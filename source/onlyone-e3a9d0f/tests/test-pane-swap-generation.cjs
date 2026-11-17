// break-2 Н1: свап панелей во время генерации. В боковой панели идёт ход чата A;
// в главной открывают тот же A — панели обмениваются чатами, но состояние хода
// (generating/requestId/liveChatId) остаётся у боковой, которая теперь показывает B.
// Боковая навсегда «генерирующая» на чужом чате, поток течёт в неё, принятая панель
// не показывает живой ход. Правки Н6/Н2/Н3 закрывают монтаж карточек/удаление/
// подготовку, но не свап — находка не закрыта транзитивно.
//
// Отрицательный контроль: свап двух НЕгенерирующих панелей просто меняет чаты;
// обычное переключение генерирующей панели сохраняет ход за чатом (detached).
'use strict'
const assert = require('node:assert/strict')
const { baseCtx, mkPane, mkChat } = require('./fixtures/app-chat-slices.cjs')

let failed = 0
let total = 0
function check (name, fn) {
  total++
  try { fn(); console.log('  ok  ' + name) } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message)) }
}

// Ход чата A идёт в боковой панели p1; главная p0 показывает B (свободна).
// liveTurnsByChat[A] создан, как это делает setGeneratingState при старте хода.
function generatingStand () {
  const p0 = mkPane('p0', 'B')
  const p1 = mkPane('p1', 'A', { generating: true, requestId: 'reqA', liveChatId: 'A', contentBuffer: 'идёт…', assistantEl: { id: 'aEl' } })
  p1.liveTurnsByChat.set('A', { generating: true, preparing: false, requestId: 'reqA', liveChatId: 'A' })
  const ctx = baseCtx({ conversations: [mkChat('A'), mkChat('B')], panes: [p0, p1] })
  return { ctx, p0, p1 }
}

// Н1: после открытия A в главной панели ход A принадлежит главной, боковая свободна.
check('Н1: свап переносит ход A в принявшую панель', () => {
  const { ctx, p0, p1 } = generatingStand()
  ctx.selectChat(p0, 'A')
  assert.equal(p0.chatId, 'A', 'главная показывает A')
  assert.equal(p1.chatId, 'B', 'боковая показывает B')
  assert.equal(p1.generating, false, 'боковая не осталась генерирующей на чужом чате B')
  assert.notEqual(p1.liveChatId, 'A', 'боковая не держит liveChatId=A')
  assert.equal(p0.generating, true, 'принятая панель показывает живой ход A')
  assert.equal(p0.requestId, 'reqA', 'ход reqA теперь в главной панели')
  const owner = ctx.paneForRequest('reqA')
  assert.ok(owner, 'ход reqA найден')
  assert.equal(owner.chatId, 'A', 'поток reqA течёт в панель, показывающую A, а не B')
})

// Отрицательный контроль: свап двух свободных панелей просто меняет чаты.
check('Н1 контроль: свап свободных панелей меняет чаты', () => {
  const p0 = mkPane('p0', 'B')
  const p1 = mkPane('p1', 'A')
  const ctx = baseCtx({ conversations: [mkChat('A'), mkChat('B')], panes: [p0, p1] })
  ctx.selectChat(p0, 'A')
  assert.equal(p0.chatId, 'A')
  assert.equal(p1.chatId, 'B')
  assert.equal(p0.generating, false)
  assert.equal(p1.generating, false)
})

// Контроль: обычное переключение генерирующей панели сохраняет ход за чатом (detached).
check('Н1 контроль: переключение сохраняет ход за чатом', () => {
  const p0 = mkPane('p0', 'A', { generating: true, requestId: 'reqA', liveChatId: 'A' })
  p0.liveTurnsByChat.set('A', { generating: true, preparing: false, requestId: 'reqA', liveChatId: 'A' })
  const p1 = mkPane('p1', null)
  const ctx = baseCtx({ conversations: [mkChat('A'), mkChat('B')], panes: [p0, p1] })
  ctx.selectChat(p0, 'B')
  assert.equal(p0.chatId, 'B')
  assert.equal(p0.generating, false, 'панель больше не генерирует на B')
  const owner = ctx.paneForRequest('reqA')
  assert.ok(owner, 'ход reqA сохранён detached')
  assert.equal(owner.requestId, 'reqA')
})

console.log(`\n${total - failed}/${total} ok`)
if (failed) process.exit(1)