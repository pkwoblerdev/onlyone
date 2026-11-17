'use strict'
// Сквозная цепочка на фикстурах: предложение -> сохранение -> повторное чтение
// -> принятие -> повторное чтение. Каждый шаг проходит через JSON-копию, как
// настоящая запись на диск, а не через тот же объект в памяти.
const assert = require('node:assert/strict')
const model = require('../src/renderer/fork-proposal.js')
const store = require('../src/renderer/fork-proposal-store.js')
const context = require('../src/renderer/fork-proposal-context.js')
const { snapshot, child } = require('../src/renderer/chat-forks.js')

const disk = value => JSON.parse(JSON.stringify(value))
const forkApi = { snapshot, child }

const parent = { id: 'parent', title: 'Parent chat', projectId: 'p1', messages: [
  { role: 'user', content: 'First question', timestamp: 1 },
  { role: 'assistant', content: 'First answer', timestamp: 2 },
  { role: 'user', content: 'Second question', timestamp: 3 }
] }
const raw = { title: 'Parser subtask', goal: 'Fix the parser', reason: 'Separate area', context: { mode: 'messages', end: 1 } }
const proposal = model.normalize(raw, { parentChatId: parent.id, messages: parent.messages, now: 10 })

// 1. Сохранение и повторное чтение ожидающего предложения.
assert.equal(store.put(parent, proposal, { now: 10 }).ok, true)
const reopened = disk(parent)
const ledger = store.read(reopened)
assert.equal(ledger.ok, true)
assert.equal(ledger.proposals.length, 1)
const pending = ledger.proposals[0]
assert.equal(pending.status, 'pending')
assert.equal(pending.operationId, proposal.operationId)
assert.equal(pending.parentChatId, 'parent')
assert.equal(pending.context.revision, proposal.context.revision)
assert.equal(context.check(pending, { parent: reopened, conversations: [] }).ok, true, 'stored context still matches')

// 2. Принятие пишет дочерний чат, затем статус; обе записи переживают JSON.
const conversations = [reopened]
const first = model.accept(proposal, { source: reopened, conversations, forkApi, newId: 'child-1', now: 20, status: store.status(reopened, proposal.operationId) })
assert.equal(first.created, true)
conversations.unshift(first.chat)
assert.equal(store.setStatus(reopened, proposal.operationId, 'accepted', { childChatId: 'child-1', now: 20 }).ok, true)
const afterAccept = disk(conversations)
const accepted = store.read(afterAccept[1]).proposals[0]
assert.equal(accepted.status, 'accepted')
assert.equal(accepted.childChatId, 'child-1')
assert.equal(afterAccept[0].fork.parentChatId, 'parent')
assert.equal(afterAccept[0].fork.proposalOperationId, proposal.operationId)
assert.equal(context.check(accepted, { parent: afterAccept[1], conversations: afterAccept }).ok, true)
assert.equal(model.findChild(afterAccept, proposal.operationId, 'parent').id, 'child-1')

// 3. Повтор после перезапуска: второго чата нет, ребёнок находится.
const again = model.accept(proposal, { source: afterAccept[1], conversations: afterAccept, forkApi, newId: 'child-2', status: accepted.status })
assert.equal(again.created, false)
assert.equal(again.chat.id, 'child-1')
assert.equal(afterAccept.filter(chat => chat.fork?.proposalOperationId === proposal.operationId).length, 1)

// 4. Отклонение не возвращается как ожидающее.
const rejecting = disk({ id: 'rejecting', messages: parent.messages })
const rejectProposal = model.normalize(raw, { parentChatId: 'rejecting', messages: rejecting.messages, now: 30 })
store.put(rejecting, rejectProposal)
store.setStatus(rejecting, rejectProposal.operationId, 'rejected', { now: 30 })
const rejectedAgain = disk(rejecting)
assert.equal(store.read(rejectedAgain).proposals[0].status, 'rejected')
assert.equal(store.status(rejectedAgain, rejectProposal.operationId), 'rejected')
store.put(rejectedAgain, rejectProposal)
assert.equal(store.status(rejectedAgain, rejectProposal.operationId), 'rejected', 'repeat event does not revive a rejected proposal')
assert.equal(store.setStatus(rejectedAgain, rejectProposal.operationId, 'pending').ok, false)

// 5. Устаревший контекст: не принят и не подменён текущей историей.
const staleParent = disk(afterAccept[1])
staleParent.messages[1].content = 'Edited after the proposal'
assert.deepEqual(context.check(store.get(staleParent, proposal.operationId), { parent: staleParent, conversations: [] }),
  { ok: false, reason: 'revision-changed' })
assert.throws(() => model.accept(proposal, { source: staleParent, conversations: [], forkApi, newId: 'child-stale' }), /source-changed/)
assert.equal(staleParent.messages[1].content, 'Edited after the proposal', 'history is not rewritten')

// 6. Сбой записи статуса: чат есть, запись pending; reconcile чинит и переживает JSON.
const crashed = disk(afterAccept[1])
const crashedLedger = store.read(crashed)
crashed.forkProposals = crashedLedger.proposals.map(record => ({ ...record, status: 'pending', childChatId: null }))
const repaired = model.reconcile({ source: crashed, conversations: afterAccept, store, now: 40 })
assert.deepEqual(repaired, { repaired: 1 })
const repairedAgain = disk(crashed)
assert.equal(store.status(repairedAgain, proposal.operationId), 'accepted')
assert.equal(store.get(repairedAgain, proposal.operationId).childChatId, 'child-1')

// 7. Одна битая запись не прячет целую; неизвестный формат не перезаписывается.
const mixed = disk(afterAccept[1])
mixed.forkProposals.push({ version: 1, operationId: 'bad id', status: 'pending' })
const mixedLedger = store.read(mixed)
assert.equal(mixedLedger.ok, true)
assert.equal(mixedLedger.proposals.length, 1)
assert.equal(mixedLedger.skipped, 1)

const future = disk(afterAccept[1])
const futurePayload = { version: 2, note: 'written by a newer build' }
future.forkProposals = [futurePayload]
const futureRaw = JSON.stringify(future.forkProposals)
const refused = store.put(future, proposal)
assert.deepEqual(refused, { ok: false, reason: 'unknown-version' })
assert.equal(store.setStatus(future, proposal.operationId, 'accepted', { childChatId: 'x' }).ok, false)
assert.equal(JSON.stringify(future.forkProposals), futureRaw, 'unknown format is byte-identical')

// 8. Принятое без ребёнка: чат удалён, повторно не создаём.
const orphanProposal = model.normalize(raw, { parentChatId: 'orphaned', messages: parent.messages, now: 50 })
const orphanRecord = {
  version: 1,
  operationId: orphanProposal.operationId,
  parentChatId: 'orphaned',
  title: orphanProposal.title,
  goal: orphanProposal.goal,
  reason: orphanProposal.reason,
  context: { mode: 'messages', end: 1, revision: orphanProposal.context.revision, summary: '' },
  createdAt: 50,
  updatedAt: 50,
  status: 'accepted',
  childChatId: 'deleted-child',
  decidedAt: 50
}
const orphaned = disk({ id: 'orphaned', messages: parent.messages, forkProposals: [orphanRecord] })
assert.deepEqual(context.check(store.get(orphaned, orphanProposal.operationId), { parent: orphaned, conversations: [] }),
  { ok: false, reason: 'child-deleted' })
assert.throws(() => model.accept(orphanProposal, { source: orphaned, conversations: [], forkApi, newId: 'child-new', status: 'accepted' }), /child-missing/)

console.log('PASS fork proposal persistence: save -> reread -> accept -> reread, reject, duplicate, stale, crash, corruption')
