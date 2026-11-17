'use strict'

// Fixed matrix: stack in, checks out. The agent does not choose tools.
// Every check is annotated with tool availability; a missing tool is not_run with
// the exact command, never a silent green.
const { probe } = require('./tools.cjs')

const MATRIX = {
  node: [
    { id: 'deps', tool: 'npm', command: ['npm', 'audit', '--json'] },
    { id: 'static', tool: 'semgrep', command: ['semgrep', '--config', 'p/owasp-top-ten', '--json', '.'] },
    { id: 'tests', tool: 'node', command: ['node', 'tools/safety/test-audit.cjs', '.'] },
    { id: 'mutants', tool: 'stryker', command: ['npx', '--no-install', 'stryker', 'run'] }
  ],
  python: [
    { id: 'deps', tool: 'pip-audit', command: ['pip-audit', '--format', 'json'] },
    { id: 'static', tool: 'bandit', command: ['bandit', '-r', '.', '-f', 'json'] },
    { id: 'tests', tool: 'node', command: ['node', 'tools/safety/test-audit.cjs', '.'] },
    { id: 'mutants', tool: 'mutmut', command: ['mutmut', 'run'] }
  ],
  go: [
    { id: 'deps', tool: 'govulncheck', command: ['govulncheck', './...'] },
    { id: 'static', tool: 'gosec', command: ['gosec', '-fmt=json', './...'] },
    { id: 'tests', tool: 'node', command: ['node', 'tools/safety/test-audit.cjs', '.'] },
    { id: 'mutants', tool: 'go-mutesting', command: ['go-mutesting', './...'] }
  ],
  rust: [
    { id: 'deps', tool: 'cargo-audit', command: ['cargo', 'audit', '--json'] },
    { id: 'static', tool: 'cargo-clippy', command: ['cargo', 'clippy', '--', '-D', 'warnings'] },
    { id: 'tests', tool: 'node', command: ['node', 'tools/safety/test-audit.cjs', '.'] },
    { id: 'mutants', tool: 'cargo-mutants', command: ['cargo-mutants'] }
  ],
  php: [
    { id: 'deps', tool: 'composer', command: ['composer', 'audit', '--format=json'] },
    { id: 'static', tool: 'semgrep', command: ['semgrep', '--config', 'p/php', '--json', '.'] },
    { id: 'tests', tool: 'node', command: ['node', 'tools/safety/test-audit.cjs', '.'] }
  ],
  dotnet: [
    { id: 'deps', tool: 'dotnet', command: ['dotnet', 'list', 'package', '--vulnerable', '--format', 'json'] },
    { id: 'static', tool: 'semgrep', command: ['semgrep', '--config', 'p/csharp', '--json', '.'] },
    { id: 'tests', tool: 'node', command: ['node', 'tools/safety/test-audit.cjs', '.'] }
  ]
}

function annotate (check, probeTool) {
  const found = probeTool({ name: check.tool })
  if (!found.available) {
    return { ...check, available: false, version: null, notRun: { reason: 'tool not found: ' + check.tool, command: check.command } }
  }
  return { ...check, available: true, version: found.version, notRun: null }
}

function route (profile, options = {}) {
  const probeTool = options.probe || probe
  const unknown = []
  const checks = []
  for (const stack of profile.stacks || []) {
    if (!MATRIX[stack.name]) { unknown.push(stack.name); continue }
    for (const check of MATRIX[stack.name]) {
      checks.push(annotate({ ...check, stack: stack.name, confidence: stack.confidence }, probeTool))
    }
  }
  return { checks, unknown }
}

module.exports = { route, MATRIX }

if (require.main === module) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--stack')
  let profile
  if (at >= 0 && args[at + 1]) profile = JSON.parse(args[at + 1])
  else if (args[0]) { const { detect } = require('./stack-detect.cjs'); profile = detect(require('node:path').resolve(args[0])) }
  else { console.error('usage: node tools/safety/route.cjs --stack <json> | <dir>'); process.exit(2) }
  console.log(JSON.stringify(route(profile), null, 2))
}
