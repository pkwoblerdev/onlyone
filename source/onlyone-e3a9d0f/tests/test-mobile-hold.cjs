// break-3 Н4: удержание «Разрешить опасное действие» на телефоне обходится.
// A) второй палец orphanит первый таймер — разрешение уходит без удержания;
// B) перерисовка paintAsks во время удержания — таймер живёт на снятом узле.
// Отрицательный контроль: одиночный тап, отпущенный раньше 1,2 с, не разрешает.
// Положительный контроль: полное удержание 1,2 с разрешает (confirmed:true).
// Стенд: настоящий mobile/www/js/app.js, подменные Store и сетевой клиент.
'use strict'
const assert = require('node:assert/strict')
const { loadPhone } = require('./fixtures/mobile-stand.cjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function open (pending) {
  const stand = loadPhone()
  await sleep(20)
  stand.remote.state.pending.approvals = pending
  stand.app.go('chat', { kind: 'pc', id: 'c1' })
  await sleep(20)
  return stand
}
const answers = stand => stand.requests.filter(r => r.method === 'approval.answer').map(r => r.params)
const holdButton = stand => stand.$('asks').querySelector('.hold')
const dangerous = { id: 'a1', chat: 'c1', summary: 'Удалить папку проекта', dangerous: true, details: 'rm -rf D:/project' }

async function twoFingers () {
  const stand = await open([{ ...dangerous }])
  const button = holdButton(stand)
  assert.ok(button, 'кнопка удержания должна быть нарисована')
  stand.dom.fire(button, 'pointerdown', { pointerId: 1 })
  await sleep(100)
  stand.dom.fire(button, 'pointerdown', { pointerId: 2 })
  await sleep(100)
  stand.dom.fire(button, 'pointerup', { pointerId: 1 })
  stand.dom.fire(button, 'pointerup', { pointerId: 2 })
  await sleep(1400)
  return answers(stand)
}

async function repaint () {
  const stand = await open([{ ...dangerous }])
  const button = holdButton(stand)
  stand.dom.fire(button, 'pointerdown', { pointerId: 1 })
  await sleep(100)
  // Штатная перерисовка: пришёл ещё один запрос агента → paintAsks переписывает innerHTML.
  stand.remote.state.pending.approvals.push({ id: 'a2', chat: 'c1', summary: 'Записать файл', dangerous: false })
  stand.fireRemote('pending', { pending: stand.remote.state.pending, fresh: [] })
  assert.ok(!stand.dom.document.contains(button), 'старая кнопка должна быть снята перерисовкой')
  await sleep(100)
  stand.dom.fire(holdButton(stand), 'pointerup', { pointerId: 1 })
  await sleep(1400)
  return answers(stand)
}

async function singleTap () {
  const stand = await open([{ ...dangerous }])
  const button = holdButton(stand)
  stand.dom.fire(button, 'pointerdown', { pointerId: 1 })
  await sleep(200)
  stand.dom.fire(button, 'pointerup', { pointerId: 1 })
  await sleep(1400)
  return answers(stand)
}

async function fullHold () {
  const stand = await open([{ ...dangerous }])
  const button = holdButton(stand)
  stand.dom.fire(button, 'pointerdown', { pointerId: 1 })
  await sleep(1350)
  return answers(stand)
}

async function main () {
  const two = await twoFingers()
  console.log('два пальца, отпущены на 200 мс:', JSON.stringify(two))
  assert.deepEqual(two, [], 'второй палец не должен оставлять осиротевший таймер: разрешение ушло без удержания')

  const repainted = await repaint()
  console.log('перерисовка во время удержания:', JSON.stringify(repainted))
  assert.deepEqual(repainted, [], 'перерисовка во время удержания не должна разрешать опасное действие')

  const tap = await singleTap()
  console.log('отрицательный контроль (одиночный тап):', JSON.stringify(tap))
  assert.deepEqual(tap, [], 'одиночный тап не разрешает')

  const held = await fullHold()
  console.log('положительный контроль (полное удержание):', JSON.stringify(held))
  assert.equal(held.length, 1, 'полное удержание разрешает ровно один раз')
  assert.equal(held[0].id, 'a1')
  assert.equal(held[0].approved, true)
  assert.equal(held[0].confirmed, true)

  console.log('ok test-mobile-hold: удержание нельзя обойти вторым пальцем или перерисовкой')
}
main().catch(error => { console.error('FAIL test-mobile-hold:', error && error.message || error); process.exitCode = 1 })