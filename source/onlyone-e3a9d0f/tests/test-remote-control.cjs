// Удалённое управление: ядро компьютера с «телефоном» на настоящем посреднике, без окна и Electron.
const assert = require('node:assert/strict')
const WebSocket = require('ws')
const { createRelay } = require('../server/relay/relay.js')
const { createRemoteControl } = require('../src/main/remote-control.js')
const { pairAsPhone } = require('../src/shared/remote-pairing.js')
const { DeviceLink } = require('../src/shared/remote-link.js')

let failed = 0
async function check(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, ms = 4000) {
  const stop = Date.now() + ms
  while (Date.now() < stop) { if (await predicate()) return; await wait(20) }
  throw new Error('не дождались условия')
}

;(async () => {
  const relay = createRelay({ pingMs: 100000 })
  const port = await relay.listen(0)
  const url = 'ws://127.0.0.1:' + port

  // Чужая сторона: окно приложения и главный процесс, подставленные руками.
  const disk = { value: null }
  const calls = []
  const approvals = [
    { id: 'a1', requestId: 'run1', summary: 'Записать файл notes.md', details: 'правка', risk: 'edit' },
    { id: 'a2', requestId: 'run1', summary: 'Выполнить команду', details: 'rm -rf build', risk: 'external' },
    { id: 'a3', requestId: 'run-other', summary: 'Чужой чат без /remote-control', details: '', risk: 'edit' }
  ]
  const questions = [{ id: 'q1', requestId: 'run1', question: 'Какой вариант?', options: [{ label: 'А' }, { label: 'Б' }] }]
  const resolved = []
  const aborted = []
  let confirmAnswer = true
  const changes = []

  const core = createRemoteControl({
    WebSocketImpl: WebSocket, relayUrl: url, desktopName: 'Рабочий ПК', version: '1.3.8',
    store: { read: () => disk.value, write: value => { disk.value = JSON.parse(JSON.stringify(value)) } },
    askRenderer: async (method, params) => {
      calls.push([method, params])
      if (method === 'chats.list') return [{ id: 'c1', title: 'Удалённый чат', updatedAt: 5, running: false }]
      if (method === 'chat.get') return { id: params.id, messages: [{ role: 'user', content: 'привет' }] }
      if (method === 'chat.send') return { ok: true }
      if (method === 'chat.run') return params.id === 'c1' ? { requestId: 'run1' } : null
      if (method === 'runs.owners') return { run1: 'c1' }
      return null
    },
    confirmDevice: async () => confirmAnswer,
    listApprovals: () => approvals.filter(a => !resolved.includes(a.id)),
    resolveApproval: (id, approved) => { resolved.push(id); calls.push(['resolve', id, approved]); return true },
    listQuestions: () => questions,
    resolveQuestion: (id, answer) => { calls.push(['answer', id, answer]); return true },
    abortRun: id => { aborted.push(id); return true },
    onChange: state => changes.push(state)
  })

  await check('по умолчанию выключено: код не выдаётся', async () => {
    assert.equal(core.state().enabled, false)
    await assert.rejects(core.beginPairing(), /выключено/)
  })

  let phoneKey; let link
  await check('включить → код → телефон спаривается после подтверждения на компьютере', async () => {
    await core.setEnabled(true)
    const begun = await core.beginPairing()
    assert.match(begun.code, /^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/)
    assert.match(begun.link, /^onlyone:\/\/pair\?code=/)
    const paired = await pairAsPhone({ url, WebSocketImpl: WebSocket, code: begun.code, name: 'Телефон Саши' })
    phoneKey = paired
    await until(() => core.state().devices.length === 1)
    assert.equal(core.state().devices[0].name, 'Телефон Саши')
    await until(() => core.state().pairing === null)   // код после спаривания гаснет
    assert.ok(disk.value.devices[0].key.length === 64, 'ключ устройства сохранён')
  })

  await check('отказ на компьютере: устройство не добавляется', async () => {
    confirmAnswer = false
    const begun = await core.beginPairing()
    await assert.rejects(pairAsPhone({ url, WebSocketImpl: WebSocket, code: begun.code, name: 'Чужой' }), /отклонил/)
    assert.equal(core.state().devices.length, 1)
    confirmAnswer = true
  })

  await check('телефон подключается и общается: чаты, чат, отправка, остановка', async () => {
    link = new DeviceLink({ url, deviceKey: phoneKey.deviceKey, role: 'p', WebSocketImpl: WebSocket })
    await link.start()
    await until(() => link.state === 'online')
    assert.equal((await link.request('hello')).desktopName, 'Рабочий ПК')
    assert.deepEqual(await link.request('chats.list'), [{ id: 'c1', title: 'Удалённый чат', updatedAt: 5, running: false }])
    assert.equal((await link.request('chat.get', { id: 'c1' })).messages[0].content, 'привет')
    await link.request('chat.send', { id: 'c1', text: '  сделай  ' })
    assert.deepEqual(calls.find(c => c[0] === 'chat.send')[1], { id: 'c1', text: 'сделай', model: undefined, effort: undefined })
    await assert.rejects(link.request('chat.send', { id: 'c1', text: '   ' }), /пустое/)
    assert.deepEqual(await link.request('chat.stop', { id: 'c1' }), { stopped: true })
    assert.deepEqual(aborted, ['run1'])
    assert.deepEqual(await link.request('chat.stop', { id: 'нет' }), { stopped: false })
  })

  await check('разрешения: видны только чаты с /remote-control; опасное — только вторым шагом; всё в журнале', async () => {
    const pending = await link.request('pending.list')
    assert.deepEqual(pending.approvals.map(a => a.id), ['a1', 'a2'], 'чужой чат не виден')
    assert.equal(pending.approvals[0].dangerous, false)
    assert.equal(pending.approvals[1].dangerous, true)
    assert.equal(pending.approvals[1].details, 'rm -rf build', 'полное описание уходит на телефон')
    assert.equal(pending.questions[0].options.length, 2)
    await link.request('approval.answer', { id: 'a1', approved: true })
    await assert.rejects(link.request('approval.answer', { id: 'a2', approved: true }), /второе подтверждение/)
    await link.request('approval.answer', { id: 'a2', approved: true, confirmed: true })
    assert.deepEqual(resolved, ['a1', 'a2'])
    await link.request('approval.answer', { id: 'нет', approved: false }).then(() => assert.fail('должен отказать'), error => assert.match(error.message, /не активен/))
    await link.request('question.answer', { id: 'q1', answer: 'Б' })
    assert.deepEqual(calls.find(c => c[0] === 'answer'), ['answer', 'q1', 'Б'])
    const kinds = core.state().audit.map(entry => entry.what)
    for (const expected of ['send', 'stop', 'approve', 'answer', 'pair-approved', 'pair-denied']) assert.ok(kinds.includes(expected), 'нет в журнале: ' + expected)
  })

  await check('события идут на телефон', async () => {
    const seen = []
    link.on('event:chat-changed', data => seen.push(data))
    await core.broadcast('chat-changed', { id: 'c1', running: true })
    await until(() => seen.length === 1)
    assert.deepEqual(seen[0], { id: 'c1', running: true })
  })

  await check('перезапуск приложения: устройство остаётся, связь поднимается сама', async () => {
    core.stop()
    await until(() => link.state === 'waiting')
    const again = createRemoteControl({
      WebSocketImpl: WebSocket, relayUrl: url, store: { read: () => disk.value, write: value => { disk.value = value } },
      askRenderer: async () => [], confirmDevice: async () => true, listApprovals: () => [], resolveApproval: () => true,
      listQuestions: () => [], resolveQuestion: () => true, abortRun: () => true
    })
    assert.equal(again.state().devices.length, 1)
    await again.start()
    await until(() => link.state === 'online', 8000)
    assert.equal((await link.request('hello')).protocol, 1)
    again.stop()
    core.links.clear()
  })

  await check('отключить: ключ уничтожен, телефон больше не входит; «отключить все» чистит список', async () => {
    const live = createRemoteControl({
      WebSocketImpl: WebSocket, relayUrl: url, store: { read: () => disk.value, write: value => { disk.value = value } },
      askRenderer: async () => [], confirmDevice: async () => true, listApprovals: () => [], resolveApproval: () => true,
      listQuestions: () => [], resolveQuestion: () => true, abortRun: () => true
    })
    await live.start()
    await until(() => link.state === 'online', 8000)
    const id = live.state().devices[0].id
    live.revoke(id)
    await until(() => link.state === 'waiting')
    assert.equal(live.state().devices.length, 0)
    assert.equal(disk.value.devices.length, 0)
    await assert.rejects(link.request('hello', {}, 800), /недоступен|не ответил/)
    live.revokeAll()
    live.stop()
  })

  link.stop()
  await relay.close()
  if (failed) process.exit(1)
  console.log('\nЯдро удалённого управления: проверки пройдены')
  process.exit(0)
})()
