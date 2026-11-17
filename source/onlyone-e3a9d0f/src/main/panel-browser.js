'use strict'

// Встроенный браузер в панели превью: ограды главного процесса.
//
// Страницы в панели — чужой код, поэтому они живут в <webview> со своими правилами:
//  - свой раздел сессии (куки и вход на сайтах переживают перезапуск, но не смешиваются
//    с окном приложения);
//  - нет Node, нет preload, песочница включена, `webSecurity` не отключается — это
//    проверяется при КАЖДОЙ вставке, а не доверяется тому, что прислало окно;
//  - переходы только на http(s): file:, javascript:, data:, chrome: и прочее закрыты;
//  - сайт ничего не просит у системы без спроса: камера, микрофон, геолокация,
//    уведомления закрыты, запись в буфер и полный экран разрешены;
//  - скачивание не стартует (файлы из чужих страниц на диск не падают);
//  - новая вкладка из страницы (target=_blank, window.open) не открывает окно, а
//    сообщает панели — вкладку заводит она.
// User-Agent чистый от «Electron» и имени приложения: часть сайтов (вход Google, защита
// от ботов) по этим словам отказывает встроенным браузерам.

const PARTITION = 'persist:onlyone-browser'
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

const webFetch = require('./web-fetch.js')

// Быстрый признак «приватен по самой форме адреса» — тот же набор проверок, что
// `looksPrivateHost` в агентском браузере (web-fetch.js — чужая зона правки,
// поэтому форма повторяется здесь, а не выносится).
function privateByForm (hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!h) return false
  if (webFetch.isLocalName(h) || h === 'metadata') return true
  if (webFetch.canonicalAddress(h) === null) return false
  try {
    return webFetch.isPrivateAddress(h) === true
  } catch {
    return false
  }
}

// Приватность адреса: сначала форма, затем резолв — публичное имя с приватной
// A-записью (DNS rebinding) формой не ловится. Отказ резолва — fail-closed, как
// в «Авто» у web-fetch. Литералы повторно не резолвим: их уже судила форма.
async function privateHost (hostname, lookup, failClosed = true) {
  if (privateByForm(hostname)) return true
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!h || webFetch.canonicalAddress(h) !== null) return false
  return webFetch.isLocalHost(h, lookup, failClosed)
}

// Находка Н2 аудита sec-net 2026-11-01 (для панели): `<iframe>`, `<img>`,
// fetch/XHR и WebSocket загруженного публичного сайта ходили в локальную сеть
// мимо всех проверок (WebSocket читается ещё и без CORS). Правило ограды: с
// ПУБЛИЧНОЙ страницы на ПРИВАТНЫЙ адрес — отмена; человек, сам переходящий на
// домашний адрес, не блокируется (навигация главной вкладки видна в строке
// адреса), а страница, открытая на приватном адресе, видит свою сеть — так
// живут dev-серверы. Решение без карточек: панель — браузер на
// глазах у человека, молчаливая отмена тихого подкадра честнее всплывающих
// вопросов на каждую картинку.
async function blockedByPartitionFence (details, lookup) {
  let target = null
  try { target = new URL(String((details && details.url) || '')) } catch { return false }
  // Переход самого человека виден в строке адреса — его не судим и не резолвим.
  if (String((details && details.resourceType) || '') === 'mainFrame') return false
  if (!(await privateHost(target.hostname, lookup))) return false
  let topURL = ''
  try { topURL = String((details && details.webContents && details.webContents.getURL()) || '') } catch { topURL = '' }
  let top = null
  try { top = new URL(topURL) } catch { return true } // сведения о странице нет — не рискуем
  if (top.protocol !== 'http:' && top.protocol !== 'https:') return true
  // Неизвестное происхождение страницы — не повод пускать подкадр в приват.
  return !(await privateHost(top.hostname, lookup, false))
}

function cleanUserAgent (agent) {
  return String(agent || '')
    .replace(/\sElectron\/\S+/i, '')
    .replace(/(\(KHTML, like Gecko\))\s+(?!Chrome\/|Safari\/|Version\/)\S+\/\S+(\s+Chrome\/)/, '$1$2')
}

function allowedUrl (value) {
  const text = String(value || '')
  if (text === 'about:blank') return true
  try {
    const parsed = new URL(text)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function permissionAllowed (permission) {
  return ALLOWED_PERMISSIONS.has(String(permission || ''))
}

// Вставка <webview>: правим настройки, которые прислало окно, а не верим им.
function guardAttach (prefs, params) {
  const src = String((params && params.src) || '')
  if (src && !allowedUrl(src)) return { allow: false }
  delete prefs.preload
  delete prefs.preloadURL
  prefs.nodeIntegration = false
  prefs.nodeIntegrationInSubFrames = false
  prefs.contextIsolation = true
  prefs.sandbox = true
  prefs.webSecurity = true
  prefs.allowRunningInsecureContent = false
  if (params) params.partition = PARTITION
  return { allow: true }
}

// onOpenTab(host, url): главный процесс сам шлёт окну событие (так же, как все остальные).
function install ({ app, session, onOpenTab, onContextMenu, lookup }) {
  const ses = session.fromPartition(PARTITION)
  try { ses.setUserAgent(cleanUserAgent(ses.getUserAgent())) } catch { /* без подмены — обычный user-agent */ }
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(permissionAllowed(permission)))
  ses.setPermissionCheckHandler((_contents, permission) => permissionAllowed(permission))
  ses.on('will-download', event => event.preventDefault())
  if (ses.webRequest && ses.webRequest.onBeforeRequest) {
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      blockedByPartitionFence(details, lookup).then(
        cancel => callback({ cancel }),
        () => callback({ cancel: true })
      )
    })
  }

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      const host = contents.hostWebContents
      contents.setWindowOpenHandler(({ url }) => {
        if (allowedUrl(url) && url !== 'about:blank' && host && !host.isDestroyed() && typeof onOpenTab === 'function') onOpenTab(host, url)
        return { action: 'deny' }
      })
      // Правая кнопка в странице: своего меню у <webview> нет, поэтому главный процесс
      // отдаёт окну только нужное (координаты, ссылка, выделение, поле ввода), а меню рисует
      // окно — тем же виджетом, что и во всём приложении.
      contents.on('context-menu', (_event, params) => {
        if (!host || host.isDestroyed() || typeof onContextMenu !== 'function') return
        onContextMenu(host, {
          x: Math.round(Number(params.x) || 0),
          y: Math.round(Number(params.y) || 0),
          linkURL: allowedUrl(params.linkURL) ? String(params.linkURL).slice(0, 2000) : '',
          selectionText: String(params.selectionText || '').slice(0, 20000),
          isEditable: Boolean(params.isEditable),
          pageURL: allowedUrl(params.pageURL) ? String(params.pageURL).slice(0, 2000) : ''
        })
      })
      const keep = (event, url) => { if (!allowedUrl(url)) event.preventDefault() }
      contents.on('will-navigate', keep)
      contents.on('will-redirect', keep)
      // Electron 44: `will-navigate`/`will-redirect` видят только главный кадр,
      // переходы подкадров судит этот обработчик (адреса запросов — ограда выше).
      contents.on('will-frame-navigate', (event, info) => {
        const nav = (info && typeof info === 'object') ? info : event
        if (!allowedUrl(String(nav.url || ''))) event.preventDefault()
      })
      return
    }
    contents.on('will-attach-webview', (event, prefs, params) => {
      if (!guardAttach(prefs, params).allow) event.preventDefault()
    })
  })
}

// «Открыть в системном браузере» из строки адреса панели: только http(s).
async function openExternal (shell, url) {
  if (!allowedUrl(url) || url === 'about:blank') return { ok: false }
  await shell.openExternal(String(url))
  return { ok: true }
}

// Порты, на которых обычно поднимается запущенный у себя проект (Next/CRA, Vite, Angular,
// Flask, Django, статика, Storybook, Astro, Webpack…).
const DEV_PORTS = [3000, 3001, 3333, 4200, 4321, 5000, 5173, 5174, 6006, 8000, 8080, 8081, 8888, 9000]

// «Найти запущенный проект»: кто слушает типичные порты на этом компьютере. Только
// соединение с 127.0.0.1 / ::1 и сразу закрытие — ни запроса, ни данных. Возвращает порты
// по возрастанию. Адреса наружу не ходят, поэтому проверка безопасна и быстра.
function detectDevServers ({ net, ports = DEV_PORTS, timeoutMs = 400 } = {}) {
  const probe = (port, host) => new Promise(resolve => {
    const socket = net.connect({ port, host })
    let settled = false
    const done = ok => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* уже закрыт */ }
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
  return Promise.all(ports.map(async port => {
    const found = (await probe(port, '127.0.0.1')) || (await probe(port, '::1'))
    return found ? port : 0
  })).then(list => list.filter(Boolean).sort((a, b) => a - b))
}

module.exports = { PARTITION, DEV_PORTS, cleanUserAgent, allowedUrl, permissionAllowed, guardAttach, install, openExternal, detectDevServers }
