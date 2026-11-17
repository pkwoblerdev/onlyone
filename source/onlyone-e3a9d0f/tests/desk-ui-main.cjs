'use strict'
// Offline fixture: production Desk window, isolated profile, no network or provider.
const { app, BrowserWindow, ipcMain, session, protocol, safeStorage, webContents } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createDeskService } = require('../src/main/desk-service.cjs')
const { createDeskProcessManager } = require('../src/main/desk-process.cjs')
// Match the application's existing Chromium configuration in this standalone fixture.
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,CalculateNativeWinOcclusion')
protocol.registerSchemesAsPrivileged([{ scheme: 'onecode-artifact', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])
const output = process.env.ONECODE_DESK_RESULT
app.on('window-all-closed', () => {})
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until (predicate) {
  for (let attempt = 0; attempt < 400; attempt++) { if (await predicate()) return; await wait(50) }
  throw Error('Desk did not reach expected state')
}
app.whenReady().then(async () => {
  const errors = []
  const site = require('node:http').createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<button id="count" onclick="this.textContent=Number(this.textContent)+1">0</button><input id="field"><input type="password" id="secret" value="PRIVATE_PASSWORD">')
  })
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
  site.unref()
  const siteUrl = 'http://127.0.0.1:' + site.address().port + '/'
  require('../src/main/panel-browser').install({ app, session })
  session.fromPartition('persist:onlyone-browser').webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (details, done) => done({ cancel: !details.url.startsWith(siteUrl) }))
  const fixtureBytes = Buffer.from('<!doctype html><title>Fixture tool</title><p>Local tool</p><script>const probe = () => parent.postMessage({ fixture: true, node: typeof require, desk: typeof deskAPI }, "*"); window.addEventListener("message", probe); probe()</script>')
  protocol.handle('onecode-artifact', async request => {
    const portable = service.serve(request)
    if (portable) return portable
    return new Response(fixtureBytes, { headers: { 'content-type': 'text/html', 'content-length': String(fixtureBytes.length), 'access-control-allow-origin': '*' } })
  })
  assert.equal(safeStorage.isEncryptionAvailable(), true)
  const configurationLib = require('../src/main/agent-run-context')
  const configurationRun = configurationLib.createRunContext({ durationMs: 1000 })
  configurationRun.recordConfiguration({ model: 'fixture/model', agentIndex: 0, systemPrompt: 'PRIVATE fixture instruction' })
  configurationRun.finish('failed')
  const configurationOptions = { dir: path.join(app.getPath('userData'), 'configuration-fixture'),
    encode: text => ({ enc: 'safeStorage', data: safeStorage.encryptString(text).toString('base64') }),
    decode: envelope => JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, 'base64'))) }
  const configurationStore = require('../src/main/bulk-store').create(configurationOptions)
  configurationLib.saveConfigurationRecord(configurationRun.snapshot(), {
    read: () => configurationStore.get('runConfigurations', []), write: records => configurationStore.set('runConfigurations', records)
  })
  await configurationStore.flush()
  assert.equal(fs.readFileSync(configurationStore.fileOf('runConfigurations'), 'utf8').includes('fixture/model'), false)
  const configurationRestored = require('../src/main/bulk-store').create(configurationOptions).get('runConfigurations', [])
  assert.equal(configurationRestored[0].configurations[0].model, 'fixture/model')
  assert.equal(JSON.stringify(configurationRestored).includes('PRIVATE'), false)
  const storage = require('../src/main/desk-store.cjs').createDeskStore({ dir: path.join(app.getPath('userData'), 'desks'),
    protect: text => safeStorage.encryptString(text).toString('base64'), unprotect: body => safeStorage.decryptString(Buffer.from(body, 'base64')) })
  const appearance = { language: 'en', theme: 'light' }
  const watchRoot = path.join(app.getPath('userData'), 'watch-fixture')
  const nestedWatchRoot = path.join(watchRoot, 'nested')
  const watchedFile = path.join(nestedWatchRoot, 'observed.txt')
  fs.mkdirSync(nestedWatchRoot, { recursive: true })
  const processChildren = []
  let templateClipboard = ''
  const processManager = createDeskProcessManager({ platform: 'win32',
    spawnProcess: (command, args, options) => {
      const child = new EventEmitter()
      child.pid = 4242
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      processChildren.push({ command, args, options, child })
      queueMicrotask(() => { child.emit('spawn'); child.stdout.emit('data', Buffer.from('server ready')) })
      return child
    },
    killProcessTree: (pid, callback) => { assert.equal(pid, 4242); callback(true); queueMicrotask(() => processChildren.at(-1).child.emit('close', 0, null)) }
  })
  const budgetCalls = []
  const budgetCore = require('../src/main/task-budget.cjs').createTaskBudget({
    limits: { requests: 10, tokens: 1000 }, deadlineAt: Date.now() + 8 * 60 * 1000, now: () => Date.now()
  })
  budgetCore.reserve({ id: 'budget-a', requests: 1, tokens: 100 })
  budgetCore.settle({ id: 'budget-a', usage: { total_tokens: 250 } })
  budgetCore.reserve({ id: 'budget-b', requests: 1, tokens: 100 })
  budgetCore.reserve({ id: 'budget-c', requests: 1, tokens: 100 })
  budgetCore.settle({ id: 'budget-c', usage: null, outcome: 'failed' })
  const budgetForChat = { snapshot: budgetCore.snapshot(), settings: { requests: 10, tokens: 1000, deadlineMinutes: 8 },
    refusal: { ok: false, reason: 'unknown_usage', dimension: 'unknown',
      message: 'Есть запросы с неизвестным расходом' } }
  let budgetFixture = budgetForChat
  const service = createDeskService({ BrowserWindow, ipcMain, storage, isMainWindow: () => false, focusMain () {},
    lookupGuest: id => webContents.fromId(id), confirmPortable: async () => true,
    // Панель обязана показывать бюджет именно этого чата, а не соседнего.
    budgetState: chatId => { budgetCalls.push(chatId); return budgetFixture },
    packageResource: async block => ({ type: block.kind === 'artifact' ? 'page' : 'text', content: block.kind === 'artifact' ? '<h1 id="portable">Portable tool</h1><script>document.body.dataset.running="yes"</script>' : 'Portable output' }),
    writeClipboard: text => { templateClipboard = text },
    createProcessManager: () => processManager,
    settings: () => ({ ...appearance }),
    watchDirectory: async (relativePath, options = {}) => {
      return { displayPath: relativePath, recursive: options.recursive === true,
        watcher: fs.watch(watchRoot, { persistent: false, recursive: options.recursive === true }) }
    },
    resolveResource: async block => block.kind === 'browser' ? { type: 'browser', url: siteUrl }
      : block.kind === 'artifact' ? { type: 'page', url: 'onecode-artifact://fixture/page.html' } : { type: 'text', text: block.resourceRef === 'fixture:updated' ? 'Updated local result' : 'Local result' } })
  service.open('fixture-chat')
  const win = BrowserWindow.getAllWindows()[0]
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  const js = code => win.webContents.executeJavaScript(code)
  await until(async () => js("typeof window.deskAPI === 'object' && document.getElementById('desk-empty-title').textContent === 'Your workspace will gather here'"))
  assert.equal(await js("[...document.querySelectorAll('input,textarea')].every(node => node.closest('#desk-transfer-dialog')) && !document.querySelector('#desk-transfer-dialog').open"), true)
  assert.equal(await js("typeof window.require"), 'undefined')
  assert.equal(await js("document.documentElement.dataset.theme"), 'light')
  await js("window.addEventListener('message', event => { if (event.data?.fixture) window.fixtureProbe = event.data })")
  const operations = ['browser','artifact','output'].map((kind,index) => ({ type: 'add', block: {
    kind, title: kind, resourceRef: 'fixture:'+kind, rect: { x: 16+index*300, y: 16, width: 280, height: 300, z: index }
  } }))
  assert.equal((await service.apply('fixture-chat', { operationId: 'first', expectedRevision: 0, operations }, 'agent:fixture')).ok, true)
  await until(async () => js("document.querySelectorAll('.ublock').length === 3 && document.querySelector('.desk-body pre')?.textContent === 'Local result'"))
  // Element insertion is earlier than cross-origin document execution on the test host.
  await until(async () => js("(() => { try { return document.querySelector('webview').getWebContentsId() > 0 && Boolean(window.fixtureProbe) } catch { return false } })()"))
  assert.equal(await js('window.fixtureProbe.node'), 'undefined')
  assert.equal(await js('window.fixtureProbe.desk'), 'undefined')
  const browserBlock = (await service.read('fixture-chat')).snapshot.blocks.find(block => block.kind === 'browser')
  const interact = input => service.interact('fixture-chat', { block_id: browserBlock.id, expected_revision: 1, ...input })
  await until(async () => (await interact({ interaction: 'observe' })).ok)
  const observed = await interact({ interaction: 'observe' })
  assert(!JSON.stringify(observed).includes('PRIVATE_PASSWORD'))
  assert(observed.elements.some(element => element.tag === 'button'))
  assert.equal((await interact({ interaction: 'fill', selector: '#field', value: 'Desk input' })).ok, true)
  assert.equal((await interact({ interaction: 'fill', selector: '#secret', value: 'forbidden' })).code, 'unavailable-target')
  assert.equal((await interact({ interaction: 'click', selector: '#count' })).ok, true)
  assert.equal(await js("document.querySelector('webview').executeJavaScript('document.getElementById(\"count\").textContent')"), '1')
  assert.equal(await js("document.querySelector('webview').executeJavaScript('document.getElementById(\"field\").value')"), 'Desk input')
  const artifactBlock = (await service.read('fixture-chat')).snapshot.blocks.find(block => block.kind === 'artifact')
  assert.equal((await service.interact('fixture-chat', { block_id: artifactBlock.id, expected_revision: 1, interaction: 'observe' })).ok, true)
  let screenshot
  await until(async () => { screenshot = await service.capture('fixture-chat', 1); return screenshot.ok })
  assert.equal(screenshot.ok, true)
  assert(screenshot.png.length > 100)
  const watch = await service.watch('fixture-chat', 'start', { path: 'fixture', recursive: true })
  assert.equal(watch.ok, true)
  fs.writeFileSync(watchedFile, 'local test event')
  await until(async () => service.events('fixture-chat', 0).events.some(event => event.type === 'file' && String(event.name).includes('observed.txt')))
  await until(async () => js("document.getElementById('desk-watch-count').textContent === '1'"))
  await js("document.getElementById('desk-watch-toggle').click()")
  await until(async () => js("document.querySelector('.desk-watch-path')?.textContent === 'fixture'"))
  assert.equal(await js("document.querySelector('.desk-watch-scope').textContent"), 'with subfolders')
  await until(async () => js("document.getElementById('desk-watch-recent').textContent.includes('observed.txt')"))
  assert.equal((await service.watch('fixture-chat', 'start', { path: 'fixture/nested' })).ok, true)
  await until(async () => js("document.getElementById('desk-watch-count').textContent === '2' && !document.getElementById('desk-watch-stop-all').hidden"))
  await js("document.querySelector('.desk-watch-stop').click()")
  await until(async () => js("document.getElementById('desk-watch-count').textContent === '1'"))
  await js("document.getElementById('desk-watch-stop-all').click()")
  await until(async () => js("document.getElementById('desk-watch-count').textContent === '0'"))
  assert.equal((await service.watch('fixture-chat', 'list')).watches.length, 0)
  await js("document.getElementById('desk-budget-toggle').click()")
  await until(async () => js("!document.getElementById('desk-budget-panel').hidden && document.getElementById('desk-budget-body').textContent.length > 0"))
  const budgetTitle = await js("document.getElementById('desk-budget-title').textContent")
  assert.ok(['Бюджет задачи', 'Task budget'].includes(budgetTitle), budgetTitle)
  const budgetBody = await js("document.getElementById('desk-budget-body').innerText")
  assert.match(budgetBody, /Unknown usage/, budgetBody)
  assert.match(budgetBody, /requests with unknown token usage/, budgetBody)
  assert.match(budgetBody, /Stopped: requests with unknown usage/, budgetBody)
  assert.match(budgetBody, /Current limits/, budgetBody)
  assert.match(budgetBody, /8 min/, budgetBody)
  assert.ok(budgetCalls.length > 0 && budgetCalls.every(id => id === 'fixture-chat'),
    'бюджет запрошен для чужого чата: ' + budgetCalls.join(','))
  // Нет сохранённых пределов — защита выключена: панель так и говорит, а не рисует нули.
  budgetFixture = null
  await js("document.getElementById('desk-budget-close').click()")
  await until(async () => js("document.getElementById('desk-budget-panel').hidden"))
  await js("document.getElementById('desk-budget-toggle').click()")
  await until(async () => js("!document.getElementById('desk-budget-panel').hidden && document.getElementById('desk-budget-body').textContent.length > 0"))
  const emptyBudget = await js("document.getElementById('desk-budget-body').innerText")
  assert.match(emptyBudget, /No task is running: there is no budget yet/, emptyBudget)
  assert.match(emptyBudget, /Current limits/, emptyBudget)
  await js("document.getElementById('desk-budget-close').click()")
  await until(async () => js("document.getElementById('desk-budget-panel').hidden"))
  const processStarted = await service.processes('fixture-chat', 'start', { command: 'fixture-server.exe', args: ['--serve'], cwd: watchRoot, env: {} })
  assert.equal(processStarted.ok, true)
  await until(async () => js("document.querySelector('.desk-process-command')?.textContent === 'fixture-server.exe --serve' && document.querySelector('.desk-process-output')?.textContent.includes('server ready')"))
  await js("document.querySelector('.desk-process-stop').click()")
  await until(async () => js("document.querySelector('.desk-process-state')?.textContent === 'Stopped'"))
  await until(async () => Object.values((await service.read('fixture-chat')).runtime).every(value => value.state === 'ready'))
  assert.equal(await js("document.querySelectorAll('.desk-block-status').length"), 3)
  const first = (await service.read('fixture-chat')).snapshot.blocks[0]
  await js("window.fixtureNode = document.querySelector('.ublock'); window.fixtureBody = document.querySelector('webview')")
  assert.equal((await service.apply('fixture-chat', { operationId: 'layout', expectedRevision: 1, operations: [{ type: 'geometry', id: first.id,
    rect: { ...first.rect, x: 32 } }] }, 'agent:fixture')).ok, true)
  await until(async () => js("document.querySelector('.ublock').style.left === '32px'"))
  assert.equal(await js("window.fixtureNode === document.querySelector('.ublock') && window.fixtureBody === document.querySelector('webview')"), true)
  await js("document.querySelector('.ublock-head').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))")
  await until(async () => (await service.read('fixture-chat')).snapshot.blocks[0].rect.x === 40)
  const held = await js(`window.deskAPI.hold(${JSON.stringify(first.id)})`)
  assert.equal(held.ok, true)
  assert.equal((await service.apply('fixture-chat', { operationId: 'blocked', expectedRevision: 3, operations: [{ type: 'remove', id: first.id }] }, 'agent:fixture')).code, 'busy')
  await js('window.deskAPI.release()')
  const outputBlock = (await service.read('fixture-chat')).snapshot.blocks[2]
  const updated = await service.apply('fixture-chat', { operationId: 'resource', expectedRevision: 3,
    operations: [{ type: 'resource', id: outputBlock.id, resourceRef: 'fixture:updated' }] }, 'agent:fixture')
  assert.equal(updated.ok, true)
  await until(async () => js("document.querySelector('.desk-body pre')?.textContent === 'Updated local result'"))
  assert.equal(await js("window.fixtureBody === document.querySelector('webview')"), true)
  assert.deepEqual(updated.snapshot.blocks[2].rect, outputBlock.rect)
  assert.equal(service.events('fixture-chat', 0).events.some(event => event.type === 'changed' && event.actor === 'human' && event.id === first.id), true)
  win.destroy()
  service.open('fixture-chat')
  let reopened = BrowserWindow.getAllWindows()[0]
  await until(async () => reopened.webContents.executeJavaScript("document.querySelectorAll('.ublock').length === 3"))
  assert.equal((await service.read('fixture-chat')).snapshot.revision, 4)
  await reopened.webContents.executeJavaScript("window.addEventListener('message', event => { if (event.data?.fixture) window.fixtureProbe = event.data })")
  await until(async () => reopened.webContents.executeJavaScript("document.querySelector('iframe').contentWindow.postMessage('probe', '*'); Boolean(window.fixtureProbe)"))
  assert.deepEqual(storage.load('fixture-chat'), (await service.read('fixture-chat')).snapshot)
  const processAfterReopen = await service.processes('fixture-chat', 'start', { command: 'fixture-server.exe', args: ['--again'], cwd: watchRoot, env: {} })
  assert.equal(processAfterReopen.ok, true)
  await reopened.webContents.executeJavaScript("document.getElementById('desk-watch-toggle').click()")
  await until(async () => reopened.webContents.executeJavaScript("[...document.querySelectorAll('.desk-process-item')].some(row => row.textContent.includes('--again'))"))
  await reopened.webContents.executeJavaScript("[...document.querySelectorAll('.desk-process-item')].find(row => row.textContent.includes('--again')).querySelector('.desk-process-stop').click()")
  await until(async () => reopened.webContents.executeJavaScript("[...document.querySelectorAll('.desk-process-item')].some(row => row.textContent.includes('--again') && row.querySelector('.desk-process-state')?.textContent === 'Stopped')"))
  const rjs = code => reopened.webContents.executeJavaScript(code)
  await rjs("document.getElementById('desk-transfer-open').click()")
  await until(async () => rjs("document.getElementById('desk-transfer-export').value.length > 0 && !document.getElementById('desk-transfer-copy').disabled"))
  const templateText = await rjs("document.getElementById('desk-transfer-export').value")
  assert.equal(templateText.includes('fixture:browser'), false)
  await rjs("document.getElementById('desk-transfer-copy').click()")
  await until(async () => templateClipboard === templateText)
  await until(async () => rjs("!document.getElementById('desk-transfer-content').disabled"))
  await rjs("document.getElementById('desk-transfer-content').click()")
  await until(async () => rjs("document.getElementById('desk-transfer-export').value.includes('onlyone-desk-package') && !document.getElementById('desk-transfer-content').disabled"))
  assert.equal(await rjs("document.getElementById('desk-transfer-help').textContent.includes('256')"), true, 'content option must update the privacy and size explanation')
  await rjs("document.getElementById('desk-transfer-content').click()")
  await until(async () => rjs(`document.getElementById('desk-transfer-export').value === ${JSON.stringify(templateText)} && !document.getElementById('desk-transfer-content').disabled`))
  await until(async () => rjs("!document.getElementById('desk-transfer-preview').disabled || !document.getElementById('desk-transfer-copy').disabled"))
  await rjs("document.getElementById('desk-transfer-input').value = '{'; document.getElementById('desk-transfer-input').dispatchEvent(new Event('input')); document.getElementById('desk-transfer-preview').click()")
  await until(async () => rjs("document.getElementById('desk-transfer-message').textContent === 'Invalid Desk template format.'"))
  assert.equal(await rjs("document.getElementById('desk-transfer-apply').disabled"), true)
  const pasteTemplate = async () => rjs(`document.getElementById('desk-transfer-input').value = ${JSON.stringify(templateText)}; document.getElementById('desk-transfer-input').dispatchEvent(new Event('input')); document.getElementById('desk-transfer-preview').click()`)
  await pasteTemplate()
  await until(async () => rjs("!document.getElementById('desk-transfer-apply').disabled && document.querySelectorAll('#desk-transfer-preview-list li').length === 3"))
  assert.equal((await service.read('fixture-chat')).snapshot.blocks.length, 3, 'preview never changes the Desk')
  await rjs("document.getElementById('desk-transfer-close').click(); document.getElementById('desk-transfer-open').click()")
  assert.equal((await service.read('fixture-chat')).snapshot.blocks.length, 3, 'cancelling never imports')
  await until(async () => rjs("document.getElementById('desk-transfer-export').value.length > 0 && !document.getElementById('desk-transfer-copy').disabled"))
  assert.equal(await rjs("document.getElementById('desk-transfer-input').value"), '')
  await pasteTemplate()
  await until(async () => rjs("!document.getElementById('desk-transfer-apply').disabled"))
  await rjs("window.originalBrowser = document.querySelector('webview'); document.getElementById('desk-transfer-apply').click(); document.getElementById('desk-transfer-apply').click()")
  await until(async () => rjs("!document.getElementById('desk-transfer-dialog').open && document.querySelectorAll('.ublock').length === 6"))
  assert.equal(await rjs("document.querySelectorAll('webview').length === 1 && document.querySelectorAll('iframe').length === 1 && document.querySelector('webview') === window.originalBrowser"), true, 'import starts no websites or artifact scripts')
  const importedView = await service.read('fixture-chat')
  assert.equal(importedView.snapshot.blocks.length, 6)
  assert.equal(importedView.snapshot.blocks.filter(block => block.resourceRef.startsWith('desk-pending:')).length, 3)
  assert.deepEqual(storage.load('fixture-chat'), importedView.snapshot, 'pending references survive actual safeStorage')
  const importedOutput = importedView.snapshot.blocks.at(-1)
  assert.equal((await service.apply('fixture-chat', { operationId: 'rebind-imported', expectedRevision: importedView.snapshot.revision,
    operations: [{ type: 'resource', id: importedOutput.id, resourceRef: 'fixture:updated' }] }, 'agent:fixture')).ok, true)
  await until(async () => rjs("document.querySelectorAll('.desk-body pre').length === 2"))
  reopened.destroy(); service.open('fixture-chat'); reopened = BrowserWindow.getAllWindows()[0]
  await until(async () => rjs("document.querySelectorAll('.ublock').length === 6 && document.querySelectorAll('.desk-body section').length === 2"))
  await rjs("window.browserBeforeLocale = document.querySelector('webview')")
  for (const language of ['ru', 'en']) {
    appearance.language = language
    service.refresh('fixture-chat')
    await until(async () => reopened.webContents.executeJavaScript(`document.documentElement.lang === '${language}' && document.getElementById('desk-watch-label').textContent === '${language === 'ru' ? 'Файлы и процессы' : 'Files and processes'}'`))
    assert.equal(await rjs("document.querySelector('.desk-body section p').textContent"), language === 'ru' ? 'Сайт пришёл без адреса страницы и без ваших входов.' : 'The site came without its page address and without your sign-ins.')
    assert.equal(await rjs("document.querySelector('webview') === window.browserBeforeLocale"), true, 'language changes must not reload live websites')
  }
  if (process.env.ONECODE_DESK_SHOTS) {
    fs.mkdirSync(process.env.ONECODE_DESK_SHOTS, { recursive: true })
    for (const language of ['ru', 'en']) for (const theme of ['dark', 'light']) {
      Object.assign(appearance, { language, theme })
      service.refresh('fixture-chat')
      await until(async () => reopened.webContents.executeJavaScript(`document.documentElement.lang === '${language}' && document.documentElement.dataset.theme === '${theme}'`))
      assert.equal(await reopened.webContents.executeJavaScript("document.getElementById('desk-watch-label').textContent"), language === 'ru' ? 'Файлы и процессы' : 'Files and processes')
      await wait(200)
      assert.equal(await reopened.webContents.executeJavaScript("document.querySelector('.ublock-title').textContent"), 'browser')
      assert.equal(await reopened.webContents.executeJavaScript("document.querySelector('.ublock-min').textContent"), language === 'ru' ? 'Свернуть' : 'Minimise')
      const shot = await reopened.webContents.capturePage()
      fs.writeFileSync(path.join(process.env.ONECODE_DESK_SHOTS, `desk-${language}-${theme}.png`), shot.toPNG())
      await rjs("document.getElementById('desk-transfer-open').click()")
      await until(async () => rjs("document.getElementById('desk-transfer-export').value.length > 0 && !document.getElementById('desk-transfer-copy').disabled"))
      assert.equal(await rjs("document.getElementById('desk-transfer-title').textContent"), language === 'ru' ? 'Обмен раскладкой' : 'Share layout')
      await rjs("document.getElementById('desk-transfer-input').value = document.getElementById('desk-transfer-export').value; document.getElementById('desk-transfer-input').dispatchEvent(new Event('input')); document.getElementById('desk-transfer-preview').click()")
      await until(async () => rjs("!document.getElementById('desk-transfer-apply').disabled && document.querySelectorAll('#desk-transfer-preview-list li').length === 6"))
      await wait(200)
      assert.equal(await rjs("(() => { const d = document.getElementById('desk-transfer-dialog'), r = d.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && d.scrollWidth <= d.clientWidth + 1 })()"), true)
      const transferShot = await reopened.webContents.capturePage()
      fs.writeFileSync(path.join(process.env.ONECODE_DESK_SHOTS, `desk-transfer-${language}-${theme}.png`), transferShot.toPNG())
      await rjs("document.getElementById('desk-transfer-close').click()")
    }
  }
  reopened.setSize(760, 600)
  await wait(200)
  await rjs("document.getElementById('desk-transfer-open').click()")
  await until(async () => rjs("document.getElementById('desk-transfer-export').value.length > 0"))
  const fitsSmall = await rjs("(() => { const d = document.getElementById('desk-transfer-dialog'), r = d.getBoundingClientRect(); return { ok: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && d.scrollWidth <= d.clientWidth + 1, box: [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight, d.scrollWidth, d.clientWidth].map(Math.round).join(',') } })()")
  assert.equal(fitsSmall.ok, true, 'transfer remains within the minimum window size: ' + fitsSmall.box)
  await rjs("document.getElementById('desk-transfer-close').click()")
  const bundle = await service.transfer('fixture-chat', 'export', { includeContent: true })
  assert.equal(bundle.ok, true)
  const packaged = JSON.parse(bundle.text)
  packaged.blocks = packaged.blocks.filter(block => block.portable).slice(0, 1)
  const previewPackage = await service.transfer('fixture-chat', 'preview', { text: JSON.stringify(packaged), viewport: { width: 800, height: 600 } })
  assert.equal(previewPackage.ok, true)
  assert.equal((await service.transfer('fixture-chat', 'import', { token: previewPackage.token })).ok, true)
  const portable = (await service.read('fixture-chat')).snapshot.blocks.at(-1)
  assert.equal(portable.portable.active, false)
  await until(async () => rjs("[...document.querySelectorAll('.desk-body button')].some(node => ['Open page','Открыть страницу'].includes(node.textContent))"))
  await rjs("[...document.querySelectorAll('.desk-body button')].find(node => ['Open page','Открыть страницу'].includes(node.textContent)).click()")
  await until(async () => (await service.read('fixture-chat')).snapshot.blocks.at(-1).portable.active)
  await until(async () => rjs("Boolean(document.querySelector('iframe[src^=\"onecode-artifact://desk-\"]'))"))
  let portableFrame
  await until(async () => {
    portableFrame = reopened.webContents.mainFrame.frames.find(frame => frame.name === 'desk:' + portable.id && !frame.detached && frame.url.startsWith('onecode-artifact://desk-'))
    if (!portableFrame) return false
    try { return (await portableFrame.executeJavaScript('document.body.dataset.running')) === 'yes' } catch { return false }
  })
  assert.equal(await portableFrame.executeJavaScript('typeof require + ":" + typeof deskAPI'), 'undefined:undefined')
  assert.equal(storage.load('fixture-chat').blocks.at(-1).portable.content, portable.portable.content)
  await rjs("window.portableBeforeLocale = document.querySelector('iframe[src^=\"onecode-artifact://desk-\"]')")
  appearance.language = appearance.language === 'en' ? 'ru' : 'en'
  service.refresh('fixture-chat')
  await until(async () => rjs(`document.documentElement.lang === '${appearance.language}'`))
  assert.equal(await rjs("document.querySelector('iframe[src^=\"onecode-artifact://desk-\"]') === window.portableBeforeLocale"), true, 'changing language must not restart an active portable tool')
  assert.equal(await rjs("Boolean(document.getElementById('desk-fit'))"), true, 'saved workspaces can fit the current screen')
  const beforeFit = (await service.read('fixture-chat')).snapshot.revision
  await rjs("document.getElementById('desk-fit').click()")
  await until(async () => (await service.read('fixture-chat')).snapshot.revision > beforeFit)
  const viewport = await rjs("({ width: document.getElementById('desk-canvas').clientWidth, height: document.getElementById('desk-canvas').clientHeight })")
  for (const block of (await service.read('fixture-chat')).snapshot.blocks) {
    assert(block.rect.x >= 0 && block.rect.x + block.rect.width <= viewport.width)
    assert(block.rect.y >= 0 && block.rect.y + block.rect.height <= viewport.height)
  }
  // Окно снова широкое: в узком (< 900) контуры плана нарочно скрыты.
  reopened.setSize(1240, 800)
  await wait(300)
  const processLate = await service.processes('fixture-chat', 'start', { command: 'fixture-server.exe', args: ['--late'], cwd: watchRoot, env: {} })
  assert.equal(processLate.ok, true)
  // Процесс на холсте: блок с выводом и «Завершить» в шапке.
  const processAdded = await service.apply('fixture-chat', { operationId: 'process-block', expectedRevision: (await service.read('fixture-chat')).snapshot.revision,
    operations: [{ type: 'add', block: { kind: 'process', title: 'fixture-server', resourceRef: 'process:' + processLate.id, rect: { x: 16, y: 420, width: 400, height: 220, z: 9 } } }] }, 'agent:fixture')
  assert.equal(processAdded.ok, true)
  const processBlockId = processAdded.snapshot.blocks.find(block => block.kind === 'process').id
  await until(async () => rjs("document.querySelector('.is-process .desk-term-block')?.textContent.includes('--late') && document.querySelector('.desk-block-stop') !== null"))
  // Агент в блоке: строка в шапке и кольцо; пауза из окна держит его следующее действие.
  service.agent('fixture-chat', 'fixture-run', { mode: 'acting', action: 'click', target: 'fixture-server', blockId: processBlockId })
  await until(async () => rjs("!document.getElementById('desk-agent').hidden && document.querySelector('.ublock.desk-acting') !== null && document.getElementById('desk-agent-act').dataset.act === 'pause'"))
  await rjs("document.getElementById('desk-agent-act').click()")
  await until(async () => rjs("document.getElementById('desk-agent-act').dataset.act === 'resume' && document.querySelector('.ublock.desk-acting') === null"))
  let gateOpen = false
  const gated = service.gate('fixture-chat').then(() => { gateOpen = true })
  await wait(200)
  assert.equal(gateOpen, false, 'пауза держит действие агента')
  await rjs("document.getElementById('desk-agent-act').click()")
  await gated
  service.endTurn('fixture-run')
  await until(async () => rjs("document.getElementById('desk-agent').hidden"))
  // План сборки: контур будущего блока виден и уходит вместе с ходом.
  assert.equal(service.plan('fixture-chat', 'fixture-build', [{ kind: 'output', title: 'Report', rect: { x: 440, y: 420, width: 320, height: 220 } }]).ok, true)
  await until(async () => rjs("document.querySelectorAll('.desk-plan').length === 1 && document.getElementById('desk-agent-act').dataset.act === 'stop'"))
  service.endTurn('fixture-build')
  await until(async () => rjs("document.querySelectorAll('.desk-plan').length === 0"))
  assert.equal((await service.apply('fixture-chat', { operationId: 'process-block-off', expectedRevision: (await service.read('fixture-chat')).snapshot.revision,
    operations: [{ type: 'remove', id: processBlockId }] }, 'agent:fixture')).ok, true)
  await until(async () => rjs("document.querySelector('.is-process') === null"))
  assert.equal(errors.length, 0, errors.join('\n'))
  fs.writeFileSync(output, JSON.stringify({ ok: true, checks: ['empty window','no composer','isolated preload','language/theme','3 real blocks','isolated artifact scripts','agent geometry','keyboard geometry','file-watch list and stop','recent file event','process output and stop','process block, agent line, pause, build plan','stable browser container','human hold','layout copy/preview/cancel/import','no execution on import','real DOM observation/click/fill','artifact DOM observation','window capture','portable content activation','rebind imported output','inactive restart','reopening','safeStorage roundtrip'], errors }))
  app.exit(0)
}).catch(error => { fs.writeFileSync(output, JSON.stringify({ ok: false, error: error.stack })); app.exit(1) })
