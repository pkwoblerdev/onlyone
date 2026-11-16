// break-5 Н2: command-guard пропускал «cd /d %APPDATA%\1code & echo x > settings.json»
// и «set P=… & echo x > %P%\f» — относительная запись в защищённый профиль.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { checkCommand } = require('../src/main/command-guard.js')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-cmdguard-'))
const appdata = path.join(base, 'AppData', 'Roaming')
const profile = path.join(appdata, '1code')
const workspace = path.join(base, 'work')
fs.mkdirSync(profile, { recursive: true })
fs.mkdirSync(workspace, { recursive: true })
const env = { APPDATA: appdata, USERPROFILE: base }
const run = (command, extra = {}) => checkCommand({
  command, cwd: workspace, protectedRoots: [profile], env, pid: 999999, appNames: ['onlyone'], ...extra
})

const MUST_DENY = [
  ['cd + относительный redirect', 'cd /d "%APPDATA%\\1code" & echo pwned > settings.json'],
  ['cd + && type nul', 'cd /d "%APPDATA%\\1code" && type nul > keys.json'],
  ['pushd + относительный redirect', 'pushd "%APPDATA%\\1code" & echo x > f.txt'],
  ['set + %P% в redirect', 'set "P=%APPDATA%\\1code" & echo x > %P%\\pwn.txt'],
  ['cd без кавычек', 'cd /d %APPDATA%\\1code & echo x > settings.json'],
  ['cd в профиль и удаление относительного', 'cd /d "%APPDATA%\\1code" & del settings.json']
]
for (const [what, command] of MUST_DENY) {
  check(`запрещено: ${what}`, () => {
    const verdict = run(command)
    assert.equal(verdict.ok, false, 'команда прошла: ' + command)
  })
}

check('контроль: абсолютная запись в профиль запрещалась и раньше', () => {
  assert.equal(run('echo x > "%APPDATA%\\1code\\pwn.txt').ok, false)
})
check('контроль: cd в рабочую подпапку с относительной записью разрешён', () => {
  assert.equal(run('cd /d "C:\\work\\sub" & echo x > f.txt').ok, true)
})
check('контроль: чтение профиля по абсолютному пути без cd разрешено', () => {
  assert.equal(run('type "%APPDATA%\\1code\\logs\\app.log"').ok, true)
})
check('контроль: обычная запись в рабочей папке разрешена', () => {
  assert.equal(run('echo x > out.txt').ok, true)
})
check('контроль: set без защищённого пути не мешает', () => {
  assert.equal(run('set "P=C:\\work" & echo x > %P%\\f.txt').ok, true)
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
try { fs.rmSync(base, { recursive: true, force: true }) } catch {}