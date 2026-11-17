'use strict'
// M-Team: инструкция выбранного мода доходит до каждой роли команды — ведущего,
// помощников, круга возражений, подмены ведущего и финальной приёмки, — а не
// только до ведущего.
//
// Проверка поведенческая: из main.js вырезаются настоящие `runAgentMode` и
// `runAgentSlot`, у `prepare` берётся настоящая привязка навыка, а подставлен
// только прогон модели. Негативный контроль ниже прогоняет те же проверки по
// испорченному тексту main.js: без части `modSkill` в `roleParts` или без
// `...payload` в одной из сборок запроса контракт обязан покраснеть.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const quality = require('../src/main/agent-quality')
const { fastEffort, fastPrompt } = require('../src/main/fast-mode')
const { buildGuideContext } = require('../src/main/work-guides')
const { prepare } = require('../src/main/mods-run.cjs')
// Вырезки компилируются new Function и видят только глобальную область.
globalThis.tr = require('../src/main/ui-text.cjs').tr

const MAIN = path.join(__dirname, '..', 'src', 'main', 'main.js')
const SOURCE = fs.readFileSync(MAIN, 'utf8')
const SKILL = 'EXACT mod skill instruction'
const SKILL_HEAD = 'User selected the following skill via mod onlyone.project-checks.'
const COLLAB = 'Исходная задача: реализовать и обсудить варианты. Работайте вместе.'

function cut(source, from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  assert(a >= 0 && b > a, 'anchor lost in main.js: ' + from)
  return source.slice(a, b)
}

function lastUser(payload) {
  const list = Array.isArray(payload?.messages) ? payload.messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') return String(list[i].content || '')
  }
  return ''
}

// Настоящий `runAgentSlot`; подставлен только прогон модели — он и запоминает
// `roleParts`, которые слот отдаёт сборщику запроса.
function buildSlot(source) {
  let shared = null
  const run = new Function('agentToolsAvailable', 'findModelRecord', 'lastUserMessage',
    'qualityContract', 'designQuality', 'runAgentLoop', 'streamChatOpenRouter',
    'fastEffort', 'fastPrompt', 'selfDevActive', 'buildGuideContext',
    cut(source, 'async function runAgentSlot(event, slot, payload, signal)', '\n// Always a string.') +
    ';return runAgentSlot')(
    () => false, () => ({}), lastUser,
    quality.qualityContract, quality.designQuality,
    async (event, payload) => { shared = payload }, async (event, payload) => { shared = payload },
    fastEffort, fastPrompt, () => false, buildGuideContext)
  return { run, parts: () => shared.roleParts }
}

async function scenario(source, { withSkill = true, failLead = false } = {}) {
  const assignments = new Map()
  const api = new Function('assignmentsByRequest', 'lastUserMessage', 'modePrompts',
    cut(source, 'function assignWorkSchema(helperCount)', 'async function runAgentMode') +
    ';return { recordAssignment, leadBrief, helperBrief, reviewBrief, critiqueBrief, isCollaborativeRequest }')(
    assignments, lastUser, require('../src/main/mode-prompts'))
  const boardApi = require('../src/main/agent-board')
  const slots = [
    { index: 0, name: 'Агент 1', modelId: 'chosen-model', modelName: 'model-0', supportsTools: true },
    { index: 1, name: 'Агент 2', modelId: 'helper-2:free', modelName: 'model-1', supportsTools: true },
    { index: 2, name: 'Агент 3', modelId: 'helper-3:free', modelName: 'model-2', supportsTools: true }
  ]
  const calls = []
  const reads = []
  const runContext = { record() {}, recordUsage() {}, transition() {}, recordSkillRead: item => reads.push(item) }
  const requestId = 'team-' + Math.random()
  let payload = {
    requestId, model: 'chosen-model', messages: [{ role: 'user', content: COLLAB }],
    customSystemPrompt: 'USER ROLE', runContext
  }
  // Как в send-message: привязка мода превращается в `modSkill` до сбора команды.
  if (withSkill) {
    payload = prepare(payload, {
      resolveSkill: () => ({ ok: true, action: { context: { modId: 'onlyone.project-checks' } },
        skill: { id: 'skill-1', systemPrompt: SKILL } })
    }).payload
  }
  let leadDown = failLead
  const runSlot = async (event, slot, sent, signal) => {
    if (leadDown && slot.index === 0 && sent.canAssign) {
      leadDown = false
      throw new Error('simulated lead outage')
    }
    // Свой прогон на вызов: помощники и критики идут параллельно, и общий
    // захват roleParts подменил бы части одной роли частями соседа.
    const runner = buildSlot(source)
    await runner.run(event, slot, sent, signal)
    calls.push({ slot, payload: sent, roleParts: runner.parts(),
      standIn: slot.index > 0 && sent.canAssign === true && !sent.isCritique })
    if (sent.isCritique) return { content: 'Возражение: край не проверен' }
    if (sent.canAssign) {
      api.recordAssignment(requestId, { assignments: [
        { agent: 2, title: 'Проверка', task: 'Проверь по коду', acceptance: 'Факты со ссылками', readOnly: true },
        { agent: 3, title: 'Края', task: 'Разбери края', acceptance: 'Сценарии', readOnly: true }
      ], review: false }, 2)
      return { content: 'Поручение от ведущего' }
    }
    return { content: 'Отчёт ' + slot.name }
  }
  const context = {
    resolveAgentSlots: () => slots, isCollaborativeRequest: api.isCollaborativeRequest,
    isFreeModel: id => id === 'chosen-model' || String(id).endsWith(':free'), LEAD_MODEL: 'z-ai/glm-5.3-flash',
    assignmentsByRequest: assignments, createCycle: require('../src/main/agent-cycle').createCycle,
    CRITIQUE_DEADLINE_MS: 10000, PART_DEADLINE_MS: 10000,
    leadBrief: api.leadBrief, helperBrief: api.helperBrief, reviewBrief: api.reviewBrief,
    critiqueBrief: api.critiqueBrief,
    lastUserMessage: lastUser,
    readyFor: new Function(cut(source, 'function readyFor(item, state)', 'function helperAssignmentMessage') + ';return readyFor')(),
    helperAssignmentMessage: new Function(cut(source, 'function helperAssignmentMessage(', 'function assignWorkSchema') + ';return helperAssignmentMessage')(),
    runAgentSlot: runSlot, describeOpenRouterError: error => error,
    sendToWindow: new Function(cut(source, 'function sendToWindow(event, channel, body)', 'async function runAgentMode') + ';return sendToWindow')(),
    failureReason: new Function('return ' + source.slice(source.indexOf('function failureReason('),
      source.indexOf('\n}', source.indexOf('function failureReason(')) + 2))(),
    seedBoard: boardApi.seedBoard, setTestsExpected: boardApi.setTestsExpected, projectHasTests: () => false,
    workspaceRoots: () => [], buildPrior: require('../src/main/prior-digest.cjs').buildPrior, rememberReports() {},
    reassignItem: boardApi.reassignItem, boardSnapshot: boardApi.boardSnapshot, boardBrief: boardApi.boardBrief,
    reviewBoardSection: id => {
      const report = boardApi.boardReport(id)
      return report ? '\n\n---\n\n' + report : ''
    }
  }
  const run = new Function(...Object.keys(context),
    cut(source, 'async function runAgentMode(event, payload, signal)', '\n// A tool call written') +
    ';return runAgentMode')(...Object.values(context))
  await run({ sender: { send() {} } }, payload, { aborted: false })
  return { calls, reads }
}

// Инструкция мода — отдельная часть роли, а не замена брифа роли: у каждой роли
// в roleParts лежат и её собственный customSystemPrompt, и текст навыка ровно раз.
function assertSkill(entry, label) {
  const skillParts = entry.roleParts.filter(part => part.includes(SKILL))
  assert.equal(skillParts.length, 1, label + ': mod skill part missing (or duplicated)')
  assert.ok(skillParts[0].includes(SKILL_HEAD), label + ': skill identity missing')
  assert.ok(entry.roleParts.some(part => part === entry.payload.customSystemPrompt),
    label + ': the role prompt vanished')
  assert.notEqual(skillParts[0], entry.payload.customSystemPrompt,
    label + ': the role prompt overwrote the mod skill')
}

async function contract(source) {
  const result = await scenario(source)
  const roles = {
    lead: result.calls.filter(call => call.slot.index === 0 && call.payload.canAssign === true && !call.payload.isCritique),
    helper: result.calls.filter(call => call.payload.readOnlyAssignment === true && !call.payload.isCritique),
    critic: result.calls.filter(call => call.payload.isCritique === true),
    acceptance: result.calls.filter(call => call.slot.index === 0 && call.payload.canAssign === false &&
      !call.payload.isCritique && String(call.payload.customSystemPrompt).includes('окончательная приёмка'))
  }
  for (const [role, entries] of Object.entries(roles)) {
    assert.ok(entries.length > 0, role + ': the role never reached runAgentSlot')
    for (const entry of entries) assertSkill(entry, role)
  }
  // У помощника свой бриф вместо брифа ведущего — и навык при этом на месте.
  assert.notEqual(roles.helper[0].payload.customSystemPrompt, roles.lead[0].payload.customSystemPrompt,
    'helper must receive its own brief, not the leader brief')
  assert.ok(!String(roles.helper[0].payload.customSystemPrompt).includes('USER ROLE'),
    'helper brief replaced by the user prompt instead of its own')
  // Журнал хода отмечает каждого работника, который действительно получил навык.
  assert.ok(result.reads.some(item => item.agentIndex === 0), 'journal: leader skill read not recorded')
  assert.ok(result.reads.some(item => item.agentIndex > 0), 'journal: helper skill read not recorded')
  assert.ok(result.reads.every(item => item.skillId === 'skill-1' && item.source === 'instruction'),
    'journal: skill read carries the wrong identity')

  // Подмена ведущего идёт с тем же payload — навык обязан быть и у неё.
  const standIn = (await scenario(source, { failLead: true })).calls.find(call => call.standIn)
  assert.ok(standIn, 'stand-in for the failed leader never ran')
  assertSkill(standIn, 'stand-in')

  // Без modSkill в payload ни одна роль не получает инструкцию.
  const plain = await scenario(source, { withSkill: false })
  assert.ok(plain.calls.length > 0, 'plain turn reached no role')
  for (const entry of plain.calls) {
    for (const part of entry.roleParts) {
      assert.ok(!part.includes(SKILL) && !part.includes(SKILL_HEAD),
        'skill instruction added without payload.modSkill (' + entry.slot.name + ')')
    }
    assert.equal(entry.payload.modSkill, undefined, 'modSkill appeared from nowhere')
  }
  return roles
}

function replaceOnce(source, pattern, replacement, label) {
  const matches = source.match(new RegExp(pattern.source, 'g'))
  assert.equal(matches && matches.length, 1, 'negative control anchor is not unique: ' + label)
  return source.replace(pattern, replacement)
}

async function main() {
  const roles = await contract(SOURCE)
  console.log('ok roles:', Object.entries(roles).map(([role, list]) => role + '=' + list.length).join(', '))

  // Негативный контроль: та же проверка обязана упасть, если исчезнет часть
  // modSkill или одно из распространений payload по ролям.
  const mutations = [
    ['modSkill role part', source => replaceOnce(source, /\n\s*payload\.modSkill\?\.prompt \|\| '',/, '', 'role part')],
    ['helper payload spread', source => replaceOnce(source, /(const helperPayload = \{)\r?\n\s+\.\.\.payload,/, '$1', 'helper')],
    ['critic payload spread', source => replaceOnce(source, /(runAgentSlot\(event, slot, \{)\r?\n\s+\.\.\.payload,/, '$1', 'critic')],
    ['acceptance payload spread', source => replaceOnce(source, /(const acceptancePayload = \{)\r?\n\s+\.\.\.payload,/, '$1', 'acceptance')]
  ]
  for (const [label, mutate] of mutations) {
    await assert.rejects(contract(mutate(SOURCE)), /mod skill/,
      'negative control did not catch a missing ' + label)
    console.log('ok negative control:', label)
  }
  console.log('PASS Mods team: the selected skill reaches the leader, helpers, critics, stand-in and final acceptance, never without payload.modSkill')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
