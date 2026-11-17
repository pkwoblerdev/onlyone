/* Встроенный браузер в панели превью.
 *
 * Обычный браузер, а не макет сайта: вкладки, адресная строка (и адрес, и поиск),
 * назад / вперёд / обновить, прогресс загрузки, понятные ошибки. Открывает и сайты, и
 * localhost — запущенный у себя проект можно смотреть тут же, рядом с чатом.
 *
 * Страницы идут в <webview>: у него нет Node и preload, а ограды (свой раздел сессии,
 * песочница, только http(s), никаких разрешений сайтам) ставит главный процесс при
 * каждой вставке (src/main/panel-browser.js). Здесь — только интерфейс. Из страницы
 * окно не читает ничего: ни содержимого, ни сообщений.
 *
 * Модуль живёт внутри панели артефактов (aside#artifactPanel): у панели два режима,
 * data-mode="artifact" (результат агента) и "browser". Всё, что касается хозяйской
 * панели (занять место в чате, закрыть, переключить режим), приходит через `deps`.
 */
(function (root) {
  'use strict'

  const PARTITION = 'persist:onlyone-browser'

  function create (deps) {
    const { $, t, document, electronAPI, model } = deps
    const tabs = model.createTabs({ max: 8 })
    const views = new Map()     // id вкладки → элемент webview
    const ready = new Set()     // у каких webview уже был dom-ready (до него методы бросают)
    let wired = false
    let draftTab = null   // вкладка, чей адрес набран и ещё не отправлен
    let zoomFactor = 1     // масштаб страниц панели (panel-adjust.js); у каждой новой вкладки тот же

    // Наблюдатель вкладки (tab-watch.js): страница изменилась — модель просыпается сразу.
    const injectNow = (id, code) => {
      const view = views.get(id)
      if (!view || !ready.has(id)) return
      try { view.executeJavaScript(code) } catch { /* вставится при следующей загрузке */ }
    }
    const tabWatch = root.OnlyoneTabWatch && deps.sendToChat ? root.OnlyoneTabWatch.create({
      t, canWake: deps.canWake, inject: injectNow,
      send: (text, options) => deps.sendToChat(text, options),
      screenshot: async id => {
        const view = views.get(id)
        if (!view) return null
        const image = await view.capturePage()
        const saved = await electronAPI.savePageScreenshot(image.toDataURL())
        return { path: saved.path, attachment: deps.acceptsImages && deps.acceptsImages() ? saved.attachment : null }
      }
    }) : null

    const panel = () => $('artifactPanel')
    const isBrowserMode = () => Boolean(panel() && !panel().hidden && panel().dataset.mode === 'browser')
    const activeTab = () => { const id = tabs.active(); return id ? tabs.get(id) : null }

    // ─── страницы ───────────────────────────────────────────────────────────────
    function makeView (id, url) {
      const view = document.createElement('webview')
      view.className = 'browser-view'
      view.setAttribute('partition', PARTITION)
      // Без allowpopups страница не может даже попросить новое окно. Окно ей не открывается
      // никогда: главный процесс отвечает на просьбу отказом и передаёт адрес сюда (вкладка).
      view.setAttribute('allowpopups', '')
      view.setAttribute('src', url)
      view.dataset.tab = id
      const sync = () => refreshNav(id)

      view.addEventListener('dom-ready', () => { ready.add(id); try { view.setZoomFactor(zoomFactor) } catch { /* вкладка уходит */ } sync(); if (tabWatch && tabWatch.active(id)) injectNow(id, root.OnlyoneTabWatch.OBSERVER) })
      view.addEventListener('console-message', event => {
        const change = tabWatch && root.OnlyoneTabWatch.parseChange(event.message)
        if (!change) return
        const tab = tabs.get(id) || {}
        tabWatch.onChange(id, change, { url: tab.url || '', title: tab.title || '' })
      })
      view.addEventListener('did-start-loading', () => { tabs.patch(id, { loading: true }); render() })
      view.addEventListener('did-stop-loading', () => { tabs.patch(id, { loading: false }); sync(); render() })
      view.addEventListener('did-navigate', event => {
        tabs.patch(id, { url: event.url || '', error: '' })
        sync(); render()
      })
      view.addEventListener('did-navigate-in-page', event => {
        if (event.isMainFrame !== false) tabs.patch(id, { url: event.url || '' })
        sync(); render()
      })
      view.addEventListener('page-title-updated', event => { tabs.patch(id, { title: String(event.title || '') }); render() })
      view.addEventListener('did-fail-load', event => {
        if (event.isMainFrame === false) return
        const text = model.describeLoadError(event.errorCode)
        if (!text) return
        tabs.patch(id, { loading: false, error: text, url: event.validatedURL || tabs.get(id)?.url || '' })
        render()
      })
      view.addEventListener('render-process-gone', () => {
        tabs.patch(id, { loading: false, error: t('Страница остановилась: нажмите «Повторить».') })
        render()
      })
      view.addEventListener('crashed', () => { tabs.patch(id, { loading: false, error: t('Страница остановилась: нажмите «Повторить».') }); render() })
      $('browserViews').appendChild(view)
      views.set(id, view)
      return view
    }

    function refreshNav (id) {
      const view = views.get(id)
      if (!view || !ready.has(id)) return
      try {
        // canGoBack()/goBack() у <webview> в Electron 44 молча не работают (история есть, а
        // ответ «нельзя»): ходим по истории смещением.
        tabs.patch(id, { canBack: view.canGoToOffset(-1), canForward: view.canGoToOffset(1) })
      } catch { /* webview ещё не прикреплён или уже закрыт */ }
      render()
    }

    function go (id, address) {
      const url = String(address || '')
      tabs.patch(id, { url, error: '', loading: true, title: '' })
      let view = views.get(id)
      if (!view) {
        makeView(id, url)
      } else {
        // Через src, а не loadURL: loadURL возвращает обещание, которое при отказе сайта
        // (закрытый порт) главный процесс печатает как необработанную ошибку. Тот же адрес —
        // обновление, иначе src не сдвинется.
        let same = false
        try { same = ready.has(id) && view.getURL() === url } catch { /* ещё не готов */ }
        if (same) { try { view.reload() } catch { /* ещё не готов */ } } else view.setAttribute('src', url)
      }
      render()
    }

    function navigateFromInput (text) {
      const parsed = model.normalizeAddress(text)
      if (!parsed) return
      if (parsed.kind === 'blocked') {
        draftTab = null
        flash(t('Такой адрес открыть нельзя: поддерживаются http и https.'))
        return
      }
      let id = tabs.active()
      if (!id) id = tabs.add('')
      go(id, parsed.url)
      // Адрес принят: строка снова показывает адрес страницы, а не то, что набрали.
      draftTab = null
      $('browserAddress')?.blur()
      render()
    }

    // ─── вкладки ────────────────────────────────────────────────────────────────
    function newTab (address) {
      const id = tabs.add('')
      if (!id) { flash(t('Вкладок уже восемь: закройте лишние.')); return null }
      if (address) go(id, address)
      else render()
      if (!address) $('browserAddress')?.focus()
      return id
    }

    function closeTab (id) {
      const view = views.get(id)
      if (view) { view.remove(); views.delete(id); ready.delete(id) }
      if (tabWatch && tabWatch.active(id)) { electronAPI.watchOrigin?.((tabs.get(id) || {}).url, false); tabWatch.stop(id) }
      tabs.close(id)
      render()
    }

    // ─── отрисовка ──────────────────────────────────────────────────────────────
    function flash (text) {
      const box = $('artifactNotice')
      if (!box) return
      box.hidden = false
      box.textContent = text
      clearTimeout(flash.timer)
      flash.timer = setTimeout(() => { box.hidden = true }, 3500)
    }

    function renderTabs () {
      const host = $('browserTabs')
      if (!host) return
      const active = tabs.active()
      host.textContent = ''
      for (const tab of tabs.list()) {
        const row = document.createElement('div')
        row.className = 'browser-tab' + (tab.id === active ? ' active' : '') + (tabWatch && tabWatch.active(tab.id) ? ' is-watched' : '')
        row.setAttribute('role', 'presentation')
        const pick = document.createElement('button')
        pick.type = 'button'
        pick.className = 'browser-tab-pick'
        pick.setAttribute('role', 'tab')
        pick.setAttribute('aria-selected', String(tab.id === active))
        pick.dataset.tab = tab.id
        const label = tab.title || tab.url ? model.titleOf(tab) : t('Новая вкладка')
        pick.setAttribute('data-tooltip', label)
        const dot = document.createElement('span')
        dot.className = 'browser-tab-dot' + (tab.loading ? ' loading' : '')
        dot.setAttribute('aria-hidden', 'true')
        const name = document.createElement('span')
        name.className = 'browser-tab-title'
        name.textContent = label
        pick.append(dot, name)
        pick.addEventListener('click', () => { tabs.select(tab.id); render() })
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'browser-tab-close'
        close.setAttribute('aria-label', t('Закрыть вкладку'))
        close.setAttribute('data-tooltip', t('Закрыть вкладку'))
        close.innerHTML = '<svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>'
        close.addEventListener('click', event => { event.stopPropagation(); closeTab(tab.id) })
        row.append(pick, close)
        host.appendChild(row)
      }
    }

    function render () {
      if (!$('browserPane')) return
      renderTabs()
      const tab = activeTab()
      for (const [id, view] of views) view.hidden = !(tab && id === tab.id)
      const hasPage = Boolean(tab && views.get(tab.id))
      // Заставка «Новая вкладка» — пока у вкладки нет ни страницы, ни адреса.
      $('browserEmpty').hidden = Boolean(tab && (hasPage || tab.url))
      const error = Boolean(tab && tab.error)
      $('browserError').hidden = !error
      if (error) {
        $('browserErrorTitle').textContent = t('Не удалось открыть') + (tab.url ? ' ' + model.displayAddress(tab.url) : '')
        $('browserErrorText').textContent = t(tab.error)
      }
      $('browserBack').disabled = !(tab && tab.canBack)
      $('browserForward').disabled = !(tab && tab.canForward)
      $('browserReload').disabled = !(tab && hasPage)
      const reload = $('browserReload')
      if (reload) {
        const loading = Boolean(tab && tab.loading)
        reload.dataset.mode = loading ? 'stop' : 'reload'
        reload.setAttribute('aria-label', loading ? t('Остановить') : t('Обновить'))
        reload.setAttribute('data-tooltip', loading ? t('Остановить загрузку') : t('Обновить (Ctrl+R)'))
      }
      const bar = $('browserProgress')
      if (bar) bar.hidden = !(tab && tab.loading)
      const input = $('browserAddress')
      // Набранное, но не отправленное остаётся в строке, пока человек кликает по панели: перерисовка стирала его при потере фокуса
      const drafting = Boolean(tab && draftTab === tab.id)
      if (input && document.activeElement !== input && !drafting) input.value = tab ? model.displayAddress(tab.url) : ''
      const pane = $('browserPane')
      if (pane) pane.dataset.hasTabs = String(tabs.list().length > 0)
      const button = $('openBrowserBtn')
      if (button) button.setAttribute('aria-pressed', String(isBrowserMode()))
    }

    // ─── меню правой кнопки ─────────────────────────────────────────────────────
    function contextMenu (info) {
      const tab = activeTab()
      const view = tab && views.get(tab.id)
      if (!view || !isBrowserMode() || typeof deps.openMenu !== 'function') return
      const box = view.getBoundingClientRect()
      const guest = fn => () => { try { fn(view) } catch { /* страница уже закрыта */ } }
      const copyText = text => () => { try { navigator.clipboard.writeText(text) } catch { /* буфер недоступен */ } }
      const items = []
      if (info.linkURL) {
        items.push({ label: t('Открыть ссылку в новой вкладке'), onPick: () => newTab(info.linkURL) })
        items.push({ label: t('Копировать адрес ссылки'), onPick: copyText(info.linkURL) })
        items.push({ separator: true })
      }
      if (info.isEditable) {
        items.push({ label: t('Вырезать'), disabled: !info.selectionText, onPick: guest(v => v.cut()) })
        items.push({ label: t('Копировать'), disabled: !info.selectionText, onPick: guest(v => v.copy()) })
        items.push({ label: t('Вставить'), onPick: guest(v => v.paste()) })
        items.push({ label: t('Выделить всё'), onPick: guest(v => v.selectAll()) })
      } else {
        if (info.selectionText) items.push({ label: t('Копировать'), onPick: guest(v => v.copy()) })
        items.push({ label: t('Назад'), disabled: !tab.canBack, onPick: () => $('browserBack').click() })
        items.push({ label: t('Вперёд'), disabled: !tab.canForward, onPick: () => $('browserForward').click() })
        items.push({ label: t('Обновить'), onPick: () => $('browserReload').click() })
        if (info.pageURL) items.push({ label: t('Копировать адрес страницы'), onPick: copyText(info.pageURL) })
        items.push({ label: t('Выделить всё'), onPick: guest(v => v.selectAll()) })
      }
      deps.openMenu(box.left + info.x, box.top + info.y, items)
    }

    // ─── панель ─────────────────────────────────────────────────────────────────
    function open (address) {
      const host = panel()
      if (!host) return
      if (host.hidden) deps.rememberFocus?.()
      host.hidden = false
      deps.space(true)
      deps.setMode('browser')
      if (address) newTabOrGo(address)
      else if (!tabs.list().length) newTab('')
      render()
      if (!address) $('browserAddress')?.focus()
    }

    // Адрес из чата или из живого вида агента: пустая вкладка занимается, иначе — новая.
    function newTabOrGo (address) {
      const parsed = model.normalizeAddress(address)
      if (!parsed || parsed.kind === 'blocked') return
      const current = activeTab()
      if (current && !current.url && !views.get(current.id)) go(current.id, parsed.url)
      else newTab(parsed.url)
    }

    function toggle () {
      if (isBrowserMode()) deps.closePanel()
      else open()
      render()
    }

    function bind () {
      if (wired || !$('browserPane')) return
      wired = true
      $('openBrowserBtn')?.addEventListener('click', toggle)
      $('browserNewTab')?.addEventListener('click', () => newTab(''))
      $('browserClose')?.addEventListener('click', () => { deps.closePanel(); render() })
      // Развернуть на весь чат — та же кнопка хозяйской панели, у браузера она своя только видом.
      $('browserExpand')?.addEventListener('click', () => {
        $('artifactExpand')?.click()
        const expanded = Boolean($('chatView')?.classList.contains('artifact-expanded'))
        $('browserExpand').setAttribute('aria-pressed', String(expanded))
        $('browserExpand').setAttribute('data-tooltip', t(expanded ? 'Вернуть панель к обычной ширине' : 'Развернуть панель на весь чат'))
      })
      $('browserBack')?.addEventListener('click', () => { const v = views.get(tabs.active()); try { v && v.goToOffset(-1) } catch { /* ещё не готов */ } })
      $('browserForward')?.addEventListener('click', () => { const v = views.get(tabs.active()); try { v && v.goToOffset(1) } catch { /* ещё не готов */ } })
      $('browserReload')?.addEventListener('click', () => {
        const tab = activeTab()
        const view = tab && views.get(tab.id)
        if (!view) return
        try { tab.loading ? view.stop() : view.reload() } catch { /* ещё не готов */ }
      })
      // Кнопка живая всегда: открывает страницу вкладки, а на пустой вкладке — набранный адрес
      $('browserExternal')?.addEventListener('click', () => {
        const tab = activeTab()
        if (tab && /^https?:/i.test(tab.url || '')) { electronAPI.openBrowserExternal?.(tab.url); return }
        const typed = model.normalizeAddress($('browserAddress')?.value)
        if (typed && typed.kind === 'url') electronAPI.openBrowserExternal?.(typed.url)
        else $('browserAddress')?.focus()
      })
      $('browserForm')?.addEventListener('submit', event => {
        event.preventDefault()
        navigateFromInput($('browserAddress').value)
      })
      $('browserAddress')?.addEventListener('focus', () => { $('browserAddress').select() })
      $('browserAddress')?.addEventListener('blur', () => render())
      $('browserAddress')?.addEventListener('input', () => { const tab = activeTab(); draftTab = tab ? tab.id : null })
      $('browserErrorRetry')?.addEventListener('click', () => {
        const tab = activeTab()
        if (tab && tab.url) go(tab.id, tab.url)
      })
      // Быстрые адреса рисуются здесь, а не в разметке. «Найти запущенный проект» спрашивает
      // главный процесс, какие из типичных портов у вас уже слушают, и показывает только их;
      // если ничего не найдено — три привычных адреса и честная подсказка.
      const quick = $('browserQuick')
      const drawQuick = (ports, searched) => {
        if (!quick) return
        quick.replaceChildren()
        const addresses = ports.length ? ports.map(port => 'localhost:' + port) : ['localhost:3000', 'localhost:5173', 'localhost:8080']
        const hint = $('browserQuickHint')
        if (hint) hint.textContent = ports.length ? t('Запущено у вас:') : (searched ? t('Запущенных проектов не найдено. Запустите проект и нажмите «Найти» ещё раз.') : '')
        for (const address of addresses) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'browser-quick-btn' + (ports.length ? ' is-found' : '')
          button.textContent = address
          button.addEventListener('click', () => navigateFromInput(address))
          quick.appendChild(button)
        }
      }
      const detect = async () => {
        const button = $('browserDetect')
        if (button) { button.disabled = true; button.dataset.busy = '1' }
        let ports = []
        try { ports = (await electronAPI.detectDevServers?.())?.ports || [] } catch { /* без поиска остаются привычные адреса */ }
        drawQuick(ports, true)
        if (button) { button.disabled = false; delete button.dataset.busy }
      }
      drawQuick([], false)
      $('browserDetect')?.addEventListener('click', detect)
      if (quick) detect()
      $('modeBrowser')?.addEventListener('click', () => open())
      document.addEventListener('keydown', event => {
        if (!isBrowserMode()) return
        const ctrl = event.ctrlKey || event.metaKey
        const key = String(event.key || '').toLowerCase()
        const inside = panel().contains(document.activeElement)
        if (ctrl && key === 'l') { event.preventDefault(); $('browserAddress')?.focus(); return }
        if (!inside) return
        if (ctrl && key === 't') { event.preventDefault(); newTab(''); return }
        if (ctrl && key === 'w') { event.preventDefault(); const id = tabs.active(); if (id) closeTab(id); return }
        if ((ctrl && key === 'r') || key === 'f5') { event.preventDefault(); $('browserReload')?.click(); return }
        if (event.altKey && key === 'arrowleft') { event.preventDefault(); $('browserBack')?.click(); return }
        if (event.altKey && key === 'arrowright') { event.preventDefault(); $('browserForward')?.click() }
      }, true)
      // Правая кнопка в странице: пункты по тому, что под курсором (ссылка, выделение, поле).
      electronAPI.onBrowserContextMenu?.(info => contextMenu(info || {}))
      // Страница просит новую вкладку (target=_blank, window.open): окно приложения не
      // открывается, вкладку заводит панель.
      electronAPI.onBrowserOpenTab?.(payload => {
        const address = payload && payload.url
        if (!address) return
        open()
        newTab(address)
      })
      render()
    }

    // ─── слежение за вкладкой по просьбе модели (tab-watch.js) ───────────────────
    // Модель вызывает watch_page: окно находит или открывает вкладку, ставит наблюдателя и сразу
    // отвечает. Слежение — фоновая задача чата (видна в «Задачи»), пробуждение идёт в тот же чат.
    async function watchRequest (request) {
      const args = request.args || {}
      const chatId = deps.chatIdOfRequest ? deps.chatIdOfRequest(request.requestId) : ''
      if (!tabWatch) return { success: false, error: 'Наблюдатель вкладок недоступен.' }
      if (request.action === 'stop') {
        const count = args.watch_id ? (tabWatch.stopById(String(args.watch_id)) ? 1 : 0) : tabWatch.stopChat(chatId)
        return { success: true, stopped: count }
      }
      const wanted = args.url ? model.normalizeAddress(String(args.url)) : null
      if (args.url && (!wanted || wanted.kind === 'blocked')) return { success: false, error: 'Нужен адрес http или https.' }
      open()
      let id = null
      if (wanted) {
        const same = tabs.list().find(tab => tab.url === wanted.url)
        id = same ? same.id : newTab(wanted.url)
      } else {
        const current = activeTab()
        id = current && current.url ? current.id : null
      }
      if (!id) return { success: false, error: 'Нет вкладки для слежения: укажи url или открой страницу в браузере.' }
      tabs.select(id)
      render()
      const stop = Date.now() + 8000
      while (Date.now() < stop && !ready.has(id)) await new Promise(resolve => setTimeout(resolve, 100))
      if (!ready.has(id)) return { success: false, error: 'Страница не загрузилась за 8 секунд: слежение не начато.' }
      const tab = tabs.get(id) || {}
      const watch = tabWatch.start(id, {
        chatId, url: tab.url, instruction: args.then,
        mode: args.wake_on === 'text_appears' ? 'text' : 'any', pattern: args.text,
        screenshot: args.screenshot !== false, gapMs: (Number(args.min_seconds) || 10) * 1000
      })
      electronAPI.watchOrigin?.(tab.url, true)
      render()
      return { success: true, watch_id: watch.id, url: tab.url, wake_on: watch.mode === 'text' ? 'text_appears' : 'any_change',
        note: 'Слежение идёт в фоне. Можешь закончить ход: при изменении страницы в этот чат придёт сообщение с поручением.' }
    }

    // Агент открывает страницу человеку: панель «Браузер» показывается, адрес грузится в ТЕКУЩЕЙ вкладке
    // (новая заводится, только если вкладок нет), и главному процессу уходит id страницы вкладки.
    async function openForAgent (url) {
      const parsed = model.normalizeAddress(String(url || ''))
      if (!parsed || parsed.kind === 'blocked') return { success: false, error: 'Нужен адрес http или https.' }
      open()
      let id = tabs.active()
      if (!id) id = newTab('')
      if (!id) return { success: false, error: 'Нет места для вкладки.' }
      tabs.select(id)
      go(id, parsed.url)
      render()
      const view = views.get(id)
      if (!view) return { success: false, error: 'Вкладка не открылась.' }
      await new Promise(resolve => {
        const done = () => { view.removeEventListener('did-stop-loading', done); resolve() }
        view.addEventListener('did-stop-loading', done)
        setTimeout(done, 15000)
      })
      if (!ready.has(id)) return { success: false, error: 'Страница не загрузилась.' }
      return { success: true, guestId: view.getWebContentsId(), url: (tabs.get(id) || {}).url || parsed.url }
    }

    // Список и остановка для панели «Задачи».
    root.OnlyonePageWatches = {
      list: chatId => (tabWatch ? tabWatch.list(chatId) : []),
      stop: id => { const watch = tabWatch && tabWatch.list().find(item => item.id === id); if (watch) electronAPI.watchOrigin?.(watch.url, false); return tabWatch ? tabWatch.stopById(id) : false },
      subscribe: fn => { if (tabWatch) tabWatch.subscribe(fn) }
    }

    // Вкладки со своими страницами (localhost, локальная сеть) перезагружаются после правки файла.
    function reloadLocal () {
      for (const [id, view] of views) {
        const url = (tabs.get(id) || {}).url || ''
        let host = ''
        try { host = new URL(url).hostname } catch { /* не адрес */ }
        const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost') ||
          host.startsWith('192.168.') || host.startsWith('10.')
        if (!ready.has(id) || !local) continue
        try { view.reload() } catch { /* вкладка ещё не готова — перезагрузится сама при загрузке */ }
      }
    }

    // Снимок видимой вкладки для телефона: уменьшенный, чтобы уйти по сети быстро.
    async function shot () {
      const id = tabs.active()
      const view = id && views.get(id)
      if (!view || !ready.has(id)) return null
      const image = await view.capturePage()
      let small = image
      try { const size = image.getSize(); if (size.width > 900) small = image.resize({ width: 900 }) } catch { /* без уменьшения */ }
      return small.toDataURL()
    }

    // Масштаб применяется ко всем открытым вкладкам и запоминается для новых.
    function setZoom (factor) {
      zoomFactor = Number(factor) > 0 ? Number(factor) : 1
      for (const [id, view] of views) { if (ready.has(id)) { try { view.setZoomFactor(zoomFactor) } catch { /* ещё не готов */ } } }
    }
    const zoomOf = () => zoomFactor

    return Object.freeze({ bind, open, toggle, newTab, render, isBrowserMode, tabs, reloadLocal, watchRequest, openForAgent, shot, setZoom, zoomOf })
  }

  // Проводка с хозяйской панелью (панель артефактов): место в чате, закрытие, режим.
  function mount (options) {
    const host = options.host
    const panel = create({
      $: options.$, t: options.t, document: options.document, electronAPI: options.electronAPI, model: options.model,
      sendToChat: options.sendToChatWithFiles, canWake: options.canWake, acceptsImages: options.acceptsImages,
      chatIdOfRequest: options.chatIdOfRequest,
      space: on => host.artifactSpace(on),
      setMode: mode => host.setPanelMode(mode),
      closePanel: () => host.closeArtifactPanel(),
      openMenu: options.openMenu,
      rememberFocus: () => {}
    })
    // Просьбы модели следить за вкладкой и обновление вкладок после записи файла проектом.
    options.electronAPI.onWatchTabRequest?.(async request => {
      let result
      try { result = await panel.watchRequest(request) } catch (error) { result = { success: false, error: String((error && error.message) || error) } }
      options.electronAPI.watchTabReply?.(request.id, result)
    })
    options.electronAPI.onBrowserPanelOpen?.(async request => {
      let result
      try { result = await panel.openForAgent(request.url) } catch (error) { result = { success: false, error: String((error && error.message) || error) } }
      options.electronAPI.watchTabReply?.(request.id, result)
    })
    let reloadTimer = null
    options.electronAPI.onWorkspaceFileChanged?.(() => {
      clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => panel.reloadLocal(), 450)
    })
    panel.bind()
    // Регулировка панели: ширина и масштаб страниц.
    if (root.OnlyonePanelAdjust) {
      const adjust = root.OnlyonePanelAdjust.create({ $: options.$, document: options.document, t: options.t, onZoom: factor => panel.setZoom(factor) })
      adjust.bind()
      panel.setZoom(adjust.zoom())
    }
    return panel
  }

  const api = Object.freeze({ create, mount, PARTITION })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneBrowserPanel = api
})(typeof window === 'object' ? window : globalThis)
