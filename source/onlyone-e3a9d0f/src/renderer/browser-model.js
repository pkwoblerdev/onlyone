/* Модель встроенного браузера в панели превью: адресная строка и вкладки.
 *
 * Чистая логика без DOM и без Electron — проверяется узловым прогоном
 * (tests/test-browser-model.cjs); окно (browser-panel.js) только рисует то, что
 * здесь решено.
 *
 * Адресная строка — и поле адреса, и поле поиска, как в обычном браузере:
 *   localhost:3000, 127.0.0.1:8080, 192.168.0.5  → http (адрес разработчика)
 *   example.com, www.site.co.uk/path             → https
 *   как сварить кофе                             → поиск
 * Любая другая схема — javascript:, file:, data:, chrome:, about:, blob:, ftp: —
 * отклоняется (`blocked`): в окно с чужими страницами она не попадает ни при каком
 * вводе, и поиском её тоже не прикидываем — человек вставил не запрос.
 */
(function (root) {
  'use strict'

  const SEARCH = 'https://duckduckgo.com/?q='
  const FIELDS = ['url', 'title', 'loading', 'canBack', 'canForward', 'error', 'favicon']

  const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

  function isLocalName (host) {
    const name = String(host || '').replace(/^\[|\]$/g, '').toLowerCase()
    return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || IPV4.test(name) || name.includes(':')
  }

  /** @returns {{kind:'url'|'search'|'blocked', url:string}|null} */
  function normalizeAddress (input) {
    const text = String(input == null ? '' : input).trim()
    if (!text) return null

    if (/^https?:\/\//i.test(text)) {
      try { return { kind: 'url', url: new URL(text).href } } catch { return { kind: 'blocked', url: '' } }
    }

    // «схема:» без «//» — если после двоеточия не порт, это чужая схема, а не имя узла.
    const scheme = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i.exec(text)
    if (scheme) return { kind: 'blocked', url: '' }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { kind: 'blocked', url: '' }

    if (/\s/.test(text)) return search(text)

    let parsed
    try { parsed = new URL('http://' + text) } catch { return search(text) }
    const host = parsed.hostname
    const hasPort = parsed.port !== ''
    if (isLocalName(host)) return { kind: 'url', url: parsed.href }
    // Имя без точки: с портом это узел домашней сети (myserver:8080), без порта — слово для поиска.
    if (!host.includes('.')) return hasPort ? { kind: 'url', url: parsed.href } : search(text)
    const tld = host.split('.').pop()
    if (!/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(tld)) return search(text)
    return { kind: 'url', url: 'https://' + parsed.host + parsed.pathname + parsed.search + parsed.hash }
  }

  function search (text) {
    return { kind: 'search', url: SEARCH + encodeURIComponent(text) }
  }

  /** Что показывать в строке адреса: без «https://» и без хвостового слэша. */
  function displayAddress (value) {
    const text = String(value || '')
    if (!text) return ''
    let parsed
    try { parsed = new URL(text) } catch { return text }
    if (!/^https?:$/.test(parsed.protocol)) return text
    const path = (parsed.pathname === '/' ? '' : parsed.pathname) + parsed.search + parsed.hash
    return (parsed.protocol === 'http:' ? 'http://' : '') + parsed.host + path
  }

  function titleOf (tab) {
    const title = String((tab && tab.title) || '').trim()
    if (title) return title
    const address = String((tab && tab.url) || '')
    if (!address) return 'Новая вкладка'
    try { return new URL(address).host.replace(/^www\./, '') } catch { return address }
  }

  /** Код ошибки Chromium → слова. -3 (отмена перехода) — не ошибка. */
  function describeLoadError (code) {
    const value = Number(code)
    if (value === -3) return ''
    if (value === -102) return 'Сервер не отвечает: соединение отклонено. Возможно, он не запущен.'
    if (value === -105 || value === -137) return 'Не удалось найти такой адрес: проверьте имя сайта.'
    if (value === -106 || value === -109 || value === -21) return 'Нет соединения с интернетом.'
    if (value === -7 || value === -118) return 'Сайт отвечает слишком долго: время ожидания вышло.'
    if (value <= -200 && value > -220) return 'Соединение не защищено: сертификат сайта не прошёл проверку.'
    if (value === -101 || value === -100) return 'Соединение оборвалось.'
    return 'Не удалось открыть страницу.'
  }

  /** Вкладки: список и активная, без DOM. */
  function createTabs (options) {
    const max = Math.max(1, Number(options && options.max) || 8)
    let seq = 0
    let tabs = []
    let activeId = null

    const find = id => tabs.find(tab => tab.id === id) || null

    return {
      list: () => tabs.map(tab => ({ ...tab })),
      get: id => { const tab = find(id); return tab ? { ...tab } : null },
      active: () => activeId,
      add (url) {
        if (tabs.length >= max) return null
        const tab = { id: 't' + (++seq), url: String(url || ''), title: '', loading: false, canBack: false, canForward: false, error: '', favicon: '' }
        tabs.push(tab)
        activeId = tab.id
        return tab.id
      },
      select (id) { if (find(id)) activeId = id },
      close (id) {
        const at = tabs.findIndex(tab => tab.id === id)
        if (at < 0) return
        tabs.splice(at, 1)
        if (activeId === id) activeId = tabs.length ? tabs[Math.min(at, tabs.length - 1)].id : null
      },
      patch (id, fields) {
        const tab = find(id)
        if (!tab || !fields) return
        for (const key of FIELDS) if (key in fields) tab[key] = fields[key]
      }
    }
  }

  const api = Object.freeze({ normalizeAddress, displayAddress, titleOf, describeLoadError, createTabs, SEARCH })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneBrowserModel = api
})(typeof window === 'object' ? window : globalThis)
