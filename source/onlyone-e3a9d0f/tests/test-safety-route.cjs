const assert = require('node:assert/strict')
const path = require('node:path')
const { detect } = require('../tools/safety/stack-detect.cjs')
const { route, MATRIX } = require('../tools/safety/route.cjs')

const base = path.join(__dirname, 'fixtures', 'safety', 'stacks')
let checks = 0
let failed = 0
function check (name, fn) {
  checks++
  try { fn(); console.log('ok ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) }
}
const absent = args => ({ name: args.name, available: false, version: null, command: null })
const present = args => ({ name: args.name, available: true, version: args.name + ' 1.0.0', command: '/usr/bin/' + args.name })

check('node gets a fixed check list', () => {
  const plan = route(detect(path.join(base, 'node')))
  const ids = plan.checks.map(c => c.id)
  assert.deepEqual(ids, ['deps', 'static', 'tests', 'mutants'])
  assert.ok(plan.checks.every(c => c.stack === 'node'))
})

check('the same input gives the same plan', () => {
  const a = route(detect(path.join(base, 'python')))
  const b = route(detect(path.join(base, 'python')))
  assert.deepEqual(a, b)
})

check('an unknown stack stays unknown', () => {
  const plan = route({ stacks: [{ name: 'cobol', confidence: 'confirmed' }] })
  assert.deepEqual(plan.unknown, ['cobol'])
  assert.equal(plan.checks.length, 0)
})

check('every routed stack keeps a tests check', () => {
  for (const stack of ['node', 'python', 'go', 'rust', 'php', 'dotnet']) {
    assert.ok(MATRIX[stack], 'no matrix entry for ' + stack)
    assert.ok(MATRIX[stack].some(c => c.id === 'tests'), stack + ' has no tests check')
    assert.ok(MATRIX[stack].every(c => Array.isArray(c.command) && c.command.length), stack + ' has a check without a command')
  }
})

check('go and rust route their own mutation engines', () => {
  assert.equal(MATRIX.go.find(c => c.id === 'mutants').tool, 'go-mutesting')
  assert.equal(MATRIX.rust.find(c => c.id === 'mutants').tool, 'cargo-mutants')
  assert.equal(MATRIX.python.find(c => c.id === 'mutants').tool, 'mutmut')
  assert.equal(MATRIX.node.find(c => c.id === 'mutants').tool, 'stryker')
})

check('a missing tool is not_run with the exact command', () => {
  const plan = route(detect(path.join(base, 'python')), { probe: absent })
  for (const check of plan.checks) {
    assert.equal(check.available, false, check.id + ' wrongly available')
    assert.ok(check.notRun, check.id + ' has no notRun record')
    assert.equal(check.notRun.reason, 'tool not found: ' + check.tool)
    assert.deepEqual(check.notRun.command, check.command, check.id + ' lost its command')
  }
})

check('an installed tool is annotated available and has no notRun', () => {
  const plan = route(detect(path.join(base, 'go')), { probe: present })
  for (const check of plan.checks) {
    assert.equal(check.available, true)
    assert.equal(check.notRun, null)
    assert.equal(check.version, check.tool + ' 1.0.0')
  }
})

check('availability is probed per tool, not assumed', () => {
  const asked = []
  const mixed = args => { asked.push(args.name); return args.name === 'node' ? present(args) : absent(args) }
  const plan = route(detect(path.join(base, 'dotnet')), { probe: mixed })
  assert.deepEqual(asked.sort(), ['dotnet', 'node', 'semgrep'])
  const tests = plan.checks.find(c => c.id === 'tests')
  const deps = plan.checks.find(c => c.id === 'deps')
  assert.equal(tests.available, true)
  assert.equal(deps.available, false)
})

check('a check never reports green without a tool', () => {
  const plan = route({ stacks: [{ name: 'php', confidence: 'confirmed' }] }, { probe: absent })
  assert.equal(plan.checks.every(c => c.available === false && c.notRun), true)
  assert.equal(plan.checks.every(c => !('passed' in c) && !('ok' in c)), true)
})

console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
