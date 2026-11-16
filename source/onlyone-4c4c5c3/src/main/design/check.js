// A bounded runtime check. No model-authored evaluation code is run outside the
// sandbox. Metrics are evidence of rendering, not aesthetic approval.
const { randomUUID } = require('crypto')

// Единственный класс адресов, куда проверке разрешено ходить. Живое превью
// шрифты грузит, и проверка без них судила о другой странице: заголовок на
// запасном шрифте имеет другую ширину, другую высоту строки и другое переполнение.
const FONT_HOSTS = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//i

async function checkDesign({ BrowserWindow, session, serveFile, designId, path, signal, exists }) {
  const screens = []
  for (const width of [1280, 375]) {
    if (signal?.aborted) throw new Error('Проверка отменена')
    const partition = session.fromPartition(`design-check-${randomUUID()}`)
    const prefix = `onecode-design://${designId}/`
    partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    partition.setPermissionCheckHandler(() => false)
    // Проверка шла с наглухо отрезанной сетью, а живое превью у человека —
    // нет. Значит модель проверяла страницу без веб-шрифтов, а пользователь
    // смотрел на другую: любой замер типографики в такой проверке — вымысел.
    // Открыт ровно один класс адресов: шрифтовые хосты. Всё остальное, включая
    // произвольные картинки и любые запросы из кода макета, по-прежнему нельзя.
    partition.webRequest.onBeforeRequest((details, callback) => {
      const url = String(details.url || '')
      const own = url.startsWith(prefix) || url.startsWith('data:') || url.startsWith('blob:')
      callback({ cancel: !own && !FONT_HOSTS.test(url) })
    })
    partition.on('will-download', event => event.preventDefault())
    partition.protocol.handle('onecode-design', serveFile)
    const window = new BrowserWindow({ width, height: 800, show: false, useContentSize: true,
      webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-redirect', event => event.preventDefault())
    const errors = []
    // Один параметр — не стилистика: позиционные аргументы этого события в
    // Electron объявлены устаревшими, а `level` в новой форме строка, а не
    // число. Старая проверка `level >= 3` на строке молча перестала бы ловить
    // ошибки — проверка осталась бы зелёной на сломанном превью.
    window.webContents.on('console-message', event => {
      if (event.level === 'error' && errors.length < 5) errors.push(String(event.message).slice(0, 250))
    })
    let timer
    const abort = () => { if (!window.isDestroyed()) window.destroy() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const result = await Promise.race([
        (async () => {
          await window.loadURL(prefix + encodeURIComponent(path))
          await new Promise(resolve => setTimeout(resolve, 400))
          return window.webContents.executeJavaScript(`(async () => {
            await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 600))]);
            const root = document.querySelector('#dc-root');
            const text = root?.innerText?.trim() || '';
            const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility === 'visible' && getComputedStyle(e).opacity !== '0';
            const controls = [...document.querySelectorAll('button,input,select,textarea,a[href]')].filter(visible);
            const named = e => e.innerText?.trim() || e.getAttribute('aria-label')?.trim() || e.getAttribute('title')?.trim() ||
              [...(e.labels || [])].some(l => l.textContent.trim()) ||
              (e.getAttribute('aria-labelledby') || '').split(/\\s+/).some(id => document.getElementById(id)?.textContent.trim()) ||
              (e.matches('input[type=submit],input[type=button],input[type=reset]') && e.value?.trim());
            return { width: innerWidth, rendered: Boolean(root?.children.length && visible(root) && [...root.querySelectorAll('*')].some(visible)), textSample: text.slice(0, 350),
              horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
              brokenImages: [...document.images].filter(i => i.complete && !i.naturalWidth).length,
              pendingImages: [...document.images].filter(i => !i.complete).length,
              unnamedControls: controls.filter(e => !named(e)).length,
              // Сайт — это несколько компонентов со ссылками друг на друга, а
              // проверка смотрела ровно один экран: страница с битыми ссылками
              // проходила её как исправная.
              links: [...new Set([...document.querySelectorAll('a[href]')]
                .map(a => a.getAttribute('href') || '')
                .filter(h => h && !h.startsWith('#') && !/^(https?:|mailto:|tel:|data:)/i.test(h)))].slice(0, 40) };
          })()`)
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Лимит проверки превью: 8 секунд')), 8000) })
      ])
      screens.push({ ...result, errors })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (!window.isDestroyed()) window.destroy()
      await partition.protocol.unhandle('onecode-design')
      await partition.clearStorageData()
    }
  }
  // Ссылки собраны с обеих ширин; существование проверяет вызывающий, у него
  // есть список компонентов дизайна.
  const linked = [...new Set(screens.flatMap(s => s.links || []))]
  const broken = typeof exists === 'function'
    ? linked.filter(href => !exists(decodeURIComponent(href.split(/[?#]/)[0])))
    : []

  return { success: true, screens, brokenLinks: broken,
    passed: screens.every(s => s.rendered && !s.horizontalOverflow && !s.brokenImages && !s.pendingImages && !s.unnamedControls && !s.errors.length) && !broken.length,
    limitation: 'Офлайн-проверка DOM и ошибок на двух ширинах. Не доказывает эстетическое качество, контраст, перекрытия и работу всех взаимодействий. Внешняя сеть отключена.' }
}

module.exports = { checkDesign }
