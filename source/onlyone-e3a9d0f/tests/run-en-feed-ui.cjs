// Красный прогон 2.6б (вторая половина поручения): строки главного процесса в
// ленте хода на английском.
//
// `run-en-no-cyrillic-ui` ленту разговора намеренно исключает — там текст модели
// и человека. Но в ленту пишет и главный процесс: глагол вызова
// («Читаю», «Пишу», «Выполняю команду»), строки `agent-event`, машинные причины
// падения и остановки. Они рождаются в `main.js` и переводом по дереву не
// догоняются в принципе — их надо переводить там, где они появляются.
//
// Ход настоящий: фикстура `ONECODE_SMOKE_FIXTURE` гонит вызов инструмента,
// чек-лист хода и команду помощников, язык окна — английский.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('1code-en-feed')
const profile = path.join(out, 'profile')
const evidence = process.env.ONECODE_EVIDENCE_DIR

const fixture = path.join(out, 'feed.fixture.json')
fs.writeFileSync(fixture, JSON.stringify({
  content: 'Готово: прочитал файл и показал результат.',
  toolStream: { tool: 'show_artifact', hold: 900, args: { kind: 'page', title: 'Проверка ленты', content: '<h1>Проверка ленты</h1>' } },
  pace: 6
}), 'utf8')

const script = path.join(__dirname, 'en-feed-renderer.js')
const resultFile = path.join(out, 'feed.json')
const shot = path.join(out, 'en-feed.png')

const child = spawnSync(electronBinary(),
  ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, timeout: 420000, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: script,
      ONECODE_SMOKE_OUT: resultFile,
      ONECODE_SMOKE_FIXTURE: fixture,
      ONECODE_SHOT: shot,
      ONECODE_ARG: 'en'
    })
  })
if (child.error) throw child.error

if (!fs.existsSync(resultFile)) {
  console.error(`Окно не отчиталось (статус ${child.status})`)
  process.exit(1)
}
const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
for (const item of report.checks || []) {
  console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
}
if (evidence) {
  fs.mkdirSync(evidence, { recursive: true })
  for (const file of [shot, resultFile, fixture]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)))
  }
}
console.log(JSON.stringify({ ok: Boolean(report.ok), failed: (report.checks || []).filter(c => !c.pass).length,
  checks: (report.checks || []).length }))
settleRun(out, Boolean(report.ok))
process.exit(report.ok ? 0 : 1)
