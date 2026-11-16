// test-update-feed-guard.cjs — находка Н6 аудита sec-net 2026-11-01 (часть про
// настройку фида) и дополнение Н8 из задания: фид обновлений — только HTTPS,
// тихая установка при выходе слушает ту же настройку автообновления, что и
// проверка, а не стоит вечная «true».
//
// Поведенческая часть исполняет НАСТОЯЩИЙ обработчик `set-update-settings`,
// вырезанный из main.js, на подставном ipcMain и хранилище.
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

globalThis.tr = require('../src/main/ui-text.cjs').tr

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

let failed = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

;(async () => {
  const start = source.indexOf("ipcMain.handle('set-update-settings'")
  const end = source.indexOf("ipcMain.handle('check-for-update'", start)
  assert.ok(start >= 0 && end > start, 'обработчик set-update-settings не найден в main.js')

  const values = new Map()
  const store = { set: (k, v) => values.set(k, v), get: k => values.get(k) }
  let captured = null
  const ipcMain = { handle: (channel, fn) => { captured = fn } }
  const UPDATE_FEED_KEY = 'update-feed'
  const UPDATE_AUTO_KEY = 'update-auto'
  const updateFeedUrl = () => String(values.get(UPDATE_FEED_KEY) || '').trim()
  new Function('ipcMain', 'store', 'UPDATE_FEED_KEY', 'UPDATE_AUTO_KEY', 'updateFeedUrl', 'autoUpdateEnabled',
    source.slice(start, end))(ipcMain, store, UPDATE_FEED_KEY, UPDATE_AUTO_KEY, updateFeedUrl, () => false)
  assert.equal(typeof captured, 'function', 'обработчик не зарегистрировался в подставном ipcMain')

  await check('http:// фид отклоняется: по http подменят файл, приложение ставит чужое', async () => {
    await assert.rejects(() => captured({}, { feedUrl: 'http://pkwobler.best/1code/' }), /HTTPS/i)
    assert.equal(values.get(UPDATE_FEED_KEY), undefined, 'отклонённый адрес всё равно записан в хранилище')
  })

  await check('https:// фид принимается и дописывает слэш на конце', async () => {
    const saved = await captured({}, { feedUrl: 'https://updates.example.com/1code' })
    assert.equal(saved.feedUrl, 'https://updates.example.com/1code/')
  })

  await check('пустой адрес фид очищает (свой фид человек может выключить)', async () => {
    const saved = await captured({}, { feedUrl: '' })
    assert.equal(saved.feedUrl, '')
  })

  await check('мсор вместо адреса отклоняется как и раньше', async () => {
    await assert.rejects(() => captured({}, { feedUrl: 'не адрес' }), /корректн/i)
  })

  await check('автоустановка следует отключённой политике', () => {
    const gStart = source.indexOf('function getAutoUpdater')
    const gEnd = source.indexOf('function normalizeNotes', gStart)
    assert.ok(gStart >= 0 && gEnd > gStart, 'getAutoUpdater не найден')
    const body = source.slice(gStart, gEnd)
    assert.match(body, /autoUpdater\.autoInstallOnAppQuit\s*=\s*autoUpdateEnabled\(\)/,
      'autoInstallOnAppQuit не привязан к настройке: выключенное автообновление всё равно тихо ставит скачанное при выходе')
    assert.doesNotMatch(body, /autoInstallOnAppQuit\s*=\s*true/, 'autoInstallOnAppQuit записан константой true')
  })

  console.log(JSON.stringify({ ok: failed === 0, failed }))
  process.exit(failed ? 1 : 0)
})()
