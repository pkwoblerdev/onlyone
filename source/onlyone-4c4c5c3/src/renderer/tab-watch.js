/* Наблюдатель вкладки (волна 4): страница изменилась — модель просыпается сразу.
 *
 * Вкладка браузера стоит открытой: на ней идёт таймер, пришла цена, появилась строка в
 * списке. Человек один раз говорит, что делать («когда таймер дойдёт до 0:00 — запиши результат
 * и сними страницу»), и больше не следит: как только страница изменилась по условию, в чат само
 * уходит сообщение — что было, что стало, что поручено — со снимком страницы. Модель делает
 * то, что нужно, и в этом же ходе видит результат.
 *
 * Страница сообщает об изменении сама: в неё вставляется короткий наблюдатель (OBSERVER) —
 * MutationObserver плюс секундная проверка. Он пишет в консоль строку с меткой, которую
 * вкладка отдаёт окну событием console-message; опроса из окна нет, поэтому реакция — доли секунды.
 *
 * Модуль решает «будить или нет» и собирает сообщение; всё остальное (вставка наблюдателя,
 * снимок, отправка в чат) приходит через deps.
 */
(function (root) {
  'use strict'

  const MARK = '\u0001ONLYONE-CHANGE '
  const DEFAULT_GAP_MS = 10 * 1000
  const HOUR_MS = 60 * 60 * 1000
  const HOUR_LIMIT = 30
  const TEXT_LIMIT = 300

  // Код для вставки в страницу. Видимый текст сводится к одной строке; об изменении сообщается
  // не чаще раза в 120 мс, плюс страховочная проверка раз в секунду — на случай обновлений, которые
  // MutationObserver не видит (значение, подставленное в поле, текст внутри shadow-DOM).
  const OBSERVER = `(() => {
    if (window.__onlyoneWatch) return 'уже стоит'
    window.__onlyoneWatch = true
    const read = () => String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 4000)
    let last = read()
    let pending = null
    const check = () => {
      pending = null
      const now = read()
      if (now === last) return
      const before = last
      last = now
      console.log(${JSON.stringify(MARK)} + JSON.stringify({ before: before.slice(0, 600), after: now.slice(0, 600), title: document.title }))
    }
    new MutationObserver(() => { if (!pending) pending = setTimeout(check, 120) })
      .observe(document, { subtree: true, childList: true, characterData: true })
    setInterval(check, 1000)
    return 'поставлен'
  })()`

  function parseChange (message) {
    const text = String(message || '')
    if (!text.startsWith(MARK)) return null
    try {
      const data = JSON.parse(text.slice(MARK.length))
      return { before: String(data.before || ''), after: String(data.after || ''), title: String(data.title || '') }
    } catch { return null }
  }

  // Что именно прибавилось: общий хвост и общее начало отрезаются, остаётся изменённая середина.
  function diffOf (before, after) {
    let head = 0
    while (head < before.length && head < after.length && before[head] === after[head]) head++
    let tail = 0
    while (tail < before.length - head && tail < after.length - head &&
      before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
    // С куском текста слева от изменения: «Цена 100 → Цена 120» понятнее, чем голое «0 → 2».
    const from = Math.max(0, head - 40)
    return {
      was: before.slice(from, before.length - tail).trim().slice(0, TEXT_LIMIT),
      now: after.slice(from, after.length - tail).trim().slice(0, TEXT_LIMIT)
    }
  }

  function matcher (watch) {
    if (watch.mode !== 'text') return null
    const pattern = String(watch.pattern || '').trim()
    if (!pattern) return null
    try { return new RegExp(pattern, 'i') } catch { return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
  }

  function create (deps) {
    const now = deps.now || (() => Date.now())
    const t = deps.t || (value => value)
    const watches = new Map()     // id вкладки → {instruction, mode, pattern, screenshot, gapMs, active, ...}
    const state = new Map()       // id вкладки → {lastWakeAt, wakes[], matchedBefore}

    // Слежение начинает модель инструментом watch_page, а не человек кнопкой: оно висит фоновой
    // задачей чата (видно в «Задачи»), и тот же чат просыпается, когда страница изменилась.
    let counter = 0
    const listeners = []
    const changed = () => { for (const fn of listeners) { try { fn() } catch { /* слушатель не должен рушить слежение */ } } }
    function start (tabId, config) {
      const watch = {
        id: 'w' + (++counter) + '-' + Math.floor(now() / 1000).toString(36),
        tabId,
        chatId: String(config.chatId || ''),
        url: String(config.url || ''),
        startedAt: now(),
        wakeCount: 0,
        instruction: String(config.instruction || '').trim().slice(0, 2000),
        mode: config.mode === 'text' ? 'text' : 'any',
        pattern: String(config.pattern || '').trim().slice(0, 200),
        screenshot: config.screenshot !== false,
        gapMs: Math.max(1000, Number(config.gapMs) || DEFAULT_GAP_MS)
      }
      watches.set(tabId, watch)
      state.set(tabId, { lastWakeAt: 0, wakes: [], matched: false })
      if (deps.inject) deps.inject(tabId, OBSERVER)
      changed()
      return watch
    }

    function stop (tabId) { const had = watches.delete(tabId); state.delete(tabId); if (had) changed() }
    // Слежения одного чата (или всех) для панели «Задачи».
    const list = chatId => [...watches.values()].filter(watch => !chatId || watch.chatId === chatId)
    function stopById (id) {
      for (const [tabId, watch] of watches) if (watch.id === id) { stop(tabId); return true }
      return false
    }
    function stopChat (chatId) {
      let count = 0
      for (const [tabId, watch] of [...watches]) if (!chatId || watch.chatId === chatId) { stop(tabId); count++ }
      return count
    }
    const get = tabId => watches.get(tabId) || null
    const active = tabId => watches.has(tabId)

    function compose (tabId, info, change, diff) {
      const watch = watches.get(tabId)
      const lines = [t('Страница во вкладке браузера изменилась (сообщение слежения за страницей).'),
        `${t('Адрес')}: ${info.url}${info.title ? ' · ' + info.title : ''}`]
      if (diff.was || diff.now) lines.push(`${t('Было')}: ${diff.was || '—'}`, `${t('Стало')}: ${diff.now || '—'}`)
      if (watch.pattern) lines.push(`${t('Условие')}: ${watch.pattern}`)
      lines.push(watch.instruction
        ? `${t('Твоё поручение, которое ты поставил при запуске слежения')}: ${watch.instruction}`
        : t('Поручение не задано: разберись, что изменилось, и коротко скажи, что это значит.'))
      if (change.after) lines.push(`${t('Текст страницы сейчас')}: ${change.after.slice(0, 500)}`)
      lines.push(t('Страница уже открыта у человека в браузере панели: открывать её отдельно не нужно, всё нужное — в этом сообщении.'))
      if (info.screenshotPath) lines.push(`${t('Снимок страницы сохранён')}: ${info.screenshotPath}${info.attached ? ' ' + t('(кадр идёт тебе прямо в ход мысли)') : ''}`)
      return lines.join('\n')
    }

    // Одно изменение страницы. Возвращает причину отказа или 'woke'.
    async function onChange (tabId, change, info) {
      const watch = watches.get(tabId)
      if (!watch || !change) return 'no-watch'
      if (deps.canWake && !deps.canWake()) return 'cannot'
      const entry = state.get(tabId)
      const diff = diffOf(change.before, change.after)
      const at = now()
      const rx = matcher(watch)
      if (rx) {
        // Условие срабатывает на ПОЯВЛЕНИЕ: пока текст на странице держится, повторы молчат.
        const hit = rx.test(change.after)
        if (!hit) { entry.matched = false; return 'no-match' }
        if (entry.matched) return 'no-match'
      }
      if (at - entry.lastWakeAt < watch.gapMs) return 'gap'
      entry.wakes = entry.wakes.filter(time => at - time < HOUR_MS)
      if (entry.wakes.length >= HOUR_LIMIT) return 'hour-limit'
      if (rx) entry.matched = true
      entry.lastWakeAt = at
      entry.wakes.push(at)
      watch.wakeCount++
      changed()
      let extra = { url: info.url, title: change.title || info.title }
      let attachments = []
      if (watch.screenshot && deps.screenshot) {
        try {
          const shot = await deps.screenshot(tabId)
          if (shot) { extra.screenshotPath = shot.path; extra.attached = Boolean(shot.attachment); if (shot.attachment) attachments = [shot.attachment] }
        } catch { /* без снимка поручение всё равно уходит: текст изменения у модели есть */ }
      }
      deps.send(compose(tabId, extra, change, diff), { attachments, chatId: watch.chatId })
      return 'woke'
    }

    return { start, stop, stopById, stopChat, list, get, active, onChange, compose, state, OBSERVER, subscribe: fn => listeners.push(fn) }
  }

  const api = { create, parseChange, diffOf, OBSERVER, MARK, DEFAULT_GAP_MS, HOUR_LIMIT }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneTabWatch = api
})(typeof window !== 'undefined' ? window : globalThis)
