'use strict'
// Н7: записи Desk не вытеснялись — после 16 чатов за сеанс open() отвечал
// `limit` навсегда, даже когда все окна закрыты. Запись без окна ничего не
// держит: слежение и процессы сняты при закрытии, раскладка лежит на диске.
// Поэтому при переполнении вытесняется самая давняя запись без окна.
const assert = require('node:assert/strict')
const { createDeskService } = require('../src/main/desk-service.cjs')

async function main () {
  const windows = []
  class Window {
    constructor (options) {
      this.options = options; this.events = {}; this.webEvents = {}
      this.webContents = { id: windows.length + 10, mainFrame: {}, send () {}, on: (name, fn) => { this.webEvents[name] = fn },
        setWindowOpenHandler () {}, isDestroyed: () => false }
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
  const disk = new Map()
  const storage = { load: id => disk.get(id) || null, save: (id, value) => disk.set(id, structuredClone(value)) }
  const service = createDeskService({ BrowserWindow: Window, ipcMain: { handle () {} }, isMainWindow: () => true, focusMain () {},
    settings: () => ({}), storage, resolveResource: async () => ({ type: 'text', text: 'x' }) })

  for (let i = 0; i < 16; i++) assert.equal((await service.open('chat-' + i)).ok, true, 'chat ' + i)
  const block = { operationId: 'add', expectedRevision: 0, operations: [{ type: 'add', block: {
    kind: 'artifact', title: 'Tool', resourceRef: 'artifact:chat-0', rect: { x: 16, y: 16, width: 480, height: 320, z: 1 }
  } }] }
  assert.equal((await service.apply('chat-0', block, 'agent:run')).ok, true)
  assert.equal((await service.open('chat-16')).code, 'limit', 'sixteen live windows still take all sixteen records')

  for (const window of windows) window.events.closed()
  assert.equal((await service.open('chat-16')).ok, true, 'a closed Desk gives its record to the next chat')

  // Вытеснение не теряет раскладку: она на диске и возвращается при повторном открытии.
  assert.equal((await service.open('chat-0')).ok, true, 'an evicted chat reopens from disk')
  assert.equal((await service.read('chat-0')).snapshot.blocks.length, 1, 'the layout survived the eviction')
  for (const window of windows) window.events.closed()
  for (let i = 17; i < 24; i++) {
    assert.equal((await service.open('chat-' + i)).ok, true, 'chat ' + i)
    for (const window of windows) window.events.closed()
  }
  console.log('PASS desk records: windowless records are evicted, the layout comes back from disk')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
