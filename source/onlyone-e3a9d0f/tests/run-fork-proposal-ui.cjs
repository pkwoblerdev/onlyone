'use strict'
// Изолированное окно (без запуска приложения): карточка предложения связанного
// чата. Проверяются показ цели, причины, родителя и границы контекста, двойной
// клик, повторная доставка события, отказ и отсутствие исполнения разметки.
//
// Под node (в общем прогоне) файл перезапускает себя настоящим Electron: иначе
// require('electron') вернул бы путь к бинарю, а окна бы не было.
const electronModule = require('electron')
if (typeof electronModule === 'string') {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawnSync(electronModule, ['--no-sandbox', '--disable-gpu-sandbox', __filename], { stdio: 'inherit', env, windowsHide: true })
  process.exit(child.status === null ? 1 : child.status)
}
const { app, BrowserWindow } = electronModule
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { acquireWindowLock } = require('./app-launch.cjs')

// Test-only GPU flags: одно скрытое окно, без проверки настоящего рендера видом.
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')

// Профиль остаётся в %TEMP% (как у ask-user-renderer.cjs): Chromium держит файлы
// профиля до выхода процесса, а удалять чужой каталог нельзя.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), '1code-fork-proposal-ui-')))
acquireWindowLock()

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  await win.loadURL('data:text/html,<div id="chat"></div><div id="other"></div>')
  win.webContents.on('console-message', (_event, level, message) => console.error('PAGE[' + level + ']: ' + message))
  const chatForks = fs.readFileSync(path.join(__dirname, '../src/renderer/chat-forks.js'), 'utf8')
  const proposal = fs.readFileSync(path.join(__dirname, '../src/renderer/fork-proposal.js'), 'utf8')
  await win.webContents.executeJavaScript(chatForks + '\n;\n' + proposal)
  const result = await win.webContents.executeJavaScript(`(async () => {
    try {
    let checks = 0
    const assert = (ok, label) => { checks++; if (!ok) throw Error(label) }
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    const mount = window.OnlyoneForkProposal.mountCard
    const normalize = window.OnlyoneForkProposal.normalize
    const accept = window.OnlyoneForkProposal.accept
    const source = { id: 'parent', title: 'Parent chat', projectId: 'p1', messages: [
      { role: 'user', content: 'First question', timestamp: 1 },
      { role: 'assistant', content: 'First answer', timestamp: 2 }
    ] }
    const conversations = [source]
    const proposal = normalize({ title: 'Parser subtask', goal: 'Fix the parser only', reason: 'Separate area',
      context: { mode: 'messages', end: 1 } }, { parentChatId: 'parent', messages: source.messages })
    let accepts = 0
    const onAccept = async item => {
      accepts++
      const created = accept(item, { source, conversations, forkApi: window.OnlyoneChatForks, newId: 'child-1' })
      if (created.created) conversations.unshift(created.chat)
      return created
    }
    let opens = 0
    let runs = 0
    let returns = 0
    const onReturn = async () => { returns++; return { saved: true, record: { text: 'ответ', messageKey: 't:2' } } }
    const card = mount(document.getElementById('chat'), proposal, { t: text => text, parentTitle: source.title, onAccept, onReject: () => {}, onOpenChild: () => { opens++ }, onRun: () => { runs++ }, onReturn })
    assert(card, 'card returned')
    assert(document.querySelectorAll('.fork-proposal-card').length === 1, 'one card')
    assert(card.getAttribute('role') === 'group', 'card is a group')
    assert(/Предложение связанного чата/.test(card.textContent), 'kicker')
    assert(card.querySelector('.fork-proposal-title').textContent === 'Parser subtask', 'goal title shown')
    assert(card.textContent.includes('Fix the parser only'), 'goal shown')
    assert(card.textContent.includes('Separate area'), 'reason shown')
    assert(card.textContent.includes('Parent chat'), 'parent chat shown')
    assert(card.textContent.includes('Сообщение 2'), 'boundary shown')
    assert(card.textContent.includes('не запускает модель'), 'no-autostart hint')
    const acceptButton = card.querySelector('[data-action="accept"]')
    const rejectButton = card.querySelector('[data-action="reject"]')
    assert(acceptButton.type === 'button' && rejectButton.type === 'button', 'real buttons')
    assert(acceptButton.textContent === 'Создать связанный чат', 'accept label')
    assert(mount(document.getElementById('chat'), proposal, { t: text => text, parentTitle: source.title, onAccept, onReject: () => {}, onOpenChild: () => { opens++ }, onRun: () => { runs++ }, onReturn }) === card, 'repeat event returns the same card')
    assert(document.querySelectorAll('.fork-proposal-card').length === 1, 'repeat event adds no card')

    acceptButton.click(); acceptButton.click()
    await wait(30)
    assert(accepts === 1, 'double click accepts once')
    assert(conversations.length === 2, 'exactly one linked chat')
    assert(conversations.filter(item => item.fork?.proposalOperationId === proposal.operationId).length === 1, 'one child by operation id')
    assert(conversations[0].fork.parentChatId === 'parent', 'link recorded')
    assert(card.classList.contains('is-created'), 'created state')
    assert(card.textContent.includes('Связанный чат создан.'), 'created status')
    assert(acceptButton.textContent === 'Открыть связанный чат', 'accepted card offers the child chat')
    assert(!acceptButton.disabled && rejectButton.hidden, 'accepted card opens the child and cannot be rejected')
    const returnButton = card.querySelector('[data-action="return"]')
    assert(returnButton && !returnButton.hidden && returnButton.textContent === 'Вернуть итог', 'accepted card offers returning the result')
    returnButton.click()
    await wait(20)
    assert(returns === 1, 'return happens once per click')
    assert(card.textContent.includes('Итог возвращён родителю.'), 'return is confirmed in the card')
    acceptButton.click()
    await wait(20)
    assert(opens === 1, 'opening the child does not create anything')
    const runButton = card.querySelector('[data-action="run"]')
    assert(runButton && !runButton.hidden && runButton.textContent === 'Запустить', 'accepted card offers an explicit run')
    runButton.click()
    await wait(20)
    assert(runs === 1, 'run starts once per click')
    assert(accepts === 1 && conversations.length === 2, 'run is not a second creation')
    assert(accepts === 1 && conversations.length === 2, 'open is not a second creation')
    mount(document.getElementById('chat'), proposal, { t: text => text, parentTitle: source.title, onAccept, onReject: () => {}, onOpenChild: () => { opens++ }, onRun: () => { runs++ }, onReturn })
    assert(document.querySelectorAll('.fork-proposal-card').length === 1, 'accepted proposal is not remounted')
    assert(accepts === 1, 'remount does not create')

    const summary = normalize({ title: 'Summary task', goal: 'Continue parser work', context: { mode: 'summary', summary: 'Parser splits on commas.' } },
      { parentChatId: 'parent', messages: source.messages })
    let rejects = 0
    const summaryCard = mount(document.getElementById('other'), summary, { t: text => text, parentTitle: source.title,
      onAccept: () => {}, onReject: async () => { rejects++ } })
    assert(summaryCard.textContent.includes('Только выжимка'), 'summary is honest')
    assert(summaryCard.textContent.includes('Parser splits on commas.'), 'summary content visible')
    summaryCard.querySelector('[data-action="reject"]').click()
    await wait(20)
    assert(rejects === 1, 'reject callback once')
    assert(summaryCard.classList.contains('is-rejected'), 'rejected state')
    assert(summaryCard.textContent.includes('Предложение отклонено.'), 'rejected status')
    assert(conversations.length === 2, 'reject creates nothing')

    const unsafe = normalize({ title: '<img src=x onerror="window.pwned=1">', goal: 'Goal', context: { mode: 'messages', end: 0 } },
      { parentChatId: 'parent', messages: source.messages })
    const unsafeCard = mount(document.getElementById('other'), unsafe, { t: text => text, parentTitle: source.title, onAccept: () => {}, onReject: () => {} })
    assert(!unsafeCard.querySelector('img'), 'markup from model is text')
    assert(!window.pwned, 'no script execution')
    assert(unsafeCard.textContent.includes('<img'), 'raw text visible')
    return { ok: true, checks }
    } catch (error) { return { ok: false, error: String(error?.message || error), stack: String(error?.stack || '') } }
  })()`)
  if (!result?.ok) throw new Error(result?.error + '\n' + result?.stack)
  console.log(JSON.stringify(result))
  win.destroy()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
