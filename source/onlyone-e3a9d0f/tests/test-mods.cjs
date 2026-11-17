'use strict'
const assert = require('node:assert/strict')
const { validatePackage, samplePackage, createMods } = require('../src/main/mods.cjs')
let saved = null, failWrite = false, notifications = 0, time = 100
const storage = { load: () => saved, save: value => { if (failWrite) throw Error('PRIVATE disk failure'); saved = structuredClone(value) } }
const build = () => createMods({ storage, now: () => time, changed: () => { notifications++ } })
const service = build(), pack = samplePackage('diagnostics')
assert.equal(validatePackage(pack).id, 'onlyone.project-checks')
for (const changed of [{ ...pack, code: 'process.exit()' }, { ...pack, permissions: [] }, { ...pack, apiVersion: 99 }, { ...pack, id: '../escape' }]) assert.throws(() => validatePackage(changed))
assert.throws(() => validatePackage({ ...pack, panels: [{ ...pack.panels[0], buttons: [{ id: 'run', label: 'Run', action: { type: 'shell', command: 'dir' } }] }] }))
assert.throws(() => validatePackage({ ...pack, rules: [{ event: 'check.failed', panelId: 'checks', text: 'x', emit: 'check.failed' }] }))
let preview = service.preview({ package: pack })
assert.equal(preview.ok, true); assert.equal(service.list().mods.length, 0)
assert.equal(service.commit(preview.token).ok, true)
assert.equal(service.commit(preview.token).code, 'expired')
assert.equal(build().list().mods[0].enabled, true, 'state survives storage roundtrip')
let state = service.list()
assert.equal(service.toggle(pack.id, false, state.revision - 1).code, 'conflict')
service.event('chat-a', 'files.changed')
assert.equal(service.panels('chat-a', 'desk').panels[0].status.tone, 'warning')
assert.equal(service.panels('chat-b', 'desk').panels[0].status, null)
service.event('chat-a', 'check.failed', { tool: 'run_command' })
const snapshot = service.panels('chat-a', 'main')
assert.equal(snapshot.chatId, 'chat-a', 'panels reply names its chat, so trends stay per chat')
assert.equal(snapshot.panels[0].status.skillId, 'diagnostics')
assert.deepEqual(Object.keys(service.list().diagnostics[0]).sort(), ['at', 'type'], 'diagnostics carry only the event type and time')
const request = { modId: pack.id, panelId: 'checks', buttonId: 'test', revision: snapshot.revision }
let action = service.action('chat-a', request)
assert.equal(action.ok, true); assert.equal(action.type, 'draft'); assert.equal(action.skillId, 'diagnostics')
assert.equal(service.action('chat-b', { ...request, suggestion: true }).code, 'missing', 'suggestions are scoped to their chat')
assert.equal(service.toggle(pack.id, false, service.list().revision).ok, true)
assert.equal(service.panels('chat-a', 'main').panels.length, 0)
assert.equal(service.action('chat-a', request).ok, false)
service.toggle(pack.id, true, service.list().revision)
assert.equal(service.panels('chat-a', 'main').panels[0].status, null, 'reenabling does not resurrect old automatic state')
assert.throws(() => validatePackage({...pack,version:['1.0.0']}), 'version is a string, never a coercible array')
assert.throws(() => validatePackage({...pack,description:false}), 'provided description is text')
assert.throws(() => validatePackage({...pack,panels:pack.panels.map(p=>({...p,body:0}))}), 'provided panel body is text')
assert.throws(() => validatePackage({...pack,panels:pack.panels.map(p=>({...p,metrics:false}))}), 'provided metrics are an array')
assert.throws(() => validatePackage({...pack,name:'Checks\u202Egnp.exe'}), 'bidirectional overrides are not package text')
assert.throws(() => validatePackage({...pack,description:'x\u007f'}), 'DEL is not package text')
const upgraded = { ...pack, version: '1.1.0', description: 'second revision' }
preview = service.preview({ package: upgraded }); failWrite = true
assert.equal(service.commit(preview.token).code, 'write-failed'); assert.equal(service.list().mods[0].package.version, '1.0.0')
failWrite = false
preview = service.preview({ package: upgraded }); time += 300001
assert.equal(service.commit(preview.token).code, 'expired')
preview = service.preview({ package: upgraded }); service.toggle(pack.id, false, service.list().revision)
assert.equal(service.commit(preview.token).code, 'conflict')
preview = service.preview({ package: upgraded }); assert.equal(service.commit(preview.token).ok, true)
assert.equal(service.list().mods[0].history.length, 1)
preview = service.preview({ rollback: pack.id }); assert.equal(preview.package.version, '1.0.0')
assert.equal(service.commit(preview.token).ok, true)
assert.equal(service.list().mods[0].package.version, '1.0.0')
assert.equal(service.preview({ package: { ...pack, description: 'changed with the same version' } }).code, 'same-version')
assert.equal(service.remove(pack.id, service.list().revision).ok, true)
assert.equal(service.panels('chat-a', 'main').panels.length, 0)
const lru = createMods({ storage: { load: () => null, save: () => {} }, now: () => time })
const lruPreview = lru.preview({ package: pack }); lru.commit(lruPreview.token)
for (let i = 1; i <= 32; i++) lru.event('lru-' + i, 'files.changed', ['C:/w/a.txt'])
for (let i = 1; i <= 32; i++) lru.panels('read-' + i, 'main')
assert.equal(lru.panels('lru-1', 'main').panels[0].counts.files, 1, 'reading panels does not squeeze a live chat out')
lru.event('lru-1', 'files.changed', ['C:/w/b.txt'])
lru.event('lru-33', 'files.changed', ['C:/w/a.txt'])
assert.equal(lru.panels('lru-1', 'main').panels[0].counts.files, 2, 'a recently used chat is not the first evicted')
assert.ok(notifications > 0)

// «files» counts distinct files, not observations: rewriting a file, the agent
// and Desk seeing the same save, or a watcher firing twice are one file.
lru.event('unique', 'files.changed', ['C:/w/a.txt'])
lru.event('unique', 'files.changed', ['C:/w/a.txt'])
lru.event('unique', 'desk.file.changed', ['C:/w/a.txt'])
assert.equal(lru.panels('unique', 'main').panels[0].counts.files, 1, 'one file written three times is one changed file')
lru.event('unique', 'files.changed', ['C:/w/old.txt', 'C:/w/new.txt'])
assert.equal(lru.panels('unique', 'main').panels[0].counts.files, 3, 'a move changes its source and its destination')
lru.event('unique', 'desk.file.changed')
const unnamed = lru.panels('unique', 'main').panels[0]
assert.equal(unnamed.counts.files, 3, 'an event without a file name cannot be counted as a new file')
assert.equal(unnamed.status.tone, 'warning', 'but it still reaches the rule')
assert.equal(JSON.stringify(lru.list()).includes('a.txt'), false, 'paths are never kept or listed')
lru.event('unique', 'files.changed', Array.from({ length: 50 }, (_, i) => 'C:/w/batch-' + i))
assert.equal(lru.panels('unique', 'main').panels[0].counts.files, 11, 'one event names at most eight files')

// A damaged mods.json is archived before anything replaces it; valid mods are kept.
const recoveryCase = (load, extra = {}) => {
  const calls = { archive: 0, saved: [] }
  const store = { load, save: value => calls.saved.push(structuredClone(value)), archive: () => { calls.archive++; return 'mods.damaged-0123456789ab.json' }, ...extra }
  return { calls, build: () => createMods({ storage: store, now: () => time }) }
}
const damage = () => { throw Object.assign(Error('mods-store-damaged'), { code: 'mods-store-damaged' }) }
let damaged = recoveryCase(damage)
let recovered = damaged.build()
assert.equal(damaged.calls.archive, 1); assert.equal(damaged.calls.saved.length, 1)
assert.deepEqual(damaged.calls.saved[0].mods, [])
assert.deepEqual(recovered.list().recovery, { archive: 'mods.damaged-0123456789ab.json', restored: 0, dropped: null })
const installed = recovered.preview({ package: pack }); assert.equal(recovered.commit(installed.token).ok, true, 'mods can be installed again after recovery')
const other = validatePackage({ ...pack, id: 'onlyone.other', name: 'Other' })
damaged = recoveryCase(() => ({ schemaVersion: 1, revision: 7, mods: [
  { package: pack, enabled: true, history: [{ ...pack, version: '0.9.0' }, { broken: true }] },
  { package: { ...pack, id: '../escape' }, enabled: true, history: [] },
  { package: other, enabled: 'yes', history: [] },
  { package: pack, enabled: false, history: [] }] }))
recovered = damaged.build()
assert.equal(damaged.calls.archive, 1, 'the original is archived even when most of it survives')
assert.deepEqual(recovered.list().recovery, { archive: 'mods.damaged-0123456789ab.json', restored: 2, dropped: 2 })
assert.deepEqual(recovered.list().mods.map(item => [item.package.id, item.enabled, item.history.length]), [[pack.id, true, 1], ['onlyone.other', false, 0]],
  'a broken history entry drops alone; an unclear switch means disabled; a duplicate is dropped')
assert.equal(recovered.list().revision, 8, 'a stale action from before the damage cannot match the new revision')
assert.equal(recovered.panels('chat-a', 'main').panels.length, 1, 'the surviving enabled mod still shows its panel')
damaged = recoveryCase(() => ({ schemaVersion: 1, revision: 'x', mods: 'x' }))
assert.deepEqual(damaged.build().list().recovery, { archive: 'mods.damaged-0123456789ab.json', restored: 0, dropped: null })
assert.equal(damaged.calls.saved[0].revision, 1)
// Nothing is replaced without a copy, and an encryption outage is not damage.
damaged = recoveryCase(damage, { archive: () => { throw Error('ENOSPC') } })
assert.throws(() => damaged.build()); assert.equal(damaged.calls.saved.length, 0, 'no archive, no replacement')
damaged = recoveryCase(damage, { archive: undefined })
assert.throws(() => damaged.build()); assert.equal(damaged.calls.saved.length, 0, 'storage without an archive is never reset')
damaged = recoveryCase(() => { throw Object.assign(Error('later'), { code: 'mods-encryption-unavailable' }) })
assert.throws(() => damaged.build()); assert.equal(damaged.calls.archive, 0); assert.equal(damaged.calls.saved.length, 0)
damaged = recoveryCase(() => { throw Object.assign(Error('EBUSY'), { code: 'EBUSY' }) })
assert.throws(() => damaged.build()); assert.equal(damaged.calls.archive, 0, 'a busy file is not damage')
assert.equal(build().list().recovery, null, 'a healthy file reports no recovery')
console.log('PASS Mods: strict API/permissions, no executable actions, preview/replay/stale/expiry, atomic failure, scoped events, distinct changed files, damaged-state archive and recovery, enable/remove, update and rollback')
