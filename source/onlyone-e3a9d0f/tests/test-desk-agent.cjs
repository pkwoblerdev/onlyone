'use strict'
// Ход агента в окне Desk: что он делает и где, пауза, план сборки и процесс как блок холста.
const assert = require('node:assert/strict')
const { createDeskService } = require('../src/main/desk-service.cjs')

async function main () {
  const handlers = new Map(), windows = [], stopped = [], marks = []
  const guest = { isDestroyed: () => false, getURL: () => 'https://shop.local/',
    executeJavaScript: async script => { const request = JSON.parse(script.slice(script.lastIndexOf('})(') + 3, -1)); marks.push([request.selector, request.tone || null]); return { ok: true } } }
  const items = []
  class Window {
    constructor (options) {
      this.options = options; this.events = {}; this.sent = []
      this.webContents = { id: windows.length + 10, mainFrame: {}, send: channel => this.sent.push(channel), on () {}, setWindowOpenHandler () {}, isDestroyed: () => false }
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
  const service = createDeskService({ BrowserWindow: Window, ipcMain: { handle: (id, fn) => handlers.set(id, fn) },
    isMainWindow: () => true, focusMain () {}, settings: () => ({ language: 'ru', theme: 'dark' }),
    resolveResource: async block => {
      if (block.kind === 'process') throw Error('process reached the outer resolver')
      return { type: 'page', url: 'onecode-artifact://one/v1.html' }
    },
    createProcessManager: () => ({ list: () => items, start: async () => ({ ok: true }), stop: async () => ({ ok: true }), closeAll: async () => {}, onChange () {} }),
    stopAgent: requestId => stopped.push(requestId), lookupGuest: id => id === 7 ? guest : null })
  assert.equal(service.open('one').ok, true)
  const win = windows[0]
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const read = () => handlers.get('desk:read')(event)
  const rect = (x, y) => ({ x, y, width: 480, height: 320, z: 1 })
  const add = (operationId, expectedRevision, block) => service.apply('one', { operationId, expectedRevision, operations: [{ type: 'add', block }] }, 'agent:run')

  // Без хода строки агента нет, а пауза без агента ничего не держит.
  assert.equal((await read()).agent, null)
  assert.equal((await handlers.get('desk:pause')(event, true)).code, 'idle')
  assert.equal(await service.gate('one'), true)

  // План: проверка формы, контуры шагов, добавленный блок закрывает свой шаг.
  assert.equal(service.plan('one', 'run', [{ kind: 'artifact', title: 'X', rect: { x: 0, y: 0, width: 10, height: 10 } }]).code, 'invalid')
  assert.equal(service.plan('one', 'run', [{ kind: 'shell', title: 'X', rect: rect(0, 0) }]).code, 'invalid')
  assert.equal(service.plan('one', 'run', [
    { kind: 'artifact', title: 'Выручка', rect: rect(16, 16) },
    { kind: 'process', title: 'npm run dev', rect: rect(16, 352), note: 'спросит разрешение' }
  ]).steps, 2)
  let view = await read()
  assert.equal(view.agent.mode, 'building'); assert.equal(view.agent.steps, 2); assert.equal(view.agent.step, 0)
  assert.deepEqual(view.agent.plan.map(item => [item.step, item.title, item.done]), [[1, 'Выручка', false], [2, 'npm run dev', false]])
  assert(win.sent.includes('desk:changed'), 'план сразу виден окну')
  assert.equal((await add('a1', 0, { kind: 'artifact', title: 'Выручка', resourceRef: 'artifact:one', rect: rect(16, 16) })).ok, true)
  view = await read()
  assert.equal(view.agent.step, 1); assert.equal(view.agent.plan[0].done, true)

  // Процесс-блок: ресурс «process:<id>» проверяет сам Desk по своему менеджеру.
  assert.equal((await add('p0', 1, { kind: 'process', title: 'npm run dev', resourceRef: 'process:nope', rect: rect(16, 352) })).code, 'resource-unavailable')
  items.push({ id: 'p1', command: 'npm', args: ['run', 'dev'], cwd: 'C:\\work\\shop-api', state: 'running', output: 'ready in 412 ms', canStop: true })
  assert.equal((await add('p1', 1, { kind: 'process', title: 'npm run dev', resourceRef: 'process:p1', rect: rect(16, 352) })).ok, true)
  view = await read()
  const processBlock = view.snapshot.blocks.find(block => block.kind === 'process')
  assert.deepEqual(view.resources[processBlock.id], { type: 'process', id: 'p1', command: 'npm', args: ['run', 'dev'], cwd: 'C:\\work\\shop-api', state: 'running', output: 'ready in 412 ms', canStop: true })
  assert.equal(view.runtime[processBlock.id].state, 'ready')
  assert.equal(view.agent, null, 'последний шаг плана снимает сборку')
  items[0].state = 'exited'
  assert.equal((await read()).runtime[processBlock.id].state, 'stopped')
  items.length = 0
  view = await read()
  assert.deepEqual(view.resources[processBlock.id], { type: 'process', id: 'p1', gone: true })
  assert.equal(view.runtime[processBlock.id].state, 'stopped')

  // Действие агента: ждёт ответа, потом действует; цель — только существующий блок.
  const target = view.snapshot.blocks.find(block => block.kind === 'artifact').id
  assert.equal(service.agent('one', 'run', { mode: 'busy', action: 'click' }).code, 'invalid')
  assert.equal(service.agent('one', 'run', { mode: 'waiting', action: 'click', target: 'Выручка', blockId: target }).ok, true)
  view = await read()
  assert.equal(view.agent.mode, 'waiting'); assert.equal(view.agent.blockId, target); assert.equal(view.agent.target, 'Выручка')
  service.agent('one', 'run', { mode: 'acting', action: 'fill', target: 'Выручка', blockId: 'gone' })
  assert.equal((await read()).agent.blockId, null)

  // Пауза держит следующее действие агента, пока человек не продолжит; отмена хода её снимает.
  assert.deepEqual(await handlers.get('desk:pause')(event, true), { ok: true, paused: true })
  let released = null
  const held = service.gate('one').then(value => { released = value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(released, null)
  assert.equal((await read()).agent.paused, true)
  await handlers.get('desk:pause')(event, false)
  await held
  assert.equal(released, true)
  await handlers.get('desk:pause')(event, true)
  const cancel = new AbortController()
  const aborted = service.gate('one', cancel.signal)
  cancel.abort()
  assert.equal(await aborted, false)
  await handlers.get('desk:pause')(event, false)

  // «Остановить сборку» снимает план и отменяет ход, который её ведёт.
  service.plan('one', 'run-2', [{ kind: 'browser', title: 'Админка', rect: rect(16, 16) }])
  assert.deepEqual(await handlers.get('desk:stop-build')(event), { ok: true })
  assert.deepEqual(stopped, ['run-2'])
  assert.equal((await read()).agent, null)
  assert.equal((await handlers.get('desk:stop-build')(event)).code, 'idle')

  // Конец хода стирает строку агента и отпускает паузу.
  service.agent('one', 'run-3', { mode: 'acting', action: 'scroll', target: 'Выручка', blockId: target })
  await handlers.get('desk:pause')(event, true)
  const late = service.gate('one')
  service.endTurn('other-run')
  assert.equal((await read()).agent.paused, true, 'чужой ход Desk не трогает')
  service.endTurn('run-3')
  assert.equal(await late, true)
  assert.equal((await read()).agent, null)

  // Окно чужого кадра не управляет ходом.
  assert.equal((await handlers.get('desk:pause')({ ...event, senderFrame: {} }, true)).code, 'forbidden')
  assert.equal((await handlers.get('desk:stop-build')({ ...event, senderFrame: {} })).code, 'forbidden')
  // Поле-цель в сайте обводится вместе со строкой агента: жёлтым, пока ждёт ответа, акцентом, пока действует.
  guest.hostWebContents = win.webContents
  const siteAdded = await add('site', (await read()).snapshot.revision, { kind: 'browser', title: 'Админка', resourceRef: 'https://shop.local/', rect: rect(560, 16) })
  const siteBlock = siteAdded.snapshot.blocks.find(block => block.kind === 'browser')
  assert.equal((await handlers.get('desk:guest')(event, { id: siteBlock.id, revision: siteBlock.revision, guestId: 7 })).ok, true)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  service.agent('one', 'run-4', { mode: 'waiting', action: 'fill', target: 'Админка', blockId: siteBlock.id, selector: '#q' })
  await settle()
  service.agent('one', 'run-4', { mode: 'acting', action: 'fill', target: 'Админка', blockId: siteBlock.id, selector: '#q' })
  await settle()
  await handlers.get('desk:pause')(event, true)
  await settle()
  await handlers.get('desk:pause')(event, false)
  await settle()
  service.endTurn('run-4')
  await settle()
  assert.deepEqual(marks, [['#q', 'warn'], ['#q', 'acc'], ['', null], ['#q', 'acc'], ['', null]])
  marks.length = 0
  service.agent('one', 'run-5', { mode: 'acting', action: 'scroll', target: 'Админка', blockId: siteBlock.id })
  await settle()
  assert.deepEqual(marks, [], 'без селектора обводить нечего')
  service.endTurn('run-5')
  const secret = 'sk-fixture-desk-header-private-1234567890'
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal(await service.gate('one', cancelled.signal), false, 'cancelled turns must not pass an unpaused gate')
  service.agent('one', 'run-private', { mode: 'waiting', action: 'process', target: 'node --token ' + secret })
  assert.equal(JSON.stringify((await read()).agent).includes(secret), false, 'activity header must mask process credentials')
  service.endTurn('run-private')
  console.log('PASS desk agent: status line, pause gate, build plan, stop build, process blocks, field mark')
}

main().catch(error => { console.error(error); process.exit(1) })
