'use strict'

// break-4 Н4: complete(помощник) возвращал true, когда у помощника нет ни одного
// своего требования — калитка состояния утверждала готовность, хотя подтверждать
// было нечего. Честный ответ — null («требований нет, решают прежние проверки»,
// документированный короткий путь), неизвестный исход помощника держит и без
// требований. Замысел волны 10.11 сохранён: помощника с закрытой СВОЕЙ частью
// чужая незакрытая часть не держит (test-task-state, «остаток по своей задаче»).

const assert = require('node:assert/strict')
const { createTaskState } = require('../src/main/task-state.cjs')

let fails = 0
const check = (name, fn) => {
  try { fn(); console.log('ok   ' + name) } catch (error) { fails++; console.log('FAIL ' + name + ' :: ' + error.message) }
}
const fresh = () => createTaskState({ now: () => 1 })

// 1. Помощник без своих требований: состояние не утверждает готовность.
check('Н4: helper with zero own requirements gets null, not true', () => {
  const task = fresh()
  task.syncPlan([{ id: 'lead', title: 'Часть ведущего', status: 'doing' }], 0)
  assert.equal(task.complete(1), null, 'complete(1) утверждает готовность без единого своего требования')
  assert.equal(task.complete(null), false, 'ведущего его открытая часть не держит')
})

// Отрицательный контроль: неизвестный исход помощника держит и без требований.
check('NEG: helper own unknown action still holds without requirements', () => {
  const task = fresh()
  task.syncPlan([{ id: 'lead', title: 'Часть ведущего', status: 'doing' }], 0)
  const a = task.beginAction({ tool: 'run_command', target: 'npm publish', agentIndex: 1 })
  task.endAction(a.id, 'done', { unconfirmed: true })
  assert.equal(task.complete(1), false, 'неизвестный исход помощника потерян')
})

// Отрицательный контроль: замысел волны — своя закрытая часть даёт готово,
// чужая открытая не держит.
check('NEG: helper with own confirmed part completes despite leader open', () => {
  const task = fresh()
  task.syncPlan([{ id: 'mine', title: 'Моя часть', status: 'done' }], 1)
  task.syncPlan([{ id: 'theirs', title: 'Часть ведущего', status: 'doing' }], 0)
  task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test', agentIndex: 1 })
  assert.equal(task.complete(1), true, 'помощника держит чужая незакрытая часть')
  assert.equal(task.complete(), false)
})

// Отрицательный контроль: своя открытая часть держит помощника.
check('NEG: helper own open requirement holds', () => {
  const task = fresh()
  task.syncPlan([{ id: 'mine', title: 'Моя часть', status: 'doing' }], 1)
  assert.equal(task.complete(1), false)
})

// Отрицательный контроль: требований нет вовсе — короткий путь для всех.
check('NEG: no requirements at all stays null for every scope', () => {
  const task = fresh()
  assert.equal(task.complete(), null)
  assert.equal(task.complete(1), null)
})

// Отрицательный контроль: всё подтверждено — готово в обоих скоупах.
check('NEG: all confirmed completes in both scopes', () => {
  const task = fresh()
  task.syncPlan([{ id: 'mine', title: 'Моя часть', status: 'done' }], 1)
  task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test', agentIndex: 0 })
  assert.equal(task.complete(1), true)
  assert.equal(task.complete(), true)
})

console.log(fails ? `\nFAILS=${fails}` : '\nALL OK')
process.exit(fails ? 1 : 0)