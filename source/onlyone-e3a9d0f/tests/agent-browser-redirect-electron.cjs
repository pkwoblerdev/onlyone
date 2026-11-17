// Главный файл крошечного Electron-приложения для run-agent-browser-redirect.cjs: настоящий browsePage открывает
// страницы с серверным редиректом (локальный сервер, разрешение человека подставлено). Итог — JSON в файле:
// stdout у окна на Windows пуст. Переменные: REDIRECT_PORT, REDIRECT_OUT.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const browser = require(path.join(__dirname, '..', 'src', 'main', 'agent-browser.js'))

app.disableHardwareAcceleration()
// Скрытые окна браузера агента закрываются сами; без этого приложение выходит, не дойдя до записи итога.
app.on('window-all-closed', () => {})

const port = process.env.REDIRECT_PORT
const base = 'http://127.0.0.1:' + port
const cases = [
  { name: 'без редиректа', url: base + '/plain', want: 'простая страница' },
  { name: 'редирект на тот же хост (308, как у polymarket.com/ru/event/)', url: base + '/ru/event/', want: 'страница после редиректа' },
  { name: 'цепочка из двух редиректов', url: base + '/a', want: 'страница после редиректа' }
]

app.whenReady().then(async () => {
  const results = []
  for (const item of cases) {
    try {
      // allow: человек разрешил локальный адрес, а граница по-прежнему включена — так и проверяем переход по редиректу.
      const read = await browser.browsePage(item.url, { allow: async () => true, timeoutMs: 20000 })
      results.push({ name: item.name, success: read.success !== false, error: read.error || '', has: String(read.text || '').includes(item.want), text: String(read.text || '').slice(0, 80) })
    } catch (error) {
      results.push({ name: item.name, success: false, error: String(error.message || error), has: false, text: '' })
    }
  }
  fs.writeFileSync(process.env.REDIRECT_OUT, JSON.stringify(results))
  app.exit(0)
})
