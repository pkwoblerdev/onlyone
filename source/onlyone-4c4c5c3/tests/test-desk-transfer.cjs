'use strict'
const assert = require('node:assert/strict')
const { createDeskModel } = require('../src/main/desk-model.cjs')
const { exportTemplate, parseTemplate, pendingResource } = require('../src/main/desk-transfer.cjs')
const rect = { x: 16, y: 24, width: 480, height: 320, z: 1 }
const model = createDeskModel({ title: 'Shared environment' })
assert.equal(model.apply({ operationId: 'setup', expectedRevision: 0, actorId: 'agent:test', operations: [
  { type: 'add', block: { kind: 'browser', title: 'Source', resourceRef: 'https://person:password@example.com/private/token?secret=key#access', rect } },
  { type: 'add', block: { kind: 'artifact', title: 'Tool', resourceRef: 'artifact:private-chat-id', rect } }
] }).ok, true)
const text = exportTemplate(model.snapshot())
assert(!text.includes('password') && !text.includes('/private') && !text.includes('secret') && !text.includes('private-chat-id'))
assert(!text.includes('resourceRef') && !text.includes('revision'))
const parsed = parseTemplate(text)
assert.equal(parsed.blocks[0].url, 'https://example.com')
assert.deepEqual(parsed.blocks[1], { kind: 'artifact', title: 'Tool', rect })
assert.equal(pendingResource(parsed.blocks[0]), 'desk-pending:browser:https://example.com')
assert.equal(pendingResource(parsed.blocks[1]), 'desk-pending:artifact')
const rejects = change => { const value = JSON.parse(text); change(value); assert.throws(() => parseTemplate(JSON.stringify(value))) }
rejects(value => { value.version = 2 })
rejects(value => { value.command = 'run' })
rejects(value => { value.blocks[0].rect.width = 10 })
rejects(value => { value.blocks[0].url = 'javascript:alert(1)' })
rejects(value => { value.blocks[0].url = 'https://example.com/private?secret=key' })
rejects(value => { value.blocks[0].resourceRef = 'artifact:private-chat-id' })
rejects(value => { value.blocks[1].url = 'https://example.com' })
rejects(value => { value.blocks = Array.from({ length: 65 }, () => value.blocks[0]) })
assert.throws(() => parseTemplate('x'.repeat(256 * 1024 + 1)))
assert.throws(() => parseTemplate('{'))
const unbound = createDeskModel({ title: 'Imported' })
unbound.apply({ operationId: 'import', expectedRevision: 0, actorId: 'human:test', operations: parsed.blocks.map(block => ({ type: 'add', block: {
  kind: block.kind, title: block.title, rect: block.rect, resourceRef: pendingResource(block)
} })) })
assert.equal(exportTemplate(unbound.snapshot()), text.replace('Shared environment', 'Imported'))
console.log('PASS Desk transfer: strict versioned templates, private-reference removal, no executable payloads, and unbound roundtrip')
