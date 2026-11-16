const assert = require('node:assert/strict')
const path = require('node:path')
const { evaluate, report } = require('../tools/safety/bench.cjs')
const { run, parse, sha256 } = require('../tools/safety/scan.cjs')

let checks = 0
let failed = 0
function check (name, fn) {
  checks++
  try { fn(); console.log('ok ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) }
}

const r = evaluate(path.join(__dirname, 'fixtures', 'safety'))
const stack = name => r.stacks.find(s => s.stack === name)

check('recall and precision pass the 0.8 bar', () => {
  assert.ok(r.recall >= 0.8, 'recall ' + r.recall)
  assert.ok(r.precision >= 0.8, 'precision ' + r.precision)
  assert.equal(r.expected, 10)
  assert.equal(r.found, 10)
})

check('honest tests are not accused', () => assert.equal(r.honestFindings, 0))
check('the node plan is fixed', () => assert.deepEqual(r.nodeChecks, ['deps', 'static', 'tests', 'mutants']))
check('the bench passes its own gate', () => assert.equal(r.passed, true))

check('every stack fixture is scored', () => {
  const names = r.stacks.map(s => s.stack).sort()
  assert.deepEqual(names, ['dotnet', 'go', 'node', 'php', 'python', 'rust'])
  assert.ok(r.stacks.every(s => s.scored), 'an unscored stack slipped through')
})

check('each stack finds exactly its planted fake-green', () => {
  const expected = { dotnet: 2, go: 2, node: 3, php: 2, python: 4, rust: 2 }
  for (const [name, count] of Object.entries(expected)) {
    const m = stack(name).metrics
    assert.equal(m.expected, count, name + ' expected ' + count)
    assert.equal(m.found, count, name + ' found ' + m.found + ' ' + JSON.stringify(m.unexpected))
    assert.equal(m.falseNegatives, 0, name + ' missed ' + JSON.stringify(m.missing))
    assert.equal(m.falsePositives, 0, name + ' invented ' + JSON.stringify(m.unexpected))
  }
})

check('no honest counterpart is accused in any stack', () => {
  for (const s of r.stacks) assert.equal(s.metrics.honestAccused, 0, s.stack + ' accused an honest file')
})

check('the stack is confirmed by its own manifest', () => {
  for (const s of r.stacks) assert.ok(s.detected.some(d => d === `${s.stack}:confirmed`), s.stack + ': ' + JSON.stringify(s.detected))
})

check('tool availability is reported, not assumed', () => {
  assert.ok(Object.keys(r.tools).length > 0, 'no tools probed')
  for (const [name, info] of Object.entries(r.tools)) {
    assert.equal(typeof info.available, 'boolean', name + ' has no boolean availability')
    if (!info.available) assert.equal(info.notRun, true, name + ' missing but not marked not_run')
  }
})

check('a missing tool produces a not_run record with its command', () => {
  const missing = r.stacks.flatMap(s => s.notRun.map(n => ({ stack: s.stack, ...n })))
  for (const n of missing) {
    assert.ok(Array.isArray(n.command) && n.command.length, n.id + ' not_run without a command')
    assert.ok(n.reason.includes(n.tool), n.id + ' reason does not name the tool')
  }
})

check('every stack carries scanner availability and its executed result', () => {
  const entries = r.scanners.entries
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(e => e.stack + ':' + e.id).sort(), ['node:deps', 'node:static', 'python:static'])
  for (const entry of entries) {
    for (const field of ['tool', 'available', 'status', 'version', 'command', 'exit', 'stdout_sha256', 'findings', 'expected', 'verified']) {
      assert.ok(field in entry, entry.stack + ':' + entry.id + ' missing ' + field)
    }
    assert.equal('passed' in entry, false, entry.stack + ':' + entry.id + ' invented a passed field')
    assert.notEqual(entry.status, 'passed', entry.stack + ':' + entry.id + ' reports a bare pass')
  }
})

check('an available scanner with findings is reported as findings, not a pass', () => {
  const ran = r.scanners.entries.filter(e => e.available && e.status === 'findings')
  assert.ok(ran.length > 0, 'no scanner actually ran: ' + JSON.stringify(r.scanners.entries.map(e => [e.tool, e.status])))
  for (const entry of ran) {
    assert.ok(entry.findingsCount > 0, entry.tool + ' says findings with an empty list')
    assert.ok(entry.findings.every(f => f.file && f.id), entry.tool + ' finding without file or id')
    assert.ok(entry.findings.every(f => Number.isInteger(f.line) && f.line > 0), entry.tool + ' finding without a line')
    assert.equal(entry.verified, entry.findingsCount >= entry.expected)
    assert.match(String(entry.stdout_sha256), /^[0-9a-f]{64}$/, entry.tool + ' has no stdout hash')
  }
  const byTool = Object.fromEntries(ran.map(e => [e.tool, e]))
  if (byTool.semgrep) {
    assert.ok(byTool.semgrep.findings.some(f => f.id === 'node-command-injection' && f.file === 'app.js'))
    assert.ok(byTool.semgrep.findings.some(f => f.id === 'node-path-traversal'))
  }
  if (byTool.bandit) {
    const ids = byTool.bandit.findings.map(f => f.id)
    assert.ok(ids.includes('B602'), 'shell=True is not reported: ' + ids.join(','))
    assert.ok(ids.includes('B105'), 'hardcoded password is not reported: ' + ids.join(','))
  }
})

check('the scan runner reports a missing tool and a timeout without faking a result', () => {
  const absent = run({ tool: 'safety-no-such-tool-xyz', argv: ['--json'] })
  assert.equal(absent.status, 'not_run')
  assert.equal(absent.exit, null)
  assert.equal(absent.stdout_sha256, null)
  assert.deepEqual(absent.findings, [])
  assert.match(absent.reason, /tool not found: safety-no-such-tool-xyz/)
  assert.equal('passed' in absent, false)
  const slow = run({ tool: 'python', argv: ['-c', 'import time; time.sleep(5)'], timeout: 400 })
  assert.equal(slow.status, 'timeout', 'got ' + slow.status + ' ' + JSON.stringify(slow.reason))
  assert.equal(slow.exit, null)
  assert.match(slow.reason, /timeout after 400 ms/)
})

check('scan records carry the evidence fields and a stable stdout hash', () => {
  const record = run({ tool: 'node', argv: ['-e', '0'] })
  for (const field of ['tool', 'version', 'command', 'exit', 'stdout_sha256', 'findings', 'status']) {
    assert.ok(field in record, 'missing ' + field)
  }
  assert.equal(record.status, 'clean')
  assert.equal(record.stdout_sha256, sha256(''))
})

check('npm audit output is parsed only when it is a real report', () => {
  const reportDoc = {
    auditReportVersion: 2,
    vulnerabilities: { lodash: { severity: 'high', range: '<4.17.21' } },
    metadata: { vulnerabilities: { high: 1 } }
  }
  const good = parse('npm', JSON.stringify(reportDoc), process.cwd())
  assert.equal(good.parsed, true)
  assert.equal(good.findings[0].id, 'lodash')
  assert.equal(good.findings[0].severity, 'high')
  const bad = parse('npm', JSON.stringify({ message: '404 Not Found', statusCode: 404 }), process.cwd())
  assert.equal(bad.parsed, false)
  assert.match(bad.reason, /npm audit error: 404/)
})

check('a scanner that is not there is not_run with the exact reason', () => {
  for (const entry of r.scanners.entries.filter(e => e.status === 'not_run')) {
    assert.ok(entry.reason, entry.tool + ' not_run without a reason')
    assert.ok(entry.reason.length > 10, entry.tool + ' reason too vague: ' + entry.reason)
    assert.equal(entry.findingsCount, 0, entry.tool + ' not_run with findings')
    assert.equal(entry.verified, false, entry.tool + ' not_run but verified')
  }
  assert.equal(r.scanners.passed, r.scanners.entries.every(e => e.verified))
})

check('a machine without scanners reports not_run, never clean', () => {
  const absent = args => ({ name: args.name, available: false, version: null, command: null })
  const bare = evaluate(path.join(__dirname, 'fixtures', 'safety'), { probe: absent })
  assert.ok(bare.scanners.entries.every(e => e.status === 'not_run'), 'a scanner ran without a tool')
  assert.equal(bare.scanners.passed, false)
  assert.ok(bare.scanners.entries.every(e => /tool not found|not installed|registry/.test(e.reason)))
  assert.equal(bare.mutation.local.status, 'not_run')
  assert.match(bare.mutation.local.reason, /python not found/)
})

check('a real mutation run reports a survivor and a killed mutant', () => {
  const local = r.mutation.local
  assert.equal(local.status, 'run', JSON.stringify(local.reason))
  assert.ok(local.mutants.length >= 2, 'too few mutants: ' + local.mutants.length)
  assert.equal(local.survived, local.mutants.filter(m => m.status === 'survived').length)
  assert.ok(local.survived >= 1, 'no mutant survived, the fixture proves nothing')
  assert.ok(local.mutants.some(m => m.status === 'killed'), 'no mutant was killed by the test')
  assert.equal(r.mutation.passed, true)
})

check('an engine without a result line is not_run, not a silent pass', () => {
  const engine = r.mutation.engine
  if (engine.status === 'run') {
    assert.ok(Number.isInteger(engine.survived) || Number.isInteger(engine.killed), 'run without mutant counts')
  } else {
    assert.equal(engine.status, 'not_run')
    assert.ok(engine.reason && engine.reason.length > 10, 'not_run without a reason')
  }
})

check('the report carries date, revision, versions and metrics', () => {
  const data = report(path.join(__dirname, 'fixtures', 'safety'), { scans: false, mutation: false })
  assert.ok(!Number.isNaN(Date.parse(data.date)), 'bad date ' + data.date)
  assert.equal(typeof data.revision, 'string')
  assert.ok(data.versions && data.versions.resolved, 'no versions block')
  assert.ok('semgrep' in data.versions.resolved && 'bandit' in data.versions.resolved && 'mutmut' in data.versions.resolved)
  for (const field of ['precision', 'recall', 'falsePositives', 'falseNegatives', 'found', 'expected', 'passed']) {
    assert.ok(field in data.metrics, 'metrics missing ' + field)
  }
  assert.equal(data.scanners.entries.length, 3)
  assert.ok(data.scanners.entries.every(e => e.status === 'not_run'), 'scans:false still ran a scan')
  assert.equal(data.overall.scannersPassed, false)
  assert.equal(data.overall.mutationPassed, false)
})

console.log(JSON.stringify({ ok: failed === 0, checks, failed, metrics: { recall: r.recall, precision: r.precision, found: r.found, expected: r.expected } }))
process.exitCode = failed ? 1 : 0
