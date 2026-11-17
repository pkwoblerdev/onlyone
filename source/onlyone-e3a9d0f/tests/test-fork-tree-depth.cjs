'use strict'
// Дерево форков читается с диска, поэтому глубокая цепочка не должна ронять
// отрисовку переполнением стека: и сборка леса, и visibleRows идут явным стеком.
const assert = require('node:assert/strict')
const model = require('../src/renderer/fork-tree-model.js')

const chat = (id, parentId, index) => ({
  id,
  title: 't' + id,
  updatedAt: 1,
  messages: [
    { role: 'user', content: 'm' + index, timestamp: 1000 + index },
    { role: 'assistant', content: 'a' + index, timestamp: 2000 + index }
  ],
  ...(parentId ? { fork: { version: 1, parentChatId: parentId } } : {})
})

// --- порядок строк не изменился на обычном дереве ---------------------------
{
  const tree = model.build([
    chat('root', null, 0),
    chat('a', 'root', 1),
    chat('b', 'root', 2),
    chat('a1', 'a', 3)
  ])
  assert.deepEqual(model.visibleRows(tree, new Set()).map(row => [row.id, row.depth]), [
    ['root', 0], ['a', 1], ['a1', 2], ['b', 1]
  ])
}

// --- глубокая цепочка: 6000 форков с сообщениями ----------------------------
const depth = 6000
const chain = Array.from({ length: depth }, (_, index) => chat('c' + index, index ? 'c' + (index - 1) : null, index))
const tree = model.build(chain)
assert.equal(tree.roots.length, 1)
assert.equal(tree.order.length, depth)
const rows = model.visibleRows(tree, new Set())
assert.equal(rows.length, depth, 'every level is rendered')
assert.equal(rows[0].id, 'c0')
assert.equal(rows[0].depth, 0)
assert.equal(rows.at(-1).id, 'c' + (depth - 1))
assert.equal(rows.at(-1).depth, depth - 1)

// Свёрнутая ветка по-прежнему не отдаёт детей.
const collapsed = model.visibleRows(tree, new Set(['c0']))
assert.equal(collapsed.length, 1)

console.log(`PASS fork tree depth: a ${depth}-level chain builds and renders without recursion`)
