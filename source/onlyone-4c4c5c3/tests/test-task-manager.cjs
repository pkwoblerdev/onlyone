'use strict'
// Красный набор планировщика фоновых задач `src/main/task-manager.js` (план, этап 2.7).
//
// ТЕСТЫ ДО КОДА: модуля нет. `require` обёрнут в try, и каждая проверка обязана
// сказать «модуля нет» СВОИМ текстом, а не `TypeError` в середине стека: без
// этого прогон неотличим от отсутствия прогона. Правильное состояние набора —
// КРАСНОЕ; зелёным оно станет тогда, когда напишут `createTaskManager`.
//
// Контракт, на который это написано (проверяется ровно он):
//   createTaskManager({ store, now, setTimeout, clearTimeout, spawn, send,
//                       maxParallel = 3, queueLimit = 100, heartbeatMs })
//     -> { add, list, get, pause, resume, cancel, restart, start, stop, drain }
//   задача = { id, title, kind, priority: high|normal|low,
//              state: queued|running|paused|error|done|interrupted,
//              progress, startedAt, finishedAt, error, attempts, log: [] }
//
// Швы, которые набор считает частью контракта (реализации их держать, остальное —
// её дело):
//   * `store` — те же шесть методов, что у `schedule-store.js`:
//     `load()/list()/save(records)/upsert(record)/remove(id)`. Здесь лежит
//     НАСТОЯЩИЙ `createScheduleStore`, а не самописка: «переживает перезапуск»
//     имеет смысл только на настоящем диске и настоящем `rename`.
//   * АРГУМЕНТЫ `spawn` набором не проверяются: «какая задача в работе» читается
//     из `get()`/`list()`, чтобы тест не зависел от того, чем именно реализация
//     поднимает процесс. Сам процесс — как `child_process.spawn` в
//     `command-runner.js`: `stdout`/`stderr`, события `error`/`exit`/`close`,
//     `kill()`.
//   * `queueLimit` считается по ВСЕМ задачам, которые планировщик держит и
//     которые видно в `list()`: и по ожидающим, и по исполняемым. Ровно 100.
//   * единственный источник быстрых обновлений одной задачи — вывод процесса
//     (`log`, `progress`); `send` — единственный канал в окно, тело обязано
//     сериализоваться в JSON (через него говорит IPC) и нести `id` задачи.
//
// Сверка с экраном (он не переписывается): `src/renderer/task-center.js` даёт
// `create(deps)` и сегодня читает из карточки `title`, `status`, `updatedAt`,
// `durationSeconds`, `agents` — `progress` и кнопок паузы/перезапуска/отмены в
// разметке ещё нет. Поэтому набор проверяет контракт планировщика из плана, а
// проводку экрана сверять будет следующее звено.
//
// Ни Electron, ни сети, ни живых ключей, ни реальных ожиданий: ни `Date.now()`,
// ни настоящих таймеров в файле нет — время двигает подставной `now`, «тик» это
// вызов подставного таймера. Повороты очереди (`setImmediate`) нужны только чтобы
// асинхронный ответ процесса успел дойти до состояния. Временные каталоги свои
// (`onlyone-task-manager-…` в `os.tmpdir()`), удаляются в конце прогона. Значения
// вида `sk-QoderTest-…` выдуманы.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

let taskModule = null
let taskLoadError = null
try {
  taskModule = require('../src/main/task-manager')
} catch (error) {
  // Первая строка: `Cannot find module ...` — без простыни require stack.
  taskLoadError = String(error && error.message).split('\n')[0]
}

let storeModule = null
let storeLoadError = null
try {
  storeModule = require('../src/main/schedule-store')
} catch (error) {
  storeLoadError = String(error && error.message).split('\n')[0]
}

// Что не нашлось — отказ КАЖДОЙ проверки, а не молчаливый «ноль проверок».
function missing() {
  const out = []
  if (!taskModule) out.push(`модуля нет: src/main/task-manager.js (${taskLoadError})`)
  if (!storeModule) out.push(`хранилища нет: src/main/schedule-store.js (${storeLoadError})`)
  return out
}

let checks = 0
let failed = 0
// Часть проверок асинхронная (ответ процесса приходит по обещанию), поэтому
// набор собирается в очередь и прогоняется последовательно: итог печатается
// ПОСЛЕ всех обещаний, иначе «ноль отказов» значил бы лишь «обещания ещё не
// дошли». Образец — `runQueue()` в `tests/test-schedule-runtime.cjs`.
const queue = []
function check(name, fn) { queue.push({ name, fn }) }
async function runQueue() {
  for (const item of queue) {
    checks++
    const gap = missing()
    if (gap.length) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: ${gap.join('; ')} — тесты написаны до кода, набор красный`)
      continue
    }
    try {
      await item.fn()
      console.log('ok', item.name)
    } catch (error) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 400)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Вспомогательное: часы, процесс-двойник, хранилище, наблюдатели
// ---------------------------------------------------------------------------

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
// Точка отсчёта выдумана и зафиксирована: «сегодня» из часов машины нигде не
// участвует.
const T0 = Date.parse('2026-09-28T04:00:00.000Z')
const SECRET = 'sk-QoderTest-1234567890'
const STATES = ['queued', 'running', 'paused', 'error', 'done', 'interrupted']
const PRIORITIES = ['high', 'normal', 'low']

function show(value) {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > 240 ? `${text.slice(0, 240)}…` : text
  } catch {
    return String(value)
  }
}

// Тело окна и карточка обязаны быть простыми данными: через `send` говорит IPC,
// а на диске текст читает человек. Кольцо или функция здесь — отказ.
function dump(value, what) {
  try {
    return JSON.stringify(value) === undefined ? String(value) : JSON.stringify(value)
  } catch (error) {
    throw new Error(`${what} не сериализуется в JSON: ${error && error.message}`)
  }
}

const tmpDirs = []
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-task-manager-'))
  tmpDirs.push(dir)
  return dir
}
function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* свои каталоги; чужие не трогаем */ }
  }
}

// Часы и таймеры — подставные: «тик» исполняет только то, что сам планировщик
// поставил, а реальных ожиданий в наборе нет ни одного.
function fakeClock(startMs) {
  let nowMs = startMs
  const timers = new Map()
  let seq = 0
  let armed = 0
  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      const id = ++seq
      const delay = Number(ms)
      armed++
      timers.set(id, { fn, at: nowMs + (Number.isFinite(delay) && delay > 0 ? delay : 0) })
      return id
    },
    clearTimeout: id => { timers.delete(id) },
    armed: () => armed,
    pending: () => timers.size,
    advance: ms => { nowMs += ms },
    // «Тик»: исполняет просроченные таймеры в порядке срока.
    fire: () => {
      const due = [...timers.entries()].filter(([, t]) => t.at <= nowMs).sort((a, b) => a[1].at - b[1].at)
      for (const [id, t] of due) { timers.delete(id); t.fn() }
      return due.length
    }
  }
}

function byteStream() {
  const stream = new EventEmitter()
  stream.setMaxListeners(0)
  stream.setEncoding = () => stream
  stream.resume = () => stream
  stream.read = () => null
  return stream
}

// Процесс-двойник: набор сам решает, умер ли процесс, с каким кодом вышел и
// сколько успел написать.
function fakeSpawn() {
  const children = []
  const spawn = (...args) => {
    const child = new EventEmitter()
    child.setMaxListeners(0)
    child.pid = 420000 + children.length
    child.killed = false
    child.stdout = byteStream()
    child.stderr = byteStream()
    child.stdin = { write: () => true, end: () => child }
    child.args = args
    child.kill = () => { child.killed = true; return true }
    // Строка вывода процесса — то же, что `data` у живого `child_process`.
    child.write = text => { child.stdout.emit('data', Buffer.from(`${text}\n`, 'utf8')) }
    // Ответ процесса: сначала `exit`, потом `close` — ровно так же, как в Node.
    child.exit = (code = 0) => { child.emit('exit', code, null); child.emit('close', code, null) }
    // Процесс не поднялся: `error` и закрытие с ненулевым кодом.
    child.die = message => { child.emit('error', new Error(message)); child.emit('close', 1, null) }
    children.push(child)
    return child
  }
  return { spawn, children }
}

// Отсутствие экспорта = отказ с внятным текстом, а не `TypeError: not a function`.
function exportOf(module_, name, file) {
  const fn = module_ && module_[name]
  if (typeof fn !== 'function') throw new Error(`${file} не экспортирует функцию ${name}`)
  return fn
}
const createStore = options => exportOf(storeModule, 'createScheduleStore', 'src/main/schedule-store.js')(options)
const createManager = options => exportOf(taskModule, 'createTaskManager', 'src/main/task-manager.js')(options)

function make(options = {}) {
  const clock = fakeClock(options.at ?? T0)
  const dir = options.dir ?? tmpDir()
  const store = options.store ?? createStore({ dir, now: clock.now })
  const spawner = fakeSpawn()
  const sent = []
  const manager = createManager({
    store,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    spawn: spawner.spawn,
    send: payload => sent.push(payload),
    heartbeatMs: options.heartbeatMs ?? 250,
    ...(options.maxParallel === undefined ? {} : { maxParallel: options.maxParallel }),
    ...(options.queueLimit === undefined ? {} : { queueLimit: options.queueLimit })
  })
  if (options.autoStart !== false) manager.start()
  return { manager, clock, spawner, sent, store, dir }
}

// Ни одного ожидания по часам: только повороты очереди и «тики» подставного
// таймера. Поворотов больше, чем нужно, — чтобы реализация могла отвечать и через
// обещание, и через `setImmediate`.
async function flush(h, rounds = 4) {
  for (let round = 0; round < rounds; round++) {
    try { h.clock.fire() } catch (error) {
      throw new Error(`таймер планировщика бросает наружу: ${error && error.message}`)
    }
    await new Promise(resolve => setImmediate(resolve))
    await Promise.resolve()
  }
}

const task = (over = {}) => ({ id: 't1', title: 'Сборка проекта', kind: 'shell', priority: 'normal', ...over })

const listOf = h => (Array.isArray(h.manager.list()) ? h.manager.list() : [])
const getOf = (h, id) => h.manager.get(id)
const stateOf = (h, id) => { const one = getOf(h, id); return one && one.state }
const runningIds = h => listOf(h).filter(one => one && one.state === 'running').map(one => one.id)
const has = (h, id) => listOf(h).some(one => one && one.id === id)
const accepted = result => result === true || !!(result && result.ok === true)
const refused = result => result === null || result === undefined || result === false ||
  (typeof result === 'object' && result.ok === false)
const spawned = h => h.spawner.children.length
const storeListOf = h => {
  try {
    const stored = h.store.list()
    return Array.isArray(stored) ? stored : []
  } catch {
    return []
  }
}

function stringValues(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const one of value) stringValues(one, out)
  else if (value && typeof value === 'object') for (const one of Object.values(value)) stringValues(one, out)
  return out
}
const about = (message, id) => stringValues(message).includes(id)
const statesIn = message => stringValues(message).filter(one => STATES.includes(one))
function lastAbout(sent, id) {
  for (let i = sent.length - 1; i >= 0; i--) {
    const message = sent[i]
    if (about(message, id) && statesIn(message).length) return message
  }
  return null
}
function dumpOfDir(dir) {
  let text = ''
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { text += dumpOfDir(full); continue }
    try { text += fs.readFileSync(full, 'utf8') } catch { /* каталог свой: что не читается, то не считается */ }
  }
  return text
}

// ---------------------------------------------------------------------------
// 1. Очередь и предел параллелизма
// ---------------------------------------------------------------------------

check('add: в работе не больше maxParallel, остальные ждут в queued и берут свободный слот по одному', async () => {
  const h = make({ maxParallel: 2 })
  for (let i = 1; i <= 5; i++) {
    const result = h.manager.add(task({ id: `t${i}`, title: `Задача ${i}` }))
    assert.ok(accepted(result), `add задачи t${i} вернул ${show(result)} — задача не принята`)
  }
  await flush(h)
  assert.equal(listOf(h).length, 5, `в списке ${listOf(h).length} задач из пяти — принятое потеряно`)
  assert.ok(spawned(h) <= 2, `поднято ${spawned(h)} процессов при maxParallel = 2`)
  assert.equal(runningIds(h).length, 2, `в работе ${runningIds(h).length} задач, обещано две: ${show(runningIds(h))}`)
  for (const id of ['t3', 't4', 't5']) {
    assert.equal(stateOf(h, id), 'queued', `t3..t5 обязаны ждать свободного слота, а ${id} в состоянии ${stateOf(h, id)}`)
  }
  // Освобождение слота берёт СЛЕДУЮЩУЮ по очереди, а не любую.
  h.spawner.children[0].exit(0)
  await flush(h)
  assert.equal(stateOf(h, 't1'), 'done', `исполнение завершилось, а t1 в состоянии ${stateOf(h, 't1')}`)
  assert.equal(spawned(h), 3, `после освобождения слота поднято ${spawned(h)} процессов — следующий не взят`)
  assert.ok(runningIds(h).includes('t3'), `свободный слот достался не t3: ${show(runningIds(h))}`)
  assert.equal(listOf(h).length, 5, 'список стал короче после завершения задачи — карточка исчезла')
  assert.deepEqual(['t4', 't5'].map(id => stateOf(h, id)), ['queued', 'queued'], 'оставшиеся задачи перестали ждать')
})

// ---------------------------------------------------------------------------
// 2. Приоритеты и FIFO внутри приоритета
// ---------------------------------------------------------------------------

check('приоритет: high идёт раньше normal, normal раньше low, внутри одного приоритета — FIFO', async () => {
  const h = make({ maxParallel: 1 })
  // Первая задача занимает единственный слот, остальные становятся в очередь.
  h.manager.add(task({ id: 'low1', title: 'низкая 1', priority: 'low' }))
  await flush(h)
  assert.deepEqual(runningIds(h), ['low1'], `единственный слот взят не той задачей: ${show(runningIds(h))}`)
  for (const [id, priority] of [['norm1', 'normal'], ['high1', 'high'], ['low2', 'low'],
    ['high2', 'high'], ['norm2', 'normal']]) {
    h.manager.add(task({ id, title: id, priority }))
  }
  await flush(h)
  assert.equal(spawned(h), 1, `пока единственный слот занят, поднято ${spawned(h)} процессов`)

  const pickups = []
  for (let step = 0; step < 6; step++) {
    const current = runningIds(h)
    assert.ok(current.length <= 1, `в работе одновременно ${show(current)} при maxParallel = 1`)
    if (!current.length) break
    if (spawned(h) > 8) throw new Error(`очередь зациклилась: поднято ${spawned(h)} процессов на шести задачах`)
    h.spawner.children[spawned(h) - 1].exit(0)
    await flush(h)
    const next = runningIds(h)
    if (next.length) pickups.push(next[0])
  }
  assert.deepEqual(pickups, ['high1', 'high2', 'norm1', 'norm2', 'low2'],
    `порядок выбора из очереди ${show(pickups)}, а обещан high → normal → low с FIFO внутри приоритета`)
})

// ---------------------------------------------------------------------------
// 3. Переполнение очереди
// ---------------------------------------------------------------------------

check('предел очереди: 101-я задача при queueLimit = 100 честно отказана, принятые не потеряны', async () => {
  const h = make({ maxParallel: 1, queueLimit: 100 })
  const acceptedIds = []
  const answers = []
  for (let i = 0; i < 101; i++) {
    const id = `q${String(i).padStart(3, '0')}`
    const result = h.manager.add(task({ id, title: `Задача ${id}` }))
    answers.push({ id, result })
    if (accepted(result)) acceptedIds.push(id)
  }
  assert.equal(acceptedIds.length, 100,
    `принято ${acceptedIds.length} задач из 101 при queueLimit = 100; отказы: ${show(answers.filter(one => !accepted(one.result)).slice(0, 3))}`)
  const last = answers[answers.length - 1]
  assert.ok(refused(last.result), `101-я задача ${last.id} принята молча: ${show(last.result)} — очередь растёт бесконечно`)
  const reason = last.result && typeof last.result === 'object' ? String(last.result.error) : ''
  assert.ok(reason.trim(), `отказ без причины: ${show(last.result)} — человеку нечем объяснить, почему задача не встала`)
  assert.match(reason, /предел|полн|переполн|лимит|limit|queue|очеред/i,
    `в отказе нет ни слова про предел очереди: ${show(reason)}`)
  await flush(h)
  assert.equal(listOf(h).length, 100, `в списке ${listOf(h).length} задач, предела в 100 не видно`)
  const stored = listOf(h).map(one => one && one.id)
  assert.deepEqual(stored.slice().sort(), acceptedIds.slice().sort(),
    `принятые задачи не равны списку: потеряно ${show(acceptedIds.filter(id => !stored.includes(id)).slice(0, 5))}`)
  assert.equal(new Set(stored).size, 100, 'в списке дубликаты id — карточки слиплись')
})

// ---------------------------------------------------------------------------
// 4. Пауза, возврат, отмена, перезапуск
// ---------------------------------------------------------------------------

check('pause не даёт начаться и снимает с исполнения, resume возвращает в очередь, cancel гасит, restart — новая попытка', async () => {
  const h = make({ maxParallel: 1 })
  h.manager.add(task({ id: 'one', title: 'Первая' }))
  await flush(h)
  assert.deepEqual(runningIds(h), ['one'], `первая задача не в работе: ${show(stateOf(h, 'one'))}`)
  h.manager.add(task({ id: 'two', title: 'Вторая' }))
  await flush(h)
  assert.equal(stateOf(h, 'two'), 'queued', `вторая задача не ждёт свободный слот, а в ${stateOf(h, 'two')}`)

  // Очередная задача на паузе: не стартует (слот занят первой) и остаётся в списке.
  h.manager.pause('two')
  await flush(h)
  assert.equal(stateOf(h, 'two'), 'paused', `pause оставил задачу в ${stateOf(h, 'two')}`)
  assert.ok(has(h, 'two'), 'paused-задача исчезла из списка — человек её потерял')
  assert.equal(spawned(h), 1, `на паузе поднято ${spawned(h)} процессов, ожидался один`)
  h.manager.resume('two')
  await flush(h)
  assert.equal(stateOf(h, 'two'), 'queued', `resume вернул задачу не в очередь, а в ${stateOf(h, 'two')}`)
  // Отменённая очередь больше не вернётся, и освободит проверку от её старта.
  h.manager.cancel('two')
  await flush(h)
  assert.equal(stateOf(h, 'two'), 'done', `cancel очереди дал ${stateOf(h, 'two')}, а контракт обещает done/отменённое`)
  assert.equal(spawned(h), 1, 'отменённая задача всё равно запустилась')

  // Пауза занятого слота снимает процесс с исполнения.
  h.spawner.children[0].write('первые строки вывода')
  h.manager.pause('one')
  await flush(h)
  assert.equal(stateOf(h, 'one'), 'paused', `pause исполняемой задачи дал ${stateOf(h, 'one')}`)
  assert.equal(h.spawner.children[0].killed, true, 'pause не снял процесс с исполнения: дочерний процесс жив')
  h.clock.advance(MINUTE)
  await flush(h)
  assert.equal(spawned(h), 1, `на паузе ничего не исполняется, а процессов ${spawned(h)}`)
  h.manager.resume('one')
  await flush(h)
  assert.ok(['queued', 'running'].includes(stateOf(h, 'one')), `resume вернул задачу в ${stateOf(h, 'one')}`)
  assert.equal(spawned(h), 2, `после resume процесс не поднят: их ${spawned(h)}`)

  // Отмена: состояние `done` и больше ни одного запуска.
  h.manager.cancel('one')
  await flush(h)
  assert.equal(stateOf(h, 'one'), 'done', `cancel дал ${stateOf(h, 'one')}, а контракт обещает done/отменённое`)
  const afterCancel = spawned(h)
  h.clock.advance(HOUR)
  await flush(h)
  assert.equal(spawned(h), afterCancel, `отменённая задача запустилась снова: было ${afterCancel}, стало ${spawned(h)}`)
  assert.equal(stateOf(h, 'one'), 'done', 'отменённая задача вернулась в работу')

  // Перезапуск того же id: новая попытка, растущий счётчик и сохранённый журнал.
  const before = getOf(h, 'one')
  const prevAttempts = Number(before.attempts) || 0
  const prevLog = (Array.isArray(before.log) ? before.log : []).map(String)
  const restarted = h.manager.restart('one')
  assert.ok(!refused(restarted), `restart вернул ${show(restarted)} — перезапуск отказал`)
  await flush(h)
  const after = getOf(h, 'one')
  assert.ok(Number(after.attempts) > prevAttempts, `attempts не вырос: было ${prevAttempts}, стало ${show(after.attempts)}`)
  assert.ok(['queued', 'running'].includes(after.state), `после restart состояние ${after.state}`)
  assert.equal(spawned(h), afterCancel + 1, `restart не поднял процесс: процессов ${spawned(h)}`)
  const newLog = (Array.isArray(after.log) ? after.log : []).map(String).join('\n')
  if (prevLog.length) {
    for (const line of prevLog) {
      assert.ok(newLog.includes(line), `прежний журнал затёрт молча: строки «${line}» в новом логе нет`)
    }
  } else {
    assert.ok(newLog.trim(), 'после restart журнал пуст: ни прежних строк, ни отметки о новой попытке — перезапуск прошёл молча')
  }
})

// ---------------------------------------------------------------------------
// 5. Падение дочернего процесса
// ---------------------------------------------------------------------------

check('падение процесса: задача становится error с ПРИЧИНОЙ, слот освобождается, соседние идут', async () => {
  const h = make({ maxParallel: 1 })
  h.manager.add(task({ id: 'boom', title: 'Падает' }))
  await flush(h)
  assert.deepEqual(runningIds(h), ['boom'], 'первая задача не исполняется — проверять падение не на чем')
  h.spawner.children[0].die('spawn EACCES: доступ запрещён')
  await flush(h)
  const crashed = getOf(h, 'boom')
  assert.equal(crashed.state, 'error', `после отказа процесса состояние ${crashed.state}, а обещан error`)
  assert.equal(typeof crashed.error, 'string', `в причине не строка: ${show(crashed.error)}`)
  assert.ok(crashed.error.trim(), 'причина отказа пустая — человек не узнает, почему задача упала')
  assert.ok(!/undefined|null/.test(crashed.error), `в причине отпечаталось undefined: ${show(crashed.error)}`)
  assert.match(crashed.error, /EACCES|доступ/i, `причина не дошла до карточки: ${show(crashed.error)}`)
  assert.ok(Array.isArray(crashed.log), 'журнал задачи — не массив')
  assert.match(crashed.log.map(String).join('\n'), /EACCES|exit|код|error|ошиб/i,
    `в журнале нет ни строки об отказе: ${show(crashed.log)}`)
  assert.ok(has(h, 'boom'), 'упавшая задача исчезла из списка')

  // Освобождённый слот достаётся следующей, и она доходит до конца.
  h.manager.add(task({ id: 'next', title: 'Сосед' }))
  await flush(h)
  assert.ok(['running', 'done'].includes(stateOf(h, 'next')),
    `после чужого падения сосед не идёт: ${show(stateOf(h, 'next'))}`)
  h.spawner.children[1].exit(3)
  await flush(h)
  const nonzero = getOf(h, 'next')
  assert.equal(nonzero.state, 'error', 'ненулевой код выхода не считается падением: ' + nonzero.state)
  const text = [String(nonzero.error), (nonzero.log || []).map(String).join('\n')].join(' ')
  assert.match(text, /(^|\D)3(\D|$)/, `в карточке не видно код выхода: ${show(text.slice(0, 200))}`)
  assert.match(text, /код|code|exit|заверш|упал|ошиб/i, `причина не объясняет, что процесс завершился: ${show(text.slice(0, 200))}`)

  h.manager.add(task({ id: 'third', title: 'Третья' }))
  await flush(h)
  assert.equal(spawned(h), 3, `после двух падений очередь встала: процессов ${spawned(h)}`)
  h.spawner.children[2].exit(0)
  await flush(h)
  assert.equal(stateOf(h, 'third'), 'done', 'после чужих падений успешная задача не дошла до done')
})

// ---------------------------------------------------------------------------
// 6. Переживает перезапуск приложения
// ---------------------------------------------------------------------------

check('перезапуск приложения: список читается с диска, незавершённая задача становится interrupted и сама не стартует', async () => {
  const dir = tmpDir()
  const first = make({ dir, maxParallel: 2 })
  first.manager.add(task({ id: 'keep', title: 'Долгая' }))
  first.manager.add(task({ id: 'finished', title: 'Короткая' }))
  await flush(first)
  assert.deepEqual(runningIds(first).sort(), ['finished', 'keep'],
    `обе задачи не взялись за исполнение: ${show(runningIds(first))}`)
  first.spawner.children[1].exit(0)
  await flush(first)
  assert.equal(stateOf(first, 'finished'), 'done', 'успешная задача не дошла до done')
  // Так выглядит диск у процесса, убитого внутри исполнения: `stop` не вызывался.

  const second = make({ dir, autoStart: false, maxParallel: 2 })
  second.manager.start()
  const stored = listOf(second).map(one => one && one.id).sort()
  assert.deepEqual(stored, ['finished', 'keep'], `после перезапуска с диска прочитано ${show(stored)}`)
  assert.equal(stateOf(second, 'keep'), 'interrupted',
    `незавершённая задача после перезапуска в ${stateOf(second, 'keep')}, а не interrupted: окно показывает висящую «в работе»`)
  assert.equal(stateOf(second, 'finished'), 'done', 'завершённая задача после перезапуска потеряла исход')
  assert.equal(spawned(second), 0,
    `после подъёма само собой поднято ${spawned(second)} процессов — прерванную задачу перезапускает человек, а не планировщик`)
  second.clock.advance(HOUR)
  await flush(second)
  assert.equal(spawned(second), 0, `тикер после подъёма всё же запустил ${spawned(second)} процессов`)
  assert.equal(stateOf(second, 'keep'), 'interrupted', 'прерванная задача сама ушла в работу')
})

// ---------------------------------------------------------------------------
// 7. Поток состояний в окно
// ---------------------------------------------------------------------------

check('поток состояний в окно не чаще heartbeatMs и с доставленным ПОСЛЕДНИМ состоянием', async () => {
  const heartbeat = 100
  const updates = 500
  const h = make({ heartbeatMs: heartbeat, maxParallel: 1 })
  h.manager.add(task({ id: 'hb', title: 'Долгий прогон' }))
  await flush(h)
  assert.deepEqual(runningIds(h), ['hb'], `задача не исполняется: ${show(stateOf(h, 'hb'))}`)
  const baseline = h.sent.length
  // 500 быстрых обновлений одной задачи: ~60 в секунду, как в живом прогоне.
  for (let i = 0; i < updates; i++) {
    h.spawner.children[0].write(`строка вывода ${i}`)
    h.clock.advance(16)
    try { h.clock.fire() } catch (error) {
      throw new Error(`тик во время потока обновлений бросает наружу: ${error && error.message}`)
    }
    await Promise.resolve()
  }
  const limit = Math.ceil((updates * 16) / heartbeat) + 4
  const burst = h.sent.length - baseline
  assert.ok(burst <= limit,
    `за ${updates} обновлений окно получило ${burst} сообщений, а по heartbeatMs = ${heartbeat} ожидалось не больше ${limit}: экран захлебнётся`)
  assert.ok(burst >= 1, 'ни одного сообщения об исполняемой задаче: экран останется пустым')
  // Последнее состояние обязано доехать, иначе карточка замирает на полуслове.
  h.spawner.children[0].exit(0)
  await flush(h)
  h.clock.advance(heartbeat)
  await flush(h)
  assert.equal(stateOf(h, 'hb'), 'done', 'своего состояния планировщик не увидел: проверять доставку не на чем')
  const last = lastAbout(h.sent, 'hb')
  assert.ok(last, 'окно не получило ни одного сообщения с id этой задачи')
  assert.ok(statesIn(last).includes('done'),
    `последнее доставленное состояние ${show(statesIn(last))}, а не done: экран останется на полуслове`)
  assert.ok(!statesIn(last).includes('running'), `в последнем сообщении ещё живёт «running»: ${show(last)}`)
})

// ---------------------------------------------------------------------------
// 8. Секреты не едут ни в окно, ни на диск
// ---------------------------------------------------------------------------

check('ни в send, ни в list, ни на диске значения вида sk-QoderTest: зачистка той же формы, что redactSecrets', async () => {
  const h = make({ maxParallel: 1 })
  const result = h.manager.add(task({ id: 'secret', title: `проверка ${SECRET} сборки` }))
  assert.ok(accepted(result), `задача с секретом в заголовке отказана: ${show(result)}`)
  await flush(h)
  h.spawner.children[0].die(`процесс пал: ${SECRET}`)
  await flush(h)
  const card = getOf(h, 'secret')
  assert.equal(card.state, 'error', 'проверка строится на упавшей задаче, а она в состоянии ' + card.state)
  const visible = dump([card, listOf(h)], 'карточка из list()/get()')
  assert.ok(!visible.includes('sk-QoderTest'), `секрет протёк в список задач: ${visible.slice(0, 240)}`)
  const wire = dump(h.sent, 'отправленные в окно тела')
  assert.ok(!wire.includes('sk-QoderTest'), `секрет уехал в окно телом send: ${wire.slice(0, 240)}`)
  assert.ok(!dumpOfDir(h.dir).includes('sk-QoderTest'),
    'секрет лёг на диск открытым: его перечитает следующий запуск и всякий, кто заглянет в каталог')
  assert.ok(storeListOf(h).length, 'задача не попала в хранилище: проверять зачистку диска не на чем')
  // Зачистка не имеет права съесть смысл: форма — та же, что у `redactSecrets`.
  const text = `${card.title} ${card.error}`
  assert.match(String(card.title), /проверка/, `зачистка съела заголовок целиком: ${show(card.title)}`)
  assert.match(String(card.title), /сборк/, `из заголовка пропало полезное слово: ${show(card.title)}`)
  assert.match(String(card.error), /пал/, `зачистка съела причину отказа: ${show(card.error)}`)
  assert.match(text, /\*\*\*/, `форма зачистки не как у redactSecrets (***): ${show(text.slice(0, 200))}`)
})

// ---------------------------------------------------------------------------
// 9. stop() гасит таймеры
// ---------------------------------------------------------------------------

check('stop() не оставляет взведённых ручек и больше не поднимает процессов', async () => {
  const h = make({ maxParallel: 2, heartbeatMs: 50 })
  for (const id of ['a', 'b', 'c', 'd']) h.manager.add(task({ id, title: id }))
  await flush(h)
  assert.equal(spawned(h), 2, `до stop в работе ${spawned(h)} процессов при maxParallel = 2`)
  const armedBefore = h.clock.armed()
  const spawnedBefore = spawned(h)
  const sentBefore = h.sent.length
  h.manager.stop()
  assert.equal(h.clock.pending(), 0,
    `после stop осталось ${h.clock.pending()} взведённых таймеров: приложение не сможет уснуть`)
  // Ни одного нового вооружения, ни одного нового процесса, ни одного запуска.
  h.clock.advance(HOUR)
  await flush(h)
  h.spawner.children[0].exit(0)
  await flush(h)
  assert.equal(h.clock.armed(), armedBefore,
    `после stop планировщик взвёл ещё ${h.clock.armed() - armedBefore} таймер(ов) — он продолжает жить`)
  assert.equal(spawned(h), spawnedBefore, `после stop поднят новый процесс: было ${spawnedBefore}, стало ${spawned(h)}`)
  for (const id of ['c', 'd']) {
    assert.equal(stateOf(h, id), 'queued', `остановленный планировщик пустил ${id} в работу: ${stateOf(h, id)}`)
  }
  assert.ok(h.sent.length >= sentBefore, 'сообщений стало меньше прежнего — stop() сломал канал окна')
})

// ---------------------------------------------------------------------------
// 10. Невалидный вход не роняет планировщик
// ---------------------------------------------------------------------------

check('невалидный вход: add(null)/add({}) без title, pause чужого id, get(undefined) — честный отказ или null, без броска', async () => {
  const h = make({ maxParallel: 1 })
  h.manager.add(task({ id: 'good', title: 'Единственная' }))
  await flush(h)
  const broken = [null, undefined, {}, 5, 'строка', { id: 'no-title' }]
  for (const input of broken) {
    let result
    assert.doesNotThrow(() => { result = h.manager.add(input) }, `add(${show(input)}) бросает наружу: планировщик падает на чужом вводе`)
    assert.ok(refused(result), `add(${show(input)}) принят молча: ${show(result)} — в списке вырастет карточка-призрак`)
    if (result && typeof result === 'object') {
      assert.ok(String(result.error || result.message || '').trim(),
        `add(${show(input)}) отказал без причины: ${show(result)}`)
    }
  }
  assert.equal(listOf(h).length, 1, `после битого входа в списке ${listOf(h).length} задач`)
  // Задача без id: либо честный отказ, либо принятая карточка СО СВОИМ id.
  let idless
  assert.doesNotThrow(() => { idless = h.manager.add({ title: 'без id' }) }, 'add без id бросает наружу')
  if (!refused(idless)) {
    const ghosts = listOf(h).filter(one => !one || typeof one.id !== 'string' || !one.id)
    assert.deepEqual(ghosts, [], `задача без id легла в список карточкой без идентификатора: ${show(ghosts)}`)
  }
  for (const method of ['pause', 'resume', 'cancel', 'restart']) {
    let answer
    assert.doesNotThrow(() => { answer = h.manager[method]('нет-такого') }, `${method}('нет-такого') бросает наружу`)
    assert.ok(refused(answer) || answer === undefined, `${method} чужого id притворился успехом: ${show(answer)}`)
  }
  for (const id of [undefined, null, '', 'нет-такого', {}]) {
    let found
    assert.doesNotThrow(() => { found = h.manager.get(id) }, `get(${show(id)}) бросает наружу`)
    assert.ok(found === null || found === undefined, `get(${show(id)}) вернул карточку ${show(found)}`)
  }
  // После череды отказов планировщик обязан оставаться живым.
  assert.deepEqual(runningIds(h), ['good'], `битый вход сломал живую задачу: ${show(stateOf(h, 'good'))}`)
  h.spawner.children[0].exit(0)
  await flush(h)
  assert.equal(stateOf(h, 'good'), 'done', 'после череды отказов живая задача не дошла до done')
})

// ---------------------------------------------------------------------------
// 11. Карточка задачи: что читает окно
// ---------------------------------------------------------------------------

check('карточка задачи: поля и состояния контракта на месте и у ожидающей, и у завершённой', async () => {
  const h = make({ maxParallel: 1 })
  h.manager.add(task({ id: 'card', title: 'Карточка' }))
  h.manager.add(task({ id: 'wait', title: 'Ждущая' }))
  await flush(h)
  const FIELDS = ['id', 'title', 'kind', 'priority', 'state', 'progress', 'startedAt', 'finishedAt', 'error', 'attempts', 'log']
  for (const id of ['card', 'wait']) {
    const one = getOf(h, id)
    assert.ok(one && typeof one === 'object', `get('${id}') вернул ${show(one)}`)
    for (const field of FIELDS) {
      assert.ok(field in one, `в карточке ${id} нет поля ${field}, которое читает окно: ${show(one)}`)
    }
    assert.ok(STATES.includes(one.state), `неизвестное состояние ${show(one.state)} — экран не сумеет его назвать`)
    assert.ok(PRIORITIES.includes(one.priority), `неизвестный приоритет ${show(one.priority)}: ${show(one)}`)
    assert.ok(Array.isArray(one.log), `журнал задачи — не массив: ${show(one.log)}`)
    assert.ok(Number.isFinite(Number(one.attempts)), `attempts не число: ${show(one.attempts)}`)
    assert.ok(one.progress === null || one.progress === undefined || Number.isFinite(Number(one.progress)),
      `progress не читается окном: ${show(one.progress)}`)
  }
  h.spawner.children[0].write('итог прогона')
  h.spawner.children[0].exit(0)
  await flush(h)
  const done = getOf(h, 'card')
  assert.equal(done.state, 'done', 'успешное исполнение не дошло до done')
  const timeOk = value => value === null || value === undefined || Number.isFinite(value) || !Number.isNaN(Date.parse(String(value)))
  assert.ok(timeOk(done.startedAt) && timeOk(done.finishedAt),
    `времена карточки не разбираются: ${show([done.startedAt, done.finishedAt])}`)
  if (Number.isFinite(done.startedAt) && Number.isFinite(done.finishedAt)) {
    assert.ok(done.finishedAt >= done.startedAt, `задача завершилась раньше, чем началась: ${show([done.startedAt, done.finishedAt])}`)
  }
  assert.equal(String(done.error || ''), '', `у завершённой задачи есть причина: ${show(done.error)}`)
})

// ---------------------------------------------------------------------------
// 12. drain() и идемпотентность взятия слота
// ---------------------------------------------------------------------------

check('drain() дожидается начатых исполнений, а повторный ответ процесса не плодит второй запуск', async () => {
  const h = make({ maxParallel: 2 })
  for (const id of ['x', 'y', 'z']) h.manager.add(task({ id, title: id }))
  await flush(h)
  assert.equal(spawned(h), 2, `взято ${spawned(h)} слота из двух`)
  // Ответ процесса приходит один раз; повторная доставка не имеет права освободить
  // слот дважды.
  h.spawner.children[0].exit(0)
  h.spawner.children[0].exit(0)
  await flush(h)
  assert.equal(stateOf(h, 'x'), 'done', `повторный ответ процесса сбил состояние: ${show(stateOf(h, 'x'))}`)
  assert.equal(spawned(h), 3, `двойной ответ освободил два слота: процессов ${spawned(h)}`)
  assert.deepEqual(runningIds(h).sort(), ['y', 'z'], `состав исполняемых после освобождения: ${show(runningIds(h))}`)
  // Всё начатое дошло: `drain()` на опустевшей очереди не висит и не бросает.
  h.spawner.children[1].exit(0)
  h.spawner.children[2].exit(0)
  const drained = await Promise.resolve(h.manager.drain())
  assert.ok(drained !== undefined, 'drain() вернул undefined — вызывающему нечем дождаться конца')
  assert.deepEqual(['x', 'y', 'z'].map(id => stateOf(h, id)), ['done', 'done', 'done'],
    'после drain() начатые исполнения остались незавершёнными')
  await h.manager.drain()
})

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

runQueue()
  .catch(error => {
    failed++
    console.error(`ПРОВАЛ [набор]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ')}`)
  })
  .finally(() => {
    cleanup()
    if (missing().length) console.error(`${missing().join('; ')} — весь набор красным, и это его правильное состояние`)
    console.log(`Проверок: ${checks}, отказов: ${failed}`)
    console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
    process.exitCode = failed ? 1 : 0
  })
