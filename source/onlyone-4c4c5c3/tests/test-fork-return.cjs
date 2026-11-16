'use strict'
// Возврат итога связанной задачи: одна запись на последний ответ ребёнка,
// повтор не дублирует, опись переживает JSON-копию и не перезаписывается при
// повреждении.
const assert = require('node:assert/strict')
const model = require('../src/renderer/fork-return.js')

const child = { id: 'child', title: 'Связанная задача', messages: [
  { role: 'user', content: 'вопрос', timestamp: 1 },
  { role: 'assistant', content: 'первый ответ', timestamp: 2 },
  { role: 'assistant', content: [{ type: 'text', text: 'итоговый ' }, { type: 'text', text: 'ответ' }], timestamp: 3 }
] }
const last = model.textOf(child)
assert.equal(last.text, 'итоговый \nответ', 'text parts are joined like the fork snapshot')
assert.equal(last.messageKey, 't:3', 'timestamp is the stable key')
assert.deepEqual(model.textOf({ messages: [{ role: 'user', content: 'x' }] }), null, 'no assistant answer means nothing to return')
assert.equal(model.textOf({ messages: [{ role: 'assistant', content: '   ' }] }), null, 'empty answer is not a result')
const noTime = model.textOf({ messages: [{ role: 'assistant', content: 'без времени' }] })
assert.match(noTime.messageKey, /^h:[0-9a-f]{8}$/, 'without a timestamp the key is the content hash')

const parent = { id: 'parent', messages: [] }
const put = model.put(parent, { operationId: 'fp_return01', childChatId: 'child', messageKey: last.messageKey, text: last.text, now: 10 })
assert.equal(put.ok, true)
assert.equal(put.existing, false)
const reread = JSON.parse(JSON.stringify(parent))
const ledger = model.read(reread)
assert.equal(ledger.ok, true)
assert.equal(ledger.returns.length, 1)
assert.equal(ledger.returns[0].text, 'итоговый \nответ')
assert.equal(model.isReturned(reread, 'fp_return01', 't:3'), true)
assert.equal(model.isReturned(reread, 'fp_return01', 't:2'), false)

const repeat = model.put(reread, { operationId: 'fp_return01', childChatId: 'child', messageKey: 't:3', text: 'изменённый текст', now: 20 })
assert.equal(repeat.existing, true, 'repeat return is idempotent')
assert.equal(reread.forkReturns.length, 1)
assert.equal(reread.forkReturns[0].text, 'итоговый \nответ', 'the first returned text is kept')

assert.equal(model.put(reread, { operationId: 'bad id', childChatId: 'child', messageKey: 't:3', text: 'x' }).ok, false)
assert.equal(model.put(reread, { operationId: 'fp_return02', childChatId: '', messageKey: 't:3', text: 'x' }).ok, false)

const corrupt = { id: 'corrupt', forkReturns: { 0: {} } }
const corruptBefore = JSON.stringify(corrupt)
assert.deepEqual(model.read(corrupt), { ok: false, reason: 'invalid-shape' })
assert.equal(model.put(corrupt, { operationId: 'fp_return03', childChatId: 'c', messageKey: 't:1', text: 'x' }).ok, false)
assert.equal(JSON.stringify(corrupt), corruptBefore, 'unknown ledger is not overwritten')

const mixed = { id: 'mixed', forkReturns: [
  { ...reread.forkReturns[0] },
  { version: 1, operationId: 'fp_return01', childChatId: 'child', messageKey: 't:3', text: 'дубль', createdAt: 1 },
  { version: 1, operationId: 'broken', childChatId: 'child', messageKey: 't:4', text: '', createdAt: 1 }
] }
const mixedRead = model.read(mixed)
assert.equal(mixedRead.returns.length, 1, 'duplicate and broken entries are skipped')
assert.equal(mixedRead.skipped, 2)

assert.equal(model.drop(reread, 'fp_return01', 't:3').ok, true)
assert.equal(reread.forkReturns.length, 0)
assert.equal(model.drop(reread, 'fp_return01', 't:3').ok, false, 'second drop is not-found')

for (let i = 0; i < model.LIMITS.records; i++) {
  model.put(reread, { operationId: 'fp_bulk' + String(i).padStart(4, '0'), childChatId: 'child', messageKey: 't:' + (100 + i), text: 'ответ', now: i })
}
assert.deepEqual(model.put(reread, { operationId: 'fp_bulk9999', childChatId: 'child', messageKey: 't:9999', text: 'x' }), { ok: false, reason: 'limit' })

console.log('PASS fork return: last answer, stable key, idempotent record, tolerant ledger, limit, drop')
