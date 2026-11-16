'use strict'
// break-4 Н20: Bloom-фильтр виденных id (4 КБ, 3 хеша) отвергал НИКОГДА не
// использованный id уже на ~685 запросах — ход обрывался на длинной задаче.
// Фильтр увеличен; при этом старый снимок (4 КБ) обязан переживать восстановление,
// иначе продолжение задачи упало бы с «Повреждённое состояние бюджета».
// Контроли: повторный id по-прежнему отвергается; старый фильтр восстанавливается.
const assert = require('node:assert/strict')
const { createTaskBudget, cleanBudgetState, SEEN_BYTES, SCHEMA_VERSION } = require('../src/main/task-budget.cjs')

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }
const bigLimits = () => ({ requests: 1000000, tokens: 1000000000 })
const fresh = () => createTaskBudget({ limits: bigLimits(), deadlineAt: null, now: () => 1000 })
// Форма id как в budget-runtime.cjs: `${run}:${agentIndex}:${scope}${step}:${attempt}${retry}`.
const idOf = step => `run:0:r1-part-t1:${step}:1`

check('свежий id не отвергается на длинной задаче (1000 структурированных id)', () => {
  const budget = fresh()
  const refused = []
  for (let step = 1; step <= 1000; step++) {
    const id = idOf(step)
    const res = budget.reserve({ id, tokens: 1 })
    if (!res.ok || res.duplicate) { refused.push({ step, error: res.error }); continue }
    budget.settle({ id, usage: { total_tokens: 1 } })
  }
  assert.deepEqual(refused.slice(0, 5), [], `Bloom отверг свежие id (всего ${refused.length}): ход обрывается на длинной задаче`)
  assert.equal(refused.length, 0)
})

check('контроль: повторный id по-прежнему отвергается', () => {
  const budget = fresh()
  const id = idOf(1)
  assert.equal(budget.reserve({ id, tokens: 1 }).ok, true)
  budget.settle({ id, usage: { total_tokens: 1 } })
  const again = budget.reserve({ id, tokens: 1 })
  assert.equal(again.duplicate, true, 'дубликат id перестал определяться')
})

check('контроль: новый фильтр больше старого 4 КБ', () => {
  const seen = fresh().snapshot().seen
  assert.ok(Buffer.from(seen, 'base64').length > 4096, 'фильтр не увеличен — ложные отказы останутся')
  assert.ok(Buffer.from(seen, 'base64').length <= 1024 * 1024, 'фильтр обязан оставаться ограниченным по памяти')
})

check('миграция: старый снимок с фильтром 4 КБ восстанавливается без потери', () => {
  const legacy = {
    schemaVersion: SCHEMA_VERSION, limits: { requests: 100, tokens: 1000 }, deadlineAt: null,
    used: { requests: 0, tokens: 0, ms: 0 }, unknownUsage: 0, overrides: 0,
    reservations: [], history: [], recoveredReservations: [], events: [],
    seen: Buffer.from(new Uint8Array(4096)).toString('base64')
  }
  const cleaned = cleanBudgetState(legacy)
  assert.ok(cleaned, 'старый фильтр 4 КБ признан повреждением — продолжение задачи упало бы')
  const budget = createTaskBudget({ limits: { requests: 100, tokens: 1000 }, deadlineAt: null, restored: legacy, now: () => 1000 })
  assert.equal(budget.reserve({ id: idOf(1), tokens: 1 }).ok, true, 'восстановленный бюджет не принимает новый резерв')
})

if (failed) process.exit(1)
console.log('Бюджет: Bloom-фильтр не обрывает длинную задачу, старые снимки целы')