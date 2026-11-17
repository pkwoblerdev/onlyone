'use strict'
// Изолированное окно (без запуска приложения): правка ожидающего предложения
// связанного чата на карточке. Проверяются открытие полей, сохранение через
// обработчик, отмена, ошибка сохранения, выключение на время работы и запрет
// правки принятого предложения. Текст модели остаётся текстом (в поле), не
// разметкой.
//
// Под node (в общем прогоне) файл перезапускает себя настоящим Electron.
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

app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), '1code-fork-proposal-edit-ui-')))
acquireWindowLock()

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  await win.loadURL('data:text/html,<div id="chat"></div><div id="other"></div><div id="third"></div>')
  win.webContents.on('console-message', (_event, level, message) => console.error('PAGE[' + level + ']: ' + message))
  const proposal = fs.readFileSync(path.join(__dirname, '../src/renderer/fork-proposal.js'), 'utf8')
  await win.webContents.executeJavaScript(proposal)
  const result = await win.webContents.executeJavaScript(`(async () => {
    try {
    let checks = 0
    const assert = (ok, label) => { checks++; if (!ok) throw Error(label) }
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    const mount = window.OnlyoneForkProposal.mountCard
    const base = {
      version: 1,
      operationId: 'fp_1a2b3c4d',
      parentChatId: 'parent',
      title: 'Parser subtask',
      goal: 'Fix the parser',
      reason: 'Separate area',
      context: { mode: 'messages', end: 1, revision: 'h:12345678', summary: '' },
      createdAt: 100,
      updatedAt: 100,
      status: 'pending',
      childChatId: null,
      decidedAt: null
    }
    const calls = []
    let answer = { saved: true, record: { ...base, title: 'Parser and lexer' } }
    const card = mount(document.getElementById('chat'), base, {
      t: text => text,
      parentTitle: 'Parent chat',
      onEdit: async item => { calls.push(item); return answer },
      onAccept: async () => ({ saved: true, chat: { id: 'child-1' } }),
      onReject: async () => ({ saved: true })
    })
    const edit = card.querySelector('[data-action="edit"]')
    const save = card.querySelector('[data-action="save-edit"]')
    const cancel = card.querySelector('[data-action="cancel-edit"]')
    const titleField = card.querySelector('.fork-proposal-input-title')
    const goalField = card.querySelector('.fork-proposal-goal-input')
    const endField = card.querySelector('.fork-proposal-input-end')
    assert(edit && !edit.hidden, 'pending card offers edit')
    assert(edit.textContent === 'Изменить', 'edit label')
    assert(card.querySelector('.fork-proposal-edit').hidden, 'form starts closed')
    edit.click()
    assert(!card.querySelector('.fork-proposal-edit').hidden, 'form opens inline')
    assert(edit.hidden, 'toggle hides while editing')
    assert(titleField.value === 'Parser subtask', 'title prefilled')
    assert(goalField.value === 'Fix the parser', 'goal prefilled')
    assert(endField.value === '2', 'boundary is one-based in the input')
    titleField.value = 'Parser and lexer'
    save.click()
    await wait(30)
    assert(calls.length === 1, 'save calls onEdit once')
    assert(calls[0].operationId === 'fp_1a2b3c4d', 'id survives the edit')
    assert(calls[0].context.end === 1, 'boundary is zero-based in the record')
    assert(card.querySelector('.fork-proposal-title').textContent === 'Parser and lexer', 'new title shown in place')
    assert(card.querySelector('.fork-proposal-status').textContent === 'Изменения сохранены.', 'saved status')
    assert(card.querySelector('.fork-proposal-edit').hidden, 'form closes on success')

    edit.click()
    titleField.value = 'Discarded'
    cancel.click()
    assert(card.querySelector('.fork-proposal-title').textContent === 'Parser and lexer', 'cancel keeps the saved text')
    assert(calls.length === 1, 'cancel saves nothing')

    answer = { saved: false }
    edit.click()
    titleField.value = 'Not saved'
    save.click()
    await wait(30)
    assert(card.querySelector('.fork-proposal-title').textContent === 'Parser and lexer', 'a failed save is not shown as success')
    assert(card.querySelector('.fork-proposal-status').textContent === 'Не удалось сохранить изменения.', 'failure line')
    assert(!card.querySelector('.fork-proposal-edit').hidden, 'form stays open for a retry')

    let release
    const gate = new Promise(resolve => { release = resolve })
    const slow = mount(document.getElementById('other'), { ...base, operationId: 'fp_1a2b3c4e' }, {
      t: text => text,
      parentTitle: 'Parent chat',
      onEdit: async item => { await gate; return { saved: true, record: { ...item } } }
    })
    slow.querySelector('[data-action="edit"]').click()
    slow.querySelector('[data-action="save-edit"]').click()
    await wait(20)
    assert(slow.querySelector('[data-action="save-edit"]').disabled, 'save disabled while busy')
    assert(slow.querySelector('[data-action="accept"]').disabled, 'accept disabled while busy')
    assert(slow.querySelector('.fork-proposal-input-title').disabled, 'fields disabled while busy')
    release()
    await wait(30)
    assert(!slow.querySelector('[data-action="save-edit"]').disabled, 'form unlocks after saving')

    const accepted = mount(document.getElementById('third'), { ...base, operationId: 'fp_1a2b3c4f', status: 'accepted' }, {
      t: text => text,
      parentTitle: 'Parent chat',
      status: 'accepted',
      onOpenChild: () => {},
      onEdit: async () => ({ saved: true })
    })
    assert(accepted.querySelector('[data-action="edit"]').hidden, 'an accepted proposal cannot be edited')

    const unsafe = { ...base, operationId: 'fp_1a2b3c50', title: '<img src=x onerror="window.pwned=1">' }
    const unsafeCard = mount(document.getElementById('third'), unsafe, { t: text => text, parentTitle: 'Parent chat', onEdit: async () => ({ saved: true }) })
    assert(!unsafeCard.querySelector('img'), 'model markup is not parsed')
    assert(!window.pwned, 'no script execution')
    unsafeCard.querySelector('[data-action="edit"]').click()
    assert(unsafeCard.querySelector('.fork-proposal-input-title').value === unsafe.title, 'model text stays a field value')
    return { ok: true, checks }
    } catch (error) { return { ok: false, error: String(error?.message || error), stack: String(error?.stack || '') } }
  })()`)
  if (!result?.ok) throw new Error(result?.error + '\n' + result?.stack)
  console.log(JSON.stringify(result))
  win.destroy()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
