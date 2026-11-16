// break-3 Н6: chat.send моста знает только первую панель.
// Часть 1: первая панель занята ходом приватного чата, вторая свободна — мост
// отказывает, свободная вторая не используется (удалённое управление не работает,
// когда агент на ПК занят — главный сценарий).
// Часть 2 (граница доверия): панель ПОКАЗЫВАЕТ remote-чат A, но ход в ней идёт по
// приватному B (liveChatId=B) — мост отдаёт текст телефона в ход B, не сверяя
// принадлежность хода.
//
// Отрицательные контроли: свободная первая панель — уходит; вторая показывает A —
// уходит в неё; ход самого A — в очередь; единственная занятая панель — отказ.
'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const bridgeApi = require(path.join(__dirname, '..', 'src', 'renderer', 'remote-bridge.js'))

let failed = 0
let total = 0
async function check (name, fn) {
  total++
  try { await fn(); console.log('  ok  ' + name) } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message)) }
}

const chats = [
  { id: 'A', title: 'Открытый', remote: true, updatedAt: 10, messages: [] },
  { id: 'B', title: 'Приватный', updatedAt: 20, messages: [] }
]
function stand (panes) {
  const sent = []; const selected = []
  const bridge = bridgeApi.create({
    conversations: () => chats, panes: () => panes,
    send: async (pane, text) => { sent.push({ pane: pane.id, text }) },
    select: (pane, id) => { pane.chatId = id; selected.push({ pane: pane.id, id }) },
    emit: () => {}, setInterval: null
  })
  return { bridge, sent, selected }
}

async function main () {
  // Часть 1: первая занята приватным B, вторая свободна — сообщение уходит во вторую.
  await check('Н6: свободная вторая панель используется', async () => {
    const p0 = { id: 'p0', chatId: 'B', liveChatId: 'B', generating: true, requestId: 'rB' }
    const p1 = { id: 'p1', chatId: 'C', liveChatId: null, generating: false }
    const { bridge, sent, selected } = stand([p0, p1])
    const res = await bridge.handle('chat.send', { id: 'A', text: 'сделай отчёт' })
    assert.equal(res.ok, true, 'отказ при свободной второй панели: ' + JSON.stringify(res))
    assert.deepEqual(sent, [{ pane: 'p1', text: 'сделай отчёт' }], 'текст ушёл во вторую панель')
    assert.deepEqual(selected, [{ pane: 'p1', id: 'A' }], 'вторая переключена на A')
  })

  // Часть 2: панель показывает A, ход идёт по приватному B — текст НЕ уходит в ход B.
  await check('Н6: текст телефона не попадает в ход приватного чата', async () => {
    const p0 = { id: 'p0', chatId: 'A', liveChatId: 'B', generating: true, requestId: 'rB' }
    const { bridge, sent } = stand([p0])
    await assert.rejects(bridge.handle('chat.send', { id: 'A', text: 'секрет' }), /идёт ход в другом чате/,
      'единственная панель занята чужим ходом — отказ, а не подмена')
    assert.deepEqual(sent, [], 'текст не ушёл в ход приватного B')
  })

  // Часть 2 с свободной второй: показывающая A панель занята B, но вторая свободна — уходит во вторую.
  await check('Н6: при занятой A-панели ходом B используется свободная вторая', async () => {
    const p0 = { id: 'p0', chatId: 'A', liveChatId: 'B', generating: true, requestId: 'rB' }
    const p1 = { id: 'p1', chatId: 'C', liveChatId: null, generating: false }
    const { bridge, sent, selected } = stand([p0, p1])
    const res = await bridge.handle('chat.send', { id: 'A', text: 'привет' })
    assert.equal(res.ok, true)
    assert.deepEqual(sent, [{ pane: 'p1', text: 'привет' }])
    assert.deepEqual(selected, [{ pane: 'p1', id: 'A' }])
  })

  // Контроль: свободная первая панель — сообщение уходит и переключает её на A.
  await check('Н6 контроль: свободная первая панель', async () => {
    const p0 = { id: 'p0', chatId: 'B', liveChatId: null, generating: false }
    const { bridge, sent, selected } = stand([p0])
    assert.deepEqual(await bridge.handle('chat.send', { id: 'A', text: 'x' }), { ok: true, queued: false })
    assert.deepEqual(sent, [{ pane: 'p0', text: 'x' }])
    assert.deepEqual(selected, [{ pane: 'p0', id: 'A' }])
  })

  // Контроль: вторая панель уже показывает A — уходит именно в неё, без переключения.
  await check('Н6 контроль: панель показывает A — уходит в неё', async () => {
    const p0 = { id: 'p0', chatId: 'B', liveChatId: 'B', generating: true, requestId: 'rB' }
    const p1 = { id: 'p1', chatId: 'A', liveChatId: null, generating: false }
    const { bridge, sent, selected } = stand([p0, p1])
    assert.deepEqual(await bridge.handle('chat.send', { id: 'A', text: 'y' }), { ok: true, queued: false })
    assert.deepEqual(sent, [{ pane: 'p1', text: 'y' }])
    assert.deepEqual(selected, [])
  })

  // Контроль: ход самого A в показывающей A панели — в очередь (steer своего хода).
  await check('Н6 контроль: ход самого A — в очередь', async () => {
    const p0 = { id: 'p0', chatId: 'A', liveChatId: 'A', generating: true, requestId: 'rA' }
    const { bridge, sent } = stand([p0])
    assert.deepEqual(await bridge.handle('chat.send', { id: 'A', text: 'ещё' }), { ok: true, queued: true })
    assert.deepEqual(sent, [{ pane: 'p0', text: 'ещё' }])
  })

  // Контроль: единственная занятая панель — отказ (контракт test-remote-bridge).
  await check('Н6 контроль: единственная занятая панель — отказ', async () => {
    const p0 = { id: 'p0', chatId: 'B', liveChatId: 'B', generating: true, requestId: 'rB' }
    const { bridge, sent, selected } = stand([p0])
    await assert.rejects(bridge.handle('chat.send', { id: 'A', text: 'x' }), /идёт ход в другом чате/)
    assert.deepEqual(sent, []); assert.deepEqual(selected, [])
  })

  console.log(`\n${total - failed}/${total} ok`)
}
main().then(() => process.exit(failed ? 1 : 0), error => { console.error(error); process.exit(1) })