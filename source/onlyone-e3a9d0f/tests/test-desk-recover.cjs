'use strict'
// Н5: после падения renderer окно Desk оставалось мёртвым: open() фокусировал
// упавшее окно, `rendererGone` снимался только при закрытии, и процессы,
// слежение и перенос отвечали `not-open` до перезапуска приложения.
// Восстановление — перезагрузка страницы в том же окне: гейты снимаются, когда
// страница действительно загрузилась (`did-finish-load`), а не в момент клика.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createDeskService } = require('../src/main/desk-service.cjs')

async function main () {
  const windows = [], watchers = []
  class Window {
    constructor (options) {
      this.options = options; this.events = {}; this.webEvents = {}; this.reloads = 0
      this.webContents = { id: windows.length + 10, mainFrame: {}, send () {},
        on: (name, fn) => { this.webEvents[name] = fn }, setWindowOpenHandler () {},
        reload: () => { this.reloads++ }, isDestroyed: () => false }
      windows.push(this)
    }

    once (name, fn) { this.events[name] = fn }
    on (name, fn) { this.events[name] = fn }
    loadFile () { return Promise.resolve() }
    isDestroyed () { return false }
    show () {}
    focus () {}
    isMinimized () { return false }
  }
  const service = createDeskService({ BrowserWindow: Window, ipcMain: { handle () {} }, isMainWindow: () => true,
    focusMain () {}, settings: () => ({}),
    resolveResource: async () => ({ type: 'text', text: 'x' }),
    createProcessManager: () => ({ list: () => [], start: async () => ({ ok: true, id: 'p1' }), stop: async () => ({ ok: true }),
      closeAll: async () => ({}), onChange () {} }),
    watchDirectory: async (relativePath, options = {}) => {
      const watcher = new EventEmitter()
      watcher.close = () => {}
      watchers.push(watcher)
      return { displayPath: relativePath, recursive: options.recursive === true, watcher }
    } })

  assert.equal((await service.open('chat')).ok, true)
  const win = windows[0]
  win.webEvents['render-process-gone']()
  assert.equal((await service.processes('chat', 'start', { command: 'node.exe', cwd: 'C:\\work' })).code, 'not-open',
    'a crashed renderer closes the gates')

  const reopened = await service.open('chat')
  assert.equal(reopened.ok, true)
  assert.equal(windows.length, 1, 'the crashed window is reused, not stacked')
  assert.equal(win.reloads, 1, 'open() reloads the crashed page')
  assert.equal((await service.open('chat')).ok, true)
  assert.equal(win.reloads, 1, 'a second open while reloading does not stack reloads')

  win.webEvents['did-finish-load']()
  assert.equal((await service.processes('chat', 'start', { command: 'node.exe', cwd: 'C:\\work' })).ok, true,
    'processes run again after recovery')
  assert.equal((await service.watch('chat', 'start', { path: 'src' })).ok, true, 'watchers work again after recovery')
  assert.equal((await service.transfer('chat', 'export', {})).ok, true, 'transfers work again after recovery')

  // Второе падение снова закрывает гейты и снова лечится открытием.
  win.webEvents['render-process-gone']()
  assert.equal((await service.processes('chat', 'start', { command: 'node.exe', cwd: 'C:\\work' })).code, 'not-open')
  assert.equal((await service.open('chat')).ok, true)
  assert.equal(win.reloads, 2, 'a second crash is recovered by a second reload')
  win.webEvents['did-finish-load']()
  assert.equal((await service.processes('chat', 'start', { command: 'node.exe', cwd: 'C:\\work' })).ok, true)
  console.log('PASS desk recovery: a crashed renderer is reloaded in place, gates reopen on did-finish-load')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
