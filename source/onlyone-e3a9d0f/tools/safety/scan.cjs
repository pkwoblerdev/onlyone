'use strict'

// One routed check, actually executed. The runner resolves the binary, records its
// version, runs argv with a timeout and hashes stdout, so a caller can prove a scan
// happened instead of trusting a route. Findings are parsed per tool; an
// unparsable output is an error, never a clean pass.
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { probe } = require('./tools.cjs')

const DEFAULT_TIMEOUT = 300000
const MAX_FINDINGS = 200

function sha256 (text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex')
}

function rel (file, cwd) {
  if (!file) return null
  return path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/')
}

const PARSERS = {
  semgrep (json, cwd) {
    return (json.results || []).map(r => ({
      file: rel(r.path, cwd),
      line: (r.start && r.start.line) || null,
      id: r.check_id,
      severity: (r.extra && r.extra.severity) || null,
      message: (r.extra && r.extra.message) || ''
    }))
  },
  bandit (json, cwd) {
    return (json.results || []).map(r => ({
      file: rel(r.filename, cwd),
      line: r.line_number || null,
      id: r.test_id,
      severity: r.issue_severity || null,
      message: r.issue_text || ''
    }))
  },
  'npm-audit' (json) {
    // npm prints an error document instead of a report when the registry lacks the
    // audit endpoint (mirrors often do). That is not a clean result.
    if (!json || typeof json.vulnerabilities !== 'object' || json.vulnerabilities === null) {
      const detail = (json && json.error && (json.error.summary || json.error.detail)) || (json && json.message) || 'no vulnerabilities block'
      throw new Error('npm audit error: ' + String(detail).slice(0, 300))
    }
    return Object.entries(json.vulnerabilities).map(([name, v]) => ({
      file: 'package.json',
      line: null,
      id: name,
      severity: v.severity || null,
      message: v.range ? name + ' ' + v.range : name
    }))
  }
}

function parserFor (tool) {
  return PARSERS[tool] || (tool === 'npm' ? PARSERS['npm-audit'] : null)
}

function parse (tool, stdout, cwd) {
  const parser = parserFor(tool)
  if (!parser) return { findings: [], parsed: true }
  let json
  try { json = JSON.parse(String(stdout || '')) } catch { return { findings: [], parsed: false, reason: 'stdout is not JSON' } }
  try { return { findings: parser(json, cwd).slice(0, MAX_FINDINGS), parsed: true } } catch (e) { return { findings: [], parsed: false, reason: 'cannot read findings: ' + e.message } }
}

// A Windows .cmd/.bat is not spawnable without cmd; tokens are quoted so a fixed
// matrix cannot turn into a shell command.
function quoteArg (arg) {
  return /[\s"&|<>^]/.test(arg) ? '"' + String(arg).replace(/"/g, '""') + '"' : String(arg)
}

function spawnFor (execPath, argv, options) {
  if (/\.(?:cmd|bat)$/i.test(execPath)) {
    // cmd /s strips one outer quote pair; wrapping the whole line keeps the quoted path.
    // windowsVerbatimArguments stops Node from backslash-escaping quotes cmd cannot read.
    const line = `"${execPath}" ${argv.map(quoteArg).join(' ')}`
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + line + '"'], { ...options, windowsVerbatimArguments: true })
  }
  return spawnSync(execPath, argv, options)
}

function run ({ tool, argv = [], cwd = process.cwd(), timeout = DEFAULT_TIMEOUT, env = {}, probeTool = probe } = {}) {
  if (!tool) throw new Error('scan needs a tool name')
  if (!Array.isArray(argv)) throw new Error('scan argv must be an array')
  const workDir = path.resolve(cwd)
  const found = probeTool({ name: tool })
  const record = { tool, available: found.available, version: found.version, command: [found.command || tool, ...argv], cwd: workDir }

  if (!found.available) {
    return {
      ...record,
      status: 'not_run',
      exit: null,
      stdout_sha256: null,
      findings: [],
      reason: 'tool not found: ' + tool
    }
  }

  const started = Date.now()
  const res = spawnFor(record.command[0], argv, {
    cwd: workDir,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
    // A launcher may call a sibling binary by name (semgrep.exe runs pysemgrep).
    env: {
      ...process.env,
      ...env,
      PATH: path.dirname(record.command[0]) + path.delimiter + (process.env.PATH || '')
    }
  })
  const durationMs = Date.now() - started
  const stdout = String(res.stdout || '')
  const stderr = String(res.stderr || '')
  const base = {
    ...record,
    exit: res.status,
    signal: res.signal || null,
    stdout_sha256: sha256(stdout),
    stderr: stderr.slice(0, 2000),
    durationMs
  }

  if (res.error) {
    const timedOut = res.error.code === 'ETIMEDOUT'
    return {
      ...base,
      status: timedOut ? 'timeout' : 'error',
      findings: [],
      reason: (timedOut ? 'timeout after ' + timeout + ' ms: ' : '') + res.error.message
    }
  }

  const parsed = parse(tool, stdout, workDir)
  if (!parsed.parsed) {
    return {
      ...base,
      status: 'error',
      findings: [],
      reason: (parsed.reason || 'unparsable output') + '; exit ' + res.status
    }
  }

  return {
    ...base,
    status: parsed.findings.length ? 'findings' : 'clean',
    findings: parsed.findings,
    reason: null
  }
}

function usage () {
  console.error('usage: node tools/safety/scan.cjs --tool <name> [--cwd <dir>] [--timeout <ms>] [--out <file>] -- <argv...>')
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const option = name => {
    const at = args.indexOf('--' + name)
    if (at < 0) return null
    const value = args[at + 1]
    args.splice(at, 2)
    return value
  }
  const tool = option('tool')
  const cwd = option('cwd') || process.cwd()
  const timeout = Number(option('timeout') || DEFAULT_TIMEOUT)
  const out = option('out')
  if (!tool) { usage(); process.exit(2) }
  const split = args.indexOf('--')
  const argv = split >= 0 ? args.slice(split + 1) : args.filter(a => a !== '')
  const record = run({ tool, argv, cwd, timeout })
  const text = JSON.stringify(record, null, 2)
  if (out) fs.writeFileSync(path.resolve(out), text, 'utf8')
  console.log(text)
  process.exitCode = record.status === 'not_run' ? 3 : record.status === 'error' || record.status === 'timeout' ? 1 : 0
}

module.exports = { run, parse, spawnFor, quoteArg, sha256, DEFAULT_TIMEOUT, PARSERS }
