const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const root = path.join(__dirname, '..')
const { electronBinary, guiEnv } = require('./app-launch.cjs')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'design-flow-071-'))
const out = path.join(output, 'checks.json')
// Сценарий поднимает настоящий Electron, и на занятой машине — например, когда
// сразу за ним идут остальные наборы — окно не всегда успевает подняться в срок.
// Это свойство запуска, а не проверок Design, поэтому таймаут даётся один раз
// повторно, а не растёт до бесконечности. Любой другой сбой пробрасывается сразу.
function launch(attempt) {
  return spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(output, 'profile' + attempt)], {
    cwd: root, timeout: 180000, stdio: 'inherit', env: guiEnv({
      ONECODE_DESIGN_FLOW: '1', ONECODE_SMOKE: path.join(__dirname, 'design-flow-renderer.js'),
      ONECODE_SMOKE_FIXTURE: path.join(__dirname, 'design-flow-fixture.json'),
      ONECODE_SMOKE_OUT: out, ONECODE_SHOT: path.join(output, 'design.png') })
  })
}

let child = launch(1)
if (child.error?.code === 'ETIMEDOUT' && !fs.existsSync(out)) {
  console.error('Окно не успело отчитаться за 180 с — повторяю один раз.')
  child = launch(2)
}
if (child.error) {
  if (child.error.code === 'ETIMEDOUT') {
    console.error('Окно не отчиталось и со второй попытки. Это не провал проверок ' +
      'Design: сценарий поднимает настоящий Electron, и запуск не уложился в лимит.')
  }
  throw child.error
}
if (!fs.existsSync(out)) throw new Error('Нет отчёта Design')
const report = JSON.parse(fs.readFileSync(out, 'utf8'))
console.log(JSON.stringify({ ...report, output }, null, 2))
process.exit(report.ok && child.status === 0 ? 0 : 1)
