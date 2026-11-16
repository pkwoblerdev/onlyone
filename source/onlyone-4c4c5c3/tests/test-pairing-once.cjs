// break-5 Н12: «одноразовый» код спаривания принимался многократно — handled
// ставился после await, ended не проверялся. Настоящие PairingHost и
// remote-protocol, WebSocket подставной (сети нет, адрес выдуманный).
const assert = require('node:assert/strict')
const path = require('node:path')
const proto = require('../src/shared/remote-protocol.js')
const { PairingHost } = require('../src/shared/remote-pairing.js')

let failed = 0
let total = 0
const asyncCheck = async (name, fn) => {
  total++
  try { await fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

class FakeSocket {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.sent = []
    this.closed = false
    setTimeout(() => this.emit('open', {}), 0)
  }
  addEventListener(kind, fn) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, [])
    this.listeners.get(kind).push(fn)
  }
  emit(kind, event) { for (const fn of this.listeners.get(kind) || []) fn(event) }
  send(text) { this.sent.push(text); return true }
  close() { this.closed = true; this.emit('close', {}) }
}
const tick = () => new Promise(r => setTimeout(r, 10))
const settle = async () => { for (let i = 0; i < 8; i++) await tick() }

async function phoneFrame(code, name) {
  const key = await proto.codeKey(code)
  const mine = await proto.newPair()
  const hello = await proto.seal(key, { pub: mine.pub, name })
  return { data: JSON.stringify({ op: 'msg', d: 'P' + hello }) }
}

const makeHost = () => {
  const state = { asks: [], paired: [], ends: [], socket: null }
  const host = new PairingHost({
    url: 'ws://127.0.0.1:9/relay',
    WebSocketImpl: class extends FakeSocket { constructor(u) { super(u); state.socket = this } },
    desktopName: 'Компьютер',
    onRequest: async info => { state.asks.push(info); return true },
    onPaired: info => state.paired.push(info),
    onEnd: reason => state.ends.push(reason),
    ttl: 60000
  })
  return { host, state }
}
const countFrames = (socket, kind) => socket.sent.filter(s => { const f = JSON.parse(s); return f.d && f.d[0] === kind }).length

async function main() {
  await asyncCheck('два P в одном тике дают одно устройство, а не два', async () => {
    const { host, state } = makeHost()
    const { code } = await host.start()
    await tick()
    const a = await phoneFrame(code, 'Телефон человека')
    const b = await phoneFrame(code, 'Устройство злоумышленника')
    state.socket.emit('message', a)
    state.socket.emit('message', b)
    await settle()
    assert.equal(state.asks.length, 1, 'карточек человеку: ' + state.asks.length)
    assert.equal(state.paired.length, 1, 'устройств добавлено: ' + state.paired.length)
    assert.equal(countFrames(state.socket, 'Q'), 1)
    assert.equal(countFrames(state.socket, 'R'), 1)
    host.cancel()
  })

  await asyncCheck('шторм из 40 P в одном тике — одно устройство', async () => {
    const { host, state } = makeHost()
    const { code } = await host.start()
    await tick()
    const frames = []
    for (let i = 0; i < 40; i++) frames.push(await phoneFrame(code, 'phone-' + i))
    for (const f of frames) state.socket.emit('message', f)
    await settle()
    assert.equal(state.asks.length, 1, 'карточек: ' + state.asks.length)
    assert.equal(state.paired.length, 1, 'устройств: ' + state.paired.length)
    host.cancel()
  })

  await asyncCheck('запоздавший P после end не зовёт onRequest и не шлёт кадров', async () => {
    const { host, state } = makeHost()
    const { code } = await host.start()
    await tick()
    host.end('expired')
    const before = state.socket.sent.length
    const f = await phoneFrame(code, 'Запоздавший телефон')
    state.socket.emit('message', f)
    await settle()
    assert.equal(state.asks.length, 0, 'карточка после истечения срока')
    assert.equal(state.socket.sent.length, before, 'кадры ушли на закрытый сокет')
  })

  await asyncCheck('контроль: второй P после обработки первого — одно устройство', async () => {
    const { host, state } = makeHost()
    const { code } = await host.start()
    await tick()
    const a = await phoneFrame(code, 'Первый')
    const b = await phoneFrame(code, 'Второй')
    state.socket.emit('message', a)
    await settle()
    state.socket.emit('message', b)
    await settle()
    assert.equal(state.paired.length, 1)
    host.cancel()
  })

  await asyncCheck('контроль: чужой код не сжигает одноразовую попытку', async () => {
    const { host, state } = makeHost()
    const { code } = await host.start()
    await tick()
    const wrongKey = await proto.codeKey('AAAAA-BBBBB')
    const stranger = await proto.newPair()
    const badHello = await proto.seal(wrongKey, { pub: stranger.pub, name: 'Чужой' })
    state.socket.emit('message', { data: JSON.stringify({ op: 'msg', d: 'P' + badHello }) })
    await tick()
    const good = await phoneFrame(code, 'Настоящий телефон')
    state.socket.emit('message', good)
    await settle()
    assert.equal(state.paired.length, 1, 'настоящий телефон не смог спариться после чужого кадра')
    host.cancel()
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })