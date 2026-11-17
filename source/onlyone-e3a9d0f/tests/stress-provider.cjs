// Ломаем связь с моделью (вручную, не в общем прогоне): локальный «хаос-сервер» в диалекте OpenAI отвечает на каждое
// сообщение по метке в тексте — 429, 500 с HTML, 401, оборванный JSON, оборванный и мусорный поток, пустой ответ,
// только рассуждение, зависание, капельную подачу, огромный ответ. Смотрим на окно: ход заканчивается (или
// останавливается кнопкой), у человека понятная фраза вместо сырого JSON и HTML, поле ввода снова живо, ошибок окна нет.
//   node tests/stress-provider.cjs
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-stressprov-'))
const profile = path.join(dir, 'profile'); const workspace = path.join(dir, 'workspace')
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
const MODEL = 'хаос-модель'

const sse = frames => frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'
const content = text => ({ choices: [{ delta: { content: text } }] })
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] }

const hits = []
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    let body = null; try { body = raw ? JSON.parse(raw) : null } catch { /* не json */ }
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: MODEL }] })); return }
    const text = JSON.stringify(body && body.messages || '')
    const mode = (text.match(/CHAOS:([a-z0-9]+)/) || [])[1] || 'ok'
    hits.push(mode)
    const sseHead = () => res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    switch (mode) {
      case '429': res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' }); res.end('{"error":{"message":"Rate limit exceeded: free-models-per-day","code":429}}'); break
      case '500': res.writeHead(500, { 'Content-Type': 'text/html' }); res.end('<html><body><h1>500 Internal Server Error</h1><pre>at Object.handler (/srv/app.js:12:3)</pre></body></html>'); break
      case '401': res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"No auth credentials found","code":401}}'); break
      case 'badjson': res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"choices": ['); break
      case 'trunc': sseHead(); res.write('data: {"choices":[{"delta":{"content":"Начало ответа, которое обо'); setTimeout(() => res.destroy(), 150); break
      case 'garbage': sseHead(); res.write('data: это не json\n\n: keep-alive\n\nevent: ping\n\ndata: {"choices":[{"delta":{"content":"Ответ после мусора."}}]}\n\ndata: {"choices":\n\n'); res.end(sse([stop])); break
      case 'empty': sseHead(); res.end(sse([stop])); break
      case 'reasoning': sseHead(); res.end(sse([{ choices: [{ delta: { reasoning: 'Думаю, думаю, думаю…' } }] }, stop])); break
      case 'hang': sseHead(); res.write(`data: ${JSON.stringify(content('Начал отвечать и замолчал. '))}\n\n`); setTimeout(() => res.end(), 300000); break
      case 'drip': { sseHead(); let i = 0; const timer = setInterval(() => { if (i++ >= 120) { clearInterval(timer); res.end(sse([stop])); return } res.write(`data: ${JSON.stringify(content('капля '))}\n\n`) }, 40); res.on('close', () => clearInterval(timer)); break }
      case 'big50': sseHead(); res.end(sse([content('Строка ответа с обычным текстом и **выделением**. '.repeat(1000)), stop])); break
      case 'big200': sseHead(); res.end(sse([content('Строка ответа с обычным текстом и **выделением**. '.repeat(4000)), stop])); break
      case 'big500': sseHead(); res.end(sse([content('Строка ответа с обычным текстом и **выделением**. '.repeat(10000)), stop])); break
      case 'huge': sseHead(); res.end(sse([content('Очень длинный ответ. '.repeat(120000)), stop])); break
      case 'length': sseHead(); res.end(sse([content('Ответ, который упёрся в предел'), { choices: [{ delta: {}, finish_reason: 'length' }] }])); break
      case 'nameless': sseHead(); res.end(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: '', arguments: '{}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }])); break
      default: sseHead(); res.end(sse([content('Обычный ответ.'), stop]))
    }
  })
})

const MODES = (process.env.CHAOS_MODES || 'ok,429,500,401,badjson,trunc,garbage,empty,reasoning,drip,length,nameless,hang,big50,big200,big500').split(',')

const PRELUDE = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 30000) => { const stop = Date.now() + ms; while (Date.now() < stop) { let v = false; try { v = await fn() } catch {} if (v) return true; await wait(120) } return false }
  await until(() => document.documentElement.dataset.appReady === '1', 30000)
  if ($('onboarding') && !$('onboarding').hidden) $('onboarding').hidden = true
  await wait(800)
`
const SETUP = `${PRELUDE}
  $('openSettingsBtn').click(); await wait(600); $('tab-keys').click(); await wait(400)
  const select = $('providerSelect'); select.value = 'openai-compatible'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait(700)
  $('customBaseUrlInput').value = '__ONECODE_ARG__'; $('customModelInput').value = '${MODEL}'; $('customKeyInput').value = 'sk-chaos-key-12345'
  $('btnSaveCustomProvider').click(); await until(() => /Сохранено/.test($('customProviderMessage').textContent), 15000)
  select.value = 'openai-compatible'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait(600)
  return { ok: true }
`
const RUN = `${PRELUDE}
  const MODES = ${JSON.stringify(MODES)}
  const busy = () => $('sendBtn') && $('sendBtn').classList.contains('is-stop')
  const errors = []
  window.addEventListener('error', e => errors.push(String(e.message).slice(0, 140)))
  window.addEventListener('unhandledrejection', e => errors.push('promise: ' + String(e.reason && e.reason.message || e.reason).slice(0, 140)))
  const out = []
  for (const mode of MODES) {
    const before = errors.length
    $('newChatBtn') && $('newChatBtn').click(); await wait(500)
    const box = $('composerTextarea'); box.value = 'Скажи что-нибудь CHAOS:' + mode; box.dispatchEvent(new Event('input', { bubbles: true })); await wait(120)
    const t0 = Date.now()
    $('composerForm').requestSubmit()
    await until(() => busy() || $('messagesList').innerText.length > 40, 8000)
    let stoppedByUs = false
    let idle = await until(() => !busy(), mode === 'hang' ? 12000 : 70000)
    if (!idle && mode === 'hang') { $('sendBtn').click(); stoppedByUs = true; idle = await until(() => !busy(), 8000) }
    await wait(900)
    const feed = $('messagesList').innerText.replace(/\\s+/g, ' ').trim()
    const canType = !$('composerTextarea').disabled
    out.push({ mode, idle, stoppedByUs, seconds: Math.round((Date.now() - t0) / 1000), canType, feedLength: feed.length, tail: feed.slice(-260), full: mode === '500' ? feed.slice(0, 1600) : '', renderMs: Date.now() - t0, newErrors: errors.slice(before) })
  }
  return { ok: true, out }
`

function launch (name, body) {
  return new Promise(resolve => {
    const script = path.join(dir, name + '.js'); fs.writeFileSync(script, `(async () => {${body}})()`)
    const result = path.join(dir, name + '.json'); const shot = path.join(dir, name + '.png')
    const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
      cwd: root, stdio: 'ignore',
      env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_SHOT: shot, ONECODE_E2E: '1', ONECODE_VERSIONS: '0', ONECODE_ARG: `http://127.0.0.1:${server.address().port}/v1` })
    })
    const timer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 900000)
    child.on('close', () => { clearTimeout(timer); let r = null; try { r = JSON.parse(fs.readFileSync(result, 'utf8')) } catch { /* нет отчёта */ } resolve({ r, shot }) })
  })
}

;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await launch('setup', SETUP)
  const { r, shot } = await launch('run', RUN)
  if (!r || !r.out) { console.log('ПРОВАЛ: окно не отчиталось (зависло или упал главный процесс)'); process.exit(0) }
  const raw = [[/"error"\s*:|\{"|\}\s*$/, 'сырой JSON'], [/<html|<body|<h1>/i, 'HTML'], [/\bat Object\.|\.js:\d+:\d+/, 'трасса стека'], [/\bundefined\b|\[object /, 'undefined/[object]'], [/Rate limit exceeded: free-models/, 'текст провайдера дословно']]
  const problems = []
  for (const item of r.out) {
    const issues = []
    if (!item.idle) issues.push('ход не закончился' + (item.stoppedByUs ? ' даже после «Остановить»' : ''))
    if (!item.canType) issues.push('поле ввода заблокировано')
    if (item.newErrors.length) issues.push('ошибки окна: ' + item.newErrors.join(' | '))
    for (const [re, what] of raw) if (re.test(item.tail)) issues.push('в ленте ' + what)
    if (item.mode !== 'ok' && item.feedLength < 60 && !['empty', 'reasoning'].includes(item.mode)) issues.push('человеку ничего не сказано (лента ' + item.feedLength + ' знаков)')
    if (item.full) console.log('    лента 500: ' + item.full)
    console.log((issues.length ? '  ✗ ' : '  ✓ ') + item.mode.padEnd(10) + ' ' + String(item.seconds).padStart(3) + ' с  «' + item.tail.slice(-150) + '»')
    if (issues.length) problems.push(item.mode + ': ' + issues.join('; '))
  }
  console.log(problems.length ? 'НАХОДКИ (' + problems.length + '):' : 'находок нет')
  for (const p of problems) console.log('  - ' + p)
  console.log('запросов к хаос-серверу: ' + hits.length + ' (' + [...new Set(hits)].join(',') + ')\nСнимок: ' + shot)
  server.close(); process.exit(0)
})()
