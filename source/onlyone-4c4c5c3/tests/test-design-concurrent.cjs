const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DesignStore } = require('../src/main/design/store')

;(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-concurrent-'))
  const store = new DesignStore(root)
  const original = store.installRuntime.bind(store)
  let active = 0, peak = 0
  store.installRuntime = async id => {
    active++; peak = Math.max(peak, active)
    try { return await original(id) } finally { active-- }
  }
  const folders = await Promise.all(Array.from({ length: 30 }, () => store.ensure('parallel')))
  assert.equal(peak, 1, 'same design must initialize only once at a time')
  assert.equal(new Set(folders).size, 1)
  assert.equal(store.pendingEnsure.size, 0)
  assert(!(await fs.readdir(folders[0])).some(name => name.endsWith('.tmp')))
  const source = await fs.readFile(path.join(__dirname, '../src/renderer/dc-runtime.js'))
  assert((await fs.readFile(path.join(folders[0], 'dc-runtime.js'))).equals(source))
  store.installRuntime = async () => { throw new Error('injected failure') }
  await assert.rejects(store.ensure('retry'), /injected failure/)
  assert.equal(store.pendingEnsure.size, 0)
  store.installRuntime = original
  await store.ensure('retry')
  console.log('PASS: concurrent runtime initialization, exact bytes, cleanup, retry after failure')
})().catch(error => { console.error(error); process.exitCode = 1 })
