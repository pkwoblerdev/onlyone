// run-agent-browser-ui.cjs — оконный прогон живого вида браузера агента на
// ЛОКАЛЬНОЙ заглушке (план, 3.6б, вариант 2: `browse_page` уважает то, что
// разрешил человек). КРАСНЫЕ проверки: продуктового кода ещё нет, и прогон обязан
// краснеть по отсутствию поведения, а не разваливаться на старте.
//
// Кадров семь, каждый — отдельный запуск окна на одном временном профиле:
// `main.js` делает один снимок на прогон, а состояние надо поймать в тот миг,
// когда оно живое («разрешили и идёт» и «кадр страницы» длятся секунды, «остановлено»
// вообще наступает по нажатию человека).
//
//   granted-ru  «разрешили и идёт»  — спрос, разрешение, живой вид с адресом
//   frame-ru    «кадр страницы»     — настоящий кадр по agent-browser-shot://
//   refused-ru  «отказ человека»    — честный отказ, окно и чат живы, карточка не зависла
//   stopped-ru  «остановлено»       — «Остановить» в живом виде, ход не прерван
//   redirect-ru находка Н87         — редирект на второй локальный адрес не мимо спроса
//   frame-en, refused-en — те же состояния по-английски
//
// Настоящей сети нет: страница живёт на `127.0.0.1` со случайным портом в этом же
// процессе, ход ведёт тестовый провайдер из файла-сценария (`ONECODE_PROVIDER_FILE`,
// шов плана 2c), ключ в профиле — фиктивный, вызова модели не происходит ни на
// шаг. Один инструмент на один ход дырой в проверке был бы потому, что страница
// живёт ровно до конца хода: действия идут тем же настоящим циклом, в котором
// `browse_page` её открыл.
//
// ПУТЬ каталога доказательств передают в форме `D:/…`, а не `/d/…`: с unix-путём
// копирование молча не происходит.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-agent-browser-ui')
const profile = path.join(out, 'profile')
const evidence = process.env.ONECODE_EVIDENCE_DIR
const RENDERER = 'agent-browser-renderer.js'

const MARKER = 'МИШЕНА36Б'
// Метка — данные страницы, а не подпись окна: на английском кадре она
// латиницей, иначе проверка «в окне нет кириллицы» спотыкается о само слово.
const markerOf = lang => (lang === 'en' ? 'TARGET36B' : MARKER)
// Тот самый секрет: если движок введёт его в поле пароля, он появится на самой
// странице (заглушка зеркалит ввод в кнопку) — и попадёт в кадр и в список
// элементов. Проверка ищет это слово везде, где его быть не должно.
const SECRET = 'СОВЕРШЕННО-СЕКРЕТНО-TEST-731'
const WORKSPACE = path.join(out, 'workspace')
fs.mkdirSync(WORKSPACE, { recursive: true })

// Профиль: ключ нужен самим фактом непустого пула, иначе ход останавливается до
// цикла. Ответы берёт файл-сценарий, обращения к провайдеру не происходит.
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model',
  legacyStoragePurged: true,
  workspace: { path: WORKSPACE, permission: 'acceptEdits' }
}))

// --- локальные заглушки --------------------------------------------------------

// Страница-заглушка говорит на двух языках: кадры `*-en` проверяют, что живой
// вид подписывает свои строки по-английски. Содержимое страницы — данные, а не
// интерфейс окна, поэтому для английского кадра и страница английская: иначе
// «ни одной русской строки» проверялось бы на подставном тексте.
const LABELS = {
  ru: {
    ask: 'Открой страницу из оконного прогона и посмотри её',
    title: 'Кадр страницы', heading: 'Проверка живого вида',
    press: 'Нажать кнопку', pressed: 'Кнопка нажата',
    note: 'Поле для текста', typed: 'Введённый текст', echo: 'Эхо:',
    password: 'Поле пароля', echoSecret: 'Эхо пароля:',
    denied: 'ЗАПРЕЩЁННАЯ-СТРАНИЦА', deniedNote: 'Сюда агенту нельзя.',
    open: 'Открываю страницу.', click: 'Кликаю.', type: 'Ввожу текст.',
    secret: 'Пробую поле пароля.', shot: 'Снимаю кадр.', taken: 'Кадр снят.',
    refused: 'Отказ приняли, страницы нет.', redirected: 'Переход закончился.',
    running: 'Ход ещё идёт.', done: 'Ход окончен.',
    size: 'пикселов', bytes: 'байт',
    refusal: 'отказ|отклон|не разреш|запрещ|отмен',
    secretWords: 'секрет|парол|токен|ключ'
  },
  en: {
    ask: 'Open the page from the window run and look at it',
    title: 'Agent page frame', heading: 'Live view check',
    press: 'Press the button', pressed: 'Button pressed',
    note: 'Text field', typed: 'Typed text', echo: 'Echo:',
    password: 'Password field', echoSecret: 'Password echo:',
    denied: 'FORBIDDEN-PAGE', deniedNote: 'The agent may not come here.',
    open: 'Opening the page.', click: 'Clicking.', type: 'Typing.',
    secret: 'Trying the password field.', shot: 'Taking the frame.',
    taken: 'Frame taken.', refused: 'Refused, there is no page.',
    redirected: 'The redirect finished.', running: 'The turn is still running.',
    done: 'Turn finished.',
    size: 'pixels', bytes: 'bytes',
    refusal: 'refus|denied|not allowed|blocked|cancel',
    secretWords: 'secret|password|token|key'
  }
}

const pageHtml = lang => {
  const L = LABELS[lang]
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${L.title} ${markerOf(lang)}</title></head>
<body>
  <h1>${L.heading} ${markerOf(lang)}</h1>
  <button id="press" type="button">${L.press} ${markerOf(lang)}</button>
  <label>${L.note} <input type="text" name="note" placeholder="${L.note}"></label>
  <label>${L.password} <input type="password" name="secret" placeholder="${L.password}"></label>
  <script>
    // Кнопка и поле оставляют на странице заметный след: по нему видно, что
    // действие случилось с THIS живым документом, а не с его копией.
    document.getElementById('press').addEventListener('click', function () {
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = '${L.pressed} ${markerOf(lang)}'
      document.body.appendChild(b)
    })
    var noteField = document.querySelector('input[name="note"]')
    noteField.addEventListener('input', function () {
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = '${L.echo} ' + noteField.value
      document.body.appendChild(b)
    })
    document.querySelector('input[name="secret"]').addEventListener('input', function (e) {
      var b = document.createElement('button')
      b.type = 'button'
      b.textContent = '${L.echoSecret} ' + e.target.value
      document.body.appendChild(b)
    })
  </script>
</body></html>`
}

// Вторая заглушка — «адрес, который человек не разрешал»: на него уводит
// перенаправление, и по его заголовку видно, совершился переход или нет.
const deniedHtml = lang => {
  const L = LABELS[lang]
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${L.denied} ${markerOf(lang)}</title></head>
<body><h1>${L.denied} ${markerOf(lang)}</h1><p>${L.deniedNote}</p></body></html>`
}

function listen (handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, response) => handler(req, response))
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

let mainServer = null
let deniedServer = null
let mainUrl = ''
let deniedUrl = ''

// --- сценарии хода -------------------------------------------------------------

// Шаг цикла заканчивается только ответом без вызовов инструментов, поэтому финал
// — отдельный ответ без потока. `delayMs` держит ход живым там, где состояние
// надо успеть снять (остановка, кадр).
function sequence (mode, lang, pageUrl) {
  const L = LABELS[lang]
  const browse = url => ({ toolCalls: [{ name: 'browse_page', args: { url } }], text: L.open })
  const click = { toolCalls: [{ name: 'browse_click', args: { text: `${L.press} ${markerOf(lang)}` } }], text: L.click }
  const typeText = { toolCalls: [{ name: 'browse_input', args: { text: L.note, value: L.typed } }], text: L.type }
  const typeSecret = { toolCalls: [{ name: 'browse_input', args: { text: L.password, value: SECRET } }], text: L.secret }
  const shot = { toolCalls: [{ name: 'browse_screenshot', args: {} }], text: L.shot }
  const idle = (text, delayMs = 1200) => ({ text, delayMs })

  switch (mode) {
    case 'refused':
      return [browse(pageUrl), idle(L.refused, 300)]
    case 'redirect':
      return [browse(pageUrl + '/skip'), idle(L.redirected, 300)]
    case 'granted':
      return [browse(pageUrl), click, typeText, typeSecret, shot, idle(L.taken, 2000), idle(L.done, 2000)]
    case 'frame':
      return [browse(pageUrl), click, typeText, typeSecret, shot, idle(L.taken, 3000)]
    case 'stopped': {
      // Кадр здесь раньше, чем в других режимах: состояние «остановлено» надо
      // поймать, пока ход ещё идёт. Держит ход живым шаг с вызовом инструмента
      // и своей задержкой: ответ без инструментов заканчивает цикл, и кнопка
      // «Остановить» нажималась бы уже после конца хода.
      const holdOn = { toolCalls: [{ name: 'browse_screenshot', args: {} }], text: L.running, delayMs: 3000 }
      return [browse(pageUrl), shot, click, typeText, typeSecret, holdOn, idle(L.done, 1500)]
    }
    default:
      throw new Error('неизвестный режим прогона: ' + mode)
  }
}

function providerFile (name, mode, lang, pageUrl) {
  const file = path.join(out, `provider-${name}.json`)
  fs.writeFileSync(file, JSON.stringify({ turns: sequence(mode, lang, pageUrl) }))
  return file
}

// --- запуск окна ---------------------------------------------------------------

const FRAMES = [
  { id: 'granted-ru', mode: 'granted', lang: 'ru', state: 'разрешили и идёт' },
  { id: 'frame-ru', mode: 'frame', lang: 'ru', state: 'кадр страницы' },
  { id: 'refused-ru', mode: 'refused', lang: 'ru', state: 'отказ человека' },
  { id: 'stopped-ru', mode: 'stopped', lang: 'ru', state: 'остановлено' },
  { id: 'redirect-ru', mode: 'redirect', lang: 'ru', state: 'редирект (Н87)' },
  { id: 'frame-en', mode: 'frame', lang: 'en', state: 'кадр страницы (EN)' },
  { id: 'refused-en', mode: 'refused', lang: 'en', state: 'отказ человека (EN)' }
]

// Прогон по всем кадрам стоит семи запусков окна; переменная позволяет test-only
// харнессу взять один кадр, чтобы починить сам харнесс, а не ждать семь минут.
const only = (process.env.ONECODE_AB_ONLY || '').split(',').map(name => name.trim()).filter(Boolean)
const SELECTED = only.length ? FRAMES.filter(frame => only.includes(frame.id)) : FRAMES

function launch (frame) {
  const resultFile = path.join(out, `${frame.id}.json`)
  const shot = path.join(out, `${frame.id}.png`)
  // Английский кадр открывается по своему пути: страница — данные, и подпись её
  // заголовка на русском обняла бы проверку «в окне нет русских строк».
  const pageUrl = frame.lang === 'en' ? `${mainUrl}en` : mainUrl
  // Окно запускается асинхронно. `spawnSync` остановил бы цикл ЭТОГО процесса,
  // а HTTP-заглушка страницы живёт именно в нём: окно ждало бы ответ 30 с и
  // получало «Превышен лимит времени загрузки страницы», а не настоящее
  // поведение приложения.
  return new Promise(resolve => {
    const child = spawn(electronBinary(),
      ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
        cwd: root, stdio: 'inherit',
        env: guiEnv({
          ONECODE_SMOKE: path.join(__dirname, RENDERER),
          ONECODE_SMOKE_OUT: resultFile,
          // Настоящий цикл с файлом-сценарием вместо сети: один ход обязан успеть
          // и browse_page, и действия по той же живой странице.
          ONECODE_E2E: '1',
          ONECODE_PROVIDER_FILE: providerFile(frame.id, frame.mode, frame.lang, pageUrl),
          ONECODE_SHOT: shot,
          ONECODE_ARG: Buffer.from(JSON.stringify({
            mode: frame.mode, lang: frame.lang, marker: markerOf(frame.lang), secret: SECRET,
            url: pageUrl, deniedUrl, state: frame.state, labels: LABELS[frame.lang]
          }), 'utf8').toString('base64')
        })
      })
    const killer = setTimeout(() => {
      console.error(`ПРОВАЛ ${frame.id}: окно не вернулось за 240 с — снимаю процесс`)
      child.kill('SIGKILL')
    }, 240000)
    child.on('error', error => {
      clearTimeout(killer)
      console.error(`ПРОВАЛ ${frame.id}: окно не запущено — ${error.message}`)
      resolve({ ok: false, checks: [], shot: false, started: false })
    })
    child.on('close', status => {
      clearTimeout(killer)
      if (!fs.existsSync(resultFile)) {
        console.error(`ПРОВАЛ ${frame.id}: окно не отчиталось (status ${status})`)
        return resolve({ ok: false, checks: [], shot: fs.existsSync(shot), started: false })
      }
      const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      if (report.error) console.error(`${frame.id}: окно сообщило об ошибке — ${report.error}`)
      for (const item of report.checks || []) {
        console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + `${frame.id} · ${item.name}` + (item.detail ? ` — ${String(item.detail).slice(0, 220)}` : ''))
      }
      if (evidence) {
        fs.mkdirSync(evidence, { recursive: true })
        for (const file of [shot, resultFile]) {
          if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)))
        }
      }
      const total = (report.checks || []).length
      resolve({ ok: Boolean(report.ok) && total > 0 && !report.error, checks: report.checks || [], shot: fs.existsSync(shot), started: true })
    })
  })
}

async function main () {
  mainServer = await listen((req, response) => {
    if (req.url.includes('/skip')) {
      response.writeHead(302, { location: deniedUrl })
      return response.end()
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(pageHtml(req.url.startsWith('/en') ? 'en' : 'ru'))
  })
  deniedServer = await listen((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(deniedHtml('ru'))
  })
  mainUrl = `http://127.0.0.1:${mainServer.address().port}/`
  deniedUrl = `http://127.0.0.1:${deniedServer.address().port}/`
  console.log(`заглушки: ${mainUrl} (страница), ${deniedUrl} (запрещённый адрес)`)

  // Кадр за кадром, одному за разом: окно и заглушка живут в одном цикле, а
  // два параллельных прогона делили бы один профиль.
  const results = []
  for (const frame of SELECTED) results.push([frame, await launch(frame)])
  const ok = results.every(([, one]) => one.ok)
  const shots = results.filter(([, one]) => one.shot).length
  for (const [frame, one] of results) {
    const red = (one.checks || []).filter(item => !item.pass).length
    console.log(`кадр ${frame.id} · ${frame.state}: проверок ${one.checks.length || 0}, красных ${red}, снимок ${one.shot ? 'есть' : 'НЕТ'}`)
  }
  console.log(`снимков: ${shots} из ${SELECTED.length}`)
  if (evidence) console.log(`доказательства: ${evidence}`)
  console.log(ok
    ? 'Живой вид браузера агента на разрешённом человеком адресе работает в окне'
    : 'Пункт 3.6б (вариант 2) ещё не сделан: browse_page не спрашивает человека и живого кадра в окне нет')
  mainServer.close()
  deniedServer.close()
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

main().catch(error => {
  if (mainServer) mainServer.close()
  if (deniedServer) deniedServer.close()
  console.error('ПРОВАЛ ' + ((error && error.message) || error))
  settleRun(out, false)
  process.exitCode = 1
})
