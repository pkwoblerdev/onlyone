'use strict'

// break-4 Н2: цикл A→B→A удерживался через раз — каждый новый круг получал новое
// предупреждение и новый проход, цикл крутился бесконечно (деньги и время).
// Замысел волны 10.11 сохранён: предупреждение однократное, осознанный повтор
// после него решает модель (приёмочный тест test-task-state «предупреждение
// одно»), фиксированного счётчика нет. Правка: проход открыт ОДИН раз на
// основание (отметка cycleUsed у осознанного повтора и его прямых продолжений);
// следующее такое же цикл без новых доказательств держится без второго прохода.
// Новое доказательство меняет основание — проход снова открыт.

const assert = require('node:assert/strict')
const { createTaskState, cleanTaskState } = require('../src/main/task-state.cjs')

let fails = 0
const check = (name, fn) => {
  try { fn(); console.log('ok   ' + name) } catch (error) { fails++; console.log('FAIL ' + name + ' :: ' + error.message) }
}
const fresh = () => createTaskState({ now: () => 1 })
const A = { tool: 'write_file', target: 'src/a.js' }
const B = { tool: 'write_file', target: 'src/b.js' }

// Итерация как в репро аудита: admit, и только разрешённое действие пишется.
const step = (task, call, seq) => {
  const verdict = task.admit(call)
  seq.push(verdict.allowed ? '+' : '-')
  if (verdict.allowed) {
    const action = task.beginAction(call)
    task.endAction(action.id, 'done')
  }
  return verdict
}

// 1. Бесконечный цикл останавливается: после использованного прохода A держится.
check('Н2: A->B->A loop held after the one conscious repeat', () => {
  const task = fresh()
  const seq = []
  for (let round = 0; round < 8; round++) { step(task, A, seq); step(task, B, seq) }
  const aSeq = seq.filter((_, i) => i % 2 === 0).join('')
  assert.equal(aSeq[1], '-', 'первое обнаружение цикла не предупредило')
  assert.equal(aSeq[2], '+', 'однократный проход после предупреждения закрыт (замысел волны)')
  assert.equal(aSeq.slice(5), '---', 'цикл продолжается без нового доказательства: A=' + aSeq)
  const executed = task.snapshot().actions.filter(item => item.target === 'src/a.js').length
  assert.ok(executed <= 3, 'A исполнялось неограниченно: ' + executed)
})

// 2. Новое доказательство — основание: удержание снимается.
check('Н2: new evidence releases the hold', () => {
  const task = fresh()
  const seq = []
  for (let round = 0; round < 6; round++) { step(task, A, seq); step(task, B, seq) }
  assert.equal(task.admit(A).allowed, false, 'цикл не удержан до доказательства')
  task.addEvidence({ source: 'observation', verdict: 'pass', coverage: 'a.js проверен' })
  assert.equal(task.admit(A).allowed, true, 'новое доказательство не стало основанием')
})

// Отрицательный контроль: приёмочный контракт волны — предупреждение одно,
// осознанный повтор сразу после него разрешён.
check('NEG: one warning, conscious repeat right after it is allowed', () => {
  const task = fresh()
  const a = task.beginAction(A); task.endAction(a.id, 'done')
  const b = task.beginAction(B); task.endAction(b.id, 'done')
  const refused = task.admit(A)
  assert.equal(refused.allowed, false)
  assert.equal(refused.cycle, true)
  assert.equal(refused.actionId, a.id)
  assert.equal(task.admit(A).allowed, true, 'решение модели после предупреждения')
})

// Отрицательный контроль: прямой повтор A→A без другой работы — не цикл, даже
// когда проход уже использован (наследование отметки не ломает прямой повтор).
check('NEG: direct A->A repeat is not a cycle even after used escape', () => {
  const task = fresh()
  const a = task.beginAction(A); task.endAction(a.id, 'done')
  const b = task.beginAction(B); task.endAction(b.id, 'done')
  assert.equal(task.admit(A).allowed, false)
  assert.equal(task.admit(A).allowed, true)
  const repeat = task.beginAction(A); task.endAction(repeat.id, 'done')
  const direct = task.beginAction(A); task.endAction(direct.id, 'done')
  assert.equal(task.admit(A).allowed, true, 'прямой повтор после использованного прохода держится как цикл')
})

// Отрицательный контроль: чужой цикл не приписан ведущему.
check('NEG: helper cycle does not hold leader', () => {
  const task = fresh()
  const seq = []
  for (let round = 0; round < 6; round++) {
    const verdict = task.admit({ ...A, agentIndex: 1 })
    seq.push(verdict.allowed ? '+' : '-')
    if (verdict.allowed) { const x = task.beginAction({ ...A, agentIndex: 1 }); task.endAction(x.id, 'done') }
    const y = task.beginAction({ ...B, agentIndex: 1 }); task.endAction(y.id, 'done')
  }
  assert.equal(task.admit({ ...A, agentIndex: 0 }).allowed, true)
})

// Отметка использованного прохода переживает перезапуск.
check('Н2: used escape survives restart', () => {
  const task = fresh()
  const a = task.beginAction(A); task.endAction(a.id, 'done')
  const b = task.beginAction(B); task.endAction(b.id, 'done')
  assert.equal(task.admit(A).allowed, false)
  assert.equal(task.admit(A).allowed, true)
  const repeat = task.beginAction(A); task.endAction(repeat.id, 'done')
  const other = task.beginAction(B); task.endAction(other.id, 'done')
  const restored = createTaskState({ now: () => 2, restored: cleanTaskState(task.snapshot()) })
  assert.equal(restored.admit(A).allowed, false, 'после перезапуска проход открыт снова')
  assert.equal(restored.admit(A).allowed, false, 'второе предупреждение после перезапуска открыло проход')
})

console.log(fails ? `\nFAILS=${fails}` : '\nALL OK')
process.exit(fails ? 1 : 0)