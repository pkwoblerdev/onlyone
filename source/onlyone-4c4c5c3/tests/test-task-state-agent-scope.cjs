'use strict'

// break-4 Н3: admit и observe не различают агентов. Чужой неизвестный исход
// держит ведущего (ложный отказ), чужое чтение «сверяет» помощника (право на
// слепой повтор без наблюдения). Замысел волны 10.11 (атрибуция по agentIndex)
// сохранён: доказательство ведущего интеграционное, действия — свои.
// Отрицательные контроли: свой неизвестный исход держит и предупреждает,
// осознанный повтор сверяет СВОЙ исход, observe без индекса — прежний контракт.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createTaskState } = require('../src/main/task-state.cjs')
const { createCheckpointStore } = require('../src/main/run-checkpoints.js')

let fails = 0
const check = (name, fn) => {
  try { fn(); console.log('ok   ' + name) } catch (error) { fails++; console.log('FAIL ' + name + ' :: ' + error.message) }
}

// Неизвестный исход помощника: начал команду, процесс умер.
const helperUnknown = (task, tool = 'run_command', target = 'npm test') => {
  const a = task.beginAction({ tool, target, agentIndex: 1 })
  task.endAction(a.id, 'done', { unconfirmed: true })
  return a.id
}

// 1. admit: чужой неизвестный исход не держит ведущего (аудит H4).
check('Н3 admit: helper unknown does not hold leader', () => {
  const task = createTaskState({ now: () => 1 })
  const id = helperUnknown(task)
  const verdict = task.admit({ tool: 'run_command', target: 'npm test', agentIndex: 0 })
  assert.equal(verdict.allowed, true, 'ведущий заблокирован исходом помощника: ' + JSON.stringify(verdict))
  // Помощника его собственный исход по-прежнему держит.
  const own = task.admit({ tool: 'run_command', target: 'npm test', agentIndex: 1 })
  assert.equal(own.allowed, false)
  assert.equal(own.actionId, id)
})

// 2. observe: чужое чтение не сверяет помощника (аудит H4b).
check('Н3 observe: leader read does not resolve helper unknown', () => {
  const task = createTaskState({ now: () => 1 })
  const id = helperUnknown(task)
  assert.equal(task.observe('npm test', 0), 0, 'чужое чтение сверило исход помощника')
  assert.equal(task.action(id).resolution, undefined)
  assert.equal(task.observe('npm test', 1), 1, 'своё наблюдение не сверяет')
  assert.equal(task.action(id).resolution, 'observed')
})

// 3. Осознанный повтор ведущего не сверяет предупреждённый исход помощника.
check('Н3 repeat: leader repeat does not resolve helper warned unknown', () => {
  const task = createTaskState({ now: () => 1 })
  const id = helperUnknown(task, 'write_file', 'src/a.js')
  const warned = task.admit({ tool: 'write_file', target: 'src/a.js', agentIndex: 1 })
  assert.equal(warned.allowed, false)
  task.beginAction({ tool: 'write_file', target: 'src/a.js', agentIndex: 0 })
  assert.equal(task.action(id).resolution, undefined, 'повтор ведущего сверил исход помощника')
})

// Отрицательный контроль: свой предупреждённый исход сверяется своим повтором.
check('NEG: own warned unknown resolved by own conscious repeat', () => {
  const task = createTaskState({ now: () => 1 })
  const id = helperUnknown(task, 'write_file', 'src/a.js')
  assert.equal(task.admit({ tool: 'write_file', target: 'src/a.js', agentIndex: 1 }).allowed, false)
  const again = task.admit({ tool: 'write_file', target: 'src/a.js', agentIndex: 1 })
  assert.equal(again.allowed, true, 'повтор после предупреждения запрещён')
  const next = task.beginAction({ tool: 'write_file', target: 'src/a.js', agentIndex: 1 })
  const old = task.action(id)
  assert.equal(old.resolution, 'repeated')
  assert.equal(old.resolvedBy, next.id)
})

// Отрицательный контроль: observe без индекса — прежний контракт (все агенты).
check('NEG: observe without index keeps legacy contract', () => {
  const task = createTaskState({ now: () => 1 })
  helperUnknown(task)
  assert.equal(task.observe('npm test'), 1)
})

// Обёртка чекпойнтов: индекс доходит до admit/observe.
check('Н3 checkpoint wrapper: admit/observe scoped by agentIndex', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scope-'))
  try {
    const store = createCheckpointStore({ dir, now: () => 1 })
    const run = store.start({ runId: '00000001-aaaa-bbbb-cccc-dddddddddddd', chatId: 'c1', ask: 'собери' })
    const handle = run.begin('run_command', { command: 'npm test' }, 1)
    handle.end('done', { unconfirmed: true })
    assert.equal(run.admit('run_command', { command: 'npm test' }, 0).allowed, true, 'ведущий заблокирован через обёртку')
    assert.equal(run.observe({ command: 'npm test' }, 0), 0, 'чужое чтение сверяет через обёртку')
    assert.equal(run.observe({ command: 'npm test' }, 1), 1)
    run.close()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

console.log(fails ? `\nFAILS=${fails}` : '\nALL OK')
process.exit(fails ? 1 : 0)