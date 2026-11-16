'use strict'
// Повторы A/A: сводка разброса по независимым прогонам одной конфигурации. Два
// прогона — только начальная оценка шума; эффект не заявляется. Окна не запускаются.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { parseArgs, summarizeAA, writeSummary } = require('../scripts/quality-bench/aa.cjs')
const { compareReports } = require('../scripts/quality-bench/compare.cjs')
function report (durations, extra = {}) {
  return { tool: 'onlyone-agent-quality-bench', schemaVersion: 1, completed: true, mode: 'self',
    suiteDigest: 'a'.repeat(64), source: { commit: 'b'.repeat(40), dirty: false },
    attempts: Object.entries(durations).map(([scenario, durationMs]) => ({ scenario, repeat: 1, mode: 'self', model: 'bench/model',
      params: { permission: 'acceptEdits', timeoutMs: 60000 }, verdict: 'pass', expected: 'pass', check: { ok: true },
      durationMs, requests: 4, tokens: null, falseDone: false, ...extra })) }
}
const one = report({ doc: 1000, desk: 2000 }), two = report({ doc: 1300, desk: 1900 })
const summary = summarizeAA([one, two])
assert.equal(summary.runs, 2)
assert.equal(summary.effectProven, false)
assert.equal(summary.noiseEstimate, 'initial')
assert.match(summary.notice, /2 прогона/)
assert.match(summary.notice, /начальная оценка шума/)
const doc = summary.scenarios.find(item => item.scenario === 'doc')
assert.deepEqual(doc.durationMs, { min: 1000, max: 1300, range: 300 })
assert.deepEqual(doc.requests, { min: 4, max: 4, range: 0 })
assert.equal(doc.tokens, null, 'неизвестные токены не превращаются в ноль')
assert.equal(doc.passed, 2)
assert.equal(doc.outcomesStable, true)
const flaky = report({ doc: 1100, desk: 2100 }); flaky.attempts[0].verdict = 'agent-error'; flaky.attempts[0].check.ok = false
const three = summarizeAA([one, two, flaky])
assert.equal(three.noiseEstimate, 'observed')
assert.match(three.notice, /не доказательство/)
assert.equal(three.scenarios.find(item => item.scenario === 'doc').outcomesStable, false)
assert.equal(three.scenarios.find(item => item.scenario === 'doc').passed, 2)
assert.throws(() => summarizeAA([one]), /2/)
const otherSuite = report({ doc: 1, desk: 1 }); otherSuite.suiteDigest = 'c'.repeat(64)
assert.throws(() => summarizeAA([one, otherSuite]), /suite/)
const otherCommit = report({ doc: 1, desk: 1 }); otherCommit.source.commit = 'c'.repeat(40)
assert.throws(() => summarizeAA([one, otherCommit]), /AA source/)
const missing = report({ doc: 1 })
assert.throws(() => summarizeAA([one, missing]), /pairs/)

// Ложное «готово» видно и в сравнении пар, а неизвестное не становится нулём.
const lied = report({ doc: 1000, desk: 2000 }); lied.attempts[0].falseDone = true; lied.attempts[0].verdict = 'agent-error'; lied.attempts[0].check.ok = false
const compared = compareReports(one, lied, 'aa')
assert.equal(compared.totals.a.falseDone, 0)
assert.equal(compared.totals.b.falseDone, 1)
const legacy = report({ doc: 1000, desk: 2000 }); for (const item of legacy.attempts) delete item.falseDone
assert.equal(compareReports(one, legacy, 'aa').totals.b.falseDone, null)

// Аргументы: число прогонов в пределах, свой --out, остальное уходит стенду.
assert.deepEqual(parseArgs(['--runs', '3', '--out', 'x', '--mode', 'live', '--model', 'm', '--profile', 'p']),
  { runs: 3, out: 'x', bench: ['--mode', 'live', '--model', 'm', '--profile', 'p'] })
assert.equal(parseArgs(['--out', 'x']).runs, 2)
for (const bad of [['--runs', '1', '--out', 'x'], ['--runs', '21', '--out', 'x'], ['--runs', '2.5', '--out', 'x'], ['--runs', '2'], ['--out', 'x', '--out', 'y'], ['--out', 'x', '--', '--out', 'y']]) {
  assert.throws(() => parseArgs(bad), 'должно быть отклонено: ' + bad.join(' '))
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-aa-'))
try {
  const file = path.join(dir, 'aa-summary.json')
  writeSummary(file, summary)
  assert.throws(() => writeSummary(file, three), /EEXIST/, 'прежняя сводка не перезаписывается')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
console.log('PASS bench A/A: spread per scenario, two runs only an initial noise estimate, strict provenance, no effect claims')
