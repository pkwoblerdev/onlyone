'use strict'
// break-2 Н6: карточки detached-хода (форк-предложение, вопрос, разрешение)
// монтировались в ленту видимого ЧУЖОГО чата и насильно скроллили её — человек
// принимал файловое разрешение в чужом контексте. После правки: карточка
// монтируется только в ленту своего чата; detached-карточка сохраняется и
// возвращается при переключении обратно (форк — из описи, вопрос/разрешение —
// из карты карточек). Контроль: attached-ход монтирует в свою ленту как раньше.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n')
const cut = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker missing: ' + a); return SRC.slice(i, j) }
const paneForRequestCode = cut('  function paneForRequest(requestId) {', '  function paneOfChat(chatId) {')
const questionCode = cut('    window.electronAPI.onAgentQuestion?.(request => {', '    // Предложение связанного чата приходит из хода')
const forkCode = cut('    window.electronAPI.onForkProposal?.(payload => {', '    window.electronAPI.onAgentApproval(request => {')
const approvalCode = cut('    window.electronAPI.onAgentApproval(request => {', '    // Ожидание снято: часть прервана по сроку')
const restoreCode = cut('    for (const pending of questionCards.values()) {', '    restoreForkProposalCards(pane)')

function fakeEl () {
  const el = {
    tagName: 'DIV', className: '', children: [], dataset: {}, style: {}, hidden: false, value: '',
    classList: { add () {}, remove () {}, toggle () {}, contains: () => false },
    appendChild (c) { this.children.push(c); return c }, append () {}, remove () {},
    addEventListener () {}, setAttribute () {}, scrollIntoView () {}, focus () {},
    querySelector () { return fakeEl() }, querySelectorAll () { return [] },
    set innerHTML (v) { this._html = v }, get innerHTML () { return this._html || '' }
  }
  return el
}
const mkList = name => ({ name, children: [], dataset: {}, appendChild (c) { this.children.push(c); return c } })

function setup (visibleChat) {
  const list = mkList('list-' + visibleChat)
  const pane = { id: 'main', chatId: visibleChat, requestId: null, dom: { list, feed: {} }, liveTurnsByChat: new Map([['A', { requestId: 'reqA', generating: true }]]) }
  const scrollCalls = []
  const ctx = {
    console, Map, Set, JSON, Number, String, Boolean, Array, Object, Promise,
    panes: [pane],
    conversations: [{ id: 'A', title: 'Chat A', messages: [] }, { id: 'B', title: 'Chat B', messages: [] }],
    questionCards: new Map(), forkProposalCards: new Map(), approvalCards: new Map(),
    designRun: null, document: { createElement: () => fakeEl(), querySelector: () => null },
    escapeHtml: s => String(s), btoa: s => s, unescape: s => s, encodeURIComponent: s => s,
    saveConversations () {}, flushConversations: () => Promise.resolve(true), showToast () {}, t: x => x,
    forkProposalHandlers: () => ({}), refreshForkProposalSummary () {}, renderDiffLines: s => s, cleanErrorText: s => s,
    askConfirm: () => Promise.resolve(false),
    scrollToBottom: (p, force) => scrollCalls.push({ list: p.dom && p.dom.list && p.dom.list.name, force: Boolean(force) }),
    OnlyoneForkProposal: {
      normalize: () => ({ operationId: 'fp_test12345', parentChatId: 'A', title: 'Fork', goal: 'g', reason: 'r', context: { mode: 'full', end: 1, revision: 'x', summary: '' }, createdAt: 1 }),
      findChild: () => null, isDismissed: () => false, mountCalls: [],
      mountCard (container, proposal) { this.mountCalls.push({ container, proposal }); return fakeEl() }, placeCard () {}
    },
    OnlyoneForkProposalStore: { status: () => null, putCalls: 0, put () { this.putCalls++; return { ok: true } } },
    window: { electronAPI: { resolveAgentApproval: async () => {}, resolveAgentQuestion: async () => {} } }
  }
  ctx.window.electronAPI.onAgentQuestion = fn => { ctx.questionHandler = fn }
  ctx.window.electronAPI.onForkProposal = fn => { ctx.forkHandler = fn }
  ctx.window.electronAPI.onAgentApproval = fn => { ctx.approvalHandler = fn }
  vm.createContext(ctx)
  vm.runInContext(paneForRequestCode + '\n' + questionCode + '\n' + forkCode + '\n' + approvalCode, ctx)
  return { ctx, pane, list, scrollCalls }
}

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

// detached: панель показывает B, ход reqA принадлежит чату A.
check('форк-предложение detached-хода не монтируется в чужую ленту и не скроллит её', () => {
  const { ctx, list, scrollCalls } = setup('B')
  ctx.forkHandler({ requestId: 'reqA', proposal: {} })
  assert.equal(ctx.OnlyoneForkProposal.mountCalls.length, 0, 'форк-карточка смонтирована в ленту чужого чата')
  assert.equal(list.children.length, 0)
  assert.ok(!scrollCalls.some(c => c.list === 'list-B' && c.force), 'чужая лента насильно проскроллена')
  assert.equal(ctx.OnlyoneForkProposalStore.putCalls, 1, 'предложение не сохранено в опись — не вернётся при переключении')
})
check('вопрос detached-хода не монтируется в чужую ленту, но сохраняется для возврата', () => {
  const { ctx, list } = setup('B')
  ctx.questionHandler({ requestId: 'reqA', id: 'q1', question: 'Что делать?', options: [] })
  assert.equal(list.children.length, 0, 'вопрос смонтирован в ленту чужого чата')
  assert.equal(ctx.questionCards.size, 1, 'вопрос не сохранён — ход зависнет без ответа')
  assert.equal(ctx.questionCards.get('q1').chatId, 'A', 'вопрос привязан не к своему чату')
})
check('разрешение detached-хода не монтируется в чужую ленту, но сохраняется для возврата', () => {
  const { ctx, list } = setup('B')
  ctx.approvalHandler({ requestId: 'reqA', id: 'ap1', summary: 'Удалить файл', details: 'a.js\n10 байт' })
  assert.equal(list.children.length, 0, 'разрешение смонтировано в ленту чужого чата')
  assert.equal(ctx.approvalCards.size, 1, 'разрешение не сохранено — ход зависнет без ответа')
  assert.equal(ctx.approvalCards.get('ap1').chatId, 'A', 'разрешение привязано не к своему чату')
})

// attached: панель показывает сам чат A — карточки монтируются в свою ленту.
check('контроль: attached-ход монтирует форк/вопрос/разрешение в свою ленту', () => {
  const { ctx, pane, list } = setup('A')
  pane.requestId = 'reqA'
  ctx.forkHandler({ requestId: 'reqA', proposal: {} })
  assert.equal(ctx.OnlyoneForkProposal.mountCalls.length, 1, 'attached-форк не смонтирован')
  assert.equal(ctx.OnlyoneForkProposal.mountCalls[0].container, list)
  ctx.questionHandler({ requestId: 'reqA', id: 'q2', question: 'Что делать?', options: [] })
  assert.equal(list.children.length, 1, 'attached-вопрос не смонтирован в свою ленту')
  ctx.approvalHandler({ requestId: 'reqA', id: 'ap2', summary: 'Записать файл', details: 'b.js' })
  assert.equal(list.children.length, 2, 'attached-разрешение не смонтировано в свою ленту')
})

// Возврат: переключение обратно на свой чат возвращает сохранённые карточки.
check('возврат: вопрос и разрешение detached-хода возвращаются в ленту своего чата', () => {
  const { ctx, pane, list } = setup('B')
  ctx.questionHandler({ requestId: 'reqA', id: 'q1', question: 'Что делать?', options: [] })
  ctx.approvalHandler({ requestId: 'reqA', id: 'ap1', summary: 'Удалить файл', details: 'a.js\n10 байт' })
  assert.equal(list.children.length, 0)
  pane.chatId = 'A'
  ctx.pane = pane
  vm.runInContext(restoreCode, ctx)
  assert.equal(list.children.length, 2, 'карточки не вернулись в свою ленту при переключении')
  // Отвеченное разрешение не должно воскреснуть при следующей перерисовке.
  const pending = ctx.approvalCards.get('ap1')
  assert.ok(pending, 'разрешение не сохранено в карте')
  ctx.approvalCards.delete('ap1')
  list.children.length = 0
  vm.runInContext(restoreCode, ctx)
  assert.equal(list.children.length, 1, 'удалённое из карты разрешение воскресло')
})

if (failed) process.exit(1)
console.log('ok test-cross-chat-card')