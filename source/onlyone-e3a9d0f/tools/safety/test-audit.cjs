'use strict'

// Finds tests that can only be green: no assertions, skipped, empty catch, tautologies.
// Language patterns are matched per line; a line yields at most one finding per kind.
const fs = require('node:fs')
const path = require('node:path')

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'out', 'vendor', 'fixtures', 'audits'])
const TEST_FILE = new RegExp([
  '(^|[/\\\\])(?:test|spec)[^/\\\\]*\\.(?:c?js|mjs|ts|tsx|py|rs|php|cs)$',
  '[^/\\\\]*_test\\.(?:go|py)$',
  '[^/\\\\]*\\.(?:test|spec)\\.(?:c?js|mjs|ts|tsx)$',
  '(^|[/\\\\])tests[/\\\\][^/\\\\]+\\.rs$',
  '(^|[/\\\\])[^/\\\\]*Tests?\\.(?:php|cs)$'
].join('|'), 'i')

const SKIPPED = [
  /(?:it|test|describe)\.skip\b/,
  /\bxit\s*\(/,
  /\bxtest\s*\(/,
  /@unittest\.skip/,
  /pytest\.mark\.skip/,
  /\bpytest\.skip\s*\(/,
  /\bt\.Skip(?:Now|f)?\s*\(/,
  /#\[ignore\b/,
  /markTest(?:Skipped|Incomplete)\s*\(/,
  /\[(?:Fact|Theory)\(\s*Skip\s*=/,
  /\[Ignore\b/
]

const TAUTOLOGY = [
  /assert\.(?:ok|equal)\(\s*true\b/,
  /expect\(\s*true\s*\)\.toBe\(\s*true\s*\)/,
  /assertEquals\(\s*1\s*,\s*1\s*\)/,
  /\bassert\s+True\b/,
  /assert(?:True|Same|Equals?)\(\s*(?:True|true|1)\s*\)/,
  /Assert\.True\(\s*true\s*\)/,
  /assert(?:_eq|_ne)!\(\s*([\w.]+)\s*,\s*\1\s*\)/,
  /assert(?:Equal|Equals|Same)\(\s*([\w.]+)\s*,\s*\1\s*\)/
]

// A test body must show one assertion call in any of the supported languages.
// Matching stays case-sensitive and word-bounded, otherwise prose ("shouldShow",
// "expects") counts as an assertion and the no-assert check goes quiet.
const ASSERT = new RegExp([
  '\\b(?:assert|expect|should)\\b',
  'assert(?:Equals?|True|False|Same|NotSame|NotEqual|In|Is)\\s*\\(',
  '->assert\\w+\\s*\\(',
  '\\bAssert\\.',
  'assert(?:_eq|_ne|_matches)!',
  '\\bt\\.(?:Error|Fatal|Run|Skip)'
].join('|'))

function audit (root) {
  const findings = []
  const walk = dir => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue }
      if (path.resolve(full) === __filename) continue // the auditor's own pattern literals are not tests
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (!TEST_FILE.test(rel)) continue
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
      const body = lines.join('\n')
      if (!ASSERT.test(body)) findings.push({ file: rel, line: 1, kind: 'no-assert' })
      lines.forEach((line, i) => {
        const n = i + 1
        const seen = new Set()
        if (SKIPPED.some(re => re.test(line))) { findings.push({ file: rel, line: n, kind: 'skipped' }); seen.add('skipped') }
        if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(line) && !seen.has('empty-catch')) findings.push({ file: rel, line: n, kind: 'empty-catch' })
        if (TAUTOLOGY.some(re => re.test(line)) && !seen.has('tautology')) findings.push({ file: rel, line: n, kind: 'tautology' })
      })
    }
  }
  walk(root)
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind))
  return findings
}

if (require.main === module) {
  const root = process.argv[2]
  if (!root) { console.error('usage: node tools/safety/test-audit.cjs <dir>'); process.exit(2) }
  console.log(JSON.stringify({ root, findings: audit(path.resolve(root)) }, null, 2))
}

module.exports = { audit, TEST_FILE }
