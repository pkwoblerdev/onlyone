// Выгрузка готового компонента картинкой или документом.
//
// Дизайн живёт внутри приложения: его видно в предпросмотре, и на этом всё.
// Отдать его наружу было нельзя ничем, а просят именно это — отправить макет,
// положить в письмо, показать тому, у кого приложения нет.
//
// Рендер идёт в том же закрытом окне, что и проверка: сеть только к шрифтовым
// хостам, ничего не скачивается, ничего не исполняется вне песочницы. Файл
// кладётся рядом с дизайном, и путь возвращается — дальше его открывает
// пользователь, а не модель.
const { randomUUID } = require('crypto')
const { join } = require('path')
const fs = require('fs/promises')

const FONT_HOSTS = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//i

// Ограничение не из осторожности, а из физики: снимок страницы в тридцать тысяч
// пикселей высотой съедает память окна и приходит пустым.
const MAX_HEIGHT = 12000

async function exportDesign({ BrowserWindow, session, serveFile, designId, path, folder, format = 'png', width = 1440, signal, store }) {
  const wanted = String(format || 'png').toLowerCase()
  if (!['png', 'pdf'].includes(wanted)) {
    return { success: false, error: 'Формат может быть png или pdf.' }
  }

  const partition = session.fromPartition(`design-export-${randomUUID()}`)
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

  const box = Math.min(Math.max(Number(width) || 1440, 320), 2560)
  const window = new BrowserWindow({ width: box, height: 900, show: false, useContentSize: true,
    webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-redirect', event => event.preventDefault())

  let timer = null
  const abort = () => { if (!window.isDestroyed()) window.destroy() }
  signal?.addEventListener('abort', abort, { once: true })

  try {
    const made = await Promise.race([
      (async () => {
        await window.loadURL(prefix + encodeURIComponent(path))
        await new Promise(resolve => setTimeout(resolve, 500))
        await window.webContents.executeJavaScript(
          'Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 900))]).then(() => 1)')

        const base = String(path).replace(/\.dc\.html$/i, '').replace(/[\\/:*?"<>|]/g, '_') || 'design'
        const fileName = `${base}.${wanted}`

        async function saveExportFile(bytes) {
          if (store && typeof store.writeExport === 'function') {
            const res = await store.writeExport(designId, fileName, bytes)
            return res.file
          }
          const file = join(folder, fileName)
          await fs.writeFile(file, bytes)
          return file
        }

        if (wanted === 'pdf') {
          const data = await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
          const file = await saveExportFile(data)
          return { file, bytes: data.length }
        }

        // Снимок делается во всю высоту страницы, а не во весь экран: макет
        // длиннее окна иначе обрезался бы ровно по его нижнему краю.
        const height = await window.webContents.executeJavaScript(
          'Math.min(document.documentElement.scrollHeight, ' + MAX_HEIGHT + ')')
        window.setContentSize(box, Math.max(200, Math.round(height)))
        await new Promise(resolve => setTimeout(resolve, 250))
        const image = await window.webContents.capturePage()
        if (image.isEmpty()) throw new Error('Снимок пуст: страница не отрисовалась')
        const data = image.toPNG()
        const file = await saveExportFile(data)
        return { file, bytes: data.length, width: box, height: Math.round(height) }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Лимит выгрузки: 20 секунд')), 20000) })
    ])

    return {
      success: true,
      format: wanted,
      ...made,
      note: 'Файл лежит рядом с дизайном. Открыть папку может пользователь — кнопка «Показать в папке» в разделе дизайна.'
    }
  } catch (error) {
    return { success: false, error: String(error?.message || error).slice(0, 300) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (!window.isDestroyed()) window.destroy()
    try { await partition.clearStorageData() } catch {}
  }
}

module.exports = { exportDesign }
