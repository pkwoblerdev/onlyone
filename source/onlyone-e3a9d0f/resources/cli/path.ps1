param([ValidateSet('Add','Remove')][string]$Action, [string]$Directory)
$ErrorActionPreference = 'Stop'

function Get-OnlyonePathValue([string]$Current, [string]$Target, [string]$Previous, [bool]$Remove) {
  function Canonical([string]$Value) {
    $value = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
    try { if ([IO.Path]::IsPathRooted($value)) { $value = [IO.Path]::GetFullPath($value) } } catch {}
    return $value.TrimEnd('\','/').ToLowerInvariant()
  }
  $targetKey = Canonical $Target
  $previousKey = if ($Previous) { Canonical $Previous } else { $null }
  $entries = [Collections.Generic.List[string]]::new()
  if ($Current) {
    foreach ($entry in $Current.Split(';')) {
      $key = Canonical $entry
      if ($key -ne $targetKey -and (!$previousKey -or $key -ne $previousKey)) { $entries.Add($entry) }
    }
  }
  if (!$Remove) { $entries.Add($Target) }
  return [string]::Join(';', $entries)
}

if ($MyInvocation.InvocationName -eq '.') { return }
if (!$Action -or !$Directory -or ![IO.Path]::IsPathRooted($Directory)) { throw 'CLI PATH registration needs an action and absolute directory.' }
$Directory = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
if ($Action -eq 'Add' -and !(Test-Path -LiteralPath (Join-Path $Directory 'onlyone.cmd') -PathType Leaf)) { throw 'CLI launcher is missing.' }
$environmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$registration = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\onlyone\CLI')
try {
  $current = [string]$environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $previous = [string]$registration.GetValue('Directory', '')
  if ($Action -eq 'Remove' -and $previous -and $previous.TrimEnd('\') -ine $Directory) { exit 0 }
  $next = Get-OnlyonePathValue $current $Directory $previous ($Action -eq 'Remove')
  if ($next.Length -gt 32700) { throw 'User PATH is too long; no changes made.' }
  $kind = if ($environmentKey.GetValueNames() -contains 'Path') { $environmentKey.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw 'User PATH has an unsupported registry type.' }
  $environmentKey.SetValue('Path', $next, $kind)
  try {
    if ($Action -eq 'Add') { $registration.SetValue('Directory', $Directory); $registration.SetValue('Enabled', '1') }
    else { $registration.DeleteValue('Directory', $false); $registration.SetValue('Enabled', '0') }
  } catch { $environmentKey.SetValue('Path', $current, $kind); throw }
} finally { $environmentKey.Dispose(); $registration.Dispose() }
