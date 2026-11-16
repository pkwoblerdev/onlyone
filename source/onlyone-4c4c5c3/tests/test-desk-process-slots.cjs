// break-4 Н17+Н18: слоты процессов Desk и потолок closeAll.
//
// Н17: снятие без подтверждения оставляет state='unknown' навсегда; alive('unknown')
// истинно, поэтому четыре штатные гонки «Стоп по уже ушедшему процессу» держат все
// 4 слота и пятый запуск навсегда отвечает limit — до пересоздания окна.
// Н18: немой spawn (ни 'spawn', ни 'error') не разрешает spawnReady; closeAll висит
// на первом шаге и не доходит до снятия остальных живых процессов.
//
// Отрицательные контроли: четыре действительно живых процесса по-прежнему держат
// лимит; closeAll с обычным spawn снимает оба процесса быстро.

const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createDeskProcessManager, MAX_PROCESSES } = require(path.join(__dirname, '..', 'src', 'main', 'desk-process.cjs'))

let failed = 0
let total = 0
async function check (name, fn) {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message))
  }
}

function stubChild (pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  return child
}

async function main () {
// Н17: четыре снятия без подтверждения + закрытие детей освобождают слоты.
await check('Н17: мёртвые «unknown» не держат слоты навсегда', async () => {
  const children = []
  const manager = createDeskProcessManager({
    spawnProcess: () => { const c = stubChild(100 + children.length); children.push(c); queueMicrotask(() => c.emit('spawn')); return c },
    killProcessTree: (_pid, cb) => cb(false) // снятие не подтверждено
  })
  const ids = []
  for (let i = 0; i < MAX_PROCESSES; i++) {
    const r = await manager.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })
    assert.equal(r.ok, true, 'запуск ' + i)
    ids.push(r.id)
  }
  for (const id of ids) assert.equal((await manager.stop(id)).code, 'stop-unconfirmed')
  // Прямые дети завершились сами (гонка «человек нажал Стоп, когда процесс уже ушёл»).
  for (const c of children) c.emit('close', 0, null)
  for (const id of ids) {
    assert.equal(manager.get(id).state, 'unknown', 'состояние unknown сохранено (контракт модуля)')
    assert.equal(manager.get(id).canStop, false)
  }
  const fifth = await manager.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })
  assert.equal(fifth.ok, true, 'пятый запуск обязан пройти: ' + JSON.stringify(fifth))
  await manager.closeAll()
})

// Отрицательный контроль: четыре живых процесса держат лимит.
await check('Н17 контроль: живые процессы держат лимит', async () => {
  const children = []
  const manager = createDeskProcessManager({
    spawnProcess: () => { const c = stubChild(200 + children.length); children.push(c); queueMicrotask(() => c.emit('spawn')); return c },
    killProcessTree: (_pid, cb) => cb(true)
  })
  for (let i = 0; i < MAX_PROCESSES; i++) {
    assert.equal((await manager.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })).ok, true)
  }
  const fifth = await manager.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })
  assert.deepEqual(fifth, { ok: false, code: 'limit' })
  await manager.closeAll()
  for (const c of children) c.emit('close', null, 'SIGKILL')
})

// Н18: немой spawn не держит closeAll — живой второй процесс снимается.
await check('Н18: closeAll с немой spawn снимает остальные процессы', async () => {
  const killed = []
  let mute = null
  let live = null
  const manager = createDeskProcessManager({
    spawnProcess: () => {
      if (!mute) { mute = stubChild(5001); return mute } // ни spawn, ни error — никогда
      live = stubChild(5002); queueMicrotask(() => live.emit('spawn')); return live
    },
    killProcessTree: (pid, cb) => { killed.push(pid); cb(true); queueMicrotask(() => live.emit('close', null, 'SIGKILL')) }
  })
  const pending = manager.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' }) // немой, не разрешится
  const second = await manager.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })
  assert.equal(second.ok, true)
  let guard = null
  const result = await Promise.race([
    manager.closeAll(),
    new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('closeAll висит на немой spawn')), 4000) })
  ]).finally(() => clearTimeout(guard))
  assert.ok(result, 'closeAll разрешился с потолком')
  assert.ok(killed.includes(5002), 'живой второй процесс снят: ' + JSON.stringify(killed))
  void pending
})

// Отрицательный контроль: обычный spawn — closeAll снимает оба быстро.
await check('Н18 контроль: обычный spawn — closeAll снимает оба', async () => {
  const killed = []
  const children = []
  const manager = createDeskProcessManager({
    spawnProcess: () => { const c = stubChild(6001 + children.length); children.push(c); queueMicrotask(() => c.emit('spawn')); return c },
    killProcessTree: (pid, cb) => { killed.push(pid); cb(true); queueMicrotask(() => children.find(c => c.pid === pid)?.emit('close', null, 'SIGKILL')) }
  })
  await manager.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })
  await manager.start({ command: 'node.exe', args: [], cwd: 'C:\\workspace' })
  const started = Date.now()
  const result = await manager.closeAll()
  assert.ok(Date.now() - started < 1500, 'closeAll без потолка ожидания не висит')
  assert.equal(result.stopped, 2)
  assert.deepEqual(killed.sort(), [6001, 6002])
})

console.log(`\n${total - failed}/${total} ok`)
}
main().then(() => process.exit(failed ? 1 : 0), error => { console.error(error); process.exit(1) })