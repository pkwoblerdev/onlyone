// Автоснимок страницы в ходе мысли (инициатива 7) в настоящем окне. Агент открывает локальную страницу (browse_page);
// модели с картинками второй запрос должен нести кадр страницы (image_url), модели без картинок — только текстовую
// заметку, что снимка нет. Провайдер подставной, запросы читаются из ONECODE_PROVIDER_DUMP.
//   node tests/run-autoshot-ui.cjs
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-autoshot')
const VISION = 'dots-studio/dots-3-note-preview:free'
const TEXT_ONLY = 'nvidia/nemotron-3-ultra-550b-a55b:free'

// Асинхронный запуск: пока окно живёт, этот процесс обязан отвечать на запросы страницы (spawnSync его бы заморозил).
async function launch (name, modelId, port) {
  const dir = path.join(out, name)
  const profile = path.join(dir, 'profile'); const workspace = path.join(dir, 'workspace'); const dump = path.join(dir, 'dump')
  for (const d of [profile, workspace, dump]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId, enabled: true }],
    defaultModel: modelId, legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
  }))
  const providerFile = path.join(dir, 'provider.json')
  fs.writeFileSync(providerFile, JSON.stringify({ turns: [
    { toolCalls: [{ name: 'browse_page', args: { url: 'http://127.0.0.1:' + port + '/' } }] },
    { text: 'Страница открыта: заголовок «Кофейня Север».' },
    { text: 'Подсказка' }, { text: 'Название' }
  ] }))
  const script = path.join(dir, 'renderer.js'); const result = path.join(dir, 'result.json')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 60000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(50) } return false }
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    if ($('onboarding') && !$('onboarding').hidden) $('onboarding').hidden = true
    // Выбранная модель подтягивается из настроек не мгновенно: пока на кнопке модель по умолчанию, ход ушёл бы не на ту.
    await until(() => !/GLM 5\.3/.test(($('pillModelName') || {}).textContent || ''), 20000)
    await wait(400)
    const box = $('composerTextarea')
    box.value = 'Открой страницу и посмотри на неё'; box.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(150); $('composerForm').requestSubmit()
    await until(() => $('sendBtn') && $('sendBtn').classList.contains('is-stop'), 20000)
    // Локальный адрес агент открывает только с разрешения человека: нажимаем «Разрешить», пока идёт ход.
    const stop = Date.now() + 120000
    while (Date.now() < stop && $('sendBtn').classList.contains('is-stop')) {
      const allow = [...document.querySelectorAll('button')].find(b => b.offsetParent && b.textContent.trim() === 'Разрешить')
      if (allow) allow.click()
      await wait(200)
    }
    await wait(1000)
    return { ok: true }
  })()`)
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, stdio: 'ignore',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_PROVIDER_DUMP: dump, ONECODE_SHOT: path.join(dir, 'shot.png') })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 240000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  const report = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : null
  const bodies = fs.readdirSync(dump).filter(f => /^request-\d+\.json$/.test(f)).sort().map(f => fs.readFileSync(path.join(dump, f), 'utf8'))
  return { report, bodies }
}

// Запрос хода после инструмента — тот, где уже есть ответ инструмента (название чата и подсказка идут другими запросами и в другом порядке).
const afterTool = bodies => bodies.find(body => /"role":\s*"tool"/.test(body)) || ''
const countImages = text => (text.match(/"type":\s*"image_url"/g) || []).length

;(async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><title>Кофейня Север</title><body style="font:24px sans-serif"><h1>Кофейня «Север»</h1><p>Открыто с 8 до 22.</p></body>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  let failed = 0
  const check = (name, ok, detail) => { console.log((ok ? '  ok  ' : 'ПРОВАЛ ') + name + (ok ? '' : ' — ' + detail)); if (!ok) failed++ }

  const vision = await launch('vision', VISION, port)
  check('модель с картинками: окно отчиталось', Boolean(vision.report && vision.report.ok), JSON.stringify(vision.report))
  check('модель с картинками: после browse_page в следующем запросе кадр страницы', countImages(afterTool(vision.bodies)) >= 1,
    'запросов ' + vision.bodies.length + ', картинок в запросе после инструмента ' + countImages(afterTool(vision.bodies)))
  check('модель с картинками: кадр помечен как снятый приложением', /снятый приложением/.test(afterTool(vision.bodies)), 'пометки нет')

  const text = await launch('text', TEXT_ONLY, port)
  check('модель без картинок: окно отчиталось', Boolean(text.report && text.report.ok), JSON.stringify(text.report))
  const askedModel = afterTool(text.bodies).match(/"model":\s*"([^"]+)"/)
  check('модель без картинок: запрос ушёл именно на неё', Boolean(askedModel) && askedModel[1] === TEXT_ONLY, 'модель в запросе: ' + (askedModel && askedModel[1]))
  check('модель без картинок: картинок в запросах нет', Boolean(afterTool(text.bodies)) && text.bodies.every(body => countImages(body) === 0),
    'картинок: ' + text.bodies.map(countImages).join(','))

  server.close()
  settleRun(out, failed === 0)
  console.log(JSON.stringify({ ok: failed === 0, failed }))
  process.exit(failed ? 1 : 0)
})()
