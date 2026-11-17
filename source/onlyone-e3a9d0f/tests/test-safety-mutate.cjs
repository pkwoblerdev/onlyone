const assert = require('node:assert/strict')
const path = require('node:path')
const { mutate, mutateLocal, evidence, ENGINES } = require('../tools/safety/mutate.cjs')

let checks = 0
let failed = 0
function check (name, fn) {
  checks++
  try { fn(); console.log('ok ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) }
}
const absent = args => ({ name: args.name, available: false, version: null, command: null })
const present = args => ({ name: args.name, available: true, version: args.name + ' 1.0.0', command: '/usr/bin/' + args.name })

check('each engine stack names its real binary', () => {
  assert.deepEqual(Object.keys(ENGINES).sort(), ['go', 'node', 'python', 'rust'])
  assert.equal(ENGINES.node.engine, 'stryker')
  assert.equal(ENGINES.python.engine, 'mutmut')
  assert.equal(ENGINES.go.engine, 'go-mutesting')
  assert.equal(ENGINES.rust.engine, 'cargo-mutants')
})

check('a missing engine is reported not_run, with the command, never passed', () => {
  for (const stack of Object.keys(ENGINES)) {
    const r = mutate(stack, { probe: absent })
    assert.equal(r.status, 'not_run', stack + ' reported ' + r.status)
    assert.match(r.reason, /not installed: /, stack + ' reason: ' + r.reason)
    assert.ok(Array.isArray(r.command) && r.command.length, stack + ' lost its command')
    assert.equal(r.exit, null)
    assert.equal('passed' in r, false, stack + ' invented a passed field')
    assert.equal(r.ok, undefined, stack + ' invented an ok field')
  }
})

check('an engine without a mutation tool says so', () => {
  for (const stack of ['php', 'dotnet']) {
    const r = mutate(stack, { probe: absent })
    assert.equal(r.status, 'not_run')
    assert.equal(r.engine, null)
    assert.equal(r.command, null)
    assert.equal(r.reason, 'no mutation engine for stack: ' + stack)
  }
})

check('an installed engine is reported as runnable, not run, under dry run', () => {
  const r = mutate('node', { probe: present, dryRun: true })
  assert.equal(r.status, 'not_run')
  assert.match(r.reason, /dry run/)
  assert.equal(r.command[0], '/usr/bin/stryker')
  assert.deepEqual(r.command.slice(1), ['run'])
})

check('nothing is fetched at run time', () => {
  for (const stack of Object.keys(ENGINES)) {
    const r = mutate(stack, { probe: present, dryRun: true })
    assert.equal(r.command[0].includes('npx'), false, stack + ' would download through npx')
    assert.equal(r.command[0].includes('@latest'), false, stack + ' would download a floating version')
  }
})

check('an engine that exits without a mutation result is not_run, not a pass', () => {
  // A real process that runs and prints nothing mutation-like: silence is a gap.
  const silent = args => ({ name: args.name, available: true, version: 'test 1.0.0', command: process.execPath })
  const r = mutate('node', { probe: silent })
  assert.equal(r.status, 'not_run')
  assert.match(r.reason, /without a mutation result/)
  assert.equal('passed' in r, false)
  assert.equal(r.ok, undefined)
})

check('only a result line turns a run into a measured result', () => {
  assert.deepEqual(evidence('3 mutants survived, 7 killed'), { survived: 3, killed: 7, total: null })
  assert.equal(evidence('To run mutmut on Windows, please use the WSL.'), null)
})

check('a local mutation run reports survivors with the file and the change', () => {
  const r = mutateLocal(path.join(__dirname, 'fixtures', 'safety', 'mutate-python'))
  assert.equal(r.status, 'run', JSON.stringify(r.reason))
  assert.equal(r.mutants.length, 2)
  const survivor = r.mutants.find(m => m.status === 'survived')
  assert.ok(survivor, 'no surviving mutant reported')
  assert.equal(survivor.file, 'calc.py')
  assert.ok(survivor.line > 0)
  assert.ok(survivor.change)
  assert.ok(r.mutants.some(m => m.status === 'killed'))
})

check('a local fixture without mutations.json is not_run', () => {
  const r = mutateLocal(path.join(__dirname, 'fixtures', 'safety', 'scan-python'))
  assert.equal(r.status, 'not_run')
  assert.match(r.reason, /no mutations.json/)
  assert.deepEqual(r.mutants, [])
})

console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
