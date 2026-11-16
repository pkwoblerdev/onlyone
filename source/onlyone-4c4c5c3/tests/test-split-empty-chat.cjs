// break-2 Н7: пустой чат закрытой боковой панели не убирается из списка никогда.
// toggleSplitView при закрытии не сбрасывает panes[1].chatId, и dropEmptyChats
// считает скрытую панель «показывающей» свой чат — пустой «Новый диалог», созданный
// при открытии сплита, висит в списке до конца сессии (п.18 владельца).
//
// Отрицательный контроль: пока сплит открыт и боковая панель действительно показывает
// пустой чат, dropEmptyChats его сохраняет (защита видимой панели не сломана).
// Стенд: настоящие слайсы toggleSplitView и dropEmptyChats из app.js в vm.
'use strict'
const assert = require('node:assert/strict')
const { cut, vm, mkPane, mkChat } = require('./fixtures/app-chat-slices.cjs')

const splitCode = cut('  let splitChatId = null', '  // Split divider')
const dropCode = cut('  function dropEmptyChats(exceptId, leavingPane) {', '  function selectChat(pane, chatId) {')

let failed = 0
let total = 0
function check (name, fn) {
  total++
  try { fn(); console.log('  ok  ' + name) } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message)) }
}

function stand () {
  const main = mkPane('p0', 'X')
  const side = mkPane('p1', 'E1')
  const ctx = {
    conversations: [{ id: 'E1', title: 'Новый диалог', messages: [], updatedAt: 1 }, mkChat('X')],
    panes: [main, side], activePane: main,
    el: { splitPane: { hidden: false, classList: { toggle () {} } }, splitResizer: { hidden: false }, splitViewBtn: { classList: { toggle () {} } } },
    document: { body: { classList: { contains: () => false, toggle () {} } } },
    $: () => null,
    setActivePane: p => { ctx.activePane = p },
    refreshTasksPanel: () => {}, saveConversations: () => {}, console
  }
  vm.createContext(ctx)
  vm.runInContext(splitCode + '\n' + dropCode, ctx)
  return { ctx, main, side }
}

// Н7: закрытие сплита сбрасывает чат боковой панели, и пустой чат уходит при переключении.
check('Н7: закрытый сплит не держит пустой чат', () => {
  const { ctx, main, side } = stand()
  ctx.toggleSplitView(false) // закрыли вторую панель
  assert.equal(side.chatId, null, 'чат боковой панели сброшен при закрытии, получено ' + side.chatId)
  const dropped = ctx.dropEmptyChats(null, main) // переключение в главной панели
  assert.equal(dropped, 1, 'пустой E1 удалён')
  assert.deepEqual(ctx.conversations.map(c => c.id), ['X'])
})

// Отрицательный контроль: открытый сплит — боковая панель показывает E1, он сохраняется.
check('Н7 контроль: открытый сплит держит свой пустой чат', () => {
  const { ctx, main, side } = stand()
  assert.equal(side.chatId, 'E1')
  const dropped = ctx.dropEmptyChats(null, main)
  assert.equal(dropped, 0, 'видимая боковая панель защищает свой чат')
  assert.deepEqual(ctx.conversations.map(c => c.id).sort(), ['E1', 'X'])
})

// Контроль: непустой чат боковой панели не удаляется даже после закрытия сплита.
check('Н7 контроль: непустой чат не удаляется', () => {
  const { ctx, main, side } = stand()
  ctx.conversations.find(c => c.id === 'E1').messages = [{ role: 'user', content: 'текст' }]
  ctx.toggleSplitView(false)
  ctx.dropEmptyChats(null, main)
  assert.deepEqual(ctx.conversations.map(c => c.id).sort(), ['E1', 'X'], 'непустой чат сохранён')
})

console.log(`\n${total - failed}/${total} ok`)
if (failed) process.exit(1)