'use strict'
// break-3 Н3: любое уведомление внутри окна «Вернуть» коммитило удаление блока
// (settlePending(true) в showNotice) и прятало кнопку отмены — безвозвратная потеря.
// После правки: ошибка опроса не коммитит удаление и не прячет «Вернуть»;
// ошибка видна в строке статуса. Контроли: «Вернуть» возвращает блок; новое
// undo-действие по-прежнему коммитит предыдущее (прежнее поведение).
const assert = require('node:assert/strict')
const { loadDesk } = require('./fixtures/desk-stand.cjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function open () {
  const stand = loadDesk()
  await sleep(30)
  return stand
}
function removeBlock (stand, id) {
  const more = stand.$('desk-canvas').querySelector(`.ublock[data-block-id="${id}"] .desk-block-more`)
  assert.ok(more, `кнопка меню блока ${id} должна быть на холсте`)
  more.click()
  const remove = stand.$('desk-menu').querySelector('[data-action="remove"]')
  assert.ok(remove, 'пункт «Убрать с Desk» должен быть в меню')
  remove.click()
}
const removeApplies = stand => stand.calls.apply.filter(c => c.operations.some(o => o.type === 'remove')).map(c => c.operations)

async function errorDuringUndo () {
  const stand = await open()
  removeBlock(stand, 'b1')
  await sleep(10)
  assert.equal(stand.$('desk-notice-undo').hidden, false, '«Вернуть» должно быть видно после удаления')
  stand.flags.failWatches = true
  stand.listeners.changed()
  await sleep(40)
  return stand
}

async function undoClick () {
  const stand = await open()
  removeBlock(stand, 'b1')
  await sleep(10)
  stand.$('desk-notice-undo').click()
  await sleep(40)
  return stand
}

async function secondUndo () {
  const stand = await open()
  removeBlock(stand, 'b1')
  await sleep(10)
  removeBlock(stand, 'b2')
  await sleep(40)
  return stand
}

async function main () {
  const err = await errorDuringUndo()
  assert.deepEqual(removeApplies(err), [], 'ошибка внутри окна «Вернуть» закоммитила удаление блока')
  assert.equal(err.$('desk-notice-undo').hidden, false, 'кнопка «Вернуть» исчезла от постороннего уведомления')
  assert.deepEqual(err.blocks.map(b => b.id), ['b1', 'b2'], 'блок безвозвратно удалён')
  assert.equal(err.$('desk-status').textContent, 'Не удалось загрузить наблюдения', 'ошибка должна быть видна в строке статуса')
  console.log('ok ошибка в окне «Вернуть» не коммитит удаление и не прячет отмену')

  const undo = await undoClick()
  assert.deepEqual(removeApplies(undo), [], '«Вернуть» не должно вызывать apply')
  assert.deepEqual(undo.blocks.map(b => b.id), ['b1', 'b2'], '«Вернуть» обязано вернуть блок')
  console.log('ok отрицательный контроль: «Вернуть» возвращает блок')

  const second = await secondUndo()
  assert.deepEqual(removeApplies(second), [[{ type: 'remove', id: 'b1' }]], 'новое undo-действие должно закоммитить предыдущее')
  assert.deepEqual(second.blocks.map(b => b.id), ['b2'], 'первый блок удалён, второй под отменой')
  assert.equal(second.$('desk-notice-undo').hidden, false, 'отмена второго блока жива')
  console.log('ok контроль: второе удаление коммитит первое и держит свою отмену')

  console.log('ok test-desk-undo-notice')
}
main().catch(error => { console.error('FAIL test-desk-undo-notice:', error && error.message || error); process.exitCode = 1 })