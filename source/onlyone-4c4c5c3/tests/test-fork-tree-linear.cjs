// Обход дерева форков обязан быть линейным (аудит 01.11, Н6).
//
// После снятия RangeError (итеративный стек) цикл определялся шагом вверх по
// ссылкам для КАЖДОГО узла: `inCycle` шёл до корня, и на цепочке из n форков это
// O(n²). Замер аудитора: n=4500 — ~1,9 с, n=9000 — ~11 с чистого CPU-глейма при
// сборке леса, который вызывается заново из search() и parentState().
//
// Тест меряет model.build() на длинной цепочке и держит бюджет: зелёный — десятки
// миллисекунд, красный (квадратичный обход) — секунды. Порог завышен враз, чтобы
// не флакать на медленной машине, но всё ещё ловить квадрат.
'use strict'
const assert = require('node:assert/strict')
const model = require('../src/renderer/fork-tree-model.js')

const CHAIN = 9000
const BUILD_BUDGET_MS = 1500

const chat = (id, parentId) => ({
  id,
  title: 't' + id,
  updatedAt: 1,
  messages: [],
  ...(parentId ? { fork: { version: 1, parentChatId: parentId } } : {})
})

let failed = 0
function check (name, fn) {
  try { fn(); console.log('ok  ' + name) } catch (e) { failed++; console.error('ПРОВАЛ  ' + name + ' — ' + e.message) }
}

// Сборка длинной цепочки должна укладываться в бюджет, а не ползти секундами.
check(`цепочка ${CHAIN} форков строится быстрее ${BUILD_BUDGET_MS} мс (линейный обход)`, () => {
  const chain = Array.from({ length: CHAIN }, (_, i) => chat('c' + i, i ? 'c' + (i - 1) : null))
  const started = process.hrtime.bigint()
  const tree = model.build(chain)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`    build(${CHAIN}): ${ms.toFixed(0)} мс`)
  assert.equal(tree.order.length, CHAIN, 'узлы потеряны')
  assert.equal(tree.roots.length, 1, 'цепочка дала не один корень')
  assert.ok(ms < BUILD_BUDGET_MS, `сборка заняла ${ms.toFixed(0)} мс при пороге ${BUILD_BUDGET_MS}`)
})

// Линейность не должна менять семантику: петля — только на самом цикле, потомки
// цикла и ссылочные случаи разбираются как раньше (сверка с test-fork-tree).
check('линейный цикл-детект совпадает поведением с прежним', () => {
  const tree = model.build([
    chat('a', 'b'), chat('b', 'a'), chat('c', 'a'), chat('self', 'self'),
    chat('gone', 'missing')
  ])
  assert.equal(tree.nodes.get('a').cycle, true, 'узел на петле не помечен')
  assert.equal(tree.nodes.get('b').cycle, true, 'второй узел петли не помечен')
  assert.equal(tree.nodes.get('c').cycle, false, 'потомок цикла помечен как цикл')
  assert.equal(tree.nodes.get('self').selfParent, true, 'ссылка на себя не selfParent')
  assert.equal(tree.nodes.get('gone').missingParent, true, 'несуществующий родитель не missingParent')
})

// Двойная вложенная петля: оба цикла помечены, третий, ведущий в цикл — нет.
check('несколько независимых петель в одном лесе', () => {
  const tree = model.build([
    chat('p', 'q'), chat('q', 'p'),
    chat('r', 's'), chat('s', 'r'),
    chat('leaf', 'p')
  ])
  for (const id of ['p', 'q', 'r', 's']) assert.equal(tree.nodes.get(id).cycle, true, `${id} должен быть на цикле`)
  assert.equal(tree.nodes.get('leaf').cycle, false, 'листь, ведущий в цикл, не сам цикл')
})

if (failed) { console.error(`\n${failed} проверок провалено`); process.exitCode = 1 }
else console.log('\nДерево форков: линейный обход подтверждён')
