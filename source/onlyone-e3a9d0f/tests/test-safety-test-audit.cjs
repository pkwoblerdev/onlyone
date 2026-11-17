const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { audit, TEST_FILE } = require('../tools/safety/test-audit.cjs')

const base = path.join(__dirname, 'fixtures', 'safety')
const stacks = path.join(base, 'stacks')
let checks = 0
let failed = 0
function check (name, fn) {
  checks++
  try { fn(); console.log('ok ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) }
}
const keys = dir => audit(dir).map(f => `${f.file}:${f.line}:${f.kind}`).sort()

check('all ten seeded fake-green tests are found', () => {
  const findings = audit(path.join(base, 'fake-green'))
  assert.equal(findings.length, 10, JSON.stringify(findings))
})

check('each kind is counted', () => {
  const findings = audit(path.join(base, 'fake-green'))
  const count = kind => findings.filter(f => f.kind === kind).length
  assert.equal(count('no-assert'), 1)
  assert.equal(count('skipped'), 3)
  assert.equal(count('tautology'), 3)
  assert.equal(count('empty-catch'), 3)
})

check('honest tests produce no findings', () => {
  assert.deepEqual(audit(path.join(base, 'honest')), [])
})

check('a finding carries file and line', () => {
  const f = audit(path.join(base, 'fake-green')).find(x => x.kind === 'skipped')
  assert.equal(f.file, 'test-skipped.cjs')
  assert.equal(typeof f.line, 'number')
})

check('test file names of every supported language are recognised', () => {
  for (const file of [
    'test-cart.cjs', 'cart.spec.ts', 'test_cart.py', 'cart_test.py', 'cart_test.go',
    'tests/cart.rs', 'tests/CartTest.php', 'CartTests.cs', 'test_cart.rs'
  ]) {
    assert.ok(TEST_FILE.test(file), 'not recognised: ' + file)
  }
  for (const file of ['cart.rs', 'cart.php', 'Cart.cs', 'README.md']) {
    assert.equal(TEST_FILE.test(file), false, 'wrongly treated as a test: ' + file)
  }
})

for (const stack of fs.readdirSync(stacks).sort()) {
  const dir = path.join(stacks, stack)
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'))

  check(stack + ': every planted fake-green test is found, nothing else', () => {
    const found = keys(dir)
    assert.deepEqual(found, [...expected.findings].sort(), 'found ' + JSON.stringify(found))
  })

  check(stack + ': honest counterpart is not accused', () => {
    const accused = keys(dir).filter(k => expected.honest.some(file => k.startsWith(file + ':')))
    assert.deepEqual(accused, [], 'accused honest files: ' + JSON.stringify(accused))
  })

  check(stack + ': at least one skip and one tautology are planted', () => {
    const kinds = new Set(expected.findings.map(k => k.split(':').pop()))
    assert.ok(kinds.has('skipped'), 'no skip planted')
    assert.ok(kinds.size >= 1, 'expected findings missing')
  })
}

console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
