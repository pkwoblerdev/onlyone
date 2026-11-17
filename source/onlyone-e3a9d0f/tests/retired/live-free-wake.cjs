// ЖИВАЯ проверка на бесплатных моделях (вручную, не в общем прогоне): страница с ошибкой во вкладке
// браузера панели → сообщение в чат само → настоящая бесплатная модель чинит файл → вкладка
// обновляется сама. Меряет, за сколько это происходит на каждой модели.
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
const BROKEN = '<!doctype html><title>BROKEN</title><h1>Сломано</h1><script>setTimeout(function(){ itDoesNotExist() }, 50)</script>'

async function one (modelId) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-live-free-'))
  const workspace = path.join(out, 'workspace')
  const profile = path.join(out, 'profile')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'index.html'), BROKEN)

  const settings = JSON.parse(fs.readFileSync(path.join(home, '1code-settings.json'), 'utf8'))
  settings.defaultModel = modelId
  settings.workspace = { path: workspace, permission: 'acceptEdits' }
  settings.projects = []
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify(settings))
  fs.copyFileSync(path.join(home, 'Local State'), path.join(profile, 'Local State'))

  const server = http.createServer((request, response) => {
    const file = path.join(workspace, request.url === '/' ? 'index.html' : request.url.split('?')[0])
    fs.readFile(file, (error, body) => {
      if (error) { response.writeHead(404); response.end('нет'); return }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(body)
    })
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
    const until = async (fn, ms) => { const stop = Date.now() + ms; while (Date.now() < stop) { if (await fn()) return true; await wait(100) } return false }
    try {
      if (!await until(() => document.documentElement.dataset.appReady === '1', 30000)) { result.note = 'окно не поднялось'; return { ok: false, result } }
      if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
      await wait(800)
      $('newChatBtn')?.click()
      await wait(400)
      $('openBrowserBtn').click()
      await wait(500)
      const t0 = Date.now()
      $('browserAddress').value = 'http://127.0.0.1:${port}/'
      $('browserAddress').dispatchEvent(new Event('input', { bubbles: true }))
      $('browserForm').requestSubmit()
      await until(async () => (await title()) === 'BROKEN', 20000)
      const tLoaded = Date.now()
      const woke = await until(() => /сама сообщила о проблеме/.test(feed()), 20000)
      result.wokeMs = woke ? Date.now() - tLoaded : null
      if (!woke) { result.note = 'модель не разбужена'; return { ok: false, result } }
      const origin0 = await view().executeJavaScript('performance.timeOrigin')
      const fixed = await until(async () => { try { return (await view().executeJavaScript('performance.timeOrigin')) !== origin0 } catch { return false } }, 150000)
      result.fixedMs = fixed ? Date.now() - tLoaded : null
      result.note = fixed ? 'вкладка обновилась сама после правки' : 'вкладка не перезагрузилась за 150 с'
      result.tail = feed().slice(-220)
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
    try { if (fileFixedMs === null && !fs.readFileSync(path.join(workspace, 'index.html'), 'utf8').includes('itDoesNotExist()')) fileFixedMs = Date.now() - startedAt } catch { /* файл пишется */ }
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
  report.fileFixed = fileFixedMs !== null
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  return report
}

;(async () => {
  for (const id of models) {
    const r = await one(id)
    const info = r.result || r
    console.log(JSON.stringify({ model: id, ok: r.ok === true && r.fileFixed === true, fileFixed: r.fileFixed, wokeMs: info.wokeMs, reloadedAfterMs: info.fixedMs, note: info.note, tail: (info.tail || '').slice(-120) }))
  }
})().catch(error => { console.error(error); process.exit(1) })
