// break-5 Н4: клиентский X-Forwarded-For снимал лимит на IP, а комнаты d- не
// имели срока жизни — 5000 удерживаемых комнат исчерпывали MAX_ROOMS до
// перезапуска посредника. Тест поднимает настоящий createRelay на 127.0.0.1.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const WebSocket = require('ws')
const { createRelay } = require('../server/relay/relay.js')

let failed = 0
let total = 0
const asyncCheck = async (name, fn) => {
  total++
  try { await fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const roomName = prefix => prefix + '-' + crypto.randomBytes(16).toString('hex')

// Клиент с ожиданием первого кадра ответа.
const connect = (port, headers = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
  const frames = []
  const waiters = []
  socket.on('message', raw => {
    const frame = JSON.parse(String(raw))
    frames.push(frame)
    if (waiters.length) waiters.shift()(frame)
  })
  socket.on('error', reject)
  socket.on('open', () => resolve({
    socket, frames,
    next: () => new Promise(r => { if (frames.length) r(frames.shift()); else waiters.push(r) }),
    send: obj => socket.send(JSON.stringify(obj)),
    closed: new Promise(r => socket.on('close', (code) => r(code)))
  }))
})
const join = async (client, room, role) => { client.send({ op: 'join', room, role }); return client.next() }

async function main() {
  // --- часть 1: XFF не от доверенного прокси не снимает лимит на IP ---
  const relay = createRelay({ maxPerIp: 2, maxRooms: 50, trustProxyFrom: [] })
  const port = await relay.listen(0)
  await asyncCheck('поддельный XFF не даёт новых счётчиков IP', async () => {
    const a = await connect(port, { 'x-forwarded-for': '10.0.0.1' })
    const b = await connect(port, { 'x-forwarded-for': '10.0.0.2' })
    assert.equal((await join(a, roomName('d'), 'd')).op, 'joined')
    assert.equal((await join(b, roomName('d'), 'd')).op, 'joined')
    const c = await connect(port, { 'x-forwarded-for': '10.0.0.3' })
    const verdict = await join(c, roomName('d'), 'd')
    assert.equal(verdict.op, 'err', 'третий клиент с тем же реальным IP прошёл под поддельным XFF')
    assert.equal(verdict.code, 'full')
    a.socket.terminate(); b.socket.terminate(); c.socket.terminate()
    await sleep(50)
  })
  await asyncCheck('контроль: без XFF лимит на IP работал и раньше', async () => {
    const clients = []
    for (let i = 0; i < 2; i++) {
      const c = await connect(port)
      assert.equal((await join(c, roomName('d'), 'd')).op, 'joined')
      clients.push(c)
    }
    const extra = await connect(port)
    assert.equal((await join(extra, roomName('d'), 'd')).code, 'full')
    for (const c of [...clients, extra]) c.socket.terminate()
    await sleep(50)
  })
  await relay.close()

  // --- часть 1б: за доверенным прокси (штатный nginx на этой же машине) XFF работает ---
  const behindProxy = createRelay({ maxPerIp: 1, maxRooms: 50, trustProxyFrom: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] })
  const proxyPort = await behindProxy.listen(0)
  await asyncCheck('контроль: XFF от доверенного прокси различает клиентов', async () => {
    const a = await connect(proxyPort, { 'x-forwarded-for': '203.0.113.1' })
    const b = await connect(proxyPort, { 'x-forwarded-for': '203.0.113.2' })
    assert.equal((await join(a, roomName('d'), 'd')).op, 'joined')
    assert.equal((await join(b, roomName('d'), 'd')).op, 'joined', 'за nginx разные клиенты получили один счётчик')
    a.socket.terminate(); b.socket.terminate()
    await sleep(50)
  })
  await behindProxy.close()

  // --- часть 2: комнаты d- убираются по сроку бездействия ---
  let clock = 1000000
  const timed = createRelay({ maxRooms: 50, pingMs: 20, now: () => clock, deviceRoomTtlMs: 100 })
  const timedPort = await timed.listen(0)
  await asyncCheck('комната d- без движения убирается, держатель отключается', async () => {
    const holder = await connect(timedPort)
    const name = roomName('d')
    assert.equal((await join(holder, name, 'd')).op, 'joined')
    assert.equal(timed.rooms(), 1)
    clock += 150 // срок вышел; сокеты живы (ws отвечает на ping сам)
    const code = await Promise.race([holder.closed, sleep(500).then(() => null)])
    assert.equal(timed.rooms(), 0, 'комната d- пережила срок бездействия')
    assert.equal(code, 4004, 'держатель не отключён кодом уборки')
  })
  await asyncCheck('контроль: комната d- с движением живёт дольше срока', async () => {
    const active = await connect(timedPort)
    const name = roomName('d')
    assert.equal((await join(active, name, 'd')).op, 'joined')
    for (let i = 0; i < 4; i++) {
      clock += 40
      active.send({ op: 'msg', d: 'x' }) // no-peer, но движение комнаты
      await sleep(25)
    }
    assert.equal(timed.rooms(), 1, 'живая комната убрана по сроку')
    active.socket.terminate()
    await sleep(50)
  })
  await asyncCheck('контроль: комната p- убирается по прежнему правилу (createdAt)', async () => {
    const pair = await connect(timedPort)
    const name = roomName('p')
    assert.equal((await join(pair, name, 'p')).op, 'joined')
    clock += 16 * 60 * 1000
    await sleep(60)
    assert.equal(timed.rooms(), 0, 'комната спаривания не убрана')
    pair.socket.terminate()
  })
  await timed.close()

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })