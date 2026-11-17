// Тестирование реальных функций очереди сообщений и изоляции чатов из src/renderer/app.js.
// Проверяет:
// 1. Постановка нескольких сообщений в очередь во время хода накапливает их (train of thoughts),
//    а не затирает первое вторым.
// 2. Реальная функция selectChat изолирует очередь per-chat: при переходе в chat_B
//    очередь из chat_A не отображается и не уходит в chat_B.
// 3. При возвращении в chat_A после завершения хода накопленные требования восстанавливаются
//    и отправляются в chat_A.
// 4. Реальная политика кэша renderMarkdownHtml является истинным LRU (чтение записи обновляет
//    её позицию, предотвращая вытеснение горячей записи).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Код окна разложен по модулям (план, 2d): берём весь исполняемый текст.
const appJs = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (err) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message))
  }
}

const cut = (source, from, to) => {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  assert.ok(a >= 0 && b > a, 'не найдено: ' + from)
  return source.slice(a, b)
}

// 1. Проверка исходников: отсутствие неизолированного pane.queued в форме и setGeneratingState
check('исходный код: форма отправки не использует неизолированный push в очередь', () => {
  const formSubmit = cut(appJs, "form.addEventListener('submit', e => {", "sendBtn?.addEventListener('click'")
  assert.doesNotMatch(formSubmit, /pane\.queued\.push\(text\)/,
    'форма использует неизолированный массив pane.queued.push')
})

check('исходный код: setGeneratingState не сбрасывает чужую очередь в активный чат при завершении', () => {
  const genState = cut(appJs, 'function setGeneratingState(pane, generating) {', 'function renderQueued(')
  assert.doesNotMatch(genState, /setTimeout\(\(\) => handleSendMessage\(pane, text\), 60\)/,
    'setGeneratingState безусловно сбрасывает очередь в текущий открытый чат')
})

// 2. Выполнение НАСТОЯЩЕГО обработчика handleSendMessage из app.js: накопление нескольких уточнений
check('реальный handleSendMessage: второе уточнение не стирает первое', async () => {
  const start = appJs.indexOf('async function handleSendMessage(pane, rawText, {')
  const end = appJs.indexOf('const turnModel =', start)
  assert.ok(start >= 0 && end > start, 'handleSendMessage не найден в app.js')

  const notices = []
  const toasts = []
  const ctx = {
    autoResizeTextarea() {},
    renderQueuedNotice(p) { notices.push(p.queuedMessage) },
    showToast(msg) { toasts.push(msg) }
  }
  vm.createContext(ctx)
  vm.runInContext(appJs.slice(start, end) + '}\nthis.enqueue = handleSendMessage;', ctx)

  const pane = {
    generating: true,
    preparing: false,
    chatId: 'chat_A',
    queuedMessage: '',
    queuedByChat: new Map(),
    dom: { textarea: { value: '' } }
  }

  // Первое уточнение
  await ctx.enqueue(pane, 'первое требование')
  assert.equal(pane.queuedMessage, 'первое требование')
  assert.equal(pane.queuedByChat.get('chat_A'), 'первое требование')

  // Второе уточнение во время того же хода
  await ctx.enqueue(pane, 'второе требование')

  // Проверяем, что ОБА требования сохранены, а не затерты
  assert.ok(pane.queuedMessage.includes('первое требование'), 'Первое требование было потеряно при втором вводе!')
  assert.ok(pane.queuedMessage.includes('второе требование'), 'Второе требование отсутствует в очереди!')
  assert.equal(pane.queuedMessage, 'первое требование\n\nвторое требование')
  assert.equal(pane.queuedByChat.get('chat_A'), 'первое требование\n\nвторое требование')
})

// 3. Выполнение НАСТОЯЩЕЙ функции selectChat из app.js: изоляция очереди между чатами
check('реальный selectChat: изолирует очередь per-chat и отправляет её только в свой чат', () => {
  const selectStart = appJs.indexOf('  function selectChat(pane, chatId) {')
  const selectEnd = appJs.indexOf('  function deleteChat(chatId) {', selectStart)
  assert.ok(selectStart >= 0 && selectEnd > selectStart, 'selectChat не найден в app.js')

  const dispatched = []
  const cancelledSuggestions = []
  const ctx = {
    document: { body: { classList: { contains: () => false } } },
    dropEmptyChats() {},
    cancelNextSuggestion(chatId) { cancelledSuggestions.push(chatId) },
    switchTab() {},
    clearAgentTasks() {},
    renderMessages() {},
    renderChatHistory() {},
    renderQueuedNotice() {},
    refreshWorkspace() {},
    renderSplitPane() {},
    jumpToBottom() {},
    requestAnimationFrame(cb) { cb() },
    handleSendMessage(p, text) { dispatched.push({ chatId: p.chatId, text }) },
    panes: [null],
    el: {}
  }
  vm.createContext(ctx)
  vm.runInContext(appJs.slice(selectStart, selectEnd) + '\nthis.selectChat = selectChat;', ctx)

  const pane = {
    chatId: 'chat_A',
    generating: true,
    preparing: false,
    queuedMessage: 'первое требование\n\nвторое требование',
    queuedByChat: new Map([['chat_A', 'первое требование\n\nвторое требование']]),
    dom: {}
  }
  ctx.panes[0] = pane

  // Переключаемся на chat_B, пока в chat_A идет генерация
  ctx.selectChat(pane, 'chat_B')

  assert.equal(cancelledSuggestions[0], 'chat_A', 'Подсказка уходящего chat_A осталась активной')
  assert.equal(pane.chatId, 'chat_B')
  assert.equal(pane.queuedMessage, '', 'В chat_B утекло уточнение из chat_A!')
  assert.equal(dispatched.length, 0, 'Уточнение было ошибочно отправлено при переключении на chat_B!')

  // Ход в chat_A завершился: генерирование окончено
  pane.generating = false
  pane.preparing = false

  // Переключаемся обратно в chat_A
  ctx.selectChat(pane, 'chat_A')

  assert.equal(cancelledSuggestions[1], 'chat_B', 'Подсказка уходящего chat_B осталась активной')
  // Очередь должна восстановиться и быть отправлена в chat_A
  assert.equal(dispatched.length, 1, 'Очередь должна была быть отправлена при возвращении в chat_A')
  assert.equal(dispatched[0].chatId, 'chat_A')
  assert.equal(dispatched[0].text, 'первое требование\n\nвторое требование')
})

// 4. Выполнение НАСТОЯЩЕЙ логики кэша renderMarkdownHtml: истинный LRU
check('реальный renderMarkdownHtml: LRU-политика сохраняет горячие записи от вытеснения', () => {
  const cStart = appJs.indexOf('  const MARKDOWN_CACHE_MAX =')
  const cEnd = appJs.indexOf('  // Flattens segments', cStart)
  assert.ok(cStart >= 0 && cEnd > cStart, 'renderMarkdownHtml не найден в app.js')

  const cacheCtx = {
    marked: { parse: s => s },
    DOMParser: class { parseFromString(s) { return { body: { innerHTML: s } } } },
    markTaskBoxes() {},
    linkifyImages() {},
    scrubElement() {},
    markInlinePaths() {},
    highlightCodeBlocks() {},
    wrapCodeBlocks() {},
    wrapTables() {},
    console
  }
  vm.createContext(cacheCtx)
  vm.runInContext(appJs.slice(cStart, cEnd) + '\nthis.render = renderMarkdownHtml; this.cache = markdownCache;', cacheCtx)

  // Заполняем кэш до максимума (300 записей)
  for (let i = 0; i < 300; i++) {
    cacheCtx.render(`entry_${i}`)
  }
  assert.equal(cacheCtx.cache.size, 300)

  // Берём самую старую запись (первую добавленную)
  const oldestKey = cacheCtx.cache.keys().next().value
  assert.equal(oldestKey, 'entry_0')

  // Обращаемся к oldestKey (происходит hit)
  cacheCtx.render(oldestKey)

  // Добавляем новую 301-ю запись
  cacheCtx.render('entry_300_new')

  // Проверяем: при честном LRU запись entry_0 НЕ должна была быть вытеснена!
  // Вытесниться должна была entry_1, так как entry_0 стала MRU после обращения к ней.
  assert.ok(cacheCtx.cache.has(oldestKey), 'LRU ошибка: горячая запись была вытеснена (поведение FIFO)!')
  assert.ok(!cacheCtx.cache.has('entry_1'), 'Запись entry_1 должна была быть вытеснена как наименее используемая')
})

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
