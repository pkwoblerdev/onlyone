'use strict'
// Все отправки хода в окно идут через одну точку.
//
// Гонка была закрыта только в области многоагентного хода, а вне её в `main.js`
// оставалось 89 прямых `event.sender.send(`. Каждый из них в момент закрытия
// или перезагрузки окна бросает `TypeError: Object has been destroyed` — ровно
// тот симптом, который виден в адресном прогоне. Тест красный, пока хоть одна
// прямая отправка стоит на месте, способном пережить смерть окна.
//
// Что проверяется, и почему именно так:
//   1. Инвентаризация: вне тела самой `sendToWindow` прямых отправок нет. Это
//      единственная проверка, которая видит все 89 мест сразу, и она не позволяет
//      «закрыть» задачу молчаливым исключением функции из-под счёта: список
//      функций-владелиц печатается в отказе.
//   2. Поведение на настоящем коде: карточка разрешения, карточка вопроса и
//      стримовые `emitContent`/`emitReasoning` вырезаются из `main.js` и
//      исполняются с мёртвым адресатом. Не бросают, ничего мёртвому окну не
//      досылают — и то же самое с живым адресатом доносит events без изменения
//      канала и формы. Подставки вместо product-кода здесь сознательно нет:
//      своя копия функции была бы зелёной и на сломанном.
//   3. Форма вызова: `sendToWindow` зовут с событием первым аргументом и с
//      каналом вторым. Механический перевод 89 мест одинаковым текстовым шагом
//      хорош ровно до момента, когда в какой-нибудь функции `event` означает не
//      IPC-событие; проверка это ловит.
//   4. Сам охранитель не оглушает чужие ошибки (то же, что в узком наборе
//      `test-run-window-gone.cjs`, но на этот раз — что он единственный путь, и
//      правила его не менялись по ходу миграции).
//
// Платных моделей, сети и Electron здесь нет. Будильник держит процесс: виснет
// ход — прогон падает с ненулевым кодом, а не выходит «зелёным по таймауту».
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: тест даёт им и переводчик фраз для окна.
globalThis.tr = require('../src/main/ui-text.cjs').tr

const MAIN_PATH = process.env.ONECODE_MAIN_UNDER_TEST ||
  path.join(__dirname, '..', 'src', 'main', 'main.js')
const main = fs.readFileSync(MAIN_PATH, 'utf8')
const lines = main.split('\n')

function at (marker, from = 0) {
  const index = main.indexOf(marker, from)
  if (index < 0) throw new Error('якорь пропал из main.js: ' + marker)
  return index
}
const cut = (from, to) => main.slice(at(from), at(to, at(from) + from.length))

const GUARD_MARK = 'function sendToWindow(event, channel, body) {'
const GUARD_CODE = cut(GUARD_MARK, 'async function runAgentMode(')
const APPROVAL_CODE = cut('async function requestApproval(event', '// A destroyed renderer can never answer')
const ASK_CODE = cut('async function askUser(event', '// Plan mode refuses')
const EMIT_CODE = cut('const emitContent = text => {', '\n  const teamSeen = new Set()')
const INVENTORY_FUNCTION_MARKS = [
  'async function requestApproval(event', 'async function askUser(event',
  'async function executeTool(event', 'async function streamChatOpenRouter(event',
  'async function runAgentLoop(event', 'function replyForSmokeTest(',
  'function showArtifact(', 'function updateArtifact(', 'function executeProjectTool(',
  'function runWorkspaceCommand(', 'function runCustomTool(', 'function defineCustomTool(',
  'function executeMcpTool(', 'function recordTurnPlan(', 'function recordBoardUpdate(',
  'function recordBoardMessage('
]

const failures = []
let checks = 0
function check (name, ok, detail) {
  checks += 1
  if (ok === true) { console.log('ok', name); return }
  failures.push(name)
  console.error(`ПРОВАЛ [${name}]${detail === undefined ? '' : ': ' + detail}`)
}

const watchdog = setTimeout(() => {
  console.error('ПРОВАЛ: набор window-send-all висит дольше 90 с — ожидание не снято')
  process.exit(1)
}, 90000)
const settle = () => new Promise(resolve => setImmediate(resolve))

// Как отвечает настоящий `ipcMain.handle('resolve-agent-*')`: запись достаётся
// из карты, снимается с неё и только потом разрешается. Проверка «ожидание не
// повисло» обязана идти тем же путём, что продукт, а не своим боковым.
function answer (map, value) {
  const id = [...map.keys()][0]
  if (!id) return false
  const entry = map.get(id)
  map.delete(id)
  entry.resolve(value)
  return true
}

// Адресат — ровно договор WebContents: `isDestroyed()` и `send()`. Мёртвый
// адресат обязан вести себя как настоящий: Electron на уничтоженном объекте
// бросает `TypeError: Object has been destroyed`, и именно этот бросок тест и
// ловит. Счётчик нужен, чтобы «мёртвому не дослали» было чем доказать.
function senderOf ({ destroyed = false, throws = null, id = 7 } = {}) {
  const sent = []
  const touched = { send: 0, isDestroyed: 0 }
  const sender = { id, sent, touched, send: (channel, body) => {
    touched.send += 1
    if (throws) throw throws
    if (destroyed) throw new TypeError('Object has been destroyed')
    sent.push({ channel, body })
  } }
  if (destroyed) sender.isDestroyed = () => { touched.isDestroyed += 1; return true }
  return sender
}
const eventOf = sender => ({ sender })

// Кто сейчас говорит «event»: имена-переменные, которые в `main.js` являются
// IPC-событием. Список — не догма, а защита от автозамены в чужом скоупе.
const EVENT_NAMES = ['event', '_event', 'evt']

function bareSenders () {
  const guardStart = at(GUARD_MARK)
  const guardEnd = at('async function runAgentMode(')
  const out = []
  const re = /([A-Za-z_$][\w$.]*)\.sender\.send\(/g
  let offset = 0
  for (let index = 0; index < lines.length; index++) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(lines[index]))) {
      const here = offset + match.index
      if (here < guardStart || here >= guardEnd) {
        out.push({ line: index + 1, who: match[1], offset: here, text: lines[index].trim().slice(0, 80) })
      }
    }
    offset += lines[index].length + 1
  }
  return out
}

// Ближайшая объявленная функция ВЫШЕ строки — чтобы отказ говорил «сколько мест
// и в каких функциях», а не просто число.
const FUNCTION_STARTS = INVENTORY_FUNCTION_MARKS
  .map(mark => ({ name: mark.split('(')[0].replace('async ', '').trim(), index: main.indexOf(mark) }))
  .filter(one => one.index >= 0)
  .sort((a, b) => a.index - b.index)
function ownerOf (offset) {
  let owner = '(вне известных функций)'
  for (const one of FUNCTION_STARTS) if (one.index < offset) owner = one.name
  return owner
}

function guardedCalls () {
  const out = []
  const re = /sendToWindow\(\s*([^,)]+),\s*([^,)]+)/g
  let offset = 0
  for (let index = 0; index < lines.length; index++) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(lines[index]))) {
      if (!lines[index].trim().startsWith('function sendToWindow')) {
        out.push({ line: index + 1, first: match[1].trim(), channel: match[2].trim(), text: lines[index].trim().slice(0, 90) })
      }
    }
    offset += lines[index].length + 1
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. Инвентаризация
// ---------------------------------------------------------------------------

const bare = bareSenders()
const owners = new Map()
for (const one of bare) {
  const name = ownerOf(one.offset)
  owners.set(name, (owners.get(name) || 0) + 1)
}
check('п.1 в main.js нет прямых `X.sender.send(` вне охранителя',
  bare.length === 0,
  `прямых отправок ${bare.length} в ${[...owners.keys()].length}+ функциях: ` +
  [...owners.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} — ${v}`).join(', ') +
  `. Первые: ${bare.slice(0, 3).map(one => `строка ${one.line} (${one.who})`).join(', ')} ` +
  `— после перевода на sendToWindow всех мест проверка зеленеет`)

// Честность самой инвентаризации: если бы охранитель пропал, проверка не должна
// молча позеленеть на пустом списке.
check('управление: инвентаризация видит и живой путь, и мёртвый (охранитель найден, прямые отправки сосчитаны)',
  GUARD_CODE.includes('function sendToWindow') && /sender\.send\(channel, body\)/.test(GUARD_CODE) &&
  Array.isArray(bare), `охранитель: ${GUARD_CODE.length} знаков, прямых: ${bare.length}`)

// ---------------------------------------------------------------------------
// 2. Поведение на вырезанном product-коде
// ---------------------------------------------------------------------------

function runApproval (sender) {
  const pendingApprovals = new Map()
  const fn = new Function('event', 'crypto', 'pendingApprovals', 'APPROVAL_TIMEOUT_MS',
    'selfDevActive', 'approvalRequired', 'workspace', 'sendToWindow',
    `${GUARD_CODE}\n${APPROVAL_CODE}\n; return requestApproval`)(
    eventOf(sender), crypto, pendingApprovals, 30000, () => false, () => true,
    { permission: 'read' }, new Function(`${GUARD_CODE}; return sendToWindow`)())
  return { fn, pendingApprovals }
}

function runAsk (sender) {
  const pendingQuestions = new Map()
  const normalizeAskOptions = raw => (Array.isArray(raw) ? raw : [])
    .map(option => ({ label: String(option?.label || '').trim(), detail: String(option?.detail || '').trim() }))
    .filter(Boolean)
  const fn = new Function('event', 'crypto', 'pendingQuestions', 'APPROVAL_TIMEOUT_MS', 'normalizeAskOptions',
    'COLOR_ONLY', 'sendToWindow', `${GUARD_CODE}\n${ASK_CODE}\n; return askUser`)(
    eventOf(sender), crypto, pendingQuestions, 30000, normalizeAskOptions,
    /^(#[0-9a-f]{3,8}|[a-z]+)$/i, new Function(`${GUARD_CODE}; return sendToWindow`)())
  return { fn, pendingQuestions }
}

function runEmitters (sender, extra = {}) {
  const fn = new Function('event', 'payload', 'agentIndex', 'agentName', 'sendToWindow',
    `${GUARD_CODE}\n${EMIT_CODE}\n; return { emitContent, emitReasoning }`)(
    eventOf(sender), { requestId: 'req-1' }, 2, 'Агент 2',
    new Function(`${GUARD_CODE}; return sendToWindow`)())
  return { ...fn, ...extra }
}

;(async () => {
  // 2a. Карточка разрешения.
  const liveSender = senderOf()
  const live = runApproval(liveSender)
  let threwLive = null
  const granted = live.fn(eventOf(liveSender), { summary: 'записать файл', risk: 'edit', requestId: 'r-1' })
    .catch(error => { threwLive = error; return 'throw' })
  await settle()
  answer(live.pendingApprovals, true)
  const liveResult = await granted
  check('п.2a живое окно: карточка разрешения доходит без броска, каналы и форма прежние',
    threwLive === null && liveResult === true &&
    liveSender.sent.map(one => one.channel).join(',') === 'agent-approval,agent-event,agent-approval-done,agent-event' &&
    liveSender.sent[0].body.summary === 'записать файл' &&
    liveSender.sent[1].body.awaitingApproval === true && liveSender.sent[3].body.awaitingApproval === false,
    `бросок: ${threwLive && threwLive.message}, каналов: ${liveSender.sent.map(one => one.channel).join(', ')}, ответ: ${liveResult}`)

  const deadSender = senderOf({ destroyed: true })
  const dead = runApproval(deadSender)
  let threwDead = null
  const asked = dead.fn(eventOf(deadSender), { summary: 'записать файл', risk: 'edit', requestId: 'r-2' })
    .catch(error => { threwDead = error; return 'throw' })
  await settle()
  answer(dead.pendingApprovals, false)
  const deadResult = await asked
  check('п.2a мёртвое окно: разрешения не бросают, ничего не досылаются, ожидание не повисло',
    threwDead === null && deadResult === false && deadSender.sent.length === 0 &&
    deadSender.touched.send === 0 && dead.pendingApprovals.size === 0,
    `бросок: ${threwDead && (threwDead.name + ': ' + threwDead.message)}, дослано: ${deadSender.sent.length}, ` +
    `висит ожиданий: ${dead.pendingApprovals.size}`)

  // 2b. Карточка вопроса.
  const askLiveSender = senderOf()
  const askLive = runAsk(askLiveSender)
  let threwAskLive = null
  const answered = askLive.fn(eventOf(askLiveSender),
    { question: 'Какой вариант?', options: [{ label: 'Первый' }, { label: 'Второй' }] }, 'r-3')
    .catch(error => { threwAskLive = error; return null })
  await settle()
  answer(askLive.pendingQuestions, 'Первый')
  const askLiveResult = await answered
  check('п.2b живое окно: вопрос доходит, ответ человека возвращается целиком',
    threwAskLive === null && askLiveResult?.answered === true && askLiveResult?.answer === 'Первый' &&
    askLiveSender.sent.map(one => one.channel).join(',') === 'agent-question,agent-event,agent-question,agent-event',
    `бросок: ${threwAskLive && threwAskLive.message}, каналов: ${askLiveSender.sent.map(one => one.channel).join(', ')}`)

  const askDeadSender = senderOf({ destroyed: true })
  const askDead = runAsk(askDeadSender)
  let threwAskDead = null
  const answeredDead = askDead.fn(eventOf(askDeadSender),
    { question: 'Какой вариант?', options: [{ label: 'Первый' }, { label: 'Второй' }] }, 'r-4')
    .catch(error => { threwAskDead = error; return null })
  await settle()
  answer(askDead.pendingQuestions, null)
  const askDeadResult = await answeredDead
  check('п.2b мёртвое окно: вопрос и его снятие не бросают и не оставляют карточку висеть',
    threwAskDead === null && askDeadSender.sent.length === 0 && askDeadSender.touched.send === 0 &&
    askDead.pendingQuestions.size === 0 &&
    askDeadResult?.answered === false,
    `бросок: ${threwAskDead && (threwAskDead.name + ': ' + threwAskDead.message)}, ` +
    `дослано: ${askDeadSender.sent.length}, висит: ${askDead.pendingQuestions.size}`)

  // 2c. Стрим ответов модели — 29 мест в `runAgentLoop`, самые частые.
  const streamLive = senderOf()
  const emLive = runEmitters(streamLive)
  let threwStreamLive = null
  try { emLive.emitContent('привет'); emLive.emitReasoning('думаю', 'думаю целком') }
  catch (error) { threwStreamLive = error }
  check('п.2c живое окно: куски стрима идут через охранитель без броска, каналы и тело прежние',
    threwStreamLive === null && streamLive.sent.length === 2 &&
    streamLive.sent[0].channel === 'message-chunk' && streamLive.sent[0].body.choices[0].delta.content === 'привет' &&
    streamLive.sent[0].body.agentIndex === 2 && streamLive.sent[0].body.agentName === 'Агент 2' &&
    streamLive.sent[1].channel === 'message-reasoning-chunk' && streamLive.sent[1].body.text === 'думаю',
    `бросок: ${threwStreamLive && (threwStreamLive.name + ': ' + threwStreamLive.message)}, отправлено: ${streamLive.sent.length}`)

  const streamDead = senderOf({ destroyed: true })
  const emDead = runEmitters(streamDead)
  let threwStreamDead = null
  try { emDead.emitContent('привет'); emDead.emitReasoning('думаю', 'думаю целиком') }
  catch (error) { threwStreamDead = error }
  check('п.2c мёртвое окно: куски стрима не бросают — именно этот путь ронял обычный чат',
    threwStreamDead === null && streamDead.sent.length === 0 && streamDead.touched.send === 0,
    `бросок: ${threwStreamDead && (threwStreamDead.name + ': ' + threwStreamDead.message)}, дослано: ${streamDead.sent.length}`)

  // 2d. Охранитель не оглушает чужую ошибку (то же правило, что в узком наборе).
  const wrongSender = senderOf({ throws: new TypeError('serialization failed: function cannot be cloned') })
  const emWrong = runEmitters(wrongSender)
  let threwWrong = null
  try { emWrong.emitContent('текст') } catch (error) { threwWrong = error }
  check('п.2d чужая ошибка из send летит наружу, а не прячется за «окно мертво»',
    threwWrong instanceof TypeError && /serialization failed/.test(threwWrong.message),
    threwWrong ? `${threwWrong.name}: ${threwWrong.message}` : 'не бросило вовсе')

  // -----------------------------------------------------------------------
  // 3. Форма вызова
  // -----------------------------------------------------------------------
  const calls = guardedCalls()
  const bad = calls.filter(one => !EVENT_NAMES.includes(one.first))
  check('п.3 все вызовы sendToWindow передают IPC-событие первым аргументом',
    bad.length === 0 && calls.length > 0,
    `вызовов: ${calls.length}, с первым аргументом не-событие: ${bad.length}` +
    (bad.length ? `. Примеры: ${bad.slice(0, 4).map(one => `строка ${one.line + 1}: ${one.text}`).join(' | ')}` : ''))

  const noChannel = calls.filter(one => !/^(['"`][a-z0-9-]+['"`])$/.test(one.channel))
  check('п.3 канал отправки — строковый литерал, а не вычисленное имя (иначе инвентаризация каналов врёт)',
    noChannel.length === 0,
    noChannel.length ? `пример: ${noChannel.slice(0, 3).map(one => `строка ${one.line + 1}: ${one.text}`).join(' | ')}` : 'все каналы литералы')

  const clean = failures.length === 0
  console.log(clean ? `проверок: ${checks}, провалов 0` :
    `ПРОВАЛ: провалено ${failures.length} из ${checks}: ${failures.join(' | ')}`)
  console.log(JSON.stringify({ ok: clean, checks, failed: failures.length, failures,
    bareSenders: bare.length, guardedCalls: calls.length, source: MAIN_PATH }))
  process.exitCode = clean ? 0 : 1
})().catch(error => {
  failures.push('прогон оборвался')
  console.error('ПРОВАЛ: набор window-send-all оборвался —', error && error.stack || error)
  console.log(JSON.stringify({ ok: false, checks, failed: failures.length, failures }))
  process.exitCode = 1
}).finally(() => { clearTimeout(watchdog) })
