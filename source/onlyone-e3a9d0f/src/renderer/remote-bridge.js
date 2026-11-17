/* Мост удалённого управления в окне (волна 4): отвечает на вопросы главного процесса, которого спросил телефон.
 *
 * Чаты живут в окне, поэтому главный процесс (src/main/remote-control.js) спрашивает окно: список чатов, содержимое
 * чата, отправка, настройки. Телефону видны только чаты, где человек включил команду /remote-control
 * (chat.remote === true); любой другой чат для него не существует.
 *
 * Модуль не трогает DOM и приложение напрямую: всё нужное приходит в deps, поэтому его проверяют без окна.
 */
(function (root) {
  'use strict'

  const MAX_DATA_URL = 200 * 1024
  const MAX_TEXT = 60000
  const MAX_DEPTH = 8
  const MAX_REPLY = 6 * 1024 * 1024

  // Копия значения для телефона: без функций, без узлов, без огромных картинок, с ограничением глубины и длины.
  function clean(value, depth = 0) {
    if (value == null) return value
    const type = typeof value
    if (type === 'string') {
      if (value.startsWith('data:') && value.length > MAX_DATA_URL) return ''
      return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value
    }
    if (type === 'number' || type === 'boolean') return value
    if (type !== 'object' || depth > MAX_DEPTH) return undefined
    if (Array.isArray(value)) return value.slice(0, 400).map(item => clean(item, depth + 1))
    const out = {}
    for (const key of Object.keys(value).slice(0, 80)) {
      const item = clean(value[key], depth + 1)
      if (item !== undefined) out[key] = item
    }
    return out
  }

  const textOf = message => String((message && (message.content || message.text)) || '')

  function create(deps) {
    const conversations = deps.conversations      // () => массив чатов
    const panes = deps.panes                       // () => массив панелей
    const send = deps.send                         // async (pane, text) => void
    const select = deps.select                     // (pane, chatId) => void
    const emit = deps.emit || (() => {})           // (payload) => void: «чат изменился»
    const setRemote = deps.setRemote || ((chat, value) => { chat.remote = value })
    const setTimer = deps.setInterval || (typeof setInterval === 'function' ? setInterval : null)
    const settingsApi = deps.settings || null      // { models(), get(), set({model, effort}) }
    const shotApi = deps.shot || null              // async (chatId) => dataUrl | null
    const tasksApi = deps.tasks || null            // (chatId) => [...]
    const signatures = new Map()
    let timer = null

    const chatById = id => conversations().find(chat => chat.id === id) || null
    const remoteChat = id => {
      const chat = chatById(id)
      if (!chat) throw new Error('чат не найден')
      if (chat.remote !== true) throw new Error('чат не открыт для телефона: включите /remote-control')
      return chat
    }
    const paneOf = id => panes().find(pane => pane && pane.liveChatId === id && pane.generating) || null

    function summary(chat) {
      const messages = chat.messages || []
      const last = messages[messages.length - 1]
      return {
        id: chat.id, title: String(chat.title || '').slice(0, 120), updatedAt: Number(chat.updatedAt) || 0,
        count: messages.length, running: Boolean(paneOf(chat.id)),
        preview: last ? textOf(last).replace(/\s+/g, ' ').slice(0, 140) : '',
        projectId: chat.projectId || null
      }
    }

    function liveOf(chat) {
      const pane = paneOf(chat.id)
      if (!pane) return null
      return clean({
        requestId: pane.requestId, content: pane.contentBuffer || '', reasoning: String(pane.reasoningBuffer || '').slice(-4000),
        blocks: pane.blocks || [], tokens: pane.totalTokens || 0, modelId: pane.actualModelId || (pane.requestedModel && pane.requestedModel.id) || ''
      })
    }

    function signature(chat) {
      const messages = chat.messages || []
      const last = messages[messages.length - 1]
      const pane = paneOf(chat.id)
      return [messages.length, last ? textOf(last).length : 0, chat.title || '', pane ? 1 : 0, pane ? String(pane.contentBuffer || '').length : 0, pane && pane.blocks ? pane.blocks.length : 0].join('|')
    }

    // Что изменилось с прошлого раза, то уходит телефону; зовётся и по таймеру, и после сохранения истории.
    function pulse() {
      let anyLive = false
      for (const chat of conversations()) {
        if (chat.remote !== true) { signatures.delete(chat.id); continue }
        const now = signature(chat)
        const live = Boolean(paneOf(chat.id))
        if (live) anyLive = true
        if (signatures.get(chat.id) !== now) {
          signatures.set(chat.id, now)
          emit({ id: chat.id, running: live, updatedAt: Number(chat.updatedAt) || 0 })
        }
      }
      return anyLive
    }
    function startTimer() {
      if (timer || !setTimer) return
      timer = setTimer(() => { pulse() }, 1200)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }

    const methods = {
      'chats.list': () => conversations().filter(chat => chat.remote === true).map(summary).sort((a, b) => b.updatedAt - a.updatedAt),
      'chat.get': ({ id, limit }) => {
        const chat = remoteChat(id)
        const all = chat.messages || []
        let slice = all.slice(-Math.max(1, Math.min(200, Number(limit) || 60)))
        let messages = slice.map(message => clean(message))
        // Канал режет большое на куски, но не больше 400 по 100 КБ: самые старые сообщения отбрасываем, пока не поместится.
        const sizes = messages.map(message => (JSON.stringify(message) || 'null').length)
        let size = 2 + sizes.reduce((sum, length) => sum + length, 0) + Math.max(0, sizes.length - 1)
        let drop = 0
        while (drop < messages.length - 1 && size > MAX_REPLY) { size -= sizes[drop++] + 1 }
        if (drop) { slice = slice.slice(drop); messages = messages.slice(drop) }
        return { id: chat.id, title: chat.title || '', total: all.length, offset: all.length - slice.length, messages, live: liveOf(chat), settings: settingsApi ? clean(settingsApi.get()) : null }
      },
      'chat.send': async ({ id, text }) => {
        const chat = remoteChat(id)
        // Панель, показывающая этот чат, годится, только если её идущий ход — тоже
        // этого чата: иначе текст телефона ушёл бы в ход приватного чата (Н6, граница
        // доверия). Ход самого этого чата — законная очередь/правка своего хода.
        let pane = panes().find(p => p && p.chatId === chat.id &&
          (!(p.generating || p.preparing) || p.liveChatId === chat.id)) || null
        if (!pane) {
          const all = panes()
          if (!all.length) throw new Error('нет открытой панели чата')
          // Свободная любая панель, а не только первая: занятая первой не должна
          // запирать удалённое управление, когда вторая свободна (Н6).
          pane = all.find(p => p && !(p.generating || p.preparing)) || null
          // Панель занята ходом другого чата: переключить её значило бы сунуть сообщение в чужую очередь.
          if (!pane) throw new Error('на компьютере идёт ход в другом чате — дождитесь его конца')
          select(pane, chat.id)
        }
        const queued = Boolean(pane.generating || pane.preparing)
        // Ход идёт сам, ответ придёт событиями; здесь не ждём его конца.
        Promise.resolve(send(pane, String(text))).catch(() => {})
        return { ok: true, queued }
      },
      'chat.run': ({ id }) => {
        remoteChat(id)
        const pane = paneOf(id)
        return pane && pane.requestId ? { requestId: pane.requestId } : null
      },
      'runs.owners': () => {
        const out = {}
        for (const pane of panes()) {
          if (!pane || !pane.generating || !pane.requestId || !pane.liveChatId) continue
          const chat = chatById(pane.liveChatId)
          if (chat && chat.remote === true) out[pane.requestId] = chat.id
        }
        return out
      },
      'chat.settings': async ({ id, model, effort }) => {
        remoteChat(id)
        if (!settingsApi) throw new Error('настройки недоступны')
        if (model || effort) settingsApi.set({ model, effort })
        return clean(settingsApi.get())
      },
      'models.list': () => (settingsApi ? clean(settingsApi.models()) : []),
      'chat.shot': async ({ id }) => {
        remoteChat(id)
        if (!shotApi) throw new Error('снимок недоступен')
        const shot = await shotApi(id)
        return { image: shot && shot.length <= 3 * 1024 * 1024 ? shot : null }
      },
      'tasks.get': ({ id }) => {
        remoteChat(id)
        return tasksApi ? clean(tasksApi(id).map(item => ({ id: item.id, title: item.title, preview: item.preview, status: item.status, agent: item.agent }))) : []
      }
    }

    return {
      handle: async (method, params) => {
        const fn = methods[method]
        if (!fn) throw new Error('метод не поддерживается: ' + method)
        return fn(params || {})
      },
      // /remote-control в чате: включает и выключает показ чата на телефоне.
      toggle(chat) {
        const next = chat.remote !== true
        setRemote(chat, next)
        signatures.delete(chat.id)
        if (next) startTimer()
        pulse()
        return next
      },
      // Просьбы главного процесса приходят событием окна, ответ — обратно тем же каналом.
      attach(electronAPI) {
        electronAPI.onRemoteRequest(async request => {
          try { electronAPI.remoteReply({ id: request.id, result: await this.handle(request.method, request.params) }) } catch (error) { electronAPI.remoteReply({ id: request.id, error: String((error && error.message) || error) }) }
        })
      },
      isRemote: chat => Boolean(chat && chat.remote === true),
      pulse,
      start: startTimer,
      stop() { if (timer && typeof clearInterval === 'function') clearInterval(timer); timer = null }
    }
  }

  const api = { create, clean }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneRemoteBridge = api
})(typeof window !== 'undefined' ? window : globalThis)
