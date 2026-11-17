'use strict'
const assert = require('node:assert/strict')
const { createDeskService } = require('../src/main/desk-service.cjs')
async function main () {
  const windows = [], ipc = new Map(), disk = new Map()
  let copied = '', resolves = 0, writable = true, activateAllowed = false
  class Window {
    constructor () { this.events = {}; this.webEvents = {}; this.webContents = { id: windows.length, mainFrame: {}, send () {},
      setWindowOpenHandler () {}, on: (name, fn) => { this.webEvents[name] = fn } }; windows.push(this) }
    on (name, fn) { this.events[name] = fn }
    once () {}
    loadFile () { return Promise.resolve() }
    isDestroyed () { return false }
    isMinimized () { return false }
    show () {}
    focus () {}
  }
  const options = { BrowserWindow: Window, ipcMain: { handle: (name, fn) => ipc.set(name, fn) }, isMainWindow: () => true,
    focusMain () {}, settings: () => ({}), writeClipboard: text => { copied = text },
    packageResource: async () => ({ type: 'page', content: '<h1>Portable tool</h1>' }),
    confirmPortable: async () => activateAllowed,
    resolveResource: async block => { resolves++; return { type: 'text', text: block.resourceRef } },
    storage: { load: id => disk.get(id), save: (id, snapshot) => { if (!writable) throw Error('full'); disk.set(id, snapshot) } } }
  const service = createDeskService(options)
  service.open('source'); service.open('target')
  const rect = { x: 16, y: 16, width: 480, height: 320, z: 0 }
  await service.apply('source', { operationId: 'source', expectedRevision: 0, operations: [{ type: 'add', block: {
    kind: 'browser', title: 'Site', resourceRef: 'https://example.com/private?token=secret', rect
  } }, { type: 'add', block: { kind: 'artifact', title: 'Tool', resourceRef: 'artifact:secret-chat-id', rect } }] }, 'agent:test')
  const exported = await service.transfer('source', 'export')
  assert.equal(exported.ok, true)
  assert.equal((await service.transfer('source', 'copy', { text: exported.text })).ok, true)
  assert.equal(copied, exported.text)
  assert.equal((await service.transfer('source', 'copy', { text: 'unreviewed text' })).code, 'conflict')
  assert.equal(copied, exported.text)
  assert(!copied.includes('secret') && !copied.includes('private'))
  const event = { sender: windows[1].webContents, senderFrame: windows[1].webContents.mainFrame }
  assert.equal((await ipc.get('desk:transfer')({ ...event, senderFrame: {} }, 'export')).code, 'forbidden')
  const preview = await ipc.get('desk:transfer')(event, 'preview', { text: exported.text })
  assert.equal(preview.ok, true)
  assert.equal(preview.blocks.length, 2)
  assert.equal((await service.read('target')).snapshot.blocks.length, 0, 'preview has no effects')
  const beforeResolves = resolves
  assert.equal((await service.transfer('source', 'import', { token: preview.token })).code, 'expired-preview', 'preview is scoped to Desk')
  const imported = await ipc.get('desk:transfer')(event, 'import', { token: preview.token })
  assert.equal(imported.ok, true)
  const target = await service.read('target')
  assert.equal(target.snapshot.blocks.length, 2)
  assert.equal(target.snapshot.blocks[0].resourceRef, 'desk-pending:browser:https://example.com')
  assert.equal(target.resources[target.snapshot.blocks[0].id].type, 'pending')
  assert.equal(resolves, beforeResolves, 'import and read never activate resources')
  assert.deepEqual(disk.get('target'), target.snapshot)
  assert.equal((await service.transfer('target', 'import', { token: preview.token })).code, 'expired-preview', 'double submit cannot import twice')
  const next = await service.transfer('target', 'preview', { text: exported.text })
  await service.apply('target', { operationId: 'move', expectedRevision: 1, operations: [{ type: 'geometry', id: target.snapshot.blocks[0].id, rect: { ...rect, x: 24 } }] }, 'agent:test')
  assert.equal((await service.transfer('target', 'import', { token: next.token })).code, 'conflict', 'concurrent edits require a new preview')
  const failed = await service.transfer('target', 'preview', { text: exported.text })
  writable = false
  assert.equal((await service.transfer('target', 'import', { token: failed.token })).code, 'storage-unavailable')
  writable = true
  assert.equal((await service.read('target')).snapshot.blocks.length, 2, 'failed persistence leaves the original layout intact')
  const bad = JSON.parse(exported.text); bad.blocks = Array.from({ length: 64 }, () => bad.blocks[0])
  assert.equal((await service.transfer('target', 'preview', { text: JSON.stringify(bad) })).code, 'limit')
  assert.equal((await service.transfer('target', 'preview', { text: '{' })).code, 'invalid-template')
  const expired = await service.transfer('target', 'preview', { text: exported.text })
  const now = Date.now
  try { Date.now = () => now() + 6 * 60 * 1000; assert.equal((await service.transfer('target', 'import', { token: expired.token })).code, 'expired-preview') } finally { Date.now = now }
  const closed = await service.transfer('target', 'preview', { text: exported.text })
  windows[1].events.closed()
  service.open('target')
  assert.equal((await service.transfer('target', 'import', { token: closed.token })).code, 'expired-preview')
  const restored = createDeskService(options); restored.open('target')
  assert.equal((await restored.read('target')).snapshot.blocks.length, 2)
  assert.equal(resolves, beforeResolves, 'restart keeps imported resources inactive')
  restored.open('bundle')
  const bundleEvent = { sender: windows.at(-1).webContents, senderFrame: windows.at(-1).webContents.mainFrame }
  const bundle = await service.transfer('source', 'export', { includeContent: true })
  assert.equal(bundle.ok, true)
  const bundlePreview = await restored.transfer('bundle', 'preview', { text: bundle.text, viewport: { width: 800, height: 600 } })
  assert.equal((await restored.transfer('bundle', 'import', { token: bundlePreview.token })).ok, true)
  const portableBlock = (await restored.read('bundle')).snapshot.blocks.find(block => block.portable)
  assert.equal((await restored.read('bundle')).resources[portableBlock.id].type, 'pending')
  assert.equal((await ipc.get('desk:activate')(bundleEvent, portableBlock.id)).code, 'denied')
  assert.equal((await restored.read('bundle')).snapshot.blocks.find(block => block.portable).portable.active, false)
  activateAllowed = true
  assert.equal((await ipc.get('desk:activate')({ ...bundleEvent, senderFrame: {} }, portableBlock.id)).code, 'forbidden')
  assert.equal((await ipc.get('desk:activate')(bundleEvent, portableBlock.id)).ok, true)
  assert.equal((await restored.read('bundle')).resources[portableBlock.id].type, 'portable-page')
  assert(disk.get('bundle').blocks.find(block => block.portable).portable.active)
  console.log('PASS Desk template service: trusted IPC, preview, atomic append, conflicts, replay, encrypted-store handoff, inactive resources and restart')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
