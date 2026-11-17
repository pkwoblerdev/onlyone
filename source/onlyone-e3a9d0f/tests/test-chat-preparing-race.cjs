'use strict'
// break-2 Н3: переключение чата во время await attachPathsFromText уводило
// сообщение и ответ в другой чат. После правки: если панель переключили, пока
// шло сканирование путей, ход не начинается — сообщение не уходит в чужой чат,
// набранное сохраняется черновиком за прежним чатом.
// Контроль: без переключения сообщение уходит в свой чат как раньше.
const assert = require('node:assert/strict')
const { baseCtx, mkPane, mkChat, sendPrefix, vm } = require('./fixtures/app-chat-slices.cjs')

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

async function scenario (switchChat) {
  const A = mkChat('A'), B = mkChat('B')
  const p0 = mkPane('main', 'A')
  p0.dom.textarea.value = 'text meant for A'
  let resolveScan
  const ctx = baseCtx({ conversations: [A, B], panes: [p0], extra: { attachPathsFromText: () => new Promise(r => { resolveScan = r }) } })
  const sending = ctx.handleSendMessage(p0, 'text meant for A')
  await new Promise(r => setImmediate(r)) // дошли до await attachPathsFromText
  if (switchChat) ctx.selectChat(p0, 'B')
  resolveScan()
  await sending
  return { A, B, p0 }
}

async function main () {
  const switched = await scenario(true)
  assert.equal(switched.B.messages.length, 1, 'сообщение ушло в чужой чат B во время подготовки')
  assert.equal(switched.A.messages.length, 1, 'в исходном чате A начался ход после переключения')
  assert.equal(switched.p0.generating, false, 'панель осталась генерирующей после отмены отправки')
  assert.equal(switched.p0.queuedByChat.get('A'), 'text meant for A', 'набранное потеряно: черновик за прежним чатом не сохранён')
  console.log('ok переключение во время подготовки не уводит сообщение в чужой чат')

  const normal = await scenario(false)
  assert.equal(normal.A.messages.length, 2, 'без переключения сообщение должно уйти в свой чат')
  assert.equal(normal.A.messages[1].content, 'text meant for A')
  assert.equal(normal.B.messages.length, 1, 'чужой чат не тронут')
  console.log('ok отрицательный контроль: без переключения сообщение уходит в свой чат')

  if (failed) process.exit(1)
  console.log('ok test-chat-preparing-race')
}
main().catch(error => { console.error('FAIL test-chat-preparing-race:', error && error.message || error); process.exitCode = 1 })