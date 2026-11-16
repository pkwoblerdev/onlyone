'use strict'
// Производители очереди (план, 3.4б): работу, которую поднял не планировщик,
// очередь видит, показывает и умеет её остановить.
//
// ТЕСТЫ ДО КОДА: шва присоединения в `src/main/task-manager.js` нет — набор
// обязан быть красным и сказать почему СВОИМ текстом.
//
// Зачем шов вообще нужен. `run_command` уже исполняет команду своим путём:
// охрана строки, подтверждение человека, съём дерева процессов, кодовая страница
// консоли. Если очередь начнёт ту же команду исполнять сама, получится либо
// двойной запуск, либо молчаливая замена самого горячего инструмента приложения
// его же копией. Поэтому договор такой: исполнитель остаётся у производителя, а
// планировщик получает рукоятку — `{ on, kill }` — и отвечает за состояние,
// журнал, карточку в окне и кнопки.
//
// Два правила, которые набор держит железно:
//   * присоединённая работа НЕ ждёт освобождения слота. Иначе четвёртый агент
//     в совете встал бы в очередь к трём командам, и ход завис бы из-за экрана,
//     который должен только показывать;
//   * рукоятка не ложится ни в окно, ни на диск: сериализуется только карточка.
//
// Ни Electron, ни сети, ни живых процессов: «рукоятка» — объект теста, «исход»
// — вызов его слушателя. Время и таймеры подставные, как в `test-task-manager`.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let taskModule = null
let loadError = null
try {
  taskModule = require('../src/main/task-manager')
} catch (error) {
  loadError = String(error && error.message).split('\n')[0]
}

let checks = 0
let failed = 0
const queue = []
function check(name, fn) { queue.push({ name, fn }) }
async function runQueue() {
  for (const item of queue) {
    checks++
    if (!taskModule) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: модуля нет — src/main/task-manager.js (${loadError})`)
      continue
    }
    try {
      await item.fn()
      console.log('ok', item.name)
    } catch (error) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 320)}`)
    }
  }
}

const show = value => {
  try {
    const text = JSON.stringify(value)
    return (text === undefined ? String(value) : text).slice(0, 220)
  } catch { return String(value) }
}

const tmpDirs = []
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-task-producers-'))
  tmpDirs.push(dir)
  return dir
}
function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* свои каталоги */ }
  }
}

const SECOND = 1000
const T0 = Date.parse('2026-09-28T09:00:00.000Z')

function fakeClock(startMs) {
  let nowMs = startMs
  const timers = new Map()
  let seq = 0
  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: nowMs + (Number(ms) || 0) }); return id },
    clearTimeout: id => { timers.delete(id) },
    pending: () => timers.size,
    advance: ms => { nowMs += ms },
    // «Тик»: исполняет просроченные таймеры. Без него троттл окна не дождаться,
    // и проверка «что ушло в окно» читала бы пустой список.
    fire: () => {
      const due = [...timers.entries()].filter(([, t]) => t.at <= nowMs).sort((a, b) => a[1].at - b[1].at)
      for (const [id, t] of due) { timers.delete(id); t.fn() }
      return due.length
    }
  }
}

// Рукоятка производителя: планировщик видит только `on` и `kill`.
function makeHandle() {
  const listeners = { error: [], close: [] }
  const handle = {
    kills: 0,
    on(name, cb) { (listeners[name] ||= []).push(cb) },
    kill() { handle.kills++; return true },
    emitClose(code) { for (const cb of listeners.close.slice()) cb(code) },
    emitError(error) { for (const cb of listeners.error.slice()) cb(error) }
  }
  return handle
}

function make(options = {}) {
  const clock = fakeClock(T0)
  const spawns = []
  const sent = []
  const store = {
    records: [],
    load() { return { records: this.records, corrupt: false } },
    list() { return this.records.map(one => ({ ...one })) },
    save(records) { this.records = records.map(one => ({ ...one })) },
    upsert(record) { this.save([record]) },
    remove() { return false }
  }
  const manager = taskModule.createTaskManager({
    store,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    spawn: (...args) => { spawns.push(args); return makeHandle() },
    send: body => { sent.push(body); return true },
    maxParallel: options.maxParallel === undefined ? 3 : options.maxParallel,
    heartbeatMs: 50
  })
  manager.start()
  return { manager, clock, spawns, sent, store }
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)) }
const task = (over = {}) => ({ id: 'a', title: 'Работа', kind: 'shell', priority: 'normal', ...over })
const stateOf = (h, id) => (h.manager.get(id) || {}).state
const cardOf = (h, id) => h.manager.get(id)

// ---------------------------------------------------------------------------

check('рукоятка принимается: задача сразу в работе, и ни одного порождённого процесса', async () => {
  const h = make({ maxParallel: 3 })
  const handle = makeHandle()
  const answer = h.manager.add(task({ id: 'cmd1', kind: 'command', handle }))
  await flush()
  assert.ok(answer && answer.ok, `add с рукояткой отказал: ${show(answer)}`)
  assert.equal(stateOf(h, 'cmd1'), 'running', `присоединённая работа в состоянии ${show(stateOf(h, 'cmd1'))}`)
  assert.equal(h.spawns.length, 0, `планировщик породил процесс сам: ${h.spawns.length} вызовов spawn`)
  assert.equal(Number(cardOf(h, 'cmd1').attempts), 1, 'попытка не засчитана')
})

check('присоединённая работа не ждёт слота: четыре из трёх идут сразу', async () => {
  const h = make({ maxParallel: 2 })
  const handles = []
  for (const id of ['p', 'q', 'r', 's']) {
    const handle = makeHandle()
    handles.push([id, handle])
    h.manager.add(task({ id, handle }))
  }
  await flush()
  const running = handles.filter(([id]) => stateOf(h, id) === 'running').map(([id]) => id)
  assert.deepEqual(running.sort(), ['p', 'q', 'r', 's'],
    `при пределе 2 в работе ${show(running)}: присоединённая работа встала в очередь — ход агента завис бы из-за экрана`)
  assert.equal(h.spawns.length, 0, 'spawn всё-таки вызывался')
})

check('обычная очередь слота по-прежнему ждёт', async () => {
  const h = make({ maxParallel: 1 })
  h.manager.add(task({ id: 'one', command: 'node' }))
  h.manager.add(task({ id: 'two', command: 'node' }))
  await flush()
  assert.equal(stateOf(h, 'one'), 'running', 'первая задача не взята')
  assert.equal(stateOf(h, 'two'), 'queued', `вторая обошла предел: ${show(stateOf(h, 'two'))}`)
})

check('исход присоединённой работы приходит от производителя, а не от процесса', async () => {
  const h = make()
  const handle = makeHandle()
  h.manager.add(task({ id: 'ok1', handle }))
  await flush()
  handle.emitClose(0)
  await flush()
  assert.equal(stateOf(h, 'ok1'), 'done', `код 0 не дошёл до карточки: ${show(stateOf(h, 'ok1'))}`)
  assert.equal(String(cardOf(h, 'ok1').error || ''), '', 'у завершённой работы есть причина')

  const bad = makeHandle()
  h.manager.add(task({ id: 'bad1', handle: bad }))
  await flush()
  bad.emitClose(3)
  await flush()
  assert.equal(stateOf(h, 'bad1'), 'error', `код 3 не стал падением: ${show(stateOf(h, 'bad1'))}`)
  assert.match(String(cardOf(h, 'bad1').error), /3/, `причина без кода: ${show(cardOf(h, 'bad1').error)}`)

  const boom = makeHandle()
  h.manager.add(task({ id: 'boom1', handle: boom }))
  await flush()
  boom.emitError(new Error('команда не запустилась'))
  await flush()
  assert.equal(stateOf(h, 'boom1'), 'error', 'ошибка рукоятки не стала падением')
  assert.match(String(cardOf(h, 'boom1').error), /не запустилась/, `причина ошибки потеряна: ${show(cardOf(h, 'boom1').error)}`)
})

check('пауза и отмена присоединённой работы снимают её у производителя', async () => {
  const h = make()
  const paused = makeHandle()
  const cancelled = makeHandle()
  h.manager.add(task({ id: 'pa', handle: paused }))
  h.manager.add(task({ id: 'ca', handle: cancelled }))
  await flush()
  assert.equal(h.manager.pause('pa').ok, true, 'пауза присоединённой работы отказала')
  assert.ok(paused.kills >= 1, 'пауза не попросила производителя снять работу')
  assert.equal(stateOf(h, 'pa'), 'paused', `после паузы состояние ${show(stateOf(h, 'pa'))}`)
  assert.equal(h.manager.cancel('ca').ok, true, 'отказ в отмене присоединённой работы')
  assert.ok(cancelled.kills >= 1, 'отмена не дошла до производителя')
  assert.equal(stateOf(h, 'ca'), 'done', `после отмены состояние ${show(stateOf(h, 'ca'))}`)
  // Снятая работа не может «вернуться» позже и испортить состояние.
  paused.emitClose(0)
  await flush()
  assert.equal(stateOf(h, 'pa'), 'paused', 'поздний ответ вернул снятую задачу в оборот')
})

check('рукоятка не уезжает ни в журнал на диске, ни в карточку окна', async () => {
  const h = make()
  const handle = makeHandle()
  h.manager.add(task({ id: 'hide', title: 'Сборка', handle }))
  await flush()
  handle.emitClose(0)
  await flush()
  const saved = JSON.stringify(h.store.records)
  assert.ok(saved.length > 2, 'журнал пуст — проверять нечего')
  assert.equal(saved.includes('emitClose'), false, 'рукоятка попала на диск')
  assert.equal(saved.includes('listeners'), false, 'внутренности рукоятки попали на диск')
  assert.doesNotThrow(() => JSON.parse(saved), 'журнал не читается как JSON')
  // В окно состояния уходят троттлированно: надо дождаться удара таймера.
  h.clock.advance(120)
  h.clock.fire()
  await flush()
  const last = h.sent[h.sent.length - 1]
  assert.ok(last && Array.isArray(last.tasks), `в окно не ушёл список задач: ${show(last)}`)
  const card = last.tasks.find(one => one && one.id === 'hide')
  assert.ok(card, 'карточки присоединённой работы нет в сообщении окна')
  assert.equal('handle' in card, false, 'в карточку окна рукоятка уехала')
  assert.equal(typeof card.on, 'undefined', 'в окне у карточки появились слушатели')
})

check('присоединённая без имени и рукоятка без слушателей — честный отказ', async () => {
  const h = make()
  const noTitle = h.manager.add({ handle: makeHandle() })
  assert.ok(noTitle && noTitle.ok === false, `работа без имени принята: ${show(noTitle)}`)
  const badHandle = h.manager.add(task({ id: 'broken', handle: { notAHandle: true } }))
  await flush()
  assert.ok(badHandle && badHandle.ok === false, 'рукоятка без слушателей принята молча: ' + show(badHandle))
  assert.equal(stateOf(h, 'broken'), undefined, 'битая рукоятка оставила карточку в списке')
})

check('перезапуск приложения: присоединённая работа становится прерванной, а не воскресшей', async () => {
  const clock = fakeClock(T0)
  const store = {
    records: [],
    load() { return { records: this.records, corrupt: false } },
    list() { return this.records.map(one => ({ ...one })) },
    save(records) { this.records = records.map(one => ({ ...one })) }
  }
  const first = taskModule.createTaskManager({
    store, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    spawn: () => makeHandle(), send: () => true, heartbeatMs: 50
  })
  first.start()
  const handle = makeHandle()
  first.add(task({ id: 'live', title: 'Долгая сборка', handle }))
  await flush()
  assert.equal((store.records.find(one => one.id === 'live') || {}).state, 'running',
    'работа не легла на диск словом «running»')
  first.stop()

  const second = taskModule.createTaskManager({
    store, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    spawn: () => makeHandle(), send: () => true, heartbeatMs: 50
  })
  second.start()
  const restored = second.get('live')
  assert.equal(restored.state, 'interrupted', `после перезапуска состояние ${show(restored.state)}`)
  assert.ok(String(restored.error || '').trim(), 'у прерванной работы нет причины')
  // Рукоятки у неё больше нет: планировщик не обязан поднимать чужую работу сам.
  second.pause('live')
  assert.notEqual(second.get('live').state, 'running', 'прерванная работа сама вернулась в исполнение')
})

// ---------------------------------------------------------------------------

runQueue()
  .catch(error => {
    failed++
    console.error(`ПРОВАЛ [набор]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ')}`)
  })
  .finally(() => {
    cleanup()
    console.log(`Проверок: ${checks}, отказов: ${failed}`)
    console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
    process.exitCode = failed ? 1 : 0
  })
