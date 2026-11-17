const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
// Окно запускается через общий помощник: он убирает ELECTRON_RUN_AS_NODE из
// окружения. С голым process.env прогон под Node-внутри-Electron запускал
// main.js как скрипт, окно не открывалось, и проверка падала на пустом отчёте.
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const root = path.join(__dirname, '..')
const output = runDir('1code-fast-ui')
const out = path.join(output, 'checks.json')
// Keep the isolated GUI fixture on the same GPU-safe launch path as the other
// window tests. The test host may not have Chromium's sandbox helper.
const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(output, 'profile')], {
  cwd: root, timeout: 45000, stdio: 'inherit', env: guiEnv({
    ONECODE_SMOKE: path.join(__dirname, 'fast-ui-renderer.js'), ONECODE_SMOKE_OUT: out,
    ONECODE_SHOT: path.join(output, 'fast.png') })
})
if (child.error) throw child.error
if (!fs.existsSync(out)) {
  console.error('окно не отчиталось: ' + out)
  process.exit(1)
}
const report = JSON.parse(fs.readFileSync(out, 'utf8'))
const checks = report.checks || []
const failed = checks.filter(check => !check.pass)
for (const check of checks) {
  console.log((check.pass ? '  ok  ' : 'ПРОВАЛ') + ' ' + check.name + (check.detail ? ' — ' + check.detail : ''))
}
console.log(`Fast — проверок ${checks.length}, успешно ${checks.length - failed.length}, снимок: ${path.join(output, 'fast.png')}`)
if (child.status !== 0) console.error(`Electron завершился с кодом ${child.status}, сигналом ${child.signal || 'нет'}`)
settleRun(output, report.ok && child.status === 0)
process.exit(report.ok && child.status === 0 ? 0 : 1)
