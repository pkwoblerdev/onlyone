// Приложение телефона: настоящие экраны (то же ядро Chromium, что у WebView Android), настоящий посредник и настоящее ядро
// компьютера с придуманными чатами. Спаривание, общий список, чат с блоками хода, разрешения (в том числе удержание для
// опасного), вопросы, отправка, остановка, модель, задачи, снимок, свои чаты с ключом, шифрование на диске, перезапуск,
// английский язык и обрыв связи.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const { startHarness } = require('./mobile-harness.cjs')

const out = runDir('onlyone-mobile')

async function main () {
  const stand = await startHarness()
  const code = await stand.code()
  stand.approvals.push({ id: 'a1', requestId: 'run1', summary: 'Записать файл src/payments/gateway.js', details: 'новый файл, 58 строк', risk: 'edit' })
  stand.approvals.push({ id: 'a2', requestId: 'run1', summary: 'Выполнить команду', details: 'rm -rf dist && npm run build', risk: 'external' })
  stand.questions.push({ id: 'q1', requestId: 'run1', question: 'Какой стиль тестов взять?', options: [{ label: 'node:test', detail: 'без зависимостей' }, { label: 'jest' }] })

  const script = path.join(out, 'phone.js')
  fs.writeFileSync(script, require('./mobile-scenario.cjs')({ code, relayUrl: stand.relayUrl, providerUrl: stand.providerUrl }))

  // Мост к «компьютеру» из страницы: страница спрашивает у процесса проверки через window-функции, которые тут подставляет оболочка.
  const shell = path.join(out, 'shell.cjs')
  fs.writeFileSync(shell, `
    const { app, BrowserWindow, ipcMain } = require('electron')
    const fs = require('node:fs')
    app.commandLine.appendSwitch('no-sandbox')
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ width: 390, height: 844, show: false })
      const errors = []
      win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) })
      await win.loadURL(process.env.MOBILE_URL)
      const probe = ${JSON.stringify({ port: 0 })}
      let result
      try { result = await win.webContents.executeJavaScript(fs.readFileSync(process.env.MOBILE_SCRIPT, 'utf8'), true) } catch (error) { result = { ok: false, checks: [{ name: 'сценарий упал', pass: false, detail: String(error && error.stack || error).slice(0, 500) }] } }
      result.consoleErrors = errors
      fs.writeFileSync(process.env.MOBILE_OUT, JSON.stringify(result))
      app.quit()
    })
  `)
  // Страница получает связь с «компьютером» по HTTP к стенду: маленькие ручки для проверки.
  const probe = require('node:http').createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*')
    const url = new URL(request.url, 'http://x')
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/resolved') { response.end(JSON.stringify({ resolved: stand.stopped })); return }
    if (url.pathname === '/live') { stand.startLive().then(() => response.end('{}')); return }
    response.end('{}')
  })
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const probeUrl = 'http://127.0.0.1:' + probe.address().port
  const prelude = `window.__remoteCheck = async id => (await (await fetch('${probeUrl}/resolved')).json()).resolved.some(item => item[1] === id && item[0] !== 'stop');
    window.__stopped = async () => (await (await fetch('${probeUrl}/resolved')).json()).resolved;
    window.__startLive = () => fetch('${probeUrl}/live');\n`
  fs.writeFileSync(script, prelude + fs.readFileSync(script, 'utf8'))
  stand.stopped.length = 0

  const resultFile = path.join(out, 'result.json')
  const child = spawn(electronBinary(), [shell, '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(out, 'profile')], {
    cwd: path.join(__dirname, '..'), stdio: 'inherit',
    env: guiEnv({ MOBILE_URL: stand.url, MOBILE_SCRIPT: script, MOBILE_OUT: resultFile })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 180000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)

  let ok = false
  if (!fs.existsSync(resultFile)) console.error('Окно телефона не отчиталось')
  else {
    const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    for (const item of report.checks || []) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    if (report.consoleErrors && report.consoleErrors.length) console.log('ошибки консоли: ' + report.consoleErrors.join(' | '))
    ok = Boolean(report.ok)
  }
  probe.close()
  await stand.close()
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
