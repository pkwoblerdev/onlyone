'use strict'
// Зонд Desk стенда: отдельный запуск Electron без окон на профиле попытки.
// seed — кладёт заранее заданную раскладку в настоящее зашифрованное хранилище
// Desk этого чата; collect — читает раскладку после хода. Результат уходит в файл.
// Проверка читает хранилище, а не слова агента.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const mode = process.env.ONECODE_BENCH_DESK_MODE
const chatId = process.env.ONECODE_BENCH_DESK_CHAT
const out = process.env.ONECODE_BENCH_DESK_OUT
app.on('window-all-closed', () => {})
const finish = (value, code) => {
  try { fs.writeFileSync(out + '.tmp', JSON.stringify(value)); fs.renameSync(out + '.tmp', out) } catch { /* код выхода скажет */ }
  app.exit(code)
}
app.whenReady().then(() => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return finish({ ok: false, error: 'encryption-unavailable' }, 1)
    const store = require('../../src/main/desk-store.cjs').createDeskStore({ dir: path.join(app.getPath('userData'), 'desks'),
      protect: text => safeStorage.encryptString(text).toString('base64'),
      unprotect: body => safeStorage.decryptString(Buffer.from(body, 'base64')) })
    if (mode === 'seed') {
      store.save(chatId, JSON.parse(fs.readFileSync(process.env.ONECODE_BENCH_DESK_SEED, 'utf8')))
      // Ключ шифрования Chromium сбрасывается в Local State с задержкой. Выйти раньше —
      // значит оставить раскладку, которую приложение потом не расшифрует.
      const state = path.join(app.getPath('userData'), 'Local State')
      const deadline = Date.now() + 30000
      const wait = () => {
        let flushed = false
        try { flushed = fs.readFileSync(state, 'utf8').includes('os_crypt') } catch { flushed = false }
        if (flushed) return finish({ ok: true }, 0)
        if (Date.now() > deadline) return finish({ ok: false, error: 'key-not-persisted' }, 1)
        return setTimeout(wait, 100)
      }
      return wait()
    }
    if (mode === 'collect') {
      const snapshot = store.load(chatId)
      return finish(snapshot ? { ok: true, snapshot } : { ok: false, error: 'not-found' }, 0)
    }
    return finish({ ok: false, error: 'unknown-mode' }, 1)
  } catch (error) { return finish({ ok: false, error: String(error && error.message || error).slice(0, 120) }, 1) }
}).catch(() => app.exit(1))
