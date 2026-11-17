'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createDeskProcessManager, MAX_OUTPUT } = require('../src/main/desk-process.cjs')

async function main () {
  const children = []
  const killed = []
  const manager = createDeskProcessManager({
    spawnProcess: (command, args, options) => {
      const child = new EventEmitter()
      child.pid = children.length + 100
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => true
      children.push({ command, args, options, child })
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
    killProcessTree: (pid, callback) => { killed.push(pid); callback(true) }
  })
  const invalid = await manager.start({ command: 'tool', args: ['ok', null], cwd: 'C:\\workspace' })
  assert.equal(invalid.code, 'invalid')
  const started = await manager.start({ command: 'node.exe', args: ['-e', 'process.stdout.write("ready")'], cwd: 'C:\\workspace', env: { PATH: 'safe' } })
  assert.equal(started.ok, true)
  assert.equal(children[0].options.shell, false)
  assert.deepEqual(children[0].args, ['-e', 'process.stdout.write("ready")'])
  children[0].child.stdout.emit('data', Buffer.from('ready'))
  assert.match((await manager.list())[0].output, /ready/)
  children[0].child.stdout.emit('data', Buffer.alloc(MAX_OUTPUT + 40, 120))
  assert.equal((await manager.list())[0].output.length, MAX_OUTPUT)
  const [stopped, duplicateStop] = await Promise.all([manager.stop(started.id), manager.stop(started.id)])
  assert.deepEqual(stopped, { ok: true, confirmed: true, id: started.id })
  assert.deepEqual(duplicateStop, stopped)
  assert.deepEqual(killed, [100])
  children[0].child.emit('close', 0, null)
  assert.equal((await manager.list())[0].state, 'stopped')
  const active = await manager.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })
  await Promise.all([manager.closeAll(), manager.closeAll()])
  assert.deepEqual(killed, [100, 101])
  children[1].child.emit('close', null, 'SIGKILL')
  assert.equal((await manager.list())[0].state, 'stopped')
  assert.equal(active.ok, true)
  const afterReopen = await manager.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })
  assert.equal(afterReopen.ok, true, 'closing and reopening Desk allows another process run')
  await manager.closeAll()
  children[2].child.emit('close', null, 'SIGKILL')
  const uncertainChildren = []
  let uncertainKills = 0
  const uncertain = createDeskProcessManager({ spawnProcess: (command, args, options) => {
    const child = new EventEmitter(); child.pid = 900; child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    uncertainChildren.push(child); queueMicrotask(() => child.emit('spawn')); return child
  }, killProcessTree: (_pid, callback) => { uncertainKills++; callback(false) } })
  const uncertainRun = await uncertain.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })
  assert.equal((await uncertain.stop(uncertainRun.id)).code, 'stop-unconfirmed')
  assert.equal((await uncertain.list())[0].state, 'unknown')
  assert.equal((await uncertain.closeAll()).ok, false)
  uncertainChildren[0].emit('close', null, 'SIGTERM')
  assert.equal((await uncertain.list())[0].state, 'unknown', 'parent exit cannot confirm descendants were stopped')
  assert.equal((await uncertain.list())[0].canStop, false, 'closed parent cannot expose a potentially stale PID as stoppable')
  assert.equal((await uncertain.stop(uncertainRun.id)).code, 'not-running')
  assert.equal(uncertainKills, 2, 'Desk close may retry while the same parent is alive, but not after its close event')
  let delayedChild
  const racing = createDeskProcessManager({ spawnProcess: () => {
    delayedChild = new EventEmitter(); delayedChild.pid = 901
    delayedChild.stdout = new EventEmitter(); delayedChild.stderr = new EventEmitter()
    return delayedChild
  }, killProcessTree: (_pid, callback) => { callback(true); queueMicrotask(() => delayedChild.emit('close', 0, null)) } })
  const pendingStart = racing.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })
  const closing = racing.closeAll()
  delayedChild.emit('spawn')
  const [pendingResult, closeResult] = await Promise.all([pendingStart, closing])
  assert.equal(pendingResult.ok, true)
  assert.deepEqual(closeResult, { ok: true, stopped: 1, unconfirmed: [] }, 'Desk close waits for pending starts before stopping them')
  assert.equal(racing.list()[0].state, 'stopped')
  console.log('PASS Desk process manager: argument-safe spawn, bounded output, confirmed tree stop, and close cleanup')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
