'use strict'
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawnSync } = require('node:child_process')
const script = path.join(__dirname, '../resources/cli/path.ps1')
assert.ok(fs.existsSync(script), 'installed CLI needs a PATH registration script')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-path-test-'))
try {
  const probe = path.join(dir, 'test.ps1')
  fs.writeFileSync(probe, `. '${script.replace(/'/g, "''")}'
$items = @(
 (Get-OnlyonePathValue 'C:\\Windows;%USERPROFILE%\\bin' 'D:\\Onlyone\\resources\\cli' '' $false),
 (Get-OnlyonePathValue 'C:\\Windows;D:\\Onlyone\\resources\\cli' 'd:\\onlyone\\resources\\cli\\' '' $false),
 (Get-OnlyonePathValue 'C:\\Windows;D:\\Old\\resources\\cli;%USERPROFILE%\\bin' 'D:\\New\\resources\\cli' 'D:\\Old\\resources\\cli' $false),
 (Get-OnlyonePathValue 'C:\\Windows;D:\\Onlyone\\resources\\cli;%USERPROFILE%\\bin' 'D:\\Onlyone\\resources\\cli' '' $true),
 (Get-OnlyonePathValue '' 'D:\\Onlyone\\resources\\cli' '' $false)
)
ConvertTo-Json -Compress -InputObject $items
`)
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  const rows = JSON.parse(result.stdout.trim())
  assert.equal(rows[0], 'C:\\Windows;%USERPROFILE%\\bin;D:\\Onlyone\\resources\\cli')
  assert.equal(rows[1].split(';').length, 2, 'registration is idempotent ignoring case and trailing slash')
  assert.equal(rows[2], 'C:\\Windows;%USERPROFILE%\\bin;D:\\New\\resources\\cli', 'update removes only our recorded old location')
  assert.equal(rows[3], 'C:\\Windows;%USERPROFILE%\\bin', 'uninstall keeps other entries and literal variables')
  assert.equal(rows[4], 'D:\\Onlyone\\resources\\cli', 'empty PATH does not introduce current-directory entry')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
console.log('PASS CLI PATH: add/update/remove, duplicates, variables and empty PATH; no user registry changes')
