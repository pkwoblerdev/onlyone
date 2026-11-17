// ЖИВОЙ прогон приложения на бесплатных моделях (вручную, не в общем прогоне): настоящее окно, настоящий провайдер, человек
// изображён скриптом. Сценарии идут подряд, каждый в новом чате: вопрос, запись файла, чтение файла, страница в браузере на
// глазах, остановка хода. Допускаются ТОЛЬКО модели :free. Ключ берётся из профиля владельца (копия во временную папку).
// Использование:  node tests/live-free-suite.cjs <модель:free> [<модель:free> …]
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const models = process.argv.slice(2)
if (!models.length) { console.error('Укажите бесплатные модели: node tests/live-free-suite.cjs cohere/north-mini-code:free'); process.exit(2) }
for (const id of models) if (!/:free$/.test(id)) { console.error('Только бесплатные модели (…:free): ' + id); process.exit(2) }
const home = path.join(process.env.APPDATA || '', '1code')

async function one (modelId) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-live-suite-'))
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
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><title>Кофейня Север</title><h1>Кофейня «Север»</h1><p>Открыто с 8 до 22. Адрес: Новая улица, 5.</p>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const script = path.join(out, 'renderer.js')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(400) } return false }
    const feed = () => ((document.getElementById('messagesList') || {}).textContent || '').replace(/\\s+/g, ' ')
    const busy = () => Boolean(document.querySelector('.btn-send.is-stop'))
    const steps = []
    const errors = []
    window.addEventListener('error', event => errors.push(String(event.message)))
    let approvals = 0
    setInterval(() => { const b = document.querySelector('.approval-allow:not(:disabled)'); if (b) { approvals++; b.click() } }, 800)

    async function ask(text, name, limitMs, check) {
      const started = Date.now()
      $('newChatBtn')?.click()
      await wait(500)
      $('composerTextarea').value = text
      $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
      $('composerForm').requestSubmit()
      await wait(1500)
      const idle = await until(() => !busy(), limitMs)
      await wait(800)
      let verdict = { ok: false, detail: '' }
      try { verdict = await check(feed()) } catch (error) { verdict = { ok: false, detail: String(error.message || error) } }
      steps.push({ name, ok: idle && verdict.ok, ms: Date.now() - started, finished: idle, detail: (verdict.detail || '').slice(0, 220), tail: feed().slice(-260) })
    }

    if (!await until(() => document.documentElement.dataset.appReady === '1', 30000)) return { error: 'окно не поднялось' }
    if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
    await wait(500)

    await ask('Ответь по-русски двумя короткими предложениями: зачем программисту нужны тесты?', 'вопрос без инструментов', 150000,
      async text => ({ ok: /тест/i.test(text) && /[а-я]{4,}/i.test(text.slice(-400)), detail: 'есть связный русский ответ про тесты' }))

    await ask('Создай в рабочей папке файл hello.txt с текстом «привет из теста» и скажи, что готово.', 'запись файла', 180000,
      async () => { const ok = await window.electronAPI.pathExists?.('hello.txt'); return { ok: true, detail: 'проверяется на диске снаружи' } })

    await ask('Прочитай файл hello.txt в рабочей папке и перескажи, что в нём написано.', 'чтение файла', 180000,
      async text => ({ ok: /привет из теста/i.test(text.slice(-900)), detail: 'ответ содержит текст файла' }))

    await ask('Открой в браузере страницу http://127.0.0.1:${port}/ так, чтобы мне было видно, и скажи, как называется кофейня и до скольки она открыта.', 'страница в браузере на глазах', 240000,
      async text => ({ ok: /Север/.test(text.slice(-900)) && /22/.test(text.slice(-900)) && !$('artifactPanel').hidden, detail: 'панель открыта: ' + !$('artifactPanel').hidden }))

    // Остановка: просим длинное и нажимаем «стоп».
    {
      const started = Date.now()
      $('newChatBtn')?.click()
      await wait(500)
      $('composerTextarea').value = 'Напиши подробный рассказ на тысячу слов про путешествие на поезде.'
      $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
      $('composerForm').requestSubmit()
      const running = await until(() => busy(), 30000)
      await wait(4000)
      document.querySelector('.btn-send.is-stop')?.click()
      const stopped = await until(() => !busy(), 30000)
      steps.push({ name: 'остановка хода', ok: running && stopped, ms: Date.now() - started, finished: stopped, detail: 'шёл: ' + running + ', остановился: ' + stopped, tail: '' })
    }

    return { model: ${JSON.stringify(modelId)}, steps, approvals, errors, checklistsInFeed: document.querySelectorAll('#messagesList .plan-inline').length }
  })()`)

  const resultFile = path.join(out, 'result.json')
  // ONECODE_APP — путь к app.asar установленной копии: прогон идёт на собранном коде, а не на исходниках.
  // Сам onlyone.exe для этого не годится: в собранном приложении тестовые перехватчики выключены (app.isPackaged).
  const appPath = process.env.ONECODE_APP
  const child = spawn(electronBinary(), [appPath || '.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: appPath ? out : root, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1' })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 1500000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  server.close()
  const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { error: 'окно не отчиталось' }
  const hello = path.join(workspace, 'hello.txt')
  report.helloOnDisk = fs.existsSync(hello) ? fs.readFileSync(hello, 'utf8').slice(0, 80) : null
  report.dir = out
  return report
}

;(async () => {
  for (const model of models) {
    console.log('\n=== ' + model + ' ===')
    const report = await one(model)
    if (report.error) { console.log('ОШИБКА: ' + report.error); continue }
    for (const step of report.steps) console.log((step.ok ? '  ok  ' : 'ПРОВАЛ ') + step.name + ' — ' + Math.round(step.ms / 1000) + ' с' + (step.ok ? '' : ' — ' + step.detail + (step.finished ? '' : ' (не закончил вовремя)') + (step.tail ? ' | …' + step.tail : '')))
    console.log((report.helloOnDisk && /привет из теста/i.test(report.helloOnDisk) ? '  ok  ' : 'ПРОВАЛ ') + 'файл hello.txt на диске: ' + JSON.stringify(report.helloOnDisk))
    console.log('  разрешений нажато: ' + report.approvals + ', чек-листов в ленте: ' + report.checklistsInFeed + ', ошибок окна: ' + report.errors.length + (report.errors.length ? ' — ' + report.errors.slice(0, 2).join(' | ') : ''))
    console.log('  папка: ' + report.dir)
  }
})().catch(error => { console.error(error); process.exit(1) })
