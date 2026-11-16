'use strict'
// Опись предложений связанного чата: чтение без мутации, идемпотентная запись,
// разрешённые переходы статуса, терпимость к битым записям и отказ трогать
// опись неизвестного формата.
const assert = require('node:assert/strict')
const model = require('../src/renderer/fork-proposal.js')
const store = require('../src/renderer/fork-proposal-store.js')

assert.equal(store.RECORD_VERSION, 1)
assert.deepEqual(store.STATUSES, ['pending', 'accepted', 'rejected'])

const messages = [
  { role: 'user', content: 'First question', timestamp: 1 },
  { role: 'assistant', content: 'First answer', timestamp: 2 }
]
const proposal = model.normalize({
  title: '  Parser subtask  ',
  goal: 'Fix the parser without touching the renderer',
  reason: 'A separate area of work',
  context: { mode: 'messages', end: 0 }
}, { parentChatId: 'parent', messages, now: 100 })
const id = proposal.operationId

function expectedRecord (proposal, now, status) {
  return {
    version: 1,
    operationId: proposal.operationId,
    parentChatId: 'parent',
    title: proposal.title,
    goal: proposal.goal,
    reason: proposal.reason,
    context: {
      mode: proposal.context.mode,
      end: proposal.context.end,
      revision: proposal.context.revision,
      summary: proposal.context.summary
    },
    createdAt: now,
    updatedAt: now,
    status,
    childChatId: null,
    decidedAt: null
  }
}

// --- пустая и отсутствующая опись ---
const empty = { id: 'parent' }
const emptyBefore = JSON.stringify(empty)
assert.deepEqual(store.read(empty), { ok: true, version: 1, proposals: [], skipped: 0 })
assert.deepEqual(store.read({ id: 'parent', forkProposals: [] }), { ok: true, version: 1, proposals: [], skipped: 0 })
assert.deepEqual(store.read(null), { ok: false, reason: 'invalid-chat' })
assert.deepEqual(store.pending(empty), [])
assert.equal(store.get(empty, id), null)
assert.equal(store.status(empty, id), null)
assert.equal(store.isRejected(empty, id), false)
assert.equal(JSON.stringify(empty), emptyBefore, 'read does not mutate the chat')

// --- запись и чтение через диск ---
const chat = { id: 'parent' }
const first = store.put(chat, proposal, { now: 200 })
assert.equal(first.ok, true)
assert.equal(first.existing, false)
assert.deepEqual(first.record, expectedRecord(proposal, 200, 'pending'))
assert.equal(chat.forkProposals.length, 1)

const disk = JSON.parse(JSON.stringify(chat))
const reread = store.read(disk)
assert.equal(reread.ok, true)
assert.equal(reread.skipped, 0)
assert.deepEqual(reread.proposals, [expectedRecord(proposal, 200, 'pending')])
assert.equal(store.status(disk, id), 'pending')
assert.equal(store.isPending(disk, id), true)

const renamed = store.put(disk, { ...proposal, title: 'Renamed after delivery' }, { now: 300 })
assert.equal(renamed.ok, true)
assert.equal(renamed.existing, true)
assert.deepEqual(renamed.record, expectedRecord(proposal, 200, 'pending'), 'repeat delivery keeps the first record')
assert.equal(disk.forkProposals.length, 1, 'one record per operation id')

// --- pending -> accepted ---
const accepted = store.setStatus(disk, id, 'accepted', { childChatId: 'child-1', now: 400 })
assert.equal(accepted.ok, true)
assert.equal(store.status(disk, id), 'accepted')
assert.equal(store.isAccepted(disk, id), true)
assert.equal(store.isPending(disk, id), false)
assert.equal(store.isRejected(disk, id), false)
const acceptedRecord = store.get(disk, id)
assert.equal(acceptedRecord.childChatId, 'child-1')
assert.equal(acceptedRecord.decidedAt, 400)
assert.equal(acceptedRecord.updatedAt, 400)
assert.equal(acceptedRecord.createdAt, 200, 'creation time survives the decision')

const againAccepted = store.setStatus(disk, id, 'accepted', { childChatId: 'child-1', now: 500 })
assert.equal(againAccepted.ok, true)
assert.equal(store.get(disk, id).updatedAt, 400, 'same status is a no-op')
assert.equal(store.setStatus(disk, id, 'pending', { now: 600 }).reason, 'not-allowed')
assert.equal(store.setStatus(disk, id, 'rejected', { now: 600 }).reason, 'not-allowed')
assert.equal(store.status(disk, id), 'accepted')

const late = store.put(disk, proposal, { now: 700 })
assert.equal(late.existing, true)
assert.equal(late.record.status, 'accepted', 'repeat delivery does not reset the decision')
assert.equal(store.get(disk, id).updatedAt, 400)
assert.deepEqual(store.pending(disk), [])

// --- pending -> rejected, обратный переход запрещён ---
const rejectChat = { id: 'parent' }
store.put(rejectChat, proposal, { now: 10 })
const rejected = store.setStatus(rejectChat, id, 'rejected', { now: 20 })
assert.equal(rejected.ok, true)
assert.equal(rejected.record.status, 'rejected')
assert.equal(rejected.record.decidedAt, 20)
assert.equal(rejected.record.childChatId, null)
assert.equal(store.isRejected(rejectChat, id), true)
assert.equal(store.setStatus(rejectChat, id, 'rejected', { now: 30 }).ok, true)
assert.equal(store.get(rejectChat, id).updatedAt, 20, 'repeat rejection is a no-op')
assert.equal(store.setStatus(rejectChat, id, 'accepted', { childChatId: 'child-1', now: 40 }).reason, 'not-allowed')
assert.equal(store.status(rejectChat, id), 'rejected')

assert.equal(store.setStatus(rejectChat, 'fp_unknown1', 'rejected').reason, 'not-found')
assert.equal(store.setStatus(rejectChat, id, 'pending').reason, 'not-allowed')
assert.equal(store.setStatus(rejectChat, 'bad id', 'rejected').reason, 'invalid-operation-id')
assert.equal(store.setStatus(rejectChat, id, 'maybe').reason, 'invalid-status')

const noChild = { id: 'parent' }
store.put(noChild, proposal, { now: 1 })
assert.equal(store.setStatus(noChild, id, 'accepted', { now: 2 }).reason, 'invalid-child')
assert.equal(store.status(noChild, id), 'pending', 'accepted without a child is refused')

// --- битые записи пропускаются, целые читаются ---
const good = expectedRecord(proposal, 5, 'pending')
const dirty = {
  id: 'parent',
  forkProposals: [
    42,
    { ...good, operationId: 'fp_foreign1', parentChatId: 'other' },
    { ...good, operationId: 'fp_badstate1', status: 'maybe' },
    { ...good, operationId: 'bad id' },
    { ...good, operationId: 'fp_version01', version: 0 },
    good
  ]
}
const dirtyRead = store.read(dirty)
assert.equal(dirtyRead.ok, true)
assert.equal(dirtyRead.proposals.length, 1)
assert.equal(dirtyRead.skipped, 5)
assert.deepEqual(dirtyRead.proposals[0], good)

const fresh = store.put(dirty, { ...proposal, operationId: 'fp_fresh001', title: 'Fresh' }, { now: 9 })
assert.equal(fresh.ok, true)
assert.equal(dirty.forkProposals[0], 42, 'corrupt entries are kept, not overwritten')
assert.equal(dirty.forkProposals.length, 7)
assert.equal(store.read(dirty).skipped, 5)
assert.equal(store.read(dirty).proposals.length, 2)

// --- неизвестная версия: вся опись нечитаема и не перезаписывается ---
const future = { id: 'parent', forkProposals: [good, { ...good, version: 2, operationId: 'fp_future001' }] }
const futureBefore = JSON.stringify(future)
assert.deepEqual(store.read(future), { ok: false, reason: 'unknown-version' })
assert.equal(store.put(future, proposal, { now: 1 }).ok, false)
assert.equal(store.setStatus(future, id, 'accepted', { childChatId: 'child-1', now: 1 }).ok, false)
assert.equal(store.pending(future).length, 0)
assert.equal(store.get(future, id), null)
assert.equal(JSON.stringify(future), futureBefore, 'unknown ledger stays byte-identical')

// --- опись не массив ---
const brokenField = { 0: good }
const broken = { id: 'parent', forkProposals: brokenField }
const brokenBefore = JSON.stringify(broken)
assert.deepEqual(store.read(broken), { ok: false, reason: 'invalid-shape' })
assert.equal(store.put(broken, proposal, { now: 1 }).ok, false)
assert.equal(store.setStatus(broken, id, 'accepted', { childChatId: 'child-1', now: 1 }).ok, false)
assert.equal(broken.forkProposals, brokenField, 'the field keeps its identity')
assert.equal(JSON.stringify(broken), brokenBefore, 'broken ledger stays byte-identical')
assert.equal(store.isRejected(broken, id), false)

// --- старое отклонение ---
const dismissedId = 'fp_1a2b3c4d'
const legacy = { id: 'parent', forkProposalDismissed: [dismissedId] }
const legacyBefore = JSON.stringify(legacy.forkProposalDismissed)
assert.equal(store.status(legacy, dismissedId), 'rejected')
assert.equal(store.isRejected(legacy, dismissedId), true)
assert.equal(store.isPending(legacy, dismissedId), false)
assert.equal(store.get(legacy, dismissedId), null)
const legacyPut = store.put(legacy, { ...proposal, operationId: dismissedId }, { now: 10 })
assert.equal(legacyPut.ok, true)
assert.equal(legacyPut.record.status, 'rejected', 'legacy dismissal is not resurrected')
assert.equal(legacy.record === undefined, true)
assert.equal(store.status(legacy, dismissedId), 'rejected')
assert.equal(store.setStatus(legacy, dismissedId, 'accepted', { childChatId: 'child-1', now: 20 }).reason, 'not-allowed')
assert.equal(JSON.stringify(legacy.forkProposalDismissed), legacyBefore, 'legacy field is not modified')

// --- отказы входа, потолки текста, время только аргументом ---
assert.equal(store.put({ id: 'other' }, proposal, { now: 1 }).reason, 'invalid-parent')
assert.equal(store.put({ id: 'parent' }, null, { now: 1 }).reason, 'invalid-proposal')
assert.equal(store.put({ id: 'parent' }, { ...proposal, operationId: 'bad id' }, { now: 1 }).reason, 'invalid-operation-id')
assert.equal(store.put({ id: 'parent' }, { ...proposal, operationId: 'fp_status01' }, { status: 'maybe', now: 1 }).reason, 'invalid-status')
assert.equal(store.put({ id: 'parent' }, { ...proposal, context: { mode: 'messages', end: -1 } }, { now: 1 }).reason, 'invalid-proposal')
assert.equal(store.put({ id: 'parent' }, { ...proposal, title: '  ' }, { now: 1 }).reason, 'invalid-proposal')

const longChat = { id: 'parent' }
const long = store.put(longChat, { ...proposal, operationId: 'fp_longtext1', title: 'x'.repeat(300) })
assert.equal(long.ok, true)
assert.equal(long.record.title.length, 200, 'title capped like the model')
assert.equal(long.record.createdAt, 100, 'no wall clock: time comes from the proposal when now is absent')
assert.equal(store.put({ id: 'parent' }, { ...proposal, reason: 'y'.repeat(2000) }, { now: 3 }).record.reason.length, 1000)

// --- потолки: 20 записей на чат, 5 ожидающих ---
assert.ok(Object.isFrozen(store.LIMITS), 'limits are frozen')
assert.equal(store.LIMITS.maxProposals, 20)
assert.equal(store.LIMITS.maxPending, 5)
assert.equal(store.LIMITS.title, 200)

const bulk = { id: 'parent' }
for (let index = 0; index < 19; index++) {
  const put = store.put(bulk, { ...proposal, operationId: 'fp_bulk' + String(index).padStart(3, '0') }, { status: 'rejected', now: index })
  assert.equal(put.ok, true, 'record ' + index + ' fits under the limit')
}
assert.equal(bulk.forkProposals.length, 19)
assert.equal(store.put(bulk, { ...proposal, operationId: 'fp_bulk019' }, { status: 'rejected', now: 19 }).ok, true, 'the 20th record fits')
assert.equal(bulk.forkProposals.length, 20)
const bulkBefore = JSON.stringify(bulk)
assert.deepEqual(store.put(bulk, { ...proposal, operationId: 'fp_bulk020' }, { status: 'rejected', now: 20 }), { ok: false, reason: 'limit' })
assert.equal(JSON.stringify(bulk), bulkBefore, 'a full ledger is not touched by a refused record')
const repeatAtLimit = store.put(bulk, { ...proposal, operationId: 'fp_bulk000' }, { now: 21 })
assert.equal(repeatAtLimit.ok, true, 'an existing record is still returned at the limit')
assert.equal(repeatAtLimit.existing, true)
assert.equal(repeatAtLimit.record.status, 'rejected')
assert.equal(bulk.forkProposals.length, 20)

const waiting = { id: 'parent' }
for (let index = 0; index < 4; index++) {
  assert.equal(store.put(waiting, { ...proposal, operationId: 'fp_wait' + String(index).padStart(3, '0') }, { now: index }).ok, true)
}
assert.equal(store.pending(waiting).length, 4)
assert.equal(store.put(waiting, { ...proposal, operationId: 'fp_wait004' }, { now: 4 }).ok, true, 'the 5th pending proposal fits')
assert.equal(store.pending(waiting).length, 5)
const waitingBefore = JSON.stringify(waiting)
assert.deepEqual(store.put(waiting, { ...proposal, operationId: 'fp_wait005' }, { now: 5 }), { ok: false, reason: 'limit' })
assert.equal(JSON.stringify(waiting), waitingBefore, 'a full pending set is not touched')
const repeatPending = store.put(waiting, { ...proposal, operationId: 'fp_wait000' }, { now: 6 })
assert.equal(repeatPending.ok, true)
assert.equal(repeatPending.existing, true, 'repeat delivery is idempotent at the pending limit')
assert.equal(store.pending(waiting).length, 5)
assert.equal(store.put(waiting, { ...proposal, operationId: 'fp_wait006' }, { status: 'rejected', now: 7 }).ok, true,
  'a decided record is not blocked by the pending limit')

// Запись из испорченного файла читается с теми же пределами, что и пишется:
// мегабайтный заголовок не должен доходить до карточки, а сама опись — меняться.
const huge = {
  id: 'huge',
  forkProposals: [{
    version: 1,
    operationId: 'fp_huge0001',
    parentChatId: 'huge',
    title: 'x'.repeat(1024 * 1024),
    goal: 'y'.repeat(5000),
    reason: 'z'.repeat(2000),
    context: { mode: 'summary', end: null, revision: '', summary: 's'.repeat(9000) },
    createdAt: 1,
    updatedAt: 1,
    status: 'pending',
    childChatId: null,
    decidedAt: null
  }]
}
const hugeBefore = JSON.stringify(huge)
const hugeRead = store.read(huge)
assert.equal(hugeRead.proposals[0].title.length, store.LIMITS.title, 'stored title is clamped on read')
assert.equal(hugeRead.proposals[0].goal.length, store.LIMITS.goal, 'stored goal is clamped on read')
assert.equal(hugeRead.proposals[0].reason.length, store.LIMITS.reason, 'stored reason is clamped on read')
assert.equal(hugeRead.proposals[0].context.summary.length, store.LIMITS.summary, 'stored summary is clamped on read')
assert.equal(JSON.stringify(huge), hugeBefore, 'read does not rewrite the stored ledger')

// Дубликат operationId в испорченной описи: одна карточка и один статус.
const duplicate = { id: 'dup', messages: [], forkProposals: [
  { ...JSON.parse(JSON.stringify(huge.forkProposals[0])), operationId: 'fp_dup00001', parentChatId: 'dup', title: 'first', goal: 'g', reason: '', context: { mode: 'summary', end: null, revision: '', summary: 's' } },
  { ...JSON.parse(JSON.stringify(huge.forkProposals[0])), operationId: 'fp_dup00001', parentChatId: 'dup', title: 'second', goal: 'g', reason: '', context: { mode: 'summary', end: null, revision: '', summary: 's' } }
] }
const dupRead = store.read(duplicate)
assert.equal(dupRead.proposals.length, 1, 'duplicate operation ids are read once')
assert.equal(dupRead.proposals[0].title, 'first', 'the first record owns the decision')
assert.equal(dupRead.skipped, 1, 'the duplicate is counted as skipped')

console.log('PASS: fork proposal ledger: empty read, put idempotency, decision transitions, corrupt entries, unknown ledger, legacy dismissal, limits, stored text caps')
