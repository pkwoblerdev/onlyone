/* Возврат итога связанной задачи родителю (Ф-4, ограниченный срез).
 *
 * Родитель получает одну адресную запись со ссылкой на дочерний чат и текстом
 * последнего ответа. Модель родителя не вызывается, переписка не копируется.
 * Запись живёт на родителе (`forkReturns`) в том же защищённом хранилище;
 * повтор того же ответа не создаёт вторую запись.
 */
(function (root) {
  'use strict'

  const RECORD_VERSION = 1
  const LIMITS = Object.freeze({ text: 4000, records: 50 })
  const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

  function hash (value) {
    const text = String(value)
    let result = 0x811c9dc5
    for (let index = 0; index < text.length; index++) {
      result ^= text.charCodeAt(index)
      result = Math.imul(result, 0x01000193) >>> 0
    }
    return result.toString(16).padStart(8, '0')
  }

  function textOf (chat) {
    const messages = Array.isArray(chat?.messages) ? chat.messages : []
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (!message || message.role !== 'assistant') continue
      const content = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
          : ''
      const text = content.trim()
      if (!text) continue
      const key = Number.isFinite(message.timestamp) ? 't:' + message.timestamp : 'h:' + hash(text)
      return { messageKey: key, text }
    }
    return null
  }

  function isRecord (entry) {
    return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry) &&
      entry.version === RECORD_VERSION &&
      typeof entry.operationId === 'string' && OPERATION_ID.test(entry.operationId) &&
      typeof entry.childChatId === 'string' && entry.childChatId &&
      typeof entry.messageKey === 'string' && entry.messageKey &&
      typeof entry.text === 'string' && entry.text && entry.text.length <= LIMITS.text &&
      Number.isFinite(entry.createdAt))
  }

  function read (chat) {
    if (!chat || typeof chat !== 'object' || Array.isArray(chat)) return { ok: false, reason: 'invalid-chat' }
    const ledger = chat.forkReturns
    if (ledger === undefined) return { ok: true, version: RECORD_VERSION, returns: [], skipped: 0 }
    if (!Array.isArray(ledger)) return { ok: false, reason: 'invalid-shape' }
    const returns = []
    const seen = new Set()
    let skipped = 0
    for (const entry of ledger) {
      if (!isRecord(entry) || seen.has(entry.operationId + '\u0000' + entry.messageKey)) { skipped++; continue }
      seen.add(entry.operationId + '\u0000' + entry.messageKey)
      returns.push({ ...entry })
    }
    return { ok: true, version: RECORD_VERSION, returns, skipped }
  }

  function list (chat) {
    const ledger = read(chat)
    return ledger.ok ? ledger.returns : []
  }

  function isReturned (chat, operationId, messageKey) {
    return list(chat).some(record => record.operationId === operationId && record.messageKey === messageKey)
  }

  function put (chat, input, options = {}) {
    if (!chat || typeof chat.id !== 'string' || !chat.id) return { ok: false, reason: 'invalid-chat' }
    const ledger = read(chat)
    if (!ledger.ok) return { ok: false, reason: ledger.reason }
    const operationId = typeof input?.operationId === 'string' ? input.operationId.trim() : ''
    const childChatId = typeof input?.childChatId === 'string' ? input.childChatId.trim() : ''
    const messageKey = typeof input?.messageKey === 'string' ? input.messageKey.trim() : ''
    const text = typeof input?.text === 'string' ? input.text.trim().slice(0, LIMITS.text) : ''
    if (!OPERATION_ID.test(operationId) || !childChatId || !messageKey || !text) return { ok: false, reason: 'invalid-return' }
    const existing = ledger.returns.find(record => record.operationId === operationId && record.messageKey === messageKey)
    if (existing) return { ok: true, record: existing, existing: true }
    if (ledger.returns.length >= LIMITS.records) return { ok: false, reason: 'limit' }
    // Время возврата: options.now (документированный вызов), затем input.now — его
    // передаёт app.js внутри input, и без этого createdAt навсегда 0 (break-2 Н5).
    const at = Number.isFinite(options.now) ? options.now
      : (Number.isFinite(input?.now) ? input.now
        : (Number.isFinite(input?.createdAt) ? input.createdAt : 0))
    const record = { version: RECORD_VERSION, operationId, childChatId, messageKey, text, createdAt: at }
    chat.forkReturns = (chat.forkReturns || []).concat([record])
    return { ok: true, record, existing: false }
  }

  function drop (chat, operationId, messageKey) {
    const ledger = read(chat)
    if (!ledger.ok) return { ok: false, reason: ledger.reason }
    const index = chat.forkReturns.findIndex(entry => isRecord(entry) && entry.operationId === operationId && entry.messageKey === messageKey)
    if (index < 0) return { ok: false, reason: 'not-found' }
    chat.forkReturns.splice(index, 1)
    return { ok: true }
  }

  function mountCard (container, record, options) {
    if (!container || typeof container.appendChild !== 'function') return null
    const doc = container.ownerDocument || root.document
    if (!doc) return null
    const t = typeof options?.t === 'function' ? options.t : text => text
    // Ключ — произвольная строка реестра (повреждённая запись терпима read()):
    // в CSS-селектор она не подставляется, иначе кавычка/скобка валила бы
    // querySelector и весь renderMessages. Селектор постоянный, сверка по dataset (Н4).
    const existing = Array.from(container.querySelectorAll('[data-fork-return-key]'))
      .find(node => node.dataset.forkReturnKey === record.messageKey)
    if (existing) return existing
    const card = doc.createElement('section')
    card.className = 'fork-return-card'
    card.dataset.forkReturnKey = record.messageKey
    card.dataset.forkReturnOperation = record.operationId
    card.setAttribute('role', 'group')
    card.setAttribute('aria-label', t('Итог связанной задачи'))
    const kicker = doc.createElement('div')
    kicker.className = 'fork-return-kicker'
    kicker.textContent = t('Итог связанной задачи')
    const title = doc.createElement('div')
    title.className = 'fork-return-title'
    title.textContent = options?.childTitle || t('Связанный чат')
    const body = doc.createElement('blockquote')
    body.className = 'fork-return-text'
    body.textContent = record.text.length > 2000 ? record.text.slice(0, 2000) + '…' : record.text
    card.append(kicker, title, body)
    if (typeof options?.onOpenChild === 'function') {
      const open = doc.createElement('button')
      open.type = 'button'
      open.className = 'fork-return-open'
      open.dataset.action = 'open-child'
      open.textContent = t('Открыть чат')
      open.addEventListener('click', () => options.onOpenChild(record))
      card.appendChild(open)
    }
    container.appendChild(card)
    return card
  }

  const api = Object.freeze({ LIMITS, RECORD_VERSION, drop, isReturned, list, mountCard, put, read, textOf })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneForkReturn = api
})(typeof window === 'object' ? window : globalThis)
