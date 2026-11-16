'use strict'
// break-2 Н2: удаление генерирующего чата в боковой панели (других чатов нет)
// оставляло панель зависшей в generating с чужим requestId; набранное терялось,
// ход не отменялся. После правки: состояние хода сброшено, ход удалённого чата
// отменён. Контроли: удаление негенерирующего чата и удаление при наличии другого
// чата работают как раньше.
const assert = require('node:assert/strict')
const { baseCtx, mkPane, mkChat } = require('./fixtures/app-chat-slices.cjs')

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

function setup (panes, conversations) {
  const aborted = []
  const ctx = baseCtx({
    conversations, panes,
    extra: { window: { electronAPI: { abortMessage: id => { aborted.push(id); return Promise.resolve() } } } }
  })
  return { ctx, aborted }
}

check('удаление генерирующего чата в боковой панели сбрасывает ход и отменяет его', () => {
  const A = mkChat('A')
  const p0 = mkPane('main', null)
  const p1 = mkPane('side', 'A', { generating: true, requestId: 'reqA', liveChatId: 'A', assistantEl: {} })
  const { ctx, aborted } = setup([p0, p1], [A])
  ctx.deleteChat('A')
  assert.equal(p1.chatId, null)
  assert.equal(p1.generating, false, 'панель зависла генерирующей после удаления чата')
  assert.equal(p1.preparing, false)
  assert.equal(p1.requestId, null, 'requestId мёртвого хода сохранён')
  assert.equal(p1.liveChatId, null)
  assert.deepEqual(aborted, ['reqA'], 'ход удалённого чата не отменён — токены продолжают тратиться')
})

check('контроль: удаление негенерирующего чата не зовёт отмену', () => {
  const A = mkChat('A')
  const p0 = mkPane('main', null)
  const p1 = mkPane('side', 'A')
  const { ctx, aborted } = setup([p0, p1], [A])
  ctx.deleteChat('A')
  assert.equal(p1.chatId, null)
  assert.equal(p1.generating, false)
  assert.deepEqual(aborted, [], 'отмена вызвана для негенерирующего чата')
})

check('контроль: при наличии другого чата панель переключается на него', () => {
  const A = mkChat('A'), B = mkChat('B')
  const p0 = mkPane('main', null)
  const p1 = mkPane('side', 'A', { generating: true, requestId: 'reqA', liveChatId: 'A', assistantEl: {} })
  const { ctx, aborted } = setup([p0, p1], [A, B])
  ctx.deleteChat('A')
  assert.equal(p1.chatId, 'B', 'панель не переключилась на оставшийся чат')
  assert.deepEqual(aborted, ['reqA'], 'ход удалённого чата не отменён')
})

if (failed) process.exit(1)
console.log('ok test-chat-delete-generating')