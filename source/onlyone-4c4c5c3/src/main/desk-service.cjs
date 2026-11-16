'use strict'
const path = require('node:path')
const { createDeskModel } = require('./desk-model.cjs')
const { randomUUID } = require('node:crypto')
const { exportTemplate, parseTemplate, pendingResource, PENDING } = require('./desk-transfer.cjs')
const { redactSecrets } = require('./run-checkpoints')

const PLAN_KINDS = new Set(['browser', 'artifact', 'output', 'process'])
const AGENT_ACTIONS = new Set(['observe', 'click', 'fill', 'scroll', 'process', 'build'])
const planText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)
const planRect = rect => rect && typeof rect === 'object' && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(rect[key])) &&
  Math.abs(rect.x) <= 20000 && Math.abs(rect.y) <= 20000 && rect.width >= 280 && rect.width <= 20000 && rect.height >= 200 && rect.height <= 20000

function createDeskService ({ BrowserWindow, ipcMain, isMainWindow, focusMain, resolveResource: resolveOuter, settings, storage, watchDirectory, createProcessManager, writeClipboard, lookupGuest, packageResource, confirmPortable, legacyLayout, onEvent, stopAgent, budgetState = null }) {
  // Процесс — блок холста над тем же менеджером, что и шторка: ресурс «process:<id>» живёт, пока жив Desk.
  async function resolveResource (block, chatId, context) {
    if (block?.kind !== 'process') return resolveOuter(block, chatId, context)
    const id = typeof block.resourceRef === 'string' && block.resourceRef.startsWith('process:') ? block.resourceRef.slice(8) : ''
    const found = desks.get(chatId)?.processManager?.list().find(item => item.id === id)
    if (found) return { type: 'process', id, command: found.command, args: found.args || [], cwd: found.cwd || '', state: found.state, output: found.output || '', canStop: Boolean(found.canStop) }
    if (context?.validate || !id) throw new Error('Process outside Desk')
    return { type: 'process', id, gone: true }
  }
  const pageUrl = (record, block) => 'onecode-artifact://desk-' + record.pageToken + '/' + block.id + '.html'
  const observation = require('./desk-observation.cjs').createDeskObservation({ lookup: lookupGuest,
    resolveFrame: async (record, block) => {
      let expected
      if (block.portable?.active && block.portable.type === 'page') expected = pageUrl(record, block)
      else {
        const resource = await resolveResource(block, record.chatId, { validate: false })
        if (resource?.type === 'page') expected = resource.url
      }
      if (!expected || !record.window || record.window.isDestroyed()) return null
      const frame = record.window.webContents.mainFrame.frames?.find(frame => frame.name === 'desk:' + block.id && frame.url === expected && !frame.detached)
      return frame ? { isDestroyed: () => frame.detached, getURL: () => frame.url, executeJavaScript: (...args) => frame.executeJavaScript(...args) } : null
    } })
  const { exportPackage, parsePackage, fitBlocks, legacyTemplate } = require('./desk-package.cjs')
  const desks = new Map()
  const validChat = id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f]/.test(id)
  const human = record => `human:${record.window.webContents.id}`
  const notify = record => {
    syncMark(record)
    if (record.window && !record.window.isDestroyed()) record.window.webContents.send('desk:changed')
  }
  // Поле-цель в сайте обведено, пока агент там действует или ждёт ответа; на паузе и после — нет.
  function syncMark (record) {
    const agent = record.agent
    const want = agent && !record.paused && agent.blockId && agent.selector && ['acting', 'waiting'].includes(agent.mode)
      ? { blockId: agent.blockId, selector: agent.selector, tone: agent.mode === 'waiting' ? 'warn' : 'acc' } : null
    const had = record.mark || null
    if (JSON.stringify(want) === JSON.stringify(had)) return
    record.mark = want
    const quiet = promise => { void Promise.resolve(promise).catch(() => {}) }
    if (had && (!want || had.blockId !== want.blockId)) quiet(observation.mark(record, { block_id: had.blockId, selector: '' }))
    if (want) quiet(observation.mark(record, { block_id: want.blockId, selector: want.selector, tone: want.tone }))
  }
  function emit (record, fields) {
    record.events.push({ ...fields, sequence: ++record.sequence })
    if (record.events.length > 256) record.events.shift()
    if (fields.type === 'file') { try { onEvent?.(record.chatId, 'desk.file.changed', fields.name ? [fields.path + '/' + fields.name] : []) } catch {} }
  }
  function events (chatId, since = 0) {
    const record = desks.get(chatId)
    if (!record) return { ok: false, code: 'not-open' }
    if (!Number.isSafeInteger(since) || since < 0 || since > record.sequence) return { ok: false, code: 'invalid' }
    return { ok: true, cursor: record.sequence, truncated: since < (record.events[0]?.sequence || 1) - 1,
      events: record.events.filter(entry => entry.sequence > since).map(entry => ({ ...entry })) }
  }
  async function watch (chatId, action, request = {}) {
    const record = desks.get(chatId)
    if (!record) return { ok: false, code: 'not-open' }
    if (action === 'list') return {
      ok: true,
      watches: [...record.watchers.values()].map(({ id, path, recursive }) => ({ id, path, recursive })),
      recent: record.events.filter(entry => entry.type === 'file').slice(-20).map(entry => ({
        path: entry.path, name: entry.name, change: entry.change, sequence: entry.sequence
      }))
    }
    if (action === 'start') {
      if (!record.window || record.window.isDestroyed() || record.rendererGone) return { ok: false, code: 'not-open' }
      const relativePath = typeof request.path === 'string' ? request.path.trim() : ''
      const recursive = request.recursive === true
      if (!relativePath || relativePath.length > 512 || /[\u0000-\u001f]/.test(relativePath) || typeof watchDirectory !== 'function') {
        return { ok: false, code: 'invalid' }
      }
      const key = relativePath.replace(/\\/g, '/').toLowerCase()
      const existing = [...record.watchers.values()].find(item => item.key === key)
      if (existing) return existing.recursive === recursive
        ? { ok: true, watchId: existing.id, path: existing.path, recursive, reused: true }
        : { ok: false, code: 'watch-mode-conflict' }
      if (record.watchers.size >= 4) return { ok: false, code: 'limit' }
      let prepared
      try { prepared = await watchDirectory(relativePath, { recursive }) } catch { return { ok: false, code: 'watch-unavailable' } }
      if (!prepared?.watcher || typeof prepared.watcher.on !== 'function' || typeof prepared.watcher.close !== 'function') {
        return { ok: false, code: 'watch-unavailable' }
      }
      if (!record.window || record.window.isDestroyed()) {
        try { prepared.watcher.close() } catch {}
        return { ok: false, code: 'not-open' }
      }
      const raced = [...record.watchers.values()].find(item => item.key === key)
      if (raced) {
        try { prepared.watcher.close() } catch {}
        return raced.recursive === recursive
          ? { ok: true, watchId: raced.id, path: raced.path, recursive, reused: true }
          : { ok: false, code: 'watch-mode-conflict' }
      }
      const id = require('node:crypto').randomUUID()
      const path = String(prepared.displayPath || relativePath).slice(0, 512)
      const entry = { id, key, path, recursive: prepared.recursive === true, watcher: prepared.watcher }
      const onChange = (change, filename) => {
        if (record.watchers.get(id) !== entry) return
        const name = filename == null ? null : String(filename).replace(/[\u0000-\u001f]/g, '').slice(0, 260)
        emit(record, { type: 'file', watchId: id, path, name, change: change === 'rename' ? 'rename' : 'change' })
        notify(record)
      }
      const onError = () => {
        if (record.watchers.get(id) !== entry) return
        record.watchers.delete(id)
        entry.watcher.removeListener?.('change', onChange)
        entry.watcher.removeListener?.('error', onError)
        try { entry.watcher.close() } catch {}
        emit(record, { type: 'watch-error', watchId: id, path })
        notify(record)
      }
      entry.onChange = onChange
      entry.onError = onError
      record.watchers.set(id, entry)
      entry.watcher.on('change', onChange)
      entry.watcher.on('error', onError)
      emit(record, { type: 'watch-started', watchId: id, path })
      notify(record)
      return { ok: true, watchId: id, path, recursive: entry.recursive, reused: false }
    }
    if (action === 'stop') {
      const id = typeof request.watchId === 'string' ? request.watchId : ''
      const entry = record.watchers.get(id)
      if (!entry) return { ok: false, code: 'not-found' }
      record.watchers.delete(id)
      entry.watcher.removeListener?.('change', entry.onChange)
      entry.watcher.removeListener?.('error', entry.onError)
      try { entry.watcher.close() } catch {}
      emit(record, { type: 'watch-stopped', watchId: id, path: entry.path })
      notify(record)
      return { ok: true, watchId: id }
    }
    return { ok: false, code: 'invalid' }
  }
  async function processes (chatId, action, request = {}) {
    const record = desks.get(chatId)
    if (!record) return { ok: false, code: 'not-open' }
    if (!record.processManager) return { ok: false, code: 'unavailable' }
    if (action === 'list') return { ok: true, processes: record.processManager.list() }
    if (action === 'start') {
      if (!record.window || record.window.isDestroyed() || record.rendererGone) return { ok: false, code: 'not-open' }
      return record.processManager.start(request)
    }
    if (action === 'stop') return record.processManager.stop(request.id)
    return { ok: false, code: 'invalid' }
  }
  async function transfer (chatId, action, input = {}) {
    const record = desks.get(chatId)
    if (!record?.window || record.window.isDestroyed() || record.rendererGone) return { ok: false, code: 'not-open' }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'invalid-template' }
    if (action === 'legacy') {
      try { return { ok: true, text: JSON.stringify(legacyTemplate(await legacyLayout?.()), null, 2) } }
      catch { return { ok: false, code: 'invalid-template' } }
    }
    if (action === 'export' || action === 'copy') {
      try {
        const snapshot = record.model.snapshot()
        const text = input.includeContent === true
          ? await exportPackage(snapshot, block => packageResource?.(block, chatId)) : exportTemplate(snapshot)
        if (record.model.snapshot().revision !== snapshot.revision) return { ok: false, code: 'conflict' }
        if (action === 'copy') {
          if (input.text !== text) return { ok: false, code: 'conflict' }
          if (typeof writeClipboard !== 'function') return { ok: false, code: 'clipboard-unavailable' }
          writeClipboard(text)
          return { ok: true }
        }
        return { ok: true, text }
      } catch { return { ok: false, code: 'export-failed' } }
    }
    if (action === 'preview') {
      record.templatePreview = null
      let template
      try {
        const parsed = typeof input.text === 'string' && input.text.length <= 256 * 1024 ? JSON.parse(input.text) : null
        template = parsed?.format === 'onlyone-desk-package' ? parsePackage(input.text)
          : parsed?.format === 'onlyone.workspace' ? legacyTemplate(input.text) : parseTemplate(input.text)
      } catch { return { ok: false, code: 'invalid-template' } }
      const current = record.model.snapshot()
      if (!template.blocks.length) return { ok: false, code: 'empty-template' }
      if (current.blocks.length + template.blocks.length > 64) return { ok: false, code: 'limit' }
      template.blocks = fitBlocks(template.blocks, input.viewport)
      record.templatePreview = { token: randomUUID(), revision: current.revision, template, expires: Date.now() + 5 * 60 * 1000 }
      return { ok: true, token: record.templatePreview.token, title: template.title, blocks: structuredClone(template.blocks), revision: current.revision }
    }
    if (action !== 'import') return { ok: false, code: 'invalid' }
    const preview = record.templatePreview
    if (!preview || preview.token !== input.token || Date.now() > preview.expires) return { ok: false, code: 'expired-preview' }
    record.templatePreview = null
    const result = record.model.apply({ operationId: preview.token, expectedRevision: preview.revision, actorId: human(record),
      operations: preview.template.blocks.map(block => ({ type: 'add', block: {
        kind: block.kind, title: block.title, rect: block.rect,
        resourceRef: block.portable ? 'desk-package:' + block.portable.type : pendingResource(block),
        ...(block.portable ? { portable: block.portable } : {})
      } })) })
    if (result.ok) {
      emit(record, { type: 'template-import', actor: 'human', count: preview.template.blocks.length })
      notify(record)
    }
    return result.ok ? { ok: true, added: preview.template.blocks.length } : { ok: false, code: result.code }
  }
  function stopWatches (record, reason = 'desk-closed') {
    for (const entry of record.watchers.values()) {
      entry.watcher.removeListener?.('change', entry.onChange)
      entry.watcher.removeListener?.('error', entry.onError)
      try { entry.watcher.close() } catch {}
      emit(record, { type: 'watch-stopped', watchId: entry.id, path: entry.path, reason })
    }
    record.watchers.clear()
  }
  function setState (record, report) {
    if (!report || Object.prototype.hasOwnProperty.call(report, '__proto__') || !['id', 'revision', 'state'].every(key => Object.hasOwn(report, key)) ||
        Object.keys(report).some(key => !['id', 'revision', 'state'].includes(key)) ||
        !['loading', 'ready', 'error', 'stopped'].includes(report.state)) return { ok: false, code: 'invalid' }
    const block = record.model.snapshot().blocks.find(block => block.id === report.id)
    if (!block || block.revision !== report.revision) return { ok: false, code: 'conflict' }
    if (record.runtime[block.id]?.state === report.state) return { ok: true }
    record.runtime[block.id] = { state: report.state }
    emit(record, { type: 'state', id: block.id, revision: block.revision, state: report.state })
    notify(record)
    return { ok: true }
  }
  // ─── ход агента в шапке Desk ─────────────────────────────────────────────
  // Что агент делает и где, план сборки и пауза живут только в памяти: это
  // состояние хода, а не раскладки, и после перезапуска ему нечего показывать.
  function agentView (record) {
    const agent = record.agent
    if (!agent && !record.paused) return null
    const plan = (record.plan || []).map((item, index) => ({ step: index + 1, kind: item.kind, title: item.title, rect: { ...item.rect }, note: item.note || '', done: item.done }))
    return { action: agent?.action || null, mode: agent?.mode || null, target: agent?.target || '', blockId: agent?.blockId || null,
      paused: Boolean(record.paused), plan, step: plan.filter(item => item.done).length, steps: plan.length }
  }
  function releasePause (record) {
    record.paused = false
    for (const resume of record.resumers.splice(0)) resume()
  }
  function setAgent (chatId, requestId, activity) {
    const record = desks.get(chatId)
    if (!record) return { ok: false, code: 'not-open' }
    clearTimeout(record.agentLinger)
    if (!activity) {
      if (!record.plan.length) record.agent = null
      else record.agent = { requestId, mode: 'building', action: 'build', target: '', blockId: null }
    } else {
      if (!['acting', 'waiting'].includes(activity.mode) || !AGENT_ACTIONS.has(activity.action)) return { ok: false, code: 'invalid' }
      const target = typeof activity.target === 'string' ? redactSecrets(activity.target.replace(/[\u0000-\u001f]/g, ' ')).slice(0, 200) : ''
      const blockId = typeof activity.blockId === 'string' && record.model.snapshot().blocks.some(block => block.id === activity.blockId) ? activity.blockId : null
      const selector = ['click', 'fill'].includes(activity.action) && typeof activity.selector === 'string' && activity.selector.length <= 2000 ? activity.selector : ''
      record.agent = { requestId, mode: activity.mode, action: activity.action, target, blockId, selector }
    }
    notify(record)
    return { ok: true }
  }
  // Действие закончено: строка держится пару секунд, иначе она мигает между шагами.
  function settleAgent (chatId, requestId, ms = 4000) {
    const record = desks.get(chatId)
    if (!record || record.agent?.requestId !== requestId) return
    clearTimeout(record.agentLinger)
    record.agentLinger = setTimeout(() => { if (record.agent?.requestId === requestId && record.agent.mode !== 'building') setAgent(chatId, requestId, null) }, ms)
    record.agentLinger.unref?.()
  }
  function plan (chatId, requestId, items) {
    const record = desks.get(chatId)
    if (!record) return { ok: false, code: 'not-open' }
    if (!Array.isArray(items) || items.length > 16 || !items.every(item => item && typeof item === 'object' && PLAN_KINDS.has(item.kind) &&
        planText(item.title, 200) && planRect(item.rect) && (item.note === undefined || item.note === '' || planText(item.note, 120)))) return { ok: false, code: 'invalid' }
    record.plan = items.map(item => ({ kind: item.kind, title: item.title.trim(), note: item.note ? item.note.trim() : '', done: false,
      rect: { x: item.rect.x, y: item.rect.y, width: item.rect.width, height: item.rect.height } }))
    if (!record.plan.length && record.agent?.mode === 'building') record.agent = null
    else if (record.plan.length) record.agent = { requestId, mode: 'building', action: 'build', target: '', blockId: null }
    emit(record, { type: 'plan', steps: record.plan.length })
    notify(record)
    return { ok: true, steps: record.plan.length }
  }
  // Добавленный агентом блок закрывает первый подходящий шаг плана.
  function advancePlan (record, operations) {
    if (!record.plan.length) return
    for (const op of operations) {
      if (op?.type !== 'add') continue
      const item = record.plan.find(one => !one.done && one.kind === op.block?.kind && one.title === String(op.block?.title || '').trim()) ||
        record.plan.find(one => !one.done && one.kind === op.block?.kind)
      if (item) item.done = true
    }
    if (record.plan.every(item => item.done)) {
      record.plan = []
      if (record.agent?.mode === 'building') record.agent = null
    }
  }
  // Пауза держит следующее действие агента в Desk, пока человек не продолжит или ход не отменят.
  function gate (chatId, signal) {
    if (signal?.aborted) return Promise.resolve(false)
    const record = desks.get(chatId)
    if (!record?.paused) return Promise.resolve(true)
    return new Promise(resolve => {
      const done = value => { signal?.removeEventListener?.('abort', aborted); resolve(value) }
      const aborted = () => { record.resumers = record.resumers.filter(one => one !== resume); done(false) }
      const resume = () => done(true)
      record.resumers.push(resume)
      if (signal?.aborted) aborted()
      else signal?.addEventListener?.('abort', aborted, { once: true })
    })
  }
  function endTurn (requestId) {
    for (const record of desks.values()) {
      if (record.agent?.requestId !== requestId) continue
      clearTimeout(record.agentLinger)
      record.agent = null
      record.plan = []
      releasePause(record)
      notify(record)
    }
  }
  function pause (record, value) {
    if (value === record.paused) return { ok: true, paused: record.paused }
    if (value && !record.agent) return { ok: false, code: 'idle' }
    if (value) record.paused = true
    else releasePause(record)
    emit(record, { type: 'pause', paused: record.paused, actor: 'human' })
    notify(record)
    return { ok: true, paused: record.paused }
  }
  function stopBuild (record) {
    const requestId = record.agent?.requestId
    if (!requestId) return { ok: false, code: 'idle' }
    record.plan = []
    record.agent = null
    releasePause(record)
    emit(record, { type: 'build-stopped', actor: 'human' })
    notify(record)
    try { stopAgent?.(requestId) } catch {}
    return { ok: true }
  }

  function fromEvent (event) {
    for (const record of desks.values()) {
      const wc = record.window && !record.window.isDestroyed() && record.window.webContents
      if (wc && event.sender === wc && event.senderFrame === wc.mainFrame) return record
    }
    return null
  }
  // Запись без окна ничего не держит: слежение и процессы сняты при закрытии,
  // раскладка на диске. Её вытеснение открывает следующий чат вместо `limit`.
  function evict (record) {
    stopWatches(record)
    if (record.processManager) void record.processManager.closeAll()
    desks.delete(record.chatId)
  }
  function open (chatId) {
    if (!validChat(chatId)) return { ok: false, code: 'chat-required' }
    let record = desks.get(chatId)
    if (!record) {
      if (desks.size >= 16) {
        const idle = [...desks.values()].find(one => !one.window || one.window.isDestroyed())
        if (!idle) return { ok: false, code: 'limit' }
        evict(idle)
      }
      let initial = null, recovered = false
      try { initial = storage?.load(chatId) } catch (error) {
        // Порча (обрезанный JSON, чужой ключ или чат) — копия рядом и пустая
        // раскладка: иначе Desk этого чата не открывается больше никогда.
        // Недоступное сейчас шифрование порчей не считается и файл не трогает.
        if (error?.code !== 'desk-store-damaged' || typeof storage.archive !== 'function') return { ok: false, code: 'storage-unavailable' }
        try { storage.archive(chatId) } catch { return { ok: false, code: 'storage-unavailable' } }
        recovered = true
      }
      try {
        record = { chatId, model: createDeskModel({ title: 'Onlyone Desk', initial,
          persist: storage ? snapshot => storage.save(chatId, snapshot) : undefined }), window: null,
          runtime: Object.create(null), sequence: 0, events: [], watchers: new Map(), agent: null, plan: [], paused: false, resumers: [],
          processManager: typeof createProcessManager === 'function' ? createProcessManager(chatId) : null }
      } catch { return { ok: false, code: 'storage-unavailable' } }
      record.recovered = recovered
      desks.set(chatId, record)
      record.processManager?.onChange?.((entry, kind) => {
        if (kind === 'output') {
          if (record.window && !record.window.isDestroyed()) record.window.webContents.send('desk:process-changed')
          return
        }
        emit(record, { type: 'process', processId: entry.id, state: entry.state })
        notify(record)
      })
    }
    // Порядок открытия — порядок вытеснения: давно открытый чат с закрытым
    // окном уходит первым.
    desks.delete(chatId); desks.set(chatId, record)
    if (record.window && !record.window.isDestroyed()) {
      // Упавший renderer ждёт перезагрузки страницы в том же окне: гейты
      // снимаются в did-finish-load, когда страница действительно вернулась.
      if (record.rendererGone && !record.reloading) { record.reloading = true; record.window.webContents.reload() }
      if (record.window.isMinimized()) record.window.restore()
      record.window.show(); record.window.focus()
      const recovered = record.recovered === true
      record.recovered = false
      return { ok: true, snapshot: record.model.snapshot(), recovered }
    }
    const win = new BrowserWindow({ width: 1240, height: 800, minWidth: 760, minHeight: 560,
      title: 'Onlyone Desk', show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, '../preload/desk.js'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, webviewTag: true, spellcheck: false } })
    record.window = win
    record.pageToken = randomUUID()
    record.rendererGone = false
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    const owner = human(record)
    win.webContents.on('render-process-gone', () => {
      record.rendererGone = true
      record.reloading = false
      record.templatePreview = null
      releasePause(record)
      record.mark = null
      record.model.releaseOwner(owner)
      stopWatches(record, 'renderer-gone')
      if (record.processManager) void record.processManager.closeAll()
      for (const block of record.model.snapshot().blocks) setState(record, { id: block.id, revision: block.revision, state: 'stopped' })
    })
    win.webContents.on('did-finish-load', () => { record.rendererGone = false; record.reloading = false })
    win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) record.model.releaseOwner(owner) })
    win.on('closed', () => {
      record.model.releaseOwner(owner); record.window = null; record.rendererGone = false; record.reloading = false
      releasePause(record)
      record.mark = null
      record.templatePreview = null
      stopWatches(record)
      if (record.processManager) void record.processManager.closeAll()
      for (const block of record.model.snapshot().blocks) setState(record, { id: block.id, revision: block.revision, state: 'stopped' })
    })
    win.once('ready-to-show', () => win.show())
    win.loadFile(path.join(__dirname, '../renderer/desk.html')).catch(() => {
      if (!win.isDestroyed()) win.destroy()
    })
    const recovered = record.recovered === true
    record.recovered = false
    return { ok: true, snapshot: record.model.snapshot(), recovered }
  }
  async function read (chatId) {
    const record = desks.get(chatId)
    if (!record) return { ok: false, code: 'not-open' }
    const snapshot = record.model.snapshot()
    const resources = {}
    await Promise.all(snapshot.blocks.map(async block => {
      if (block.portable) {
        resources[block.id] = block.portable.active
          ? block.portable.type === 'text' ? { type: 'text', text: block.portable.content } : { type: 'portable-page', url: pageUrl(record, block) }
          : { type: 'pending', portable: true, dependencies: block.portable.dependencies }
        return
      }
      if (block.resourceRef.startsWith(PENDING)) {
        resources[block.id] = { type: 'pending', hint: block.kind === 'browser' ? block.resourceRef.slice((PENDING + 'browser:').length) : '' }
        return
      }
      try { resources[block.id] = await resolveResource(block, chatId, { validate: false }) }
      catch { resources[block.id] = { type: 'unavailable' } }
    }))
    const processState = resource => resource.gone || ['stopped', 'exited'].includes(resource.state) ? 'stopped'
      : resource.state === 'failed' ? 'error' : resource.state === 'running' ? 'ready' : 'loading'
    const runtime = Object.fromEntries(snapshot.blocks.map(block => [block.id, resources[block.id]?.type === 'pending' ? { state: 'stopped' }
      : resources[block.id]?.type === 'process' ? { state: processState(resources[block.id]) }
        : record.runtime[block.id] || { state: record.window ? 'loading' : 'stopped' }]))
    let budget = null
    try { budget = typeof budgetState === 'function' ? budgetState(chatId) : null } catch { budget = null }
    return { ok: true, snapshot, resources, runtime, settings: settings(), budget, persistent: !!storage, agent: agentView(record) }
  }
  async function apply (chatId, command, actorId, context = {}) {
    if (context.signal?.aborted) return { ok: false, code: 'aborted' }
    const record = desks.get(chatId)
    if (!record) return { ok: false, code: 'not-open' }
    if (!command || typeof command !== 'object') return { ok: false, code: 'invalid' }
    if (command.operations?.some(op => op?.type === 'activate' || op?.block?.portable !== undefined)) return { ok: false, code: 'forbidden' }
    const trusted = { ...command, actorId }
    const checked = record.model.preview(trusted)
    if (!checked.ok || checked.replayed) return checked
    try {
      for (const op of command.operations) {
        if (op.type === 'add') await resolveResource(op.block, chatId, { ...context, validate: true })
        if (op.type === 'resource') {
          const block = checked.snapshot.blocks.find(block => block.id === op.id)
          await resolveResource(block, chatId, { ...context, validate: true })
        }
      }
    } catch { return { ok: false, code: 'resource-unavailable' } }
    if (context.signal?.aborted) return { ok: false, code: 'aborted' }
    const before = record.model.snapshot()
    const result = record.model.apply(trusted)
    if (result.ok && !result.replayed) {
      for (const op of command.operations) {
        if (op.type === 'resource') delete record.runtime[op.id]
        if (op.type === 'remove') delete record.runtime[op.id]
      }
      if (actorId.startsWith('agent:')) advancePlan(record, command.operations)
      const prior = new Map(before.blocks.map(block => [block.id, block]))
      const next = new Map(result.snapshot.blocks.map(block => [block.id, block]))
      for (const id of new Set([...prior.keys(), ...next.keys()])) {
        if (prior.get(id)?.revision !== next.get(id)?.revision) emit(record, { type: 'changed', id,
          revision: result.snapshot.revision, actor: actorId.startsWith('human:') ? 'human' : 'agent' })
      }
      notify(record)
    }
    return result
  }
  ipcMain.handle('desk:open', (event, chatId) => isMainWindow(event) ? open(chatId) : { ok: false, code: 'forbidden' })
  ipcMain.handle('desk:read', event => { const record = fromEvent(event); return record ? read(record.chatId) : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:apply', (event, command) => {
    const record = fromEvent(event)
    if (!record) return { ok: false, code: 'forbidden' }
    if (!Array.isArray(command?.operations) || command.operations.some(op => !['geometry', 'remove'].includes(op?.type))) return { ok: false, code: 'forbidden' }
    return apply(record.chatId, command, human(record))
  })
  ipcMain.handle('desk:hold', (event, id) => { const record = fromEvent(event); return record ? record.model.hold(id, human(record)) : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:state', (event, report) => { const record = fromEvent(event); return record ? setState(record, report) : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:guest', (event, report) => { const record = fromEvent(event); return record ? observation.register(record, report) : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:watches', event => { const record = fromEvent(event); return record ? watch(record.chatId, 'list') : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:watch-stop', (event, id) => { const record = fromEvent(event); return record ? watch(record.chatId, 'stop', { watchId: id }) : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:processes', event => { const record = fromEvent(event); return record ? processes(record.chatId, 'list') : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:process-stop', (event, id) => { const record = fromEvent(event); return record ? processes(record.chatId, 'stop', { id }) : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:transfer', (event, action, input) => { const record = fromEvent(event); return record ? transfer(record.chatId, action, input) : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:fit', (event, input) => {
    const record = fromEvent(event)
    if (!record) return { ok: false, code: 'forbidden' }
    const snapshot = record.model.snapshot()
    if (snapshot.revision !== input?.revision) return { ok: false, code: 'conflict' }
    if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 280 || input.height < 200 || input.width > 20000 || input.height > 20000) return { ok: false, code: 'invalid' }
    if (!snapshot.blocks.length) return { ok: true }
    const result = record.model.apply({ operationId: randomUUID(), expectedRevision: snapshot.revision, actorId: human(record),
      operations: fitBlocks(snapshot.blocks, input).map(block => ({ type: 'geometry', id: block.id, rect: block.rect })) })
    if (result.ok) { emit(record, { type: 'fit', actor: 'human' }); notify(record) }
    return result
  })
  ipcMain.handle('desk:activate', async (event, id) => {
    const record = fromEvent(event)
    if (!record) return { ok: false, code: 'forbidden' }
    const snapshot = record.model.snapshot(), block = snapshot.blocks.find(block => block.id === id)
    if (!block?.portable || block.portable.active) return { ok: false, code: 'invalid' }
    if (!await confirmPortable?.(record.window, block)) return { ok: false, code: 'denied' }
    if (fromEvent(event) !== record) return { ok: false, code: 'not-open' }
    const result = record.model.apply({ operationId: randomUUID(), expectedRevision: snapshot.revision, actorId: human(record), operations: [{ type: 'activate', id }] })
    if (result.ok) { emit(record, { type: 'resource-activated', id, actor: 'human' }); notify(record) }
    return result
  })
  ipcMain.handle('desk:pause', (event, value) => { const record = fromEvent(event); return record ? pause(record, value === true) : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:stop-build', event => { const record = fromEvent(event); return record ? stopBuild(record) : { ok: false, code: 'forbidden' } })
  ipcMain.handle('desk:release', event => { const record = fromEvent(event); if (!record) return { ok: false, code: 'forbidden' }; record.model.releaseOwner(human(record)); return { ok: true } })
  ipcMain.handle('desk:main', event => { if (!fromEvent(event)) return { ok: false, code: 'forbidden' }; focusMain(); return { ok: true } })
  // shortcut: replay history is process-local; clients must read the restored revision before submitting edits.
  return Object.freeze({ open, read, apply, events, watch, processes, transfer, plan, gate, endTurn,
    agent: setAgent, settleAgent,
    chatForEvent: event => fromEvent(event)?.chatId || null,
    notifyMods: chatId => { for (const record of desks.values()) if ((!chatId || record.chatId === chatId) && record.window && !record.window.isDestroyed()) record.window.webContents.send('mods:changed') },
    serve (request) {
      let url
      try { url = new URL(request.url) } catch { return null }
      if (url.protocol !== 'onecode-artifact:') return null
      for (const record of desks.values()) {
        if (!record.window || record.window.isDestroyed() || record.rendererGone || url.hostname !== 'desk-' + record.pageToken) continue
        const block = record.model.snapshot().blocks.find(block => pageUrl(record, block) === url.href)
        if (!block?.portable?.active || block.portable.type !== 'page') return null
        return new Response(block.portable.content, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'" } })
      }
      return null
    },
    interact: (chatId, input, signal) => observation.run(desks.get(chatId), input, signal),
    async capture (chatId, revision, signal) {
      const record = desks.get(chatId), win = record?.window
      if (!win || win.isDestroyed() || record.rendererGone) return { ok: false, code: 'not-open' }
      if (record.model.snapshot().revision !== revision) return { ok: false, code: 'conflict' }
      if (signal?.aborted) return { ok: false, code: 'aborted' }
      try {
        const image = await win.webContents.capturePage()
        if (signal?.aborted) return { ok: false, code: 'aborted' }
        if (record.window !== win || win.isDestroyed() || record.model.snapshot().revision !== revision) return { ok: false, code: 'conflict' }
        const png = image.toPNG()
        if (!png.length || png.length > 20 * 1024 * 1024) return { ok: false, code: 'capture-unavailable' }
        return { ok: true, png }
      } catch { return { ok: false, code: 'capture-unavailable' } }
    },
    refresh: chatId => { const record = desks.get(chatId); if (record) notify(record) },
    dispose () { for (const record of desks.values()) { stopWatches(record); if (record.processManager) void record.processManager.closeAll(); if (record.window && !record.window.isDestroyed()) record.window.destroy() } } })
}
module.exports = { createDeskService }
