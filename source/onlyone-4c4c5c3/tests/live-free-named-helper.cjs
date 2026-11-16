// ЖИВАЯ проверка сценария владельца на бесплатных моделях (вручную, не в общем прогоне): ведущий — выбранная в переключателе
// модель, в просьбе названа другая («agent inception/mercury-decide:free») и велено открыть браузер на глазах и проверять
// страницу каждые 5 минут. Смотрим: появился ли Агент 2 на названной модели (и нет ли других помощников), открылась ли панель
// «Браузер» со страницей, поставлено ли слежение с min_seconds=300, не появились ли чек-листы в ленте.
//
// Ключ берётся из профиля владельца (копия настроек и Local State во временную папку). Допускаются ТОЛЬКО модели :free.
// Использование:  node tests/live-free-named-helper.cjs <ведущий:free> <помощник:free>
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const [lead, helper] = process.argv.slice(2)
if (!lead || !helper || !/:free$/.test(lead) || !/:free$/.test(helper)) {
  console.error('Нужны две бесплатные модели: node tests/live-free-named-helper.cjs nvidia/nemotron-3-ultra-550b-a55b:free inception/mercury-decide:free')
  process.exit(2)
}
const home = path.join(process.env.APPDATA || '', '1code')

async function main () {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-live-helper-'))
  const workspace = path.join(out, 'workspace')
  const profile = path.join(out, 'profile')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(profile, { recursive: true })
  const settings = JSON.parse(fs.readFileSync(path.join(home, '1code-settings.json'), 'utf8'))
  settings.defaultModel = lead
  settings.workspace = { path: workspace, permission: 'acceptEdits' }
  settings.projects = []
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify(settings))
  fs.copyFileSync(path.join(home, 'Local State'), path.join(profile, 'Local State'))

  let hits = 0
  const server = http.createServer((request, response) => {
    hits++
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><title>BTC 5m</title><h1 id="p">Цена: 85700</h1><script>var n=85700;setInterval(function(){n+=Math.round(Math.random()*20-10);document.getElementById("p").textContent="Цена: "+n},2000)</script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const prompt = `Your task with agent ${helper} is to monitor the 5-minute chart on http://127.0.0.1:${port}/. Every 5 minutes, wake up, take a screenshot, log your observations, and save them to the designated chat folder. Only 2 agent you and ${helper}. Use the decision helper to judge, after each observation, whether the move is notable. Do not make predictions yet; just collect the data. Open the browser inside this environment to execute so I can see it. Reply in Russian.`

  const script = path.join(out, 'renderer.js')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(500) } return false }
    const feed = () => ((document.getElementById('messagesList') || {}).textContent || '').replace(/\\s+/g, ' ')
    const result = { lead: ${JSON.stringify(lead)}, helper: ${JSON.stringify(helper)}, notes: [] }
    try {
      if (!await until(() => document.documentElement.dataset.appReady === '1', 30000)) { result.notes.push('окно не поднялось'); return result }
      if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
      await wait(500)
      $('newChatBtn')?.click()
      await wait(500)
      $('composerTextarea').value = ${JSON.stringify(prompt)}
      $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
      $('composerForm').requestSubmit()
      result.helperAnnounced = await until(() => /помощникw* по решениям/i.test(feed()), 60000)
      result.browserOpened = await until(() => !$('artifactPanel').hidden && Boolean(document.querySelector('#browserViews webview')), 240000)
      // Если всё же спросили разрешение — человека изображает тест, но фиксируем, что спросили.
      result.approvalsAsked = 0
      const approver = setInterval(() => { const b = document.querySelector('.approval-allow:not(:disabled)'); if (b) { result.approvalsAsked++; b.click() } }, 1000)
      const watches = () => (window.OnlyonePageWatches ? window.OnlyonePageWatches.list() : [])
      result.watchSet = await until(() => watches().length > 0, 240000)
      result.watch = watches().map(w => ({ url: w.url, gap: w.minSeconds || w.gapSeconds || w.gap || null }))
      await until(() => !document.querySelector('.btn-send.is-stop'), 240000)
      clearInterval(approver)
      result.stopped = !document.querySelector('.btn-send.is-stop')
      result.checklistsInFeed = document.querySelectorAll('#messagesList .plan-inline').length
      result.agents = [...new Set((feed().match(/Агент \\d/g) || []))]
      result.tail = feed().slice(-700)
      result.shotDir = null
    } catch (error) { result.notes.push(String((error && error.stack) || error).slice(0, 300)) }
    return result
  })()`)

  const resultFile = path.join(out, 'result.json')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_SHOT: path.join(out, 'live.png') })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 900000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  server.close()
  console.log('Страница запрашивалась раз: ' + hits)
  if (fs.existsSync(resultFile)) console.log(JSON.stringify(JSON.parse(fs.readFileSync(resultFile, 'utf8')), null, 2))
  else console.log('Окно не отчиталось')
  console.log('Папка прогона: ' + out)
}
main().catch(error => { console.error(error); process.exit(1) })
