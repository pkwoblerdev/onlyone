// Браузер агента и серверный редирект в настоящем Electron. Сторож перехода отменял КАЖДЫЙ редирект на публичное имя
// и продолжал его заново, а исходный loadURL при отмене падал с ERR_FAILED (-2): browse_page отвечал «не загрузилось»
// на любой сайт с редиректом (http→https, /путь→/путь/, смена локали) — например, на polymarket.com/ru/event/.
//   node tests/run-agent-browser-redirect.cjs
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, runDir, settleRun } = require('./app-launch.cjs')

;(async () => {
  const out = runDir('onlyone-browser-redirect')
  const server = http.createServer((request, response) => {
    const html = text => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><title>t</title><body><p>' + text + '</p></body>') }
    const jump = to => { response.writeHead(308, { location: to }); response.end() }
    if (request.url === '/plain') return html('простая страница')
    if (request.url === '/ru/event/') return jump('/ru/event')
    if (request.url === '/ru/event') return html('страница после редиректа')
    if (request.url === '/a') return jump('/b')
    if (request.url === '/b') return jump('/ru/event')
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const resultFile = path.join(out, 'result.json')
  const env = { ...process.env, REDIRECT_PORT: String(server.address().port), REDIRECT_OUT: resultFile }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronBinary(), [path.join(__dirname, 'agent-browser-redirect-electron.cjs'), '--no-sandbox', '--user-data-dir=' + path.join(out, 'profile')], { env, stdio: 'ignore' })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 120000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  server.close()

  const results = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null
  let failed = 0
  const check = (name, ok, detail) => { console.log((ok ? '  ok  ' : 'ПРОВАЛ ') + name + (ok ? '' : ' — ' + detail)); if (!ok) failed++ }
  check('приложение отчиталось', Array.isArray(results), 'нет файла итога')
  for (const item of results || []) {
    check(item.name + ': страница прочитана', item.success && item.has, JSON.stringify(item))
  }
  settleRun(out, failed === 0)
  console.log(JSON.stringify({ ok: failed === 0, failed }))
  process.exit(failed ? 1 : 0)
})()
