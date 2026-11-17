'use strict'
const assert = require('node:assert/strict')
const { snapshot, child } = require('../src/renderer/chat-forks.js')
const source = { id: 'parent', title: 'Project', projectId: 'project', remote: true,
  messages: [
    { role: 'user', content: 'First', timestamp: 1, attachments: [{ path: 'private' }] },
    { role: 'assistant', content: 'Answer', timestamp: 2, undoId: 'undo', runId: 'run', blocks: [{ secret: true }] },
    { role: 'tool', content: 'tool output' },
    { role: 'user', content: [{ type: 'text', text: 'Second' }, { type: 'image_url', image_url: { url: 'private' } }] }
  ] }
const before = JSON.stringify(source)
const snap = snapshot(source, 1)
assert.equal(snap.messages.length, 2)
const fork = child(source, snap, 'Branch', 'new-id', 5)
assert.equal(fork.fork.parentChatId, 'parent')
assert.equal(fork.fork.sourceMessageIndex, 1)
assert.equal(fork.projectId, 'project')
assert.equal(fork.remote, undefined)
assert.equal(fork.messages[1].undoId, undefined)
assert.equal(fork.messages[1].blocks, undefined)
assert.deepEqual(Object.keys(fork.messages[1]).sort(), ['content', 'role', 'timestamp'])
fork.messages[0].content = 'Changed'
assert.equal(source.messages[0].content, 'First')
assert.equal(snap.messages[0].content, 'First')
assert.equal(JSON.stringify(source), before)
assert.equal(snapshot(source, 3).messages.at(-1).content, 'Second')
assert.equal(snapshot(source, 3).omitted, true)
assert.throws(() => snapshot(source, -1))
assert.throws(() => snapshot(source, 99))
assert.throws(() => snapshot({ id: 'empty', messages: [] }))
assert.throws(() => child(source, snap, ' ', 'new-id', 5))
assert.throws(() => child(source, snap, 'Branch', 'parent', 5))
source.messages[1].content = 'Edited after preview'
assert.throws(() => child(source, snap, 'Branch', 'new-id', 5), /changed/)
source.messages[1].content = 'Answer'
source.messages.push({role:'user',content:'Later'})
assert.equal(child(source, snap, 'Branch', 'new-id', 5).messages.length, 2)
console.log('PASS: fork boundary, detached text, no execution metadata, stale preview, validation')

const fs = require('node:fs'), vm = require('node:vm')
const app = fs.readFileSync(require('node:path').join(__dirname, '../src/renderer/app.js'), 'utf8')
const forkCode = app.slice(app.indexOf('  let forkInProgress = false'), app.indexOf('  // Lives here rather than inside the listener setup:'))
function controller (answer = true) {
  let finish
  const toasts = [], chats = [{ id: 'source', title: 'Source', messages: [{ role: 'user', content: 'Keep me' }] }]
  const preview = { calls: [], answer }
  const api = vm.runInNewContext(forkCode + '\n({forkChat})', {
    conversations: chats, historyUnavailable: false, panes: [{}], activePane: {},
    OnlyoneChatForks: { snapshot, child }, crypto: { randomUUID: () => 'fork' },
    OnlyoneForkPreview: { open: options => { preview.calls.push(options); return Promise.resolve(preview.answer) } },
    document: { activeElement: null },
    saveConversations () {}, flushConversations: () => new Promise(resolve => { finish = resolve }),
    selectChat () {}, renderChatHistory () {}, renderProjects () {}, queueMicrotask,
    showToast: message => toasts.push(message), t: message => message
  })
  return { api, chats, toasts, preview, finish: value => finish(value) }
}
;(async () => {
  for (const saved of [true, false]) {
    const state = controller(), pending = state.api.forkChat('source')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.preview.calls.length, 1, 'fork asks for a preview first')
    const call = state.preview.calls[0]
    assert.equal(call.name, 'Source', 'preview shows the new session name')
    assert.equal(call.end, 0, 'preview shows the branch point')
    assert.deepEqual([call.total, call.copied, call.omitted], [1, 1, false], 'preview states what is copied')
    assert.equal(state.toasts.length, 0, 'no success before storage acknowledges the fork')
    state.api.forkChat('source')
    assert.equal(state.preview.calls.length, 1, 'duplicate stays blocked while the preview is open')
    state.finish(saved); await pending
    assert.equal(state.chats.length, 2, 'confirming creates exactly one fork')
    assert.equal(state.toasts.some(message => message.startsWith('Форк создан.')), saved)
    assert.equal(state.toasts.some(message => message.includes('не сохранён')), !saved)
    assert.equal(state.chats[1].messages[0].content, 'Keep me', 'parent intact after save or refusal')
  }
  const cancelled = controller(false), cancelling = cancelled.api.forkChat('source')
  await new Promise(resolve => setImmediate(resolve))
  await cancelling
  assert.equal(cancelled.chats.length, 1, 'refusing the preview creates nothing')
  assert.equal(cancelled.toasts.length, 0, 'refusing the preview is silent')
  cancelled.api.forkChat('source')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled.preview.calls.length, 2, 'refusal releases the guard for the next attempt')
  const flushCode = app.slice(app.indexOf('  async function flushConversations()'), app.indexOf('  // Closing the window must not lose the last turn.'))
  for (const saved of [true, false]) {
    let delay
    const store = vm.runInNewContext(flushCode + '\n({flushConversations,state:()=>({savePending,saveFailures})})', {
      savePending: true, historyUnavailable: false, saveFailures: 0, saveTimer: null, conversations: [],
      window: { electronAPI: { async setConversations () { if (!saved) throw Error('disk refused') } } },
      console: { error () {} }, showToast () {}, clearTimeout () {}, setTimeout (_fn, ms) { delay = ms }
    })
    assert.equal(await store.flushConversations(), saved, 'storage acknowledgement reaches the caller')
    assert.equal(store.state().savePending, !saved, 'refused save stays pending for retry')
    assert.equal(store.state().saveFailures, saved ? 0 : 1)
    if (!saved) assert.equal(delay, 4000, 'existing retry schedule preserved')
  }
  const main = fs.readFileSync(require('node:path').join(__dirname, '../src/main/main.js'), 'utf8')
  const ipcCode = main.slice(main.indexOf("ipcMain.handle('set-conversations'"), main.indexOf('// One-time hand-off'))
  let handler, finishWrite, flushed = false, acknowledged = false
  vm.runInNewContext(ipcCode, {
    ipcMain: { handle (_name, fn) { handler = fn } }, writeSecure () {}, historyGuard: { reconcile: (_id, list) => list },
    bulk: () => ({ flush () { flushed = true; return new Promise(resolve => { finishWrite = resolve }) } })
  })
  const pending = handler({ sender: { id: 1 } }, []).then(() => { acknowledged = true })
  await Promise.resolve()
  assert.equal(acknowledged, false, 'IPC cannot acknowledge before disk write finishes')
  assert.equal(flushed, true, 'conversation write must flush the protected store')
  finishWrite(); await pending
  vm.runInNewContext(ipcCode, {
    ipcMain: { handle (_name, fn) { handler = fn } }, writeSecure () {}, historyGuard: { reconcile: (_id, list) => list },
    bulk: () => ({ async flush () { throw Error('disk refused') } })
  })
  await assert.rejects(handler({ sender: { id: 1 } }, []), /disk refused/, 'disk error must reach renderer retry logic')
  console.log('PASS: fork waits for persistence, warns on refusal and blocks duplicate writes')
})().catch(error => { console.error(error); process.exitCode = 1 })
