'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../tools/safety/live.cjs'), 'utf8')
const start = source.indexOf('async function waitNoLeftovers (')
const end = source.indexOf('\nasync function cleanupLaunch (', start)
assert.ok(start >= 0 && end > start)
async function main () {
  let now = 0, calls = 0
  const scan = async () => ++calls === 1 ? { ok: true, pids: [123] } : { ok: true, pids: [] }
  const wait = new Function('processesWithMarker', 'sleep', 'Date', source.slice(start, end) + ';return waitNoLeftovers')(
    scan, async () => { now = 20 }, { now: () => now })
  assert.deepEqual(await wait('isolated-profile', 10), { ok: true, pids: [] })
  assert.equal(calls, 2, 'a final scan must not return the stale snapshot')
  const stillAlive = new Function('processesWithMarker', 'sleep', 'Date', source.slice(start, end) + ';return waitNoLeftovers')(
    async () => ({ ok: true, pids: [123] }), async () => { now = 20 }, { now: () => now })
  now = 0
  assert.deepEqual(await stillAlive('isolated-profile', 10), { ok: true, pids: [123] })
  console.log('PASS cleanup checks a fresh process snapshot after its deadline')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
