'use strict'

// Бюджет задачи: настройки пределов (АГ-8, И-4). Модуль чистый — ни диска, ни
// Electron: главный процесс читает и пишет один ключ electron-store, а сюда
// отдаёт недоверенный объект на проверку.
//
// Политика смены настроек:
// - новые пределы действуют на НОВУЮ задачу (явный старт хода);
// - продолжение прерванной задачи берёт сохранённые пределы и срок из
//   контрольной точки — смена настроек не обнуляет расход и не расширяет
//   остаток (иначе «продолжить» после каждого падения давало бы новый бюджет);
// - изменить текущую задачу можно только явным решением (`explicit`): пределы
//   берутся из настроек, а срок не отодвигается — побеждает ранний из
//   сохранённого и нового, снять сохранённый срок тоже нельзя.
//
// null — «без предела», а не ноль: ноль запрещён, чтобы опечатка в поле не
// выглядела как исчерпанный бюджет. Часы передаются явно (число или функция),
// чтобы проверки не зависели от системного времени.

const DIMENSIONS = Object.freeze(['requests', 'tokens'])
const FIELDS = Object.freeze([...DIMENSIONS, 'deadlineMinutes'])

// Явные значения по умолчанию: задача без настроек не должна быть бесконечной.
// Человек может поставить null в любом поле — тогда предела нет.
const DEFAULT_SETTINGS = Object.freeze({ requests: 60, tokens: 250_000, deadlineMinutes: 180 })
const MAX_SETTINGS = Object.freeze({ requests: 100_000, tokens: 100_000_000, deadlineMinutes: 7 * 24 * 60 })
const MINUTE = 60 * 1000

const POLICY = Object.freeze({
  newTask: 'settings',
  continuation: 'saved',
  explicit: 'settings-with-earliest-deadline',
  text: 'Новые пределы действуют на новую задачу. Продолжение тратит сохранённый остаток и срок; ' +
    'изменить текущую задачу можно только явным решением, и срок при этом не отодвигается.'
})

const own = (object, key) => Object.hasOwn(object, key)
const issue = (field, code) => ({ field, code })
const isLimit = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max

function clockNow (now) {
  if (typeof now === 'function') return now()
  if (Number.isSafeInteger(now) && now >= 0) return now
  throw new TypeError('Неверные часы бюджета')
}

function checkField (field, value) {
  if (value === null) return { ok: true, value: null }
  if (!isLimit(value, MAX_SETTINGS[field])) {
    const code = value === 0 ? 'zero'
      : typeof value !== 'number' || !Number.isFinite(value) ? 'not-a-number'
        : !Number.isInteger(value) ? 'not-an-integer'
          : value < 0 ? 'negative' : 'out-of-range'
    return { ok: false, code }
  }
  return { ok: true, value }
}

// Возвращает { ok, settings, errors }. При ошибке каждое поле получает
// значение по умолчанию: частично записанные пределы не должны молча стать
// нулём или старым значением другого поля.
function normalizeBudgetSettings (raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, settings: Object.freeze({ ...DEFAULT_SETTINGS }), errors: [] }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, settings: Object.freeze({ ...DEFAULT_SETTINGS }), errors: [issue('settings', 'invalid')] }
  }
  const errors = []
  for (const key of Object.keys(raw)) {
    if (!FIELDS.includes(key)) errors.push(issue(key, 'unknown'))
  }
  const settings = {}
  for (const field of FIELDS) {
    const value = own(raw, field) ? raw[field] : DEFAULT_SETTINGS[field]
    const checked = checkField(field, value)
    if (!checked.ok) errors.push(issue(field, checked.code))
    settings[field] = checked.ok ? checked.value : DEFAULT_SETTINGS[field]
  }
  return { ok: errors.length === 0, settings: Object.freeze(settings), errors }
}

// Пределы и абсолютный срок для НОВОЙ задачи. Ошибка настроек — исключение:
// начинать задачу с догадкой о пределах нельзя.
function budgetTemplate (raw, now = Date.now) {
  const checked = normalizeBudgetSettings(raw)
  if (!checked.ok) {
    const error = new TypeError('Неверные настройки бюджета задачи')
    error.errors = checked.errors
    throw error
  }
  const at = clockNow(now)
  const minutes = checked.settings.deadlineMinutes
  return {
    ok: true,
    settings: checked.settings,
    limits: Object.freeze({ requests: checked.settings.requests, tokens: checked.settings.tokens }),
    deadlineAt: minutes === null ? null : at + minutes * MINUTE
  }
}

function readSaved (saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new TypeError('Повреждённое состояние бюджета задачи')
  const limits = saved.limits
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new TypeError('Повреждённое состояние бюджета задачи')
  const clean = {}
  for (const dim of DIMENSIONS) {
    if (!own(limits, dim)) throw new TypeError('Повреждённое состояние бюджета задачи')
    if (limits[dim] !== null && !(Number.isSafeInteger(limits[dim]) && limits[dim] >= 0)) {
      throw new TypeError('Повреждённое состояние бюджета задачи')
    }
    clean[dim] = limits[dim]
  }
  if (!own(saved, 'deadlineAt')) throw new TypeError('Повреждённое состояние бюджета задачи')
  if (saved.deadlineAt !== null && !(Number.isSafeInteger(saved.deadlineAt) && saved.deadlineAt >= 0)) {
    throw new TypeError('Повреждённое состояние бюджета задачи')
  }
  return { limits: Object.freeze(clean), deadlineAt: saved.deadlineAt }
}

// Срок не продлевается: null — «без срока», поэтому ранний из двух, а не min().
function earliestDeadline (saved, wanted) {
  if (saved === null) return wanted
  if (wanted === null) return saved
  return Math.min(saved, wanted)
}

function sameLimits (a, b) {
  return DIMENSIONS.every(dim => a[dim] === b[dim])
}

// План бюджета для старта хода. saved — checkpoint.task.budget (снимок
// task-budget.cjs) или null. explicit — осознанное решение человека применить
// новые пределы к текущей задаче.
//
// next — то, что получит следующая НОВАЯ задача: настройки уже применены.
function resolveBudget ({ settings, saved = null, now = Date.now, explicit = false } = {}) {
  const fresh = budgetTemplate(settings, now)
  const next = { limits: fresh.limits, deadlineAt: fresh.deadlineAt }
  if (saved === null || saved === undefined) {
    return {
      ok: true, source: 'new', appliesToCurrent: false, differs: false,
      settings: fresh.settings, limits: fresh.limits, deadlineAt: fresh.deadlineAt, next
    }
  }
  const held = readSaved(saved)
  if (explicit !== true) {
    return {
      ok: true, source: 'continuation', appliesToCurrent: false,
      differs: !sameLimits(held.limits, fresh.limits) || held.deadlineAt !== fresh.deadlineAt,
      settings: fresh.settings, limits: held.limits, deadlineAt: held.deadlineAt, next
    }
  }
  return {
    ok: true, source: 'explicit', appliesToCurrent: true, differs: false,
    settings: fresh.settings, limits: fresh.limits,
    deadlineAt: earliestDeadline(held.deadlineAt, fresh.deadlineAt), next
  }
}

// Плоская запись для electron-store: ключ без точки, только известные поля.
function storeRecord (raw) {
  const checked = normalizeBudgetSettings(raw)
  if (!checked.ok) {
    const error = new TypeError('Неверные настройки бюджета задачи')
    error.errors = checked.errors
    throw error
  }
  return { requests: checked.settings.requests, tokens: checked.settings.tokens, deadlineMinutes: checked.settings.deadlineMinutes }
}

module.exports = {
  DIMENSIONS, FIELDS, DEFAULT_SETTINGS, MAX_SETTINGS, MINUTE, POLICY,
  normalizeBudgetSettings, budgetTemplate, resolveBudget, storeRecord
}
