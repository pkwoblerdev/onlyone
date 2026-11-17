'use strict'
// АГ-8, И-2 runtime: общий бюджет подключается к уже существующим запросам.
// Резерв — до вызова провайдера; отказ и несохранённый резерв до провайдера не
// доходят. Повтор, смена ключа и продолжение идут на том же остатке, а не с
// нового бюджета. Фактический расход (в том числе неизвестный) списывается,
// неотправленный запрос освобождается, позднее уточнение идемпотентно.
const assert = require('node:assert/strict')
const { createTaskBudget } = require('../src/main/task-budget.cjs')
const { createBudgetRuntime, reservationId, runWithBudget } = require('../src/main/budget-runtime.cjs')

let checks = 0
const failures = []
const check = async (name, fn) => {
  try { await fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

const clockAt = start => {
  let value = start
  return { now: () => value, advance: delta => { value += delta } }
}

// Поддельная контрольная точка: тот же контракт, что у run-checkpoints.start,
// но бюджет в памяти. `writable: false` повторяет отказ диска: резерв снимается,
// id не помечается — повтор после починенного диска должен пройти.
function fakeCheckpoint({ limits = { requests: 10, tokens: 1000 }, deadlineAt = null, clock = clockAt(1000),
  writable = true, enabled = true, restored = null } = {}) {
  const budget = enabled ? createTaskBudget({ limits, deadlineAt, restored, now: clock.now }) : null
  const calls = []
  return {
    runId: 'run-1',
    calls,
    clock,
    setWritable(value) { writable = value },
    budget: () => (budget ? budget.snapshot() : null),
    reserveBudget(input) {
      calls.push({ method: 'reserve', input })
      if (!budget) return { ok: false, error: 'no_budget' }
      const result = budget.reserve(input)
      if (!result.ok || result.duplicate) return result
      if (!writable) {
        budget.rollback({ id: input.id })
        return { ok: false, error: 'not_durable', durable: false }
      }
      return { ...result, durable: true }
    },
    settleBudget(input) {
      calls.push({ method: 'settle', input })
      if (!budget) return { ok: false, error: 'no_budget' }
      const result = budget.settle(input)
      if (result.ok || result.released) return { ...result, durable: writable }
      return result
    },
    releaseBudget(input) {
      calls.push({ method: 'release', input })
      if (!budget) return { ok: false, error: 'no_budget' }
      const result = budget.release(input)
      if (result.ok) return { ...result, durable: writable }
      return result
    },
    correctBudget(input) {
      calls.push({ method: 'correct', input })
      if (!budget) return { ok: false, error: 'no_budget' }
      const result = budget.correct(input)
      if (result.ok) return { ...result, durable: writable }
      return result
    }
  }
}

function fakeProvider({ value = { usage: { total_tokens: 25 } }, error = null } = {}) {
  const provider = async () => {
    provider.calls++
    if (error) throw error
    return value
  }
  provider.calls = 0
  return provider
}

const snap = checkpoint => checkpoint.budget()

;(async () => {
  await check('id резерва стабилен: runId:agentIndex:step:attempt', () => {
    assert.equal(reservationId({ runId: 'abc-1', agentIndex: 2, step: 5, attempt: 1 }), 'abc-1:2:5:1')
    // Фаза запуска называет место запроса: части и критика одного агента не делят id.
    assert.equal(reservationId({ runId: 'abc-1', agentIndex: 2, invocation: 'r1-part-3', step: 0, attempt: 0 }),
      'abc-1:2:r1-part-3:0:0')
    assert.throws(() => reservationId({ runId: 'abc-1', invocation: 'плохая фаза' }), /invocation/i)
    assert.throws(() => reservationId({ runId: 'плохой ход' }), /идентификатор/i)
    assert.throws(() => reservationId({ runId: 'abc', step: -1 }), /step/i)
  })

  await check('успешный запрос: резерв на диске раньше провайдера, списание по факту', async () => {
    const checkpoint = fakeCheckpoint()
    const budget = createBudgetRuntime({ checkpoint })
    const provider = fakeProvider({ value: { usage: { total_tokens: 25 } } })
    const result = await budget.run({ agentIndex: 2, kind: 'helper', step: 5, attempt: 1, tokens: 40 }, provider)
    assert.equal(result.ok, true)
    assert.equal(provider.calls, 1)
    assert.deepEqual(checkpoint.calls.map(call => call.method), ['reserve', 'settle'])
    const reserved = checkpoint.calls[0].input
    assert.equal(reserved.id, 'run-1:2:5:1')
    assert.equal(reserved.tokens, 40)
    assert.equal(reserved.agentIndex, 2)
    assert.equal(reserved.kind, 'helper')
    const snapshot = snap(checkpoint)
    assert.equal(snapshot.used.requests, 1)
    assert.equal(snapshot.used.tokens, 25)
    assert.equal(snapshot.reserved.tokens, 0)
  })

  await check('запрос сверх лимита не доходит до провайдера', async () => {
    const checkpoint = fakeCheckpoint({ limits: { requests: 10, tokens: 50 } })
    const budget = createBudgetRuntime({ checkpoint })
    const first = fakeProvider({ value: { usage: { total_tokens: 40 } } })
    assert.equal((await budget.run({ step: 0, tokens: 40 }, first)).ok, true)
    assert.equal(first.calls, 1)

    const denied = fakeProvider()
    const result = await budget.run({ step: 1, tokens: 20 }, denied)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'budget_exhausted')
    assert.equal(result.dimension, 'tokens')
    assert.equal(denied.calls, 0, 'провайдер вызван при отказе')
    assert.equal(snap(checkpoint).used.requests, 1)
  })

  await check('отказ записи (not_durable): резерв не остался, провайдер не вызван', async () => {
    const checkpoint = fakeCheckpoint({ writable: false })
    const budget = createBudgetRuntime({ checkpoint })
    const provider = fakeProvider()
    const result = await budget.run({ step: 0, tokens: 10 }, provider)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_durable')
    assert.equal(provider.calls, 0)
    assert.equal(snap(checkpoint).used.requests, 0)
    assert.equal(snap(checkpoint).reservations.length, 0)

    checkpoint.setWritable(true)
    const retried = await budget.run({ step: 0, tokens: 10 }, provider)
    assert.equal(retried.ok, true, 'id снятого резерва остался запрещённым')
    assert.equal(provider.calls, 1)
  })

  await check('повтор с тем же id не отправляет запрос второй раз', async () => {
    const checkpoint = fakeCheckpoint()
    const budget = createBudgetRuntime({ checkpoint })
    const provider = fakeProvider({ value: { usage: { total_tokens: 5 } } })
    assert.equal((await budget.run({ step: 3, attempt: 0, tokens: 10 }, provider)).ok, true)
    const duplicate = await budget.run({ step: 3, attempt: 0, tokens: 10 }, provider)
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.reason, 'duplicate')
    assert.equal(provider.calls, 1)
    assert.equal(snap(checkpoint).used.requests, 1)
  })

  await check('неизвестный расход не ноль; продолжение — только явным разрешением', async () => {
    const checkpoint = fakeCheckpoint({ limits: { requests: 10, tokens: 100 } })
    const budget = createBudgetRuntime({ checkpoint })
    const silent = fakeProvider({ value: {} })
    assert.equal((await budget.run({ step: 0, tokens: 40 }, silent)).ok, true)
    let snapshot = snap(checkpoint)
    assert.equal(snapshot.used.tokens, 0)
    assert.equal(snapshot.used.requests, 1)
    assert.equal(snapshot.unknownUsage, 1)

    const denied = fakeProvider()
    const refused = await budget.run({ step: 1, tokens: 10 }, denied)
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'unknown_usage')
    assert.equal(denied.calls, 0)

    const allowed = fakeProvider({ value: { usage: { total_tokens: 5 } } })
    const continued = await budget.run({ step: 1, attempt: 1, tokens: 10, allowUnknown: true }, allowed)
    assert.equal(continued.ok, true)
    assert.equal(allowed.calls, 1)
    snapshot = snap(checkpoint)
    assert.equal(snapshot.used.requests, 2)
    assert.equal(snapshot.used.tokens, 5)
    assert.equal(snapshot.unknownUsage, 1)
  })

  await check('повтор, смена ключа и продолжение не возвращают бюджет', async () => {
    const clock = clockAt(1000)
    const checkpoint = fakeCheckpoint({ clock })
    const budget = createBudgetRuntime({ checkpoint })
    await budget.run({ step: 4, attempt: 0, tokens: 40 }, fakeProvider({ value: { usage: { total_tokens: 40 } } }))
    // Провайдер без допуска на отправку: старый вход платит один резерв за
    // вызов. Настоящая ротация ключей внутри openRouterRequest проверяется в
    // test-budget-attempts, где каждая отправка берёт свой допуск.
    const rotating = fakeProvider({ value: { usage: { total_tokens: 30 } } })
    await budget.run({ step: 4, attempt: 1, tokens: 40 }, async () => {
      rotating.calls++
      return rotating()
    })
    const snapshot = snap(checkpoint)
    assert.equal(snapshot.used.requests, 2)
    assert.equal(snapshot.used.tokens, 70)

    // Продолжение хода: бюджет восстанавливается из снимка, остаток тот же.
    const resumedCheckpoint = fakeCheckpoint({ clock, restored: snapshot })
    const resumed = createBudgetRuntime({ checkpoint: resumedCheckpoint })
    const continued = await resumed.run({ step: 5, attempt: 0, tokens: 40 },
      fakeProvider({ value: { usage: { total_tokens: 20 } } }))
    assert.equal(continued.ok, true)
    assert.equal(snap(resumedCheckpoint).used.requests, 3)
    assert.equal(snap(resumedCheckpoint).used.tokens, 90)
  })

  await check('ведущий и помощники тратят один общий бюджет', async () => {
    const checkpoint = fakeCheckpoint()
    const budget = createBudgetRuntime({ checkpoint })
    await budget.run({ agentIndex: 0, kind: 'agent', step: 0, tokens: 30 },
      fakeProvider({ value: { usage: { total_tokens: 10 } } }))
    await budget.run({ agentIndex: 1, kind: 'helper', step: 0, tokens: 30 },
      fakeProvider({ value: { usage: { total_tokens: 20 } } }))
    const snapshot = snap(checkpoint)
    assert.equal(snapshot.used.requests, 2)
    assert.equal(snapshot.used.tokens, 30)
    assert.equal(snapshot.reservations.length, 0)
  })

  await check('release освобождает неотправленный запрос и не списывает его', async () => {
    const checkpoint = fakeCheckpoint({ limits: { requests: 10, tokens: 100 } })
    const budget = createBudgetRuntime({ checkpoint })
    const guard = budget.reserve({ step: 0, attempt: 0, tokens: 60 })
    assert.equal(guard.ok, true)
    assert.equal(budget.budget().reserved.tokens, 60)
    assert.equal(budget.release({ id: guard.id }).ok, true)
    const snapshot = snap(checkpoint)
    assert.equal(snapshot.used.requests, 0)
    assert.equal(snapshot.used.tokens, 0)
    assert.equal(snapshot.reserved.tokens, 0)
    assert.equal(snapshot.remaining.tokens, 100)
    assert.equal(budget.reserve({ step: 0, attempt: 0, tokens: 60 }).reason, 'duplicate')
    assert.equal(budget.reserve({ step: 0, attempt: 1, tokens: 60 }).ok, true)
  })

  await check('событие списывается один раз; позднее уточнение идемпотентно', async () => {
    const checkpoint = fakeCheckpoint({ limits: { requests: 10, tokens: 100 } })
    const budget = createBudgetRuntime({ checkpoint })
    await budget.run({ step: 0, tokens: 40, eventId: 'evt-1' }, fakeProvider({ value: {} }))
    assert.equal(snap(checkpoint).unknownUsage, 1)
    const corrected = budget.correct({ eventId: 'evt-1', tokens: 33 })
    assert.equal(corrected.ok, true)
    assert.equal(snap(checkpoint).used.tokens, 33)
    assert.equal(snap(checkpoint).unknownUsage, 0)
    assert.equal(budget.correct({ eventId: 'evt-1', tokens: 33 }).duplicate, true)
    assert.equal(budget.correct({ eventId: 'evt-1', tokens: 34 }).conflict, true)
    assert.equal(snap(checkpoint).used.tokens, 33)

    const guard = budget.reserve({ step: 1, tokens: 10 })
    assert.equal(budget.settle({ id: guard.id, usage: { total_tokens: 7 }, eventId: 'evt-2' }).ok, true)
    assert.equal(budget.settle({ id: guard.id, usage: { total_tokens: 7 }, eventId: 'evt-2' }).duplicate, true)
    assert.equal(snap(checkpoint).used.requests, 2)
    assert.equal(snap(checkpoint).used.tokens, 40)
  })

  await check('ошибка провайдера списывается как неизвестная; заведомо неотправленный — освобождается', async () => {
    const checkpoint = fakeCheckpoint()
    const budget = createBudgetRuntime({ checkpoint })
    const failed = await budget.run({ step: 0, tokens: 10 }, fakeProvider({ error: Error('сеть упала') }))
    assert.equal(failed.ok, false)
    assert.equal(failed.reason, 'provider_failed')
    assert.equal(failed.error.message, 'сеть упала')
    assert.equal(snap(checkpoint).used.requests, 1)
    assert.equal(snap(checkpoint).unknownUsage, 1)

    const unsent = await budget.run({ step: 1, tokens: 10, allowUnknown: true, unsentOnError: true },
      fakeProvider({ error: Error('нет ключа') }))
    assert.equal(unsent.ok, false)
    assert.equal(unsent.released.ok, true)
    assert.equal(snap(checkpoint).used.requests, 1)
    assert.equal(snap(checkpoint).reserved.requests, 0)
  })

  await check('срок задачи: запрос после deadline не уходит провайдеру', async () => {
    const clock = clockAt(1000)
    const checkpoint = fakeCheckpoint({ clock, deadlineAt: 1500 })
    const budget = createBudgetRuntime({ checkpoint })
    clock.advance(600)
    const provider = fakeProvider()
    const result = await budget.run({ step: 0, tokens: 10 }, provider)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'deadline')
    assert.equal(provider.calls, 0)
  })

  await check('без бюджета — прозрачный проход; runWithBudget терпит отсутствие обвязки', async () => {
    const checkpoint = fakeCheckpoint({ enabled: false })
    const budget = createBudgetRuntime({ checkpoint })
    const provider = fakeProvider()
    const result = await budget.run({ step: 0, tokens: 10 }, provider)
    assert.equal(result.ok, true)
    assert.equal(result.enabled, false)
    assert.equal(provider.calls, 1)

    const bare = fakeProvider({ value: { usage: { total_tokens: 1 } } })
    const direct = await runWithBudget(null, { step: 0, tokens: 10 }, bare)
    assert.equal(direct.ok, true)
    assert.equal(bare.calls, 1)
  })

  await check('явная оценка обязательна, а отмена до резерва не тратит бюджет', async () => {
    const checkpoint = fakeCheckpoint()
    const budget = createBudgetRuntime({ checkpoint })
    assert.throws(() => budget.reserve({ step: 0 }), /оценк/i)
    assert.throws(() => budget.reserve({ step: 0, tokens: -1 }), /оценк/i)

    const controller = new AbortController()
    controller.abort()
    const provider = fakeProvider()
    const aborted = await budget.run({ step: 0, tokens: 10, signal: controller.signal }, provider)
    assert.equal(aborted.ok, false)
    assert.equal(aborted.reason, 'aborted')
    assert.equal(provider.calls, 0)
    assert.equal(snap(checkpoint).used.requests, 0)
    assert.equal(checkpoint.calls.length, 0)
  })

  await check('отмена после возможной отправки — честный учёт, до отправки — освобождение', async () => {
    const checkpoint = fakeCheckpoint()
    const budget = createBudgetRuntime({ checkpoint })
    const controller = new AbortController()
    const inflight = await budget.run({ step: 0, tokens: 10, signal: controller.signal }, async () => {
      controller.abort()
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    assert.equal(inflight.ok, false)
    assert.equal(inflight.reason, 'provider_failed')
    assert.equal(snap(checkpoint).used.requests, 1, 'отправка могла состояться — запрос учтён')
    assert.equal(snap(checkpoint).unknownUsage, 1, 'расход неизвестен, а не ноль')
    assert.equal(snap(checkpoint).reservations.length, 0)

    const before = fakeCheckpoint()
    const early = createBudgetRuntime({ checkpoint: before })
    const aborted = new AbortController()
    aborted.abort()
    const calls = fakeProvider()
    assert.equal((await early.run({ step: 0, tokens: 10, signal: aborted.signal }, calls)).reason, 'aborted')
    assert.equal(calls.calls, 0)
    assert.equal(before.calls.length, 0, 'до отправки резерв не создаётся')
  })

  if (failures.length) {
    console.error(`ПРОВАЛЕНО ${failures.length}: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
})().catch(error => { console.error(error); process.exitCode = 1 })
