'use strict'
const assert = require('node:assert/strict')
const { createRunContext } = require('../src/main/agent-run-context')

let checks = 0
function check(name, fn) { fn(); checks++; console.log('ok', name) }
let clock = 100
check('actual skill reads and served models survive archive/checkpoint without raw contents', () => {
  const run = createRunContext({ durationMs: 1000 })
  run.recordSkillRead({ agentIndex: 1, skillId: 'PRIVATE skill', path: 'PRIVATE path', content: 'SECRET text', source: 'file' })
  run.recordSkillRead({ agentIndex: 1, skillId: 'PRIVATE skill', path: 'PRIVATE path', content: 'SECRET text', source: 'file' })
  run.recordSkillRead({ agentIndex: 1, skillId: 'PRIVATE skill', path: 'PRIVATE path', content: 'changed text', source: 'file' })
  run.recordModelCall({ kind: 'agent', agentIndex: 1, model: 'test/requested', answeredModel: 'test/served', outcome: 'completed' })
  run.recordConfiguration({ model: 'test/requested', agentIndex: 1 })
  const snapshot = run.snapshot()
  assert.equal(snapshot.skillReads.length, 2)
  assert.equal(snapshot.skillReads[0].bytes, 11)
  assert.equal(snapshot.modelCalls[0].answeredModel, 'test/served')
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false)
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false)
  const { configurationRecord } = require('../src/main/agent-run-context')
  const { cleanRunContext } = require('../src/main/run-checkpoints')
  for (const clean of [configurationRecord, cleanRunContext]) {
    const saved = clean({ ...snapshot, skillReads: [{ ...snapshot.skillReads[0], secret: 'SECRET' }],
      modelCalls: [{ ...snapshot.modelCalls[0], prompt: 'SECRET' }] })
    assert.equal(saved.skillReads.length, 1)
    assert.equal(saved.modelCalls[0].answeredModel, 'test/served')
    assert.equal(JSON.stringify(saved).includes('SECRET'), false)
  }
  snapshot.skillReads[0].hash = 'changed'
  assert.notEqual(run.snapshot().skillReads[0].hash, 'changed')
  for (let i = 0; i < 140; i++) {
    run.recordSkillRead({ agentIndex: 0, skillId: 'a', path: String(i), source: 'file', content: String(i) })
    run.recordModelCall({ kind: 'judge', agentIndex: 0, model: 'test/requested', outcome: 'failed', answeredModel: 'SECRET invalid value' })
  }
  assert.equal(run.snapshot().skillReads.length, 128)
  assert.ok(run.snapshot().droppedSkillReads > 0)
  assert.equal(run.snapshot().modelCalls.length, 128)
  assert.ok(run.snapshot().droppedModelCalls > 0)
  assert.equal(run.snapshot().modelCalls[0].answeredModel, null)
  run.finish('completed')
  const closed = run.snapshot()
  run.recordSkillRead({ agentIndex: 0, skillId: 'b', source: 'instruction', content: 'late' })
  run.recordModelCall({ kind: 'agent', agentIndex: 0, model: 'test/requested', outcome: 'completed' })
  assert.deepEqual(run.snapshot(), closed)
})
check('configuration versions are immutable, deduplicated and exclude raw secrets', () => {
  const run = createRunContext({ durationMs: 100 })
  const input = { model: 'test/model', agentIndex: 0, reasoningEffort: 'high', systemPrompt: 'PRIVATE instruction',
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    skills: [{ id: 'private skill', enabled: true, systemPrompt: 'PRIVATE skill', apiKey: 'SECRET' }], apiKey: 'SECRET' }
  run.recordConfiguration(input)
  run.recordConfiguration({ ...input, apiKey: 'different' })
  const first = run.snapshot().configurations
  assert.equal(first.length, 1)
  assert.equal(first[0].model, 'test/model')
  assert.equal(first[0].tools[0].name, 'read_file')
  assert.equal(JSON.stringify(first).includes('PRIVATE'), false)
  assert.equal(JSON.stringify(first).includes('SECRET'), false)
  run.recordConfiguration({ ...input, systemPrompt: 'changed instruction' })
  run.recordConfiguration({ ...input, skills: [{ ...input.skills[0], systemPrompt: 'changed skill' }] })
  assert.equal(run.snapshot().configurations.length, 3)
  first[0].model = 'mutated'
  assert.equal(run.snapshot().configurations[0].model, 'test/model')
  const { cleanRunContext } = require('../src/main/run-checkpoints')
  assert.deepEqual(cleanRunContext(run.snapshot()).configurations, run.snapshot().configurations)
  for (let i = 0; i < 40; i++) run.recordConfiguration({ ...input, systemPrompt: 'revision ' + i })
  assert.equal(run.snapshot().configurations.length, 32)
  assert.ok(run.snapshot().droppedConfigurations > 0)
  const { saveConfigurationRecord } = require('../src/main/agent-run-context')
  let records = []
  const storage = { read: () => records, write: value => { records = value } }
  run.finish('failed')
  saveConfigurationRecord(run.snapshot(), storage)
  assert.equal(records[0].state, 'failed')
  saveConfigurationRecord(run.snapshot(), storage)
  assert.equal(records.length, 1)
  assert.equal(JSON.stringify(records).includes('SECRET'), false)
  for (let i = 0; i < 20; i++) saveConfigurationRecord({ ...run.snapshot(), runId: '00000000-0000-0000-0000-' + String(i).padStart(12, '0') }, storage)
  assert.equal(records.length, 16)
  assert.throws(() => saveConfigurationRecord(run.snapshot(), { read: () => records, write: () => { throw Error('disk unavailable') } }), /disk unavailable/)
  assert.equal(records.length, 16)
})
const context = createRunContext({ requestId: 'turn', durationMs: 800, now: () => clock })
check('configuration archive IPC only exposes sanitized records to the main frame', () => {
  const fs = require('node:fs'), path = require('node:path')
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  const start = main.indexOf("ipcMain.handle('get-run-configurations'")
  const end = main.indexOf("ipcMain.handle('get-conversations'", start)
  assert.ok(start >= 0 && end > start)
  let handler, reads = 0
  const wc = { mainFrame: {} }
  const run = createRunContext({ durationMs: 100 })
  run.recordConfiguration({ agentIndex: 0, model: 'test/model' })
  const stored = { ...run.snapshot(), apiKey: 'SECRET' }
  new Function('ipcMain', 'mainWindow', 'readSecure', 'require', main.slice(start, end))(
    { handle: (_id, fn) => { handler = fn } }, { isDestroyed: () => false, webContents: wc },
    key => { assert.equal(key, 'runConfigurations'); reads++; return [stored] }, require('node:module').createRequire(path.join(__dirname, '../src/main/main.js')))
  assert.equal(handler({ sender: {}, senderFrame: wc.mainFrame }).code, 'forbidden')
  assert.equal(handler({ sender: wc, senderFrame: {} }).code, 'forbidden')
  assert.equal(reads, 0)
  const result = handler({ sender: wc, senderFrame: wc.mainFrame })
  assert.equal(result.records[0].configurations[0].model, 'test/model')
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
  const hook = main.slice(main.indexOf('    applyFilePlugin(bodyData, messages)'), main.indexOf('    applyFilePlugin(bodyData, messages)') + 470)
  assert.match(hook, /recordConfiguration/)
  assert.match(hook, /tools: bodyData\.tools/)
})
check('one deadline survives worker payload copies', () => {
  const lead = { runContext: context }, worker = { ...lead }, reviewer = { ...worker }
  clock = 900
  assert.equal(reviewer.runContext.expired(), true)
  assert.equal(worker.runContext.remainingMs(), 0)
  assert.equal(lead.runContext.startedAt, 100)
})
check('all workers contribute to one usage total', () => {
  context.recordUsage({ total_tokens: 30 }, { agentIndex: 0 })
  context.recordUsage({ prompt_tokens: 10, completion_tokens: 5 }, { agentIndex: 1 })
  assert.equal(context.snapshot().usage.totalTokens, 45)
})
check('invalid usage cannot poison the total', () => {
  context.recordUsage({ total_tokens: -1, prompt_tokens: Infinity, completion_tokens: -8 })
  assert.equal(context.snapshot().usage.totalTokens, 45)
})
check('journal metadata excludes secrets and arguments', () => {
  context.record('worker', { agentIndex: 2, apiKey: 'secret', arguments: 'private' })
  assert.equal(JSON.stringify(context.snapshot()).includes('secret'), false)
  assert.equal(JSON.stringify(context.snapshot()).includes('private'), false)
})
check('snapshots cannot mutate live accounting', () => {
  const copy = context.snapshot(); copy.journal[0].type = 'changed'
  copy.usage.totalTokens = -9
  assert.equal(context.snapshot().journal[0].type, 'started')
  assert.equal(context.snapshot().usage.totalTokens, 45)
})
check('journal remains bounded with visible truncation', () => {
  const run = createRunContext({ durationMs: 50, journalLimit: 2 })
  run.record('one'); run.record('two')
  assert.equal(run.snapshot().journal.length, 2)
  assert.equal(run.snapshot().droppedEvents, 1)
  assert.deepEqual(run.snapshot().journal.map(e => e.sequence), [2, 3])
})
check('terminal state is immutable and finishing is idempotent', () => {
  context.finish('cancelled')
  const before = context.snapshot()
  context.recordUsage({ total_tokens: 90 }); context.record('late')
  assert.deepEqual(context.finish('completed'), before)
})
check('independent requests never share usage or deadlines', () => {
  const other = createRunContext({ durationMs: 200, now: () => 1000 })
  assert.notEqual(context.runId, other.runId)
  assert.equal(other.snapshot().usage.totalTokens, 0)
  assert.equal(other.expired(), false)
})
check('chat and Design use the same accounting contract', () => {
  const variants = [{ surface: 'chat' }, { surface: 'design' }]
  for (const variant of variants) {
    const run = createRunContext({ ...variant, durationMs: 100, now: () => 5 })
    run.recordUsage({ total_tokens: 12 })
    assert.equal(run.finish('completed').usage.totalTokens, 12)
    assert.equal(run.deadlineAt, 105)
  }
})
check('chat and Design share the same checked lifecycle', () => {
  const variants = [{ surface: 'chat' }, { surface: 'design' }]
  const traces = variants.map(variant => {
    const run = createRunContext({ ...variant, durationMs: 100 })
    run.transition('plan', { kind: 'adaptive' })
    run.transition('execute', { round: 1 })
    run.transition('verify', { round: 1 })
    run.transition('rework', { round: 2 })
    run.transition('execute', { round: 2 })
    run.transition('verify', { round: 2 })
    run.transition('finalize')
    return run.snapshot().journal.filter(event => event.type === 'phase').map(event => event.phase)
  })
  assert.deepEqual(traces[0], ['plan', 'execute', 'verify', 'rework', 'execute', 'verify', 'finalize'])
  assert.deepEqual(traces[1], traces[0])
})
check('lifecycle rejects skipped verification and post-final work', () => {
  const run = createRunContext({ durationMs: 100 })
  assert.throws(() => run.transition('execute'), /Invalid run phase transition/)
  run.transition('plan'); run.transition('execute'); run.transition('verify'); run.transition('finalize')
  assert.throws(() => run.transition('rework'), /Invalid run phase transition/)
})
check('invalid configurations rejected', () => {
  for (const durationMs of [0, -1, NaN, Infinity]) assert.throws(() => createRunContext({ durationMs }))
  assert.throws(() => createRunContext({ durationMs: 1, surface: 'unknown' }))
})
console.log(JSON.stringify({ ok: true, checks }))

// Execute the actual IPC boundary with a deterministic engine, not a copy of it.
async function wiring() {
  const fs = require('node:fs')
  const path = require('node:path')
  const vm = require('node:vm')
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  const start = source.indexOf("ipcMain.handle('send-message', async")
  assert.ok(start > 0)
  const runModeStart = source.indexOf('async function runAgentMode(')
  const executorStart = source.indexOf('async function runMultiAgentExecution(')
  assert.ok(runModeStart > 0 && executorStart > runModeStart)
  const executor = source.slice(executorStart, source.indexOf('// Tool-calling loop', executorStart))
  assert.match(executor, /return await runAgentMode\(event, payload, signal\)/,
    'чат и Design должны входить через один диспетчер')
  const runMode = source.slice(runModeStart, source.indexOf('// A tool call written', runModeStart))
  for (const phase of ['plan', 'execute', 'verify', 'rework', 'finalize']) {
    assert.ok(runMode.includes(`transition('${phase}'`), `общий диспетчер не проводит фазу ${phase}`)
  }
  let handler, captured, mode = 'ok', opened = 0, closed = 0
  const savedContexts = []
  // Порядок жизни контрольных точек: преемник записывается до того, как снят
  // предшественник. Записываем вызовы, чтобы увидеть порядок, а не верить ему.
  const order = []
  const deskEnded = []
  let carried = null
  const sandbox = {
    ipcMain: { handle(name, fn) { assert.equal(name, 'send-message'); handler = fn } },
    turnScope: { run(_scope, fn) { return fn() } }, currentProject: () => null,
    app: { isPackaged: true }, process, AbortController, createRunContext,
    TURN_SOFT_LIMIT_MS: 800, activeAbortControllers: new Map(),
    clearTurnPlans() {}, clearBoard() {},
    deskService: { endTurn(requestId) { deskEnded.push(requestId) } },
    // Незакрытое переносится в следующее сообщение диалога в том же finally (инициатива 5); здесь переносить нечего.
    rememberOpenWork() {},
    // Скрытая страница агента (браузер) снимается в том же finally; здесь страниц нет.
    releaseAgentPage() {},
    // Согласие на браузер со входами человека снимается там же, в конце хода.
    userBrowserTurns: new Set(),
    // Согласие на видимый браузер по просьбе человека снимается там же, в конце хода.
    visibleBrowserTurns: new Set(),
    interruptedRunList: () => sandbox.runs,
    runs: [],
    wantsWholeJob: () => false,
    createCycle: require('../src/main/agent-cycle').createCycle,
    budgetPlanForTurn: () => ({ limits: null, deadlineAt: null }),
    createBudgetRuntime: () => ({ budget: () => null, reserve: () => ({ ok: true, enabled: false }), settle: () => ({}), release: () => ({}), correct: () => ({}), run: async (_input, provider) => ({ ok: true, enabled: false, value: await provider() }) }),
    activeBudgetRuns: new Map(),
    lastBudgetRefusal: new Map(),
    noteBudgetResult: () => {},
    // Ход отмечает начало и конец хода макета у помощника правки из чата
    // (4.2 шаг 2): настоящий модуль, без внешних зависимостей — только память.
    designEditTurn: require('../src/main/design/edit-turn').createDesignEditTurn({ designs: {}, send: () => {} }),
    // Контрольная точка на диске: заводится на каждый ход и закрывается на любом выходе.
    runCheckpoints: { start: (options) => { opened++; order.push('start'); carried = options.carried; return {
      updateContext(snapshot) { savedContexts.push(snapshot) },
      updateCycle() {},
      saved: () => true,
      close() { closed++; order.push('close') }
    } }, dismiss(runId) { order.push('dismiss:' + runId); return true } },
    async runMultiAgentExecution(_event, payload, signal) {
      captured = payload.runContext
      captured.recordUsage({ total_tokens: 17 })
      if (mode === 'fail') throw new Error('provider failed')
      if (mode === 'cancel') sandbox.activeAbortControllers.get(payload.requestId).abort()
      return { ok: true, content: 'result', aborted: signal.aborted }
    }
  }
  vm.runInNewContext(source.slice(start), sandbox)
  for (const input of [{}, { designId: 'design-1' }]) {
    const result = await handler({}, { ...input, requestId: 'same-request', runContext: { startedAt: -999 } })
    assert.equal(result.execution.state, 'completed')
    assert.equal(result.execution.usage.totalTokens, 17)
    assert.equal(savedContexts.at(-1).usage.totalTokens, 17, 'общий расход записан в контрольную точку')
    assert.notEqual(result.execution.startedAt, -999, 'IPC cannot inject a budget')
    assert.equal(sandbox.activeAbortControllers.size, 0)
  }
  mode = 'cancel'
  assert.equal((await handler({}, { requestId: 'cancel' })).execution.state, 'cancelled')
  mode = 'fail'
  await assert.rejects(handler({}, { requestId: 'failed' }), /provider failed/)
  assert.equal(captured.snapshot().state, 'failed')
  assert.equal(sandbox.activeAbortControllers.size, 0)
  assert.deepEqual(deskEnded, ['same-request', 'same-request', 'cancel', 'failed'], 'Desk activity ends on success, cancellation and provider failure')
  assert.equal(opened, 4)
  assert.equal(closed, 4, 'контрольная точка закрывается и при отмене, и при ошибке')
  console.log('ok actual IPC: two entries, trusted context, cancellation, failure and cleanup')

  // Продолжение оборванного хода: новая запись появляется раньше, чем старая
  // снята, и наследует и сделанное, и то, что ещё надо проверить.
  mode = 'ok'
  sandbox.runs = [{
    runId: 'deadbeef-0000-1111-2222-333333333333', chatId: 'c1', designId: null, surface: 'chat',
    ask: 'доведи', startedAt: 1, updatedAt: 2, context: null, cycle: null,
    done: [{ tool: 'write_file', target: 'src/a.js', status: 'done' }],
    failed: [], unknown: [{ tool: 'run_command', target: 'npm test', status: 'unknown' }]
  }]
  order.length = 0
  carried = null
  await handler({}, { requestId: 'resume', resumeRunId: 'deadbeef-0000-1111-2222-333333333333' })
  assert.deepEqual(order, ['start', 'dismiss:deadbeef-0000-1111-2222-333333333333', 'close'],
    'прежняя точка должна сниматься после записи новой: ' + order.join(', '))
  assert.equal(JSON.stringify((carried || []).map(item => `${item.tool}:${item.status}`).sort()),
    JSON.stringify(['run_command:unknown', 'write_file:done']),
    'наследуются и сделанное, и непроверенное: ' + JSON.stringify(carried))
  assert.equal(sandbox.runs.length, 0, 'список оборванных ходов очищается заодно с файлом')
  console.log('ok продолжение: сначала сохранён преемник, потом снят предшественник')
}
wiring().catch(error => { console.error(error); process.exitCode = 1 })
