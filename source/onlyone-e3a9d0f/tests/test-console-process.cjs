// start_process на настоящем процессе: планировщик поднимает spawnLong, вывод идёт в журнал
// построчно, «Завершить» снимает дерево (дочерний node тоже умирает), завершённое убирается.
const assert = require('node:assert/strict')
const { createTaskManager } = require('../src/main/task-manager')
const { spawnLong } = require('../src/main/command-runner')

const wait = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 10000) => { const stop = Date.now() + ms; while (Date.now() < stop) { if (fn()) return true; await wait(50) } return false }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

;(async () => {
  let failed = 0
  const check = async (name, fn) => { try { await fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '—', e.message) } }
  const m = createTaskManager({ maxParallel: 3, send: () => true })
  m.start()
  const node = JSON.stringify(process.execPath)

  await check('короткая команда: вывод построчно и состояние «завершено»', async () => {
    const t = m.add({ title: 'echo', kind: 'process', launch: () => spawnLong({ command: `${node} -e "console.log('один'); console.log('два')"` }) })
    assert.ok(await until(() => m.get(t.id).state === 'done'), 'не завершилась: ' + m.get(t.id).state)
    const log = m.get(t.id).log
    assert.ok(log.includes('один') && log.includes('два'), JSON.stringify(log))
    assert.equal(m.remove(t.id).ok, true)
  })

  await check('долгий процесс: «Завершить» снимает всё дерево', async () => {
    let pid
    const t = m.add({ title: 'dev', kind: 'process', launch: () => { const h = spawnLong({ command: `${node} -e "setInterval(() => console.log('тик'), 100)"` }); pid = h.pid; return h } })
    assert.ok(await until(() => m.get(t.id).log.some(l => l === 'тик')), 'вывода нет')
    m.cancel(t.id)
    assert.ok(await until(() => !alive(pid), 8000), 'процесс жив после «Завершить»')
  })

  m.stop()
  console.log(failed ? `ПРОВАЛ: ${failed}` : 'процессы консоли: всё прошло')
  process.exit(failed ? 1 : 0)
})()
