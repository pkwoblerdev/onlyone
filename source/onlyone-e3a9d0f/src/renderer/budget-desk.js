/* Бюджет задачи в Desk: только чтение состояния и настроек, без строки ввода.

   Источник — снимок checkpoint.budget() (task-state.cjs → task-budget.cjs), а не
   второй счётчик: сколько потрачено, что ещё в активных резервах, что ушло с
   неизвестным расходом токенов, сколько осталось до общего срока и почему задача
   остановлена. Настройки — те же, что в окне Onlyone; здесь они только читаются.

   Модуль без DOM-зависимостей в `view`: его можно проверить без окна. `paint`
   рисует готовую модель теми же классами, что шторки Desk, и не создаёт полей
   ввода — менять пределы можно только на экране настроек Onlyone. */
(function (root, factory) {
  'use strict'
  const api = factory(root)
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneBudgetDesk = api
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict'

  // Совпадает с MAX_RESERVATIONS в task-budget.cjs; снимок приносит сам список.
  const MAX_RESERVATIONS = 64
  const MINUTE = 60 * 1000
  const DEFAULTS = { requests: null, tokens: null, deadlineMinutes: null }

  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
  const group = value => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  // Без словаря модуль всё равно читаем: те же «%s», что подставляет t(...).
  const defaultT = (source, ...args) => args.reduce((text, value) => text.replace('%s', value), source)

  function duration (ms, t) {
    const total = Math.max(0, Math.floor(number(ms) / 1000))
    if (total < 60) return t('%s с', total)
    const mins = Math.floor(total / 60)
    if (mins < 60) return t('%s мин', mins)
    const hours = Math.floor(mins / 60)
    const rest = mins % 60
    return rest ? t('%s ч %s мин', hours, rest) : t('%s ч', hours)
  }

  const limitText = (limit, t) => limit === null || limit === undefined ? t('без предела') : group(limit)
  const leftOf = (limit, used, reserved) => limit === null || limit === undefined ? null : Math.max(0, limit - used - reserved)

  function toneOf (limit, remaining) {
    if (limit === null || limit === undefined || remaining === null) return 'default'
    if (remaining <= 0) return 'danger'
    return remaining <= Math.max(1, Math.floor(limit / 10)) ? 'warn' : 'default'
  }

  function deadlineState (at, now, t) {
    if (at === null || at === undefined) return { at: null, leftMs: null, expired: false, text: t('без срока'), tone: 'quiet' }
    const leftMs = at - now
    if (leftMs <= 0) return { at, leftMs: 0, expired: true, text: t('срок истёк'), tone: 'danger' }
    return {
      at, leftMs, expired: false,
      text: t('осталось %s', duration(leftMs, t)),
      tone: leftMs <= 10 * MINUTE ? 'warn' : 'default'
    }
  }

  // Отказ приходит из checkpoint.reserveBudget/settleBudget: dimension от
  // task-budget или error/durable от отказа записи. Явный отказ точнее вывода
  // из снимка — он и показывается первым.
  function reasonOf (snapshot, refusal, now, t) {
    if (refusal && typeof refusal === 'object') {
      if (refusal.error === 'not_durable' || refusal.durable === false) {
        return {
          code: 'write', tone: 'danger', text: t('Остановка: резерв не сохранился на диск'),
          detail: t('Без записи запрос не начинается. Проверьте доступ к папке данных.')
        }
      }
      if (refusal.error === 'no_budget') {
        return { code: 'none', tone: 'quiet', text: t('Бюджет задачи не подключён'), detail: '' }
      }
      if (refusal.dimension === 'deadline') {
        return { code: 'deadline', tone: 'danger', text: t('Истёк общий срок задачи'), detail: '' }
      }
      if (refusal.dimension === 'unknown') {
        return {
          code: 'unknown', tone: 'warn', text: t('Остановка: запросы с неизвестным расходом'),
          detail: t('Свободный остаток токенов не выдаётся, пока расход не уточнён.')
        }
      }
      if (refusal.dimension === 'reservations' || refusal.dimension === 'overrides') {
        return {
          code: 'reservations', tone: 'warn', text: t('Остановка: слишком много активных резервов'),
          detail: t('Дождитесь завершения запросов в пути или уточните их исход.')
        }
      }
      if (refusal.dimension === 'requests' || refusal.dimension === 'tokens') {
        return {
          code: 'budget', dimension: refusal.dimension, tone: 'danger', text: t('Бюджет задачи исчерпан'),
          detail: refusal.dimension === 'requests' ? t('Закончились запросы') : t('Закончились токены')
        }
      }
    }
    if (!snapshot || typeof snapshot !== 'object') return null
    if (snapshot.deadlineAt !== null && snapshot.deadlineAt !== undefined && now >= snapshot.deadlineAt) {
      return { code: 'deadline', tone: 'danger', text: t('Истёк общий срок задачи'), detail: '' }
    }
    const used = snapshot.used || {}
    const reserved = snapshot.reserved || {}
    for (const dim of ['requests', 'tokens']) {
      const limit = snapshot.limits ? snapshot.limits[dim] : null
      if (limit === null || limit === undefined) continue
      if (number(used[dim]) + number(reserved[dim]) >= limit) {
        return {
          code: 'budget', dimension: dim, tone: 'danger', text: t('Бюджет задачи исчерпан'),
          detail: dim === 'requests' ? t('Закончились запросы') : t('Закончились токены')
        }
      }
    }
    if (Array.isArray(snapshot.reservations) && snapshot.reservations.length >= MAX_RESERVATIONS) {
      return {
        code: 'reservations', tone: 'warn', text: t('Остановка: слишком много активных резервов'),
        detail: t('Дождитесь завершения запросов в пути или уточните их исход.')
      }
    }
    return null
  }

  // Модель представления. Ничего не считает заново: потраченное, резервы,
  // неизвестный расход и срок берутся из снимка, настройки — из проверенного
  // объекта настроек (main/budget-settings.cjs).
  function view ({ snapshot = null, settings = null, now = Date.now(), refusal = null, t = defaultT } = {}) {
    const present = Boolean(snapshot && snapshot.limits && snapshot.used && snapshot.reserved)
    const limits = present ? snapshot.limits : {}
    const used = present ? snapshot.used : { requests: 0, tokens: 0, ms: 0 }
    const reserved = present ? snapshot.reserved : { requests: 0, tokens: 0 }
    const unknownUsage = present ? number(snapshot.unknownUsage) : 0

    const requestsLeft = leftOf(limits.requests, number(used.requests), number(reserved.requests))
    const tokensLeft = leftOf(limits.tokens, number(used.tokens), number(reserved.tokens))
    const requests = {
      used: number(used.requests), limit: limits.requests ?? null, remaining: requestsLeft,
      text: `${group(used.requests)} / ${limitText(limits.requests, t)}`,
      note: requestsLeft === null ? t('без предела') : t('осталось %s', group(requestsLeft)),
      tone: toneOf(limits.requests, requestsLeft)
    }
    const tokens = {
      used: number(used.tokens), limit: limits.tokens ?? null, remaining: tokensLeft,
      text: `${group(used.tokens)} / ${limitText(limits.tokens, t)}`,
      note: tokensLeft === null ? t('без предела') : t('осталось %s', group(tokensLeft)),
      tone: toneOf(limits.tokens, tokensLeft), unknown: unknownUsage
    }
    const reservedRow = {
      requests: number(reserved.requests), tokens: number(reserved.tokens),
      zero: number(reserved.requests) === 0 && number(reserved.tokens) === 0,
      text: number(reserved.requests) === 0 && number(reserved.tokens) === 0
        ? t('нет')
        : t('%s запросов, %s токенов', group(reserved.requests), group(reserved.tokens))
    }
    const unknown = {
      requests: unknownUsage, present: unknownUsage > 0,
      text: unknownUsage > 0 ? t('%s запросов без счёта токенов', group(unknownUsage)) : t('нет')
    }
    const deadline = deadlineState(present ? snapshot.deadlineAt : null, now, t)
    const reason = present ? reasonOf(snapshot, refusal, now, t) : null

    const rows = []
    if (present) {
      rows.push({ key: 'requests', label: t('Запросы'), value: requests.text, note: requests.note, tone: requests.tone })
      rows.push({ key: 'tokens', label: t('Токены'), value: tokens.text, note: tokens.note, tone: tokens.tone })
      rows.push({ key: 'reserved', label: t('Резервы'), value: reservedRow.text, note: t('Ещё не списано: запросы в пути'), tone: 'default' })
      rows.push({ key: 'unknown', label: t('Неизвестный расход'), value: unknown.text, tone: unknown.present ? 'warn' : 'default' })
      rows.push({ key: 'deadline', label: t('Общий срок'), value: deadline.text, note: t('Время запросов: %s', duration(used.ms, t)), tone: deadline.tone })
    }

    const given = settings && typeof settings === 'object' ? settings : DEFAULTS
    const settingsRows = [
      { key: 'requests', label: t('Запросы'), value: limitText(given.requests, t) },
      { key: 'tokens', label: t('Токены'), value: limitText(given.tokens, t) },
      {
        key: 'deadline', label: t('Общий срок'),
        value: given.deadlineMinutes === null || given.deadlineMinutes === undefined
          ? t('без срока') : duration(given.deadlineMinutes * MINUTE, t)
      }
    ]

    return {
      present,
      empty: present ? null : t('Задача не идёт: бюджета пока нет.'),
      title: t('Бюджет задачи'),
      requests, tokens,
      reserved: reservedRow, unknown, deadline, reason,
      rows,
      settingsTitle: t('Действующие пределы'),
      settingsRows,
      settingsNote: t('Для новых задач. Продолжение тратит сохранённый остаток и срок.'),
      policy: t('Смена пределов действует на новую задачу; изменить текущую можно только явным решением, и срок не отодвигается.')
    }
  }

  function element (document, tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function paintRow (document, row, extraClass) {
    const node = element(document, 'div', 'desk-budget-row' + (extraClass ? ' ' + extraClass : ''))
    node.dataset.tone = row.tone || 'default'
    node.append(element(document, 'span', 'desk-budget-label', row.label), element(document, 'span', 'desk-budget-value', row.value))
    if (row.note) node.append(element(document, 'span', 'desk-budget-note', row.note))
    return node
  }

  // Рисует панель в переданный контейнер. Никаких input/select/textarea:
  // настройки здесь только читаются, менять их можно в Onlyone.
  function paint (container, model, { document = root.document } = {}) {
    if (!container || !model || !document) return null
    const nodes = [element(document, 'h3', 'desk-lab', model.title)]
    if (model.empty) nodes.push(element(document, 'p', 'desk-quiet', model.empty))
    if (model.reason) {
      const reason = element(document, 'div', 'desk-budget-reason')
      reason.dataset.tone = model.reason.tone || 'danger'
      reason.append(element(document, 'span', 'desk-budget-reason-title', model.reason.text))
      if (model.reason.detail) reason.append(element(document, 'span', 'desk-budget-reason-detail', model.reason.detail))
      nodes.push(reason)
    }
    for (const row of model.rows) nodes.push(paintRow(document, row))
    nodes.push(element(document, 'h3', 'desk-lab', model.settingsTitle))
    for (const row of model.settingsRows) nodes.push(paintRow(document, row, 'is-settings'))
    if (model.settingsNote) nodes.push(element(document, 'p', 'desk-quiet', model.settingsNote))
    if (model.policy) nodes.push(element(document, 'p', 'desk-budget-policy', model.policy))
    container.replaceChildren(...nodes)
    return container
  }

  return { view, paint, duration, MAX_RESERVATIONS, MINUTE }
})
