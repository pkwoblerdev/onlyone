'use strict'
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { electronBinary, guiEnv, runDir, acquireWindowLock } = require('./app-launch.cjs')
const history = require('./history-store.cjs')
const root = path.join(__dirname, '..'), dir = runDir('onlyone-chat-forks'), profile = path.join(dir, 'profile')
fs.mkdirSync(profile, { recursive: true })
acquireWindowLock()
const seed = [{ id: 'fork-parent', title: 'Fork parent', messages: [
  { role: 'user', content: 'Fork first question', timestamp: 1 },
  { role: 'assistant', content: 'Fork first answer', timestamp: 2, undoId: 'do-not-inherit' },
  { role: 'user', content: 'Do not copy this later message', timestamp: 3 }
], createdAt: 1, updatedAt: 1 }]
async function phase (name, body) {
  const script = path.join(dir, name + '.js'), out = path.join(dir, name + '.json')
  fs.writeFileSync(script, `(async () => {
    const wait = ms => new Promise(r => setTimeout(r,ms))
    const check = (pass, name) => { if (!pass) throw Error(name) }
    const until = async fn => { const end=Date.now()+12000; while(Date.now()<end){if(await fn())return;await wait(80)};throw Error('wait: '+fn) }
    await until(() => document.documentElement.dataset.appReady === '1')
    ${body}
    return {ok:true,checks:[]}
  })()`)
  const proc = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: path.join(dir, name + '.png') }) })
  let tail = ''
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', data => { tail = (tail + data).slice(-4000) })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
      else proc.kill('SIGKILL')
    }, 90000)
    proc.once('error', error => { clearTimeout(timer); reject(error) })
    proc.once('close', exit => { clearTimeout(timer); resolve(exit) })
  })
  assert.equal(code, 0, name + ': ' + tail)
  assert.equal(JSON.parse(fs.readFileSync(out)).ok, true, name)
  console.log('PASS: ' + name)
}
;(async () => {
  await phase('seed', `await window.electronAPI.setConversations(${JSON.stringify(seed)}); await wait(1000)`)
  await phase('create', `
    await until(() => document.querySelector('[data-chat-id="fork-parent"] .history-item-title'))
    document.querySelector('[data-chat-id="fork-parent"] .history-item-title').click()
    await until(() => document.querySelector('[data-fork-message-index="1"]'))
    const openMenu = () => {
      document.querySelector('[data-fork-message-index="1"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:250}))
      const menu = [...document.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('форк'))
      check(menu, 'message context menu'); menu.click()
    }
    openMenu()
    await until(() => document.querySelector('dialog.chat-fork-preview[open]'))
    const preview = document.querySelector('dialog.chat-fork-preview')
    const text = preview.textContent
    check(text.includes('Предпросмотр форка'), 'preview is titled')
    check(text.includes('Fork parent'), 'preview shows the new session name')
    check(text.includes('Сообщение 2 / 3'), 'preview shows the branch point')
    check(text.includes('Переносится') && text.includes('Сообщений с текстом: 2'), 'preview says what is copied')
    check(text.includes('Не переносится') && text.includes('модель не запускается'), 'preview says what is not copied')
    check(document.activeElement === preview.querySelector('[data-action="confirm"]'), 'confirm holds focus')
    preview.querySelector('[data-action="cancel"]').click()
    await until(() => !document.querySelector('.chat-fork-preview'))
    await wait(150)
    check((await window.electronAPI.getConversations()).length === 1, 'cancel creates nothing')
    openMenu()
    await until(() => document.querySelector('dialog.chat-fork-preview[open]'))
    const confirm = document.querySelector('dialog.chat-fork-preview [data-action="confirm"]')
    confirm.click(); confirm.click()
    await until(() => !document.querySelector('.chat-fork-preview'))
    await until(async () => (await window.electronAPI.getConversations()).some(c => c.fork))
    let chats=await window.electronAPI.getConversations(), child=chats.find(c=>c.fork)
    check(chats.filter(c=>c.fork).length===1, 'double click creates once')
    check(child.title==='Fork parent', 'name inherited without a separate form')
    check(child.messages.length===2 && !child.messages[1].undoId, 'selected text-only boundary')
    check(child.fork.parentChatId==='fork-parent', 'parent recorded')
    check(chats.find(c=>c.id==='fork-parent').messages.length===3, 'parent intact')
    await until(() => document.getElementById('messagesList').dataset.chatId===child.id)
    document.querySelector('[data-chat-id="'+child.id+'"].history-item').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:200}))
    const parentButton=[...document.querySelectorAll('.ctx-item')].find(b=>b.textContent.includes('родительскому'))
    check(parentButton, 'parent navigation'); parentButton.click()
    await until(() => document.getElementById('messagesList').dataset.chatId==='fork-parent')
    const button=document.getElementById('chatForkBtn');check(button&&!button.hidden, 'separate fork button')
    button.click();button.click()
    await until(() => document.querySelector('dialog.chat-fork-preview[open]'))
    check(document.querySelectorAll('dialog.chat-fork-preview').length===1, 'toolbar double click opens one preview')
    check(document.querySelector('dialog.chat-fork-preview').textContent.includes('Сообщение 3 / 3'),'toolbar keeps the last message as the branch point')
    document.querySelector('dialog.chat-fork-preview [data-action="confirm"]').click()
    await until(async () => (await window.electronAPI.getConversations()).filter(c=>c.fork).length===2)
    chats=await window.electronAPI.getConversations()
    check(chats.filter(c=>c.fork).length===2, 'toolbar fork created once after confirmation')
    check(chats.some(c=>c.fork?.sourceMessageIndex===2&&c.messages.length===3),'toolbar copies current text')
    const second=chats.find(c=>c.fork?.sourceMessageIndex===2)
    await until(() => document.getElementById('messagesList').dataset.chatId===second.id)
    check(!document.querySelector('dialog[open]'),'preview is closed after creation')
    await until(() => document.getElementById('toastNotification')?.textContent.includes('Форк создан.'))
  `)
  await phase('restart', `
    const chats=await window.electronAPI.getConversations(), children=chats.filter(c=>c.fork)
    check(children.length===2 && children.every(c=>c.fork.parentChatId==='fork-parent'), 'links survive restart')
    check(children.some(c=>c.messages.length===2)&&children.some(c=>c.messages.length===3),'boundaries survive restart')
    check(chats.find(c=>c.id==='fork-parent').messages.length===3, 'parent survives restart')
    document.querySelector('[data-chat-id="'+children[0].id+'"] .history-item-title').click()
    await until(() => document.getElementById('messagesList').dataset.chatId===children[0].id)
    check(!document.querySelector('dialog[open]'),'no dialog after restart')
  `)
  assert.ok(history.historyPresent(profile), 'history store exists on disk')
  assert.equal(history.plaintextInData(profile, 'Fork first question'), null, 'history is encrypted on disk')
  for (const lang of ['ru', 'en']) for (const theme of ['dark', 'light']) {
    await phase('view-' + lang + '-' + theme, `
      const chats=await window.electronAPI.getConversations(), child=chats.find(c=>c.fork)
      document.querySelector('[data-chat-id="'+child.id+'"] .history-item-title').click()
      const language=document.getElementById('languageSelect'); language.value=${JSON.stringify(lang)}; language.dispatchEvent(new Event('change',{bubbles:true}))
      const theme=document.getElementById('personalTheme'); theme.value=${JSON.stringify(theme)}; theme.dispatchEvent(new Event('change',{bubbles:true}))
      const label=${JSON.stringify(lang === 'en' ? 'Fork chat' : 'Создать форк чата')}
      await until(() => document.getElementById('chatForkBtn')?.getAttribute('aria-label')===label)
      await until(() => document.documentElement.dataset.theme===${JSON.stringify(theme)})
      const button=document.getElementById('chatForkBtn'), rect=button.getBoundingClientRect()
      check(rect.width>=24&&rect.left>=0&&rect.right<=innerWidth,'fork button visible inside window')
      button.focus(); check(document.activeElement===button,'fork button accepts keyboard focus')
      check(!document.querySelector('.chat-fork-dialog'),'no fork form')
      await wait(350)
    `)
  }
  await phase('delete-parent', `
    const chats=await window.electronAPI.getConversations()
    await window.electronAPI.setConversations(chats.filter(c=>c.id!=='fork-parent'))
  `)
  await phase('orphan', `
    const chats=await window.electronAPI.getConversations(), child=chats.find(c=>c.fork)
    check(chats.length===2&&child.messages.length>0,'deleting parent preserves children and context')
    const row=document.querySelector('[data-chat-id="'+child.id+'"].history-item')
    row.querySelector('.history-item-title').click()
    row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:200}))
    const link=[...document.querySelectorAll('.ctx-item')].find(b=>/Parent chat is unavailable|Родительский чат недоступен/.test(b.textContent))
    check(link?.disabled,'unavailable parent is explained and cannot be opened')
  `)
  console.log('PASS: direct fork button and context menu, preview before creation, cancel, inherited name, double-click guard, parent link, encrypted persistence and restart; evidence ' + dir)
})().catch(error => { console.error(error); process.exitCode = 1 })
