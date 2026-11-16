'use strict'
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { compareReports, writeComparison } = require('../scripts/quality-bench/compare.cjs')
function report () {
  return { tool: 'onlyone-agent-quality-bench', schemaVersion: 1, completed: true, mode: 'live',
    suiteDigest: 'a'.repeat(64), source: { commit: 'b'.repeat(40), dirty: false },
    attempts: [1, 2].map(repeat => ({ scenario: 'files', repeat, mode: 'live', model: 'model/x',
      params: { permission: 'acceptEdits', timeoutMs: 60000 }, verdict: 'pass', expected: 'pass',
      check: { ok: true }, durationMs: repeat * 100, requests: 2, tokens: 40 })) }
}
const a = report(), b = report()
b.attempts.reverse(); b.attempts[0].durationMs = 250
b.attempts[0].tokens = null
const result = compareReports(a, b, 'aa')
assert.equal(result.pairs.length, 2)
assert.equal(result.pairs[1].durationMs.delta, 50, 'pairs match by scenario and repeat, never array index')
assert.equal(result.totals.b.tokens, null, 'unknown tokens cannot become zero or partial total')
assert.equal(result.totals.tokensDelta, null)
assert.equal(result.effectProven, false, 'descriptive comparison is not proof of effect')
assert.equal(result.totals.b.requests, 4)
function rejects (mutate, pattern = /./, kind = 'aa') { const other = report(); mutate(other); assert.throws(() => compareReports(a, other, kind), pattern) }
rejects(r => { r.completed = false }, /completed/)
rejects(r => { delete r.suiteDigest }, /suite/)
rejects(r => { r.suiteDigest = 'c'.repeat(64) }, /suite/)
rejects(r => { r.mode = 'self' }, /mode/)
rejects(r => { r.attempts.pop() }, /pairs/)
rejects(r => { r.attempts[1].repeat = 1 }, /duplicate/)
rejects(r => { r.source.dirty = true }, /source/)
rejects(r => { r.source.commit = 'c'.repeat(40) }, /source/)
rejects(r => { r.attempts[0].model = 'other' }, /model/)
rejects(r => { r.attempts[0].params.timeoutMs = 1 }, /conditions/)
rejects(r => { r.attempts[0].verdict = 'provider-error' }, /infrastructure/)
rejects(r => { r.attempts[0].tokens = -1 }, /tokens/)
rejects(r => { r.attempts[0].check.ok = false }, /verdict/)
const changed = report(); changed.source.commit = 'c'.repeat(40)
changed.attempts[0].verdict = 'agent-error'; changed.attempts[0].check.ok = false
const ab = compareReports(a, changed, 'ab')
assert.equal(ab.pairs[0].outcome, 'regressed')
assert.equal(ab.totals.b.passed, 1)
const selfA = report(), selfB = report()
for (const r of [selfA, selfB]) { r.mode = 'self'; for (const item of r.attempts) item.mode = 'self' }
assert.equal(compareReports(selfA, selfB, 'aa').evidence, 'scripted-self-check-only')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-compare-'))
try {
  const file = path.join(dir, 'compare.json'); writeComparison(file, result)
  assert.throws(() => writeComparison(file, ab), /EEXIST/)
  assert.equal(JSON.parse(fs.readFileSync(file)).kind, 'aa', 'existing evidence is never overwritten')
  const inputA = path.join(dir, 'a.json'), inputB = path.join(dir, 'b.json'), output = path.join(dir, 'cli.json')
  fs.writeFileSync(inputA, JSON.stringify(a)); fs.writeFileSync(inputB, JSON.stringify(b))
  const cli = require('node:path').join(__dirname, '../scripts/quality-bench/compare.cjs')
  const spawn = args => require('node:child_process').spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  const args = ['--kind', 'aa', '--out', output, inputA, inputB]
  const invoked = spawn(args)
  assert.equal(invoked.status, 0, invoked.stderr)
  assert.equal(JSON.parse(fs.readFileSync(output)).pairs.length, 2)
  assert.equal(spawn(args).status, 2, 'CLI cannot overwrite previous evidence')
  assert.equal(spawn(['--kind', 'aa', inputA, inputB]).status, 2)
  fs.writeFileSync(inputB, 'PRIVATE_REPORT_VALUE')
  const invalid = spawn(['--kind', 'ab', '--out', path.join(dir, 'bad.json'), inputA, inputB])
  assert.equal(invalid.status, 2)
  assert.equal(invalid.stderr.includes('PRIVATE_REPORT_VALUE'), false, 'parse errors must not print report contents')
  assert.equal(fs.existsSync(path.join(dir, 'bad.json')), false)
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
const huge = report(); for (const item of huge.attempts) item.tokens = Number.MAX_SAFE_INTEGER
assert.equal(compareReports(a, huge, 'aa').totals.b.tokens, null, 'overflow cannot fabricate a precise total')
assert.match(require('../scripts/quality-bench.cjs').suiteDigest(), /^[a-f0-9]{64}$/)
console.log('PASS bench comparison: matched pairs, strict provenance/conditions, unknown cost, refusal and no effect claims')
