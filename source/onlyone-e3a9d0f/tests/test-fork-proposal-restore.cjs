'use strict'
// Восстановление карточек предложений: план по описи, отказ от отклонённых,
// выключенное принятие при изменившемся контексте, удалённый ребёнок, отсутствие
// дублей и обработчиков при повторной перерисовке.
const assert = require('node:assert/strict')
const restore = require('../src/renderer/fork-proposal-restore.js')

const source = { id: 'parent', title: 'Parent chat', messages: [
  { role: 'user', content: 'Question', timestamp: 1 },
  { role: 'assistant', content: 'Answer', timestamp: 2 }
] }
const record = (operationId, status, extra = {}) => ({
  version: 1,
  operationId,
  parentChatId: 'parent',
  title: 'Task ' + operationId,
  goal: 'Goal',
  reason: '',
  context: { mode: 'messages', end: 0, revision: 'h:00000000', summary: '' },
  createdAt: 1,
  updatedAt: 1,
  status,
  childChatId: null,
  decidedAt: null,
  ...extra
})

const pending = record('op_pending1', 'pending')
const accepted = record('op_accepted1', 'accepted', { childChatId: 'child-1' })
const rejected = record('op_rejected1', 'rejected')
const broken = record('op_broken01', 'pending')

const store = {
  read: () => ({ ok: true, version: 1, proposals: [pending, accepted, rejected, broken], skipped: 0 })
}
const conversations = [{ id: 'child-1', fork: { parentChatId: 'parent', proposalOperationId: accepted.operationId } }]
const contextApi = {
  childOf: (list, operationId, parentChatId) => list.find(chat => chat.fork &&
    chat.fork.proposalOperationId === operationId && chat.fork.parentChatId === parentChatId) || null,
  check: item => item.operationId === broken.operationId ? { ok: false, reason: 'revision-changed' } : { ok: true }
}

const planned = restore.plan({ source, conversations, store, contextApi })
assert.equal(planned.ok, true)
assert.deepEqual(planned.entries.map(entry => entry.record.operationId), ['op_pending1', 'op_accepted1', 'op_broken01'], 'rejected is skipped')
assert.equal(planned.entries[0].problemCode, null)
assert.equal(planned.entries[1].status, 'accepted')
assert.equal(planned.entries[1].openChildId, 'child-1')
assert.equal(planned.entries[2].problemCode, 'context-changed')

const deleted = restore.plan({
  source,
  conversations: [],
  store: { read: () => ({ ok: true, version: 1, proposals: [accepted], skipped: 0 }) },
  contextApi
})
assert.equal(deleted.entries[0].problemCode, 'child-deleted')
assert.equal(deleted.entries[0].openChildId, null)

const unreadable = restore.plan({ source, conversations: [], store: { read: () => ({ ok: false, reason: 'invalid-shape' }) }, contextApi })
assert.deepEqual(unreadable, { ok: false, reason: 'invalid-shape' })

assert.equal(restore.plan({ source: null, store }).ok, false)
assert.equal(JSON.stringify(source), JSON.stringify({ id: 'parent', title: 'Parent chat', messages: source.messages }), 'plan does not mutate the source')

// ensure: один раз на чат, кэш не даёт задвоить карточки и обработчики.
let appended = 0
const container = { appendChild: () => { appended++ } }
const cache = new Map()
const mounts = []
const calls = { accept: 0, reject: 0, open: 0 }
const mountCard = (target, proposal, options) => {
  mounts.push({ proposal, options })
  target.appendChild({})
  return { proposal, options }
}
const first = restore.ensure({
  source, conversations, container, cache, store, contextApi, mountCard, t: text => text,
  parentTitle: 'Parent chat',
  handlers: {
    onAccept: () => { calls.accept++ },
    onReject: () => { calls.reject++ },
    onOpenChild: () => { calls.open++ }
  }
})
assert.deepEqual(first, { ok: true, mounted: 3, skipped: 0 })
assert.equal(appended, 3)
assert.equal(mounts[0].options.status, 'pending')
assert.equal(mounts[0].options.problem, null)
assert.equal(mounts[1].options.status, 'accepted')
assert.equal(mounts[1].options.problem, null, 'accepted with a child has no problem')
assert.match(mounts[2].options.problem.text, /Контекст предложения изменился/)
assert.equal(calls.accept + calls.reject, 0, 'restore never decides by itself')
assert.equal(typeof mounts[1].options.onRun, 'function', 'accepted card with a child offers run')
 mounts[1].options.onOpenChild()
assert.equal(calls.open, 1, 'accepted card opens the existing child')

const second = restore.ensure({ source, conversations, container, cache, store, contextApi, mountCard, t: text => text, handlers: {} })
assert.deepEqual(second, { ok: true, mounted: 0, skipped: 3 }, 'redraw does not duplicate cards or handlers')
assert.equal(appended, 3)

const cacheWithKey = new Map([['parent:op_pending1', { chatId: 'parent' }]])
const partial = restore.ensure({ source, conversations, container, cache: cacheWithKey, store, contextApi, mountCard, t: text => text, handlers: {} })
assert.deepEqual(partial, { ok: true, mounted: 2, skipped: 1 })

console.log('PASS fork proposal restore: pending and accepted restored, rejected skipped, problems visible, no duplicates')

