'use strict'
// Чистая модель предложения связанного чата: структура, граница контекста,
// устойчивый id операции, ровно один дочерний чат и совместимость с деревом
// (единственный источник связи — chat.fork.parentChatId).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const model = require('../src/renderer/fork-proposal.js')
const { snapshot, child } = require('../src/renderer/chat-forks.js')
const { TOOL_DEFINITION, createForkProposalTool } = require('../src/main/fork-proposal-tool.cjs')

const source = { id: 'parent', title: 'Parent chat', projectId: 'project', messages: [
  { role: 'user', content: 'First question', timestamp: 1 },
  { role: 'assistant', content: 'First answer', timestamp: 2, undoId: 'never-copy' },
  { role: 'user', content: [{ type: 'text', text: 'Second question' }, { type: 'image_url', image_url: { url: 'private' } }], timestamp: 3, attachments: [{ path: 'private' }] }
] }
const before = JSON.stringify(source)
const raw = {
  title: '  Parser subtask  ',
  goal: 'Fix the parser without touching the renderer',
  reason: 'A separate area of work',
  context: { mode: 'messages', end: 1 }
}

const proposal = model.normalize(raw, { parentChatId: 'parent', messages: source.messages, now: 10 })
assert.equal(proposal.title, 'Parser subtask', 'title trimmed')
assert.equal(proposal.parentChatId, 'parent')
assert.equal(proposal.context.end, 1)
assert.match(proposal.operationId, /^fp_[0-9a-f]{8}$/, 'derived stable operation id')
assert.equal(model.normalize(raw, { parentChatId: 'parent', messages: source.messages, now: 99 }).operationId, proposal.operationId, 'same content -> same operation id')
assert.notEqual(model.normalize({ ...raw, goal: 'Another goal' }, { parentChatId: 'parent', messages: source.messages }).operationId, proposal.operationId)
assert.equal(model.normalize({ ...raw, operationId: 'op-12345678' }, { parentChatId: 'parent', messages: source.messages }).operationId, 'op-12345678', 'explicit id kept when valid')
assert.notEqual(model.normalize({ ...raw, operationId: 'bad id' }, { parentChatId: 'parent', messages: source.messages }).operationId, 'bad id', 'invalid explicit id falls back to derived')

assert.throws(() => model.normalize({ ...raw, title: '  ' }, { parentChatId: 'parent' }), /empty-title/)
assert.throws(() => model.normalize({ ...raw, goal: '' }, { parentChatId: 'parent' }), /empty-goal/)
assert.throws(() => model.normalize({ ...raw, context: { mode: 'summary' } }, { parentChatId: 'parent' }), /empty-summary/)
assert.throws(() => model.normalize({ ...raw, context: { mode: 'other' } }, { parentChatId: 'parent' }), /invalid-context-mode/)
assert.throws(() => model.normalize({ ...raw, context: { mode: 'messages' } }, { parentChatId: 'parent' }), /missing-boundary/)
assert.throws(() => model.normalize({ ...raw, context: { mode: 'messages', end: 99 } }, { parentChatId: 'parent', messages: source.messages }), /invalid-boundary/)
assert.throws(() => model.normalize(raw, { messages: source.messages }), /invalid-parent/)
assert.equal(model.normalize({ ...raw, context: { mode: 'messages' } }, { parentChatId: 'parent', messages: source.messages }).context.end, 2, 'omitted boundary takes the whole fixed context')
assert.ok(model.normalize({ ...raw, title: 'x'.repeat(400) }, { parentChatId: 'parent' }).title.length <= 200, 'title capped')

const first = model.accept(proposal, { source, conversations: [], forkApi: { snapshot, child }, newId: 'child-1', now: 20 })
assert.equal(first.created, true)
assert.equal(first.chat.id, 'child-1')
assert.equal(first.chat.title, 'Parser subtask')
assert.equal(first.chat.projectId, 'project')
assert.equal(first.chat.fork.parentChatId, 'parent', 'one source of link')
assert.equal(first.chat.fork.proposalOperationId, proposal.operationId)
assert.equal(first.chat.fork.kind, 'subtask')
assert.equal(first.chat.fork.mode, 'messages')
assert.equal(first.chat.fork.sourceMessageIndex, 1)
assert.equal(first.chat.messages.length, 2, 'text up to the boundary only')
assert.equal(first.chat.messages[1].undoId, undefined)
assert.equal(first.chat.messages[0].content, 'First question')
assert.equal(JSON.stringify(source), before, 'parent untouched')

const conversations = [first.chat]
const second = model.accept(proposal, { source, conversations, forkApi: { snapshot, child }, newId: 'child-2', now: 30 })
assert.equal(second.created, false, 'repeat acceptance is a no-op')
assert.equal(second.chat, first.chat)
assert.equal(model.findAccepted(conversations, proposal.operationId).id, 'child-1')
assert.equal(model.findAccepted(conversations, 'fp_absent0'), null)

const edited = JSON.parse(JSON.stringify(source))
const stale = model.normalize(raw, { parentChatId: 'parent', messages: edited.messages })
edited.messages[1].content = 'Edited after the proposal'
assert.throws(() => model.accept(stale, { source: edited, conversations: [], forkApi: { snapshot, child }, newId: 'child-3' }), /source-changed/, 'stale context is refused')

const summaryRaw = { title: 'Summary task', goal: 'Continue the parser work', reason: 'Keep the main thread short', context: { mode: 'summary', summary: 'The parser splits on commas; the renderer is out of scope.', end: 1 } }
const summaryProposal = model.normalize(summaryRaw, { parentChatId: 'parent', messages: source.messages })
const summaryChat = model.accept(summaryProposal, { source, conversations: [], forkApi: { snapshot, child }, newId: 'child-summary', now: 40 }).chat
assert.equal(summaryChat.messages.length, 1)
assert.equal(summaryChat.messages[0].role, 'user')
assert.match(summaryChat.messages[0].content, /Continue the parser work/)
assert.match(summaryChat.messages[0].content, /splits on commas/)
assert.equal(summaryChat.fork.mode, 'summary', 'summary is named as summary, not a full copy')
assert.equal(summaryChat.fork.parentChatId, 'parent')
assert.equal(summaryChat.fork.sourceMessageIndex, 1)

const noBoundary = model.normalize({ ...summaryRaw, context: { mode: 'summary', summary: 'Only the summary' } }, { parentChatId: 'parent' })
const noBoundaryChat = model.accept(noBoundary, { source, conversations: [], forkApi: { snapshot, child }, newId: 'child-4', now: 50 }).chat
assert.equal(noBoundaryChat.fork.sourceMessageIndex, null)
assert.deepEqual(noBoundaryChat.messages.map(message => message.content), ['Continue the parser work\n\nOnly the summary'])

const dismissed = model.dismissedWith({ forkProposalDismissed: ['old'] }, proposal.operationId)
assert.deepEqual(dismissed.slice(0, 2), ['old', proposal.operationId])
assert.equal(model.isDismissed({ forkProposalDismissed: dismissed }, proposal.operationId), true)
assert.equal(model.isDismissed(source, proposal.operationId), false)
assert.equal(model.dismissedWith(null, proposal.operationId).length, 1, 'missing history starts clean')

assert.equal(TOOL_DEFINITION.function.name, 'propose_linked_chat')
assert.deepEqual(TOOL_DEFINITION.function.parameters.required, ['title', 'goal', 'context'])
const sent = []
const tool = createForkProposalTool({ sendToWindow: (event, channel, body) => { sent.push({ event, channel, body }); return true } })
;(async () => {
  const result = await tool.execute({ sender: {} }, raw, 'request-1')
  assert.equal(result.success, true)
  assert.equal(result.status, 'proposed')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].channel, 'fork-proposal')
  assert.equal(sent[0].body.requestId, 'request-1')
  assert.equal(sent[0].body.proposal.title, 'Parser subtask')
  assert.equal(sent[0].body.proposal.parentChatId, undefined, 'main does not invent a parent chat')
  assert.equal(sent[0].body.proposal.context.end, 1)
  await tool.execute({ sender: {} }, raw, 'request-1')
  assert.equal(sent.length, 2, 'repeat delivery just repeats the event; creation is the renderer decision')
  assert.equal(JSON.stringify(sent[0].body.proposal), JSON.stringify(sent[1].body.proposal), 'repeat delivery is byte-identical')

  const refused = await tool.execute({ sender: {} }, { ...raw, title: '' }, 'request-2')
  assert.equal(refused.success, false)
  assert.equal(sent.length, 2, 'invalid proposal is not shown')
  assert.doesNotMatch(refused.error, /parent|C:\\|D:\\/i)

  const lost = createForkProposalTool({ sendToWindow: () => false })
  const noWindow = await lost.execute({ sender: {} }, raw, 'request-3')
  assert.equal(noWindow.success, false)
  assert.equal(noWindow.status, undefined, 'no success claim when the window is gone')

  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/fork-proposal.css'), 'utf8')
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'card colours come from tokens, not literals')
  assert.match(css, /var\(--accent\)/, 'card uses the design system')
  console.log('PASS: fork proposal structure, stable operation id, single linked chat, stale boundary, summary honesty, tool transport')
})().catch(error => { console.error(error); process.exitCode = 1 })
