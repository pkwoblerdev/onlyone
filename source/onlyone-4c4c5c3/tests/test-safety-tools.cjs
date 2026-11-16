const assert = require('node:assert/strict')
const { probe } = require('../tools/safety/tools.cjs')

let checks = 0
let failed = 0
function check (name, fn) {
  checks++
  try { fn(); console.log('ok ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) }
}

check('node is found with a version and a command', () => {
  const r = probe({ name: 'node' })
  assert.equal(r.available, true)
  assert.ok(r.command, 'no resolved command')
  assert.match(String(r.version), /\d+\.\d+/)
})

check('an absent tool is reported absent, not guessed', () => {
  const r = probe({ name: 'safety-no-such-tool-xyz' })
  assert.deepEqual({ available: r.available, version: r.version, command: r.command }, { available: false, version: null, command: null })
})

check('probing is stable across calls', () => {
  assert.deepEqual(probe({ name: 'node' }), probe({ name: 'node' }))
})

check('a tool name cannot smuggle a shell command', () => {
  for (const name of ['node; rm -rf /', 'node && echo pwned', '$(whoami)', '']) {
    assert.throws(() => probe({ name }), /plain binary name/, 'accepted: ' + JSON.stringify(name))
  }
})

check('the result shape is exactly availability, version and command', () => {
  const r = probe({ name: 'safety-no-such-tool-xyz' })
  assert.deepEqual(Object.keys(r).sort(), ['available', 'command', 'name', 'version'])
})

console.log(JSON.stringify({ ok: failed === 0, checks, failed, node: probe({ name: 'node' }) }))
process.exitCode = failed ? 1 : 0
