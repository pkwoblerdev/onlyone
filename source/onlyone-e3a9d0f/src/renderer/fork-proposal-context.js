/* Проверка контекста предложения связанного чата (участок context).
 *
 * Перед показом и перед принятием надо убедиться, что родитель на месте, что
 * граница истории не уехала и что переписка до границы — та же, о которой
 * договаривались. Изменившийся контекст нельзя молча заменить текущей историей:
 * это был бы уже другой чат под прежним названием.
 *
 * Модуль чистый: ничего не мутирует, не сохраняет и не создаёт. Ревизия
 * считается тем же алгоритмом, что в fork-proposal.js, иначе одна и та же
 * переписка давала бы два разных отпечатка.
 */
(function (root) {
  'use strict'

  const REASONS = Object.freeze([
    'invalid-proposal',
    'parent-missing',
    'parent-mismatch',
    'boundary-missing',
    'boundary-changed',
    'revision-missing',
    'revision-changed',
    'child-deleted'
  ])

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

  function childOf (conversations, operationId, parentChatId) {
    if (!Array.isArray(conversations) || typeof operationId !== 'string' || !operationId) return null
    if (typeof parentChatId !== 'string' || !parentChatId) return null
    return conversations.find(chat => chat && chat.fork &&
      chat.fork.proposalOperationId === operationId && chat.fork.parentChatId === parentChatId) || null
  }

  function check (proposal, options) {
    if (!proposal || typeof proposal !== 'object') return { ok: false, reason: 'invalid-proposal' }
    const parent = options?.parent
    if (!parent || typeof parent !== 'object') return { ok: false, reason: 'parent-missing' }
    if (typeof proposal.parentChatId !== 'string' || !proposal.parentChatId) return { ok: false, reason: 'invalid-proposal' }
    if (parent.id !== proposal.parentChatId) return { ok: false, reason: 'parent-mismatch' }
    const context = proposal.context
    if (!context || typeof context !== 'object') return { ok: false, reason: 'boundary-missing' }
    const messages = Array.isArray(parent.messages) ? parent.messages : []
    const end = context.end
    if (end !== null && end !== undefined && (!Number.isInteger(end) || end < 0)) return { ok: false, reason: 'boundary-missing' }
    const bounded = end !== null && end !== undefined
    if (bounded && end >= messages.length) return { ok: false, reason: 'boundary-changed' }
    // Выжимка без границы не зависит от истории: сверять нечего.
    if (bounded || context.mode !== 'summary') {
      if (typeof context.revision !== 'string' || !context.revision) return { ok: false, reason: 'revision-missing' }
      if (revisionOf(messages, end) !== context.revision) return { ok: false, reason: 'revision-changed' }
    }
    if (proposal.status === 'accepted') {
      const child = childOf(options?.conversations, proposal.operationId, proposal.parentChatId)
      if (!child) return { ok: false, reason: 'child-deleted' }
      return { ok: true, child }
    }
    return { ok: true }
  }

  const api = Object.freeze({ REASONS, check, childOf, revisionOf })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneForkProposalContext = api
})(typeof window === 'object' ? window : globalThis)
