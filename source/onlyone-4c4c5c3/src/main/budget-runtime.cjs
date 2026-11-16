'use strict'

// АГ-8, И-2 runtime: обвязка общего бюджета задачи вокруг уже существующих
// запросов к провайдеру. Своего цикла, повторов и таймеров здесь нет: модуль
// только резервирует до вызова, списывает по факту и освобождает неотправленное.
// Бюджет живёт в контрольной точке хода (run-checkpoints.js) и общий для
// ведущего, помощников, повторов и продолжения.
//
// Порядок один:
//   reserve -> провайдер -> settle (запрос состоялся)
//   reserve -> release (запрос не отправлен)
// Отказ резерва и отказ записи контрольной точки до провайдера не доходят.
// Ошибка провайдера — состоявшийся запрос с неизвестным расходом, не ноль;
// отменить это списание можно только явно (`unsentOnError`), когда вызывающий
// точно знает, что запрос не ушёл.
//
// Идентификатор резерва стабилен и называет место запроса:
// `${runId}:${agentIndex}:${invocation}:${step}:${attempt}`. `invocation` —
// конкретный запуск слота: круг ведущего, часть помощника, критика, доработка.
// Без него локальные step/attempt у двух фаз одного агента совпадали, и вторая
// фаза отвергалась как duplicate. Повтор, смена ключа и продолжение по-прежнему
// получают новые attempt/step, а повторная доставка того же события остаётся
// идемпотентной.
//
// Смена ключа внутри openRouterRequest — это отдельная фактическая отправка:
// допуск на неё берёт createAttemptGuard перед каждым fetch, а не один резерв
// вокруг всего запроса.

const ID = /^[A-Za-z0-9_.:-]{1,120}$/
const OUTCOMES = ['completed', 'failed', 'cancelled']

const validId = value => typeof value === 'string' && ID.test(value)
const safe = value => Number.isSafeInteger(value) && value >= 0

function reservationId({ runId, agentIndex = 0, invocation = null, step = 0, attempt = 0, transport = null } = {}) {
  const run = String(runId ?? '')
  if (!validId(run)) throw new TypeError('Неверный идентификатор хода для резерва бюджета')
  for (const [name, value] of [['agentIndex', agentIndex], ['step', step], ['attempt', attempt]]) {
    if (!safe(value)) throw new TypeError(`Неверный ${name} для резерва бюджета`)
  }
  for (const [name, value] of [['invocation', invocation]]) {
    if (value !== null && value !== undefined && !validId(value)) {
      throw new TypeError(`Неверный ${name} для резерва бюджета`)
    }
  }
  // Транспортный повтор — отдельная отправка того же места. Свой суффикс, а не
  // сдвиг номера: попытка вызывающего и номер ротации не должны совпасть ни при
  // каком числе ключей.
  if (transport !== null && transport !== undefined && !(safe(transport) && transport >= 2)) {
    throw new TypeError('Неверный номер транспортной попытки')
  }
  const scope = invocation === null || invocation === undefined ? '' : `${invocation}:`
  const retry = transport === null || transport === undefined ? '' : `:t${transport}`
  const id = `${run}:${agentIndex}:${scope}${step}:${attempt}${retry}`
  if (!validId(id)) throw new TypeError('Идентификатор резерва бюджета слишком длинный')
  return id
}

// Отказ ядра в один словарь: причина, измерение, остаток и человеческая строка.
// `no_budget` — не отказ, а выключенный бюджет: старые входы идут как раньше.
function refused(result) {
  const error = String(result?.error || '')
  if (error === 'no_budget') return { ok: true, enabled: false, id: null }
  if (error === 'not_durable') {
    return { ok: false, enabled: true, called: false, reason: 'not_durable', durable: false,
      message: 'Резерв бюджета не записан на диск — запрос не отправлен.' }
  }
  if (result?.duplicate) {
    return { ok: false, enabled: true, called: false, reason: 'duplicate', duplicate: true,
      message: error || 'Этот запрос уже зарезервирован или учтён — повторно он не отправляется.' }
  }
  if (result?.dimension === 'deadline') {
    return { ok: false, enabled: true, called: false, reason: 'deadline', dimension: 'deadline',
      message: error || 'Срок задачи истёк — запрос не отправлен.' }
  }
  if (result?.dimension === 'unknown') {
    return { ok: false, enabled: true, called: false, reason: 'unknown_usage', dimension: 'unknown',
      unknownUsage: result.unknownUsage,
      message: `${error || 'Есть запросы с неизвестным расходом'}: свободный остаток из потерянного расхода не выдаётся. ` +
        'Продолжение — только явным разрешением allowUnknown.' }
  }
  if (result?.dimension === 'requests' || result?.dimension === 'tokens') {
    const left = safe(result.left) ? result.left : 0
    const wanted = safe(result.requested) ? `, нужно ${result.requested}` : ''
    return { ok: false, enabled: true, called: false, reason: 'budget_exhausted', dimension: result.dimension,
      left, requested: result.requested,
      message: `${error || 'Бюджет задачи исчерпан'}: осталось ${left}${wanted} — запрос не отправлен.` }
  }
  return { ok: false, enabled: true, called: false, reason: 'budget_refused',
    message: error || 'Бюджет задачи отклонил резерв — запрос не отправлен.' }
}

// Допуск на каждую фактическую отправку внутри openRouterRequest. Ротация
// ключей, сетевой повтор и fallback — разные отправки: каждая берёт свой резерв,
// поэтому предел запросов нельзя обойти вторым ключом. Первая отправка может
// быть уже зарезервирована вызывающим (`first`): тогда второй резерв на неё не
// берётся и двойного списания нет. Неудачная отправка списывается как запрос с
// неизвестным расходом, а не как ноль; доставленный ответ отдаёт свой id
// вызывающему через `winner`, чтобы расход списали по факту.
function createAttemptGuard(budget, input = {}, first = null) {
  if (!budget || typeof budget.reserve !== 'function') return null
  const base = {
    agentIndex: input.agentIndex === undefined ? 0 : input.agentIndex,
    kind: input.kind,
    invocation: input.invocation === undefined ? null : input.invocation,
    step: input.step === undefined ? 0 : input.step,
    attempt: input.attempt === undefined ? 0 : input.attempt,
    tokens: input.tokens
  }
  let attempts = 0
  let sent = null
  const inherit = handle => ({
    ok: true, enabled: true, id: handle?.id ?? null, inherited: true
  })
  return {
    get attempts() { return attempts },
    get winner() { return sent },
    // Перед fetch. Отказ означает: эта отправка не состоялась и не состоится.
    before() {
      attempts += 1
      if (attempts === 1 && first?.id) return inherit(first)
      // Вторая и следующие отправки того же места (другой ключ, сетевой повтор)
      // — действие приложения, а не решение модели: первая уже списана как
      // неизвестная, и без разрешения задача закрывалась бы навсегда.
      return budget.reserve({ ...base, transport: attempts, allowUnknown: attempts > 1 })
    },
    sent(handle) { sent = handle },
    // Ответ провайдера пришёл с ошибкой или сеть оборвалась после попытки.
    failed(handle, outcome = 'failed') {
      if (!handle?.id) return { ok: true, skipped: true }
      return budget.settle({
        id: handle.id, usage: null, agentIndex: base.agentIndex,
        outcome: outcome === 'cancelled' ? 'cancelled' : 'failed'
      })
    }
  }
}

function createBudgetRuntime({ checkpoint, runId = null, budgetDecision = null } = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') throw new TypeError('Нужна контрольная точка хода с бюджетом')
  for (const method of ['budget', 'reserveBudget', 'settleBudget', 'releaseBudget', 'correctBudget']) {
    if (typeof checkpoint[method] !== 'function') throw new TypeError(`Контрольная точка не умеет ${method}`)
  }
  const prefix = String(runId || checkpoint.runId || '')
  if (!validId(prefix)) throw new TypeError('Неверный идентификатор хода для бюджета')
  // Явное решение хода продолжить с неизвестным расходом (например, человек
  // продолжил прерванную задачу). Отдельный транспортный повтор разрешает себя
  // сам; больше никто, а модель — никогда.
  const continueUnknown = budgetDecision === 'continue-unknown'

  // Резерв до запроса. Оценка токенов обязательна: без неё исчерпанный предел
  // обходился бы «нулём». Остальные поля называют место запроса в журнале.
  function reserve(input = {}) {
    if (!safe(input.tokens)) throw new TypeError('Резерв бюджета требует явной оценки токенов: tokens')
    const agentIndex = input.agentIndex === undefined ? 0 : input.agentIndex
    const id = reservationId({
      runId: prefix, agentIndex,
      invocation: input.invocation === undefined ? null : input.invocation,
      step: input.step === undefined ? 0 : input.step,
      attempt: input.attempt === undefined ? 0 : input.attempt,
      transport: input.transport === undefined ? null : input.transport
    })
    const result = checkpoint.reserveBudget({
      id,
      requests: input.requests === undefined ? 1 : input.requests,
      tokens: input.tokens,
      agentIndex,
      kind: validId(input.kind) ? input.kind : 'agent',
      allowUnknown: continueUnknown || input.allowUnknown === true
    })
    if (!result || result.ok !== true || result.duplicate) {
      return refused(result?.ok === true ? { ...result, duplicate: true } : result)
    }
    return { ok: true, enabled: true, id, durable: result.durable !== false }
  }

  // Списание по факту. `usage: null` — расход неизвестен, а не ноль.
  function settle(input = {}) {
    if (!input.id) return { ok: true, enabled: false, skipped: true }
    if (!validId(input.id)) throw new TypeError('Неверный идентификатор резерва бюджета')
    const result = checkpoint.settleBudget({
      id: input.id,
      usage: input.usage === undefined ? null : input.usage,
      outcome: OUTCOMES.includes(input.outcome) ? input.outcome : 'completed',
      ...(validId(input.eventId) ? { eventId: input.eventId } : {}),
      ...(input.elapsedMs === undefined ? {} : { elapsedMs: input.elapsedMs }),
      ...(input.agentIndex === undefined ? {} : { agentIndex: input.agentIndex })
    })
    if (!result || result.error === 'no_budget') return { ok: true, enabled: false, skipped: true }
    if (result.ok !== true) {
      return { ok: false, enabled: true, reason: result.duplicate ? 'duplicate' : 'settle_refused',
        duplicate: Boolean(result.duplicate), released: Boolean(result.released),
        message: result.error || 'Списание бюджета отклонено.' }
    }
    return { ok: true, enabled: true, durable: result.durable !== false, charged: result.charged, entry: result.entry }
  }

  // Запрос не отправлен: резерв возвращается целиком, расход не появляется.
  function release(input = {}) {
    if (!input.id) return { ok: true, enabled: false, skipped: true }
    if (!validId(input.id)) throw new TypeError('Неверный идентификатор резерва бюджета')
    const result = checkpoint.releaseBudget({ id: input.id })
    if (!result || result.error === 'no_budget') return { ok: true, enabled: false, skipped: true }
    if (result.ok !== true) {
      return { ok: false, enabled: true, reason: result.duplicate ? 'duplicate' : 'release_refused',
        duplicate: Boolean(result.duplicate), message: result.error || 'Освобождение резерва отклонено.' }
    }
    return { ok: true, enabled: true, durable: result.durable !== false, reservation: result.reservation }
  }

  // Позднее уточнение неизвестного расхода (идемпотентно, см. task-budget.cjs).
  function correct(input = {}) {
    const result = checkpoint.correctBudget({
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      tokens: input.tokens
    })
    if (!result || result.error === 'no_budget') return { ok: true, enabled: false, skipped: true }
    return { enabled: true, ...result }
  }

  // Один запрос целиком: резерв, провайдер, списание. Для потоковых ответов не
  // годится — там списание делается после чтения потока, вручную.
  async function run(input = {}, provider) {
    if (typeof provider !== 'function') throw new TypeError('Нужен вызов провайдера')
    if (input.signal?.aborted) {
      return { ok: false, enabled: true, called: false, reason: 'aborted',
        message: 'Запрос отменён до резерва — провайдер не вызывался.' }
    }
    const guard = reserve(input)
    if (!guard.ok) return { ...guard, called: false }

    if (!guard.enabled) {
      try {
        return { ok: true, enabled: false, called: true, value: await provider(null) }
      } catch (error) {
        return { ok: false, enabled: false, called: true,
          reason: input.signal?.aborted ? 'aborted' : 'provider_failed', error, message: error?.message }
      }
    }

    // Провайдер получает допуск на каждую свою отправку: один вызов
    // openRouterRequest может сделать несколько fetch (ротация ключей), и
    // каждый обязан пройти через бюджет.
    const transport = createAttemptGuard({ reserve, settle, release }, input, guard)
    let value
    try {
      value = await provider(transport)
    } catch (error) {
      if (error?.budgetRefusal) return { ...error.budgetRefusal, ok: false, enabled: true, called: true }
      const outcome = input.signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed'
      const unsent = typeof input.unsentOnError === 'function'
        ? input.unsentOnError(error) === true
        : input.unsentOnError === true
      // Отправки не было: освобождается только резерв, которого ещё не касался
      // транспорт (он отпускает свои попытки сам).
      if (unsent && !transport?.attempts) {
        return { ok: false, enabled: true, called: false, reason: 'provider_failed', error,
          released: release({ id: guard.id }), message: error?.message }
      }
      // Доставленный ответ, но разбор упал уже после него: списывается та
      // отправка, которую транспорт признал доставленной.
      if (transport?.winner?.id) {
        return { ok: false, enabled: true, called: true, reason: 'provider_failed', error,
          settled: settle({ id: transport.winner.id, usage: null, outcome }), message: error?.message }
      }
      // Каждую неудачную отправку транспорт уже списал сам; второй раз та же
      // попытка не списывается.
      if (transport?.attempts) {
        return { ok: false, enabled: true, called: true, reason: 'provider_failed', error,
          settled: { ok: true, settledByTransport: true }, message: error?.message }
      }
      return { ok: false, enabled: true, called: true, reason: 'provider_failed', error,
        settled: settle({ id: guard.id, usage: null, outcome }), message: error?.message }
    }

    const usage = typeof input.usageOf === 'function' ? input.usageOf(value) : (value?.usage ?? null)
    // Списывается та отправка, которая действительно доставила ответ: при
    // ротации это может быть не первая.
    const settled = settle({ id: transport?.winner?.id || guard.id, usage, outcome: 'completed',
      eventId: input.eventId, agentIndex: input.agentIndex })
    return { ok: true, enabled: true, called: true, value, usage, settled }
  }

  return Object.freeze({
    reserve, settle, release, correct, run,
    budget: () => checkpoint.budget(),
    remaining: () => {
      const snapshot = checkpoint.budget()
      return snapshot ? snapshot.remaining : { requests: null, tokens: null }
    }
  })
}

// Тот же вызов там, где обвязки может не быть (ход не из send-message, тесты,
// подставной провайдер): без бюджета — прозрачный проход, с бюджетом — run.
function runWithBudget(budget, input, provider) {
  if (typeof provider !== 'function') throw new TypeError('Нужен вызов провайдера')
  if (budget && typeof budget.run === 'function') return budget.run(input, provider)
  return (async () => {
    try {
      return { ok: true, enabled: false, called: true, value: await provider(null) }
    } catch (error) {
      return { ok: false, enabled: false, called: true, reason: 'provider_failed', error, message: error?.message }
    }
  })()
}

module.exports = { createBudgetRuntime, createAttemptGuard, reservationId, runWithBudget }
