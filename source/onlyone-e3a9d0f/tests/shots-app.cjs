// Снимки приложения «как оно выглядит сейчас» (вручную, не в общем прогоне): настоящее окно, несколько состояний, каждый снимок —
// отдельный запуск со свежим профилем. Сценарный провайдер даёт настоящий ход агента без сети и денег.
// Использование:  node tests/shots-app.cjs [папка для снимков]
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv } = require('./app-launch.cjs')
const { createRelay } = require('../server/relay/relay.js')

const root = path.join(__dirname, '..')
const target = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-shots-'))
fs.mkdirSync(target, { recursive: true })

const turn = (text, calls) => {
  const frames = []
  if (text) frames.push({ choices: [{ delta: { content: text } }] })
  calls.forEach((call, index) => frames.push({ choices: [{ delta: { tool_calls: [{ index, id: 'call_' + (index + 1), function: { name: call.name, arguments: '' } }] } }] }))
  calls.forEach((call, index) => frames.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }] } }] }))
  frames.push({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })
  return { frames }
}
const PROVIDER = { turns: [
  turn('Сначала посмотрю, что лежит в папке.', [{ name: 'list_files', args: { path: '.' } }]),
  turn('Создам страницу и проверю её.', [{ name: 'write_file', args: { path: 'index.html', content: '<h1>Кофейня «Север»</h1>\n<p>Открыто с 8 до 22.</p>\n' } }]),
  turn('', [{ name: 'read_file', args: { path: 'index.html' } }]),
  turn('Готово: страница `index.html` создана.\n\n- заголовок «Кофейня «Север»»\n- время работы с 8 до 22\n\nМогу добавить карту и меню — скажите, что нужно.', []),
  turn('Название', []), turn('Подсказка', []), turn('Подсказка', [])
] }

const PRELUDE = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(150) } return false }
  const ready = async () => { await until(() => document.documentElement.dataset.appReady === '1', 30000); if ($('onboarding') && !$('onboarding').hidden) $('onboarding').querySelector('.ob-skip')?.click(); await wait(700) }
  const ask = async text => { $('composerTextarea').value = text; $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true })); $('composerForm').requestSubmit(); await wait(1500); await until(() => !document.querySelector('.btn-send.is-stop'), 60000); await wait(1200) }
`

const SCENES = [
  { name: '01-главная', body: `await ready(); $('newChatBtn')?.click(); await wait(600)` },
  { name: '02-чат-с-ходом-работы', provider: true, body: `await ready(); $('newChatBtn')?.click(); await wait(500); await ask('Сделай страницу кофейни «Север»: название и часы работы с 8 до 22.')` },
  { name: '03-выбор-модели', body: `await ready(); $('newChatBtn')?.click(); await wait(500); $('modelEffortPillBtn').click(); await wait(600)` },
  { name: '04-браузер-в-панели', page: true, body: `await ready(); $('newChatBtn')?.click(); await wait(400); $('openBrowserBtn').click(); await wait(500); const i = $('browserAddress'); i.value = '__PAGE__'; $('browserForm').requestSubmit(); await wait(3500)` },
  { name: '05-настройки-удалённое-управление', relay: true, body: `await ready(); $('openSettingsBtn').click(); await wait(400); $('tab-remote').click(); await wait(300); $('remoteEnabled').click(); await until(() => !$('remoteBody').hidden); $('remotePairBtn').click(); await until(() => /^[2-9A-Z]{5}-/.test($('remoteCode').textContent.trim())); await wait(800)` },
  { name: '06-настройки-вид-версии', body: `await ready(); $('openSettingsBtn').click(); await wait(400); $('tab-appearance').click(); await wait(600)` },
  { name: '07-ultra', body: `await ready(); const base = await window.electronAPI.getUiConfig(); await window.electronAPI.setUiConfig(Object.assign({}, base, { versionPreset: 'ultra' })); await wait(2500)` },
  { name: '08-дизайн', body: `await ready(); document.querySelector('[data-view="design"], #navDesign')?.click(); await wait(1200)` },
  { name: '09-stable-настройки-без-версий', channel: 'stable', body: `await ready(); $('openSettingsBtn').click(); await wait(400); $('tab-appearance').click(); await wait(600)` }
]

async function shoot (scene, port, relayPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-shot-'))
  const profile = path.join(dir, 'profile'); const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
  }))
  const script = path.join(dir, 'renderer.js')
  fs.writeFileSync(script, `(async () => { ${PRELUDE}\n ${scene.body.replace('__PAGE__', 'http://127.0.0.1:' + port + '/')}\n return { ok: true } })()`)
  let providerEnv = {}
  if (scene.provider) { const file = path.join(dir, 'provider.json'); fs.writeFileSync(file, JSON.stringify(PROVIDER)); providerEnv = { ONECODE_PROVIDER_FILE: file } }
  const shot = path.join(target, scene.name + '.png')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, stdio: 'ignore',
    env: guiEnv({
      ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: path.join(dir, 'r.json'), ONECODE_SHOT: shot, ONECODE_E2E: '1',
      ...providerEnv, ...(scene.relay ? { ONECODE_RELAY_URL: 'ws://127.0.0.1:' + relayPort } : {}), ...(scene.channel ? { ONECODE_CHANNEL: scene.channel } : {})
    })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 120000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  const ok = fs.existsSync(shot)
  console.log((ok ? '  ok  ' : 'ПРОВАЛ ') + scene.name + (ok ? ' → ' + shot : ''))
  return ok
}

;(async () => {
  const page = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Кофейня Север</title><body style="font-family:sans-serif;padding:24px"><h1>Кофейня «Север»</h1><p>Открыто с 8 до 22. Новая улица, 5.</p></body>')
  })
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve))
  const relay = createRelay({ pingMs: 100000 })
  const relayPort = await relay.listen(0)
  for (const scene of SCENES) await shoot(scene, page.address().port, relayPort)
  page.close(); await relay.close()
  console.log('Папка снимков: ' + target)
  process.exit(0)
})()
