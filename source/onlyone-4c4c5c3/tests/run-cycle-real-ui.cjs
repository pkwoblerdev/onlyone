// Общий цикл на настоящих обработчиках (план, 2c).
// Здесь нет ни подставного цикла, ни подставного провайдера на полпути: окно
// запускается по-настоящему, настоящий `send-message` ведёт настоящий
// `runAgentLoop`, а вместо сети отвечает файл-сценарий (`ONECODE_PROVIDER_FILE`,
// шов работает только в непрособранном приложении). Так проверяется то, чем
// пользуются: отказ приёмки и успешная доработка, исчерпание бюджета, права
// режима и продолжение на остатке после перезапуска.
//
// Завершение хода определяется по состоянию прогона, а не по одному тексту:
// сначала кнопка перевоится в «стоп» (ход идёт), потом появляется ожидаемая
// фраза, потом кнопка возвращается в «отправить» (ход кончился). Сколько запросов
// сделал ход — считается по обращениям к тестовому провайдеру
// (`ONECODE_PROVIDER_LOG`): так «остаток вместо полного бюджета» проверяется
// числом, а не формулировкой.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const { createCheckpointStore, continuationPrompt } = require('../src/main/run-checkpoints')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-cycle-real')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })

// Каждый сценарий живёт в своём профиле: чаты, контрольные точки и очередь
// одного прогона не должны подменять другой. Пару «ход → перезапуск» намеренно
// сажаем на общий профиль — в этом и смысл проверки.
function makeProfile(tag) {
  const dir = path.join(out, 'profile-' + tag)
  fs.mkdirSync(dir, { recursive: true })
  // Ключ не используется: ответы берёт файл-сценарий. Нужен сам факт, что пул
  // непустой, — иначе ход останавливается до цикла.
  fs.writeFileSync(path.join(dir, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model',
    legacyStoragePurged: true,
    workspace: { path: workspace, permission: 'acceptEdits' }
  }))
  return dir
}

const PLAN_OPEN = { name: 'task_plan', args: { items: [
  { id: 'a', title: 'Кнопка отмены прерывает запрос', status: 'done' },
  { id: 'b', title: 'Отменённый запрос не пишет результат', status: 'todo' }
] } }
const PLAN_DONE = { name: 'task_plan', args: { items: [
  { id: 'a', title: 'Кнопка отмены прерывает запрос', status: 'done' },
  { id: 'b', title: 'Отменённый запрос не пишет результат', status: 'done' }
] } }

// Шаг цикла заканчивается только ответом без вызовов инструментов: после такого
// ответа и приходит приёмка. Поэтому в сценарии каждый вызов отделён пустым
// шагом, а судья — отдельным ответом без потока.
const turns = {
  // Первый ответ приёмки: «не готово» (чек-лист открыт), второй: «готово».
  rework: [
    { toolCalls: [PLAN_OPEN], text: 'Начал с кнопки отмены.' },
    { text: 'Первая попытка: кнопка есть, вторая часть открыта.' },
    { content: 'ВЕРДИКТ: НЕ ГОТОВО\n- пункт чек-листа не закрыт' },
    { toolCalls: [PLAN_DONE], text: 'Закрыл вторую часть.' },
    { text: 'Закрыл вторую часть, поведение проверено.' },
    { content: 'ВЕРДИКТ: ГОТОВО' }
  ],
  // Чек-лист не закрывается никогда: три продления и остаток вслух. Сценарий
  // конечен: после него провайдер отдаёт пустой ответ без вызовов, и ход
  // останавливается сам, а не идёт до предела в 200 шагов.
  stubborn: [
    { toolCalls: [PLAN_OPEN], text: 'Делаю.' },
    { text: 'Готово, вроде всё.' },
    { toolCalls: [PLAN_OPEN], text: 'Делаю.' },
    { text: 'Готово, вроде всё.' },
    { toolCalls: [PLAN_OPEN], text: 'Делаю.' },
    { text: 'Готово, вроде всё.' },
    { toolCalls: [PLAN_OPEN], text: 'Делаю.' },
    { text: 'Готово, вроде всё.' },
    { toolCalls: [PLAN_OPEN], text: 'Делаю.' },
    { text: 'Готово, вроде всё.' },
    { toolCalls: [PLAN_OPEN], text: 'Делаю.' },
    { text: 'Готово, вроде всё.' },
    { toolCalls: [PLAN_OPEN], text: 'Делаю.' },
    { text: 'Готово, вроде всё.' }
  ],
  // Дизайн: попытка файлового инструмента, потом настоящая проверка макета.
  design: [
    { toolCalls: [{ name: 'write_file', args: { path: 'index.html', content: '<h1>x</h1>' } }], text: 'Записываю страницу.' },
    { text: 'Страница готова.' },
    { content: 'ВЕРДИКТ: ГОТОВО' }
  ],
  // Долгий ход для отмены: шаги тормозятся самим сценарием (`delayMs` в шве
  // провайдера), иначе ход в тесте проходится за долю секунды, и останавливать
  // было бы нечего.
  slow: [
    { toolCalls: [PLAN_OPEN], text: 'Думаю.', delayMs: 900 },
    { text: 'Думаю дальше.', delayMs: 900 },
    { toolCalls: [PLAN_OPEN], text: 'Думаю.', delayMs: 900 },
    { text: 'Думаю ещё.', delayMs: 900 },
    { toolCalls: [PLAN_OPEN], text: 'Думаю.', delayMs: 900 },
    { text: 'Думаю ещё.', delayMs: 900 },
    { toolCalls: [PLAN_OPEN], text: 'Думаю.', delayMs: 900 },
    { text: 'Думаю ещё.', delayMs: 900 }
  ]
}

function providerFile(name) {
  const file = path.join(out, `provider-${name}.json`)
  fs.writeFileSync(file, JSON.stringify({ turns: turns[name] }))
  return file
}

function requestCount(name) {
  const file = path.join(out, `requests-${name}.log`)
  if (!fs.existsSync(file)) return -1
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
}

function launch(name, body, extraEnv = {}, opts = {}) {
  const profile = opts.profile || makeProfile(name)
  const script = path.join(out, `${name}.js`)
  const resultFile = path.join(out, `${name}.json`)
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 60000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) { try { if (fn()) return true } catch {}; await wait(120) }
      return false
    }
    const checks = []
    let extra = null
    const note = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const errors = []
    window.addEventListener('error', e => errors.push(String(e.message).slice(0, 160)))
    window.addEventListener('unhandledrejection', e => errors.push('promise: ' + String(e.reason?.message || e.reason).slice(0, 160)))
    await until(() => document.documentElement.dataset.appReady === '1')
    await wait(400)
    const feed = () => $('messagesList').innerText.replace(/\\s+/g, ' ')
    const designFeed = () => $('designMessages').innerText.replace(/\\s+/g, ' ')
    // Ход запускается нажатием, а не вызовом моста: только так проверяется тот
    // путь, по которому человек действительно говорит с приложением, и только
    // тогда в ленте есть что читать.
    const sendChat = async text => {
      $('newChatBtn')?.click()
      await wait(400)
      const box = $('composerTextarea')
      box.value = text
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      $('composerForm').requestSubmit()
    }
    const sendDesign = async text => {
      $('navDesign')?.click()
      await wait(400)
      const box = $('designComposerTextarea')
      box.value = text
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      $('designComposerForm').requestSubmit()
    }
    const stopRun = () => $('sendBtn')?.click()
    // Кнопка «стоп» — это состояние хода, а не текста: ход считается кончившимся,
    // только когда кнопка вернулась в «отправить».
    const busy = design => $(design ? 'designSendBtn' : 'sendBtn')?.classList.contains('is-stop')
    // Возвращает { started, said, idle }: ход начался, сказал ожидаемое, завершился.
    // Ждать только по тексту нельзя — фраза успевает появиться до конца хода.
    const runFinished = async (re, { design = false, ms = 90000 } = {}) => {
      const started = await until(() => busy(design), 20000)
      const said = await until(() => re.test(design ? designFeed() : feed()), ms)
      await wait(500)
      const idle = await until(() => !busy(design), 20000)
      return { started, said, idle }
    }
${body}
    const configurationHistory = await window.electronAPI.getRunConfigurations()
    note('конфигурация реального хода сохранена', configurationHistory.ok && configurationHistory.records.some(record => record.configurations.length > 0))
    note('история конфигураций содержит только отпечатки инструкций', configurationHistory.records.every(record => record.configurations.every(config => /^[a-f0-9]{64}$/.test(config.instructions))))
    await window.OnlyoneRunConfigurations.open({ t: value => value })
    note('экран конфигураций читает настоящий архив', document.querySelectorAll('.run-configurations-dialog tbody tr').length === 8)
    document.querySelector('.run-configurations-dialog header button')?.click()
    await until(() => !document.querySelector('.run-configurations-dialog'))
    note('ошибок в окне нет', !errors.length, errors.join(' | ') || 'нет')
    return { ok: checks.every(item => item.pass), checks, extra }
  })()`)
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 240000, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: providerFile(opts.provider || name),
      ONECODE_PROVIDER_LOG: path.join(out, `requests-${name}.log`),
      ONECODE_SHOT: path.join(out, `${name}.png`),
      ...extraEnv
    })
  })
  if (!fs.existsSync(resultFile)) {
    console.error(`ПРОВАЛ ${name}: окно не отчиталось (status ${child.status})`)
    return { ok: false, checks: [], name }
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error(`ПРОВАЛ ${name}: ${report.error}`)
  for (const c of report.checks || []) {
    console.log((c.pass ? '  ok     ' : '  ПРОВАЛ ') + `${name} · ${c.label}` + (c.detail ? ' — ' + c.detail.slice(0, 200) : ''))
  }
  report.name = name
  return report
}

const reports = []

// 1. Отказ приёмки и успешная доработка: продление ровно одно, из трёх.
reports.push(launch('rework', `
  await sendChat('Сделай кнопку отмены, двумя шагами.')
  const r = await runFinished(/поведение проверено/)
  note('ход дошёл до конца', r.said && r.idle, JSON.stringify(r) + ' | ' + feed().slice(0, 200))
  const answers = document.querySelectorAll('#messagesList .msg-item.assistant').length
  note('первая попытка была отклонена, вторая сдана',
    /вторая часть открыта/.test(feed()) && /поведение проверено/.test(feed()), feed().slice(0, 260))
  note('ход не кончился на отклонённой попытке', answers >= 1 && /поведение проверено/.test(feed()), 'ответов: ' + answers)
  note('бюджет не потрачен целиком', !/до предела/.test(feed()))
`))

// 2. Исчерпание бюджета: остаток называется словами, а не подметается.
// Число «готово» до предела — это полный бюджет; продолженный ход должен уложить-
// ся в меньшее число (сравнение — в ветке перезапуска).
const stubbornRun = launch('stubborn', `
  await sendChat('Сделай то, что не будет доделано.')
  const r = await runFinished(/продлевала ход до предела/)
  note('ход дошёл до конца', r.said && r.idle, JSON.stringify(r) + ' | ' + feed().slice(0, 200))
  note('три продления израсходованы', /до предела \\(3 из 3\\)/.test(feed()), feed().slice(-260))
  note('остаток назван вслух', /Приёмка продлевала ход до предела \\(3 из 3\\)/.test(feed()) &&
    /Отменённый запрос не пишет результат/.test(feed()), feed().slice(-300))
  note('итог проверок вышел списком', /Как закончилась проверка/.test(feed()) && /чек-лист/.test(feed()))
  extra = { tries: (feed().match(/Готово, вроде всё/g) || []).length }
`)
reports.push(stubbornRun)

// 3. Дизайн: файловый инструмент недоступен, проверка макета считается по
// прошлому или нет, протухшая проверка требует переделки.
reports.push(launch('design', `
  $('navDesign')?.click()
  await until(() => !$('designGallery').hidden, 8000)
  // Макет заводится нажатием, а не записью в хранилище: список в окне держит
  // свою копию, и чужая запись в нём не появляется.
  const starter = [...document.querySelectorAll('#designGallery .shelf-item')].find(item => /чистого листа/.test(item.textContent))
  note('формат выбран', !!starter)
  starter?.click()
  // Команда — по просьбе (07.10): этот сценарий проверяет путь команды с проверкой макета, поэтому просит её прямо.
  // Дизайн рождается из этих слов: первое сообщение уходит вместе с созданием.
  const askBox = $('dsNewIn')
  askBox.value = 'Собери макет, работайте вместе'
  askBox.dispatchEvent(new Event('input', { bubbles: true }))
  $('dsNewForm').requestSubmit()
  const opened = await until(() => !$('designWorkspace').hidden, 8000)
  note('макет открыт', opened)
  // Пока макет не выбран, запрос уйдёт не туда, где смотрит проверка: именем
  // открытого макета живёт шапка рабочей области.
  const title = $('designTitle')?.textContent.trim() || ''
  note('макет выбран и назван', opened && title.length > 0, 'шапка: ' + title)
  const r = await runFinished(/Страница готова/, { design: true })
  note('ход Дизайна дошёл до конца', r.said && r.idle, JSON.stringify(r) + ' | ' + designFeed().slice(0, 200))
  // Законченный ход — свёрнутый блок с итогом; строки вызовов строятся при раскрытии.
  document.querySelectorAll('#designMessages .thought-group').forEach(group => { group.open = true })
  await wait(300)
  const refused = [...document.querySelectorAll('#designMessages .tool')].map(node => node.innerText.replace(/\\s+/g, ' '))
  note('файловый инструмент в Дизайне не выполнен (прав не дано)',
    refused.some(line => /Не выполнено/.test(line) && /write_file|index\\.html/.test(line)), refused.join(' | ').slice(0, 260))
  note('вызовы макета остались в своей ленте',
    refused.some(line => /dc_check|dc_read|dc_list/i.test(line)) || /dc_check/i.test(designFeed()), refused.join(' | ').slice(0, 260))
`))

// 4. Отмена посреди хода: остановка работает, окно не падает, ход не доходит
// до последней фразы сценария.
reports.push(launch('slow', `
  await sendChat('Делай долго.')
  const started = await until(() => busy(false), 20000)
  await wait(1200)
  stopRun()
  const idle = await until(() => !busy(false), 20000)
  await wait(700)
  note('ход был запущен и остановлен по нажатию', started && idle, JSON.stringify({ started, idle }))
  note('остановленный ход не допел сценарий', !/Думаю ещё\\./.test(feed()), feed().slice(-200))
  note('окно живёт после остановки', document.documentElement.dataset.appReady === '1')
`))

// 5. Перезапуск: сначала обычный ход, между запусками кладётся контрольная
// точка с истраченным бюджетом, затем продолжение по карточке. Оба прогона —
// на одном профиле, иначе продолжать было бы нечего.
const restartProfile = makeProfile('restart')
const seed = launch('rework-seed', `
  await sendChat('Сделай кнопку отмены, двумя шагами.')
  const r = await runFinished(/поведение проверено/)
  note('первый ход завершён', r.said && r.idle, JSON.stringify(r))
  // История уходит на диск с задержкой в 400 мс; без запаса следующий запуск
  // не нашёл бы чат и карточка продолжения не появилась бы вообще.
  await wait(1500)
  const chatId = document.querySelector('.history-item')?.dataset.chatId || ''
  note('чат создан', !!chatId, chatId)
  return { ok: r.said && r.idle && !!chatId, checks, chatId }
`, {}, { profile: restartProfile, provider: 'rework' })

// Контрольная точка лежит в профиле: именно оттуда её читает приложение при
// следующем запуске.
const runsDir = path.join(restartProfile, 'runs')
fs.mkdirSync(runsDir, { recursive: true })
const runId = 'cccccccc-1111-2222-3333-444444444444'
const store = createCheckpointStore({ dir: runsDir })
const seedRun = store.start({ runId, chatId: seed.chatId || 'chat-1', ask: 'сделай кнопку отмены двумя шагами' })
seedRun.begin('write_file', { path: 'a.js' }).end('done')
seedRun.begin('run_command', { command: 'npm test' })
const { createCycle } = require('../src/main/agent-cycle')
const cycle = createCycle({})
cycle.spend('reworks')
cycle.spend('reworks')
cycle.spend('judge')
cycle.record({ source: 'acceptance', verdict: 'fail', gaps: ['не закрыт чек-лист'] })
seedRun.updateCycle(cycle.snapshot())
const interrupted = store.interrupted()[0]
const before = continuationPrompt(interrupted)
fs.writeFileSync(path.join(out, 'continuation.txt'), before || '')
reports.push(seed)

// Продолжение: карточка, «Продолжить» — и ход упирается в предел, потратив
// только остаток. Сценарий упрямо не закрывает чек-лист, поэтому без остатка
// было бы три продления, а с ним — одно.
const fullTries = (stubbornRun.extra && stubbornRun.extra.tries) || 0
reports.push(launch('rework-2', `
  // Без чата, дожившего до второго запуска, карточке появляться негде:
  // отдельная проверка отделяет «профиль не пережил перезапуск» от «карточка
  // не показалась».
  const chatAlive = await until(() => document.querySelectorAll('.history-item').length > 0, 8000)
  note('чат пережил перезапуск', chatAlive, 'чатов: ' + document.querySelectorAll('.history-item').length)
  const shown = await until(() => document.querySelector('#messagesList .approval-card.kind-resume'), 15000)
  const card = document.querySelector('#messagesList .approval-card.kind-resume')
  note('карточка продолжения появилась', shown && !!card, card?.innerText.replace(/\\s+/g, ' ').slice(0, 160))
  card?.querySelector('.approval-allow')?.click()
  const r = await runFinished(/до предела/)
  note('продолжение дошло до конца', r.said && r.idle, JSON.stringify(r) + ' | ' + feed().slice(0, 200))
  // Сколько раз ход успел сказать «готово» до предела. Сравн — прогон того же
  // сценария с полным бюджетом: ${fullTries} продлений.
  const tries = (feed().match(/Готово, вроде всё/g) || []).length
  note('израсходован остаток, а не полный бюджет', tries >= 1 && tries < ${fullTries || 99},
    'продлений в продолжении: ' + tries + ', с полным бюджетом: ${fullTries}')
  note('остаток назван в итоге проверок', /Бюджет продолжен с остатка/.test(feed()), feed().slice(-260))
  note('карточка снята с глаз', !document.querySelector('#messagesList .approval-card.kind-resume'))
  extra = { tries }
`, {}, { profile: restartProfile, provider: 'stubborn' }))

const afterRuns = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(n => n.endsWith('.json')) : []
console.log((afterRuns.length ? '  ПРОВАЛ ' : '  ok     ') + 'прежняя контрольная точка снята после продолжения: ' + JSON.stringify(afterRuns))

const carriedOk = Boolean(before && /npm test/.test(before) && /a\.js/.test(before))
console.log((carriedOk ? '  ok     ' : '  ПРОВАЛ ') + 'опись продолжения помнит сделанное и непроверенное до старта')

// Настоящее число обращений к модели вместо догадок по тексту: продолженный ход
// тратит остаток, поэтому запросов у него меньше, чем у такого же сценария с
// полным бюджетом.
const full = requestCount('stubborn')
const continued = requestCount('rework-2')
const budgetOk = full > 0 && continued > 0 && continued < full
console.log((budgetOk ? '  ok     ' : '  ПРОВАЛ ') +
  `продолжение сделало меньше запросов, чем полный бюджет: ${continued} против ${full}`)

for (const name of ['rework', 'stubborn', 'design', 'slow', 'rework-2']) {
  const shot = path.join(out, `${name}.png`)
  if (process.env.ONECODE_EVIDENCE_DIR && fs.existsSync(shot)) {
    fs.mkdirSync(process.env.ONECODE_EVIDENCE_DIR, { recursive: true })
    fs.copyFileSync(shot, path.join(process.env.ONECODE_EVIDENCE_DIR, `cycle-${name}.png`))
  }
}

const ok = reports.every(report => report && report.ok !== false) && afterRuns.length === 0 && carriedOk && budgetOk
console.log(ok ? 'Общий цикл проходит настоящими обработчиками во всех режимах' : 'Есть провалы в сквозной проверке цикла')
settleRun(out, ok)
process.exitCode = ok ? 0 : 1
