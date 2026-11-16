# Runs one command inside a Windows AppContainer and a Job Object (memory / process /
# CPU limits). The container token carries no capability unless the config asks for
# `net: on` (internetClient only). The SID ACEs added for the run are removed again
# afterwards; a failure to remove them comes back as cleanup = "failed".
# Reads a JSON config file, writes one JSON line in capture mode; in stream mode the
# child inherits our std handles so the parent can speak to it directly, and this
# process exits with the child's code.
param([Parameter(Mandatory = $true)][string]$ConfigPath)

$ErrorActionPreference = 'Stop'
# One profile per capability set: a profile is created once per machine and cannot gain
# a capability later, so `net: on` gets its own name instead of a stale capability-free one.
$ContainerBaseName = 'onlyone.sandbox'
# Diagnostics go to the parent as UTF-8, not the console code page.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Mode = 'capture'
$cfg = $null
try {
  $cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  [Console]::Error.WriteLine("appcontainer: cannot read config: $($_.Exception.Message)")
  exit 70
}
if ($cfg.mode -eq 'stream') { $Mode = 'stream' }

function Write-Failure([string]$Reason) {
  if ($Mode -eq 'stream') {
    [Console]::Error.WriteLine("appcontainer: $Reason")
    exit 70
  }
  [pscustomobject]@{ available = $false; reason = $Reason } | ConvertTo-Json -Compress -Depth 4
  exit 0
}

$Source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OnlyoneAppContainer
{
  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }

  [StructLayout(LayoutKind.Sequential)]
  public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFO
  {
    public int cb;
    public IntPtr lpReserved;
    public IntPtr lpDesktop;
    public IntPtr lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFOEX { public STARTUPINFO si; public IntPtr lpAttributeList; }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

  [StructLayout(LayoutKind.Sequential)]
  struct BASIC_LIMIT
  {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }

  [StructLayout(LayoutKind.Sequential)]
  struct EXTENDED_LIMIT
  {
    public BASIC_LIMIT Basic;
    public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  public class RunOutcome { public int Code; public bool Killed; public string[] CapabilitiesInToken; }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
  [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groupSids, out uint groupSidCount, out IntPtr capabilitySids, out uint capabilitySidCount);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length, out uint returned);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetStdHandle(int index);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr updated);
  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  static extern bool TerminateJobObject(IntPtr job, uint code);

  // Capability SIDs must come from DeriveCapabilitySidsFromName: the documented well-known
  // value S-1-15-2-1 is the *group* form and CreateProcess rejects it with
  // ERROR_INVALID_PARAMETER (87); internetClient derives to S-1-15-3-1.
  static IntPtr DeriveCapabilitySid(string capabilityName, out string sidText)
  {
    IntPtr groupSids, capabilitySids;
    uint groupSidCount, capabilitySidCount;
    if (!DeriveCapabilitySidsFromName(capabilityName, out groupSids, out groupSidCount, out capabilitySids, out capabilitySidCount)) throw new Win32Exception(Marshal.GetLastWin32Error(), "DeriveCapabilitySidsFromName " + capabilityName);
    try
    {
      if (capabilitySidCount == 0) throw new InvalidOperationException("no capability SID for " + capabilityName);
      IntPtr capabilitySid = Marshal.ReadIntPtr(capabilitySids);
      sidText = SidToString(capabilitySid);
      return capabilitySid;
    }
    finally
    {
      for (int i = 0; i < groupSidCount; i++) LocalFree(Marshal.ReadIntPtr(groupSids, i * IntPtr.Size));
      if (groupSids != IntPtr.Zero) LocalFree(groupSids);
      if (capabilitySids != IntPtr.Zero) LocalFree(capabilitySids);
    }
  }

  public static IntPtr BuildCapabilityArray(string[] capabilityNames, out IntPtr[] allocations)
  {
    allocations = new IntPtr[capabilityNames == null ? 0 : capabilityNames.Length];
    if (capabilityNames == null || capabilityNames.Length == 0) return IntPtr.Zero;
    int entrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
    IntPtr array = Marshal.AllocHGlobal(entrySize * capabilityNames.Length);
    try
    {
      for (int i = 0; i < capabilityNames.Length; i++)
      {
        string sidText;
        allocations[i] = DeriveCapabilitySid(capabilityNames[i], out sidText);
        SID_AND_ATTRIBUTES entry = new SID_AND_ATTRIBUTES();
        entry.Sid = allocations[i];
        entry.Attributes = 0x4; // SE_GROUP_ENABLED
        Marshal.StructureToPtr(entry, new IntPtr(array.ToInt64() + (long)entrySize * i), false);
      }
      return array;
    }
    catch
    {
      Marshal.FreeHGlobal(array);
      throw;
    }
  }

  public static string[] CapabilitySids(string[] capabilityNames)
  {
    if (capabilityNames == null || capabilityNames.Length == 0) return new string[0];
    IntPtr[] allocations;
    IntPtr array = BuildCapabilityArray(capabilityNames, out allocations);
    try
    {
      string[] texts = new string[allocations.Length];
      for (int i = 0; i < allocations.Length; i++) texts[i] = SidToString(allocations[i]);
      return texts;
    }
    finally { FreeCapabilityArray(array, allocations); }
  }

  static void FreeCapabilityArray(IntPtr array, IntPtr[] allocations)
  {
    if (array != IntPtr.Zero) Marshal.FreeHGlobal(array);
    if (allocations == null) return;
    foreach (IntPtr sid in allocations) { if (sid != IntPtr.Zero) LocalFree(sid); }
  }

  public static IntPtr CreateSid(string name, string[] capabilityNames)
  {
    IntPtr sid = IntPtr.Zero;
    IntPtr[] allocations;
    IntPtr array = BuildCapabilityArray(capabilityNames, out allocations);
    int created;
    try
    {
      created = CreateAppContainerProfile(name, name, "onlyone sandbox: no files outside the granted workspace, network only with net: on", array, (uint)allocations.Length, out sid);
    }
    finally { FreeCapabilityArray(array, allocations); }
    if (created == 0) return sid;
    int derived = DeriveAppContainerSidFromAppContainerName(name, out sid);
    if (derived != 0) throw new InvalidOperationException("AppContainer profile failed: create=0x" + created.ToString("X8") + " derive=0x" + derived.ToString("X8"));
    return sid;
  }

  public static string SidToString(IntPtr sid)
  {
    IntPtr text;
    if (!ConvertSidToStringSidW(sid, out text)) throw new Win32Exception(Marshal.GetLastWin32Error());
    string value = Marshal.PtrToStringUni(text);
    LocalFree(text);
    return value;
  }

  static IntPtr OpenForChild(string path, uint access, uint share, uint disposition)
  {
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
    sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
    sa.bInheritHandle = true;
    IntPtr handle = CreateFileW(path, access, share, ref sa, disposition, 0x80, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFile " + path);
    return handle;
  }

  static IntPtr CreateJob(ulong memory, uint processes, uint cpuMs)
  {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
    EXTENDED_LIMIT info = new EXTENDED_LIMIT();
    info.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
    if (memory > 0) { info.Basic.LimitFlags |= 0x100; info.ProcessMemoryLimit = (UIntPtr)memory; info.JobMemoryLimit = (UIntPtr)memory; }
    if (processes > 0) { info.Basic.LimitFlags |= 0x8; info.Basic.ActiveProcessLimit = processes; }
    if (cpuMs > 0) { info.Basic.LimitFlags |= 0x4; info.Basic.PerJobUserTimeLimit = cpuMs * 10000L; }
    int length = Marshal.SizeOf(typeof(EXTENDED_LIMIT));
    IntPtr buffer = Marshal.AllocHGlobal(length);
    Marshal.StructureToPtr(info, buffer, false);
    bool ok = SetInformationJobObject(job, 9, buffer, (uint)length);
    Marshal.FreeHGlobal(buffer);
    if (!ok) { CloseHandle(job); throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject"); }
    return job;
  }

  static PROCESS_INFORMATION StartProcess(string application, string commandLine, string cwd, IntPtr sid, string[] capabilityNames, IntPtr hIn, IntPtr hOut, IntPtr hErr)
  {
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(list, 1, 0, ref size))
    {
      Marshal.FreeHGlobal(list);
      throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList");
    }
    int capsSize = Marshal.SizeOf(typeof(SECURITY_CAPABILITIES));
    IntPtr capsPtr = Marshal.AllocHGlobal(capsSize);
    IntPtr capsArray = IntPtr.Zero;
    IntPtr[] capSids = null;
    try
    {
      SECURITY_CAPABILITIES capabilities = new SECURITY_CAPABILITIES();
      capabilities.AppContainerSid = sid;
      // `net: on` reaches the token only through this array: one internetClient SID with
      // SE_GROUP_ENABLED. `net: off` leaves Capabilities = NULL and Count = 0.
      capsArray = BuildCapabilityArray(capabilityNames, out capSids);
      capabilities.Capabilities = capsArray;
      capabilities.CapabilityCount = (uint)capSids.Length;
      Marshal.StructureToPtr(capabilities, capsPtr, false);
      if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x00020009, capsPtr, (IntPtr)capsSize, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute");

      STARTUPINFOEX info = new STARTUPINFOEX();
      info.si.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      info.si.dwFlags = 0x100; // STARTF_USESTDHANDLES
      info.si.hStdInput = hIn;
      info.si.hStdOutput = hOut;
      info.si.hStdError = hErr;
      info.lpAttributeList = list;

      PROCESS_INFORMATION process;
      bool ok = CreateProcessW(application, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0x00080000, IntPtr.Zero, cwd, ref info, out process);
      int error = Marshal.GetLastWin32Error();
      if (!ok) throw new Win32Exception(error, "CreateProcess failed (" + error + ")");
      return process;
    }
    finally
    {
      DeleteProcThreadAttributeList(list);
      Marshal.FreeHGlobal(list);
      Marshal.FreeHGlobal(capsPtr);
      FreeCapabilityArray(capsArray, capSids);
    }
  }

  // Asks the child token itself which capabilities are there, instead of trusting the
  // request we made. TokenCapabilities is info class 30 (Windows 8+); the buffer is a
  // DWORD count followed by 8-byte-aligned SID_AND_ATTRIBUTES entries.
  static string[] TokenCapabilities(IntPtr process)
  {
    IntPtr token = IntPtr.Zero;
    try
    {
      if (!OpenProcessToken(process, 0x0008, out token)) return new string[0]; // TOKEN_QUERY
      uint size;
      GetTokenInformation(token, 30, IntPtr.Zero, 0, out size);
      if (size < 8) return new string[0];
      IntPtr buffer = Marshal.AllocHGlobal((int)size);
      try
      {
        uint returned;
        if (!GetTokenInformation(token, 30, buffer, size, out returned)) return new string[0];
        int count = Marshal.ReadInt32(buffer);
        int entrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        string[] found = new string[count];
        for (int i = 0; i < count; i++)
        {
          IntPtr entry = new IntPtr(buffer.ToInt64() + 8 + (long)entrySize * i);
          found[i] = SidToString(Marshal.ReadIntPtr(entry));
        }
        return found;
      }
      finally { Marshal.FreeHGlobal(buffer); }
    }
    finally { if (token != IntPtr.Zero) CloseHandle(token); }
  }

  static string[] VerifiedCapabilities(IntPtr process)
  {
    return TokenCapabilities(process);
  }

  public static RunOutcome RunCapture(string application, string commandLine, string cwd, IntPtr sid, string[] capabilityNames, string outPath, string errPath, int timeoutMs, ulong memory, uint processes, uint cpuMs)
  {
    RunOutcome outcome = new RunOutcome();
    outcome.CapabilitiesInToken = new string[0];
    IntPtr hIn = OpenForChild("NUL", 0x80000000, 3, 3);
    IntPtr hOut = OpenForChild(outPath, 0x40000000, 1, 2);
    IntPtr hErr = OpenForChild(errPath, 0x40000000, 1, 2);
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    IntPtr job = IntPtr.Zero;
    bool started = false;
    try
    {
      process = StartProcess(application, commandLine, cwd, sid, capabilityNames, hIn, hOut, hErr);
      started = true;
      outcome.CapabilitiesInToken = VerifiedCapabilities(process.hProcess);
      job = CreateJob(memory, processes, cpuMs);
      if (!AssignProcessToJobObject(job, process.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject");
      uint wait = WaitForSingleObject(process.hProcess, (uint)(timeoutMs > 0 ? timeoutMs : 30000));
      if (wait == 258)
      {
        outcome.Killed = true;
        TerminateJobObject(job, 1);
        WaitForSingleObject(process.hProcess, 5000);
      }
      uint code;
      GetExitCodeProcess(process.hProcess, out code);
      outcome.Code = unchecked((int)code);
    }
    finally
    {
      CloseHandle(hIn);
      CloseHandle(hOut);
      CloseHandle(hErr);
      if (started) { CloseHandle(process.hThread); CloseHandle(process.hProcess); }
      if (job != IntPtr.Zero) CloseHandle(job);
    }
    return outcome;
  }

  public static int RunStreaming(string application, string commandLine, string cwd, IntPtr sid, string[] capabilityNames, ulong memory, uint processes, uint cpuMs)
  {
    // Our own std handles come from the parent as non-inheritable pipes; the child
    // needs inheritable copies or CreateProcess refuses STARTF_USESTDHANDLES.
    IntPtr hIn = Inheritable(GetStdHandle(-10));
    IntPtr hOut = Inheritable(GetStdHandle(-11));
    IntPtr hErr = Inheritable(GetStdHandle(-12));
    PROCESS_INFORMATION process;
    try
    {
      process = StartProcess(application, commandLine, cwd, sid, capabilityNames, hIn, hOut, hErr);
    }
    finally
    {
      CloseCopy(hIn);
      CloseCopy(hOut);
      CloseCopy(hErr);
    }
    IntPtr job = IntPtr.Zero;
    try
    {
      job = CreateJob(memory, processes, cpuMs);
      if (!AssignProcessToJobObject(job, process.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject");
      WaitForSingleObject(process.hProcess, 0xFFFFFFFF);
      uint code;
      GetExitCodeProcess(process.hProcess, out code);
      return unchecked((int)code);
    }
    finally
    {
      CloseHandle(process.hThread);
      CloseHandle(process.hProcess);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }

  static IntPtr Inheritable(IntPtr handle)
  {
    if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return handle;
    IntPtr copy;
    if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), out copy, 0, true, 2)) throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateHandle");
    return copy;
  }

  static void CloseCopy(IntPtr handle)
  {
    if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
  }
}
'@

try {
  Add-Type -TypeDefinition $Source -Language CSharp
} catch {
  Write-Failure "Add-Type failed: $($_.Exception.Message)"
}

# `net: off` -> no capability at all; `net: on` -> internetClient, supplied by the host.
$capabilities = @()
foreach ($cap in @($cfg.capabilities)) { if ($cap) { $capabilities += [string]$cap } }

$sid = [IntPtr]::Zero
$sidString = ''
$ContainerName = if ($capabilities.Count -gt 0) { $ContainerBaseName + '.net' } else { $ContainerBaseName }
try {
  $sid = [OnlyoneAppContainer]::CreateSid($ContainerName, [string[]]$capabilities)
  $sidString = [OnlyoneAppContainer]::SidToString($sid)
} catch {
  Write-Failure "AppContainer profile unavailable: $($_.Exception.Message)"
}

if ($cfg.action -eq 'probe') {
  [pscustomobject]@{ available = $true; sid = $sidString } | ConvertTo-Json -Compress
  exit 0
}

function Quote([string]$s) {
  if ($s -ne '' -and $s -notmatch '[\s"]') { return $s }
  $q = '"'
  $r = [regex]::Replace($s, '(\\*)"', '$1$1\"')
  $r = [regex]::Replace($r, '(\\+)$', '$1$1')
  return $q + $r + $q
}

$exe = [string]$cfg.cmd
if (-not $exe) { Write-Failure 'config has no cmd' }
$commandLine = (Quote $exe) + ' ' + ((@($cfg.args) | Where-Object { $_ -ne $null } | ForEach-Object { Quote ([string]$_) }) -join ' ')
$cwd = if ($cfg.cwd) { [string]$cfg.cwd } else { (Get-Location).Path }

# The AppContainer SID gets read+execute on the workspace only; nothing else on disk.
$memory = [uint64]$cfg.maxMemoryBytes
$processes = [uint32]$cfg.maxProcesses
$cpuMs = [uint32]$cfg.cpuMs

$capabilitySids = @([OnlyoneAppContainer]::CapabilitySids([string[]]$capabilities))

# The child gets exactly the environment the host composed; our own PowerShell process
# started before this rewrite, so it stays healthy while the worker sees no profile vars.
if ($cfg.env) {
  $wanted = @{}
  foreach ($prop in $cfg.env.PSObject.Properties) { $wanted[$prop.Name] = [string]$prop.Value }
  # CreateProcess for an AppContainer needs LOCALAPPDATA in the environment block and
  # rewrites it to %LOCALAPPDATA%\Packages\<container>\AC, so the worker sees its own
  # profile directory, never the user's.
  if (-not $wanted.ContainsKey('LOCALAPPDATA')) { $wanted['LOCALAPPDATA'] = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process') }
  foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    if (-not $wanted.ContainsKey([string]$name)) { [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process') }
  }
  foreach ($name in $wanted.Keys) { [Environment]::SetEnvironmentVariable($name, $wanted[$name], 'Process') }
}

$outFile = [string]$cfg.stdoutPath
$errFile = [string]$cfg.stderrPath
$timeout = [int]$cfg.timeoutMs
$granted = @()
$cleanupErrors = @()
$outcome = $null
$streamCode = 0
$failure = ''
$stage = 'grant'

# Every ACE we add is recorded here and removed again once the run is over.
try {
  foreach ($grant in @($cfg.grants)) {
    if (-not $grant) { continue }
    if (-not (Test-Path -LiteralPath $grant)) { throw "grant path not found: $grant" }
    $item = Get-Item -LiteralPath $grant -Force
    if ($item.PSIsContainer) { $rule = "*${sidString}:(OI)(CI)(RX)" } else { $rule = "*${sidString}:(RX)" }
    $output = & icacls.exe $item.FullName /grant $rule /Q 2>&1
    if ($LASTEXITCODE -ne 0) { throw "icacls failed on $($item.FullName): $(($output | Out-String).Trim())" }
    $granted += $item.FullName
  }
  $stage = 'launch'
  if ($Mode -eq 'stream') {
    $streamCode = [OnlyoneAppContainer]::RunStreaming($exe, $commandLine, $cwd, $sid, $capabilities, $memory, $processes, $cpuMs)
  } else {
    $outcome = [OnlyoneAppContainer]::RunCapture($exe, $commandLine, $cwd, $sid, $capabilities, $outFile, $errFile, $timeout, $memory, $processes, $cpuMs)
  }
} catch {
  $failure = if ($stage -eq 'launch') { "launch failed: $($_.Exception.Message)" } else { $_.Exception.Message }
} finally {
  # The container is gone by now; take our SID back off every path we touched. A failure
  # here is reported, never swallowed: an ACE left behind outlives the sandbox. icacls
  # writes to stderr, and $ErrorActionPreference = 'Stop' turns that into a throw, so both
  # the exit code and the throw are collected.
  foreach ($dir in $granted) {
    try {
      $output = & icacls.exe $dir /remove:g "*$sidString" /Q 2>&1
      if ($LASTEXITCODE -ne 0) { $cleanupErrors += ($dir + ': ' + (($output | Out-String).Trim())) }
    } catch {
      $cleanupErrors += ($dir + ': ' + $_.Exception.Message)
    }
  }
}

if ($failure) { Write-Failure $failure }

if ($Mode -eq 'stream') {
  if ($cleanupErrors.Count -gt 0) { [Console]::Error.WriteLine('appcontainer: cleanup failed: ' + ($cleanupErrors -join ' | ')) }
  exit $streamCode
}

$stdoutText = ''
$stderrText = ''
if ($outFile -and (Test-Path -LiteralPath $outFile)) { $stdoutText = [IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8) }
if ($errFile -and (Test-Path -LiteralPath $errFile)) { $stderrText = [IO.File]::ReadAllText($errFile, [Text.Encoding]::UTF8) }
$reason = if ($outcome.Killed) { 'timeout' } else { '' }
[pscustomobject]@{
  available = $true
  code = $outcome.Code
  stdout = $stdoutText
  stderr = $stderrText
  killed = $outcome.Killed
  reason = $reason
  sid = $sidString
  capabilities = @($capabilities)
  capabilitySids = @($capabilitySids)
  capabilitiesInToken = @($outcome.CapabilitiesInToken)
  cleanup = $(if ($cleanupErrors.Count -gt 0) { 'failed' } else { 'ok' })
  cleanupError = ($cleanupErrors -join ' | ')
} | ConvertTo-Json -Compress -Depth 4
exit 0
