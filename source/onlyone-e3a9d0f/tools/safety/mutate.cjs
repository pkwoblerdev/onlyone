'use strict'

// Mutation engines per stack. Run only when the engine is already installed:
// this tool never installs anything and a missing engine is reported as not_run
// with the exact command — it is not scored as a pass. An engine that exits 0 but
// prints no mutation result (mutmut refuses native Windows) is not_run as well:
// silence is a gap, not a green.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { probe, pipVersions } = require('./tools.cjs')

const ENGINES = {
  node: { engine: 'stryker', argv: ['run'] },
  python: { engine: 'mutmut', argv: ['run'] },
  go: { engine: 'go-mutesting', argv: ['./...'] },
  rust: { engine: 'cargo-mutants', argv: [] }
}

// A run counts only with a result line: "3 mutants survived" or similar.
function evidence (output) {
  const text = String(output || '')
  const survived = /(\d+)\s+(?:mutants?\s+)?survived/i.exec(text)
  const killed = /(\d+)\s+(?:mutants?\s+)?killed/i.exec(text)
  if (!survived && !killed && !/survived|killed/i.test(text)) return null
  const number = match => (match ? Number(match[1]) : null)
  return { survived: number(survived), killed: number(killed), total: null }
}

function firstLine (output) {
  return String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0] || null
}

function mutate (stack, options = {}) {
  const spec = ENGINES[stack]
  if (!spec) {
    return { stack, engine: null, status: 'not_run', command: null, exit: null, reason: 'no mutation engine for stack: ' + stack }
  }
  const found = (options.probe || probe)({ name: spec.engine, root: options.root })
  const command = [found.command || spec.engine, ...spec.argv]
  if (!found.available) {
    return { stack, engine: spec.engine, status: 'not_run', command, exit: null, reason: 'mutation engine not installed: ' + spec.engine }
  }
  if (options.dryRun) {
    return { stack, engine: spec.engine, status: 'not_run', command, exit: null, reason: 'dry run: engine present, not executed' }
  }
  const run = spawnSync(command[0], command.slice(1), {
    cwd: options.root || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeout || 600000,
    windowsHide: true,
    shell: false,
    env: { ...process.env, PATH: path.dirname(command[0]) + path.delimiter + (process.env.PATH || '') }
  })
  const stdout = String(run.stdout || '')
  const stderr = String(run.stderr || '')
  const output = [stdout, stderr].filter(Boolean).join('\n').trim()
  const result = evidence(output)
  const base = {
    stack,
    engine: spec.engine,
    command,
    exit: run.status,
    signal: run.signal || null,
    version: found.version || (pipVersions([spec.engine])[spec.engine] || null)
  }
  if (run.error) return { ...base, status: 'not_run', reason: run.error.message, output: output.slice(0, 2000) }
  if (!result) {
    return {
      ...base,
      status: 'not_run',
      reason: 'engine exited ' + run.status + ' without a mutation result: ' + (firstLine(output) || 'no output'),
      output: output.slice(0, 2000)
    }
  }
  return {
    ...base,
    status: 'run',
    reason: null,
    survived: result.survived,
    killed: result.killed,
    output: output.slice(0, 2000)
  }
}

// Fallback engine for platforms the named engine refuses: patch-based mutants from
// mutations.json in the fixture, run against the fixture's own unittest module.
// It reports exactly what it ran, so a survivor is a measured survivor.
function mutateLocal (fixtureDir, options = {}) {
  const specFile = path.join(fixtureDir, 'mutations.json')
  if (!fs.existsSync(specFile)) return { engine: 'local', status: 'not_run', reason: 'no mutations.json in ' + fixtureDir, mutants: [] }
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
  const python = (options.probe || probe)({ name: options.python || 'python' })
  const command = [python.command || 'python', '-m', 'unittest', '-q', spec.module]
  if (!python.available) return { engine: 'local', status: 'not_run', command, reason: 'python not found', mutants: [] }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-mutate-'))
  try {
    for (const name of fs.readdirSync(fixtureDir)) {
      const from = path.join(fixtureDir, name)
      if (fs.statSync(from).isFile() && name !== 'mutations.json') fs.copyFileSync(from, path.join(work, name))
    }
    const target = path.join(work, spec.file)
    const original = fs.readFileSync(target, 'utf8')
    const mutants = (spec.mutants || []).map(mutant => {
      if (!original.includes(mutant.find)) return { id: mutant.id, status: 'not_applied', reason: 'snippet not found in ' + spec.file }
      fs.writeFileSync(target, original.replace(mutant.find, mutant.replace))
      const started = Date.now()
      try {
        const run = spawnSync(command[0], command.slice(1), { cwd: work, encoding: 'utf8', timeout: options.timeout || 60000, windowsHide: true })
        return {
          id: mutant.id,
          file: spec.file,
          line: mutant.line || null,
          change: mutant.change || (mutant.find + ' -> ' + mutant.replace),
          status: run.status === 0 ? 'survived' : 'killed',
          exit: run.status,
          durationMs: Date.now() - started
        }
      } finally {
        fs.writeFileSync(target, original)
      }
    })
    const survived = mutants.filter(m => m.status === 'survived').length
    return {
      engine: 'local',
      status: 'run',
      command,
      file: spec.file,
      mutants,
      survived,
      killed: mutants.filter(m => m.status === 'killed').length,
      reason: null
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

module.exports = { mutate, mutateLocal, ENGINES, evidence }

if (require.main === module) {
  const args = process.argv.slice(2)
  const option = name => {
    const at = args.indexOf('--' + name)
    if (at < 0) return null
    const value = args[at + 1]
    args.splice(at, 2)
    return value
  }
  const fixture = option('fixture')
  const stack = args[0]
  if (!stack && !fixture) { console.error('usage: node tools/safety/mutate.cjs <node|python|go|rust> [--fixture <dir>]'); process.exit(2) }
  const result = fixture ? mutateLocal(path.resolve(fixture)) : mutate(stack, { root: process.cwd() })
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'run') process.exitCode = 3
}
