'use strict'
// Адресный набор рантайма расписаний (план, этап 3.5, часть 2 контракта):
// `src/main/schedule-store.js` (что лежит на диске) и
// `src/main/schedule-runner.js` (пробуждение, исполнение, отмена).
//
// ТЕСТЫ ДО КОДА: модулей нет, набор обязан быть красным и говорить почему.
// Ни Electron, ни сети, ни живых ключей, ни реальных ожиданий: часы и таймеры
// приходят параметрами, «сон» — это прыжок внедрённого `now`, а не пауза
// процесса. Тот же приём, что у `createCheckpointStore({ dir, now, … })`.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let storeMod = null
let runnerMod = null
const loadErrors = []
try { storeMod = require('../src/main/schedule-store') } catch (error) { loadErrors.push('store: ' + String(error.message).split('\n')[0]) }
try { runnerMod = require('../src/main/schedule-runner') } catch (error) { loadErrors.push('runner: ' + String(error.message).split('\n')[0]) }
const model = require('../src/main/schedule-model')

let checks = 0
let failed = 0
// Часть проверок возвращает обещание (исполнение асинхронное), поэтому набор
// собирается в очередь и прогоняется последовательно: общий итог обязан быть
// напечатан ПОСЛЕ всех обещаний, иначе «0 отказов» значит лишь «обещания ещё
// не дошли».
const queue = []
function check(name, fn) { queue.push({ name, fn }) }
async function runQueue() {
  for (const item of queue) {
    checks++
    if (!storeMod || !runnerMod) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: модулей рантайма нет (${loadErrors.join('; ')})`)
      continue
    }
    try {
      await item.fn()
      console.log('ok', item.name)
    } catch (error) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: ${error.message}`)
    }
  }
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const T = iso => Date.parse(iso)
const dirs = []
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-schedule-'))
  dirs.push(dir)
  return dir
}
function cleanup() { for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} } }

// Часы и таймеры — подставные: «тик» исполняет только то, что сам планировщик
// поставил, и порядок исполнений виден тесту.
function fakeClock(startMs) {
  let nowMs = startMs
  const timers = new Map()
  let seq = 0
  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: nowMs + ms }); return id },
    clearTimeout: id => { timers.delete(id) },
    pending: () => timers.size,
    // Сколько таймеров сработало бы прямо сейчас, если бы часы позволили:
    // планировщик на холостом ходу держит именно такие.
    due: () => [...timers.values()].filter(t => t.at <= nowMs).length,
    advance: ms => { nowMs += ms },
    // Исполняет просроченные таймеры (в порядке срока) и возвращает, сколько
    // из них сработало.
    fire: () => {
      const due = [...timers.entries()].filter(([, t]) => t.at <= nowMs).sort((a, b) => a[1].at - b[1].at)
      for (const [id, t] of due) { timers.delete(id); t.fn() }
      return due.length
    }
  }
}

// Часовой интервал: тайминги тестов не должны зависеть от пояса и DST —
// для этого есть отдельный набор ядра.
const hourly = (over = {}) => record({
  kind: 'interval',
  interval: { everyMinutes: 60, from: T('2026-04-01T04:00:00.000Z') },
  ...over
})

const record = (over = {}) => ({
  id: 'sch_1',
  name: 'Утренний разбор',
  enabled: true,
  timeZone: 'Europe/Berlin',
  kind: 'daily',
  daily: { time: '07:30' },
  action: { type: 'note', text: 'заметка' },
  ...over
})

function makeRunner(options = {}) {
  const dir = options.dir ?? tmpDir()
  const clock = fakeClock(options.at ?? T('2026-04-01T04:00:00.000Z'))
  const calls = []
  const events = []
  const store = storeMod.createScheduleStore({ dir, now: clock.now })
  const runner = runnerMod.createScheduleRunner({
    store,
    model,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    execute: options.execute || (async rec => { calls.push(rec.id); return { ok: true, runId: 'run-' + calls.length } }),
    publish: options.publish || (event => events.push(event)),
    ...options.extra
  })
  return { runner, clock, calls, events, store, dir, execute: options.execute }
}

// Снимок — объект `{ records, invalid, corrupt, storeError }`: отброшенные
// записи обязаны быть видимы, а не молча исчезнуть. Дальше набор работает с
// `.records`.
const views = runner => runner.snapshot().records
const viewOf = (runner, id) => views(runner).find(entry => entry.id === id)
// История живёт в хранилище: окно её не получает, и читать её нужно там же,
// где её читает человек после падения.
const historyOf = (store, id) => {
  const item = store.list().find(entry => entry && entry.id === id)
  return (item && Array.isArray(item.history) ? item.history : []).filter(entry => entry && typeof entry === 'object')
}

// ---------------------------------------------------------------------------
// 1. Хранилище
// ---------------------------------------------------------------------------

check('хранилище: пустой каталог — пустой список и без отметки о порче', () => {
  const store = storeMod.createScheduleStore({ dir: tmpDir() })
  const loaded = store.load()
  assert.deepEqual(loaded.records, [], 'на пустом каталоге что-то нашлось')
  assert.equal(loaded.corrupt, false, 'пустой каталог записан как битый')
})

check('хранилище: список перечитывается после перезапуска без потерь', () => {
  const dir = tmpDir()
  const first = storeMod.createScheduleStore({ dir })
  first.upsert(record())
  first.upsert(record({ id: 'sch_2', name: 'Вечерний' }))
  const second = storeMod.createScheduleStore({ dir })
  const names = second.load().records.map(item => item.name).sort()
  assert.deepEqual(names, ['Вечерний', 'Утренний разбор'], `после перезапуска осталось ${JSON.stringify(names)}`)
})

check('хранилище: битый файл — честная отметка, а не молчаливая пустота', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'schedules.json')
  fs.writeFileSync(file, '{ это не json')
  const loaded = storeMod.createScheduleStore({ dir }).load()
  assert.equal(loaded.corrupt, true, 'битый файл притворился пустым — человек потеряет расписания молча')
  assert.ok(fs.existsSync(file), 'битый файл стёрт: восстановить уже нечего')
})

check('хранилище: запись атомарна — временных файлов после save не остаётся', () => {
  const dir = tmpDir()
  storeMod.createScheduleStore({ dir }).upsert(record())
  const leftovers = fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'после записи остались временные файлы: ' + leftovers.join(', '))
})

check('хранилище: отказ записи не съедает прежний файл', () => {
  const dir = tmpDir()
  const store = storeMod.createScheduleStore({ dir })
  store.upsert(record())
  const before = fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8')
  // Подставляем отказ на место атомарной записи: так выглядит диск, который
  // кончился или отдан под read-only.
  const broken = storeMod.createScheduleStore({
    dir,
    rename: () => { throw new Error('нет места на диске') }
  })
  assert.throws(() => broken.upsert(record({ name: 'Новое' })), /нет места|rename|запис/i,
    'отказ записи проглочен молча: человек решит, что расписание сохранено')
  assert.equal(fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8'), before,
    'прежний файл повреждён неудачной записью')
})

check('хранилище: история режется до 20 и старое уходит первым', () => {
  const store = storeMod.createScheduleStore({ dir: tmpDir() })
  store.upsert(record())
  for (let i = 0; i < 25; i++) store.appendHistory('sch_1', { at: 1000 + i, ok: true })
  const item = store.list().find(entry => entry.id === 'sch_1')
  assert.equal(item.history.length, 20, `в истории ${item.history.length} записей, обещано 20`)
  assert.equal(item.history[0].at, 1024, 'новые записи не в начале')
  assert.equal(item.history[19].at, 1005, 'ушло не самое старое')
})

check('хранилище: текст ошибки проходит зачистку и не хранит секрет', () => {
  const secret = 'sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14'
  const dir = tmpDir()
  const store = storeMod.createScheduleStore({ dir, redact: text => String(text).split(secret).join('***') })
  store.upsert(record())
  store.appendHistory('sch_1', { at: 1, ok: false, error: `ключ ${secret} отклонён` })
  const dump = fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8')
  assert.ok(!dump.includes(secret), 'секрет уехал на диск в истории расписания')
  assert.match(dump, /отклонён/, 'зачистка съела весь текст ошибки: ' + dump.slice(0, 160))
})

// Журнал задачи пишет командную строку двояко: одной строкой или массивом
// аргументов. Ключ, попавший в аргумент, зачищается так же, как в `command`, —
// и не режется по длине, иначе команда перестаёт исполняться.
check('хранилище: секрет в массиве args зачищен, а сам массив не обрезан по длине', () => {
  const secret = 'sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14'
  const dir = tmpDir()
  const store = storeMod.createScheduleStore({ dir, file: 'tasks.json', redact: text => String(text).split(secret).join('***') })
  const longArg = 'x'.repeat(400)
  store.save([{ id: 'task_1', title: 'Сборка', command: 'node', args: ['-e', `ключ ${secret}`, longArg] }])
  const dump = fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8')
  assert.ok(!dump.includes(secret), 'секрет уехал на диск в массиве аргументов')
  assert.match(dump, /ключ \*\*\*/, 'зачистка съела аргумент целиком: ' + dump.slice(0, 200))
  const back = store.list().find(entry => entry.id === 'task_1')
  assert.equal(back.args.length, 3, `аргументов стало ${back.args.length} — хранилище режет команду`)
  assert.equal(back.args[2], longArg, 'длинный аргумент обрезан — команда не исполнится')
  assert.equal(back.command, 'node', 'сам `command` испорчен')
})

check('хранилище: upsert правит по id, remove чужого id не бросает', () => {
  const store = storeMod.createScheduleStore({ dir: tmpDir() })
  store.upsert(record())
  store.upsert(record({ name: 'Переименованное' }))
  assert.equal(store.list().length, 1, 'upsert плодит дубль вместо правки')
  assert.equal(store.list()[0].name, 'Переименованное')
  assert.doesNotThrow(() => store.remove('нет-такого'))
  store.remove('sch_1')
  assert.deepEqual(store.list(), [], 'после remove запись вернулась')
})

check('хранилище: settleHistory правит ту же запись истории и чистит её', () => {
  const dir = tmpDir()
  const store = storeMod.createScheduleStore({ dir })
  store.upsert(record())
  // Два запуска подряд: «начато» без ответа, и исход обязан прийти в СВОЮ
  // строку — иначе журнал запусков врёт о том, что дожило до ответа.
  assert.equal(store.appendHistory('sch_1', { at: 1000, ok: null, runId: 'run-a' }), true, 'appendHistory не сообщил об успехе')
  assert.equal(store.appendHistory('sch_1', { at: 2000, ok: null, runId: 'run-b' }), true)
  assert.equal(store.settleHistory('sch_1', 'run-a', { ok: true }), true, 'settleHistory не нашёл запись «начато»')
  const item = storeMod.createScheduleStore({ dir }).list().find(entry => entry.id === 'sch_1')
  assert.equal(item.history.length, 2, `исход добавил третью запись: ${JSON.stringify(item.history)}`)
  assert.deepEqual([item.history[1].runId, item.history[1].ok], ['run-a', true], 'исход лёг не в ту запись')
  assert.equal(item.history[0].ok, null, 'чужой запуск получил исход раньше времени')
  assert.equal(store.settleHistory('sch_1', 'нет-такого', { ok: true }), false, 'несуществующий runId притворился исполненным')
  assert.equal(store.settleHistory('нет-расписания', 'run-a', { ok: true }), false, 'исход лёг в чужое расписание')
  // Текст исхода проходит ту же зачистку, что и остальные ветки записи.
  const secret = 'sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14'
  const sealed = storeMod.createScheduleStore({ dir, redact: text => String(text).split(secret).join('***') })
  assert.equal(sealed.settleHistory('sch_1', 'run-b', { ok: false, error: `ключ ${secret} отклонён` }), true)
  const raw = fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8')
  assert.ok(!raw.includes(secret), 'исход уехал на диск открытым ключом')
  assert.match(raw, /ключ \*\*\* отклонён/, 'зачистка съела причину отказа: ' + raw.slice(0, 200))
})

check('хранилище: upsert не затирает журнал, а новый id получает свою историю', () => {
  const dir = tmpDir()
  const store = storeMod.createScheduleStore({ dir })
  store.upsert(record())
  store.appendHistory('sch_1', { at: 1000, ok: null, runId: 'run-a' })
  store.settleHistory('sch_1', 'run-a', { ok: true })
  store.upsert(record({ name: 'Вторая редакция', history: [] }))
  const item = storeMod.createScheduleStore({ dir }).list().find(entry => entry.id === 'sch_1')
  assert.equal(item.name, 'Вторая редакция', 'upsert не дошёл до диска')
  assert.deepEqual(item.history.map(entry => entry.runId), ['run-a'],
    `правка записи стёрла журнал запуска: ${JSON.stringify(item.history)}`)
  store.upsert(record({ id: 'sch_new', history: [{ at: 1, ok: true, runId: 'run-new' }] }))
  const fresh = store.list().find(entry => entry.id === 'sch_new')
  assert.deepEqual(fresh.history.map(entry => entry.runId), ['run-new'],
    'первая запись журнала нового расписания потеряна')
})

// ---------------------------------------------------------------------------
// 2. Рантайм: подъём, тик, идемпотентность
// ---------------------------------------------------------------------------

check('рантайм: start поднимает с диска и пересчитывает просроченный nextRunAt', () => {
  const dir = tmpDir()
  const made = makeRunner({ dir })
  made.runner.add(record({ nextRunAt: T('2020-01-01T00:00:00.000Z') }))
  made.runner.start()
  const item = viewOf(made.runner, 'sch_1')
  assert.ok(item.nextRunAt > made.clock.now(), `nextRunAt остался в прошлом: ${new Date(item.nextRunAt).toISOString()}`)
  assert.equal(item.nextRunAt, T('2026-04-01T05:30:00.000Z'), 'пересчёт не по стене пояса записи')
  // Пересчёт обязан пережить падение до первого тика: на диске тоже будущее.
  const onDisk = made.store.list().find(entry => entry.id === 'sch_1')
  assert.equal(onDisk.nextRunAt, T('2026-04-01T05:30:00.000Z'),
    `start пересчитал в памяти, а на диске осталось ${new Date(onDisk.nextRunAt).toISOString()} — следующий старт догонит её снова`)
})

check('рантайм: наступивший запуск исполняется ровно один раз на слот', () => {
  const made = makeRunner()
  made.runner.add(hourly())
  made.runner.start()
  made.clock.advance(61 * MINUTE)
  made.clock.fire()
  assert.deepEqual(made.calls, ['sch_1'], 'наступивший слот не исполнен')
  made.clock.fire()
  made.clock.fire()
  assert.deepEqual(made.calls, ['sch_1'], 'тот же слот исполнился повторно: ' + made.calls.join(','))
})

check('рантайм: гонка «вручную + таймер» по одному слоту даёт один ход', () => {
  // Исполнение намеренно не завершено к моменту тика: защита от двойного хода
  // проверяется на этом окне, а не после того, как всё разошлось.
  const clock = fakeClock(T('2026-04-01T04:00:00.000Z'))
  const started = []
  let release = null
  const runner = runnerMod.createScheduleRunner({
    store: storeMod.createScheduleStore({ dir: tmpDir(), now: clock.now }),
    model, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    publish: () => {},
    execute: rec => { started.push(rec.id); return new Promise(resolve => { release = () => resolve({ ok: true }) }) }
  })
  runner.add(hourly())
  runner.start()
  clock.advance(61 * MINUTE)
  const manual = runner.runNow('sch_1')
  // Второй ручной запуск того же расписания, пока первый не ответил: защиту
  // держит само `fire` (тик проверяет занятость отдельно).
  runner.runNow('sch_1')
  clock.fire()
  assert.equal(started.length, 1, `исполнений ${started.length} ещё до ответа — тик взял занятый слот`)
  // Второй слот наступает, пока первое исполнение ещё не ответило: расписание
  // с длинным ходом не должно исполняться параллельно само себя.
  clock.advance(60 * MINUTE)
  clock.fire()
  assert.equal(started.length, 1, `пока исполнение не ответило, началось второе (${started.length}) — слоты накладываются`)
  release()
  return Promise.resolve(manual).then(() => runner.drain()).then(() => {
    assert.ok(started.length >= 1, 'после ответа планировщик встал')
  })
})

check('рантайм: занятое исполнение не будит процесс впустую', () => {
  // Слот наступил, пока предыдущий ход ещё не ответил. Второй ход запрещён —
  // и запрещён тоже таймер, который ради этого запрещённого хода крутил бы
  // планировщик на холостом ходу: он срабатывает, ничего не находит и
  // вооружается снова.
  const clock = fakeClock(T('2026-04-01T04:00:00.000Z'))
  const started = []
  let release = null
  const runner = runnerMod.createScheduleRunner({
    store: storeMod.createScheduleStore({ dir: tmpDir(), now: clock.now }),
    model, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    publish: () => {},
    execute: rec => { started.push(rec.id); return new Promise(resolve => { release = () => resolve({ ok: true }) }) }
  })
  runner.add(hourly())
  runner.start()
  clock.advance(60 * MINUTE)
  clock.fire()
  assert.deepEqual(started, ['sch_1'], 'первый слот не исполнен: проверять занятость нечего')
  clock.advance(60 * MINUTE)
  clock.fire()
  assert.deepEqual(started, ['sch_1'], 'пока ход не ответил, начался второй')
  assert.equal(clock.due(), 0, `планировщик держит ${clock.due()} таймер(ов), срабатывающих впустую — процесс крутится, пока ход не ответит`)
  release()
  return runner.drain().then(() => {
    assert.equal(clock.due(), 1, 'освободившись, расписание не вооружилось: пропущенный слот ждать себя не станет')
    clock.fire()
    assert.deepEqual(started, ['sch_1', 'sch_1'], 'после ответа следующий слот не исполнен — сетка встала')
  })
})

check('рантайм: ручной запуск не двигает сетку, но попадает в историю', () => {
  const made = makeRunner()
  made.runner.add(hourly())
  made.runner.start()
  const before = viewOf(made.runner, 'sch_1').nextRunAt
  return made.runner.runNow('sch_1').then(() => {
    const item = viewOf(made.runner, 'sch_1')
    assert.equal(item.nextRunAt, before, 'ручной запуск сдвинул следующий по расписанию')
    assert.ok(item.lastRunAt <= made.clock.now(), `ручной запуск записал исполненным будущее: ${new Date(item.lastRunAt).toISOString()}`)
    const history = historyOf(made.store, 'sch_1')
    assert.equal(history.length, 1, `ручной запуск дал ${history.length} записей истории, а не одну`)
    assert.equal(history[0].manual, true, 'в истории нет пометки о ручном запуске')
    assert.equal(history[0].ok, true, 'исход не лёг в ту же запись «начато»: ' + JSON.stringify(history[0]))
    // И сетка после ручного запуска обязана прийти в срок.
    made.clock.advance(61 * MINUTE)
    made.clock.fire()
    return made.runner.drain().then(() => {
      assert.equal(made.calls.length, 2, 'после ручного запуска ближайший слот по расписанию пропущен')
    })
  })
})

check('рантайм: pause не исполняет, resume пересчитывает от «сейчас»', () => {
  const made = makeRunner()
  made.runner.add(hourly())
  made.runner.start()
  made.runner.pause('sch_1')
  made.clock.advance(24 * HOUR)
  made.clock.fire()
  assert.deepEqual(made.calls, [], 'на паузе расписание исполнилось')
  assert.equal(viewOf(made.runner, 'sch_1').enabled, false)
  made.runner.resume('sch_1')
  const item = viewOf(made.runner, 'sch_1')
  assert.equal(item.enabled, true)
  assert.ok(item.nextRunAt > made.clock.now(), 'resume не пересчитал следующий запуск')
})

check('рантайм: stop снимает все таймеры', () => {
  const made = makeRunner()
  made.runner.add(record())
  made.runner.add(record({ id: 'sch_2' }))
  made.runner.start()
  assert.ok(made.clock.pending() > 0, 'start не поставил ни одного таймера — проверять нечего')
  made.runner.stop()
  assert.equal(made.clock.pending(), 0, `после stop осталось ${made.clock.pending()} таймеров`)
})

check('рантайм: падение исполнения не убивает планировщик и не съедает соседа', () => {
  const dir = tmpDir()
  const made = makeRunner({
    dir,
    execute: async rec => { if (rec.id === 'sch_1') throw new Error('нет ответа'); return { ok: true } }
  })
  made.runner.add(hourly())
  made.runner.add(hourly({ id: 'sch_2' }))
  made.runner.start()
  made.clock.advance(61 * MINUTE)
  made.clock.fire()
  // Не `setImmediate`, а `drain()`: исполнение асинхронное, и «один поворот
  // цикла» мог бы прочитать состояние до того, как отказ дописан в историю.
  return made.runner.drain().then(() => {
    const item = viewOf(made.runner, 'sch_1')
    assert.match(String(item.lastError), /нет ответа/, 'причина отказа не записана')
    assert.ok(!String(item.lastError).includes('undefined'), 'в причине отпечаталось undefined')
    assert.ok(item.nextRunAt > made.clock.now(), 'после отказа расписание умерло')
    assert.ok(historyOf(made.store, 'sch_1').some(entry => entry.ok === false), 'в истории нет отказа')
    const other = viewOf(made.runner, 'sch_2')
    assert.ok(other.lastRunAt !== undefined && other.lastRunAt !== null, 'сосед по тике не исполнился из-за чужого падения')
  })
})

check('рантайм: сон на сутки при skip не превращается в очередь из 24 запусков', () => {
  const made = makeRunner()
  made.runner.add(hourly({ misfire: 'skip' }))
  made.runner.start()
  made.clock.advance(24 * HOUR + MINUTE)
  made.clock.fire()
  assert.equal(made.calls.length, 1, `после сна догнано ${made.calls.length} запусков, обещан один тик`)
})

check('рантайм: run-once догоняет ровно один пропуск и возвращается к сетке', () => {
  const made = makeRunner({ at: T('2026-04-01T00:00:00.000Z') })
  made.runner.add(record({ kind: 'interval', interval: { everyMinutes: 60, from: T('2026-04-01T00:00:00.000Z') }, misfire: 'run-once' }))
  made.runner.start()
  made.clock.advance(5 * HOUR + 30 * MINUTE)
  made.clock.fire()
  // Между тиками обязано дойти исполнение: слот, который ещё не settled,
  // занят, и второй тик его не берёт (это и есть защита от двойного хода).
  return made.runner.drain().then(() => {
    assert.equal(made.calls.length, 1, `после сна исполнено ${made.calls.length} — догон не обязан быть одиночным`)
    const after = viewOf(made.runner, 'sch_1')
    assert.ok(after.nextRunAt > made.clock.now(),
      `после догона остался просроченный слот ${new Date(after.nextRunAt).toISOString()} — это очередь догонов`)
    made.clock.advance(60 * MINUTE)
    made.clock.fire()
    return made.runner.drain()
  }).then(() => {
    assert.equal(made.calls.length, 2, 'после догона сетка не продолжилась')
  })
})

check('рантайм: publish говорит об изменении состояния и не показывает секретов', () => {
  const made = makeRunner()
  made.runner.add(hourly())
  made.runner.start()
  const dump = JSON.stringify(made.events)
  assert.ok(made.events.length >= 1, 'ни одного события окна: экран не узнает о расписании')
  assert.ok(!/keyEncrypted|sk-|ghp_|token/i.test(dump), 'в payload окна уехало что-то похожее на секрет: ' + dump.slice(0, 200))
  const item = made.events[0]
  for (const field of ['id', 'name', 'nextRunAt', 'enabled']) {
    assert.ok(field in item, `в событии нет поля ${field}: ${JSON.stringify(item)}`)
  }
})

check('рантайм: испорченная запись в файле не роняет start, остальные живут', () => {
  const dir = tmpDir()
  storeMod.createScheduleStore({ dir }).upsert(record())
  const file = path.join(dir, 'schedules.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  saved.records.push({ id: 'broken', kind: 'нет-такого' })
  fs.writeFileSync(file, JSON.stringify(saved))
  const made = makeRunner({ dir })
  assert.doesNotThrow(() => made.runner.start(), 'start упал на битой записи')
  const state = made.runner.snapshot()
  assert.deepEqual(state.records.map(entry => entry.id), ['sch_1'], 'вместо одной битой записи отброшен весь список')
  assert.ok(JSON.stringify(state.invalid).includes('broken'),
    `отброшенная запись нигде не отмечена — человек теряет расписание молча: ${JSON.stringify(state)}`)
})

check('рантайм: remove снимает расписание и с диска, и из таймеров', () => {
  const dir = tmpDir()
  const made = makeRunner({ dir })
  made.runner.add(hourly())
  made.runner.start()
  made.runner.remove('sch_1')
  assert.deepEqual(views(made.runner), [], 'расписание осталось в снапшоте')
  const reread = storeMod.createScheduleStore({ dir }).list()
  assert.deepEqual(reread, [], 'расписание осталось на диске')
})

check('рантайм: «начато» лежит на диске, пока исполнение ещё не ответило', () => {
  // Смысл контрольной точки: процесс, убитый внутри хода, оставляет след, и
  // след этот обязан отличаться от «сделано».
  const made = makeRunner({ execute: () => new Promise(() => {}) })
  made.runner.add(hourly())
  made.runner.start()
  made.clock.advance(61 * MINUTE)
  made.clock.fire()
  const history = historyOf(made.store, 'sch_1')
  assert.equal(history.length, 1, `исполнение началось, а на диске ${history.length} записей`)
  assert.equal(history[0].ok, null, '«начато» не отличается от «сделано»: след потерялся')
  assert.ok(typeof history[0].runId === 'string' && history[0].runId.length, 'у «начато» нет runId, исход нечем привязать')
  assert.equal(viewOf(made.runner, 'sch_1').running, true, 'висящее исполнение не помечено занятым')
})

check('рантайм: отказ диска в тике не роняет планировщик и не пропадает молча', () => {
  const dir = tmpDir()
  const clock = fakeClock(T('2026-04-01T04:00:00.000Z'))
  const good = storeMod.createScheduleStore({ dir, now: clock.now })
  good.upsert(hourly())
  const broken = Object.assign(Object.create(null), good, {
    appendHistory: () => { throw new Error('нет места на диске') },
    upsert: () => { throw new Error('нет места на диске') }
  })
  const runner = runnerMod.createScheduleRunner({
    store: broken, model, now: clock.now, setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout, publish: () => {}, execute: () => ({ ok: true })
  })
  runner.start()
  clock.advance(61 * MINUTE)
  assert.doesNotThrow(() => clock.fire(), 'отказ записи уронил планировщик наружу: часы встанут до утра')
  const state = runner.snapshot()
  assert.deepEqual(state.records.map(entry => entry.id), ['sch_1'], 'отказ записи выбросил расписание из снимка')
  assert.match(String(state.storeError), /нет места/, 'отказ диска проглочен молча: человек ждёт запуска впустую')
  assert.ok(state.records[0].nextRunAt > clock.now(), 'после отказа диска сетка не ушла вперёд')
})

check('рантайм: слот дальше 24 дней не вооружается задержкой, которую Node считает переполнением', () => {
  // Node обрезает `setTimeout` с задержкой больше 2^31-1 мс до 1 мс: расписание
  // «через год» без ограничения сработало бы СЕГОДНЯ.
  const clock = fakeClock(T('2026-04-01T04:00:00.000Z'))
  const delays = []
  const runner = runnerMod.createScheduleRunner({
    store: storeMod.createScheduleStore({ dir: tmpDir(), now: clock.now }),
    model, now: clock.now, publish: () => {}, execute: async () => ({ ok: true }),
    setTimeout: (fn, ms) => { delays.push(ms); return clock.setTimeout(fn, Math.min(ms, 2 ** 31 - 1)) },
    clearTimeout: clock.clearTimeout
  })
  runner.add({ id: 'sch_later', name: 'Через год', enabled: true, timeZone: 'Europe/Berlin',
    kind: 'once', once: { at: '2027-04-01T07:30:00+02:00' }, action: { type: 'note', text: 'заметка' } })
  runner.start()
  assert.ok(delays.length, 'start() не вооружил ни одного таймера — проверять нечего')
  for (const delay of delays) {
    assert.ok(delay <= 2 ** 31 - 1, `задержка ${delay} мс: Node превращает её в 1 мс, и запуск через год случится сегодня`)
  }
})

check('рантайм: отказ без явного ok:false тоже отказ, а история не разрастается', () => {
  const made = makeRunner({ execute: () => ({ error: 'модель не ответила' }) })
  made.runner.add(hourly())
  made.runner.start()
  made.clock.advance(61 * MINUTE)
  made.clock.fire()
  return made.runner.drain().then(() => {
    assert.match(String(viewOf(made.runner, 'sch_1').lastError), /модель не ответила/,
      'исполнитель вернул `error` без признака — запуск записан успешным')
    assert.equal(historyOf(made.store, 'sch_1')[0].ok, false, 'исход лёг как успешный')
  })
})

check('рантайм: 25 запусков подряд оставляют на диске ровно 20 записей истории', () => {
  // Память — зеркало хранилища, но зеркало, которое пишет обратно: если рантайм
  // держит истории меньше предела, он затирает диск до своей длины.
  const made = makeRunner({ execute: () => ({ ok: true }) })
  made.runner.add(hourly())
  made.runner.start()
  for (let i = 0; i < 25; i++) {
    made.clock.advance(HOUR)
    made.clock.fire()
  }
  return made.runner.drain().then(() => {
    const history = historyOf(made.store, 'sch_1')
    assert.equal(history.length, 20, `на диске ${history.length} записей истории, предела 20 не видно`)
    assert.ok(history.every(entry => entry.ok === true), 'среди сохранённых исходов есть провалы — обрезка съела не то')
  })
})

check('рантайм: хранилище, которое не отдало файл, не притворяется пустотой', () => {
  const clock = fakeClock(T('2026-04-01T04:00:00.000Z'))
  const good = storeMod.createScheduleStore({ dir: tmpDir(), now: clock.now })
  good.upsert(record())
  const deaf = Object.assign(Object.create(null), good, {
    load: () => { throw new Error('диск отключён') }
  })
  const runner = runnerMod.createScheduleRunner({
    store: deaf, model, now: clock.now, setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout, publish: () => {}, execute: () => ({ ok: true })
  })
  assert.doesNotThrow(() => runner.start(), 'отказ чтения уронил старт')
  const state = runner.snapshot()
  assert.equal(state.corrupt, true, 'нераскрытый файл отдан человеку как «расписаний нет»')
  assert.match(String(state.storeError), /диск отключён/, 'причина отказа чтения потеряна')
})

check('рантайм: remove во время незавершённого хода не воскресает запись', () => {
  const clock = fakeClock(T('2026-04-01T04:00:00.000Z'))
  const dir = tmpDir()
  let release = null
  const store = storeMod.createScheduleStore({ dir, now: clock.now })
  const runner = runnerMod.createScheduleRunner({
    store, model, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    publish: () => {}, execute: () => new Promise(resolve => { release = () => resolve({ ok: true }) })
  })
  runner.add(hourly())
  runner.start()
  clock.advance(60 * MINUTE)
  clock.fire()
  assert.equal(runner.remove('sch_1'), true, 'remove не сообщил об успехе')
  release()
  return runner.drain().then(() => {
    assert.deepEqual(storeMod.createScheduleStore({ dir }).list(), [],
      'удалённое расписание вернулось на диск после ответа хода')
    assert.deepEqual(views(runner), [], 'удалённое расписание осталось в снимке')
    assert.equal(clock.pending(), 0, `для удалённой записи висит ${clock.pending()} таймер(ов)`)
  })
})

check('рантайм: взятый слот ложится на диск до ответа, перезапуск его не повторяет', () => {
  const made = makeRunner({ execute: () => new Promise(() => {}) })
  made.runner.add(hourly())
  made.runner.start()
  made.clock.advance(60 * MINUTE)
  made.clock.fire()
  // Так выглядит диск у процесса, убитого внутри исполнения.
  const disk = storeMod.createScheduleStore({ dir: made.dir }).list()[0]
  assert.equal(disk.lastRunAt, T('2026-04-01T05:00:00.000Z'),
    `слот взят, но на диске lastRunAt ${disk.lastRunAt}: перезапуск догонит его снова`)
  assert.ok(disk.nextRunAt > made.clock.now(), `на диске следующий запуск ${new Date(disk.nextRunAt).toISOString()} — в прошлом`)
  const seen = []
  const reopened = makeRunner({ dir: made.dir, at: made.clock.now() + MINUTE, execute: (rec, at) => { seen.push(at); return { ok: true } } })
  reopened.runner.start()
  reopened.clock.advance(6 * HOUR)
  reopened.clock.fire()
  return reopened.runner.drain().then(() => {
    assert.deepEqual(seen, [T('2026-04-01T06:00:00.000Z')],
      `после перезапуска исполнены слоты ${seen.map(one => new Date(one).toISOString())} — взятый до убийства процесса слот повторился`)
    assert.equal(historyOf(reopened.store, 'sch_1').filter(entry => entry.scheduledAt === T('2026-04-01T05:00:00.000Z')).length, 1,
      'журнал одного слота разросся до двух записей')
  })
})

check('рантайм: ручной запуск до срока получает настоящее время, а не будущий слот', () => {
  const seen = []
  const made = makeRunner({ execute: (rec, scheduledAt) => { seen.push(scheduledAt); return { ok: true } } })
  made.runner.add(hourly())
  made.runner.start()
  made.clock.advance(MINUTE) // 04:01: ближайший слот только в 05:00
  return made.runner.runNow('sch_1').then(() => {
    assert.deepEqual(seen, [made.clock.now()],
      `исполнителю отдан слот ${new Date(seen[0]).toISOString()} вместо «сейчас»`)
    assert.equal(historyOf(made.store, 'sch_1')[0].scheduledAt, made.clock.now(),
      'в истории ручной запуск задан будущим слотом')
    assert.equal(viewOf(made.runner, 'sch_1').nextRunAt, T('2026-04-01T05:00:00.000Z'), 'ручной запуск сдвинул сетку')
  })
})

check('хранилище: старт на сотне записей делает одну запись файла, а не сто', () => {
  const dir = tmpDir()
  const seed = storeMod.createScheduleStore({ dir })
  const many = Array.from({ length: 100 }, (_, i) => record({ id: `sch_${i}`, kind: 'interval', interval: { everyMinutes: 60, from: T('2026-04-01T04:00:00.000Z') } }))
  seed.save(many)
  const clock = fakeClock(T('2026-04-01T04:00:00.000Z'))
  const inner = storeMod.createScheduleStore({ dir, now: clock.now })
  let writes = 0
  const counting = Object.assign(Object.create(null), inner, {
    save: list => { writes++; return inner.save(list) },
    upsert: item => { writes++; return inner.upsert(item) }
  })
  const runner = runnerMod.createScheduleRunner({
    store: counting, model, now: clock.now, setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout, publish: () => {}, execute: () => ({ ok: true })
  })
  const started = Date.now()
  runner.start()
  assert.equal(writes, 1, `start() сделал ${writes} обращений к диску на 100 записях: на медленном диске это секунды до готовности приложения`)
  assert.ok(Date.now() - started < 500, `start() на 100 записях занял ${Date.now() - started} мс`)
  assert.deepEqual(views(runner).length, 100, 'start() поднял не все расписания')
})

check('рантайм: журнал, который хранилище не приняло, виден в снимке', () => {
  const clock = fakeClock(T('2026-04-01T04:00:00.000Z'))
  const inner = storeMod.createScheduleStore({ dir: tmpDir(), now: clock.now })
  inner.upsert(hourly())
  const deaf = Object.assign(Object.create(null), inner, { appendHistory: () => false })
  const runner = runnerMod.createScheduleRunner({
    store: deaf, model, now: clock.now, setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout, publish: () => {}, execute: () => ({ ok: true })
  })
  runner.start()
  clock.advance(60 * MINUTE)
  clock.fire()
  return runner.drain().then(() => {
    assert.match(String(runner.snapshot().storeError), /журнал|запис/,
      `хранилище отказало вести журнал, а снимок молчит: ${JSON.stringify(runner.snapshot().storeError)}`)
  })
})

check('хранилище: имя расписания проходит зачистку и не доезжает до окна открытым', () => {
  const secret = 'sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14'
  const dir = tmpDir()
  const store = storeMod.createScheduleStore({ dir, redact: text => String(text).split(secret).join('***') })
  const clock = fakeClock(T('2026-04-01T04:00:00.000Z'))
  const runner = runnerMod.createScheduleRunner({
    store, model, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    publish: () => {}, execute: () => ({ ok: true })
  })
  runner.add(record({ name: `проверка ${secret}` }))
  const view = viewOf(runner, 'sch_1')
  assert.ok(!JSON.stringify([view, runner.snapshot()]).includes(secret), 'имя записи протекло в снимок')
  assert.ok(!fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8').includes(secret), 'имя записи легло на диск открытым')
  assert.match(String(view.name), /проверка \*\*\*/, 'зачистка съела имя целиком: ' + view.name)
})

check('рантайм: record и runningOf отдают содержимое только по адресу', () => {
  // Эти два метода — единственная дверь к полному тексту записи, и она для
  // главного процесса: канал текста просьбы и слово о следующем запуске.
  const made = makeRunner({ execute: () => new Promise(() => {}) })
  made.runner.add(hourly())
  made.runner.start()
  const full = made.runner.record('sch_1')
  assert.equal(full && full.action && full.action.text, 'заметка', 'record не вернул полный текст записи')
  assert.equal(JSON.stringify(made.runner.snapshot()).includes('заметка'), false, 'содержание протекло в снимок')
  assert.equal(made.runner.runningOf('sch_1'), null, 'хода нет, а runId нашёлся')
  made.clock.advance(61 * MINUTE)
  made.clock.fire()
  assert.match(String(made.runner.runningOf('sch_1')), /^sch_1-\d+/, 'идущий ход без runId: окно не сопоставит итог с нажатием')
  assert.ok(Number.isFinite(made.runner.record('sch_1').nextRunAt), 'record потерял срок')
})

runQueue().then(() => {
  cleanup()
  console.log(`Проверок: ${checks}, отказов: ${failed}`)
  console.log(JSON.stringify({ ok: failed === 0 && !loadErrors.length, checks, failed }))
  process.exitCode = failed || loadErrors.length ? 1 : 0
})
