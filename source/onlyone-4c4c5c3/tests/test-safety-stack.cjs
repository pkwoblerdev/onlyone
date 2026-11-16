const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { detect } = require('../tools/safety/stack-detect.cjs')

const base = path.join(__dirname, 'fixtures', 'safety', 'stacks')
let checks = 0
let failed = 0
function check (name, fn) {
  checks++
  try { fn(); console.log('ok ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) }
}

for (const [dir, stack] of [['node', 'node'], ['python', 'python'], ['go', 'go'], ['rust', 'rust'], ['php', 'php'], ['dotnet', 'dotnet']]) {
  check(stack + ' is confirmed by its manifest', () => {
    const r = detect(path.join(base, dir))
    const hit = r.stacks.find(s => s.name === stack)
    assert.ok(hit, 'stack missing: ' + JSON.stringify(r.stacks))
    assert.equal(hit.confidence, 'confirmed')
  })
}

check('an extension without a manifest is only observed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-observed-'))
  fs.writeFileSync(path.join(dir, 'test_cart.py'), 'assert 1 + 1 == 2\n')
  const r = detect(dir)
  const hit = r.stacks.find(s => s.name === 'python')
  assert.ok(hit, JSON.stringify(r.stacks))
  assert.equal(hit.confidence, 'observed')
  fs.rmSync(dir, { recursive: true, force: true })
})

check('an empty directory is unknown, not a guess', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-empty-'))
  const r = detect(dir)
  assert.equal(r.unknown, true)
  assert.deepEqual(r.stacks, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
