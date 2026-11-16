# Runs one command inside a Windows Job Object. Reads JSON from stdin (or from
# -ConfigPath), writes one JSON line. With -Stream the child inherits this process's
# std handles, nothing is captured here, and this process exits with the child's code.
param([string]$ConfigPath, [switch]$Stream)
$ErrorActionPreference = 'Stop'
if ($ConfigPath) {
  $cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
  $cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OnlyoneJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC {
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
  struct IO { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)]
  struct EXT {
    public BASIC Basic;
    public IO Io;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll")]
  static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll")]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr job);

  public static IntPtr Create(ulong memory, uint processes, uint cpuMs) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    var info = new EXT();
    info.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
    if (memory > 0) { info.Basic.LimitFlags |= 0x100; info.ProcessMemoryLimit = (UIntPtr)memory; info.JobMemoryLimit = (UIntPtr)memory; }
    if (processes > 0) { info.Basic.LimitFlags |= 0x8; info.Basic.ActiveProcessLimit = processes; }
    if (cpuMs > 0) { info.Basic.LimitFlags |= 0x4; info.Basic.PerJobUserTimeLimit = cpuMs * 10000L; }
    int len = Marshal.SizeOf(typeof(EXT));
    IntPtr ptr = Marshal.AllocHGlobal(len);
    Marshal.StructureToPtr(info, ptr, false);
    bool ok = SetInformationJobObject(job, 9, ptr, (uint)len);
    Marshal.FreeHGlobal(ptr);
    if (!ok) { CloseHandle(job); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    return job;
  }
  public static bool Assign(IntPtr job, IntPtr process) { return AssignProcessToJobObject(job, process); }
  public static void Kill(IntPtr job) { TerminateJobObject(job, 1); }
  public static void Close(IntPtr job) { CloseHandle(job); }
}
"@

function Quote([string]$s) {
  if ($s -ne '' -and $s -notmatch '[\s"]') { return $s }
  $q = '"'
  $r = [regex]::Replace($s, '(\\*)"', '$1$1\"')
  $r = [regex]::Replace($r, '(\\+)$', '$1$1')
  return $q + $r + $q
}

$job = $null
$p = $null
$killed = $false
# The child gets exactly the environment the host composed. Rewriting our own process
# environment after PowerShell has started keeps PowerShell itself healthy while the
# worker still sees no APPDATA / USERPROFILE / tokens.
if ($cfg.env) {
  $wanted = @{}
  foreach ($prop in $cfg.env.PSObject.Properties) { $wanted[$prop.Name] = [string]$prop.Value }
  foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    if (-not $wanted.ContainsKey([string]$name)) { [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process') }
  }
  foreach ($name in $wanted.Keys) { [Environment]::SetEnvironmentVariable([string]$name, $wanted[$name], 'Process') }
}
try {
  $job = [OnlyoneJob]::Create([uint64]$cfg.maxMemoryBytes, [uint32]$cfg.maxProcesses, [uint32]$cfg.cpuMs)
  if ($Stream) {
    # Inherit our std handles so the parent talks to the child directly (JSON-RPC).
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = [string]$cfg.cmd
    $psi.Arguments = (($cfg.args | ForEach-Object { Quote ([string]$_) }) -join ' ')
    $psi.UseShellExecute = $false
    if ($cfg.cwd) { $psi.WorkingDirectory = [string]$cfg.cwd }
    $p = [Diagnostics.Process]::Start($psi)
    if (-not [OnlyoneJob]::Assign($job, $p.Handle)) {
      throw "AssignProcessToJobObject failed: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)"
    }
    $p.WaitForExit()
    exit $p.ExitCode
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = [string]$cfg.cmd
  $psi.Arguments = (($cfg.args | ForEach-Object { Quote ([string]$_) }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  if ($cfg.cwd) { $psi.WorkingDirectory = [string]$cfg.cwd }
  $p = [Diagnostics.Process]::Start($psi)
  if (-not [OnlyoneJob]::Assign($job, $p.Handle)) {
    throw "AssignProcessToJobObject failed: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)"
  }
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  $timeout = [int]$cfg.timeoutMs
  if ($timeout -le 0) { $timeout = 30000 }
  if (-not $p.WaitForExit($timeout)) {
    [OnlyoneJob]::Kill($job)
    $killed = $true
    $p.WaitForExit(5000) | Out-Null
  }
  $code = if ($p.HasExited) { $p.ExitCode } else { -1 }
  [pscustomobject]@{
    code = $code
    stdout = $outTask.Result
    stderr = $errTask.Result
    killed = $killed
    reason = if ($killed) { 'timeout' } else { '' }
  } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ code = -1; stdout = ''; stderr = $_.Exception.Message; killed = $killed; reason = 'error' } | ConvertTo-Json -Compress
} finally {
  if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} }
  if ($job) { [OnlyoneJob]::Close($job) }
}
