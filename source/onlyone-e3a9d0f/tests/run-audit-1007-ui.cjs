// Оконный прогон регрессий аудита 07.10.2026 (вёрстка: наложения, обрезки, пропавшие кнопки).
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock } = require('./app-launch.cjs')
const root = path.join(__dirname, '..')
const output = runDir('onlyone-audit-1007-ui')
const out = path.join(output, 'checks.json')
acquireWindowLock()
const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(output, 'profile')], {
  cwd: root, timeout: 240000, stdio: 'inherit', env: guiEnv({
    ONECODE_SMOKE: path.join(__dirname, 'audit-1007-renderer.js'), ONECODE_SMOKE_OUT: out,
    ONECODE_SMOKE_FIXTURE: path.join(__dirname, 'audit-1007-fixture.json'),
    ONECODE_SHOT: path.join(output, 'audit-1007.png') })
})
if (child.error) throw child.error
if (!fs.existsSync(out)) {
  console.error('окно не отчиталось: ' + out)
  process.exit(1)
}
const report = JSON.parse(fs.readFileSync(out, 'utf8'))
const checks = report.checks || []
const failed = checks.filter(check => !check.pass && !check.skipped)
for (const check of checks) {
  console.log((check.pass ? '  ok  ' : check.skipped ? 'ПУСТО ' : 'ПРОВАЛ') + ' ' + check.name + (check.detail ? ' — ' + check.detail : ''))
}
console.log(`Вёрстка аудита 07.10 — проверок ${checks.length}, не прошло ${failed.length}`)
settleRun(output, report.ok && child.status === 0)
process.exit(report.ok && child.status === 0 ? 0 : 1)
