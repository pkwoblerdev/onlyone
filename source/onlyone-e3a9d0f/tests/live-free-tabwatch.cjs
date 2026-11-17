// ЖИВАЯ проверка наблюдателя вкладки на бесплатных моделях (вручную, не в общем прогоне): во вкладке
// тикает таймер; когда на странице появляется ГОТОВО, настоящая бесплатная модель САМА получает
// сообщение, записывает result.txt и (если видит картинки) смотрит на снимок. Меряет задержки.
//
// Ключ берётся из профиля владельца (копия настроек и Local State во временную папку; внутрь ничего
// не печатается). Допускаются ТОЛЬКО модели с суффиксом :free — платный вызов исключён проверкой
// до запуска. Использование:  node tests/live-free-wake.cjs <модель:free> [<модель:free> …]
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const models = process.argv.slice(2)
if (!models.length) { console.error('Укажите бесплатные модели: node tests/live-free-wake.cjs nvidia/nemotron-3.5-lightning:free'); process.exit(2) }
for (const id of models) {
  if (!/:free$/.test(id)) { console.error('Только бесплатные модели (…:free): ' + id); process.exit(2) }
}

const home = path.join(process.env.APPDATA || '', '1code')
const BROKEN = '<!doctype html><title>Табло</title><h1 id="t">Ждём</h1><script>setInterval(function(){fetch("/state").then(function(x){return x.text()}).then(function(s){document.getElementById("t").textContent=s})},400)</script>'
let flag = false

async function one (modelId) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-live-free-'))
  const workspace = path.join(out, 'workspace')
  const profile = path.join(out, 'profile')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(profile, { recursive: true })

  const settings = JSON.parse(fs.readFileSync(path.join(home, '1code-settings.json'), 'utf8'))
  settings.defaultModel = modelId
  settings.workspace = { path: workspace, permission: 'acceptEdits' }
  settings.projects = []
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify(settings))
  fs.copyFileSync(path.join(home, 'Local State'), path.join(profile, 'Local State'))

  const server = http.createServer((request, response) => {
    if (request.url === '/trigger') { flag = true; response.writeHead(200, { 'access-control-allow-origin': '*' }); response.end('ok'); return }
    if (request.url === '/state') { response.writeHead(200, { 'cache-control': 'no-store' }); response.end(flag ? 'ГОТОВО' : 'Ждём'); return }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(BROKEN)
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const script = path.join(out, 'renderer.js')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const feed = () => ((document.getElementById('messagesList') || {}).textContent || '').replace(/\\s+/g, ' ')
    const view = () => document.querySelector('#browserViews webview')
    const title = async () => { try { return await view().executeJavaScript('document.title') } catch { return '' } }
    const result = { model: ${JSON.stringify(modelId)}, wokeMs: null, answeredMs: null, fixedMs: null, note: '' }
    const until = async (fn, ms) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch { /* вкладка ещё не готова */ } await wait(100) } return false }
    try {
      if (!await until(() => document.documentElement.dataset.appReady === '1', 30000)) { result.note = 'окно не поднялось'; return { ok: false, result } }
      if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
      await wait(800)
      $('newChatBtn')?.click()
      await wait(400)
      const watches = () => (window.OnlyonePageWatches ? window.OnlyonePageWatches.list() : [])
      const t0 = Date.now()
      $('composerTextarea').value = 'Следи за страницей http://127.0.0.1:${port}/ в браузере: когда на ней появится слово ГОТОВО — запиши файл result.txt с текстом страницы и коротко скажи, что сделал.'
      $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
      $('composerForm').requestSubmit()
      const placed = await until(() => watches().length >= 1, 120000)
      result.setupMs = placed ? Date.now() - t0 : null
      if (!placed) { result.note = 'модель не поставила слежение (watch_page не вызван)'; result.tail = feed().slice(-220); return { ok: false, result } }
      // Ход, в котором модель ставила слежение, ещё может идти (она дописывает ответ): пробуждение, пришедшее
      // посреди хода, по правилам чата встаёт в очередь. Для замера ждём, пока чат освободится.
      await until(() => !document.querySelector('.btn-send.is-stop'), 120000)
      await wait(1500)
      // Страница меняется сама: сервер переключает табло на ГОТОВО.
      // Из самой страницы (у окна приложения своя политика соединений): сервер переключает табло на ГОТОВО.
      await view().executeJavaScript("fetch('/trigger')")
      const tPage = Date.now()
      const woke = await until(() => /сообщение слежения за страницей/.test(feed()), 20000)
      result.wokeMs = woke ? Date.now() - tPage : null
      if (!woke) { result.note = 'модель не разбужена; слежений в списке: ' + watches().length + '; страница: ' + (await view().executeJavaScript('document.body.innerText').catch(() => '?')); result.tail = feed().slice(-300); return { ok: false, result } }
      const answered = await until(() => /Создан файл|Изменён файл|Записал/.test(feed().slice(feed().indexOf('сообщение слежения за страницей') + 400)), 150000)
      result.fixedMs = answered ? Date.now() - tPage : null
      result.note = answered ? 'модель ответила и действовала' : 'модель не успела за 150 с'
      result.tail = feed().slice(-220)
      const fixed = answered
      return { ok: fixed, result }
    } catch (error) { result.note = String((error && error.message) || error).slice(0, 200); return { ok: false, result } }
  })()`)

  const resultFile = path.join(out, 'result.json')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, stdio: 'ignore',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1' })
  })
  const startedAt = Date.now()
  let fileFixedMs = null
  const poll = setInterval(() => {
    try { if (fileFixedMs === null && fs.existsSync(path.join(workspace, 'result.txt'))) fileFixedMs = Date.now() - startedAt } catch { /* файл пишется */ }
  }, 200)
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 240000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  clearInterval(poll)
  server.close()
  let report = { ok: false, note: 'окно не отчиталось' }
  if (fs.existsSync(resultFile)) {
    report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  }
  report.fileFixed = fs.existsSync(path.join(workspace, 'result.txt'))
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  return report
}

;(async () => {
  for (const id of models) {
    const r = await one(id)
    const info = r.result || r
    console.log(JSON.stringify({ model: id, ok: r.ok === true && r.fileFixed === true, resultTxt: r.fileFixed, setupMs: info.setupMs, wokeMs: info.wokeMs, answeredAfterMs: info.fixedMs, note: info.note, tail: (info.tail || '').slice(-120) }))
  }
})().catch(error => { console.error(error); process.exit(1) })
