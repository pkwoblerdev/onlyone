'use strict'

// ---------------------------------------------------------------------------
// Пункт 7.5 «Своя CLI» — оконный прогон. КРАСНЫЙ: написан ДО кода.
//
// Здесь CLI проверяется не на подставных зависимостях (это делает
// tests/test-cli-7-5.cjs), а как процесс человека: `onlyone run "<просьба>"
// --folder <путь>` — реальные stdout/stderr, реальный код выхода и настоящий
// цикл ядра на ПОДСТАВНОЙ модели: файл-сценарий провайдера
// (`ONECODE_PROVIDER_FILE`, шов работает только в непрособранном приложении).
// Ни сети, ни настоящих ключей, ни платных запросов.
//
// Сценарии:
//   чтение           → код 0, ответ в stdout, в папке ни одного нового файла
//   запись без флага → код WRITE_REFUSED (3), в выводе строка отказа, файла НЕТ
//   запись с флагом  → код 0, файл создан
//   ошибка модели    → код TURN_FAILED (1), причина названа
//   нет --folder     → код BAD_INPUT (2), ядро не дёрнулось (счётчик 0)
//   папки нет        → код BAD_INPUT (2), ядро не дёрнулось
//   неизвестный ключ → код BAD_INPUT (2), имя ключа в подсказке
//   секрет           → в stdout, stderr и в файле журнала нет ни подставного
//                      ключа из профиля, ни его окон, ни его base64-хвоста.
//                      Меряется по байтам труб и файлов, а не по регулярке
//                      «похоже на ключ».
//   хранилище        → после CLI-прогона в профиле нет файлов, которых не
//                      создаёт само приложение: CLI не заводит своего
//                      хранилища, `--profile` только переключает userData
//   снятый извне ход → процесс, убитый посреди хода, не выдаёт успех
//
// Чего этот прогон СОЗНАТЕЛЬНО НЕ меряет: кода ABORTED (4) по Ctrl+C. Node на
// Windows не умеет послать SIGINT консольному ребёнку (`child.kill` снимает
// процесс целиком), поэтому «Ctrl+C → 4» держит узловой набор (исход хода =
// код) и ручная проверка: запуск `onlyone run …`, Ctrl+C во время хода, и
// `echo %ERRORLEVEL%` обязано дать 4.
//
// Как запускается CLI: по умолчанию `node src/cli/onlyone.cjs …`. Если
// реализатор выберет другой вход (например `electron . --cli …`), его задают
// одной переменной без правки этого файла: ONECODE_CLI_CMD=["путь", "арг…"].
//
// Прогон сериализован на общий замок окон (app-launch.acquireWindowLock): CLI
// поднимает Electron внутри себя, а два окна рядом уже топили прогоны друг
// друга. Улики — расшифровки прогонов, журнал и кадр baseline — остаются в
// audits/cli-7-5/ и при зелёном прогоне тоже.
// ---------------------------------------------------------------------------

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock } = require('./app-launch.cjs')

const ROOT = path.join(__dirname, '..')
const ENTRY = process.env.ONECODE_CLI_ENTRY || path.join(ROOT, 'src', 'cli', 'onlyone.cjs')
const OUT = runDir('onlyone-cli-7-5')
const EVIDENCE = process.env.ONECODE_EVIDENCE_DIR || path.join(ROOT, 'audits', 'cli-7-5')

// Подставной ключ прогона: форма как у живого, значение выдумано. Он кладётся
// в профиль (в конверте) и в текст ответа тестовой модели — так «ключа в
// выводе нет» меряется на настоящих байтах, а не вхолостую.
const SECRET = 'ONECODE_TEST_Aq7Z2Lm4Xd9Rt6Yb1Nc8Vk3Hf5Gs0JpMjQ='
const SECRET_B64 = Buffer.from(SECRET, 'utf8').toString('base64')
const SECRET_FRAGMENTS = (() => {
  const pieces = [SECRET, SECRET.toUpperCase()]
  for (let i = 8; i + 8 <= SECRET.length; i++) pieces.push(SECRET.slice(i, i + 8))
  for (const size of [4, 6, 8, 10, 12, 16]) pieces.push(SECRET.slice(-size))
  return [...new Set(pieces.filter(piece => piece.length >= 4))]
})()

const REQUEST_READ = 'Прочитай notes.txt и назови слово'
const REQUEST_WRITE = 'Запиши в папку файл otvet.md со словом привет'
const ANSWER_MARK = 'пальма'
const FILE_WORD = 'привет из onlyone'

// ─── сценарии тестовой модели ───────────────────────────────────────────────
// Шаг цикла заканчивается ответом без вызовов инструментов, судья — отдельным
// ответом (тот же порядок, что в tests/run-cycle-real-ui.cjs).
const turns = {
  read: [
    { toolCalls: [{ name: 'read_file', args: { path: 'notes.txt' } }], text: 'Читаю notes.txt.' },
    // Кроме секрета в ответе обязана быть обычная речь: иначе «ключа нет»
    // нельзя отличить от «вывода нет».
    { text: 'Готово: в notes.txt слово «' + ANSWER_MARK + '». Повторяю заголовок запроса: Bearer ' + SECRET },
    { content: 'ВЕРДИКТ: ГОТОВО' }
  ],
  write: [
    { toolCalls: [{ name: 'write_file', args: { path: 'otvet.md', content: FILE_WORD } }], text: 'Записываю otvet.md.' },
    { text: 'Готово: otvet.md записан, слово «' + ANSWER_MARK + '» не менял.' },
    { content: 'ВЕРДИКТ: ГОТОВО' }
  ],
  // Отклонённый ключ живёт ДО КОНЦА хода: ядро пробует другого агента, и
  // только когда падает вся команда, ход называется сорванным. Один-единственный
  // ошибочный ответ означал бы обратное: после него тестовый провайдер отдал
  // бы пустые ответы, ядро объявило бы «Модель ничего не вернула…» с `ok: true`
  // — и проверяющий спорил бы не с отказом ключа, а с обрезанным сценарием.
  // Сервер вправе процитировать отправленный заголовок: секрет приходит в
  // текст ошибки, а наружу он обязан не выйти.
  broken: Array.from({ length: 12 }, () => ({ error: 'Сервер отклонил ключ ' + SECRET + ' (401)' })),
  slow: [
    { toolCalls: [{ name: 'read_file', args: { path: 'notes.txt' } }], text: 'Думаю.', delayMs: 1500 },
    { text: 'Думаю дальше.', delayMs: 2000 },
    { text: 'Итог: слово «' + ANSWER_MARK + '»' },
    { content: 'ВЕРДИКТ: ГОТОВО' }
  ]
}

// ─── что заводит прогон до запуска ──────────────────────────────────────────
const harnessOwn = new Set()
function own (file) { harnessOwn.add(path.resolve(file)); return file }

function providerFile (name) {
  const file = path.join(OUT, 'provider-' + name + '.json')
  fs.writeFileSync(file, JSON.stringify({ turns: turns[name] }))
  return own(file)
}

function makeWorkspace (tag) {
  const folder = path.join(OUT, 'ws-' + tag)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'слово ' + ANSWER_MARK + '\n')
  return folder
}

// Профиль — тот же формат, что у приложения: ключ в поле `keyEncrypted`
// (здесь base64-конверт; настоящим safeStorage его заверяет само окно). Пул
// обязан быть непустым, иначе ход останавливается до цикла; живой ключ не
// нужен — отвечает файл-сценарий.
//
// Модель ключа — настоящая из каталога, а не вымышленная: `resolveAgentSlots`
// не подменяет молча модель ведущего, а `modelCanCallTools` по чужому имени
// отвечает «нет» — и весь цикл инструментов выключается: один запрос, ответ
// первого шага, `write_file` не исполняется. Живой профиль выглядит именно
// так: человек привязал ключ к модели из каталога. Отвечает всё равно
// файл-сценарий, запрос наружу не идёт.
const STUB_MODEL = 'z-ai/glm-5.3-flash'
function makeProfile (tag) {
  const dir = path.join(OUT, 'profile-' + tag)
  fs.mkdirSync(dir, { recursive: true })
  const folder = makeWorkspace(tag)
  const settings = path.join(dir, '1code-settings.json')
  fs.writeFileSync(settings, JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: SECRET_B64, modelId: STUB_MODEL, enabled: true }],
    defaultModel: STUB_MODEL,
    legacyStoragePurged: true,
    workspace: { path: folder, permission: 'acceptEdits' }
  }))
  own(settings)
  return { dir, folder, settings }
}

// ─── отчёт ─────────────────────────────────────────────────────────────────
const report = []
function line (group, name, pass, detail) {
  report.push({ group, name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  console.log((pass ? '  ok     ' : '  ПРОВАЛ ') + group + ' · ' + name
    + (detail === undefined ? '' : ' — ' + String(detail).replace(/\s+/g, ' ').slice(0, 220)))
}

function fragmentsIn (text) {
  return SECRET_FRAGMENTS.filter(piece => String(text).includes(piece))
}

function noSecret (text, where) {
  const hit = fragmentsIn(text)
  line('секрет', where + ': подставного ключа нет', hit.length === 0,
    hit.length ? 'осталось ' + hit.length + ' кусков: ' + JSON.stringify(hit.slice(0, 4)) : '')
  return hit.length === 0
}

function treeList (dir) {
  const out = []
  const walk = current => {
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch (error) { return }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(dir, full).split(path.sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

// Файлы, которые прогон кладёт сам и намеренно (профиль, сценарий модели), в
// поиск утечки не попадают: иначе краснела бы проверка харнесса.
function scanNewFiles (sinceMs, where) {
  const found = []
  const walk = current => {
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch (error) { return }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (harnessOwn.has(path.resolve(full))) continue
      let stat
      try { stat = fs.statSync(full) } catch (error) { continue }
      if (stat.mtimeMs < sinceMs || stat.size > 4 * 1024 * 1024) continue
      let bytes
      try { bytes = fs.readFileSync(full) } catch (error) { continue }
      const asUtf8 = bytes.toString('utf8')
      const asUtf16 = bytes.toString('utf16le')
      const hit = SECRET_FRAGMENTS.filter(piece => asUtf8.includes(piece) || asUtf16.includes(piece))
      if (hit.length) found.push(path.relative(OUT, full).split(path.sep).join('/') + ' → ' + hit.slice(0, 2).join(', '))
    }
  }
  walk(OUT)
  line('секрет', where + ': ни один файл прогона ключ не содержит', found.length === 0, found.join(' | '))
  return found
}

// ─── запуск CLI как процесса человека ───────────────────────────────────────
function cliCommand (args) {
  if (process.env.ONECODE_CLI_CMD) {
    const parts = JSON.parse(process.env.ONECODE_CLI_CMD)
    return { file: parts[0], args: parts.slice(1).concat(args) }
  }
  return { file: process.execPath, args: [ENTRY].concat(args) }
}

function cliArgs (request, opts) {
  const args = ['run', request]
  if (opts.noFolder !== true) {
    args.push('--folder', opts.missingFolder ? path.join(OUT, 'такой-папки-нет') : opts.folder)
  }
  args.push('--profile', opts.profileDir, '--log', opts.journal)
  if (opts.allowWrite) args.push('--allow-write')
  for (const extra of opts.extraArgs || []) args.push(extra)
  return args
}

function cliEnv (scenario, requests) {
  return guiEnv({
    ONECODE_PROVIDER_FILE: providerFile(scenario),
    ONECODE_PROVIDER_LOG: requests,
    ONECODE_EVIDENCE_DIR: EVIDENCE
  })
}

function requestCountOf (file) {
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
}

function runCli (name, request, opts = {}) {
  const profile = makeProfile(name)
  const journal = own(path.join(OUT, 'journal-' + name + '.jsonl'))
  const requests = path.join(OUT, 'requests-' + name + '.log')
  const args = cliArgs(request, {
    folder: profile.folder, profileDir: profile.dir, journal,
    noFolder: opts.noFolder, missingFolder: opts.missingFolder,
    allowWrite: opts.allowWrite, extraArgs: opts.extraArgs
  })
  acquireWindowLock()
  const started = Date.now() - 1000
  const cmd = cliCommand(args)
  const child = spawnSync(cmd.file, cmd.args, {
    cwd: ROOT, encoding: 'utf8', timeout: opts.timeout || 240000, env: cliEnv(opts.scenario || 'read', requests)
  })
  const failure = child.error ? String(child.error.message) : ''
  return {
    name, args, started, requests, journal, profileSettings: profile.settings,
    code: child.status, signal: String(child.signal || ''),
    stdout: child.stdout || '', stderr: (child.stderr || '') + failure,
    journalText: fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : '',
    requestCount: requestCountOf(requests),
    profileDir: profile.dir, folder: profile.folder
  }
}

// Ход, снятый извне: spawn + снятие всего дерева процессов. На Windows у
// node-ребёнка остаётся внучатый Electron, и без taskkill он дописывал бы
// профиль уже после того, как прогон решил, что ход снят.
function runCliKilled (name, request, opts = {}) {
  const profile = makeProfile(name)
  const journal = own(path.join(OUT, 'journal-' + name + '.killed.jsonl'))
  const requests = path.join(OUT, 'requests-' + name + '.log')
  const args = cliArgs(request, { folder: profile.folder, profileDir: profile.dir, journal })
  acquireWindowLock()
  const started = Date.now() - 1000
  const cmd = cliCommand(args)
  return new Promise(resolve => {
    const child = spawn(cmd.file, cmd.args, { cwd: ROOT, env: cliEnv(opts.scenario || 'slow', requests) })
    let stdout = ''
    let stderr = ''
    let killed = false
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { stderr += String(error.message || error) })
    const timer = setTimeout(() => {
      killed = true
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { encoding: 'utf8' })
      else child.kill('SIGKILL')
    }, opts.after || 4000)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        name, args, started, requests, journal, code, signal: String(signal || ''), killed,
        stdout, stderr,
        journalText: fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : '',
        requestCount: requestCountOf(requests),
        profileDir: profile.dir, folder: profile.folder
      })
    })
  })
}

// ─── прогон ────────────────────────────────────────────────────────────────
const SCENARIOS = ['чтение', 'запись без флага', 'запись с флагом', 'ошибка модели', 'нет --folder',
  'папки нет', 'неизвестный ключ', 'секрет', 'хранилище', 'снятый извне ход']
const results = []
const ready = {
  entry: fs.existsSync(ENTRY),
  electron: (() => {
    try { return fs.existsSync(String(electronBinary())) } catch (error) { return false }
  })()
}

function finish () {
  const failed = report.filter(item => !item.pass)
  console.log('\nИтог прогона 7.5: проверок ' + report.length + ', красных ' + failed.length + '. Улики: ' + EVIDENCE)
  if (failed.length) {
    console.log('КРАСНЫХ групп: ' + [...new Set(failed.map(item => item.group))].join(', '))
    if (!ready.entry) {
      console.log('Причина: точка входа ' + path.relative(ROOT, ENTRY).split(path.sep).join('/')
        + ' ещё не написана (пункт 7.5, тест до кода) — так и задумано.')
    }
  }
  settleRun(OUT, failed.length === 0)
  process.exitCode = failed.length === 0 ? 0 : 1
}

async function runEverything () {
  // 1. Чтение: ответ в stdout, код 0, в папке ни одного нового файла.
  const read = runCli('read', REQUEST_READ, { scenario: 'read' })
  results.push(read)
  line('чтение', 'код выхода = успех хода (0)', read.code === 0, 'код ' + read.code + ' ' + read.signal)
  line('чтение', 'ответ хода в stdout', read.stdout.includes(ANSWER_MARK), read.stdout)
  line('чтение', 'ход сделал запросы к модели', read.requestCount >= 1, 'запросов: ' + read.requestCount)
  line('чтение', 'журнал прогона создан по --log', fs.existsSync(read.journal), read.journal)
  const readTree = treeList(read.folder).join(',')
  line('чтение', 'в папке ни одного нового файла', readTree === 'notes.txt', readTree)
  noSecret(read.stdout, 'чтение stdout')
  noSecret(read.stderr, 'чтение stderr')
  noSecret(read.journalText, 'чтение журнал')

  // 2. Запись без флага: код 3, отказ назван, файла на диске нет.
  //    Профиль нарочно разрешает правки (acceptEdits): право записи обязана
  //    давать CLI, а не настройки рабочего каталога.
  const refused = runCli('write-refused', REQUEST_WRITE, { scenario: 'write' })
  results.push(refused)
  line('запись без флага', 'код выхода = WRITE_REFUSED (3)', refused.code === 3, 'код ' + refused.code)
  const refusalText = refused.stdout + refused.stderr
  line('запись без флага', 'отказ назван человеку строкой', /--allow-write/.test(refusalText), refusalText)
  line('запись без флага', 'отказ виден, а не проглочен молча', refusalText.trim().length > 20,
    'длина вывода ' + refusalText.trim().length)
  const refusedFile = path.join(refused.folder, 'otvet.md')
  line('запись без флага', 'файл не появился на диске', !fs.existsSync(refusedFile),
    fs.existsSync(refusedFile) ? 'otvet.md записан: ' + fs.readFileSync(refusedFile, 'utf8').slice(0, 60) : 'папка чистая')
  noSecret(refused.stdout, 'запись без флага stdout')
  noSecret(refused.stderr, 'запись без флага stderr')
  noSecret(refused.journalText, 'запись без флага журнал')

  // 3. Запись с флагом: тот же сценарий доходит до файла, код 0.
  const allowed = runCli('write-allowed', REQUEST_WRITE, { scenario: 'write', allowWrite: true })
  results.push(allowed)
  const written = path.join(allowed.folder, 'otvet.md')
  line('запись с флагом', 'код выхода = успех хода (0)', allowed.code === 0, 'код ' + allowed.code)
  line('запись с флагом', 'ход сделал запись в рабочую папку', fs.existsSync(written),
    fs.existsSync(written) ? fs.readFileSync(written, 'utf8').slice(0, 60) : 'otvet.md нет')
  noSecret(allowed.stdout, 'запись с флагом stdout')
  noSecret(allowed.journalText, 'запись с флагом журнал')

  // 4. Ошибка модели: код 1, причина названа, ключа в выводе нет.
  const broken = runCli('model-error', REQUEST_READ, { scenario: 'broken' })
  results.push(broken)
  line('ошибка модели', 'код выхода = TURN_FAILED (1)', broken.code === 1, 'код ' + broken.code)
  line('ошибка модели', 'причина названа человеку', /401|отклон|ошибк|не ответ/i.test(broken.stdout + broken.stderr),
    broken.stdout + broken.stderr)
  noSecret(broken.stdout, 'ошибка модели stdout')
  noSecret(broken.stderr, 'ошибка модели stderr')
  noSecret(broken.journalText, 'ошибка модели журнал')

  // 5. Нет --folder: код 2, ядро не дёрнулось ни разу.
  const noFolder = runCli('no-folder', REQUEST_READ, { noFolder: true })
  results.push(noFolder)
  line('нет --folder', 'код выхода = BAD_INPUT (2)', noFolder.code === 2, 'код ' + noFolder.code)
  line('нет --folder', 'ход ядра не запускался', noFolder.requestCount === 0, 'запросов: ' + noFolder.requestCount)
  line('нет --folder', 'подсказка по-русски и с именем ключа',
    /--folder/.test(noFolder.stdout + noFolder.stderr) && /[а-яё]/i.test(noFolder.stdout + noFolder.stderr),
    noFolder.stdout + noFolder.stderr)

  // 6. Папки нет на диске: тот же исход, без обращения к модели.
  const missing = runCli('no-such-folder', REQUEST_READ, { missingFolder: true })
  results.push(missing)
  line('папки нет', 'код выхода = BAD_INPUT (2)', missing.code === 2, 'код ' + missing.code)
  line('папки нет', 'ход ядра не запускался', missing.requestCount === 0, 'запросов: ' + missing.requestCount)
  line('папки нет', 'человеку названа папка', /такой-папки-нет/.test(missing.stdout + missing.stderr),
    missing.stdout + missing.stderr)

  // 7. Неизвестный ключ: код 2 до запуска хода.
  const unknown = runCli('unknown-flag', REQUEST_READ, { extraArgs: ['--max-tokens', '10'] })
  results.push(unknown)
  line('неизвестный ключ', 'код выхода = BAD_INPUT (2)', unknown.code === 2, 'код ' + unknown.code)
  line('неизвестный ключ', 'имя ключа названо в подсказке', /--max-tokens/.test(unknown.stdout + unknown.stderr),
    unknown.stdout + unknown.stderr)
  line('неизвестный ключ', 'ход ядра не запускался', unknown.requestCount === 0, 'запросов: ' + unknown.requestCount)

  // 8. Граница хранилища: файлы профиля после CLI против файлов после того же
  //    хода из окна. Лишнее значит, что CLI завёл своё хранилище.
  const baseline = makeProfile('baseline')
  const script = path.join(OUT, 'baseline.js')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const problems = []
    const until = async (fn, ms = 90000) => {
      const stop = Date.now() + ms
      while (Date.now() < stop) {
        try { if (fn()) return true } catch (error) { problems.push(String(error.message || error)) }
        await wait(150)
      }
      return false
    }
    await until(() => document.documentElement.dataset.appReady === '1')
    await wait(400)
    $('newChatBtn')?.click(); await wait(400)
    const box = $('composerTextarea')
    box.value = ${JSON.stringify(REQUEST_READ)}
    box.dispatchEvent(new Event('input', { bubbles: true })); await wait(150)
    $('composerForm').requestSubmit()
    const said = await until(() => $('messagesList').innerText.includes(${JSON.stringify(ANSWER_MARK)}))
    await wait(1500)
    return { ok: said, checks: [{ label: 'ход из чата дошёл до ответа', pass: said,
      detail: $('messagesList').innerText.replace(/\\s+/g, ' ').slice(0, 160) + ' | ' + problems.slice(0, 2).join('; ') }] }
  })()`)
  own(script)
  const resultFile = own(path.join(OUT, 'baseline.json'))
  const gui = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + baseline.dir], {
      cwd: ROOT, encoding: 'utf8', timeout: 240000,
      env: guiEnv({
        ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1',
        ONECODE_PROVIDER_FILE: providerFile('read'),
        ONECODE_PROVIDER_LOG: path.join(OUT, 'requests-baseline.log'),
        ONECODE_SHOT: path.join(OUT, 'baseline.png')
      })
    })
  let baselineOk = false
  let baselineChecks = []
  if (fs.existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      baselineOk = parsed.ok !== false
      baselineChecks = parsed.checks || []
    } catch (error) {
      baselineChecks = [{ label: 'отчёт окна читается', pass: false, detail: String(error.message || error) }]
    }
  }
  line('хранилище', 'baseline-окно отработало тот же ход', baselineOk && fs.existsSync(resultFile),
    'status ' + gui.status + ' | ' + baselineChecks.map(item => item.label + '=' + (item.pass ? 'ok' : 'ПРОВАЛ')).join(', '))
  const appFiles = treeList(baseline.dir)
  const cliFiles = treeList(read.profileDir)
  const extra = cliFiles.filter(name => !appFiles.includes(name) && name !== '1code-settings.json')
  line('хранилище', 'CLI не заводит своих файлов в профиле', extra.length === 0,
    extra.length ? 'лишнее: ' + extra.slice(0, 8).join(', ') : 'новых против приложения: 0 из ' + cliFiles.length)
  const settingsText = fs.readFileSync(read.profileSettings, 'utf8')
  line('хранилище', 'в профиле после прогона нет открытого ключа', fragmentsIn(settingsText).length === 0,
    fragmentsIn(settingsText).slice(0, 3).join(', ') || 'конверт на месте')
  line('хранилище', 'профиль тот же: ключ не переписан и не удвоен',
    JSON.parse(settingsText).openrouterKeys.length === 1,
    'записей ключа: ' + JSON.parse(settingsText).openrouterKeys.length)

  // 9. Снятый извне ход не выдаёт успех. (Код 4 по Ctrl+C меряется руками —
  //    см. шапку файла; здесь меряется, что молчаливого «0» не бывает.)
  const killed = await runCliKilled('killed', REQUEST_READ, { scenario: 'slow', after: 4000 })
  results.push(killed)
  line('снятый извне ход', 'прогон был прерван, а не дошёл', killed.killed && killed.code !== 0,
    'код ' + killed.code + ', сигнал ' + killed.signal)
  line('снятый извне ход', 'успех не объявлен без ответа', !killed.stdout.includes(ANSWER_MARK), killed.stdout)

  // 10. Ни один файл, появившийся за прогон, ключа не содержит.
  scanNewFiles(read.started, 'все прогоны')

  // Улики: расшифровка каждого спавна, журналы, отчёт и кадр baseline.
  fs.mkdirSync(EVIDENCE, { recursive: true })
  for (const item of results) {
    const transcript = [
      '$ ' + path.relative(ROOT, ENTRY).split(path.sep).join('/') + ' ' + item.args.join(' '),
      'КОД ВЫХОДА: ' + item.code + (item.signal ? ' (сигнал ' + item.signal + ')' : ''),
      'ЗАПРОСОВ К МОДЕЛИ: ' + item.requestCount,
      '--- stdout ---', item.stdout,
      '--- stderr ---', item.stderr,
      '--- журнал ---', item.journalText
    ].join('\n')
    fs.writeFileSync(path.join(EVIDENCE, 'transcript-' + item.name + '.txt'), transcript)
    if (fs.existsSync(item.journal)) fs.copyFileSync(item.journal, path.join(EVIDENCE, 'journal-' + item.name + '.jsonl'))
  }
  if (fs.existsSync(path.join(OUT, 'baseline.png'))) {
    fs.copyFileSync(path.join(OUT, 'baseline.png'), path.join(EVIDENCE, 'baseline.png'))
  }
  fs.writeFileSync(path.join(EVIDENCE, 'cli-run-report.json'), JSON.stringify(report, null, 2))
}

if (!ready.entry) {
  const reason = 'точка входа «' + path.relative(ROOT, ENTRY).split(path.sep).join('/') + '» ещё не написана (пункт 7.5)'
  for (const scenario of SCENARIOS) line(scenario, reason, false)
  console.log('Спавны не выполнялись: без точки входа прогон висел бы на отсутствующем модуле.')
  finish()
} else if (!ready.electron) {
  const blocked = 'BLOCKED: бинарный Electron в node_modules ещё не догружен — оконная часть не исполнена'
  for (const scenario of SCENARIOS) line(scenario, blocked, false, 'проверка написана, ждёт готового node_modules')
  finish()
} else {
  runEverything().then(finish)
}
