'use strict'
// Н3 (аудит 31.10): «готово» решал чек-лист модели, а состояние задачи
// (task-state.cjs) с его complete()/remainder() в src/main не спрашивал никто.
// Требование, заявленное сделанным без доказательства, обязано мешать закончить
// ход — иначе модель закрывает пункт и отчитывается, а приложение молчит.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { completionGaps } = require('../src/main/agent-completion')
const { createTaskState } = require('../src/main/task-state.cjs')

let checks = 0
const failures = []
const check = (name, fn) => {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

// Что отдаёт task-state.cjs после хода: пункт чек-листа закрыт моделью, значит
// требование «проверяется», но доказательства нет.
function taskAfterClaimedDone() {
  const task = createTaskState({ idPrefix: 'run' })
  task.syncPlan([{ id: 'cancel', title: 'Кнопка отмены прерывает запрос', status: 'done' }], 0)
  assert.equal(task.complete(), false, 'состояние уже считает задачу незакрытой')
  return task.remainder()
}

check('требование без доказательства закрывает калитку', () => {
  const gate = completionGaps({ plan: [], answer: 'Готово, всё сделал.', log: [], task: taskAfterClaimedDone() })
  assert.ok(gate.gaps.length > 0, 'незакрытое требование пропущено')
  assert.match(gate.gaps[0], /Кнопка отмены/, 'в претензии нет самого требования')
  assert.ok(gate.lead.trim(), 'у претензии нет заголовка')
})

check('неизвестный исход действия тоже держит ход', () => {
  const task = createTaskState({ idPrefix: 'run' })
  task.beginAction({ tool: 'move_path', target: 'a.txt → b.txt' })
  const restored = createTaskState({ idPrefix: 'run', restored: task.snapshot() })
  const gate = completionGaps({ plan: [], answer: 'Готово.', log: [], task: restored.remainder() })
  assert.ok(gate.gaps.some(item => /move_path/.test(item)), 'неизвестный исход не назван')
})

check('без требований калитка молчит, как и раньше', () => {
  const empty = createTaskState({ idPrefix: 'run' })
  assert.equal(empty.complete(), null)
  assert.equal(completionGaps({ plan: [], answer: 'Разобрал, как работает цикл.', log: [], task: null }).gaps.length, 0)
})

check('main.js спрашивает состояние задачи в финализаторе хода', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
  assert.match(main, /payload\.checkpoint\?\.task\?\.\(\)/, 'состояние задачи не читается')
  assert.match(main, /\.complete\(ownScope\) === false/, 'complete() не вызывается')
  // Параллельные задачи судятся по своим требованиям: остаток берётся в той же
  // области, в которой считалась готовность (у помощника — своя часть).
  assert.match(main, /\.remainder\(ownScope\)/, 'остаток считается не по той же области')
  assert.match(main, /completionGaps\(\{[^}]*task: taskLeft/s, 'остаток не доходит до калитки')
})

if (failures.length) {
  console.error(`ПРОВАЛЕНО ${failures.length}: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, checks, failed: 0 }))
