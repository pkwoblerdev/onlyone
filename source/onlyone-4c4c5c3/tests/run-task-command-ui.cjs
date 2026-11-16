// Команда агента в Центре задач (план, 3.4б): настоящий ход, настоящий
// `run_command`, настоящий дочерний процесс — и пауза, нажатая человеком в
// очереди, а не в тесте.
//
// Здесь нет ни подставного цикла, ни подставного процесса: окно запускается
// по-настоящему, ведёт его `runAgentLoop`, а вместо сети отвечает файл-сценарий
// (`ONECODE_PROVIDER_FILE`). Команда пишет в файл проекта метку времени каждого
// тика, и «пауза сняла процесс» доказывается не состоянием карточки, а тем, что
// тики оборвались в момент нажатия: часы у прогонщика и у окна одни.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-task-command')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
const ticks = path.join(workspace, 'tick.log')

// Скрипт, который команда исполняет: тик каждые 200 мс с меткой времени. Пути в
// него не подставляются — команда выглядит так, как её написал бы человек.
fs.writeFileSync(path.join(workspace, 'tick.js'),
  "const fs = require('fs')\nsetInterval(() => fs.appendFileSync('tick.log', Date.now() + '\\n'), 200)\n")

const providerFile = path.join(out, 'provider.json')
fs.writeFileSync(providerFile, JSON.stringify({
  turns: [
    { toolCalls: [{ name: 'run_command', args: { command: 'node tick.js', timeout_seconds: 25 } }] },
    { text: 'Команда снята паузой из очереди.' }
  ]
}))

const profile = path.join(out, 'profile')
fs.mkdirSync(profile, { recursive: true })
// Ключ не используется: отвечает файл-сценарий. Нужен сам факт непустого пула,
// иначе ход останавливается до цикла. `acceptEdits` — чтобы команда прошла
// подтверждение так же, как у соседнего харнесса.
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model',
  legacyStoragePurged: true,
  workspace: { path: workspace, permission: 'acceptEdits' }
}))

const script = path.join(out, 'renderer.js')
fs.writeFileSync(script, `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 40000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(80) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const errors = []
  window.addEventListener('error', event => errors.push(String(event.message)))
  const rows = () => [...document.querySelectorAll('#taskCenterList .task-center-row')]
  const title = row => (row.querySelector('.task-center-title') || {}).textContent || ''
  const state = row => (String((row.querySelector('.task-center-item') || {}).className).match(/status-([a-z]+)/) || [])[1] || ''
  const buttons = row => [...(row ? row.querySelectorAll('.task-center-action') : [])].map(b => b.dataset.taskAction)
  const action = (row, name) => (row ? [...row.querySelectorAll('.task-center-action')] : []).find(b => b.dataset.taskAction === name)
  const commandRow = () => rows().find(row => title(row).startsWith('Команда:'))
  const extra = {}

  async function run() {
    if (!await until(() => document.documentElement.dataset.appReady === '1')) { note('окно не поднялось', false); return }
    if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
    await wait(300)
    document.dispatchEvent(new CustomEvent('open-task-center'))

    $('composerTextarea').value = 'Запусти сборку и оставь её на паузе'
    $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
    await wait(150)
    $('composerForm').requestSubmit()

    const appeared = await until(() => Boolean(commandRow()))
    note('команда агента появилась в очереди', appeared,
      rows().map(row => title(row) + '=' + state(row)).join(' | ').slice(0, 200))
    const running = appeared && await until(() => state(commandRow()) === 'running', 20000)
    note('карточка названа работой, пока процесс идёт', running, state(commandRow()))
    const row = commandRow()
    note('на карточке команды есть кнопка паузы', Boolean(row && action(row, 'pause')), buttons(row).join(','))
    // Пауза нажимается не сразу: процесс должен успеть оставить несколько тиков,
    // иначе «тики оборвались» нельзя отличить от «процесс не дожил до тика».
    await wait(1400)
    extra.pauseAt = Date.now()
    if (row && action(row, 'pause')) action(row, 'pause').click()
    const paused = await until(() => state(commandRow()) === 'waiting' && !buttons(commandRow()).includes('pause'), 15000)
    note('пауза из очереди сняла карточку с работы', paused,
      state(commandRow()) + ' · ' + buttons(commandRow()).join(','))
    note('присоединённую команду очередь ни возобновить, ни перезапустить не предлагает',
      !buttons(commandRow()).includes('restart') && !buttons(commandRow()).includes('resume'),
      buttons(commandRow()).join(','))
    // Пауза паузой, но главный признак — молчание файла. Окно намеренно живёт
    // ещё несколько секунд: если процесс пережил снятие, он обязан был
    // дописать тики уже после нажатия, и «тики кончились на выходе приложения»
    // не осталось бы отговоркой.
    await wait(2600)

    const idle = await until(() => !($('sendBtn') && $('sendBtn').classList.contains('is-stop')), 40000)
    note('ход завершился после снятия команды', idle,
      (($('messagesList') || {}).textContent || '').replace(/\\s+/g, ' ').slice(-140))
    await wait(500)
  }

  try { await run() } catch (error) {
    note('проверка упала', false, String((error && error.stack) || error).slice(0, 400))
  }
  note('ошибок в окне нет', !errors.length, errors.join(' | '))
  return { ok: checks.every(c => c.pass), checks, extra }
})()`)

const resultFile = path.join(out, 'result.json')
const child = spawnSync(electronBinary(),
  ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, timeout: 300000, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: script,
      ONECODE_SMOKE_OUT: resultFile,
      ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: providerFile,
      ONECODE_SHOT: path.join(out, 'task-command.png')
    })
  })

// Момент, когда приложения уже нет: он отделяет «процесс сняла пауза» от
// «процесс унёс выход приложения».
const appExitAt = Date.now()

const claims = []
function claim(name, pass, detail) {
  claims.push({ name, pass: Boolean(pass), detail: String(detail === undefined ? '' : detail) })
  console.log((pass ? '  ok  ' : 'ПРОВАЛ ') + 'диск · ' + name + (detail === undefined ? '' : ` — ${detail}`))
}

let ok = false
if (!fs.existsSync(resultFile)) {
  console.error(`Окно не отчиталось (status ${child.status})`)
} else {
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error(`окно сообщило об ошибке — ${report.error}`)
  for (const item of report.checks || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
  }
  ok = Boolean(report.ok)

  const marks = fs.existsSync(ticks) ? fs.readFileSync(ticks, 'utf8').split('\n').filter(Boolean).map(Number) : []
  const pauseAt = Number((report.extra || {}).pauseAt) || 0
  const last = marks.length ? marks[marks.length - 1] : 0
  claim('команда действительно писала в файл проекта', marks.length >= 3, `тиков: ${marks.length}`)
  // Тики должны оборваться на паузе, а не на выходе приложения: дети Electron
  // всё равно снимаются вместе с ним. Поэтому мерка одна — сколько периодов по
  // 200 мс приложение прожило ПОСЛЕ последнего тика. Живой процесс дописал бы
  // их все; восемь периодов — это два с лишним секунды молчания.
  const periods = Math.round((appExitAt - last) / 200)
  // Пол задержки не нулевой и не зависит от очереди: тик, назначенный на
  // ближайшие 200 мс, успеет записаться, а `taskkill /T /F` снимает дерево за
  // сотню-другую миллисекунд. 500 мс — это два таких периода: «сразу» в
  // смысле «процесс умер по нажатию», а не «процесс дотерпел до следующего
  // своего шага». Прежний допуск 1500 мс пропускал бы паузу, которая вообще
  // ничего не снимает, но укладывается в три периода.
  claim('после паузы процесс не пишет: тики оборвались на моменте нажатия',
    marks.length >= 3 && pauseAt > 0 && last <= pauseAt + 500 && periods >= 8,
    `последний тик через ${last - pauseAt} мс от нажатия, после него приложение жило ${appExitAt - last} мс (~${periods} периодов тика)`)

  const journal = path.join(profile, 'tasks', 'tasks.json')
  const envelope = JSON.parse(fs.readFileSync(journal, 'utf8'))
  if (envelope.enc !== 'safeStorage') throw new Error('Журнал команды должен быть зашифрован на диске.')
  const read = spawnSync(electronBinary(), [path.join(__dirname, 'design-page-unwrap.cjs'), journal,
    '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, env: guiEnv(), encoding: 'utf8', timeout: 30000
  })
  if (read.error || read.status !== 0) throw new Error('Не удалось расшифровать тестовый журнал: ' + (read.error?.message || read.stderr))
  const decoded = JSON.parse(read.stdout)
  if (!decoded.enc) throw new Error('DPAPI не раскрыл тестовый журнал.')
  const records = JSON.parse(decoded.text).records
  if (!Array.isArray(records)) throw new Error('В тестовом журнале нет списка задач.')
  const command = records.find(one => String(one.title || '').startsWith('Команда:'))
  claim('команда легла в журнал очереди как работа производителя',
    Boolean(command) && command.kind === 'command', JSON.stringify(command && { state: command.state, kind: command.kind, attempts: command.attempts }))
  claim('рукоятка не уехала на диск', !JSON.stringify(records).includes('queueReport'), 'в журнале нет полей рукоятки')
}

const shot = path.join(out, 'task-command.png')
if (fs.existsSync(shot)) {
  const evidence = path.join(root, 'audits', 'qoder-2-2026-09-28', 'task-producers')
  fs.mkdirSync(evidence, { recursive: true })
  fs.copyFileSync(shot, path.join(evidence, 'task-command.png'))
  console.log('снимок: ' + path.join(evidence, 'task-command.png'))
}
const green = ok && claims.every(one => one.pass)
console.log(green ? 'Команда агента живёт в очереди и снимается оттуда' : 'Есть отказы в прогоне команды через очередь')
process.exitCode = green ? 0 : 1
settleRun(out, green)
