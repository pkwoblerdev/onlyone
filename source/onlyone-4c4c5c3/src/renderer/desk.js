/* Desk is a view of the main-process model; embedded content never receives its preload.

   Вид — по макету 25.10 (audits/ui-2026-10-18/desk): шапка с именем среды и
   тремя значками, блок без рамок кнопок (статус только у не готового, действия
   — меню «…»), шторки «Файлы и процессы», «Моды», «Обмен раскладкой»,
   уведомление с «Вернуть» вместо постоянной строки состояния, узкое окно —
   блоки по одному. */
(function () {
  'use strict'
  const api = window.deskAPI
  const $ = id => document.getElementById(id)
  const canvas = $('desk-canvas')
  const status = $('desk-status')
  const watchToggle = $('desk-watch-toggle')
  const watchPanel = $('desk-watch-panel')
  const budgetToggle = $('desk-budget-toggle')
  const budgetPanel = $('desk-budget-panel')
  const watchList = $('desk-watch-list')
  const watchRecent = $('desk-watch-recent')
  const watchCount = $('desk-watch-count')
  const processList = $('desk-process-list')
  const menu = $('desk-menu')
  const bodies = new Map()
  const GAP = 16
  const NARROW = 900
  const UNDO_MS = 10000
  let snapshot = null, language = 'ru', gesture = null, loading = 0, watchLoading = 0, saving = false
  let runtime = {}, resources = {}, narrow = false, current = null
  let watchTotal = 0, runningTotal = 0, processItems = [], viewedProcess = null
  let agent = null
  let budgetState = null
  const dismissed = new Set()
  function t (source, ...args) {
    let text = language === 'en' ? (window.__I18N__.en[source] || source) : source
    for (const value of args) text = text.replace('%s', value)
    return text
  }
  function report (source) { status.textContent = t(source) }

  const ICONS = {
    browser: '<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c1.5 1.6 2.2 3.5 2.2 5.6s-.7 4-2.2 5.6c-1.5-1.6-2.2-3.5-2.2-5.6S6.5 4 8 2.4z"/>',
    artifact: '<rect x="2.2" y="3" width="11.6" height="10" rx="2.4"/><path d="M2.2 6.6h11.6"/>',
    output: '<path d="M9 2.2H4.6c-.9 0-1.6.7-1.6 1.6v8.4c0 .9.7 1.6 1.6 1.6h6.8c.9 0 1.6-.7 1.6-1.6V6.2zM9 2.2v4h4"/>',
    process: '<rect x="2.2" y="3" width="11.6" height="10" rx="2.4"/><path d="M5 6.4l1.8 1.6L5 9.6M8.4 9.6H11"/>',
    folder: '<path d="M2.3 5.1c0-.9.7-1.6 1.6-1.6h2l1.4 1.8h5c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H3.9c-.9 0-1.6-.7-1.6-1.6z"/>',
    more: '<circle cx="3.8" cy="8" r=".75"/><circle cx="8" cy="8" r=".75"/><circle cx="12.2" cy="8" r=".75"/>',
    left: '<rect x="2.2" y="3" width="11.6" height="10" rx="2.4"/><path d="M6.4 3v10"/>',
    right: '<rect x="2.2" y="3" width="11.6" height="10" rx="2.4"/><path d="M9.6 3v10"/>',
    bottom: '<rect x="2.2" y="3" width="11.6" height="10" rx="2.4"/><path d="M2.2 9h11.6"/>',
    full: '<path d="M9.6 2.8h3.6v3.6M6.4 13.2H2.8V9.6M13.2 2.8 9.2 6.8M2.8 13.2l4-4"/>',
    reload: '<path d="M12.6 8a4.6 4.6 0 1 1-1.4-3.3M12.8 2.8v2.6h-2.6"/>',
    min: '<path d="M4 11.6h8"/>',
    remove: '<path d="M3.4 4.6h9.2M6.4 4.6V3.4h3.2v1.2M5 4.6l.5 8h5l.5-8"/>',
    chat: '<rect x="2.2" y="3" width="11.6" height="8.6" rx="2.4"/><path d="M5.8 11.6L4.4 14.1v-2.5"/>',
    eye: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/>',
    pause: '<path d="M5.6 3.4v9.2M10.4 3.4v9.2"/>',
    play: '<path d="M5.4 3.6v8.8L12.4 8z"/>',
    stop: '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.6"/>',
    copy: '<rect x="5.4" y="5.4" width="8" height="8" rx="1.8"/><path d="M10.6 5.4V4.2c0-1-.8-1.8-1.8-1.8H4.2c-1 0-1.8.8-1.8 1.8v4.6c0 1 .8 1.8 1.8 1.8h1.2"/>'
  }
  const KIND_ICON = { browser: 'browser', artifact: 'artifact', output: 'output', process: 'process', 'external-app': 'artifact' }
  function icon (name, small = true) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    node.setAttribute('class', 'desk-i' + (small ? ' desk-i14' : ''))
    node.setAttribute('viewBox', '0 0 16 16')
    node.setAttribute('aria-hidden', 'true')
    node.innerHTML = ICONS[name] || ''
    return node
  }
  function el (tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  function actionButton (className, label, iconName, handler) {
    const node = el('button', className)
    node.type = 'button'
    if (iconName) node.append(icon(iconName))
    node.append(document.createTextNode(label))
    if (handler) node.addEventListener('click', handler)
    return node
  }
  const hostOf = url => { try { return new URL(url).host } catch { return '' } }

  // ─── уведомление: ошибка или «Вернуть» ─────────────────────────────────────
  const notice = $('desk-notice'), noticeText = $('desk-notice-text'), noticeUndo = $('desk-notice-undo')
  let noticeTimer = null, pending = null
  function settlePending (commit) {
    const job = pending
    pending = null
    if (!job) return
    clearTimeout(job.timer)
    if (commit) void job.commit()
    else job.cancel()
  }
  function showNotice (source, { undo = null, ms = 5000 } = {}) {
    // Ошибка внутри окна «Вернуть» не коммитит чужое удаление и не прячет отмену:
    // иначе штатный сбой опроса безвозвратно теряет блок (break-3 Н3). Текст ошибки
    // уходит в строку статуса, окно отмены живёт до своего срока.
    if (!undo && pending) { report(source); return }
    settlePending(true)
    clearTimeout(noticeTimer)
    noticeText.textContent = source
    report(source)
    notice.hidden = false
    notice.classList.toggle('has-undo', Boolean(undo))
    noticeUndo.hidden = !undo
    noticeUndo.querySelector('span').textContent = t('Вернуть')
    notice.classList.remove('is-running')
    void notice.offsetWidth
    if (undo) {
      notice.style.setProperty('--desk-undo', ms + 'ms')
      notice.classList.add('is-running')
      pending = { ...undo, timer: setTimeout(() => { hideNotice(); settlePending(true) }, ms) }
    } else noticeTimer = setTimeout(hideNotice, ms)
  }
  function hideNotice () { notice.hidden = true; notice.classList.remove('is-running') }
  function alertUser (source) { showNotice(t(source)) }
  noticeUndo.addEventListener('click', () => { hideNotice(); settlePending(false) })

  // ─── полоса «не сохранилось» ───────────────────────────────────────────────
  const banner = $('desk-banner'), bannerRetry = $('desk-banner-retry')
  let failedOperations = null
  function showBanner (lead, rest, retry) {
    const text = $('desk-banner-text')
    text.replaceChildren(el('b', '', t(lead)), document.createTextNode(' ' + t(rest)))
    bannerRetry.hidden = !retry
    bannerRetry.querySelector('span').textContent = t('Сохранить ещё раз')
    banner.hidden = false
    document.body.classList.add('has-banner')
  }
  function hideBanner () { banner.hidden = true; document.body.classList.remove('has-banner') }
  bannerRetry.addEventListener('click', async () => {
    if (!failedOperations || saving) return
    const operations = failedOperations
    bannerRetry.disabled = true
    saving = true
    let error = null
    try {
      const fresh = await api.read()
      const alive = operations.filter(op => fresh.snapshot.blocks.some(block => block.id === op.id))
      if (!alive.length) { failedOperations = null; hideBanner(); return }
      const result = await api.apply({ operationId: crypto.randomUUID(), expectedRevision: fresh.snapshot.revision, operations: alive })
      if (result.ok) { failedOperations = null; hideBanner() } else error = applyError(result)
    } catch { error = 'Не удалось обновить Desk' }
    finally { saving = false; bannerRetry.disabled = false; await refresh(); if (error) alertUser(error) }
  })

  // ─── Файлы и процессы ──────────────────────────────────────────────────────
  function paintCount () {
    const total = watchTotal + runningTotal
    watchCount.textContent = String(total)
    watchCount.toggleAttribute('data-zero', total === 0)
    watchToggle.setAttribute('aria-label', total ? t('Файлы и процессы: %s', total) : t('Файлы и процессы'))
  }
  function paintWatches (result) {
    if (!result.ok) { alertUser('Не удалось загрузить наблюдения'); return }
    watchList.replaceChildren()
    watchRecent.replaceChildren()
    const watches = Array.isArray(result.watches) ? result.watches : []
    // Одно и то же изменение подряд приходит от наблюдателя несколько раз — в
    // списке оно одной строкой.
    const seen = new Set()
    const recent = (Array.isArray(result.recent) ? result.recent.slice(-40).reverse() : []).filter(item => {
      const key = `${item.path}/${item.name || ''}:${item.change}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 20)
    watchTotal = watches.length
    paintCount()
    const stopAll = $('desk-watch-stop-all')
    stopAll.hidden = watches.length < 2
    stopAll.textContent = t('Остановить все')
    $('desk-watch-folders-title').querySelector('span').textContent = t('Слежение за папками')
    $('desk-watch-empty').hidden = watches.length > 0
    $('desk-watch-empty').textContent = t('Слежения за папками нет')
    $('desk-watch-recent-title').textContent = t('Изменения файлов')
    $('desk-watch-recent-empty').hidden = recent.length > 0
    $('desk-watch-recent-empty').textContent = t('Изменений пока нет')
    for (const item of recent) {
      const row = el('li', 'desk-frow')
      row.append(el('span', '', item.name || item.path), el('span', 'desk-aux', t(item.change === 'rename' ? 'добавлен или удалён' : 'изменён')))
      row.title = `${item.path}${item.name ? `/${item.name}` : ''}`
      watchRecent.append(row)
    }
    for (const item of watches) {
      const row = el('li', 'desk-row desk-watch-item')
      const name = el('span', 'desk-nm desk-watch-path', item.path)
      name.title = item.path
      const stop = actionButton('desk-btn desk-btn-sm desk-watch-stop', t('Остановить'))
      stop.dataset.watchId = item.id
      stop.setAttribute('aria-label', `${t('Остановить слежение')}: ${item.path}`)
      const end = el('span', 'desk-end')
      end.append(stop)
      row.append(icon('folder', false), name, el('span', 'desk-aux desk-watch-scope', t(item.recursive ? 'с подпапками' : 'только эта папка')), end)
      watchList.append(row)
    }
  }
  async function refreshWatches () {
    const sequence = ++watchLoading
    try {
      const result = await api.watches()
      if (sequence === watchLoading) paintWatches(result)
    } catch { if (sequence === watchLoading) paintWatches({ ok: false }) }
  }
  const PROCESS_STATES = { starting: 'Запускается', running: 'Работает', stopping: 'Останавливается', stopped: 'Остановлен', exited: 'Завершён', failed: 'Ошибка запуска', unknown: 'Состояние неизвестно' }
  const LIVE = ['starting', 'running', 'stopping', 'unknown']
  const commandOf = item => [item.command, ...(item.args || [])].map(value => /[\s"]/.test(String(value)) ? JSON.stringify(String(value)) : String(value)).join(' ')
  function paintProcesses (result) {
    if (!result.ok) { alertUser('Не удалось загрузить процессы'); return }
    processItems = Array.isArray(result.processes) ? result.processes.slice(0, 8) : []
    const items = processItems.filter(item => !dismissed.has(item.id))
    runningTotal = processItems.filter(item => LIVE.includes(item.state)).length
    paintCount()
    const empty = $('desk-process-empty')
    empty.hidden = items.length > 0
    empty.textContent = t('Нет процессов')
    $('desk-process-title').textContent = t('Процессы')
    processList.replaceChildren()
    for (const item of items) {
      const live = LIVE.includes(item.state)
      const row = el('li', 'desk-row desk-process-item')
      row.dataset.processId = item.id
      const command = el('button', 'desk-nm desk-process-command' + (live ? '' : ' is-quiet'), commandOf(item))
      command.type = 'button'
      command.dataset.viewProcess = item.id
      command.title = item.cwd || ''
      const state = el('span', 'desk-aux desk-process-state', t(PROCESS_STATES[item.state] || 'Состояние неизвестно'))
      state.hidden = item.state === 'running'
      const end = el('span', 'desk-end')
      if (item.canStop && live) {
        const stop = actionButton('desk-btn desk-btn-sm desk-stop desk-process-stop', t('Завершить'))
        stop.dataset.processId = item.id
        stop.setAttribute('aria-label', `${t('Завершить процесс')}: ${item.command}`)
        end.append(stop)
      } else if (!live) {
        const hide = actionButton('desk-btn desk-btn-sm desk-process-dismiss', t('Убрать'))
        hide.dataset.dismissProcess = item.id
        end.append(hide)
      }
      const output = el('pre', 'desk-process-output', item.output || '')
      output.hidden = true
      row.append(icon('process', false), command, state, end, output)
      processList.append(row)
    }
    if (viewedProcess) paintProcessView()
    // Процесс-блоки на холсте показывают тот же свежий вывод, что и шторка.
    if (snapshot) for (const block of snapshot.blocks) {
      const proc = processOf(block.id)
      if (!proc) continue
      paintTerm(bodies.get(block.id)?.child, proc)
      const head = canvas.querySelector(`.ublock[data-block-id="${CSS.escape(block.id)}"] .ublock-head`)
      if (head) dressHead(head, block)
    }
  }
  async function refreshProcesses () {
    try { paintProcesses(await api.processes()) } catch { paintProcesses({ ok: false }) }
  }
  // Вывод процесса — в той же шторке, со стрелкой назад.
  function paintProcessView () {
    const item = processItems.find(one => one.id === viewedProcess)
    const viewing = Boolean(item)
    $('desk-watch-body').hidden = viewing
    $('desk-process-view').hidden = !viewing
    $('desk-process-back').hidden = !viewing
    $('desk-process-back').querySelector('span').textContent = t('Назад')
    $('desk-watch-title').textContent = viewing ? commandOf(item) : t('Файлы и процессы')
    if (!viewing) { viewedProcess = null; return }
    const out = $('desk-process-output-full')
    const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 8
    out.textContent = item.output || t('Вывода пока нет')
    if (atEnd) out.scrollTop = out.scrollHeight
    const stop = $('desk-process-view-stop')
    stop.hidden = !(item.canStop && LIVE.includes(item.state))
    stop.textContent = t('Завершить')
    stop.dataset.processId = item.id
    $('desk-process-view-copy').textContent = t('Скопировать вывод')
  }

  // ─── ход агента: строка в шапке, кольцо у блока-цели, план сборки ──────────
  const AGENT_DOING = { observe: 'Агент читает «%s»', click: 'Агент нажимает в «%s»', fill: 'Агент заполняет поле в «%s»', scroll: 'Агент листает «%s»', process: 'Агент запускает «%s»' }
  const AGENT_ASKS = { observe: 'прочитать «%s»', click: 'нажать в «%s»', fill: 'заполнить поле в «%s»', scroll: 'пролистать «%s»', process: 'запустить «%s»' }
  const agentLine = $('desk-agent'), agentWhat = $('desk-agent-what'), agentAct = $('desk-agent-act')
  // Блок-цель обводится, пока агент в нём действует или ждёт разрешения; на паузе — нет.
  const agentOn = id => Boolean(agent && !agent.paused && agent.blockId === id && ['acting', 'waiting'].includes(agent.mode))
  function agentText () {
    if (!agent) return null
    if (agent.paused) return { tone: 'idle', text: t('Пауза'), act: 'resume' }
    // Пока человек тянет блок, агент в Desk ничего не делает: правка блока держит его.
    if (gesture) return { tone: 'idle', text: t('Агент ждёт, пока вы двигаете блок'), act: null }
    if (agent.mode === 'waiting') return { tone: 'warn', text: t('Ждёт вашего ответа в Onlyone: %s', t(AGENT_ASKS[agent.action] || AGENT_ASKS.click, agent.target)), act: 'answer' }
    if (agent.mode === 'building') {
      // Шаг идёт, пока его блок грузится; потом — следующий по плану.
      const loadingStep = agent.plan.find(item => item.done && (snapshot?.blocks || []).some(block => block.kind === item.kind && block.title === item.title && runtime[block.id]?.state === 'loading'))
      const next = loadingStep || agent.plan.find(item => !item.done)
      return { tone: 'acc', text: next ? t('Собираю среду: шаг %s из %s, %s', next.step, agent.steps, next.title) : t('Собираю среду'), act: 'stop' }
    }
    return { tone: 'acc', text: t(AGENT_DOING[agent.action] || AGENT_DOING.click, agent.target), act: 'pause' }
  }
  const AGENT_ACTS = { pause: ['Пауза', 'pause'], resume: ['Продолжить', 'play'], stop: ['Остановить сборку', 'stop'], answer: ['Ответить в Onlyone', 'chat'] }
  function paintBudget () {
    const body = $('desk-budget-body')
    if (!body || !window.OnlyoneBudgetDesk) return
    $('desk-budget-title').textContent = t('Бюджет задачи')
    $('desk-budget-close').querySelector('span').textContent = t('Закрыть')
    budgetToggle.setAttribute('aria-label', t('Бюджет задачи'))
    $('desk-budget-label').textContent = t('Бюджет задачи')
    const model = window.OnlyoneBudgetDesk.view({
      snapshot: budgetState?.snapshot || null,
      settings: budgetState?.settings || null,
      refusal: budgetState?.refusal || null,
      now: Date.now(), t
    })
    window.OnlyoneBudgetDesk.paint(body, model)
  }

  function paintAgent () {
    const line = agentText()
    agentLine.hidden = !line
    agentAct.hidden = !line?.act
    if (!line) return
    agentLine.dataset.tone = line.tone
    agentWhat.textContent = line.text
    agentWhat.title = line.text
    if (line.act) {
      const [label, name] = AGENT_ACTS[line.act]
      agentAct.dataset.act = line.act
      agentAct.querySelector('svg').innerHTML = ICONS[name]
      agentAct.querySelector('span').textContent = t(label)
    }
  }
  agentAct.addEventListener('click', async () => {
    const act = agentAct.dataset.act
    agentAct.disabled = true
    try {
      if (act === 'answer') await api.main()
      else {
        const result = act === 'stop' ? await api.stopBuild() : await api.pause(act === 'pause')
        if (!result.ok && result.code !== 'idle') alertUser('Не удалось обновить Desk')
        await refresh()
      }
    } catch { alertUser(act === 'answer' ? 'Не удалось открыть Onlyone' : 'Не удалось обновить Desk') }
    finally { agentAct.disabled = false }
  })
  // Будущие блоки сборки — контуром с номером шага там, где они встанут.
  function paintPlan () {
    canvas.querySelectorAll(':scope > .desk-plan').forEach(node => node.remove())
    for (const item of agent?.plan || []) {
      if (item.done) continue
      const node = el('section', 'desk-plan')
      node.setAttribute('aria-label', t('Будет: %s', item.title))
      Object.assign(node.style, { left: item.rect.x + 'px', top: item.rect.y + 'px', width: item.rect.width + 'px', height: item.rect.height + 'px' })
      const head = el('div', 'desk-plan-head')
      const note = item.note ? t('Шаг %s', item.step) + ', ' + item.note : t(item.kind === 'process' ? 'Шаг %s, спросит разрешение' : 'Шаг %s', item.step)
      head.append(icon(KIND_ICON[item.kind] || 'artifact'), el('span', 'desk-plan-title', item.title), el('span', 'desk-sp'), el('span', 'desk-plan-step', note))
      node.append(head)
      canvas.insertBefore(node, $('desk-dock'))
    }
  }

  // ─── блоки ─────────────────────────────────────────────────────────────────
  const blocks = window.OnlyoneUltraBlocks.create({ document, window, host: () => canvas, t, top: GAP,
    bodyFor: item => bodies.get(item.id)?.node,
    onChange: () => { void commitGeometry() } })
  blocks.mount(canvas)

  function errorState (block, entry, info) {
    const box = el('div', 'desk-es')
    const mark = document.querySelector('.desk-spark').cloneNode(true)
    mark.classList.add('desk-spark-big', 'is-off')
    const host = hostOf(info.url) || block.title
    const acts = el('div', 'desk-es-acts')
    acts.append(actionButton('desk-btn', t('Открыть снова'), 'reload', () => {
      entry.node.classList.remove('is-error')
      box.remove()
      try { entry.child.reload() } catch { entry.child.src = info.url }
    }), actionButton('desk-btn', t('Спросить в Onlyone'), null, () => { void api.main().catch(() => alertUser('Не удалось открыть Onlyone')) }))
    box.append(mark, el('h3', '', t('Сайт не открылся')), el('p', '', t('%s не ответил. Остальные блоки работают.', host)), acts)
    if (info.code) {
      const meta = el('p', 'desk-es-meta', t('Код') + ' ')
      meta.append(el('b', '', info.code))
      box.append(meta)
    }
    return box
  }

  // Вывод процесса пишется в тот же узел: прокрутка у конца держится, у середины — не прыгает.
  function paintTerm (node, item) {
    if (!node || node.tagName !== 'PRE') return
    const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 8
    const line = el('span', 'desk-term-cmd')
    line.append(el('span', 'desk-term-ps', '$'), document.createTextNode(' ' + commandOf(item)))
    node.replaceChildren(line, document.createTextNode('\n' + (item.output || '')))
    if (LIVE.includes(item.state)) node.append(el('i', 'desk-term-cur'))
    if (atEnd) node.scrollTop = node.scrollHeight
  }
  const processOf = id => { const resource = resources[id]; return resource?.type === 'process' && !resource.gone ? processItems.find(item => item.id === resource.id) || resource : null }

  function content (block, resource) {
    const old = bodies.get(block.id)
    const signature = resource?.type === 'process' ? `process:${resource.id}:${resource.gone ? 'gone' : 'live'}:${language}`
      : JSON.stringify(resource) + (!['browser', 'page', 'text', 'portable-page'].includes(resource?.type) ? ':' + language : '')
    if (old?.signature === signature) return old.node
    const node = old?.node || document.createElement('div')
    node.className = 'desk-body'
    let child
    const state = value => {
      const entry = bodies.get(block.id)
      if (entry?.child !== child) return
      void api.state({ id: block.id, revision: entry.revision, state: value }).catch(() => alertUser('Не удалось обновить Desk'))
    }
    if (resource?.type === 'browser') {
      node.classList.add('is-site')
      child = document.createElement('webview')
      child.setAttribute('partition', 'persist:onlyone-browser')
      child.setAttribute('src', resource.url)
      child.addEventListener('dom-ready', () => {
        const entry = bodies.get(block.id)
        if (entry?.child === child) void api.guest({ id: block.id, revision: entry.revision, guestId: child.getWebContentsId() }).catch(() => alertUser('Не удалось обновить Desk'))
      })
      child.addEventListener('did-start-loading', () => state('loading'))
      child.addEventListener('did-stop-loading', () => { if (bodies.get(block.id)?.failed !== true) state('ready') })
      child.addEventListener('did-fail-load', event => {
        if (event.isMainFrame === false || event.errorCode === -3) return
        const entry = bodies.get(block.id)
        if (entry?.child !== child) return
        entry.failed = true
        node.querySelector(':scope > .desk-es')?.remove()
        node.classList.add('is-error')
        node.append(errorState(block, entry, { url: resource.url, code: event.errorDescription || String(event.errorCode || '') }))
        state('error')
      })
      child.addEventListener('did-start-navigation', event => {
        const entry = bodies.get(block.id)
        if (event.isMainFrame && entry?.child === child) { entry.failed = false; node.classList.remove('is-error'); node.querySelector(':scope > .desk-es')?.remove() }
      })
      child.addEventListener('render-process-gone', () => state('stopped'))
    } else if (resource?.type === 'page' || resource?.type === 'portable-page') {
      node.classList.add('is-site')
      child = document.createElement('iframe')
      child.setAttribute('sandbox', 'allow-scripts')
      child.name = 'desk:' + block.id
      child.title = block.title
      child.src = resource.url
      child.addEventListener('load', () => state('ready'))
      child.addEventListener('error', () => state('error'))
    } else if (resource?.type === 'pending') {
      // Импортированный блок: ожидание и отказ — тем же видом, что ошибка, без искорки.
      child = el('section', 'desk-es')
      const acts = el('div', 'desk-es-acts')
      if (resource.portable) {
        child.append(el('p', '', t('Страница перенесена вместе с шаблоном. Внешние адреса и доступ к компьютеру у неё закрыты.')))
        const activate = actionButton('desk-btn', t('Открыть страницу'), 'eye')
        activate.addEventListener('click', async () => {
          activate.disabled = true
          try { const result = await api.activate(block.id); if (result.ok) await refresh(); else alertUser('Не удалось обновить Desk') }
          catch { alertUser('Не удалось обновить Desk') }
          finally { activate.disabled = false }
        })
        acts.append(activate)
        child.append(acts)
        if (resource.dependencies?.length) {
          const names = resource.dependencies.map(hostOf).filter(Boolean)
          const list = [...new Set(names.length ? names : resource.dependencies)].slice(0, 3)
          child.append(el('p', 'desk-es-meta', t('Ей нужны %s — они заблокированы', list.join(', '))))
        }
      } else {
        child.append(el('p', '', t(block.kind === 'browser' ? 'Сайт пришёл без адреса страницы и без ваших входов.' : 'Блок пришёл без содержимого. Привяжите его в Onlyone.')))
        acts.append(actionButton('desk-btn', t('Привязать в Onlyone'), 'chat', () => { void api.main().catch(() => alertUser('Не удалось открыть Onlyone')) }))
        child.append(acts)
      }
    } else if (resource?.type === 'process') {
      // Состояние процесс-блока знает сервис (по менеджеру процессов), окно его не докладывает.
      node.classList.add('is-process')
      if (resource.gone) {
        child = el('section', 'desk-es')
        child.append(el('p', '', t('Процесс остановлен вместе с Desk. Его вывод не сохраняется.')))
      } else {
        child = el('pre', 'desk-term desk-term-block')
        child.setAttribute('role', 'log')
        child.setAttribute('aria-label', t('Вывод: %s', commandOf(resource)))
      }
      bodies.set(block.id, { node, signature, child, revision: block.revision })
      node.replaceChildren(child)
      paintTerm(child, resource)
      return node
    } else {
      child = document.createElement(resource?.type === 'text' ? 'pre' : 'p')
      child.textContent = resource?.type === 'text' ? resource.text : t('Ресурс Desk недоступен')
    }
    bodies.set(block.id, { node, signature, child, revision: block.revision })
    node.replaceChildren(child)
    state(resource?.type === 'pending' ? 'stopped' : resource?.type === 'text' ? 'ready' : ['browser', 'page', 'portable-page'].includes(resource?.type) ? 'loading' : 'error')
    return node
  }

  const STATE_WORDS = { loading: 'Загрузка…', ready: 'Готово', error: 'Ошибка', stopped: 'Остановлено' }
  // Шапка блока: значок вида, имя, адрес, состояние (у готового — нет) и меню.
  function dressHead (head, block) {
    const resource = resources[block.id] || {}
    head.tabIndex = 0
    head.setAttribute('role', 'group')
    head.setAttribute('aria-label', t('Стрелки перемещают блок, Shift и стрелки меняют размер'))
    let kind = head.querySelector('.desk-kind')
    if (!kind) { kind = icon(KIND_ICON[block.kind] || 'artifact'); kind.classList.add('desk-kind'); head.prepend(kind) }
    let meta = head.querySelector('.desk-meta')
    if (!meta) { meta = el('span', 'desk-meta'); head.querySelector('.ublock-title').after(meta) }
    const proc = processOf(block.id)
    meta.textContent = resource.type === 'browser' ? hostOf(resource.url) : resource.type === 'pending' && resource.hint ? resource.hint
      : proc?.cwd ? proc.cwd.split(/[\\/]/).filter(Boolean).pop() || '' : ''
    const badge = head.querySelector('.desk-block-status') || el('span', 'desk-block-status')
    badge.setAttribute('role', 'status')
    const pendingWord = resource.type === 'pending' ? (resource.portable ? 'Не открыт' : 'Не привязан') : ''
    const value = agentOn(block.id) ? (agent.mode === 'waiting' ? 'agent-wait' : 'agent') : pendingWord ? 'pending' : runtime[block.id]?.state || 'loading'
    badge.dataset.state = value
    badge.textContent = value.startsWith('agent') ? t('Агент здесь') : pendingWord ? t(pendingWord) : t(STATE_WORDS[value] || 'Загрузка…')
    let more = head.querySelector('.desk-block-more')
    if (!more) {
      more = el('button', 'desk-ib desk-ib-sm desk-block-more')
      more.type = 'button'
      more.setAttribute('aria-haspopup', 'menu')
      more.append(icon('more'))
      head.append(badge, more)
    } else if (badge.parentElement !== head) head.insertBefore(badge, more)
    // Работающий процесс завершается прямо из шапки своего блока.
    let stop = head.querySelector('.desk-block-stop')
    if (proc?.canStop && LIVE.includes(proc.state)) {
      if (!stop) { stop = actionButton('desk-btn desk-btn-sm desk-stop desk-block-stop', ''); head.insertBefore(stop, more) }
      stop.textContent = t('Завершить')
      stop.dataset.processId = proc.id
      stop.setAttribute('aria-label', `${t('Завершить процесс')}: ${proc.command}`)
    } else stop?.remove()
    more.setAttribute('aria-label', t('Действия с блоком'))
    more.dataset.blockId = block.id
  }

  function paint (view) {
    if (!view.ok) { alertUser('Не удалось открыть Desk'); return }
    if (snapshot && view.snapshot.revision < snapshot.revision) return
    snapshot = view.snapshot
    runtime = view.runtime || {}
    resources = view.resources || {}
    agent = view.agent || null
    budgetState = view.budget || null
    language = view.settings.language === 'en' ? 'en' : 'ru'
    document.documentElement.lang = language
    paintBudget()
    transfer.paint()
    $('desk-mods-label').textContent = t('Моды')
    modsToggle.setAttribute('aria-label', t('Моды'))
    $('desk-mods-title').textContent = t('Моды')
    $('desk-mods-settings').textContent = t('Моды в настройках Onlyone')
    void refreshMods()
    $('desk-watch-label').textContent = t('Файлы и процессы')
    $('desk-watch-close').querySelector('span').textContent = t('Закрыть')
    $('desk-mods-close').querySelector('span').textContent = t('Закрыть')
    paintProcessView()
    paintCount()
    const theme = view.settings.theme
    document.documentElement.dataset.theme = theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark'
    $('desk-title').textContent = snapshot.title
    $('desk-empty-title').textContent = t('Здесь соберётся среда')
    $('desk-empty-text').textContent = t('Опишите задачу в Onlyone. Сайты, инструменты и результаты появятся на этом месте.')
    $('desk-empty-main').textContent = t('Открыть Onlyone')
    $('desk-empty-accept').textContent = t('Принять раскладку')
    fit.textContent = t('Уместить блоки')
    $('desk-empty').hidden = snapshot.blocks.length > 0 || Boolean(agent?.plan.length)
    paintAgent()
    paintPlan()
    for (const block of snapshot.blocks) {
      content(block, resources[block.id])
      bodies.get(block.id).revision = block.revision
      const proc = processOf(block.id)
      if (proc) paintTerm(bodies.get(block.id).child, proc)
      const guest = bodies.get(block.id).child
      if (guest?.tagName === 'WEBVIEW') {
        try { void api.guest({ id: block.id, revision: block.revision, guestId: guest.getWebContentsId() }).catch(() => {}) } catch {}
      }
    }
    for (const id of bodies.keys()) if (!snapshot.blocks.some(block => block.id === id)) bodies.delete(id)
    const local = blocks.geometry()
    const geometry = Object.fromEntries(snapshot.blocks.map(block => [block.id, { x: block.rect.x, y: block.rect.y, w: block.rect.width, h: block.rect.height, min: local[block.id]?.min, closed: local[block.id]?.closed }]))
    blocks.restore(geometry)
    blocks.render(snapshot.blocks)
    afterRender()
    if (!view.persistent) showBanner('Раскладка не сохраняется.', 'Правки живут до закрытия окна.', false)
    else if (!failedOperations) hideBanner()
    report(view.persistent ? 'Desk: раскладка сохраняется автоматически' : 'Desk: раскладка в памяти до выхода из приложения')
  }

  function afterRender () {
    canvas.querySelectorAll('.ublock').forEach(node => {
      const block = snapshot.blocks.find(one => one.id === node.dataset.blockId)
      if (!block) return
      node.style.zIndex = block.rect.z
      node.setAttribute('aria-label', agentOn(block.id) ? t('%s, здесь действует агент', block.title) : block.title)
      node.classList.toggle('desk-acting', agentOn(block.id))
      node.classList.toggle('desk-acting-wait', agentOn(block.id) && agent.mode === 'waiting')
      bodies.get(block.id)?.node.classList.toggle('is-loading', runtime[block.id]?.state === 'loading' && bodies.get(block.id)?.node.classList.contains('is-site'))
      dressHead(node.querySelector('.ublock-head'), block)
    })
    layoutDock()
    paintNarrow()
  }

  // Свёрнутые блоки — пилюлями в ряд у нижнего края.
  function layoutDock () {
    let x = GAP
    const y = canvas.clientHeight - GAP - 32
    canvas.querySelectorAll('.ublock-pill').forEach(pill => {
      const block = snapshot?.blocks.find(one => one.id === pill.dataset.blockId)
      if (block && !pill.querySelector('.desk-i')) pill.prepend(icon(KIND_ICON[block.kind] || 'artifact'))
      pill.style.left = x + 'px'
      pill.style.top = y + 'px'
      x += pill.offsetWidth + 8
    })
  }

  // ─── узкое окно ────────────────────────────────────────────────────────────
  const tabs = $('desk-tabs')
  function paintNarrow () {
    const shown = (snapshot?.blocks || []).filter(block => !blocks.geometry()[block.id]?.closed)
    narrow = canvas.clientWidth > 0 && canvas.clientWidth < NARROW && shown.length > 0
    document.body.classList.toggle('is-narrow', narrow)
    tabs.hidden = !narrow
    if (!narrow) { tabs.replaceChildren(); canvas.querySelectorAll('.ublock.is-current').forEach(node => node.classList.remove('is-current')); return }
    if (!shown.some(block => block.id === current)) current = shown[0].id
    tabs.setAttribute('role', 'tablist')
    tabs.replaceChildren(...shown.map(block => {
      const tab = el('button', 'desk-tb')
      tab.type = 'button'
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(block.id === current))
      tab.dataset.tab = block.id
      tab.append(icon(KIND_ICON[block.kind] || 'artifact'), document.createTextNode(block.title))
      return tab
    }))
    canvas.querySelectorAll('.ublock').forEach(node => node.classList.toggle('is-current', node.dataset.blockId === current))
  }
  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]')
    if (!tab) return
    current = tab.dataset.tab
    paintNarrow()
  })
  // Перекладка — в следующем кадре: иначе наблюдатель ловит свои же изменения.
  new ResizeObserver(() => requestAnimationFrame(() => { if (snapshot) { layoutDock(); paintNarrow() } })).observe(canvas)

  async function refresh () {
    const sequence = ++loading
    try { const view = await api.read(); if (sequence === loading && !gesture && !saving) paint(view) }
    catch { alertUser('Не удалось обновить Desk') }
  }

  // ─── правка раскладки ──────────────────────────────────────────────────────
  function applyError (result) {
    if (result.code === 'storage-unavailable') return 'Не удалось сохранить Desk. Прежняя раскладка сохранена.'
    return result.code === 'busy' ? 'Блок Desk сейчас занят' : 'Раскладка Desk изменилась: повторите правку'
  }
  // Сохраняет местную геометрию названных блоков одной операцией.
  async function commitIds (ids, { z, hold } = {}) {
    let error = null
    saving = true
    try {
      if (hold) { if (!(await hold).ok) { error = 'Блок Desk сейчас занят'; return } }
      else for (const id of ids) if (!(await api.hold(id)).ok) { error = 'Блок Desk сейчас занят'; return }
      const fresh = await api.read()
      if (!fresh.ok) { error = 'Не удалось обновить Desk'; return }
      const geo = blocks.geometry()
      const operations = fresh.snapshot.blocks.filter(block => ids.includes(block.id) && geo[block.id]).map(block => {
        const one = geo[block.id]
        return { type: 'geometry', id: block.id, rect: { x: Math.round(one.x), y: Math.round(one.y), width: Math.round(one.w), height: Math.round(one.h), z: z ?? block.rect.z } }
      })
      if (!operations.length) return
      const result = await api.apply({ operationId: crypto.randomUUID(), expectedRevision: fresh.snapshot.revision, operations })
      if (result.ok) { if (failedOperations) { failedOperations = null; hideBanner() } return }
      if (result.code === 'storage-unavailable') {
        failedOperations = operations
        showBanner('Раскладка не сохранилась.', 'Прежняя цела.', true)
      } else error = applyError(result)
    } catch { error = 'Не удалось обновить Desk' }
    finally { gesture = null; saving = false; await api.release().catch(() => {}); await refresh(); if (error) alertUser(error) }
  }
  async function commitGeometry () {
    if (!snapshot || saving || !gesture) return
    const edit = gesture
    await commitIds([edit.id], { z: edit.z, hold: edit.hold })
  }

  // «Поставить» — замена перетаскиванию: те же зоны, что у прилипания.
  function zoneRect (zone) {
    const W = canvas.clientWidth, H = canvas.clientHeight
    const grid = value => Math.round(value / 8) * 8
    const half = Math.max(280, grid((W - 3 * GAP) / 2))
    const tall = Math.max(200, H - 2 * GAP)
    const low = grid(H * 0.55)
    return {
      left: { x: GAP, y: GAP, w: half, h: tall },
      right: { x: Math.max(GAP, W - GAP - half), y: GAP, w: half, h: tall },
      bottom: { x: GAP, y: low, w: Math.max(280, W - 2 * GAP), h: Math.max(200, H - GAP - low) },
      full: { x: GAP, y: GAP, w: Math.max(280, W - 2 * GAP), h: tall }
    }[zone]
  }
  async function placeBlock (id, zone) {
    if (!snapshot || saving || narrow) return
    const rect = zoneRect(zone)
    const geometry = blocks.geometry()
    if (!geometry[id] || !rect) return
    Object.assign(geometry[id], rect, { zone: zone === 'left' || zone === 'right' ? zone : null })
    blocks.restore(geometry)
    blocks.render(snapshot.blocks)
    afterRender()
    const z = Math.min(1000000, Math.max(0, ...snapshot.blocks.map(one => one.rect.z)) + 1)
    await commitIds([id], { z })
  }
  function setLocal (ids, patch) {
    const geometry = blocks.geometry()
    for (const id of ids) if (geometry[id]) Object.assign(geometry[id], patch)
    blocks.restore(geometry)
    blocks.render(snapshot.blocks)
    afterRender()
  }
  // «Убрать» — блок прячется сразу, а удаляется, только когда истекло время
  // «Вернуть».
  function removeBlocks (ids, message) {
    if (!ids.length) return
    setLocal(ids, { closed: true, min: false })
    showNotice(message, { ms: UNDO_MS, undo: {
      cancel: () => setLocal(ids, { closed: false }),
      commit: async () => {
        try {
          for (const id of ids) await api.hold(id)
          const fresh = await api.read()
          const operations = ids.filter(id => fresh.snapshot.blocks.some(block => block.id === id)).map(id => ({ type: 'remove', id }))
          if (!operations.length) return
          const result = await api.apply({ operationId: crypto.randomUUID(), expectedRevision: fresh.snapshot.revision, operations })
          if (!result.ok) { setLocal(ids, { closed: false }); alertUser(applyError(result)) }
        } catch { setLocal(ids, { closed: false }); alertUser('Не удалось обновить Desk') }
        finally { await api.release().catch(() => {}); await refresh() }
      }
    } })
  }

  // ─── меню блока ────────────────────────────────────────────────────────────
  let menuFor = null
  function closeMenu (focusBack = false) {
    if (menu.hidden) return
    menu.hidden = true
    const back = canvas.querySelector(`.desk-block-more[data-block-id="${CSS.escape(menuFor || '')}"]`)
    menuFor = null
    if (focusBack) back?.focus()
  }
  function openMenu (button) {
    const id = button.dataset.blockId
    const entry = bodies.get(id)
    const reloadable = entry && (entry.child?.tagName === 'WEBVIEW' || entry.child?.tagName === 'IFRAME')
    menuFor = id
    const item = (label, iconName, action, { bad = false, disabled = false } = {}) => {
      const node = actionButton('desk-mi' + (bad ? ' is-bad' : ''), t(label), iconName)
      node.setAttribute('role', 'menuitem')
      node.disabled = disabled
      node.dataset.action = action
      return node
    }
    menu.replaceChildren(
      el('div', 'desk-mh', t('Поставить')),
      item('Слева', 'left', 'left', { disabled: narrow }),
      item('Справа', 'right', 'right', { disabled: narrow }),
      item('Снизу', 'bottom', 'bottom', { disabled: narrow }),
      item('Во всё окно', 'full', 'full', { disabled: narrow }),
      el('div', 'desk-mgap'),
      ...(processOf(id) ? [item('Вывод процесса', 'process', 'output'), item('Скопировать вывод', 'copy', 'copy')]
        : [item('Обновить содержимое', 'reload', 'reload', { disabled: !reloadable })]),
      item('Свернуть', 'min', 'min'),
      item('Убрать с Desk', 'remove', 'remove', { bad: true })
    )
    menu.setAttribute('aria-label', t('Действия с блоком'))
    menu.hidden = false
    const r = button.getBoundingClientRect()
    const left = Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))
    const below = r.bottom + 4 + menu.offsetHeight <= innerHeight - 8
    menu.style.left = left + 'px'
    menu.style.top = (below ? r.bottom + 4 : Math.max(8, r.top - 4 - menu.offsetHeight)) + 'px'
    menu.querySelector('.desk-mi:not(:disabled)')?.focus()
  }
  menu.addEventListener('click', event => {
    const node = event.target.closest('[data-action]')
    if (!node || node.disabled) return
    const id = menuFor
    const block = snapshot?.blocks.find(one => one.id === id)
    closeMenu()
    if (!block) return
    const action = node.dataset.action
    if (['left', 'right', 'bottom', 'full'].includes(action)) void placeBlock(id, action)
    else if (action === 'reload') {
      const child = bodies.get(id)?.child
      try { if (child.tagName === 'WEBVIEW') child.reload(); else child.src = child.src } catch { alertUser('Не удалось обновить Desk') }
    } else if (action === 'output') {
      viewedProcess = processOf(id)?.id || null
      openDrawer('watch')
      paintProcessView()
    } else if (action === 'copy') {
      void navigator.clipboard.writeText(processOf(id)?.output || '').then(() => showNotice(t('Вывод скопирован')), () => alertUser('Не удалось скопировать вывод'))
    } else if (action === 'min') canvas.querySelector(`.ublock[data-block-id="${CSS.escape(id)}"] .ublock-min`)?.click()
    else if (action === 'remove') removeBlocks([id], t('Блок «%s» убран', block.title))
    afterRender()
  })
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('.desk-mi:not(:disabled)')]
    const at = items.indexOf(document.activeElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    } else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeMenu(true) }
  })
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && !event.target.closest('.desk-block-more')) closeMenu() }, true)
  canvas.addEventListener('click', event => {
    const stop = event.target.closest('.desk-block-stop')
    if (stop) { void stopProcess(stop); return }
    const more = event.target.closest('.desk-block-more')
    if (!more) return
    if (!menu.hidden && menuFor === more.dataset.blockId) { closeMenu(); return }
    openMenu(more)
  })

  // ─── шторки ────────────────────────────────────────────────────────────────
  const modsPanel = $('desk-mods-panel'), modsToggle = $('desk-mods-toggle'), modsBody = $('desk-mods-body')
  function openDrawer (which) {
    const watchOpen = which === 'watch'
    const modsOpen = which === 'mods'
    const budgetOpen = which === 'budget'
    watchPanel.hidden = !watchOpen
    watchToggle.setAttribute('aria-expanded', String(watchOpen))
    modsPanel.hidden = !modsOpen
    modsToggle.setAttribute('aria-expanded', String(modsOpen))
    budgetPanel.hidden = !budgetOpen
    budgetToggle.setAttribute('aria-expanded', String(budgetOpen))
    if (!watchOpen) { viewedProcess = null; paintProcessView() }
    if (watchOpen) { void refreshWatches(); void refreshProcesses() }
    if (modsOpen) void refreshMods()
    if (budgetOpen) void refresh()
  }
  watchToggle.addEventListener('click', () => openDrawer(watchPanel.hidden ? 'watch' : null))
  $('desk-watch-close').addEventListener('click', () => { openDrawer(null); watchToggle.focus() })
  modsToggle.addEventListener('click', () => openDrawer(modsPanel.hidden ? 'mods' : null))
  $('desk-mods-close').addEventListener('click', () => { openDrawer(null); modsToggle.focus() })
  budgetToggle.addEventListener('click', () => openDrawer(budgetPanel.hidden ? 'budget' : null))
  $('desk-budget-close').addEventListener('click', () => { openDrawer(null); budgetToggle.focus() })
  $('desk-mods-settings').addEventListener('click', () => { void api.main().catch(() => alertUser('Не удалось открыть Onlyone')) })
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.hidden) return
    if (!watchPanel.hidden && viewedProcess) { viewedProcess = null; paintProcessView(); return }
    if (!watchPanel.hidden) { openDrawer(null); watchToggle.focus() } else if (!modsPanel.hidden) { openDrawer(null); modsToggle.focus() } else if (!budgetPanel.hidden) { openDrawer(null); budgetToggle.focus() }
  })

  let modsGeneration = 0
  async function refreshMods () {
    if (modsPanel.hidden || !api.modsPanels) return
    const generation = ++modsGeneration
    try {
      const view = await api.modsPanels()
      if (generation !== modsGeneration || modsPanel.hidden) return
      window.OnlyoneModPanels.paint(modsBody, view, { t, action: input => api.modAction(input), draft: () => report('Задача открыта в Onlyone') })
    } catch { alertUser('Не удалось загрузить моды') }
  }

  const transfer = window.OnlyoneDeskTransfer.mount({ api, t, refresh, report: alertUser, isEditing: () => Boolean(gesture || saving),
    blocks: () => (snapshot?.blocks || []).map(block => ({ title: block.title, kind: block.kind, url: resources[block.id]?.type === 'browser' ? resources[block.id].url : '' })),
    icon,
    // Импорт можно отменить тем же «Вернуть»: новые блоки убираются.
    imported: async count => {
      const before = new Set((snapshot?.blocks || []).map(block => block.id))
      await refresh()
      const added = (snapshot?.blocks || []).filter(block => !before.has(block.id)).map(block => block.id)
      if (!added.length) return
      const n = added.length
      const form = n % 10 === 1 && n % 100 !== 11 ? 'Добавлен %s блок, ничего не запущено'
        : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'Добавлено %s блока, ничего не запущено' : 'Добавлено %s блоков, ничего не запущено'
      showNotice(t(form, n), { ms: UNDO_MS, undo: {
        cancel: () => { removeNow(added) },
        commit: () => {}
      } })
    } })
  async function removeNow (ids) {
    try {
      for (const id of ids) await api.hold(id)
      const fresh = await api.read()
      const operations = ids.filter(id => fresh.snapshot.blocks.some(block => block.id === id)).map(id => ({ type: 'remove', id }))
      if (operations.length) {
        const result = await api.apply({ operationId: crypto.randomUUID(), expectedRevision: fresh.snapshot.revision, operations })
        if (!result.ok) alertUser(applyError(result))
      }
    } catch { alertUser('Не удалось обновить Desk') }
    finally { await api.release().catch(() => {}); await refresh() }
  }
  $('desk-empty-main').addEventListener('click', () => { void api.main().catch(() => alertUser('Не удалось открыть Onlyone')) })
  $('desk-empty-accept').addEventListener('click', () => transfer.open('in'))

  // «Уместить блоки» живёт в шторке раскладки, на вкладке «Передать»: среда,
  // сохранённая на большом экране, встаёт в текущее окно.
  const fit = $('desk-fit')
  fit.addEventListener('click', async () => {
    if (!snapshot || gesture || saving) return
    fit.disabled = true
    try {
      const result = await api.fit({ revision: snapshot.revision, width: canvas.clientWidth, height: canvas.clientHeight })
      if (result.ok) await refresh()
      else alertUser('Не удалось обновить Desk')
    } catch { alertUser('Не удалось обновить Desk') }
    finally { fit.disabled = false }
  })

  canvas.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return
    const block = event.target.closest('.ublock')
    if (block && event.target.closest('.ublock-head,.ublock-grip')) {
      // В узком окне блоки по одному: свободная раскладка широкого окна не трогается.
      if (narrow || saving) { event.stopImmediatePropagation(); event.preventDefault(); return }
      const z = Math.min(1000000, Math.max(0, ...snapshot.blocks.map(one => one.rect.z)) + 1)
      block.style.zIndex = z
      gesture = { id: block.dataset.blockId, hold: api.hold(block.dataset.blockId), z }
      paintAgent()
    }
  }, true)
  canvas.addEventListener('pointercancel', () => { gesture = null }, true)
  window.addEventListener('pointerup', () => { if (gesture && !saving) { gesture = null; void api.release().then(refresh).catch(() => alertUser('Не удалось обновить Desk')) } })
  window.addEventListener('pointercancel', () => { gesture = null; void api.release().then(refresh).catch(() => alertUser('Не удалось обновить Desk')) })
  canvas.addEventListener('keydown', async event => {
    const head = event.target.closest('.ublock-head')
    if (!head || narrow || event.target.closest('button') || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || saving) return
    event.preventDefault()
    const id = head.closest('.ublock').dataset.blockId
    gesture = { id, hold: api.hold(id) }
    const geometry = blocks.geometry(), one = geometry[id]
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    const key = event.shiftKey ? (horizontal ? 'w' : 'h') : (horizontal ? 'x' : 'y')
    one[key] += event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -8 : 8
    blocks.restore(geometry)
    blocks.render(snapshot.blocks)
    afterRender()
    await commitGeometry()
  })
  $('desk-main').addEventListener('click', () => { void api.main().catch(() => alertUser('Не удалось открыть Onlyone')) })
  watchList.addEventListener('click', async event => {
    const button = event.target.closest('button[data-watch-id]')
    if (!button) return
    button.disabled = true
    try {
      const result = await api.stopWatch(button.dataset.watchId)
      if (!result.ok) alertUser('Не удалось остановить наблюдение')
    } catch { alertUser('Не удалось остановить наблюдение') }
    await refreshWatches()
  })
  $('desk-watch-stop-all').addEventListener('click', async event => {
    const button = event.currentTarget
    button.disabled = true
    try {
      const listed = await api.watches()
      const results = await Promise.all((listed.watches || []).map(item => api.stopWatch(item.id)))
      if (!listed.ok || results.some(result => !result.ok)) alertUser('Не удалось остановить наблюдение')
    } catch { alertUser('Не удалось остановить наблюдение') }
    button.disabled = false
    await refreshWatches()
  })
  async function stopProcess (button) {
    button.disabled = true
    try {
      const result = await api.stopProcess(button.dataset.processId)
      if (!result.ok) alertUser(result.code === 'stop-unconfirmed' ? 'Не удалось подтвердить остановку процесса' : 'Не удалось остановить процесс')
    } catch { alertUser('Не удалось остановить процесс') }
    await refreshProcesses()
  }
  processList.addEventListener('click', async event => {
    const stop = event.target.closest('button[data-process-id]')
    if (stop) { await stopProcess(stop); return }
    const hide = event.target.closest('button[data-dismiss-process]')
    if (hide) { dismissed.add(hide.dataset.dismissProcess); await refreshProcesses(); return }
    const view = event.target.closest('button[data-view-process]')
    if (view) { viewedProcess = view.dataset.viewProcess; paintProcessView(); $('desk-process-back').focus() }
  })
  $('desk-process-back').addEventListener('click', () => { viewedProcess = null; paintProcessView() })
  $('desk-process-view-stop').addEventListener('click', event => { void stopProcess(event.currentTarget) })
  $('desk-process-view-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('desk-process-output-full').textContent); showNotice(t('Вывод скопирован')) }
    catch { alertUser('Не удалось скопировать вывод') }
  })
  const unsubscribeMods = api.onModsChanged?.(() => { void refreshMods() })
  const unsubscribe = api.onChanged(() => { void refresh(); void refreshWatches(); void refreshProcesses() })
  const unsubscribeProcesses = api.onProcessesChanged(() => { void refreshProcesses() })
  window.addEventListener('beforeunload', () => { settlePending(true); unsubscribe(); unsubscribeProcesses(); unsubscribeMods?.(); blocks.dispose() })
  void refresh()
  void refreshWatches()
  void refreshProcesses()
})()
