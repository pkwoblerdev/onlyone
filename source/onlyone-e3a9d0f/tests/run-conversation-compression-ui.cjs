'use strict'
// Сжатие длинного разговора в настоящем окне (план, 3.9; поручение 29.09 10:45).
//
// Тест до кода просили на подставной модели — здесь она и есть: ход идёт через
// настоящий `send-message` и настоящий цикл агента, а отвечает файл-сценарий
// (`ONECODE_PROVIDER_FILE`). Внешней сети и настоящих ключей нет.
//
// Что доказывается: у предела окна середина разговора сворачивается сводкой,
// которую написала модель; в ленте появляется одна строка «Разговор сжат: …» с
// раскрытием; исходные сообщения остаются и в ленте, и на диске; на следующем
// ходу и после перезапуска сводка переиспользуется, а не создаётся заново.
//
// Отрицательный контроль встроен в саму схему сценария: первый запрос хода —
// просьба о сводке, и она забирает нулевойTurn. Если бы сжатие не сработало,
// ответом хода стался бы текст сводки, и ожидаемая фраза в ленте не появилась
// бы. После перезапуска сценарий даёт нулевым ходом сразу ответ: если бы окно
// снова попросило сводку, ответа бы не было.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-conversation-compression')
const evidence = process.env.ONECODE_EVIDENCE_DIR
  || path.join(root, 'audits', 'qoder-2-2026-09-29', 'conversation-compression')
const profile = path.join(out, 'profile')
const profileEn = path.join(out, 'profile-en')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(profile, { recursive: true })

const CHAT_TITLE = 'Длинный разговор'
const SEED_MESSAGES = 20
const MESSAGE_CHARS = 3000
// Просьба о сводке — отдельный запрос модели, и он стоит нулевым в сценарии.
const SUMMARY_TEXT = 'СВОДКА: человек просил разобрать отчёт, требования собраны, два раздела готовы.'
const ANSWER_ONE = 'Первый ответ после сжатия.'
const ANSWER_TWO = 'Второй ответ: сводка та же.'
const ANSWER_RESTART = 'Ответ после перезапуска окна.'
// Английское окно: подписи окна обязаны перевестись, сводка — текст модели.
const SUMMARY_EN = 'SUMMARY: the user asked to review the report; requirements collected, two sections done.'
const ANSWER_EN = 'English answer after compression.'

// Модель в профиле — самая короткоконтекстная из встроенного каталога
// (`z-ai/glm-5.2:free`, 256 000): с незнакомым id окно берёт первую модель
// списка, а у неё контекст 1,3 млн — сжатие наступило бы только на мегабайтном
// разговоре. Потолок ответа поднимается выше её контекста, и `modelBudget`
// падает на свою нижнюю границу в 8000 условных токенов: 20 сообщений по три
// тысячи символов — это ~19 000. Так предел окна наступает на глазах.
const SMALL_MODEL = 'z-ai/glm-5.2:free'
function writeSettings(dir, language) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '1code-settings.json'), JSON.stringify({
    language,
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: SMALL_MODEL, enabled: true }],
    defaultModel: SMALL_MODEL,
    activeProvider: 'openrouter',
    legacyStoragePurged: true,
    workspace: { path: workspace, permission: 'acceptEdits' }
  }))
  return dir
}
writeSettings(profile, 'ru')

// Бюджет окна = контекст минус запрошенный ответ минус 5 %. 250 000 > 256 000 −
// 12 800, поэтому остаётся нижняя граница `modelBudget` — 8000 токенов.
const SMALL_BUDGET_ENV = { ONECODE_ANSWER_TOKENS: '250000' }

function providerFile(name, turns) {
  const file = path.join(out, `provider-${name}.json`)
  fs.writeFileSync(file, JSON.stringify({ turns }))
  return file
}

function requestsOf(name) {
  const file = path.join(out, `requests-${name}.log`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(line => line.trim().split(/\s+/).slice(1).map(Number))
}

const notes = []
function claim(name, pass, detail) {
  notes.push({ name, pass: Boolean(pass), detail: String(detail === undefined ? '' : detail) })
  console.log((pass ? '  ok  ' : 'ПРОВАЛ ') + 'диск · ' + name + (detail ? ` — ${detail}` : ''))
}

function launch(name, body, opts = {}) {
  const dir = opts.profileDir || profile
  const script = path.join(out, `${name}.js`)
  const resultFile = path.join(out, `${name}.json`)
  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile)
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 90000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) { try { if (fn()) return true } catch {}; await wait(120) }
      return false
    }
    const checks = []
    const note = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const errors = []
    window.addEventListener('error', e => errors.push(String(e.message).slice(0, 160)))
    window.addEventListener('unhandledrejection', e => errors.push('promise: ' + String(e.reason?.message || e.reason).slice(0, 160)))
    await until(() => document.documentElement.dataset.appReady === '1')
    await wait(600)
    // Меряется textContent, а не innerText: лента длинного разговора закрыта
    // content-visibility: auto (index.css), и у скрытых прокруткой строк
    // innerText возвращает пустоту — проверка ответа ловила бы собственную
    // мерку, а не текст.
    const feed = () => $('messagesList').textContent.replace(/\\s+/g, ' ')
    const bubbles = () => document.querySelectorAll('#messagesList .msg-item').length
    const line = () => document.querySelector('#messagesList .chat-compressed')
    const lineText = () => (line()?.querySelector('summary')?.textContent || '').replace(/\\s+/g, ' ').trim()
    const lineBody = () => (line()?.querySelector('.chat-compressed-body')?.textContent || '').replace(/\\s+/g, ' ').trim()
    // Разговор открывается нажатием в списке, а не вызовом моста: только так
    // проверяется то, что человек действительно увидит.
    const openChat = async () => {
      const row = [...document.querySelectorAll('.history-item')]
        .find(one => (one.textContent || '').includes('${CHAT_TITLE}'))
      row?.querySelector('.history-item-title')?.click()
      return await until(() => bubbles() > 0, 20000)
    }
    // Ход ждём по тексту ответа, а не по кнопке: на подставной модели ход
    // успевает кончиться между двумя проверками состояния, и тогда мерка
    // снималась бы на пустом месте.
    const ask = async (text, expected) => {
      const box = $('composerTextarea')
      box.value = text
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(200)
      $('composerForm').requestSubmit()
      const busy = () => $('sendBtn')?.classList.contains('is-stop')
      const said = await until(() => feed().includes(expected), 60000)
      await wait(400)
      await until(() => !busy(), 30000)
      return said
    }
${body}
    note('ошибок в окне нет', !errors.length, errors.join(' | ') || 'нет')
    return { ok: checks.every(item => item.pass), checks }
  })()`)

  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + dir], {
    cwd: root, timeout: opts.timeout || 300000, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: script,
      ONECODE_SMOKE_OUT: resultFile,
      ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: providerFile(name, opts.turns || []),
      ONECODE_PROVIDER_LOG: path.join(out, `requests-${name}.log`),
      ONECODE_SHOT: path.join(out, `${name}.png`),
      ...SMALL_BUDGET_ENV,
      ...opts.extraEnv
    })
  })
  if (!fs.existsSync(resultFile)) {
    if (opts.expectReport === false) return { ok: true, checks: [], name }
    console.error(`ПРОВАЛ ${name}: окно не отчиталось (status ${child.status})`)
    return { ok: false, checks: [], name }
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error(`окно упало ${name}: ${report.error}`)
  for (const one of report.checks || []) {
    console.log((one.pass ? '  ok  ' : 'ПРОВАЛ ') + `${name} · ${one.label}` + (one.detail ? ` — ${one.detail.slice(0, 200)}` : ''))
  }
  report.name = name
  return report
}

// 1. Заготовка: длинный разговор ложится в зашифрованное хранилище тем же
//    каналом, что и вся переписка, и ПЕРЕЗАГРУЗКОЙ окна передаётся состоянию
//    renderer. Без перезагрузки заготовка не держится: окно не знает о чужой
//    записи и на первом же своём сохранении стирает её (проверено — после замера
//    в хранилище оставался только новый диалог). Отдельным Electron-процессом
//    конверт тоже не подделать: у него другой контекст шифрования, и приложение
//    не открывает такие байты.
//    После перезагрузки скрипт в окне умирает вместе со страницей и отчёта не
//    даёт — это ожидаемо, прогон обрывается по короткому таймауту.
const seed = launch('seed', `
  const long = []
  for (let i = 0; i < ${SEED_MESSAGES}; i++) {
    const body = ('реплика ' + i + ' — ' + (i % 2 ? 'ответ модели' : 'вопрос человека') + ': ').padEnd(${MESSAGE_CHARS}, 'х')
    long.push({ role: i % 2 ? 'assistant' : 'user', content: body, timestamp: Date.now() - (${SEED_MESSAGES} - i) * 1000 })
  }
  await window.electronAPI.setConversations([{
    id: 'chat-long', title: '${CHAT_TITLE}', messages: long,
    createdAt: Date.now() - 60000, updatedAt: Date.now() - 1000
  }])
  location.reload()
  await wait(20000)
`, { turns: [], timeout: 45000, expectReport: false })
claim('заготовка прошла (окно перечитало её после перезагрузки)', seed.ok !== false)

// 2. Ход у предела окна: середина сворачивается, строка появляется, исходные
//    сообщения остаются.
const measure = launch('measure', `
  note('длинный разговор открылся', await openChat(), 'пузырей: ' + bubbles())
  note('до хода строки о сжатии нет', !line(), lineText() || 'нет')
  const before = bubbles()
  note('первый ход принёс ответ сценария, а не текст сводки',
    await ask('Что осталось недоделанным?', '${ANSWER_ONE}'), feed().slice(-200))
  note('в ленте появилась одна строка о сжатии',
    document.querySelectorAll('#messagesList .chat-compressed').length === 1,
    'строк: ' + document.querySelectorAll('#messagesList .chat-compressed').length)
  const foldedFirst = Number((lineText().match(/(\\d+)/) || [])[1] || 0)
  note('строка называет число свёрнутых сообщений', foldedFirst >= 3, lineText())
  note('исходные сообщения никуда не делись', bubbles() >= before + 2, 'было ' + before + ', стало ' + bubbles())
  const details = line()
  if (details) details.open = true
  await wait(300)
  note('в раскрытии читается сводка модели', lineBody().includes('СВОДКА'), lineBody().slice(0, 160))
  note('второй ход принёс свой ответ',
    await ask('Продолжи по той же сводке.', '${ANSWER_TWO}'), feed().slice(-200))
  const foldedSecond = Number((lineText().match(/(\\d+)/) || [])[1] || 0)
  note('второй ход свернул не больше первого (сводка переиспользована)',
    foldedSecond === foldedFirst, 'первый: ' + foldedFirst + ', второй: ' + foldedSecond)
  // Кадр снимается в конце скрипта: чтобы на нём было видно саму строку, ленту
  // возвращаем наверх, а раскрытие оставляем открытым.
  if (details) details.open = true
  details?.scrollIntoView({ block: 'start' })
  await wait(400)
`, { turns: [
  { content: `${SUMMARY_TEXT}` },
  { text: `${ANSWER_ONE}` }, { text: `${ANSWER_ONE}` },
  { text: `${ANSWER_TWO}` }, { text: `${ANSWER_TWO}` }, { text: `${ANSWER_TWO}` }
] })

const measureRequests = requestsOf('measure')
claim('первым ход попросил сводку', measureRequests[0]?.[0] === 2,
  'сообщений в первом запросе: ' + JSON.stringify(measureRequests[0]))
claim('ответ ушёл короче разговора, но не пустой',
  measureRequests.length > 1 && measureRequests[1][0] > 2 && measureRequests[1][0] < SEED_MESSAGES,
  'сообщений во втором запросе: ' + JSON.stringify(measureRequests[1]) + ' против ' + SEED_MESSAGES +
  ' · все запросы: ' + JSON.stringify(measureRequests))

// 3. Перезапуск: запись пережила закрытие окна, и сводку никто заново не просит
//    (нулевым turn в этом прогоне лежит сразу ответ — если бы окно позвал
//    сводку, ответа бы не было).
const restart = launch('restart', `
  note('разговор открылся после перезапуска', await openChat(), 'пузырей: ' + bubbles())
  note('строка о сжатии на месте без нового хода', Boolean(line()), lineText())
  note('сводка та же, что и до перезапуска', lineBody().includes('СВОДКА'), lineBody().slice(0, 120))
  note('ход после перезапуска получил ответ, а не потратил его на сводку',
    await ask('Ответь после перезапуска.', '${ANSWER_RESTART}'), feed().slice(-200))
`, { turns: [{ text: `${ANSWER_RESTART}` }] })

const restartRequests = requestsOf('restart')
claim('после перезапуска ход действительно говорил с моделью', restartRequests.length > 0,
  'запросов: ' + restartRequests.length)
// Первый запрос после перезапуска — ответ, а не сводка: свёрнутая середина уже
// лежит на чате. Если бы окно звало сводку заново, первым шёл бы двухстрочный
// запрос (системная просьба + текст середины).
claim('после перезапуска сводку не запрашивали заново', (restartRequests[0]?.[0] || 0) > 2,
  'запросы: ' + JSON.stringify(restartRequests))

// 4. Отдельный кадр: строка сжатия с раскрытием вверху ленты. Ходов здесь нет —
//    только то, что человек увидит, открыв длинный разговор после сжатия.
launch('shot', `
  note('разговор открыт для кадра', await openChat(), 'пузырей: ' + bubbles())
  const details = line()
  if (details) details.open = true
  await wait(400)
  // Кадр снимается сразу после того, как скрипт вернул управление, поэтому
  // прокрутку ставим без анимации и несколько раз: у ленты scroll-behavior
  // smooth, и с анимацией снимок поймал бы середину разговора.
  const toTop = () => {
    const scroller = $('chatFeed')
    if (!scroller) return
    scroller.style.scrollBehavior = 'auto'
    scroller.scrollTop = 0
  }
  toTop(); await wait(200); toTop(); await wait(200); toTop()
  await wait(700)
  note('лента показана с начала, строка сжатия в кадре',
    ($('chatFeed').scrollTop || 0) < 40 && Boolean(lineText()),
    'scrollTop ' + $('chatFeed').scrollTop + ' · scrollHeight ' + $('chatFeed').scrollHeight + ' · ' + lineText())
  toTop()
`, { turns: [] })

// ─── английское окно: та же мера, другие подписи ─────────────────────────────
// Название диалога остаётся русским: это данные человека, а не подпись окна
// (язык таких строк — 2.6б). Проверяется ровно то, что рисует вкладка.
writeSettings(profileEn, 'en')
launch('seed-en', `
  const long = []
  for (let i = 0; i < ${SEED_MESSAGES}; i++) {
    const body = ('turn ' + i + ' — ' + (i % 2 ? 'model answer' : 'user question') + ': ').padEnd(${MESSAGE_CHARS}, 'x')
    long.push({ role: i % 2 ? 'assistant' : 'user', content: body, timestamp: Date.now() - (${SEED_MESSAGES} - i) * 1000 })
  }
  await window.electronAPI.setConversations([{
    id: 'chat-long', title: '${CHAT_TITLE}', messages: long,
    createdAt: Date.now() - 60000, updatedAt: Date.now() - 1000
  }])
  location.reload()
  await wait(20000)
`, { turns: [], timeout: 45000, expectReport: false, profileDir: profileEn })

launch('measure-en', `
  note('английский разговор открылся', await openChat(), 'пузырей: ' + bubbles())
  note('ход принёс ответ сценария', await ask('What is still open?', '${ANSWER_EN}'), feed().slice(-160))
  note('строка сжатия переведена', /Conversation compressed: \\d+/.test(lineText()), lineText())
  note('в подписи строки нет ни одной кириллической буквы', !/[А-Яа-яЁё]/.test(lineText()), lineText())
  const details = line()
  if (details) details.open = true
  await wait(400)
  const toTop = () => {
    const scroller = $('chatFeed')
    if (!scroller) return
    scroller.style.scrollBehavior = 'auto'
    scroller.scrollTop = 0
  }
  toTop(); await wait(200); toTop()
  await wait(600)
  note('кадр снят с начала ленты', ($('chatFeed').scrollTop || 0) < 40, 'scrollTop ' + $('chatFeed').scrollTop)
`, {
  turns: [{ content: `${SUMMARY_EN}` }, { text: `${ANSWER_EN}` }, { text: `${ANSWER_EN}` }],
  profileDir: profileEn
})

const reports = [measure, restart]
const failed = notes.filter(one => !one.pass)
  .concat(reports.flatMap(one => (one.checks || []).filter(check => !check.pass)))
for (const one of notes.filter(item => !item.pass)) console.error('ПРОВАЛ ' + one.name + (one.detail ? ' — ' + one.detail : ''))

// Зелёный прогон стирает временный каталог (`settleRun`), а кадры обязаны
// пережить его: копия всегда идёт в директорию аудита своего ворктри.
for (const name of ['measure', 'restart', 'shot', 'measure-en']) {
  const shot = path.join(out, `${name}.png`)
  if (fs.existsSync(shot)) {
    fs.mkdirSync(evidence, { recursive: true })
    fs.copyFileSync(shot, path.join(evidence, `${name}.png`))
  }
}

const ok = failed.length === 0
settleRun(out, ok)
console.log(JSON.stringify({ ok, checks: notes.length + reports.reduce((n, one) => n + (one.checks || []).length, 0), failed: failed.length }))
process.exitCode = ok ? 0 : 1
