// Карточка задачи Дизайна в ленте чата (план, этап 4 «Чат + Дизайн»):
// четыре состояния — четыре запуска на одном профиле, каждый со своим снимком
// (правило «одно состояние = один запуск = один снимок», как в
// `run-artifacts-ui.cjs`). Снимки можно сохранить через ONECODE_EVIDENCE_DIR.
//
// Состояния поднимаются настоящим путём: в чат уходит просьба, ход ведёт дымов
// провайдер и вызывает НАСТОЯЩИЙ инструмент `design_task` (main.js:11806-11822).
// Он пишет макет настоящими `dc_*` и проверяет его настоящим `dc_check`, так что
// платного вызова модели в прогоне быть не может: профиль свежий, ключей в нём
// нет, ONECODE_E2E не выставлен.
//
// Фикстуры состояний пишутся в каталог прогона, а не в репозиторий: тестовых
// файлов в `tests/` ради этого плодить нечего.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const evidence = process.env.ONECODE_EVIDENCE_DIR
const out = runDir('onlyone-design-task-ui')
const profile = path.join(out, 'profile')
const RENDERER = 'design-task-renderer.js'

// Один и тот же бриф для «идёт», «готово» и «открыть»: задача честная, и макет
// собирается настоящий. Маркер в брифе — то, по чему прогон находит карточку в
// ленте, поэтому он обязан дойти до окна текстом.
const briefFor = marker => 'Собери одностраничный сайт «' + marker + '»: первый экран с заголовком ' +
  'и коротким описанием, блок тарифов из трёх строк, форма заказа и подвал с контактами.'

// Готовый макет: движок сам пишет страницу и сам её проверяет.
const FIXTURE_READY = marker => ({
  content: 'Готово: макет собран и проверен.',
  toolStream: { tool: 'design_task', args: { brief: briefFor(marker), topic: 'Проверка карточки' } }
})

// Отказ до единой записи на диск: правка макета, которого нет в реестре.
const FIXTURE_FAILED = marker => ({
  content: 'Не вышло.',
  toolStream: {
    tool: 'design_task',
    args: { brief: briefFor(marker), topic: 'Проверка карточки', design_id: 'net-takogo-maketa' }
  }
})

fs.writeFileSync(path.join(out, 'fixture-ready.json'), JSON.stringify(FIXTURE_READY('МИШЕНА-ГОТОВО'), null, 2))
fs.writeFileSync(path.join(out, 'fixture-running.json'), JSON.stringify(FIXTURE_READY('МИШЕНА-ИДЁТ'), null, 2))
fs.writeFileSync(path.join(out, 'fixture-open.json'), JSON.stringify(FIXTURE_READY('МИШЕНА-ОТКРЫТЬ'), null, 2))
fs.writeFileSync(path.join(out, 'fixture-failed.json'), JSON.stringify(FIXTURE_FAILED('МИШЕНА-ОШИБКА'), null, 2))

// Один запуск окна: свой режим, свой отчёт и свой снимок в конце проверки.
function launch (name, id, { mode, marker, fixture, shot }) {
  const resultFile = path.join(out, id + '.json')
  const child = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
      cwd: root, timeout: 240000, stdio: 'inherit',
      env: guiEnv({
        ONECODE_SMOKE: path.join(__dirname, RENDERER),
        ONECODE_SMOKE_OUT: resultFile,
        ONECODE_SMOKE_FIXTURE: fixture,
        ONECODE_SHOT: shot,
        // Аргументы — base64: русские маркеры и кавычки в строковом литерале
        // скрипта ломались бы на первой же скобке.
        ONECODE_ARG: Buffer.from(JSON.stringify({ mode, marker }), 'utf8').toString('base64')
      })
    })
  if (child.error) {
    console.error('ПРОВАЛ ' + name + ': окно не запущено — ' + (child.error.message || child.error))
    return { ok: false, checks: [], started: false }
  }
  if (!fs.existsSync(resultFile)) {
    console.error('ПРОВАЛ ' + name + ': окно не отчиталось (status ' + child.status + ')')
    return { ok: false, checks: [], started: true }
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error('ПРОВАЛ ' + name + ': окно сообщило об ошибке — ' + report.error)
  for (const item of report.checks || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + name + ' · ' + item.name + (item.detail ? ' — ' + item.detail : ''))
  }
  if (evidence && shot && fs.existsSync(shot)) {
    fs.mkdirSync(evidence, { recursive: true })
    fs.copyFileSync(shot, path.join(evidence, path.basename(shot)))
  }
  return { ok: Boolean(report.ok) && child.status === 0, checks: report.checks || [], shot, started: true }
}

function main () {
  const states = [
    // «идёт» снимается первым: карточка до финального события живёт ровно
    // столько, сколько местный исполнитель пишет и проверяет макет, и снять её
    // надо успеть.
    { name: 'идёт', id: 'running', mode: 'running', marker: 'МИШЕНА-ИДЁТ', file: 'fixture-running.json', shot: 'design-task-running.png' },
    { name: 'готово', id: 'ready', mode: 'ready', marker: 'МИШЕНА-ГОТОВО', file: 'fixture-ready.json', shot: 'design-task-ready.png' },
    { name: 'ошибка', id: 'failed', mode: 'failed', marker: 'МИШЕНА-ОШИБКА', file: 'fixture-failed.json', shot: 'design-task-failed.png' },
    { name: 'открыть в дизайне', id: 'open', mode: 'open', marker: 'МИШЕНА-ОТКРЫТЬ', file: 'fixture-open.json', shot: 'design-task-open.png' }
  ]
  const runs = states.map(state => launch(state.name, state.id, {
    mode: state.mode, marker: state.marker,
    fixture: path.join(out, state.file),
    shot: path.join(out, state.shot)
  }))
  const ok = runs.every(run => run.ok)
  const shots = runs.filter(run => run.shot && fs.existsSync(run.shot)).map(run => path.basename(run.shot))
  console.log('снимки состояний: ' + (shots.length ? shots.join(', ') : 'не созданы'))
  console.log(JSON.stringify({
    ok,
    checks: runs.map((run, index) => ({
      состояние: states[index].name,
      всего: run.checks.length,
      красных: run.checks.filter(item => !item.pass).length
    })),
    output: out
  }))
  console.log(ok ? 'Карточка задачи Дизайна работает' : 'Есть ошибки в карточке задачи Дизайна')
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

try {
  main()
} catch (error) {
  console.error('ПРОВАЛ', (error && error.message) || error)
  settleRun(out, false)
  process.exitCode = 1
}
