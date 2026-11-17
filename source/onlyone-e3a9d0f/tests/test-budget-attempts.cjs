'use strict'
// АГ-8, И-2: бюджет считается у границы фактической отправки, а не вокруг всего
// openRouterRequest. Ротация ключей — это несколько реальных запросов, и каждый
// берёт свой допуск: предел 1 не пропускает второй fetch. Идентификатор резерва
// называет конкретный запуск слота (круг/часть/критика), поэтому части и фазы
// одного агента не получают один id и не глотают друг друга как duplicate.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createTaskBudget } = require('../src/main/task-budget.cjs')
const { createBudgetRuntime, runWithBudget } = require('../src/main/budget-runtime.cjs')

let checks = 0
const failures = []
const check = async (name, fn) => {
  try { await fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

// Настоящий budget-runtime и task-budget на поддельной контрольной точке:
// диска и моделей нет, сеть заменена заглушкой.
function makeBudget (limits) {
  const core = createTaskBudget({ limits, deadlineAt: null, now: () => 1000 })
  const calls = []
  const checkpoint = {
    runId: 'fixture-run',
    budget: () => core.snapshot(),
    reserveBudget: input => { calls.push({ method: 'reserve', id: input.id }); return { ...core.reserve(input), durable: true } },
    settleBudget: input => { calls.push({ method: 'settle', id: input.id }); return { ...core.settle(input), durable: true } },
    releaseBudget: input => { calls.push({ method: 'release', id: input.id }); return { ...core.release(input), durable: true } },
    correctBudget: input => { calls.push({ method: 'correct', id: input.id }); return { ...core.correct(input), durable: true } }
  }
  return { core, calls, budget: createBudgetRuntime({ checkpoint }) }
}

// openRouterRequest берётся из настоящего main.js без изменений; все внешние
// имена заменены заглушками, fetch считает фактические отправки.
function makeTransport ({ firstStatus = 429, alwaysStatus = null, body = null, keys: keyCount = 2, plan = null } = {}) {
  const root = path.join(__dirname, '..')
  const source = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
  const start = source.indexOf('async function openRouterRequest(')
  const end = source.indexOf('\nfunction requestHeaders(', start)
  assert(start > 0 && end > start, 'маркер openRouterRequest в main.js сместился')
  const keys = Array.from({ length: keyCount }, (_unused, index) => ({
    id: `fixture-key-${index}`, keyEncrypted: `fixture-only-${index}`
  }))
  const pool = {
    keys, isDead: () => false, getCandidateChain: () => keys,
    recordSuccess () {}, markCooldown () {}, markDead () {}
  }
  const state = { fetches: [] }
  const sandbox = {
    testProviderResponse: async () => null,
    normalizeOutgoingMessages: messages => messages,
    isAdapterProvider: () => false,
    getOpenRouterKeyPool: () => pool,
    keyDead: () => false,
    decryptKeyValue: value => value,
    requestHeaders: () => ({}),
    OPENROUTER_URL: 'https://fixture.invalid',
    describeOpenRouterError: () => 'fixture rate limit',
    latency: { write () {} },
    tr: value => value,
    fetch: async (url, init) => {
      state.fetches.push({ url, init })
      const attempt = state.fetches.length
      const failedStatus = plan ? (plan[attempt - 1] ?? 200)
        : alwaysStatus !== null ? alwaysStatus : (attempt === 1 ? firstStatus : 200)
      if (failedStatus !== 200) {
        return { ok: false, status: failedStatus, text: async () => '{"error":"fixture rate limit"}', headers: { get: () => null } }
      }
      const payload = body || { usage: { total_tokens: 2 }, choices: [{ message: { content: 'fixture' } }] }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload, text: async () => JSON.stringify(payload) }
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(source.slice(start, end) + '\nthis.fixtureRequest = openRouterRequest;', sandbox)
  return { request: sandbox.fixtureRequest, state }
}

const jsonProvider = (request, state, body = { model: 'fixture/model', messages: [] }) =>
  attemptGuard => request('/chat/completions', { body, attemptGuard })
    .then(response => response.json())

// Помощник по решениям берётся из настоящего main.js: у него свой endpoint и
// свой ответ, и он обязан ходить через тот же бюджет, а не мимо него.
function makeDecision ({ body = null } = {}) {
  const root = path.join(__dirname, '..')
  const source = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
  const start = source.indexOf('async function askDecisionTool(')
  const end = source.indexOf('\nfunction recordAssignment(', start)
  assert(start > 0 && end > start, 'маркер askDecisionTool в main.js сместился')
  const { request, state } = makeTransport({ firstStatus: 200, body: body || { answers: { direction: { type: 'choice', choice: 'up', confidence: 0.7, probabilities: { up: 0.7, down: 0.3 } } } } })
  const sandbox = {
    decisionTurns: new Map([['req-1', { id: 'fixture/decide', name: 'Решатель' }]]),
    isAdapterProvider: () => false,
    decisionsLib: require('../src/main/decisions.cjs'),
    sendToWindow: () => {},
    tr: value => value,
    openRouterRequest: request,
    runWithBudget,
    messagesRoughTokens: () => 20
  }
  vm.createContext(sandbox)
  vm.runInContext(source.slice(start, end) + '\nthis.ask = askDecisionTool;', sandbox)
  return { ask: sandbox.ask, state }
}

;(async () => {
  await check('ротация ключей не обходит предел запросов: лимит 1 — одна отправка', async () => {
    const { request, state } = makeTransport()
    const { core, budget } = makeBudget({ requests: 1, tokens: null })
    const result = await runWithBudget(budget, { agentIndex: 0, kind: 'agent', step: 0, tokens: 10 },
      jsonProvider(request, state))
    assert.equal(state.fetches.length, 1, 'второй ключ не должен получить запрос при пределе 1')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'budget_exhausted')
    assert.equal(result.dimension, 'requests')
    assert.equal(core.snapshot().used.requests, 1, 'первая отправка должна быть учтена')
  })

  await check('две фактические отправки при пределе 2 учитываются обе', async () => {
    const { request, state } = makeTransport()
    const { core, budget } = makeBudget({ requests: 2, tokens: null })
    const result = await runWithBudget(budget, { agentIndex: 0, kind: 'agent', step: 0, tokens: 10 },
      jsonProvider(request, state))
    assert.equal(state.fetches.length, 2)
    assert.equal(result.ok, true)
    const snapshot = core.snapshot()
    assert.equal(snapshot.used.requests, 2)
    assert.equal(snapshot.unknownUsage, 1, 'неудачная отправка — неизвестный расход, а не ноль')
  })

  await check('неизвестный расход не превращается в ноль: повтор идёт, расход остаётся неизвестным', async () => {
    const { request, state } = makeTransport()
    const { core, budget } = makeBudget({ requests: 2, tokens: 500 })
    const result = await runWithBudget(budget, { agentIndex: 0, kind: 'agent', step: 0, tokens: 10 },
      jsonProvider(request, state))
    // Повтор того же места другим ключом — действие приложения, а не модели:
    // без него один сбой провайдера закрывал задачу навсегда (Н1, аудит 31.10).
    assert.equal(state.fetches.length, 2, 'второй ключ обязан получить запрос')
    assert.equal(result.ok, true, result.message)
    const snapshot = core.snapshot()
    assert.equal(snapshot.used.requests, 2)
    assert.equal(snapshot.unknownUsage, 1, 'потерянный расход списан как известный')
    assert.equal(snapshot.used.tokens, 2, 'неизвестная отправка выдана за ноль токенов')
  })

  await check('фазы одного агента не делят id резерва', async () => {
    const { core, budget } = makeBudget({ requests: 10, tokens: 1000 })
    let calls = 0
    const provider = () => { calls++; return { usage: { total_tokens: 1 } } }
    const part = await budget.run({ agentIndex: 1, step: 0, attempt: 0, kind: 'helper', invocation: 'r1-part-2', tokens: 10 }, provider)
    const critique = await budget.run({ agentIndex: 1, step: 0, attempt: 0, kind: 'critique', invocation: 'r1-critique', tokens: 10 }, provider)
    assert.equal(part.ok, true)
    assert.equal(critique.ok, true, `вторая фаза отвергнута: ${critique.reason || critique.message}`)
    assert.equal(calls, 2)
    assert.equal(core.remaining('requests'), 8)
    const ids = core.snapshot().history.map(entry => entry.id)
    assert.equal(new Set(ids).size, ids.length, 'id резервов обязаны различаться')
  })

  await check('повторная доставка того же резерва остаётся идемпотентной', async () => {
    const { core, budget } = makeBudget({ requests: 10, tokens: 1000 })
    let calls = 0
    const provider = () => { calls++; return { usage: { total_tokens: 1 } } }
    const input = { agentIndex: 1, step: 0, attempt: 0, kind: 'helper', invocation: 'r1-part-2', tokens: 10 }
    assert.equal((await budget.run(input, provider)).ok, true)
    const again = await budget.run(input, provider)
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'duplicate')
    assert.equal(calls, 1, 'повторная доставка не должна звать провайдера')
    assert.equal(core.remaining('requests'), 9)
  })

  await check('все ключи отказали: каждая отправка списана ровно один раз', async () => {
    const { request, state } = makeTransport({ alwaysStatus: 429 })
    const { core, calls, budget } = makeBudget({ requests: 5, tokens: null })
    const result = await runWithBudget(budget, { agentIndex: 0, kind: 'agent', step: 0, tokens: 10 },
      attemptGuard => request('/chat/completions', { body: { model: 'fixture/model', messages: [] }, attemptGuard }))
    assert.equal(state.fetches.length, 2, 'оба ключа получили запрос')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'provider_failed')
    const snapshot = core.snapshot()
    assert.equal(snapshot.used.requests, 2)
    assert.equal(snapshot.unknownUsage, 2)
    const settles = calls.filter(call => call.method === 'settle')
    assert.equal(settles.length, 2, 'транспорт и вызывающий не должны списывать одну отправку дважды')
    assert.equal(new Set(settles.map(call => call.id)).size, 2)
    assert.equal(snapshot.history.length, 2)
  })

  await check('помощник по решениям проходит через общий бюджет', async () => {
    const { ask, state } = makeDecision()
    const { core, budget } = makeBudget({ requests: 2, tokens: null })
    const answer = await ask(null, { state: {}, questions: { direction: { type: 'noul', instructions: 'Идти?', criteria: { true: 'да', false: 'нет' } } } },
      'req-1', null, { budget, agentIndex: 0, step: 2, invocation: 'lead-r1' })
    assert.equal(answer.success, true, answer.error)
    assert.equal(state.fetches.length, 1)
    const snapshot = core.snapshot()
    assert.equal(snapshot.used.requests, 1)
    assert.equal(snapshot.unknownUsage, 1, 'ответ без usage — неизвестный расход, а не ноль')
    assert.equal(snapshot.history[0].kind, 'decision')
  })

  await check('исчерпанный бюджет не отправляет запрос помощнику по решениям', async () => {
    const { ask, state } = makeDecision()
    const { core, budget } = makeBudget({ requests: 1, tokens: null })
    await budget.run({ agentIndex: 0, step: 0, tokens: 5 }, () => ({ usage: { total_tokens: 1 } }))
    const answer = await ask(null, { state: {}, questions: { direction: { type: 'noul', instructions: 'Идти?', criteria: { true: 'да', false: 'нет' } } } },
      'req-1', null, { budget, agentIndex: 0, step: 2, invocation: 'lead-r1' })
    assert.equal(answer.success, false)
    assert.match(String(answer.error), /Бюджет/)
    assert.equal(state.fetches.length, 0, 'второй отправки быть не должно')
    assert.equal(core.snapshot().used.requests, 1)
  })

  await check('ротация трёх ключей не сталкивает номера двух запросов', async () => {
    const { request, state } = makeTransport({ keys: 3, plan: [429, 429, 200, 429, 200] })
    const { core, budget } = makeBudget({ requests: 10, tokens: null })
    const first = await runWithBudget(budget, { agentIndex: 0, kind: 'agent', step: 0, attempt: 100, tokens: 10 },
      jsonProvider(request, state))
    const second = await runWithBudget(budget, { agentIndex: 0, kind: 'agent', step: 0, attempt: 101, tokens: 10 },
      jsonProvider(request, state))
    assert.equal(first.ok, true)
    assert.equal(second.ok, true, `второй запрос отвергнут: ${second.reason || second.message}`)
    assert.equal(state.fetches.length, 5)
    assert.equal(core.snapshot().used.requests, 5)
  })

  await check('два вопроса помощнику на одном шаге — два запроса', async () => {
    const { ask, state } = makeDecision()
    const { core, budget } = makeBudget({ requests: 3, tokens: null })
    const question = { state: {}, questions: { direction: { type: 'noul', instructions: 'Идти?', criteria: { true: 'да', false: 'нет' } } } }
    const first = await ask(null, question, 'req-1', null, { budget, agentIndex: 0, step: 3, invocation: 'lead-r1', attempt: 400 })
    const second = await ask(null, question, 'req-1', null, { budget, agentIndex: 0, step: 3, invocation: 'lead-r1', attempt: 401 })
    assert.equal(first.success, true, first.error)
    assert.equal(second.success, true, second.error)
    assert.equal(state.fetches.length, 2)
    assert.equal(core.snapshot().used.requests, 2)
    // Проводка цикла обязана передавать номер вопроса: иначе оба получат attempt 0.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
    assert.ok(/askDecisionTool\(event, args, payload\.requestId, signal, \{[\s\S]{0,240}?attempt:/.test(source),
      'цикл не передаёт номер вопроса помощнику — оба вопроса получат один резерв')
  })

  await check('общий остаток хода: помощник тратит тот же бюджет, исчерпанный держит и ведущего', async () => {
    const { core, budget } = makeBudget({ requests: 2, tokens: null })
    const spend = (agentIndex, invocation) => budget.run({ agentIndex, kind: 'helper', invocation, tokens: 5 },
      () => ({ usage: { total_tokens: 5 } }))
    assert.equal((await spend(1, 'r1-part-2')).ok, true)
    assert.equal((await spend(2, 'r1-part-3')).ok, true)
    // Помощник не заводит свой счётчик и не возвращает остаток: ведущему его уже нет.
    const lead = await budget.run({ agentIndex: 0, kind: 'lead', invocation: 'r1-lead', tokens: 5 },
      () => ({ usage: { total_tokens: 5 } }))
    assert.equal(lead.ok, false)
    assert.equal(lead.reason, 'budget_exhausted')
    assert.equal(core.remaining('requests'), 0)
    assert.equal(core.snapshot().used.requests, 2, 'помощник сбросил общий расход')
  })

  if (failures.length) {
    console.error(`ПРОВАЛЕНО ${failures.length}: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
})().catch(error => { console.error(error); process.exitCode = 1 })
