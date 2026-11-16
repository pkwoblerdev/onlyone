// Снимок макета, который модель действительно видит.
//
// Самый большой изъян здесь был не в инструментах, а в том, что их набор
// целиком состоял из косвенных свидетельств. Модель писала разметку, спрашивала
// «отрисовалось ли», получала «да, ошибок нет, переполнения нет» — и на этом её
// знание о результате кончалось. Она ни разу не видела того, что сделала.
//
// Отсюда всё остальное: иерархия, которая кажется правильной в коде и
// разваливается на экране; композиция, собранная по памяти о том, как выглядят
// такие страницы; уверенный отчёт «проверено» про работу, которую никто не
// смотрел. Числа из замера это чинят наполовину — они ловят слабый контраст и
// мелкие цели, но не скажут, что страница выглядит пустой или что заголовок
// наехал на картинку.
//
// Снимок делается в том же закрытом окне, что и проверка, и возвращается в
// переписку картинкой — той же дорогой, какой туда попадают вложения человека.
// Модель без зрения получает честный отказ вместо картинки: врать ей, что она
// посмотрела, хуже, чем не показывать вовсе.
const { randomUUID } = require('crypto')

const FONT_HOSTS = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//i

// Ширина снимка. Выше — дороже по токенам и бесполезнее: модель всё равно
// смотрит на уменьшенную копию, а разница между 1440 и 2000 на глаз не видна.
const SHOT_WIDTH = { desktop: 1280, mobile: 390 }
const MAX_HEIGHT = 2600

async function shootDesign({ BrowserWindow, session, serveFile, designId, path, view = 'desktop', signal }) {
  const wanted = SHOT_WIDTH[String(view || 'desktop')] ? String(view) : 'desktop'
  const width = SHOT_WIDTH[wanted]

  const partition = session.fromPartition(`design-shot-${randomUUID()}`)
  const prefix = `onecode-design://${designId}/`
  partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  partition.webRequest.onBeforeRequest((details, callback) => {
    const url = String(details.url || '')
    const own = url.startsWith(prefix) || url.startsWith('data:') || url.startsWith('blob:')
    callback({ cancel: !own && !FONT_HOSTS.test(url) })
  })
  partition.on('will-download', event => event.preventDefault())
  partition.protocol.handle('onecode-design', serveFile)

  const window = new BrowserWindow({ width, height: 900, show: false, useContentSize: true,
    webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-redirect', event => event.preventDefault())

  let timer = null
  const abort = () => { if (!window.isDestroyed()) window.destroy() }
  signal?.addEventListener('abort', abort, { once: true })

  try {
    return await Promise.race([
      (async () => {
        await window.loadURL(prefix + encodeURIComponent(path))
        await new Promise(resolve => setTimeout(resolve, 450))
        await window.webContents.executeJavaScript(
          'Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 900))]).then(() => 1)')

        const height = await window.webContents.executeJavaScript(
          'Math.min(document.documentElement.scrollHeight, ' + MAX_HEIGHT + ')')
        window.setContentSize(width, Math.max(200, Math.round(height)))
        await new Promise(resolve => setTimeout(resolve, 260))

        const image = await window.webContents.capturePage()
        if (image.isEmpty()) throw new Error('Снимок пуст: страница не отрисовалась')

        // Уменьшение вдвое для широкого вида: модель смотрит на уменьшенную
        // копию в любом случае, а токенов картинка стоит по площади.
        const shown = wanted === 'desktop' ? image.resize({ width: 900 }) : image
        return {
          success: true,
          view: wanted,
          width,
          height: Math.round(height),
          dataUrl: 'data:image/png;base64,' + shown.toPNG().toString('base64')
        }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Лимит снимка: 15 секунд')), 15000) })
    ])
  } catch (error) {
    return { success: false, error: String(error?.message || error).slice(0, 300) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (!window.isDestroyed()) window.destroy()
    try { await partition.clearStorageData() } catch {}
  }
}

module.exports = { shootDesign, SHOT_WIDTH }
