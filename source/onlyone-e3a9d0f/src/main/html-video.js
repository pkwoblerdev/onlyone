'use strict'

// Ролик из HTML-страницы (план, 9.8): агент пишет страницу — типографика, движение,
// графика, что угодно, что умеет браузер, — а приложение снимает её кадр за кадром по
// ВИРТУАЛЬНОМУ времени и отдаёт кадры в ffmpeg. Так делается motion-дизайн, которого не
// собрать одними фильтрами ffmpeg.
//
// Страница — чужой (сгенерированный) код, поэтому окно рендера закрыто: без Node, в песочнице,
// в собственной сессии, без сети — разрешены только файлы из рабочих папок, data: и blob:.
// Электрон внедряется (`electron`), ffmpeg запускается по пути из `tools`.

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { pathToFileURL, fileURLToPath } = require('url')
const { CLOCK_SOURCE } = require('./video-clock')
const { verifyOutput, VIDEO_EXTENSIONS } = require('./video-render')

const MAX_SECONDS = 180
const MAX_SIDE = 4096
const READY_TIMEOUT_MS = 15000

const even = value => Math.max(2, Math.round(Number(value) / 2) * 2)
const inside = (root, target) => {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

// Что можно загрузить странице: файлы из рабочих папок, data: и blob:. Всё остальное —
// сеть, чужие диски, расширения — отказ.
function requestAllowed(url, roots) {
  if (/^(data|blob|devtools):/i.test(url)) return true
  if (!/^file:/i.test(url)) return false
  let target
  try { target = path.resolve(fileURLToPath(url)) } catch { return false }
  return roots.some(root => inside(path.resolve(root), target))
}

async function renderHtml(tools, options) {
  const { electron, htmlFile, output, roots = [], onProgress, signal } = options
  // Этапы — в журнал: рендер страницы упирается в окно и протокол, и «завис» без следов не разобрать.
  const log = typeof options.log === 'function' ? options.log : () => {}
  if (!electron || !electron.BrowserWindow || !electron.session) return { ok: false, error: 'Рендер страницы недоступен: нет окна Electron.' }
  const width = even(Math.min(Number(options.width) || 1080, MAX_SIDE))
  const height = even(Math.min(Number(options.height) || 1920, MAX_SIDE))
  const scale = [1, 2].includes(Number(options.scale)) ? Number(options.scale) : 1
  const fps = Math.min(Math.max(Math.round(Number(options.fps) || 30), 1), 60)
  const duration = Number(options.duration)
  if (!(duration >= 0.1) || duration > MAX_SECONDS) return { ok: false, error: `Длительность ролика — от 0.1 до ${MAX_SECONDS} с.` }
  const extension = path.extname(String(output || '')).toLowerCase()
  if (!VIDEO_EXTENSIONS.has(extension)) return { ok: false, error: `Результат должен быть видеофайлом: mp4, webm или mov; получено «${extension || 'без расширения'}».` }
  if (!fs.existsSync(htmlFile)) return { ok: false, error: `Страница не найдена: ${htmlFile}` }
  if (signal?.aborted) return { ok: false, aborted: true, error: 'Остановлено пользователем.' }

  const total = Math.max(1, Math.round(duration * fps))
  const started = Date.now()
  const partition = `onlyone-clip-${process.pid}-${started}`
  const session = electron.session.fromPartition(partition)
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !requestAllowed(details.url, roots) }))

  const win = new electron.BrowserWindow({
    width: 960, height: 540, useContentSize: true, show: false, frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, session }
  })
  win.webContents.setFrameRate(60)
  const pageErrors = []
  win.webContents.on('console-message', event => { if (event && event.level === 'error') pageErrors.push(String(event.message).slice(0, 200)) })
  const dbg = win.webContents.debugger

  let ff = null
  let aborted = false
  const onAbort = () => { aborted = true; if (ff) { try { ff.kill() } catch { /* уже завершился */ } } }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })

  const cleanup = async () => {
    if (signal) signal.removeEventListener('abort', onAbort)
    try { dbg.detach() } catch { /* не был подключён */ }
    try { if (!win.isDestroyed()) win.destroy() } catch { /* уже закрыто */ }
    try { await session.clearStorageData() } catch { /* сессия одноразовая */ }
  }

  try {
    // Отладчик — к странице, у которой уже есть процесс отрисовки: команды окну, что ещё
    // ничего не загружало, зависают без ответа.
    await win.loadURL('about:blank')
    dbg.attach('1.3')
    log('окно создано, отладчик подключён')
    await dbg.sendCommand('Page.enable')
    // Часы — раньше любого скрипта страницы: иначе её таймеры уже пошли бы по настоящему времени.
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SOURCE })
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
    log('грузим страницу')
    await win.loadURL(pathToFileURL(htmlFile).toString())
    log('страница загружена')
    const js = code => win.webContents.executeJavaScript(code, true)
    // Шрифты и картинки — до первого кадра: иначе он снимется с подменой шрифта и пустыми местами.
    const ready = await Promise.race([
      js(`(async () => {
        if (!window.__clip) return 'нет часов'
        try { await document.fonts.ready } catch {}
        const images = [...document.images].filter(img => !img.complete)
        await Promise.all(images.map(img => new Promise(done => { img.addEventListener('load', done, { once: true }); img.addEventListener('error', done, { once: true }) })))
        return 'ok'
      })()`),
      new Promise(resolve => setTimeout(() => resolve('таймаут'), READY_TIMEOUT_MS))
    ])
    if (ready !== 'ok') return { ok: false, error: ready === 'таймаут' ? 'Страница не догрузила шрифты и картинки за 15 с.' : `Страница не готова: ${ready}` }
    log('шрифты и картинки готовы')
    await js('window.__clip.advanceTo(0)')

    // Кадр: PNG без потерь (по умолчанию) или JPEG q95 (`capture: 'fast'`) — примерно на
    // пятую часть быстрее, цена — лёгкая потеря чёткости мелкого текста. Основное время кадра
    // уходит не на кодирование, а на ожидание отрисовки, поэтому выигрыш скромный.
    const fast = options.capture === 'fast'
    const grab = async () => {
      const shot = await dbg.sendCommand('Page.captureScreenshot', fast
        ? { format: 'jpeg', quality: 95, fromSurface: true, captureBeyondViewport: false }
        : { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false })
      const png = Buffer.from(shot.data, 'base64')
      if (fast) {
        // Размер JPEG — в маркере SOF0/SOF2: ищем его, а не читаем по смещению PNG.
        let at = 2
        while (at + 9 < png.length) {
          if (png[at] !== 0xff) { at++; continue }
          const marker = png[at + 1]
          if (marker === 0xc0 || marker === 0xc2) return { png, height: png.readUInt16BE(at + 5), width: png.readUInt16BE(at + 7) }
          at += 2 + png.readUInt16BE(at + 2)
        }
        return { png, width: 0, height: 0 }
      }
      return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    }
    const first = await grab()
    log(`первый кадр ${first.width}×${first.height}`)

    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', fast ? 'mjpeg' : 'png', '-framerate', String(fps), '-i', '-']
    if (options.audio) args.push('-i', options.audio)
    // Кадр снимается в width×height×scale; на выходе — ровно width×height.
    args.push('-vf', `scale=${width}:${height}:flags=lanczos`)
    args.push(...(options.encodeArgs || []))
    if (options.audio) args.push('-shortest')
    args.push(output)
    ff = spawn(tools.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let ffErr = ''
    ff.stderr.on('data', chunk => { ffErr += chunk; if (ffErr.length > 100000) ffErr = ffErr.slice(-50000) })
    const closed = new Promise(resolve => ff.on('close', code => resolve(code === null ? -1 : code)))
    log('ffmpeg запущен')
    let stdinError = null
    ff.stdin.on('error', error => { stdinError = error })
    ff.on('error', error => { stdinError = error })
    const write = buffer => new Promise(resolve => {
      if (stdinError || aborted) return resolve()
      if (ff.stdin.write(buffer)) resolve()
      else ff.stdin.once('drain', resolve)
    })

    let frame = 0
    for (; frame < total; frame++) {
      if (aborted || stdinError) break
      if (frame > 0) {
        await js(`window.__clip.advanceTo(${((frame * 1000) / fps).toFixed(3)})`)
      }
      const shot = frame === 0 ? first : await grab()
      if (shot.width !== first.width || shot.height !== first.height) {
        stdinError = new Error(`размер кадра сменился: ${shot.width}×${shot.height}`)
        break
      }
      await write(shot.png)
      if (frame % 30 === 0) log(`кадр ${frame + 1}/${total}`)
      if (typeof onProgress === 'function' && (frame % 3 === 0 || frame === total - 1)) {
        try { onProgress(Math.min((frame + 1) / total, 0.99)) } catch { /* окно не должно ронять рендер */ }
      }
    }
    try { ff.stdin.end() } catch { /* уже закрыт */ }
    const code = await closed
    const seconds = Math.round((Date.now() - started) / 100) / 10
    if (aborted) return { ok: false, aborted: true, seconds, error: 'Рендер остановлен. Файл на диске мог остаться недописанным — не открывай его как готовый.' }
    if (stdinError) return { ok: false, seconds, error: `Сборка оборвалась: ${String(stdinError.message || stdinError)}${ffErr ? ` · ${ffErr.trim().slice(-300)}` : ''}` }
    if (code !== 0) return { ok: false, seconds, error: `ffmpeg завершился с кодом ${code}: ${ffErr.trim().slice(-400)}` }
    const verified = await verifyOutput(tools, output, seconds, options.exec)
    if (verified.ok && typeof onProgress === 'function') { try { onProgress(1) } catch { /* см. выше */ } }
    return { ...verified, frames: frame, ...(pageErrors.length ? { pageErrors: pageErrors.slice(0, 5) } : {}) }
  } catch (error) {
    if (ff) { try { ff.kill() } catch { /* уже завершился */ } }
    return { ok: false, error: `Рендер страницы не удался: ${String(error?.message || error)}` }
  } finally {
    await cleanup()
  }
}

module.exports = { renderHtml, requestAllowed, MAX_SECONDS }
