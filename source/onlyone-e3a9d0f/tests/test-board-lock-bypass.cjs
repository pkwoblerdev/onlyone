'use strict'
// break-4 Н19: замок приёмки доски обходится тремя штатными порядками.
// Правка перестаёт быть видимой замку → changed=false → «сделано» без зелёной проверки.
// B1: пункт передан другому агенту после правки (assignmentId + прежний исполнитель).
// B2: два пункта одного агента, доказательство без assignmentId (legacy).
// B2b: ведущий правит сам, когда на доске два пункта с правом записи.
// Отрицательные контроли: после зелёной проверки пункт закрывается; одиночный
// пункт по-прежнему держит замок без проверки и открывается с проверкой.
const assert = require('node:assert/strict')
const board = require('../src/main/agent-board')

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }
let n = 0
const fresh = (assignments, roster = ['Агент 1', 'Агент 2', 'Агент 3']) => {
  const id = 'lock-' + (++n)
  board.clearBoard(id)
  board.seedBoard(id, assignments, roster)
  board.setTestsExpected(id, true)
  return id
}
const NOTE = 'изменён a.js, проверка запущена, результат прочитан'
const close = (id, agent, item = 't1') => board.updateItem(id, agent, { id: item, status: 'done', note: NOTE })
const edit = (id, agent, assignmentId) => board.recordToolEvidence(id, { tool: 'edit_file', agent, path: 'a.js', ok: true, ...(assignmentId ? { assignmentId } : {}) })
const green = (id, agent, assignmentId) => board.recordToolEvidence(id, { tool: 'run_command', agent, command: 'npm test', exitCode: 0, ok: true, ...(assignmentId ? { assignmentId } : {}) })

check('B1 передача пункта не снимает замок: правка прежнего исполнителя видна', () => {
  const id = fresh([{ agent: 'Агент 2', task: 'править a.js', readOnly: false }])
  edit(id, 'Агент 2', 't1')
  assert.equal(close(id, 'Агент 2').success, false, 'до передачи замок должен держать')
  board.reassignItem(id, 't1', 'Агент 3')
  assert.equal(close(id, 'Агент 3').success, false, 'передача пункта сделала правку невидимой — замок открылся')
  green(id, 'Агент 3', 't1')
  assert.equal(close(id, 'Агент 3').success, true, 'после зелёной проверки пункт обязан закрываться')
})

check('B2 два пункта одного агента: legacy-правка видна обоим', () => {
  const id = fresh([{ agent: 'Агент 2', task: 'править a.js', readOnly: false }, { agent: 'Агент 2', task: 'править b.js', readOnly: false }])
  edit(id, 'Агент 2')
  assert.equal(close(id, 'Агент 2', 't1').success, false, 'правка невидима первому пункту — замок открылся')
  assert.equal(close(id, 'Агент 2', 't2').success, false, 'правка невидима второму пункту — замок открылся')
  green(id, 'Агент 2')
  assert.equal(close(id, 'Агент 2', 't1').success, true, 'после зелёной проверки первый пункт закрывается')
  assert.equal(close(id, 'Агент 2', 't2').success, true, 'после зелёной проверки второй пункт закрывается')
})

check('B2b правка ведущего при двух writable-пунктах видна замку', () => {
  const id = fresh([{ agent: 'Агент 2', task: 'править a.js', readOnly: false }, { agent: 'Агент 3', task: 'править b.js', readOnly: false }])
  edit(id, 'Агент 1')
  assert.equal(close(id, 'Агент 1', 't1').success, false, 'правка ведущего невидима при двух пунктах — замок открылся')
  green(id, 'Агент 1')
  assert.equal(close(id, 'Агент 1', 't1').success, true, 'после зелёной проверки ведущий закрывает пункт')
})

check('контроль: одиночный пункт держит замок без проверки и открывается с проверкой', () => {
  const id = fresh([{ agent: 'Агент 2', task: 'править a.js', readOnly: false }])
  edit(id, 'Агент 2')
  assert.equal(close(id, 'Агент 2').success, false)
  green(id, 'Агент 2')
  assert.equal(close(id, 'Агент 2').success, true)
})

check('контроль: чужой помощник не даёт проверку этому пункту', () => {
  const id = fresh([{ agent: 'Агент 2', task: 'править a.js', readOnly: false }])
  edit(id, 'Агент 2')
  green(id, 'Агент 3')
  assert.equal(close(id, 'Агент 2').success, false, 'проверка постороннего помощника не должна открывать замок')
})

if (failed) process.exit(1)
console.log('Замок приёмки: обходы передачей/двумя пунктами закрыты')