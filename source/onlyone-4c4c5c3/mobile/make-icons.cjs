// Рисует значки запуска onlyone (искра на тёмном) для всех плотностей Android.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
app.commandLine.appendSwitch('no-sandbox')
const RES = process.env.RES
const mark = fs.readFileSync(path.join(__dirname, 'icons', 'onlyone-mark.svg'), 'utf8')
const BG = '#171613'
const sizes = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }

const page = (size, kind) => {
  // 'legacy': скруглённый квадрат; 'round': круг; 'fg': прозрачный фон, искра в безопасной зоне (66/108)
  const spark = kind === 'fg' ? 0.5 : 0.6
  const radius = kind === 'round' ? '50%' : (kind === 'legacy' ? '22%' : '0')
  const bg = kind === 'fg' ? 'transparent' : BG
  return `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;background:${bg};border-radius:${radius};display:grid;place-items:center">
    <div style="width:${size * spark}px;height:${size * spark}px">${mark.replace('<svg ', '<svg width="100%" height="100%" ')}</div></div></body></html>`
}

async function render(win, size, kind) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(size, kind)))
  await new Promise(resolve => setTimeout(resolve, 150))
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  const got = image.getSize()
  if (got.width !== size) image = image.resize({ width: size, height: size })
  return image.toPNG()
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: false } })
  for (const [density, factor] of Object.entries(sizes)) {
    const dir = path.join(RES, 'mipmap-' + density)
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), await render(win, Math.round(48 * factor), 'legacy'))
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), await render(win, Math.round(48 * factor), 'round'))
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), await render(win, Math.round(108 * factor), 'fg'))
  }
  console.log('icons done')
  app.quit()
})
