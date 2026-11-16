// agent-browser.js: изолированный рантайм браузера агента (этап 3.6).
// Скрытый WebContents в отдельной partition без прав и доступа к локальной сети.
const { randomUUID } = require('node:crypto')
const electron = require('electron')
const webFetch = require('./web-fetch.js')

const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_CHARS = 50000

// Разрешённые протоколы для безопасного веб-браузинга
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Быстрый признак «это точно локальный адрес» — синхронный, для обработчиков
 * перехода, где preventDefault нужен немедленно, а dns.lookup ещё нет.
 * Судит ТОЛЬКО форму адреса: локальное имя и IP-литерал частной сети.
 * `webFetch.isPrivateAddress` называет приватным и любое не-IP значение
 * («непонятное трактуем как локальное»), и без этой оговорки каждое имя —
 * публичный сайт в том числе — выглядело адресом домашней сети.
 * Полную проверку имени (имя → адреса) делают `validateBrowserUrl` на входе и
 * резолв в стороже перехода.
 */
function looksPrivateHost (hostname) {
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

/**
 * Валидация URL перед открытием в браузере.
 * Защита от SSRF, обращения к loopback/localhost, приватным сетям и запрещённым протоколам.
 */
async function validateBrowserUrl(rawUrl, { lookup, allow } = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('URL должен быть непустой строкой')
  }

  let url
  try {
    url = new URL(rawUrl.trim())
  } catch (err) {
    throw new Error(`Некорректный формат URL: ${err.message}`)
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Недопустимый протокол "${url.protocol}": поддерживаются только http: и https:`)
  }

  // Н7 аудита sec-net 2026-11-01: `parseTarget` в web-fetch такие адреса отвергает,
  // а браузер принимал — и пароль ехал в результат инструмента и в журнал. Тот же
  // отказ, той же формулировкой.
  if (url.username || url.password) {
    throw new Error('Логин и пароль в адресе не принимаются')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()

  // Причина отказа собирается до спроса: человек спрашивается ровно один раз на
  // адрес, а не по разу на каждую проверку. Протокол спрашиванием не обходится —
  // до этого места он уже проверён.
  let blocked = ''
  const isLocal = await webFetch.isLocalHost(hostname, lookup)
  if (isLocal) {
    blocked = `Запрещён доступ к локальному или частному адресу "${hostname}" (SSRF защита)`
  } else {
    // Резолв целевых адресов для защиты от DNS rebinding
    try {
      const target = await webFetch.resolveTarget(url, lookup)
      if (target.addresses && target.addresses.some(addr => webFetch.isPrivateAddress(addr))) {
        blocked = `Целевой хост "${hostname}" резолвится в приватный IP адрес (SSRF защита)`
      }
    } catch (err) {
      if (/SSRF|локальн|частн/i.test(err.message)) blocked = err.message
      else throw new Error(`Не удалось разрешить адрес "${hostname}": ${err.message}`)
    }
  }

  if (blocked) {
    // Граница та же, но адрес, который
    // человек разрешил сам, проходит — ровно как у `fetch_url`. Без `allow`
    // поведение не изменилось: тот же отказ с той же формулировкой.
    const granted = allow ? await allow(url, { local: true, lookup }) : false
    if (!granted) throw new Error(blocked)
  }

  return url
}

/**
 * Прочитать открытую страницу: заголовок, читаемый текст, ссылки. Работает с любым
 * webContents — фоновым окном агента или вкладкой браузера человека (user-browser).
 */
async function extractPage(webContents, { maxChars = DEFAULT_MAX_CHARS, url = '', fallbackHost = '' } = {}) {
  const pageData = await webContents.executeJavaScript(`(() => {
    try {
      const title = (document.title || '').trim()
      const text = (document.body ? (document.body.innerText || document.body.textContent || '') : '').trim()
      const links = []
      const seen = new Set()
      for (const a of document.querySelectorAll('a[href]')) {
        const rawHref = a.getAttribute('href') || ''
        if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) continue
        const fullHref = a.href || ''
        const linkText = (a.textContent || '').trim().replace(/\\s+/g, ' ')
        if (linkText && fullHref && !seen.has(fullHref)) {
          seen.add(fullHref)
          links.push({ text: linkText, href: fullHref })
          if (links.length >= 50) break
        }
      }
      return { title, text, links }
    } catch (e) {
      return { title: '', text: '', links: [], error: String(e) }
    }
  })()`)

  let text = String(pageData?.text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  let truncated = false

  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n\n[...Текст обрезан по лимиту]'
    truncated = true
  }

  return {
    success: true,
    url,
    title: pageData.title || fallbackHost,
    text,
    links: pageData.links || [],
    truncated
  }
}

/**
 * Запуск изолированного просмотра страницы в фоновом BrowserWindow.
 */
async function browsePage(rawUrl, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxChars = DEFAULT_MAX_CHARS,
    signal,
    BrowserWindow = electron.BrowserWindow,
    session = electron.session,
    lookup,
    // Спрос человека о приватном адресе — тот же хук, что у `fetch_url`.
    allow,
    // `hold` оставляет страницу открытой: на ней агент кликает и вводит текст
    // (`agent-interact.js`). Без него окно живёт ровно один вызов, как раньше.
    hold = false,
    // Имя раздела браузера человека (persist:…): страница открывается С ЕГО ВХОДАМИ —
    // куки и локальные данные общие с вкладками браузера в панели. Раздел при этом
    // не чистится и не переписывается: его разрешения и запрет скачивания уже стоят
    // от браузера панели, а выход из аккаунтов по концу хода недопустим.
    sharedPartition = ''
  } = options

  // 1. Валидация начального URL
  let targetUrl
  try {
    targetUrl = await validateBrowserUrl(rawUrl, { lookup, allow })
  } catch (validationError) {
    return { success: false, error: validationError.message }
  }

  // 2. Изолированная партиция в памяти
  const shared = typeof sharedPartition === 'string' && sharedPartition.startsWith('persist:')
  const partitionId = shared ? sharedPartition : `agent-browser-${randomUUID()}`
  const partition = session.fromPartition(partitionId)

  if (!shared) {
    // Полный запрет запросов любых разрешений (геолокация, микрофон, камера, пуши и т.д.)
    partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    partition.setPermissionCheckHandler(() => false)

    // Запрет скачивания любых файлов
    partition.on('will-download', event => event.preventDefault())
  }

  // Журнал редиректов внутри сессии. Отменить переход здесь нельзя —
  // `onBeforeRedirect` приходит уже после того, как Chromium решил идти по
  // новому адресу; блокировка живёт на `will-navigate`/`will-redirect` ниже.
  if (!shared && partition.webRequest) {
    partition.webRequest.onBeforeRedirect?.(async details => {
      try {
        await validateBrowserUrl(details.redirectURL, { lookup, allow })
      } catch {
        // Журнал без пароля: на входе userinfo отвергается, но `Location:` чужого
        // сервера может нести `user:pass@` — в консоль он ложиться не должен.
        const shown = String(details.redirectURL || '').replace(/^(https?:\/\/)[^/@]*@/i, '$1')
        console.warn(`[agent-browser] Редирект на запрещённый адрес: ${shown}`)
      }
    })
  }

  // 3. Создание скрытого окна BrowserWindow
  let window = null
  let timeoutTimer = null
  let aborted = false
  let keepOpen = false

  const cleanup = async () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
    }
    if (window && !window.isDestroyed()) {
      try { window.destroy() } catch {}
    }
    window = null
    try {
      if (!shared && partition && typeof partition.clearStorageData === 'function') {
        await partition.clearStorageData()
      }
    } catch {}
  }

  const abortHandler = () => {
    aborted = true
    cleanup()
  }

  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true })
  }

  try {
    window = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      useContentSize: true,
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false
      }
    })

    // Запрет открытия дочерних окон и popup
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    // Защита от переходов на недопустимые адреса. Прежний `onBeforeRedirect`
    // отменить переход не умеет — он только сообщает, поэтому
    // блокировка сидит здесь, на `will-navigate` и `will-redirect`: серверный
    // 302 ловится вторым, и без него редирект в локальную сеть совершался.
    const navApproved = new Set()
    // Хосты, судьба которых уже решена: начальный адрес прошёл validateBrowserUrl, разрешённые сторожем имена
    // добавляются по ходу. Переход внутри такого хоста (308 /путь → /путь/, смена локали, http→https на том же
    // имени) идёт как шёл: отмена с повтором через loadURL роняла исходную загрузку с ERR_FAILED (-2), и
    // browse_page отвечал «не загрузилось» на любой сайт с редиректом (polymarket.com/ru/event/).
    // Для публичного имени решён хост (порт не важен), для частного адреса — хост с портом: человек разрешил один
    // сервис, а не всю машину.
    const initialPrivate = await webFetch.isLocalHost(targetUrl.hostname.toLowerCase(), lookup).catch(() => true)
    const decidedHosts = new Set([initialPrivate ? targetUrl.host.toLowerCase() : targetUrl.hostname.toLowerCase()])
    const isDecided = parsed => decidedHosts.has(parsed.hostname.toLowerCase()) || decidedHosts.has(parsed.host.toLowerCase())
    // Продолжения, начатые сторожем вместо отменённого перехода: загрузка ждёт их итога, а не падает на отмене.
    let pendingResume = null
    const startPending = () => {
      let settle
      const promise = new Promise(resolve => { settle = resolve })
      pendingResume = pendingResume ? pendingResume.then(() => promise) : promise
      return settle
    }
    // Итог продолжения: true — страница загрузилась.
    const resume = parsed => {
      if (!window || window.isDestroyed()) return Promise.resolve(false)
      navApproved.add(parsed.href)
      return window.loadURL(parsed.href).then(() => true, () => false)
    }
    // Спрос человека о переходе: без его «да» переход остаётся отменённым.
    // `local: true` и для имени, которое не успели разрешить, — нерешённый
    // адрес трактуется как приватный, а не проходит молча.
    const askAndResume = parsed => Promise.resolve(allow ? allow(parsed, { local: true, lookup }) : false)
      .then(ok => {
        if (!ok) return { ok: false, reason: 'Переход на ' + parsed.hostname + ' не разрешён' }
        decidedHosts.add(parsed.host.toLowerCase())
        return resume(parsed).then(loaded => ({ ok: loaded, reason: loaded ? '' : 'Страница ' + parsed.hostname + ' не загрузилась' }))
      })
      .catch(() => ({ ok: false, reason: 'Переход на ' + parsed.hostname + ' не удался' }))
    // Отмена перехода и его продолжение сторожем: итог уходит в очередь, которую ждёт загрузка.
    const cancelAndResolve = (event, work) => {
      event.preventDefault()
      const settle = startPending()
      Promise.resolve().then(work).then(settle, () => settle({ ok: false, reason: 'Переход не удался' }))
    }
    const guardNavigation = (event, nextUrl, details) => {
      let parsed = null
      try {
        parsed = new URL(nextUrl)
      } catch {
        event.preventDefault()
        return
      }
      if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        event.preventDefault()
        return
      }
      if (navApproved.has(parsed.href)) return
      if (isDecided(parsed)) return
      if (looksPrivateHost(parsed.hostname)) {
        // Адрес приватен по самой своей форме: частная сеть литералом или
        // локальное имя по суффиксу. Резолв здесь ничего не добавит.
        return cancelAndResolve(event, () => askAndResume(parsed))
      }
      // Публичный IP-литерал: резолвить нечего, переход идёт как шёл —
      // без отмены и без спроса, ровно как на входе.
      if (webFetch.canonicalAddress(parsed.hostname) !== null) return
      // Отправление формы повторить нельзя: `loadURL` умеет только GET, тело
      // запроса теряется. Поэтому для не-GET решение остаётся прежним — строгий
      // спрос, пока резолв не сделан синхронно (остаток находки, см. аудит).
      const method = String((details && details.method) || 'GET').toUpperCase()
      if (method !== 'GET') {
        return cancelAndResolve(event, () => askAndResume(parsed))
      }
      // Имя судится тем же правилом, что и на входе: то же `resolveTarget` и те
      // же приватные адреса. Решение нужно до ответа Chromium, поэтому переход
      // блокируется и продолжается самим `loadURL`: публичный адрес идёт без
      // спроса человека, приватный — со спросом, неразрешившееся имя — тоже со
      // спросом (`isLocalHost` на отказе отвечает «не локальный», молча пропустить
      // имя без решения он не даёт).
      cancelAndResolve(event, () => Promise.resolve(webFetch.resolveTarget(parsed, lookup))
        .then(target => {
          const privateTarget = (target.addresses || []).some(address => webFetch.isPrivateAddress(address))
          if (privateTarget) return askAndResume(parsed)
          decidedHosts.add(parsed.hostname.toLowerCase())
          return resume(parsed).then(loaded => ({ ok: loaded, reason: loaded ? '' : 'Страница ' + parsed.hostname + ' не загрузилась' }))
        })
        .catch(() => askAndResume(parsed)))
    }
    window.webContents.on('will-navigate', guardNavigation)
    window.webContents.on('will-redirect', guardNavigation)

    // Находка Н2 (аудит sec-net 01.11): `will-navigate`/`will-redirect` в Electron 44
    // видят ТОЛЬКО главный кадр, а переходы и запросы подкадров — `<iframe>`, `<img>`,
    // fetch/XHR и WebSocket — загруженная публичная страница слала в локальную сеть
    // мимо всей проверки (`ws://` читается ещё и без CORS). Судит теперь каждый запрос
    // партиции ДО соединения: приватный адрес — только с решения человека (тот же
    // `allow` и тот же `decidedHosts`, что у главного кадра), имя судится тем же
    // `resolveTarget`, неразрешившееся — как приватное, отказ по умолчанию.
    const fenceHost = async parsed => {
      const granted = await Promise.resolve(allow ? allow(parsed, { local: true, lookup }) : false).catch(() => false)
      if (granted) decidedHosts.add(parsed.host.toLowerCase())
      return !granted
    }
    const fenceRequest = async urlText => {
      let parsed = null
      try { parsed = new URL(String(urlText || '')) } catch { return true }
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return true
      if (isDecided(parsed)) return false
      if (looksPrivateHost(parsed.hostname)) return fenceHost(parsed)
      // Публичный IP-литерал: резолвить нечего, запрос идёт как шёл — ровно как в
      // стороже главного кадра.
      if (webFetch.canonicalAddress(parsed.hostname) !== null) { decidedHosts.add(parsed.hostname.toLowerCase()); return false }
      try {
        const target = await webFetch.resolveTarget(parsed, lookup)
        if ((target.addresses || []).some(address => webFetch.isPrivateAddress(address))) return fenceHost(parsed)
        decidedHosts.add(parsed.hostname.toLowerCase())
        return false
      } catch { return fenceHost(parsed) }
    }
    if (!shared && partition.webRequest && partition.webRequest.onBeforeRequest) {
      partition.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
        fenceRequest(details && details.url).then(cancel => callback({ cancel }), () => callback({ cancel: true }))
      })
    }
    // Кадровые переходы: схему судим сразу (главный кадр сторожит `will-navigate`),
    // адрес подкадра решает ограда запросов выше — вместе они дают один спрос на хост.
    window.webContents.on('will-frame-navigate', (event, info) => {
      const nav = (info && typeof info === 'object') ? info : event
      if (nav.isMainFrame !== false) return
      let parsed = null
      try { parsed = new URL(String(nav.url || '')) } catch { event.preventDefault(); return }
      if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) event.preventDefault()
    })

    // Загрузка страницы с контролем таймаута
    const loadPromise = (async () => {
      let loadError = null
      try {
        await window.loadURL(targetUrl.toString())
      } catch (error) {
        loadError = error
      }
      // Отменённый сторожем переход роняет исходный loadURL (ERR_FAILED/ERR_ABORTED), но страница при этом едет
      // дальше продолжением сторожа: ждём его итога, а ошибку исходной загрузки отдаём, только если продолжений не было.
      let waited = false
      while (pendingResume) {
        const current = pendingResume
        waited = true
        const outcome = await current
        if (pendingResume === current) pendingResume = null
        if (outcome && outcome.ok === false) throw new Error(outcome.reason || 'Переход не удался')
      }
      if (loadError && !waited) throw loadError

      const read = await extractPage(window.webContents, { maxChars, url: targetUrl.toString(), fallbackHost: targetUrl.hostname })
      return read
    })()

    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`Превышен лимит времени загрузки страницы (${Math.round(timeoutMs / 1000)} с)`))
      }, timeoutMs)
    })

    const result = await Promise.race([loadPromise, timeoutPromise])
    if (hold) {
      keepOpen = true
      return {
        ...result,
        agentPage: {
          webContents: window && !window.isDestroyed() ? window.webContents : null,
          url: targetUrl.toString(),
          release: cleanup
        }
      }
    }
    return result

  } catch (error) {
    return {
      success: false,
      url: targetUrl.toString(),
      error: String(error?.message || error).slice(0, 300)
    }
  } finally {
    if (signal) {
      signal.removeEventListener('abort', abortHandler)
    }
    if (!keepOpen) await cleanup()
  }
}

module.exports = {
  validateBrowserUrl,
  extractPage,
  browsePage,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CHARS,
  ALLOWED_PROTOCOLS
}
