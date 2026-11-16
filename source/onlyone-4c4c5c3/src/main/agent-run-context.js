'use strict'

const { randomUUID, createHash } = require('node:crypto')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value)
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function cleanObservations (snapshot) {
  const skillReads = (Array.isArray(snapshot.skillReads) ? snapshot.skillReads : []).slice(-128)
    .filter(item => item && isDigest(item.skillId) && isDigest(item.path) && isDigest(item.hash) &&
      ['instruction', 'file'].includes(item.source) && Number.isSafeInteger(item.agentIndex) && item.agentIndex >= 0 &&
      Number.isSafeInteger(item.bytes) && item.bytes >= 0)
    .map(item => ({ skillId: item.skillId, path: item.path, hash: item.hash, bytes: item.bytes, source: item.source, agentIndex: item.agentIndex }))
  const modelCalls = (Array.isArray(snapshot.modelCalls) ? snapshot.modelCalls : []).slice(-128)
    .filter(item => item && ['agent', 'chat', 'coordinator', 'judge', 'summary', 'closing'].includes(item.kind) && identifier(item.model) &&
      ['completed', 'failed', 'cancelled'].includes(item.outcome) && Number.isSafeInteger(item.agentIndex) && item.agentIndex >= 0 && isDigest(item.inputHash))
    .map(item => ({ kind: item.kind, model: item.model, answeredModel: identifier(item.answeredModel) ? item.answeredModel : null,
      agentIndex: item.agentIndex, outcome: item.outcome, inputHash: item.inputHash }))
  return { skillReads, modelCalls,
    droppedSkillReads: Number.isSafeInteger(snapshot.droppedSkillReads) && snapshot.droppedSkillReads >= 0 ? snapshot.droppedSkillReads : 0,
    droppedModelCalls: Number.isSafeInteger(snapshot.droppedModelCalls) && snapshot.droppedModelCalls >= 0 ? snapshot.droppedModelCalls : 0 }
}

function cleanConfigurations (entries) {
  if (!Array.isArray(entries)) return []
  return entries.slice(-32).filter(item => item && isDigest(item.id) && identifier(item.model) &&
    Number.isSafeInteger(item.agentIndex) && item.agentIndex >= 0 && isDigest(item.instructions) &&
    isDigest(item.toolSetHash) && isDigest(item.skillSetHash) &&
    Number.isSafeInteger(item.toolCount) && item.toolCount >= 0 && Number.isSafeInteger(item.skillCount) && item.skillCount >= 0 &&
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(item.reasoningEffort) &&
    Array.isArray(item.tools) && item.tools.length <= 256 && item.tools.every(tool => identifier(tool?.name) && isDigest(tool.hash)) &&
    Array.isArray(item.skills) && item.skills.length <= 128 && item.skills.every(skill => isDigest(skill?.id) && isDigest(skill.hash)))
    .map(item => ({ id: item.id, model: item.model, agentIndex: item.agentIndex, reasoningEffort: item.reasoningEffort,
      instructions: item.instructions, toolSetHash: item.toolSetHash, skillSetHash: item.skillSetHash,
      toolCount: item.toolCount, skillCount: item.skillCount, tools: item.tools.map(tool => ({ name: tool.name, hash: tool.hash })),
      skills: item.skills.map(skill => ({ id: skill.id, hash: skill.hash })) }))
}

function configurationRecord (snapshot) {
  if (!snapshot || !/^[a-f0-9-]{36}$/.test(snapshot.runId || '') || !Number.isFinite(snapshot.startedAt) ||
      !['running', 'completed', 'failed', 'cancelled', 'incomplete'].includes(snapshot.state)) return null
  const configurations = cleanConfigurations(snapshot.configurations)
  const observations = cleanObservations(snapshot)
  if (!configurations.length && !observations.modelCalls.length && !observations.skillReads.length) return null
  return { runId: snapshot.runId, startedAt: snapshot.startedAt, state: snapshot.state, configurations,
    ...observations,
    droppedConfigurations: Number.isSafeInteger(snapshot.droppedConfigurations) && snapshot.droppedConfigurations >= 0 ? snapshot.droppedConfigurations : 0 }
}

function saveConfigurationRecord (snapshot, { read, write }) {
  const record = configurationRecord(snapshot)
  if (!record) return false
  const previous = read()
  if (!Array.isArray(previous)) throw new TypeError('Invalid configuration history')
  const next = previous.map(configurationRecord).filter(item => item && item.runId !== record.runId)
  next.push(record)
  write(next.slice(-16))
  return true
}

const NEXT_PHASES = Object.freeze({
  plan: ['execute'],
  execute: ['verify'],
  verify: ['rework', 'finalize'],
  rework: ['execute'],
  finalize: []
})

// One context per user turn, shared by coordinator, workers and review passes.
// It contains no keys, prompts or tool arguments. This is accounting, not yet
// a restart checkpoint: replaying a journal must never repeat side effects.
function createRunContext({ requestId, surface = 'chat',
  durationMs, now = Date.now, journalLimit = 256 } = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new TypeError('Invalid run duration')
  if (!Number.isInteger(journalLimit) || journalLimit < 1) throw new TypeError('Invalid journal limit')
  if (!['chat', 'design'].includes(surface)) throw new TypeError('Invalid run surface')
  const runId = randomUUID()
  const startedAt = now()
  const deadlineAt = startedAt + durationMs
  const journal = []
  const configurations = []
  const skillReads = [], modelCalls = []
  let droppedSkillReads = 0, droppedModelCalls = 0
  let droppedConfigurations = 0
  let sequence = 0, dropped = 0, tokens = 0, usageReports = 0, totalCost = 0
  let state = 'running', endedAt = null, currentPhase = null
  let onChange = null
  const finiteCount = n => Number.isFinite(n) && n >= 0 ? n : 0

  function record(type, fields = {}) {
    if (state !== 'running') return
    const entry = { sequence: ++sequence, at: now(), type }
    // Explicit metadata allow-list: never persist provider payloads/secrets.
    for (const key of ['agentIndex', 'model', 'tokens', 'cost', 'outcome', 'phase', 'round', 'kind']) {
      if (typeof fields[key] === 'string') entry[key] = fields[key].slice(0, 160)
      else if (Number.isFinite(fields[key])) entry[key] = fields[key]
    }
    journal.push(entry)
    if (journal.length > journalLimit) { journal.shift(); dropped++ }
    notify()
  }
  function recordUsage(usage, fields = {}) {
    if (state !== 'running') return
    const total = Number(usage?.total_tokens)
    const count = Number.isFinite(total) && total >= 0 ? total
      : finiteCount(Number(usage?.prompt_tokens)) + finiteCount(Number(usage?.completion_tokens))
    tokens += count
    usageReports++
    const cost = Number(usage?.cost ?? usage?.total_cost)
    if (Number.isFinite(cost) && cost >= 0) {
      totalCost += cost
    }
    record('usage', { ...fields, tokens: count, ...(Number.isFinite(cost) && cost >= 0 ? { cost } : {}) })
  }
  function snapshot() {
    return {
      schemaVersion: 1, runId, requestId: String(requestId || ''),
      surface,
      startedAt, deadlineAt, endedAt, state, currentPhase,
      usage: { totalTokens: tokens, reports: usageReports, ...(totalCost > 0 ? { totalCost } : {}) },
      journal: journal.map(entry => ({ ...entry })), droppedEvents: dropped,
      ...cleanObservations({ skillReads, modelCalls, droppedSkillReads, droppedModelCalls }),
      ...(configurations.length ? { configurations: cleanConfigurations(configurations), droppedConfigurations } : {})
    }
  }
  function recordSkillRead (input = {}) {
    if (state !== 'running' || !Number.isSafeInteger(input.agentIndex) || input.agentIndex < 0 ||
        !['instruction', 'file'].includes(input.source) || typeof input.skillId !== 'string' || typeof input.content !== 'string') return false
    const item = { skillId: digest(input.skillId), path: digest(String(input.path || '')), source: input.source,
      hash: createHash('sha256').update(input.content).digest('hex'), bytes: Buffer.byteLength(input.content), agentIndex: input.agentIndex }
    if (skillReads.some(previous => JSON.stringify(previous) === JSON.stringify(item))) return true
    skillReads.push(item)
    if (skillReads.length > 128) { skillReads.shift(); droppedSkillReads++ }
    notify(); return true
  }
  function recordModelCall (input = {}) {
    if (state !== 'running') return false
    const clean = cleanObservations({ modelCalls: [{ ...input, inputHash: digest(input.body || {}) }] }).modelCalls[0]
    if (!clean) return false
    modelCalls.push(clean)
    if (modelCalls.length > 128) { modelCalls.shift(); droppedModelCalls++ }
    notify(); return true
  }
  function recordConfiguration (input = {}) {
    if (state !== 'running' || !identifier(input.model) || !Number.isSafeInteger(input.agentIndex) || input.agentIndex < 0) return false
    const tools = (Array.isArray(input.tools) ? input.tools : []).filter(tool => identifier(tool?.function?.name))
      .map(tool => ({ name: tool.function.name, hash: digest(tool.function) })).sort((a, b) => a.name.localeCompare(b.name))
    const skills = (Array.isArray(input.skills) ? input.skills : []).filter(skill => skill?.enabled)
      .map(skill => ({ id: digest(String(skill.id || '')), hash: digest({ name: skill.name, description: skill.description,
        systemPrompt: skill.systemPrompt, pack: skill.pack }) })).sort((a, b) => a.id.localeCompare(b.id))
    const body = { model: input.model, agentIndex: input.agentIndex,
      reasoningEffort: input.reasoningEffort || 'none', instructions: digest(String(input.systemPrompt || '')),
      toolSetHash: digest(tools), skillSetHash: digest(skills), toolCount: tools.length, skillCount: skills.length,
      tools: tools.slice(0, 256), skills: skills.slice(0, 128) }
    const item = { id: digest(body), ...body }
    if (!cleanConfigurations([item]).length) return false
    if (configurations.some(previous => previous.id === item.id)) return true
    configurations.push(item)
    if (configurations.length > 32) { configurations.shift(); droppedConfigurations++ }
    notify()
    return true
  }
  function notify() {
    if (!onChange) return
    try { onChange(snapshot()) } catch { /* persistence must never stop a run */ }
  }
  function transition(phase, fields = {}) {
    if (state !== 'running') return false
    if (!Object.hasOwn(NEXT_PHASES, phase)) throw new TypeError('Invalid run phase')
    const allowed = currentPhase === null ? phase === 'plan' : NEXT_PHASES[currentPhase]?.includes(phase)
    if (!allowed) {
      throw new Error(`Invalid run phase transition: ${currentPhase || 'start'} -> ${phase}`)
    }
    currentPhase = phase
    record('phase', { ...fields, phase })
    return true
  }
  function observeChanges(callback) {
    onChange = typeof callback === 'function' ? callback : null
    notify()
  }
  function finish(outcome) {
    if (state !== 'running') return snapshot()
    if (!['completed', 'failed', 'cancelled', 'incomplete'].includes(outcome)) throw new TypeError('Invalid run outcome')
    record('finished', { outcome })
    state = outcome
    endedAt = now()
    notify()
    return snapshot()
  }
  record('started')
  return Object.freeze({
    runId, startedAt, deadlineAt,
    expired: () => now() >= deadlineAt,
    remainingMs: () => Math.max(0, deadlineAt - now()),
    record, recordUsage, recordConfiguration, recordSkillRead, recordModelCall, transition, observeChanges, finish, snapshot,
    get currentPhase() { return currentPhase }
  })
}

module.exports = { createRunContext, NEXT_PHASES, cleanConfigurations, cleanObservations, configurationRecord, saveConfigurationRecord }
