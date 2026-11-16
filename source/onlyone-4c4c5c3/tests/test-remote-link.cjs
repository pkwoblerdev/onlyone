// Удалённое управление: спаривание по коду и связь компьютер ⇄ телефон через настоящего посредника.
const assert = require('node:assert/strict')
const WebSocket = require('ws')
const { createRelay } = require('../server/relay/relay.js')
const { PairingHost, pairAsPhone } = require('../src/shared/remote-pairing.js')
const { DeviceLink } = require('../src/shared/remote-link.js')
const proto = require('../src/shared/remote-protocol.js')

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

  async function pairDevices(approve = true) {
    let paired = null
    let sasDesktop = null
    const host = new PairingHost({
      url, WebSocketImpl: WebSocket, desktopName: 'Рабочий ПК',
      onRequest: async info => { sasDesktop = info.sas; return approve },
      onPaired: info => { paired = info }
    })
    const { code } = await host.start()
    let sasPhone = null
    const phoneResult = pairAsPhone({ url, WebSocketImpl: WebSocket, code, name: 'Телефон Саши', onSas: sas => { sasPhone = sas } })
    return { host, phoneResult, getPaired: () => paired, sas: () => ({ desktop: sasDesktop, phone: sasPhone }), code }
  }

  let keys = null
  await check('спаривание: оба получают один ключ, цифры сверки совпадают, код умирает', async () => {
    const run = await pairDevices(true)
    const phone = await run.phoneResult
    await until(() => run.getPaired())
    const desktop = run.getPaired()
    assert.equal(proto.toHex(phone.deviceKey), proto.toHex(desktop.deviceKey))
    assert.equal(phone.deviceId, desktop.deviceId)
    assert.equal(desktop.name, 'Телефон Саши')
    assert.equal(phone.desktopName, 'Рабочий ПК')
    assert.match(run.sas().desktop, /^\d{4}$/)
    assert.equal(run.sas().desktop, run.sas().phone)
    keys = { desktop: desktop.deviceKey, phone: phone.deviceKey }
    await wait(500)
    // тот же код второй раз не работает: комната спаривания уже пуста
    await assert.rejects(pairAsPhone({ url, WebSocketImpl: WebSocket, code: run.code, name: 'Чужой', timeoutMs: 1500 }), /Код не найден|закрылась/)
  })

  await check('отказ на компьютере: телефон получает отказ и ключа не имеет', async () => {
    const run = await pairDevices(false)
    await assert.rejects(run.phoneResult, /отклонил/)
    assert.equal(run.getPaired(), null)
  })

  await check('неверный код: телефон не находит комнату', async () => {
    await assert.rejects(pairAsPhone({ url, WebSocketImpl: WebSocket, code: 'ABCDE-FGHJK', name: 'х', timeoutMs: 1500 }), /Код не найден|закрылась/)
    await assert.rejects(pairAsPhone({ url, WebSocketImpl: WebSocket, code: 'abc', name: 'х' }), /Код должен/)
  })

  let desktop; let phone
  const events = []
  await check('связь: рукопожатие без петли, запрос с ответом, ошибка метода, событие', async () => {
    desktop = new DeviceLink({
      url, deviceKey: keys.desktop, role: 'd', WebSocketImpl: WebSocket,
      handlers: {
        ping: async params => ({ pong: params.n + 1 }),
        boom: async () => { throw new Error('так нельзя') },
        echo: async params => params
      }
    })
    phone = new DeviceLink({ url, deviceKey: keys.phone, role: 'p', WebSocketImpl: WebSocket })
    phone.on('event', e => events.push(e))
    await desktop.start(); await phone.start()
    await until(() => desktop.state === 'online' && phone.state === 'online')
    const before = relay.stats.forwarded
    await wait(300)
    assert.ok(relay.stats.forwarded - before === 0, 'рукопожатие не должно перекидываться бесконечно')
    assert.deepEqual(await phone.request('ping', { n: 41 }), { pong: 42 })
    await assert.rejects(phone.request('boom'), /так нельзя/)
    await assert.rejects(phone.request('нет-такого'), /не поддерживается/)
    assert.equal(await desktop.emit('chat-changed', { id: 'c1' }), true)
    await until(() => events.some(e => e.name === 'chat-changed'))
    assert.deepEqual(events[0].data, { id: 'c1' })
  })

  await check('большая нагрузка (500 КБ) идёт кусками и собирается целиком в обе стороны', async () => {
    const text = 'Ж'.repeat(500 * 1024)
    const back = await phone.request('echo', { text }, 60000)
    assert.equal(back.text.length, text.length)
    assert.equal(back.text, text)
  })

  await check('компьютер ушёл: телефон видит «недоступен», запрос отказывает сразу; вернулся — связь восстановилась', async () => {
    desktop.stop()
    await until(() => phone.state === 'waiting')
    await assert.rejects(phone.request('ping', { n: 1 }), /недоступен/)
    desktop = new DeviceLink({ url, deviceKey: keys.desktop, role: 'd', WebSocketImpl: WebSocket, handlers: { ping: async p => ({ pong: p.n + 1 }) } })
    await desktop.start()
    await until(() => phone.state === 'online' && desktop.state === 'online')
    assert.deepEqual(await phone.request('ping', { n: 1 }), { pong: 2 })
  })

  await check('обрыв соединения телефона: сам переподключается', async () => {
    phone.socket.terminate ? phone.socket.terminate() : phone.socket.close()
    await until(() => phone.state !== 'online', 2000).catch(() => {})
    await until(() => phone.state === 'online' && desktop.state === 'online', 8000)
    assert.deepEqual(await phone.request('ping', { n: 9 }), { pong: 10 })
  })

  await check('чужой ключ не попадает в комнату устройства и не читает пакеты', async () => {
    const strangerKey = proto.fromHex ? proto.fromHex('ab'.repeat(32)) : new Uint8Array(32).fill(7)
    const stranger = new DeviceLink({ url, deviceKey: strangerKey, role: 'p', WebSocketImpl: WebSocket })
    await stranger.start()
    await wait(300)
    assert.notEqual(stranger.state, 'online')
    await assert.rejects(stranger.request('ping', { n: 1 }, 500))
    stranger.stop()
  })

  desktop.stop(); phone.stop()
  await relay.close()
  if (failed) process.exit(1)
  console.log('\nСпаривание и связь удалённого управления: проверки пройдены')
  process.exit(0)
})()
