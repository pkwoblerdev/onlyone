/* onlyone для Android. Один экран за раз: список чатов (свои и компьютера вместе), чат, подключение, настройки.
   Чаты компьютера — те, где на ПК включена команда /remote-control; они помечены значком компьютера. */
(function (root) {
  'use strict'
  const { icon, MARK } = root.OnlyoneIcons
  const { t, setLang } = root.OnlyoneI18n
  const { esc, messageHtml, liveHtml } = root.OnlyoneRender
  const Store = root.OnlyoneStore
  const Provider = root.OnlyoneProvider
  const doc = document
  const $ = id => doc.getElementById(id)
  const cap = () => (root.Capacitor && root.Capacitor.Plugins) || {}

  const S = {
    settings: { lang: 'auto', theme: 'dark', notify: true, providers: [], deviceName: '' },
    chats: [],
    stack: [],
    remote: null,
    pc: null,           // открытый чат компьютера: { id, messages, live, settings, error }
    own: null,          // идущий ответ своего чата: { chatId, controller, text }
    models: { pc: null, own: {} }
  }

  // ─── мелочи ────────────────────────────────────────────────────────────────
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2))
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  function timeLabel(at) {
    if (!at) return ''
    const date = new Date(at)
    const now = new Date()
    if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
  }

  let toastTimer = null
  function toast(text, isError) {
    const old = $('toast')
    if (old) old.remove()
    const node = doc.createElement('div')
    node.id = 'toast'
    node.className = 'toast' + (isError ? ' err' : '')
    node.setAttribute('role', 'status')
    node.textContent = text
    $('app').appendChild(node)
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => node.remove(), 3200)
  }

  async function saveSettings() { await Store.set('settings', S.settings) }
  async function saveChats() { await Store.set('chats', S.chats.slice(0, 200)) }

  function applyTheme() {
    const theme = S.settings.theme
    if (theme === 'light' || theme === 'dark') doc.documentElement.dataset.theme = theme
    else delete doc.documentElement.dataset.theme
    const meta = doc.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', getComputedStyle(doc.documentElement).getPropertyValue('--bg').trim() || '#171613')
  }

  // ─── навигация ─────────────────────────────────────────────────────────────
  function go(name, params, back) {
    S.stack.push({ name, params: params || {} })
    paint(back ? 'back' : '')
  }
  function pop() {
    if (S.stack.length <= 1) return false
    leaveScreen()
    S.stack.pop()
    paint('back')
    return true
  }
  const top = () => S.stack[S.stack.length - 1]
  function replaceStack(name, params) { leaveScreen(); S.stack = [{ name, params: params || {} }]; paint('') }

  function leaveScreen() {
    const current = top()
    if (current && current.name === 'chat') {
      if (current.params.kind === 'pc') S.pc = null
    }
  }

  function paint(direction) {
    const current = top()
    const screen = doc.createElement('section')
    screen.className = 'screen' + (direction === 'back' ? ' back' : '')
    screen.id = 'screen'
    const old = $('screen')
    if (old) old.remove()
    $('app').appendChild(screen)
    closeSheet()
    const draw = { home: drawHome, chat: drawChat, pair: drawPair, settings: drawSettings, provider: drawProvider }[current.name]
    draw(screen, current.params)
  }

  // ─── нижние листы ──────────────────────────────────────────────────────────
  function openSheet(title, bodyHtml, bind) {
    closeSheet()
    const wrap = doc.createElement('div')
    wrap.id = 'sheet-root'
    wrap.innerHTML = '<div class="scrim" data-act="sheet-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="sheet-grip"></div><div class="sheet-head">' + esc(title) + '</div><div class="sheet-body">' + bodyHtml + '</div></div>'
    $('app').appendChild(wrap)
    wrap.addEventListener('click', event => { if (event.target.closest('[data-act="sheet-close"]')) closeSheet() })
    if (bind) bind(wrap)
    return wrap
  }
  function closeSheet() { const node = $('sheet-root'); if (node) node.remove() }

  function head(title, options = {}) {
    const back = options.back ? '<button class="icon-btn" data-act="back" aria-label="' + esc(t('Назад')) + '">' + icon('back') + '</button>' : ''
    const titleHtml = options.sub !== undefined
      ? '<div class="head-title"><b>' + esc(title) + '</b><span>' + (options.subHtml || esc(options.sub)) + '</span></div>'
      : '<h1>' + (options.mark ? MARK : '') + esc(title) + '</h1>'
    return '<header class="head' + (options.back ? ' has-back' : '') + '">' + back + titleHtml + (options.actions || '') + '</header>'
  }

  // ─── домашний экран: один список ──────────────────────────────────────────
  function mergedChats() {
    const own = S.chats.map(chat => ({ kind: 'own', id: chat.id, title: chat.title || t('Новый чат'), sub: lastText(chat), at: chat.updatedAt || 0 }))
    const pc = (S.remote.state.chats || []).map(chat => ({ kind: 'pc', id: chat.id, title: chat.title || t('Новый чат'), sub: chat.preview || '', at: chat.updatedAt || 0, running: chat.running }))
    return [...own, ...pc].sort((a, b) => b.at - a.at)
  }
  const lastText = chat => {
    const last = (chat.messages || [])[chat.messages.length - 1]
    return last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 120) : ''
  }

  function connStrip() {
    const paired = S.remote.state.paired
    if (!paired) {
      return '<div class="conn"><span class="conn-main"><b>' + esc(t('Чаты компьютера')) + '</b><span class="caption">' + esc(t('Подключите onlyone на компьютере, чтобы видеть его чаты здесь')) + '</span></span><button class="btn primary" data-act="pair">' + esc(t('Подключить')) + '</button></div>'
    }
    const status = S.remote.state.status
    const text = status === 'online' ? t('в сети') : (status === 'waiting' ? t('onlyone на компьютере закрыт') : t('подключаюсь…'))
    return '<div class="conn"><span class="pc-badge' + (status === 'online' ? '' : ' off') + '">' + icon('monitor') + '</span><span class="conn-main">' + esc(paired.desktopName) + '<span class="caption">' + esc(text) + '</span></span><i class="dot' + (status === 'online' ? ' on' : '') + '"></i></div>'
  }

  function drawHome(screen) {
    screen.innerHTML = head('onlyone', { mark: true, actions: '<button class="icon-btn" data-act="settings" aria-label="' + esc(t('Настройки')) + '">' + icon('settings') + '</button><button class="icon-btn accent" data-act="new-chat" aria-label="' + esc(t('Новый чат')) + '">' + icon('plus') + '</button>' }) +
      '<div class="body" id="home-body"></div>'
    fillHome()
    bindActions(screen)
  }

  function fillHome() {
    const body = $('home-body')
    if (!body) return
    const items = mergedChats()
    const keyless = !S.settings.providers.length
    const online = S.remote.state.status === 'online'
    let html = connStrip()
    if (keyless && !S.remote.state.paired && items.length) {
      html += '<div class="notice"><span>' + icon('key') + '</span><span>' + esc(t('Чтобы писать прямо с телефона, добавьте ключ провайдера. Или подключите компьютер и работайте в его чатах.')) + '<br><button class="btn" data-act="add-provider">' + esc(t('Добавить ключ')) + '</button></span></div>'
    }
    if (!items.length) {
      html += '<div class="empty">' + icon('chat') + '<b>' + esc(t('Чатов пока нет')) + '</b><span>' + esc(S.remote.state.paired ? t('Откройте чат на компьютере и напишите в нём /remote-control: он появится здесь.') : t('Начните новый чат или подключите компьютер.')) + '</span><button class="btn primary" data-act="new-chat">' + esc(t('Новый чат')) + '</button></div>'
    } else {
      html += items.map(item => {
        const pc = item.kind === 'pc'
        const badge = pc ? '<span class="pc-badge' + (online ? '' : ' off') + '" title="' + esc(online ? t('Чат компьютера') : t('Компьютер недоступен')) + '">' + icon('monitor', 'ic-sm') + '</span>' : ''
        const state = pc ? (item.running ? '<i class="dot work"></i>' : (online ? '' : '<span>' + esc(t('недоступен')) + '</span>')) : ''
        return '<button class="chat-row" data-act="open" data-kind="' + item.kind + '" data-id="' + esc(item.id) + '"><span class="chat-row-main"><span class="chat-row-title">' + badge + '<span>' + esc(item.title) + '</span></span><span class="chat-row-sub">' + esc(item.sub || ' ') + '</span></span><span class="chat-row-meta"><span>' + esc(timeLabel(item.at)) + '</span>' + state + '</span></button>'
      }).join('')
    }
    body.innerHTML = html
  }

  // ─── спаривание ────────────────────────────────────────────────────────────
  function drawPair(screen, params) {
    screen.innerHTML = head(t('Подключить компьютер'), { back: true }) +
      '<div class="body"><div class="pad"><p class="caption">' + esc(t('На компьютере откройте Настройки → Удалённое управление, включите его и нажмите «Показать код». Введите код ниже или наведите камеру телефона на QR: он откроет это приложение сам.')) + '</p></div>' +
      '<div class="field"><label for="pair-code">' + esc(t('Код')) + '</label><input id="pair-code" class="code-input" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="11" placeholder="ABCDE-FGHJK" value="' + esc(params.code || '') + '"></div>' +
      '<div class="field"><label for="pair-name">' + esc(t('Как назвать этот телефон')) + '</label><input id="pair-name" autocomplete="off" value="' + esc(S.settings.deviceName || '') + '"><span class="hint">' + esc(t('Это имя увидите на компьютере при подтверждении')) + '</span></div>' +
      '<div class="field"><label for="pair-relay">' + esc(t('Адрес посредника')) + '</label><input id="pair-relay" autocomplete="off" spellcheck="false" value="' + esc(params.relay || S.remote.state.paired?.relay || S.remote.DEFAULT_RELAY) + '"></div>' +
      '<div class="pad"><button class="btn primary block" id="pair-go" data-act="pair-go">' + esc(t('Подключить')) + '</button></div><div id="pair-status" class="pad center"></div></div>'
    bindActions(screen)
    const input = $('pair-code')
    input.addEventListener('input', () => {
      const raw = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10)
      input.value = raw.length > 5 ? raw.slice(0, 5) + '-' + raw.slice(5) : raw
    })
    if (params.code) input.dispatchEvent(new Event('input'))
  }

  async function doPair() {
    const code = $('pair-code').value
    const name = $('pair-name').value.trim() || t('Телефон')
    const relay = $('pair-relay').value.trim()
    const status = $('pair-status')
    const button = $('pair-go')
    button.disabled = true
    status.innerHTML = '<span class="caption">' + esc(t('Ищу компьютер…')) + '</span>'
    try {
      S.settings.deviceName = name
      await saveSettings()
      await S.remote.pair({
        code, name, relay,
        onSas: sas => { status.innerHTML = '<div class="caption">' + esc(t('Проверьте цифры. Они должны совпасть с теми, что на компьютере, и там нужно нажать «Подключить»')) + '</div><div class="sas">' + esc(sas) + '</div>' }
      })
      toast(t('Компьютер подключён'))
      replaceStack('home')
    } catch (error) {
      button.disabled = false
      status.innerHTML = '<div class="err-text">' + esc(error.message || String(error)) + '</div>'
    }
  }

  // ─── свой провайдер ────────────────────────────────────────────────────────
  function drawProvider(screen, params) {
    const existing = S.settings.providers.find(item => item.id === params.id) || { id: uid(), name: 'OpenRouter', baseUrl: Provider.OPENROUTER, key: '', model: 'openrouter/auto' }
    screen.innerHTML = head(params.id ? t('Провайдер') : t('Новый провайдер'), { back: true }) +
      '<div class="body">' +
      '<div class="field"><label for="pv-name">' + esc(t('Название')) + '</label><input id="pv-name" autocomplete="off" value="' + esc(existing.name) + '"></div>' +
      '<div class="field"><label for="pv-url">' + esc(t('Адрес API')) + '</label><input id="pv-url" autocomplete="off" spellcheck="false" inputmode="url" value="' + esc(existing.baseUrl) + '"><span class="hint">' + esc(t('OpenRouter или любой сервис с интерфейсом OpenAI')) + '</span></div>' +
      '<div class="field"><label for="pv-key">' + esc(t('Ключ')) + '</label><input id="pv-key" type="password" autocomplete="off" spellcheck="false" value="' + esc(existing.key) + '"><span class="hint">' + esc(t('Хранится только на этом телефоне, в зашифрованном виде')) + '</span></div>' +
      '<div class="field"><label for="pv-model">' + esc(t('Модель по умолчанию')) + '</label><input id="pv-model" autocomplete="off" spellcheck="false" value="' + esc(existing.model) + '"></div>' +
      '<div class="pad"><button class="btn primary block" data-act="provider-save" data-id="' + esc(existing.id) + '">' + esc(t('Сохранить')) + '</button></div>' +
      (params.id ? '<div class="pad"><button class="btn danger block" data-act="provider-del" data-id="' + esc(existing.id) + '">' + esc(t('Удалить ключ')) + '</button></div>' : '') +
      '</div>'
    bindActions(screen)
  }

  async function saveProvider(id) {
    const value = {
      id, name: $('pv-name').value.trim() || 'OpenRouter', baseUrl: $('pv-url').value.trim() || Provider.OPENROUTER,
      key: $('pv-key').value.trim(), model: $('pv-model').value.trim() || 'openrouter/auto'
    }
    if (!value.key) { toast(t('Вставьте ключ'), true); return }
    if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/i.test(value.baseUrl)) { toast(t('Адрес должен начинаться с https://'), true); return }
    const at = S.settings.providers.findIndex(item => item.id === id)
    if (at >= 0) S.settings.providers[at] = value; else S.settings.providers.push(value)
    await saveSettings()
    toast(t('Сохранено'))
    pop()
  }

  // ─── настройки ─────────────────────────────────────────────────────────────
  function drawSettings(screen) {
    const paired = S.remote.state.paired
    const status = S.remote.state.status
    const providers = S.settings.providers.map(item => '<button class="row" data-act="provider" data-id="' + esc(item.id) + '"><span class="row-main"><span>' + esc(item.name) + '</span><span class="caption">' + esc(item.model) + '</span></span>' + icon('chev') + '</button>').join('')
    const segment = (key, values) => '<span class="seg" role="group">' + values.map(([value, label]) => '<button data-act="set-' + key + '" data-value="' + value + '" class="' + (S.settings[key] === value ? 'on' : '') + '" aria-pressed="' + (S.settings[key] === value) + '">' + esc(label) + '</button>').join('') + '</span>'
    screen.innerHTML = head(t('Настройки'), { back: true }) + '<div class="body">' +
      '<div class="group-title">' + esc(t('Компьютер')) + '</div><div class="card">' +
      (paired
        ? '<div class="row"><span class="pc-badge">' + icon('monitor') + '</span><span class="row-main"><span>' + esc(paired.desktopName) + '</span><span class="caption">' + esc(status === 'online' ? t('в сети') : t('не в сети')) + '</span></span><i class="dot' + (status === 'online' ? ' on' : '') + '"></i></div><button class="row" data-act="forget"><span class="row-main"><span>' + esc(t('Забыть компьютер')) + '</span><span class="caption">' + esc(t('Телефон перестанет видеть его чаты. Код можно сбросить и на самом компьютере')) + '</span></span></button>'
        : '<button class="row" data-act="pair"><span class="row-main"><span>' + esc(t('Подключить компьютер')) + '</span><span class="caption">' + esc(t('Чаты с командой /remote-control появятся в общем списке')) + '</span></span>' + icon('chev') + '</button>') +
      '</div>' +
      '<div class="group-title">' + esc(t('Провайдеры и ключи')) + '</div><div class="card">' + providers +
      '<button class="row" data-act="add-provider"><span class="row-main"><span>' + esc(t('Добавить ключ')) + '</span><span class="caption">' + esc(t('Свои чаты на телефоне, без компьютера')) + '</span></span>' + icon('plus') + '</button></div>' +
      '<div class="group-title">' + esc(t('Вид')) + '</div><div class="card">' +
      '<div class="row"><span class="row-main"><span>' + esc(t('Язык')) + '</span></span>' + segment('lang', [['auto', t('Авто')], ['ru', 'RU'], ['en', 'EN']]) + '</div>' +
      '<div class="row"><span class="row-main"><span>' + esc(t('Тема')) + '</span></span>' + segment('theme', [['auto', t('Авто')], ['dark', t('Тёмная')], ['light', t('Светлая')]]) + '</div>' +
      '<label class="row"><span class="row-main"><span>' + esc(t('Уведомления')) + '</span><span class="caption">' + esc(t('О разрешениях и вопросах агента, пока приложение открыто')) + '</span></span><span class="switch"><input type="checkbox" data-act="toggle-notify"' + (S.settings.notify ? ' checked' : '') + '><i></i></span></label></div>' +
      '<div class="group-title">' + esc(t('О приложении')) + '</div><div class="card"><div class="row"><span class="row-main"><span>onlyone ' + esc(root.ONLYONE_VERSION || '') + '</span><span class="caption">' + esc(t('Экспериментальная версия. Данные хранятся только на этом телефоне')) + '</span></span></div></div><div class="sp"></div></div>'
    bindActions(screen)
  }

  // ─── чат ───────────────────────────────────────────────────────────────────
  const ownChat = id => S.chats.find(chat => chat.id === id)

  function newOwnChat() {
    const provider = S.settings.providers[0]
    if (!provider) { go('provider', {}); toast(t('Сначала добавьте ключ провайдера')); return }
    const chat = { id: uid(), title: t('Новый чат'), messages: [], updatedAt: Date.now(), providerId: provider.id, model: provider.model }
    S.chats.unshift(chat)
    saveChats()
    go('chat', { kind: 'own', id: chat.id })
  }

  function chatTitle(params) {
    if (params.kind === 'own') return (ownChat(params.id) || {}).title || t('Новый чат')
    return ((S.remote.state.chats || []).find(chat => chat.id === params.id) || {}).title || (S.pc && S.pc.title) || t('Чат')
  }

  function drawChat(screen, params) {
    const pcMode = params.kind === 'pc'
    const subHtml = pcMode ? '<span class="pc-badge">' + icon('monitor', 'ic-sm') + '</span> ' + esc(S.remote.state.paired?.desktopName || '') : esc((ownChat(params.id) || {}).model || '')
    const actions = (pcMode ? '<button class="icon-btn" data-act="tasks" aria-label="' + esc(t('Задачи')) + '">' + icon('tasks') + '</button><button class="icon-btn" data-act="shot" aria-label="' + esc(t('Снимок экрана компьютера')) + '">' + icon('image') + '</button>' : '') +
      '<button class="icon-btn" data-act="chat-more" aria-label="' + esc(t('Ещё')) + '">' + icon('more') + '</button>'
    screen.innerHTML = head(chatTitle(params), { back: true, sub: '', subHtml, actions }) +
      '<div class="body" id="msgs-body"><div class="msgs" id="msgs"></div></div>' +
      '<div id="asks"></div>' +
      '<div class="composer"><div class="chips" id="chips"></div><div class="input-row"><textarea id="composer-input" rows="1" autocomplete="off" placeholder="' + esc(t('Сообщение')) + '" aria-label="' + esc(t('Сообщение')) + '"></textarea><button class="send" id="send-btn" data-act="send" aria-label="' + esc(t('Отправить')) + '">' + icon('send') + '</button></div></div>'
    bindActions(screen)
    const input = $('composer-input')
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px' })
    if (pcMode) openPcChat(params.id); else { paintMessages(); paintChips(); paintSend() }
  }

  const stickToBottom = () => { const body = $('msgs-body'); return !body || body.scrollHeight - body.scrollTop - body.clientHeight < 140 }
  function scrollDown(force) { const body = $('msgs-body'); if (body && force) body.scrollTop = body.scrollHeight }

  function paintMessages() {
    const host = $('msgs')
    if (!host) return
    const params = top().params
    const stick = stickToBottom()
    let html = ''
    if (params.kind === 'own') {
      const chat = ownChat(params.id)
      html = (chat ? chat.messages : []).map(message => messageHtml(message)).join('')
      if (S.own && S.own.chatId === params.id) html += liveHtml({ content: S.own.text, blocks: [] })
      if (!html) html = '<div class="empty">' + icon('chat') + '<b>' + esc(t('Пустой чат')) + '</b><span>' + esc(t('Напишите первое сообщение')) + '</span></div>'
    } else if (S.pc) {
      if (S.pc.error) html += '<div class="notice danger"><span>' + icon('alert') + '</span><span>' + esc(S.pc.error) + '<br><button class="btn" data-act="retry-pc">' + esc(t('Повторить')) + '</button></span></div>'
      html += (S.pc.messages || []).map(message => messageHtml(message)).join('')
      if (S.pc.live) html += liveHtml(S.pc.live)
      if (!html) html = '<div class="empty"><b>' + esc(t('Загружаю чат…')) + '</b></div>'
    }
    host.innerHTML = html
    for (const image of host.querySelectorAll('img.shot')) image.addEventListener('click', () => lightbox(image.src))
    if (stick || (S.pc && S.pc.firstPaint)) { scrollDown(true); if (S.pc) S.pc.firstPaint = false }
  }

  function paintSend() {
    const button = $('send-btn')
    if (!button) return
    const running = isRunning()
    button.innerHTML = icon(running ? 'stop' : 'send')
    button.dataset.act = running ? 'stop' : 'send'
    button.setAttribute('aria-label', running ? t('Остановить') : t('Отправить'))
  }
  function isRunning() {
    const params = top().params
    if (params.kind === 'own') return Boolean(S.own && S.own.chatId === params.id)
    return Boolean(S.pc && S.pc.live)
  }

  function paintChips() {
    const host = $('chips')
    if (!host) return
    const params = top().params
    if (params.kind === 'own') {
      const chat = ownChat(params.id)
      host.innerHTML = chat ? '<button class="chip" data-act="model-own">' + icon('code', 'ic-sm') + '<span>' + esc(chat.model) + '</span></button>' : ''
    } else if (S.pc) {
      const settings = S.pc.settings || {}
      host.innerHTML = (settings.modelName || settings.model ? '<button class="chip" data-act="model-pc">' + icon('code', 'ic-sm') + '<span>' + esc(settings.modelName || settings.model) + '</span></button>' : '') +
        (settings.effort ? '<button class="chip" data-act="effort-pc">' + icon('fast', 'ic-sm') + '<span>' + esc(settings.effort) + '</span></button>' : '')
    }
  }

  // Разрешения и вопросы агента, относящиеся к этому чату. Общий фильтр для карточек
  // и карусели: считать pending по всем чатам значило бы запереть индекс на чужом
  // total и сделать первый запрос недостижимым (break-3 Н5).
  function askItems() {
    const id = top().params.id
    return [
      ...S.remote.state.pending.approvals.filter(item => item.chat === id).map(item => ({ ...item, type: 'approval' })),
      ...S.remote.state.pending.questions.filter(item => item.chat === id).map(item => ({ ...item, type: 'question' }))
    ]
  }

  // Разрешения и вопросы агента, относящиеся к этому чату.
  function paintAsks() {
    const host = $('asks')
    if (!host || !S.pc) return
    // Перерисовка снимает кнопку: таймер удержания на снятом узле не должен дожить до разрешения.
    if (holdReset) { holdReset(); holdReset = null }
    const items = askItems()
    if (!items.length) { host.innerHTML = ''; return }
    // Один запрос за раз: стопка карточек съедала экран, а ответить нужно на каждый по отдельности.
    S.pc.askIdx = Math.min(S.pc.askIdx || 0, items.length - 1)
    const item = items[S.pc.askIdx]
    const pager = items.length > 1 ? '<button class="btn pager" data-act="ask-next">' + esc(t('Следующий запрос')) + ' · ' + (S.pc.askIdx + 1) + ' / ' + items.length + '</button>' : ''
    let card
    if (item.type === 'approval') {
      const detail = [item.details, item.diff].filter(Boolean).join('\n\n')
      const reject = '<button class="btn" data-act="reject" data-id="' + esc(item.id) + '">' + esc(t('Отклонить')) + '</button>'
      const actions = item.dangerous
        ? '<div class="ask-actions">' + reject + '<button class="btn danger hold" data-act="hold" data-id="' + esc(item.id) + '"><i></i><span>' + esc(t('Удерживайте, чтобы разрешить')) + '</span></button></div>'
        : '<div class="ask-actions">' + reject + '<button class="btn primary" data-act="approve" data-id="' + esc(item.id) + '">' + esc(t('Разрешить')) + '</button></div>'
      card = '<div class="ask' + (item.dangerous ? ' danger' : '') + '"><div class="ask-title">' + icon(item.dangerous ? 'alert' : 'eye') + '<span>' + esc(item.dangerous ? t('Опасное действие: ') : '') + esc(item.summary) + '</span></div>' + (detail ? '<pre>' + esc(detail) + '</pre>' : '') + actions + pager + '</div>'
    } else {
      card = '<div class="ask"><div class="ask-title">' + icon('info') + '<span>' + esc(item.question) + '</span></div>' + (item.note ? '<span class="caption">' + esc(item.note) + '</span>' : '') +
        item.options.map(option => '<button class="btn" data-act="answer" data-id="' + esc(item.id) + '" data-label="' + esc(option.label) + '">' + esc(option.label) + (option.detail ? ' — ' + esc(option.detail) : '') + '</button>').join('') + pager + '</div>'
    }
    host.innerHTML = card
    bindHold(host)
  }

  // Удержание: опасное действие разрешается только после 1,2 секунд нажатия — случайный тап не пройдёт.
  let holdReset = null
  function bindHold(host) {
    for (const button of host.querySelectorAll('.hold')) {
      let timer = null
      const bar = button.querySelector('i')
      const reset = () => { clearTimeout(timer); timer = null; bar.style.transition = 'transform 160ms'; bar.style.transform = 'scaleX(0)' }
      const start = event => {
        event.preventDefault()
        clearTimeout(timer) // второй палец не должен оставлять осиротевший таймер первого
        bar.style.transition = 'transform 1200ms linear'
        bar.style.transform = 'scaleX(1)'
        timer = setTimeout(() => { reset(); answerApproval(button.dataset.id, true, true) }, 1200)
      }
      button.addEventListener('pointerdown', start)
      for (const name of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(name, reset)
      button.addEventListener('contextmenu', event => event.preventDefault())
      holdReset = reset
    }
  }

  async function answerApproval(id, approved, confirmed) {
    try { await S.remote.request('approval.answer', { id, approved, confirmed: Boolean(confirmed) }); await S.remote.refreshPending() } catch (error) { toast(error.message, true) }
    paintAsks()
  }

  // ── чат компьютера ──
  let pcTimer = null
  async function openPcChat(id) {
    S.pc = { id, messages: [], live: null, settings: null, error: '', firstPaint: true, title: '' }
    paintMessages(); paintChips(); paintSend(); paintAsks()
    await loadPcChat()
  }
  async function loadPcChat() {
    const params = top().params
    if (params.kind !== 'pc' || !S.pc) return
    const id = params.id
    try {
      const got = await S.remote.request('chat.get', { id, limit: 80 }, 30000)
      if (!S.pc || S.pc.id !== id) return
      S.pc.messages = got.messages || []
      S.pc.live = got.live || null
      S.pc.settings = got.settings || S.pc.settings
      S.pc.title = got.title || S.pc.title
      S.pc.error = ''
    } catch (error) {
      if (!S.pc || S.pc.id !== id) return
      S.pc.error = S.remote.state.status === 'online' ? (error.message || t('Не удалось загрузить чат')) : t('Компьютер недоступен. Запустите onlyone на ПК, чат откроется сам.')
    }
    paintMessages(); paintChips(); paintSend(); paintAsks()
  }
  function schedulePcReload() { clearTimeout(pcTimer); pcTimer = setTimeout(loadPcChat, 350) }

  async function sendMessage() {
    const input = $('composer-input')
    const text = input.value.trim()
    if (!text) return
    const params = top().params
    input.value = ''; input.style.height = 'auto'
    if (params.kind === 'pc') {
      if (S.pc) { S.pc.messages.push({ role: 'user', content: text }); paintMessages(); scrollDown(true) }
      try { await S.remote.request('chat.send', { id: params.id, text }) } catch (error) { toast(error.message, true); if (S.pc) { S.pc.messages.pop(); paintMessages() } }
      return
    }
    await sendOwn(params.id, text)
  }

  async function sendOwn(chatId, text) {
    const chat = ownChat(chatId)
    if (!chat || S.own) return
    const provider = S.settings.providers.find(item => item.id === chat.providerId) || S.settings.providers[0]
    if (!provider) { toast(t('Нет ключа провайдера'), true); return }
    chat.messages.push({ role: 'user', content: text })
    if (chat.messages.length === 1) chat.title = text.replace(/\s+/g, ' ').slice(0, 40)
    chat.updatedAt = Date.now()
    const controller = new AbortController()
    S.own = { chatId, controller, text: '' }
    paintMessages(); paintSend(); scrollDown(true)
    let error = ''
    try {
      await Provider.stream({
        provider, model: chat.model, signal: controller.signal,
        messages: chat.messages.map(message => ({ role: message.role, content: message.content })),
        onDelta: (piece, full) => { S.own.text = full; if (top().params.id === chatId) { paintMessages() } }
      })
    } catch (caught) { if (caught.name !== 'AbortError') error = caught.message || String(caught) }
    const answer = S.own ? S.own.text : ''
    S.own = null
    if (answer || error) chat.messages.push({ role: 'assistant', content: answer, error: error || undefined })
    chat.updatedAt = Date.now()
    await saveChats()
    if (top().name === 'chat' && top().params.id === chatId) { paintMessages(); paintSend(); const titleNode = doc.querySelector('.head-title b'); if (titleNode) titleNode.textContent = chat.title }
  }

  async function stopRun() {
    const params = top().params
    if (params.kind === 'own') { if (S.own) S.own.controller.abort(); return }
    try { await S.remote.request('chat.stop', { id: params.id }) } catch (error) { toast(error.message, true) }
  }

  // ── листы выбора модели, задач, снимка ──
  async function pcModels() {
    if (!S.models.pc) S.models.pc = await S.remote.request('models.list')
    return S.models.pc
  }
  async function pickModel(kind) {
    const params = top().params
    let list
    try {
      list = kind === 'pc' ? await pcModels() : await Provider.listModels(S.settings.providers.find(item => item.id === (ownChat(params.id) || {}).providerId) || S.settings.providers[0])
    } catch (error) { toast(error.message, true); return }
    const current = kind === 'pc' ? (S.pc.settings || {}).model : (ownChat(params.id) || {}).model
    openSheet(t('Модель'), '<div class="field"><input id="model-q" autocomplete="off" placeholder="' + esc(t('Поиск')) + '" aria-label="' + esc(t('Поиск')) + '"></div><div id="model-list"></div>', wrap => {
      const draw = () => {
        const query = $('model-q').value.trim().toLowerCase()
        $('model-list').innerHTML = list.filter(item => !query || (item.id + ' ' + item.name).toLowerCase().includes(query)).slice(0, 80).map(item =>
          '<button class="opt" data-pick="' + esc(item.id) + '"><span>' + esc(item.name)  + '<small>' + esc(item.id) + '</small></span>' + (item.id === current ? '<span class="check">' + icon('check') + '</span>' : '') + '</button>').join('')
      }
      draw()
      $('model-q').addEventListener('input', draw)
      wrap.addEventListener('click', async event => {
        const row = event.target.closest('[data-pick]')
        if (!row) return
        closeSheet()
        if (kind === 'pc') {
          try { S.pc.settings = await S.remote.request('chat.settings', { id: params.id, model: row.dataset.pick }); paintChips(); toast(t('Модель сменилась на компьютере')) } catch (error) { toast(error.message, true) }
        } else {
          const chat = ownChat(params.id)
          chat.model = row.dataset.pick; await saveChats(); paintChips()
        }
      })
    })
  }

  function pickEffort() {
    const settings = S.pc.settings || {}
    const stops = settings.stops || ['off', 'low', 'medium', 'high', 'max']
    openSheet(t('Глубина рассуждений'), stops.map(stop => '<button class="opt" data-pick="' + esc(stop) + '"><span>' + esc(stop) + '</span>' + (stop === settings.effort ? '<span class="check">' + icon('check') + '</span>' : '') + '</button>').join(''), wrap => {
      wrap.addEventListener('click', async event => {
        const row = event.target.closest('[data-pick]')
        if (!row) return
        closeSheet()
        try { S.pc.settings = await S.remote.request('chat.settings', { id: top().params.id, effort: row.dataset.pick }); paintChips() } catch (error) { toast(error.message, true) }
      })
    })
  }

  async function showTasks() {
    let tasks = []
    try { tasks = await S.remote.request('tasks.get', { id: top().params.id }) } catch (error) { toast(error.message, true); return }
    const body = tasks.length
      ? tasks.map(task => '<div class="opt"><i class="dot ' + (task.status === 'done' ? 'on' : (task.status === 'doing' || task.status === 'in_progress' ? 'work' : '')) + '"></i><span>' + esc(task.title) + (task.preview ? '<small>' + esc(task.preview) + '</small>' : '') + '</span></div>').join('')
      : '<div class="empty"><b>' + esc(t('Задач пока нет')) + '</b></div>'
    openSheet(t('Задачи'), body)
  }

  async function showShot() {
    toast(t('Запрашиваю снимок…'))
    try {
      const answer = await S.remote.request('chat.shot', { id: top().params.id }, 30000)
      if (answer && answer.image) lightbox(answer.image); else toast(t('На компьютере нет открытой страницы для снимка'), true)
    } catch (error) { toast(error.message, true) }
  }
  function lightbox(src) {
    const node = doc.createElement('div')
    node.className = 'lightbox'
    node.innerHTML = '<img alt="' + esc(t('Снимок')) + '">'
    node.firstChild.src = src
    node.addEventListener('click', () => node.remove())
    $('app').appendChild(node)
  }

  function chatMore() {
    const params = top().params
    openSheet(t('Чат'), params.kind === 'own'
      ? '<button class="opt" data-more="rename">' + icon('edit') + '<span>' + esc(t('Переименовать')) + '</span></button><button class="opt" data-more="delete">' + icon('close') + '<span>' + esc(t('Удалить чат')) + '</span></button>'
      : '<button class="opt" data-more="reload">' + icon('retry') + '<span>' + esc(t('Обновить')) + '</span></button>', wrap => {
      wrap.addEventListener('click', async event => {
        const row = event.target.closest('[data-more]')
        if (!row) return
        closeSheet()
        if (row.dataset.more === 'reload') loadPcChat()
        if (row.dataset.more === 'delete') { S.chats = S.chats.filter(chat => chat.id !== params.id); await saveChats(); pop() }
        if (row.dataset.more === 'rename') {
          const chat = ownChat(params.id)
          openSheet(t('Название'), '<div class="field"><input id="rename-in" autocomplete="off" value="' + esc(chat.title) + '"></div><div class="pad"><button class="btn primary block" data-act="rename-ok">' + esc(t('Сохранить')) + '</button></div>', w => {
            w.querySelector('[data-act="rename-ok"]').addEventListener('click', async () => { chat.title = $('rename-in').value.trim() || chat.title; await saveChats(); closeSheet(); paint('') })
          })
        }
      })
    })
  }

  // ─── действия ──────────────────────────────────────────────────────────────
  function bindActions(scope) {
    scope.addEventListener('click', async event => {
      const target = event.target.closest('[data-act]')
      if (!target || target.closest('.sheet')) return
      const act = target.dataset.act
      const id = target.dataset.id
      if (act === 'back') pop()
      else if (act === 'settings') go('settings')
      else if (act === 'new-chat') newOwnChat()
      else if (act === 'pair') go('pair')
      else if (act === 'pair-go') doPair()
      else if (act === 'open') go('chat', { kind: target.dataset.kind, id })
      else if (act === 'add-provider') go('provider', {})
      else if (act === 'provider') go('provider', { id })
      else if (act === 'provider-save') saveProvider(id)
      else if (act === 'provider-del') { S.settings.providers = S.settings.providers.filter(item => item.id !== id); await saveSettings(); pop() }
      else if (act === 'forget') { await S.remote.forget(); paint('') }
      else if (act === 'set-lang') { S.settings.lang = target.dataset.value; setLang(S.settings.lang); await saveSettings(); paint('') }
      else if (act === 'set-theme') { S.settings.theme = target.dataset.value; applyTheme(); await saveSettings(); paint('') }
      else if (act === 'send') sendMessage()
      else if (act === 'stop') stopRun()
      else if (act === 'chat-more') chatMore()
      else if (act === 'model-own') pickModel('own')
      else if (act === 'model-pc') pickModel('pc')
      else if (act === 'effort-pc') pickEffort()
      else if (act === 'tasks') showTasks()
      else if (act === 'shot') showShot()
      else if (act === 'retry-pc') loadPcChat()
      else if (act === 'ask-next') { if (S.pc) { const total = askItems().length; S.pc.askIdx = (S.pc.askIdx || 0) + 1; if (S.pc.askIdx >= total) S.pc.askIdx = 0; paintAsks() } }
      else if (act === 'approve') answerApproval(id, true, false)
      else if (act === 'reject') answerApproval(id, false, false)
      else if (act === 'answer') {
        try { await S.remote.request('question.answer', { id, answer: target.dataset.label }); await S.remote.refreshPending() } catch (error) { toast(error.message, true) }
        paintAsks()
      }
    })
    const notify = scope.querySelector('[data-act="toggle-notify"]')
    if (notify) notify.addEventListener('change', async () => { S.settings.notify = notify.checked; await saveSettings() })
  }

  // ─── уведомления и системные события ───────────────────────────────────────
  async function notifyAsk(items) {
    if (!S.settings.notify || !items.length) return
    const plugin = cap().LocalNotifications
    if (!plugin || !doc.hidden) return
    try {
      const granted = await plugin.checkPermissions()
      if (granted.display !== 'granted') { const asked = await plugin.requestPermissions(); if (asked.display !== 'granted') return }
      const item = items[0]
      await plugin.schedule({ notifications: [{ id: Math.floor(Math.random() * 2e9), title: item.question ? t('Агент задаёт вопрос') : t('Агент ждёт разрешения'), body: String(item.question || item.summary || '').slice(0, 140) }] })
    } catch { /* уведомления не обязательны */ }
  }

  function wireRemote() {
    S.remote.on('status', () => {
      const name = top() && top().name
      if (name === 'home') fillHome()
      if (name === 'settings') paint('')
      if (name === 'chat' && top().params.kind === 'pc' && S.remote.state.status === 'online') loadPcChat()
      if (name === 'chat' && top().params.kind === 'pc' && S.remote.state.status !== 'online' && S.pc && !S.pc.error) { S.pc.error = t('Компьютер недоступен. Запустите onlyone на ПК, чат откроется сам.'); paintMessages() }
    })
    S.remote.on('chats', () => { if (top() && top().name === 'home') fillHome() })
    S.remote.on('chat-changed', data => { if (top() && top().name === 'chat' && top().params.kind === 'pc' && data.id === top().params.id) schedulePcReload() })
    S.remote.on('pending', info => { paintAsks(); notifyAsk(info.fresh) })
  }

  function wireNative() {
    const plugins = cap()
    if (plugins.App) {
      plugins.App.addListener('backButton', () => { if ($('sheet-root')) closeSheet(); else if (!pop()) plugins.App.exitApp() })
      plugins.App.addListener('appUrlOpen', event => handleLink(event.url))
      plugins.App.getLaunchUrl().then(result => { if (result && result.url) handleLink(result.url) }).catch(() => {})
    }
    doc.addEventListener('visibilitychange', () => {
      if (doc.hidden) return
      if (S.remote.state.paired) { S.remote.connect(); S.remote.refreshChats().catch(() => {}); S.remote.refreshPending().catch(() => {}) }
      if (top() && top().name === 'chat' && top().params.kind === 'pc') loadPcChat()
    })
  }

  // onlyone://pair?code=ABCDE-FGHJK&relay=wss%3A%2F%2F…
  function handleLink(url) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'onlyone:' || parsed.hostname !== 'pair') return
      const code = parsed.searchParams.get('code') || ''
      const relay = parsed.searchParams.get('relay') || ''
      if (relay && !/^wss:\/\//i.test(relay) && !/^ws:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2)/i.test(relay)) return
      S.stack = [{ name: 'home', params: {} }]
      go('pair', { code, relay })
    } catch { /* чужая ссылка */ }
  }

  // ─── запуск ────────────────────────────────────────────────────────────────
  async function start() {
    Object.assign(S.settings, await Store.get('settings', {}))
    S.chats = await Store.get('chats', [])
    setLang(S.settings.lang)
    applyTheme()
    S.remote = root.OnlyoneRemoteClient.create({ store: Store })
    await S.remote.load()
    wireRemote()
    wireNative()
    S.remote.connect()
    root.__onlyone = { S, go, pop, paint, handleLink, toast }
    replaceStack('home')
    doc.documentElement.dataset.appReady = '1'
  }

  root.OnlyoneApp = { start }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => start()); else start()
})(window)
