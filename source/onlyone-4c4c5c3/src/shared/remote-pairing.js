/* Спаривание телефона с компьютером по коду (волна 4): обе стороны. Подробно о схеме — remote-protocol.js.
 *
 * Кадры в комнате спаривания (поле d пакета посредника), все под ключом, выведенным из кода:
 *   телефон → 'P' + {pub, name}                       «вот мой открытый ключ и имя телефона»
 *   компьютер → 'Q' + {pub}                           «вот мой ключ» (оба считают четыре цифры сверки)
 *   компьютер → 'R' + {ok, deviceId, desktopName}     итог: человек разрешил или отклонил на компьютере
 */
(function (root) {
  'use strict'

  const proto = root.OnlyoneRemote || (typeof require === 'function' ? require('./remote-protocol.js') : null)

  function openSocket(WebSocketImpl, url) {
    return new Promise((resolve, reject) => {
      let socket
      try { socket = new WebSocketImpl(url) } catch (error) { reject(error); return }
      socket.addEventListener('open', () => resolve(socket))
      socket.addEventListener('error', () => reject(new Error('нет связи с сервером')))
    })
  }

  const frameOf = data => { try { return JSON.parse(typeof data === 'string' ? data : String(data)) } catch { return null } }

  // ─── телефон ────────────────────────────────────────────────────────────────
  async function pairAsPhone(options) {
    const WebSocketImpl = options.WebSocketImpl || root.WebSocket
    const code = proto.normalizeCode(options.code)
    if (!proto.validCode(code)) throw new Error('Код должен выглядеть так: ABCDE-FGHJK')
    const room = await proto.pairingRoom(code)
    const key = await proto.codeKey(code)
    const mine = await proto.newPair()
    const socket = await openSocket(WebSocketImpl, options.url)
    const timeoutMs = options.timeoutMs || 120000

    return new Promise((resolve, reject) => {
      let finished = false
      let theirPub = null
      const done = (error, value) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        try { socket.close() } catch { /* уже закрыт */ }
        if (error) reject(error); else resolve(value)
      }
      const timer = setTimeout(() => done(new Error('Компьютер не подтвердил устройство вовремя')), timeoutMs)
      socket.addEventListener('close', () => done(new Error('Связь с сервером закрылась')))
      socket.addEventListener('message', async event => {
        const frame = frameOf(event.data)
        if (!frame) return
        if (frame.op === 'joined') {
          if (!frame.peer) { done(new Error('Код не найден или устарел: включите «Подключить телефон» на компьютере заново')); return }
          const hello = await proto.seal(key, { pub: mine.pub, name: String(options.name || 'Телефон').slice(0, 60) })
          socket.send(JSON.stringify({ op: 'msg', d: 'P' + hello }))
          return
        }
        if (frame.op === 'err') { done(new Error('Сервер отказал: ' + frame.code)); return }
        if (frame.op !== 'msg' || typeof frame.d !== 'string') return
        try {
          const body = await proto.open(key, frame.d.slice(1))
          if (frame.d[0] === 'Q') {
            theirPub = body.pub
            if (options.onSas) options.onSas(await proto.sasDigits(theirPub, mine.pub))
            return
          }
          if (frame.d[0] === 'R') {
            if (!body.ok) { done(new Error('Компьютер отклонил это устройство')); return }
            if (!theirPub) { done(new Error('Нарушен порядок спаривания')); return }
            const shared = await proto.sharedSecret(mine.privateKey, theirPub)
            const deviceKey = await proto.makeDeviceKey(shared, theirPub, mine.pub)
            done(null, { deviceKey, deviceId: body.deviceId, desktopName: body.desktopName || 'Компьютер' })
          }
        } catch { /* пакет не под нашим кодом — игнорируем */ }
      })
      socket.send(JSON.stringify({ op: 'join', room, role: 'p' }))
    })
  }

  // ─── компьютер ──────────────────────────────────────────────────────────────
  class PairingHost {
    constructor(options) {
      this.url = options.url
      this.WebSocketImpl = options.WebSocketImpl || root.WebSocket
      this.onRequest = options.onRequest          // async ({name, sas}) => boolean
      this.desktopName = options.desktopName || 'Компьютер'
      this.onPaired = options.onPaired || (() => {})
      this.onEnd = options.onEnd || (() => {})
      this.ttl = options.ttl || proto.CODE_TTL_MS
      this.socket = null
      this.ended = false
    }

    async start() {
      this.code = proto.makeCode()
      this.expiresAt = Date.now() + this.ttl
      const room = await proto.pairingRoom(this.code)
      this.key = await proto.codeKey(this.code)
      this.mine = await proto.newPair()
      this.socket = await openSocket(this.WebSocketImpl, this.url)
      this.timer = setTimeout(() => this.end('expired'), this.ttl)
      this.socket.addEventListener('close', () => this.end('closed'))
      this.socket.addEventListener('message', event => this.onFrame(event.data))
      this.socket.send(JSON.stringify({ op: 'join', room, role: 'd' }))
      return { code: this.code, expiresAt: this.expiresAt }
    }

    async onFrame(data) {
      const frame = frameOf(data)
      if (!frame || frame.op !== 'msg' || typeof frame.d !== 'string' || frame.d[0] !== 'P' || this.handled || this.ended) return
      this.handled = true     // код одноразовый: попытку занимаем до await, иначе кадры одного тика пройдут все
      let hello
      try { hello = await proto.open(this.key, frame.d.slice(1)) } catch { this.handled = false; return }   // чужой код — не слушаем
      if (!hello || typeof hello.pub !== 'string') { this.handled = false; return }
      const send = async (kind, body) => this.socket.send(JSON.stringify({ op: 'msg', d: kind + await proto.seal(this.key, body) }))
      await send('Q', { pub: this.mine.pub })
      const sas = await proto.sasDigits(this.mine.pub, hello.pub)
      let approved = false
      try { approved = Boolean(await this.onRequest({ name: String(hello.name || 'Телефон'), sas })) } catch { approved = false }
      if (!approved) { await send('R', { ok: false }); this.end('denied'); return }
      const deviceId = proto.randomId()
      await send('R', { ok: true, deviceId, desktopName: this.desktopName })
      const shared = await proto.sharedSecret(this.mine.privateKey, hello.pub)
      const deviceKey = await proto.makeDeviceKey(shared, this.mine.pub, hello.pub)
      this.onPaired({ deviceId, name: String(hello.name || 'Телефон').slice(0, 60), deviceKey })
      setTimeout(() => this.end('paired'), 300)
    }

    end(reason) {
      if (this.ended) return
      this.ended = true
      clearTimeout(this.timer)
      try { if (this.socket) this.socket.close() } catch { /* уже закрыт */ }
      this.onEnd(reason)
    }
    cancel() { this.end('cancelled') }
  }

  const api = { pairAsPhone, PairingHost }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyonePairing = api
})(typeof window !== 'undefined' ? window : globalThis)
