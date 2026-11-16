// Встроенный браузер панели: ограды главного процесса.
//
// Страницы в панели — чужой код. Они идут через <webview>, у которого нет ни Node, ни
// preload, ни доступа к окну приложения, а сам браузер ничего не просит у системы без
// спроса: камера, микрофон, геолокация, уведомления закрыты, скачивание не стартует,
// схемы кроме http(s) не открываются. Здесь — чистые части этих оград и то, что они
// подключены в main.js и в окне.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const guard = require('../src/main/panel-browser.js')

const failures = []
const pending = []
function test(name, fn) {
  try {
    const done = fn()
    if (done && typeof done.then === 'function') {
      pending.push(done.then(() => console.log('ok', name), error => { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }))
    } else console.log('ok', name)
  } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

test('user-agent: без Electron и имени приложения, остальное цело', () => {
  const raw = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) onlyone/1.3.1 Chrome/146.0.0.0 Electron/44.2.0 Safari/537.36'
  const clean = guard.cleanUserAgent(raw)
  assert.equal(clean, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36')
  assert.equal(guard.cleanUserAgent(clean), clean, 'повторная очистка ничего не меняет')
})

test('переход: только http(s) и пустая страница', () => {
  for (const ok of ['https://example.com/', 'http://localhost:3000/a', 'about:blank']) assert.equal(guard.allowedUrl(ok), true, ok)
  for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,x', 'chrome://gpu', 'devtools://devtools/x', 'view-source:https://a.test', 'ftp://a.test', 'blob:https://a.test/1', '', 'мусор']) {
    assert.equal(guard.allowedUrl(bad), false, bad)
  }
})

test('вставка webview: preload снят, Node закрыт, песочница включена, раздел принудительно свой', () => {
  const prefs = { preload: 'x.js', preloadURL: 'file:///x.js', nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false, allowRunningInsecureContent: true, nodeIntegrationInSubFrames: true }
  const params = { src: 'https://example.com', partition: 'persist:чужой' }
  const verdict = guard.guardAttach(prefs, params)
  assert.equal(verdict.allow, true)
  assert.equal(prefs.preload, undefined)
  assert.equal(prefs.preloadURL, undefined)
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.sandbox, true)
  assert.equal(prefs.webSecurity, true)
  assert.equal(prefs.allowRunningInsecureContent, false)
  assert.equal(prefs.nodeIntegrationInSubFrames, false)
  assert.equal(params.partition, guard.PARTITION)
})

test('вставка webview: адрес file:/data:/javascript: отказ, пустой src можно', () => {
  assert.equal(guard.guardAttach({}, { src: 'file:///C:/x' }).allow, false)
  assert.equal(guard.guardAttach({}, { src: 'javascript:alert(1)' }).allow, false)
  assert.equal(guard.guardAttach({}, { src: '' }).allow, true)
  assert.equal(guard.guardAttach({}, { src: 'about:blank' }).allow, true)
  assert.equal(guard.guardAttach({}, { src: 'http://localhost:5173/' }).allow, true)
})

test('разрешения сайтов: только запись в буфер и полный экран', () => {
  for (const ok of ['clipboard-sanitized-write', 'fullscreen']) assert.equal(guard.permissionAllowed(ok), true, ok)
  for (const bad of ['media', 'geolocation', 'notifications', 'midi', 'openExternal', 'clipboard-read', 'camera', 'microphone', 'display-capture', 'hid', 'usb']) {
    assert.equal(guard.permissionAllowed(bad), false, bad)
  }
})

// Находка Н2 аудита sec-net 2026-11-01 (для панели): переходы судились только на
// главном кадре <webview>, а <iframe>, <img>, fetch/XHR и WebSocket загруженного
// публичного сайта шли в локальную сеть за спиной человека. Ограда partition
// отменяет запросы с ПУБЛИЧНОЙ страницы на ПРИВАТНЫЙ адрес; человек, сам
// открывающий домашний адрес (навигация главной вкладки), не блокируется, а
// страница, открытая на приватном адресе, видит свою сеть (dev-серверы).
test('ограда partition: публичная страница не ходит в локальную сеть (подкадр, скрипт, xhr, ws)', async () => {
  let fence = null
  const ses = {
    getUserAgent: () => 'Mozilla/5.0 Electron/44.2.0 onlyone/1.3.33',
    setUserAgent: () => {},
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    on: () => {},
    webRequest: { onBeforeRequest: (filter, handler) => { fence = { filter, handler } } }
  }
  const created = []
  // Ограда резолвит имена (Н8 break-5): вымышленные адреса набора получают публичный IP.
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  guard.install({ app: { on: (event, fn) => { if (event === 'web-contents-created') created.push(fn) } }, session: { fromPartition: () => ses }, lookup })
  assert.ok(fence, 'на partition панели нет ни одного сетевого слушателя: подкадры публичных судов судить нечем')
  for (const scheme of ['http://', 'https://', 'ws://', 'wss://']) {
    assert.ok((fence.filter.urls || []).some(u => String(u).startsWith(scheme)), `фильтр не накрывает ${scheme}`)
  }
  const ask = (url, topURL, resourceType) => new Promise(resolve => {
    fence.handler({
      url, method: 'GET', resourceType, referrer: '',
      webContents: topURL === null ? undefined : { getURL: () => topURL }
    }, response => resolve(response))
  })
  assert.equal((await ask('http://127.0.0.1:8080/api', 'https://evil.example/page', 'subFrame')).cancel, true, 'iframe публичной страницы в loopback прошёл')
  assert.equal((await ask('http://192.168.0.1/upg', 'https://evil.example/page', 'image')).cancel, true, 'картинка в домашнюю сеть прошла')
  assert.equal((await ask('http://10.0.0.5/admin', 'https://evil.example/page', 'xmlhttprequest')).cancel, true, 'fetch из публичной страницы в приват прошёл')
  assert.equal((await ask('ws://127.0.0.1:9229/devtools', 'https://evil.example/page', 'webSocket')).cancel, true, 'WebSocket без CORS читал бы локальный сервис')
  assert.equal((await ask('http://localhost:3000/api', 'https://evil.example/page', 'xhr')).cancel, true, 'имя localhost не считается приватным')
  assert.equal((await ask('http://[::1]:8080/', 'https://evil.example/page', 'image')).cancel, true, 'IPv6 loopback прошёл')
  assert.equal((await ask('https://cdn.example/x.png', 'https://good.example/page', 'image')).cancel, false, 'публичный подкадр отменён — ограда ломает обычные сайты')
  assert.equal((await ask('http://127.0.0.1:5173/api', 'http://localhost:3000/', 'xhr')).cancel, false, 'страница приватного происхождения не видит свою сеть — dev-сервер сломан')
  assert.equal((await ask('http://192.168.0.1/', 'https://evil.example/page', 'mainFrame')).cancel, false, 'переход по ссылке человека в роутер заблокирован — а он видим в строке адреса')
  assert.equal((await ask('http://127.0.0.1/', undefined, 'image')).cancel, true, 'без сведения о странице приватный запрос прошёл молча')
})

test('webview: переходы подкадров тоже судятся (will-frame-navigate)', () => {
  const ses = {
    getUserAgent: () => 'UA', setUserAgent: () => {}, setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {}, on: () => {}, webRequest: { onBeforeRequest: () => {} }
  }
  let created = null
  guard.install({ app: { on: (event, fn) => { if (event === 'web-contents-created') created = fn } }, session: { fromPartition: () => ses } })
  const events = {}
  const contents = {
    getType: () => 'webview',
    hostWebContents: { isDestroyed: () => true },
    setWindowOpenHandler: () => {},
    on: (event, fn) => { events[event] = fn }
  }
  created({}, contents)
  assert.ok(events['will-navigate'] && events['will-redirect'], 'главные переходы висят')
  assert.equal(typeof events['will-frame-navigate'], 'function', 'на каждый кадр обработчика нет')
  let prevented = false
  const event = { preventDefault: () => { prevented = true } }
  events['will-frame-navigate'](event, { url: 'file:///C:/Windows/win.ini', isMainFrame: false })
  assert.ok(prevented, 'подкадр на file:// не отменён')
  prevented = false
  events['will-frame-navigate'](event, { url: 'javascript:alert(1)', isMainFrame: true })
  assert.ok(prevented, 'главный кадр на javascript: не отменён и на уровне кадра')
})

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8')
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')

test('main.js: оградa подключена и webviewTag включён только для окна приложения', () => {
  assert.match(main, /require\('\.\/panel-browser'\)/)
  assert.match(main, /panelBrowser\.install\(/)
  assert.match(main, /webviewTag: true/)
})

test('preload: окно слышит «новая вкладка» от страницы и умеет открыть адрес в системном браузере', () => {
  assert.match(preload, /onBrowserOpenTab/)
  assert.match(preload, /browser-open-external|openBrowserExternal/)
})

test('окно: политика содержимого не ослабла и <webview> заведён только внутри панели', () => {
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1]
  assert.ok(!/unsafe-eval/.test(csp))
  assert.ok(!/<webview/i.test(html), 'webview создаётся кодом панели по требованию, а не стоит в разметке')
})

// «Найти запущенный проект»: настоящий сокет на свободном порту находится, закрытый — нет.
;(async () => {
  const net = require('node:net')
  const server = net.createServer(socket => socket.destroy())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const open = server.address().port
  const closed = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
  try {
    const found = await guard.detectDevServers({ net, ports: [closed, open], timeoutMs: 500 })
    test('поиск запущенного проекта: находит слушающий порт и не выдумывает закрытый', () => assert.deepEqual(found, [open]))
    test('поиск: порты по умолчанию — типичные и без повторов', () => {
      assert.ok(guard.DEV_PORTS.includes(3000) && guard.DEV_PORTS.includes(5173) && guard.DEV_PORTS.includes(8080))
      assert.equal(new Set(guard.DEV_PORTS).size, guard.DEV_PORTS.length)
    })
    test('поиск подключён: preload, IPC и кнопка в окне', () => {
      const root = path.join(__dirname, '..')
      assert.match(fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8'), /detectDevServers/)
      assert.match(fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8'), /browser-detect-dev-servers/)
      assert.match(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8'), /id="browserDetect"/)
    })
  } finally { server.close() }
  await Promise.all(pending)
  if (failures.length) { console.error(`\nПРОВАЛ ${failures.length}`); process.exit(1) }
  console.log('\nВсе проверки оград браузера пройдены')
})()
