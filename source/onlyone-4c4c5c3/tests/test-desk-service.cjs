'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createDeskService } = require('../src/main/desk-service.cjs')

async function main () {
  const handlers = new Map(), windows = [], processManagers = []
  let focus = 0, lookups = 0, cancelWhileResolving = null
  const watchers = []
  class Window {
    constructor (options) {
      this.options = options; this.events = {}
      const webEvents = {}
      this.webContents = { id: windows.length + 10, mainFrame: {}, send () {}, on: (name, fn) => { webEvents[name] = fn }, setWindowOpenHandler () {}, isDestroyed: () => false }
      this.webEvents = webEvents
      windows.push(this)
    }
    once (name, fn) { this.events[name] = fn }
    on (name, fn) { this.events[name] = fn }
    loadFile (file) { this.file = file; return Promise.resolve() }
    isDestroyed () { return false }
    show () {}
    focus () { focus++ }
    isMinimized () { return false }
  }
  const modEvents = []
  const service = createDeskService({ BrowserWindow: Window, ipcMain: { handle: (id, fn) => handlers.set(id, fn) },
    isMainWindow: event => event.sender === 'main', focusMain () {}, settings: () => ({ language: 'en', theme: 'light' }),
    onEvent: (...args) => modEvents.push(args),
    resolveResource: async (block, chatId) => {
      lookups++
      if (cancelWhileResolving) cancelWhileResolving.abort()
      if (block.resourceRef !== `artifact:${chatId}`) throw Error('outside chat')
      return { type: 'page', url: `onecode-artifact://${chatId}/v1.html` }
    },
    createProcessManager: chatId => {
      const state = { chatId, items: [], closed: 0 }
      const manager = { list: () => state.items,
        start: async request => { state.items.push({ id: 'process-'+chatId, ...request, state: 'running' }); return { ok: true, id: 'process-'+chatId } },
        stop: async id => ({ ok: id === 'process-'+chatId, id }), closeAll: async () => { state.closed++ }, onChange () {} }
      processManagers.push({ state, manager })
      return manager
    },
    watchDirectory: async (relativePath, options = {}) => {
      if (relativePath === 'outside') throw Error('outside workspace')
      const watcher = new EventEmitter()
      watcher.closed = false
      watcher.close = () => { watcher.closed = true }
      watchers.push({ relativePath, watcher })
      return { displayPath: relativePath, recursive: options.recursive === true, watcher }
    } })
  assert.equal((await handlers.get('desk:open')({ sender: 'foreign' }, 'one')).code, 'forbidden')
  assert.equal((await handlers.get('desk:open')({ sender: 'main' }, 'one')).ok, true)
  assert.equal(windows.length, 1)
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false)
  assert.equal(windows[0].options.webPreferences.sandbox, true)
  assert.equal(windows[0].options.webPreferences.contextIsolation, true)
  service.open('one'); assert.equal(windows.length, 1); assert.equal(focus, 1)
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }
  assert.equal((await handlers.get('desk:processes')({ ...event, senderFrame: {} })).code, 'forbidden')
  assert.deepEqual(await handlers.get('desk:processes')(event), { ok: true, processes: [] })
  assert.equal((await service.processes('one', 'start', { command: 'node.exe', cwd: 'C:\\workspace' })).ok, true)
  assert.equal((await handlers.get('desk:processes')(event)).processes[0].id, 'process-one')
  assert.equal((await handlers.get('desk:process-stop')(event, 'process-one')).ok, true)
  assert.equal((await handlers.get('desk:apply')(event, { operations: [{ type: 'add' }] })).code, 'forbidden')
  assert.equal((await handlers.get('desk:read')({ ...event, senderFrame: {} })).code, 'forbidden')
  const c = { operationId: 'add', expectedRevision: 0, operations: [{ type: 'add', block: {
    kind: 'artifact', title: 'Tool', resourceRef: 'artifact:one', rect: { x: 16, y: 16, width: 480, height: 320, z: 1 }
  } }] }
  assert.equal((await service.apply('one', c, 'agent:run')).ok, true)
  const view = await handlers.get('desk:read')(event)
  assert.equal(view.snapshot.blocks.length, 1); assert.equal(view.settings.language, 'en')
  const id = view.snapshot.blocks[0].id
  assert.equal(view.resources[id].type, 'page')
  assert.equal(view.runtime[id].state, 'loading')
  const stateReport = { id, revision: 1, state: 'ready' }
  assert.equal((await handlers.get('desk:state')(event, stateReport)).ok, true)
  assert.equal((await handlers.get('desk:state')({ ...event, senderFrame: {} }, stateReport)).code, 'forbidden')
  assert.equal((await handlers.get('desk:state')(event, { ...stateReport, revision: 0 })).code, 'conflict')
  assert.equal((await handlers.get('desk:state')(event, { ...stateReport, state: 'secret text' })).code, 'invalid')
  const cursor = service.events('one', 0).cursor
  await handlers.get('desk:state')(event, stateReport)
  assert.equal(service.events('one', cursor).events.length, 0, 'duplicate state is quiet')
  assert.equal(service.events('one', 0).events.at(-1).state, 'ready')
  assert.equal(service.events('one', -1).code, 'invalid')
  assert.equal((await service.watch('one', 'start', { path: 'outside' })).code, 'watch-unavailable')
  const watched = await service.watch('one', 'start', { path: 'src' })
  assert.equal(watched.ok, true)
  const watchRecord = watchers.at(-1)
  watchRecord.watcher.emit('change', 'change', 'main.js')
  assert.deepEqual(service.events('one', cursor).events.at(-1), {
    type: 'file', watchId: watched.watchId, path: 'src', name: 'main.js', change: 'change', sequence: service.events('one', cursor).cursor
  })
  assert.equal((await service.watch('one', 'start', { path: 'src' })).watchId, watched.watchId, 'same path reuses one watcher')
  assert.equal((await service.watch('one', 'list')).watches.length, 1)
  const listing = await handlers.get('desk:watches')(event)
  assert.deepEqual(listing.watches, [{ id: watched.watchId, path: 'src', recursive: false }])
  assert.deepEqual(listing.recent.at(-1), { path: 'src', name: 'main.js', change: 'change', sequence: listing.recent.at(-1).sequence })
  // Mods count distinct files, so the observation names the file (workspace
  // display path); a watcher that gives no name names none.
  watchRecord.watcher.emit('change', 'rename', null)
  assert.deepEqual(modEvents.slice(-2), [['one', 'desk.file.changed', ['src/main.js']], ['one', 'desk.file.changed', []]])
  assert.equal((await handlers.get('desk:watches')({ ...event, senderFrame: {} })).code, 'forbidden')
  assert.equal((await handlers.get('desk:watch-stop')(event, watched.watchId)).ok, true)
  assert.equal(watchRecord.watcher.closed, true)
  assert.equal((await service.watch('one', 'list')).watches.length, 0)
  assert.equal((await service.watch('one', 'stop', { watchId: 'missing' })).code, 'not-found')
  const recursiveWatch = await service.watch('one', 'start', { path: 'src', recursive: true })
  assert.equal(recursiveWatch.recursive, true)
  assert.equal((await service.watch('one', 'start', { path: 'src' })).code, 'watch-mode-conflict')
  assert.equal((await service.watch('one', 'list')).watches[0].recursive, true)
  assert.equal((await service.watch('one', 'stop', { watchId: recursiveWatch.watchId })).ok, true)
  const failedWatch = await service.watch('one', 'start', { path: 'src' })
  watchers.at(-1).watcher.emit('error', Error('private path detail'))
  assert.equal((await service.watch('one', 'list')).watches.length, 0, 'watch errors release the watcher')
  assert.equal(service.events('one', 0).events.at(-1).type, 'watch-error')
  assert.equal(JSON.stringify(service.events('one', 0)).includes('private path detail'), false, 'watch errors do not expose OS error text')
  assert.equal(failedWatch.ok, true)
  const capacity = []
  for (const path of ['one', 'two', 'three', 'four']) capacity.push(await service.watch('one', 'start', { path }))
  assert.equal(capacity.every(result => result.ok), true)
  assert.equal((await service.watch('one', 'start', { path: 'five' })).code, 'limit', 'a Desk can watch at most four folders')
  for (const result of capacity) assert.equal((await service.watch('one', 'stop', { watchId: result.watchId })).ok, true)
  service.open('two')
  assert.equal((await service.read('two')).snapshot.blocks.length, 0)
  assert.equal((await service.apply('two', { ...c, operationId: 'cross-chat' }, 'agent:run')).code, 'resource-unavailable')
  assert.equal((await service.read('two')).snapshot.revision, 0)
  const crashedWatch = await service.watch('two', 'start', { path: 'project', recursive: true })
  const crashedWatcher = watchers.at(-1).watcher
  windows[1].webEvents['render-process-gone']()
  assert.equal(crashedWatcher.closed, true, 'renderer exit stops active watchers')
  assert.equal((await service.processes('two', 'start', { command: 'node.exe', cwd: 'C:\\workspace' })).code, 'not-open', 'renderer crash prevents new process launches')
  assert.equal((await service.watch('two', 'list')).watches.length, 0)
  assert.equal(service.events('two', 0).events.some(item => item.type === 'watch-stopped' && item.watchId === crashedWatch.watchId && item.reason === 'renderer-gone'), true)
  assert.equal((await handlers.get('desk:hold')(event, id)).ok, true)
  assert.equal((await service.apply('one', { operationId: 'held-resource', expectedRevision: 1,
    operations: [{ type: 'resource', id, resourceRef: 'artifact:one' }] }, 'agent:run')).code, 'busy')
  const remove = { operationId: 'remove', expectedRevision: 1, operations: [{ type: 'remove', id }] }
  assert.equal((await service.apply('one', remove, 'agent:run')).code, 'busy')
  const closingWatch = await service.watch('one', 'start', { path: 'src' })
  const closingWatcher = watchers.at(-1).watcher
  windows[0].events.closed()
  assert.equal(processManagers[0].state.closed, 1, 'closing Desk stops owned processes')
  assert.equal((await service.read('one')).runtime[id].state, 'stopped')
  assert.equal(closingWatcher.closed, true, 'closing Desk stops all file watchers')
  assert.equal(service.events('one', 0).events.some(item => item.type === 'watch-stopped' && item.watchId === closingWatch.watchId && item.reason === 'desk-closed'), true)
  assert.equal((await service.apply('one', remove, 'agent:run')).ok, true)
  const beforeReplay = lookups
  assert.equal((await service.apply('one', c, 'agent:run')).replayed, true)
  assert.equal(lookups, beforeReplay, 'replay must not request resource access again')
  assert.equal((await service.apply('one', { ...c, operationId: 'stale', expectedRevision: 0 }, 'agent:run')).code, 'conflict')
  assert.equal(lookups, beforeReplay, 'stale operation must not request resource access')
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal((await service.apply('one', c, 'agent:run', { signal: cancelled.signal })).code, 'aborted')
  assert.equal(lookups, beforeReplay)
  cancelWhileResolving = new AbortController()
  assert.equal((await service.apply('one', { ...c, operationId: 'cancel-midflight', expectedRevision: 2 }, 'agent:run', { signal: cancelWhileResolving.signal })).code, 'aborted')
  assert.equal((await service.read('one')).snapshot.blocks.length, 0)
  const disk = new Map()
  let writable = true
  const storage = { load: id => disk.get(id), save: (id, value) => { if (!writable) throw Error('disk full'); disk.set(id, structuredClone(value)) } }
  const options = { BrowserWindow: Window, ipcMain: { handle () {} }, isMainWindow: () => true, focusMain () {},
    settings: () => ({}), resolveResource: async () => ({ type: 'text', text: 'restored' }), storage }
  const firstProcess = createDeskService(options)
  firstProcess.open('saved')
  assert.equal((await firstProcess.apply('saved', c, 'agent:run')).ok, true)
  const secondProcess = createDeskService(options)
  assert.equal(secondProcess.open('saved').snapshot.revision, 1)
  assert.deepEqual((await secondProcess.read('saved')).snapshot, (await firstProcess.read('saved')).snapshot)
  assert.equal((await secondProcess.read('saved')).persistent, true)
  writable = false
  const savedId = disk.get('saved').blocks[0].id
  assert.equal((await secondProcess.apply('saved', { operationId: 'disk-full', expectedRevision: 1, operations: [{ type: 'remove', id: savedId }] }, 'agent:run')).code, 'storage-unavailable')
  assert.equal((await secondProcess.read('saved')).snapshot.blocks.length, 1)
  assert.equal(disk.get('saved').blocks.length, 1)
  const corrupt = createDeskService({ ...options, storage: { load: () => { throw Error('corrupt') }, save () { assert.fail('must not overwrite') } } })
  assert.equal(corrupt.open('saved').code, 'storage-unavailable')
  const updateService = createDeskService(options)
  writable = true
  updateService.open('update')
  const initial = await updateService.apply('update', c, 'agent:run')
  const target = initial.snapshot.blocks[0]
  const update = { operationId: 'replace', expectedRevision: 1, operations: [{ type: 'resource', id: target.id, resourceRef: 'artifact:updated' }] }
  assert.equal((await updateService.apply('update', update, 'agent:run')).ok, true)
  assert.equal((await updateService.read('update')).snapshot.blocks[0].resourceRef, 'artifact:updated')
  assert.deepEqual((await updateService.read('update')).snapshot.blocks[0].rect, target.rect)
  for (let i = 0; i < 260; i++) {
    const result = await updateService.apply('update', { operationId: 'move-' + i, expectedRevision: i + 2,
      operations: [{ type: 'geometry', id: target.id, rect: { ...target.rect, x: i } }] }, 'agent:run')
    assert.equal(result.ok, true)
  }
  const bounded = updateService.events('update', 0)
  assert.equal(bounded.events.length, 256)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.events.every(entry => entry.id === target.id), true)
  assert.equal((await updateService.apply('update', { ...update, operationId: 'stale-update' }, 'agent:run')).code, 'conflict')
  assert.equal(service.events('two', 0).events.some(e => e.id === id), false)
  console.log('PASS desk service: window security, resource holds, bounded events, and scoped file-watch lifecycle')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
