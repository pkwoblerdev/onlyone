// Ограда каналов главного процесса (разбор REA 25.10, находка 7).
//
// До неё 159 каналов ipcMain отвечали любому отправителю: защита держалась
// только на том, что preload есть у одного окна. Здесь `installIpcSenderGuard`
// вырезается из настоящего main.js и проверяется на поддельных событиях Electron:
// свой верхний кадр проходит, <webview>, вложенная рамка, чужой адрес и
// уничтоженное окно — нет. Живой путь (preload → канал) проверяет run-smoke.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(process.env.ONECODE_MAIN_UNDER_TEST ||
  path.join(root, 'src', 'main', 'main.js'), 'utf8')
const start = main.indexOf('function installIpcSenderGuard(')
assert.ok(start >= 0, 'в main.js нет installIpcSenderGuard')
const end = main.indexOf('\ninstallIpcSenderGuard(ipcMain', start)
assert.ok(end > start, 'ограда не ставится на настоящий ipcMain')
const install = new Function('require', main.slice(start, end) + '\nreturn installIpcSenderGuard')(require)

// Каталог с пробелом и кириллицей: в адресе кадра они закодированы, в пути — нет.
const rendererDir = path.join(root, 'tmp dir', 'рендерер')
const pageUrl = name => pathToFileURL(path.join(rendererDir, name)).href

function fakeIpc() {
  const routes = new Map()
  const register = (channel, listener) => { routes.set(channel, listener) }
  return { routes, handle: register, handleOnce: register, on: register, once: register }
}
function frame(url) { return { url } }
function windowEvent(url, { type = 'window', sub = false, destroyed = false } = {}) {
  const mainFrame = frame(url)
  const sender = { getType: () => type, mainFrame, isDestroyed: () => destroyed }
  return { sender, senderFrame: sub ? frame(url) : mainFrame }
}

let failed = 0
async function check(name, fn) {
  try { await fn(); console.log('ok    ' + name) } catch (error) { failed++; console.log('ПРОВАЛ ' + name + ' — ' + error.message) }
}

;(async () => {
  const ipc = fakeIpc()
  install(ipc, rendererDir)
  const calls = []
  ipc.handle('get-settings', (_event, value) => { calls.push(value); return 'ok:' + value })
  ipc.on('perf-longtask', (_event, value) => { calls.push(value) })
  const invoke = (event, value) => ipc.routes.get('get-settings')(event, value)
  const send = (event, value) => ipc.routes.get('perf-longtask')(event, value)

  await check('главное окно и Desk из src/renderer проходят', async () => {
    assert.equal(await invoke(windowEvent(pageUrl('index.html')), 1), 'ok:1')
    assert.equal(await invoke(windowEvent(pageUrl('desk.html') + '#x'), 2), 'ok:2')
  })

  await check('<webview> получает отказ даже с адресом приложения', async () => {
    assert.throws(() => invoke(windowEvent(pageUrl('index.html'), { type: 'webview' }), 3), /только окну onlyone/)
  })

  await check('вложенная рамка окна получает отказ', async () => {
    assert.throws(() => invoke(windowEvent(pageUrl('index.html'), { sub: true }), 4), /только окну onlyone/)
  })

  await check('чужой адрес в окне получает отказ', async () => {
    assert.throws(() => invoke(windowEvent('https://example.com/'), 5), /только окну onlyone/)
    assert.throws(() => invoke(windowEvent(pathToFileURL(path.join(root, 'tmp dir', 'рендерер-соседний', 'index.html')).href), 6)
      , /только окну onlyone/, 'соседняя папка с тем же началом имени прошла')
    assert.throws(() => invoke(windowEvent('onecode-artifact://a/index.html'), 7), /только окну onlyone/)
  })

  await check('уничтоженное окно и событие без кадра получают отказ', async () => {
    assert.throws(() => invoke(windowEvent(pageUrl('index.html'), { destroyed: true }), 8), /только окну onlyone/)
    assert.throws(() => invoke({ sender: windowEvent(pageUrl('index.html')).sender, senderFrame: null }, 9), /только окну onlyone/)
  })

  await check('сообщение (on) от чужого молча отбрасывается, своё доходит', async () => {
    send(windowEvent('https://example.com/', { type: 'webview' }), 10)
    send(windowEvent(pageUrl('index.html')), 11)
    assert.deepEqual(calls, [1, 2, 11])
  })

  console.log(JSON.stringify({ ok: failed === 0, failed }))
  process.exit(failed ? 1 : 0)
})()
