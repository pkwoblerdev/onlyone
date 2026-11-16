const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { addFinding, addRecord, verify } = require('../tools/safety/evidence.cjs')

let checks = 0
let failed = 0
function check (name, fn) {
  checks++
  try { fn(); console.log('ok ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'))
const base = { id: 'f1', title: 'claim', confidence: 'observed', kind: 'static' }
const record = (kind, extra = {}) => ({ findingId: 'f1', kind, command: ['node', '-e', '1'], exit: 0, ...extra })

check('a finding without a record is refused', () => {
  addFinding(dir, base)
  const r = verify(dir)
  assert.equal(r.ok, false)
  assert.match(r.problems.join(' '), /no record/)
})

check('one matching record is enough for observed', () => {
  addRecord(dir, record('static'))
  assert.equal(verify(dir).ok, true)
})

check('confirmed needs two record kinds', () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'))
  addFinding(d2, { ...base, confidence: 'confirmed' })
  addRecord(d2, record('static'))
  assert.equal(verify(d2).ok, false)
  addRecord(d2, record('runtime'))
  assert.equal(verify(d2).ok, true)
  fs.rmSync(d2, { recursive: true, force: true })
})

check('a hypothesis is not a finding', () => {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'))
  addFinding(d3, { ...base, id: 'h1', confidence: 'hypothesis' })
  addRecord(d3, { ...record('static'), findingId: 'h1' })
  assert.equal(verify(d3).ok, false)
  fs.rmSync(d3, { recursive: true, force: true })
})

check('a record needs a measured exit code', () => {
  assert.throws(() => addRecord(dir, { findingId: 'f1', kind: 'static', command: ['x'] }), /exit/)
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
