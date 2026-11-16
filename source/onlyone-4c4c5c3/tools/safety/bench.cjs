'use strict'

// Measures the audit on seeded fixtures. Numbers carry a date and a revision.
// Every stack fixture is scored separately: planted fake-green must be found,
// honest files must not be accused, and a missing tool is listed as not_run.
// Scanners are executed, not routed: each entry records status, version, exit,
// a stdout hash and the parsed findings, so "clean" and "never ran" never look alike.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execSync, spawnSync } = require('node:child_process')
const { detect } = require('./stack-detect.cjs')
const { route } = require('./route.cjs')
const { audit } = require('./test-audit.cjs')
const { probe, pipVersions } = require('./tools.cjs')
const { run: scan, spawnFor } = require('./scan.cjs')
const { mutate, mutateLocal } = require('./mutate.cjs')

const key = f => `${f.file}:${f.line}:${f.kind}`

// Fixtures are deliberately vulnerable; expected is the minimum that proves the
// scanner analysed the file instead of returning an empty result.
const SCANS = [
  {
    stack: 'node',
    id: 'static',
    tool: 'semgrep',
    cwd: 'scan-node',
    argv: ['--config', 'rules.yml', '--json', '--no-git-ignore', 'app.js'],
    expected: 2,
    why: 'child_process.exec with a tainted string and path.join traversal'
  },
  {
    stack: 'python',
    id: 'static',
    tool: 'bandit',
    cwd: 'scan-python',
    argv: ['-r', '.', '-f', 'json', '-q'],
    expected: 2,
    why: 'subprocess with shell=True and a hardcoded password'
  },
  {
    stack: 'node',
    id: 'deps',
    tool: 'npm',
    audit: true,
    expected: 1,
    why: 'lodash 4.17.15 in a temporary package'
  }
]

const VULNERABLE_DEP = { name: 'lodash', version: '4.17.15' }

function score (want, got, honest) {
  const wantSet = new Set(want)
  const gotSet = new Set(got)
  const tp = [...gotSet].filter(k => wantSet.has(k)).length
  const falsePositives = gotSet.size - tp
  const falseNegatives = wantSet.size - tp
  const honestAccused = got.filter(k => honest.some(f => k.startsWith(f + ':'))).length
  const precision = gotSet.size ? tp / gotSet.size : 1
  const recall = wantSet.size ? tp / wantSet.size : 1
  return {
    precision,
    recall,
    falsePositives,
    falseNegatives,
    found: gotSet.size,
    expected: wantSet.size,
    honestAccused,
    unexpected: [...gotSet].filter(k => !wantSet.has(k)),
    missing: [...wantSet].filter(k => !gotSet.has(k)),
    passed: falsePositives === 0 && falseNegatives === 0 && honestAccused === 0
  }
}

function evaluateStack (dir, name, probeTool, tools) {
  const expectedFile = path.join(dir, 'expected.json')
  if (!fs.existsSync(expectedFile)) return { stack: name, scored: false, reason: 'no expected.json' }
  const spec = JSON.parse(fs.readFileSync(expectedFile, 'utf8'))
  const profile = detect(dir)
  const plan = route(profile, { probe: probeTool })
  const findings = audit(dir).map(key)
  const metrics = score(spec.findings || [], findings, spec.honest || [])
  for (const check of plan.checks) tools[check.tool] = { available: check.available, version: check.version, notRun: Boolean(check.notRun) }
  const confirmation = profile.stacks.map(s => `${s.name}:${s.confidence}`)
  const confirmed = profile.stacks.some(s => s.name === spec.stack && s.confidence === 'confirmed')
  return {
    stack: name,
    expectedStack: spec.stack,
    detected: confirmation,
    checks: plan.checks.map(c => c.id),
    notRun: plan.checks.filter(c => c.notRun).map(c => ({ id: c.id, tool: c.tool, command: c.command, reason: c.notRun.reason })),
    metrics: { ...metrics, passed: metrics.passed && confirmed },
    scored: true
  }
}

function firstLine (text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0] || null
}

function registryReachable (npm, timeout = 20000) {
  // The configured registry is the person's choice; no address is added here.
  const run = spawnFor(npm.command || 'npm', ['ping', '--fetch-timeout=4000', '--fetch-retries=0', '--loglevel=silent'], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: false
  })
  if (run.error) return { ok: false, reason: 'npm ping failed: ' + run.error.message }
  if (run.status !== 0) return { ok: false, reason: 'npm ping exit ' + run.status + ': ' + (firstLine(run.stderr) || firstLine(run.stdout) || 'no output') }
  return { ok: true, reason: null }
}

// A temporary package with one known-vulnerable dependency. Nothing is written to
// the repo; the audit needs the registry, so an unreachable registry is not_run with
// the ping output, never a quiet pass.
function npmAuditScan (options = {}) {
  const probeTool = options.probe || probe
  const npm = probeTool({ name: 'npm' })
  const base = {
    tool: 'npm',
    available: npm.available,
    version: npm.version,
    command: [npm.command || 'npm', 'audit', '--json'],
    exit: null,
    stdout_sha256: null,
    findings: []
  }
  if (!npm.available) return { ...base, status: 'not_run', reason: 'tool not found: npm' }
  if (options.registry === false) return { ...base, status: 'not_run', reason: 'registry not probed: ' + (options.reason || 'disabled by caller') }
  const reachable = registryReachable(npm)
  if (!reachable.ok) return { ...base, status: 'not_run', reason: 'registry unreachable: ' + reachable.reason }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-audit-'))
  try {
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({
      name: 'safety-audit-fixture',
      version: '1.0.0',
      private: true,
      dependencies: { [VULNERABLE_DEP.name]: VULNERABLE_DEP.version }
    }, null, 2))
    const lock = spawnFor(npm.command || 'npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-timeout=20000'], {
      cwd: work,
      encoding: 'utf8',
      timeout: options.timeout || 120000,
      windowsHide: true,
      shell: false
    })
    if (lock.error || lock.status !== 0) {
      return { ...base, status: 'not_run', reason: 'no lockfile: npm install exit ' + lock.status + ': ' + (firstLine(lock.error ? lock.error.message : lock.stderr) || 'no output') }
    }
    const record = scan({ tool: 'npm', argv: ['audit', '--json'], cwd: work, timeout: options.timeout || 120000, probeTool })
    // A registry without the audit endpoint answers with an error document: not_run
    // with that exact text, never a clean audit.
    if (record.status === 'error') return { ...record, status: 'not_run', reason: 'registry audit unavailable: ' + record.reason }
    return record
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

function annotateScan (record, spec) {
  return {
    stack: spec.stack,
    id: spec.id,
    tool: spec.tool,
    why: spec.why,
    available: record.available,
    status: record.status,
    version: record.version,
    command: record.command,
    exit: record.exit,
    stdout_sha256: record.stdout_sha256,
    durationMs: record.durationMs || null,
    findings: record.findings || [],
    findingsCount: (record.findings || []).length,
    expected: spec.expected,
    verified: record.status === 'findings' && (record.findings || []).length >= spec.expected,
    reason: record.reason || null
  }
}

function scanAll (fixturesDir, options = {}) {
  const entries = []
  for (const spec of SCANS) {
    if (options.scans === false) {
      entries.push(annotateScan({ available: false, status: 'not_run', version: null, command: [spec.tool], exit: null, stdout_sha256: null, findings: [], reason: 'scans disabled by caller' }, spec))
      continue
    }
    if (spec.audit) {
      entries.push(annotateScan(npmAuditScan(options), spec))
      continue
    }
    const cwd = path.join(fixturesDir, spec.cwd)
    const record = scan({ tool: spec.tool, argv: spec.argv, cwd, timeout: options.timeout, probeTool: options.probe })
    entries.push(annotateScan(record, spec))
  }
  // A scan passes only when the tool ran on a seeded vulnerability and found it.
  const passed = entries.every(entry => entry.verified)
  return { entries, passed }
}

function mutationReport (fixturesDir, options = {}) {
  const fixture = path.join(fixturesDir, 'mutate-python')
  const engine = options.mutation === false
    ? { status: 'not_run', reason: 'mutation disabled by caller', engine: 'mutmut', command: null, exit: null }
    : mutate('python', { root: fixture, timeout: options.mutationTimeout || 120000, probe: options.probe })
  const local = options.mutation === false
    ? { status: 'not_run', reason: 'mutation disabled by caller', engine: 'local', mutants: [] }
    : mutateLocal(fixture, { probe: options.probe })
  return {
    engine,
    local,
    passed: local.status === 'run' && local.survived > 0
  }
}

function versions (options = {}) {
  const probeTool = options.probe || probe
  const binaries = {}
  for (const name of ['node', 'npm', 'semgrep', 'bandit', 'mutmut', 'python']) {
    const found = probeTool({ name })
    binaries[name] = found.available ? found.version : null
  }
  const pythonPackages = options.probe ? {} : pipVersions(['semgrep', 'bandit', 'mutmut'])
  return {
    binaries,
    pythonPackages,
    resolved: {
      semgrep: (pythonPackages.semgrep || binaries.semgrep || null),
      bandit: (pythonPackages.bandit || binaries.bandit || null),
      mutmut: (pythonPackages.mutmut || binaries.mutmut || null),
      npm: binaries.npm,
      node: binaries.node,
      python: binaries.python
    }
  }
}

function evaluate (fixturesDir, options = {}) {
  const expected = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'expected.json'), 'utf8'))
  const found = audit(path.join(fixturesDir, 'fake-green'))
  const honest = audit(path.join(fixturesDir, 'honest'))
  const legacy = score(expected.findings, found.map(key), ['test-honest.cjs'])
  const legacyHonest = honest.length

  const tools = {}
  const probeTool = options.probe || (args => {
    const result = probe(args)
    tools[result.name] = { available: result.available, version: result.version, notRun: !result.available }
    return result
  })
  const stacksRoot = path.join(fixturesDir, 'stacks')
  const names = fs.existsSync(stacksRoot)
    ? fs.readdirSync(stacksRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
    : []
  const stacks = names.map(name => evaluateStack(path.join(stacksRoot, name), name, probeTool, tools))
  const scored = stacks.filter(s => s.scored)
  const nodeStack = scored.find(s => s.stack === 'node')

  const scanners = scanAll(fixturesDir, { ...options, probe: options.probe || probe })
  const mutation = mutationReport(fixturesDir, { ...options, probe: options.probe || probe })

  return {
    precision: legacy.precision,
    recall: legacy.recall,
    falsePositives: legacy.falsePositives,
    falseNegatives: legacy.falseNegatives,
    found: legacy.found,
    expected: legacy.expected,
    honestFindings: legacyHonest,
    nodeChecks: nodeStack ? nodeStack.checks : [],
    stacks,
    tools,
    scanners,
    mutation,
    versions: versions({ probe: options.probe }),
    passed: legacy.passed && legacyHonest === 0 && scored.length === names.length && scored.every(s => s.metrics.passed)
  }
}

function report (fixturesDir, options = {}) {
  const result = evaluate(fixturesDir, options)
  let revision = ''
  try { revision = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim() } catch {}
  return {
    date: new Date().toISOString(),
    revision,
    fixture: fixturesDir,
    versions: result.versions,
    metrics: {
      precision: result.precision,
      recall: result.recall,
      falsePositives: result.falsePositives,
      falseNegatives: result.falseNegatives,
      found: result.found,
      expected: result.expected,
      honestFindings: result.honestFindings,
      passed: result.passed
    },
    perStack: result.stacks.map(s => ({ stack: s.stack, metrics: s.metrics, notRun: s.notRun })),
    scanners: result.scanners,
    mutation: result.mutation,
    tools: result.tools,
    overall: {
      precision: result.precision,
      recall: result.recall,
      falsePositives: result.falsePositives,
      falseNegatives: result.falseNegatives,
      found: result.found,
      expected: result.expected,
      honestFindings: result.honestFindings,
      scannersPassed: result.scanners.passed,
      mutationPassed: result.mutation.passed,
      passed: result.passed
    }
  }
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'tests', 'fixtures', 'safety'))
  const out = path.resolve(process.argv[3] || 'safety-report.json')
  const data = report(dir)
  fs.writeFileSync(out, JSON.stringify(data, null, 2), 'utf8')
  console.log(JSON.stringify(data))
  if (!data.metrics.passed) process.exitCode = 1
}

module.exports = { evaluate, score, report, scanAll, npmAuditScan, SCANS }
