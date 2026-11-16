/* Страница сказала — модель услышала (волна 4).
 *
 * Браузер панели сообщает окну о событиях страницы (ошибка в консоли, упавшая загрузка, зависшая
 * или упавшая вкладка; src/main/panel-browser.js). Этот модуль решает, будить ли модель: если
 * страница — ваша (localhost и локальная сеть), слежение включено и ошибка новая, он собирает
 * короткое сообщение и отдаёт его в чат тем же путём, что и набранный текст — идущий ход
 * принимает его в очередь, свободный чат начинает ход сразу.
 *
 * Меры против шума и расхода: одинаковая ошибка будит не чаще раза в 5 минут; за 10 минут чат
 * будится не больше трёх раз; события в пределах 1,5 с собираются в одно сообщение; чужие сайты
 * не будят никогда (их ошибки не лечатся правкой проекта).
 *
 * Второй путь — живое обновление: агент записал файл — открытые вкладки с localhost
 * перезагружаются сами, без «обнови страницу».
 */
(function (root) {
  'use strict'

  const DEBOUNCE_MS = 700
  const SAME_ERROR_MS = 5 * 60 * 1000
  const WAKE_WINDOW_MS = 10 * 60 * 1000
  const WAKE_LIMIT = 3
  const RELOAD_DEBOUNCE_MS = 450
  const MAX_LINES = 5

  // Шум, который не лечится правкой проекта и не должен будить модель.
  const NOISE = [/favicon\.ico/i, /DevTools/i, /ResizeObserver loop/i, /net::ERR_BLOCKED_BY_CLIENT/i]

  function isLocalAddress (raw) {
    let url
    try { url = new URL(String(raw || '')) } catch { return false }
    if (!/^https?:$/.test(url.protocol)) return false
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true
    if (/^127\./.test(host)) return true
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  }

  function signatureOf (event) {
    return event.kind + '|' + String(event.text || event.failedUrl || '').replace(/\s+/g, ' ').slice(0, 160)
  }

  function create (deps) {
    const now = deps.now || (() => Date.now())
    const timer = deps.setTimeout || setTimeout
    const clear = deps.clearTimeout || clearTimeout
    const t = deps.t || (value => value)
    const seen = new Map()      // подпись → когда будила последний раз
    const wakes = []            // времена пробуждений за окно
    let pending = []
    let flushTimer = null
    let reloadTimer = null
    const stats = { woke: 0, dropped: 0, ignored: 0 }

    function line (event) {
      const where = event.source ? ` (${String(event.source).split('/').pop()}${event.line ? ':' + event.line : ''})` : ''
      const what = {
        'console-error': t('ошибка в консоли'),
        'load-failed': t('страница не загрузилась'),
        crashed: t('вкладка упала'),
        hung: t('вкладка зависла')
      }[event.kind] || event.kind
      return `• ${event.url || event.failedUrl} — ${what}: ${String(event.text || '').slice(0, 300)}${where}`
    }

    function compose (events) {
      const head = t('Страница в браузере панели сама сообщила о проблеме (автоматическое сообщение).')
      const tail = t('Если причина в файлах проекта — найди и исправь, затем коротко скажи, что поменял. Если причина не в проекте — просто скажи об этом. Страница уже открыта у человека в браузере панели: открывать её отдельно не нужно, всё нужное — в сообщении выше.')
      return [head, ...events.slice(0, MAX_LINES).map(line), tail].join('\n')
    }

    function flush () {
      flushTimer = null
      const batch = pending
      pending = []
      if (!batch.length) return
      const at = now()
      while (wakes.length && at - wakes[0] > WAKE_WINDOW_MS) wakes.shift()
      if (wakes.length >= WAKE_LIMIT) { stats.dropped += batch.length; return }
      if (deps.canWake && !deps.canWake()) { stats.dropped += batch.length; return }
      wakes.push(at)
      stats.woke++
      deps.send(compose(batch))
    }

    function handle (event) {
      if (!event || !event.kind) return false
      if (deps.enabled && !deps.enabled()) { stats.ignored++; return false }
      const address = event.failedUrl || event.url
      if (!isLocalAddress(address)) { stats.ignored++; return false }
      const text = String(event.text || '')
      if (NOISE.some(rx => rx.test(text) || rx.test(String(event.source || '')))) { stats.ignored++; return false }
      const key = signatureOf(event)
      const at = now()
      if (seen.has(key) && at - seen.get(key) < SAME_ERROR_MS) { stats.ignored++; return false }
      seen.set(key, at)
      pending.push(event)
      if (!flushTimer) flushTimer = timer(flush, DEBOUNCE_MS)
      return true
    }

    // Агент записал файл: вкладки со своими страницами перезагружаются одним разом.
    function fileChanged () {
      if (deps.liveReload && !deps.liveReload()) return
      clear(reloadTimer)
      reloadTimer = timer(() => { reloadTimer = null; deps.reloadLocal() }, RELOAD_DEBOUNCE_MS)
    }

    // После перезагрузки та же ошибка снова считается новой: правка могла её не устранить, и
    // модель должна услышать об этом, а не молчать «потому что уже говорили».
    function forget () { seen.clear() }

    return { handle, flush, fileChanged, forget, stats, compose, isLocalAddress }
  }

  const api = { create, isLocalAddress, DEBOUNCE_MS, SAME_ERROR_MS, WAKE_LIMIT }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyonePageWatch = api
})(typeof window !== 'undefined' ? window : globalThis)
