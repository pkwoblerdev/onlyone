'use strict'
// Принятие предложения связанного чата: один чат на операцию при двойном клике,
// повторе события и повторе после сбоя записи; отказ без ребёнка; восстановление
// статуса по уже созданному чату; никакого запуска модели.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const model = require('../src/renderer/fork-proposal.js')
const { snapshot, child } = require('../src/renderer/chat-forks.js')

const source = { id: 'parent', title: 'Parent chat', projectId: 'project', messages: [
  { role: 'user', content: 'First question', timestamp: 1 },
  { role: 'assistant', content: 'First answer', timestamp: 2 },
  { role: 'user', content: 'Second question', timestamp: 3 }
] }
const before = JSON.stringify(source)
const raw = { title: 'Parser subtask', goal: 'Fix the parser', reason: 'A separate area of work', context: { mode: 'messages', end: 1 } }
const proposal = model.normalize(raw, { parentChatId: 'parent', messages: source.messages, now: 10 })
const forkApi = { snapshot, child }

const record = (status, extra = {}) => ({
  version: 1,
  operationId: proposal.operationId,
  parentChatId: 'parent',
  title: proposal.title,
  goal: proposal.goal,
  reason: proposal.reason,
  context: { mode: 'messages', end: 1, revision: proposal.context.revision, summary: '' },
  createdAt: 10,
  updatedAt: 10,
  status,
  childChatId: null,
  decidedAt: null,
  ...extra
})

// Мини-хранилище по контракту §2: read не мутирует, setStatus правит запись.
function fakeStore (records, options = {}) {
  const calls = []
  const store = {
    calls,
    read: () => options.unreadable
      ? { ok: false, reason: 'invalid-shape' }
      : { ok: true, version: 1, proposals: records.map(item => ({ ...item })), skipped: 0 },
    setStatus: (chat, operationId, status, { childChatId = null, now } = {}) => {
      calls.push({ operationId, status, childChatId, now })
      if (options.refuse) return { ok: false, reason: 'not-allowed' }
      const item = records.find(entry => entry.operationId === operationId)
      item.status = status
      item.childChatId = childChatId
      item.decidedAt = now
      return { ok: true, record: { ...item } }
    }
  }
  return store
}

// Порядок app.js §6: принять, затем положить чат в ленту переписок.
const press = (conversations, options = {}) => {
  const result = model.accept(proposal, { source, conversations, forkApi, newId: 'child-' + (conversations.length + 1), now: 20, ...options })
  if (result.created) conversations.unshift(result.chat)
  return result
}

const conversations = []
const first = press(conversations)
assert.equal(first.created, true)
assert.equal(first.chat.id, 'child-1')
assert.equal(first.chat.fork.parentChatId, 'parent', 'one source of link')
assert.equal(first.chat.fork.proposalOperationId, proposal.operationId, 'stable child key')
assert.equal(first.chat.fork.kind, 'subtask')
assert.equal(first.chat.fork.mode, 'messages')

const second = press(conversations)
assert.equal(second.created, false, 'double click creates no second chat')
assert.equal(second.chat, first.chat)
assert.equal(conversations.length, 1)

const repeat = model.normalize(raw, { parentChatId: 'parent', messages: source.messages, now: 99 })
assert.equal(repeat.operationId, proposal.operationId)
assert.equal(model.accept(repeat, { source, conversations, forkApi, newId: 'child-repeat' }).created, false, 'repeat event creates no second chat')
assert.equal(conversations.length, 1)

// Сбой между созданием чата и записью статуса: запись осталась pending.
const retryConversations = []
press(retryConversations)
const retried = press(retryConversations, { status: 'pending' })
assert.equal(retried.created, false, 'retry after a failed record write returns the existing chat')
assert.equal(retried.chat.id, 'child-1')
assert.equal(retryConversations.length, 1)

// Сбой «чат создан — статус не обновлён»: reconcile чинит pending по ребёнку.
const crashed = record('pending')
const repairedStore = fakeStore([crashed])
const repaired = model.reconcile({ source, conversations: retryConversations, store: repairedStore, now: 30 })
assert.deepEqual(repaired, { repaired: 1 })
assert.deepEqual(repairedStore.calls, [{ operationId: proposal.operationId, status: 'accepted', childChatId: 'child-1', now: 30 }])
assert.equal(crashed.status, 'accepted')
assert.equal(crashed.childChatId, 'child-1')

const acceptedAgain = press(retryConversations, { status: 'accepted' })
assert.equal(acceptedAgain.created, false, 'accepted record with its child returns it')
assert.equal(acceptedAgain.chat.id, 'child-1')

// accepted без ребёнка: второй чат не создаётся.
assert.throws(() => press([], { status: 'accepted' }), /child-missing/)

// rejected: не создавать.
assert.throws(() => press([], { status: 'rejected' }), /proposal-rejected/)

// Изменённый контекст: принятие запрещено.
const edited = JSON.parse(JSON.stringify(source))
const stale = model.normalize(raw, { parentChatId: 'parent', messages: edited.messages })
edited.messages[1].content = 'Edited after the proposal'
assert.throws(() => model.accept(stale, { source: edited, conversations: [], forkApi, newId: 'child-stale' }), /source-changed/)

// findChild: родитель обязателен и сверяется.
assert.equal(model.findChild(conversations, proposal.operationId, 'parent'), first.chat)
assert.equal(model.findChild(conversations, proposal.operationId, 'other'), null)
assert.equal(model.findChild(conversations, proposal.operationId), null, 'parent is required')
assert.equal(model.findChild(null, proposal.operationId, 'parent'), null)
assert.equal(model.findAccepted(conversations, proposal.operationId), first.chat, 'findAccepted keeps its behaviour')

// reconcile не трогает accepted без ребёнка и не пишет в нечитаемую опись.
const orphan = record('accepted', { childChatId: 'deleted-child' })
const orphanStore = fakeStore([orphan])
assert.deepEqual(model.reconcile({ source, conversations: [], store: orphanStore, now: 40 }), { repaired: 0 })
assert.deepEqual(orphanStore.calls, [])

const unreadableStore = fakeStore([record('pending')], { unreadable: true })
assert.deepEqual(model.reconcile({ source, conversations: retryConversations, store: unreadableStore, now: 50 }), { repaired: 0, unreadable: true })
assert.deepEqual(unreadableStore.calls, [])

const refusedStore = fakeStore([record('pending')], { refuse: true })
assert.deepEqual(model.reconcile({ source, conversations: retryConversations, store: refusedStore, now: 60 }), { repaired: 0 }, 'store refusal is not an exception')
assert.equal(refusedStore.calls.length, 1)

assert.equal(JSON.stringify(source), before, 'parent untouched')

const moduleSource = fs.readFileSync(path.join(__dirname, '../src/renderer/fork-proposal.js'), 'utf8')
assert.doesNotMatch(moduleSource, /streamAgent|handleSendMessage/, 'accept path must not start the model')
assert.doesNotMatch(moduleSource, /sendMessage|runAgent/, 'accept path must not send messages')
console.log('PASS fork proposal accept: one child per operation, reject/child-missing/stale refusals, reconcile after a crash, no model start')
