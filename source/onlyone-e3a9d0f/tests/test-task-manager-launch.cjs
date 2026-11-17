// Консоль панели «Задачи» (макет 20.10): процессы, которые агент оставил работать.
// Отложенный запуск (процесс стартует, когда очередь даст место), «Убрать» завершённое
// и дописывание вывода в журнал. Без окна и без настоящих процессов: часы и spawn — подставные.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createTaskManager } = require('../src/main/task-manager')

let failed = 0, total = 0
const check = (name, fn) => { total++; try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '—', e.message) } }

function fakeChild() {
  const c = new EventEmitter()
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter()
  c.killed = 0
  c.kill = () => { c.killed++; return true }
  return c
}
const timers = []
const manager = (extra = {}) => createTaskManager({
  maxParallel: 1, send: () => true, now: () => 1000,
  setTimeout: fn => { timers.push(fn); return timers.length }, clearTimeout: () => {}, ...extra
})

check('отложенный запуск: процесс создаётся, только когда очередь даёт место', () => {
  const m = manager(); m.start()
  const made = []
  const launch = () => { const c = fakeChild(); made.push(c); return c }
  const a = m.add({ title: 'npm run dev', kind: 'process', chatId: 'c1', launch })
  const b = m.add({ title: 'npx vitest --watch', kind: 'process', chatId: 'c1', launch })
  assert.equal(made.length, 1, 'второй ждёт места')
  assert.equal(m.get(a.id).state, 'running')
  assert.equal(m.get(b.id).state, 'queued')
  made[0].emit('close', 0)
  assert.equal(made.length, 2, 'освободилось место — второй запущен')
  assert.equal(m.get(b.id).state, 'running')
})

check('вывод процесса идёт в журнал построчно', () => {
  const m = manager(); m.start()
  let child
  const t = m.add({ title: 'dev', kind: 'process', launch: () => (child = fakeChild()) })
  child.stdout.emit('data', 'VITE ready\nLocal: http://localhost:5173/\n')
  const log = m.get(t.id).log.join('\n')
  assert.match(log, /VITE ready/)
  assert.match(log, /localhost:5173/)
})

check('отмена снимает процесс его же kill (дерево снимает рукоятка)', () => {
  const m = manager(); m.start()
  let child
  const t = m.add({ title: 'dev', kind: 'process', launch: () => (child = fakeChild()) })
  m.cancel(t.id)
  assert.equal(child.killed, 1)
})

check('«Убрать» удаляет завершённую карточку, идущую — нет', () => {
  const m = manager(); m.start()
  let child
  const t = m.add({ title: 'dev', kind: 'process', launch: () => (child = fakeChild()) })
  assert.equal(m.remove(t.id).ok, false, 'идущую не убрать')
  child.emit('close', 1)
  assert.equal(m.remove(t.id).ok, true)
  assert.equal(m.get(t.id), null)
})

check('дописать вывод в журнал (команда агента отдаёт вывод после конца)', () => {
  const m = manager(); m.start()
  const t = m.add({ title: 'npm test', kind: 'command', handle: { on() {}, kill() { return true } } })
  m.appendLog(t.id, '> vitest run\n✓ settings.test.js (6)\nTests  6 passed')
  const log = m.get(t.id).log
  assert.ok(log.some(l => /6 passed/.test(l)), JSON.stringify(log))
})

check('отложенный запуск не пишется на диск и не возвращается после перезапуска сам', () => {
  const saved = []
  const m = manager({ store: { save: list => saved.push(JSON.stringify(list)), load: () => [] } }); m.start()
  m.add({ title: 'dev', kind: 'process', launch: () => fakeChild() })
  assert.ok(saved.length && saved.every(s => !/launch/.test(s)), 'функция запуска не сериализуется')
})

console.log(failed ? `ПРОВАЛ: ${failed} из ${total}` : `консоль задач: всё прошло (${total})`)
process.exit(failed ? 1 : 0)
