const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const quality = require('../src/main/agent-quality')
const { fastEffort, fastPrompt } = require('../src/main/fast-mode')
const { buildGuideContext } = require('../src/main/work-guides')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
function cut(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a)
  assert(a >= 0 && b > a, from)
  return source.slice(a, b)
}
const declarations = cut('function assignWorkSchema(helperCount)', 'async function runAgentMode')
const assignments = new Map()
// Брифы ролей теперь данными в ./mode-prompts/team.js, но вырезаются вместе с
// остальными объявлениями главного процесса — поэтому режим подаётся как
// настоящая зависимость, а не подделывается.
const api = new Function('assignmentsByRequest', 'lastUserMessage', 'modePrompts', declarations +
  ';return { recordAssignment, leadBrief, helperBrief, reviewBrief, isCollaborativeRequest }')(
  assignments, p => p.messages.at(-1).content, require('../src/main/mode-prompts'))
const slots = [1, 2, 3].map((n, index) => ({ index, name: `Агент ${n}`,
  modelId: index ? `helper-${n}:free` : 'chosen-model', modelName: `model-${n}`, supportsTools: true }))

async function scenario({ failHelper = false, abortHelper = false, solo = false, speedMode, leadModel = 'chosen-model', finalState = {} } = {}) {
  const calls = [], events = [], signal = { aborted: false }
  // Команда — по просьбе: без неё ведущий работает один и помощников не получает.
  const original = [{ role: 'user', content: solo ? 'Исходная задача: реализовать и обсудить варианты' : 'Исходная задача: реализовать и обсудить варианты. Работайте вместе.' }]
  const requestId = 'test-' + Math.random()
  let leadCalls = 0
  const runSlot = async (event, slot, payload) => {
    calls.push({ slot, payload })
    assert.deepEqual(payload.messages[0], original[0], 'original request must survive all handoffs')
    if (slot.index === 0) {
      leadCalls++
      if (payload.canAssign && !solo) {
        api.recordAssignment(requestId, { assignments: [{ agent: leadCalls === 1 ? 2 : 3,
          task: leadCalls === 1 ? 'Исследуй варианты' : 'Проверь возражения', acceptance: 'Проверяемые факты', readOnly: true }], review: false }, 2)
        return { content: 'Промежуточное поручение', answeredModel: 'chosen-model' }
      }
      return { content: 'Проверенный итог Агент 1', answeredModel: 'chosen-model', ...finalState }
    }
    assert.equal(payload.canAssign, false)
    assert.equal(payload.readOnlyAssignment, true)
    if (abortHelper) signal.aborted = true
    if (failHelper) throw new Error('simulated helper outage')
    return { content: 'Отчёт ' + slot.name, ok: true }
  }
  // Реальный модуль доски, а не заглушка.
  const boardApi = require('../src/main/agent-board')
  const context = {
    resolveAgentSlots: () => [{ ...slots[0], modelId: leadModel }, ...slots.slice(1)], isCollaborativeRequest: api.isCollaborativeRequest,
    isFreeModel: id => id === 'chosen-model' || id.endsWith(':free'), LEAD_MODEL: 'z-ai/glm-5.3-flash',
    assignmentsByRequest: assignments, createCycle: require('../src/main/agent-cycle').createCycle, CRITIQUE_DEADLINE_MS: 120000, PART_DEADLINE_MS: 5 * 60 * 1000,
    leadBrief: api.leadBrief, helperBrief: api.helperBrief, reviewBrief: api.reviewBrief,
    lastUserMessage: p => p.messages.filter(m => m.role === 'user').at(-1).content,
    // Настоящее правило совместимости: его собственные проверки живут в
    // test-agent-waves, а здесь важно, что ход с ним работает.
    readyFor: new Function(source.slice(source.indexOf('function readyFor(item, state)'),
      source.indexOf('function helperAssignmentMessage')) + '; return readyFor')(),
    // Настоящее сообщение помощнику: что именно он видит последним, решает, по
    // чему он строит план.
    helperAssignmentMessage: new Function(source.slice(source.indexOf('function helperAssignmentMessage('),
      source.indexOf('function assignWorkSchema')) + '; return helperAssignmentMessage')(),
    runAgentSlot: runSlot, describeOpenRouterError: e => e,
    // Отправка события хода — настоящая функция из main.js: без неё вырезанный
    // `runAgentMode` падает на `sendToWindow is not defined` в первом же
    // `stage()`, а заглушка здесь спрятала бы проверяемую регрессию.
    sendToWindow: new Function(cut('function sendToWindow(event, channel, body)',
      'async function runAgentMode(event') + '; return sendToWindow')(),
    // Настоящая функция из main.js: её смысл в том, что текст ошибки доходит
    // до пользователя целым, а не превращается в «OpenRouter вернул статус 0».
    failureReason: new Function('return ' + source.slice(source.indexOf('function failureReason('),
      source.indexOf(String.fromCharCode(10) + '}', source.indexOf('function failureReason(')) + 2))(),
    // Доска настоящая: её собственные правила проверяются в test-agent-board,
    // а здесь важно, что ход с ней работает, а не что она заглушена.
    seedBoard: boardApi.seedBoard,
    // Замок приёмки доски, предыстория помощнику и склад отчётов (инициативы 1 и 6): настоящий модуль доски,
    // остальное — имена, которые вырезанный ход должен найти.
    setTestsExpected: boardApi.setTestsExpected, projectHasTests: () => false,
    workspaceRoots: () => [],
    buildPrior: require('../src/main/prior-digest.cjs').buildPrior, rememberReports() {},
    reassignItem: boardApi.reassignItem,
    boardSnapshot: boardApi.boardSnapshot,
    boardBrief: boardApi.boardBrief,
    reviewBoardSection: requestId => {
      const report = boardApi.boardReport(requestId)
      return report ? '\n\n---\n\n' + report : ''
    }
  }
  const run = new Function(...Object.keys(context),
    cut('async function runAgentMode(event', '\n// A tool call written') + ';return runAgentMode')(...Object.values(context))
  const result = await run({ sender: { send: (channel, body) => events.push({ channel, body }) } },
    { requestId, model: leadModel, speedMode, messages: original }, signal)
  return { result, calls, events, leadCalls }
}

async function main() {
  for (const finalState of [{ok: false}, {incomplete: true}, {failed: true}]) {
    const run = await scenario({solo: true, finalState})
    assert.equal(run.result.ok, false, 'partial/failed final must not become successful')
    assert.equal(run.result.incomplete, true)
  }
  api.recordAssignment('merge', { assignments: [{ agent: 2, task: 'A' }] }, 2)
  api.recordAssignment('merge', { assignments: [{ agent: 3, task: 'B' }] }, 2)
  api.recordAssignment('merge', { assignments: [] }, 2)
  assert.equal(assignments.get('merge').assignments.length, 2, 'tool calls must not erase earlier assignments')
  assert(assignments.get('merge').assignments.every(a => a.readOnly))
  assert.equal(assignments.get('merge').review, true)
  assert(!quality.toolAllowedForAssignment('write_file', true))
  assert(!quality.toolAllowedForAssignment('mcp_anything', true))
  assert(!quality.toolAllowedForAssignment('dc_write', true))
  assert(!quality.toolAllowedForAssignment('assign_work', true))
  assert(quality.toolAllowedForAssignment('read_file', true))
  assert(quality.toolAllowedForAssignment('dc_read', true))
  assert(quality.toolAllowedForAssignment('write_file', false))
  const result = await scenario()
  assert.equal(result.leadCalls, 3, 'two delegation rounds plus mandatory final acceptance')
  assert.equal(result.calls.length, 5)
  assert.equal(result.calls.at(-1).payload.canAssign, false)
  assert.equal(result.result.content, 'Проверенный итог Агент 1')
  assert.equal(result.result.answeredModel, 'chosen-model')
  assert.equal(result.result.contributions.length, 2)
  assert(result.calls.at(-1).payload.messages.at(-1).content.includes('Отчёт Агент 2'))
  assert(result.calls.at(-1).payload.messages.at(-1).content.includes('Отчёт Агент 3'))
  assert(result.events.filter(e => e.channel === 'agent-stage-start').every(e => /^Агент [1-8]$/.test(e.body.agentName)))
  const failed = await scenario({ failHelper: true })
  assert(failed.result.contributions.every(c => c.failed))
  assert(failed.calls.at(-1).payload.messages.at(-1).content.includes('ОШИБКА'))
  const aborted = await scenario({ abortHelper: true })
  assert.equal(aborted.result.aborted, true)
  assert.equal(aborted.calls.length, 2, 'no new agent starts after cancellation')
  assert.equal((await scenario({ solo: true })).calls.length, 1, 'small task does not force helpers')
  const fast = await scenario({ speedMode: 'fast' })
  assert.equal(fast.calls.filter(c => c.slot.index > 0).length, 1, 'Fast has only one helper wave')
  assert.equal(fast.calls.at(-1).slot.index, 0, 'Fast keeps final leader verification')
  assert.equal((await scenario({ speedMode: 'fast', solo: true })).calls.length, 1)
  await assert.rejects(scenario({ speedMode: 'fast', leadModel: 'other/paid' }), /бесплатные/)
  assert.equal((await scenario({ speedMode: 'fast', solo: true, leadModel: 'z-ai/glm-5.3-flash' })).calls.length, 1)

  let shared, pathTaken, selfDevelopment = false
  const runSlot = new Function('agentToolsAvailable', 'findModelRecord',
    'lastUserMessage', 'qualityContract', 'designQuality', 'runAgentLoop', 'streamChatOpenRouter', 'fastEffort', 'fastPrompt', 'selfDevActive', 'buildGuideContext',
    cut('async function runAgentSlot(event', '\n// Always a string.') + ';return runAgentSlot')(
    () => false, () => ({}), p => p.task || 'task',
    quality.qualityContract, quality.designQuality,
    async (event, p) => { shared = p; pathTaken = 'tools' },
    async (event, p) => { shared = p; pathTaken = 'text' }, fastEffort, fastPrompt, () => selfDevelopment, buildGuideContext)
  // Слот отдаёт вход только частями роли: режим собирается там, где известен
  // фактический список инструментов хода (см. test-prompt-routes).
  const hasPart = text => shared.roleParts.some(part => part.includes(text))
  await runSlot({}, slots[0], { messages: [], canAssign: true, customSystemPrompt: 'ROLE' }, {})
  assert.equal(pathTaken, 'tools', 'delegation tools work even without a workspace')
  assert(!hasPart('Инструменты этого режима'), 'режим собрался в слоте — он встанет дважды')
  assert(hasPart('Контракт качества'), 'контракт качества потерян')
  assert(hasPart('ROLE'), 'роль слота потеряна')
  assert.equal(shared.isCoordinator, true)
  await runSlot({}, slots[0], { messages: [], canAssign: true, speedMode: 'fast', reasoningEffort: 'max' }, {})
  assert.equal(shared.reasoningEffort, 'low')
  assert(shared.roleParts.some(part => part.includes('FAST')), 'Fast не дошёл до слота')
  selfDevelopment = true
  await runSlot({}, slots[0], { messages: [], canAssign: true, speedMode: 'fast' }, {})
  assert.equal(shared.reasoningEffort, 'high', 'self-development keeps its safety budget in Fast')
  selfDevelopment = false
  assert(hasPart('Контракт качества'))
  await runSlot({}, slots[1], { messages: [], designId: 'design', customSystemPrompt: 'DESIGN-ROLE' }, {})
  assert.equal(pathTaken, 'tools', 'design tools are available without a workspace')
  assert(hasPart('Качество визуальной работы'), 'качество визуальной работы потеряно')
  assert(hasPart('DESIGN-ROLE'), 'роль дизайнера потеряна')
  assert.equal(shared.isCoordinator, false)
  await runSlot({}, { ...slots[0], supportsTools: false }, { messages: [], customSystemPrompt: 'ROLE' }, {})
  assert.equal(pathTaken, 'text')
  await runSlot({}, { ...slots[0], supportsTools: false }, { messages: [], task: 'Аудит промпта', speedMode: 'fast' }, {})
  assert(hasPart('[agent-prompt-audit;'), 'памятка не дошла до хода без инструментов')
  assert(hasPart('не подключён'), 'ход без инструментов не сказал, что памятку не вызвать')
  assert(hasPart('Контракт качества'))
  // The mod skill rides in its own part: every team role replaces
  // customSystemPrompt, and the part must be added once per request, with the
  // journal recording the worker that actually received it.
  const reads = []
  const runContext = { record: () => {}, recordUsage: () => {}, recordSkillRead: input => reads.push(input) }
  await runSlot({}, slots[0], { messages: [], customSystemPrompt: 'ROLE', modSkill: { id: 's1', prompt: 'SKILL BLOCK' }, runContext }, {})
  assert.equal(shared.roleParts.join('\n\n').split('SKILL BLOCK').length - 1, 1, 'skill part appears once')
  assert(hasPart('ROLE'), 'role prompt survives the skill part')
  await runSlot({}, slots[1], { messages: [], modSkill: { id: 's1', prompt: 'SKILL BLOCK' }, runContext }, {})
  assert.deepEqual(reads.map(item => item.agentIndex), [0, 1], 'journal records each worker, not preparation')
  assert(reads.every(item => item.skillId === 's1' && item.source === 'instruction'))
  assert.match(source, /const toolAllowed = allTools\.some\(tool => tool\.function\.name === toolName\)/)
  assert.match(source, /rawResult = !toolAllowed\n\s+\? \{ success: false, error: 'Инструмент недоступен в этом назначении/)
  assert.equal((source.match(/models: payload.isCoordinator \? \[model\]/g) || []).length, 2,
    'neither text nor tool leader request may use an automatic replacement model')

  // Participants are numbered, never named after a model or a job. The owner
  // asked for this twice — «ролевые слова не возвращай», «имена только Агент 1,
  // Агент 2» — and it had regressed before. Both places that name a participant
  // are checked, because only one of them is on the path a roster test walks:
  // replacing the other with «Помощник GLM» left every suite green.
  const namingSites = [...source.matchAll(/name: ([`'"][^`'"\n]*Агент[^`'"\n]*[`'"]),/g)]
  assert(namingSites.length >= 2, 'участников должно называть не меньше двух мест')
  for (const [, quoted] of namingSites) {
    const value = quoted.slice(1, -1)
    assert.match(value, /^Агент (\d+|\$\{[^}]+\})$/,
      'имя участника должно быть только номером, а не «' + value + '»')
  }
  for (const forbidden of ['Кодер', 'Разработчик', 'Ревьюер', 'Помощник', 'Lead', 'Solo']) {
    assert(!new RegExp('name: `?[^`,\\n]*' + forbidden).test(source),
      'роль или модель в имени участника: ' + forbidden)
  }
  console.log('Universal Agent: selection context, delegation, review, failure, cancellation, read-only and prompt composition passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
