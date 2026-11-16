'use strict'
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createStore } = require('../src/main/mods-store.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-mods-store-')), file = path.join(dir, 'mods.json')
try {
  const store = createStore({ file, protect: text => 'sealed:' + Buffer.from(text).toString('base64'), unprotect: text => { if (!text.startsWith('sealed:')) throw Error('key lost'); return Buffer.from(text.slice(7),'base64').toString() } })
  assert.equal(store.load(), null)
  store.save({ private: 'PRIVATE package' }); assert.deepEqual(store.load(), { private: 'PRIVATE package' })
  const before = fs.readFileSync(file)
  assert.equal(before.toString().includes('PRIVATE'), false)
  assert.throws(() => createStore({ file, protect: () => { throw Error('unavailable') }, unprotect: text => text }).save({ private: 'overwrite' }))
  assert.deepEqual(fs.readFileSync(file), before)
  fs.writeFileSync(file, '{broken'); assert.throws(() => store.load(), { code: 'mods-store-damaged' })
  assert.equal(fs.readFileSync(file,'utf8'), '{broken')
  // The archive is a byte copy named by content: a repeated attempt on the same
  // damaged file adds nothing, and the original stays until a good save replaces it.
  const aside = store.archive()
  assert.match(aside, /^mods\.damaged-[0-9a-f]{12}\.json$/)
  assert.equal(fs.readFileSync(path.join(dir, aside), 'utf8'), '{broken')
  assert.equal(store.archive(), aside); assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('mods.damaged-')).length, 1)
  assert.equal(fs.readFileSync(file,'utf8'), '{broken')
  fs.writeFileSync(file, JSON.stringify({ enc: 'plain', data: 'x' })); assert.throws(() => store.load(), { code: 'mods-store-damaged' }, 'foreign envelope')
  fs.writeFileSync(file, JSON.stringify({ enc: 'safeStorage', data: 'other-key' })); assert.throws(() => store.load(), { code: 'mods-store-damaged' }, 'key lost')
  fs.writeFileSync(file, JSON.stringify({ enc: 'safeStorage', data: 'sealed:' + Buffer.from('{no').toString('base64') })); assert.throws(() => store.load(), { code: 'mods-store-damaged' }, 'decrypted text is not JSON')
  // Encryption that is merely unavailable right now is not damage: nothing is archived or replaced.
  const offline = createStore({ file, unprotect: () => { throw Object.assign(Error('later'), { code: 'mods-encryption-unavailable' }) } })
  assert.throws(() => offline.load(), { code: 'mods-encryption-unavailable' })
  assert.throws(() => createStore({ file }).load(), { code: 'mods-encryption-unavailable' })
  console.log('PASS Mods store: protected roundtrip, unavailable key preserves old data, damage is classified and archived by content, never reset')
} finally { assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep)); fs.rmSync(dir,{recursive:true,force:true}) }
