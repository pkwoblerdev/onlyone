// Оконная проверка очереди фоновых задач (план, 3.4): три настоящих окна.
//
// Профиль заводится временный, и в нём заранее лежит журнал очереди — тот же
// файл, что пишет планировщик (`<профиль>/tasks/tasks.json`). Приложение
// поднимает настоящие дочерние процессы (локальный `node` с `-e`), окно ими
// управляет, а прогон обрывается на середине работы: журнал остаётся со словом
// «running», и второй запуск превращает такую задачу в «прерванную». Это ровно
// то, что видит человек, закрывший приложение посреди сборки, — дети Electron у
// Windows доживают только до выхода самого приложения, а ответа о их итоге
// планировщик не получил.
//
// Зелёный прогон убирает свой каталог, красный оставляет; кадры копируются в
// `audits/…` до уборки — снимок обязан пережить прогон.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('1code-task-queue')
const evidence = process.env.ONECODE_EVIDENCE_DIR
  || path.join(root, 'audits', 'qoder-2-2026-09-27', 'task-center')
const pidDir = path.join(out, 'pids')
const SECRET = 'sk-QoderTest-1234567890'
const CRASH_CODE = '3'
// Долгие процессы нужны затем, чтобы пауза была заметна: снятый процесс
// умирает по-настоящему, а не «успел сам».
const SLOW_MS = 9000
const LONG_MS = 30000
const nodeExe = process.execPath

const TITLES = {
  pause: 'Пауза живой сборки',
  second: 'Сборка во второй слот',
  third: 'Сборка в третий слот',
  cancel: 'Отмена ожидающей',
  crash: 'Падение с кодом',
  secret: 'Сборка с токеном',
  wait: 'Ожидание своей волны',
  long: 'Долгая сборка',
  paused: 'Пауза с прогрессом',
  ready: 'Готовая ранее'
}

function sleepScript(id, ms) {
  const mark = path.join(pidDir, `${id}.pid`)
  return `require('fs').writeFileSync(${JSON.stringify(mark)}, String(process.pid)); setTimeout(() => {}, ${ms})`
}

function rec(id, title, extra = {}) {
  return {
    id, title, kind: 'shell', priority: 'normal', state: 'queued', progress: null,
    startedAt: null, finishedAt: null, error: '', attempts: 0, log: [],
    command: nodeExe, args: ['-e', 'process.exit(0)'], ...extra
  }
}

// Один и тот же посев для обоих профилей: в английской копии «Долгая сборка»
// кладётся уже состоявшейся, чтобы «прервано» было чем показать на первом же
// запуске (в русской копии его даёт выход приложения из первого прогона).
function seedRecords(options = {}) {
  return [
    rec('a1', TITLES.pause, { args: ['-e', sleepScript('a1', LONG_MS)] }),
    rec('a2', TITLES.second, { args: ['-e', sleepScript('a2', SLOW_MS)] }),
    rec('a3', TITLES.third, { args: ['-e', sleepScript('a3', SLOW_MS)] }),
    rec('cancel', TITLES.cancel, { args: ['-e', sleepScript('cancel', LONG_MS)] }),
    rec('crash', TITLES.crash, { args: ['-e', `process.exit(${CRASH_CODE})`] }),
    rec('secret', `${TITLES.secret} ${SECRET}`, {
      args: ['-e', `console.error(${JSON.stringify('ключ ' + SECRET)}); process.exit(2)`]
    }),
    rec('wait', TITLES.wait),
    rec('long', TITLES.long, {
      priority: 'low', state: options.interruptedAlready ? 'running' : 'queued',
      args: ['-e', sleepScript('long', LONG_MS)]
    }),
    rec('paused', TITLES.paused, { state: 'paused', progress: 0.4 }),
    rec('ready', TITLES.ready, { state: 'done', finishedAt: Date.now() - 60000 })
  ]
}

function seedTasks(profile, options = {}) {
  const dir = path.join(profile, 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'tasks.json'),
    JSON.stringify({ schemaVersion: 1, savedAt: Date.now(), records: seedRecords(options) }, null, 2))
  return path.join(dir, 'tasks.json')
}

function journalOf(profile) {
  const file = path.join(profile, 'tasks', 'tasks.json')
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (envelope.enc !== 'safeStorage') throw new Error('Журнал очереди должен быть зашифрован на диске.')
  // Reuse the existing Electron/DPAPI reader on this disposable profile after the app exits.
  const read = spawnSync(electronBinary(), [path.join(__dirname, 'design-page-unwrap.cjs'), file,
    '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, env: guiEnv(), encoding: 'utf8', timeout: 30000
  })
  if (read.error || read.status !== 0) throw new Error('Не удалось расшифровать тестовый журнал: ' + (read.error?.message || read.stderr))
  const decoded = JSON.parse(read.stdout)
  if (!decoded.enc) throw new Error('DPAPI не раскрыл тестовый журнал.')
  const parsed = JSON.parse(decoded.text)
  if (!Array.isArray(parsed.records)) throw new Error('В тестовом журнале нет списка задач.')
  return parsed.records
}

function pidOf(id) {
  try { return Number(fs.readFileSync(path.join(pidDir, `${id}.pid`), 'utf8')) } catch { return 0 }
}

function killChildren(ids) {
  for (const id of ids) {
    const pid = pidOf(id)
    if (!pid) continue
    try { process.kill(pid) } catch { /* процесс уже умер сам */ }
  }
}

function launch(name, profile, args) {
  const resultFile = path.join(out, `${name}.json`)
  const child = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
      cwd: root, timeout: 240000, stdio: 'inherit',
      env: guiEnv({
        ONECODE_SMOKE: path.join(__dirname, 'task-center-queue-renderer.js'),
        ONECODE_SMOKE_OUT: resultFile,
        ONECODE_SHOT: path.join(out, `${name}.png`),
        // Путь к node и тело `-e` не должны попасть ни в аргументы командной
        // строки, ни в файл: окно получает их base64-ом, как и соседний прогон.
        ONECODE_ARG: Buffer.from(JSON.stringify({
          nodeExe, secret: SECRET, crashCode: CRASH_CODE, titles: TITLES, ...args
        }), 'utf8').toString('base64')
      })
    })
  if (child.error) throw child.error
  const shot = path.join(out, `${name}.png`)
  if (fs.existsSync(shot)) {
    fs.mkdirSync(evidence, { recursive: true })
    fs.copyFileSync(shot, path.join(evidence, `task-center-${name}.png`))
  }
  if (!fs.existsSync(resultFile)) {
    console.error(`Окно не отчиталось: ${name} (status ${child.status})`)
    return { ok: false, checks: [] }
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error(`${name}: окно сообщило об ошибке — ${report.error}`)
  for (const item of report.checks || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + name + ' · ' + item.name +
      (item.detail ? ' — ' + item.detail : ''))
  }
  console.log(`снимок: ${path.join(evidence, `task-center-${name}.png`)}`)
  return report
}

const notes = []
function claim(name, pass, detail) {
  notes.push({ name, pass: Boolean(pass), detail: String(detail === undefined ? '' : detail) })
  console.log((pass ? '  ok  ' : 'ПРОВАЛ ') + 'диск · ' + name + (detail ? ` — ${detail}` : ''))
}

function main() {
  fs.mkdirSync(pidDir, { recursive: true })
  const ruProfile = path.join(out, 'profile-ru')
  const enProfile = path.join(out, 'profile-en')
  fs.mkdirSync(ruProfile, { recursive: true })
  fs.mkdirSync(enProfile, { recursive: true })
  seedTasks(ruProfile)
  seedTasks(enProfile, { interruptedAlready: true })

  const queue = launch('queue-ru', ruProfile, {
    mode: 'queue', minRows: 9, surfaceLabel: 'Очередь задач',
    labels: { running: 'В работе', waiting: 'Ожидает', interrupted: 'Прервано' }
  })
  // Что осталось на диске после выхода приложения: «взято в работу» обязано
  // пережить гибель процесса, иначе «прервано» следующего запуска было бы
  // выдумкой экрана.
  const journal = journalOf(ruProfile)
  const byId = id => journal.find(one => one && one.id === id) || {}
  const stillRunning = journal.filter(one => one && one.state === 'running').map(one => one.id)
  claim('журнал сохранил задачу «в работе» до ответа процесса', stillRunning.includes('long'),
    `running на диске: ${stillRunning.join(',') || 'нет'}`)
  // Жив ли процесс после выхода приложения, ничего не доказывает: Electron на
  // Windows держит детей в job-объекте, и они снимаются вместе с ним. Поэтому
  // здесь проверяются следы, которые оставил НАСТОЯЩИЙ процесс: файл pid,
  // записанный самим ребёнком, и состояние очереди на диске.
  claim('долгая задача исполнялась настоящим процессом', pidOf('long') > 0, `pid ${pidOf('long')}`)
  claim('пауза дожила до журнала: задача записана снятой с работы',
    byId('a1').state === 'paused' && Number(byId('a1').attempts) === 1,
    `${byId('a1').state}, попыток ${byId('a1').attempts}`)
  const raw = JSON.stringify(journal)
  claim('токена нет в журнале на диске', !raw.includes(SECRET),
    raw.includes(SECRET) ? 'токен читается целиком' : 'зачищен')
  claim('форма зачистки в журнале — как у redactSecrets', /\*\*\*/.test(raw), '*** на месте')
  killChildren(['a1', 'a2', 'a3', 'cancel', 'long'])

  const interrupted = launch('interrupted-ru', ruProfile, {
    mode: 'interrupted', minRows: 8, surfaceLabel: 'Очередь задач',
    labels: { running: 'В работе', waiting: 'Ожидает', interrupted: 'Прервано' }
  })
  const afterRestart = journalOf(ruProfile).find(one => one && one.id === 'crash')
  claim('перезапуск упавшей задачи действительно поднял процесс ещё раз',
    Number(afterRestart && afterRestart.attempts) >= 2, `попыток: ${afterRestart && afterRestart.attempts}`)
  killChildren(['a1', 'a2', 'a3', 'cancel', 'long'])

  const en = launch('queue-en', enProfile, {
    mode: 'queue-en', minRows: 9, surfaceLabel: 'Очередь задач',
    labels: { running: 'В работе', waiting: 'Ожидает', interrupted: 'Прервано' },
    en: { running: 'In progress', waiting: 'Waiting', interrupted: 'Interrupted' }
  })
  killChildren(['a1', 'a2', 'a3', 'cancel', 'long'])

  const failed = [...(queue.checks || []), ...(interrupted.checks || []), ...(en.checks || []), ...notes]
    .filter(one => !one.pass)
  const ok = queue.ok && interrupted.ok && en.ok && !failed.length
  console.log(ok ? 'Очередь задач работает в окне' : `Есть отказы в оконном прогоне очереди: ${failed.length}`)
  for (const item of failed) console.log('отказ: ' + item.name + (item.detail ? ` — ${item.detail}` : ''))
  console.log(`кадры: ${evidence}`)
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

try {
  main()
} catch (error) {
  console.error('ПРОВАЛ [набор]', error && error.message)
  settleRun(out, false)
  process.exitCode = 1
}
