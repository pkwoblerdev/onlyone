'use strict'
// Сводная карточка «Связанные задачи · N»: считаются только записи описи.
// Ожидающие — отдельные карточки, здесь лишь счётчик; созданные дают строку с
// заголовком дочернего чата. Статусов исполнения не выдумываем — источника нет.
const assert = require('node:assert/strict')
const proposal = require('../src/renderer/fork-proposal.js')
const store = require('../src/renderer/fork-proposal-store.js')

const base = (operationId, title, context = { mode: 'messages', end: 0, revision: 'h:00000000' }) => ({
  operationId,
  parentChatId: 'parent',
  title,
  goal: 'Goal',
  reason: '',
  context
})

const source = { id: 'parent', title: 'Parent', messages: [{ role: 'user', content: 'q', timestamp: 1 }] }
const put = (shape, status, extra) => {
  const result = store.put(source, shape, { now: 1 })
  assert.equal(result.ok, true, 'put ' + shape.operationId)
  if (status) assert.equal(store.setStatus(source, shape.operationId, status, { now: 2, ...extra }).ok, true)
}

put(base('op_pending01', 'Pending one'), 'pending')
put(base('op_pending02', 'Pending two', { mode: 'summary', end: null, revision: '', summary: 'Short.' }), 'pending')
put(base('op_accepted1', 'Accepted one'), 'accepted', { childChatId: 'child-1' })
put(base('op_accepted2', 'Accepted two'), 'accepted', { childChatId: 'child-gone' })
put(base('op_rejected1', 'Rejected one'), 'rejected')

const conversations = [
  source,
  { id: 'child-1', title: 'Child one', fork: { parentChatId: 'parent', proposalOperationId: 'op_accepted1' } }
]
const before = JSON.stringify({ source, conversations })

const summary = proposal.summaryOf(source, conversations, store)
assert.equal(summary.ok, true)
assert.equal(summary.pending, 2, 'pending proposals are counted, not listed twice')
assert.equal(summary.created, 2, 'accepted proposals are counted as created')
assert.deepEqual(summary.rows.map(row => [row.operationId, row.chatId, row.title]), [
  ['op_accepted1', 'child-1', 'Child one'],
  ['op_accepted2', null, 'Accepted two']
], 'one row per accepted child, deleted child keeps its title without a target')
assert.equal(JSON.stringify({ source, conversations }), before, 'summary does not mutate the chat')
const summaryRunning = proposal.summaryOf(source, conversations, store, new Set(['child-1']))
assert.equal(summaryRunning.rows[0].running, true, 'a live child run is marked as running')
assert.equal(summaryRunning.rows[1].running, false, 'a missing child is not running')

assert.deepEqual(proposal.summaryOf({ id: 'empty', title: 'Empty' }, [], store),
  { ok: true, pending: 0, created: 0, rows: [] }, 'a chat without proposals has nothing to summarize')

assert.deepEqual(proposal.summaryOf({ id: 'parent', forkProposals: 'broken' }, [], store),
  { ok: false, reason: 'invalid-shape' }, 'an unreadable ledger is not summarized')
assert.deepEqual(proposal.summaryOf(source, [], null), { ok: false, reason: 'store-required' })
assert.deepEqual(proposal.summaryOf(null, [], store), { ok: false, reason: 'invalid-source' })

console.log('PASS fork proposal summary: pending and created counted, accepted children listed, no invented states')
