// Стенд ядра чата app.js: настоящие слайсы selectChat/deleteChat/paneForRequest/
// начала handleSendMessage исполняются в vm (приём tests/test-chat-forks.cjs и
// ломающего разбора break-2). Окружение подменное: сети и Electron нет.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8')
const cut = (a, b) => {
  const i = app.indexOf(a), j = app.indexOf(b, i)
  if (i < 0 || j < 0) throw new Error('marker missing: ' + a)
  return app.slice(i, j).replace(/\r\n/g, '\n')
}
const selectChatCode = cut('  function dropEmptyChats(exceptId, leavingPane) {', '  function deleteChat(chatId) {')
const deleteChatCode = cut('  function deleteChat(chatId) {', '  function clearActiveChat(')
const paneForRequestCode = cut('  function paneForRequest(requestId) {', '  function paneOfChat(chatId) {')
const sendPrefix = cut('  async function handleSendMessage(pane, rawText, { hidden = \'\', resumeRunId = \'\' } = {}) {', '    // Start Generation State.') + '\nreturn chat.id\n}'

function baseCtx (over = {}) {
  const conversations = over.conversations || []
  const panes = over.panes || []
  const ctx = {
    conversations, panes, activePane: panes[0] || null, splitChatId: null,
    el: { splitPane: { hidden: true } },
    document: { body: { classList: { contains: () => false } }, activeElement: null },
    saveConversations () {}, renderMessages () {}, renderChatHistory () {}, renderProjects () {},
    cancelNextSuggestion () {}, switchTab () {}, clearAgentTasks () {}, renderQueuedNotice () {},
    renderSplitPane () {}, refreshWorkspace () {}, paintSendButton () {}, jumpToBottom () {},
    requestAnimationFrame () {}, createNewChat () { throw new Error('unexpected createNewChat') },
    chatOf: pane => conversations.find(c => c.id === pane?.chatId) || null,
    OnlyoneSlashCommands: { startsCommand: () => false }, SLASH_COMMANDS: [],
    selectedModel: { id: 'm', name: 'M' }, fastMode: false,
    autoResizeTextarea () {}, clearAttachments () {}, showToast () {}, t: s => s,
    window: { electronAPI: {} }, console,
    ...over.extra
  }
  vm.createContext(ctx)
  vm.runInContext(selectChatCode + '\n' + deleteChatCode + '\n' + paneForRequestCode + '\n' + sendPrefix, ctx)
  return ctx
}
const mkPane = (id, chatId, extra = {}) => ({
  id, chatId, generating: false, preparing: false, resuming: false, requestId: null, liveChatId: null,
  assistantEl: null, liveTurnsByChat: new Map(), queuedByChat: new Map(), tasksByChat: new Map(),
  queuedMessage: '', blocks: [], paintedBlocks: [], contentBuffer: '', streamQueue: '',
  reasoningBuffer: '', reasoningSegments: [], fileChanges: [], attachments: [], quotes: [],
  dom: { textarea: { value: '' }, list: {} }, stickToBottom: true, ...extra
})
const mkChat = id => ({ id, title: id, messages: [{ role: 'user', content: 'seed ' + id }], updatedAt: 1 })

module.exports = { app, cut, selectChatCode, deleteChatCode, paneForRequestCode, sendPrefix, baseCtx, mkPane, mkChat, vm }