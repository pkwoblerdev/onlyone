// Вспомогательный процесс прогона: читает файл страницы макета и печатает его
// развернутые байты. С 29.09 страница на диске лежит в конверте safeStorage, и
// node-процесс её не откроет — только Electron с тем же пользователем. Логика
// раскрытия совпадает с `unwrapProtectedBytes` в main.js и нарочно не тянет
// продукт: прогону нужны байты, а не внутренности приложения.
const { app, safeStorage } = require('electron')
const fs = require('fs')

const file = process.argv[2]
app.whenReady().then(() => {
  const bytes = fs.readFileSync(file)
  let text = bytes.toString('utf8')
  try {
    const parsed = JSON.parse(text)
    if (parsed && parsed.enc === 'safeStorage' && typeof parsed.data === 'string' && safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(Buffer.from(parsed.data, 'base64'))
      text = parsed.b64 ? Buffer.from(decrypted, 'base64').toString('utf8') : decrypted
    }
  } catch (notEnvelope) { /* обычный файл — остаётся как есть */ }
  process.stdout.write(JSON.stringify({ enc: text !== bytes.toString('utf8'), text }))
  app.exit(0)
})
