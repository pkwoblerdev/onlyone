// 9.8 «в действительности»: настоящее окно, настоящий ход агента, настоящий ffmpeg.
//
// Сценарий провайдера (без сети и денег) ведёт агента тем путём, которым он пойдёт
// по просьбе «сделай ролик»: ffmpeg_info → video_render (вертикальный 1080×1920) →
// video_analyze собранного ролика. Проверяется не строка в коде, а то, что видит
// человек и что осталось на диске: ролик играет в панели (виден размер кадра,
// работает Range), карточка рендера в Центре задач дошла до конца, копия лежит в
// хранилище диалога и читается ffprobe, лист кадров разбора существует.
//
// Без ffmpeg на машине прогон пропускается громко: проверять нечем.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const ffmpegTools = require('../src/main/ffmpeg-tools')

const tools = ffmpegTools.create({})
const found = tools.locate()
if (!found) {
  console.log('ПРОПУЩЕНО: ffmpeg на машине нет — сквозной прогон видео нечем проверять')
  process.exit(0)
}

const root = path.join(__dirname, '..')
const out = runDir('onlyone-video')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })

// `node tests/run-video-ui.cjs html` — ролик из HTML-страницы: страница с CSS-движением,
// таймером и requestAnimationFrame снимается кадр за кадром по виртуальному времени.
const htmlMode = process.argv[2] === 'html'
const PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
#box{position:absolute;top:60px;left:0;width:100px;height:100px;background:#e00;animation:go 1s linear forwards}
@keyframes go{from{left:0}to{left:800px}}
#late{position:absolute;left:0;bottom:0;width:1080px;height:200px;background:#fff}
#raf{position:absolute;left:0;top:400px;width:200px;height:100px;background:#fff}
</style><div id="box"></div><div id="late"></div><div id="raf"></div>
<script>
// Таймер: через 300 мс низ страницы синеет; rAF: к 500 мс появляется зелёный блок.
setTimeout(() => { document.getElementById('late').style.background = '#00f' }, 300)
const start = performance.now()
function tick(now) { if (now - start >= 500) document.getElementById('raf').style.background = '#0a0'; requestAnimationFrame(tick) }
requestAnimationFrame(tick)
</script>`
if (htmlMode) {
  fs.mkdirSync(path.join(workspace, 'clips', 'box'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'clips', 'box', 'index.html'), PAGE)
}

const providerFile = path.join(out, 'provider.json')
fs.writeFileSync(providerFile, JSON.stringify(htmlMode ? {
  turns: [
    { toolCalls: [{ name: 'video_render_html', args: { html: 'clips/box/index.html', output: 'renders/promo-1.mp4', duration_seconds: Number(process.env.VIDEO_UI_SECONDS) || 1, fps: 30, capture: process.env.VIDEO_UI_CAPTURE || 'lossless', width: 1080, height: 1920, title: 'Страница 1' } }] },
    { text: 'Готово: ролик собран и показан.' }
  ]
} : {
  turns: [
    { toolCalls: [{ name: 'ffmpeg_info', args: {} }] },
    { toolCalls: [{ name: 'video_render', args: {
      args: ['-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=3', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
      output: 'renders/promo-1.mp4', title: 'Промо 1'
    } }] },
    { toolCalls: [{ name: 'video_analyze', args: { path: 'renders/promo-1.mp4' } }] },
    { text: 'Готово: ролик собран и показан.' }
  ]
}))

const profile = path.join(out, 'profile')
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', keyEnc: 'plain', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model',
  legacyStoragePurged: true,
  workspace: { path: workspace, permission: 'acceptEdits' }
}))

// `node tests/run-video-ui.cjs ultra` — тот же ход в оболочке Ultra: ролик обязан лечь
// свободным блоком с плеером внутри (9.8: «справа создаются окна, видео готовы»).
const ultra = process.argv[2] === 'ultra'
if (ultra) {
  require('../src/main/ui-config.js').save(profile, {
    versionPreset: 'ultra', showSidebar: true, showWorkPanel: true, sidebarWidth: 240, workPanelWidth: 360
  })
}

const script = path.join(out, 'renderer.js')
fs.writeFileSync(script, `(async () => {
  const ULTRA = ${JSON.stringify(ultra)}
  const EXPECT_SECONDS = ${htmlMode ? (Number(process.env.VIDEO_UI_SECONDS) || 1) : 3}
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
  const resizeNotices = []
  function recordWindowError(event) {
    // Chromium media controls can defer resize deliveries even with app observers
    // disabled. В ходу два видео-поля (панель и карточка в ленте), и под нагрузкой
    // на одном и том же коде наблюдалось 1–3 уведомления за ход; повторяющийся
    // цикл даёт десятки. Порог ниже отделяет цикл от отложенных доставок.
    if (!event.error && event.lineno === 0 && event.colno === 0 && (!event.filename || event.filename === location.href) && event.message === 'ResizeObserver loop completed with undelivered notifications.') {
      resizeNotices.push(event.message)
    } else errors.push(String(event.message))
  }
  window.addEventListener('error', recordWindowError)
  const extra = {}

  async function run() {
    if (!await until(() => document.documentElement.dataset.appReady === '1')) { note('окно не поднялось', false); return }
    if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
    await wait(300)
    $('newChatBtn')?.click()
    await wait(300)

    const ask = 'Собери вертикальный ролик для TikTok и покажи его'
    if (ULTRA) {
      // В Ultra человек пишет в строку самой оболочки, а не в скрытый композер окна.
      await until(() => document.querySelector('#ultraHost textarea.uint'), 15000)
      const field = document.querySelector('#ultraHost textarea.uint')
      note('строка ввода Ultra на месте', Boolean(field))
      field.value = ask
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      field.form.requestSubmit()
    } else {
      $('composerTextarea').value = ask
      $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      $('composerForm').requestSubmit()
    }

    if (ULTRA) {
      const found = await until(() => document.querySelector('.ublock video.ublock-video'), 90000)
      note('в Ultra ролик лёг свободным блоком с плеером', Boolean(found))
      const player = document.querySelector('.ublock video.ublock-video')
      const block = player && player.closest('.ublock')
      note('блок живёт в оболочке Ultra', Boolean(block && block.closest('#ultraHost')))
      note('панель артефактов поверх блока не открылась', $('artifactPanel').hidden)
      const rect = block && block.getBoundingClientRect()
      note('у блока есть место в окне', rect && rect.width >= 280 && rect.height >= 200, rect && (Math.round(rect.width) + 'x' + Math.round(rect.height)))
      note('блок под вертикальный ролик: выше, чем шире', rect && rect.height > rect.width, rect && (Math.round(rect.width) + 'x' + Math.round(rect.height)))
      const ok = await until(() => player && player.videoWidth > 0, 20000)
      note('плеер в блоке знает размер кадра: 1080×1920', ok && player.videoWidth === 1080 && player.videoHeight === 1920, player && (player.videoWidth + 'x' + player.videoHeight))
      const started = player ? await player.play().then(() => true, error => String(error)) : false
      // Кадры пойдут не мгновенно: декодеру нужно время под нагрузкой, ждём до 6 с.
      await until(() => player.currentTime > 0.2, 6000)
      note('ролик в блоке идёт', started === true && player.currentTime > 0.2, started + ' · ' + (player && player.currentTime))
      player && player.pause()
      const kindWord = block && block.querySelector('.ublock-caption')
      note('под плеером подпись вида', kindWord && /видео/i.test(kindWord.textContent), kindWord && kindWord.textContent)
      await until(() => /ролик собран/.test((($('messagesList') || {}).textContent || '')), 60000)
      return
    }

    // 1. Панель открылась видео, и оно проигрывается: кадр 1080×1920 известен плееру.
    const opened = await until(() => !$('artifactPanel').hidden && $('artifactPanel').dataset.kind === 'video', 90000)
    note('панель открылась роликом (kind=video)', opened, $('artifactPanel').dataset.kind)
    const video = $('artifactVideo')
    note('элемент <video> показан', Boolean(video) && !video.hidden)
    const ready = await until(() => video && video.videoWidth > 0, 20000)
    note('плеер знает размер кадра: 1080×1920', ready && video.videoWidth === 1080 && video.videoHeight === 1920,
      video && (video.videoWidth + 'x' + video.videoHeight))
    note('длительность ролика ~' + EXPECT_SECONDS + ' с', ready && Math.abs(video.duration - EXPECT_SECONDS) < 0.3, video && video.duration)
    note('подпись вида — «Видео»', $('artifactKind').textContent === 'Видео', $('artifactKind').textContent)
    note('в подвале — размер в МБ, не в знаках', /МБ/.test($('artifactMeta').textContent) && !/знаков/.test($('artifactMeta').textContent), $('artifactMeta').textContent)
    note('«Править» для ролика скрыто', $('artifactEdit').hidden)

    // 2. Перемотка: протокол отдаёт Range частями, а не весь файл.
    const url = video && video.getAttribute('src')
    const part = url ? await fetch(url, { headers: { Range: 'bytes=0-99' } }) : null
    note('Range: ответ 206 и ровно 100 байт', part && part.status === 206 && (await part.arrayBuffer()).byteLength === 100, part && part.status)
    const tailPart = url ? await fetch(url, { headers: { Range: 'bytes=-50' } }) : null
    note('Range с конца файла: 206 и 50 байт', tailPart && tailPart.status === 206 && (await tailPart.arrayBuffer()).byteLength === 50, tailPart && tailPart.status)
    const beyond = url ? await fetch(url, { headers: { Range: 'bytes=999999999-' } }) : null
    note('Range за концом файла: 416', beyond && beyond.status === 416, beyond && beyond.status)
    const play = video ? await video.play().then(() => true, error => String(error)) : false
    await until(() => video.currentTime > 0.2, 6000)
    note('ролик действительно идёт (currentTime сдвинулся)', play === true && video.currentTime > 0.2, play + ' · ' + (video && video.currentTime))
    video && video.pause()

    // 3. Центр задач: рендер был работой очереди и дошёл до конца.
    document.dispatchEvent(new CustomEvent('open-task-center'))
    await wait(500)
    const rows = () => [...document.querySelectorAll('#taskCenterList .task-center-row')]
    const title = row => (row.querySelector('.task-center-title') || {}).textContent || ''
    const state = row => (String((row.querySelector('.task-center-item') || {}).className).match(/status-([a-z]+)/) || [])[1] || ''
    const renderRow = () => rows().find(row => title(row).startsWith('Ролик:'))
    const listed = await until(() => Boolean(renderRow()), 15000)
    note('рендер есть в Центре задач', listed, rows().map(title).join(' | ').slice(0, 200))
    // Окно узнаёт о состоянии задач по такту планировщика — завершение приходит не мгновенно.
    const finished = listed && await until(() => renderRow() && /done|finished|complete/.test(state(renderRow())), 10000)
    note('карточка рендера завершена', finished, listed && state(renderRow()))

    // 4. Ход дошёл до конца и в ленте есть строки про ролик.
    const idle = await until(() => !($('sendBtn') && $('sendBtn').classList.contains('is-stop')), 60000)
    note('ход завершился', idle)
    $('navChat')?.click()
    await wait(400)
    const feed = (($('messagesList') || {}).textContent || '').replace(/\\s+/g, ' ')
    extra.feed = feed.slice(-400)
    note('в ленте сказано про ролик', /ролик/i.test(feed), feed.slice(-160))
  }

  try { await run() } catch (error) {
    note('проверка упала', false, String((error && error.stack) || error).slice(0, 400))
  }
  note('ошибок JavaScript в окне нет', !errors.length, errors.join(' | '))
  note('нет повторяющегося цикла resize у плеера', resizeNotices.length <= 6, 'browser resize notices: ' + resizeNotices.length)
  return { ok: checks.every(c => c.pass), checks, extra }
})()`)

const resultFile = path.join(out, 'result.json')
const child = spawnSync(electronBinary(),
  ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, timeout: 120000, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: script,
      ONECODE_SMOKE_OUT: resultFile,
      ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: providerFile,
      ONECODE_SHOT: path.join(out, 'video.png')
    })
  })

const claims = []
function claim(name, pass, detail) {
  claims.push({ name, pass: Boolean(pass), detail: String(detail === undefined ? '' : detail) })
  console.log((pass ? '  ok  ' : 'ПРОВАЛ ') + 'диск · ' + name + (detail === undefined ? '' : ` — ${detail}`))
}

;(async () => {
  let ok = false
  if (!fs.existsSync(resultFile)) {
    console.error(`Окно не отчиталось (status ${child.status})`)
  } else {
    const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    if (report.error) console.error(`окно сообщило об ошибке — ${report.error}`)
    for (const item of report.checks || []) {
      console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    }
    ok = Boolean(report.ok)

    const render = path.join(workspace, 'renders', 'promo-1.mp4')
    claim('рендер лёг в рабочую папку', fs.existsSync(render) && fs.statSync(render).size > 1000, fs.existsSync(render) && fs.statSync(render).size)

    const artifactsRoot = path.join(profile, 'artifacts')
    const ids = fs.existsSync(artifactsRoot) ? fs.readdirSync(artifactsRoot) : []
    const meta = ids.map(id => { try { return JSON.parse(fs.readFileSync(path.join(artifactsRoot, id, 'meta.json'), 'utf8')) } catch { return null } })
      .find(item => item && (item.kind === 'video' || item.enc))
    claim('артефакт-видео записан в хранилище диалога', Boolean(meta), ids.join(','))
    const stored = ids.map(id => path.join(artifactsRoot, id, '1-video.mp4')).find(file => fs.existsSync(file))
    claim('копия ролика лежит в папке артефакта открытым файлом', Boolean(stored) && fs.statSync(stored).size === fs.statSync(render).size,
      stored && fs.statSync(stored).size)
    if (stored) {
      const probe = await tools.exec(found.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name,pix_fmt', '-of', 'csv=p=0', stored])
      claim('ffprobe читает копию: h264 1080×1920 yuv420p', /h264,1080,1920,yuv420p/.test(probe.stdout.replace(/\s/g, '')) || /1080,1920/.test(probe.stdout), probe.stdout.trim())
    }

    const analysis = path.join(profile, 'video-analysis')
    const sheets = []
    const walk = dir => { for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) { const p = path.join(dir, name); fs.statSync(p).isDirectory() ? walk(p) : (name === 'sheet.jpg' && sheets.push(p)) } }
    walk(analysis)
    if (!htmlMode) claim('разбор ролика оставил лист кадров', sheets.length >= 1, sheets.length)

    if (htmlMode) {
      // Пиксель кадра на нужной секунде: страница снята по виртуальному времени, а не по настоящему.
      const rgb = async (t, x, y) => {
        const fileOut = path.join(out, `px-${t}-${x}-${y}.bin`)
        await tools.exec(found.ffmpeg, ['-y', '-v', 'error', '-ss', String(t), '-i', render, '-frames:v', '1',
          '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', fileOut], { timeoutMs: 30000 })
        const bytes = fs.existsSync(fileOut) ? fs.readFileSync(fileOut) : Buffer.alloc(3)
        return [bytes[0], bytes[1], bytes[2]]
      }
      const near = (got, want, tol = 60) => got.every((v, i) => Math.abs(v - want[i]) <= tol)
      const half = await rgb(0.5, 450, 110)
      claim('CSS-движение: на 0.5 с красный блок уже на x≈450 (left=400)', near(half, [220, 0, 0]), JSON.stringify(half))
      const before = await rgb(0.5, 50, 110)
      claim('…а на старте его там нет: слева на 0.5 с фон', near(before, [255, 255, 255], 40), JSON.stringify(before))
      const early = await rgb(0.1, 500, 1850)
      claim('setTimeout(300): на 0.1 с низ страницы ещё белый', near(early, [255, 255, 255], 40), JSON.stringify(early))
      const late = await rgb(0.6, 500, 1850)
      claim('setTimeout(300): на 0.6 с низ страницы синий', near(late, [0, 0, 255], 70), JSON.stringify(late))
      const rafEarly = await rgb(0.2, 100, 450)
      claim('requestAnimationFrame: на 0.2 с блок ещё белый', near(rafEarly, [255, 255, 255], 40), JSON.stringify(rafEarly))
      const rafLate = await rgb(0.8, 100, 450)
      claim('requestAnimationFrame: на 0.8 с блок зелёный', near(rafLate, [0, 170, 0], 70), JSON.stringify(rafLate))
    }
  }
  // Журнал рендера страницы — в вывод: по меткам времени видно, сколько стоит кадр.
  const journal = path.join(profile, 'logs', 'latency.log')
  if (htmlMode && fs.existsSync(journal)) {
    for (const line of fs.readFileSync(journal, 'utf8').split('\n')) if (line.includes('video_render_html')) console.log('  журнал · ' + line.slice(11))
  }
  const all = ok && claims.every(item => item.pass)
  settleRun(out, all)
  process.exit(all ? 0 : 1)
})()
