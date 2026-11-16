// Агент открывает сайт человеку (browse_page с show_to_user): в панели «Браузер», в ТЕКУЩЕЙ вкладке, без новых.
// Вторая страница заменяет первую в той же вкладке; агент читает страницу с настоящей видимой вкладки.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-agent-panel')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })

const server = http.createServer((request, response) => {
  const name = request.url.startsWith('/b') ? 'Вторая' : 'Первая'
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end('<!doctype html><title>' + name + ' страница</title><h1>' + name + ' страница агента</h1>')
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
  const base = 'http://127.0.0.1:' + port
  const providerFile = path.join(out, 'provider.json')
  fs.writeFileSync(providerFile, JSON.stringify({
    turns: [
      turn('Открываю первую страницу.', [{ name: 'browse_page', args: { url: base + '/a', show_to_user: true } }]),
      turn('Теперь вторую.', [{ name: 'browse_page', args: { url: base + '/b', show_to_user: true } }]),
      turn('Открыл обе страницы в вашем браузере.', [])
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
      while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(100) }
      return false
    }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const errors = []
    window.addEventListener('error', event => errors.push(String(event.message)))
    const feed = () => ((document.getElementById('messagesList') || {}).textContent || '').replace(/\\s+/g, ' ')
    const view = () => document.querySelector('#browserViews webview')
    const title = async () => { try { return await view().executeJavaScript('document.title') } catch { return '' } }

    async function run() {
      if (!await until(() => document.documentElement.dataset.appReady === '1')) { note('окно не поднялось', false); return }
      if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
      await wait(400)
      // Человек разрешил модели этот адрес (как при слежении): вопросов по ходу нет.
      await window.electronAPI.watchOrigin('${base}/', true)
      $('newChatBtn')?.click()
      await wait(300)
      $('composerTextarea').value = 'Открой мне две страницы по очереди в браузере'
      $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
      $('composerForm').requestSubmit()

      note('панель «Браузер» открылась сама', await until(() => !$('artifactPanel').hidden && $('artifactPanel').dataset.mode === 'browser', 30000))
      note('первая страница открылась во вкладке', await until(async () => (await title()) === 'Первая страница', 30000), await title())
      note('вторая страница заменила первую в той же вкладке', await until(async () => (await title()) === 'Вторая страница', 40000), await title())
      note('вкладка одна — новых не заводилось', document.querySelectorAll('.browser-tab').length === 1, document.querySelectorAll('.browser-tab').length)
      note('агент закончил ход и отчитался', await until(() => /Открыл обе страницы в вашем браузере/.test(feed()), 40000), feed().slice(-160))
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
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_SHOT: path.join(out, 'agent-panel.png') })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 200000)
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
