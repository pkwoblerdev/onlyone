'use strict'
const fs = require('node:fs'), { isDeepStrictEqual } = require('node:util')
function attemptsOf (report, allowed = ['pass', 'agent-error']) {
  if (report?.tool !== 'onlyone-agent-quality-bench' || report.schemaVersion !== 1 || report.completed !== true) throw Error('completed bench report required')
  if (!['self', 'live'].includes(report.mode)) throw Error('invalid mode')
  if (!/^[a-f0-9]{64}$/.test(report.suiteDigest || '')) throw Error('suite digest missing: regenerate with current bench')
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(report.source?.commit || '') || report.source.dirty !== false) throw Error('clean, identified source required')
  if (!Array.isArray(report.attempts) || !report.attempts.length || report.attempts.length > 10000) throw Error('invalid pairs')
  const pairs = new Map()
  for (const item of report.attempts) {
    if (!item || typeof item.scenario !== 'string' || !item.scenario || !Number.isSafeInteger(item.repeat) || item.repeat < 1) throw Error('invalid pair identity')
    const key = JSON.stringify([item.scenario, item.repeat])
    if (pairs.has(key)) throw Error('duplicate pair: ' + key)
    if (item.mode !== report.mode || typeof item.model !== 'string' || !item.model) throw Error('invalid mode/model')
    if (!item.params || typeof item.params.permission !== 'string' || !Number.isFinite(item.params.timeoutMs) || item.params.timeoutMs <= 0) throw Error('missing conditions')
    if (!allowed.includes(item.verdict)) throw Error('infrastructure/provider failure: comparison refused')
    if (typeof item.check?.ok !== 'boolean' || item.check.ok !== (item.verdict === 'pass')) throw Error('inconsistent verdict/check')
    for (const metric of ['durationMs', 'requests', 'tokens']) {
      if (metric !== 'durationMs' && item[metric] === null) continue
      if (!Number.isFinite(item[metric]) || item[metric] < 0 || (metric !== 'durationMs' && !Number.isSafeInteger(item[metric]))) throw Error('invalid ' + metric)
    }
    pairs.set(key, item)
  }
  return pairs
}
const sum = (rows, metric) => {
  if (rows.some(row => row[metric] === null)) return null
  const total = rows.reduce((value, row) => value + row[metric], 0)
  return Number.isFinite(total) && (metric === 'durationMs' || Number.isSafeInteger(total)) ? total : null
}
const delta = (a, b) => a === null || b === null ? null : b - a
function compareReports (a, b, kind) {
  if (!['aa', 'ab', 'lessons'].includes(kind)) throw Error('kind must be aa, ab or lessons')
  const allowed = kind === 'lessons' ? ['pass', 'agent-error', 'provider-error'] : ['pass', 'agent-error']
  const left = attemptsOf(a, allowed), right = attemptsOf(b, allowed)
  if (a.mode !== b.mode) throw Error('mode differs')
  if (a.suiteDigest !== b.suiteDigest) throw Error('suite differs')
  if (kind === 'aa' && a.source.commit !== b.source.commit) throw Error('AA source differs')
  // Сравнение уроков — та же ревизия и та же модель: иначе эффект урока смешан
  // с изменением кода или маршрутизации.
  if (kind === 'lessons' && a.source.commit !== b.source.commit) throw Error('lesson comparison source differs')
  if (left.size !== right.size || [...left.keys()].some(key => !right.has(key))) throw Error('pairs differ: no unmatched attempts may be discarded')
  const excluded = []
  const ordered = [...left.values()].sort((x, y) => x.scenario.localeCompare(y.scenario) || x.repeat - y.repeat)
  const picked = ordered.filter(one => {
    if (kind !== 'lessons') return true
    const two = right.get(JSON.stringify([one.scenario, one.repeat]))
    if (!one.lessons && !two.lessons) {
      // Задача без уроков не участвует в сравнении off/on, но и не исчезает молча.
      excluded.push({ scenario: one.scenario, repeat: one.repeat, reason: 'no lessons metadata' })
      return false
    }
    if (!one.lessons || !two.lessons) throw Error('lessons metadata missing: ' + one.scenario)
    return true
  })
  if (kind === 'lessons' && !picked.length) throw Error('no lesson pairs: nothing to compare off/on')
  const pairs = picked.map(one => {
    const two = right.get(JSON.stringify([one.scenario, one.repeat]))
    if (kind === 'aa' && one.model !== two.model) throw Error('AA model differs')
    if (kind === 'lessons' && one.model !== two.model) throw Error('lesson comparison model differs: ' + one.scenario)
    if (!isDeepStrictEqual(one.params, two.params) || one.expected !== two.expected) throw Error('conditions differ: ' + one.scenario)
    if (kind === 'lessons') {
      // A — без уроков, B — с уроками: тот же проект, те же ожидания и условия,
      // отличается только набор уроков. Провайдерская ошибка — свой исход пары.
      if (one.lessons.profile !== 'off' || two.lessons.profile !== 'on') throw Error('lessons profiles must be off then on: ' + one.scenario)
      if (one.lessons.projectId !== two.lessons.projectId) throw Error('lessons project differs: ' + one.scenario)
      if (!isDeepStrictEqual(one.lessons.expected, two.lessons.expected)) throw Error('lessons expectations differ: ' + one.scenario)
    }
    const metrics = Object.fromEntries(['durationMs', 'requests', 'tokens'].map(metric => [metric, { a: one[metric], b: two[metric], delta: delta(one[metric], two[metric]) }]))
    const providerError = one.verdict === 'provider-error' || two.verdict === 'provider-error'
    return { scenario: one.scenario, repeat: one.repeat, models: { a: one.model, b: two.model },
      verdicts: { a: one.verdict, b: two.verdict },
      outcome: providerError ? 'provider-error' : one.verdict === two.verdict ? 'unchanged' : two.verdict === 'pass' ? 'improved' : 'regressed',
      failures: { a: one.failure || null, b: two.failure || null },
      stopReasons: { a: one.stopReason || null, b: two.stopReason || null },
      checks: { a: String(one.check?.detail || '').slice(0, 300), b: String(two.check?.detail || '').slice(0, 300) },
      ...metrics }
  })
  const totalsOf = rows => { return { attempts: rows.length, passed: rows.filter(row => row.verdict === 'pass').length,
    providerErrors: rows.filter(row => row.verdict === 'provider-error').length,
    durationMs: sum(rows, 'durationMs'), requests: sum(rows, 'requests'), tokens: sum(rows, 'tokens'),
    falseDone: rows.every(row => typeof row.falseDone === 'boolean') ? rows.filter(row => row.falseDone).length : null } }
  const totalsA = totalsOf(picked), totalsB = totalsOf(picked.map(one => right.get(JSON.stringify([one.scenario, one.repeat]))))
  return { tool: 'onlyone-agent-quality-comparison', schemaVersion: 1, kind, mode: a.mode,
    evidence: a.mode === 'self' ? 'scripted-self-check-only' : 'live-observations', effectProven: false,
    configurationFullyVerified: false,
    limitations: ['Descriptive paired observations only; no statistical effect or acceptance decision.',
      'Models are requested IDs; actual routing, effort, skills and complete environment are not verified.',
      ...(kind === 'lessons' ? ['Lesson delivery is observed in the provider request (or the lessons-store probe in live); a model following a lesson is not proven.',
        'Tasks without lessons metadata are listed in excluded, not silently dropped.',
        'Provider errors stay a separate outcome; unknown spend stays null, never zero.'] : []),
      ...(a.mode === 'self' ? ['Scripted replies test the bench, not real model quality.'] : [])],
    sources: { a: a.source.commit, b: b.source.commit }, suiteDigest: a.suiteDigest, excluded, pairs,
    totals: { a: totalsA, b: totalsB, durationMsDelta: delta(totalsA.durationMs, totalsB.durationMs),
      requestsDelta: delta(totalsA.requests, totalsB.requests), tokensDelta: delta(totalsA.tokens, totalsB.tokens) } }
}
function writeComparison (file, result) { fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }) }
function main (argv) {
  let kind, out; const files = []
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--kind' || key === '--out') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw Error('missing value: ' + key)
      if (key === '--kind') { if (kind) throw Error('duplicate kind'); kind = value } else { if (out) throw Error('duplicate out'); out = value }
    } else if (key.startsWith('--')) throw Error('unknown argument: ' + key)
    else files.push(key)
  }
  if (!kind || !out || files.length !== 2) throw Error('Usage: npm run bench:compare -- --kind aa|ab|lessons --out new.json A/report.json B/report.json')
  const reports = files.map(file => {
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw Error('report too large')
    const text = fs.readFileSync(file, 'utf8')
    try { return JSON.parse(text) } catch { throw Error('invalid report JSON') }
  })
  const result = compareReports(reports[0], reports[1], kind)
  writeComparison(out, result)
  console.log(JSON.stringify({ report: out, pairs: result.pairs.length, evidence: result.evidence, effectProven: false }))
}
if (require.main === module) { try { main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 2 } }
module.exports = { compareReports, writeComparison }
