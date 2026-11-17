// Посредник удалённого управления: комнаты, пересылка, вытеснение, лимиты, живость.
const assert = require('node:assert/strict')
const WebSocket = require('ws')
const { createRelay } = require('../server/relay/relay.js')

let failed = 0
async function check(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const ROOM = 'd-' + '0123456789abcdef'.repeat(2)
const ROOM_P = 'p-' + 'fedcba9876543210'.repeat(2)

function client(port, role, room = ROOM) {
  const socket = new WebSocket('ws://127.0.0.1:' + port)
  const inbox = []
  const closed = new Promise(resolve => socket.on('close', code => resolve(code)))
  socket.on('message', raw => inbox.push(JSON.parse(String(raw))))
  const opened = new Promise(resolve => socket.on('open', () => { if (room) socket.send(JSON.stringify({ op: 'join', room, role })); resolve() }))
  const next = async (predicate, ms = 1500) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      const at = inbox.findIndex(predicate)
      if (at >= 0) return inbox.splice(at, 1)[0]
      await wait(10)
    }
    throw new Error('не дождались кадра; пришло: ' + JSON.stringify(inbox))
  }
  return { socket, inbox, opened, closed, next, send: frame => socket.send(JSON.stringify(frame)) }
}

;(async () => {
  const relay = createRelay({ pingMs: 100000 })
  const port = await relay.listen(0)

  await check('вход: сообщает, на месте ли собеседник; второй входящий будит первого', async () => {
    const d = client(port, 'd'); await d.opened
    assert.deepEqual(await d.next(f => f.op === 'joined'), { op: 'joined', peer: false })
    const p = client(port, 'p'); await p.opened
    assert.deepEqual(await p.next(f => f.op === 'joined'), { op: 'joined', peer: true })
    assert.deepEqual(await d.next(f => f.op === 'peer'), { op: 'peer', online: true })
    p.socket.close()
    assert.deepEqual(await d.next(f => f.op === 'peer'), { op: 'peer', online: false })
    d.socket.close()
  })

  await check('пакеты идут в обе стороны без изменений; чужие комнаты не слышат', async () => {
    const d = client(port, 'd'); const p = client(port, 'p'); const stranger = client(port, 'p', 'd-' + 'a'.repeat(32))
    await Promise.all([d.opened, p.opened, stranger.opened])
    await d.next(f => f.op === 'peer')
    d.send({ op: 'msg', d: 'КУСОК-1' })
    assert.deepEqual(await p.next(f => f.op === 'msg'), { op: 'msg', d: 'КУСОК-1' })
    p.send({ op: 'msg', d: 'КУСОК-2' })
    assert.deepEqual(await d.next(f => f.op === 'msg'), { op: 'msg', d: 'КУСОК-2' })
    await wait(80)
    assert.ok(!stranger.inbox.some(f => f.op === 'msg'), 'чужая комната получила пакет')
    for (const c of [d, p, stranger]) c.socket.close()
  })

  await check('без собеседника пакет не теряется молча: отказ no-peer', async () => {
    const d = client(port, 'd'); await d.opened
    await d.next(f => f.op === 'joined')
    d.send({ op: 'msg', d: 'в пустоту' })
    assert.deepEqual(await d.next(f => f.op === 'err'), { op: 'err', code: 'no-peer' })
    d.socket.close()
  })

  await check('новый вход той же роли вытесняет прежний (код 4001), собеседник видит смену', async () => {
    const d1 = client(port, 'd'); await d1.opened
    const p = client(port, 'p'); await p.opened
    await d1.next(f => f.op === 'peer')
    const d2 = client(port, 'd'); await d2.opened
    assert.equal(await d1.closed, 4001)
    assert.deepEqual(await d2.next(f => f.op === 'joined'), { op: 'joined', peer: true })
    d2.send({ op: 'msg', d: 'от нового' })
    assert.deepEqual(await p.next(f => f.op === 'msg' && f.d === 'от нового'), { op: 'msg', d: 'от нового' })
    d2.socket.close(); p.socket.close()
  })

  await check('кривое имя комнаты, роль и кадры отвергаются', async () => {
    const badRoom = client(port, 'd', 'комната-с-пробелом')
    await badRoom.opened
    assert.equal(await badRoom.closed, 4002)
    const badRole = client(port, 'x', ROOM)
    await badRole.opened
    assert.equal(await badRole.closed, 4002)
    const d = client(port, 'd'); await d.opened
    await d.next(f => f.op === 'joined')
    d.socket.send('это не json')
    assert.equal((await d.next(f => f.op === 'err')).code, 'bad-frame')
    d.send({ op: 'msg', d: 42 })
    assert.equal((await d.next(f => f.op === 'err')).code, 'bad-frame')
    d.socket.close()
  })

  await check('кто не вошёл в комнату за срок, отключается', async () => {
    const quick = createRelay({ joinTimeout: 150, pingMs: 100000 })
    const quickPort = await quick.listen(0)
    const lazy = client(quickPort, 'd', null)
    await lazy.opened
    assert.equal(await lazy.closed, 4000)
    await quick.close()
  })

  await check('слишком частые пакеты получают отказ rate, а не очередь', async () => {
    const d = client(port, 'd'); const p = client(port, 'p'); await Promise.all([d.opened, p.opened])
    await d.next(f => f.op === 'peer')
    for (let i = 0; i < 400; i++) d.send({ op: 'msg', d: 'x' + i })
    await d.next(f => f.op === 'err' && f.code === 'rate', 3000)
    d.socket.close(); p.socket.close()
  })

  await check('слишком большой кадр закрывает соединение; лимит соединений с одного адреса', async () => {
    const small = createRelay({ maxPayload: 1024, maxPerIp: 3, pingMs: 100000 })
    const smallPort = await small.listen(0)
    const big = client(smallPort, 'd'); await big.opened
    big.socket.send('x'.repeat(5000))
    assert.equal(await big.closed, 1009)
    const sockets = [client(smallPort, 'd', 'd-' + '1'.repeat(32)), client(smallPort, 'p', 'd-' + '1'.repeat(32)), client(smallPort, 'd', 'd-' + '2'.repeat(32))]
    await Promise.all(sockets.map(s => s.opened))
    const fourth = client(smallPort, 'd', 'd-' + '3'.repeat(32))
    await fourth.opened
    assert.equal(await fourth.closed, 4003)
    for (const s of sockets) s.socket.close()
    await small.close()
  })

  await check('комнаты убираются, когда пусты; здоровье отвечает без подробностей', async () => {
    const before = relay.rooms()
    const d = client(port, 'd', 'd-' + '9'.repeat(32)); await d.opened
    await d.next(f => f.op === 'joined')
    assert.equal(relay.rooms(), before + 1)
    d.socket.close()
    await d.closed
    await wait(50)
    assert.equal(relay.rooms(), before)
    const answer = await new Promise(resolve => require('node:http').get('http://127.0.0.1:' + port + '/health', response => {
      let text = ''
      response.on('data', chunk => { text += chunk }); response.on('end', () => resolve(text))
    }))
    assert.match(answer, /^ok rooms=\d+$/)
  })

  await check('пакеты не логируются и не хранятся: в состоянии посредника нет их текста', async () => {
    const d = client(port, 'd'); const p = client(port, 'p'); await Promise.all([d.opened, p.opened])
    await d.next(f => f.op === 'peer')
    d.send({ op: 'msg', d: 'СЕКРЕТНЫЙ-ПАКЕТ-123' })
    await p.next(f => f.op === 'msg')
    assert.ok(!JSON.stringify(relay.stats).includes('СЕКРЕТНЫЙ'))
    d.socket.close(); p.socket.close()
  })

  await relay.close()
  if (failed) process.exit(1)
  console.log('\nПосредник удалённого управления: проверки пройдены')
})()
