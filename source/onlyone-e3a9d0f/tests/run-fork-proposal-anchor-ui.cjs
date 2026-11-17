'use strict'
// Изолированное окно (без запуска приложения): привязка карточки предложения к
// сообщению-границе и сводная карточка «Связанные задачи · N».
//
// Проверяется: карточка встаёт сразу после узла с data-fork-message-index ===
// String(context.end); без границы (выжимка) — в конец; перерисовка не задваивает
// карточки и обработчики; сводка считает предложенные и созданные, открывает
// дочерний чат и у чата без предложений её нет.
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

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), '1code-fork-proposal-anchor-ui-')))
acquireWindowLock()

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  await win.loadURL('data:text/html,<div id="chat"></div><div id="other"></div><div id="bare"></div>')
  win.webContents.on('console-message', (_event, level, message) => console.error('PAGE[' + level + ']: ' + message))
  const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/' + name), 'utf8')
  const scripts = ['chat-forks.js', 'fork-proposal.js', 'fork-proposal-store.js', 'fork-proposal-context.js', 'fork-proposal-restore.js']
    .map(read).join('\n;\n')
  await win.webContents.executeJavaScript(scripts)
  const result = await win.webContents.executeJavaScript(`(async () => {
    try {
    let checks = 0
    const assert = (ok, label) => { checks++; if (!ok) throw Error(label) }
    const F = window.OnlyoneForkProposal
    const Store = window.OnlyoneForkProposalStore
    const Restore = window.OnlyoneForkProposalRestore
    const t = text => text
    const messages = [
      { role: 'user', content: 'First question', timestamp: 1 },
      { role: 'assistant', content: 'First answer', timestamp: 2 }
    ]
    const source = { id: 'parent', title: 'Parent chat', messages }
    const render = (target, count) => {
      target.innerHTML = ''
      for (let index = 0; index < count; index++) {
        const node = document.createElement('div')
        node.dataset.forkMessageIndex = String(index)
        node.textContent = 'Message ' + index
        target.appendChild(node)
      }
    }

    // --- живая доставка: карточка сразу после сообщения-границы ---------------
    const list = document.getElementById('chat')
    render(list, 2)
    const pending = F.normalize({ title: 'Parser task', goal: 'Fix parser', reason: '',
      context: { mode: 'messages', end: 0 } }, { parentChatId: 'parent', messages, now: 5 })
    Store.put(source, pending, { now: 5 })
    const card = F.mountCard(list, pending, { t, parentTitle: source.title, onAccept: () => {}, onReject: () => {} })
    assert(card.previousElementSibling?.dataset.forkMessageIndex === '0', 'card lands right after the boundary message')
    assert(list.lastElementChild !== card, 'card is not left at the end of the feed')
    assert(F.mountCard(list, pending, { t, parentTitle: source.title }) === card, 'repeat event returns the same card')

    // --- перерисовка: те же узлы возвращаются к границе, без дублей -----------
    render(list, 3)
    assert(list.querySelectorAll('.fork-proposal-card').length === 0, 'redraw cleared the feed')
    F.placeCard(list, card)
    F.placeCard(list, card)
    assert(list.querySelectorAll('.fork-proposal-card').length === 1, 'redraw does not duplicate the card')
    assert(card.previousElementSibling?.dataset.forkMessageIndex === '0', 'redraw puts the card back after its message')

    // --- восстановление из описи идёт тем же помощником ----------------------
    const other = document.getElementById('other')
    render(other, 2)
    const cache = new Map()
    const first = Restore.ensure({ source, conversations: [source], container: other, cache, t, parentTitle: source.title, handlers: {} })
    assert(first.ok && first.mounted === 1, 'restore mounts the pending card once')
    const restored = other.querySelector('.fork-proposal-card')
    assert(restored?.previousElementSibling?.dataset.forkMessageIndex === '0', 'restored card lands after the boundary message')
    const second = Restore.ensure({ source, conversations: [source], container: other, cache, t, parentTitle: source.title, handlers: {} })
    assert(second.mounted === 0 && second.skipped === 1, 'second restore does not duplicate the card or its handlers')
    assert(other.querySelectorAll('.fork-proposal-card').length === 1, 'one restored card only')

    // --- выжимка без границы остаётся в конце ленты --------------------------
    const bare = document.getElementById('bare')
    render(bare, 2)
    const digest = F.normalize({ title: 'Digest task', goal: 'Continue', context: { mode: 'summary', summary: 'Short.' } },
      { parentChatId: 'parent', messages, now: 6 })
    const digestCard = F.mountCard(bare, digest, { t, parentTitle: source.title, onAccept: () => {}, onReject: () => {} })
    assert(bare.lastElementChild === digestCard, 'a proposal without a boundary stays at the end of the feed')

    // --- сводка: счётчики и открытие созданного чата -------------------------
    Store.setStatus(source, pending.operationId, 'accepted', { childChatId: 'child-1', now: 7 })
    const later = F.normalize({ title: 'Later task', goal: 'Next area', reason: '',
      context: { mode: 'messages', end: 1 } }, { parentChatId: 'parent', messages, now: 8 })
    Store.put(source, later, { now: 8 })
    const conversations = [source, { id: 'child-1', title: 'Child one', fork: { parentChatId: 'parent', proposalOperationId: pending.operationId } }]
    const summary = F.summaryOf(source, conversations, Store)
    assert(summary.ok && summary.pending === 1 && summary.created === 1, 'summary counts pending and created')
    assert(summary.rows.length === 1 && summary.rows[0].chatId === 'child-1', 'summary lists the accepted child only')

    let opened = null
    const summaryCard = F.mountSummary(list, summary, { t, onOpenChild: record => { opened = record.chatId } })
    assert(summaryCard.textContent.includes('Связанные задачи · 2'), 'summary names the total')
    assert(summaryCard.textContent.includes('Предложено: 1'), 'summary counts proposed')
    assert(summaryCard.textContent.includes('Создано: 1'), 'summary counts created')
    assert(!summaryCard.textContent.includes('Later task'), 'pending proposals are not repeated inside the summary')
    const row = summaryCard.querySelector('[data-action="open-child"]')
    assert(row && row.textContent === 'Child one', 'one row per accepted child with its title')
    row.click()
    assert(opened === 'child-1', 'the row opens the accepted child chat')

    render(list, 2)
    F.placeCard(list, card)
    F.placeCard(list, summaryCard)
    F.placeCard(list, summaryCard)
    assert(list.querySelectorAll('[data-fork-proposal-summary]').length === 1, 'redraw does not duplicate the summary')
    assert(list.lastElementChild === summaryCard, 'the summary lives at the end of the feed')

    // --- чат без предложений: сводки нет -------------------------------------
    const empty = { id: 'empty', title: 'Empty chat', messages: [] }
    const nothing = F.summaryOf(empty, conversations, Store)
    assert(nothing.ok && nothing.pending === 0 && nothing.created === 0, 'a chat without proposals has zero counts')
    render(bare, 1)
    assert(bare.querySelectorAll('[data-fork-proposal-summary]').length === 0, 'a chat without proposals shows no summary')

    return { ok: true, checks }
    } catch (error) { return { ok: false, error: String(error?.message || error), stack: String(error?.stack || '') } }
  })()`)
  if (!result?.ok) throw new Error(result?.error + '\n' + result?.stack)
  console.log(JSON.stringify(result))
  win.destroy()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
