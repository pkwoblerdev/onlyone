// Удалённое управление: мост в окне — видны только чаты с /remote-control, отправка, живой ход, сигналы.
const assert = require('node:assert/strict')
const bridgeApi = require('../src/renderer/remote-bridge.js')

let failed = 0
async function check(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) }
}

;(async () => {
  const chats = [
    { id: 'c1', title: 'Удалённый', remote: true, updatedAt: 10, messages: [{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'готово', blocks: [{ type: 'step', image: 'data:image/png;base64,' + 'A'.repeat(300 * 1024) }, { type: 'text', text: 'ок', fn() {} }] }] },
    { id: 'c2', title: 'Личный', updatedAt: 20, messages: [{ role: 'user', content: 'секрет' }] }
  ]
  const sent = []; const emitted = []; const selected = []
  const pane = { id: 'p1', chatId: 'c2', liveChatId: null, generating: false, requestId: null }
  const bridge = bridgeApi.create({
    conversations: () => chats, panes: () => [pane],
    send: async (target, text) => { sent.push([target.chatId, text]) },
    select: (target, id) => { target.chatId = id; selected.push(id) },
    emit: payload => emitted.push(payload),
    setInterval: null,
    settings: { get: () => ({ model: 'm1', effort: 'high' }), set: () => {}, models: () => [{ id: 'm1', name: 'Модель' }] }
  })

  await check('список: только чаты с /remote-control', async () => {
    const list = await bridge.handle('chats.list')
    assert.deepEqual(list.map(c => c.id), ['c1'])
    assert.equal(list[0].preview, 'готово')
  })

  await check('чужой чат недоступен ни одним методом', async () => {
    for (const method of ['chat.get', 'chat.send', 'chat.run', 'chat.settings', 'chat.shot', 'tasks.get']) {
      await assert.rejects(bridge.handle(method, { id: 'c2', text: 'x' }), /не открыт для телефона/, method)
    }
    await assert.rejects(bridge.handle('chat.get', { id: 'нет' }), /не найден/)
    assert.equal(sent.length, 0)
  })

  await check('чат: сообщения очищены (функции и огромные картинки не уходят)', async () => {
    const got = await bridge.handle('chat.get', { id: 'c1' })
    assert.equal(got.messages.length, 2)
    assert.equal(got.messages[1].blocks[0].image, '', 'картинка больше предела убрана')
    assert.equal(got.messages[1].blocks[1].fn, undefined)
    assert.equal(got.messages[1].blocks[1].text, 'ок')
    assert.equal(got.live, null)
    assert.deepEqual(got.settings, { model: 'm1', effort: 'high' })
  })

  await check('отправка: чат открывается в панели и сообщение уходит; ход в работе — в очередь', async () => {
    assert.deepEqual(await bridge.handle('chat.send', { id: 'c1', text: 'сделай' }), { ok: true, queued: false })
    assert.deepEqual(selected, ['c1'])
    assert.deepEqual(sent, [['c1', 'сделай']])
    pane.generating = true; pane.liveChatId = 'c1'; pane.requestId = 'req1'; pane.contentBuffer = 'идёт…'; pane.blocks = [{ type: 'step' }]
    assert.equal((await bridge.handle('chat.send', { id: 'c1', text: 'ещё' })).queued, true)
  })

  await check('живой ход виден: содержимое, блоки, номер запроса; владельцы запросов — только чаты телефона', async () => {
    const got = await bridge.handle('chat.get', { id: 'c1' })
    assert.equal(got.live.content, 'идёт…')
    assert.equal(got.live.blocks.length, 1)
    assert.deepEqual(await bridge.handle('chat.run', { id: 'c1' }), { requestId: 'req1' })
    assert.deepEqual(await bridge.handle('runs.owners'), { req1: 'c1' })
    pane.liveChatId = 'c2'
    assert.deepEqual(await bridge.handle('runs.owners'), {}, 'ход личного чата не показывается')
    pane.liveChatId = 'c1'
  })

  await check('сигналы: меняется только то, что изменилось; личные чаты молчат', async () => {
    emitted.length = 0
    bridge.pulse()
    assert.equal(emitted.length, 1)
    bridge.pulse()
    assert.equal(emitted.length, 1, 'ничего не менялось — нового сигнала нет')
    pane.contentBuffer += ' ещё'
    bridge.pulse()
    assert.equal(emitted.length, 2)
    assert.equal(emitted[1].running, true)
    chats[1].messages.push({ role: 'user', content: 'ещё секрет' })
    bridge.pulse()
    assert.equal(emitted.length, 2)
  })

  await check('панель занята ходом другого чата: сообщение с телефона не подменяет чат', async () => {
    const busy = { id: 'p9', chatId: 'c2', liveChatId: 'c2', generating: true, requestId: 'r9' }
    const guarded = bridgeApi.create({ conversations: () => chats, panes: () => [busy], send: async () => assert.fail('не должно уйти'), select: () => assert.fail('не должно переключиться'), emit: () => {}, setInterval: null })
    await assert.rejects(guarded.handle('chat.send', { id: 'c1', text: 'привет' }), /идёт ход в другом чате/)
  })

  await check('ответ чата ограничен по размеру: самые старые сообщения отбрасываются', async () => {
    const big = { id: 'c8', title: 'Большой', remote: true, updatedAt: 1, messages: Array.from({ length: 150 }, (_, i) => ({ role: 'assistant', content: 'x'.repeat(50000) + i })) }
    const sized = bridgeApi.create({ conversations: () => [big], panes: () => [], send: async () => {}, select: () => {}, emit: () => {}, setInterval: null })
    const got = await sized.handle('chat.get', { id: 'c8', limit: 200 })
    assert.ok(JSON.stringify(got.messages).length <= 6 * 1024 * 1024 + 60000)
    assert.ok(got.messages.length < 150 && got.messages.length >= 1)
    assert.equal(got.offset + got.messages.length, 150, 'отброшены самые старые, а не новые')
  })

  await check('/remote-control: включает и выключает чат', async () => {
    assert.equal(bridge.toggle(chats[1]), true)
    assert.ok((await bridge.handle('chats.list')).some(c => c.id === 'c2'))
    assert.equal(bridge.toggle(chats[1]), false)
    assert.ok(!(await bridge.handle('chats.list')).some(c => c.id === 'c2'))
    await assert.rejects(bridge.handle('неизвестно'), /не поддерживается/)
  })

  if (failed) process.exit(1)
  console.log('\nМост удалённого управления: проверки пройдены')
})()
