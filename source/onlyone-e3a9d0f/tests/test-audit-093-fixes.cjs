// Regression test suite for defects F1-F7 identified in Codex audit (0.93.0)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const mainSource = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
const appSource = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8')
const board = require('../src/main/agent-board')

let passed = 0
let total = 0
function check(label, condition, detail = '') {
  total++
  if (!condition) {
    console.error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`)
    process.exit(1)
  }
  passed++
  console.log(`  ok  ${label}`)
}

const cut = (text, a, b) => {
  const start = text.indexOf(a)
  const end = text.indexOf(b, start)
  assert(start >= 0 && end > start, `Not found: ${a}`)
  return text.slice(start, end)
}

console.log('=== F1: Immutable agent identity & role isolation ===')
{
  const assignments = new Map()
  const recordAssignment = new Function('assignmentsByRequest', cut(mainSource, 'function recordAssignment(', 'function isCollaborativeRequest(') + ';return recordAssignment')(assignments)

  // 1. Reserved title "Агент 1" or titles starting with agent keywords are discarded
  recordAssignment('req-id-1', { assignments: [{ agent: 2, title: 'Агент 1', task: 'Проверка' }] }, 2)
  const rec1 = assignments.get('req-id-1').assignments[0]
  check('title "Агент 1" отклоняется как заголовок', rec1.title === '')

  recordAssignment('req-id-2', { assignments: [{ agent: 2, title: 'Помощник верстки', task: 'Стили' }] }, 2)
  const rec2 = assignments.get('req-id-2').assignments[0]
  check('title со словом "Помощник" отклоняется', rec2.title === '')

  // 2. Helper on the board cannot close another agent task
  board.clearBoard('req-id-3')
  board.seedBoard('req-id-3', [
    { agent: 'Агент 2', task: 'Работа помощника 2' },
    { agent: 'Агент 3', task: 'Работа помощника 3' }
  ])
  const imp = board.updateItem('req-id-3', 'Агент 2', { id: 't2', status: 'done', note: 'Пытаюсь закрыть чужой пункт t2 с доказательством' })
  check('помощник не может закрыть чужой пункт', imp.success === false)

  // 3. Two helpers with identical titles receive unique identities and can message each other
  recordAssignment('req-id-4', { assignments: [{ agent: 2, title: 'Проверка', task: 'A' }, { agent: 3, title: 'Проверка', task: 'B' }] }, 2)
  board.clearBoard('req-id-4')
  board.seedBoard('req-id-4', [
    { agent: 'Агент 2', task: 'A' },
    { agent: 'Агент 3', task: 'B' }
  ])
  const msg = board.postMessage('req-id-4', 'Агент 2', { to: 'Агент 3', kind: 'question', body: 'Проверь файл пожалуйста' })
  check('сообщение между коллегами с одинаковыми title отправляется', msg.success === true)

  // 4. resolveName resolves prefix "Агент <name>"
  board.clearBoard('req-id-5')
  board.seedBoard('req-id-5', [{ agent: 'Проверка доступности', task: 'Проверить доступность' }])
  const liveBoard = board.ensureBoard('req-id-5')
  const resolved = board.resolveName(liveBoard, 'Агент Проверка доступности')
  check('resolveName сопоставляет "Агент <Имя>" с именем без префикса', resolved === 'Проверка доступности')
}

console.log('=== F2: Board gaps & mutation attribution ===')
{
  board.clearBoard('req-f2-1')
  board.seedBoard('req-f2-1', [{ agent: 'Агент 2', task: 'Исправить баг в коде', readOnly: false }])
  // Coordinator fixes the file and closes the item
  board.recordToolEvidence('req-f2-1', { tool: 'write_file', path: 'src/fix.js', agent: 'Агент 1', ok: true })
  const closeRes = board.updateItem('req-f2-1', 'Агент 1', { id: 't1', status: 'done', note: 'Исправил файл за помощника и протестировал' })
  check('координатор может закрыть задачу с обоснованием', closeRes.success === true)
  const gaps = board.boardGaps('req-f2-1')
  check('boardGaps признает исправление координатором', gaps.length === 0, gaps.join(', '))

  // Design mutations are recognized
  board.clearBoard('req-f2-2')
  board.seedBoard('req-f2-2', [{ agent: 'Агент 2', task: 'Обновить стили компонента', readOnly: false }])
  board.recordToolEvidence('req-f2-2', { tool: 'dc_html_str_replace', path: 'card.dc.html', agent: 'Агент 2', ok: true })
  board.updateItem('req-f2-2', 'Агент 2', { id: 't1', status: 'done', note: 'Обновил стили через dc_html_str_replace' })
  const designGaps = board.boardGaps('req-f2-2')
  check('dc_html_str_replace признается как валидная мутация', designGaps.length === 0, designGaps.join(', '))

  // Unrelated mutation by agent 3 does not validate agent 2 item
  board.clearBoard('req-f2-3')
  board.seedBoard('req-f2-3', [
    { agent: 'Агент 2', task: 'Задача 2', readOnly: false },
    { agent: 'Агент 3', task: 'Задача 3', readOnly: false }
  ])
  board.recordToolEvidence('req-f2-3', { tool: 'write_file', path: 'other.js', agent: 'Агент 3', ok: true })
  board.updateItem('req-f2-3', 'Агент 2', { id: 't1', status: 'done', note: 'Закрыл без своих правок' })
  const foreignGaps = board.boardGaps('req-f2-3')
  check('чужая запись не подтверждает пункт другого агента', foreignGaps.some(g => g.includes('t1')))
}

console.log('=== F3: Coordinator message routing ===')
{
  board.clearBoard('req-f3')
  board.seedBoard('req-f3', [{ agent: 'Агент 2', task: 'A' }, { agent: 'Агент 3', task: 'B' }])
  const q = board.postMessage('req-f3', 'Агент 2', { to: 'Агент 3', kind: 'question', body: 'Как проверить границу массива?' })
  check('вопрос создан', q.success === true)

  // Coordinator answers question with to: "Агент 3"
  const ans = board.postMessage('req-f3', 'Агент 1', { to: 'Агент 3', kind: 'answer', replyTo: q.id, body: 'Граница проверена отдельным тестом' })
  check('ответ координатора принят', ans.success === true)
  check('вопрос закрыт в unanswered', board.unanswered('req-f3').length === 0)

  // Author Agent 2 MUST receive the answer
  const inbox2 = board.inbox('req-f3', 'Агент 2')
  check('автор вопроса Агент 2 получил ответ в инбокс', inbox2.length === 1 && inbox2[0].replyTo === q.id)
}

console.log('=== F4: Collaborative request classification ===')
{
  const collab = new Function('lastUserMessage', cut(mainSource, 'function isCollaborativeRequest(', '// ---------------------------------------------------------------------------') + ';return isCollaborativeRequest')(p => p.messages.at(-1).content)

  // Negations and CLI queries should NOT trigger collaborative team mode
  check('CLI команда git status не вызывает команду',
    collab({ messages: [{ role: 'user', content: 'Что делает команда git status, ничего не выполняй' }] }) === false)

  check('Явный запрет работы вместе не вызывает команду',
    collab({ messages: [{ role: 'user', content: 'Не работай вместе с другими моделями, ответь сам' }] }) === false)

  check('"без других моделей" не вызывает команду',
    collab({ messages: [{ role: 'user', content: 'Ответь сам без других моделей и без агентов' }] }) === false)

  check('"команда npm test" не вызывает команду',
    collab({ messages: [{ role: 'user', content: 'Какая команда npm test запускает тесты?' }] }) === false)

  // True collaborative requests MUST trigger collaborative mode
  check('"работай вместе с другими моделями" вызывает команду',
    collab({ messages: [{ role: 'user', content: 'Работай вместе с другими моделями над проектом' }] }) === true)

  check('"подключи команду моделей" вызывает команду',
    collab({ messages: [{ role: 'user', content: 'Подключи команду моделей для рефакторинга' }] }) === true)

  check('"запусти агентов" вызывает команду',
    collab({ messages: [{ role: 'user', content: 'Запусти агентов и сделай сайт' }] }) === true)

  check('"командный режим" вызывает команду',
    collab({ messages: [{ role: 'user', content: 'Включи командный режим' }] }) === true)
}

console.log('=== F5: Incomplete terminal state & acceptance gate ===')
{
  const loop = cut(mainSource, 'async function runAgentLoop(', 'function createWindow(')
  // Отправка хода — настоящая точка из main.js: хвост цикла пишет в окно через
  // неё, и без неё вырезанный кусок падал бы на имени, а не на поведении.
  const guard = cut(mainSource, 'function sendToWindow(event, channel, body) {', 'async function runAgentMode(')
  const tail = loop.slice(loop.lastIndexOf('  const aborted = Boolean(signal?.aborted)'))
  const terminal = new Function('signal', 'event', 'payload', 'aggregateContent', 'aggregateReasoning', 'totalTokens', 'contextTokens', 'servedBy', 'agentIndex', 'agentName', 'hitStepLimit', 'lastGaps', 'continuationIncomplete = false', 'budgetRefusal = null',
    guard + '\n' +
    // Итоговый объект хода несёт artifacts (Н92); в этом сценарии их нет.
    'let gateContinues = 3; let gateLimit = 3; const createdArtifacts = [];\n' +
    tail.slice(0, tail.lastIndexOf('}')))

  const notice = 'Приёмка продлевала ход до предела и всё ещё видит незакрытым: файл не создан. Отправьте «продолжай».'
  const ended = terminal({}, { sender: { send() {} } }, { requestId: 'terminal' }, notice, '', 0, 0, 'model', 0, 'Агент 1', false, ['файл не создан'])
  check('терминальное состояние возвращает incomplete: true при незакрытых пунктах', ended.incomplete === true)
  check('терминальное состояние возвращает ok: false при незакрытых пунктах', ended.ok === false)

  const normalEnded = terminal({}, { sender: { send() {} } }, { requestId: 'term-ok' }, 'Всё готово и проверено', '', 0, 0, 'model', 0, 'Агент 1', false, [])
  check('успешное завершение возвращает ok: true', normalEnded.ok === true)
  check('успешное завершение возвращает incomplete: false', normalEnded.incomplete === false)
  const quoted = terminal({}, { sender: { send() {} } }, { requestId: 'quoted' }, 'Цитата: Отправьте «продолжай». Разбор завершён.', '', 0, 0, 'model', 0, 'Агент 1', false, [])
  check('цитата не превращает успешный ход в незавершённый', quoted.ok === true)
  const clipped = terminal({}, { sender: { send() {} } }, { requestId: 'clipped' }, 'Оборванный ответ', '', 0, 0, 'model', 0, 'Агент 1', false, [], true)
  check('структурированный признак обрыва возвращает incomplete', clipped.incomplete === true && clipped.ok === false)
}

console.log('=== F6: Tasks panel isolated by chatId ===')
{
  const pane = {
    chatId: 'chat-a',
    liveChatId: 'chat-a',
    generating: true,
    agentTasks: new Map([[0, { what: 'Работа в A' }]]),
    tasksOpen: true
  }

  const cancelledSuggestions = []
  const selectChatFn = new Function('dropEmptyChats', 'switchTab', 'panes', 'renderMessages', 'clearAgentTasks', 'renderChatHistory', 'el', 'renderSplitPane', 'refreshWorkspace', 'requestAnimationFrame', 'jumpToBottom', 'cancelNextSuggestion', 'document',
    cut(appSource, '  function selectChat(', '  function deleteChat(') + ';return selectChat'
  )(() => {}, () => {}, [pane], () => {}, () => { pane.agentTasks = new Map() }, () => {}, {}, () => {}, () => {}, () => {}, () => {}, chatId => cancelledSuggestions.push(chatId), {
    body: { classList: { contains: () => false } }
  })

  // Select chat-b
  selectChatFn(pane, 'chat-b')
  check('смена чата отменяет подсказку предыдущего чата', cancelledSuggestions[0] === 'chat-a')
  check('выбранный чат стал chat-b', pane.chatId === 'chat-b')
  check('задачи chat-a изолированы и не показываются в chat-b', pane.agentTasks.size === 0)
  check('панель задач закрыта для нового чата', pane.tasksOpen === false)

  // Switch back to chat-a
  selectChatFn(pane, 'chat-a')
  check('обратное переключение отменяет подсказку chat-b', cancelledSuggestions[1] === 'chat-b')
  check('при возвращении в chat-a задачи восстановлены', pane.agentTasks.size === 1)
  check('панель задач для chat-a снова открыта', pane.tasksOpen === true)
}

console.log('=== F7: Context ring current occupancy ===')
{
  const progressStart = appSource.indexOf('window.electronAPI.onAgentProgress?.(')
  const progressEnd = appSource.indexOf('\n    window.electronAPI.onAgentEvent', progressStart)
  let handler
  const contextPane = { contextTokens: 0 }
  new Function('window', 'paneForRequest', 'updateLiveMeta', 'renderContextRing',
    appSource.slice(progressStart, progressEnd)
  )({ electronAPI: { onAgentProgress(fn) { handler = fn } } }, () => contextPane, () => {}, () => {})

  handler({ requestId: 'ctx', agentIndex: 0, contextTokens: 80000 })
  check('контекст заполнен до 80 000', contextPane.contextTokens === 80000)

  // After context compaction, occupancy drops to 10 000
  handler({ requestId: 'ctx', agentIndex: 0, contextTokens: 10000 })
  check('после сжатия контекст корректно снижен до 10 000 (без Math.max)', contextPane.contextTokens === 10000)
}

console.log(`\nВсе регрессионные проверки F1–F7 успешно пройдены: ${passed}/${total}`)
