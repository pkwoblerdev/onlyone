// Приложение на настоящем Android (эмулятор или телефон по adb): ставит APK, запускает, через отладку WebView прогоняет
// тот же сценарий, что и run-mobile-ui, против стенда на этом компьютере. Не входит в `npm test`: нужен adb и устройство.
//   node tests/run-android-device.cjs [путь к apk]
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const WebSocket = require('ws')
const { startHarness } = require('./mobile-harness.cjs')

const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk/platform-tools/adb.exe')
const APK = process.argv[2] || path.join(__dirname, '..', 'mobile', 'onlyone-1.0.0-experimental-debug.apk')
const adb = (...args) => spawnSync(ADB, args, { encoding: 'utf8', timeout: 60000 })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main () {
  if (!/\tdevice/.test(adb('devices').stdout)) { console.error('Нет устройства adb'); process.exit(2) }
  const stand = await startHarness()
  const code = await stand.code()
  stand.approvals.push({ id: 'a1', requestId: 'run1', summary: 'Записать файл src/payments/gateway.js', details: 'новый файл, 58 строк', risk: 'edit' })
  stand.approvals.push({ id: 'a2', requestId: 'run1', summary: 'Выполнить команду', details: 'rm -rf dist && npm run build', risk: 'external' })
  stand.questions.push({ id: 'q1', requestId: 'run1', question: 'Какой стиль тестов взять?', options: [{ label: 'node:test', detail: 'без зависимостей' }, { label: 'jest' }] })

  const probe = http.createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('content-type', 'application/json')
    const url = new URL(request.url, 'http://x')
    if (url.pathname === '/resolved') { response.end(JSON.stringify({ resolved: stand.stopped })); return }
    if (url.pathname === '/live') { stand.startLive().then(() => response.end('{}')); return }
    response.end('{}')
  })
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const ports = [new URL(stand.relayUrl.replace('ws', 'http')).port, new URL(stand.providerUrl).port, String(probe.address().port)]
  // Туннели телефон → компьютер ставятся с проверкой: прежний прогон оставлял свои, а непроверенный туннель молча терял соединение
  // («Failed to fetch» и спаривание, которое не доходит до стенда) — сбой стенда, а не приложения.
  adb('reverse', '--remove-all')
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const port of ports) adb('reverse', 'tcp:' + port, 'tcp:' + port)
    const listed = adb('reverse', '--list').stdout
    if (ports.every(port => listed.includes('tcp:' + port))) break
    await wait(500)
  }
  const reverseList = () => adb('reverse', '--list').stdout.trim()

  adb('uninstall', 'best.pkwobler.onlyone')
  const installed = adb('install', '-r', APK)
  console.log('установка: ' + (installed.stdout || installed.stderr).trim().split('\n').pop())
  adb('shell', 'am', 'start', '-n', 'best.pkwobler.onlyone/.MainActivity')
  await wait(6000)

  // Отладочный сокет WebView этого приложения.
  const pid = adb('shell', 'pidof', 'best.pkwobler.onlyone').stdout.trim().split(/\s+/)[0]
  const sockets = adb('shell', 'cat', '/proc/net/unix').stdout
  const socket = (sockets.match(new RegExp('webview_devtools_remote_' + pid)) || [])[0]
  if (!pid || !socket) { console.error('Нет отладочного сокета WebView (pid ' + pid + ')'); process.exit(2) }
  adb('forward', 'tcp:9333', 'localabstract:' + socket)
  const targets = await new Promise((resolve, reject) => http.get('http://127.0.0.1:9333/json', response => { let body = ''; response.on('data', chunk => { body += chunk }); response.on('end', () => resolve(JSON.parse(body))) }).on('error', reject))
  const target = targets.find(item => item.type === 'page')
  const cdp = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve => cdp.on('open', resolve))
  let id = 0
  const pending = new Map()
  cdp.on('message', raw => { const message = JSON.parse(String(raw)); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) } })
  const evaluate = expression => new Promise(resolve => { const mine = ++id; pending.set(mine, resolve); cdp.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, timeout: 170000 } })) })

  const probeUrl = 'http://127.0.0.1:' + probe.address().port
  const prelude = `window.__remoteCheck = async id => (await (await fetch('${probeUrl}/resolved')).json()).resolved.some(item => item[1] === id && item[0] !== 'stop');
    window.__stopped = async () => (await (await fetch('${probeUrl}/resolved')).json()).resolved;
    window.__startLive = () => fetch('${probeUrl}/live');
    await (async () => { while (document.documentElement.dataset.appReady !== '1') await new Promise(r => setTimeout(r, 100)); OnlyoneI18n.setLang('ru'); window.__onlyone.S.settings.lang = 'ru'; window.__onlyone.paint(''); })();\n`
  stand.stopped.length = 0
  const answer = await evaluate('(async () => {' + prelude + 'return await ' + require('./mobile-scenario.cjs')({ code, relayUrl: stand.relayUrl, providerUrl: stand.providerUrl }) + '})()')
  const report = answer.result && answer.result.result && answer.result.result.value
  let ok = false
  if (!report) console.error('Сценарий не вернул итог: ' + JSON.stringify(answer).slice(0, 400))
  else {
    if (!Array.isArray(report.checks)) console.error('Итог без checks: ' + JSON.stringify(report).slice(0, 600))
    for (const item of report.checks || []) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.pass ? '' : ' — ' + item.detail))
    ok = report.ok
  }
  if (!ok) {
    // Улики сбоя: журнал окна приложения (chromium) — почему спаривание не дошло.
    const log = adb('logcat', '-d', '-s', 'chromium:I', 'Capacitor:*', 'Capacitor/Console:*').stdout.split('\n').slice(-60).join('\n')
    console.error('--- туннели при сбое ---\n' + reverseList() + '\n--- порты стенда: ' + ports.join(', '))
    console.error('--- журнал окна приложения (последние строки) ---\n' + log)
  }
  const shot = adb('exec-out', 'screencap', '-p')
  cdp.close(); probe.close(); await stand.close()
  process.exit(ok ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
