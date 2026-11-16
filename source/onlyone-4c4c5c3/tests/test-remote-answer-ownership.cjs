// break-5 Н5: ответ на разрешение/вопрос не проверял принадлежность чату — граница
// «только чаты с /remote-control» соблюдалась на чтении (pending.list), но не на ответе.
// Настоящее ядро remote-control, окно подставное, сети нет.
const assert = require('node:assert/strict')
const { createRemoteControl } = require('../src/main/remote-control.js')

let failed = 0
let total = 0
async function check(name, fn) {
  total++
  try { await fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) }
}

function makeCore(options = {}) {
  const state = { resolved: [], answered: [], ownersCalls: 0 }
  const approvals = [
    { id: 'a1', requestId: 'run1', summary: 'Записать файл notes.md', details: 'правка', risk: 'edit' },
    { id: 'a2', requestId: 'run1', summary: 'Выполнить команду', details: 'rm -rf build', risk: 'external' },
    { id: 'a3', requestId: 'run-other', summary: 'Чужой чат без /remote-control', details: '', risk: 'edit' },
    { id: 'a4', requestId: 'run-other', summary: 'Удалить том', details: 'format', risk: 'destructive' }
  ]
  const questions = [
    { id: 'q1', requestId: 'run1', question: 'Какой вариант?', options: [{ label: 'А' }] },
    { id: 'q2', requestId: 'run-other', question: 'Секретный вопрос чужого чата', options: [] }
  ]
  const core = createRemoteControl({
    WebSocketImpl: function () { throw new Error('сеть в этой проверке не нужна') },
    relayUrl: 'ws://127.0.0.1:9/relay',
    store: { read: () => ({ enabled: true, devices: [], audit: [] }), write: () => {} },
    askRenderer: async method => {
      if (method === 'runs.owners') {
        state.ownersCalls++
        if (options.ownersFail) throw new Error('окно закрыто')
        return { run1: 'c1' }
      }
      return null
    },
    confirmDevice: async () => true,
    listApprovals: () => approvals,
    resolveApproval: (id, approved) => { state.resolved.push([id, approved]); return true },
    listQuestions: () => questions,
    resolveQuestion: (id, answer) => { state.answered.push([id, answer]); return true },
    abortRun: () => true
  })
  const handlers = core.handlersFor({ id: 'dev1', name: 'Телефон человека' })
  return { core, state, handlers }
}

async function main() {
  await check('разрешение чужого чата не принимается и не доходит до resolveApproval', async () => {
    const { core, state, handlers } = makeCore()
    await assert.rejects(handlers['approval.answer']({ id: 'a3', approved: true }), /не активен/)
    await assert.rejects(handlers['approval.answer']({ id: 'a4', approved: true, confirmed: true }), /не активен/)
    assert.deepEqual(state.resolved, [], 'чужие разрешения исполнены: ' + JSON.stringify(state.resolved))
    assert.equal(core.state().audit.length, 0, 'отказ не должен писаться в журнал как approve')
  })

  await check('вопрос чужого чата не принимается и не доходит до resolveQuestion', async () => {
    const { core, state, handlers } = makeCore()
    await assert.rejects(handlers['question.answer']({ id: 'q2', answer: 'Б' }), /не активен/)
    assert.deepEqual(state.answered, [], 'чужой вопрос отвечен: ' + JSON.stringify(state.answered))
    assert.equal(core.state().audit.length, 0)
  })

  await check('вопрос с неизвестным id не принимается', async () => {
    const { state, handlers } = makeCore()
    await assert.rejects(handlers['question.answer']({ id: 'нет-такого', answer: 'Б' }), /не активен/)
    assert.deepEqual(state.answered, [])
  })

  await check('контроль: своё разрешение проходит, опасное — только вторым шагом', async () => {
    const { state, handlers } = makeCore()
    assert.deepEqual(await handlers['approval.answer']({ id: 'a1', approved: true }), { ok: true })
    await assert.rejects(handlers['approval.answer']({ id: 'a2', approved: true }), /второе подтверждение/)
    assert.deepEqual(await handlers['approval.answer']({ id: 'a2', approved: true, confirmed: true }), { ok: true })
    assert.deepEqual(state.resolved, [['a1', true], ['a2', true]])
  })

  await check('контроль: свой вопрос проходит, пустой ответ по-прежнему отказан', async () => {
    const { state, handlers } = makeCore()
    assert.deepEqual(await handlers['question.answer']({ id: 'q1', answer: ' А ' }), { ok: true })
    assert.deepEqual(state.answered, [['q1', 'А']])
    await assert.rejects(handlers['question.answer']({ id: 'q1', answer: '   ' }), /пустой ответ/)
  })

  await check('контроль: телефон видит ровно свои разрешения и вопросы', async () => {
    const { handlers } = makeCore()
    const pending = await handlers['pending.list']()
    assert.deepEqual(pending.approvals.map(a => a.id), ['a1', 'a2'])
    assert.deepEqual(pending.questions.map(q => q.id), ['q1'])
  })

  await check('владельцы чатов не прочитаны (окно закрыто) — отказ, а не разрешение всего', async () => {
    const { state, handlers } = makeCore({ ownersFail: true })
    await assert.rejects(handlers['approval.answer']({ id: 'a1', approved: true }), /не активен/)
    await assert.rejects(handlers['question.answer']({ id: 'q1', answer: 'А' }), /не активен/)
    assert.deepEqual(state.resolved, [])
    assert.deepEqual(state.answered, [])
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })