'use strict'
// Уход окна посреди хода: единственная точка отправки, отмена ходов и привязка
// жизненного цикла окна к этой отмене.
//
// Что стоит под регрессией. Ход пишет в окно, а окно в этот момент закрывают
// (или оно падает, или его перезагружают). `.send` в уничтоженный WebContents
// бросает `TypeError: Object has been destroyed`, и раньше этот бросок из глубины
// хода убивал весь ход: человек не получал ни ответа, ни внятной причины. На этом
// пути теперь три вещи, и они сшиты между собой:
//   * `sendToWindow` — единственная точка отправки событий хода;
//   * `abortActiveTurns` — отмена активных ходов тем же механизмом, что и кнопка
//     «Стоп» (ход закрывается через свой `finally`, а не бросается на середине);
//   * `onWindowGone` — привязка второго к событиям окна.
//
// Платных моделей, сети и Electron-окна здесь нет: адресат — подставный `sender`
// с договором `isDestroyed()` + `send()`, ход — настоящий `AbortController`, какой
// заводит `send-message`. Но логика в тесте не переписывается: тела функций
// вырезаются из `src/main/main.js` по маркерам и исполняются через `new Function`
// с подставленными зависимостями — тот же приём, что в
// `test-run-checkpoint-main-wiring.cjs` и `test-dispatch-runtime.cjs`. Своя копия
// `sendToWindow` в тесте была бы зелёной и на сломанном продукте.
//
// Маркеры вырезки (каждый встречается в main.js ровно один раз):
//   SEND   `function sendToWindow(event, channel, body) {`  … `async function runAgentMode(`
//   ABORT  `function abortActiveTurns(`                     … `// Спросить человека прямо в переписке.`
//   REJECT `function rejectPendingApprovals(`               … `// Уничтоженный renderer`
//   STAGE  `const stage = (slot, label, total, assignment = '', taskTitle = '') => {` … `let leadResult = null`
//   WIRE   `const onWindowGone = reason => {`               … `let shown = false`
//
// Плюс контроль слепой зоны: в области хода (`runAgentMode` … `runMultiAgentExecution`)
// не должно остаться ни одной прямой отправки `event.sender.send(` — иначе
// «единственная точка отправки» держится только на честном слове.
//
// Список параметров сознательно не указан там, где он мог вырасти:
// `abortActiveTurns` уже принимает второй аргумент (ид окна, чьи ходы снимать), и
// тест не должен краснеть только из-за того, что у функции появился аргумент.
//
// Почти каждый сценарий прогоняется парой «живой адресат — мёртвый адресат», и
// исходы сравниваются: иначе проверка прошла бы и на заглушке, которая молчит
// всегда.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Путь к исходнику можно подменить одному харнессу-мутанту (ср.
// `audits/qoder-2-2026-09-24/checkpoint-wiring-mutation.cjs`): в общем прогоне
// переменная не выставлена и читается канонический `src/main/main.js`.
const MAIN_PATH = process.env.ONECODE_MAIN_UNDER_TEST ||
  path.join(__dirname, '..', 'src', 'main', 'main.js')
const main = fs.readFileSync(MAIN_PATH, 'utf8')

function at (marker, from = 0) {
  const index = main.indexOf(marker, from)
  assert.ok(index >= 0, 'якорь пропал из main.js: ' + marker)
  return index
}
const cut = (from, to) => main.slice(at(from), at(to, at(from) + from.length))

const SEND_MARK = 'function sendToWindow(event, channel, body) {'
const ABORT_MARK = 'function abortActiveTurns('
const STAGE_MARK = "const stage = (slot, label, total, assignment = '', taskTitle = '') => {"
const WIRE_MARK = 'const onWindowGone = reason => {'

const SEND_CODE = cut(SEND_MARK, 'async function runAgentMode(')
const ABORT_CODE = cut(ABORT_MARK, '// Спросить человека прямо в переписке.')
const REJECT_CODE = cut('function rejectPendingApprovals(', '// Уничтоженный renderer')
const STAGE_CODE = cut(STAGE_MARK, 'let leadResult = null')

// Начало привязки окна — строка с `onWindowGone`, но вместе с ней в вырезку
// берутся и одиночные `const …` объявления непосредственно над ней: сегодня там
// лежит `goneWindowId`, без которого стрелка ссылалась бы на свободную
// переменную. На первом же не-объявлении остановка — чужой код не утаскивается.
function wireCode () {
  const goneAt = at(WIRE_MARK)
  const lines = main.slice(0, goneAt).split('\n')
  const preamble = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('//')) continue
    if (!/^const \w+ = [^{\[]+$/.test(line)) break
    preamble.unshift(line)
  }
  return [...preamble, main.slice(goneAt, at('let shown = false', goneAt))].join('\n')
}
const WIRE_CODE = wireCode()

// Вырезка обязана содержать своё объявление: если маркеры разъедутся, тест должен
// краснеть внятной строкой, а не «sendToWindow is not defined».
for (const [name, code, marker] of [
  ['sendToWindow', SEND_CODE, SEND_MARK],
  ['abortActiveTurns', ABORT_CODE, ABORT_MARK],
  ['stage', STAGE_CODE, STAGE_MARK],
  ['onWindowGone', WIRE_CODE, WIRE_MARK]
]) {
  assert.ok(code.includes(marker), `вырезка «${name}» не содержит маркера «${marker}» — правка main.js сдвинула границы`)
  assert.ok(code.length > marker.length + 20, `вырезка «${name}» подозрительно короткая: ${code.length} символов`)
}

// Текст между первой `{` после маркера и парной ей `}` — нужна конкретная ловушка
// `catch` и конкретное тело стрелки, а не вся вырезка наугад.
function blockOf (text, from) {
  const open = text.indexOf('{', from)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}' && (depth -= 1) === 0) return text.slice(open + 1, i)
  }
  return ''
}
function blocksAfter (text, wordRe) {
  const found = []
  for (const match of text.matchAll(wordRe)) found.push(blockOf(text, match.index + match[0].length))
  return found
}

// ---------------------------------------------------------------------------
// Настоящие участки главного процесса с подставленными входами
// ---------------------------------------------------------------------------

const sendToWindow = new Function(`${SEND_CODE}; return sendToWindow`)()

const abortTurnsOf = controllers =>
  new Function('activeAbortControllers', `${ABORT_CODE}; return abortActiveTurns`)(controllers)

// Отклонение ожиданий — тоже настоящим кодом: карточка живого окна не должна
// получать «отказ» из-за закрытия соседнего окна, и проверить это на подставке
// невозможно.
const rejectOf = ({ approvals, questions }) =>
  new Function('pendingApprovals', 'pendingQuestions', `${REJECT_CODE}; return rejectPendingApprovals`)(
    approvals, questions)

// Этап собирается вместе с настоящей точкой отправки: проверяется связка
// `stage` → `sendToWindow`, а не две раздельные заглушки.
const stageOf = ({ event, payload }) =>
  new Function('event', 'payload', `${SEND_CODE}\n${STAGE_CODE}; return stage`)(event, payload)

// Привязка жизненного цикла окна: `abortActiveTurns` — тоже вырезанный код, чтобы
// проверка шла до самых контроллеров хода, а не упиралась в подставку. Окно — с
// `webContents.id`, как в настоящем Electron: по этому id ход и привязан.
function lifecycleOf (controllers, { id = 7 } = {}) {
  const handlers = new Map()
  const windowHandlers = new Map()
  const rejections = []
  const mainWindow = {
    on: (channel, fn) => windowHandlers.set(channel, fn),
    webContents: { id, on: (channel, fn) => handlers.set(channel, fn) }
  }
  // Заглушка помнит, с кем её позвали: привязка отклонения к своему окну — часть
  // того же жизненного цикла.
  new Function('mainWindow', 'rejectPendingApprovals', 'activeAbortControllers', `${ABORT_CODE}\n${WIRE_CODE}`)(
    mainWindow, windowId => rejections.push(windowId === undefined ? null : windowId), controllers)
  return {
    id,
    handlers,
    rejections,
    fire (channel, ...args) {
      const fn = handlers.get(channel)
      assert.ok(typeof fn === 'function', `окно не слушает событие «${channel}»`)
      fn(...args)
    }
  }
}

// ---------------------------------------------------------------------------
// Подставные адресат и ход
// ---------------------------------------------------------------------------

// Адресат — ровно тот договор, что даёт WebContents: `isDestroyed()` и `send()`.
// `destroyed: true` значит «окно уничтожено» — `isDestroyed()` отвечает да.
// Счётчики нужны, чтобы «не вызывалось» было чем доказать, а не на слово.
function senderStub ({ destroyed = false, sendThrows = null, hasIsDestroyed = true } = {}) {
  const sent = []
  const touched = { send: 0, isDestroyed: 0 }
  const sender = { sent, touched }
  sender.send = (channel, body) => {
    touched.send += 1
    if (sendThrows) throw sendThrows
    sent.push({ channel, body })
  }
  if (hasIsDestroyed) sender.isDestroyed = () => { touched.isDestroyed += 1; return destroyed }
  return sender
}

// Ход — настоящий AbortController (как его заводит `send-message`) со счётчиком
// вызовов `abort` и привязкой к окну (`controller.windowId`, той же, что в
// продукте); бросок по заказу нужен для проверки устойчивости перебора.
function turnStub (key, { blows = false, windowId = null } = {}) {
  const controller = new AbortController()
  const calls = []
  const held = {
    calls,
    signal: controller.signal,
    controller: {
      windowId,
      abort (reason) {
        calls.push(reason)
        if (blows) throw new Error(`ход «${key}» уже снимается`)
        controller.abort(reason)
      }
    }
  }
  return held
}

const abortedOnce = turn => turn.calls.length === 1 && turn.signal.aborted === true
// Причина обрыва: продукт обязан передать Error, поэтому за текстом идём в
// `.message` — строка вместо Error даст «undefined» и покраснит проверку.
const reasonOf = turn => String((turn.calls[0] || {}).message)
const describe = error => error ? `${error.name}: ${error.message}` : 'не бросило'

let checks = 0
const failures = []
function check (name, ok, detail) {
  checks += 1
  if (ok === true) {
    console.log('ok', name)
    return
  }
  failures.push(name)
  console.error(`ПРОВАЛ [${name}]${detail === undefined ? '' : `: ${detail}`}`)
}
// Сценарии, которые обязаны молчать, а не бросать: бросок ловится, чтобы краснить
// именно свою проверку, а не уносить весь набор.
function grab (fn) {
  try { return { value: fn(), threw: null } } catch (error) { return { value: null, threw: error } }
}

// Зависший прогон не должен выглядеть зелёным: будильник держит процесс, пока не
// завершён сам прогон (unref()'ом его нельзя — тогда при потерянном обещании Node
// тихо выходит с кодом 0).
const watchdog = setTimeout(() => {
  console.error('ПРОВАЛ: прогон window-gone не завершился за 60 с')
  process.exit(1)
}, 60000)

const CHANNEL = 'agent-stage-start'

try {
  // -------------------------------------------------------------------------
  // 1…5. Единственная точка отправки
  // -------------------------------------------------------------------------

  // п.1 — живой адресат: ровно один `send`, канал и тело дословные, ответ true.
  const liveBody = { requestId: 'r-1', stage: 1 }
  const live = senderStub()
  const r1 = grab(() => sendToWindow({ sender: live }, CHANNEL, liveBody))
  check('п.1 живой адресат: send вызван ровно один раз, канал и тело дословные, возврат true',
    r1.threw === null && r1.value === true &&
    live.touched.send === 1 && live.sent.length === 1 &&
    live.sent[0].channel === CHANNEL && live.sent[0].body === liveBody,
    `бросок: ${describe(r1.threw)}, возврат: ${r1.value}, send вызванов: ${live.touched.send}, дошло: ${live.sent.length}`)

  // п.2 — уничтоженный адресат: до `send` не доходит, ответ false, тихо.
  const dead = senderStub({ destroyed: true })
  const r2 = grab(() => sendToWindow({ sender: dead }, CHANNEL, { a: 1 }))
  check('п.2 isDestroyed() → true: send не вызывался, возврат false, наружу не бросает',
    r2.threw === null && r2.value === false && dead.touched.send === 0 && dead.sent.length === 0,
    `бросок: ${describe(r2.threw)}, возврат: ${r2.value}, send вызванов: ${dead.touched.send}`)

  // п.3 — окно умерло между проверкой и вызовом: `isDestroyed()` соврало, что
  // жив, а `.send` бросает тот самый `TypeError`, из-за которого всё и началось.
  const lied = senderStub({ destroyed: false, sendThrows: new TypeError('Object has been destroyed') })
  const r3 = grab(() => sendToWindow({ sender: lied }, CHANNEL, { a: 1 }))
  check('п.3 окно умерло между проверкой и вызовом (send бросает TypeError про destroyed): false и без броска',
    r3.threw === null && r3.value === false && lied.touched.send === 1 && lied.sent.length === 0,
    `бросок: ${describe(r3.threw)}, возврат: ${r3.value}, попыток send: ${lied.touched.send}`)

  // п.4 — чужой сбой обязан уйти наверх как был: это единственная защита от
  // «починили» молчанием в `catch`. Текст сверяется дословно, вместе с пробелами.
  const FOREIGN = new Error(' serialization failed ')
  const foreign = senderStub({ destroyed: false, sendThrows: FOREIGN })
  const r4 = grab(() => sendToWindow({ sender: foreign }, CHANNEL, { a: 1 }))
  check('п.4 чужая ошибка из send летит наружу тем же объектом и с несъеденным текстом',
    r4.threw === FOREIGN && r4.value === null && foreign.touched.send === 1 &&
    r4.threw.message === ' serialization failed ',
    `вылетело: ${describe(r4.threw)}, тот же объект: ${r4.threw === FOREIGN}, возврат: ${r4.value}`)

  // п.5 — адресата нет вовсе или у него нет `send`: false, а не TypeError.
  const shapes = [
    ['event undefined', undefined],
    ['event null', null],
    ['event без sender', {}],
    ['sender:null', { sender: null }],
    ['sender без send', { sender: {} }],
    ['sender.send — не функция', { sender: { send: 'agent-event' } }]
  ]
  const r5 = grab(() => shapes.map(([name, event]) => {
    const outcome = grab(() => sendToWindow(event, CHANNEL, { a: 1 }))
    return outcome.threw ? `${name}: бросило ${describe(outcome.threw)}` : (outcome.value !== false ? `${name}: вернулось ${outcome.value}` : '')
  }).filter(Boolean))
  check('п.5 event без sender и sender без send: false и не падает ни в одной из форм',
    r5.threw === null && r5.value.length === 0, (r5.threw ? describe(r5.threw) : r5.value.join('; ')))

  // Тот же пункт с другой стороны: `isDestroyed` у адресата может и не быть
  // (страховка в коде не обязательна) — отправка от этого не должна пропадать.
  const noFlag = senderStub({ hasIsDestroyed: false })
  const r6 = grab(() => sendToWindow({ sender: noFlag }, CHANNEL, { a: 1 }))
  check('п.1 адресат без isDestroyed: страховка в коде не обязательна, отправка идёт',
    r6.threw === null && r6.value === true && noFlag.sent.length === 1,
    `бросок: ${describe(r6.threw)}, возврат: ${r6.value}, дошло: ${noFlag.sent.length}`)

  // Управление против молчания вырезки: один и тот же собранный код, два адресата.
  const ctlLive = senderStub()
  const ctlDead = senderStub({ destroyed: true })
  const ctl = grab(() => ({
    alive: sendToWindow({ sender: ctlLive }, CHANNEL, { a: 1 }),
    dead: sendToWindow({ sender: ctlDead }, CHANNEL, { a: 1 })
  }))
  check('управление: вырезка sendToWindow не молчит — живому дослано, мёртвому нет, исходы разные',
    ctl.threw === null && ctl.value.alive === true && ctl.value.dead === false &&
    ctlLive.sent.length === 1 && ctlDead.sent.length === 0,
    ctl.threw ? `бросок: ${describe(ctl.threw)}` :
      `живой: вернул ${ctl.value.alive}, дослано ${ctlLive.sent.length}; ` +
      `мёртвый: вернул ${ctl.value.dead}, дослано ${ctlDead.sent.length}`)

  // Управление против проглатывания в тексте самой ловушки.
  const sendBody = blockOf(SEND_CODE, SEND_CODE.indexOf('function sendToWindow'))
  const catches = blocksAfter(sendBody, /\bcatch\b/g)
  const bare = catches.filter(body => /^\s*$/.test(body))
  const swallowing = catches.filter(body => !/\bthrow\b/.test(body) || !/message|String\(/.test(body))
  check('управление: в sendToWindow нет голого catch {} — каждая ловушка разбирает текст ошибки и бросает остальное',
    catches.length >= 1 && bare.length === 0 && swallowing.length === 0 && /sender\.send\s*\(/.test(sendBody),
    `ловушек: ${catches.length}, пустых: ${bare.length}, без разбора/без throw: ${swallowing.length}, ` +
    `тела: ${JSON.stringify(catches.map(body => body.trim()))}`)

  // -------------------------------------------------------------------------
  // 6. Отмена активных ходов
  // -------------------------------------------------------------------------

  const first = turnStub('r-1')
  const last = turnStub('r-3')
  const map = new Map([['r-1', first.controller], ['r-3', last.controller]])
  // Вызов с одним аргументом — «обрывать всё», как это и формулируется в
  // договоре: окно ушло, чей это ход, уже не важно.
  const r7 = grab(() => abortTurnsOf(map)('окно закрыто'))
  check('п.6 abortActiveTurns со значением «окно закрыто» снимает каждый ход один раз и с причиной в тексте',
    r7.threw === null && abortedOnce(first) && abortedOnce(last) &&
    [/окно закрыто/.test(reasonOf(first)), /окно закрыто/.test(reasonOf(last))].every(Boolean) &&
    [/r-1/.test(reasonOf(first)), /r-3/.test(reasonOf(last))].every(Boolean) &&
    first.calls[0] instanceof Error && last.calls[0] instanceof Error,
    `бросок: ${describe(r7.threw)}, r-1: ${reasonOf(first)}, r-3: ${reasonOf(last)}`)

  // Один ход может сниматься прямо в этот момент — его бросок не имеет права
  // унести за собой остальные. Порядок в Map вставляет бросившийся вторым.
  const before = turnStub('a-1')
  const blow = turnStub('a-2', { blows: true })
  const after = turnStub('a-3')
  const shaky = new Map([['a-1', before.controller], ['a-2', blow.controller], ['a-3', after.controller]])
  const r8 = grab(() => abortTurnsOf(shaky)('окно закрыто'))
  check('п.6 обрыв одного контроллера (его abort бросает) не мешает отменить остальные и не рвёт карту',
    r8.threw === null && abortedOnce(before) && abortedOnce(after) && blow.calls.length === 1 &&
    shaky.size === 3 && [...shaky.keys()].join(',') === 'a-1,a-2,a-3',
    `бросок: ${describe(r8.threw)}, a-1: ${before.calls.length}, a-2: ${blow.calls.length}, ` +
    `a-3: ${after.calls.length}, в карте осталось: ${shaky.size}`)

  // Пустая карта — не повод падать: окно могли закрыть между ходами.
  const r9 = grab(() => abortTurnsOf(new Map())('окно закрыто'))
  check('п.6 ходов нет — отмена молча проходит, а не падает', r9.threw === null, describe(r9.threw))

  // -------------------------------------------------------------------------
  // 7. Этап хода через единственную точку отправки
  // -------------------------------------------------------------------------

  const SLOT = { index: 1, modelName: 'Модель-2', autoPicked: true, taskTitle: 'Заголовок слота' }
  const stageLive = senderStub()
  const r10 = grab(() => stageOf({ event: { sender: stageLive }, payload: { requestId: 'req-77' } })
    (SLOT, 'Агент 2', 3, 'Собери раздел о пальмах', 'Пальмы'))
  const stageBody = (stageLive.sent[0] || {}).body || {}
  check('п.7 stage с живым отправителем досылает agent-stage-start с agentName и поручением',
    r10.threw === null && stageLive.sent.length === 1 && stageLive.sent[0].channel === 'agent-stage-start' &&
    stageBody.agentName === 'Агент 2' && stageBody.assignment === 'Собери раздел о пальмах' &&
    stageBody.requestId === 'req-77' && stageBody.stage === 2 && stageBody.totalStages === 3 &&
    stageBody.taskTitle === 'Пальмы' && /подобрана/.test(String(stageBody.modelName)),
    `бросок: ${describe(r10.threw)}, дошло событий: ${stageLive.sent.length}, тело: ${JSON.stringify(stageBody)}`)

  // Негативное управление к предыдущей: та же собранная связка, но адресат мёртв.
  // Если бы заглушка была мертва и в проверке п.7 — она бы покраснела.
  const stageDead = senderStub({ destroyed: true })
  const r11 = grab(() => stageOf({ event: { sender: stageDead }, payload: { requestId: 'req-77' } })
    (SLOT, 'Агент 2', 3, 'Собери раздел о пальмах', 'Пальмы'))
  check('п.7 stage с мёртвым отправителем не бросает и ничего не досылает — при живом тот же код досылает (п.7 выше)',
    r11.threw === null && stageDead.touched.send === 0 && stageDead.sent.length === 0 && stageLive.sent.length === 1,
    `бросок: ${describe(r11.threw)}, попыток send: ${stageDead.touched.send}, ` +
    `у мёртвого дошло: ${stageDead.sent.length}, у живого: ${stageLive.sent.length}`)

  // Значения по умолчанию того же `stage`: поручения нет — его и в окне нет, а
  // заголовок берётся из слота.
  const defaults = senderStub()
  const r12 = grab(() => stageOf({ event: { sender: defaults }, payload: { requestId: 'req-78' } })
    (SLOT, 'Агент 2', 3))
  const defaultBody = (defaults.sent[0] || {}).body || {}
  check('п.7 stage без поручения: assignment пустой, taskTitle берётся из слота',
    r12.threw === null && defaultBody.assignment === '' && defaultBody.taskTitle === 'Заголовок слота' &&
    defaultBody.modelName === 'Модель-2 (подобрана)',
    `бросок: ${describe(r12.threw)}, тело: ${JSON.stringify(defaultBody)}`)

  // -------------------------------------------------------------------------
  // 8. Привязка жизненного цикла окна
  // -------------------------------------------------------------------------

  // Порядок аргументов Electron у did-start-navigation: (event, url, isInPlace,
  // isMainFrame) — так же и передаём, иначе проверка проверяла бы свою выдумку.
  const gone13 = grab(() => {
    const turn = turnStub('r-1', { windowId: 7 })
    const win = lifecycleOf(new Map([['r-1', turn.controller]]), { id: 7 })
    win.fire('destroyed')
    return { turn, win }
  })
  check('п.8 destroyed ведёт через onWindowGone: отклоняет ожидания и обрывает ход «окно закрыто»',
    gone13.threw === null && gone13.value.win.rejections.length === 1 &&
    abortedOnce(gone13.value.turn) && /окно закрыто/.test(reasonOf(gone13.value.turn)),
    `бросок: ${describe(gone13.threw)}, отклонений: ${gone13.value && gone13.value.win.rejections.length}, ` +
    `причина обрыва: ${gone13.value ? reasonOf(gone13.value.turn) : '—'}`)

  // Отметка на причине — не украшение: по ней координатор и этап-решение называют
  // «ушли, не спросив» отдельно от «человек нажал Стоп». Без неё человек читал бы
  // про собственную остановку там, где он просто закрыл окно.
  const gone16 = grab(() => {
    const turn = turnStub('r-16', { windowId: 7 })
    const win = lifecycleOf(new Map([['r-16', turn.controller]]), { id: 7 })
    win.fire('destroyed')
    return turn.signal.reason
  })
  check('п.8 причина обрыва помечена как уход окна (`windowGone`), а не просто как остановка',
    gone16.threw === null && gone16.value instanceof Error && gone16.value.windowGone === 'окно закрыто',
    `бросок: ${describe(gone16.threw)}, отметка: ${gone16.value && JSON.stringify(gone16.value.windowGone)}`)

  const gone14 = grab(() => {
    const turn = turnStub('r-2', { windowId: 7 })
    const win = lifecycleOf(new Map([['r-2', turn.controller]]), { id: 7 })
    win.fire('render-process-gone', {}, {})
    return { turn, win }
  })
  check('п.8 render-process-gone ведёт через onWindowGone: отклоняет ожидания и обрывает ход своей причиной',
    gone14.threw === null && gone14.value.win.rejections.length === 1 &&
    abortedOnce(gone14.value.turn) && /процесс окна оборвался/.test(reasonOf(gone14.value.turn)),
    `бросок: ${describe(gone14.threw)}, отклонений: ${gone14.value && gone14.value.win.rejections.length}, ` +
    `причина обрыва: ${gone14.value ? reasonOf(gone14.value.turn) : '—'}`)

  const navBad = []
  const NAV = [
    { isMainFrame: true, isInPlace: false, touches: true },
    { isMainFrame: true, isInPlace: true, touches: false },
    { isMainFrame: false, isInPlace: false, touches: false },
    { isMainFrame: false, isInPlace: true, touches: false }
  ]
  const navThrew = []
  for (const one of NAV) {
    const turn = turnStub('r-nav', { windowId: 7 })
    const win = lifecycleOf(new Map([['r-nav', turn.controller]]), { id: 7 })
    const fired = grab(() => win.fire('did-start-navigation', {}, 'app://index/index.html', one.isInPlace, one.isMainFrame))
    if (fired.threw) {
      navThrew.push(`isMainFrame=${one.isMainFrame} isInPlace=${one.isInPlace}: ${describe(fired.threw)}`)
      continue
    }
    const touched = turn.calls.length > 0 || win.rejections.length > 0
    const where = `isMainFrame=${one.isMainFrame} isInPlace=${one.isInPlace}`
    if (touched !== one.touches) {
      navBad.push(`${where}: ${touched ? 'ход тронут' : 'молчит'}, ожидалось «${one.touches ? 'ход тронут' : 'молчит'}»`)
    }
    if (one.touches && !/окно перезагружено/.test(reasonOf(turn))) {
      navBad.push(`${where}: причина обрыва «${reasonOf(turn)}», ожидалась «окно перезагружено»`)
    }
  }
  check('п.8 did-start-navigation трогает ход только при isMainFrame && !isInPlace (четыре комбинации)',
    navThrew.length === 0 && navBad.length === 0, [...navThrew, ...navBad].join('; '))

  // Соседнее живое окно (второй чат рядом) не имеет права вставать вместе с
  // закрытым: ход привязан к окну тем же `webContents.id`, каким его снимает
  // `onWindowGone`. Это тот же жизненный цикл, поэтому и проверяется здесь же:
  // без фильтра чужой платный ход обрывался бы заодно.
  const own = turnStub('w7-turn', { windowId: 7 })
  const neighbour = turnStub('w8-turn', { windowId: 8 })
  const loose = turnStub('no-window', { windowId: null })
  const twoWindows = grab(() => {
    const win = lifecycleOf(new Map([
      ['w7-turn', own.controller], ['w8-turn', neighbour.controller], ['no-window', loose.controller]
    ]), { id: 7 })
    win.fire('destroyed')
    return win
  })
  check('п.8 закрытие одного окна снимает свои ходы и ходы без окна, но не ход живого соседнего окна',
    twoWindows.threw === null && abortedOnce(own) && abortedOnce(loose) &&
    neighbour.calls.length === 0 && neighbour.signal.aborted === false &&
    /окно закрыто/.test(reasonOf(own)) && /w7-turn/.test(reasonOf(own)),
    `бросок: ${describe(twoWindows.threw)}, своего окна: ${own.calls.length}, соседнего: ${neighbour.calls.length}, ` +
    `без окна: ${loose.calls.length}, причина: ${reasonOf(own)}`)

  // Текстовый контроль той же привязки: слушает именно webContents, а тело
  // onWindowGone вызывает и отклонение ожиданий, и отмену ходов.
  const goneBody = blockOf(WIRE_CODE, WIRE_CODE.indexOf('onWindowGone'))
  const wiringMisses = []
  for (const channel of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
    if (!new RegExp(`webContents\\.on\\(['"]${channel}['"]`).test(WIRE_CODE)) wiringMisses.push(`нет подписки webContents на «${channel}»`)
    if (!new RegExp(`['"]${channel}['"][\\s\\S]{0,160}?onWindowGone\\(`).test(WIRE_CODE)) wiringMisses.push(`«${channel}» не проходит через onWindowGone`)
  }
  // Отклонение ожиданий обязано зваться С ИДЕНТИФИКАТОРОМ того же окна, каким
  // снимается ход: два вызова без одного и того же аргумента — это два разных
  // представления о том, чьё окно умерло.
  const rejectCall = /rejectPendingApprovals\s*\(([^)]*)\)/.exec(goneBody)
  const abortCall = /abortActiveTurns\s*\(([^)]*)\)/.exec(goneBody)
  if (!rejectCall || !rejectCall[1].trim()) wiringMisses.push('onWindowGone зовёт rejectPendingApprovals() без идентификатора окна')
  if (!abortCall || !rejectCall || !abortCall[1].includes(rejectCall[1].trim())) {
    wiringMisses.push('отклонение ожиданий и отмена ходов привязаны к разным окнам')
  }
  if (!/abortActiveTurns\s*\(/.test(goneBody)) wiringMisses.push('onWindowGone не зовёт abortActiveTurns(')
  check('п.8 текст привязки: три события webContents идут через onWindowGone, а тот зовёт и rejectPendingApprovals(своё окно), и abortActiveTurns(',
    wiringMisses.length === 0, wiringMisses.join('; '))

  // То же поведением: id уничтоженного окна доходит до отклонения ожиданий.
  const gone15 = grab(() => {
    const win = lifecycleOf(new Map(), { id: 11 })
    win.fire('destroyed')
    return win
  })
  check('п.8 закрытие окна отклоняет ожидания именно своего окна (id доходит до rejectPendingApprovals)',
    gone15.threw === null && gone15.value.rejections.length === 1 && gone15.value.rejections[0] === 11,
    `бросок: ${describe(gone15.threw)}, вызовы: ${JSON.stringify(gone15.value && gone15.value.rejections)}`)

  // п.9 — привязка карточки к окну настоящим кодом `rejectPendingApprovals`.
  // Чужое окно не получает ни «отказа», «ответа нет»: человека там спрашивают,
  // и ход этого окна продолжает работу.
  {
    const settled = []
    const record = (kind, windowId) => ({ requestId: 'r-' + windowId, windowId,
      resolve: value => settled.push({ kind, value }) })
    const approvals = new Map([['a7', record('approval', 7)], ['a8', record('approval', 8)], ['a0', record('approval', null)]])
    const questions = new Map([['q7', record('question', 7)], ['q8', record('question', 8)], ['q0', record('question', null)]])
    const reject = rejectOf({ approvals, questions })
    reject(7)
    const kinds = key => settled.filter(one => one.kind === key).map(one => one.value)
    check('п.9 отклонение по id окна снимает карточки своего окна и ожидания без окна, чужие — нет',
      JSON.stringify(kinds('approval')) === JSON.stringify([false, false]) &&
      JSON.stringify(kinds('question')) === JSON.stringify([null, null]) &&
      approvals.has('a8') === true && questions.has('q8') === true &&
      approvals.has('a7') === false && questions.has('q7') === false && approvals.has('a0') === false,
      `отклонённые подтверждения: ${JSON.stringify(kinds('approval'))}, вопросы: ${JSON.stringify(kinds('question'))}, ` +
      `остались: ${[...approvals.keys(), ...questions.keys()].join(',')}`)

    const left = new Map([['b8', record('approval', 8)]])
    const loose = new Map([['b7', record('question', 7)]])
    rejectOf({ approvals: left, questions: loose })()
    check('п.9 вызов без окна (app-quit, общие места) отклоняет всё, как раньше',
      left.size === 0 && loose.size === 0, `остались: ${left.size} и ${loose.size}`)
  }

  // п.10 слепая зона: «единственная точка отправки» должна быть ею и на деле.
  // Прямой `event.sender.send(` в области хода — это тот самый бросок, который
  // здесь и лечится, и вернуть его одной строкой не должно быть незаметно.
  {
    const from = at('async function runAgentMode(event')
    const to = at('function callFingerprint(toolName, args)')
    const bare = []
    main.slice(from, to).split('\n').forEach((line, index) => {
      if (/event\.sender\.send\(/.test(line)) bare.push(`${index + 1}: ${line.trim().slice(0, 70)}`)
    })
    check('п.10 в области хода не осталось прямых event.sender.send — все идут через sendToWindow',
      bare.length === 0, bare.join(' | ') || `прямых отправок нет на ${main.slice(from, to).split('\n').length} строках`)
  }
} catch (error) {
  failures.push('прогон оборвался')
  console.error('ПРОВАЛ: набор window-gone оборвался —', error && error.stack || error)
} finally {
  clearTimeout(watchdog)
}

const clean = failures.length === 0
console.log(clean ? `проверок: ${checks}, провалов 0` : `ПРОВАЛ: ${failures.join(' | ')} — провалено ${failures.length} из ${checks}`)
console.log(JSON.stringify({ ok: clean, checks, failed: failures.length, failures, source: MAIN_PATH }))
process.exit(clean ? 0 : 1)
