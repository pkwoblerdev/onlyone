/* Связь компьютера и телефона через посредника (волна 4): вход в комнату, рукопожатие, зашифрованный сеанс,
 * запросы с ответами, события, повторное соединение. Один класс на обе стороны: роль 'd' (компьютер) отвечает на
 * запросы и шлёт события, роль 'p' (телефон) спрашивает и слушает.
 *
 * Кадры посредника — JSON ({op:'join'|'msg'|…}); в поле d пакета: 'H<nonce>' — рукопожатие (случайные числа
 * открыты), 'M<пакет>' — зашифрованный пакет сеанса (remote-protocol.js).
 */
(function (root) {
  'use strict'

  const proto = root.OnlyoneRemote || (typeof require === 'function' ? require('./remote-protocol.js') : null)

  const REQUEST_TIMEOUT_MS = 20000
  const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000]

  class DeviceLink {
    constructor(options) {
      this.url = options.url
      this.deviceKey = options.deviceKey            // Uint8Array
      this.role = options.role === 'd' ? 'd' : 'p'
      this.WebSocketImpl = options.WebSocketImpl || root.WebSocket
      this.handlers = options.handlers || {}        // только компьютер: метод → async (params) => результат
      this.listeners = new Map()
      this.pending = new Map()
      // Пакеты сеанса идут строго по очереди в обе стороны: расшифровка и шифрование асинхронны, и без очереди
      // куски большого ответа обгоняли друг друга, а приёмник отбрасывал «переставленные» (проявлялось на снимках).
      this.inbound = Promise.resolve()
      this.outbound = Promise.resolve()
      this.assembler = proto.makeAssembler()
      this.state = 'idle'                           // idle | connecting | waiting | online | stopped
      this.attempt = 0
      this.timer = null
      this.session = null
      this.nonceMine = null
      this.room = null
      this.socket = null
      this.peerOnline = false
      this.setTimeout = options.setTimeout || ((fn, ms) => setTimeout(fn, ms))
      this.clearTimeout = options.clearTimeout || (id => clearTimeout(id))
    }

    on(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, [])
      this.listeners.get(name).push(fn)
      return () => this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== fn))
    }
    fire(name, data) { for (const fn of this.listeners.get(name) || []) { try { fn(data) } catch { /* слушатель не рушит связь */ } } }
    setState(next) { if (this.state !== next) { this.state = next; this.fire('status', next) } }

    async start() {
      if (this.state === 'stopped') this.state = 'idle'
      this.room = await proto.deviceRoom(this.deviceKey)
      this.connect()
    }

    connect() {
      if (this.state === 'stopped') return
      this.setState('connecting')
      let socket
      try { socket = new this.WebSocketImpl(this.url) } catch { this.scheduleReconnect(); return }
      this.socket = socket
      this.session = null
      this.peerOnline = false
      socket.addEventListener('open', () => {
        this.attempt = 0
        socket.send(JSON.stringify({ op: 'join', room: this.room, role: this.role }))
      })
      socket.addEventListener('message', event => this.onFrame(socket, event.data))
      socket.addEventListener('close', () => { if (this.socket === socket) this.onClosed() })
      socket.addEventListener('error', () => { /* закрытие придёт отдельно */ })
    }

    onClosed() {
      this.socket = null
      this.session = null
      this.peerOnline = false
      this.announced = false
      this.lastTheirs = null
      this.failPending('связь прервана')
      if (this.state === 'stopped') return
      this.setState('connecting')
      this.scheduleReconnect()
    }

    scheduleReconnect() {
      if (this.state === 'stopped') return
      const base = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]
      this.attempt += 1
      this.clearTimeout(this.timer)
      this.timer = this.setTimeout(() => this.connect(), base + Math.floor(Math.random() * 400))
    }

    failPending(reason) {
      for (const [, entry] of this.pending) { this.clearTimeout(entry.timer); entry.reject(new Error(reason)) }
      this.pending.clear()
    }

    async onFrame(socket, raw) {
      let frame
      try { frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) } catch { return }
      if (frame.op === 'joined') { this.peerOnline = Boolean(frame.peer); if (frame.peer) this.shake(); else this.setState('waiting'); return }
      if (frame.op === 'peer') {
        this.peerOnline = Boolean(frame.online)
        if (frame.online) this.shake()
        else { this.session = null; this.setState('waiting'); this.failPending('собеседник отключился'); this.fire('peer-left') }
        return
      }
      if (frame.op === 'err') { this.fire('relay-error', frame.code); return }
      if (frame.op !== 'msg' || typeof frame.d !== 'string') return
      const kind = frame.d[0]
      const body = frame.d.slice(1)
      if (kind === 'H') { await this.onShake(body); return }
      if (kind === 'M' && this.session) {
        const session = this.session
        this.inbound = this.inbound.then(async () => {
          try {
            if (this.session !== session) return
            const message = await session.receive(body)
            // Обработчик (например, снимок экрана на 30 с) не должен задерживать следующие пакеты, в том числе «стоп».
            this.onMessage(message).catch(() => {})
          } catch { /* повтор, чужой или битый пакет — молча отбрасываем */ }
        })
      }
    }

    // Рукопожатие: каждая сторона присылает свои случайные числа; ключи сеанса — из ключа устройства и обоих чисел.
    shake() {
      this.nonceMine = proto.randomNonce()
      this.session = null
      this.lastTheirs = null
      this.announced = true
      this.rawSend('H' + this.nonceMine)
    }
    async onShake(theirs) {
      if (!this.nonceMine) this.nonceMine = proto.randomNonce()
      // Свои числа шлём, если ещё не слали или собеседник начал заново (его числа новые); тех же чисел
      // в ответ на повтор не шлём — иначе стороны бесконечно перекидывались бы рукопожатиями.
      if (!this.announced || theirs !== this.lastTheirs) { this.rawSend('H' + this.nonceMine); this.announced = true }
      // Тот же собеседник и сеанс уже стоит — не пересобираем: счётчики пакетов сбросились бы на ходу.
      if (this.session && theirs === this.lastTheirs) return
      this.lastTheirs = theirs
      this.session = await proto.makeSession(this.deviceKey, this.role, this.nonceMine, theirs)
      this.attempt = 0
      this.setState('online')
      this.fire('session')
    }

    rawSend(data) {
      const socket = this.socket
      if (!socket || socket.readyState !== 1) return false
      socket.send(JSON.stringify({ op: 'msg', d: data }))
      return true
    }

    sendPacket(type, payload) {
      if (!this.session) return Promise.reject(new Error('сеанс не установлен'))
      const session = this.session
      const run = async () => {
        if (this.session !== session) throw new Error('сеанс сменился')
        const parts = proto.splitBig(type, payload)
        if (parts) { for (const part of parts) this.rawSend('M' + await session.send('big', part)); return }
        this.rawSend('M' + await session.send(type, payload))
      }
      const mine = this.outbound.then(run, run)
      this.outbound = mine.catch(() => {})
      return mine
    }

    async onMessage(message) {
      if (!message || typeof message !== 'object') return
      let { type, payload } = message
      if (typeof type !== 'string') return
      if (type === 'big') {
        const done = this.assembler.add(payload)
        if (!done) return
        type = done.type
        payload = done.payload
      }
      if (type === 'res') {
        const entry = this.pending.get(payload && payload.id)
        if (!entry) return
        this.pending.delete(payload.id)
        this.clearTimeout(entry.timer)
        if (payload.ok) entry.resolve(payload.result); else entry.reject(new Error(payload.error || 'отказ'))
        return
      }
      if (type === 'req' && this.role === 'd') { await this.onRequest(payload); return }
      if (type === 'ev' && payload && typeof payload === 'object') {
        this.fire('event', payload)
        if (typeof payload.name === 'string') this.fire('event:' + payload.name, payload.data)
        return
      }
    }

    async onRequest(request) {
      const id = request && request.id
      const method = request && typeof request.method === 'string' ? request.method : ''
      const handler = method && Object.hasOwn(this.handlers, method) && typeof this.handlers[method] === 'function' ? this.handlers[method] : null
      let answer
      if (!handler) answer = { id, ok: false, error: 'метод не поддерживается' }
      else {
        try { answer = { id, ok: true, result: await handler(request.params || {}, this) } } catch (error) { answer = { id, ok: false, error: String((error && error.message) || error).slice(0, 300) } }
      }
      try { await this.sendPacket('res', answer) } catch { /* сеанс оборвался */ }
    }

    // Телефон спрашивает компьютер.
    request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (this.role !== 'p') return Promise.reject(new Error('спрашивает телефон'))
      return new Promise((resolve, reject) => {
        if (!this.session) { reject(new Error('компьютер недоступен')); return }
        const id = proto.randomId()
        const timer = this.setTimeout(() => { this.pending.delete(id); reject(new Error('компьютер не ответил')) }, timeoutMs)
        this.pending.set(id, { resolve, reject, timer })
        this.sendPacket('req', { id, method, params: params || {} }).catch(error => { this.pending.delete(id); this.clearTimeout(timer); reject(error) })
      })
    }

    // Компьютер сообщает телефону.
    async emit(name, data) {
      if (!this.session) return false
      try { await this.sendPacket('ev', { name, data }); return true } catch { return false }
    }

    stop() {
      this.setState('stopped')
      this.clearTimeout(this.timer)
      this.failPending('связь закрыта')
      const socket = this.socket
      this.socket = null
      this.session = null
      try { if (socket) socket.close() } catch { /* уже закрыт */ }
    }
  }

  const api = { DeviceLink, REQUEST_TIMEOUT_MS }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneLink = api
})(typeof window !== 'undefined' ? window : globalThis)
