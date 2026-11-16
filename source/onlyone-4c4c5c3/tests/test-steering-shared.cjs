// Указание на лету в командном ходе: помощники делят requestId с ведущим, и ни старт, ни конец помощника
// не должны стирать очередь ведущего; «Сейчас» прерывает шаги всех, кто работает в этот момент.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createSteering } = require('../src/main/agent-steering.cjs')

test('очередь живёт, пока работает хоть один агент хода', () => {
  const s = createSteering()
  s.open('r1') // ведущий
  s.open('r1') // помощник стартовал — очередь не обнуляется
  assert.equal(s.post({ requestId: 'r1', text: 'не трогай config' }), true)
  s.open('r1') // ещё один помощник: уже лежащее указание не пропадает
  s.close('r1') // один помощник закончил
  assert.deepEqual(s.drain('r1').map(m => m.text), ['не трогай config'])
  assert.equal(s.post({ requestId: 'r1', text: 'ещё' }), true, 'ведущий и второй помощник ещё работают')
  s.close('r1'); s.close('r1')
  assert.equal(s.post({ requestId: 'r1', text: 'поздно' }), false, 'после ухода всех очереди нет')
})

test('указание отдаётся один раз', () => {
  const s = createSteering()
  s.open('r2')
  s.post({ requestId: 'r2', text: 'a' })
  assert.equal(s.drain('r2').length, 1)
  assert.equal(s.drain('r2').length, 0)
})

test('«Сейчас» прерывает текущие шаги всех агентов хода, законченный шаг не трогает', () => {
  const s = createSteering()
  s.open('r3')
  const a = new AbortController(), b = new AbortController(), done = new AbortController()
  s.beginStep('r3', a); s.beginStep('r3', b)
  const endDone = s.beginStep('r3', done); endDone()
  s.post({ requestId: 'r3', text: 'стоп', force: true })
  assert.equal(a.signal.aborted && b.signal.aborted, true)
  assert.equal(a.signal.reason, 'forced_by_user')
  assert.equal(done.signal.aborted, false)
})

test('мягкое указание шаг не прерывает', () => {
  const s = createSteering()
  s.open('r4')
  const a = new AbortController(); s.beginStep('r4', a)
  s.post({ requestId: 'r4', text: 'позже', force: false })
  assert.equal(a.signal.aborted, false)
})

test('пустое указание и чужой ход отклоняются', () => {
  const s = createSteering()
  s.open('r5')
  assert.equal(s.post({ requestId: 'r5', text: '  ' }), false)
  assert.equal(s.post({ requestId: 'нет', text: 'x' }), false)
  assert.equal(s.post({ text: 'x' }), false)
})

test('main.js пользуется модулем, а шаг снимает слушатель сигнала на любом выходе', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.ok(code.includes("require('./agent-steering.cjs')"), 'main.js подключает agent-steering.cjs')
  assert.ok(!/agentMailboxes\.set\(/.test(code), 'очередь больше не создаётся напрямую (затирала ящик ведущего)')
  assert.ok(!/activeStepControllers\.set\(/.test(code), 'контроллер шага не кладётся по requestId напрямую')
  const direct = code.match(/signal\.removeEventListener\('abort', onSignalAbort\)/g) || []
  assert.equal(direct.length, 1, 'слушатель снимается в одном месте — endStep, а не вручную на отдельных путях')
  assert.ok(/endStep\(\)/.test(code), 'есть общий endStep')
})
