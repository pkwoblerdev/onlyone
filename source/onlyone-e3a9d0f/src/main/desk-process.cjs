'use strict'

const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const commandRunner = require('./command-runner')

const MAX_PROCESSES = 4
const MAX_OUTPUT = 6000
const MAX_HISTORY = 8
// Потолок ожидания незавершённого spawn при закрытии: немой spawn (ни 'spawn', ни
// 'error') не имеет права держать closeAll вечно — остальные живые процессы обязаны
// быть сняты (break-4 Н18). Настоящий spawn разрешается за миллисекунды.
const CLOSE_SPAWN_WAIT_MS = 2000

function createDeskProcessManager ({ spawnProcess = spawn, killProcessTree = commandRunner.killTree, platform = process.platform } = {}) {
  const entries = new Map()
  const listeners = new Set()
  let closing = false
  let closePromise = null
  const notify = (entry, kind = 'state') => { for (const listener of listeners) { try { listener(publicEntry(entry), kind) } catch {} } }
  const alive = entry => ['starting', 'running', 'stopping', 'unknown'].includes(entry.state)
  // Слот занимает процесс с ещё открытым прямым ребёнком. «unknown» после закрытия
  // ребёнка (снятие без подтверждения) слот не держит: иначе четыре штатные гонки
  // «Стоп по уже ушедшему процессу» навсегда отказывают в запуске (break-4 Н17).
  const occupiesSlot = entry => entry.child != null
  const publicEntry = entry => ({ id: entry.id, command: entry.command, args: [...entry.args], cwd: entry.cwd,
    pid: entry.pid, state: entry.state, startedAt: entry.startedAt, exitCode: entry.exitCode,
    signal: entry.signal, output: entry.output, canStop: Boolean(entry.child && entry.pid != null && !entry.stopConfirmed) })
  const trim = () => {
    const done = [...entries.values()].filter(entry => !alive(entry))
    while (done.length > MAX_HISTORY) entries.delete(done.shift().id)
  }

  async function start ({ command, args = [], cwd, env = {} } = {}) {
    if (closing) return { ok: false, code: 'closed' }
    if (typeof command !== 'string' || !command.trim() || command.length > 1024 || /[\u0000-\u001f]/.test(command) ||
        !Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) ||
        args.reduce((total, arg) => total + (typeof arg === 'string' ? arg.length : 0), 0) > 8192 ||
        typeof cwd !== 'string' || !cwd || !require('node:path').isAbsolute(cwd) || !env || typeof env !== 'object' || Array.isArray(env) ||
        Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))) {
      return { ok: false, code: 'invalid' }
    }
    if ([...entries.values()].filter(occupiesSlot).length >= MAX_PROCESSES) return { ok: false, code: 'limit' }
    const entry = { id: randomUUID(), command: command.trim(), args: [...args], cwd, pid: null, state: 'starting', startedAt: Date.now(), exitCode: null, signal: null, output: '' }
    entries.set(entry.id, entry)
    trim()
    let child
    try {
      child = spawnProcess(entry.command, entry.args, { cwd, env: { ...env }, shell: false,
        windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      entry.state = 'failed'; entry.error = String(error?.message || 'spawn failed').slice(0, 300)
      notify(entry)
      return { ok: false, code: 'spawn-failed', message: entry.error }
    }
    entry.child = child
    let outputNotify = null
    const append = chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      entry.output = (entry.output + text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')).slice(-MAX_OUTPUT)
      if (!outputNotify) {
        outputNotify = setTimeout(() => { outputNotify = null; notify(entry, 'output') }, 250)
        outputNotify.unref?.()
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('close', (code, signal) => {
      if (outputNotify) clearTimeout(outputNotify)
      outputNotify = null
      entry.exitCode = Number.isInteger(code) ? code : null
      entry.signal = signal || null
      entry.state = entry.stopRequested ? (entry.stopConfirmed ? 'stopped' : 'unknown') : (code === 0 ? 'exited' : 'failed')
      entry.child = null
      entry.stopPromise = null
      trim()
      notify(entry)
    })
    let finishSpawn
    entry.spawnReady = new Promise(resolve => { finishSpawn = resolve })
    const result = await new Promise(resolve => {
      let settled = false
      const finish = value => { if (settled) return; settled = true; finishSpawn(value); resolve(value) }
      child.once('spawn', () => {
        entry.pid = Number.isInteger(child.pid) ? child.pid : null
        entry.state = 'running'
        notify(entry)
        finish({ ok: true, id: entry.id, state: entry.state })
      })
      child.once('error', error => {
        entry.state = 'failed'
        entry.error = String(error?.message || 'spawn failed').slice(0, 300)
        entry.child = null
        trim()
        notify(entry)
        finish({ ok: false, code: 'spawn-failed', message: entry.error })
      })
    })
    return result
  }

  async function stop (id) {
    const entry = entries.get(id)
    if (!entry) return { ok: false, code: 'not-found' }
    if (entry.stopPromise) return entry.stopPromise
    // Once the direct child closes, an unconfirmed tree kill cannot safely be retried:
    // the PID may already have been reused by an unrelated process.
    if (!alive(entry) || entry.pid == null || !entry.child || entry.stopConfirmed) return { ok: false, code: 'not-running' }
    entry.stopRequested = true
    entry.state = 'stopping'
    notify(entry)
    entry.stopPromise = (async () => {
      const confirmed = await new Promise(resolve => {
      try { killProcessTree(entry.pid, value => resolve(value === true)) } catch { resolve(false) }
      })
      if (confirmed) {
        entry.stopConfirmed = true
        if (!entry.child) entry.state = 'stopped'
      } else if (alive(entry)) { entry.state = 'unknown'; entry.stopPromise = null }
      notify(entry)
      return confirmed ? { ok: true, confirmed: true, id: entry.id } : { ok: false, confirmed: false, code: 'stop-unconfirmed', id: entry.id }
    })()
    return entry.stopPromise
  }

  function closeAll () {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      const starting = [...entries.values()].filter(entry => entry.state === 'starting')
      await Promise.all(starting.map(entry => Promise.race([
        entry.spawnReady,
        new Promise(resolve => { const timer = setTimeout(resolve, CLOSE_SPAWN_WAIT_MS); timer.unref?.() })
      ])))
      const active = [...entries.values()].filter(alive)
      const results = await Promise.all(active.map(entry => stop(entry.id)))
      return { ok: results.every(result => result.ok), stopped: results.filter(result => result.ok).length,
        unconfirmed: results.filter(result => !result.ok).map(result => result.id) }
    })()
    return closePromise.finally(() => { closePromise = null; closing = false })
  }

  return {
    start,
    stop,
    closeAll,
    list: () => [...entries.values()].sort((a, b) => Number(alive(b)) - Number(alive(a)) || b.startedAt - a.startedAt).map(publicEntry),
    onChange: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    get: id => { const entry = entries.get(id); return entry ? publicEntry(entry) : null }
  }
}

module.exports = { createDeskProcessManager, MAX_PROCESSES, MAX_OUTPUT, MAX_HISTORY }
