/* Предложение связанного чата (Ф-3, первый ограниченный срез).
 *
 * Агент предлагает выделить тему или подзадачу в отдельный связанный чат.
 * Предложение ничего не создаёт и модель не запускает: человек видит карточку
 * с целью, причиной, родителем и выбранным контекстом и сам нажимает «создать»
 * или «отклонить». Принятие создаёт РОВНО один дочерний чат на операцию.
 *
 * Общие механизмы не дублируются:
 *  - снимок и связь пишет `chat-forks.js` (kind/mode и id предложения — только
 *    дополнительные поля того же `chat.fork`);
 *  - единственный источник родства — `chat.fork.parentChatId`, поэтому дерево
 *    связанных чатов (кандидат 8e287c9) видит созданный чат без второй базы;
 *  - событие едет существующим каналом главного процесса (`sendToWindow`),
 *    карточка живёт в переписке рядом с вопросом `ask_user`.
 *
 * Устойчивый id операции выводится из содержимого предложения и родителя:
 * повторная доставка события или повторный клик не создают второй чат.
 * Отклонение хранится списком id на родителе (`forkProposalDismissed`), если
 * вызывающая сторона решит его сохранить; сама модель ничего не пишет.
 */
(function (root) {
  'use strict'

  const TOOL_NAME = 'propose_linked_chat'
  const PROPOSAL_VERSION = 1
  const LIMITS = Object.freeze({ title: 200, goal: 4000, reason: 1000, summary: 8000, dismissed: 50 })
  const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

  function fail (code) { throw new Error(code) }

  function cleanText (value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : ''
  }

  // FNV-1a: короткий стабильный отпечаток без crypto — одинаков в Node и в окне.
  function hash (value) {
    const text = String(value)
    let result = 0x811c9dc5
    for (let index = 0; index < text.length; index++) {
      result ^= text.charCodeAt(index)
      result = Math.imul(result, 0x01000193) >>> 0
    }
    return result.toString(16).padStart(8, '0')
  }

  // Структурная проверка без родительского чата: её же зовёт главный процесс,
  // прежде чем показать предложение. Родитель и граница проверяются в окне,
  // где лежит переписка.
  function sanitize (raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid-proposal')
    const title = cleanText(raw.title, LIMITS.title)
    const goal = cleanText(raw.goal, LIMITS.goal)
    const reason = cleanText(raw.reason, LIMITS.reason)
    if (!title) fail('empty-title')
    if (!goal) fail('empty-goal')
    const context = raw.context
    if (!context || typeof context !== 'object' || Array.isArray(context)) fail('invalid-context')
    const mode = context.mode
    if (mode !== 'messages' && mode !== 'summary') fail('invalid-context-mode')
    const end = context.end === undefined || context.end === null ? null : context.end
    if (end !== null && (!Number.isInteger(end) || end < 0)) fail('invalid-boundary')
    const summary = mode === 'summary' ? cleanText(context.summary, LIMITS.summary) : ''
    if (mode === 'summary' && !summary) fail('empty-summary')
    const operationId = typeof raw.operationId === 'string' ? raw.operationId.trim() : ''
    const clean = {
      version: PROPOSAL_VERSION,
      title,
      goal,
      reason,
      context: { mode, end, summary, revision: '' }
    }
    if (OPERATION_ID.test(operationId)) clean.operationId = operationId
    return clean
  }

  function revisionOf (messages, end) {
    return 'h:' + hash(JSON.stringify(messages.slice(0, end + 1)))
  }

  function fingerprint (parentChatId, shape) {
    return 'fp_' + hash(JSON.stringify([
      parentChatId,
      shape.title,
      shape.goal,
      shape.reason,
      shape.context.mode,
      shape.context.end,
      shape.context.summary,
      shape.context.revision
    ]))
  }

  function normalize (raw, options) {
    const parentChatId = typeof options?.parentChatId === 'string' ? options.parentChatId.trim() : ''
    if (!parentChatId) fail('invalid-parent')
    const messages = Array.isArray(options?.messages) ? options.messages : null
    const shape = sanitize(raw)
    const context = shape.context
    if (context.mode === 'messages') {
      if (context.end === null) {
        if (!messages || !messages.length) fail('missing-boundary')
        context.end = messages.length - 1
      }
      if (messages && context.end >= messages.length) fail('invalid-boundary')
      if (messages && context.end >= 0) context.revision = revisionOf(messages, context.end)
    } else if (context.end !== null && messages) {
      if (context.end >= messages.length) fail('invalid-boundary')
      context.revision = revisionOf(messages, context.end)
    }
    const createdAt = Number.isFinite(options?.now) ? options.now : Date.now()
    return Object.freeze({
      version: PROPOSAL_VERSION,
      operationId: shape.operationId || fingerprint(parentChatId, shape),
      parentChatId,
      title: shape.title,
      goal: shape.goal,
      reason: shape.reason,
      context: Object.freeze({ ...context }),
      createdAt
    })
  }

  function findAccepted (conversations, operationId) {
    if (!Array.isArray(conversations) || typeof operationId !== 'string' || !operationId) return null
    return conversations.find(chat => chat && chat.fork && chat.fork.proposalOperationId === operationId) || null
  }

  // Чужой ребёнок с тем же id операции не считается своим: связь сверяется и по
  // родителю, иначе повтор из другого чата вернул бы чужой чат.
  function findChild (conversations, operationId, parentChatId) {
    if (!Array.isArray(conversations) || typeof operationId !== 'string' || !operationId) return null
    if (typeof parentChatId !== 'string' || !parentChatId) return null
    return conversations.find(chat => chat && chat.fork &&
      chat.fork.proposalOperationId === operationId && chat.fork.parentChatId === parentChatId) || null
  }

  function proposalRecord (proposal) {
    return {
      operationId: proposal.operationId,
      title: proposal.title,
      goal: proposal.goal,
      reason: proposal.reason,
      context: { mode: proposal.context.mode, end: proposal.context.end, revision: proposal.context.revision },
      createdAt: proposal.createdAt
    }
  }

  function forkOf (proposal, source, now, mode) {
    return {
      version: 1,
      kind: 'subtask',
      mode,
      parentChatId: source.id,
      sourceMessageIndex: proposal.context.end,
      proposalOperationId: proposal.operationId,
      proposal: proposalRecord(proposal),
      createdAt: now
    }
  }

  // Принятие идемпотентно по operationId: если родитель уже получил дочерний
  // чат этого предложения, возвращается он же и ничего не создаётся.
  function accept (proposal, options) {
    if (!proposal || proposal.version !== PROPOSAL_VERSION || typeof proposal.operationId !== 'string') fail('invalid-proposal')
    const source = options?.source
    if (!source || typeof source.id !== 'string' || source.id !== proposal.parentChatId) fail('invalid-parent')
    if (options?.status === 'rejected') fail('proposal-rejected')
    const existing = findChild(options?.conversations, proposal.operationId, source.id)
    if (existing) return { created: false, chat: existing }
    if (options?.status === 'accepted') fail('child-missing')
    const newId = typeof options?.newId === 'string' ? options.newId.trim() : ''
    if (!newId || newId === source.id) fail('invalid-chat-id')
    const now = Number.isFinite(options?.now) ? options.now : Date.now()
    const context = proposal.context

    if (context.mode === 'messages') {
      const forkApi = options?.forkApi
      if (!forkApi || typeof forkApi.snapshot !== 'function' || typeof forkApi.child !== 'function') fail('fork-api-required')
      let preview
      try {
        preview = forkApi.snapshot(source, context.end)
      } catch (error) {
        if (/invalid-boundary|empty-context/.test(String(error?.message))) fail('source-changed')
        throw error
      }
      if (context.revision && revisionOf(source.messages, context.end) !== context.revision) fail('source-changed')
      const chat = forkApi.child(source, preview, proposal.title, newId, now)
      chat.fork = { ...chat.fork, ...forkOf(proposal, source, now, 'messages') }
      return { created: true, chat }
    }

    // Выжимка — это выжимка: в чат попадают цель и согласованный текст, а не
    // притворная полная история. Вложения и служебные блоки не переносятся.
    const chat = {
      id: newId,
      title: proposal.title,
      projectId: source.projectId || null,
      createdAt: now,
      updatedAt: now,
      messages: [{ role: 'user', content: proposal.goal + '\n\n' + context.summary, timestamp: now }],
      fork: forkOf(proposal, source, now, 'summary')
    }
    return { created: true, chat }
  }

  function dismissedWith (chat, operationId) {
    if (typeof operationId !== 'string' || !operationId) fail('invalid-operation-id')
    const history = Array.isArray(chat?.forkProposalDismissed) ? chat.forkProposalDismissed : []
    return [...history.filter(id => typeof id === 'string' && id !== operationId), operationId].slice(-LIMITS.dismissed)
  }

  function isDismissed (chat, operationId) {
    return Array.isArray(chat?.forkProposalDismissed) && chat.forkProposalDismissed.includes(operationId)
  }

  // Сбой между созданием чата и записью статуса: чат уже есть, запись ещё
  // pending. При следующем чтении связь находится по устойчивому id, и статус
  // догоняется. В нечитаемую опись не пишем; accepted без ребёнка не трогаем.
  function reconcile (options) {
    const source = options?.source
    const conversations = options?.conversations
    const store = options?.store
    if (!source || typeof source.id !== 'string') fail('invalid-parent')
    if (!store || typeof store.read !== 'function' || typeof store.setStatus !== 'function') fail('store-required')
    const ledger = store.read(source)
    if (!ledger.ok) return { repaired: 0, unreadable: true }
    const now = Number.isFinite(options?.now) ? options.now : Date.now()
    let repaired = 0
    for (const record of ledger.proposals) {
      if (record.status !== 'pending') continue
      const child = findChild(conversations, record.operationId, source.id)
      if (!child) continue
      const result = store.setStatus(source, record.operationId, 'accepted', { childChatId: child.id, now })
      if (result.ok) repaired++
    }
    return { repaired }
  }

  // Карточка встаёт сразу после сообщения-границы, а не в конец ленты: якорь —
  // `context.end`. Нет границы (выжимка) или сообщение не отрисовано — в конец.
  // Один помощник у живой доставки, восстановления и перерисовки.
  function placeCard (container, card) {
    const end = card?.dataset?.forkAnchorEnd
    const boundary = end && typeof container.querySelector === 'function'
      ? container.querySelector('[data-fork-message-index="' + end + '"]')
      : null
    if (!boundary || boundary.parentNode !== container) {
      container.appendChild(card)
      return card
    }
    // Несколько карточек на одну границу сохраняют порядок доставки.
    let after = boundary.nextSibling
    while (after && after.dataset && after.dataset.forkAnchorEnd === end) after = after.nextSibling
    container.insertBefore(card, after)
    return card
  }

  // Сводка связанных задач: только записи описи. Статусов исполнения
  // (работает/ждёт/непрочитано) здесь нет — источника для них пока нет.
  function summaryOf (source, conversations, storeApi, runningIds) {
    if (!storeApi || typeof storeApi.read !== 'function') return { ok: false, reason: 'store-required' }
    if (!source || typeof source.id !== 'string' || !source.id) return { ok: false, reason: 'invalid-source' }
    const ledger = storeApi.read(source)
    if (!ledger.ok) return { ok: false, reason: ledger.reason }
    const rows = []
    let pending = 0
    for (const record of ledger.proposals) {
      if (record.status === 'rejected') continue
      if (record.status === 'pending') { pending++; continue }
      const child = findChild(conversations, record.operationId, source.id)
      const chatId = child && typeof child.id === 'string' ? child.id : null
      rows.push({
        operationId: record.operationId,
        chatId,
        title: (child && typeof child.title === 'string' && child.title) || record.title,
        running: Boolean(chatId && runningIds && typeof runningIds.has === 'function' && runningIds.has(chatId))
      })
    }
    return { ok: true, pending, created: rows.length, rows }
  }

  // Ожидающие остаются отдельными карточками: сводка показывает только счётчики
  // и строки созданных чатов, иначе одно предложение стояло бы дважды.
  function mountSummary (container, summary, options) {
    if (!container || typeof container.appendChild !== 'function') fail('invalid-container')
    if (!summary || !Array.isArray(summary.rows)) fail('invalid-summary')
    const doc = container.ownerDocument || root.document
    if (!doc) fail('invalid-container')
    const t = typeof options?.t === 'function' ? options.t : text => text
    const total = summary.pending + summary.created
    const card = doc.createElement('section')
    card.className = 'fork-proposal-summary-card'
    card.dataset.forkProposalSummary = 'true'
    card.setAttribute('role', 'group')

    const title = doc.createElement('div')
    title.className = 'fork-proposal-summary-title'
    title.textContent = t('Связанные задачи') + ' · ' + total
    card.setAttribute('aria-label', title.textContent)
    card.appendChild(title)

    const counts = doc.createElement('div')
    counts.className = 'fork-proposal-summary-counts'
    counts.textContent = t('Предложено') + ': ' + summary.pending + ' · ' + t('Создано') + ': ' + summary.created
    card.appendChild(counts)

    if (summary.rows.length) {
      const rows = doc.createElement('div')
      rows.className = 'fork-proposal-summary-rows'
      for (const item of summary.rows) {
        const button = doc.createElement('button')
        button.type = 'button'
        button.className = 'fork-proposal-summary-row'
        button.dataset.action = 'open-child'
        button.textContent = item.title + (item.running ? ' · ' + t('Работает') : '')
        if (item.chatId) {
          button.dataset.chatId = item.chatId
          button.setAttribute('aria-label', t('Открыть чат') + ': ' + item.title)
          button.addEventListener('click', () => options?.onOpenChild?.(item))
        } else {
          button.disabled = true
        }
        rows.appendChild(button)
      }
      card.appendChild(rows)
    }
    container.appendChild(card)
    return card
  }

  // Карточка ничего не решает сама: колбэки принадлежат переписке, которая
  // умеет сохранять чаты. Разметка модели попадает в DOM только текстом.
  function mountCard (container, proposal, options) {
    if (!container || typeof container.appendChild !== 'function') fail('invalid-container')
    if (!proposal || typeof proposal.operationId !== 'string') fail('invalid-proposal')
    for (const node of container.querySelectorAll('[data-fork-proposal-id]')) {
      if (node.dataset.forkProposalId === proposal.operationId) return node
    }
    const doc = container.ownerDocument || root.document
    if (!doc) fail('invalid-container')
    const t = typeof options?.t === 'function' ? options.t : text => text
    const status = options?.status === 'accepted' ? 'accepted' : 'pending'
    const problem = options?.problem && typeof options.problem === 'object' ? options.problem : null
    const canOpen = status === 'accepted' && !problem && typeof options?.onOpenChild === 'function'
    const line = (tag, className, text) => {
      const node = doc.createElement(tag)
      node.className = className
      node.textContent = text
      return node
    }

    const card = doc.createElement('section')
    card.className = 'fork-proposal-card'
    card.dataset.forkProposalId = proposal.operationId
    if (Number.isInteger(proposal.context?.end)) card.dataset.forkAnchorEnd = String(proposal.context.end)
    card.dataset.forkProposalStatus = status
    card.setAttribute('role', 'group')
    card.setAttribute('aria-label', t('Предложение связанного чата'))

    card.appendChild(line('div', 'fork-proposal-kicker', t('Предложение связанного чата')))
    const titleNode = line('h3', 'fork-proposal-title', proposal.title)
    card.appendChild(titleNode)
    card.appendChild(line('div', 'fork-proposal-label', t('Цель')))
    const goalNode = line('p', 'fork-proposal-goal', proposal.goal)
    card.appendChild(goalNode)
    const reasonLabel = line('div', 'fork-proposal-label', t('Почему отдельно'))
    const reasonNode = line('p', 'fork-proposal-reason', proposal.reason)
    reasonLabel.hidden = !proposal.reason
    reasonNode.hidden = !proposal.reason
    card.append(reasonLabel, reasonNode)
    card.appendChild(line('div', 'fork-proposal-parent', t('Родительский чат') + ': ' + (options?.parentTitle || proposal.parentChatId)))
    card.appendChild(line('div', 'fork-proposal-label', t('Переносится')))
    let boundaryNode = null
    if (proposal.context.mode === 'messages') {
      card.appendChild(line('p', 'fork-proposal-context', t('Текст переписки до выбранного сообщения. Вложения, инструменты и служебные блоки не переносятся.')))
      boundaryNode = line('div', 'fork-proposal-meta', t('Сообщение') + ' ' + (proposal.context.end + 1))
      card.appendChild(boundaryNode)
    } else {
      card.appendChild(line('p', 'fork-proposal-context', t('Только выжимка. Полная история не переносится.')))
      card.appendChild(line('blockquote', 'fork-proposal-summary', proposal.context.summary))
      if (proposal.context.end !== null) {
        boundaryNode = line('div', 'fork-proposal-meta', t('Сообщение') + ' ' + (proposal.context.end + 1))
        card.appendChild(boundaryNode)
      }
    }

    // Правка до создания: поля открываются на месте. Текст модели попадает в
    // значение поля, а не в разметку, и сохраняет его вызывающий.
    const editForm = doc.createElement('div')
    editForm.className = 'fork-proposal-edit'
    editForm.hidden = true
    const field = (labelText, control) => {
      const label = line('label', 'fork-proposal-field', '')
      label.appendChild(line('span', 'fork-proposal-field-label', labelText))
      label.appendChild(control)
      return label
    }
    const titleInput = doc.createElement('input')
    titleInput.type = 'text'
    titleInput.maxLength = 200
    titleInput.className = 'fork-proposal-input-title'
    const goalInput = doc.createElement('textarea')
    goalInput.rows = 3
    goalInput.maxLength = 4000
    goalInput.className = 'fork-proposal-goal-input'
    const reasonInput = doc.createElement('textarea')
    reasonInput.rows = 2
    reasonInput.maxLength = 1000
    reasonInput.className = 'fork-proposal-reason-input'
    editForm.append(
      field(t('Название'), titleInput),
      field(t('Цель'), goalInput),
      field(t('Почему отдельно'), reasonInput)
    )
    let boundaryInput = null
    if (proposal.context.mode === 'messages') {
      boundaryInput = doc.createElement('input')
      boundaryInput.type = 'number'
      boundaryInput.min = 1
      boundaryInput.step = 1
      boundaryInput.className = 'fork-proposal-input-end'
      editForm.appendChild(field(t('Сообщение'), boundaryInput))
    }
    const saveEditButton = doc.createElement('button')
    saveEditButton.type = 'button'
    saveEditButton.dataset.action = 'save-edit'
    saveEditButton.className = 'fork-proposal-save'
    saveEditButton.textContent = t('Сохранить')
    const cancelEditButton = doc.createElement('button')
    cancelEditButton.type = 'button'
    cancelEditButton.dataset.action = 'cancel-edit'
    cancelEditButton.className = 'fork-proposal-cancel'
    cancelEditButton.textContent = t('Отмена')
    const editActions = doc.createElement('div')
    editActions.className = 'fork-proposal-actions'
    editActions.append(saveEditButton, cancelEditButton)
    editForm.appendChild(editActions)
    card.appendChild(editForm)

    const actions = doc.createElement('div')
    actions.className = 'fork-proposal-actions'
    const acceptButton = doc.createElement('button')
    acceptButton.type = 'button'
    acceptButton.dataset.action = 'accept'
    acceptButton.className = 'fork-proposal-accept'
    acceptButton.textContent = status === 'accepted' ? t('Открыть связанный чат') : t('Создать связанный чат')
    const rejectButton = doc.createElement('button')
    rejectButton.type = 'button'
    rejectButton.dataset.action = 'reject'
    rejectButton.className = 'fork-proposal-reject'
    rejectButton.textContent = t('Отклонить')
    rejectButton.hidden = status === 'accepted'
    const canEdit = status === 'pending' && typeof options?.onEdit === 'function'
    const canRun = status === 'accepted' && typeof options?.onRun === 'function'
    const editButton = doc.createElement('button')
    editButton.type = 'button'
    editButton.dataset.action = 'edit'
    editButton.className = 'fork-proposal-edit-toggle'
    editButton.textContent = t('Изменить')
    editButton.hidden = !canEdit
    const canReturn = status === 'accepted' && typeof options?.onReturn === 'function'
    const returnButton = doc.createElement('button')
    returnButton.type = 'button'
    returnButton.dataset.action = 'return'
    returnButton.className = 'fork-proposal-return'
    returnButton.textContent = t('Вернуть итог')
    returnButton.hidden = !canReturn
    const runButton = doc.createElement('button')
    runButton.type = 'button'
    runButton.dataset.action = 'run'
    runButton.className = 'fork-proposal-run'
    runButton.textContent = t('Запустить')
    runButton.hidden = !canRun
    actions.append(acceptButton, rejectButton, editButton, runButton, returnButton)
    card.appendChild(actions)
    card.appendChild(line('p', 'fork-proposal-hint', t('Создание не запускает модель.')))
    const statusLine = line('div', 'fork-proposal-status', '')
    statusLine.setAttribute('role', 'status')
    card.appendChild(statusLine)

    if (status === 'accepted') {
      card.classList.add('is-created')
      statusLine.textContent = t('Связанный чат создан.')
      acceptButton.disabled = !canOpen
    }
    if (problem) {
      card.classList.add('has-problem')
      statusLine.textContent = typeof problem.text === 'string' ? problem.text : ''
      acceptButton.disabled = true
    }

    let busy = false
    let resolvedChildId = null
    // Решения и правка видят одно и то же предложение: сохранённая правка
    // становится тем, что примет или отклонит человек.
    let current = { ...proposal, context: { ...proposal.context } }
    const lock = () => {
      busy = true
      acceptButton.disabled = true
      rejectButton.disabled = true
      editButton.disabled = true
      saveEditButton.disabled = true
      cancelEditButton.disabled = true
      titleInput.disabled = true
      goalInput.disabled = true
      reasonInput.disabled = true
      if (boundaryInput) boundaryInput.disabled = true
    }
    const unlock = () => {
      busy = false
      acceptButton.disabled = Boolean(problem)
      rejectButton.disabled = false
      editButton.disabled = false
      saveEditButton.disabled = false
      cancelEditButton.disabled = false
      titleInput.disabled = false
      goalInput.disabled = false
      reasonInput.disabled = false
      if (boundaryInput) boundaryInput.disabled = false
    }

    const openEdit = () => {
      if (busy || !canEdit) return
      titleInput.value = current.title
      goalInput.value = current.goal
      reasonInput.value = current.reason || ''
      if (boundaryInput) boundaryInput.value = current.context.end === null ? '' : String(current.context.end + 1)
      editForm.hidden = false
      editButton.hidden = true
      statusLine.textContent = ''
      if (typeof titleInput.focus === 'function') titleInput.focus()
    }
    const closeEdit = () => {
      editForm.hidden = true
      editButton.hidden = !canEdit
    }
    const showEdited = record => {
      current = { ...current, title: record.title, goal: record.goal, reason: record.reason, context: { ...record.context } }
      titleNode.textContent = current.title
      goalNode.textContent = current.goal
      reasonNode.textContent = current.reason
      reasonLabel.hidden = !current.reason
      reasonNode.hidden = !current.reason
      if (boundaryNode && current.context.end !== null) boundaryNode.textContent = t('Сообщение') + ' ' + (current.context.end + 1)
      // Правка границы меняет и место карточки: якорь переезжает вместе с ней.
      if (Number.isInteger(current.context.end)) card.dataset.forkAnchorEnd = String(current.context.end)
      else delete card.dataset.forkAnchorEnd
      placeCard(container, card)
    }

    editButton.addEventListener('click', openEdit)
    returnButton.addEventListener('click', async () => {
      if (busy) return
      lock()
      try {
        const result = await options.onReturn({ ...current, childChatId: resolvedChildId || current.childChatId || null })
        if (result && result.saved === false) { unlock(); statusLine.textContent = t('Не удалось вернуть итог.'); return }
        statusLine.textContent = t('Итог возвращён родителю.')
        unlock()
      } catch (error) {
        unlock()
        statusLine.textContent = t('Не удалось вернуть итог.')
      }
    })
    runButton.addEventListener('click', () => {
      if (busy) return
      // Запуск — отдельное явное действие: текст цели становится первым
      // сообщением хода, создание чата модель по-прежнему не запускает.
      options.onRun({ ...current, childChatId: resolvedChildId || current.childChatId || null })
    })
    cancelEditButton.addEventListener('click', () => {
      if (busy) return
      closeEdit()
      statusLine.textContent = ''
    })
    saveEditButton.addEventListener('click', async () => {
      if (busy) return
      const title = titleInput.value.trim()
      const goal = goalInput.value.trim()
      let end = current.context.end
      if (boundaryInput) {
        const typed = Number(boundaryInput.value)
        if (!Number.isInteger(typed) || typed < 1) {
          statusLine.textContent = t('Не удалось сохранить изменения.')
          return
        }
        end = typed - 1
      }
      if (!title || !goal) {
        statusLine.textContent = t('Не удалось сохранить изменения.')
        return
      }
      lock()
      try {
        const result = await options.onEdit({
          operationId: current.operationId,
          parentChatId: current.parentChatId,
          title,
          goal,
          reason: reasonInput.value.trim(),
          context: { ...current.context, end }
        })
        if (result && result.saved === false) {
          unlock()
          statusLine.textContent = t('Не удалось сохранить изменения.')
          return
        }
        showEdited(result?.record || { title, goal, reason: reasonInput.value.trim(), context: { ...current.context, end } })
        closeEdit()
        unlock()
        statusLine.textContent = t('Изменения сохранены.')
      } catch (error) {
        unlock()
        statusLine.textContent = t('Не удалось сохранить изменения.')
      }
    })

    acceptButton.addEventListener('click', async () => {
      // Принятая карточка открывает уже созданный чат — до и после перезапуска
      // одинаково, а не только по восстановленной записи.
      if (status === 'accepted' || resolvedChildId) {
        if (resolvedChildId) options?.onOpenChild?.({ ...current, childChatId: resolvedChildId })
        else if (canOpen) options.onOpenChild(current)
        return
      }
      if (busy) return
      lock()
      try {
        const result = await options?.onAccept?.(current)
        if (result && result.saved === false) {
          unlock()
          card.classList.remove('is-created')
          statusLine.textContent = t('Связанный чат открыт, но ещё не сохранён на диск. Проверьте место и права доступа.')
          return
        }
        card.classList.add('is-created')
        card.dataset.forkProposalStatus = 'accepted'
        statusLine.textContent = result && result.created === false
          ? t('Связанный чат уже создан.')
          : t('Связанный чат создан.')
        const created = result?.chat && typeof result.chat.id === 'string' ? result.chat.id : ''
        if (created) {
          resolvedChildId = created
          busy = false
          acceptButton.textContent = t('Открыть связанный чат')
          acceptButton.disabled = false
          rejectButton.hidden = true
          editButton.hidden = true
          editForm.hidden = true
          runButton.hidden = typeof options?.onRun !== 'function'
          returnButton.hidden = typeof options?.onReturn !== 'function'
        }
      } catch (error) {
        unlock()
        card.classList.remove('is-created')
        statusLine.textContent = t('Не удалось создать связанный чат.')
      }
    })
    rejectButton.addEventListener('click', async () => {
      if (busy) return
      lock()
      try {
        const result = await options?.onReject?.(current)
        if (result && result.saved === false) {
          unlock()
          statusLine.textContent = t('Не удалось отклонить предложение.')
          return
        }
        card.classList.add('is-rejected')
        card.dataset.forkProposalStatus = 'rejected'
        statusLine.textContent = t('Предложение отклонено.')
        editButton.hidden = true
        editForm.hidden = true
      } catch (error) {
        unlock()
        statusLine.textContent = t('Не удалось отклонить предложение.')
      }
    })

    return placeCard(container, card)
  }

  const api = Object.freeze({
    TOOL_NAME,
    LIMITS,
    accept,
    dismissedWith,
    findAccepted,
    findChild,
    isDismissed,
    mountCard,
    mountSummary,
    normalize,
    placeCard,
    reconcile,
    sanitize,
    summaryOf
  })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneForkProposal = api
})(typeof window === 'object' ? window : globalThis)
