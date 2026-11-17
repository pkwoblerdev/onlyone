'use strict'
// Н5 (аудит 31.10): при переполнении журнала действий вытеснялось именно
// неизвестное действие — то, которое продолжение обязано проверить. Известный
// исход вытесняется первым; когда вытеснять нечего (все исходы неизвестны),
// журнал не растёт за счёт неизвестных: новый вызов только считается выпавшим.
const assert = require('node:assert/strict')
const { createTaskState, MAX_ACTIONS } = require('../src/main/task-state.cjs')

let checks = 0
const failures = []
const check = (name, fn) => {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

const unknownAction = (task, target) => {
  const action = task.beginAction({ tool: 'move_path', target })
  task.endAction(action.id, 'failed', { unconfirmed: true })
  return action
}

check('первым вытесняется действие с известным исходом', () => {
  const task = createTaskState({ idPrefix: 'run' })
  const ids = []
  for (let i = 0; i < MAX_ACTIONS - 1; i++) ids.push(unknownAction(task, `f${i}.txt → g${i}.txt`).id)
  const done = task.beginAction({ tool: 'write_file', target: 'done.txt' })
  task.endAction(done.id, 'done')
  assert.equal(task.snapshot().actions.length, MAX_ACTIONS)
  const next = task.beginAction({ tool: 'write_file', target: 'new.txt' })
  assert.equal(task.action(done.id), null, 'законченное действие не вытеснено')
  assert.equal(task.action(next.id).status, 'started')
  assert.equal(task.remainder().unknownActions.length, MAX_ACTIONS - 1, 'неизвестные вытеснены раньше законченного')
  assert.ok(task.action(ids[0]) && task.action(ids[ids.length - 1]))
})

check('при 200 неизвестных ни одно не вытесняется', () => {
  const task = createTaskState({ idPrefix: 'run' })
  const ids = []
  for (let i = 0; i < MAX_ACTIONS; i++) ids.push(unknownAction(task, `f${i}.txt → g${i}.txt`).id)
  assert.equal(task.remainder().unknownActions.length, MAX_ACTIONS)
  const next = task.beginAction({ tool: 'write_file', target: 'new.txt' })
  assert.equal(task.remainder().unknownActions.length, MAX_ACTIONS, 'неизвестный исход вытеснен')
  assert.ok(task.action(ids[0]), 'самое старое неизвестное действие пропало')
  assert.ok(task.action(ids[ids.length - 1]), 'последнее неизвестное действие пропало')
  assert.equal(task.action(next.id), null, 'новый вызов вошёл в журнал сверх предела')
  assert.equal(task.snapshot().droppedActions, 1, 'выпавший вызов не посчитан')
})

check('сверенный исход освобождает место, не теряя остальных неизвестных', () => {
  const task = createTaskState({ idPrefix: 'run' })
  const ids = []
  for (let i = 0; i < MAX_ACTIONS; i++) ids.push(unknownAction(task, `f${i}.txt → g${i}.txt`).id)
  assert.equal(task.observe('f0.txt → g0.txt'), 1)
  const next = task.beginAction({ tool: 'write_file', target: 'new.txt' })
  assert.equal(task.action(ids[0]), null, 'сверенное действие не вытеснено')
  assert.equal(task.action(next.id).status, 'started')
  assert.equal(task.remainder().unknownActions.length, MAX_ACTIONS - 1)
})

if (failures.length) {
  console.error(`ПРОВАЛЕНО ${failures.length}: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
