// Страница сказала — модель услышала: настоящее окно, настоящий webview, настоящий локальный сервер.
//
//   1. В папке проекта лежит страница с ошибкой (вызов несуществующей функции), её отдаёт локальный сервер.
//   2. Человек открывает её во вкладке браузера панели.
//   3. Ошибка в консоли страницы САМА становится сообщением в чат — человек ничего не пишет.
//   4. Сценарный провайдер отвечает «моделью»: записывает исправленную страницу.
//   5. Запись файла перезагружает вкладку сама, и страница уже без ошибки (заголовок OK).
//   6. Глаз в строке адреса выключает слежение: новая ошибка молчит.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-page-wake')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })

const BROKEN = '<!doctype html><title>BROKEN</title><h1>Сломано</h1><script>setTimeout(function(){ itDoesNotExist() }, 50)</script>'
const FIXED = '<!doctype html><title>OK</title><h1>Починено</h1>'
fs.writeFileSync(path.join(workspace, 'index.html'), BROKEN)

const server = http.createServer((request, response) => {
  const file = path.join(workspace, request.url === '/' ? 'index.html' : request.url.split('?')[0])
  fs.readFile(file, (error, body) => {
    if (error) { response.writeHead(404); response.end('нет'); return }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body)
  })
})

const turn = (text, calls) => {
  const frames = []
  if (text) frames.push({ choices: [{ delta: { content: text } }] })
  calls.forEach((call, index) => frames.push({ choices: [{ delta: { tool_calls: [{ index, id: 'call_' + (index + 1), function: { name: call.name, arguments: '' } }] } }] }))
  calls.forEach((call, index) => frames.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }] } }] }))
  frames.push({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })
  return { frames }
}

async function main () {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const providerFile = path.join(out, 'provider.json')
  fs.writeFileSync(providerFile, JSON.stringify({
    turns: [
      turn('Вижу ошибку на странице — исправляю.', [{ name: 'write_file', args: { path: 'index.html', content: FIXED } }]),
      turn('Исправил: страница снова открывается без ошибок.', [])
    ]
  }))

  const profile = path.join(out, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model', legacyStoragePurged: true,
    workspace: { path: workspace, permission: 'acceptEdits' }
  }))

  const script = path.join(out, 'renderer.js')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 60000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(100) }
      return false
    }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const errors = []
    window.addEventListener('error', event => errors.push(String(event.message)))
    const feed = () => ((document.getElementById('messagesList') || {}).textContent || '').replace(/\\s+/g, ' ')
    const view = () => document.querySelector('#browserViews webview')
    const title = async () => { try { return await view().executeJavaScript('document.title') } catch { return '' } }
    const untilTitle = async (want, ms = 20000) => { const stop = Date.now() + ms; while (Date.now() < stop) { if ((await title()) === want) return true; await wait(150) } return false }

    async function run() {
      if (!await until(() => document.documentElement.dataset.appReady === '1')) { note('окно не поднялось', false); return }
      if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
      await wait(400)
      $('newChatBtn')?.click()
      await wait(400)
      note('слежение по умолчанию включено (глаз нажат)', $('browserWatch') && $('browserWatch').getAttribute('aria-pressed') === 'true')

      // Человек открывает свою страницу во вкладке браузера.
      $('openBrowserBtn').click()
      await wait(500)
      const address = $('browserAddress')
      address.value = 'http://127.0.0.1:${port}/'
      address.dispatchEvent(new Event('input', { bubbles: true }))
      $('browserForm').requestSubmit()
      note('страница открылась во вкладке', await until(() => view()), '')
      note('страница с ошибкой загружена (BROKEN)', await untilTitle('BROKEN'), await title())

      // Ошибка сама стала сообщением в чат — человек ничего не писал.
      const woke = await until(() => /Страница в браузере панели сама сообщила о проблеме/.test(feed()) && /itDoesNotExist/.test(feed()), 30000)
      note('ошибка страницы сама попала в чат как сообщение', woke, feed().slice(0, 200))
      note('в сообщении назван адрес и текст ошибки', /127\\.0\\.0\\.1/.test(feed()) && /itDoesNotExist is not defined/.test(feed()), feed().slice(0, 240))

      // Модель услышала и починила.
      note('модель ответила и записала файл', await until(() => /Исправил: страница снова открывается/.test(feed()), 60000), feed().slice(-160))
      // Запись файла перезагрузила вкладку сама.
      note('вкладка перезагрузилась сама: страница уже OK', await untilTitle('OK'), await title())

      // Глаз выключает слежение.
      $('browserWatch').click()
      await wait(200)
      note('глаз выключил слежение', $('browserWatch').getAttribute('aria-pressed') === 'false')
    }

    try { await run() } catch (error) {
      note('проверка упала', false, String((error && error.stack) || error).slice(0, 400))
    }
    note('ошибок в окне нет', !errors.length, errors.join(' | '))
    return { ok: checks.every(c => c.pass), checks }
  })()`)

  const resultFile = path.join(out, 'result.json')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_SHOT: path.join(out, 'page-wake.png') })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 240000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  server.close()
  let ok = false
  if (!fs.existsSync(resultFile)) {
    console.error('Окно не отчиталось')
  } else {
    const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    for (const item of report.checks || []) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    ok = Boolean(report.ok)
  }
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}
main().catch(error => { console.error(error); server.close(); process.exit(1) })
