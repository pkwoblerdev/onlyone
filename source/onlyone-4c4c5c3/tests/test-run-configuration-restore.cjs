'use strict'
const assert = require('node:assert/strict')
const { createRunContext } = require('../src/main/agent-run-context')
const { register } = require('../src/main/run-configuration-restore.cjs')
const run = createRunContext({ durationMs: 1000 })
run.recordConfiguration({ model: 'fixture/model', agentIndex: 1, reasoningEffort: 'high' })
let settings = { defaultModel: 'fixture/previous', thinkingEffort: 'low', activeProvider: 'test', apiKey: 'SECRET', instructions: 'PRIVATE' }
let models = [{ id: 'fixture/model', supportedEfforts: ['low', 'high'] }], busy = false, fail = false, writes = 0, now = 100
const handlers = {}, wc = { mainFrame: {} }, event = { sender: wc, senderFrame: wc.mainFrame }
register({ ipcMain: { handle: (name, fn) => { handlers[name] = fn } }, trusted: e => e.sender === wc && e.senderFrame === wc.mainFrame,
  readRecords: () => [run.snapshot()], getSettings: () => settings, getModels: () => models, isBusy: () => busy, now: () => now,
  writeParameters: patch => { if (fail) throw Error('SECRET disk path'); writes++; settings = { ...settings, ...patch } } })
const preview = selection => handlers['preview-run-parameters'](event, selection || { runId: run.runId, configurationId: run.snapshot().configurations[0].id })
const apply = token => handlers['apply-run-parameters'](event, { token })
assert.equal(handlers['preview-run-parameters']({ sender: {}, senderFrame: wc.mainFrame }, {}).code, 'forbidden')
assert.equal(handlers['apply-run-parameters']({ sender: wc, senderFrame: {} }, {}).code, 'forbidden')
assert.equal(preview({ runId: run.runId, configurationId: 'unknown' }).code, 'missing')
const first = preview()
assert.equal(first.ok, true)
assert.deepEqual(first.after, { defaultModel: 'fixture/model', thinkingEffort: 'high' })
assert.equal(writes, 0, 'preview has no effects')
assert.equal(JSON.stringify(first).includes('SECRET'), false)
assert.equal(JSON.stringify(first).includes('PRIVATE'), false)
assert.equal(apply(first.token).ok, true)
assert.equal(writes, 1)
assert.equal(settings.apiKey, 'SECRET')
assert.equal(settings.instructions, 'PRIVATE')
assert.equal(apply(first.token).code, 'expired', 'approval cannot be replayed')
let p = preview(); settings.activeProvider = 'changed'
assert.equal(apply(p.token).code, 'changed')
p = preview(); settings.thinkingEffort = 'low'
assert.equal(apply(p.token).code, 'changed')
p = preview(); settings.providerVersion = 'edited endpoint with the same profile id'
assert.equal(apply(p.token).code, 'changed')
p = preview(); busy = true
assert.equal(apply(p.token).code, 'busy')
assert.equal(preview().code, 'busy'); busy = false
p = preview(); models = []
assert.equal(apply(p.token).code, 'unavailable')
models = [{ id: 'fixture/model', supportedEfforts: ['low'] }]
assert.equal(preview().code, 'effort')
models[0].supportedEfforts.push('high')
p = preview(); now += 300001
assert.equal(apply(p.token).code, 'expired')
p = preview(); fail = true
assert.equal(apply(p.token).code, 'write_failed')
assert.equal(writes, 1)
assert.equal(apply(p.token).code, 'expired')
fail = false
run.recordConfiguration({ model: 'fixture/model', agentIndex: 0 })
assert.equal(preview({ runId: run.runId, configurationId: run.snapshot().configurations[1].id }).code, 'effort', 'no silent effort conversion')
models[0].supportedEfforts = []
p = preview({ runId: run.runId, configurationId: run.snapshot().configurations[1].id })
assert.equal(p.after.thinkingEffort, 'off')
assert.equal(apply(p.token).ok, true)
models[0].unavailable = true
assert.equal(preview().code, 'unavailable')
console.log('PASS restoration: preview, trusted frame, archive lookup, atomic allow-list, replay/stale/provider/catalog/busy/expiry/write failure')
