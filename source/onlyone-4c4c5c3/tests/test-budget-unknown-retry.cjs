'use strict'
// Н1 (аудит 31.10): один сбой провайдера при конечном пределе токенов закрывал
// задачу навсегда. Разрешение на неизвестный расход даёт только доверенный
// повтор приложения (следующая отправка того же места другим ключом) или явный
// флаг хода; обычный резерв следующего запроса по-прежнему отвергается.
// «Неизвестно» остаётся неизвестным, а не нулём.
const assert = require('node:assert/strict')
const { createTaskBudget } = require('../src/main/task-budget.cjs')
const { createBudgetRuntime } = require('../src/main/budget-runtime.cjs')

let checks = 0
const failures = []
const check = async (name, fn) => {
  try { await fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

// Та же контрольная точка, что у run-checkpoints.start: бюджет в памяти, диск не нужен.
function checkpointFor(limits, restored = null) {
  const budget = createTaskBudget({ limits, deadlineAt: null, restored, now: () => 1000 })
  const calls = []
  return {
    calls,
    runId: 'run-rot',
    budget: () => budget.snapshot(),
    reserveBudget(input) { calls.push(input); return { ...budget.reserve(input), durable: true } },
    settleBudget(input) { return { ...budget.settle(input), durable: true } },
    releaseBudget(input) { return { ...budget.release(input), durable: true } },
    correctBudget(input) { return { ...budget.correct(input), durable: true } }
  }
}

// Как в openRouterRequest: before() -> fetch -> failed() при 429 -> следующий ключ.
async function rotate(runtime, keys, input = { agentIndex: 0, kind: 'chat', tokens: 100 }) {
  const sends = []
  try {
    const out = await runtime.run(input, async guard => {
      for (const key of keys) {
        const attempt = guard.before()
        if (!attempt.ok) throw Object.assign(new Error(attempt.message), { budgetRefusal: attempt })
        sends.push(key)
        if (key === 'key-1') { guard.failed(attempt, 'failed'); continue }
        guard.sent(attempt)
        return { usage: { total_tokens: 70 } }
      }
    })
    return { out, sends }
  } catch (error) {
    return { out: error, sends }
  }
}

;(async () => {
  const finite = { requests: 10, tokens: 100_000 }

  await check('сбой провайдера не закрывает задачу: второй ключ получает запрос', async () => {
    const checkpoint = checkpointFor(finite)
    const { out, sends } = await rotate(createBudgetRuntime({ checkpoint }), ['key-1', 'key-2'])
    assert.deepEqual(sends, ['key-1', 'key-2'])
    assert.equal(out.ok, true)
    assert.equal(out.called, true)
    const snapshot = checkpoint.budget()
    assert.equal(snapshot.used.requests, 2, 'обе отправки списаны')
    assert.equal(snapshot.unknownUsage, 1, 'неудачная отправка осталась неизвестной')
    assert.equal(snapshot.used.tokens, 70, 'известен только расход доставленного ответа')
    assert.equal(snapshot.overrides, 1, 'разрешение повтору посчитано явно')
  })

  await check('разрешение даёт только повтор: первая отправка без него', async () => {
    const checkpoint = checkpointFor(finite)
    await rotate(createBudgetRuntime({ checkpoint }), ['key-1', 'key-2'])
    assert.equal(checkpoint.calls[0].allowUnknown, false, 'первый резерв разрешён моделью')
    assert.equal(checkpoint.calls[1].allowUnknown, true, 'повтору того же места разрешение не выдано')
  })

  await check('неизвестный расход не ноль: учёт неполный, следующий запрос закрыт', async () => {
    const checkpoint = checkpointFor(finite)
    const runtime = createBudgetRuntime({ checkpoint })
    await rotate(runtime, ['key-1', 'key-2'])
    const snapshot = checkpoint.budget()
    assert.equal(snapshot.tokenAccounting, 'incomplete')
    assert.equal(snapshot.history[0].tokens, null)
    assert.equal(snapshot.remaining.tokens, Math.max(0, finite.tokens - snapshot.used.tokens))
    let called = 0
    const next = await runtime.run({ step: 1, tokens: 10 }, async () => { called++; return { usage: { total_tokens: 1 } } })
    assert.equal(next.ok, false, 'обычный следующий запрос прошёл с неизвестным расходом')
    assert.equal(next.reason, 'unknown_usage')
    assert.equal(called, 0, 'провайдер вызван при отказе')
  })

  await check('явный флаг хода разрешает продолжить с неизвестным расходом', async () => {
    const checkpoint = checkpointFor(finite)
    await rotate(createBudgetRuntime({ checkpoint }), ['key-1', 'key-2'])
    const decided = createBudgetRuntime({ checkpoint, budgetDecision: 'continue-unknown' })
    let called = 0
    const next = await decided.run({ step: 1, tokens: 10 }, async () => { called++; return { usage: { total_tokens: 5 } } })
    assert.equal(next.ok, true, next.message)
    assert.equal(called, 1)
    const snapshot = checkpoint.budget()
    assert.equal(snapshot.unknownUsage, 1, 'старый неизвестный расход не списан как ноль')
    assert.equal(snapshot.overrides, 2, 'решение хода не учтено')
    assert.equal(snapshot.used.tokens, 75)
  })

  await check('продолжение после падения: без флага закрыто, с флагом идёт', async () => {
    // Резерв, переживший падение, восстанавливается как неизвестный расход.
    const first = createTaskBudget({ limits: finite, deadlineAt: null })
    first.reserve({ id: 'lost', tokens: 120 })
    const restored = first.snapshot()

    const plain = checkpointFor(finite, restored)
    const denied = await createBudgetRuntime({ checkpoint: plain })
      .run({ step: 0, tokens: 10 }, async () => ({ usage: { total_tokens: 1 } }))
    assert.equal(denied.ok, false)
    assert.equal(denied.reason, 'unknown_usage')

    const decidedCheckpoint = checkpointFor(finite, restored)
    const allowed = await createBudgetRuntime({ checkpoint: decidedCheckpoint, budgetDecision: 'continue-unknown' })
      .run({ step: 0, tokens: 10 }, async () => ({ usage: { total_tokens: 1 } }))
    assert.equal(allowed.ok, true, allowed.message)
    assert.equal(decidedCheckpoint.budget().unknownUsage, 1, 'потерянный расход остался неизвестным')
  })

  if (failures.length) {
    console.error(`ПРОВАЛЕНО ${failures.length}: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
})().catch(error => { console.error(error); process.exitCode = 1 })
