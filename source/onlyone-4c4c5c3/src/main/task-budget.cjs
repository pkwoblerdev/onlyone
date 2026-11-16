'use strict'

// АГ-8, И-2/И-2.1: один бюджет задачи на ведущего, помощников, повторы,
// продолжение и смену ключа. Своего предела у модуля нет: пороги и общий срок
// передаёт вызывающий явно. Модуль чистый — ни диска, ни Electron. Хранит его
// состояние владелец задачи (task-state.cjs), а переживает падение оно в
// контрольной точке хода.
//
// Порядок один: резерв до запроса → списание по факту → освобождение резерва.
// Неизвестный расход не ноль. При конечном пределе токенов он запрещает
// обычное продолжение: свободный остаток из потерянного usage не выдаётся,
// пока доверенный код не скажет allowUnknown явно. Позднее уточнение переводит
// неизвестный расход в известный идемпотентно.
//
// Суммарная длительность запросов (used.ms) — учёт, а не предел. Общий срок
// задачи — отдельный абсолютный deadlineAt; он не продлевается помощником,
// повтором или продолжением.
//
// Виденные id хранятся в Bloom-фильтре фиксированного размера: старый id после
// вытеснения из журнала не становится незаметно новой попыткой. Ложное
// срабатывание (свежий id отвергнут) безопасно, но возможно; id должны быть
// уникальными. Исправление позднего расхода ищется только в журнале истории,
// поэтому после его вытеснения уточнить расход нельзя.

const { createHash } = require('node:crypto')

const SCHEMA_VERSION = 2
const DIMENSIONS = ['requests', 'tokens']
const OUTCOMES = ['completed', 'failed', 'cancelled', 'unknown']
// Ограничения журналов, а не расходов: старые записи вытесняются.
const MAX_RESERVATIONS = 64
const MAX_HISTORY = 64
const MAX_RECOVERED = 64
// События расхода — точное кольцо хешей: повтор внутри окна не списывается,
// за окном — списывается повторно (переучёт, но не бесплатный запрос).
const MAX_EVENTS = 512
const EVENT_HASH = /^[a-f0-9]{32}$/
// Bloom: 512 Кбит, три хеша. Ограниченная память вместо растущего списка id.
// 4 КБ отвергали свежий id уже на ~685 запросах (break-4 Н20); старые снимки
// на 4 КБ восстанавливаются как есть — размер фильтра берётся из его байтов.
const SEEN_BYTES = 65536
const LEGACY_SEEN_BYTES = 4096
const SEEN_HASHES = 3
const ID = /^[A-Za-z0-9_.:-]{1,120}$/

const validId = value => typeof value === 'string' && ID.test(value)
const safe = value => Number.isSafeInteger(value) && value >= 0
const copy = value => JSON.parse(JSON.stringify(value))

function hasOwn(object, key) {
  return Object.hasOwn(object, key)
}

function readLimits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Нужны явные пределы бюджета задачи')
  for (const key of Object.keys(raw)) {
    if (!DIMENSIONS.includes(key)) throw new TypeError(`Неизвестный предел бюджета: ${key}; общий срок задаётся deadlineAt`)
  }
  const limits = {}
  for (const dim of DIMENSIONS) {
    if (!hasOwn(raw, dim)) throw new TypeError(`Нужен явный предел бюджета: ${dim}`)
    if (raw[dim] === null) { limits[dim] = null; continue }
    if (!safe(raw[dim])) throw new TypeError(`Неверный предел бюджета: ${dim}`)
    limits[dim] = raw[dim]
  }
  return Object.freeze(limits)
}

function readDeadline(value) {
  if (value === undefined) throw new TypeError('Нужен явный срок задачи: deadlineAt или null')
  if (value === null) return null
  if (!safe(value)) throw new TypeError('Неверный срок задачи: deadlineAt')
  return value
}

function cleanLimits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (Object.keys(raw).some(key => !DIMENSIONS.includes(key))) return null
  const limits = {}
  for (const dim of DIMENSIONS) {
    if (!hasOwn(raw, dim)) return null
    if (raw[dim] === null) { limits[dim] = null; continue }
    if (!safe(raw[dim])) return null
    limits[dim] = raw[dim]
  }
  return limits
}

// ─── Bloom-фильтр виденных id ───────────────────────────────────────────────

function hashText(text, seed) {
  let hash = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function bitAt(text, index, bits) {
  const first = hashText(text, 0x9e3779b9)
  const second = hashText(text, 0x85ebca6b) | 1
  return ((first + Math.imul(index, second)) >>> 0) % bits
}

function maybeSeen(bytes, text) {
  const bits = bytes.length * 8
  for (let i = 0; i < SEEN_HASHES; i++) {
    const bit = bitAt(text, i, bits)
    if (!(bytes[bit >> 3] & (1 << (bit & 7)))) return false
  }
  return true
}

function markSeen(bytes, text) {
  const bits = bytes.length * 8
  for (let i = 0; i < SEEN_HASHES; i++) {
    const bit = bitAt(text, i, bits)
    bytes[bit >> 3] |= 1 << (bit & 7)
  }
}

function encodeSeen(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function decodeSeen(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null
  const bytes = Buffer.from(text, 'base64')
  // Принимаем и прежний размер (4 КБ): продолжение старой задачи не должно
  // падать с «Повреждённое состояние бюджета» из-за роста фильтра.
  if ((bytes.length !== SEEN_BYTES && bytes.length !== LEGACY_SEEN_BYTES) || bytes.toString('base64') !== text) return null
  return new Uint8Array(bytes)
}

function eventHashOf(eventId) {
  return createHash('sha256').update(`event:${eventId}`).digest('hex').slice(0, 32)
}

// ─── Разбор недоверенного снимка ────────────────────────────────────────────

function cleanReservation(raw) {
  if (!raw || typeof raw !== 'object' || !validId(raw.id)) return null
  if (!safe(raw.requests) || raw.requests < 1) return null
  if (!safe(raw.tokens) || !safe(raw.agentIndex) || !safe(raw.at)) return null
  if (!validId(raw.kind)) return null
  return { id: raw.id, requests: raw.requests, tokens: raw.tokens, agentIndex: raw.agentIndex, kind: raw.kind, at: raw.at }
}

function cleanHistory(raw) {
  if (!raw || typeof raw !== 'object' || !validId(raw.id)) return null
  if (!hasOwn(raw, 'eventId') || (raw.eventId !== null && !validId(raw.eventId))) return null
  if (!OUTCOMES.includes(raw.outcome)) return null
  if (!safe(raw.requests) || raw.requests < 1) return null
  if (raw.tokens !== null && !safe(raw.tokens)) return null
  if (typeof raw.tokensUnknown !== 'boolean' || raw.tokensUnknown !== (raw.tokens === null)) return null
  if (!safe(raw.elapsedMs) || !safe(raw.agentIndex) || !safe(raw.at)) return null
  if (!validId(raw.kind)) return null
  return {
    id: raw.id, eventId: raw.eventId, outcome: raw.outcome, requests: raw.requests,
    tokens: raw.tokens, tokensUnknown: raw.tokensUnknown, elapsedMs: raw.elapsedMs,
    agentIndex: raw.agentIndex, kind: raw.kind, at: raw.at
  }
}

function reservedTotalsOf(list) {
  const totals = { requests: 0, tokens: 0 }
  for (const item of list) {
    totals.requests += item.requests
    totals.tokens += item.tokens
    if (!Number.isSafeInteger(totals.requests) || !Number.isSafeInteger(totals.tokens)) return null
  }
  return totals
}

// С диска приходит недоверенный объект: файл мог быть старым, обрезанным или
// поправленным соседним процессом. Любое расхождение — повреждение, а не
// повод начать с нуля: ноль при повреждённых счётчиках открыл бы новый бюджет.
function cleanBudgetState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== SCHEMA_VERSION) return null
  const limits = cleanLimits(raw.limits)
  if (!limits) return null
  if (!hasOwn(raw, 'deadlineAt')) return null
  const deadlineAt = raw.deadlineAt === null ? null : safe(raw.deadlineAt) ? raw.deadlineAt : undefined
  if (deadlineAt === undefined) return null
  if (!raw.used || typeof raw.used !== 'object' || Array.isArray(raw.used)) return null
  if (!safe(raw.used.requests) || !safe(raw.used.tokens) || !safe(raw.used.ms)) return null
  const used = { requests: raw.used.requests, tokens: raw.used.tokens, ms: raw.used.ms }
  if (!safe(raw.unknownUsage) || raw.unknownUsage > used.requests) return null
  let unknownUsage = raw.unknownUsage
  if (!safe(raw.overrides)) return null
  const overrides = raw.overrides

  if (!Array.isArray(raw.reservations) || raw.reservations.length > MAX_RESERVATIONS) return null
  const reservations = []
  for (const item of raw.reservations) {
    const clean = cleanReservation(item)
    if (!clean || reservations.some(other => other.id === clean.id)) return null
    reservations.push(clean)
  }

  if (!Array.isArray(raw.history)) return null
  const history = []
  for (const item of raw.history.slice(-MAX_HISTORY)) {
    const clean = cleanHistory(item)
    if (!clean || history.some(other => other.id === clean.id)) return null
    if (clean.eventId && history.some(other => other.eventId === clean.eventId)) return null
    history.push(clean)
  }
  const knownIds = new Set(history.map(item => item.id))
  if (reservations.some(item => knownIds.has(item.id))) return null

  let historyRequests = 0
  let historyTokens = 0
  let historyMs = 0
  let historyUnknown = 0
  for (const item of history) {
    historyRequests += item.requests
    historyMs += item.elapsedMs
    if (item.tokensUnknown) historyUnknown += item.requests
    else historyTokens += item.tokens
    if (![historyRequests, historyTokens, historyMs, historyUnknown].every(Number.isSafeInteger)) return null
  }
  // Удержанная история — нижняя граница итогов. Весь расход из обрезанного
  // журнала не пересчитывается: старые списания остаются в totals.
  if (used.requests < historyRequests || used.tokens < historyTokens ||
      used.ms < historyMs || unknownUsage < historyUnknown) return null

  if (!Array.isArray(raw.recoveredReservations) || raw.recoveredReservations.length > MAX_RECOVERED) return null
  const recovered = []
  for (const id of raw.recoveredReservations) {
    if (!validId(id) || recovered.includes(id)) return null
    recovered.push(id)
  }

  if (!Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) return null
  const events = []
  for (const hash of raw.events) {
    if (typeof hash !== 'string' || !EVENT_HASH.test(hash) || events.includes(hash)) return null
    events.push(hash)
  }
  for (const item of history) {
    if (item.eventId && !events.includes(eventHashOf(item.eventId))) return null
  }

  const seen = decodeSeen(raw.seen)
  if (!seen) return null
  // Записи журнала и восстановленные id обязаны быть видны фильтру: иначе
  // старый id снова станет новой попыткой. Bloom не даёт ложных отрицаний.
  for (const item of history) {
    if (!maybeSeen(seen, `r:${item.id}`)) return null
  }
  for (const id of recovered) {
    if (!maybeSeen(seen, `r:${id}`)) return null
  }
  if (recovered.some(id => reservations.some(item => item.id === id))) return null

  const held = reservedTotalsOf(reservations)
  if (!held) return null
  if (hasOwn(raw, 'reserved')) {
    const value = raw.reserved
    if (!value || typeof value !== 'object' || value.requests !== held.requests || value.tokens !== held.tokens) return null
  }
  if (hasOwn(raw, 'remaining')) {
    const value = raw.remaining
    if (!value || typeof value !== 'object') return null
    for (const dim of DIMENSIONS) {
      const limit = limits[dim]
      const expected = limit === null ? null : Math.max(0, limit - used[dim] - held[dim])
      if (value[dim] !== expected) return null
    }
  }
  if (hasOwn(raw, 'tokenAccounting') && raw.tokenAccounting !== (unknownUsage > 0 ? 'incomplete' : 'complete')) return null

  // Снимок читают только у процесса, которого уже нет: резерв без списания —
  // это, возможно, отправленный запрос с потерянным ответом. Считаем запрос
  // потраченным, токены — неизвестными; нулём их не называем.
  for (const item of reservations) {
    const nextRequests = used.requests + item.requests
    const nextUnknown = unknownUsage + item.requests
    if (!Number.isSafeInteger(nextRequests) || !Number.isSafeInteger(nextUnknown) || nextUnknown > nextRequests) return null
    used.requests = nextRequests
    unknownUsage = nextUnknown
    history.push({ id: item.id, eventId: null, outcome: 'unknown', requests: item.requests, tokens: null,
      tokensUnknown: true, elapsedMs: 0, agentIndex: item.agentIndex, kind: item.kind, at: item.at })
    recovered.push(item.id)
    markSeen(seen, `r:${item.id}`)
  }
  while (history.length > MAX_HISTORY) history.shift()
  while (recovered.length > MAX_RECOVERED) recovered.shift()

  return {
    schemaVersion: SCHEMA_VERSION,
    limits,
    deadlineAt,
    used,
    unknownUsage,
    overrides,
    reservations: [],
    history,
    recoveredReservations: recovered,
    events,
    seen: encodeSeen(seen)
  }
}

function readTokens(usage) {
  if (!usage || typeof usage !== 'object' || usage.unknown === true) return null
  if (safe(usage.total_tokens)) return usage.total_tokens
  if (safe(usage.prompt_tokens) && safe(usage.completion_tokens)) {
    const total = usage.prompt_tokens + usage.completion_tokens
    return Number.isSafeInteger(total) ? total : null
  }
  return null
}

function createTaskBudget({ limits, deadlineAt, restored = null, now = Date.now } = {}) {
  const caps = readLimits(limits)
  const wantedDeadline = readDeadline(deadlineAt)
  if (typeof now !== 'function') throw new TypeError('Неверные часы')
  const base = restored ? cleanBudgetState(restored) : null
  if (restored && !base) throw new TypeError('Повреждённое состояние бюджета')

  // Срок продолжения не продлевается: из сохранённого и переданного берётся
  // ранний. Снять срок или отодвинуть его может только новая задача.
  const savedDeadline = base ? base.deadlineAt : null
  const deadline = savedDeadline === null
    ? wantedDeadline
    : (wantedDeadline === null ? savedDeadline : Math.min(savedDeadline, wantedDeadline))

  const used = base ? { ...base.used } : { requests: 0, tokens: 0, ms: 0 }
  let unknownUsage = base ? base.unknownUsage : 0
  let overrides = base ? base.overrides : 0
  const history = base ? base.history.slice() : []
  const recovered = base ? base.recoveredReservations.slice() : []
  const events = base ? base.events.slice() : []
  const seen = base ? decodeSeen(base.seen) : new Uint8Array(SEEN_BYTES)
  if (!seen) throw new TypeError('Повреждённое состояние бюджета')
  const reservations = new Map()

  const trim = (list, max) => { while (list.length > max) list.shift() }

  function reservedTotals() {
    const totals = reservedTotalsOf([...reservations.values()])
    if (!totals) throw new RangeError('Переполнение учёта бюджета')
    return totals
  }

  function remaining(dim) {
    if (!DIMENSIONS.includes(dim)) throw new TypeError(`Неизвестное измерение бюджета: ${dim}`)
    const limit = caps[dim]
    if (limit === null) return null
    return Math.max(0, limit - used[dim] - reservedTotals()[dim])
  }

  function timeLeftMs() {
    return deadline === null ? null : Math.max(0, deadline - now())
  }

  function outOfTime() {
    return deadline !== null && now() >= deadline
  }

  // Резерв — обещание запроса: без него не стартуем. Оценка токенов обязательна,
  // иначе исчерпанный предел обходился бы «нулём». Ноль допустим только явно.
  function reserve(input = {}) {
    if (!validId(input.id)) throw new TypeError('Неверный идентификатор резерва')
    const requests = input.requests === undefined ? 1 : input.requests
    if (!Number.isSafeInteger(requests) || requests < 1) throw new TypeError('Неверное число запросов в резерве')
    if (!safe(input.tokens)) throw new TypeError('Резерв требует явной оценки токенов')

    if (outOfTime()) return { ok: false, error: 'Срок задачи истёк', dimension: 'deadline' }
    const pending = reservations.get(input.id)
    if (pending) return { ok: true, duplicate: true, reservation: copy(pending) }
    // Старый id не должен тихо стать новой попыткой: Bloom помнит его и после
    // вытеснения из журнала. Ложное срабатывание отвергает свежий id — это
    // безопасный отказ, а не списание.
    if (maybeSeen(seen, `r:${input.id}`)) {
      return { ok: false, duplicate: true, error: 'Этот id уже использован; для нового запроса нужен новый id.' }
    }
    if (reservations.size >= MAX_RESERVATIONS) {
      return { ok: false, error: 'Слишком много активных резервов', dimension: 'reservations', limit: MAX_RESERVATIONS }
    }
    if (caps.tokens !== null && unknownUsage > 0 && input.allowUnknown !== true) {
      return { ok: false, error: 'Есть запросы с неизвестным расходом', dimension: 'unknown', unknownUsage }
    }

    const wanted = { requests, tokens: input.tokens }
    const held = reservedTotals()
    for (const dim of DIMENSIONS) {
      const limit = caps[dim]
      if (limit === null) continue
      const left = Math.max(0, limit - used[dim] - held[dim])
      if (left <= 0 || wanted[dim] > left) {
        return { ok: false, error: `Бюджет задачи исчерпан: ${dim}`, dimension: dim, left, requested: wanted[dim] }
      }
    }
    const nextHeld = { requests: held.requests + wanted.requests, tokens: held.tokens + wanted.tokens }
    const aggregate = { requests: used.requests + nextHeld.requests, tokens: used.tokens + nextHeld.tokens }
    if (![nextHeld.requests, nextHeld.tokens, aggregate.requests, aggregate.tokens].every(Number.isSafeInteger)) {
      return { ok: false, error: 'Переполнение суммы резервов', dimension: 'reservations' }
    }

    // Исключение из политики неизвестного расхода — только явное и только на
    // один резерв; в снимке остаётся счётчик таких решений.
    if (unknownUsage > 0 && input.allowUnknown === true) {
      if (!Number.isSafeInteger(overrides + 1)) {
        return { ok: false, error: 'Переполнение счётчика исключений', dimension: 'overrides' }
      }
      overrides += 1
    }
    const item = {
      id: input.id, requests, tokens: input.tokens,
      agentIndex: Number.isInteger(input.agentIndex) && input.agentIndex >= 0 ? input.agentIndex : 0,
      kind: validId(input.kind) ? input.kind : 'agent',
      at: now()
    }
    reservations.set(item.id, item)
    return { ok: true, reservation: copy(item) }
  }

  // Списание по факту: запрос состоялся, даже если провайдер ответил ошибкой
  // или токены неизвестны. Остаток резерва при этом освобождается.
  function settle(input = {}) {
    if (!validId(input.id)) throw new TypeError('Неверный идентификатор резерва')
    if (input.outcome !== undefined && !['completed', 'failed', 'cancelled'].includes(input.outcome)) {
      throw new TypeError('Неверный исход запроса')
    }
    const eventId = validId(input.eventId) ? input.eventId : null
    const eventHash = eventId ? eventHashOf(eventId) : null
    const item = reservations.get(input.id)
    if (!item) {
      const known = maybeSeen(seen, `r:${input.id}`) || (eventHash && events.includes(eventHash))
      return { ok: false, duplicate: Boolean(known), error: known ? 'Событие уже учтено.' : 'Резерва нет.' }
    }
    if (eventHash && events.includes(eventHash)) {
      reservations.delete(item.id)
      markSeen(seen, `r:${item.id}`)
      return { ok: false, duplicate: true, released: true, error: 'Событие уже учтено.' }
    }

    const tokens = readTokens(input.usage)
    const elapsedMs = input.elapsedMs === undefined ? Math.max(0, now() - item.at) : input.elapsedMs
    if (!safe(elapsedMs)) throw new TypeError('Неверная длительность запроса')
    const outcome = input.outcome || 'completed'
    const agentIndex = Number.isInteger(input.agentIndex) && input.agentIndex >= 0 ? input.agentIndex : item.agentIndex

    // Ошибка не должна оставить частичное списание или потерять резерв:
    // сначала считаем весь будущий результат, только потом фиксируем.
    const nextRequests = used.requests + item.requests
    const nextUnknown = tokens === null ? unknownUsage + item.requests : unknownUsage
    const nextTokens = tokens === null ? used.tokens : used.tokens + tokens
    const nextMs = used.ms + elapsedMs
    if (![nextRequests, nextUnknown, nextTokens, nextMs].every(Number.isSafeInteger)) {
      throw new RangeError('Переполнение учёта бюджета')
    }

    reservations.delete(item.id)
    used.requests = nextRequests
    used.tokens = nextTokens
    used.ms = nextMs
    unknownUsage = nextUnknown

    const entry = {
      id: item.id, eventId, outcome, requests: item.requests, tokens, tokensUnknown: tokens === null,
      elapsedMs, agentIndex, kind: validId(input.kind) ? input.kind : item.kind, at: now()
    }
    history.push(entry)
    trim(history, MAX_HISTORY)
    markSeen(seen, `r:${item.id}`)
    if (eventHash) {
      events.push(eventHash)
      trim(events, MAX_EVENTS)
    }
    return { ok: true, charged: { requests: item.requests, tokens, ms: elapsedMs, tokensUnknown: tokens === null }, entry: copy(entry) }
  }

  // Отмена до отправки: запроса не было, резерв возвращается целиком; id
  // остаётся виден, чтобы отменённая попытка не стала новой незаметно.
  function release(input = {}) {
    if (!validId(input.id)) throw new TypeError('Неверный идентификатор резерва')
    const item = reservations.get(input.id)
    if (!item) {
      const known = maybeSeen(seen, `r:${input.id}`)
      return { ok: false, duplicate: Boolean(known), error: known ? 'Резерв уже завершён.' : 'Резерва нет.' }
    }
    reservations.delete(item.id)
    markSeen(seen, `r:${item.id}`)
    return { ok: true, reservation: copy(item) }
  }

  // Только для отказа записи контрольной точки: резерв снимается до отправки,
  // id не помечается — повтор после починенного диска должен пройти.
  function rollback(input = {}) {
    if (!validId(input.id)) throw new TypeError('Неверный идентификатор резерва')
    const item = reservations.get(input.id)
    if (!item) return { ok: false, error: 'Резерва нет.' }
    reservations.delete(item.id)
    return { ok: true, reservation: copy(item) }
  }

  // Позднее уточнение неизвестного расхода. Известное значение не переписывается:
  // то же — идемпотентный повтор, другое — конфликт.
  function correct(input = {}) {
    if (input.id !== undefined && !validId(input.id)) throw new TypeError('Неверный идентификатор события')
    if (input.eventId !== undefined && !validId(input.eventId)) throw new TypeError('Неверный идентификатор события')
    if (!safe(input.tokens)) throw new TypeError('Уточнение требует явного числа токенов')
    if (input.id === undefined && input.eventId === undefined) return { ok: false, error: 'Нужен id или eventId.' }

    const byId = input.id === undefined ? null : history.find(item => item.id === input.id) || null
    const byEvent = input.eventId === undefined ? null : history.find(item => item.eventId === input.eventId) || null
    if (input.id !== undefined && input.eventId !== undefined && byId !== byEvent) {
      return { ok: false, error: 'id и событие указывают на разные записи.' }
    }
    const entry = byEvent || byId
    if (!entry) return { ok: false, error: 'Запись о расходе не найдена.' }
    if (!entry.tokensUnknown) {
      if (entry.tokens === input.tokens) return { ok: false, duplicate: true, tokens: entry.tokens }
      return { ok: false, conflict: true, error: 'Расход уже известен с другим значением.', tokens: entry.tokens }
    }
    if (unknownUsage < entry.requests) throw new RangeError('Учёт неизвестного расхода повреждён')
    const nextTokens = used.tokens + input.tokens
    if (!Number.isSafeInteger(nextTokens)) throw new RangeError('Переполнение учёта бюджета')
    used.tokens = nextTokens
    unknownUsage -= entry.requests
    entry.tokens = input.tokens
    entry.tokensUnknown = false
    return { ok: true, corrected: true, requests: entry.requests, tokens: input.tokens }
  }

  function snapshot() {
    const held = reservedTotals()
    return {
      schemaVersion: SCHEMA_VERSION,
      limits: { ...caps },
      deadlineAt: deadline,
      used: { ...used },
      unknownUsage,
      overrides,
      reserved: held,
      remaining: { requests: remaining('requests'), tokens: remaining('tokens') },
      tokenAccounting: unknownUsage > 0 ? 'incomplete' : 'complete',
      reservations: [...reservations.values()].map(copy),
      history: history.map(item => ({ ...item })),
      recoveredReservations: recovered.slice(),
      events: events.slice(),
      seen: encodeSeen(seen)
    }
  }

  return Object.freeze({
    limits: caps, deadlineAt: deadline, reserve, settle, release, rollback, correct,
    remaining, timeLeftMs, outOfTime, snapshot
  })
}

module.exports = { SCHEMA_VERSION, MAX_RESERVATIONS, MAX_EVENTS, SEEN_BYTES, createTaskBudget, cleanBudgetState }
