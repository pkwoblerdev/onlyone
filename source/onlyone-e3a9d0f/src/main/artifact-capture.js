'use strict'

// Съёмка растра артефакта (план, 1.4): страница, картинка и график уходят png
// тем же содержимым, что видит панель, — по той же ссылке хранилища, а не
// перерисовываются заново.
//
// Окно под съёмку — своё, невидимое и коротко живущее; так же устроены снимки
// раздела «Дизайн» (`src/main/design/shot.js`). Главный процесс при этом остаётся
// с одним настоящим окном: правило «окно ровно одно» держится по существу, а не
// потому, что помощник спрятан в другом файле. Рисовать тут приходится чужой
// html — то, что прислала модель, — поэтому граница обязательна: своя сессия без
// прав, без новых окон, без ухода с адреса и без ресурсов наружу.

const { BrowserWindow, session } = require('electron')
const { randomUUID } = require('crypto')

// Секунды, после которых съёмка считается неудачной: зависшая страница не имеет
// права держать выгрузку открытой.
const CAPTURE_TIMEOUT_MS = 15000
// Кадру надо отрисоваться: без паузы снимок выходит пустым на медленной машине.
const SETTLE_MS = 250

// Что считается «своим» для этого адреса: папка артефакта в ссылке хранилища или
// сама data-обёртка. Наружу не выходит ни то, ни другое.
function ownPrefix (url) {
  const value = String(url || '')
  const scheme = value.indexOf('://')
  if (scheme < 0) {
    const colon = value.indexOf(':')
    return colon > 0 ? value.slice(0, colon + 1) : ''
  }
  const slash = value.indexOf('/', scheme + 3)
  return slash < 0 ? value : value.slice(0, slash + 1)
}

async function capturePng ({ url, width, height } = {}) {
  const address = String(url || '')
  if (!address) throw new Error('Адреса для съёмки нет.')
  const size = n => Math.max(1, Math.min(8000, Math.round(Number(n) || 0)))
  const prefix = ownPrefix(address)
  const partition = session.fromPartition(`artifact-shot-${randomUUID()}`, { cache: false })
  partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  partition.webRequest.onBeforeRequest((details, callback) => {
    const target = String(details.url || '')
    const own = target.startsWith(prefix) || target.startsWith('data:') ||
      target.startsWith('blob:') || target.startsWith('about:')
    callback({ cancel: !own })
  })
  partition.on('will-download', event => event.preventDefault())

  const window = new BrowserWindow({
    show: false,
    width: size(width), height: size(height),
    frame: false, useContentSize: true,
    webPreferences: {
      session: partition, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-redirect', event => event.preventDefault())

  let timer = null
  try {
    const shot = (async () => {
      await window.webContents.loadURL(address)
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
      const image = await window.webContents.capturePage()
      if (image.isEmpty()) throw new Error('Снимок пуст: содержимое не отрисовалось.')
      return image.toPNG()
    })()
    return await Promise.race([
      shot,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Съёмка не уложилась в ${Math.round(CAPTURE_TIMEOUT_MS / 1000)} с.`)), CAPTURE_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
    if (!window.isDestroyed()) window.destroy()
    try { await partition.clearStorageData() } catch { /* след съёмки, не данные человека */ }
  }
}

module.exports = { capturePng, ownPrefix, CAPTURE_TIMEOUT_MS }
