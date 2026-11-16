'use strict'
// break-4 Н1: один зелёный прогон подтверждает ВСЕ требования разом, даже те,
// к которым агент не притронулся. Покрытие: автоматическое доказательство
// команды (с actionId) подтверждает только требования, над которыми агент
// действительно работал — действие было привязано к требованию в работе.
// Доказательство без действия (судья/человек/явная интеграционная проверка)
// сохраняет документированное правило ведущего (Б-7).
// Отрицательный контроль: та же зелёная команда после реальной работы по
// каждому пункту подтверждает всё — легальный поток не сломан.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createTaskState } = require('../src/main/task-state.cjs')
const { createCheckpointStore } = require('../src/main/run-checkpoints.js')

let checks = 0
const failures = []
function check(name, fn) {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}
let clock = 1000
const now = () => ++clock
const fresh = () => createTaskState({ now, idPrefix: 'cov' })

check('зелёная команда не подтверждает требования, которые не делались', () => {
  const task = fresh()
  task.syncPlan([{ id: 'p1', title: 'часть 1', status: 'doing' }, { id: 'p2', title: 'часть 2', status: 'todo' }, { id: 'p3', title: 'часть 3', status: 'todo' }], 0)
  for (const id of ['plan:0:p1', 'plan:0:p2', 'plan:0:p3']) {
    task.move(id, 'in_progress'); task.move(id, 'verifying')
  }
  // Агент не сделал ни одного действия по требованиям и пишет всегда зелёный «тест».
  const write = task.beginAction({ tool: 'write_file', target: 'tests/ok.cjs', agentIndex: 0 })
  task.endAction(write.id, 'done')
  const run = task.beginAction({ tool: 'run_command', target: 'node tests/ok.cjs', agentIndex: 0, verification: true })
  task.endAction(run.id, 'done')
  task.addEvidence({ source: 'command', verdict: 'pass', actionId: run.id, coverage: 'node tests/ok.cjs → код 0' })
  const states = ['plan:0:p1', 'plan:0:p2', 'plan:0:p3'].map(id => task.get(id).state)
  assert.deepEqual(states, ['verifying', 'verifying', 'verifying'], 'посторонний зелёный прогон подтвердил нетронутые требования: ' + states.join(','))
  assert.equal(task.complete(), false, 'задача сдана без покрытия требований')
})

check('отрицательный контроль: зелёная команда после работы по каждому пункту подтверждает всё', () => {
  const task = fresh()
  task.syncPlan([{ id: 'p1', title: 'часть 1', status: 'doing' }, { id: 'p2', title: 'часть 2', status: 'todo' }], 0)
  const w1 = task.beginAction({ tool: 'write_file', target: 'src/a.js', agentIndex: 0 })
  task.endAction(w1.id, 'done')
  task.syncPlan([{ id: 'p1', title: 'часть 1', status: 'done' }, { id: 'p2', title: 'часть 2', status: 'doing' }], 0)
  const w2 = task.beginAction({ tool: 'write_file', target: 'src/b.js', agentIndex: 0 })
  task.endAction(w2.id, 'done')
  task.syncPlan([{ id: 'p1', title: 'часть 1', status: 'done' }, { id: 'p2', title: 'часть 2', status: 'done' }], 0)
  const run = task.beginAction({ tool: 'run_command', target: 'npm test', agentIndex: 0, verification: true })
  task.endAction(run.id, 'done')
  task.addEvidence({ source: 'command', verdict: 'pass', actionId: run.id, coverage: 'npm test → код 0' })
  assert.equal(task.get('plan:0:p1').state, 'confirmed', 'сделанная часть не подтверждена интеграционной проверкой')
  assert.equal(task.get('plan:0:p2').state, 'confirmed', 'сделанная часть не подтверждена интеграционной проверкой')
  assert.equal(task.complete(), true)
})

check('доказательство без действия сохраняет интеграционное правило ведущего (Б-7)', () => {
  const task = fresh()
  task.syncPlan([{ id: 'lead', title: 'Ведущий: кнопка отмены', status: 'done' }], 0)
  task.syncPlan([{ id: 'help', title: 'Помощник: выложить обновление', status: 'done' }], 1)
  task.addEvidence({ source: 'command', verdict: 'pass', coverage: 'npm test', agentIndex: 0 })
  assert.equal(task.get('plan:1:help').state, 'confirmed', 'проверка ведущего перестала быть интеграционной')
  assert.equal(task.complete(), true)
})

check('отметка работы переживает перезапуск состояния', () => {
  const task = fresh()
  task.syncPlan([{ id: 'p1', title: 'часть 1', status: 'doing' }], 0)
  const work = task.beginAction({ tool: 'write_file', target: 'src/a.js', agentIndex: 0 })
  task.endAction(work.id, 'done')
  task.syncPlan([{ id: 'p1', title: 'часть 1', status: 'done' }], 0)
  const restored = createTaskState({ restored: task.snapshot(), now, idPrefix: 'cov' })
  const run = restored.beginAction({ tool: 'run_command', target: 'npm test', agentIndex: 0, verification: true })
  restored.endAction(run.id, 'done')
  restored.addEvidence({ source: 'command', verdict: 'pass', actionId: run.id, coverage: 'npm test → код 0' })
  assert.equal(restored.get('plan:0:p1').state, 'confirmed', 'после перезапуска сделанная часть не подтверждается')
})

// Продакшн-путь: доказательства создаёт только run-checkpoints (begin/end).
check('контрольная точка: посторонний зелёный прогон не закрывает план (репро H16)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'))
  const store = createCheckpointStore({ dir, now: () => 1000 })
  const cp = store.start({ runId: 'aaaa1111', ask: 'сделай три части', budgetLimits: null })
  cp.syncPlan([{ id: 'p1', title: 'часть 1', status: 'doing' }, { id: 'p2', title: 'часть 2', status: 'todo' }, { id: 'p3', title: 'часть 3', status: 'todo' }], 0)
  const task = cp.task()
  for (const id of ['plan:0:p1', 'plan:0:p2', 'plan:0:p3']) {
    task.move(id, 'in_progress'); task.move(id, 'verifying')
  }
  cp.begin('write_file', { path: 'tests/ok.cjs', content: 'process.exit(0)' }, 0).end('done')
  cp.begin('run_command', { command: 'node tests/ok.cjs' }, 0).end('done', { exitCode: 0 })
  const states = ['plan:0:p1', 'plan:0:p2', 'plan:0:p3'].map(id => task.get(id).state)
  assert.deepEqual(states, ['verifying', 'verifying', 'verifying'], 'H16: один тривиальный тест подтвердил все части: ' + states.join(','))
  assert.equal(task.complete(), false)
  cp.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

check('контрольная точка: работа по пунктам + зелёная проверка закрывают план', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'))
  const store = createCheckpointStore({ dir, now: () => 1000 })
  const cp = store.start({ runId: 'bbbb2222', ask: 'сделай две части', budgetLimits: null })
  cp.syncPlan([{ id: 'p1', title: 'часть 1', status: 'doing' }, { id: 'p2', title: 'часть 2', status: 'todo' }], 0)
  cp.begin('write_file', { path: 'src/a.js', content: 'a' }, 0).end('done')
  cp.syncPlan([{ id: 'p1', title: 'часть 1', status: 'done' }, { id: 'p2', title: 'часть 2', status: 'doing' }], 0)
  cp.begin('write_file', { path: 'src/b.js', content: 'b' }, 0).end('done')
  cp.syncPlan([{ id: 'p1', title: 'часть 1', status: 'done' }, { id: 'p2', title: 'часть 2', status: 'done' }], 0)
  cp.begin('run_command', { command: 'npm test' }, 0).end('done', { exitCode: 0 })
  const task = cp.task()
  assert.equal(task.get('plan:0:p1').state, 'confirmed')
  assert.equal(task.get('plan:0:p2').state, 'confirmed')
  assert.equal(task.complete(), true)
  cp.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`task-state coverage: ${checks} ok, ${failures.length} failed`)
if (failures.length) process.exitCode = 1