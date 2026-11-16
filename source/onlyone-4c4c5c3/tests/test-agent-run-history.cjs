'use strict'
const assert = require('node:assert/strict')
const { createRecorder } = require('../src/renderer/agent-run-history')
const record = createRecorder({
  normalizePlanSteps: items => items,
  extractTaskTitle: text => text.split('\n')[0],
  now: () => 10000
})
assert.equal(record({}), undefined, 'ordinary short reply has no fake agent history')
const source = {
  agentTasks: new Map([[0, { index: 0, name: 'Lead', done: true, since: 1000, endedAt: 3000 }],
    [1, { index: 1, assignment: 'Build\nDetails', since: 4000 }]]),
  board: { items: [{ id: 'a', task: 'Build', status: 'done' }] },
  planByAgent: new Map([['Lead', [{ status: 'done' }, { status: 'doing' }]]])
}
const chat = record(source, { ask: '  Make   a page ', seconds: 2.4 })
const design = record({ ...source, designId: 'design-1' }, { ask: '  Make   a page ', seconds: 2.4 })
assert.deepEqual(chat, design, 'same history contract in chat and Design')
assert.equal(chat.ask, 'Make a page')
assert.equal(chat.agents[0].seconds, 2)
assert.equal(chat.agents[1].outcome, 'interrupted')
assert.equal(chat.agents[1].seconds, 6)
assert.deepEqual(chat.plans, [{ agent: 'Lead', done: 1, total: 2 }])
chat.board[0].status = 'changed'
assert.equal(source.board.items[0].status, 'done', 'serialized history is detached')
assert.doesNotThrow(() => JSON.stringify(design))
assert.equal(record(source, { ask: 'x'.repeat(300) }).ask.length, 161)
console.log('Agent history: chat/Design parity, interruption, durations, plans and detached serialization passed')
