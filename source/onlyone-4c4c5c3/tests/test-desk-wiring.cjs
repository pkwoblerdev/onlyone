'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')

async function run () {
  let options, storageOptions, available = true, approvals = 0, grant = true, restored = 0, processRecords = [], copied = ''
  const service = { open: id => ({ opened: id }), watch: (chatId, action, request) => ({ chatId, action, request }),
    processes: (chatId, action, request) => action === 'list' ? { ok: true, processes: processRecords } : ({ chatId, action, request }), read: () => ({ ok: true, snapshot: { revision: 1 }, resources: {
    good: { type: 'text', text: 'large result'.repeat(10000) }, missing: { type: 'unavailable' }
  }, runtime: { good: { state: 'ready' } } }), events: (chatId, since) => ({ chatId, cursor: since }), apply: (...args) => args }
  const load = id => {
    if (id === './desk-store.cjs') return { createDeskStore: input => { storageOptions = input; return {} } }
    if (id === './desk-service.cjs') return { createDeskService: input => { options = input; return service } }
    if (id === './agent-browser.js') return { validateBrowserUrl: async url => { assert.equal(url, 'https://example.com/') } }
    throw Error('Unexpected require '+id)
  }
  const snippet = main.slice(main.indexOf('let deskService = null'), main.indexOf('let artifactStore = null'))
  assert(snippet.includes('function ensureDesk()'))
  const names = ['require','BrowserWindow','ipcMain','mainWindow','store','personalSettings','panelBrowser','userBrowserTurns',
    'requestApproval','tr','ensureArtifacts','artifactPublic','createWindow','join','app','safeStorageAvailable','protectStore','unprotectStore','clipboard']
  const make = new Function(...names, snippet+'; return ensureDesk')
  const ensure = make(load, {}, {}, null, { get: () => 'en' }, () => ({ theme: 'light' }), require('../src/main/panel-browser'), new Set(),
    async () => { approvals++; return grant }, s => s,
    () => ({ readMeta: async id => ({ id, chatId: id === 'foreign' ? 'other' : 'chat', kind: id === 'text' ? 'code' : 'page' }), versionText: async () => 'result' }),
    meta => ({ url: `onecode-artifact://${meta.id}/v1.html` }), () => { restored++ }, path.join, { getPath: () => '/test-profile' }, () => available, text => 'sealed:'+text, body => body.slice(7), { writeText: text => { copied = text } })
  assert.equal(ensure(), service)
  options.writeClipboard('reviewed template'); assert.equal(copied, 'reviewed template')
  assert.equal(storageOptions.protect('private'), 'sealed:private')
  assert.equal(storageOptions.unprotect('sealed:private'), 'private')
  available = false
  assert.throws(() => storageOptions.protect('private'))
  assert.throws(() => storageOptions.unprotect('sealed:private'))
  available = true
  assert.deepEqual(options.settings(), { language: 'en', theme: 'light' })
  options.focusMain(); assert.equal(restored, 1)
  assert.equal(options.isMainWindow({ sender: {} }), null)
  assert.deepEqual(await options.resolveResource({ kind: 'artifact', resourceRef: 'artifact:page' }, 'chat', { validate: false }), { type: 'page', url: 'onecode-artifact://page/v1.html' })
  assert.deepEqual(await options.resolveResource({ kind: 'output', resourceRef: 'artifact:text' }, 'chat', { validate: false }), { type: 'text', text: 'result' })
  await assert.rejects(options.resolveResource({ kind: 'artifact', resourceRef: 'artifact:foreign' }, 'chat', { validate: false }))
  await assert.rejects(options.resolveResource({ kind: 'process', resourceRef: 'run' }, 'chat', { validate: false }))
  const browser = { kind: 'browser', resourceRef: 'https://example.com/' }
  await options.resolveResource(browser, 'chat', { validate: true, event: {}, requestId: 'run' })
  await options.resolveResource(browser, 'chat', { validate: true, event: {}, requestId: 'run' })
  assert.equal(approvals, 1, 'same turn must not ask for browser access twice')
  grant = false
  await assert.rejects(options.resolveResource(browser, 'chat', { validate: true, event: {}, requestId: 'denied' }))
  await assert.rejects(options.resolveResource({ ...browser, resourceRef: 'file:///secret' }, 'chat', { validate: true, event: {}, requestId: 'bad' }))
  assert.equal(approvals, 2)
  const route = main.slice(main.indexOf("    if (name === 'desk_workspace')"), main.indexOf("    if (name === 'show_artifact')", main.indexOf("    if (name === 'desk_workspace')")))
  const dispatch = new Function('name','args','turnHere','ensureDesk','requestId','event','signal',
    'assertSafeWorkspacePath','fs','relativeDisplay','requireMutationApproval','workspaceRoots = () => []','isInside = () => true',
    'return (async () => {'+route+'})()')
  assert.deepEqual(await dispatch('desk_workspace', { action: 'open' }, () => ({ chatId: 'chat' }), ensure, 'run', {}, null), { opened: 'chat' })
  assert.equal((await dispatch('desk_workspace', { action: 'open' }, () => null, ensure, 'run', {}, null)).code, 'chat-required')
  assert.deepEqual(await dispatch('desk_workspace', { action: 'read' }, () => ({ chatId: 'chat' }), ensure, 'run', {}, null),
    { ok: true, snapshot: { revision: 1 }, runtime: { good: { state: 'ready' } }, unavailable: ['missing'], processes: [] })
  assert.deepEqual(await dispatch('desk_workspace', { action: 'events', since: 7 }, () => ({ chatId: 'chat' }), ensure, 'run', {}, null), { chatId: 'chat', cursor: 7 })
  assert.deepEqual(await dispatch('desk_workspace', { action: 'watch', watch_action: 'list' }, () => ({ chatId: 'chat' }), ensure, 'run', {}, null),
    { chatId: 'chat', action: 'list', request: { path: undefined, watchId: undefined, recursive: undefined } })
  let watchAllowed = false, watchPrompts = 0
  const watchPath = async value => { assert.equal(value, 'src'); return '/workspace/src' }
  const watchApproval = async (_event, summary, details, _diff, risk, _requestId, _signal, force) => {
    watchPrompts++
    assert.equal(summary, 'Следить за файлами проекта')
    assert.equal(risk, 'read')
    assert.equal(force, true)
    assert(details.includes('подкаталогах'))
    return watchAllowed
  }
  const recursiveStart = { action: 'watch', watch_action: 'start', path: 'src', recursive: true }
  assert.deepEqual(await dispatch('desk_workspace', recursiveStart, () => ({ chatId: 'chat' }), ensure, 'run', {}, null,
    watchPath, { stat: async () => ({ isDirectory: () => true }) }, () => 'src', watchApproval), { ok: false, code: 'denied' })
  watchAllowed = true
  assert.deepEqual(await dispatch('desk_workspace', recursiveStart, () => ({ chatId: 'chat' }), ensure, 'run', {}, null,
    watchPath, { stat: async () => ({ isDirectory: () => true }) }, () => 'src', watchApproval),
  { chatId: 'chat', action: 'start', request: { path: 'src', watchId: undefined, recursive: true } })
  assert.equal(watchPrompts, 2)
  let processAllowed = false, processPrompts = 0
  const processApproval = async (_event, summary, details, _diff, risk, _requestId, _signal, force) => {
    processPrompts++
    assert.equal(summary, 'Запустить локальную программу')
    assert.match(details, /node\.exe/)
    assert.match(details, /"--version"/)
    assert.equal(risk, 'edit')
    assert.equal(force, true)
    return processAllowed
  }
  const processStart = { action: 'process', process_action: 'start', command: 'node.exe', args: ['--version'], path: 'src' }
  const processPath = async value => { assert.equal(value, 'src'); return '/workspace/src' }
  const processFs = { realpath: async value => value, stat: async () => ({ isDirectory: () => true }) }
  const roots = () => ['/workspace']
  const inside = (root, target) => target === root || target.startsWith(root + '/')
  assert.deepEqual(await dispatch('desk_workspace', processStart, () => ({ chatId: 'chat' }), ensure, 'run', {}, null,
    processPath, processFs, () => 'src', processApproval, roots, inside), { ok: false, code: 'denied' })
  processAllowed = true
  const processResult = await dispatch('desk_workspace', processStart, () => ({ chatId: 'chat' }), ensure, 'run', {}, null,
    processPath, processFs, () => 'src', processApproval, roots, inside)
  assert.equal(processResult.chatId, 'chat')
  assert.equal(processResult.action, 'start')
  assert.equal(processResult.request.command, 'node.exe')
  assert.deepEqual(processResult.request.args, ['--version'])
  assert.equal(processResult.request.cwd, '/workspace/src')
  assert.equal(Object.hasOwn(processResult.request.env, 'OPENAI_API_KEY'), false)
  assert.equal(processPrompts, 2)
  const cancelled = new AbortController(); cancelled.abort()
  assert.deepEqual(await dispatch('desk_workspace', processStart, () => ({ chatId: 'chat' }), ensure, 'cancelled', {}, cancelled.signal,
    processPath, processFs, () => 'src', processApproval, roots, inside), { ok: false, code: 'aborted' })
  const promptCount = processPrompts
  const escaped = await dispatch('desk_workspace', processStart, () => ({ chatId: 'chat' }), ensure, 'run', {}, null,
    async () => '/outside', { realpath: async value => value, stat: async () => ({ isDirectory: () => true }) }, () => 'outside', processApproval, roots, inside)
  assert.deepEqual(escaped, { ok: false, code: 'outside-workspace' })
  assert.equal(processPrompts, promptCount, 'outside-workspace paths are rejected before approval')
  let activityTarget = ''
  service.agent = (_chatId, _requestId, activity) => { if (activity) activityTarget = activity.target }
  const credential = 'sk-fixture-boundary-private-1234567890'
  await dispatch('desk_workspace', { ...processStart, args: ['--version', 'x'.repeat(180), credential] },
    () => ({ chatId: 'chat' }), ensure, 'boundary', {}, null, processPath, processFs, () => 'src', async () => false, roots, inside)
  assert(activityTarget.includes(credential), 'keep full credentials until Desk service redacts before truncating')
  delete service.agent
  processRecords = [{ id: 'process-1', command: 'node.exe', pid: 42, cwd: '/workspace/src', state: 'running' }]
  let stopAllowed = false, stopPrompts = 0
  const stopApproval = async (_event, summary, details, _diff, risk, _requestId, _signal, force) => {
    stopPrompts++
    assert.equal(summary, 'Остановить локальный процесс')
    assert.match(details, /PID: 42/)
    assert.equal(risk, 'edit'); assert.equal(force, true)
    return stopAllowed
  }
  const processStop = { action: 'process', process_action: 'stop', process_id: 'process-1' }
  assert.deepEqual(await dispatch('desk_workspace', processStop, () => ({ chatId: 'chat' }), ensure, 'run', {}, null,
    undefined, undefined, undefined, stopApproval), { ok: false, code: 'denied' })
  stopAllowed = true
  assert.deepEqual(await dispatch('desk_workspace', processStop, () => ({ chatId: 'chat' }), ensure, 'run', {}, null,
    undefined, undefined, undefined, stopApproval), { chatId: 'chat', action: 'stop', request: { id: 'process-1' } })
  assert.equal(stopPrompts, 2)
  const result = await dispatch('desk_workspace', { action: 'apply', operation_id: 'op', expected_revision: 2, operations: [] }, () => ({ chatId: 'chat' }), ensure, 'run', {}, null)
  assert.equal(result[0], 'chat'); assert.equal(result[1].expectedRevision, 2); assert.equal(result[2], 'agent:run')
  const html = fs.readFileSync(path.join(root,'src/renderer/desk.html'),'utf8')
  assert(!/<(?:input|textarea)\b/.test(html.replace(/<dialog\b[\s\S]*?<\/dialog>/g, '')), 'text fields belong only to the explicit layout transfer dialog')
  const preload = fs.readFileSync(path.join(root,'src/preload/desk.js'),'utf8')
  assert(!/sendMessage|runCommand|readFile|writeFile/.test(preload))
  const deskTool = require('../src/main/desk-tools.cjs').deskToolSchemas[0].function
  assert(deskTool.parameters.properties.action.enum.includes('watch'))
  assert.deepEqual(deskTool.parameters.properties.watch_action.enum, ['start', 'list', 'stop'])
  assert.equal(deskTool.parameters.properties.recursive.type, 'boolean')
  assert(deskTool.parameters.properties.action.enum.includes('process'))
  assert.deepEqual(deskTool.parameters.properties.process_action.enum, ['start', 'list', 'stop'])
  assert.equal(deskTool.parameters.properties.args.type, 'array')
  console.log('PASS Desk wiring: real main callbacks, resource/chat boundary, browser approval, dispatcher, no composer or privileged child API')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
