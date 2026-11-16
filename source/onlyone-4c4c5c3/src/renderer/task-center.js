/* Unified task index for the Tasks view. It reads the existing chat, Design,
 * live-pane and interrupted-run records; it deliberately owns no persistence.
 */
(function (root) {
  'use strict'

  const PROBLEM_OUTCOMES = new Set(['failed', 'interrupted', 'incomplete', 'not-started', 'blocked'])

  function plainText(value, limit = 240) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
  }

  function htmlEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char])
  }

  function taskStatus(agents = []) {
    if (agents.some(agent => PROBLEM_OUTCOMES.has(String(agent?.outcome || '').toLowerCase()))) return 'problem'
    if (agents.length && agents.every(agent => agent?.outcome === 'done')) return 'complete'
    return 'unknown'
  }

  function previousUserText(messages, index) {
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') return plainText(messages[i].content)
    }
    return ''
  }

  function latestUserText(messages) {
    if (!Array.isArray(messages)) return ''
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') return plainText(messages[i].content)
    }
    return ''
  }

  function historyItem({ surface, ownerId, ownerName, message, messages, index }) {
    const run = message?.agentRun
    if (!run || !Array.isArray(run.agents) || !run.agents.length) return null
    const timestamp = Number(run.at || message.timestamp) || 0
    const agents = run.agents.map(agent => ({
      name: plainText(agent?.name || 'Агент', 80),
      title: plainText(agent?.title, 120),
      model: plainText(agent?.model, 120),
      outcome: PROBLEM_OUTCOMES.has(String(agent?.outcome || '').toLowerCase())
        ? String(agent.outcome).toLowerCase()
        : agent?.outcome === 'done' ? 'done' : 'unknown'
    }))
    return {
      id: `history:${surface}:${ownerId}:${timestamp || index}`,
      surface,
      ownerId,
      ownerName: plainText(ownerName, 120),
      title: plainText(run.ask || previousUserText(messages, index) || ownerName || 'Задача'),
      status: taskStatus(agents),
      updatedAt: timestamp,
      durationSeconds: Math.max(0, Number(run.seconds) || 0),
      agents,
      origin: 'history',
      messageIndex: index,
      // Куда прокручивать ленту при переходе из карточки. Лента метит ответ его
      // `timestamp` (атрибут `data-at`), поэтому берётся он, а не время из
      // описи хода: они могут разойтись, и пролёт мимо ответа выглядел бы
      // поломкой перехода.
      messageAt: Number(message.timestamp) || timestamp || 0
    }
  }

  function historyItems(owner, surface) {
    const messages = Array.isArray(owner?.messages) ? owner.messages : []
    const ownerId = plainText(owner?.id, 160)
    if (!ownerId) return []
    return messages.map((message, index) => historyItem({
      surface,
      ownerId,
      ownerName: owner?.name || owner?.title || '',
      message,
      messages,
      index
    })).filter(Boolean)
  }

  function liveItem(pane, surface, ownerName, currentAsk = '') {
    if (!pane || (!pane.generating && !pane.preparing && !pane.resuming)) return null
    const ownerId = plainText(pane.chatId || pane.designId, 160)
    if (!ownerId) return null
    const agents = [...(pane.agentTasks?.values?.() || [])].map(agent => ({
      name: plainText(agent?.name || 'Агент', 80),
      title: plainText(agent?.taskTitle || agent?.assignment || agent?.what, 120),
      model: plainText(agent?.model, 120),
      outcome: agent?.done ? (agent?.outcome || 'done') : 'running'
    }))
    return {
      id: `live:${surface}:${ownerId}`,
      surface,
      ownerId,
      ownerName: plainText(ownerName, 120),
      title: plainText(pane.currentAsk || pane.ask || pane.lastAsk || currentAsk),
      status: pane.preparing || pane.resuming ? 'waiting' : 'running',
      updatedAt: Math.max(Number(pane.startedAt) || 0, 0, ...[...(pane.agentTasks?.values?.() || [])].map(agent => Number(agent?.since) || 0)),
      durationSeconds: 0,
      agents,
      origin: 'live'
    }
  }

  function interruptedItem(run) {
    const ownerId = plainText(run?.designId || run?.chatId || run?.runId, 160)
    if (!ownerId) return null
    const surface = run?.designId ? 'design' : 'chat'
    return {
      id: `interrupted:${plainText(run?.runId, 100) || ownerId}`,
      runId: plainText(run?.runId, 100),
      surface,
      ownerId,
      ownerName: '',
      title: plainText(run?.ask || 'Прерванный ход'),
      status: 'interrupted',
      updatedAt: Number(run?.updatedAt || run?.startedAt) || 0,
      durationSeconds: 0,
      agents: [],
      origin: 'interrupted'
    }
  }

  // Очередь фоновых работ (план, 3.4): карточка планировщика говорит с экраном
  // на том же языке состояний, что ход чата, но остаётся своей — `source:
  // 'queue'` держит её отдельно и по id, и по разметке.
  const QUEUE_STATUS = {
    queued: 'waiting', running: 'running', paused: 'waiting',
    error: 'problem', done: 'complete', interrupted: 'interrupted'
  }

  function queueTaskItem(task) {
    const startedAt = Number(task && task.startedAt) || 0
    const finishedAt = Number(task && task.finishedAt) || 0
    const raw = Number(task && task.progress)
    const progress = task && task.progress !== null && task.progress !== undefined && task.progress !== ''
      && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : null
    return {
      id: `queue:${task && task.id}`,
      cardId: String((task && task.id) || ''),
      source: 'queue',
      surface: 'queue',
      title: plainText(task && task.title, 200) || 'Задача',
      status: QUEUE_STATUS[task && task.state] || 'unknown',
      updatedAt: Math.max(startedAt, finishedAt, 0),
      durationSeconds: startedAt && finishedAt ? Math.max(0, Math.round((finishedAt - startedAt) / 1000)) : 0,
      progress,
      error: plainText(task && task.error, 240),
      canPause: Boolean(task && task.canPause),
      canResume: Boolean(task && task.canResume),
      canCancel: Boolean(task && task.canCancel),
      canRestart: Boolean(task && task.canRestart),
      agents: [],
      ownerName: ''
    }
  }

  function collectTaskItems({ conversations = [], designs = [], panes = [], designTaskPanes = new Map(), interruptedRuns = [], queueTasks = [] } = {}) {
    const items = []
    for (const chat of conversations) items.push(...historyItems(chat, 'chat'))
    for (const design of designs) items.push(...historyItems(design, 'design'))

    for (const pane of panes) {
      const chat = conversations.find(item => item?.id === pane?.chatId)
      const item = liveItem(pane, 'chat', chat?.title || chat?.name || '', latestUserText(chat?.messages))
      if (item) items.push(item)
    }
    for (const [designId, pane] of designTaskPanes || []) {
      const design = designs.find(item => item?.id === designId)
      const item = liveItem({ ...pane, designId }, 'design', design?.name || '', latestUserText(design?.messages))
      if (item) items.push(item)
    }
    for (const run of interruptedRuns) {
      const item = interruptedItem(run)
      if (item) items.push(item)
    }
    for (const task of queueTasks) {
      if (task) items.push(queueTaskItem(task))
    }

    return items.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  }

  // Подпись поверхности — то, что человек читает на карточке. Искать надо по
  // видимому слову, а не по внутреннему ключу: по «дизайн» находить «design».
  function surfaceLabels(t = value => value) {
    return { chat: t('Чат'), design: t('Дизайн'), queue: t('Очередь задач') }
  }

  function filterTaskItems(items = [], { query = '', status = 'all', t } = {}) {
    const needle = plainText(query, 200).toLocaleLowerCase()
    const labels = surfaceLabels(t)
    return (Array.isArray(items) ? items : []).filter(item => {
      if (status === 'active' && !['running', 'waiting', 'interrupted'].includes(item.status)) return false
      if (status === 'problems' && !['problem', 'interrupted'].includes(item.status)) return false
      if (status === 'complete' && item.status !== 'complete') return false
      if (!needle) return true
      return [item.title, item.ownerName, item.surface, labels[item.surface],
        ...(item.agents || []).flatMap(agent => [agent.name, agent.title, agent.model])]
        .some(value => plainText(value, 240).toLocaleLowerCase().includes(needle))
    })
  }

  function taskCardHtml(item, index, escapeHtml, t = value => value) {
    const safe = typeof escapeHtml === 'function' ? escapeHtml : htmlEscape
    const status = new Set(['running', 'waiting', 'interrupted', 'problem', 'complete', 'unknown']).has(item.status)
      ? item.status : 'unknown'
    const statusLabels = {
      running: t('В работе'), waiting: t('Ожидает'), interrupted: t('Прервано'),
      problem: t('Есть проблема'), complete: t('Завершено'), unknown: t('Статус не определён')
    }
    const surfaces = surfaceLabels(t)
    const details = (item.agents || []).map(agent => agent.title || agent.name).filter(Boolean).slice(0, 3).join(' · ')
    const owner = [item.ownerName].filter(Boolean).join(' · ')
    // Полоса работы — только там, где планировщик назвал число. Без него экран
    // рисовал бы выдуманный процент, а человек считал бы задержку прогрессом.
    const percent = Number.isFinite(item.progress) ? Math.round(item.progress * 100) : null
    const bar = percent === null ? '' : `<span class="task-center-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span class="task-center-progress-fill" style="width:${percent}%"></span></span>`
    const reason = item.source === 'queue' && item.error ? `<span class="task-center-error">${safe(item.error)}</span>` : ''
    const actions = item.source === 'queue' ? [
      item.canPause && ['pause', t('Пауза')],
      item.canResume && ['resume', t('Возобновить')],
      item.canRestart && ['restart', t('Перезапустить')],
      item.canCancel && ['cancel', t('Отменить')]
    ].filter(Boolean).map(([name, label]) =>
      `<button type="button" class="btn-secondary task-center-action" data-task-action="${name}" data-task-card="${safe(item.cardId)}">${safe(label)}</button>`) : []
    // Имя кнопки — её же текст: `aria-label` перекроет его, и диктор назовёт
    // только заголовок, потеряв поверхность и состояние.
    const card = `<button type="button" class="task-center-item status-${status}" data-task-index="${index}">
      <span class="task-center-status" aria-hidden="true"></span>
      <span class="task-center-copy"><span class="task-center-title">${safe(item.title || t('Задача'))}</span>
      <span class="task-center-meta">${safe(surfaces[item.surface] || item.surface)}${owner ? ` · ${safe(owner)}` : ''}</span>
      ${details ? `<span class="task-center-detail">${safe(details)}</span>` : ''}</span>
      <span class="task-center-state">${safe(statusLabels[item.status] || statusLabels.unknown)}</span>
    </button>`
    // Ряд — только у карточки очереди: разметку ходов чата и Дизайна
    // этот экран не меняет.
    if (item.source !== 'queue') return card
    return `<div class="task-center-row">${card}${bar}${reason}${actions.length
      ? `<span class="task-center-actions">${actions.join('')}</span>` : ''}</div>`
  }

  const renderedItems = new WeakMap()

  function renderTaskItems(container, items, options = {}) {
    if (!container) return []
    const filtered = filterTaskItems(items, options)
    renderedItems.set(container, filtered)
    if (!filtered.length) {
      const query = plainText(options.query, 200)
      const safe = typeof options.escapeHtml === 'function' ? options.escapeHtml : htmlEscape
      // Пусто по разным причинам звучит по-разному: ходов нет вовсе; есть, но
      // их скрыл поиск; есть, но под них не подходит выбранный фильтр.
      const say = typeof options.t === 'function' ? options.t : value => value
      const hasItems = (Array.isArray(items) ? items : []).length > 0
      const filteredByStatus = options.status && options.status !== 'all'
      // Три разные пустоты и три разные фразы: ходов нет вовсе; их скрыл
      // запрос; их скрыл выбранный фильтр, а ходы другого состояния остались.
      let title = 'Пока нет задач'
      let description = 'Здесь появятся активные и завершённые ходы из чатов и Дизайна.'
      if (query) {
        title = 'Ничего не найдено'
        description = 'Измените запрос или фильтр.'
      } else if (hasItems && filteredByStatus) {
        title = 'Ничего не найдено'
        description = 'Смените фильтр — ходы другого состояния остались выше.'
      }
      title = say(title)
      description = say(description)
      container.innerHTML = `<div class="task-center-empty"><span class="task-center-empty-mark" aria-hidden="true">—</span><strong>${safe(title)}</strong><span>${safe(description)}</span></div>`
      return filtered
    }
    container.innerHTML = filtered.map((item, index) => taskCardHtml(item, index, options.escapeHtml, options.t)).join('')
    return filtered
  }

  const boundContainers = new WeakSet()
  const boundActions = new WeakSet()

  function bindTaskItems(container, onOpen) {
    if (!container || typeof onOpen !== 'function' || boundContainers.has(container)) return false
    boundContainers.add(container)
    container.addEventListener('click', event => {
      const button = event.target?.closest?.('[data-task-index]')
      if (!button || !container.contains(button)) return
      const items = renderedItems.get(container) || []
      const index = Number(button.dataset.taskIndex)
      if (Number.isInteger(index) && index >= 0 && index < items.length) onOpen(items[index])
    })
    return true
  }

  // Действия очереди — не переход, а команда планировщику. Кнопки лежат рядом
  // с карточкой, а не внутри неё: вложенная кнопка в кнопке ломает и мышь, и
  // клавиатуру, и дерево доступности.
  function bindTaskActions(container, onAction) {
    if (!container || typeof onAction !== 'function' || boundActions.has(container)) return false
    boundActions.add(container)
    container.addEventListener('click', event => {
      const button = event.target?.closest?.('[data-task-action]')
      if (!button || !container.contains(button)) return
      const name = String(button.dataset.taskAction || '')
      const cardId = String(button.dataset.taskCard || '')
      if (!name || !cardId) return
      Promise.resolve().then(() => onAction(name, cardId)).catch(() => {})
    })
    return true
  }

  // ---------------------------------------------------------------------------
  // Экран раздела
  // ---------------------------------------------------------------------------
  // Индекс выше — только данные. Экран добавляет то, без чего раздел остаётся
  // списком в модуле: «читаю»/«пусто»/«не прочиталось», поиск и фильтры,
  // движение активного хода, пока раздел открыт, и переход из карточки туда,
  // где работа делалась. Сам он не хранит ни истории, ни макеты, ни описи
  // прерванных ходов: читает то, что показывают проводкой, и рисует.

  const STATUSES = ['all', 'active', 'problems', 'complete']
  const LIVE = new Set(['running', 'waiting'])
  const TICK_MS = 5000
  const SEARCH_DEBOUNCE_MS = 150
  // Ход выдаёт события пачками, а индекс перечитывает всю историю: перерисовка
  // ставится на короткий шаг и не чаще, чем раз в этот интервал.
  const REBUILD_MS = 400

  function create(deps) {
    const {
      document, t = value => value, escapeHtml,
      readInterrupted = async () => [],
      readTasks = async () => [],
      runTaskAction = async () => ({}),
      getChats = () => [], getDesigns = () => [], getPanes = () => [],
      getDesignPanes = () => new Map(), openTask, setBadge = () => {}
    } = deps

    const labels = {
      all: () => t('Все'), active: () => t('Активные'),
      problems: () => t('С проблемами'), complete: () => t('Завершённые')
    }
    const state = { query: '', status: 'all', items: [], shown: [], interrupted: [], queue: [], queueError: '', loading: false, loaded: false, error: '' }
    let timer = null
    let searchTimer = null
    let soon = null
    let queueTimer = null

    const esc = typeof escapeHtml === 'function' ? escapeHtml : htmlEscape
    const node = id => (document && document.getElementById ? document.getElementById(id) : null)
    const listBox = () => node('taskCenterList')
    // Открыт ли раздел: у скрытого `display:none` узла нет offsetParent, так что
    // лезть в чужие классы и порядок вкладки не нужно.
    const isOpen = () => Boolean(listBox() && listBox().offsetParent)

    const countWhere = status => filterTaskItems(state.items, { status, query: state.query }).length

    function loadingHtml() {
      const row = '<div class="task-center-skeleton" aria-hidden="true"></div>'
      return `<div class="task-center-loading" role="status"><span>${esc(t('Читаю задачи…'))}</span></div>${row}${row}${row}`
    }

    function build() {
      state.items = collectTaskItems({
        conversations: getChats(), designs: getDesigns(), panes: getPanes(),
        designTaskPanes: getDesignPanes(), interruptedRuns: state.interrupted,
        queueTasks: state.queue
      })
    }

    function paintCount(host) {
      const active = countWhere('active')
      // Метка навигации пишется до всего остального: раздел может быть закрыт
      // и не иметь строки счёта, а решать, заходить ли, человек по ней.
      setBadge(active)
      const box = node('taskCenterCount')
      if (!box) return
      if (state.loading && !state.loaded) { box.textContent = t('Читаю задачи…'); return }
      const parts = [`${t('Активных')} ${active}`, `${t('Всего')} ${countWhere('all')}`]
      // Когда список сужен поиском или фильтром, человек видит и это: иначе
      // «Всего 2» рядом с пятью карточками читается как ошибка счёта.
      if (host && state.shown.length !== state.items.length) parts.unshift(`${t('Показано')} ${state.shown.length}`)
      if (state.error) parts.push(t('Прерванные ходы не прочитались'))
      if (state.queueError) parts.push(t('Очередь задач не прочиталась'))
      const line = parts.join(' · ')
      // Строка счёта — живая область: писать её на каждый тик часов нельзя,
      // диктор перечитывал бы одно и то же.
      if (box.textContent !== line) box.textContent = line
    }

    function paint() {
      const host = listBox()
      if (!host) return
      for (const button of document.querySelectorAll('[data-task-filter]')) {
        const on = STATUSES.includes(button.dataset.taskFilter) && button.dataset.taskFilter === state.status
        button.setAttribute('aria-pressed', String(on))
        const label = labels[button.dataset.taskFilter]
        if (label) button.textContent = label()
      }
      if (state.loading && !state.loaded) { host.innerHTML = loadingHtml(); paintCount(null); return }
      state.shown = renderTaskItems(host, state.items, { query: state.query, status: state.status, escapeHtml, t })
      paintCount(host)
      if (isOpen() && state.items.some(item => LIVE.has(item.status))) startTimer()
      else stopTimer()
    }

    function startTimer() {
      if (timer) return
      timer = setInterval(() => {
        // Раздел закрыли или активный ход кончился — часы сами себя снимают.
        if (!isOpen() || !state.items.some(item => LIVE.has(item.status))) { stopTimer(); return }
        build()
        paint()
      }, TICK_MS)
    }

    function stopTimer() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    }

    function wire(section, host) {
      if (section.dataset.taskCenterWired) return
      section.dataset.taskCenterWired = '1'
      section.addEventListener('input', event => {
        if (event.target?.id !== 'taskCenterSearch') return
        clearTimeout(searchTimer)
        const value = String(event.target.value || '')
        searchTimer = setTimeout(() => { state.query = value; paint() }, SEARCH_DEBOUNCE_MS)
      })
      section.addEventListener('click', event => {
        const button = event.target?.closest?.('[data-task-filter]')
        if (!button || !section.contains(button)) return
        state.status = STATUSES.includes(button.dataset.taskFilter) ? button.dataset.taskFilter : 'all'
        paint()
      })
      bindTaskItems(host, item => {
        // У карточки очереди нет чата, который можно открыть: переход по клику
        // у неё — кнопки действий.
        if (item && item.source === 'queue') return undefined
        if (typeof openTask === 'function') return openTask(item)
        return undefined
      })
      bindTaskActions(host, (name, cardId) => Promise.resolve(runTaskAction(name, cardId)).then(() => {
        build()
        paint()
      }))
    }

    // Раздел существует в разметке окна; проводка ставится на его узлы при
    // первом обращении, пока их нет — экран просто ничего не рисует.
    function ensure() {
      const section = node('taskCenterView')
      const host = listBox()
      if (!section || !host) return false
      wire(section, host)
      return true
    }

    function refresh() {
      if (!ensure()) return Promise.resolve(0)
      state.loading = true
      paint()
      return Promise.resolve()
        .then(() => Promise.allSettled([readInterrupted(), readTasks()]))
        .then(([runs, queue]) => {
          // Очередь и прерванные ходы читаются вместе, но отказ одной не имеет
          // права лишить человека другой: две разные строки, два разных провала.
          state.interrupted = runs.status === 'fulfilled' && Array.isArray(runs.value) ? runs.value : []
          state.error = runs.status === 'fulfilled' ? '' : t('Прерванные ходы не прочитались')
          state.queue = queue.status === 'fulfilled' && Array.isArray(queue.value) ? queue.value : []
          state.queueError = queue.status === 'fulfilled' ? '' : t('Очередь задач не прочиталась')
        })
        .then(() => {
          state.loading = false
          state.loaded = true
          build()
          paint()
          return state.items.length
        })
    }

    // Событие очереди говорит только «изменилось»: тело несёт те карточки, у
    // которых сдвинулся статус, а не весь список. Править им экран — значит
    // потерять карточку, поэтому ответ один: перечитать очередь целиком. Метка
    // раздела нужна и закрытому экрану, поэтому читается всегда, а пачка
    // событий сливается в одну перечитку.
    function queueChanged() {
      if (queueTimer) return state.items.length
      queueTimer = setTimeout(() => {
        queueTimer = null
        Promise.resolve()
          .then(() => readTasks())
          .then(tasks => {
            state.queue = Array.isArray(tasks) ? tasks : []
            state.queueError = ''
          })
          .catch(() => { state.queueError = t('Очередь задач не прочиталась') })
          .then(() => { build(); paint() })
      }, REBUILD_MS)
      return state.items.length
    }

    return Object.freeze({
      ensure, refresh, queueChanged,
      rebuild() { build(); paint(); return state.items.length },
      // Окно зовёт это на каждое событие хода: пока раздел закрыт — молчит,
      // а открытые перерисовки сливаются в одну.
      rebuildSoon() {
        if (!isOpen() || soon) return state.items.length
        soon = setTimeout(() => { soon = null; build(); paint() }, REBUILD_MS)
        return state.items.length
      },
      setQuery(value) { state.query = plainText(value, 200); paint(); return state.shown.length },
      setStatus(value) { state.status = STATUSES.includes(value) ? value : 'all'; paint(); return state.shown.length },
      items: () => state.items.slice(),
      shown: () => state.shown.slice(),
      interruptedRuns: () => state.interrupted.slice(),
      // Метка в навигации нужна и закрытому разделу: по ней человек решает,
      // заходить ли. Считается по тем же данным, что и список, но DOM раздела
      // не трогает.
      syncBadge() { build(); const active = countWhere('active'); setBadge(active); return active },
      // Часы и отложенная перерисовка — то, что обязано гаснуть вместе с
      // экраном: иначе раздел дёргается, когда его уже не видно.
      stop() {
        stopTimer()
        clearTimeout(searchTimer)
        if (soon) { clearTimeout(soon); soon = null }
        if (queueTimer) { clearTimeout(queueTimer); queueTimer = null }
      }
    })
  }

  const api = Object.freeze({ collectTaskItems, historyItems, taskStatus, filterTaskItems, taskCardHtml,
    renderTaskItems, bindTaskItems, bindTaskActions, queueTaskItem, create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneTaskCenter = api
})(typeof window === 'object' ? window : globalThis)
