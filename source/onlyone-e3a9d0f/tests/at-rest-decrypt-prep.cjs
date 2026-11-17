// at-rest-decrypt-prep.cjs: подготовка зашифрованных safeStorage файлов для оконного теста unwrapProtectedBytes
'use strict'
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  try {
    const profile = process.argv[2]
    if (!profile) throw new Error('profile dir required')
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption is not available on this machine')
    }

    const protect = text => safeStorage.encryptString(String(text)).toString('base64')
    const protectBuf = buf => safeStorage.encryptString(buf.toString('base64')).toString('base64')

    // 1. Артефакт-картинка
    const artifactsDir = path.join(profile, 'artifacts')
    const artId = 'test-art-image-01'
    const artFolder = path.join(artifactsDir, artId)
    fs.mkdirSync(artFolder, { recursive: true })

    // 10x10 валидный PNG
    const samplePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const encryptedPng = protectBuf(samplePng)
    fs.writeFileSync(path.join(artFolder, '1-image.png'), JSON.stringify({
      enc: 'safeStorage',
      data: encryptedPng,
      b64: true
    }), 'utf8')

    fs.writeFileSync(path.join(artFolder, 'meta.json'), JSON.stringify({
      id: artId,
      kind: 'image',
      title: 'Тестовая картинка',
      chatId: 'ui',
      current: 1,
      versions: [{ n: 1, at: Date.now(), file: '1-image.png', chars: samplePng.length }]
    }), 'utf8')

    // 2. Макет Дизайна с файлами CSS и JS
    const designsDir = path.join(profile, 'designs')
    const designId = 'test-design-decrypt-01'
    const designFolder = path.join(designsDir, designId)
    fs.mkdirSync(designFolder, { recursive: true })

    const htmlContent = '<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="designBox" class="test-design-box">DESIGN ENCRYPTED OK</div><script src="script.js"></script></body></html>'
    fs.writeFileSync(path.join(designFolder, 'Home.dc.html'), JSON.stringify({
      enc: 'safeStorage',
      data: protect(htmlContent)
    }), 'utf8')

    const cssContent = '.test-design-box { background-color: rgb(255, 105, 180); color: rgb(255, 255, 255); padding: 24px; font-size: 22px; font-weight: bold; border-radius: 12px; }'
    fs.writeFileSync(path.join(designFolder, 'style.css'), JSON.stringify({
      enc: 'safeStorage',
      data: protect(cssContent)
    }), 'utf8')

    const jsContent = 'window.__designScriptRan = true; var el = document.getElementById("designBox"); if (el) el.setAttribute("data-script-ok", "true"); var bg = el ? window.getComputedStyle(el).backgroundColor : ""; window.parent.postMessage({ type: "ONECODE_DESIGN_TEST", scriptOk: true, bg: bg }, "*");'
    fs.writeFileSync(path.join(designFolder, 'script.js'), JSON.stringify({
      enc: 'safeStorage',
      data: protect(jsContent)
    }), 'utf8')

    // 3. Вложение чата (картинка)
    const attachDir = path.join(profile, 'attachments')
    fs.mkdirSync(attachDir, { recursive: true })
    const attachFile = path.join(attachDir, 'sample-attachment.png')
    fs.writeFileSync(attachFile, JSON.stringify({
      enc: 'safeStorage',
      data: encryptedPng,
      b64: true
    }), 'utf8')

    const manifest = {
      ok: true,
      artId,
      designId,
      attachFile,
      pngLength: samplePng.length
    }
    fs.writeFileSync(path.join(profile, 'at-rest-manifest.json'), JSON.stringify(manifest), 'utf8')
    app.quit()
  } catch (err) {
    console.error('PREP_ERROR:', err.message)
    app.exit(1)
  }
})
