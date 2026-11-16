'use strict'

// break-4 Н5: вытеснение доказательств делает ground немонотонным. Журнал полон
// (60), новые доказательства вытесняют старые, длина не меняется — «основание не
// изменилось» и легальный повтор после новой проверки блокируется как цикл.
// Правка: основание = evidence.length + droppedEvidence (монотонный счётчик),
// сравнение в cycleOf то же. Отрицательные контроли: настоящий цикл при полном
// журнале держится, после вытеснения новый цикл тоже держится, перезапуск сохраняет.

const assert = require('node:assert/strict')
const { createTaskState, cleanTaskState } = require('../src/main/task-state.cjs')

let fails = 0
const check = (name, fn) => {
  try { fn(); console.log('ok   ' + name) } catch (error) { fails++; console.log('FAIL ' + name + ' :: ' + error.message) }
}
const fresh = () => createTaskState({ now: () => 1 })
const fill = task => {
  for (let i = 0; i < 60; i++) task.addEvidence({ source: 'command', verdict: 'unknown', coverage: 'проверка ' + i })
}
const doAction = (task, target) => {
  const a = task.beginAction({ tool: 'edit_file', target })
  task.endAction(a.id, 'done')
  return a
}

// 1. Репро аудита H5: 60 доказательств, A, B, ещё 5 — повтор A легален.
check('Н5: new evidence with full journal is a ground, not a cycle', () => {
  const task = fresh()
  fill(task)
  doAction(task, 'a.js')
  doAction(task, 'b.js')
  for (let i = 0; i < 5; i++) task.addEvidence({ source: 'observation', verdict: 'pass', coverage: 'новое ' + i })
  const verdict = task.admit({ tool: 'edit_file', target: 'a.js' })
  assert.equal(verdict.allowed, true, 'ложный цикл на легальной работе: ' + JSON.stringify(verdict))
})

// Отрицательный контроль: настоящий цикл при полном журнале держится.
check('NEG: real cycle with full journal still held', () => {
  const task = fresh()
  fill(task)
  doAction(task, 'a.js')
  doAction(task, 'b.js')
  const verdict = task.admit({ tool: 'edit_file', target: 'a.js' })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.cycle, true)
})

// Отрицательный контроль: после вытеснения новый цикл на новом основании держится.
check('NEG: cycle after eviction on the new ground still held', () => {
  const task = fresh()
  fill(task)
  doAction(task, 'a.js')
  doAction(task, 'b.js')
  for (let i = 0; i < 5; i++) task.addEvidence({ source: 'observation', verdict: 'pass', coverage: 'новое ' + i })
  assert.equal(task.admit({ tool: 'edit_file', target: 'a.js' }).allowed, true)
  doAction(task, 'a.js')
  doAction(task, 'b.js')
  const verdict = task.admit({ tool: 'edit_file', target: 'a.js' })
  assert.equal(verdict.allowed, false, 'после вытеснения цикл перестал распознаваться')
  assert.equal(verdict.cycle, true)
})

// Отрицательный контроль: монотонное основание переживает перезапуск.
check('NEG: monotonic ground survives restart', () => {
  const task = fresh()
  fill(task)
  doAction(task, 'a.js')
  doAction(task, 'b.js')
  for (let i = 0; i < 5; i++) task.addEvidence({ source: 'observation', verdict: 'pass', coverage: 'новое ' + i })
  doAction(task, 'a.js')
  doAction(task, 'b.js')
  const restored = createTaskState({ now: () => 2, restored: cleanTaskState(task.snapshot()) })
  const verdict = restored.admit({ tool: 'edit_file', target: 'a.js' })
  assert.equal(verdict.allowed, false, 'после перезапуска основание потеряно')
  assert.equal(verdict.cycle, true)
})

console.log(fails ? `\nFAILS=${fails}` : '\nALL OK')
process.exit(fails ? 1 : 0)