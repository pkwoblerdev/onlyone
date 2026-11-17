// Оконный прогон оболочки Ultra (план, 9.2): пятнадцать запусков настоящего окна
// на одном профиле прогона.
//
// Пресет включается НАСТОЯЩЕЙ конфигурацией интерфейса: перед каждым запуском
// в профиль прогона кладётся `ui-config.json` тем же `ui-config.save`, что
// пишет его живой программе, — главный процесс читает его же `ui-config.load`.
// Никакой подделки DOM: если `versionPreset` не «ultra», экран обязан остаться
// обычным (последний кадр прогона — ровно этот контроль).
//
// Кадров девять на оболочку: посев диалогов, вход со списком Sessions, пустая
// новая сессия, один открытый чат, отправка из строки Ultra и те же три экрана
// по-английски, затем контроль `default`. Шесть кадров — остаток пункта 9.2
// (поручение 29.09 14:40): выбор Ultra в Настройках «Вид приложения», окно Ultra
// и возврат на onlyone — по-русски и по-английски. Они стартуют с пресета
// `start`: ВСЕ поля конфигурации в нём отличимы от DEFAULT_UI_CONFIG, иначе
// «остальные поля не обнулены» было бы нечем мерить (обнуление до дефолтов
// незаметно именно потому, что дефолт и был прежним значением).
// Окно делает один снимок на запуск, поэтому каждый
// кадр — отдельный запуск; снимки и отчёты копируются в ONECODE_EVIDENCE_DIR и
// переживают прогон (зелёный запуск убирает свой временный каталог, красный
// оставляет улики).
//
// Диалоги сеются штатным каналом окна (`setConversations`), результаты — ТЕМ ЖЕ
// модулем `src/main/artifacts.js`, которым их пишет живая программа, и лежат в
// отдельном диалоге `chatC`: кадры оболочки его не открывают, поэтому их
// геометрию новые артефакты не меняют, а «данные не теряются» меряется настоящим
// числом диалогов и результатов до и после двух переходов версиями.
//
// Запуск — асинхронный `spawn`: `spawnSync` блокирует цикл того же процесса,
// где может жить HTTP-заглушка или другой прогон, и красное сообщение приходит
// по таймауту загрузки вместо продукта.
//
// Подмножество кадров для отрицательного контроля: ONECODE_ULTRA_FRAMES=entry-ru
// (посев всё равно выполняется первым — без посеянных диалогов кадры пусты).
//
// ПУТЬ каталога доказательств передают в форме `D:/…`, а не `/d/…`.
//
// Каталог кадров — СВОЁ ворктри (правка 5 приёмки 29.09). Прежний прогон
// писал снимки в общую папку дерева, а там по правилу плана не пишут ничего:
// раннер по умолчанию берёт `<свой ворктри>/audits/ultra-shell` и не даёт
// увести путь наружу — `audits/` в .gitignore, кадры в коммит не лягут.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const uiConfig = require('../src/main/ui-config.js')
const artifactStore = require('../src/main/artifacts.js')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-ultra-shell-ui')
const profile = path.join(out, 'profile')

function evidenceDir () {
  const wanted = path.resolve(process.env.ONECODE_EVIDENCE_DIR || path.join(root, 'audits', 'ultra-shell'))
  const own = path.resolve(root) + path.sep
  if (!wanted.startsWith(own)) {
    throw new Error(`Каталог доказательств вне своего ворктри: «${wanted}». Кадры пишутся сюда: ${path.join(root, 'audits', 'ultra-shell')} — в общей папке дерева ничего не пишут`)
  }
  return wanted
}

const evidence = evidenceDir()

// Идентификаторы диалогов — их сеет зонд, они же он ищет в списке Sessions.
const chatA = '11111111-2222-3333-4444-555555555511'
const chatB = '11111111-2222-3333-4444-555555555512'
// Диалог, к которому лежат артефакты: кадры оболочки его НЕ открывают, поэтому
// новый слой свободных блоков не лезет в прежние проверки геометрии, а «данные не
// теряются» меряется настоящими результатами, а не нулём.
const chatC = '11111111-2222-3333-4444-555555555513'
const ARTIFACTS = [
  { title: 'Отчёт по сборке', kind: 'page', content: '<h1>Сборка</h1><p>Три раздела.</p>' },
  { title: 'Тесты', kind: 'table', content: 'Suite,Result\ncore,pass\nui,pass' }
]

// Конфигурация интерфейса по пресетам. `showSidebar` и `showWorkPanel` в кадрах
// Ultra стоят «показать»: гасить панели обязана оболочка, а не человек в
// Настройках, — иначе проверка «панели погашены» не отличила бы оболочку от
// выключенных вручную панелей.
//
// Пресет `start` — кадры выбора версии. Отличим от DEFAULT_UI_CONFIG КАЖДЫМ
// полем: проверка «записали versionPreset, а чужие поля сохранились» на
// дефолтах была бы зелёной и при обнулении профиля.
const CONFIG = {
  ultra: { versionPreset: 'ultra', showSidebar: true, showWorkPanel: true, sidebarWidth: 240, workPanelWidth: 360 },
  default: { versionPreset: 'default', showSidebar: true, showWorkPanel: true, sidebarWidth: 240, workPanelWidth: 360 },
  start: {
    versionPreset: 'default', showSidebar: true, showWorkPanel: true,
    sidebarWidth: 300, workPanelWidth: 420, codeFontSize: 16, fontUiSize: 12.5,
    lineHeight: 1.6, panelsOrder: ['chat', 'sidebar', 'work']
  }
}

const FRAMES = [
  { name: 'seed', mode: 'seed', lang: 'ru', preset: 'ultra' },
  { name: 'entry-ru', mode: 'entry', lang: 'ru', preset: 'ultra' },
  { name: 'empty-ru', mode: 'empty', lang: 'ru', preset: 'ultra' },
  { name: 'chat-ru', mode: 'chat', lang: 'ru', preset: 'ultra' },
  { name: 'send-ru', mode: 'send', lang: 'ru', preset: 'ultra' },
  { name: 'entry-en', mode: 'entry', lang: 'en', preset: 'ultra' },
  { name: 'empty-en', mode: 'empty', lang: 'en', preset: 'ultra' },
  { name: 'chat-en', mode: 'chat', lang: 'en', preset: 'ultra' },
  // U-1: полос прокрутки в Ultra не видно ни на каком из двух размеров окна.
  { name: 'scroll-1240', mode: 'scroll', lang: 'ru', preset: 'ultra', width: 1240, height: 800 },
  { name: 'scroll-1920', mode: 'scroll', lang: 'ru', preset: 'ultra', width: 1920, height: 1080 },
  // U-2: «Задачи» — свободный блок. Второй кадр — ТОТ ЖЕ профиль и новый запуск
  // окна: по нему видно, что место и размер пережили перезапуск, а не живут в
  // памяти вкладки. `expects` — кадр, из которого берётся сохранённое место.
  { name: 'tasks-open', mode: 'tasks', lang: 'ru', preset: 'ultra' },
  { name: 'tasks-again', mode: 'tasks', lang: 'ru', preset: 'ultra', expects: 'tasks-open' },
  // ПОЧЕМУ КОНТРОЛЬ ИМЕННО ЗДЕСЬ, А НЕ В НАЧАЛЕ. Кадр сверяет, что в обычном
  // виде полоса прокрутки ленты ОСТАЛАСЬ, и меряет её на переполненной ленте.
  // Переполнение создаёт предыдущий кадр, поэтому контроль идёт последним из
  // кадров Ultra: поставленный выше, он смотрел на пустую ленту, где
  // прокручиваться нечему, и краснел без причины.
  { name: 'control-default', mode: 'control', lang: 'ru', preset: 'default' },
  // 9.2 остаток (поручение 29.09 14:40): выбор Ultra в Настройках, окно Ultra и
  // возврат — три состояния в ДВУХ языках.
  { name: 'version-choose-ru', mode: 'version-choose', lang: 'ru', preset: 'start' },
  { name: 'version-ultra-ru', mode: 'version-ultra', lang: 'ru', preset: 'start' },
  { name: 'version-return-ru', mode: 'version-return', lang: 'ru', preset: 'start' },
  { name: 'version-choose-en', mode: 'version-choose', lang: 'en', preset: 'start' },
  { name: 'version-ultra-en', mode: 'version-ultra', lang: 'en', preset: 'start' },
  { name: 'version-return-en', mode: 'version-return', lang: 'en', preset: 'start' }
]

// Место блока, которое один кадр оставил другому (U-2: перезапуск на том же
// профиле обязан найти блок там же).
const places = {}

function pickFrames () {  const want = String(process.env.ONECODE_ULTRA_FRAMES || '')
    .split(',').map(name => name.trim()).filter(Boolean)
  if (!want.length) return FRAMES
  const unknown = want.filter(name => !FRAMES.some(frame => frame.name === name))
  if (unknown.length) throw new Error('Кадров нет в списке: ' + unknown.join(', '))
  const chosen = want.map(name => FRAMES.find(frame => frame.name === name))
  // Посев обязателен: без него список Sessions и лента чата пустые, и кадры
  // проверяли бы пустой экран вместо работы оболочки. Кадры выбора версии меряют
  // число диалогов и результатов — без посева они измеряли бы ноль на нуле.
  if (!chosen.some(frame => frame.mode === 'seed')) return [FRAMES[0], ...chosen]
  return chosen
}

// Результаты отдельного диалога: тем же модулем и в тот же каталог профиля,
// куда их пишет живая программа (`userData/artifacts`, см. artifactsRoot() в
// main.js). Ошибка посева — это не «красная проверка», а сломанный прогон:
// раннер говорит о ней прямо.
async function seedArtifacts () {
  const store = artifactStore.create({ dir: path.join(profile, 'artifacts') })
  for (const item of ARTIFACTS) {
    const made = await store.add({ chatId: chatC, title: item.title, kind: item.kind, content: item.content })
    if (!made || !made.id) throw new Error(`Профиль прогона не принял результат «${item.title}»`)
  }
  const listed = await store.list({ chatId: chatC })
  if (listed.length !== ARTIFACTS.length) {
    throw new Error(`Профиль прогона принял ${listed.length} артефактов вместо ${ARTIFACTS.length}`)
  }
}

function launch (frame) {
  const resultFile = path.join(out, `${frame.name}.json`)
  const shot = path.join(out, `ultra-shell-${frame.name}.png`)
  const saved = uiConfig.save(profile, CONFIG[frame.preset])
  if (!saved.ok) throw new Error(`Профиль прогона не принял конфигурацию «${frame.preset}»: ${saved.error}`)
  // Две папки для проверки «Добавить папку»: системный диалог в прогоне заменён
  // очередью путей (ONECODE_TEST_PICK_FOLDER, работает только из исходников).
  const pickA = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-pick-a-'))
  const pickB = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-pick-b-'))
  const args = {
    mode: frame.mode, lang: frame.lang, chatA, chatB, chatC,
    preset: frame.preset,
    pick: [pickA, pickB],
    width: frame.width,
    height: frame.height,
    expect: frame.expects ? places[frame.expects] : undefined
  }
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary(),
      ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
        cwd: root, stdio: 'inherit',
        env: guiEnv({
          ONECODE_SMOKE: path.join(__dirname, 'ultra-shell-renderer.js'),
          ONECODE_SMOKE_OUT: resultFile,
          ONECODE_SHOT: shot,
          ONECODE_TEST_PICK_FOLDER: pickA + '|' + pickB,
          // Ответ провайдера под прогоном берётся из фикстуры: отправка из
          // строки Ultra проверяется настоящим ходом, без сети и без ключа.
          ONECODE_SMOKE_FIXTURE: path.join(__dirname, 'smoke-fixture.json'),
          // Аргументы — base64: в них есть кавычки и угловые скобки.
          ONECODE_ARG: Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
        })
      })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Окно «${frame.name}» не отчиталось за 180 с`))
    }, 180000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => {
      clearTimeout(timer)
      if (!fs.existsSync(resultFile)) {
        console.error(`ПРОВАЛ [${frame.name}]: окно не отчиталось (status ${code})`)
        resolve({ ok: false, checks: [], shot: false })
        return
      }
      const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      if (report.error) console.error(`${frame.name}: окно сообщило об ошибке — ${report.error}`)
      for (const item of report.checks || []) {
        console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + frame.name + ' · ' + item.name +
          (item.detail ? ' — ' + item.detail : ''))
      }
      if (evidence) {
        fs.mkdirSync(evidence, { recursive: true })
        for (const file of [shot, resultFile]) {
          if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)))
        }
      }
      resolve({ ...report, shot: fs.existsSync(shot) })
    })
  })
}

async function main () {
  if (evidence) fs.mkdirSync(evidence, { recursive: true })
  fs.mkdirSync(profile, { recursive: true })
  await seedArtifacts()
  const frames = pickFrames()
  const results = []
  for (const frame of frames) {
    console.log(`-> кадр ${frame.name} (mode=${frame.mode}, lang=${frame.lang}, versionPreset=${frame.preset})`)
    const report = await launch(frame)
    results.push([frame.name, report])
    if (report && report.extra && report.extra.place) {
      const one = report.extra.place
      places[frame.name] = { x: Math.round(one.x), y: Math.round(one.y), w: Math.round(one.w), h: Math.round(one.h) }
    }
  }
  const total = results.reduce((sum, [, one]) => sum + (one.checks || []).length, 0)
  const passed = results.reduce((sum, [, one]) => sum + (one.checks || []).filter(item => item.pass).length, 0)
  const shots = results.filter(([, one]) => one.shot).length
  for (const [name, one] of results) {
    console.log(`кадр ${name}: проверок ${(one.checks || []).length}, снимок ${one.shot ? 'есть' : 'НЕТ'}`)
  }
  const reds = results.filter(([, one]) => !one.ok).map(([name]) => name)
  const ok = reds.length === 0 && total > 0 && shots === results.length
  console.log(`Оболочка Ultra — кадров ${results.length}, снимков ${shots}, проверок ${total}, успешно ${passed}`)
  if (evidence) console.log(`доказательства: ${evidence}`)
  console.log(ok
    ? 'Оболочка Ultra работает в настоящем окне по пункту 9.2 (и выбор версии в настройках тоже)'
    : `Пункт 9.2 ещё не сделан: оболочка Ultra в окне ведёт себя иначе — красные кадры: ${reds.join(', ')}`)
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

main().catch(error => {
  console.error('ПРОВАЛ', error.message)
  settleRun(out, false)
  process.exitCode = 1
})
