/* Восстановление карточек предложений после чтения сохранённой переписки.
 *
 * Событие предложения одноразовое, поэтому после перезапуска карточку надо
 * собрать заново из описи на чате-родителе. Ожидающие показываются как есть,
 * принятые — с кнопкой «открыть» уже созданный дочерний чат, отклонённые не
 * возвращаются никогда.
 *
 * Модуль ничего не сохраняет и не принимает: решения делает app.js через
 * переданные handlers. Кэш карточек — тот же, что у ленты, иначе перерисовка
 * задвоила бы карточки и обработчики.
 */
(function (root) {
  'use strict'

  const PROBLEM_TEXT = Object.freeze({
    'context-changed': 'Контекст предложения изменился.',
    'child-deleted': 'Связанный чат удалён.',
    unreadable: 'Предложения этого чата не читаются: запись повреждена.'
  })

  function proposalOf (record) {
    return {
      version: 1,
      operationId: record.operationId,
      parentChatId: record.parentChatId,
      title: record.title,
      goal: record.goal,
      reason: record.reason,
      context: {
        mode: record.context.mode,
        end: record.context.end,
        revision: record.context.revision,
        summary: record.context.summary
      },
      createdAt: record.createdAt
    }
  }

  function plan (options) {
    const source = options?.source
    if (!source || typeof source.id !== 'string' || !source.id) return { ok: false, reason: 'invalid-source' }
    const store = options?.store || root.OnlyoneForkProposalStore
    const contextApi = options?.contextApi || root.OnlyoneForkProposalContext
    if (!store || typeof store.read !== 'function') return { ok: false, reason: 'storage-missing' }
    const ledger = store.read(source)
    if (!ledger.ok) return { ok: false, reason: ledger.reason }
    const conversations = Array.isArray(options?.conversations) ? options.conversations : []
    const entries = []
    for (const record of ledger.proposals) {
      if (record.status === 'rejected') continue
      if (record.status === 'accepted') {
        const child = contextApi?.childOf?.(conversations, record.operationId, source.id) || null
        entries.push({
          record,
          status: 'accepted',
          problemCode: child ? null : 'child-deleted',
          openChildId: child ? child.id : null
        })
        continue
      }
      const check = contextApi?.check?.(record, { parent: source, conversations }) || { ok: true }
      entries.push({
        record,
        status: 'pending',
        problemCode: check.ok ? null : 'context-changed',
        openChildId: null
      })
    }
    return { ok: true, entries }
  }

  function ensure (options) {
    const source = options?.source
    const container = options?.container
    if (!container || typeof container.appendChild !== 'function') return { ok: false, reason: 'invalid-container', mounted: 0 }
    const planResult = plan(options)
    if (!planResult.ok) return { ok: false, reason: planResult.reason, mounted: 0 }
    const proposalApi = options?.proposalApi || root.OnlyoneForkProposal
    const mountCard = options?.mountCard || proposalApi?.mountCard
    if (typeof mountCard !== 'function') return { ok: false, reason: 'model-missing', mounted: 0 }
    const cache = options?.cache
    const t = typeof options?.t === 'function' ? options.t : text => text
    const handlers = options?.handlers || {}
    let mounted = 0
    let skipped = 0
    for (const entry of planResult.entries) {
      const key = source.id + ':' + entry.record.operationId
      if (cache?.has?.(key)) { skipped++; continue }
      const problem = entry.problemCode
        ? { code: entry.problemCode, text: t(PROBLEM_TEXT[entry.problemCode] || PROBLEM_TEXT.unreadable) }
        : null
      const card = mountCard(container, proposalOf(entry.record), {
        t,
        parentTitle: options?.parentTitle,
        status: entry.status,
        problem,
        onOpenChild: entry.openChildId ? () => handlers.onOpenChild?.(entry.record) : null,
        onRun: entry.status === 'accepted' && entry.openChildId ? () => handlers.onRun?.(entry.record) : null,
        onReturn: entry.status === 'accepted' && entry.openChildId ? () => handlers.onReturn?.(entry.record) : null,
        onAccept: item => handlers.onAccept?.(item),
        onReject: item => handlers.onReject?.(item),
        onEdit: item => handlers.onEdit?.(item)
      })
      cache?.set?.(key, { chatId: source.id, card })
      mounted++
    }
    return { ok: true, mounted, skipped }
  }

  const api = Object.freeze({ PROBLEM_TEXT, ensure, plan, proposalOf })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneForkProposalRestore = api
})(typeof window === 'object' ? window : globalThis)
