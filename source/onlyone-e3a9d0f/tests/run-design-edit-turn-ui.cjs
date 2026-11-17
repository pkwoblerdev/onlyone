// run-design-edit-turn-ui.cjs — оконный прогон шага 2 пункта 4.2: правка макета
// из чата идёт ХОДОМ ДИЗАЙНА и только когда макет открыт в окне (решение
// владельца от 28.09). Набор написан ДО продуктового кода и краснеет по
// отсутствию поведения, а не разваливается на старте.
//
// Кадров шесть — три состояния × два языка, каждый отдельным запуском окна на
// СВОЁМ временном профиле: `main.js` делает один снимок на прогон, а состояние
// надо поймать живым. Профиль заводится прогоном и заполняется настоящим
// содержимым: один макет в реестре (`data/designs.json`), одна переписка
// (`data/conversations.json`) и одна страница на диске — так проверка видит тот
// же профиль, что и человек, а не выдуманное состояние. В режимах с ходом к
// кадру добавляется второй запуск на том же профиле — кадр самого раздела
// «Дизайн» (`designSectionShot`): лента чата и рабочее место макета — разные
// панели, на одном снимке их не бывает.
//
//   waiting-ru / waiting-en — макет НЕ открыт → карточка «ждёт — откроется при
//                следующем запуске», версия и байты страницы не изменились;
//   turn-ru    / turn-en    — макет открыт в разделе «Дизайн» → карточка
//                «правка идёт ходом Дизайна», версия того же макета выросла,
//                и то же видно на кадре раздела «Дизайн»;
//   unfocus-ru / unfocus-en — макет открывали и закрыли → снова «ждёт».
//
// Ход ведёт тестовый провайдер из файла-сценария (`ONECODE_PROVIDER_FILE`, шов
// плана 2c): сеть не трогается, ключ в профиле фиктивный, вызова модели нет.
// Правка делается НАСТОЯЩИМ путём: просьба уходит через форму чата, а в режимах
// с открытым макетом её исполняет ход Дизайна того же окна — его шаги тоже
// лежат в том же файле-сценарии.
//
// ПУТЬ каталога доказательств передают в форме `D:/…`, а не `/d/…`: с unix-путём
// копирование молча не происходит. Каталог по умолчанию — СВОЁ ворктри
// (`<ворктри>/audits/design-edit-turn`): в общей папке дерева кадры не пишутся,
// и наружу раннер их не отдаёт (правило приёмки 29.09).
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
// Форму файла компонента знает само хранилище: прогон сеет страницу его же средствами.
const { assemble } = require('../src/main/design/store.js')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-design-edit-turn-ui')

function evidenceDir () {
  const wanted = path.resolve(process.env.ONECODE_EVIDENCE_DIR || path.join(root, 'audits', 'design-edit-turn'))
  const own = path.resolve(root) + path.sep
  if (!wanted.startsWith(own)) {
    throw new Error(`Каталог доказательств вне своего ворктри: «${wanted}». Кадры пишутся сюда: ${path.join(root, 'audits', 'design-edit-turn')} — в общей папке дерева ничего не пишут`)
  }
  return wanted
}

const evidence = evidenceDir()
const RENDERER = 'design-edit-turn-renderer.js'

const DESIGN_ID = 'dproof42'
const COMPONENT = 'Home.dc.html'
const CHAT_ID = 'chat-edit-turn'

const LABELS = {
  ru: {
    topic: 'Лендинг доставки цветов',
    ask: 'Поправь макет из оконного прогона',
    marker: 'МИШЕНА-ПРАВОК',
    waiting: 'жд[её]т|жд[её]м',
    // «откро» само по себе не годится: в ленте есть кнопка «Открыть в Дизайне»,
    // а обычное «идёт работа» уже содержит «ждём». Ищем именно обещание.
    promiseWord: 'при следующем|следующ[её]м запуск|следующ[её]го запуска|когда откроете|после запуска',
    revision: 'правк',
    viaTurn: 'ход|дизайна',
    ready: 'готов',
    before: 'МИШЕНА-ДО-ПРАВКИ',
    after: 'МИШЕНА-ПОСЛЕ-ПРАВКИ',
    note: 'Форма заказа и блок тарифов.'
  },
  en: {
    topic: 'Flower delivery landing',
    ask: 'Fix the layout from the window run',
    marker: 'TARGET-EDIT',
    waiting: 'waits|waiting|queued|on hold',
    promiseWord: 'next launch|next start|next time|on next|when you open|after you open',
    revision: 'edit',
    viaTurn: 'turn|design',
    ready: 'ready|done',
    before: 'TARGET-BEFORE-EDIT',
    after: 'TARGET-AFTER-EDIT',
    note: 'Order form and pricing block.'
  }
}

// --- профиль прогона ------------------------------------------------------------

const b64 = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
// Конверт `{enc:'plain'}` главный процесс читает независимо от того, доступен ли
// DPAPI: тот же формат, что у профиля без шифрования.
const envelope = value => JSON.stringify({ enc: 'plain', data: b64(value) })

const pageTemplate = (L, state) => `<h1>${state === 'after' ? L.after : L.before}</h1>
<p>${L.topic}</p>
<p>${L.note}</p>`
// Файл компонента пишется в той же форме, что его пишет движок (`assemble`):
// иначе `dc_read` вернул бы пустой шаблон, и правка «из ничего» исказила бы
// картину прогона.
const pageFile = (L, state) => assemble({ template: pageTemplate(L, state), logic: '', props: '' })

function makeProfile (frameId, lang) {
  const L = LABELS[lang]
  const profile = path.join(out, `profile-${frameId}`)
  const workspace = path.join(out, `workspace-${frameId}`)
  fs.mkdirSync(path.join(profile, 'data'), { recursive: true })
  fs.mkdirSync(path.join(profile, 'designs', DESIGN_ID), { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model',
    legacyStoragePurged: true,
    workspace: { path: workspace, permission: 'acceptEdits' },
    language: lang
  }))
  // Набор переписки засевается старым форматом (v1): хранилище переносит его
  // само, поэтому кадр не зависит от выбранной раскладки истории.
  fs.writeFileSync(path.join(profile, 'data', 'conversations.json'), envelope([{
    id: CHAT_ID, title: lang === 'en' ? 'Window edit check' : 'Проверка правки из окна',
    messages: [], projectId: null, createdAt: Date.now(), updatedAt: Date.now(),
    // Название этого диалога уже сгенерировано, поэтому фоновый запрос имени
    // (`nameChat` идёт сразу за ответом) не встаёт в общий счётчик шагов
    // тестового провайдера перед шагом хода Дизайна. Замеренный порядок
    // обращений (`providerTurns`) его не показывает, но он единственный
    // оставшийся кандидат съесть шаг, а порядок обращений — не то, чем стоит
    // жертвовать ради устойчивости прогона.
    titleGenerated: true
  }]))
  fs.writeFileSync(path.join(profile, 'data', 'designs.json'), envelope([{
    id: DESIGN_ID, name: L.topic, chatId: CHAT_ID, component: COMPONENT, version: 1,
    messages: [], comments: [], createdAt: Date.now(), updatedAt: Date.now()
  }]))
  fs.writeFileSync(path.join(profile, 'designs', DESIGN_ID, COMPONENT), pageFile(L, 'before'))
  return { profile, workspace }
}

// --- сценарий хода ---------------------------------------------------------------

// Шаги одного прогона: ответ чата с вызовом `design_task`, финальная реплика чата,
// затем шаги хода Дизайна (он начинается тем же окном, если макет открыт) —
// `dc_write` новой страницей и финальная реплика. Лишние шаги без инструментов
// заканживают цикл, если ходов окажется больше ожидаемого.
//
// Выдаём запись первому ведущему запросу Дизайна по содержимому системного
// промпта: фоновые проверки могут выполняться в любом количестве.
function providerTurns (L, lang) {
  const instruction = lang === 'en'
    ? `Make the headline larger — ${L.marker}`
    : `Сделай заголовок крупнее — ${L.marker}`
  const writeStep = () => ({ toolCalls: [{ name: 'dc_write',
    args: { path: COMPONENT, b_dc_html: pageTemplate(L, 'after'), c_dc_js: '', d_props_json: '' } }] })
  const done = lang === 'en' ? 'Done.' : 'Готово.'
  return {
    instruction,
    keyed: [{ match: 'Ты — onlyone в разделе «Дизайн»', once: true, ...writeStep() }],
    turns: [
      { toolCalls: [{ name: 'design_task', args: { brief: instruction, topic: L.topic, design_id: DESIGN_ID, instruction } }] },
      { text: lang === 'en' ? 'The edit is handed to the Design section.' : 'Правку передал в раздел «Дизайн».' },
      { text: done },
      { text: done },
      { text: lang === 'en' ? 'Layout updated.' : 'Макет обновлён.' },
      // Хвост: помощники команды, приёмка хода и подсказка следующего запроса —
      // все без инструментов, чтобы цикл заканчивался, а не висел до лимита.
      ...Array.from({ length: 10 }, () => ({ text: done }))
    ]
  }
}

function providerFile (frameId, script) {
  const file = path.join(out, `provider-${frameId}.json`)
  fs.writeFileSync(file, JSON.stringify(script))
  return file
}

// --- что осталось на диске ---------------------------------------------------------

// Страница макета на диске лежит в конверте safeStorage (шифрование на диске,
// 29.09), и node-процесс её не откроет: обычный `readFileSync` отдал бы байты
// конверта, и проверка «метки нет» ловила бы шифр, а не правку. Поэтому байты
// читаются отдельным Electron-процессом на ТОМ ЖЕ профиле — тем же путём, каким
// их читает приложение (`tests/design-page-unwrap.cjs`), и всё равно ПОСЛЕ
// закрытия окна: мерка остаётся тем, что реально лежит на диске.
function readPageBytes (profile, page) {
  if (!fs.existsSync(page)) return Promise.resolve('')
  return new Promise(resolve => {
    const child = spawn(electronBinary(),
      [path.join(__dirname, 'design-page-unwrap.cjs'), page, '--no-sandbox', `--user-data-dir=${profile}`],
      { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.on('error', () => resolve(''))
    child.on('close', code => {
      if (code !== 0) return resolve('')
      try { resolve(String(JSON.parse(out).text)) } catch (broken) { resolve('') }
    })
  })
}

async function diskState (profile, lang) {
  const L = LABELS[lang]
  const page = path.join(profile, 'designs', DESIGN_ID, COMPONENT)
  const versionsDir = path.join(profile, 'designs', DESIGN_ID, '.versions', COMPONENT)
  let folders = []
  try {
    folders = fs.readdirSync(path.join(profile, 'designs'), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch { folders = [] }
  let versionFiles = []
  try { versionFiles = fs.readdirSync(versionsDir) } catch { versionFiles = [] }
  const text = await readPageBytes(profile, page)
  return {
    pageExists: fs.existsSync(page),
    beforeKept: text.includes(L.before),
    afterShown: text.includes(L.after),
    // Реестр после первого сохранения окна лежит в профиле шифром DPAPI, и
    // прогон его не откроет. Поэтому «второго макета нет» читается папками
    // хранилища: это и есть то, что остаётся на диске от правки.
    designs: folders.length,
    designFolders: folders.join(', '),
    keptVersions: versionFiles.filter(name => !name.startsWith('.')).length
  }
}

// --- кадр раздела «Дизайн» для режимов с ходом -------------------------------------
//
// Снимок в прогоне один на запуск окна, а лента чата и рабочее место макета — две
// разные панели: на одном кадре их не бывает. Поэтому «правка дошла до макета в
// разделе» показывается ВТОРЫМ запуском на ТОМ ЖЕ профиле (тот же приём, что в
// `run-design-resume-ui.cjs`): второе окно только открывает макет, модель не зовёт
// и на диске ничего не меняет — байты первого прогона к этому моменту уже сняты
// `diskState`.
const DESIGN_SHOT_SCRIPT = `(async () => {
  const arg = (() => {
    try {
      const bin = atob('__ONECODE_ARG__')
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  })()
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms) => {
    const stop = Date.now() + ms
    for (;;) {
      let value = false
      try { value = await fn() } catch { /* состояние ещё не собрано */ }
      if (value) return true
      if (Date.now() > stop) return false
      await wait(80)
    }
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({
    name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail).slice(0, 200)
  })
  const TEXT = el => (el && (el.textContent || '')).replace(/\\s+/g, ' ').trim()
  const ready = await until(() => document.documentElement.dataset.appReady === '1', 30000)
  note('окно сообщило о готовности', ready)
  if (!ready) return { ok: false, checks }
  $('navDesign') && $('navDesign').click()
  note('раздел «Дизайн» открыт', await until(() => $('designView') && $('designView').classList.contains('active'), 8000))
  const row = await until(() => [...($('designList').children || [])].some(node => TEXT(node).includes(arg.topic)), 8000)
  note('макет виден в списке Дизайна', row, TEXT($('designList')))
  const target = [...($('designList').children || [])].find(node => TEXT(node).includes(arg.topic))
  target && target.click()
  note('рабочее место этого макета открыто', await until(() => $('designWorkspace') && !$('designWorkspace').hidden, 10000))
  const listed = await window.electronAPI.designVersions(arg.designId, arg.component)
  const versions = ((listed && listed.versions) || []).length
  note('у той же страницы есть сохранённая прежняя версия — правка легла в историю', versions >= 1, 'версий: ' + versions)
  const lane = await until(() => TEXT($('designMessages')).includes(arg.marker), 10000)
  note('лента макета помнит эту правку', lane, TEXT($('designMessages')).slice(0, 200))
  // Кадр превью: страница в разделе обязана успеть отрисоваться до снимка.
  await wait(2000)
  return { ok: checks.every(item => item.pass) && checks.length > 0, checks }
})()`

// --- запуск окна -------------------------------------------------------------------

const FRAMES = [
  { id: 'waiting-ru', mode: 'waiting', lang: 'ru', state: 'не открыт → ждёт' },
  { id: 'turn-ru', mode: 'turn', lang: 'ru', state: 'открыт → правка ходом Дизайна' },
  { id: 'unfocus-ru', mode: 'unfocus', lang: 'ru', state: 'сняли с открытого → ждёт' },
  { id: 'waiting-en', mode: 'waiting', lang: 'en', state: 'not open → waiting (EN)' },
  { id: 'turn-en', mode: 'turn', lang: 'en', state: 'open → design turn edit (EN)' },
  { id: 'unfocus-en', mode: 'unfocus', lang: 'en', state: 'unfocused → waiting (EN)' }
]

const only = (process.env.ONECODE_EDIT_TURN_ONLY || '').split(',').map(name => name.trim()).filter(Boolean)
const SELECTED = only.length ? FRAMES.filter(frame => only.includes(frame.id)) : FRAMES

// Окно закрывается само (main.js делает снимок и выходит), поэтому ждём именно
// закрытия процесса. Снятый по таймауту процесс — красный кадр, а не зависший
// прогон: без этого харнесс ждал бы вечно.
async function awaitClosed (child, label, timeoutMs) {
  const killer = setTimeout(() => {
    console.error(`ПРОВАЛ ${label}: окно не вернулось за ${Math.round(timeoutMs / 1000)} с — снимаю процесс`)
    child.kill('SIGKILL')
  }, timeoutMs)
  return await new Promise(resolve => {
    child.on('error', error => {
      clearTimeout(killer)
      console.error(`ПРОВАЛ ${label}: окно не запущено — ${error.message}`)
      resolve('spawn-error')
    })
    child.on('close', status => { clearTimeout(killer); resolve(status) })
  })
}

function readReport (file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

function copyEvidence (...files) {
  if (!evidence) return
  fs.mkdirSync(evidence, { recursive: true })
  for (const file of files) {
    if (file && fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)))
  }
}

// Второй запуск того же профиля: кадр раздела «Дизайн» — там видно, что
// правка дошла до макета, а не только до карточки в чате.
async function designSectionShot (frame, profile) {
  const L = LABELS[frame.lang]
  const scriptFile = path.join(out, `${frame.id}-design-script.js`)
  const resultFile = path.join(out, `${frame.id}-design.json`)
  const shot = path.join(out, `${frame.id}-design.png`)
  fs.writeFileSync(scriptFile, DESIGN_SHOT_SCRIPT)
  const child = spawn(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
      cwd: root, stdio: 'inherit',
      env: guiEnv({
        ONECODE_SMOKE: scriptFile,
        ONECODE_SMOKE_OUT: resultFile,
        ONECODE_SHOT: shot,
        ONECODE_ARG: Buffer.from(JSON.stringify({
          topic: L.topic, marker: L.marker, designId: DESIGN_ID, component: COMPONENT
        }), 'utf8').toString('base64')
      })
    })
  const closed = await awaitClosed(child, `${frame.id}/дизайн`, 180000)
  const report = readReport(resultFile)
  if (!report) console.error(`ПРОВАЛ ${frame.id}/дизайн: окно не отчиталось (status ${closed})`)
  const checks = report ? ((report.checks) || []) : [{ name: 'кадр раздела «Дизайн»: окно отчиталось', pass: false, detail: `status ${closed}` }]
  for (const item of checks) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + `${frame.id} · ${item.name}` + (item.detail ? ` — ${item.detail}` : ''))
  }
  copyEvidence(shot, resultFile)
  return { checks, shots: fs.existsSync(shot) ? 1 : 0 }
}

async function launch (frame) {
  const L = LABELS[frame.lang]
  const { profile } = makeProfile(frame.id, frame.lang)
  const script = providerTurns(L, frame.lang)
  const resultFile = path.join(out, `${frame.id}.json`)
  const shot = path.join(out, `${frame.id}.png`)
  const child = spawn(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
      cwd: root, stdio: 'inherit',
      env: guiEnv({
        ONECODE_SMOKE: path.join(__dirname, RENDERER),
        ONECODE_SMOKE_OUT: resultFile,
        // Настоящий цикл агента с файлом-сценарием вместо сети.
        ONECODE_E2E: '1',
        ONECODE_PROVIDER_FILE: providerFile(frame.id, script),
        ONECODE_SHOT: shot,
        ONECODE_ARG: Buffer.from(JSON.stringify({
          mode: frame.mode, lang: frame.lang, marker: L.marker, topic: L.topic, ask: L.ask,
          designId: DESIGN_ID, component: COMPONENT, chatId: CHAT_ID, labels: L,
          instruction: script.instruction
        }), 'utf8').toString('base64')
      })
    })
  const closed = await awaitClosed(child, frame.id, 300000)
  const report = readReport(resultFile)
  if (report && report.error) console.error(`${frame.id}: окно сообщило об ошибке — ${report.error}`)
  if (!report) console.error(`ПРОВАЛ ${frame.id}: окно не отчиталось (status ${closed})`)
  for (const item of (report && report.checks) || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + `${frame.id} · ${item.name}` + (item.detail ? ` — ${item.detail}` : ''))
  }

  // Диск — вторая половина доказательства: слово «выросла» в окне ещё не значит,
  // что байты страницы изменились, а в «ждёт» не должно измениться ничего.
  // Читается ПОСЛЕ закрытия окна: до этого в профиле лежат ещё исходные байты
  // прогона, и «ничего не изменилось» было бы верно сама по себе.
  const after = await diskState(profile, frame.lang)
  const diskChecks = frame.mode === 'turn'
    ? [
      ['диск: страница макета изменена правкой', after.afterShown && !after.beforeKept,
        `после=${after.afterShown}, до осталось=${after.beforeKept}`],
      ['диск: прежние байты сохранены как версия', after.keptVersions >= 1, `версий в .versions: ${after.keptVersions}`],
      ['диск: папка макета осталась одна (второго макета нет)', after.designs === 1,
        `папок хранилища: ${after.designFolders}`]
    ]
    : [
      ['диск: страница макета не тронута', after.beforeKept && !after.afterShown,
        `до=${after.beforeKept}, после=${after.afterShown}`],
      ['диск: новых версий не появилось', after.keptVersions === 0, `версий в .versions: ${after.keptVersions}`],
      ['диск: второго макета не завелось', after.designs === 1, `папок хранилища: ${after.designFolders}`]
    ]
  for (const [name, pass, detail] of diskChecks) {
    console.log((pass ? '  ok  ' : 'ПРОВАЛ ') + `${frame.id} · ${name} — ${detail}`)
  }

  copyEvidence(shot, resultFile)
  // Кадр раздела «Дизайн» — только там, где правка действительно дошла до
  // макета: в режимах ожидания менять в разделе нечего.
  const companion = frame.mode === 'turn' ? await designSectionShot(frame, profile) : { checks: [], shots: 0 }
  const windowOk = Boolean(report && report.ok) && (report.checks || []).length > 0 && !report.error
  return {
    ok: windowOk && diskChecks.every(item => item[1] === true) &&
      companion.checks.every(item => item.pass === true),
    checks: [...((report && report.checks) || []), ...companion.checks],
    diskChecks: diskChecks.map(item => ({ name: item[0], pass: item[1] === true })),
    shots: (fs.existsSync(shot) ? 1 : 0) + companion.shots
  }
}

async function main () {
  const results = []
  for (const frame of SELECTED) results.push([frame, await launch(frame)])
  const ok = results.every(([, one]) => one.ok)
  console.log('')
  for (const [frame, one] of results) {
    const red = [...one.checks, ...one.diskChecks].filter(item => !item.pass).length
    console.log(`кадр ${frame.id} · ${frame.state}: проверок ${one.checks.length + one.diskChecks.length}, ` +
      `красных ${red}, снимков ${one.shots}`)
  }
  const shots = results.reduce((sum, [, one]) => sum + one.shots, 0)
  console.log(`снимков: ${shots} (каждый кадр — лента чата, в режимах с ходом ещё раздел «Дизайн»)` +
    ` из ${SELECTED.length + results.filter(([frame]) => frame.mode === 'turn').length}`)
  if (evidence) console.log(`доказательства: ${evidence}`)
  console.log(ok
    ? 'Правка из чата идёт ходом Дизайна и только при открытом макете'
    : 'Шаг 2 пункта 4.2 не сделан: окно не сообщает открытый макет, правка идёт чатным движком, ' +
      'а при закрытом окне стартует вместо ожидания')
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

main().catch(error => {
  console.error('ПРОВАЛ ' + ((error && error.message) || error))
  settleRun(out, false)
  process.exitCode = 1
})
