'use strict'
// Runs one plugin worker process and speaks line-delimited JSON-RPC with it.
// The host checks the manifest, reduces the environment and caps output.
// With sandbox:true the worker is started through tools/sandbox (AppContainer when the
// OS can build it, otherwise a Job Object); sandbox:false keeps the plain spawn path.
// A boundary that cannot be built throws: it never silently degrades to a plain spawn.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { loadManifest } = require('./manifest.cjs')
const { createParser, encodeFrame } = require('./protocol.cjs')
const winJob = require('../sandbox/win-job.cjs')
const appcontainer = require('../sandbox/win-appcontainer.cjs')

const ENV_KEYS = ['PATH', 'SystemRoot', 'TEMP', 'TMP']
// Windows injects the account's profile variables into every new process even
// when they are not passed; blank them so the real values never reach a plugin.
const BLANKED_ENV_KEYS = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']
// Node canonicalises every module path with realpath, which stats the drive root; an
// AppContainer cannot stat the drive root, so it is told to keep the paths as given.
// Plugin files are copied into the profile, never symlinked, so nothing changes here.
const APPCONTAINER_NODE_FLAGS = ['--preserve-symlinks', '--preserve-symlinks-main']

function startHost({
  pluginDir,
  grants = [],
  workspace,
  timeoutMs = 5000,
  maxOutputBytes = 1024 * 1024,
  sandbox = false,
  maxMemoryBytes = 0,
  maxProcesses = 0
} = {}) {
  if (!pluginDir) throw new Error('host: pluginDir is required')
  // The worker runs with cwd=pluginDir, so a relative dir would be applied twice.
  pluginDir = path.resolve(pluginDir)
  const manifest = loadManifest(pluginDir)
  const entry = path.join(pluginDir, manifest.entry)
  if (!fs.existsSync(entry)) throw new Error(`host: entry not found: ${manifest.entry}`)

  const env = {}
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of BLANKED_ENV_KEYS) env[key] = ''

  let child
  let sandboxed = false
  let sandboxReason = null
  if (sandbox) {
    if (process.platform !== 'win32') {
      throw Object.assign(new Error('host: sandbox is Windows-only'), { code: 'SANDBOX_UNAVAILABLE' })
    }
    const info = appcontainer.available()
    if (info.available) {
      child = appcontainer.spawn({
        cmd: process.execPath,
        args: [...APPCONTAINER_NODE_FLAGS, entry],
        cwd: pluginDir,
        env,
        workspace: workspace || pluginDir,
        maxMemoryBytes,
        maxProcesses
      })
      sandboxed = 'appcontainer'
    } else {
      sandboxReason = 'AppContainer unavailable: ' + info.reason
      child = winJob.spawn({ cmd: process.execPath, args: [entry], cwd: pluginDir, env, maxMemoryBytes, maxProcesses })
      sandboxed = 'job'
    }
  } else {
    child = spawn(process.execPath, [entry], {
      cwd: pluginDir,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  }

  const pending = new Map()
  let nextId = 1
  let stderrText = ''
  const state = { quarantined: false, stopped: false, exit: null }
  let resolveExit
  const exited = new Promise((resolve) => { resolveExit = resolve })

  const failAll = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
  }

  const parser = createParser({
    onMessage(message) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error !== undefined) waiter.reject(new Error(String(message.error)))
      else waiter.resolve(message.result)
    },
    onError(error) {
      state.quarantined = true
      failAll(error)
      child.kill()
    }
  })

  child.stdout.on('data', (chunk) => parser.push(chunk.toString('utf8')))
  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8')
    if (stderrText.length > maxOutputBytes) stderrText = stderrText.slice(0, maxOutputBytes)
  })
  child.stdin.on('error', () => {})
  child.on('error', (error) => {
    state.quarantined = true
    failAll(error)
  })
  child.on('exit', (code, signal) => {
    state.exit = { code, signal }
    if (!state.stopped) state.quarantined = true
    failAll(new Error(`host: worker exited (code ${code})`))
  })
  // 'close' fires after stdout/stderr are drained, so `exited` also waits for stderr.
  child.on('close', () => resolveExit(state.exit))

  function call(method, params = {}) {
    if (state.quarantined) return Promise.reject(new Error('host: worker quarantined'))
    if (state.stopped) return Promise.reject(new Error('host: worker stopped'))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        state.quarantined = true
        child.kill()
        reject(new Error('host: timeout'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(encodeFrame({ id, method, params }))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  function killSwitch() {
    state.stopped = true
    child.kill()
    failAll(new Error('host: killed'))
    return { stopped: true }
  }

  return {
    manifest,
    grants: grants.slice(),
    workspace,
    sandboxed,
    sandboxReason,
    child,
    exited,
    get quarantined() { return state.quarantined },
    get stopped() { return state.stopped },
    stderr() { return stderrText },
    ping() { return call('ping', {}) },
    selftest() { return call(manifest.selftest ? manifest.selftest.method : 'selftest', {}) },
    call,
    killSwitch
  }
}

module.exports = { startHost, ENV_KEYS, BLANKED_ENV_KEYS }
