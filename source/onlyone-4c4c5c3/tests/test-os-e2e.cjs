'use strict'
// OS end-to-end: stack -> route -> test audit -> static and runtime evidence -> verify.
// The target is a real Node project with a path traversal and one fake-green test.
// Two independent records (a static location and a live exploit) make the finding
// confirmed; removing the static record must turn verify red.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { detect } = require('../tools/safety/stack-detect.cjs')
const { route } = require('../tools/safety/route.cjs')
const { audit } = require('../tools/safety/test-audit.cjs')
const { addFinding, addRecord, verify } = require('../tools/safety/evidence.cjs')

const fixture = path.join(__dirname, 'fixtures', 'os-e2e', 'vuln-node')
const serverFile = path.join(fixture, 'server.cjs')
const exploitFile = path.join(fixture, 'exploit.cjs')

let checks = 0
let failed = 0
function check (name, fn) {
  checks++
  try { fn(); console.log('ok ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) }
}

const runDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'os-e2e-run-'))
const outside = fs.mkdtempSync(path.join(path.dirname(fixture), 'outside-'))
const marker = 'OS-E2E-OUTSIDE-' + Date.now()
const secret = path.join(outside, 'secret.txt')
fs.writeFileSync(secret, marker)
const relativeToPublic = path.relative(path.join(fixture, 'public'), secret)

const scanCode = [
  "const fs = require('node:fs')",
  "const lines = fs.readFileSync(process.argv[1], 'utf8').split(/\\r?\\n/)",
  "const at = lines.findIndex(line => line.includes('fs.readFileSync'))",
  'if (at < 0) process.exit(3)',
  'console.log(JSON.stringify({ line: at + 1 }))'
].join(';')
const scan = spawnSync(process.execPath, ['-e', scanCode, serverFile], { encoding: 'utf8', timeout: 30000 })
const exploit = spawnSync(process.execPath, [exploitFile, relativeToPublic], { cwd: fixture, encoding: 'utf8', timeout: 30000 })

check('stack-detect confirms node from its manifest', () => {
  const profile = detect(fixture)
  const node = profile.stacks.find(stack => stack.name === 'node')
  assert.ok(node, JSON.stringify(profile.stacks))
  assert.equal(node.confidence, 'confirmed')
})

check('route gives the fixed node check list with commands', () => {
  const plan = route(detect(fixture))
  assert.deepEqual(plan.checks.map(item => item.id), ['deps', 'static', 'tests', 'mutants'])
  assert.ok(plan.checks.every(item => item.stack === 'node'))
  assert.ok(plan.checks.every(item => Array.isArray(item.command) && item.command.length))
})

check('test-audit finds the fake-green test and nothing else', () => {
  const findings = audit(fixture)
  assert.equal(findings.length, 1, JSON.stringify(findings))
  assert.deepEqual(findings[0], { file: 'tests/test-server.cjs', line: 4, kind: 'tautology' })
})

check('the static scan finds the sink at file:line', () => {
  assert.equal(scan.status, 0, scan.stderr)
  const found = JSON.parse(String(scan.stdout).trim())
  const expected = fs.readFileSync(serverFile, 'utf8').split(/\r?\n/)
    .findIndex(line => line.includes('fs.readFileSync')) + 1
  assert.equal(found.line, expected)
  assert.match(fs.readFileSync(serverFile, 'utf8').split(/\r?\n/)[found.line - 1], /fs\.readFileSync\(/)
})

check('the runtime exploit reads a file outside the project (exit 0, marker)', () => {
  assert.ok(path.relative(fixture, secret).startsWith('..'), 'the secret must live outside the project')
  assert.equal(exploit.status, 0, exploit.stderr)
  assert.ok(String(exploit.stdout).includes(marker), 'marker not read: ' + exploit.stdout)
})

check('a confirmed finding with static and runtime records verifies ok', () => {
  addFinding(runDir, {
    id: 'path-traversal',
    title: 'readUserFile joins user input without a path check',
    kind: 'static',
    confidence: 'confirmed'
  })
  addRecord(runDir, {
    findingId: 'path-traversal',
    kind: 'static',
    file: path.relative(fixture, serverFile).split(path.sep).join('/'),
    line: JSON.parse(String(scan.stdout).trim()).line,
    command: [process.execPath, '-e', scanCode, serverFile],
    exit: scan.status
  })
  addRecord(runDir, {
    findingId: 'path-traversal',
    kind: 'runtime',
    file: path.relative(fixture, serverFile).split(path.sep).join('/'),
    line: JSON.parse(String(scan.stdout).trim()).line,
    command: [process.execPath, exploitFile, relativeToPublic],
    exit: exploit.status,
    stdout_sha256: crypto.createHash('sha256').update(String(exploit.stdout)).digest('hex')
  })
  const result = verify(runDir)
  assert.deepEqual(result, { ok: true, findings: 1, records: 2, problems: [] })
})

check('negative control: without the static record verify fails', () => {
  const file = path.join(runDir, 'records.jsonl')
  const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(record => record.kind !== 'static')
  fs.writeFileSync(file, kept.map(record => JSON.stringify(record)).join('\n') + '\n')
  const result = verify(runDir)
  assert.equal(result.ok, false)
  assert.match(result.problems.join(' '), /confirmed needs two record kinds/)
})

fs.rmSync(runDir, { recursive: true, force: true })
fs.rmSync(outside, { recursive: true, force: true })
console.log(JSON.stringify({
  ok: failed === 0,
  checks,
  failed,
  finding: 'path-traversal',
  line: JSON.parse(String(scan.stdout).trim()).line,
  exploit: { exit: exploit.status, marker: String(exploit.stdout).includes(marker) }
}))
process.exitCode = failed ? 1 : 0
