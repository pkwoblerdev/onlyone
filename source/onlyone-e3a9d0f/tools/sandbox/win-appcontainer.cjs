'use strict'
// Windows AppContainer boundary for plugin workers and tool runs.
// A child gets an AppContainer token whose capabilities depend on `net`: `off` (default)
// grants none at all, `on` grants internetClient and nothing else. The
// container SID is granted read+execute only on the workspace (and on a staged copy of
// node.exe); every ACE added is removed again when the run ends (`cleanup`).
// Job Object limits from win-job.cjs are applied on top: AppContainer is additive.
// The executable is staged into a temp directory because a container cannot read
// Program Files; the staged copy is byte-identical to process.execPath.
//
// Test-only: ONLYONE_SANDBOX_PLATFORM fakes the platform guard when NODE_ENV=test; there
// is no Linux sandbox — the override covers the refusal path, never a real Linux run.
const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PS = path.join(__dirname, 'win-appcontainer.ps1')
const STAGE_ROOT = path.join(os.tmpdir(), 'onlyone-appcontainer')
// App capability name for the network. The helper derives the capability SID from it:
// internetClient -> S-1-15-3-1. The often-quoted S-1-15-2-1 is the group form and makes
// CreateProcess fail with ERROR_INVALID_PARAMETER (87), so it is never passed.
const INTERNET_CLIENT = 'internetClient'

let cached = null
let configCounter = 0

// `net: 'off'` (default) keeps the token capability-free; `net: 'on'` adds exactly
// internetClient. Anything else is a caller bug, not a silent downgrade.
function capabilitiesFor (net) {
  if (net === undefined || net === null || net === 'off') return []
  if (net === 'on') return [INTERNET_CLIENT]
  throw Object.assign(new Error('net must be "off" or "on", got ' + JSON.stringify(net)), { code: 'SANDBOX_ERROR' })
}

function platform () {
  const override = process.env.ONLYONE_SANDBOX_PLATFORM
  if (override && process.env.NODE_ENV === 'test') return override
  return process.platform
}

function powershell () {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function unavailable (reason) {
  return Object.assign(new Error('AppContainer unavailable: ' + reason), { code: 'SANDBOX_UNAVAILABLE' })
}

function isSameFile (left, right) {
  try {
    return path.resolve(String(left)).toLowerCase() === path.resolve(String(right)).toLowerCase()
  } catch {
    return false
  }
}

function stagedNode () {
  const stat = fs.statSync(process.execPath)
  const key = crypto.createHash('sha256')
    .update(`${process.execPath}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16)
  const dir = path.join(STAGE_ROOT, key)
  const exe = path.join(dir, 'node.exe')
  if (!fs.existsSync(exe) || fs.statSync(exe).size !== stat.size) {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(process.execPath, exe)
  }
  return exe
}

function writeConfig (config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-ac-cfg-'))
  const file = path.join(dir, `config-${process.pid}-${configCounter++}.json`)
  fs.writeFileSync(file, JSON.stringify(config))
  return { file, dir }
}

function invoke (config) {
  const { file, dir } = writeConfig(config)
  try {
    const res = spawnSync(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS, '-ConfigPath', file], {
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    })
    if (res.error) throw Object.assign(new Error('AppContainer helper failed: ' + res.error.message), { code: 'SANDBOX_ERROR' })
    const line = String(res.stdout || '').trim().split('\n').pop()
    try {
      return JSON.parse(line)
    } catch {
      throw Object.assign(new Error('AppContainer helper produced no JSON: ' + String(res.stderr || res.stdout).trim().slice(0, 300)), { code: 'SANDBOX_ERROR' })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function grantList ({ exe, workspace, grants }) {
  const paths = [workspace, path.dirname(exe), ...grants].filter(Boolean)
  const seen = new Set()
  const out = []
  for (const item of paths) {
    const full = path.resolve(String(item))
    const key = full.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(full)
  }
  return out
}

function resolveExe (cmd) {
  return isSameFile(cmd, process.execPath) ? stagedNode() : cmd
}

// One synchronous run with captured output. Throws SANDBOX_UNAVAILABLE when the OS
// cannot build the boundary; never falls back to an unsandboxed run. `cleanup` is the
// verdict on removing the SID ACEs afterwards: 'failed' means the ACL still has them.
function launch ({ cmd, args = [], cwd, workspace, grants = [], net = 'off', timeoutMs = 30000, maxMemoryBytes = 0, maxProcesses = 0, cpuMs = 0 }) {
  if (platform() !== 'win32') throw unavailable('not Windows: AppContainer is a Windows feature')
  const exe = resolveExe(cmd)
  const allowed = grantList({ exe, workspace, grants })
  const io = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-ac-io-'))
  try {
    const out = invoke({
      action: 'run',
      mode: 'capture',
      cmd: exe,
      args,
      cwd: cwd || workspace || path.dirname(exe),
      grants: allowed,
      capabilities: capabilitiesFor(net),
      timeoutMs,
      maxMemoryBytes,
      maxProcesses,
      cpuMs,
      stdoutPath: path.join(io, 'stdout.txt'),
      stderrPath: path.join(io, 'stderr.txt')
    })
    if (out.available === false) throw unavailable(String(out.reason || 'helper refused to run'))
    return {
      code: typeof out.code === 'number' ? out.code : -1,
      stdout: String(out.stdout || ''),
      stderr: String(out.stderr || ''),
      killed: out.killed === true,
      reason: String(out.reason || ''),
      sid: out.sid,
      net,
      capabilities: Array.isArray(out.capabilities) ? out.capabilities.map(String) : [],
      capabilitySids: Array.isArray(out.capabilitySids) ? out.capabilitySids.map(String) : [],
      capabilitiesInToken: Array.isArray(out.capabilitiesInToken) ? out.capabilitiesInToken.map(String) : [],
      cleanup: out.cleanup === 'failed' ? 'failed' : 'ok',
      cleanupError: String(out.cleanupError || '')
    }
  } finally {
    fs.rmSync(io, { recursive: true, force: true })
  }
}

function probe () {
  // Documented escape hatch: hosts that must stay on the Job Object path (and the
  // tests for that path) set this before the first availability check.
  if (process.env.ONLYONE_SANDBOX_JOBS_ONLY === '1') {
    return { available: false, reason: 'AppContainer disabled by ONLYONE_SANDBOX_JOBS_ONLY=1' }
  }
  if (platform() !== 'win32') return { available: false, reason: 'not Windows: AppContainer is a Windows feature' }
  let exe
  try {
    exe = stagedNode()
  } catch (error) {
    return { available: false, reason: 'cannot stage node.exe for the container: ' + error.message }
  }
  try {
    const info = invoke({ action: 'probe' })
    if (!info.available) return { available: false, reason: String(info.reason || 'probe returned no reason') }
    const check = launch({
      cmd: exe,
      args: ['-e', 'process.exit(0)'],
      cwd: path.dirname(exe),
      timeoutMs: 30000
    })
    if (check.code !== 0) {
      return { available: false, reason: `container launch failed (exit ${check.code}): ${(check.stderr || check.stdout || check.reason).trim().slice(0, 300)}` }
    }
    return { available: true, sid: info.sid }
  } catch (error) {
    return { available: false, reason: error.message }
  }
}

// { available, reason? } — the answer is cached for the life of the process.
function available () {
  if (!cached) cached = probe()
  return cached
}

function run (options = {}) {
  const info = available()
  if (!info.available) throw unavailable(info.reason)
  return launch(options)
}

// Streaming child for the plugin host: the sandboxed worker inherits this process's
// std handles, so the line-delimited JSON-RPC protocol works unchanged. `env` is the
// worker environment: PowerShell keeps its own environment (it needs it to start) and
// rewrites its process block for the child. Stream mode has no result object, so a
// cleanup failure there is written to stderr and not reported as a verdict.
function spawnProcess ({ cmd, args = [], cwd, env, workspace, grants = [], net = 'off', maxMemoryBytes = 0, maxProcesses = 0, cpuMs = 0 }) {
  const info = available()
  if (!info.available) throw unavailable(info.reason)
  const exe = resolveExe(cmd)
  const allowed = grantList({ exe, workspace, grants })
  const { file, dir } = writeConfig({
    action: 'run',
    mode: 'stream',
    cmd: exe,
    args,
    cwd: cwd || workspace || path.dirname(exe),
    grants: allowed,
    capabilities: capabilitiesFor(net),
    env,
    maxMemoryBytes,
    maxProcesses,
    cpuMs
  })
  const child = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS, '-ConfigPath', file], {
    cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
  child.once('error', () => fs.rmSync(dir, { recursive: true, force: true }))
  return child
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2)
    const flags = {}
    let index = 0
    for (; index < argv.length; index++) {
      const token = argv[index]
      if (token === '--') { index++; break }
      if (token === '--net' || token === '--workspace' || token === '--timeout' || token === '--memory') {
        flags[token.slice(2)] = argv[++index]
        continue
      }
      throw new Error('unknown flag: ' + token)
    }
    if (flags.net !== undefined && flags.net !== 'off' && flags.net !== 'on') {
      throw new Error('appcontainer: --net must be off or on, got ' + flags.net)
    }
    const command = argv.slice(index)
    if (!command.length) throw new Error('usage: win-appcontainer.cjs [--net off|on] [--workspace DIR] [--timeout MS] [--memory BYTES] -- <command> [args...]')
    const workspace = flags.workspace ? path.resolve(flags.workspace) : undefined
    const result = run({
      cmd: command[0],
      args: command.slice(1),
      cwd: workspace,
      workspace,
      net: flags.net || 'off',
      timeoutMs: flags.timeout ? Number(flags.timeout) : 30000,
      maxMemoryBytes: flags.memory ? Number(flags.memory) : 0
    })
    console.log(JSON.stringify(result))
    process.exitCode = result.code === 0 ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }))
    process.exitCode = 2
  }
}

module.exports = { available, run, spawn: spawnProcess, capabilitiesFor, INTERNET_CLIENT }
