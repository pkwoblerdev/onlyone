'use strict'

// Рантайм расписаний (план, этап 3.5, часть 2 контракта): пробуждение,
// исполнение, пауза, отмена и идемпотентность.
//
// Три правила, из которых вырос модуль.
//
// 1. «Начато» раньше «сделано». Запись истории заводится ДО вызова исполнителя
//    и с тем же `runId`, а исход обновляет её же (шов `settleHistory`).
//    Процесс, умерший внутри хода, оставляет след — тот же приём, что
//    контрольные точки хода в `run-checkpoints.js`.
// 2. Слот берётся один раз. Таймер вооружается ровно на `nextRunAt`, слот
//    помечается взятым до исполнения, поэтому повторная доставка того же
//    таймера и гонка «вручную + по расписанию» не дают второго хода.
//    Периодической самопроверки нет намеренно: она будит процесс впустую и
//    перестает успевать за длинными слотами. `tick()` остаётся публичным —
//    им главный процесс будит планировщик после выхода из сна.
// 3. Память — зеркало хранилища. Зачистка секрета и обрезка истории живут в
//    одном месте, и окно обязано видеть ровно то, что легло на диск, а не то,
//    что однажды вернула модель.
//
// Ни `Date.now()`, ни настоящих таймеров внутри: часы, `setTimeout` и
// `clearTimeout` приходят параметрами. Иначе проверка «сон на сутки не
// превращается в очередь из двадцати четырёх запусков» обязана была бы ждать
// сутки.

const MAX_HISTORY_FALLBACK = 20
const INVALID_TEXT_LIMIT = 4
// Node обрезает `setTimeout` с задержкой больше 2^31-1 мс до одного миллисекунды:
// расписание «через год» без ограничения сработало бы сегодня. Длинные слоты
// вооружаются частями: одно пустое пробуждение раз в 24 дня вместо запуска
// не в свой срок.
const MAX_TIMEOUT_MS = 2 ** 31 - 2

function createScheduleRunner(options = {}) {
  const store = options.store
  const model = options.model
  const now = typeof options.now === 'function' ? options.now : Date.now
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout
  const execute = typeof options.execute === 'function' ? options.execute : async () => ({ ok: true })
  const publish = typeof options.publish === 'function' ? options.publish : () => {}
  const historyLimit = Number(store && store.MAX_HISTORY) || MAX_HISTORY_FALLBACK

  let records = []
  let invalid = []
  let corruptFile = false
  let storeError = ''
  const timers = new Map()
  const running = new Map()
  const inflight = new Set()
  const announced = new Map()
  let seq = 0
  let started = false

  function find(id) {
    return records.find(record => record && record.id === id) || null
  }

  // Полный текст записи — только адресным нуждам главного процесса (человеческое
  // слово о следующем запуске, текст просьбы для формы правки). В снимок и в
  // события это не попадает: там вьюха, и она по договору без содержания.
  function record(id) {
    return find(id)
  }

  // Какой `runId` носит текущий ход записи: по нему окно сопоставит нажатие с
  // будущим итогом. После ответа (или для синхронного исполнителя) — null.
  function runningOf(id) {
    return running.get(id) || null
  }

  function textOf(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value))
  }

  // Что видит окно: только состояние расписания. Ни `action`, ни `history`, ни
  // промптов — исполняемая часть остаётся на диске, а в снимке её некому читать.
  function view(record) {
    return {
      id: record.id,
      name: textOf(record.name) || textOf(record.id),
      kind: record.kind,
      timeZone: record.timeZone,
      enabled: record.enabled !== false,
      running: running.has(record.id),
      nextRunAt: Number.isFinite(record.nextRunAt) ? record.nextRunAt : null,
      lastRunAt: Number.isFinite(record.lastRunAt) ? record.lastRunAt : null,
      lastError: textOf(record.lastError)
    }
  }

  function snapshot() {
    return { records: records.map(view), invalid: invalid.map(one => ({ ...one })), corrupt: corruptFile, storeError }
  }

  function recompute(record, fromMs, { catchedUp = false } = {}) {
    // Догон считался «прошлым» слотом: после него сетка продолжается от
    // «сейчас», иначе следующий тик догонит ещё раз, и ещё — ровно та очередь,
    // которую контракт запрещает.
    const probe = catchedUp ? { ...record, misfire: 'skip' } : record
    let next = null
    try {
      next = model.nextAfter(probe, fromMs)
      record.nextRunAt = Number.isFinite(next) ? next : null
    } catch (error) {
      record.nextRunAt = null
      record.lastError = textOf(error && error.message) || 'ошибка вычисления расписания'
    }
    return record
  }

  // ---------------------------------------------------------------------------
  // Таймеры: один на расписание, ровно на его слот
  // ---------------------------------------------------------------------------

  function disarm(id) {
    if (!timers.has(id)) return
    const handle = timers.get(id)
    timers.delete(id)
    clearTimer(handle)
  }

  function arm(record) {
    if (!record) return
    disarm(record.id)
    // Занятая запись не вооружается: два хода одного расписания параллельно —
    // это тот же двойной запуск, только изнутри. Освобождается оно в `settle`.
    if (!started || record.enabled === false || running.has(record.id)) return
    if (!Number.isFinite(record.nextRunAt)) return
    const delay = record.nextRunAt - now()
    if (!Number.isFinite(delay)) return
    timers.set(record.id, setTimer(onWake, Math.min(Math.max(0, delay), MAX_TIMEOUT_MS)))
  }

  function rearm() {
    for (const record of records.slice()) arm(record)
  }

  function sweep() {
    const at = now()
    for (const record of records.slice()) {
      try {
        if (!record || record.enabled === false || running.has(record.id)) continue
        if (!Number.isFinite(record.nextRunAt) || record.nextRunAt > at) continue
        fire(record)
      } catch (error) {
        if (record) {
          record.lastError = textOf(error && error.message) || 'ошибка запуска'
        }
      }
    }
  }

  // Пробуждение смотрит по всем записям, а не по разбуженной: за время сна
  // сосед тоже мог поспеть, а занятое исполнение обязано быть разбужено после
  // ответа тем же путём, что и плановый слот.
  function onWake() {
    if (!started) return
    sweep()
    rearm()
  }

  function tick() {
    onWake()
    return snapshot()
  }

  // ---------------------------------------------------------------------------
  // Хранилище и события
  // ---------------------------------------------------------------------------

  // Отказ хранилища в пути исполнения не имеет права ронять планировщик: память
  // остаётся правдой, а следующая удачная запись допишет то же самое. Причина
  // лежит в снимке под общим именем `storeError` (отказ на отказ не накладывается:
  // потерянную запись молча не забудешь, она видна до ближайшего старта), и
  // отказ чтения, и отказ записи — человек обязан увидеть и то, и другое.
  function write(apply) {
    try {
      apply(store)
    } catch (error) {
      storeError = storeError || messageOf(error)
    }
  }

  // Память перечитывается из хранилища после записи: зачистка секрета и
  // обрезка истории делают это в одном месте, и рантайм не имеет права
  // показывать окно сырее, чем лежит на диске.
  function syncStored(record) {
    let stored = null
    try {
      stored = (store.list() || []).find(item => item && item.id === record.id) || null
    } catch {
      return
    }
    if (!stored) return
    record.name = textOf(stored.name)
    record.history = Array.isArray(stored.history) ? stored.history.slice() : []
    record.lastError = textOf(stored.lastError)
  }

  function send(event) {
    try { publish(event) } catch { /* окно закрыто — планировщик не встаёт */ }
  }

  function remember(record) {
    announced.set(record.id, JSON.stringify(view(record)))
  }

  // Состояние отдаётся окну только когда оно правда изменилось: повторный
  // `pause` не обязан плодить события, а `snapshot()` вообще молчит.
  function announceState(record) {
    const state = JSON.stringify(view(record))
    if (announced.get(record.id) === state) return
    announced.set(record.id, state)
    send({ type: 'schedule-state', at: now(), ...view(record) })
  }

  function announce(kind, record, extra = {}) {
    send({ type: `schedule-${kind}`, at: now(), ...(record ? view(record) : {}), ...extra })
    if (record) remember(record)
  }

  function persistRecord(record) {
    write(s => s.upsert(record))
    syncStored(record)
  }

  // ---------------------------------------------------------------------------
  // Исполнение
  // ---------------------------------------------------------------------------

  // Слот считается взятым, только если он наступил: «выполнить сейчас» не имеет
  // права съедать ближайший запуск по расписанию и записывать будущее в
  // `lastRunAt`.
  function takeSlot(record, slotAt) {
    if (slotAt > now()) return
    record.lastRunAt = slotAt
    recompute(record, now(), { catchedUp: slotAt < now() })
  }

  function normalize(answer) {
    // Отказ без явного `ok: false` тоже отказ: исполнитель, который принёс
    // только `error`, не имеет права записываться как успешный запуск. `message`
    // сам по себе текстом отказа не считается — у хода агента это обычное поле.
    // Не-объектный ответ — тоже отказ: молчаливый успех о ходе, которого не
    // было, хуже честного отказа (break-4 Н16).
    if (!answer || typeof answer !== 'object') return { ok: false, error: 'исполнитель не принёс исход' }
    const error = textOf(answer.error)
    if (answer.ok === false || error) {
      return { ok: false, error: error || textOf(answer.message) || 'исполнение не удалось' }
    }
    return { ok: true }
  }

  function messageOf(error) {
    return textOf(error && error.message) || textOf(error) || 'исполнение не удалось'
  }

  // Исход правит ту же запись истории, что заведена словом «начато». Если
  // хранилище про новый шов ничего не знает (контракт обещает шесть методов),
  // история ложится целиком вместе с записью. Расписание могли удалить, пока
  // ход шёл: писать некому, и будить его больше нельзя.
  function settle(record, runId, outcome) {
    running.delete(record.id)
    if (find(record.id) !== record) return { ok: outcome.ok, runId, dropped: true }
    const patch = outcome.ok ? { ok: true, error: null } : { ok: false, error: outcome.error }
    const index = record.history.findIndex(entry => entry && entry.runId === runId)
    if (index >= 0) record.history[index] = { ...record.history[index], ...patch }
    else record.history = [{ at: now(), runId, ...patch }, ...record.history].slice(0, historyLimit)
    record.lastError = outcome.ok ? '' : outcome.error
    if (typeof store.settleHistory === 'function' && !writeOrFalse(s => s.settleHistory(record.id, runId, patch))) {
      write(s => s.appendHistory(record.id, { at: now(), runId, ...patch }))
    }
    persistRecord(record)
    announce(outcome.ok ? 'done' : 'error', record, { runId })
    arm(record)
    return { ok: outcome.ok, runId }
  }

  function writeOrFalse(apply) {
    let result = false
    try { result = Boolean(apply(store)) } catch (error) { storeError = messageOf(error) }
    return result
  }

  function fire(record, { manual = false } = {}) {
    if (!record) return Promise.resolve({ ok: false, error: 'расписания нет' })
    if (running.has(record.id)) {
      return Promise.resolve({ ok: false, skipped: true, runId: running.get(record.id) })
    }
    const startedAt = now()
    const slotAt = Number.isFinite(record.nextRunAt) ? record.nextRunAt : startedAt
    // Ручной запуск ДО срока исполняется сейчас, а не «в счёт будущего слота»:
    // и исполнитель, и журнал обязаны видеть настоящий момент. Сетку трогает
    // только наступивший слот — за это стоит `takeSlot`.
    const runAt = Math.min(slotAt, startedAt)
    const runId = `${record.id}-${startedAt}-${++seq}`
    takeSlot(record, slotAt)
    running.set(record.id, runId)
    const entry = { at: startedAt, ok: null, runId, scheduledAt: runAt, manual }
    record.history = [entry, ...(Array.isArray(record.history) ? record.history : [])].slice(0, historyLimit)
    if (!writeOrFalse(s => s.appendHistory(record.id, entry))) {
      storeError = storeError || 'запуск не попал в журнал расписания'
    }
    // Взятый слот уходит на диск сразу, не дожидаясь ответа: запись «начато»
    // с прежним сроком означала бы, что процесс, убитый внутри исполнения,
    // оставил планировщику приглашение догнать ЭТОТ ЖЕ слот второй раз.
    persistRecord(record)
    announce('run', record, { runId, scheduledAt: runAt, manual })
    disarm(record.id)

    let answer
    try {
      answer = execute({ ...record }, runAt, { manual, runId, at: startedAt })
    } catch (error) {
      // Синхронный отказ обязан быть виден синхронно: снапшот читают в том же
      // тике, а не через поворот цикла обещаний.
      return Promise.resolve(settle(record, runId, normalize({ ok: false, error: messageOf(error) })))
    }
    if (!answer || typeof answer.then !== 'function') {
      return Promise.resolve(settle(record, runId, normalize(answer)))
    }
    const job = answer
      .then(value => normalize(value), error => normalize({ ok: false, error: messageOf(error) }))
      .then(outcome => settle(record, runId, outcome))
    inflight.add(job)
    job.then(() => inflight.delete(job), () => inflight.delete(job))
    return job
  }

  // ---------------------------------------------------------------------------
  // Подъём из хранилища и команды пользователя
  // ---------------------------------------------------------------------------

  function adopt(loaded) {
    const accepted = []
    const rejected = []
    for (const item of Array.isArray(loaded) ? loaded : []) {
      const validation = model.validateSchedule(item)
      if (!validation.ok) {
        // Отброшенное расписание остаётся видимым: без этой строки человек
        // теряет свой список молча и узнаёт о нём только по чужому рассказу.
        rejected.push({
          id: item && typeof item === 'object' ? textOf(item.id) : '',
          name: item && typeof item === 'object' ? textOf(item.name).slice(0, 80) : '',
          errors: (validation.errors || []).slice(0, INVALID_TEXT_LIMIT)
            .map(one => ({ field: textOf(one && one.field), code: textOf(one && one.code), message: textOf(one && one.message) }))
        })
        continue
      }
      const record = { misfire: 'skip', ...item, history: Array.isArray(item.history) ? item.history.slice(0, historyLimit) : [] }
      recompute(record, now())
      accepted.push(record)
    }
    records = accepted
    invalid = rejected
    return records
  }

  function start() {
    started = true
    storeError = ''
    announced.clear()
    corruptFile = false
    let loaded = null
    let unreadable = false
    try {
      loaded = store.load()
    } catch (error) {
      // Файл, который не удалось даже прочитать, — это испорченное состояние,
      // а не «пустой список»: молча поднять планировщик на пустоте значит
      // потерять расписания человека без единого слова.
      unreadable = true
      storeError = messageOf(error)
    }
    corruptFile = unreadable || Boolean(loaded && loaded.corrupt)
    const stored = loaded && Array.isArray(loaded.records) ? loaded.records : []
    adopt(stored)
    // Пересчитанный `nextRunAt` обязан пережить падение до первого тика, и
    // сразу весь список: по обращению на расписание — это сто записей файла
    // на пуске приложения, а на медленном диске — секунды до готовности.
    // Чужие записи, которые ядро отвергло, пишутся обратно как лежали: их
    // человек ещё может поправить руками.
    const known = new Set(records.map(one => one.id))
    const untouched = stored.filter(one => one && typeof one === 'object' && typeof one.id === 'string' &&
      one.id && !known.has(one.id))
    write(s => s.save([...records, ...untouched]))
    rearm()
    for (const record of records) announceState(record)
    return snapshot()
  }

  function stop() {
    started = false
    for (const id of [...timers.keys()]) disarm(id)
  }

  function add(next) {
    const validation = model.validateSchedule(next)
    if (!validation.ok) return { ok: false, errors: validation.errors }
    const record = { enabled: true, misfire: 'skip', ...next }
    const current = find(record.id)
    record.history = Array.isArray(current && current.history) ? current.history : (Array.isArray(record.history) ? record.history : [])
    recompute(record, now())
    if (current) Object.assign(current, record)
    else records.push(record)
    const target = current || record
    persistRecord(target)
    invalid = invalid.filter(one => one.id !== target.id)
    arm(target)
    announceState(target)
    return { ok: true, record: target }
  }

  function update(patch) {
    const current = find(patch && patch.id)
    if (!current) return add(patch)
    return add({ ...current, ...patch })
  }

  function remove(id) {
    const index = records.findIndex(record => record && record.id === id)
    const gone = index >= 0 ? records[index] : null
    if (index >= 0) records.splice(index, 1)
    const stored = writeOrFalse(s => s.remove(id))
    disarm(id)
    running.delete(id)
    const removed = Boolean(gone || stored)
    if (removed) {
      announced.delete(id)
      send({ type: 'schedule-removed', at: now(), ...(gone ? view(gone) : { id }) })
    }
    rearm()
    return removed
  }

  function pause(id) {
    const record = find(id)
    if (!record) return null
    record.enabled = false
    disarm(record.id)
    persistRecord(record)
    announceState(record)
    return view(record)
  }

  function resume(id) {
    const record = find(id)
    if (!record) return null
    record.enabled = true
    recompute(record, now())
    persistRecord(record)
    arm(record)
    announceState(record)
    return view(record)
  }

  function runNow(id) {
    const record = find(id)
    if (!record) return Promise.resolve({ ok: false, error: 'расписания нет' })
    return fire(record, { manual: true })
  }

  // Для теста и для честной остановки: все начатые исполнения уже дошли до
  // конца. Без этого «ноль отказов» означало бы лишь то, что обещания ещё не
  // вернулись.
  function drain() {
    return Promise.all([...inflight]).then(() => snapshot())
  }

  return { start, stop, tick, add, update, remove, pause, resume, runNow, snapshot, drain,
    record, runningOf, get started() { return started } }
}

module.exports = { createScheduleRunner, MAX_HISTORY_FALLBACK }
