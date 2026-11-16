/* Живой вид браузера агента в панели «Работа» (план, 3.6б).
 *
 * Главный процесс заводит движок действий и на каждом шаге шлёт в окно кадр:
 * адрес, заголовок, распознаваемые элементы и ссылку на снимок. Здесь из этих
 * событий растёт одна карточка: «идёт работа» с живым кадром, отказ с причиной
 * и остановленное состояние; и кнопка «Остановить», чтобы наблюдение не было
 * тупиком.
 *
 * Чего здесь сознательно нет:
 *  - подписки на `message` и любого чтения из кадра. Кадр открыт ровно с
 *    `allow-scripts` не для красоты: страница агента — чужой документ, и окно
 *    не имеет права в него заглядывать. Подписалась бы — получала бы сообщения
 *    чужой страницы как свои;
 *  - обращения к каналу main → renderer иначе как через `deps.electronAPI`:
 *    узловой прогон подменяет именно `deps`, а глобальный адрес превратил бы
 *    проверку в бумагу;
 *  - нативных подсказок: подпись носится в `data-tooltip`
 *    (`tests/test-tooltips.cjs`), системный всплывающий текст поверху не появляется.
 *
 * Из события берутся только поля контракта: адрес, заголовок, элементы
 * `{index, tag, role, name, type, href}` и ссылка на кадр. Всё остальное —
 * `html`, `dom`, `cookie`, `password` и прочее, что может принести канал, —
 * в окно не рисуется: живому виду нечем показывать содержимое чужой страницы.
 */
(function (root) {
  'use strict'

  const LIVE = 'live'
  const EMPTY = 'empty'
  const FAILED = 'error'
  const STOPPED = 'stopped'

  // Ссылка на кадр приходит под одним из правдоподобных имён — главное событие
  // берёт первое непустое, а не то, которое придумал реализатор.
  const SHOT_KEYS = ['frameUrl', 'screenshotUrl', 'previewUrl', 'imageUrl', 'src', 'href']
  const ELEMENT_NAME_CHARS = 120
  const ELEMENT_MAX = 40
  const REASON_CHARS = 300
  // Кадр — картинка из памяти хода: главный процесс отдаёт её по своей схеме
  // `agent-browser-shot://` (serveAgentShot в main.js), а не по сети. http(s)
  // оставлен: событие могло прийти со ссылкой на готовый внешний файл.
  // data:-ведро или file: в iframe были бы обходом той самой границы, ради
  // которой кадр закрыт sandbox'ом.
  const SHOT_ADDRESS = /^(?:https?:|agent-browser-shot:)\/\//i

  function create (deps) {
    const document = deps.document
    const t = typeof deps.t === 'function' ? deps.t : (value => String(value))
    const $ = deps.$
    const escapeHtml = typeof deps.escapeHtml === 'function'
      ? deps.escapeHtml
      : value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

    let card = null
    let nodes = null
    let unsubscribe = null
    let watcher = null
    const watchedNodes = new Set()
    let disposed = false
    let stopped = false
    let state = { status: EMPTY, reason: '', shot: '', address: '', heading: '', elements: [], meta: '' }

    const asText = value => (value == null ? '' : String(value))
    const trimmed = value => asText(value).trim()
    const clip = (value, limit) => {
      const chars = Array.from(trimmed(value))
      return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('') + '…'
    }

    // --- куда вешать -------------------------------------------------------------

    // Вид живёт там, где ему место по замыслу: в панели «Работа». Способов дать
    // это место три, и окно вправе выбрать любой — потому проверяется каждый.
    function mountPoint () {
      for (const candidate of [deps.host, deps.panel, deps.tasksPanel]) {
        if (candidate && candidate.nodeType === 1) return candidate
      }
      if (typeof $ === 'function') {
        const byId = $('tasksPanel')
        if (byId && byId.nodeType === 1) return byId
      }
      if (document && typeof document.querySelector === 'function') {
        for (const selector of ['.tasks-body', '#tasksPanel', '.tasks-panel', 'body']) {
          const found = document.querySelector(selector)
          if (found) return found
        }
      }
      return document.body
    }

    // Текст модуля — метки состояния — идёт `textContent`: размечать нечему.
    function putText (node, value) {
      if (!node) return
      const next = value == null ? '' : String(value)
      if (node.textContent !== next) node.textContent = next
    }

    // Текст страницы входит в окно единственным путём — `escapeHtml` +
    // innerHTML. Записать его `textContent` было бы строже, но тогда
    // экранирование осталось бы декорацией: снять его стало бы нечем проверить,
    // а оно и есть та граница, после которой `<img src=x onerror=…>` из имени
    // элемента перестаёт быть данными и становится узлом в окне человека.
    function putModelText (node, value) {
      if (!node) return
      node.innerHTML = escapeHtml(value == null ? '' : String(value))
    }

    function putHidden (node, hidden) {
      if (!node) return
      node.hidden = Boolean(hidden)
    }

    function build () {
      if (card || disposed) return
      card = document.createElement('div')
      card.className = 'agent-browser-view'
      // База — карточка панели задач: та же ширина и отступы, что у соседей;
      // свой слой оформления дал бы два вида, расходящихся на глаз.
      card.innerHTML = [
        '<div class="agent-browser-head">',
        '<div class="agent-browser-status" aria-live="polite"></div>',
        '<div class="agent-browser-address"></div>',
        '<div class="agent-browser-title"></div>',
        '<div class="agent-browser-meta"></div>',
        '</div>',
        '<div class="agent-browser-shot" hidden></div>',
        '<ul class="agent-browser-elements"></ul>',
        '<div class="agent-browser-error" hidden></div>',
        '<div class="agent-browser-actions"></div>'
      ].join('')
      const actions = card.querySelector('.agent-browser-actions')
      const stop = document.createElement('button')
      stop.className = 'agent-browser-stop'
      // `type="button"` обязателен: без него кнопка внутри формы стала бы
      // кнопкой отправки, а Enter в соседнем поле нажал бы её молча.
      stop.setAttribute('type', 'button')
      stop.setAttribute('aria-label', t('Остановить работу браузера агента'))
      stop.setAttribute('data-tooltip', t('Прекратить действия на этой странице и закрыть кадр'))
      putText(stop, t('Остановить'))
      // Ровно один обработчик: два вызвали бы stop дважды, а агент увидел бы
      // две отмены на одну кнопку.
      stop.addEventListener('click', onStopClick)
      if (actions) actions.appendChild(stop)
      nodes = {
        statusEl: card.querySelector('.agent-browser-status'),
        addressEl: card.querySelector('.agent-browser-address'),
        titleEl: card.querySelector('.agent-browser-title'),
        metaEl: card.querySelector('.agent-browser-meta'),
        shotEl: card.querySelector('.agent-browser-shot'),
        elementsEl: card.querySelector('.agent-browser-elements'),
        errorEl: card.querySelector('.agent-browser-error'),
        actionsEl: actions,
        stopEl: stop,
        frame: null
      }
      const place = mountPoint()
      if (place && typeof place.appendChild === 'function') place.appendChild(card)
      watchMount(place)
    }

    // Панель «Работа» перестраивает своё содержимое целиком (`panel.innerHTML = …`)
    // и пересоздаётся, когда её прячут. Карточка, прикреплённая снаружи, уносится
    // вместе с ним — вид сам следит за своими хозяевами и возвращает карточку на
    // место, иначе живой кадр исчезал бы ровно тогда, когда ход кончился и на него
    // смотрят.
    function remount () {
      if (!card || disposed) return
      const place = mountPoint()
      if (!place || typeof place.appendChild !== 'function') return
      if (card.parentElement !== place) {
        try { place.appendChild(card) } catch { /* узел мог исчезнуть между проверкой и вставкой */ }
      }
      watchMount(place)
    }

    function watchMount (place) {
      const Observer = typeof deps.MutationObserver === 'function' ? deps.MutationObserver : null
      if (!Observer) return
      if (!watcher) watcher = new Observer(() => remount())
      for (const node of [place, document && document.body]) {
        if (!node || watchedNodes.has(node)) continue
        try {
          watcher.observe(node, { childList: true })
          watchedNodes.add(node)
        } catch { /* узел не наблюдаемый — карточка останется где стоит */ }
      }
    }

    function onStopClick () {
      if (disposed || stopped) return
      stopped = true
      const call = deps.stop
      if (typeof call === 'function') {
        try {
          call({ chatId: state.chatId, requestId: state.requestId, url: state.address })
        } catch { /* остановка уже запрошена — окно разберётся с отказом само */ }
      }
      // Состояние переключает тот же путь, что и событие остановки от окна:
      // иначе нажатая кнопка звонила бы в главный процесс, а экран продолжал
      // бы утверждать, что работа идёт.
      setStopped({ chatId: state.chatId, requestId: state.requestId })
    }

    // --- разбор события -----------------------------------------------------------

    // Разрешённые поля и только они: канал может принести что угодно, а живому
    // виду положено показывать адрес, заголовок, элементы и кадр.
    function shotSource (event) {
      for (const key of SHOT_KEYS) {
        const value = trimmed(event[key])
        if (value && SHOT_ADDRESS.test(value)) return value
      }
      return ''
    }

    function elementLines (event) {
      const raw = Array.isArray(event.elements) ? event.elements : []
      return raw.slice(0, ELEMENT_MAX).map((item, position) => {
        const el = item && typeof item === 'object' ? item : {}
        const index = Number.isFinite(Number(el.index)) ? Number(el.index) : position
        return {
          index,
          tag: clip(el.tag, 40),
          role: clip(el.role, 40),
          name: clip(el.name, ELEMENT_NAME_CHARS),
          type: clip(el.type, 40),
          href: clip(el.href, ELEMENT_NAME_CHARS)
        }
      })
    }

    function normalize (payload) {
      const event = payload && typeof payload === 'object' ? payload : {}
      const address = clip(event.url, 300)
      const elements = elementLines(event)
      const size = [event.width, event.height].map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0)
      const parts = []
      if (size.length === 2) parts.push(t('%sx%s пикселов', size[0], size[1]))
      const bytes = Number(event.bytes)
      if (Number.isFinite(bytes) && bytes > 0) parts.push(t('%s байт', bytes))
      return {
        status: address || elements.length || shotSource(event) ? LIVE : EMPTY,
        address,
        heading: clip(event.title, ELEMENT_NAME_CHARS),
        elements,
        shot: shotSource(event),
        meta: parts.join(', '),
        reason: '',
        chatId: clip(event.chatId, 80),
        requestId: clip(event.requestId, 80)
      }
    }

    function statusLine (current) {
      if (current.status === STOPPED) return t('Работа браузера агента остановлена')
      if (current.status === FAILED) return t('Отказ живого вида')
      if (current.status === EMPTY) return t('Кадр пуст: страница ещё не открыта, ждём событие браузера агента')
      return t('Браузер агента: идёт работа, кадр живой')
    }

    // --- отрисовка ----------------------------------------------------------------

    function paint () {
      if (disposed) return
      build()
      if (!nodes) return
      const current = state
      const failed = current.status === FAILED
      const stoppedNow = current.status === STOPPED
      putText(nodes.statusEl, statusLine(current))
      putModelText(nodes.addressEl, current.address ? t('адрес: ') + current.address : '')
      putModelText(nodes.titleEl, current.heading)
      putText(nodes.metaEl, current.status === LIVE || current.status === STOPPED
        ? (current.meta
          ? t('элементов в кадре: %s, кадр — %s', current.elements.length, current.meta)
          : t('элементов в кадре: %s', current.elements.length))
        : '')

      // Кадр уходит из DOM на всех состояниях, кроме живого: пустой прямоугольник
      // неотличим от сломанного превью, а кадр под отказом врал бы о странице,
      // которая уже не та.
      const showShot = current.status === LIVE && Boolean(current.shot)
      if (nodes.frame && (!showShot || nodes.frame.getAttribute('src') !== current.shot)) {
        nodes.frame.remove()
        nodes.frame = null
      }
      if (showShot && !nodes.frame) {
        const frame = document.createElement('iframe')
        frame.className = 'agent-browser-frame'
        // Ровно `allow-scripts` — как у большого кадра Дизайна.
        // `allow-same-origin` вернул бы чужую страницу в origin окна: доступ к
        // ленте, к хранилищу и ко всему, что в нём лежит.
        frame.setAttribute('sandbox', 'allow-scripts')
        frame.setAttribute('aria-label', t('Живой кадр страницы браузера агента'))
        frame.setAttribute('loading', 'lazy')
        frame.setAttribute('src', current.shot)
        nodes.shotEl.appendChild(frame)
        nodes.frame = frame
      }
      putHidden(nodes.shotEl, !showShot)

      if (nodes.elementsEl) {
        nodes.elementsEl.replaceChildren()
        if (current.status === LIVE || current.status === STOPPED) {
          for (const el of current.elements) {
            const line = document.createElement('li')
            const described = `${el.index} · ${el.tag}${el.role ? ' · ' + el.role : ''} · ${el.name}` +
              (el.type ? ' · ' + el.type : '') + (el.href ? ' → ' + el.href : '')
            // href элемента — данные, а не ссылка: из «javascript:alert(1)» в
            // имени никто кликабельный узел в окне человека не собирает.
            putModelText(line, described)
            nodes.elementsEl.appendChild(line)
          }
        }
      }

      const reason = failed ? clip(current.reason, REASON_CHARS) : ''
      putModelText(nodes.errorEl, reason)
      putHidden(nodes.errorEl, !reason)
      // После остановки останавливать нечем: кнопка уходит, чтобы не напрашивалась
      // на второй вызов там, где работа уже прекращена.
      putHidden(nodes.actionsEl, stoppedNow)
      if (stoppedNow && nodes.stopEl && nodes.stopEl.parentElement) nodes.stopEl.remove()
    }

    // --- публичный API --------------------------------------------------------------

    function renderFrame (payload) {
      // Остановленный вид больше не перерисовывается: иначе следующее событие
      // канала вернуло бы «идёт работа» туда, где человек сказал «довольно».
      if (disposed || stopped) return null
      const current = normalize(payload)
      state = Object.assign({ chatId: '', requestId: '' }, current)
      paint()
      return card
    }

    function setError (payload) {
      if (disposed || stopped) return null
      const reason = payload && typeof payload === 'object'
        ? (payload.error || payload.message || payload.reason)
        : payload
      state = Object.assign({}, state, {
        status: FAILED,
        reason: clip(trimmed(reason) || t('Причина не названа'), REASON_CHARS)
      })
      paint()
      return card
    }

    function setStopped (payload) {
      if (disposed) return null
      stopped = true
      const ids = payload && typeof payload === 'object' ? payload : {}
      state = Object.assign({}, state, {
        status: STOPPED,
        chatId: clip(ids.chatId || state.chatId, 80),
        requestId: clip(ids.requestId || state.requestId, 80)
      })
      paint()
      return card
    }

    // Подписка на канал — здесь, а не на стороне окна: вид создаётся вместе с
    // панелью и обязан отписаться вместе с ней, иначе на каждое переподключение
    // окна остался бы слушатель, рисующий в мёртвый DOM.
    function subscribe () {
      if (unsubscribe || disposed) return unsubscribe
      const api = deps.electronAPI
      if (!api || typeof api.onAgentBrowserEvent !== 'function') return null
      unsubscribe = api.onAgentBrowserEvent(payload => renderFrame(payload))
      return unsubscribe
    }

    function dispose () {
      if (typeof unsubscribe === 'function') {
        try { unsubscribe() } catch { /* отписка из окна могла уже быть сделана */ }
      }
      unsubscribe = null
      // Наблюдающий переживает окно, если его не снять: после dispose он
      // возвращал бы карточку в DOM, где её больше не на что рисовать.
      if (watcher) {
        try { watcher.disconnect() } catch { /* окно могло убрать узлы раньше */ }
      }
      watcher = null
      watchedNodes.clear()
      if (nodes && nodes.frame) {
        nodes.frame.remove()
        nodes.frame = null
      }
      if (card) card.remove()
      card = null
      nodes = null
      disposed = true
    }

    subscribe()

    return Object.freeze({
      renderFrame,
      setError,
      setStopped,
      dispose,
      // Проводке окна: текущее состояние вида, чтобы не хранить его дважды.
      state: () => Object.freeze(Object.assign({}, state))
    })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneAgentBrowserView = api
})(typeof window === 'object' ? window : globalThis)
