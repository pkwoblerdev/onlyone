/* Связь телефона с компьютером: спаривание по коду, постоянное соединение через посредника, кэш чатов компьютера.
   Всё шифруется ключом устройства (js/shared/remote-*.js); ключ лежит в зашифрованном хранилище телефона. */
(function (root) {
  'use strict'

  const DEFAULT_RELAY = ''

  function allowedRelay(value) {
    try {
      const url = new URL(String(value || ''))
      const host = url.hostname.toLowerCase().replace(/\.$/, '')
      if (url.username || url.password || ['pkwobler.best', 'pkwobler.dev'].some(domain => host === domain || host.endsWith('.' + domain))) return false
      return url.protocol === 'wss:' || (url.protocol === 'ws:' && ['localhost', '127.0.0.1', '10.0.2.2'].includes(host))
    } catch { return false }
  }

  function create(deps) {
    const store = deps.store
    const WebSocketImpl = deps.WebSocketImpl || root.WebSocket
    const proto = root.OnlyoneRemote
    const listeners = new Map()
    const state = { paired: null, status: 'off', chats: [], chatsAt: 0, pending: { approvals: [], questions: [] } }
    let link = null

    const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn) }
    const fire = (name, data) => { for (const fn of listeners.get(name) || []) { try { fn(data) } catch { /* слушатель не рушит связь */ } } }

    async function load() {
      state.paired = await store.get('pc', null)
      state.chats = await store.get('pcchats', [])
      return state
    }

    function setStatus(status) { if (state.status !== status) { state.status = status; fire('status', status) } }

    async function refreshChats() {
      if (!link || state.status !== 'online') return state.chats
      const list = await link.request('chats.list')
      state.chats = Array.isArray(list) ? list : []
      state.chatsAt = Date.now()
      await store.set('pcchats', state.chats)
      fire('chats', state.chats)
      return state.chats
    }

    async function refreshPending() {
      if (!link || state.status !== 'online') return state.pending
      const before = new Set([...state.pending.approvals.map(item => item.id), ...state.pending.questions.map(item => item.id)])
      const pending = await link.request('pending.list')
      state.pending = { approvals: pending.approvals || [], questions: pending.questions || [] }
      const fresh = [...state.pending.approvals, ...state.pending.questions].filter(item => !before.has(item.id))
      fire('pending', { pending: state.pending, fresh })
      return state.pending
    }

    function connect() {
      if (!state.paired || link) return
      const paired = state.paired
      if (!allowedRelay(paired.relay || DEFAULT_RELAY)) { setStatus('off'); return }
      link = new root.OnlyoneLink.DeviceLink({ url: paired.relay || DEFAULT_RELAY, deviceKey: proto.fromHex(paired.deviceKey), role: 'p', WebSocketImpl })
      link.on('status', status => {
        setStatus(status === 'online' ? 'online' : (status === 'waiting' ? 'waiting' : (status === 'stopped' ? 'off' : 'connecting')))
        if (status === 'online') { refreshChats().catch(() => {}); refreshPending().catch(() => {}) }
      })
      link.on('event:chat-changed', data => { fire('chat-changed', data || {}); refreshChats().catch(() => {}) })
      link.on('event:pending-changed', () => { refreshPending().catch(() => {}) })
      link.start().catch(() => {})
    }

    function disconnect() {
      if (link) { link.stop(); link = null }
      setStatus('off')
    }

    async function pair(options) {
      const relay = options.relay || DEFAULT_RELAY
      if (!allowedRelay(relay)) throw new Error('Адрес сервера недоступен или не настроен / Relay is unavailable or not configured')
      const result = await root.OnlyonePairing.pairAsPhone({ url: relay, code: options.code, name: options.name, onSas: options.onSas, WebSocketImpl })
      state.paired = { deviceKey: proto.toHex(result.deviceKey), deviceId: result.deviceId, desktopName: result.desktopName, relay }
      await store.set('pc', state.paired)
      disconnect()
      connect()
      return state.paired
    }

    async function forget() {
      disconnect()
      state.paired = null
      state.chats = []
      state.pending = { approvals: [], questions: [] }
      store.remove('pc'); store.remove('pcchats')
      fire('chats', [])
    }

    const request = (method, params, timeout) => {
      if (!link) return Promise.reject(new Error('Компьютер не подключён'))
      return link.request(method, params, timeout)
    }

    return { state, on, load, connect, disconnect, pair, forget, request, refreshChats, refreshPending, DEFAULT_RELAY }
  }

  root.OnlyoneRemoteClient = { create, DEFAULT_RELAY }
})(window)
