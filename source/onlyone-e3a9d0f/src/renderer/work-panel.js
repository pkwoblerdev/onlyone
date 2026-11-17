/* Панель «Работа» — кто что делает прямо сейчас (план, 2d).
 *
 * Реестр хода: строки агентов, чек-лист, письма с доски и история прошлых
 * ходов, плюс кнопка входа в заголовке чата. Панель одна на окно и
 * принадлежит тому чату, на который смотрят, — знать какой именно открыт
 * ей должен тот, у кого это состояние живёт, а не заводить своё.
 *
 * Отдельный файл потому, что панель — свой экран со своим состоянием и
 * своими часами: в `app.js` она занимала восемьсот строк между лентой
 * сообщений и меню проекта. Всё нужное приходит проводкой при первом
 * обращении; ни хранилища диалогов, ни настроек модуль не касается.
 */
(function (root) {
  'use strict'

  let $, t, el, escapeHtml, showToast, prefersReducedMotion, formatDuration, formatTokens, formatRelativeTime, updateLiveMeta, chatOf, normalizePlanSteps, designTaskPanes, PLAN_STATUS, stopTurn, stopDesignRun, getUiLang, getPanes, getActivePane, getDesigns, getActiveDesign, configurationParameters

  // Панель пересобирается целиком на каждом шаге хода (до двух раз в секунду). Кнопка, на которой стоял фокус,
  // исчезала вместе с ним — клавиатурой нельзя было ни остановить ход, ни свернуть панель. Запоминаем кнопку по
  // классам и номеру среди таких же, а после сборки возвращаем фокус её двойнику.
  function rememberPanelFocus(panel) {
    const node = document.activeElement
    if (!node || node === document.body || !panel.contains(node)) return null
    const selector = node.tagName.toLowerCase() + [...node.classList].map(name => '.' + CSS.escape(name)).join('')
    return { selector, index: [...panel.querySelectorAll(selector)].indexOf(node) }
  }
  function restorePanelFocus(panel, saved) {
    if (!saved) return
    const found = panel.querySelectorAll(saved.selector)
    const target = (saved.index >= 0 && found[saved.index]) || found[0]
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true })
  }

  // Чат рядом с браузером/превью и панелью «Работа». Раньше лента зажималась до 60–220 px: панель браузера
  // считала ширину от окна, не зная про панель «Работа», а поле ввода уезжало под неё. Лента не уже CHAT_MIN_WIDTH:
  // место освобождается теми же шагами, что и у «Второго чата рядом» — сначала боковая панель сворачивается до значков,
  // потом закрывается панель «Работа» (её кнопка в заголовке вернёт её, когда браузер закроют).
  const CHAT_MIN_WIDTH = 360
  const SIDEBAR_RAIL_WIDTH = 58
  let sidebarNarrowedForArtifact = false
  let applySidebarWidth = () => {}

  function artifactBesideChat() {
    const view = $('chatView')
    return Boolean(view && view.classList.contains('artifact-open') && !view.classList.contains('artifact-expanded'))
  }
  function ensureChatRoom() {
    const feed = $('chatFeed')
    if (!feed || !artifactBesideChat()) return
    let room = feed.getBoundingClientRect().width
    if (room >= CHAT_MIN_WIDTH) return
    const bar = document.querySelector('.sidebar')
    if (bar && !document.body.classList.contains('sidebar-narrow')) {
      // Боковая панель сворачивается с анимацией: выигрыш считаем, а не ждём замера.
      room += Math.max(0, bar.getBoundingClientRect().width - SIDEBAR_RAIL_WIDTH)
      applySidebarWidth(true)
      sidebarNarrowedForArtifact = true
    }
    if (room >= CHAT_MIN_WIDTH) return
    const owner = panelPane()
    if (owner && owner.tasksOpen) toggleTasksPanel(owner, false)
  }
  function releaseChatRoom() {
    if (!sidebarNarrowedForArtifact) return
    sidebarNarrowedForArtifact = false
    applySidebarWidth(false)
  }
  // Человек сам решил, какой быть боковой панели: закрытие браузера её уже не возвращает.
  function forgetSidebarNarrowing() { sidebarNarrowedForArtifact = false }
  // Автооткрытие панели при событиях хода не должно снова сжать чат до обрубка.
  function roomForWorkPanel() {
    const feed = $('chatFeed')
    if (!feed || !artifactBesideChat()) return true
    const wide = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--work-panel-width')) || 292
    return feed.getBoundingClientRect().width - (window.innerWidth < 1280 ? 244 : wide) >= CHAT_MIN_WIDTH
  }

  function create(deps) {
    if (typeof deps.applySidebarWidth === 'function') applySidebarWidth = deps.applySidebarWidth
    ;({ $, t, el, escapeHtml, showToast, prefersReducedMotion, formatDuration, formatTokens, formatRelativeTime, updateLiveMeta, chatOf, normalizePlanSteps, designTaskPanes, PLAN_STATUS, stopTurn, stopDesignRun, getUiLang, getPanes, getActivePane, getDesigns, getActiveDesign, configurationParameters } = deps)
    return Object.freeze({
      ensureChatRoom,
      releaseChatRoom,
      forgetSidebarNarrowing,
      agentTaskState,
      lastAskOf,
      noteAgentDoing,
      elapsedText,
      panelPane,
      panelWelcomeHere,
      toggleTasksPanel,
      refreshTasksPanel,
      allTasks,
      extractTaskTitle,
      cutOnWord,
      unifiedPlanItems,
      stepItems,
      planOfTask,
      taskState,
      checklistHtml,
      countWord,
      agentsWord,
      agentRunRecord,
      runsOf,
      historyAgentHtml,
      historySectionHtml,
      unifiedItemHtml,
      boardSectionHtml,
      planSectionsHtml,
      settleAgentTasks,
      completeAgentTask,
      taskEndLabel,
      taskCard,
      tasksStatus,
      renderAgentTasks,
      renderTasksHeaderButton,
      clearAgentTasks
    })
  }

  // ---------------------------------------------------------------------------
  // Running tasks: who is doing what, right now
  // ---------------------------------------------------------------------------
  //
  // In a team mode several agents work one after another and the only thing on
  // screen was a single status line, so it was impossible to tell who was
  // working, on what, and how long it had been going. This panel answers that
  // while it happens rather than afterwards in the transcript.

  function agentTaskState(pane, index, name) {
    pane.agentTasks = pane.agentTasks || new Map()
    if (!pane.agentTasks.has(index)) {
      pane.agentTasks.set(index, {
        index,
        name: name || `Агент ${index + 1}`,
        model: '',
        what: 'готовится',
        step: 0,
        since: Date.now(),
        tools: 0,
        done: false
      })
    }
    const task = pane.agentTasks.get(index)
    if (name) task.name = name
    return task
  }

  // Что агент делает прямо сейчас. Пишется в его строку в панели работы;
  // отдельного «ожидания» больше нет — есть либо мысль, либо вызов, либо ответ.
  // Последняя просьба пользователя в этом чате — она же заголовок работы
  // ведущего агента в панели.
  function lastAskOf(pane) {
    const chat = chatOf(pane)
    const last = [...(chat?.messages || [])].reverse().find(m => m.role === 'user')
    const text = String(last?.content || '').replace(/\s+/g, ' ').trim()
    return text.length > 160 ? text.slice(0, 160).replace(/\s+\S*$/, '') + '…' : text
  }

  function noteAgentDoing(pane, event, what) {
    if (!what) return
    const task = agentTaskState(pane, event?.agentIndex ?? 0, event?.agentName)
    const next = String(what)
    // Ничего не поменялось — и рисовать нечего. Это зовётся на каждый кусок
    // потока, а занятие весь ответ одно и то же: «Пишет ответ». Без этой
    // строки панель перестраивалась целиком на каждый токен.
    if (task.what === next && !task.done) return
    task.what = next
    task.done = false
    renderAgentTasks(pane)
    updateLiveMeta(pane)
  }

  function elapsedText(since) {
    const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
    if (seconds < 60) return `${seconds} с`
    return `${Math.floor(seconds / 60)} мин ${String(seconds % 60).padStart(2, '0')} с`
  }

  // A register of what is running, the way a task list works: what is going on
  // now, what has finished, and one place to clear the finished ones. In a team
  // mode several agents work in turn, and a single status line could not say who
  // was working, on what, or for how long.
  // Панель одна на окно, и принадлежит она тому чату, на который смотрят. Это
  // третий подход к вопросу, и первые два были неверны одинаково: сначала
  // открытость была общей на окно, потом появился отдельный «владелец» — и
  // фоновый чат всё равно забирал панель себе, потому что открывал её сам,
  // приходя со своим планом или доской. Владелец не может быть ничем иным,
  // кроме открытого чата: панель показывает работу того, кого видно.
  function panelPane() {
    if (el.designView?.classList.contains('active')) { const design = getActiveDesign(); return design ? designTaskPanes.get(design.id) || null : null }
    if (!el.chatView?.classList.contains('active')) return null
    return getActivePane() || getPanes()[0] || null
  }

  // Панель работы открывается сама там, где помогает. В разделе Design смотрят на
  // макет, а панель занимает почти треть окна: появившись без спроса, она сужает
  // ровно то, ради чего раздел открыт. Открыть её руками из заголовка можно
  // всегда — тогда место под неё резервируется, а не отнимается у превью.
  function panelWelcomeHere() {
    // При двух чатах панель сама не открывается: у правого края стоит второй
    // чат, и панель, появившись без спроса, закрывала его целиком.
    if (document.body.classList.contains('split-open')) return false
    // Браузер рядом занял место: появившись сама, панель сжала бы чат до обрубка.
    if (!roomForWorkPanel()) return false
    return !el.designView?.classList.contains('active')
  }

  function toggleTasksPanel(pane, force) {
    const target = pane || panelPane()
    if (!target) return
    target.tasksOpen = force === undefined ? !target.tasksOpen : Boolean(force)
    renderAgentTasks(target)
  }

  // Смена открытого чата меняет и хозяина панели: старая работа уходит с
  // экрана вместе со своим чатом, новая появляется, если она есть.
  function refreshTasksPanel() {
    const target = panelPane()
    if (target) renderAgentTasks(target)
    else {
      $('tasksPanel')?.remove()
      document.body.classList.remove('tasks-open')
    }
  }

  function allTasks(pane) {
    return [...(pane?.agentTasks?.values() || [])]
  }

  // Заголовок поручения — его первая фраза. Точка считается концом фразы только
  // если за ней пробел или конец строки: иначе «package.json» разрывало надвое,
  // и в панели стояло «Прочитай файл package», а под ним обрывок «.json в корне
  // ра…». То же случалось с «tests/run-smoke.cjs» и с версиями вида 1.1.0.
  function extractTaskTitle(taskStr) {
    if (!taskStr) return ''
    const clean = String(taskStr).replace(/^\/agent\s+/i, '').replace(/^[tT]\d+[:.\s-]+/, '').trim()
    const firstSentence = (clean.split(/(?<=[.;!?])\s|\n/)[0] || clean).replace(/[.;!?]+$/, '').trim()
    const beforeColon = firstSentence.split(':')[0].trim()
    const head = beforeColon.length >= 4 ? beforeColon : firstSentence
    const title = head.length > 60 ? cutOnWord(head, 60) : head
    return title.length > 3 ? title : cutOnWord(clean, 50)
  }

  // Обрезка по границе слова: обрезанное посреди слова читается как опечатка.
  function cutOnWord(text, limit) {
    const raw = String(text || '').trim()
    if (raw.length <= limit) return raw
    const cut = raw.slice(0, limit)
    const space = cut.lastIndexOf(' ')
    return (space > limit * 0.6 ? cut.slice(0, space) : cut).trim() + '…'
  }

  const BOARD_WORD = {
    open: 'не начато',
    doing: 'в работе',
    done: 'сделано',
    blocked: 'заблокировано',
    disputed: 'оспорено'
  }

  function unifiedPlanItems(pane) {
    const list = []
    const seenTitles = new Set()

    const boardItems = Array.isArray(pane.board?.items) ? pane.board.items : []
    for (const b of boardItems) {
      const fullTask = String(b.task || '').trim()
      const title = String(b.title || extractTaskTitle(fullTask) || (b.id ? `Задача ${b.id}` : 'Поручение')).trim()
      // Остаток поручения под заголовком. Если заголовок обрезан по слову, то
      // остаток начинается не с его длины, а с первой неиспользованной фразы —
      // иначе под заголовком стоял обрывок того же слова.
      const clipped = title.endsWith('…')
      const rest = !clipped && fullTask.startsWith(title)
        ? fullTask.slice(title.length).replace(/^[:.;\s-]+/, '')
        : (clipped ? '' : (fullTask !== title ? fullTask : ''))
      const shortDetail = rest || b.note || ''
      const preview = shortDetail ? cutOnWord(shortDetail.replace(/\s+/g, ' ').trim(), 85) : ''
      list.push({
        id: b.id || `b_${list.length}`,
        title,
        preview,
        fullTask,
        note: b.note || '',
        acceptance: b.acceptance || '',
        agent: b.agent || '',
        status: b.status || 'open'
      })
      seenTitles.add(title.toLowerCase())
    }

    return list
  }

  function stepItems(items, agent) {
    return normalizePlanSteps(items).map((step, i) => {
      const detail = String(step.detail || '').trim()
      return {
        id: `${agent || 'plan'}:${step.id || i}`,
        title: String(step.title || 'Шаг').trim(),
        preview: detail ? detail.slice(0, 85).replace(/\s+/g, ' ').trim() : '',
        fullTask: detail,
        note: '',
        acceptance: '',
        agent: '',
        status: step.status || 'todo',
        dependsOn: step.dependsOn || []
      }
    })
  }

  // Чек-лист, принадлежащий этой карточке. Сначала по номеру агента; по имени —
  // только для списков, чей номер неизвестен (сохранённые до этой версии).
  function planOfTask(pane, task) {
    const owners = pane?.planOwner || new Map()
    for (const [agent, items] of (pane?.planByAgent || new Map())) {
      if (!Array.isArray(items) || !items.length) continue
      const mine = owners.has(agent)
        ? owners.get(agent) === task.index
        : agent === task.name || String(task.name || '').startsWith(agent + ' ')
      if (mine) return { agent, items }
    }
    return null
  }

  const TASK_ICONS = {
    running: '<svg fill="none" class="icon task-spin" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4A5.6 5.6 0 1 0 13.6 8"/></svg>',
    done: '<svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M5.6 8.3l1.7 1.7 3.2-3.5"/></svg>',
    problem: '<svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 7.4V11M8 5.2v.01"/></svg>',
    waiting: '<svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.1 1.4"/></svg>',
    todo: '<svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/></svg>',
    history: '<svg fill="none" class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4.5V9H8M12 7.5V12l3 2"/></svg>'
  }

  function taskState(task) {
    if (task.waiting) return 'waiting'
    if (!task.done) return 'running'
    return ['failed', 'interrupted', 'incomplete', 'not-started'].includes(task.outcome) ? 'problem' : 'done'
  }

  function checklistHtml(pane, task) {
    const plan = planOfTask(pane, task)
    if (!plan) return ''
    const steps = stepItems(plan.items, plan.agent)
    const done = steps.filter(step => step.status === 'done').length
    const pct = steps.length ? Math.round((done / steps.length) * 100) : 0
    pane.checklistOpen = pane.checklistOpen || new Set()
    // Пока ход идёт, список раскрыт: по нему и следят за работой. Как только
    // ход закончился, тот же список уходит в переписку, и держать его раскрытым
    // ещё и здесь — показывать одно и то же дважды. Выбор человека запоминается.
    const touched = pane.checklistOpen.has(`open:${task.index}`) || pane.checklistOpen.has(`closed:${task.index}`)
    const open = touched
      ? pane.checklistOpen.has(`open:${task.index}`)
      : Boolean(pane.generating)
    return `
      <div class="task-checklist">
        <button type="button" class="tasks-section-toggle" data-checklist="${task.index}" aria-expanded="${open}">
          <svg class="tasks-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
          <span class="tasks-section-name">${t('Чек-лист')}</span>
          <span class="tasks-section-count">${done} / ${steps.length}</span>
        </button>
        <div class="tasks-plan-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${done}"><span style="width:${pct}%"></span></div>
        ${open ? `<div class="tasks-plan">${steps.map(step => unifiedItemHtml(step, pane)).join('')}</div>` : ''}
      </div>`
  }

  // «1 диалог», «3 диалога», «5 диалогов». Английскому хватает двух форм.
  function countWord(count, one, few, many) {
    const n = Number(count) || 0
    if (getUiLang() === 'en') return `${n} ${t(n === 1 ? one : many)}`
    const tail = n % 10 === 1 && n % 100 !== 11 ? one
      : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many
    return `${n} ${tail}`
  }

  function agentsWord(count) {
    return countWord(count, 'агент', 'агента', 'агентов')
  }

  // Запись о работе агентов, которая остаётся в сохранённом ответе. Живая панель
  // стирается со следующим ходом, и узнать, как отработала команда вчера, было
  // негде. Обычный одиночный ответ без чек-листа сюда не попадает: иначе история
  // заполнилась бы каждым «привет».
  function agentRunRecord(source, options = {}) {
    return window.OnlyoneRunHistory.createRecorder({ normalizePlanSteps, extractTaskTitle })(source, options)
  }

  function runsOf(pane) {
    const messages = pane?.designId
      ? getDesigns().find(design => design.id === pane.designId)?.messages
      : chatOf(pane)?.messages
    return (messages || []).filter(message => message?.role === 'assistant' && message.agentRun).reverse()
  }

  function historyAgentHtml(agent) {
    const state = ['failed', 'interrupted', 'incomplete', 'not-started'].includes(agent.outcome) ? 'problem' : 'done'
    const meta = [
      agent.title ? agent.name : '',
      agent.model ? (agent.model.includes('/') ? agent.model.split('/').pop() : agent.model) : '',
      agent.seconds ? formatDuration(agent.seconds) : '',
      agent.tools ? `${agent.tools} ${t('действ.')}` : '',
      agent.tokens ? `${formatTokens(agent.tokens)} ${t('ток.')}` : ''
    ].filter(Boolean).join(' · ')
    return `<div class="history-agent outcome-${escapeHtml(agent.outcome || 'done')}">
        <span class="task-state-icon state-${state}">${TASK_ICONS[state]}</span>
        <div class="history-agent-text">
          <div class="history-agent-line">
            <span class="history-agent-name">${escapeHtml(agent.title || agent.name || 'Агент')}</span>
            <span class="history-agent-state">${escapeHtml(taskEndLabel(agent))}</span>
          </div>
          <div class="history-agent-meta">${escapeHtml(meta)}</div>
        </div>
      </div>`
  }

  function historySectionHtml(pane) {
    const runs = runsOf(pane)
    if (!runs.length) {
      return `
        <div class="tasks-empty history-empty">
          <span class="tasks-empty-icon">${TASK_ICONS.history}</span>
          <span>${t('Здесь появятся прошлые ходы: кто что делал и чем кончилось.')}</span>
        </div>`
    }
    pane.historyOpen = pane.historyOpen || new Set()
    return runs.map(message => {
      const run = message.agentRun
      const agents = Array.isArray(run.agents) ? run.agents : []
      const troubled = agents.some(agent => ['failed', 'interrupted', 'incomplete'].includes(agent.outcome))
      const key = String(run.at || message.timestamp || '')
      const meta = [formatRelativeTime(run.at || message.timestamp), agentsWord(agents.length),
        run.seconds ? formatDuration(run.seconds) : ''].filter(Boolean).join(' · ')
      return `
        <details class="history-run${troubled ? ' troubled' : ''}" data-run="${escapeHtml(key)}"${pane.historyOpen.has(key) ? ' open' : ''}>
          <summary class="history-run-head">
            <span class="task-state-icon state-${troubled ? 'problem' : 'done'}">${troubled ? TASK_ICONS.problem : TASK_ICONS.done}</span>
            <span class="history-run-text">
              <span class="history-run-ask">${escapeHtml(run.ask || t('Ход без текста'))}</span>
              <span class="history-run-meta">${escapeHtml(meta)}${troubled ? ` · <span class="history-run-issue">${t('есть проблемы')}</span>` : ''}</span>
            </span>
            <svg class="tasks-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
          </summary>
          <div class="history-run-body">
            ${agents.map(historyAgentHtml).join('')}
            ${(Array.isArray(run.plans) ? run.plans : []).map(plan => `
              <div class="history-plan">
                <span>${escapeHtml(plan.agent ? `${t('Чек-лист')} · ${plan.agent}` : t('Чек-лист'))}</span>
                <span class="history-plan-count">${plan.done} / ${plan.total}</span>
              </div>`).join('')}
            ${(Array.isArray(run.board) ? run.board : []).map(item => `
              <div class="history-board status-${escapeHtml(item.status || 'open')}">
                <div class="history-agent-line">
                  <span class="history-board-title">${escapeHtml(item.title || item.id || '')}</span>
                  <span class="history-agent-state">${escapeHtml(BOARD_WORD[item.status] || item.status || '')}</span>
                </div>
                ${item.agent ? `<div class="history-agent-meta">${escapeHtml(item.agent)}</div>` : ''}
                ${item.note ? `<div class="history-board-note">${escapeHtml(item.note)}</div>` : ''}
              </div>`).join('')}
            ${message.timestamp && !pane.designId ? `<button type="button" class="history-jump" data-at="${escapeHtml(String(message.timestamp))}">${t('Показать ответ в переписке')}</button>` : ''}
          </div>
        </details>`
    }).join('')
  }

  function unifiedItemHtml(item, pane) {
    const status = Object.hasOwn(BOARD_WORD, item.status) || Object.hasOwn(PLAN_STATUS, item.status) ? item.status : 'todo'
    const statusLabel = BOARD_WORD[status] || PLAN_STATUS[status] || status
    const hasMore = Boolean(item.fullTask || item.note || item.acceptance || item.dependsOn?.length)
    const itemKey = item.id || item.title
    const isOpen = pane?.expandedTaskIds?.has(itemKey)
    // Значок несёт состояние, слово — только там, где значка мало: «в работе»
    // и «заблокировано». «Сделано» и «не начато» видно по кружку.
    const icon = status === 'done' ? TASK_ICONS.done
      : status === 'doing' ? TASK_ICONS.running
      : status === 'blocked' || status === 'disputed' ? TASK_ICONS.problem : TASK_ICONS.todo
    const loud = status === 'doing' || status === 'blocked' || status === 'disputed'

    return `
      <details class="unified-task-node status-${escapeHtml(status)}"${isOpen ? ' open' : ''} data-task-id="${escapeHtml(itemKey)}">
        <summary class="unified-task-summary">
          <span class="task-state-icon state-${escapeHtml(status)}">${icon}</span>
          <span class="unified-task-body">
            <span class="unified-task-title-line">
              <span class="unified-task-title">${escapeHtml(item.title)}</span>
              ${item.agent ? `<span class="unified-task-agent">${escapeHtml(item.agent)}</span>` : ''}
            </span>
            ${item.preview ? `<span class="unified-task-preview">${escapeHtml(item.preview)}</span>` : ''}
          </span>
          ${loud ? `<span class="unified-task-status status-${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>` : `<span class="visually-hidden">${escapeHtml(statusLabel)}</span>`}
          ${hasMore ? `<svg class="unified-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>` : ''}
        </summary>
        ${hasMore ? `
          <div class="unified-task-exp">
            ${item.fullTask && item.fullTask !== item.preview ? `
              <div class="unified-exp-row">
                <span class="unified-exp-label">${t('Задание')}</span>
                <div class="unified-exp-text">${escapeHtml(item.fullTask)}</div>
              </div>` : ''}
            ${item.acceptance ? `
              <div class="unified-exp-row">
                <span class="unified-exp-label">${t('Готово, когда')}</span>
                <div class="unified-exp-text">${escapeHtml(item.acceptance)}</div>
              </div>` : ''}
            ${item.note ? `
              <div class="unified-exp-row unified-exp-note">
                <span class="unified-exp-label">${t('Отчёт')}</span>
                <div class="unified-exp-text">${escapeHtml(item.note)}</div>
              </div>` : ''}
            ${item.dependsOn?.length ? `
              <div class="unified-exp-row">
                <span class="unified-exp-label">${t('После')}</span>
                <div class="unified-exp-text">${escapeHtml(item.dependsOn.join(', '))}</div>
              </div>` : ''}
          </div>` : ''}
      </details>`
  }

  // Слежение за вкладками браузера — фоновые задачи этого чата (модель начинает их инструментом
  // watch_page). Живут между ходами, пока их не остановят здесь или словами «хватит следить».
  let watchesSubscribed = false
  function chatWatches(pane) {
    const registry = root.OnlyonePageWatches
    if (!registry) return []
    if (!watchesSubscribed) { watchesSubscribed = true; registry.subscribe(() => refreshTasksPanel()) }
    return registry.list(pane?.chatId || '')
  }

  function watchesHtml(pane) {
    const list = chatWatches(pane)
    if (!list.length) return ''
    const rows = list.map(watch => {
      let host = watch.url
      try { host = new URL(watch.url).host } catch { /* показываем как есть */ }
      const rule = watch.mode === 'text' ? `${t('когда появится')} «${watch.pattern}»` : t('при любом изменении страницы')
      const woke = watch.wakeCount ? ` · ${t('будила')} ${watch.wakeCount}` : ''
      return `<div class="watch-row">
        <span class="watch-dot" aria-hidden="true"></span>
        <div class="watch-text"><b>${escapeHtml(host)}</b><span>${escapeHtml(rule)}${escapeHtml(woke)}</span>${watch.instruction ? `<em>${escapeHtml(cutOnWord(watch.instruction, 110))}</em>` : ''}</div>
        <button type="button" class="tasks-icon-btn" data-watch-stop="${escapeHtml(watch.id)}" data-tooltip="${t('Остановить слежение')}" aria-label="${t('Остановить слежение')}">
          <svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>
        </button>
      </div>`
    }).join('')
    return `<section class="tasks-block tasks-watches"><div class="tasks-block-head"><span class="tasks-block-title">${t('Слежение за страницами')}</span><span class="tasks-block-count">${list.length}</span></div>${rows}</section>`
  }

  function boardSectionHtml(pane) {
    const board = pane.board
    const messages = Array.isArray(board?.messages) ? board.messages : []
    const pending = messages.filter(m => (m.kind === 'question' || m.kind === 'objection') && !m.answered)
    if (!pending.length) return ''

    return `
      <section class="tasks-block board-letters">
        <div class="tasks-block-head"><span class="tasks-block-title">${t('Ждут ответа')}</span><span class="tasks-block-count">${pending.length}</span></div>
        ${pending.map(m => `
          <div class="board-letter">
            <div class="board-letter-line">
              <span class="board-letter-kind">${m.kind === 'objection' ? t('Возражение') : t('Вопрос')}</span>
              <span class="board-letter-who">${escapeHtml(m.from || '')} → ${escapeHtml(m.to || '')}</span>
            </div>
            <div class="board-letter-body">${escapeHtml(String(m.body || '').slice(0, 200))}</div>
          </div>`).join('')}
      </section>`
  }

  function planSectionsHtml(pane) {
    const tasks = allTasks(pane)
    const orphans = [...(pane.planByAgent || new Map())]
      .filter(([, list]) => Array.isArray(list) && list.length)
      .filter(([agent, list]) => !tasks.some(task => planOfTask(pane, task)?.items === list))
      .flatMap(([agent, list]) => stepItems(list, agent))
    const items = [...unifiedPlanItems(pane), ...orphans]
    if (!items.length) return ''
    const open = pane.planOpen !== false
    const done = items.filter(step => step.status === 'done').length
    const pct = items.length ? Math.round((done / items.length) * 100) : 0

    return `
      <section class="tasks-block">
        <button type="button" class="tasks-section-toggle tasks-block-head" data-fold="plan" aria-expanded="${open}">
          <svg class="tasks-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
          <span class="tasks-section-name tasks-block-title">${pane.board?.items?.length ? t('Поручения') : t('План')}</span>
          <span class="tasks-section-count">${done} / ${items.length}</span>
        </button>
        <div class="tasks-plan-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${items.length}" aria-valuenow="${done}"><span style="width:${pct}%"></span></div>
        ${open ? `<div class="tasks-plan">${items.map(it => unifiedItemHtml(it, pane)).join('')}</div>` : ''}
      </section>`
  }

  function settleAgentTasks(pane) {
    for (const task of pane?.agentTasks?.values() || []) {
      if (!task.done) {
        task.outcome = task.taskTitle === 'Ожидает назначения' ? 'not-started' : 'interrupted'
        task.done = true
      }
      task.waiting = false
    }
  }

  function completeAgentTask(pane, response) {
    const task = agentTaskState(pane, response?.agentIndex ?? 0, response?.agentName)
    task.endedAt = Date.now()
    task.done = true
    task.waiting = false
    task.outcome = response?.aborted ? 'interrupted'
      : response?.incomplete ? 'incomplete' : response?.ok === false ? 'failed' : 'done'
  }

  function taskEndLabel(task) {
    return ({ interrupted: 'Прервано', 'not-started': 'Не запускался', incomplete: 'Не завершено', failed: 'Ошибка' })[task.outcome] || t('готово')
  }

  // Строка агента. Первая строка — сама работа: у одиночного хода это просьба
  // человека, у ведущего команды — его роль, у помощника — поручение. Раньше
  // одиночный ход подписывался «Разбор задачи и координация», хотя никакой
  // команды не было.
  function taskCard(task, pane) {
    const team = allTasks(pane).length > 1 || Boolean(pane?.board?.items?.length)
    let headline = ''
    if (task.taskTitle) headline = task.taskTitle
    else if (task.index === 0 || task.name === 'Агент 1') headline = team ? t('Ведёт команду') : (lastAskOf(pane) || t('Ответ'))
    else if (task.assignment) headline = extractTaskTitle(task.assignment) || task.assignment.slice(0, 50)
    else if (task.name && !/^Агент \d+$/.test(task.name)) headline = task.name
    else headline = task.what || t('готовится')

    const state = taskState(task)
    const model = String(task.model || '')
    const shortModel = model.includes('/') ? (model.split('/').pop() || model) : model
    // У одиночного хода «Агент 1» ничего не сообщает — там важна модель.
    const who = team
      ? [task.name || t('Агент'), shortModel].filter(Boolean).join(' · ')
      : shortModel
    const spend = task.tokens ? `${formatTokens(task.tokens)} ${t('ток.')}` : ''
    const now = !task.done && task.what && task.what !== headline ? task.what : ''
    return `
      <div class="task-card state-${state}${task.done ? ' done' : ''}${task.waiting ? ' waiting' : ''}">
        <span class="task-state-icon state-${state}">${TASK_ICONS[state]}</span>
        <div class="task-card-main">
          <div class="task-headline">${escapeHtml(headline)}</div>
          <div class="task-who">
            <span class="task-agent">${escapeHtml(who)}</span>
            <span class="task-time">${task.done ? escapeHtml(taskEndLabel(task)) : elapsedText(task.since)}</span>
          </div>
          ${task.waiting ? `<div class="task-waiting">${t('Ждёт вашего разрешения')}</div>` : ''}
          ${now ? `<div class="task-now">${escapeHtml(now)}</div>` : ''}
          ${task.preview && !task.done && task.preview !== task.what ? `<div class="task-preview">${escapeHtml(task.preview)}</div>` : ''}
          ${task.done && spend ? `<div class="task-spend">${escapeHtml(spend)}</div>` : ''}
          ${task.checklistHtml || ''}
        </div>
      </div>`
  }

  // Строка состояния в шапке: одна осмысленная фраза вместо голого числа —
  // её же зачитает экранный диктор (ui-ux-pro-max, «Contextual Live Badge»).
  function tasksStatus(pane, tasks, running) {
    if (pane.generating) {
      if (tasks.some(task => task.waiting)) return { state: 'waiting', text: t('Ждёт вас') }
      // В узкой панели «Работают 3 агента» не помещается рядом с кнопками;
      // крутящийся значок уже говорит «работают», слово остаётся диктору.
      if (running.length > 1) return { state: 'running', lead: t('Работают'), text: agentsWord(running.length) }
      const since = running[0]?.since || tasks[0]?.since || Date.now()
      return { state: 'running', text: `${t('Идёт')} · ${elapsedText(since)}` }
    }
    if (!tasks.length) return null
    const seconds = pane.tasksFinishedDuration || Math.max(1, Math.round((Date.now() - (tasks[0]?.since || Date.now())) / 1000))
    const troubled = tasks.some(task => taskState(task) === 'problem')
    return troubled
      ? { state: 'problem', text: `${t('Есть проблемы')} · ${formatDuration(seconds)}` }
      : { state: 'done', text: `${t('Готово')} · ${formatDuration(seconds)}` }
  }

  function renderAgentTasks(pane) {
    if (!pane) return
    const tasks = allTasks(pane)
    if (!pane.generating && tasks.length && !pane.tasksFinishedDuration) {
      const earliest = tasks.reduce((first, t) => Math.min(first, t.since || Date.now()), Date.now())
      pane.tasksFinishedDuration = Math.max(1, Math.round((Date.now() - earliest) / 1000))
    }
    const running = pane.generating ? tasks.filter(t => !t.done) : []

    renderTasksHeaderButton(pane)
    updateLiveMeta(pane)

    if (pane !== panelPane()) {
      clearInterval(pane.agentTaskTimer)
      pane.agentTaskTimer = null
      return
    }

    for (const task of tasks) task.checklistHtml = checklistHtml(pane, task)
    // Панель этого чата (макет 20.10): агенты хода и консоль; «Истории», доски и задач других чатов в ней нет
    const watchHtml = watchesHtml(pane)

    let panel = $('tasksPanel')
    if (!pane.tasksOpen) {
      panel?.remove()
      document.body.classList.remove('tasks-open')
      clearInterval(pane.agentTaskTimer)
      pane.agentTaskTimer = null
      return
    }
    if (!panel) {
      panel = document.createElement('aside')
      panel.id = 'tasksPanel'
      panel.className = 'tasks-panel mk tasks-drawer'
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-labelledby', 'tasksTitle')
      document.body.appendChild(panel)
      bindPanel(panel)
      loadConsole()
    }
    // Панель может быть скрыта настройкой или оболочкой Ultra (`--work-panel-display: none`): место под неё
    // резервируется, только пока она видна, иначе справа остаётся мёртвая полоса шириной в панель.
    document.body.classList.toggle('tasks-open', getComputedStyle(panel).display !== 'none')
    // Хозяин панели — тот чат, который её нарисовал: обработчики берут его отсюда
    panel.__pane = pane

    const tab = pane.tasksTab === 'console' ? 'console' : 'agents'
    const procs = consoleOf(pane)
    const signature = JSON.stringify([tab, pane.tasksProc, pane.generating, pane.tasksFinishedDuration, [...(pane.agentPlanOpen || [])], [...(pane.agentPlanShut || [])], [...(pane.agentStopping || [])],
      watchHtml, tasks.map(task => [task.name, task.model, task.what, task.done, task.waiting, task.outcome, task.checklistHtml]),
      procs.map(p => [p.id, p.state, p.id === pane.tasksProc ? p.log.length : 0, p.title])])
    if (panel.dataset.signature === signature) {
      // Та же картина — меняются только часы хода
      const tick = panel.querySelector('[data-tick]')
      if (tick && pane.generating) tick.textContent = clockOf(runStartOf(tasks))
      return
    }
    panel.dataset.signature = signature
    const scroll = panel.querySelector('.td-body')
    const savedTop = scroll ? scroll.scrollTop : 0
    const heldFocus = rememberPanelFocus(panel)
    const K = root.OnlyoneMk
    const busyN = running.filter(task => !task.waiting).length + tasks.filter(task => task.waiting).length
    const liveProcs = procs.filter(p => p.state === 'running').length
    const sub = tasks.length
      ? `${agentsWord(tasks.length)}${pane.generating && busyN ? `, ${t('%s в работе', busyN)}` : ''}`
      : t('Сейчас ничего не идёт')
    panel.innerHTML = `<header class="drawer-head"><div class="drawer-ttl"><h2 id="tasksTitle">${escapeHtml(t('Задачи'))}</h2><div class="drawer-sub" aria-live="polite">${escapeHtml(sub)}</div></div>` +
      `<button class="btn-secondary tasks-configurations" type="button">${escapeHtml(t('Конфигурации'))}</button><button class="ibtn tasks-close" type="button" data-tx="close" aria-label="${escapeHtml(t('Закрыть'))}" data-tooltip="${escapeHtml(t('Закрыть'))}">${K.ico('close')}</button></header>` +
      `<div class="td-tabs"><span class="seg" role="group" aria-label="${escapeHtml(t('Раздел задач'))}">${[['agents', t('Агенты'), pane.generating ? busyN : 0], ['console', t('Консоль'), liveProcs]]
        .map(([v, label, n]) => `<button type="button" data-tx="tab" data-v="${v}" aria-pressed="${v === tab}">${escapeHtml(label)}${n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</span></div>` +
      `<div class="td-body tasks-scroll">${tab === 'agents' ? agentsHtml(pane, tasks, watchHtml) : consoleHtml(pane, procs)}</div>`
    panel.querySelector('.tasks-configurations')?.addEventListener('click', event => { void root.OnlyoneRunConfigurations.open({ t, opener: event.currentTarget, parameters: configurationParameters }) })
    const fresh = panel.querySelector('.td-body')
    if (fresh) fresh.scrollTop = savedTop
    restorePanelFocus(panel, heldFocus)

    if (pane.generating && running.length) {
      if (!pane.agentTaskTimer) pane.agentTaskTimer = setInterval(() => renderAgentTasks(pane), 1000)
    } else if (pane.agentTaskTimer) {
      clearInterval(pane.agentTaskTimer)
      pane.agentTaskTimer = null
    }
  }

  // ── Агенты хода: состояние, имя и модель, что делает; план раскрывается под строкой ──
  const clockOf = since => { const s = Math.max(0, Math.round((Date.now() - since) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  const runStartOf = tasks => tasks.reduce((first, task) => Math.min(first, task.since || Date.now()), Date.now())
  const ICON = {
    now: '<span class="st-ico"><span class="dot dot-now"></span></span>',
    next: '<span class="st-ico"><span class="dot"></span></span>',
    stop: '<span class="st-ico"><span class="dash"></span></span>'
  }
  const iconFor = s => ICON[s] || `<span class="st-ico">${root.OnlyoneMk.ico(s === 'done' ? 'check' : s === 'wait' ? 'clock' : 'alert', s === 'done' ? 'ok' : s === 'wait' ? 'warn' : 'bad')}</span>`
  function agentState(pane, task) {
    if ((pane.agentStopping || new Set()).has(task.name)) return 'stop'
    if (task.waiting) return 'wait'
    if (!task.done) return 'now'
    return taskState(task) === 'problem' ? 'fail' : 'done'
  }
  function agentsHtml(pane, tasks, watchHtml) {
    const K = root.OnlyoneMk
    if (!tasks.length) return (watchHtml || '') + `<section class="state"><h2>${escapeHtml(t('Агенты сейчас не работают'))}</h2><p>${escapeHtml(t('Когда агент возьмёт задачу в этом чате, здесь будет видно, кто чем занят и по какому плану.'))}</p></section>`
    const team = tasks.length > 1
    const status = pane.generating
      ? `<b>${escapeHtml(t('Ход идёт'))}</b> <span data-tick>${clockOf(runStartOf(tasks))}</span>`
      : escapeHtml(tasksStatus(pane, tasks, [])?.text || t('Ход закончен'))
    const rows = tasks.map(task => {
      const s = agentState(pane, task)
      const plan = planOfTask(pane, task)
      const steps = plan ? stepItems(plan.items, plan.agent) : []
      const open = (pane.agentPlanOpen || new Set()).has(task.index) || (Boolean(pane.generating) && !(pane.agentPlanShut || new Set()).has(task.index))
      const model = String(task.model || '')
      const shortModel = model.includes('/') ? (model.split('/').pop() || model) : model
      // У законченного агента галочка уже говорит «готово»: строка отдана тому, что он делал, и времени.
      // Слово исхода остаётся, только когда исход не обычный (прервано, ошибка).
      const took = task.done && task.since && task.endedAt ? formatDuration((task.endedAt - task.since) / 1000) : ''
      const did = task.taskTitle && task.taskTitle !== 'Ожидает назначения' ? task.taskTitle : ''
      const now = s === 'stop' ? t('Остановится через несколько секунд — можно вернуть')
        : task.waiting ? t('Ждёт вашего разрешения')
          : task.done ? [s === 'fail' || !did ? taskEndLabel(task) : '', did, took].filter(Boolean).join(' · ') : (task.what || t('готовится'))
      const stepS = st => st === 'done' ? 'done' : st === 'doing' ? 'now' : st === 'blocked' ? 'fail' : 'next'
      // Остановить можно одного помощника, пока он работает; ведущего — только вместе с ходом
      const act = pane.generating && team && task.index > 0 && s === 'now'
        ? K.L(t('Остановить'), { attrs: ` data-tx="agstop" data-name="${escapeHtml(task.name)}" data-tooltip="${escapeHtml(t('Только этого агента — остальные работают дальше'))}"` })
        : s === 'stop' ? K.L(t('Вернуть'), { accent: true, attrs: ` data-tx="agback" data-name="${escapeHtml(task.name)}"` }) : ''
      return `<li class="ag" data-agent="${task.index}" data-state="${s === 'now' ? 'now' : s === 'done' ? 'done' : s === 'stop' ? 'stopped' : s}">${iconFor(s)}<div class="ag-main">` +
        `<div class="ag-top"><b>${escapeHtml(task.name || t('Агент'))}</b>${shortModel ? `<span class="ag-model">${escapeHtml(shortModel)}</span>` : ''}` +
        (steps.length ? `<button class="fold-btn" type="button" data-tx="agplan" data-i="${task.index}" aria-expanded="${open}">${K.ico('chevR')}<span>${escapeHtml(t('План, %s из %s', steps.filter(x => x.status === 'done').length, steps.length))}</span></button>` : '') + `</div>` +
        `<p class="ag-now">${escapeHtml(now)}</p>` +
        (steps.length && open ? `<ol class="ag-plan" aria-label="${escapeHtml(t('План: %s', task.name || ''))}">${steps.map(x => `<li data-s="${stepS(x.status)}">${iconFor(stepS(x.status))}<span>${escapeHtml(x.title)}</span></li>`).join('')}</ol>` : '') +
        `</div><div class="ag-act">${act}</div></li>`
    }).join('')
    return (watchHtml || '') + `<section class="rc" data-live="${Boolean(pane.generating)}"><div class="rc-head"><span class="rc-state">${status}</span>` +
      (pane.generating ? K.L(t('Остановить всех'), { danger: true, attrs: ' data-tx="runstop"' }) : '') +
      `</div><ul class="ag-list" aria-label="${escapeHtml(t('Агенты хода'))}">${rows}</ul></section>`
  }

  // ── Консоль: процессы, которые агенты этого чата оставили работать (и команды хода) ──
  let consoleCards = []
  let consoleTimer = 0
  async function loadConsole() {
    try { const r = await root.electronAPI?.getTasks?.(); consoleCards = Array.isArray(r?.tasks) ? r.tasks : consoleCards } catch { /* консоль — подсказка, а не условие показа */ }
    const pane = panelPane()
    if (pane?.tasksOpen) renderAgentTasks(pane)
  }
  let consoleWired = false
  function wireConsole() {
    if (consoleWired || !root.electronAPI?.onTaskEvent) return
    consoleWired = true
    // Событие несёт только изменившиеся карточки (и не говорит об удалённых): список берётся целиком, не чаще раза в 300 мс
    root.electronAPI.onTaskEvent(() => { clearTimeout(consoleTimer); consoleTimer = setTimeout(loadConsole, 300) })
  }
  function consoleOf(pane) {
    wireConsole()
    const chat = chatOf(pane)
    if (!chat) return []
    return consoleCards.filter(card => card.chatId === chat.id && (card.kind === 'process' || card.kind === 'command'))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  }
  const procName = p => String(p.title || '').replace(/^Команда:\s*/, '')
  const procS = p => p.state === 'running' ? 'run' : p.state === 'queued' ? 'queue' : p.state === 'error' ? 'fail' : p.state === 'interrupted' || p.state === 'paused' ? 'stop' : 'done'
  const PS = '<span class="pr-ps" aria-hidden="true">$</span>'
  function procIco(s) { return s === 'run' ? ICON.now : s === 'queue' ? `<span class="st-ico">${root.OnlyoneMk.ico('clock', 'mute')}</span>` : s === 'fail' ? iconFor('fail') : s === 'done' ? iconFor('done') : ICON.stop }
  function procAct(p) {
    const s = procS(p)
    if (s === 'run') return `<button class="pr-kill" type="button" data-tx="prkill" data-id="${escapeHtml(p.id)}">${escapeHtml(t('Завершить'))}</button>`
    return `<button class="pr-drop" type="button" data-tx="${s === 'queue' ? 'prkill' : 'prdrop'}" data-id="${escapeHtml(p.id)}">${escapeHtml(s === 'queue' ? t('Убрать из очереди') : t('Убрать'))}</button>`
  }
  // Строка вывода: эхо npm («> …») тусклым, ошибки красным, успех зелёным
  function outLine(line) {
    const cls = /^>\s/.test(line) ? 'echo' : /(error|failed|fail\b|✗|×|ошибк|не удалось|exited with code [1-9])/i.test(line) ? 'bad' : /(✓|passed|\bready\b|готово|успешно|\bok\b)/i.test(line) ? 'ok' : ''
    return `<span${cls ? ` class="${cls}"` : ''}>${escapeHtml(line)}</span>`
  }
  function consoleHtml(pane, procs) {
    const K = root.OnlyoneMk
    const open = pane.tasksProc && procs.find(p => p.id === pane.tasksProc)
    if (open) {
      const s = procS(open), lines = open.log.filter(line => !/^попытка №\d+$/.test(line))
      return `<div class="pr-view" data-proc="${escapeHtml(open.id)}" data-state="${s}"><button class="pr-back" type="button" data-tx="prback">${K.ico('back', 'i-sm')}${escapeHtml(t('Консоль'))}</button>` +
        `<div class="pr-view-bar"><h3>${escapeHtml(procName(open))}</h3>${procAct(open)}</div>` +
        `<div class="pr-out term" role="log" aria-label="${escapeHtml(t('Вывод: %s', procName(open)))}"><span class="cmd">${PS}${escapeHtml(procName(open))}</span>` +
        (lines.length ? lines.map(outLine).join('') : `<span class="echo">${escapeHtml(s === 'queue' ? t('Ещё не запущен: ждёт свободного места в очереди.') : t('Вывода пока нет.'))}</span>`) +
        (s === 'run' ? '<span><i class="pr-cur" aria-hidden="true"></i></span>' : '') + '</div></div>'
    }
    if (!procs.length) return `<section class="state"><h2>${escapeHtml(t('Консоль пуста'))}</h2><p>${escapeHtml(t('Здесь будут команды, которые агенты этого чата оставили работать: сервер, тесты в слежении, сборка.'))}</p></section>`
    const run = procs.filter(p => p.state === 'running').length, q = procs.filter(p => p.state === 'queued').length
    return `<div class="pr-sum"><span>${escapeHtml(run ? t('Идут %s из %s', run, 3) + (q ? t(', %s в очереди', q) : '') : t('Сейчас ничего не запущено'))}</span>` +
      K.L(t('Завершить все'), { danger: true, dis: !run, attrs: ' data-tx="prkillall"' }) + `</div>` +
      `<ul class="pr-list term">${procs.map(p => `<li class="pr" data-proc="${escapeHtml(p.id)}" data-state="${procS(p)}"><button class="pr-open" type="button" data-tx="propen" data-id="${escapeHtml(p.id)}" data-tooltip="${escapeHtml(t('Открыть вывод'))}">${procIco(procS(p))}<span class="pr-cmd">${PS}${escapeHtml(procName(p))}</span></button>${procAct(p)}</li>`).join('')}</ul>`
  }

  // Одно делегирование на панель: она пересобирается, обработчики — нет
  function bindPanel(panel) {
    panel.addEventListener('click', async e => {
      const watchStop = e.target.closest('[data-watch-stop]')
      if (watchStop) { root.OnlyonePageWatches?.stop(watchStop.dataset.watchStop); return }
      const a = e.target.closest('[data-tx]')
      if (!a || a.disabled) return
      const pane = panel.__pane || panelPane()
      if (!pane) return
      const x = a.dataset.tx
      if (x === 'close') { pane.tasksDismissed = true; toggleTasksPanel(pane, false); el.navTasks?.focus(); return }
      if (x === 'tab') { pane.tasksTab = a.dataset.v; pane.tasksProc = null; if (a.dataset.v === 'console') loadConsole(); renderAgentTasks(pane); panel.querySelector(`[data-tx="tab"][data-v="${a.dataset.v}"]`)?.focus(); root.OnlyoneMk.springIn(panel.querySelector('.td-body'), 'soft', { transform: 'translateY(4px)', opacity: 0 }); return }
      if (x === 'agplan') {
        const i = Number(a.dataset.i), wasOpen = a.getAttribute('aria-expanded') === 'true'
        pane.agentPlanOpen = pane.agentPlanOpen || new Set(); pane.agentPlanShut = pane.agentPlanShut || new Set()
        if (wasOpen) { pane.agentPlanOpen.delete(i); pane.agentPlanShut.add(i) } else { pane.agentPlanOpen.add(i); pane.agentPlanShut.delete(i) }
        renderAgentTasks(pane); panel.querySelector(`[data-tx="agplan"][data-i="${i}"]`)?.focus(); return
      }
      if (x === 'runstop') { pane.designId ? stopDesignRun() : stopTurn(pane); return }
      if (x === 'agstop') {
        // Остановка через 8 с: столько же живёт «Вернуть» в уведомлении
        const name = a.dataset.name
        pane.agentStopping = pane.agentStopping || new Set()
        pane.agentStopping.add(name)
        pane.agentStopTimers = pane.agentStopTimers || new Map()
        clearTimeout(pane.agentStopTimers.get(name))
        pane.agentStopTimers.set(name, setTimeout(() => {
          pane.agentStopping.delete(name); pane.agentStopTimers.delete(name)
          root.electronAPI?.stopAgent?.({ requestId: pane.requestId, name })
          renderAgentTasks(pane)
        }, 8000))
        renderAgentTasks(pane)
        showToast(t('«%s» остановится — остальные работают дальше', name), false, { undo: () => X_back(pane, name) })
        return
      }
      if (x === 'agback') { X_back(pane, a.dataset.name); return }
      if (x === 'propen') { pane.tasksProc = a.dataset.id; renderAgentTasks(pane); panel.querySelector('[data-tx="prback"]')?.focus(); return }
      if (x === 'prback') { const id = pane.tasksProc; pane.tasksProc = null; renderAgentTasks(pane); panel.querySelector(`[data-tx="propen"][data-id="${CSS.escape(id || '')}"]`)?.focus(); return }
      if (x === 'prkill') { a.disabled = true; await root.electronAPI?.cancelTask?.(a.dataset.id); loadConsole(); return }
      if (x === 'prdrop') { await root.electronAPI?.removeTask?.(a.dataset.id); if (pane.tasksProc === a.dataset.id) pane.tasksProc = null; await loadConsole(); return }
      if (x === 'prkillall') {
        const live = consoleOf(pane).filter(p => p.state === 'running' || p.state === 'queued')
        if (!live.length) return
        const ok = await (root.__askConfirm ? root.__askConfirm(t('Завершить все процессы этого чата (%s)? Серверы и слежение остановятся.', live.length), t('Завершить все')) : Promise.resolve(true))
        if (!ok) return
        for (const p of live) await root.electronAPI?.cancelTask?.(p.id)
        loadConsole()
      }
    })
    panel.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return
      const pane = panel.__pane || panelPane()
      if (!pane) return
      e.preventDefault(); e.stopPropagation()
      pane.tasksDismissed = true
      toggleTasksPanel(pane, false)
      el.navTasks?.focus()
    })
  }
  function X_back(pane, name) {
    clearTimeout(pane.agentStopTimers?.get(name))
    pane.agentStopTimers?.delete(name)
    pane.agentStopping?.delete(name)
    renderAgentTasks(pane)
  }

  // Вход в панель — в заголовке чата. Заголовок один на окно, поэтому кнопка
  // всегда говорит про ту панель чата, в которой человек сейчас работает.
  function renderTasksHeaderButton(source) {
    // В чате кнопка ОДНА — «Задачи» (слово владельца 04.10, В3-10): она открывает панель
    // работы именно этого чата, счётчик показывает его работающих агентов. Прежняя вторая
    // половина таблетки («Работа агентов») убрана. В Ultra задачи — свободный блок оболочки,
    // в Design — свой ряд кнопок.
    if (!el.designView?.classList.contains('active')) {
      document.querySelectorAll('#chatHeader .tasks-header-btn').forEach(old => old.remove())
      const nav = $('navTasks')
      const own = panelPane()
      if (!nav || document.documentElement.dataset.versionPreset === 'ultra') return
      const live = (own?.generating ? allTasks(own).filter(task => !task.done).length : 0) + chatWatches(own).length
      const badge = $('taskCenterBadge')
      if (badge) {
        badge.textContent = String(live)
        badge.hidden = !live
        // Число цветом --warn, если кто-то ждёт ответа (макет 19.10)
        badge.classList.toggle('is-waiting', Boolean(own?.generating && allTasks(own).some(task => task && task.waiting && !task.done)))
      }
      nav.classList.toggle('is-live', Boolean(live))
      nav.setAttribute('aria-pressed', String(Boolean(own?.tasksOpen)))
      return
    }
    const host = el.designView?.classList.contains('active')
      ? $('designTaskActions') : (document.querySelector('#chatHeader #taskPill') || document.querySelector('#chatHeader .chat-header-actions'))
    if (!host) return
    // Заголовок один на окно и говорит про открытый чат. Фоновая панель чата
    // его не трогает — иначе счётчик показывал бы чужую работу.
    // Заголовок один на окно и говорит только про открытый чат. Раньше сюда
    // пролезал фоновый: в заголовке горел его счётчик, а клик по счётчику
    // стирал панель, потому что у открытого чата задач не было.
    const pane = panelPane()
    let btn = host.querySelector('.tasks-header-btn')

    const tasks = allTasks(pane)
    // Кнопка остаётся и после хода: работа, которая уже кончилась, — это то, что
    // хочется посмотреть потом, и уходить вместе с ходом кнопке незачем.
    const hasWork = Boolean(tasks.length || (pane?.planByAgent && pane.planByAgent.size) ||
      (pane?.board?.items || []).length || runsOf(pane).length)
    if (!hasWork) {
      btn?.remove()
      return
    }

    if (!btn) {
      btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn-icon tasks-header-btn'
      btn.dataset.tooltip = 'Работа агентов'
      btn?.removeAttribute?.('title')
      btn.setAttribute('aria-label', 'Работа агентов')
      // Значок «агенты» из дизайн-системы: у двух соседних кнопок был один и тот же
      // список, и по виду было не понять, чем они отличаются.
      btn.innerHTML = '<svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.6" cy="5.4" r="2"/><circle cx="11" cy="6.2" r="1.6"/><path d="M2.2 12.8c.4-1.8 1.7-2.9 3.4-2.9s3 1.1 3.4 2.9M9.6 10.2c.4-.2.9-.3 1.4-.3 1.4 0 2.4.9 2.8 2.4"/></svg>' +
        '<span class="tasks-header-count" hidden></span>'
      btn.addEventListener('click', () => toggleTasksPanel(panelPane()))
      host.insertBefore(btn, host.firstChild)
    }

    const running = pane?.generating ? tasks.filter(task => !task.done).length : 0
    const badge = btn.querySelector('.tasks-header-count')
    badge.textContent = running ? String(running) : ''
    badge.hidden = !running
    btn.classList.toggle('is-live', Boolean(running))
    btn.setAttribute('aria-pressed', String(Boolean(pane?.tasksOpen)))
  }

  function clearAgentTasks(pane) {
    pane.agentTasks = new Map()
    pane.planByAgent = new Map()
    pane.planOwner = new Map()
    pane.lanes = new Map()
    // Новый ход открывается на том, что происходит сейчас, а не на истории,
    // которую смотрели в прошлый раз.
    pane.tasksTab = 'now'
    pane.board = null
    pane.tasksDismissed = false
    pane.tasksFinishedDuration = null
    clearInterval(pane.agentTaskTimer)
    pane.agentTaskTimer = null
    // The panel moved out of the message and into its own element; this line
    // was still hunting for the old one, so the previous turn's tasks stayed on
    // screen until the first event of the new turn redrew them.
    if (pane === panelPane()) {
      $('tasksPanel')?.remove()
      document.body.classList.remove('tasks-open')
    }
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneWorkPanel = api
})(typeof window === 'object' ? window : globalThis)
