// Слежение за вкладкой по просьбе в чате — настоящее окно, webview и локальный сервер, без единой кнопки.
//
// Человек пишет в чате: «следи за таймером, когда будет ГОТОВО — запиши result.txt». «Модель»
// (сценарный провайдер) вызывает watch_page и заканчивает ход; слежение висит фоновой задачей чата
// («Задачи»). Пока таймер тикает, чат молчит; страница показала ГОТОВО — в тот же чат САМО приходит
// сообщение (было / стало, поручение, снимок), модель пишет result.txt. Остановка — из панели «Задачи».
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-tab-watch')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })

const PAGE = '<!doctype html><title>Таймер</title><h1 id="t">Осталось 5</h1>' +
  '<script>var n=5;var h=setInterval(function(){n--;document.getElementById("t").textContent=n>0?"Осталось "+n:"ГОТОВО";if(n<=0)clearInterval(h)},1000)</script>'
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(PAGE)
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
      turn('Ставлю слежение за таймером.', [{ name: 'watch_page', args: { url: 'http://127.0.0.1:' + port + '/', wake_on: 'text_appears', text: 'ГОТОВО', then: 'Запиши result.txt с текстом страницы и скажи, что записал.', min_seconds: 3 } }]),
      turn('Слежу за страницей: как только появится ГОТОВО, запишу result.txt.', []),
      // Между ходами провайдеру приходят ещё служебные запросы (название чата, подсказки) — они берут свои ответы по очереди.
      turn('Слежение за таймером', []),
      turn('Ещё не нужно', []),
      turn('Ещё не нужно', []),
      // Приёмка теперь спрашивает ещё и модель, что работала, если другой судья не дал внятного вердикта: ещё один служебный ответ.
      turn('Ещё не нужно', []),
      turn('Таймер дошёл до конца — записываю результат.', [{ name: 'write_file', args: { path: 'result.txt', content: 'ГОТОВО: таймер закончился\n' } }]),
      turn('Записал result.txt и снял страницу.', [])
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
    const pageText = async () => { try { return await view().executeJavaScript('document.body.innerText') } catch { return '' } }

    async function run() {
      if (!await until(() => document.documentElement.dataset.appReady === '1')) { note('окно не поднялось', false); return }
      if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
      await wait(400)
      $('newChatBtn')?.click()
      await wait(400)
      // Человек просит модель следить — словами, как обычно.
      $('composerTextarea').value = 'Следи за таймером на странице: когда появится ГОТОВО — запиши result.txt'
      $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
      $('composerForm').requestSubmit()
      const watches = () => (window.OnlyonePageWatches ? window.OnlyonePageWatches.list() : [])
      note('модель поставила слежение инструментом watch_page', await until(() => watches().length === 1, 40000), watches().length)
      note('вкладка с таймером открылась сама, без кнопок', await until(async () => /Осталось|ГОТОВО/.test(await pageText()), 20000))
      note('в интерфейсе нет лишних кнопок и окошек наблюдателя', !$('browserTabWatch') && !$('tabWatchPopover') && !$('browserWatch'))
      note('вкладка помечена как наблюдаемая', Boolean(document.querySelector('.browser-tab.is-watched')))

      // Слежение — фоновая задача чата: видна в «Задачи», счётчик на кнопке.
      await until(() => !document.querySelector('.btn-send.is-stop'), 30000)
      $('navTasks').click()
      await wait(500)
      const panelText = ((document.getElementById('tasksPanel') || {}).textContent || '').replace(/\\s+/g, ' ')
      note('в «Задачи» есть слежение за страницей этого чата', /Слежение за страницами/.test(panelText) && /127\\.0\\.0\\.1/.test(panelText) && /ГОТОВО/.test(panelText), panelText.slice(0, 200))
      note('у кнопки «Задачи» счётчик слежений', Number(($('taskCenterBadge') || {}).textContent) >= 1, ($('taskCenterBadge') || {}).textContent)

      // Страница дошла до ГОТОВО — сообщение приходит само.
      note('когда появилось «ГОТОВО», сообщение пришло в чат само', await until(() => /сообщение слежения за страницей/.test(feed()), 30000), feed().slice(-200))
      note('в сообщении: адрес, «Стало: … ГОТОВО», условие и поручение модели самой себе',
        /127\\.0\\.0\\.1/.test(feed()) && /Стало: [^.]*ГОТОВО/.test(feed()) && /Условие: ГОТОВО/.test(feed()) && /Запиши result\\.txt с текстом страницы/.test(feed()), '')
      note('снимок сохранён в проекте и назван в сообщении', /onlyone-screens\\/page-/.test(feed()), '')
      note('модель выполнила поручение и отчиталась', await until(() => /Записал result\\.txt и снял страницу/.test(feed()), 60000), feed().slice(-160))
      note('сообщение было одно (повторов нет)', (feed().match(/сообщение слежения за страницей/g) || []).length === 1, (feed().match(/сообщение слежения за страницей/g) || []).length)

      // Остановка — из панели «Задачи».
      // Панель могла перерисоваться из-за поздних событий хода: нажимаем, пока слежение не снимется.
      for (let attempt = 0; attempt < 6 && watches().length; attempt++) { document.querySelector('[data-watch-stop]')?.click(); await wait(400) }
      note('остановка из «Задачи» снимает слежение и метку вкладки', watches().length === 0 && !document.querySelector('.browser-tab.is-watched'))
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
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_PROVIDER_LOG: path.join(out, "provider.log"), ONECODE_SHOT: path.join(out, 'tab-watch.png') })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 240000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  server.close()
  if (process.env.SHOW_PROVIDER_LOG && fs.existsSync(path.join(out, 'provider.log'))) console.log('запросы к провайдеру:', fs.readFileSync(path.join(out, 'provider.log'), 'utf8').trim().split(String.fromCharCode(10)).join(' | '))
  let ok = false
  if (!fs.existsSync(resultFile)) {
    console.error('Окно не отчиталось')
  } else {
    const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    for (const item of report.checks || []) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    // Файлы проекта — на диске: результат модели и снимок страницы.
    const resultText = fs.existsSync(path.join(workspace, 'result.txt')) ? fs.readFileSync(path.join(workspace, 'result.txt'), 'utf8') : ''
    const shots = fs.existsSync(path.join(workspace, 'onlyone-screens')) ? fs.readdirSync(path.join(workspace, 'onlyone-screens')).filter(name => name.endsWith('.png')) : []
    const shotOk = shots.length > 0 && fs.statSync(path.join(workspace, 'onlyone-screens', shots[0])).size > 1000
    console.log((resultText.includes('ГОТОВО') ? '  ok  ' : 'ПРОВАЛ ') + 'result.txt записан моделью на диск — ' + JSON.stringify(resultText.trim()))
    console.log((shotOk ? '  ok  ' : 'ПРОВАЛ ') + 'снимок страницы — настоящий PNG в onlyone-screens/ — ' + shots.join(','))
    ok = Boolean(report.ok) && resultText.includes('ГОТОВО') && shotOk
  }
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}
main().catch(error => { console.error(error); server.close(); process.exit(1) })
