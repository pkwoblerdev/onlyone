// Удалённое управление: общий протокол (спаривание, ключ устройства, сеанс, защита от подмены и повтора).
const assert = require('node:assert/strict')
const proto = require('../src/shared/remote-protocol.js')

let failed = 0
async function check(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) }
}

// Полное спаривание в памяти: компьютер и телефон, посредник видит только то, что проходит между ними.
async function pair(code) {
  const wire = []
  const k0Desktop = await proto.codeKey(code)
  const k0Phone = await proto.codeKey(code)
  const desktop = await proto.newPair()
  const phone = await proto.newPair()
  // телефон → компьютер: открытый ключ под кодом
  const hello = await proto.seal(k0Phone, { pub: phone.pub, name: 'Телефон Саши' })
  wire.push(hello)
  const received = await proto.open(k0Desktop, hello)
  assert.equal(received.pub, phone.pub)
  // компьютер → телефон: свой открытый ключ под кодом
  const answer = await proto.seal(k0Desktop, { pub: desktop.pub, deviceId: proto.randomId() })
  wire.push(answer)
  const got = await proto.open(k0Phone, answer)
  const keyDesktop = await proto.makeDeviceKey(await proto.sharedSecret(desktop.privateKey, received.pub), desktop.pub, received.pub)
  const keyPhone = await proto.makeDeviceKey(await proto.sharedSecret(phone.privateKey, got.pub), got.pub, phone.pub)
  return { keyDesktop, keyPhone, desktop, phone, wire }
}

;(async () => {
  await check('код: десять знаков, без путаемых, нормализуется и проверяется', () => {
    for (let i = 0; i < 50; i++) {
      const code = proto.makeCode()
      assert.match(code, /^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/)
      assert.ok(proto.validCode(code))
    }
    assert.equal(proto.normalizeCode('abcde fghjk'), 'ABCDE-FGHJK')
    assert.equal(proto.normalizeCode('abcdefghjk'), 'ABCDE-FGHJK')
    assert.equal(proto.normalizeCode('abc'), '')
    assert.ok(!proto.validCode('0BCDE-FGHJK'), 'ноль не из алфавита')
  })

  await check('код: знаки выпадают равномерно (без перекоса `байт % 30`)', () => {
    // При `% 30` первые 16 знаков алфавита выпадали в 9/8 раза чаще остальных:
    // на 200 000 знаков это ~12 %, а случайный разброс средних — доли процента.
    const counts = new Map([...proto.ALPHABET].map(ch => [ch, 0]))
    for (let i = 0; i < 20000; i++) for (const ch of proto.makeCode().replace('-', '')) counts.set(ch, counts.get(ch) + 1)
    const values = [...proto.ALPHABET].map(ch => counts.get(ch))
    const mean = list => list.reduce((a, b) => a + b, 0) / list.length
    const ratio = mean(values.slice(0, 16)) / mean(values.slice(16))
    assert.ok(ratio > 0.97 && ratio < 1.03, `перекос знаков кода: ${ratio.toFixed(3)}`)
  })

  await check('спаривание: обе стороны получают один и тот же ключ устройства и одну комнату', async () => {
    const result = await pair('ABCDE-FGHJK')
    assert.equal(proto.toHex(result.keyDesktop), proto.toHex(result.keyPhone))
    assert.equal(result.keyDesktop.length, 32)
    assert.equal(await proto.deviceRoom(result.keyDesktop), await proto.deviceRoom(result.keyPhone))
    assert.match(await proto.deviceRoom(result.keyDesktop), /^d-[0-9a-f]{32}$/)
    // комната спаривания не раскрывает код и отличается от комнаты устройства
    assert.notEqual(await proto.pairingRoom('ABCDE-FGHJK'), await proto.deviceRoom(result.keyDesktop))
    assert.equal(await proto.pairingRoom('ABCDE-FGHJK'), await proto.pairingRoom('abcde fghjk'))
  })

  await check('цифры сверки одинаковы у обеих сторон и зависят от обоих ключей', async () => {
    const a = await pair('ABCDE-FGHJK')
    const one = await proto.sasDigits(a.desktop.pub, a.phone.pub)
    assert.match(one, /^\d{4}$/)
    assert.equal(one, await proto.sasDigits(a.desktop.pub, a.phone.pub))
    const b = await pair('ABCDE-FGHJK')
    assert.notEqual(await proto.sasDigits(b.desktop.pub, b.phone.pub), one, 'другие ключи — другие цифры (с огромной вероятностью)')
  })

  await check('чужой код не открывает пакеты спаривания', async () => {
    const good = await proto.codeKey('ABCDE-FGHJK')
    const bad = await proto.codeKey('ABCDE-FGHJM')
    const packet = await proto.seal(good, { pub: 'секрет' })
    await assert.rejects(proto.open(bad, packet))
  })

  await check('посредник, не знающий код, не может подставить свой ключ', async () => {
    const real = await proto.codeKey('ABCDE-FGHJK')
    const attacker = await proto.codeKey('XXXXX-YYYYY'.replace(/X/g, 'H').replace(/Y/g, 'J'))
    const forged = await proto.seal(attacker, { pub: (await proto.newPair()).pub, name: 'взломщик' })
    await assert.rejects(proto.open(real, forged))
  })

  await check('сеанс: пакеты идут в обе стороны, шифруются и читаются только своей парой', async () => {
    const { keyDesktop, keyPhone } = await pair('ABCDE-FGHJK')
    const nonceD = proto.randomNonce()
    const nonceP = proto.randomNonce()
    const desktop = await proto.makeSession(keyDesktop, 'd', nonceD, nonceP)
    const phone = await proto.makeSession(keyPhone, 'p', nonceP, nonceD)
    const toPhone = await desktop.send('chats', [{ id: 'c1', title: 'Мой чат' }])
    assert.ok(!toPhone.includes('Мой чат'), 'в пакете не должно быть открытого текста')
    assert.deepEqual(await phone.receive(toPhone), { type: 'chats', payload: [{ id: 'c1', title: 'Мой чат' }] })
    const toDesktop = await phone.send('send', { chatId: 'c1', text: 'Привет' })
    assert.deepEqual(await desktop.receive(toDesktop), { type: 'send', payload: { chatId: 'c1', text: 'Привет' } })
  })

  await check('повтор пакета и его перестановка отвергаются', async () => {
    const { keyDesktop, keyPhone } = await pair('ABCDE-FGHJK')
    const nonceD = proto.randomNonce(); const nonceP = proto.randomNonce()
    const desktop = await proto.makeSession(keyDesktop, 'd', nonceD, nonceP)
    const phone = await proto.makeSession(keyPhone, 'p', nonceP, nonceD)
    const first = await desktop.send('x', 1)
    const second = await desktop.send('x', 2)
    await phone.receive(second)
    await assert.rejects(phone.receive(first), /повтор или перестановка/)
    await assert.rejects(phone.receive(second), /повтор или перестановка/)
  })

  await check('пакет, отправленный в одну сторону, нельзя выдать за пришедший из другой (отражение)', async () => {
    const { keyDesktop, keyPhone } = await pair('ABCDE-FGHJK')
    const nonceD = proto.randomNonce(); const nonceP = proto.randomNonce()
    const desktop = await proto.makeSession(keyDesktop, 'd', nonceD, nonceP)
    const phone = await proto.makeSession(keyPhone, 'p', nonceP, nonceD)
    const own = await desktop.send('x', 'от компьютера')
    await assert.rejects(desktop.receive(own), 'компьютер не должен принимать собственный пакет')
    const back = await phone.send('x', 'от телефона')
    await assert.rejects(phone.receive(back))
  })

  await check('порча одного байта пакета ловится; чужое устройство не читает чужой сеанс', async () => {
    const one = await pair('ABCDE-FGHJK')
    const two = await pair('FGHJK-ABCDE')
    const nonceD = proto.randomNonce(); const nonceP = proto.randomNonce()
    const desktop = await proto.makeSession(one.keyDesktop, 'd', nonceD, nonceP)
    const stranger = await proto.makeSession(two.keyPhone, 'p', nonceP, nonceD)
    const packet = await desktop.send('x', 'секрет')
    await assert.rejects(stranger.receive(packet))
    const phone = await proto.makeSession(one.keyPhone, 'p', nonceP, nonceD)
    const bytes = proto.fromBase64(packet)
    bytes[bytes.length - 1] ^= 1
    await assert.rejects(phone.receive(proto.toBase64(bytes)))
  })

  await check('каждый сеанс — свои ключи: пакет прошлого сеанса в новом не читается', async () => {
    const { keyDesktop, keyPhone } = await pair('ABCDE-FGHJK')
    const d1 = await proto.makeSession(keyDesktop, 'd', 'n1', 'n2')
    const p2 = await proto.makeSession(keyPhone, 'p', 'n4', 'n3')
    await assert.rejects(p2.receive(await d1.send('x', 1)))
  })

  if (failed) process.exit(1)
  console.log('\nПротокол удалённого управления: проверки пройдены')
})()
