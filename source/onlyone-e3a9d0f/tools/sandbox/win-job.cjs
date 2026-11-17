'use strict'

// Job Object limits for a child process. Files and network are not restricted here:
// without AppContainer this is a resource boundary, not a sandbox (ADR-0001).
//
// Test-only: ONLYONE_SANDBOX_PLATFORM fakes the platform guard when NODE_ENV=test; there
// is no Linux sandbox — the override covers the refusal path, never a real Linux run.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PS = path.join(__dirname, 'win-job.ps1')

function powershell () {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function platform () {
  const override = process.env.ONLYONE_SANDBOX_PLATFORM
  if (override && process.env.NODE_ENV === 'test') return override
  return process.platform
}

function run ({ cmd, args = [], cwd, timeoutMs = 30000, maxMemoryBytes = 0, maxProcesses = 0, cpuMs = 0 }) {
  if (platform() !== 'win32') throw Object.assign(new Error('Job Object is Windows-only'), { code: 'SANDBOX_UNAVAILABLE' })
  const input = JSON.stringify({ cmd, args, cwd, timeoutMs, maxMemoryBytes, maxProcesses, cpuMs })
  const res = spawnSync(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS], {
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  if (res.error) throw Object.assign(res.error, { code: 'SANDBOX_UNAVAILABLE' })
  const line = String(res.stdout || '').trim().split('\n').pop()
  let parsed
  try { parsed = JSON.parse(line) } catch {
    throw Object.assign(new Error('sandbox produced no JSON: ' + String(res.stderr || res.stdout).slice(0, 300)), { code: 'SANDBOX_ERROR' })
  }
  return parsed
}

// Streaming child for the plugin host: the worker inherits our std handles through
// PowerShell, so line-delimited JSON-RPC works; Job Object limits still apply.
// `env` is the worker environment: PowerShell keeps its own environment (it needs it
// to start) and rewrites its process block for the child.
function spawnProcess ({ cmd, args = [], cwd, env, maxMemoryBytes = 0, maxProcesses = 0, cpuMs = 0 }) {
  if (platform() !== 'win32') throw Object.assign(new Error('Job Object is Windows-only'), { code: 'SANDBOX_UNAVAILABLE' })
  if (!cmd) throw new Error('job: cmd is required')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-job-cfg-'))
  const file = path.join(dir, `config-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify({ cmd, args, cwd, env, timeoutMs: 0, maxMemoryBytes, maxProcesses, cpuMs }))
  const child = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS, '-ConfigPath', file, '-Stream'], {
    cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
  return child
}

module.exports = { run, spawn: spawnProcess }
