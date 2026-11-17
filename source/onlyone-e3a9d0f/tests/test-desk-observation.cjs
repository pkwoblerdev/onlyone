'use strict'
const assert = require('node:assert/strict')
const { createDeskObservation, pageScript } = require('../src/main/desk-observation.cjs')
async function main () {
  const host = { id: 1 }, guest = { id: 2, hostWebContents: host, isDestroyed: () => false,
    getURL: () => 'https://example.com/', executeJavaScript: async script => { assert(script.includes('password')); return { ok: true, elements: [] } } }
  const observe = createDeskObservation({ lookup: id => id === 2 ? guest : null })
  const record = { window: { isDestroyed: () => false, webContents: host }, rendererGone: false,
    model: { snapshot: () => ({ revision: 3, blocks: [{ id: 'b', kind: 'browser', revision: 2 }] }) } }
  assert.equal(observe.register(record, { id: 'b', revision: 2, guestId: 99 }).code, 'forbidden')
  guest.hostWebContents = {}
  assert.equal(observe.register(record, { id: 'b', revision: 2, guestId: 2 }).code, 'forbidden')
  guest.hostWebContents = host
  assert.equal(observe.register(record, { id: 'b', revision: 1, guestId: 2 }).code, 'conflict')
  assert.equal(observe.register(record, { id: 'b', revision: 2, guestId: 2 }).ok, true)
  assert.equal((await observe.run(record, { block_id: 'b', expected_revision: 2, interaction: 'observe' })).code, 'conflict')
  assert.equal((await observe.run(record, { block_id: 'b', expected_revision: 3, interaction: 'execute' })).code, 'invalid')
  assert.equal((await observe.run(record, { block_id: 'b', expected_revision: 3, interaction: 'observe' })).ok, true)
  assert.equal((await observe.run(record, { block_id: 'b', expected_revision: 3, interaction: 'fill', selector: '#password', value: 'x'.repeat(5000) })).code, 'invalid')
  guest.getURL = () => 'file:///secret'
  assert.equal((await observe.run(record, { block_id: 'b', expected_revision: 3, interaction: 'observe' })).code, 'forbidden')
  assert(!pageScript({ interaction: 'observe' }).includes('document.cookie'))
  // Поле-цель обводится на странице и снимается, не трогая чужую обводку страницы.
  const vm = require('node:vm')
  const field = { style: { outline: '1px dotted red', outlineOffset: '' }, dataset: {} }
  const page = { querySelector: selector => selector === '#q' ? field : null, querySelectorAll: () => Object.values(field.dataset).length ? [field] : [] }
  const mark = request => JSON.parse(JSON.stringify(vm.runInNewContext(pageScript({ url: 'https://example.com/', deadline: Date.now() + 5000, interaction: 'mark', ...request }),
    { location: { href: 'https://example.com/' }, document: page, Date, JSON })))
  assert.deepEqual(mark({ selector: '#q', tone: 'acc' }), { ok: true })
  assert.equal(field.style.outline, '2px solid #b83c0a'); assert.equal(field.style.outlineOffset, '2px')
  assert.deepEqual(mark({ selector: '#q', tone: 'warn' }), { ok: true })
  assert.equal(field.style.outline, '2px solid #8b4e06')
  assert.deepEqual(mark({ selector: '' }), { ok: true })
  assert.equal(field.style.outline, '1px dotted red', 'снятие возвращает обводку страницы')
  assert.equal(Object.keys(field.dataset).length, 0)
  assert.equal(mark({ selector: '#missing', tone: 'acc' }).code, 'unavailable-target')
  guest.getURL = () => 'https://example.com/'
  let marked = null
  guest.executeJavaScript = async script => { marked = script; return { ok: true } }
  assert.equal((await observe.mark(record, { block_id: 'b', selector: '#q', tone: 'acc' })).ok, true)
  assert(marked.includes('"interaction":"mark"'))
  assert.equal((await observe.mark(record, { block_id: 'b', selector: '#q', tone: 'red' })).code, 'invalid')
  assert.equal((await observe.mark(record, { block_id: 'b', selector: 'x'.repeat(2001), tone: 'acc' })).code, 'invalid')
  assert.equal((await observe.mark(record, { block_id: 'nope', selector: '#q', tone: 'acc' })).code, 'unavailable-target')
  guest.getURL = () => 'file:///secret'
  record.rendererGone = true
  assert.equal((await observe.run(record, { block_id: 'b', expected_revision: 3, interaction: 'observe' })).code, 'not-open')
  console.log('PASS Desk observation: guest ownership, revision, bounded actions, navigation policy and renderer loss')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
