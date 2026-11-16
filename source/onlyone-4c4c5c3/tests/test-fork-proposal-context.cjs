'use strict'
// Контекст предложения связанного чата: родитель, граница истории, ревизия.
// Проверка не подменяет изменившийся контекст текущей историей и не создаёт
// дочерний чат для записи, которая уже «принята», но ребёнка больше нет.
const assert = require('node:assert/strict')
const model = require('../src/renderer/fork-proposal.js')
const ctx = require('../src/renderer/fork-proposal-context.js')

const parent = { id: 'parent', messages: [
  { role: 'user', content: 'First question', timestamp: 1 },
  { role: 'assistant', content: 'First answer', timestamp: 2 },
  { role: 'user', content: 'Second question', timestamp: 3 }
] }
const raw = { title: 'Parser subtask', goal: 'Fix the parser', reason: 'Separate area', context: { mode: 'messages', end: 1 } }
const proposal = model.normalize(raw, { parentChatId: 'parent', messages: parent.messages, now: 10 })
const record = {
  version: 1,
  operationId: proposal.operationId,
  parentChatId: 'parent',
  title: proposal.title,
  goal: proposal.goal,
  reason: proposal.reason,
  context: { mode: 'messages', end: 1, revision: proposal.context.revision, summary: '' },
  createdAt: 10,
  updatedAt: 10,
  status: 'pending',
  childChatId: null,
  decidedAt: null
}
const child = { id: 'child', fork: { parentChatId: 'parent', proposalOperationId: proposal.operationId } }

assert.equal(ctx.revisionOf(parent.messages, 1), proposal.context.revision, 'same revision algorithm as the model')
assert.deepEqual(ctx.check(record, { parent, conversations: [] }), { ok: true })

const before = JSON.stringify({ parent, record, conversations: [child] })
assert.deepEqual(ctx.check(record, { parent, conversations: [child] }), { ok: true })
assert.equal(JSON.stringify({ parent, record, conversations: [child] }), before, 'check does not mutate')

assert.deepEqual(ctx.check(record, { conversations: [] }), { ok: false, reason: 'parent-missing' })
assert.deepEqual(ctx.check(record, { parent: { id: 'other', messages: parent.messages }, conversations: [] }), { ok: false, reason: 'parent-mismatch' })
assert.deepEqual(ctx.check({ ...record, context: { ...record.context, end: -1 } }, { parent, conversations: [] }), { ok: false, reason: 'boundary-missing' })
assert.deepEqual(ctx.check({ ...record, context: { ...record.context, end: 99 } }, { parent, conversations: [] }), { ok: false, reason: 'boundary-changed' })
assert.deepEqual(ctx.check({ ...record, context: { ...record.context, revision: '' } }, { parent, conversations: [] }), { ok: false, reason: 'revision-missing' })

const edited = JSON.parse(JSON.stringify(parent))
edited.messages[1].content = 'Edited after the proposal'
assert.deepEqual(ctx.check(record, { parent: edited, conversations: [] }), { ok: false, reason: 'revision-changed' }, 'changed context is refused, not replaced')

const summary = { ...record, context: { mode: 'summary', end: null, revision: '', summary: 'Only the summary' } }
assert.deepEqual(ctx.check(summary, { parent, conversations: [] }), { ok: true }, 'summary without a boundary has nothing to revise')

const accepted = { ...record, status: 'accepted', childChatId: 'child' }
assert.deepEqual(ctx.check(accepted, { parent, conversations: [child] }), { ok: true, child })
assert.deepEqual(ctx.check(accepted, { parent, conversations: [] }), { ok: false, reason: 'child-deleted' })
assert.deepEqual(ctx.check(accepted, { parent, conversations: [{ id: 'foreign', fork: { parentChatId: 'other', proposalOperationId: record.operationId } }] }),
  { ok: false, reason: 'child-deleted' }, 'a child of another parent is not this child')

assert.equal(ctx.childOf([child], record.operationId, 'parent'), child)
assert.equal(ctx.childOf([child], record.operationId, 'other'), null)
assert.equal(ctx.childOf([child], record.operationId), null, 'parent is required')

const legacy = { id: 'old', messages: [] }
const legacyCheck = ctx.check({ ...record, parentChatId: 'old', context: { ...record.context, end: null } }, { parent: legacy, conversations: [] })
assert.equal(legacyCheck.ok, false, 'legacy chat without messages is a refusal, not a crash')

console.log('PASS fork proposal context: parent, boundary, revision, child-deleted, no substitution')
