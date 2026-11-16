// Страница сказала — модель услышала (волна 4): решения page-watch и события страницы из главного процесса.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const watchModule = require('../src/renderer/page-watch.js')
const panelBrowser = require('../src/main/panel-browser.js')

let failed = 0
function check(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) }
}

// Часы и таймеры в руках теста: «прошло 1,5 с» — это вызов, а не ожидание.
function harness(options = {}) {
  let clock = 1_000_000
  const timers = []
  const sent = []
  const reloads = []
  const state = { enabled: true, canWake: true, liveReload: true }
  const api = watchModule.create({
    now: () => clock,
    setTimeout: (fn, ms) => { const timer = { fn, at: clock + ms, live: true }; timers.push(timer); return timer },
    clearTimeout: timer => { if (timer) timer.live = false },
    t: value => value,
    send: text => sent.push(text),
    canWake: () => state.canWake,
    enabled: () => state.enabled,
    liveReload: () => state.liveReload,
    reloadLocal: () => reloads.push(clock),
    ...options
  })
  const advance = ms => {
    clock += ms
    for (const timer of timers.splice(0)) { if (timer.live && timer.at <= clock) timer.fn(); else if (timer.live) timers.push(timer) }
  }
  return { api, sent, reloads, state, advance, tick: ms => { clock += ms }, now: () => clock }
}

const err = (text, url = 'http://localhost:5173/') => ({ kind: 'console-error', guestId: 7, url, text, source: 'http://localhost:5173/src/app.js', line: 12 })

check('ошибка своей страницы будит модель сообщением с адресом, текстом и местом', () => {
  const h = harness()
  assert.equal(h.api.handle(err('ReferenceError: total is not defined')), true)
  h.advance(1600)
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0], /localhost:5173/)
  assert.match(h.sent[0], /ReferenceError: total is not defined/)
  assert.match(h.sent[0], /app\.js:12/)
  assert.match(h.sent[0], /автоматическое/)
})

check('несколько событий за полторы секунды — одно сообщение', () => {
  const h = harness()
  h.api.handle(err('Ошибка А'))
  h.advance(300)
  h.api.handle(err('Ошибка Б'))
  h.advance(1500)
  assert.equal(h.sent.length, 1)
  assert.ok(h.sent[0].includes('Ошибка А') && h.sent[0].includes('Ошибка Б'))
})

check('чужой сайт не будит никогда', () => {
  const h = harness()
  assert.equal(h.api.handle(err('Uncaught TypeError', 'https://example.com/')), false)
  h.advance(2000)
  assert.equal(h.sent.length, 0)
})

check('локальная сеть — своя страница', () => {
  const h = harness()
  assert.equal(h.api.handle(err('boom', 'http://192.168.0.5:3000/')), true)
})

check('одинаковая ошибка не будит чаще раза в 5 минут', () => {
  const h = harness()
  h.api.handle(err('Та же ошибка'))
  h.advance(1600)
  assert.equal(h.api.handle(err('Та же ошибка')), false)
  h.advance(5 * 60 * 1000 + 100)
  assert.equal(h.api.handle(err('Та же ошибка')), true)
})

check('шум не будит: favicon, DevTools, ResizeObserver', () => {
  const h = harness()
  for (const text of ['GET /favicon.ico 404', 'Download the React DevTools', 'ResizeObserver loop limit exceeded']) {
    assert.equal(h.api.handle(err(text)), false, text)
  }
})

check('не больше трёх пробуждений за десять минут', () => {
  const h = harness()
  for (let i = 0; i < 6; i++) { h.api.handle(err('Разная ошибка ' + i)); h.advance(1600) }
  assert.equal(h.sent.length, 3)
  assert.equal(h.api.stats.dropped, 3)
  h.advance(10 * 60 * 1000)
  h.api.handle(err('Ошибка после паузы')); h.advance(1600)
  assert.equal(h.sent.length, 4)
})

check('выключенное слежение молчит, как и чат без ключа или папки', () => {
  const h = harness()
  h.state.enabled = false
  assert.equal(h.api.handle(err('Выключено')), false)
  h.state.enabled = true
  h.state.canWake = false
  h.api.handle(err('Нет ключа')); h.advance(1600)
  assert.equal(h.sent.length, 0)
})

check('упавшая загрузка и упавшая вкладка тоже сообщаются', () => {
  const h = harness()
  h.api.handle({ kind: 'load-failed', url: 'http://localhost:3000/', failedUrl: 'http://localhost:3000/', text: 'ERR_CONNECTION_REFUSED' })
  h.api.handle({ kind: 'crashed', url: 'http://localhost:3000/', text: 'oom' })
  h.advance(1600)
  assert.match(h.sent[0], /страница не загрузилась/)
  assert.match(h.sent[0], /вкладка упала/)
})

check('живое обновление: пачка записей файлов — одна перезагрузка, и ошибка после неё слышится заново', () => {
  const h = harness()
  h.api.handle(err('Старая ошибка')); h.advance(1600)
  assert.equal(h.sent.length, 1)
  h.api.fileChanged(); h.api.fileChanged(); h.api.fileChanged()
  h.advance(500)
  assert.equal(h.reloads.length, 1)
  h.api.forget()
  assert.equal(h.api.handle(err('Старая ошибка')), true, 'после правки та же ошибка должна услышаться снова')
})

check('живое обновление выключается тем же глазом', () => {
  const h = harness()
  h.state.liveReload = false
  h.api.fileChanged(); h.advance(1000)
  assert.equal(h.reloads.length, 0)
})

// Главный процесс: события гостевой страницы уходят окну коротко и без лишнего.
check('главный процесс: ошибка консоли, провал загрузки, падение и зависание уходят окну', () => {
  const contents = new EventEmitter()
  contents.id = 42
  contents.getURL = () => 'http://localhost:5173/'
  const host = { sent: [], isDestroyed: () => false, send(channel, payload) { this.sent.push({ channel, payload }) } }
  panelBrowser.watchGuest(contents, host)
  contents.emit('console-message', { level: 'error', message: 'Uncaught Error: x', lineNumber: 9, sourceId: 'http://localhost:5173/a.js' })
  contents.emit('console-message', { level: 'info', message: 'просто лог', lineNumber: 1, sourceId: '' })
  contents.emit('console-message', {}, 3, 'старая сигнатура', 4, 'b.js')
  contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true)
  contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost:5173/', true)
  contents.emit('did-fail-load', {}, -102, 'sub', 'http://localhost:5173/x.png', false)
  contents.emit('render-process-gone', {}, { reason: 'crashed' })
  contents.emit('unresponsive')
  const kinds = host.sent.map(item => item.payload.kind)
  assert.deepEqual(kinds, ['console-error', 'console-error', 'load-failed', 'crashed', 'hung'])
  assert.ok(host.sent.every(item => item.channel === 'browser-page-event' && item.payload.guestId === 42))
  assert.equal(host.sent[0].payload.line, 9)
})

check('главный процесс молчит, если окна уже нет', () => {
  const contents = new EventEmitter()
  contents.id = 1; contents.getURL = () => 'http://localhost/'
  let sent = 0
  panelBrowser.watchGuest(contents, { isDestroyed: () => true, send() { sent++ } })
  contents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(sent, 0)
})

check('проводка: слушатели в preload, запись файла сообщает окну, глаз в разметке', () => {
  const root = path.join(__dirname, '..')
  const read = file => fs.readFileSync(path.join(root, file), 'utf8')
  assert.match(read('src/preload/preload.js'), /onBrowserPageEvent/)
  assert.match(read('src/preload/preload.js'), /onWorkspaceFileChanged/)
  assert.match(read('src/main/main.js'), /'workspace-file-changed'/)
  assert.match(read('src/renderer/index.html'), /id="browserWatch"/)
  assert.match(read('src/renderer/index.html'), /page-watch\.js/)
  assert.match(read('src/renderer/app.js'), /sendToChat:/)
})

if (failed) process.exit(1)
console.log('\nСлежение за страницей: проверки пройдены')
