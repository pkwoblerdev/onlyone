/* Опись предложений связанного чата (участок хранения).
 *
 * Второй базы нет: записи лежат в самом чате-родителе полем `forkProposals`
 * и едут существующим защищённым хранилищем переписок. Модуль ничего не
 * сохраняет: мутирует переданный чат, а на диск пишет вызывающий.
 *
 * Чужая или битая запись пропускается и не мешает остальным. Неизвестная
 * опись (не массив или запись с version > 1) не читается и не перезаписывается:
 * молча терять формат будущей версии нельзя.
 */
(function (root) {
  'use strict'

  const RECORD_VERSION = 1
  const STATUSES = Object.freeze(['pending', 'accepted', 'rejected'])
  const LIMITS = Object.freeze({
    title: 200,
    goal: 4000,
    reason: 1000,
    summary: 8000,
    maxProposals: 20,
    maxPending: 5
  })
  const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

  function cleanText (value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : ''
  }

  // Тот же отпечаток, что в fork-proposal.js и fork-proposal-context.js:
  // иначе правка границы дала бы ревизию, которую принятие не узнает.
  function hash (value) {
    const text = String(value)
    let result = 0x811c9dc5
    for (let index = 0; index < text.length; index++) {
      result ^= text.charCodeAt(index)
      result = Math.imul(result, 0x01000193) >>> 0
    }
    return result.toString(16).padStart(8, '0')
  }

  function revisionOf (messages, end) {
    return 'h:' + hash(JSON.stringify(messages.slice(0, end + 1)))
  }

  function fail (reason) {
    return { ok: false, reason }
  }

  function isRecord (entry, chatId) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    if (entry.version !== RECORD_VERSION) return false
    if (typeof entry.operationId !== 'string' || !OPERATION_ID.test(entry.operationId)) return false
    if (typeof chatId !== 'string' || !chatId || entry.parentChatId !== chatId) return false
    if (!STATUSES.includes(entry.status)) return false
    if (typeof entry.title !== 'string' || typeof entry.goal !== 'string' || typeof entry.reason !== 'string') return false
    const context = entry.context
    if (!context || typeof context !== 'object' || Array.isArray(context)) return false
    if (context.mode !== 'messages' && context.mode !== 'summary') return false
    if (context.end !== null && (!Number.isInteger(context.end) || context.end < 0)) return false
    return typeof context.summary === 'string' && typeof context.revision === 'string'
  }

  function read (chat) {
    if (!chat || typeof chat !== 'object' || Array.isArray(chat)) return fail('invalid-chat')
    const ledger = chat.forkProposals
    if (ledger === undefined) return { ok: true, version: RECORD_VERSION, proposals: [], skipped: 0 }
    if (!Array.isArray(ledger)) return fail('invalid-shape')
    if (ledger.some(entry => entry && typeof entry === 'object' && Number.isInteger(entry.version) && entry.version > RECORD_VERSION)) {
      return fail('unknown-version')
    }
    const proposals = []
    const seen = new Set()
    let skipped = 0
    for (const entry of ledger) {
      if (isRecord(entry, chat.id)) {
        if (seen.has(entry.operationId)) {
          // Дубликат id в испорченной описи: первый — источник решения, второй
          // не должен давать вторую карточку или второй статус.
          skipped++
          continue
        }
        seen.add(entry.operationId)
        // Читаем с теми же пределами, с какими пишем: запись, пришедшая из
        // испорченного файла, не должна рисовать мегабайтный заголовок.
        proposals.push({
          ...entry,
          title: cleanText(entry.title, LIMITS.title),
          goal: cleanText(entry.goal, LIMITS.goal),
          reason: cleanText(entry.reason, LIMITS.reason),
          context: { ...entry.context, summary: cleanText(entry.context.summary, LIMITS.summary) }
        })
      } else skipped++
    }
    return { ok: true, version: RECORD_VERSION, proposals, skipped }
  }

  function get (chat, operationId) {
    if (typeof operationId !== 'string' || !operationId) return null
    const ledger = read(chat)
    if (!ledger.ok) return null
    return ledger.proposals.find(record => record.operationId === operationId) || null
  }

  function status (chat, operationId) {
    const record = get(chat, operationId)
    if (record) return record.status
    if (typeof operationId !== 'string' || !operationId) return null
    return Array.isArray(chat?.forkProposalDismissed) && chat.forkProposalDismissed.includes(operationId) ? 'rejected' : null
  }

  function pending (chat) {
    const ledger = read(chat)
    return ledger.ok ? ledger.proposals.filter(record => record.status === 'pending') : []
  }

  function isPending (chat, operationId) {
    return status(chat, operationId) === 'pending'
  }

  function isAccepted (chat, operationId) {
    return status(chat, operationId) === 'accepted'
  }

  function isRejected (chat, operationId) {
    return status(chat, operationId) === 'rejected'
  }

  function put (chat, proposal, options) {
    const ledger = read(chat)
    if (!ledger.ok) return fail(ledger.reason)
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return fail('invalid-proposal')
    if (typeof proposal.operationId !== 'string' || !OPERATION_ID.test(proposal.operationId)) return fail('invalid-operation-id')
    if (typeof chat.id !== 'string' || !chat.id || proposal.parentChatId !== chat.id) return fail('invalid-parent')
    const context = proposal.context
    if (!context || typeof context !== 'object' || Array.isArray(context)) return fail('invalid-proposal')
    if (context.mode !== 'messages' && context.mode !== 'summary') return fail('invalid-proposal')
    const end = context.end === undefined ? null : context.end
    if (end !== null && (!Number.isInteger(end) || end < 0)) return fail('invalid-proposal')
    const title = cleanText(proposal.title, LIMITS.title)
    const goal = cleanText(proposal.goal, LIMITS.goal)
    if (!title || !goal) return fail('invalid-proposal')
    let status = options?.status === undefined ? 'pending' : options.status
    if (!STATUSES.includes(status)) return fail('invalid-status')

    const existing = ledger.proposals.find(record => record.operationId === proposal.operationId)
    if (existing) return { ok: true, record: existing, existing: true }

    // Старое отклонение не воскрешаем: запись сразу rejected, поле не трогаем.
    if (status === 'pending' && Array.isArray(chat.forkProposalDismissed) && chat.forkProposalDismissed.includes(proposal.operationId)) {
      status = 'rejected'
    }
    // Потолки считаются по читаемым записям: битые и чужие не занимают место.
    if (ledger.proposals.length >= LIMITS.maxProposals) return fail('limit')
    if (status === 'pending' && ledger.proposals.filter(record => record.status === 'pending').length >= LIMITS.maxPending) return fail('limit')
    const at = Number.isFinite(options?.now) ? options.now : (Number.isFinite(proposal.createdAt) ? proposal.createdAt : 0)
    const record = {
      version: RECORD_VERSION,
      operationId: proposal.operationId,
      parentChatId: chat.id,
      title,
      goal,
      reason: cleanText(proposal.reason, LIMITS.reason),
      context: {
        mode: context.mode,
        end,
        revision: typeof context.revision === 'string' ? context.revision : '',
        summary: context.mode === 'summary' ? cleanText(context.summary, LIMITS.summary) : ''
      },
      createdAt: at,
      updatedAt: at,
      status,
      childChatId: null,
      decidedAt: status === 'pending' ? null : at
    }
    chat.forkProposals = (chat.forkProposals || []).concat([record])
    return { ok: true, record, existing: false }
  }

  function setStatus (chat, operationId, status, options) {
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) return fail('invalid-operation-id')
    if (!STATUSES.includes(status)) return fail('invalid-status')
    const ledger = read(chat)
    if (!ledger.ok) return fail(ledger.reason)
    const current = ledger.proposals.find(record => record.operationId === operationId)
    if (!current) return fail('not-found')
    if (current.status === status) return { ok: true, record: current }
    if (current.status !== 'pending') return fail('not-allowed')
    const childChatId = typeof options?.childChatId === 'string' ? options.childChatId.trim() : ''
    if (status === 'accepted' && !childChatId) return fail('invalid-child')
    const at = Number.isFinite(options?.now) ? options.now : (Number.isFinite(current.updatedAt) ? current.updatedAt : 0)
    const record = {
      ...current,
      context: { ...current.context },
      status,
      childChatId: status === 'accepted' ? childChatId : null,
      updatedAt: at,
      decidedAt: at
    }
    const raw = Array.isArray(chat.forkProposals) ? chat.forkProposals : []
    const index = raw.findIndex(entry => isRecord(entry, chat.id) && entry.operationId === operationId)
    if (index < 0) return fail('not-found')
    raw[index] = record
    return { ok: true, record }
  }

  // Правка ожидающего предложения до создания. Ревизия не принимается от
  // вызывающего: она пересчитывается по текущей истории родителя и новой
  // границе, иначе принятие сверяло бы отпечаток, которого не видело.
  function update (chat, operationId, patch, options) {
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) return fail('invalid-operation-id')
    const ledger = read(chat)
    if (!ledger.ok) return fail(ledger.reason)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return fail('invalid-patch')
    const current = ledger.proposals.find(record => record.operationId === operationId)
    if (!current) return fail('not-found')
    if (current.status !== 'pending') return fail('not-allowed')

    const title = patch.title === undefined ? current.title : cleanText(patch.title, LIMITS.title)
    const goal = patch.goal === undefined ? current.goal : cleanText(patch.goal, LIMITS.goal)
    if (!title || !goal) return fail('invalid-patch')
    const reason = patch.reason === undefined ? current.reason : cleanText(patch.reason, LIMITS.reason)

    const context = patch.context === undefined ? current.context : patch.context
    if (!context || typeof context !== 'object' || Array.isArray(context)) return fail('invalid-context')
    const mode = context.mode === undefined ? current.context.mode : context.mode
    if (mode !== 'messages' && mode !== 'summary') return fail('invalid-context')
    const end = context.end === undefined ? current.context.end : context.end
    if (end !== null && (!Number.isInteger(end) || end < 0)) return fail('invalid-context')
    const messages = Array.isArray(chat.messages) ? chat.messages : null
    let revision = ''
    if (mode === 'messages') {
      if (end === null || !messages || end >= messages.length) return fail('invalid-context')
      revision = revisionOf(messages, end)
    } else if (end !== null) {
      if (!messages || end >= messages.length) return fail('invalid-context')
      revision = revisionOf(messages, end)
    }
    const summary = mode === 'summary'
      ? cleanText(context.summary === undefined ? current.context.summary : context.summary, LIMITS.summary)
      : ''
    if (mode === 'summary' && !summary) return fail('invalid-context')

    const at = Number.isFinite(options?.now) ? options.now : (Number.isFinite(current.updatedAt) ? current.updatedAt : 0)
    const record = {
      ...current,
      title,
      goal,
      reason,
      context: { mode, end, revision, summary },
      updatedAt: at
    }
    const raw = Array.isArray(chat.forkProposals) ? chat.forkProposals : []
    const index = raw.findIndex(entry => isRecord(entry, chat.id) && entry.operationId === operationId)
    if (index < 0) return fail('not-found')
    raw[index] = record
    return { ok: true, record }
  }

  const api = Object.freeze({
    LIMITS,
    RECORD_VERSION,
    STATUSES,
    get,
    isAccepted,
    isPending,
    isRejected,
    pending,
    put,
    read,
    setStatus,
    status,
    update
  })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneForkProposalStore = api
})(typeof window === 'object' ? window : globalThis)
