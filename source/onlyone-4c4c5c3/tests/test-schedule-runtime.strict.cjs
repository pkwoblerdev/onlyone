'use strict'
// Рантайм планировщика расписаний (этап 3.5, часть 2): что лежит на диске,
// пробуждение, исполнение, отмена, идемпотентность.
//
// ТЕСТЫ ДО КОДА: `src/main/schedule-store.js` и `src/main/schedule-runner.js`
// ещё не написаны, набор обязан быть КРАСНЫМ и говорить почему. `require`
// обёрнут в try: без итоговых двух строк прогон неотличим от отсутствия прогона,
// а «модуля нет» должно считаться отказом КАЖДОЙ проверки, а не молча съесть набор.
//
// Контракт: audits/qoder-2-2026-09-26/schedule-contract.md, часть 2. Чистое ядро
// (`schedule-model.js`) закрыто раньше и 57 проверками; здесь оно подключается
// как ЗАВИСИМОСТЬ `model` — ровно так, как его передаст главный процесс.
//
// Ни Electron, ни сети, ни живых ключей. Часы и таймеры только внедрённые:
// `now`/`setTimeout`/`clearTimeout` приходят параметрами, реальных ожиданий в
// наборе нет ни одного: тик — это вызов подставного таймера, который я сам и
// исполняю. `Date.now()` в файле не встречается вовсе. Значения вида
// `sk-QoderTest-…` выдуманы.
//
// Временные каталоги — только свои (`onlyone-schedule-…` в os.tmpdir()),
// удаляются в finally.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let storeModule = null
let storeLoadError = null
try {
  storeModule = require('../src/main/schedule-store')
} catch (error) {
  // Первая строка: `Cannot find module ...` — без простыни require stack ×25.
  storeLoadError = String(error.message).split('\n')[0]
}

let runnerModule = null
let runnerLoadError = null
try {
  runnerModule = require('../src/main/schedule-runner')
} catch (error) {
  runnerLoadError = String(error.message).split('\n')[0]
}

// Ядро здесь зависимое, а не подставное: рантаймер обязан исполнять ту же
// математику часов, что уже измерена и закрыта.
let model = null
let modelLoadError = null
try {
  model = require('../src/main/schedule-model')
} catch (error) {
  modelLoadError = String(error.message).split('\n')[0]
}

let checks = 0
let failed = 0
function check(name, fn) {
  checks++
  const missing = []
  if (!storeModule) missing.push(`src/main/schedule-store.js (${storeLoadError})`)
  if (!runnerModule) missing.push(`src/main/schedule-runner.js (${runnerLoadError})`)
  if (!model) missing.push(`src/main/schedule-model.js (${modelLoadError})`)
  if (missing.length) {
    failed++
    console.error(`ПРОВАЛ [${name}]: нет модуля: ${missing.join('; ')} — тесты написаны до кода, набор красный`)
    return
  }
  try {
    fn()
    console.log('ok', name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${String(error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 400)}`)
  }
}

// Отсутствие экспорта = отказ, а не `TypeError: not a function` в середине стека.
function exportOf(module_, name, file) {
  const fn = module_ && module_[name]
  if (typeof fn !== 'function') throw new Error(`${file} не экспортирует функцию ${name}`)
  return fn
}
const createStore = options => exportOf(storeModule, 'createScheduleStore', 'src/main/schedule-store.js')(options)
const createRunner = options => exportOf(runnerModule, 'createScheduleRunner', 'src/main/schedule-runner.js')(options)

// ---------------------------------------------------------------------------
// Вспомогательное: времена, записи, часы, хранилище-двойник, временные папки
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MAX_HISTORY = 20
const T = text => Date.parse(text)
const iso = ms => (typeof ms === 'number' ? new Date(ms).toISOString().replace('.000Z', 'Z') : String(ms))
function show(value) {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > 240 ? `${text.slice(0, 240)}…` : text
  } catch {
    return String(value)
  }
}
const shown = value => (typeof value === 'number' && Number.isFinite(value) ? iso(value) : show(value))

// Точки отсчёта выдуманы и зафиксированы: «сегодня» из часов машины нигде не
// участвует. Стены сняты с уже закрытого ядра: 01.05 и 01.04 в Берлине — GMT+2.
const T0 = T('2026-05-01T00:00:00.000Z') // сеть интервалов: шаг 60 минут отсюда
const APR_01 = T('2026-04-01T00:00:00.000Z') // Берлин: 02:00 того же дня
const DAILY_AT_T0 = T('2026-05-01T05:30:00.000Z') // 07:30 по Берлину 1 мая
const DAILY_TODAY = T('2026-04-01T05:30:00.000Z') // 07:30 по Берлину 1 апреля
const DAILY_TOMORROW = T('2026-04-02T05:30:00.000Z')
const STALE = T('2026-01-01T00:00:00.000Z')

const SECRET = 'sk-QoderTest-9f8e7d6c4b3a'
const SECRET_MASK = /sk-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9]{6,}|Bearer\s+[A-Za-z0-9_-]{6,}/g

const record = (over = {}) => ({
  id: 'sch_morning',
  name: 'Утренний разбор',
  enabled: true,
  timeZone: 'Europe/Berlin',
  kind: 'daily',
  daily: { time: '07:30' },
  action: { type: 'agent-turn', prompt: 'разобрать ночные находки', chatId: 'chat-1' },
  misfire: 'skip',
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
  history: [],
  ...over
})
const dailyRec = (over = {}) => record({ id: 'sch_daily', kind: 'daily', daily: { time: '07:30' }, ...over })
const everyRec = (over = {}) => record({ id: 'sch_every', kind: 'interval', interval: { everyMinutes: 60, from: T0 }, ...over })

// Маска для хранилища-двойника своя, независимая от реализации: двойник обязан
// показать, дошёл ли секрет до окна.
const maskSecrets = text => (typeof text === 'string' ? text.replace(SECRET_MASK, '***') : text)
const sealEntry = entry => (!entry || typeof entry !== 'object' ? entry : { ...entry, error: maskSecrets(entry.error) })
const sealRecord = item => (!item || typeof item !== 'object'
  ? item
  : { ...item, lastError: maskSecrets(item.lastError), history: Array.isArray(item.history) ? item.history.map(sealEntry) : item.history })
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify({ value })).value)

// Хранилище-двойник ровно по контракту (`load/save/upsert/remove/appendHistory/list`),
// без диска — так проверки рантаймера остаются адресными. Порядок истории —
// новые в начале, обрезка до MAX_HISTORY (то же правило закреплено ниже и для
// настоящего хранилища).
function makeFakeStore(initialRecords = []) {
  let list = (Array.isArray(initialRecords) ? initialRecords : []).map(item => sealRecord(clone(item)))
  const api = {
    writes: 0,
    load() { return { records: clone(list), corrupt: false } },
    list() { return clone(list) },
    save(next) {
      if (!Array.isArray(next)) throw new TypeError('save(list): ждался массив записей')
      list = next.map(item => sealRecord(clone(item)))
      api.writes++
      return true
    },
    upsert(item) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new TypeError('upsert: у записи нет строкового id')
      const clean = sealRecord(clone(item))
      const at = list.findIndex(existing => existing && existing.id === clean.id)
      if (at >= 0) list[at] = clean
      else list.push(clean)
      api.writes++
      return clone(clean)
    },
    remove(id) {
      const before = list.length
      list = list.filter(existing => !(existing && existing.id === id))
      api.writes++
      return list.length !== before
    },
    appendHistory(id, entry) {
      const existing = list.find(item => item && item.id === id)
      if (!existing) return false
      const history = (Array.isArray(existing.history) ? existing.history : []).concat()
      history.unshift(sealEntry(clone(entry)))
      existing.history = history.slice(0, MAX_HISTORY)
      api.writes++
      return true
    }
  }
  return api
}

// Подставные часы. Прыжок во времени исполняет только Те таймеры, что на момент
// прыжка уже наступили, и не трогает перевооружённые после — так же, как делает
// настоящая система после сна. Повторный тик по тому же слоту — `replay(handle)`:
// это и моделируемая двойная доставка/гонка.
function makeClock(startMs) {
  let nowMs = startMs
  let seq = 0
  const armed = new Map()
  const log = []

  function setTimeout_(fn, ms) {
    if (typeof fn !== 'function') throw new TypeError('setTimeout: колбэк обязан быть функцией')
    const delay = Math.max(0, Number(ms) || 0)
    const handle = {
      id: ++seq, at: nowMs + delay, delay, fn, fired: 0,
      unref() { return handle }, ref() { return handle }, refresh() { return handle },
      hasRef() { return armed.has(handle.id) }
    }
    armed.set(handle.id, handle)
    return handle
  }
  function clearTimeout_(handle) {
    const key = handle && typeof handle === 'object' ? handle.id : handle
    if (typeof key === 'number') armed.delete(key)
  }
  const due = () => [...armed.values()].filter(handle => handle.at <= nowMs).sort((a, b) => a.at - b.at || a.id - b.id)
  function runOne(handle) {
    armed.delete(handle.id)
    handle.fired++
    log.push(handle)
    handle.fn()
  }
  function fireDue(limit = 64) {
    let guard = 0
    for (;;) {
      const ready = due()
      if (!ready.length) return guard
      if (++guard > limit) throw new Error(`таймеры перевооружаются и не гаснут за ${limit} прогонов — планировщик крутится вхолостую`)
      runOne(ready[0])
    }
  }
  return {
    now: () => nowMs,
    setTimeout: setTimeout_,
    clearTimeout: clearTimeout_,
    set(ms) { nowMs = ms },
    advance(ms) { nowMs += ms; return fireDue() },
    advanceTo(ms) { nowMs = ms; return fireDue() },
    fireDue,
    pending: () => [...armed.values()],
    pendingCount: () => armed.size,
    firedLog: () => log.slice(),
    replay(handle) {
      const found = log.find(one => one === handle)
      if (!found) throw new Error('replay: исполненного таймера с такой ручкой нет — набор неверно моделирует повторный тик')
      found.fired++
      log.push(found)
      found.fn()
      return found
    }
  }
}

const tmpDirs = []
function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `onlyone-schedule-${label}-`))
  tmpDirs.push(dir)
  return dir
}
function filesIn(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}
const storeFileOf = dir => path.join(dir, 'schedules.json')
function readStoreFile(dir) {
  const target = storeFileOf(dir)
  if (!fs.existsSync(target)) throw new Error(`контракт именует файл <dir>/schedules.json, а в каталоге лежит ${show(filesIn(dir))}`)
  return fs.readFileSync(target, 'utf8')
}
const TEMP_LIKE = /\.tmp|~$|\.part$|\.new$|^schedules\.json\./i

// snapshot() и publish() могут быть отданы и списком, и объектом — набор читает
// и то и другое, но требует, чтобы расписания были перечислимы и подписаны id.
function viewList(snapshot) {
  if (Array.isArray(snapshot)) return snapshot
  if (snapshot && typeof snapshot === 'object') {
    for (const key of ['records', 'items', 'list', 'schedules', 'views', 'entries', 'all'])
      if (Array.isArray(snapshot[key])) return snapshot[key]
    const values = Object.values(snapshot)
    if (values.length && values.every(value => value && typeof value === 'object' && !Array.isArray(value) &&
      ('id' in value || 'scheduleId' in value || 'nextRunAt' in value))) return values
  }
  throw new Error(`snapshot() вернул неперечислимое: ${show(snapshot)}`)
}
const idOf = view => String((view && (view.id || view.scheduleId || view.key)) || '')
function viewOf(snapshot, id) {
  return viewList(snapshot).find(view => idOf(view) === String(id)) || null
}
function manualMarked(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.manual === true || entry.manual === 'true') return true
  const mark = [entry.trigger, entry.source, entry.reason, entry.via, entry.by, entry.kind, entry.type]
    .filter(value => typeof value === 'string').join(' ').toLowerCase()
  return /manual|run-?now|ручной|вруч|human|user/.test(mark)
}
function historyOf(store, id) {
  const item = store.list().find(existing => existing && existing.id === id)
  return (item && Array.isArray(item.history) ? item.history : []).filter(entry => entry && typeof entry === 'object')
}

// ---------------------------------------------------------------------------
// 1..7. src/main/schedule-store.js — что лежит на диске
// ---------------------------------------------------------------------------

function storeSuite() {
  check('хранилище: пустой и несуществующий каталог дают пустой список и corrupt:false', () => {
    const empty = createStore({ dir: tmpDir('empty') })
    const loaded = empty.load()
    assert.ok(loaded && typeof loaded === 'object', `load() вернул ${show(loaded)}, а ждалось { records, corrupt }`)
    assert.equal(loaded.corrupt, false, `пустой каталог объявлен битым (corrupt=${show(loaded.corrupt)})`)
    assert.ok(Array.isArray(loaded.records), `load().records не массив (${show(loaded.records)})`)
    assert.deepEqual(loaded.records, [], `в пустом каталоге нашлись записи: ${show(loaded.records)}`)
    assert.deepEqual(empty.list(), [], `list() в пустом каталоге не пуст (${show(empty.list())})`)

    // Первый запуск приложения: папки нет вовсе — это не «битый файл».
    const absent = path.join(tmpDir('absent-parent'), 'вложенная', 'папки-нет')
    const fresh = createStore({ dir: absent })
    const freshLoaded = fresh.load()
    assert.equal(freshLoaded.corrupt, false, `несуществующий каталог объявлен битым: ${show(freshLoaded)}`)
    assert.deepEqual(freshLoaded.records, [], `несуществующий каталог вернул записи: ${show(freshLoaded.records)}`)
    assert.doesNotThrow(() => fresh.save([dailyRec()]), 'первая запись в несуществующую папку бросает')
    assert.equal(createStore({ dir: absent }).load().records.length, 1, 'первая запись не дошла до диска')
  })

  check('хранилище: сохранённый список перечитывается байт-в-байт после перезапуска', () => {
    const dir = tmpDir('reload')
    const saved = [
      dailyRec({ id: 'sch_morning', name: 'Утренний разбор', nextRunAt: DAILY_TODAY, lastRunAt: DAILY_TODAY - DAY, lastError: 'прошлый запуск не дошёл' }),
      everyRec({ id: 'sch_night', name: 'Ночная сверка — ё и «кавычки»', misfire: 'run-once', nextRunAt: T0 + HOUR, history: [
        { at: T0, ok: true, runId: 'run-первый' },
        { at: T0 - MINUTE, ok: false, error: 'нет ответа от модели' }
      ] }),
      record({ id: 'sch_cmd', kind: 'daily', daily: { time: '08:00' }, action: { type: 'command', command: 'npm test' }, enabled: false })
    ]
    createStore({ dir }).save(saved)
    assert.ok(fs.existsSync(storeFileOf(dir)), 'запись осталась только в памяти: файла на диске нет')
    assert.match(readStoreFile(dir), /sch_night/, 'файл не содержит того, что в него положили')

    const reopened = createStore({ dir }).load()
    assert.equal(reopened.corrupt, false, `целый файл объявлен битым: ${show(reopened)}`)
    assert.deepEqual(reopened.records, saved, 'после перезапуска список отличается от сохранённого')
    assert.deepEqual(createStore({ dir }).list(), saved, 'list() после перезапуска отличается от сохранённого')
    // Пересохранение прочитанного ничего не «улучшает» по пути.
    createStore({ dir }).save(reopened.records)
    assert.deepEqual(createStore({ dir }).load().records, saved, 'пересохранение прочитанного изменило данные')
  })

  check('хранилище: битый JSON — corrupt:true, список пуст, файл не затёрт молча', () => {
    const dir = tmpDir('corrupt')
    const broken = '{"schemaVersion":1,"records":[{"id":"sch_good","name":"Целая запись","kind":"daily"'
    fs.writeFileSync(storeFileOf(dir), broken, 'utf8')
    const loaded = createStore({ dir }).load()
    assert.equal(loaded.corrupt, true, `нераспарсившийся файл отдан как целый: ${show(loaded)}`)
    assert.ok(Array.isArray(loaded.records), `records не массив (${show(loaded.records)})`)
    assert.deepEqual(loaded.records, [], `битый файл вернул непустой список: ${show(loaded.records)}`)
    assert.equal(fs.readFileSync(storeFileOf(dir), 'utf8'), broken, 'load() перезаписал битый файл — человек не увидит правду')

    // Нечитаемое «имя» (каталог вместо файла) — та же история: правда, а не пустота.
    const blocked = tmpDir('corrupt-blocked')
    fs.mkdirSync(storeFileOf(blocked))
    const blockedLoaded = createStore({ dir: blocked }).load()
    assert.equal(blockedLoaded.corrupt, true, `нечитаемый файл отдан как пустой и целый: ${show(blockedLoaded)}`)
    assert.deepEqual(blockedLoaded.records, [], `из нечитаемого файла что-то достали: ${show(blockedLoaded.records)}`)
  })

  check('хранилище: последующая запись не теряет то, что удалось разобрать из битого файла', () => {
    const dir = tmpDir('corrupt-save')
    fs.writeFileSync(storeFileOf(dir), '{"records":[{"id":"sch_good","name":"Целая запись",', 'utf8')
    const st = createStore({ dir })
    assert.equal(st.load().corrupt, true, 'битый файл не назван битым')
    st.save([dailyRec({ id: 'sch_new' })])
    // Механизм свободный (архив битого по образцу Н37 или сохранение разобранного),
    // факт один: то, что было в битом файле, с диска не исчезло.
    const survivors = filesIn(dir).filter(name => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8').includes('sch_good')
      } catch {
        return false
      }
    })
    assert.ok(survivors.length, `после save на диске не осталось и следа от битого файла (каталог: ${show(filesIn(dir))})`)
    assert.deepEqual(st.list().map(item => item && item.id), ['sch_new'], 'новая запись не леглась')
  })

  check('хранилище: запись атомарная — после save в каталоге нет временных остатков', () => {
    const dir = tmpDir('atomic')
    const st = createStore({ dir })
    for (let i = 0; i < 5; i++) st.save([dailyRec({ id: `sch_${i}` }), everyRec({ id: 'sch_every' })])
    st.upsert(dailyRec({ id: 'sch_extra' }))
    st.appendHistory('sch_every', { at: T0, ok: true, runId: 'run-1' })
    const leftovers = filesIn(dir).filter(name => name !== 'schedules.json' && TEMP_LIKE.test(name))
    assert.deepEqual(leftovers, [], `рядом с schedules.json остались временные файлы: ${show(leftovers)}`)
  })

  check('хранилище: отказ переименования или записи не затирает прежний файл', () => {
    const base = [dailyRec({ id: 'sch_old', name: 'Прежняя версия' })]
    const next = [dailyRec({ id: 'sch_old', name: 'Новая версия' }), everyRec({ id: 'sch_added' })]
    const broken = new Error('подставленный отказ диска')
    const seams = {
      rename: boom => ({ rename: (from, to) => (boom() || fs.renameSync(from, to)) }),
      writeFile: boom => ({ writeFile: (file, data) => (boom() || fs.writeFileSync(file, data)) }),
      fs: boom => ({ fs: { ...fs, renameSync: (from, to) => (boom() || fs.renameSync(from, to)), writeFileSync: (file, data) => (boom() || fs.writeFileSync(file, data)) } })
    }
    const attempts = []
    for (const [label, seamOf] of Object.entries(seams)) {
      const dir = tmpDir(`seam-${label}`)
      let failure = null
      let after = null
      let retry = null
      try {
        let armed = false
        const boom = () => { if (armed) throw broken }
        const st = createStore({ dir, ...seamOf(boom) })
        st.save(base)
        armed = true
        try {
          st.save(next)
        } catch (error) {
          failure = error === broken ? 'отказ диска выпущен наружу' : `другая ошибка: ${error.message}`
        }
        after = createStore({ dir }).list()
        // Тот же каталог после успеха: остаток от неудавшейся попытки не должен
        // множиться (образец `writeAtomic` в контрольных точках — имя временного
        // файла детерминировано процессом, поэтому повторная запись его накрывает).
        createStore({ dir }).save(next)
        retry = filesIn(dir).filter(name => TEMP_LIKE.test(name))
      } catch (error) {
        if (error !== broken) failure = `хранилище бросило не тем отказом: ${error.message}`
      }
      attempts.push({ label, failure, after, leftovers: retry })
    }
    const ignored = attempts.filter(attempt => show(attempt.after) === show(next))
    assert.notEqual(ignored.length, Object.keys(seams).length,
      `ни один шов отказа диску (${Object.keys(seams).join(', ')}) не повлиял на запись: атомарность нечем проверить — каждая попытка отдала новый список ${show(next)}`)
    for (const attempt of attempts.filter(one => show(one.after) !== show(next))) {
      assert.equal(show(attempt.after), show(base), `${attempt.label}: отказ записи не отдал прежний список — ${show(attempt.after)}`)
      assert.deepEqual(attempt.leftovers, [], `${attempt.label}: после неудачной попытки следующий успешный save оставил временные файлы ${show(attempt.leftovers)}`)
    }
  })

  check('хранилище: appendHistory держит 20 записей, новые в начале, выпадают самые старые', () => {
    const dir = tmpDir('history')
    const st = createStore({ dir })
    st.save([everyRec({ id: 'sch_hist' })])
    for (let i = 1; i <= 25; i++) st.appendHistory('sch_hist', { at: T0 + i * MINUTE, ok: i % 2 === 0, runId: `run-${i}` })
    const stored = createStore({ dir }).list().find(item => item.id === 'sch_hist')
    const history = stored && stored.history
    assert.ok(Array.isArray(history), `history не массив: ${show(history)}`)
    assert.equal(history.length, MAX_HISTORY, `история выросла до ${history.length} — предела ${MAX_HISTORY} нет`)
    assert.equal(history[0].runId, 'run-25', `в начале лежит ${show(history[0])}, а не самый новый run-25`)
    assert.equal(history[history.length - 1].runId, 'run-6', `с конца выпало не самое старое: ${show(history[history.length - 1])}`)
    assert.deepEqual(history.map(entry => entry.runId), Array.from({ length: MAX_HISTORY }, (_, i) => `run-${25 - i}`),
      `порядок или набор выпавших не те: ${show(history.map(entry => entry.runId))}`)
    const raw = readStoreFile(dir)
    assert.match(raw, /run-25/, 'история не дошла до диска')
    assert.equal(/"run-[1-5]"/.test(raw), false, 'самые старые записи остались в файле')
  })

  check('хранилище: текст ошибки проходит через переданный redact — ни в файле, ни в list() секрета нет', () => {
    const dir = tmpDir('redact')
    let redactedCalls = 0
    const st = createStore({
      dir,
      redact: text => { redactedCalls++; return typeof text === 'string' ? text.replace(SECRET_MASK, '***') : text }
    })
    st.save([dailyRec({ id: 'sch_leak', lastError: `401 Unauthorized: ${SECRET}` })])
    st.appendHistory('sch_leak', { at: T0, ok: false, error: `запрос отклонён, ключ ${SECRET} не принят` })
    assert.ok(redactedCalls > 0, `redact не вызывался ни разу (${redactedCalls})`)
    const raw = readStoreFile(dir)
    assert.equal(raw.includes(SECRET), false, 'значение, похожее на ключ, легло в файл открытым текстом')
    const listed = st.list().find(item => item.id === 'sch_leak')
    assert.equal(JSON.stringify(listed).includes(SECRET), false, 'секрет вернулся из list()')
    // Вычищается ключ, а не сообщение целиком: человеку нужно что-то читать.
    assert.match(String(listed.lastError), /401/, `lastError перестал быть читаемым: ${show(listed.lastError)}`)
    assert.match(String(listed.history[0].error), /запрос отклонён/, `история ошибки перестала быть читаемой: ${show(listed.history[0])}`)
  })

  check('хранилище: upsert по существующему id правит запись, remove чужого id не бросает', () => {
    const dir = tmpDir('upsert')
    const st = createStore({ dir })
    st.save([dailyRec({ id: 'sch_a', name: 'первая редакция' }), everyRec({ id: 'sch_b' })])
    st.upsert(dailyRec({ id: 'sch_a', name: 'вторая редакция', nextRunAt: DAILY_TODAY }))
    const after = st.list()
    assert.deepEqual(after.map(item => item && item.id).sort(), ['sch_a', 'sch_b'], `upsert породил дубль: ${show(after.map(item => item && item.id))}`)
    assert.equal(after.find(item => item.id === 'sch_a').name, 'вторая редакция', 'upsert не заменил поля записи')
    assert.deepEqual(createStore({ dir }).list().map(item => item && item.id).sort(), ['sch_a', 'sch_b'], 'после перезапуска набор id изменился')

    assert.doesNotThrow(() => st.remove('sch-нет-такого'), 'remove несуществующего id бросает')
    assert.equal(st.remove('sch-нет-такого'), false, 'remove несуществующего id притворился удалением')
    assert.equal(st.remove('sch_b'), true, 'remove существующего id не сообщил об успехе')
    assert.deepEqual(st.list().map(item => item && item.id), ['sch_a'], 'remove не убрал запись')
    assert.deepEqual(createStore({ dir }).list().map(item => item && item.id), ['sch_a'], 'удаление не дошло до диска')
  })
}

// ---------------------------------------------------------------------------
// 8..18. src/main/schedule-runner.js — пробуждение и исполнение
// ---------------------------------------------------------------------------

function makeHarness({ store = null, nowMs = T0, execute = null, intervalMs = 30 * 1000, publish = null, start = true } = {}) {
  const clock = makeClock(nowMs)
  const st = store || makeFakeStore()
  const calls = []
  const published = []
  const outcome = execute || (() => ({ ok: true }))
  const instance = createRunner({
    store: st,
    model,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    intervalMs,
    execute: (item, scheduledAt, ...rest) => {
      try {
        const result = outcome(item, scheduledAt, ...rest)
        calls.push({ item, scheduledAt, result })
        return result
      } catch (error) {
        // Падающий execute тоже остаётся в списке: «не умер» — это не «не вызван».
        calls.push({ item, scheduledAt, threw: error })
        throw error
      }
    },
    publish: publish || (event => { published.push(event) })
  })
  if (!instance || typeof instance !== 'object') throw new Error(`createScheduleRunner вернул ${show(instance)}`)
  for (const method of ['start', 'stop', 'runNow', 'pause', 'resume', 'remove', 'snapshot'])
    if (typeof instance[method] !== 'function') throw new Error(`планировщик не отдаёт метод ${method}()`)
  if (start) instance.start()
  return { runner: instance, clock, store: st, calls, published }
}

function runnerSuite() {
  check('рантаймер: start() поднимает записи из хранилища и выставляет nextRunAt от «сейчас»', () => {
    const harness = makeHarness({
      nowMs: T0,
      store: makeFakeStore([
        dailyRec({ id: 'sch_daily', nextRunAt: STALE, lastRunAt: STALE }),
        everyRec({ id: 'sch_every', nextRunAt: STALE, lastRunAt: STALE })
      ])
    })
    const snapshot = harness.runner.snapshot()
    assert.deepEqual(viewList(snapshot).map(idOf).sort(), ['sch_daily', 'sch_every'], `start() не поднял записи: ${show(viewList(snapshot).map(idOf))}`)
    assert.equal(viewOf(snapshot, 'sch_daily').nextRunAt, DAILY_AT_T0,
      `daily со stored nextRunAt в прошлом не пересчитан от «сейчас»: ${shown(viewOf(snapshot, 'sch_daily').nextRunAt)} вместо ${iso(DAILY_AT_T0)}`)
    assert.equal(viewOf(snapshot, 'sch_every').nextRunAt, T0 + HOUR,
      `interval не пересчитан от «сейчас»: ${shown(viewOf(snapshot, 'sch_every').nextRunAt)} вместо ${iso(T0 + HOUR)}`)
    for (const id of ['sch_daily', 'sch_every']) {
      const stored = harness.store.list().find(item => item.id === id)
      assert.ok(stored.nextRunAt > harness.clock.now(), `${id}: в хранилище остался следующий запуск в прошлом (${shown(stored.nextRunAt)})`)
    }
  })

  check('рантаймер: тик по наступившему расписанию даёт ровно один вызов execute, повтор тика — ни одного', () => {
    const harness = makeHarness({ nowMs: T0, store: makeFakeStore([everyRec({ id: 'sch_every' })]) })
    assert.ok(harness.clock.pendingCount() > 0, `start() не вооружил ни одного таймера: ${show(harness.runner.snapshot())}`)
    harness.clock.advanceTo(T0 + HOUR)
    assert.equal(harness.calls.length, 1, `первый тик дал ${harness.calls.length} вызовов execute вместо одного: ${show(harness.calls.map(call => shown(call.scheduledAt)))}`)
    assert.equal(harness.calls[0].scheduledAt, T0 + HOUR, `исполнен не тот слот: ${shown(harness.calls[0].scheduledAt)}`)
    const slotTimer = harness.clock.firedLog().find(handle => handle.at <= T0 + HOUR)
    assert.ok(slotTimer, 'ни один таймер не был исполнен — моделировать повторный тик нечем')
    harness.clock.replay(slotTimer)
    harness.clock.fireDue()
    assert.equal(harness.calls.length, 1, `повтор тика на том же scheduledAt добавил ход: ${show(harness.calls.map(call => shown(call.scheduledAt)))}`)
    const next = viewOf(harness.runner.snapshot(), 'sch_every').nextRunAt
    assert.ok(next > harness.clock.now(), `сетка не ушла вперёд: nextRunAt ${shown(next)} — слот повторился бы при любом лишнем тике`)
  })

  check('рантаймер: пометка «начато» ложится в историю до исполнения, исход — одной записью', () => {
    const store = makeFakeStore([everyRec({ id: 'sch_every', history: [] })])
    const seen = []
    const harness = makeHarness({
      nowMs: T0,
      store,
      execute: item => {
        seen.push(historyOf(store, item.id).length)
        return { ok: true, runId: 'run-внутри' }
      }
    })
    harness.clock.advanceTo(T0 + HOUR)
    assert.equal(seen.length, 1, `execute вызван ${seen.length} раз — проверка не состоялась`)
    assert.ok(seen[0] >= 1, 'внутри execute история пуста: запуск не записан ДО исполнения («начато» раньше «сделано»)')
    const history = historyOf(store, 'sch_every')
    assert.equal(history.length, 1, `один запуск породил ${history.length} записей истории: ${show(history)}`)
    assert.equal(history[0].ok, true, `исход лёг отдельной записью вместо той же: ${show(history[0])}`)
    assert.ok(typeof history[0].runId === 'string' && history[0].runId.length, `в истории нет runId запуска: ${show(history[0])}`)
  })

  check('рантаймер: гонка runNow(id) + тик по тому же слоту даёт один ход, а не два', () => {
    const harness = makeHarness({ nowMs: T0, store: makeFakeStore([everyRec({ id: 'sch_every' })]) })
    harness.clock.set(T0 + HOUR) // «сейчас» наступило, таймер ещё не исполнен
    harness.runner.runNow('sch_every')
    assert.equal(harness.calls.length, 1, `runNow дал ${harness.calls.length} вызовов вместо одного`)
    harness.clock.fireDue() // тот же слот приходит таймером
    harness.clock.fireDue()
    assert.equal(harness.calls.length, 1, `гонка дала ${harness.calls.length} хода: ${show(harness.calls.map(call => shown(call.scheduledAt)))}`)
    const next = viewOf(harness.runner.snapshot(), 'sch_every').nextRunAt
    assert.ok(next > harness.clock.now(), `после гонки nextRunAt ${shown(next)} не позже «сейчас» — слот будет исполнен ещё раз`)
    harness.clock.advanceTo(T0 + 2 * HOUR)
    assert.equal(harness.calls.length, 2, `после гонки сетка встала: вызовов ${harness.calls.length}`)
    assert.equal(harness.calls[1].scheduledAt, T0 + 2 * HOUR, `сетка съехала: второй ход на ${shown(harness.calls[1].scheduledAt)}`)
  })

  check('рантаймер: runNow не двигает сетку, в истории — пометка ручного запуска', () => {
    const harness = makeHarness({ nowMs: APR_01, store: makeFakeStore([dailyRec({ id: 'sch_daily' })]) })
    const { runner, clock, calls, store } = harness
    assert.equal(viewOf(runner.snapshot(), 'sch_daily').nextRunAt, DAILY_TODAY, 'сетка до ручного запуска уже не та')
    clock.set(APR_01 + 4 * HOUR) // 04:00Z: до слота 05:30Z ещё есть время
    runner.runNow('sch_daily')
    assert.equal(calls.length, 1, `runNow не исполнил расписание (вызовов ${calls.length})`)
    assert.equal(viewOf(runner.snapshot(), 'sch_daily').nextRunAt, DAILY_TODAY,
      `ручной запуск сдвинул сетку: ${shown(viewOf(runner.snapshot(), 'sch_daily').nextRunAt)} вместо ${iso(DAILY_TODAY)}`)
    const manual = historyOf(store, 'sch_daily').filter(manualMarked)
    assert.equal(manual.length, 1, `в истории нет ровно одной пометки ручного запуска (ожидается entry.trigger === 'manual' или manual:true): ${show(historyOf(store, 'sch_daily'))}`)
    clock.advanceTo(DAILY_TODAY)
    assert.equal(calls.length, 2, `ручной запуск съел плановый слот: вызовов ${calls.length}`)
    assert.equal(viewOf(runner.snapshot(), 'sch_daily').nextRunAt, DAILY_TOMORROW, 'после планового слота сетка не перешла на завтра')
  })

  check('рантаймер: pause(id) снимает таймер и не исполняет, resume(id) пересчитывает от «сейчас»', () => {
    const harness = makeHarness({ nowMs: T0, store: makeFakeStore([everyRec({ id: 'sch_every' })]) })
    const { runner, clock, calls, store } = harness
    runner.pause('sch_every')
    const paused = viewOf(runner.snapshot(), 'sch_every')
    assert.ok(paused, `pause() убрал запись из снимка: ${show(runner.snapshot())}`)
    assert.equal(paused.enabled, false, `pause() не перевёл запись в выключенное состояние: ${show(paused)}`)
    assert.ok(!paused.running, `на паузе запись осталась занятой: ${show(paused)}`)
    assert.equal(store.list().find(item => item.id === 'sch_every').enabled, false, 'pause() не дошёл до хранилища')
    clock.advanceTo(T0 + 2 * HOUR)
    assert.equal(calls.length, 0, `на паузе расписание всё равно исполнилось ${calls.length} раз(а)`)

    runner.resume('sch_every')
    const resumed = viewOf(runner.snapshot(), 'sch_every')
    assert.equal(resumed.enabled, true, `resume() не вернул запись в работу: ${show(resumed)}`)
    assert.equal(resumed.nextRunAt, T0 + 3 * HOUR,
      `resume() посчитал не от «сейчас» (${iso(clock.now())}): ${shown(resumed.nextRunAt)}, ждался слот ${iso(T0 + 3 * HOUR)}`)
    clock.fireDue()
    assert.equal(calls.length, 0, `resume() вернул пропущенный слот вместо пересчёта: ${show(calls.map(call => shown(call.scheduledAt)))}`)
    clock.advanceTo(T0 + 3 * HOUR)
    assert.equal(calls.length, 1, `после resume() расписание не пошло по сетке (вызовов ${calls.length})`)
  })

  check('рантаймер: stop() вызывает clearTimeout для всех поставленных таймеров', () => {
    const harness = makeHarness({
      nowMs: T0,
      store: makeFakeStore([
        everyRec({ id: 'sch_a' }),
        everyRec({ id: 'sch_b', interval: { everyMinutes: 15, from: T0 } }),
        dailyRec({ id: 'sch_c' })
      ])
    })
    const armed = harness.clock.pending()
    assert.ok(armed.length >= 1, `после start() вооружено ${armed.length} таймеров — планировщик ничего не ждёт`)
    harness.runner.stop()
    assert.equal(harness.clock.pendingCount(), 0,
      `stop() оставил висеть ${harness.clock.pendingCount()} таймер(ов): ${show(harness.clock.pending().map(handle => ({ at: shown(handle.at), delay: handle.delay })))}`)
    const fired = harness.clock.firedLog().length
    harness.clock.advanceTo(T0 + 7 * DAY)
    assert.equal(harness.clock.firedLog().length, fired, 'после stop() таймеры всё равно исполняются')
    assert.equal(harness.clock.pendingCount(), 0, 'после stop() планировщик вооружил новые таймеры')
    assert.equal(harness.calls.length, 0, `после stop() что-то исполнилось: ${show(harness.calls.map(call => call.item && call.item.id))}`)
  })

  check('рантаймер: падение execute не убивает планировщик — lastError, пересчёт и второе расписание в том же тике', () => {
    const store = makeFakeStore([everyRec({ id: 'sch_bad' }), everyRec({ id: 'sch_good' })])
    const harness = makeHarness({
      nowMs: T0,
      store,
      execute: item => {
        if (item.id === 'sch_bad') throw new Error('агент не ответил')
        return { ok: true }
      }
    })
    const { runner, clock, calls } = harness
    assert.doesNotThrow(() => clock.advanceTo(T0 + HOUR), 'тик с падающим execute уронил планировщик наружу')
    const bad = viewOf(runner.snapshot(), 'sch_bad')
    assert.ok(calls.some(call => call.item.id === 'sch_good'), `в тике с падением второе расписание не исполнилось: ${show(calls.map(call => call.item && call.item.id))}`)
    assert.ok(String(bad.lastError || '').length > 3, `падение не записано в lastError: ${show(bad)}`)
    assert.equal(bad.nextRunAt, T0 + 2 * HOUR, `после падения следующий запуск не пересчитан на ${iso(T0 + 2 * HOUR)}: ${shown(bad.nextRunAt)}`)
    assert.ok(historyOf(store, 'sch_bad').some(entry => entry.ok === false), `в истории нет отказа: ${show(historyOf(store, 'sch_bad'))}`)
    assert.equal(calls.filter(call => call.item.id === 'sch_good').length, 1, 'второе расписание исполнилось дважды в одном тике')
    assert.doesNotThrow(() => clock.advanceTo(T0 + 2 * HOUR), 'после падения сетка встала')
    assert.equal(calls.filter(call => call.item.id === 'sch_bad').length, 2, `упавший ход не вернулся по сетке вторым слотом: ${calls.filter(call => call.item.id === 'sch_bad').length}`)
  })

  check('рантаймер: misfire run-once после сна догоняет ровно один запуск и возвращается на сетку', () => {
    const harness = makeHarness({
      nowMs: T0 + 5 * HOUR + 30 * MINUTE, // «проснулись» через пять с половиной часов
      store: makeFakeStore([everyRec({ id: 'sch_every', misfire: 'run-once', lastRunAt: T0, nextRunAt: T0 + HOUR })])
    })
    harness.clock.fireDue()
    assert.equal(harness.calls.length, 1, `run-once после сна дал ${harness.calls.length} вызовов вместо одного догона — запрещённая очередь`)
    assert.equal(harness.calls[0].scheduledAt, T0 + 5 * HOUR, `догнан не последний пропущенный слот: ${shown(harness.calls[0].scheduledAt)}`)
    assert.equal(viewOf(harness.runner.snapshot(), 'sch_every').nextRunAt, T0 + 6 * HOUR,
      `после догона сетка не продолжилась: ${shown(viewOf(harness.runner.snapshot(), 'sch_every').nextRunAt)}`)
    harness.clock.advanceTo(T0 + 6 * HOUR)
    assert.equal(harness.calls.length, 2, `после догона обычный шаг не пошёл (вызовов ${harness.calls.length})`)
  })

  check('рантаймер: misfire skip не догоняет пропущенное и пересчитывает вперёд от «сейчас»', () => {
    const harness = makeHarness({
      nowMs: T0 + 5 * HOUR + 30 * MINUTE,
      store: makeFakeStore([everyRec({ id: 'sch_every', misfire: 'skip', lastRunAt: T0, nextRunAt: T0 + HOUR })])
    })
    harness.clock.fireDue()
    assert.equal(harness.calls.length, 0, `skip догнал пропущенное: ${show(harness.calls.map(call => shown(call.scheduledAt)))}`)
    assert.equal(viewOf(harness.runner.snapshot(), 'sch_every').nextRunAt, T0 + 6 * HOUR,
      `skip не пересчитал вперёд от «сейчас»: ${shown(viewOf(harness.runner.snapshot(), 'sch_every').nextRunAt)}`)
    harness.clock.advanceTo(T0 + 6 * HOUR)
    assert.equal(harness.calls.length, 1, `после skip сетка не пошла: вызовов ${harness.calls.length}`)
  })

  check('рантаймер: publish не трещотка — чтение снимка и пустой тик событий не плодят', () => {
    const harness = makeHarness({ nowMs: T0, store: makeFakeStore([everyRec({ id: 'sch_every' })]) })
    const { runner, clock, published } = harness
    assert.ok(published.length >= 1, `после start() не было ни одного publish: ${show(published)}`)
    const before = published.length
    for (let i = 0; i < 5; i++) runner.snapshot()
    assert.equal(published.length, before, `пять чтений snapshot() добавили ${published.length - before} событий`)
    clock.set(T0 + 10 * MINUTE) // до слота далеко: тик ничего не меняет
    clock.fireDue()
    assert.equal(published.length, before, `пустой тик добавил ${published.length - before} событий при неизменном состоянии`)
    runner.pause('sch_every')
    assert.ok(published.length > before, 'реальное изменение состояния (pause) не дошло до окна')
    const afterPause = published.length
    runner.pause('sch_every')
    runner.pause('sch_every')
    assert.equal(published.length, afterPause, `повторный pause без изменения добавил ${published.length - afterPause} событий`)
  })

  check('рантаймер: в publish и snapshot() нет полей, похожих на секрет; снимок перечисляет все расписания', () => {
    const store = makeFakeStore([
      everyRec({ id: 'sch_every' }),
      dailyRec({ id: 'sch_daily', action: { type: 'agent-turn', prompt: `служебный промпт ${SECRET}`, chatId: 'chat-1' } }),
      record({ id: 'sch_note', kind: 'daily', daily: { time: '08:00' }, action: { type: 'note', text: 'заметка' } })
    ])
    const harness = makeHarness({
      nowMs: T0,
      store,
      execute: () => ({ ok: false, error: `401 Unauthorized: ${SECRET}` })
    })
    harness.clock.advanceTo(T0 + HOUR)
    const snapshot = harness.runner.snapshot()
    const views = viewList(snapshot)
    assert.deepEqual(views.map(idOf).sort(), ['sch_daily', 'sch_every', 'sch_note'], `snapshot() перечисляет не все расписания: ${show(views.map(idOf))}`)
    for (const view of views)
      assert.ok(typeof view.nextRunAt === 'number' || view.nextRunAt === null, `у ${idOf(view)} нет nextRunAt: ${show(view)}`)
    const every = viewOf(snapshot, 'sch_every')
    assert.match(String(every.lastError), /401/, `ошибка не дошла до окна: ${show(every)}`)
    assert.equal(String(every.lastError).includes(SECRET), false, 'в lastError снимка протёк секрет')
    const dump = JSON.stringify([harness.published, snapshot])
    assert.equal(dump.includes(SECRET), false, 'в publish/snapshot есть значение, похожее на ключ')
    assert.equal(/"action"\s*:|"history"\s*:|"prompt"\s*:|"chatId"\s*:/.test(dump), false, `окну показывают лишние поля записи: ${show(Object.keys(views[0] || {}))}`)
    assert.ok(harness.published.some(event => JSON.stringify(event).includes('sch_every')), 'о наступившем запуске sch_every окно не известили')
  })

  check('рантаймер: пропущенные запуски не копятся очередью — сон на сутки при skip даёт один запуск, не 24', () => {
    const harness = makeHarness({ nowMs: T0, store: makeFakeStore([everyRec({ id: 'sch_every', misfire: 'skip' })]) })
    assert.equal(viewOf(harness.runner.snapshot(), 'sch_every').nextRunAt, T0 + HOUR, 'до сна сетка не та')
    harness.clock.advanceTo(T0 + DAY + 10 * MINUTE) // «ноутбук спал сутки»
    assert.equal(harness.calls.length, 1, `после сна на сутки исполнено ${harness.calls.length} запусков: ${show(harness.calls.map(call => shown(call.scheduledAt)))}`)
    const next = viewOf(harness.runner.snapshot(), 'sch_every').nextRunAt
    assert.ok(next > harness.clock.now(), `после сна nextRunAt ${shown(next)} не позже «сейчас» — очередь пропусков осталась`)
    harness.clock.fireDue()
    harness.clock.replay(harness.clock.firedLog()[0])
    assert.equal(harness.calls.length, 1, `повторные тики после сна добавили ходов: ${harness.calls.length}`)
  })

  check('рантаймер: невалидная запись в хранилище не роняет start(), остальные живут', () => {
    const store = makeFakeStore([
      dailyRec({ id: 'sch_live_a' }),
      { id: 'sch_junk', name: 'Испорчено рукой', kind: 'нет-такого', timeZone: 'Europe/Berlin' },
      null,
      'расписание',
      { id: 'a.b', kind: 'daily', daily: { time: '24:00' }, timeZone: 'Mars/Olympus' },
      dailyRec({ id: 'sch_live_b', daily: { time: '08:00' } })
    ])
    let harness = null
    try {
      harness = makeHarness({ nowMs: APR_01, store })
    } catch (error) {
      throw new Error(`start() бросает на невалидной записи из хранилища: ${error.message}`)
    }
    const views = viewList(harness.runner.snapshot())
    assert.deepEqual(views.map(idOf).sort(), ['sch_live_a', 'sch_live_b'],
      `живые расписания не пережили соседство с мусором: ${show(views.map(idOf))}`)
    assert.equal(views.filter(view => typeof view.nextRunAt === 'number' && view.nextRunAt > harness.clock.now()).length, 2,
      `не у всех живых расписаний есть следующий запуск в будущем: ${show(views)}`)
    assert.doesNotThrow(() => harness.runner.runNow('sch_junk'), 'runNow по отброшенной записи бросает')
    harness.clock.advanceTo(APR_01 + 8 * HOUR)
    assert.deepEqual([...new Set(harness.calls.map(call => call.item && call.item.id))].sort(), ['sch_live_a', 'sch_live_b'],
      `исполнилось не то: ${show(harness.calls.map(call => call.item && call.item.id))}`)
    assert.ok(harness.calls.length >= 1, 'за соседство с мусором живые расписания встали')
    const trace = JSON.stringify([harness.runner.snapshot(), harness.published])
    const marked = /sch_junk|"a\.b"/.test(trace) || /"(invalid|corrupt|dropped|rejected|errors)"/.test(trace)
    assert.ok(marked, `отброшенная невалидная запись нигде не отмечена — человек теряет расписание молча: ${trace.slice(0, 300)}`)
  })

  check('рантаймер: remove(id) убирает расписание из снимка и больше его не исполняет', () => {
    const harness = makeHarness({ nowMs: T0, store: makeFakeStore([everyRec({ id: 'sch_gone' }), everyRec({ id: 'sch_stay' })]) })
    harness.runner.remove('sch_gone')
    assert.deepEqual(viewList(harness.runner.snapshot()).map(idOf).sort(), ['sch_stay'],
      `remove() оставил запись в снимке: ${show(viewList(harness.runner.snapshot()).map(idOf))}`)
    assert.equal(harness.store.list().some(item => item && item.id === 'sch_gone'), false, 'remove() не дошёл до хранилища')
    harness.clock.advanceTo(T0 + 5 * HOUR)
    assert.deepEqual([...new Set(harness.calls.map(call => call.item && call.item.id))], ['sch_stay'],
      `удалённое расписание всё равно исполняется: ${show(harness.calls.map(call => call.item && call.item.id))}`)
  })

  check('рантаймер: состояние после перезапуска поднимается с диска и сетка продолжается', () => {
    const dir = tmpDir('restart')
    createStore({ dir }).save([dailyRec({ id: 'sch_disk' })])
    const first = makeHarness({ nowMs: APR_01, store: createStore({ dir }) })
    first.clock.advanceTo(DAILY_TODAY)
    assert.equal(first.calls.length, 1, 'до перезапуска расписание не исполнилось')
    first.runner.stop()

    const reopened = makeHarness({ nowMs: DAILY_TODAY + MINUTE, store: createStore({ dir }) })
    const view = viewOf(reopened.runner.snapshot(), 'sch_disk')
    assert.ok(view, `после перезапуска записи нет в снимке: ${show(reopened.runner.snapshot())}`)
    assert.equal(view.nextRunAt, DAILY_TOMORROW, `после перезапуска сетка не продолжилась: ${shown(view.nextRunAt)}`)
    const stored = createStore({ dir }).list().find(item => item.id === 'sch_disk')
    assert.equal(stored.lastRunAt, DAILY_TODAY, `исполненное не легло на диск: ${shown(stored.lastRunAt)}`)
    assert.ok(Array.isArray(stored.history) && stored.history.length >= 1, `история запусков не пережила перезапуск: ${show(stored.history)}`)
    reopened.clock.advanceTo(DAILY_TOMORROW)
    assert.equal(reopened.calls.length, 1, 'после перезапуска плановый слот не исполнен')
  })
}

try {
  storeSuite()
  runnerSuite()
} finally {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // свои каталоги; чужие не трогаем ни при каком раскладе
    }
  }
}

if (!storeModule || !runnerModule)
  console.error('src/main/schedule-store.js и src/main/schedule-runner.js отсутствуют — весь набор красным, и это правильно')
console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
