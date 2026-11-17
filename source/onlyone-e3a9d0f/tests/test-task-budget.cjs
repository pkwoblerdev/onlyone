'use strict'
// АГ-8, И-2.1: обходы бюджета закрыты. Повреждённые счётчики не становятся
// нулём, активные резервы не теряются, неизвестный расход не даёт свободный
// остаток без явного решения, позднее уточнение идемпотентно. Суммарная
// длительность запросов отделена от общего срока задачи; старый id после
// вытеснения из журнала не становится новой попыткой.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createTaskBudget, cleanBudgetState, SEEN_BYTES } = require('../src/main/task-budget.cjs')
const { createTaskState, cleanTaskState } = require('../src/main/task-state.cjs')
const { createCheckpointStore, continuationPrompt } = require('../src/main/run-checkpoints')

let checks = 0
const failures = []
function check(name, fn) {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

const clockAt = start => {
  let value = start
  return { now: () => value, set: next => { value = next }, add: delta => { value += delta } }
}
const LIMITS = () => ({ requests: 10, tokens: 1000 })
const fresh = (options = {}) => createTaskBudget({
  limits: options.limits || LIMITS(),
  deadlineAt: Object.hasOwn(options, 'deadlineAt') ? options.deadlineAt : null,
  restored: options.restored || null,
  now: (options.clock || clockAt(1000)).now
})
const make = (options = {}) => {
  const clock = options.clock || clockAt(1000)
  return { budget: fresh({ ...options, clock }), clock }
}
const validSnapshot = () => make().budget.snapshot()
const rawSnapshot = () => {
  const raw = validSnapshot()
  delete raw.reserved
  delete raw.remaining
  delete raw.tokenAccounting
  return raw
}
const reservation = (id, at = 1000) => ({ id, requests: 1, tokens: 10, agentIndex: 0, kind: 'agent', at })

check('резерв занимает остаток, списание учитывает факт и освобождает резерв', () => {
  const { budget, clock } = make()
  assert.equal(budget.reserve({ id: 'q1', tokens: 40 }).ok, true)
  assert.equal(budget.remaining('tokens'), 960)
  assert.equal(budget.remaining('requests'), 9)
  clock.add(120)
  const settled = budget.settle({ id: 'q1', usage: { total_tokens: 25 }, elapsedMs: 120 })
  assert.equal(settled.ok, true)
  const snap = budget.snapshot()
  assert.equal(snap.used.tokens, 25)
  assert.equal(snap.used.requests, 1)
  assert.equal(snap.used.ms, 120)
  assert.equal(snap.reserved.tokens, 0)
  assert.equal(budget.remaining('tokens'), 975)
})

check('исчерпание — отказ по названному измерению', () => {
  const { budget } = make({ limits: { requests: 2, tokens: 10 } })
  assert.equal(budget.reserve({ id: 'a', tokens: 10 }).ok, true)
  const second = budget.reserve({ id: 'b', tokens: 1 })
  assert.equal(second.ok, false)
  assert.equal(second.dimension, 'tokens')
  budget.settle({ id: 'a', usage: { total_tokens: 10 } })
  assert.equal(budget.reserve({ id: 'c', tokens: 1 }).dimension, 'tokens')

  const byRequests = make({ limits: { requests: 1, tokens: null } }).budget
  byRequests.reserve({ id: 'r', tokens: 0 })
  byRequests.settle({ id: 'r', usage: { total_tokens: 5 } })
  const denied = byRequests.reserve({ id: 'r2', tokens: 1 })
  assert.equal(denied.ok, false)
  assert.equal(denied.dimension, 'requests')
})

check('конкуренция: одновременные резервы не превышают общий остаток', () => {
  const { budget } = make({ limits: { requests: 10, tokens: 100 } })
  const results = []
  for (let i = 0; i < 10; i++) results.push(budget.reserve({ id: `p${i}`, tokens: 30 }))
  assert.equal(results.filter(item => item.ok).length, 3, 'резервы разошлись с остатком')
  assert.equal(budget.snapshot().reserved.tokens, 90)
  assert.equal(results.slice(3).every(item => !item.ok && item.dimension === 'tokens'), true)
  budget.settle({ id: 'p0', usage: { total_tokens: 10 } })
  assert.equal(budget.reserve({ id: 'p10', tokens: 20 }).ok, true)
  assert.equal(budget.reserve({ id: 'p11', tokens: 11 }).ok, false)
})

check('повторное событие не списывает расход второй раз', () => {
  const { budget } = make()
  budget.reserve({ id: 'q', tokens: 50 })
  assert.equal(budget.settle({ id: 'q', eventId: 'evt-1', usage: { total_tokens: 20 } }).ok, true)
  const again = budget.settle({ id: 'q', eventId: 'evt-1', usage: { total_tokens: 20 } })
  assert.equal(again.ok, false)
  assert.equal(again.duplicate, true)
  assert.equal(budget.snapshot().used.requests, 1)
  assert.equal(budget.snapshot().used.tokens, 20)

  budget.reserve({ id: 'q2', tokens: 50 })
  const duplicate = budget.settle({ id: 'q2', eventId: 'evt-1', usage: { total_tokens: 20 } })
  assert.equal(duplicate.duplicate, true)
  assert.equal(budget.snapshot().used.tokens, 20)
  assert.equal(budget.snapshot().reserved.requests, 0)
})

check('неизвестный расход не ноль и не даёт свободный остаток', () => {
  const { budget } = make({ limits: { requests: 10, tokens: 100 } })
  budget.reserve({ id: 'u', tokens: 40 })
  const settled = budget.settle({ id: 'u', usage: null, outcome: 'failed' })
  assert.equal(settled.charged.tokens, null)
  assert.equal(settled.charged.tokensUnknown, true)
  const snap = budget.snapshot()
  assert.equal(snap.used.tokens, 0)
  assert.equal(snap.used.requests, 1)
  assert.equal(snap.unknownUsage, 1)
  assert.equal(snap.tokenAccounting, 'incomplete')

  const denied = budget.reserve({ id: 'n', tokens: 5 })
  assert.equal(denied.ok, false, 'продолжение получило свободный остаток из потерянного usage')
  assert.equal(denied.dimension, 'unknown')
  const allowed = budget.reserve({ id: 'o', tokens: 5, allowUnknown: true })
  assert.equal(allowed.ok, true, 'явное решение доверенного кода не прошло')
  assert.equal(budget.snapshot().overrides, 1)
  assert.equal(budget.reserve({ id: 'n2', tokens: 5 }).dimension, 'unknown')
})

check('без предела токенов неизвестный расход не блокирует', () => {
  const { budget } = make({ limits: { requests: null, tokens: null } })
  budget.reserve({ id: 'u', tokens: 10 })
  budget.settle({ id: 'u', usage: null })
  assert.equal(budget.reserve({ id: 'n', tokens: 10 }).ok, true)
})

check('позднее уточнение расхода идемпотентно', () => {
  const { budget } = make({ limits: { requests: 10, tokens: 100 } })
  budget.reserve({ id: 'u', tokens: 40 })
  budget.settle({ id: 'u', eventId: 'e1', usage: null, outcome: 'failed' })
  assert.equal(budget.snapshot().unknownUsage, 1)

  const corrected = budget.correct({ eventId: 'e1', tokens: 12 })
  assert.equal(corrected.ok, true)
  assert.equal(corrected.corrected, true)
  let snap = budget.snapshot()
  assert.equal(snap.used.tokens, 12)
  assert.equal(snap.unknownUsage, 0)
  assert.equal(snap.tokenAccounting, 'complete')

  const again = budget.correct({ eventId: 'e1', tokens: 12 })
  assert.equal(again.duplicate, true)
  assert.equal(budget.snapshot().used.tokens, 12, 'повторное уточнение удвоило расход')
  const conflict = budget.correct({ eventId: 'e1', tokens: 13 })
  assert.equal(conflict.conflict, true)
  assert.equal(budget.snapshot().used.tokens, 12)
  assert.equal(budget.correct({ eventId: 'nope', tokens: 1 }).ok, false)

  assert.equal(budget.reserve({ id: 'n', tokens: 1 }).ok, true, 'уточнение не сняло запрет')
})

check('уточнение вне журнала не выдумывает расход', () => {
  const { budget } = make({ limits: { requests: null, tokens: null } })
  for (let i = 0; i < 65; i++) {
    budget.reserve({ id: `u${i}`, tokens: 1 })
    budget.settle({ id: `u${i}`, eventId: `e${i}`, usage: null })
  }
  const snap = budget.snapshot()
  assert.equal(snap.unknownUsage, 65)
  const late = budget.correct({ eventId: 'e0', tokens: 5 })
  assert.equal(late.ok, false)
  assert.equal(budget.snapshot().used.tokens, 0)
  assert.equal(budget.snapshot().unknownUsage, 65)
})

check('ошибка провайдера тратит запрос, отмена до отправки освобождает резерв', () => {
  const { budget } = make()
  budget.reserve({ id: 'fail', tokens: 30 })
  assert.equal(budget.settle({ id: 'fail', outcome: 'failed' }).ok, true)
  assert.equal(budget.snapshot().used.requests, 1)
  assert.equal(budget.snapshot().unknownUsage, 1)

  budget.reserve({ id: 'cancel', tokens: 30, allowUnknown: true })
  assert.equal(budget.release({ id: 'cancel', reason: 'отменено до запроса' }).ok, true)
  assert.equal(budget.snapshot().used.requests, 1)
  assert.equal(budget.snapshot().reserved.requests, 0)
})

check('помощник, повтор и смена ключа тратят тот же бюджет', () => {
  const { budget } = make({ limits: { requests: 2, tokens: 100 } })
  assert.equal(Object.hasOwn(budget, 'reset'), false, 'в API появился сброс бюджета')
  budget.reserve({ id: 'lead', tokens: 60, agentIndex: 0 })
  budget.settle({ id: 'lead', usage: { total_tokens: 50 }, agentIndex: 0 })
  const helper = budget.reserve({ id: 'helper', tokens: 60, agentIndex: 1, kind: 'helper' })
  assert.equal(helper.ok, false)
  assert.equal(helper.dimension, 'tokens')
  assert.equal(budget.reserve({ id: 'helper2', tokens: 50, agentIndex: 1, kind: 'helper' }).ok, true)
  budget.settle({ id: 'helper2', usage: { total_tokens: 50 }, agentIndex: 1 })
  assert.equal(budget.remaining('requests'), 0)
  const retry = budget.reserve({ id: 'retry', tokens: 0, kind: 'retry' })
  assert.equal(retry.ok, false)
  assert.equal(retry.dimension, 'requests')
  assert.equal(JSON.stringify(budget.snapshot()).includes('keyId'), false)
})

check('длительность запросов и срок задачи — разные вещи', () => {
  const clock = clockAt(1000)
  const budget = createTaskBudget({ limits: { requests: 10, tokens: null }, deadlineAt: 5000, now: clock.now })
  clock.set(4000)
  assert.equal(budget.reserve({ id: 'p1', tokens: 0 }).ok, true)
  clock.set(4500)
  assert.equal(budget.reserve({ id: 'p2', tokens: 0 }).ok, true)
  budget.settle({ id: 'p1', usage: { total_tokens: 1 }, elapsedMs: 200 })
  clock.set(4700)
  budget.settle({ id: 'p2', usage: { total_tokens: 2 }, elapsedMs: 300 })
  assert.equal(budget.snapshot().used.ms, 500, 'суммарная длительность запросов потеряна')
  assert.equal(budget.timeLeftMs(), 300)
  clock.set(5000)
  const denied = budget.reserve({ id: 'p3', tokens: 0 })
  assert.equal(denied.ok, false)
  assert.equal(denied.dimension, 'deadline')
  assert.equal(budget.outOfTime(), true)
})

check('восстановление не продлевает срок задачи', () => {
  const clock = clockAt(1000)
  const first = createTaskBudget({ limits: LIMITS(), deadlineAt: 5000, now: clock.now })
  first.reserve({ id: 'q', tokens: 10 })
  first.settle({ id: 'q', usage: { total_tokens: 5 }, elapsedMs: 100 })
  const disk = cleanBudgetState(first.snapshot())

  const later = createTaskBudget({ limits: LIMITS(), deadlineAt: 9000, restored: disk, now: clock.now })
  assert.equal(later.snapshot().deadlineAt, 5000, 'продолжение продлило срок')
  assert.equal(later.snapshot().used.ms, 100)
  const absent = createTaskBudget({ limits: LIMITS(), deadlineAt: null, restored: disk, now: clock.now })
  assert.equal(absent.snapshot().deadlineAt, 5000, 'срок снят восстановлением')
  const tighter = createTaskBudget({ limits: LIMITS(), deadlineAt: 4000, restored: disk, now: clock.now })
  assert.equal(tighter.snapshot().deadlineAt, 4000, 'нельзя сократить срок')
})

check('резерв умершего процесса: запрос потрачен, токены неизвестны', () => {
  const clock = clockAt(1000)
  const limits = { requests: 4, tokens: 100 }
  const first = createTaskBudget({ limits, deadlineAt: 5000, now: clock.now })
  first.reserve({ id: 'done', tokens: 40 })
  first.settle({ id: 'done', usage: { total_tokens: 30 }, elapsedMs: 200 })
  first.reserve({ id: 'inflight', tokens: 40 })
  const disk = cleanBudgetState(JSON.parse(JSON.stringify(first.snapshot())))
  const second = createTaskBudget({ limits, deadlineAt: 9000, restored: disk, now: clock.now })
  const snap = second.snapshot()
  assert.equal(snap.used.tokens, 30)
  assert.equal(snap.used.requests, 2)
  assert.equal(snap.unknownUsage, 1)
  assert.equal(snap.reserved.requests, 0)
  assert.equal(snap.deadlineAt, 5000)
  assert.equal(second.reserve({ id: 'after', tokens: 70 }).dimension, 'unknown')
  assert.equal(second.reserve({ id: 'after', tokens: 70, allowUnknown: true }).ok, true)
  const old = second.reserve({ id: 'inflight', tokens: 10 })
  assert.equal(old.ok, false)
  assert.equal(old.duplicate, true, 'старый id стал новой попыткой')
  const corrected = second.correct({ id: 'inflight', tokens: 20 })
  assert.equal(corrected.ok, true)
  assert.equal(second.snapshot().unknownUsage, 0)
  assert.equal(second.snapshot().used.tokens, 50)
})

check('пределы и срок передаются явно, скрытых нет', () => {
  assert.throws(() => createTaskBudget({ deadlineAt: null }), /предел/i)
  assert.throws(() => createTaskBudget({ limits: { requests: 1 }, deadlineAt: null }), /предел/i)
  assert.throws(() => createTaskBudget({ limits: { requests: 1, tokens: 1 } }), /срок|deadline/i)
  assert.throws(() => createTaskBudget({ limits: { requests: -1, tokens: 1 }, deadlineAt: null }))
  assert.throws(() => createTaskBudget({ limits: { requests: 1, tokens: 1 }, deadlineAt: -1 }))
  assert.throws(() => createTaskBudget({ limits: { requests: 1, tokens: 1, ms: 5000 }, deadlineAt: null }), /ms|срок|deadline/i)
  const budget = createTaskBudget({ limits: { requests: 1, tokens: 1 }, deadlineAt: null })
  assert.deepEqual(budget.snapshot().limits, { requests: 1, tokens: 1 })
  assert.throws(() => budget.reserve({ id: 'no-tokens' }), /токен|tokens/i)
})

check('повреждённые счётчики не превращаются в нулевой расход', () => {
  for (const mutate of [
    raw => { raw.used.tokens = 'много' },
    raw => { delete raw.used.tokens },
    raw => { delete raw.used },
    raw => { delete raw.limits },
    raw => { raw.limits.ms = 5000 },
    raw => { delete raw.reservations },
    raw => { delete raw.history },
    raw => { delete raw.recoveredReservations },
    raw => { delete raw.seen },
    raw => { delete raw.unknownUsage },
    raw => { delete raw.overrides },
    raw => { raw.used.requests = -1 },
    raw => { raw.used.ms = 1.5 },
    raw => { raw.used.tokens = Number.MAX_SAFE_INTEGER + 2 },
    raw => { raw.unknownUsage = 1.5 },
    raw => { raw.overrides = Number.MAX_SAFE_INTEGER + 2 },
    raw => { raw.limits.tokens = -1 },
    raw => { delete raw.limits.tokens },
    raw => { raw.deadlineAt = 'скоро' },
    raw => { delete raw.deadlineAt },
    raw => { raw.schemaVersion = 1 },
    raw => { raw.seen = 'AAAA' },
    raw => { delete raw.events },
    raw => { raw.events = ['zz'] },
    raw => { raw.unknownUsage = 1 },
    raw => { raw.overrides = -1 },
    raw => { raw.reservations = [reservation('r0', 1)] ; raw.reservations[0].requests = 0 },
    raw => { raw.reservations = [reservation('r0', 1)] ; raw.reservations[0].tokens = Number.MAX_SAFE_INTEGER + 2 }
  ]) {
    const raw = rawSnapshot()
    mutate(raw)
    assert.equal(cleanBudgetState(raw), null, `повреждение принято: ${mutate}`)
  }
  const raw = rawSnapshot()
  raw.used.tokens = 'много'
  assert.equal(cleanBudgetState(raw), null)
  assert.throws(() => createTaskBudget({ limits: LIMITS(), deadlineAt: null, restored: raw }), /поврежд/i)
})

check('повторяющиеся id и противоречивые поля — повреждение', () => {
  const twoSettled = () => {
    const { budget } = make()
    budget.reserve({ id: 'h1', tokens: 1 })
    budget.settle({ id: 'h1', eventId: 'e1', usage: { total_tokens: 1 } })
    budget.reserve({ id: 'h2', tokens: 1 })
    budget.settle({ id: 'h2', eventId: 'e2', usage: { total_tokens: 1 } })
    const raw = budget.snapshot()
    delete raw.reserved
    delete raw.remaining
    delete raw.tokenAccounting
    return raw
  }
  const cases = [
    raw => { raw.reservations = [reservation('dup'), reservation('dup')] },
    raw => { raw.history[1].id = raw.history[0].id },
    raw => { raw.history[1].eventId = raw.history[0].eventId },
    raw => { raw.history[0].tokens = 5; raw.history[0].tokensUnknown = true },
    raw => { raw.history[0].tokens = null; raw.history[0].tokensUnknown = false },
    raw => { raw.history[0].requests = 0 },
    raw => { raw.used.requests = 1; raw.unknownUsage = 2 },
    raw => { raw.recoveredReservations = ['x', 'x'] },
    raw => { raw.reservations = [reservation('h1')] },
    raw => { raw.events = [raw.events[0], raw.events[0]] },
    raw => { raw.events.shift() }
  ]
  for (const mutate of cases) {
    const raw = twoSettled()
    mutate(raw)
    assert.equal(cleanBudgetState(raw), null)
  }
  const zeroFilter = twoSettled()
  zeroFilter.seen = validSnapshot().seen
  assert.equal(cleanBudgetState(zeroFilter), null, 'история прошла без следа в фильтре id')
  const derived = validSnapshot()
  derived.reserved = { requests: 0, tokens: 1 }
  assert.equal(cleanBudgetState(derived), null, 'резервы в снимке разошлись с списком')
  const remaining = validSnapshot()
  remaining.remaining = { requests: 10, tokens: 999 }
  assert.equal(cleanBudgetState(remaining), null, 'остаток в снимке разошёлся с расчётом')
  const accounting = rawSnapshot()
  accounting.used.requests = 1
  accounting.unknownUsage = 1
  accounting.tokenAccounting = 'complete'
  assert.equal(cleanBudgetState(accounting), null, 'учёт назван полным при неизвестном расходе')
})

check('границы активных резервов 63/64/65', () => {
  for (const size of [63, 64]) {
    const raw = rawSnapshot()
    raw.reservations = Array.from({ length: size }, (_, i) => reservation(`r${i}`))
    const clean = cleanBudgetState(raw)
    assert.ok(clean, `${size} резервов отвергнуты`)
    assert.equal(clean.used.requests, size)
    assert.equal(clean.unknownUsage, size)
    assert.equal(clean.reservations.length, 0)
  }
  const over = rawSnapshot()
  over.reservations = Array.from({ length: 65 }, (_, i) => reservation(`r${i}`))
  assert.equal(cleanBudgetState(over), null, '65-й активный резерв потерян, а не отвергнут')

  const { budget } = make({ limits: { requests: null, tokens: null } })
  for (let i = 0; i < 64; i++) assert.equal(budget.reserve({ id: `a${i}`, tokens: 0 }).ok, true)
  const denied = budget.reserve({ id: 'a64', tokens: 0 })
  assert.equal(denied.ok, false)
  assert.equal(denied.dimension, 'reservations')
  budget.settle({ id: 'a0', usage: { total_tokens: 0 }, elapsedMs: 0 })
  assert.equal(budget.reserve({ id: 'a64', tokens: 0 }).ok, true)
})

check('старый id после вытеснения не становится новой попыткой', () => {
  const { budget } = make({ limits: { requests: null, tokens: null } })
  const count = 300
  for (let i = 0; i < count; i++) {
    assert.equal(budget.reserve({ id: `q${i}`, tokens: 1 }).ok, true)
    budget.settle({ id: `q${i}`, eventId: `ev${i}`, usage: { total_tokens: 0 }, elapsedMs: 0 })
  }
  const old = budget.reserve({ id: 'q0', tokens: 1 })
  assert.equal(old.ok, false, 'вытесненный id принят как новый запрос')
  assert.equal(old.duplicate, true)
  assert.equal(budget.snapshot().used.requests, count)

  assert.equal(budget.reserve({ id: 'q300', tokens: 1 }).ok, true)
  const before = budget.snapshot().used
  const duplicate = budget.settle({ id: 'q300', eventId: 'ev0', usage: { total_tokens: 5 } })
  assert.equal(duplicate.duplicate, true)
  assert.equal(budget.snapshot().used.tokens, before.tokens)
  assert.equal(budget.snapshot().reserved.requests, 0)

  const seen = budget.snapshot().seen
  assert.equal(typeof seen, 'string')
  assert.equal(Buffer.from(seen, 'base64').length, SEEN_BYTES, 'журнал id перестал быть ограниченным по памяти')
  assert.equal(budget.snapshot().events.length, count, 'кольцо событий потеряло ещё не вытесненный повтор')
})

check('повтор события за окном не становится бесплатным', () => {
  const { budget } = make({ limits: { requests: null, tokens: null } })
  for (let i = 0; i < 513; i++) {
    budget.reserve({ id: `z${i}`, tokens: 1 })
    budget.settle({ id: `z${i}`, eventId: `zev${i}`, usage: { total_tokens: 0 }, elapsedMs: 0 })
  }
  assert.equal(budget.snapshot().events.length, 512)
  assert.equal(budget.reserve({ id: 'late', tokens: 1 }).ok, true)
  const settled = budget.settle({ id: 'late', eventId: 'zev0', usage: { total_tokens: 5 } })
  assert.equal(settled.ok, true, 'повтор за окном потерял расход')
  assert.equal(budget.snapshot().used.tokens, 5, 'расход за окном не учтён')
})

check('снимок хранит бюджет у владельца состояния и передаёт остаток', () => {
  const clock = clockAt(1000)
  const limits = { requests: 4, tokens: 100 }
  const task = createTaskState({ now: clock.now, idPrefix: 'r1', budgetLimits: limits, budgetDeadlineAt: 5000 })
  assert.ok(task.budget, 'бюджет не создан')
  assert.throws(() => createTaskState({ now: clock.now, budgetLimits: limits }), /срок|deadline/i, 'срок забыт молча')
  task.budget.reserve({ id: 'a', tokens: 40 })
  task.budget.settle({ id: 'a', usage: { total_tokens: 30 }, elapsedMs: 10 })
  const disk = cleanTaskState(JSON.parse(JSON.stringify(task.snapshot())))
  assert.equal(disk.budget.used.tokens, 30)
  assert.equal(disk.budget.deadlineAt, 5000)
  const second = createTaskState({ now: clock.now, idPrefix: 'r2', restored: disk, budgetLimits: limits, budgetDeadlineAt: 9000 })
  assert.equal(second.budget.snapshot().used.tokens, 30)
  assert.equal(second.budget.snapshot().deadlineAt, 5000)
  assert.equal(second.budget.remaining('tokens'), 70)
  assert.throws(() => createTaskState({ now: clock.now, restored: disk }), /предел/i)

  const broken = JSON.parse(JSON.stringify(task.snapshot()))
  broken.budget.used.tokens = 'много'
  const cleaned = cleanTaskState(broken)
  assert.equal(cleaned.budget, null)
  assert.equal(cleaned.budgetCorrupt, true)
  assert.throws(() => createTaskState({ now: clock.now, restored: cleaned, budgetLimits: limits, budgetDeadlineAt: 5000 }), /поврежд/i)
  assert.match(continuationPrompt({ task: cleaned, ask: '', done: [], failed: [], unknown: [], droppedActions: 0 }),
    /бюджета задачи поврежден/i)
})

check('повторное чтение снимка не удваивает расход', () => {
  const { budget } = make()
  budget.reserve({ id: 'p', tokens: 10 })
  const once = cleanBudgetState(budget.snapshot())
  const twice = cleanBudgetState(once)
  assert.deepEqual(twice, once)
  assert.equal(once.used.requests, 1)
  assert.equal(once.unknownUsage, 1)
  assert.deepEqual(once.recoveredReservations, ['p'])
})

check('контрольная точка: успешная запись, падение, продолжение', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-budget-cp-'))
  const limits = { requests: 5, tokens: 100 }
  const deadline = Date.now() + 60000
  const laterDeadline = deadline + 60000
  const firstId = '00000001-aaaa-bbbb-cccc-dddddddddddd'
  const secondId = '00000002-aaaa-bbbb-cccc-dddddddddddd'
  try {
    const store = createCheckpointStore({ dir })
    assert.throws(() => store.start({ runId: '00000005-aaaa-bbbb-cccc-dddddddddddd', budgetLimits: limits }), /срок|deadline/i)
    const run = store.start({ runId: firstId, budgetLimits: limits, budgetDeadlineAt: deadline })
    const reserved = run.reserveBudget({ id: 'q1', tokens: 40 })
    assert.equal(reserved.ok, true)
    assert.equal(reserved.durable, true)
    assert.equal(run.settleBudget({ id: 'q1', usage: { total_tokens: 25 }, elapsedMs: 100 }).durable, true)
    assert.equal(run.reserveBudget({ id: 'q2', tokens: 40 }).durable, true)

    const found = store.interrupted()[0]
    assert.equal(found.task.budget.used.tokens, 25)
    assert.equal(found.task.budget.used.requests, 2)
    assert.equal(found.task.budget.unknownUsage, 1)
    assert.equal(found.task.budget.deadlineAt, deadline)

    const resumed = store.start({ runId: secondId, carriedTask: found.task, budgetLimits: limits, budgetDeadlineAt: laterDeadline })
    assert.equal(resumed.budget().used.tokens, 25)
    assert.equal(resumed.budget().deadlineAt, deadline, 'продолжение продлило срок')
    const normal = resumed.reserveBudget({ id: 'q3', tokens: 10 })
    assert.equal(normal.ok, false)
    assert.equal(normal.dimension, 'unknown')
    assert.equal(resumed.reserveBudget({ id: 'q3', tokens: 10, allowUnknown: true }).ok, true)
    const old = resumed.reserveBudget({ id: 'q2', tokens: 10 })
    assert.equal(old.ok, false)
    assert.equal(old.duplicate, true)

    const prompt = continuationPrompt(found)
    assert.match(prompt, /Общий бюджет задачи/)
    assert.match(prompt, /1 с неизвестным расходом/)
    store.dismiss(firstId)
    store.dismiss(secondId)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('отказ записи не запускает резерв и не помечает id потраченным', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-budget-write-'))
  const blocker = path.join(base, 'blocked')
  fs.writeFileSync(blocker, '')
  try {
    const store = createCheckpointStore({ dir: blocker })
    const run = store.start({ runId: '00000003-aaaa-bbbb-cccc-dddddddddddd', budgetLimits: { requests: 5, tokens: 100 }, budgetDeadlineAt: null })
    const refused = run.reserveBudget({ id: 'x', tokens: 10 })
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'not_durable')
    assert.equal(run.budget().reservations.length, 0)
    assert.equal(run.budget().used.requests, 0)
    assert.equal(run.budget().remaining.tokens, 100)

    fs.rmSync(blocker)
    fs.mkdirSync(blocker)
    const retried = run.reserveBudget({ id: 'x', tokens: 10 })
    assert.equal(retried.ok, true, 'id снятого резерва стал навсегда запрещённым')
    assert.equal(retried.durable, true)
    run.close()
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

check('ошибка записи списания видна, а диск сохраняет неизвестный исход', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-budget-write2-'))
  const runId = '00000004-aaaa-bbbb-cccc-dddddddddddd'
  try {
    const store = createCheckpointStore({ dir })
    const run = store.start({ runId, budgetLimits: { requests: 5, tokens: 100 }, budgetDeadlineAt: null })
    assert.equal(run.reserveBudget({ id: 'q', tokens: 10 }).ok, true)
    const temp = path.join(dir, `${runId}.json.${process.pid}.tmp`)
    fs.mkdirSync(temp)
    const settled = run.settleBudget({ id: 'q', usage: { total_tokens: 5 }, elapsedMs: 10 })
    assert.equal(settled.ok, true)
    assert.equal(settled.durable, false, 'отказ записи выдал себя за успех')
    fs.rmdirSync(temp)

    const found = store.interrupted()[0]
    assert.equal(found.task.budget.used.tokens, 0, 'на диске оказался незаписанный расход')
    assert.equal(found.task.budget.used.requests, 1)
    assert.equal(found.task.budget.unknownUsage, 1)
    store.dismiss(runId)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('снимок с историей 50 токенов и итогом 0 отвергается', () => {
  const options = { limits: { requests: null, tokens: 100 }, deadlineAt: null, now: () => 1000 }
  const budget = createTaskBudget(options)
  budget.reserve({ id: 'first', tokens: 50 })
  budget.settle({ id: 'first', usage: { total_tokens: 50 }, elapsedMs: 0 })
  const raw = budget.snapshot()
  raw.used.tokens = 0
  raw.remaining.tokens = 100
  assert.throws(() => createTaskBudget({ ...options, restored: raw }), /поврежд/i)
})

check('история не больше накопленных requests, ms и unknown', () => {
  const limits = { requests: null, tokens: null }
  const budget = createTaskBudget({ limits, deadlineAt: null, now: () => 1000 })
  budget.reserve({ id: 'known', tokens: 1 })
  budget.settle({ id: 'known', usage: { total_tokens: 1 }, elapsedMs: 10 })
  budget.reserve({ id: 'unknown', tokens: 1 })
  budget.settle({ id: 'unknown', usage: null, elapsedMs: 20 })
  for (const mutate of [
    raw => { raw.used.requests = 0 },
    raw => { raw.used.ms = 0 },
    raw => { raw.unknownUsage = 0 }
  ]) {
    const raw = JSON.parse(JSON.stringify(budget.snapshot()))
    mutate(raw)
    assert.throws(() => createTaskBudget({ limits, deadlineAt: null, now: () => 1000, restored: raw }), /поврежд/i)
  }
})

check('settle при переполнении не меняет состояние и не теряет резерв', () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const options = { limits: { requests: null, tokens: null }, deadlineAt: null, now: () => 1000 }
  const budget = createTaskBudget(options)
  budget.reserve({ id: 'first', tokens: 0 })
  budget.settle({ id: 'first', usage: { total_tokens: MAX }, elapsedMs: 0 })
  budget.reserve({ id: 'next', tokens: 0 })
  const before = budget.snapshot()
  assert.throws(() => budget.settle({ id: 'next', usage: { total_tokens: 1 }, elapsedMs: 0 }), /Переполнение/)
  assert.deepEqual(budget.snapshot(), before, 'неудачное списание изменило requests и потеряло резерв')
})

check('settle при переполнении ms атомарен', () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const options = { limits: { requests: null, tokens: null }, deadlineAt: null, now: () => 1000 }
  const budget = createTaskBudget(options)
  budget.reserve({ id: 'first', tokens: 0 })
  budget.settle({ id: 'first', usage: { total_tokens: 0 }, elapsedMs: MAX })
  budget.reserve({ id: 'next', tokens: 0 })
  const before = budget.snapshot()
  assert.throws(() => budget.settle({ id: 'next', usage: { total_tokens: 0 }, elapsedMs: 1 }), /Переполнение/)
  assert.deepEqual(budget.snapshot(), before)
})

check('reserve при переполнении суммы резервов отвергается, снимок читаем', () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const options = { limits: { requests: null, tokens: null }, deadlineAt: null, now: () => 1000 }
  const budget = createTaskBudget(options)
  budget.reserve({ id: 'bulk', requests: MAX, tokens: 0 })
  const before = budget.snapshot()
  const result = budget.reserve({ id: 'extra', tokens: 0 })
  assert.equal(result.ok, false, 'резерв с переполненной суммой принят')
  assert.deepEqual(budget.snapshot(), before)
})

check('снимок с переполненной суммой резервов отвергается', () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const raw = rawSnapshot()
  raw.reservations = [
    { id: 'a', requests: MAX, tokens: 0, agentIndex: 0, kind: 'agent', at: 1 },
    { id: 'b', requests: 1, tokens: 0, agentIndex: 0, kind: 'agent', at: 1 }
  ]
  assert.equal(cleanBudgetState(raw), null)
})

check('переполнение overrides не принимается', () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const limits = { requests: null, tokens: 100 }
  const budget = createTaskBudget({ limits, deadlineAt: null, now: () => 1000 })
  budget.reserve({ id: 'u', tokens: 10 })
  budget.settle({ id: 'u', usage: null })
  const raw = budget.snapshot()
  raw.overrides = MAX
  delete raw.reserved
  delete raw.remaining
  delete raw.tokenAccounting
  const restored = createTaskBudget({ limits, deadlineAt: null, now: () => 1000, restored: raw })
  const before = restored.snapshot()
  const result = restored.reserve({ id: 'n', tokens: 0, allowUnknown: true })
  assert.equal(result.ok, false, 'переполненный счётчик исключений принят')
  assert.deepEqual(restored.snapshot(), before)
})

check('correct при переполнении не меняет неизвестный расход', () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const options = { limits: { requests: null, tokens: null }, deadlineAt: null, now: () => 1000 }
  const budget = createTaskBudget(options)
  budget.reserve({ id: 'known', tokens: 0 })
  budget.settle({ id: 'known', usage: { total_tokens: MAX }, elapsedMs: 0 })
  budget.reserve({ id: 'unknown', tokens: 0 })
  budget.settle({ id: 'unknown', eventId: 'eu', usage: null, elapsedMs: 0 })
  const before = budget.snapshot()
  assert.throws(() => budget.correct({ eventId: 'eu', tokens: 1 }), /Переполнение/)
  assert.deepEqual(budget.snapshot(), before)
})

if (failures.length) {
  console.error(`ПРОВАЛЕНО ${failures.length}: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
