'use strict'

// ---------------------------------------------------------------------------
// Пункт 7.5 «Своя CLI» — КРАСНЫЙ набор. Написан ДО продуктового кода.
//
// Требование владельца (29.09):
//   `onlyone run "<просьба>" --folder <путь>`; без `--allow-write` только
//   чтение; ключи из того же зашифрованного профиля, в выводе и журналах ключей
//   нет; код выхода = исход хода. Тест до кода на подставной модели.
//
// Набор меряет ПОВЕДЕНИЕ и коды выхода, а не то, как реализатор до них дошёл.
// Как именно модуль узнаёт о существовании папки, как именно он зовёт ядро и
// как именно bootstrap поднимает Electron — его дело. Здесь заморожено только
// имя и форма публичной поверхности, потому что по ней пункт принимает человек.
//
// ─── Публичный контракт, который требует этот набор ──────────────────────────
//
// Точка входа: `src/cli/onlyone.cjs` — CommonJS, `module.exports`, `'use strict'`.
// В ТЕЛЕ — ни файловой системы, ни процессов, ни сети, ни Electron: всё через
// внедрённые зависимости (образцы чистоты в этом дереве —
// `src/main/design/task.js` и `src/renderer/ultra-blocks.js`). Первая проверка
// грузит модуль в песочнице, где `require('fs')`, `require('child_process')`,
// `require('http')` и `require('electron')` бросают ошибку: если модуль дожил до
// вызова `createCli(deps).run(...)` — значит диск он не трогал.
//
// Экспорт:
//   parseArgs(argv)   → { command, request, folder, allowWrite, profile, log, error }
//                       argv — уже срезанные пользовательские слова
//                       (`process.argv.slice(2)`), первое из них — команда.
//                       `error` — строка ПОДСКАЗКИ человеку по-русски либо null.
//   EXIT              = Object.freeze({ OK: 0, TURN_FAILED: 1, BAD_INPUT: 2,
//                       WRITE_REFUSED: 3, ABORTED: 4 })
//   toolsFor(bool)    → [имена инструментов] — что разрешено ходу ядра.
//   outcomeOf(turn)   → { code, answer } — по тому, что вернул ход.
//   lineFor(outcome)  → строка, которую печатать в stdout.
//   redact(text, secrets) → строка, в которой нет ни секрета, ни его частей.
//   createCli(deps)   → { run(argv) → { code } | Promise<{ code }> }
//
// `turn` — то, что отдаёт ядро, плюс один знак от самого CLI. Измерено прогоном
// окна (профиль с реальным ключом-заглушкой, `ONECODE_PROVIDER_FILE`):
//   успех        → `{ ok: true, mode, stages, content, execution }`
//   отказ плана  → `{ ok: false, incomplete: true, content }`, а в ИСТОРИИ
//                  ВЫЗОВОВ (`agent-tool-log`) пишущий инструмент с `ok: false`;
//                  поля `denied` в ответе хода НЕТ — `denied: true` живёт в
//                  результате инструмента (`planModeRefusal` в main.js) и наружу
//                  через `send-message` не выходит.
//   сбой ключа   → `{ ok: false, error, content, execution: { state: 'failed' } }`
// Поэтому код выхода CLI решает по знакам, а не по формулировкам:
//   { ok: true, content }            → OK
//   { ok: false } | { error }        → TURN_FAILED
//   { aborted: true }                → ABORTED        (важнее и ok, и error)
//   { denied: true }                 → WRITE_REFUSED  (важнее ok, но не отмены)
//   { readOnly: true, tools: [писавший и не сумевший] }
//                                    → WRITE_REFUSED  (то же самое без готового
//                                      знака: CLI сам знает, что дал ходу только
//                                      чтение, и видит вызовы инструмента)
//
// deps для `createCli` (имена обязательны; лишние — можно):
//   readProfile()          → содержимое ТОГО ЖЕ зашифрованного профиля, что у
//                           приложения (decrypted значения ключей уже внутри)
//   writeProfile(body)     → единственный способ что-либо положить в профиль
//   folderExists(path)     → есть ли папка на диске
//   runTurn(payload)       → один ход ядра, отдаёт `turn`
//   out(text), err(text)   → единственный канал человеку
//   log(entry)             → журнал прогона (строка или объект)
//   t(text)                → перевод строки, которую увидит человек
//   now(), cwd(), env, homeDir, profileDir — окружение прогона
//
// Чего набор СОЗНАТЕЛЬНО НЕ ТРЕБУЕТ: порядка чтения настроек, формы payload для
// ядра, имени файла-проводчика bootstrap, способа поднять Electron, формата
// журнала, формулировок подсказок (кроме названных слов-обязательств),
// наличия `--help` и `--version`.
//
// Все секреты в наборе выдуманы. Сети, настоящих ключей и живых обращений к модели
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const MODULE_FILE = process.env.ONECODE_CLI_MODULE || 'src/cli/onlyone.cjs'
const MODULE_PATH = path.isAbsolute(MODULE_FILE) ? MODULE_FILE : path.join(ROOT, MODULE_FILE)
// Все секреты в наборе выдуманы: ни сети, ни настоящих ключей, ни живых
// обращений к модели здесь нет, но форма значения — как у настоящих.
const SECRET_PREFIX = 'ONECODE_'
const FAKE_SECRET = 'ONECODE_AQ7z2Lm4Xd9Rt6Yb1Nc8Vk3Hf5Gs0JpMjQ='
const FAKE_SECRETupper = FAKE_SECRET.toUpperCase()

const EXPECTED_API = ['parseArgs', 'toolsFor', 'outcomeOf', 'lineFor', 'redact', 'createCli']
const EXIT_WANTED = { OK: 0, TURN_FAILED: 1, BAD_INPUT: 2, WRITE_REFUSED: 3, ABORTED: 4 }
const DEPS_REQUIRED = ['readProfile', 'writeProfile', 'folderExists', 'runTurn', 'out', 'err', 'log', 't']

// Строка ответа из настоящего прогона окна (main.js:9646), где все запросы
// хода упали с 401. Нужна здесь затем, чтобы ни одна проверка не научилась
// объявлять успех по одному лишь непустому ответу: текст есть, а результата
// нет.
const EMPTY_ANSWER = 'Модель ничего не вернула: модель завершила ход без ответа ' +
  '(finish_reason: stop). Попробуйте ещё раз или смените модель.'

// Пишущий класс: удаление, запись, выполнение команд, изменение настроек.
// Имена взяты из ядра (`src/main/main.js`, реестр инструментов хода).
const MUTATING_TOOLS = ['write_file', 'create_directory', 'move_path', 'delete_path', 'run_command',
  'define_tool', 'add_mcp_server', 'add_skill', 'update_skill', 'delete_skill', 'toggle_skill',
  'update_artifact', 'dc_write', 'dc_set_entry', 'browse_click', 'browse_input', 'project_note',
  'project_topic_set', 'project_plan_set']
// Читающий класс обязан остаться в прогоне: без него CLI бесполезен.
const READING_REQUIRED = ['read_file', 'list_files', 'search_files', 'fetch_url']

// ---------------------------------------------------------------------------
// Два факта из дерева, на которые опираются проверки (читаются, а не переписываются)
// ---------------------------------------------------------------------------

const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8')
const checkpointsSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'run-checkpoints.js'), 'utf8')

// Единственный в дереве список «это только чтение» — `READ_ONLY_TOOLS` в
// run-checkpoints.js (им же пользуется ядро, решая, что писать в журнал). CLI
// не вправе придумывать себе более мягкий список.
const readOnlyMatch = checkpointsSrc.match(/const READ_ONLY_TOOLS = new Set\(\[([\s\S]*?)\]\)/)
const READ_ONLY_TOOLS = new Set(readOnlyMatch
  ? (readOnlyMatch[1].match(/'([^']+)'/g) || []).map(text => text.slice(1, -1)) : [])

// Вселенная инструментов, которые вообще существуют в приложении: реестр хода
// в main.js + declarations of the Design engine (`schema('dc_…')`) + lists in
// agent-quality.js. CLI не имеет права обещать инструмент, которого нет.
const toolSourceFiles = ['src/main/main.js', 'src/main/design/tools.js', 'src/main/agent-quality.js',
  'src/main/run-checkpoints.js', 'src/main/command-runner.js']
const KNOWN_TOOLS = new Set()
for (const name of toolSourceFiles) {
  const file = path.join(ROOT, ...name.split('/'))
  if (!fs.existsSync(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(/\bname:\s*'([a-z0-9_]+)'/g)) KNOWN_TOOLS.add(m[1])
  for (const m of text.matchAll(/\bschema\(\s*'([a-z0-9_]+)'/g)) KNOWN_TOOLS.add(m[1])
  for (const m of text.matchAll(/\bdc_[a-z_]+\b/g)) KNOWN_TOOLS.add(m[0])
  for (const m of text.matchAll(/'([a-z][a-z0-9_]{3,})'/g)) if (/^(own_|mcp__)/.test(m[1])) KNOWN_TOOLS.add(m[1])
}

// ---------------------------------------------------------------------------
// Харнесс
// ---------------------------------------------------------------------------

let total = 0
let failed = 0
let redForMissingModule = 0
const queue = []

function check (name, fn) { queue.push({ name, fn }) }

const norm = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
const rel = file => path.relative(ROOT, file).split(path.sep).join('/')
const oneLine = error => norm((error && error.message) ? error.message : String(error))

// Списки, собранные ИЗ ПЕСОЧНИЦЫ, нельзя сверять через assert.deepEqual:
// строгое сравнение смотрит и прототип, а у массива из vm он другого realm —
// и пустой список краснел бы как непустой. Меряем длину и содержимое явно.
function noItems (list, message) {
  assert.equal(Array.isArray(list), true, message + ' (это не список)')
  assert.equal(list.length, 0, message + ': ' + list.join(', '))
}

// Куски секрета, которые запрещены в выводе: целое значение, все окна по 8
// символов ПОСЛЕ префикса формата (сам префикс — не секрет: secret-mask.js в
// ядре открыто бережёт общий префикс вроде `sk-or-v1`), и хвосты 4/6/8/10/12 —
// именно так живой сервер сокращает ключ в объяснении.
function secretFragments (secret = FAKE_SECRET, prefix = SECRET_PREFIX) {
  const out = [secret]
  for (let i = prefix.length; i + 8 <= secret.length; i++) out.push(secret.slice(i, i + 8))
  for (const size of [4, 6, 8, 10, 12]) if (secret.length >= size) out.push(secret.slice(-size))
  return [...new Set(out.filter(piece => piece.length >= 4))]
}
const FRAGMENTS = secretFragments()

// ─── мягкая загрузка модуля ──────────────────────────────────────────────────
// Красный набор обязан краснеть ПОВЕДЕНИЕМ и называть причину, а не падать
// молча и не превращаться в «зелёный» прогон, где ничего не проверено.
function missingReason () {
  return `файл «${rel(MODULE_PATH)}» ещё не написан (пункт 7.5: своя CLI — \`onlyone run\`)`
}

function loadModule () {
  if (!fs.existsSync(MODULE_PATH)) return { ok: false, reason: missingReason() }
  try {
    return { ok: true, instance: cleanInstance({}) }
  } catch (error) {
    return { ok: false, reason: `«${rel(MODULE_PATH)}» не подключается чистым node: ${oneLine(error)}` }
  }
}

const FORBIDDEN_REQUIRE = ['fs', 'node:fs', 'os', 'node:os', 'child_process', 'node:child_process',
  'electron', 'http', 'node:http', 'https', 'node:https', 'net', 'dns', 'worker_threads',
  'node:worker_threads', 'fs/promises', 'node:fs/promises']

// Инстанс модуля в песочнице без диска. `probe.spy` (если передан) собирает
// признаки того, что модуль всё-таки полез руками в процесс: console,
// process.stdout, process.exit. Без probe песочница просто грузит модуль.
function cleanInstance (probe) {
  const spy = (probe && probe.spy) || {}
  const cwdValue = (probe && probe.cwdValue) || 'D:/onlyone-cli-7-5/ws'
  const code = fs.readFileSync(MODULE_PATH, 'utf8')
  const mod = { exports: {} }
  const guardedRequire = name => {
    const key = String(name)
    if (FORBIDDEN_REQUIRE.includes(key)) {
      throw new Error(`ЧИСТОТА: модуль зовёт require('${key}') — в теле чистого модуля 7.5 `
        + 'файловой системы, процессов и Electron быть не должно; всё идёт через deps')
    }
    return require(key)
  }
  const recordStdio = (where, chunk) => {
    if (spy.stdio) spy.stdio.push({ where, text: String(chunk) })
    throw new Error(`ЧИСТОТА: модуль пишет в process.${where} напрямую — человеку текст обязан `
      + 'отдавать deps.out/deps.err, иначе набор не измерит вывод в байтах')
  }
  const sandbox = {
    require: guardedRequire,
    module: mod,
    exports: mod.exports,
    __filename: MODULE_PATH,
    __dirname: path.dirname(MODULE_PATH),
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Intl,
    Date,
    Math,
    JSON,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    setImmediate: fn => setImmediate(fn),
    console: {
      log: (...args) => { if (spy.console) spy.console.push(args.map(String).join(' ')) },
      info: (...args) => { if (spy.console) spy.console.push(args.map(String).join(' ')) },
      debug: (...args) => { if (spy.console) spy.console.push(args.map(String).join(' ')) },
      warn: (...args) => { if (spy.console) spy.console.push(args.map(String).join(' ')) },
      error: (...args) => { if (spy.console) spy.console.push(args.map(String).join(' ')) }
    },
    process: {
      env: {},
      argv: [],
      platform: 'win32',
      version: process.version,
      cwd: () => cwdValue,
      exit: code => {
        if (spy.exit) spy.exit.push(code)
        throw new Error('ЧИСТОТА: чистый модуль не зовёт process.exit — код обязан вернуть '
          + 'run(argv), а выходить из процесса вправе только bootstrap')
      },
      on: () => {},
      once: () => {},
      nextTick: fn => setTimeout(fn, 0),
      stdout: { write: chunk => recordStdio('stdout', chunk), isTTY: false },
      stderr: { write: chunk => recordStdio('stderr', chunk), isTTY: false }
    }
  }
  vm.runInNewContext(code, sandbox, { filename: MODULE_PATH })
  return { exports: mod.exports, spy }
}

const LOADED = loadModule()

function need () {
  if (!LOADED.ok) throw new Error(LOADED.reason)
  return LOADED.instance.exports
}

// Заглушка на случай отсутствия контракта: каждый метод бросает причину, чтобы
// ни одна проверка не могла «пройти» на пустом месте.
function contractStub (reason) {
  const stub = { EXIT: new Proxy({}, { get: () => { throw new Error('НЕТ КОНТРАКТА: ' + reason) } }) }
  for (const name of EXPECTED_API) stub[name] = () => { throw new Error('НЕТ КОНТРАКТА: ' + reason) }
  return stub
}

// ─── подставные deps ────────────────────────────────────────────────────────
// Форма профиля намеренно ИЗБЫТОЧНА: набор не решает, откуда читать ключ
// (`keyEncrypted`, `key`, `value`, `raw` — на выбор реализации). Требование
// одно: ни один из этих байт не имеет права выйти в out/err/log.
const FOLDER = 'D:/onlyone-cli-7-5/ws'
const REQUEST = 'Прочитай notes.txt и назови слово'
const SETTINGS_B64 = Buffer.from(FAKE_SECRET, 'utf8').toString('base64')

function fakeProfile (folder) {
  const record = { id: 'key-1', name: 'Тест', keyEncrypted: SETTINGS_B64, key: FAKE_SECRET, value: FAKE_SECRET, raw: FAKE_SECRET }
  return {
    openrouterKeys: [record],
    keys: [record],
    defaultModel: 'test/model',
    workspace: { path: folder, permission: 'manual' },
    legacyStoragePurged: true,
    apiKey: FAKE_SECRET
  }
}

function makeScenario (opts = {}) {
  if (!fs.existsSync(MODULE_PATH)) throw new Error(missingReason())
  const spy = {
    readProfile: 0,
    writeProfile: [],
    runTurnCalls: [],
    existsCalls: [],
    logEntries: [],
    out: [],
    err: [],
    t: [],
    console: [],
    exit: [],
    stdio: []
  }
  const folder = opts.folder === undefined ? FOLDER : opts.folder
  const turn = opts.turn === undefined ? { ok: true, content: 'Готово: в файле слово «пальма».' } : opts.turn
  const instance = cleanInstance({ spy, cwdValue: folder })

  const runTurn = async payload => {
    spy.runTurnCalls.push(payload)
    if (turn instanceof Error) throw turn
    if (typeof turn === 'function') return await turn(payload)
    if (turn && typeof turn.then === 'function') return await turn
    return turn
  }
  const exists = p => { spy.existsCalls.push(String(p)); return opts.folderExists !== false }

  const deps = {
    readProfile: () => { spy.readProfile++; return opts.profile === undefined ? fakeProfile(folder) : opts.profile },
    writeProfile: body => { spy.writeProfile.push(body) },
    folderExists: exists,
    // Терпимость к имени: требование — «спросить разрешение папки через deps»,
    // а не точное слово в подписи.
    statPath: exists,
    pathExists: exists,
    runTurn,
    turn: runTurn,
    startTurn: runTurn,
    out: text => spy.out.push(String(text)),
    err: text => spy.err.push(String(text)),
    log: entry => spy.logEntries.push(entry),
    t: text => { spy.t.push(String(text)); return 'EN:' + text },
    now: () => 1700000000000,
    cwd: () => folder,
    env: {},
    homeDir: () => 'C:/Users/test',
    profileDir: 'D:/onlyone-cli-7-5/profile',
    os: 'Windows_NT'
  }
  // Лишних deps набор не запрещает: если модуль спросит что-то своё, он получит
  // `undefined` и краснота будет внятной, а не «Cannot read property».
  return { cli: instance.exports, deps, spy, folder }
}

// Все байты, которые CLI показал человеку или положил в журнал.
function outputBytes (spy) {
  const parts = []
  for (const text of spy.out) parts.push(text)
  for (const text of spy.err) parts.push(text)
  for (const entry of spy.logEntries) {
    parts.push(typeof entry === 'string' ? entry : JSON.stringify(entry))
  }
  for (const item of spy.stdio) parts.push(item.text)
  for (const item of spy.console) parts.push(item)
  return parts.join('\n')
}

// Any array of tool names that reached the kernel, shape-agnostic.
function toolArraysIn (value) {
  const found = []
  const walk = node => {
    if (Array.isArray(node)) {
      if (node.length && node.every(item => typeof item === 'string')) found.push(node)
      for (const item of node) walk(item)
    } else if (node && typeof node === 'object') {
      for (const item of Object.values(node)) walk(item)
    }
  }
  walk(value)
  return found
}

function callDump (scenario) {
  const spy = scenario && scenario.spy ? scenario.spy : scenario
  const safe = []
  for (const call of spy.runTurnCalls) {
    try { safe.push(JSON.parse(JSON.stringify(call))) } catch (error) { safe.push(String(oneLine(error))) }
  }
  return { text: JSON.stringify(safe), arrays: toolArraysIn(spy.runTurnCalls) }
}

function argv (...parts) { return ['run', ...parts] }

async function codeOfRun (scenario, argv) {
  const cli = scenario.cli
  assert.equal(typeof cli.createCli, 'function', 'нет createCli(deps) — точка сборки CLI не названа')
  const api = cli.createCli(scenario.deps)
  assert.ok(api && typeof api.run === 'function', 'createCli(deps) не вернул { run(argv) }')
  const result = await api.run(argv)
  assert.ok(result && Number.isInteger(result.code), `run(argv) не вернул { code }: ${JSON.stringify(result)}`)
  return result
}

// ---------------------------------------------------------------------------
// 0. Опорные проверки: набор не пустой и краснеет по причине, а не молча
// ---------------------------------------------------------------------------

check('набор краснеет причиной, а не молча проходит без модуля', () => {
  const reason = missingReason()
  const stub = contractStub(reason)
  assert.match(reason, /ещё не написан/)
  for (const name of EXPECTED_API) {
    assert.throws(() => stub[name]('что угодно'), /НЕТ КОНТРАКТА/, `${name} на заглушке не бросается`)
  }
  assert.throws(() => stub.EXIT.OK, /НЕТ КОНТРАКТА/)
})

check('читающий класс приложения, на который сверяются проверки, непустой', () => {
  assert.ok(READ_ONLY_TOOLS.size >= 15, `READ_ONLY_TOOLS не вычитался из run-checkpoints.js: ${READ_ONLY_TOOLS.size}`)
  for (const name of ['read_file', 'list_files', 'search_files', 'fetch_url']) {
    assert.ok(READ_ONLY_TOOLS.has(name), `в читающем классе ядра нет ${name} — сверка была бы пустой`)
  }
})

check('пишущие инструменты, запрещаемые набором, правда живут в ядре', () => {
  const absent = MUTATING_TOOLS.filter(name => !KNOWN_TOOLS.has(name) && !/^dc_/.test(name))
  assert.deepEqual(absent, [], `набор запрещает имена, которых нет в ядре: ${absent.join(', ')}`)
  assert.ok(KNOWN_TOOLS.has('write_file') && KNOWN_TOOLS.has('run_command') && KNOWN_TOOLS.has('delete_path'))
})

check('подставной секрет годен для измерения утечки', () => {
  assert.ok(FAKE_SECRET.length >= 32, 'секрет слишком короткий — окна по 8 символов не наберутся')
  assert.ok(FRAGMENTS.length >= 20, `кусков секрета для замера мало: ${FRAGMENTS.length}`)
  assert.ok(FRAGMENTS.some(piece => /=/.test(piece)), 'в замере не участвует base64-хвост')
})

// ---------------------------------------------------------------------------
// 1. Подключение и публичная поверхность
// ---------------------------------------------------------------------------

check('модуль подключается чистым node без диска, процессов и Electron', () => {
  need()
})

check('публичная поверхность названа', () => {
  const cli = need()
  for (const name of EXPECTED_API) assert.equal(typeof cli[name], 'function', `нет экспорта ${name}()`)
  assert.equal(typeof cli.EXIT, 'object', 'нет экспорта EXIT')
})

check('EXIT — таблица кодов выхода с замороженными значениями', () => {
  const cli = need()
  // Пять обещанных имён обязаны стоять с обещанными числами; алиасы
  // (USAGE, DENIED) реализатору не запрещаются — это не часть контракта.
  for (const name of Object.keys(EXIT_WANTED)) {
    assert.equal(cli.EXIT[name], EXIT_WANTED[name], `EXIT.${name} обязан быть ${EXIT_WANTED[name]}`)
  }
  assert.ok(Object.isFrozen(cli.EXIT), 'EXIT можно переписать на ходу')
})

// ---------------------------------------------------------------------------
// 2. parseArgs
// ---------------------------------------------------------------------------

check('parseArgs: run "<просьба>" --folder <путь>', () => {
  const parsed = need().parseArgs(argv(REQUEST, '--folder', FOLDER))
  assert.equal(parsed.command, 'run')
  assert.equal(parsed.request, REQUEST, 'просьба исказилась при разборе')
  assert.equal(parsed.folder, FOLDER)
  assert.equal(parsed.allowWrite, false, 'без --allow-write запись не может быть включена')
  assert.ok(!parsed.error, `разбор живой команды вернул ошибку: ${parsed.error}`)
})

check('parseArgs: --allow-write включает запись', () => {
  const parsed = need().parseArgs(argv(REQUEST, '--folder', FOLDER, '--allow-write'))
  assert.equal(parsed.allowWrite, true)
  assert.ok(!parsed.error)
})

check('parseArgs: --profile переключает каталог userData', () => {
  const parsed = need().parseArgs(argv(REQUEST, '--folder', FOLDER, '--profile', 'D:/onlyone-cli-7-5/profile'))
  assert.equal(parsed.profile, 'D:/onlyone-cli-7-5/profile')
  assert.ok(!parsed.error)
})

check('parseArgs: --log задаёт файл журнала прогона', () => {
  const parsed = need().parseArgs(argv(REQUEST, '--folder', FOLDER, '--log', 'D:/onlyone-cli-7-5/out/journal.jsonl'))
  assert.equal(parsed.log, 'D:/onlyone-cli-7-5/out/journal.jsonl')
  assert.ok(!parsed.error)
})

check('parseArgs: просьба сохраняется байт в байт (кириллица, пробелы, кавычки)', () => {
  const tricky = '  Собери «отчёт» по test-run.cjs   и назови причину   '
  const parsed = need().parseArgs(argv(tricky, '--folder', FOLDER))
  assert.ok(String(parsed.request).includes('Собери «отчёт» по test-run.cjs'), `просьба потерялась: ${parsed.request}`)
  assert.ok(String(parsed.request).includes('назови причину'), `хвост просьбы отрезан: ${parsed.request}`)
})

check('parseArgs: форма --folder=<путь> разбирается так же', () => {
  const parsed = need().parseArgs(argv(REQUEST, `--folder=${FOLDER}`, '--allow-write'))
  assert.equal(parsed.folder, FOLDER, `--folder=… не разобрался: ${parsed.folder}`)
  assert.equal(parsed.allowWrite, true)
  assert.ok(!parsed.error, `разбор формы с «=” вернул ошибку: ${parsed.error}`)
})

check('parseArgs: без просьбы — подсказка по-русски, а не запуск хода', () => {
  const parsed = need().parseArgs(['run', '--folder', FOLDER])
  assert.ok(parsed.error, 'пустая просьба обязана дать error, а не молча собрать ход')
  assert.ok(!parsed.request || !String(parsed.request).trim(), `request придуман: ${parsed.request}`)
})

check('parseArgs: без --folder — подсказка по-русски, а не запуск хода', () => {
  const parsed = need().parseArgs(['run', REQUEST])
  assert.ok(parsed.error, 'run без --folder обязан вернуть error')
  assert.match(String(parsed.error), /--folder/, 'человеку не подсказано, чего не хватает')
})

check('parseArgs: --folder без значения — error', () => {
  const parsed = need().parseArgs(argv(REQUEST, '--folder'))
  assert.ok(parsed.error, 'ключ без значения не может молча означать «папкой считается следующее слово»')
})

check('parseArgs: --profile без значения — error', () => {
  const parsed = need().parseArgs(argv(REQUEST, '--folder', FOLDER, '--profile'))
  assert.ok(parsed.error, 'ключ без значения обязан быть BAD_INPUT, а не «профиль пустой»')
})

check('parseArgs: неизвестный ключ — error, и в нём назван сам ключ', () => {
  const parsed = need().parseArgs(argv(REQUEST, '--folder', FOLDER, '--max-tokens', '10'))
  assert.ok(parsed.error, 'неизвестный ключ не может означать «не вижу»')
  assert.match(String(parsed.error), /--max-tokens/, 'в подсказке нет имени непринятого ключа')
})

check('parseArgs: лишние позиционные слова не теряются молча', () => {
  const parsed = need().parseArgs(['run', 'найди', 'ошибки', 'в', 'коде', '--folder', FOLDER])
  const joined = String(parsed.request || '')
  if (!parsed.error) {
    assert.ok(joined.includes('найди') && joined.includes('коде'),
      `часть просьбы потерялась: request=«${joined}», error=«${parsed.error}»`)
  }
})

check('parseArgs: неизвестная команда — error с подсказкой про run', () => {
  const parsed = need().parseArgs(['talk', REQUEST, '--folder', FOLDER])
  assert.ok(parsed.error, 'неизвестная команда обязана быть BAD_INPUT')
  assert.match(String(parsed.error), /run/, 'человеку не показано, как надо писать')
})

check('parseArgs: подсказки — русская речь, без undefined и NaN', () => {
  const cli = need()
  const bad = [
    ['run'],
    ['run', '', '--folder', FOLDER],
    ['run', REQUEST],
    ['run', REQUEST, '--folder'],
    ['run', REQUEST, '--folder', FOLDER, '--unknown'],
    ['nope', REQUEST]
  ]
  for (const args of bad) {
    const error = String(cli.parseArgs(args).error || '')
    assert.ok(error.length > 5, `${JSON.stringify(args)} → пустая подсказка: «${error}»`)
    assert.ok(/[а-яёА-ЯЁ]/.test(error), `${JSON.stringify(args)} → подсказка не по-русски: «${error}»`)
    assert.doesNotMatch(error, /undefined|NaN|\[object Object\]/, `${JSON.stringify(args)} → ${error}`)
  }
})

// ---------------------------------------------------------------------------
// 3. toolsFor
// ---------------------------------------------------------------------------

check('toolsFor(false) — только читающий класс, общий с ядром', () => {
  const tools = need().toolsFor(false)
  assert.ok(Array.isArray(tools) && tools.length, 'toolsFor(false) не вернул непустой список')
  const extra = tools.filter(name => !READ_ONLY_TOOLS.has(name))
  noItems(extra, `CLI без --allow-write разрешает то, что ядро читает как запись: ${extra.join(', ')} `
    + '(сверяемся с READ_ONLY_TOOLS в src/main/run-checkpoints.js)')
})

check('toolsFor(false) не даёт ни одного пишущего инструмента', () => {
  const tools = new Set(need().toolsFor(false))
  const leaked = MUTATING_TOOLS.filter(name => tools.has(name))
  noItems(leaked, `без --allow-write даны права на: ${leaked.join(', ')}`)
})

check('toolsFor(false) оставляет чтение полезным', () => {
  const tools = new Set(need().toolsFor(false))
  const missing = READING_REQUIRED.filter(name => !tools.has(name))
  noItems(missing, `CLI без --allow-write не умеет читать: ${missing.join(', ')}`)
})

check('toolsFor(true) шире читающего и даёт запись', () => {
  const cli = need()
  const readOnly = cli.toolsFor(false)
  const writable = cli.toolsFor(true)
  assert.ok(Array.isArray(writable) && writable.length, 'toolsFor(true) пустой')
  for (const name of readOnly) assert.ok(writable.includes(name), `с --allow-write пропал читающий инструмент ${name}`)
  assert.ok(writable.includes('write_file'), 'с --allow-write запись файлов так и не разрешена')
  assert.ok(writable.length > readOnly.length, '--allow-write ни к чему не приводит')
})

check('toolsFor называет только инструменты, известные ядру, без повторов', () => {
  const cli = need()
  for (const allow of [false, true]) {
    const tools = cli.toolsFor(allow)
    assert.equal(new Set(tools).size, tools.length, `дубли в toolsFor(${allow}): ${tools.join(', ')}`)
    const unknown = tools.filter(name => !KNOWN_TOOLS.has(name) && !/^(own_|mcp__)/.test(name))
    noItems(unknown, `toolsFor(${allow}) обещает инструменты, которых в ядре нет: ${unknown.join(', ')}`)
  }
})

// ---------------------------------------------------------------------------
// 4. outcomeOf и lineFor
// ---------------------------------------------------------------------------

check('исход хода: успех → OK и ответ', () => {
  const outcome = need().outcomeOf({ ok: true, content: 'В файле слово «пальма».' })
  assert.equal(outcome.code, EXIT_WANTED.OK)
  assert.match(String(outcome.answer), /пальма/)
})

check('исход хода: ошибка → TURN_FAILED с названной причиной', () => {
  const cli = need()
  const one = cli.outcomeOf({ ok: false, error: 'Ключ отклонён (401)' })
  assert.equal(one.code, EXIT_WANTED.TURN_FAILED)
  assert.match(String(one.answer), /401|отклон|ошибк/i, `причина хода потеряна: ${JSON.stringify(one)}`)
  const two = cli.outcomeOf({ error: new Error('модель не ответила') })
  assert.equal(two.code, EXIT_WANTED.TURN_FAILED)
})

check('исход хода: снят по отмене → ABORTED, а не TURN_FAILED', () => {
  const outcome = need().outcomeOf({ ok: true, aborted: true, content: '' })
  assert.equal(outcome.code, EXIT_WANTED.ABORTED)
})

check('снятый ход с технической ошибкой остаётся снятым', () => {
  // Ядро на этом пути возвращает `{ ok: true, aborted: true }`, а настоящую
  // ошибку пишет в журнал хода (main.js, ветка controller.signal.aborted).
  const outcome = need().outcomeOf({ ok: true, aborted: true, error: 'TypeError: closed' })
  assert.equal(outcome.code, EXIT_WANTED.ABORTED, 'отмена не имеет права превратиться в «ход упал»')
})

check('исход хода: отказ по правам → WRITE_REFUSED', () => {
  const outcome = need().outcomeOf({ ok: true, denied: true, content: 'Запись не выполнена: прав нет' })
  assert.equal(outcome.code, EXIT_WANTED.WRITE_REFUSED)
})

check('приоритет знаков хода: отмена > отказ по правам > ошибка > успех', () => {
  const cli = need()
  assert.equal(cli.outcomeOf({ ok: true, content: 'x', denied: true, aborted: true }).code, EXIT_WANTED.ABORTED)
  assert.equal(cli.outcomeOf({ ok: false, error: 'упало', denied: true }).code, EXIT_WANTED.WRITE_REFUSED,
    'отказ по правам нельзя терять за общей ошибкой хода: человеку нужен про --allow-write')
  assert.equal(cli.outcomeOf({ ok: false, error: 'упало' }).code, EXIT_WANTED.TURN_FAILED)
  assert.equal(cli.outcomeOf({ ok: true, content: 'готово' }).code, EXIT_WANTED.OK)
  // Пустой ответ — это НЕ успех, даже когда ядро вернуло `ok` без признака
  // отказа: ход «Модель ничего не вернула…» не даёт человеку ровно ничего.
  assert.notEqual(cli.outcomeOf({ ok: true, content: EMPTY_ANSWER }).code, EXIT_WANTED.OK,
    'ход без ответа не имеет права выйти нулём')
})

// Отказ по правам в живом ходе приходит НЕ полем ответа: `planModeRefusal`
// ставит `denied` на результат инструмента, а в `agent-tool-log` наружу идёт
// только `ok: false`. CLI обязан читать историю вызовов — иначе код 3
// появляется только тогда, когда модель сама соизволит сказать «запрещено».
check('отказ по правам виден из истории вызовов, а не из слов модели', () => {
  const cli = need()
  const refused = cli.outcomeOf({
    ok: false, incomplete: true, content: 'Записываю otvet.md.Записал otvet.md.',
    readOnly: true,
    tools: [
      { tool: 'write_file', pending: true },
      { tool: 'write_file', ok: false }
    ]
  })
  assert.equal(refused.code, EXIT_WANTED.WRITE_REFUSED,
    `пишущий инструмент не выполнился в режиме чтения, а код выхода ${refused.code}`)
  assert.match(cli.lineFor(refused), /--allow-write/)
})

check('читавший ход без записи остаётся успехом', () => {
  const cli = need()
  const one = cli.outcomeOf({
    ok: true, content: 'Готово: в notes.txt слово «пальма».', readOnly: true,
    tools: [{ tool: 'read_file', pending: true }, { tool: 'read_file', ok: true }]
  })
  assert.equal(one.code, EXIT_WANTED.OK)
})

check('сбой читающего инструмента — не отказ по правам', () => {
  const cli = need()
  const one = cli.outcomeOf({ ok: false, error: 'Файла нет на диске', readOnly: true,
    tools: [{ tool: 'read_file', ok: false }] })
  assert.equal(one.code, EXIT_WANTED.TURN_FAILED)
})

// Отрицательный контроль: знак «отказ» не должен рождаться из формулировки.
// Здесь в истории стоит инструмент вне обоих списков, а в ответе — слова про
// режим плана; права ходу даны, значит это ordinary сбой, а не код 3.
check('слова про «режим плана» без пишущего отказа не дают кода 3', () => {
  const cli = need()
  const one = cli.outcomeOf({
    ok: true, content: 'Изменения запрещены, включите режим «План» и --allow-write',
    readOnly: false, tools: [{ tool: 'edit_file', ok: false }]
  })
  assert.notEqual(one.code, EXIT_WANTED.WRITE_REFUSED,
    'код 3 родился из текста ответа, а не из невыполненного пишущего вызова')
})

check('успешная запись снимает признак отказа', () => {
  const cli = need()
  const one = cli.outcomeOf({
    ok: true, content: 'Записал otvet.md.', readOnly: true,
    tools: [{ tool: 'write_file', ok: false }, { tool: 'write_file', ok: true }]
  })
  assert.notEqual(one.code, EXIT_WANTED.WRITE_REFUSED,
    'файл записан, а CLI говорит человеку про отсутствие прав')
})

check('незавершённая строка истории (pending) отказом не считается', () => {
  const cli = need()
  const one = cli.outcomeOf({ ok: true, content: 'Записываю…', readOnly: true,
    tools: [{ tool: 'write_file', pending: true }] })
  assert.notEqual(one.code, EXIT_WANTED.WRITE_REFUSED,
    'вызов ещё не завершился — судить по нему нельзя')
})

// Права хода знает только CLI: он их и выставлял. Без этого знака называть
// не выполнившийся отказом по правам было бы догадкой — например сбоем диска.
check('без знака `readOnly` упавшая запись отказом по правам не объявляется', () => {
  const cli = need()
  const one = cli.outcomeOf({ ok: true, content: 'Не вышло.',
    tools: [{ tool: 'write_file', ok: false }] })
  assert.notEqual(one.code, EXIT_WANTED.WRITE_REFUSED,
    'код 3 вынесен там, где CLI не знает, какие права он дал ходу')
})

check('lineFor: у каждого кода есть строка для человека', () => {
  const cli = need()
  const samples = [
    { ok: true, content: 'Ответ хода' },
    { ok: false, error: 'Модель не ответила (500)' },
    { aborted: true, ok: true },
    { denied: true, ok: true }
  ]
  for (const turn of samples) {
    const outcome = cli.outcomeOf(turn)
    const line = cli.lineFor(outcome)
    assert.equal(typeof line, 'string', `lineFor для кода ${outcome.code} вернул не строку`)
    assert.ok(line.trim().length > 3, `пустая строка вывода для кода ${outcome.code}`)
    assert.ok(/[а-яёА-ЯЁ]/.test(line), `строка для кода ${outcome.code} не по-русски: ${line}`)
  }
})

check('lineFor: служебная обёртка IPC не показывается человеку', () => {
  const cli = need()
  const line = cli.lineFor(cli.outcomeOf({ ok: false,
    error: "Error invoking remote method 'send-message': Error: В пуле нет активных ключей OpenRouter. Откройте Настройки и добавьте ключ." }))
  assert.doesNotMatch(line, /remote method|send-message/, `человеку показан служебный канал Electron: ${line}`)
  assert.match(line, /В пуле нет активных ключей/, `причина отказа потерялась: ${line}`)
})

check('отказ по правам виден человеку строкой с --allow-write', () => {
  const cli = need()
  const line = cli.lineFor(cli.outcomeOf({ ok: true, denied: true, content: 'Не выполнено' }))
  assert.match(line, /--allow-write/, `в отказе нет лекарства: ${line}`)
  assert.match(line, /запис|измен|прав/i, `в отказе не сказано, чего именно не дали: ${line}`)
})

check('успех: в stdout идёт сам ответ, а не служебная обёртка', () => {
  const cli = need()
  const answer = 'Готово: в notes.txt слово «пальма».\nВторая строка ответа.'
  const line = cli.lineFor(cli.outcomeOf({ ok: true, content: answer }))
  assert.ok(line.includes('пальма'), `ответ хода не доехал до строки вывода: ${line}`)
})

// ---------------------------------------------------------------------------
// 5. redact: ни ключа, ни его части, ни base64-хвоста
// ---------------------------------------------------------------------------

const ECHO_LINES = {
  whole: `Провайдер вернул 401 для ключа ${FAKE_SECRET}.`,
  tail: `Сервер сократил секрет до …${FAKE_SECRET.slice(-10)} и отказал.`,
  mid: `В логе фрагмент ${FAKE_SECRET.slice(12, 28)} не принят.`,
  upper: `Эхо ВЕРХНИМ регистром: ${FAKE_SECRETupper}`,
  assign: `key=${FAKE_SECRET}`
}

check('redact убирает ключ целиком', () => {
  const out = need().redact(ECHO_LINES.whole, [FAKE_SECRET])
  assert.ok(!out.includes(FAKE_SECRET), `ключ вышел целиком: ${out}`)
})

check('redact не оставляет ни одного окна в 8 символов', () => {
  const out = need().redact(ECHO_LINES.mid, [FAKE_SECRET])
  const stays = secretFragments().filter(piece => piece.length >= 8 && out.includes(piece))
  assert.deepEqual(stays, [], `в выводе остались окна ключа: ${stays.join(' | ')} → ${out}`)
})

check('redact не оставляет хвостов 4/6/8/10/12, в том числе base64', () => {
  const out = need().redact(ECHO_LINES.tail, [FAKE_SECRET])
  const tails = [4, 6, 8, 10, 12].map(size => FAKE_SECRET.slice(-size)).filter(piece => out.includes(piece))
  assert.deepEqual(tails, [], `в выводе остались хвосты ключа: ${JSON.stringify(tails)} → ${out}`)
  assert.ok(!out.includes(FAKE_SECRET.slice(-12)), `base64-хвост ключа дожил целиком: ${out}`)
})

check('redact стирает эхо ключа верхним регистром', () => {
  const out = need().redact(ECHO_LINES.upper, [FAKE_SECRET])
  assert.ok(!out.toUpperCase().includes(FAKE_SECRETupper), `регистр обошёл зачистку: ${out}`)
})

check('redact стирает секрет в форме присваивания key=…', () => {
  const out = need().redact(ECHO_LINES.assign, [FAKE_SECRET])
  assert.ok(!out.includes(FAKE_SECRET) && !out.includes(FAKE_SECRET.slice(10, 24)), `присваивание не вычищено: ${out}`)
})

check('redact принимает несколько секретов одним вызовом', () => {
  const second = 'ONECODE_Zz9Yb8Xc7Wd6Ve5Uf4Tg3Sh2Rj1Qk0PmNl='
  const out = need().redact(`Два ключа: ${FAKE_SECRET} и ${second}.`, [FAKE_SECRET, second])
  assert.ok(!out.includes(FAKE_SECRET) && !out.includes(second), `один из ключей дожил: ${out}`)
})

check('redact не трогает обычную русскую речь (байт в байт)', () => {
  const cli = need()
  const prose = [
    'Ключ не задан, поэтому ход не пошёл',
    'Мой токен можно проверить вручную',
    'пароль: нет',
    'токен доступа не задан',
    'ключевые файлы не трогай',
    'Собери лендинг про пальмы, ключевые слова не меняются',
    'Отказ по правам: не передан --allow-write',
    'Ход снят по Ctrl+C, запись не выполнялась',
    'Папка не найдена на диске: D:/нет/такой/папки'
  ]
  for (const text of prose) {
    assert.equal(cli.redact(text, [FAKE_SECRET]), text, `красная речь испорчена зачисткой: ${text}`)
  }
})

check('redact сохраняет то, по чему человек понимает отказ', () => {
  const out = need().redact(ECHO_LINES.whole, [FAKE_SECRET])
  for (const keep of ['401', 'ключа', 'Провайдер']) {
    assert.ok(out.includes(keep), `зачистка съела объяснение («${keep}»): ${out}`)
  }
})

check('redact без секретов ничего не делает и не падает', () => {
  const cli = need()
  const text = 'Ответ хода: файл прочитан, слово «пальма».'
  assert.equal(cli.redact(text, []), text)
  assert.equal(cli.redact(text), text, 'redact(text) без второго аргумента обязан вернуть текст как есть')
  assert.equal(cli.redact(text, null), text)
  for (const weird of [undefined, null, 42, { a: 1 }, '']) {
    assert.equal(typeof cli.redact(weird, [FAKE_SECRET]), 'string', `redact(${JSON.stringify(weird)}) вернул не строку`)
  }
})

check('redact идемпотентен: повторный прогон ничего не меняет', () => {
  const cli = need()
  for (const line of Object.values(ECHO_LINES)) {
    const once = cli.redact(line, [FAKE_SECRET])
    assert.equal(cli.redact(once, [FAKE_SECRET]), once, 'второй проход redact доизменял уже вычищенный текст')
  }
})

check('после зачистки строка остаётся строкой, а не пустотой', () => {
  const cli = need()
  for (const [label, line] of Object.entries(ECHO_LINES)) {
    const out = cli.redact(line, [FAKE_SECRET])
    assert.ok(out.trim().length >= 8, `зачистка оставила пустоту в случае «${label}»: ${JSON.stringify(out)}`)
  }
})

// ---------------------------------------------------------------------------
// 6. createCli(deps): граница данных и коды выхода на живом прогоне
// ---------------------------------------------------------------------------

check('пустая просьба → BAD_INPUT, ядро не тронуто', async () => {
  const scenario = makeScenario()
  const result = await codeOfRun(scenario, ['run', '--folder', FOLDER])
  assert.equal(result.code, EXIT_WANTED.BAD_INPUT)
  assert.equal(scenario.spy.runTurnCalls.length, 0, 'ход ушёл в ядро на пустой просьбе')
  assert.ok(norm(scenario.spy.err.join(' ')) || norm(scenario.spy.out.join(' ')), 'человеку не сказано ни слова')
})

check('нет --folder → BAD_INPUT, ядро не тронуто', async () => {
  const scenario = makeScenario()
  const result = await codeOfRun(scenario, ['run', REQUEST])
  assert.equal(result.code, EXIT_WANTED.BAD_INPUT)
  assert.equal(scenario.spy.runTurnCalls.length, 0, 'ход ушёл в ядро без рабочей папки')
})

check('папки нет на диске → BAD_INPUT и внятная строка, ядро не тронуто', async () => {
  const scenario = makeScenario({ folderExists: false })
  const result = await codeOfRun(scenario, argv(REQUEST, '--folder', 'D:/только-во-сне'))
  assert.equal(result.code, EXIT_WANTED.BAD_INPUT, 'несуществующая папка не имеет права означать «ход сделан»')
  assert.equal(scenario.spy.runTurnCalls.length, 0)
  const shown = norm(scenario.spy.err.join(' ') + ' ' + scenario.spy.out.join(' '))
  assert.ok(/[а-яё]/.test(shown) && shown.length > 10, `человек не получил объяснения: ${JSON.stringify(shown)}`)
  assert.ok(scenario.spy.existsCalls.length >= 1, 'папку никто не проверял через deps')
})

check('неизвестный ключ → BAD_INPUT до запуска хода', async () => {
  const scenario = makeScenario()
  const result = await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER, '--max-tokens', '10'))
  assert.equal(result.code, EXIT_WANTED.BAD_INPUT)
  assert.equal(scenario.spy.runTurnCalls.length, 0, 'опечатку в ключе нельзя лечить запуском хода')
})

check('ключи берутся из общего профиля: readProfile вызван, диска модуль не трогал', async () => {
  const scenario = makeScenario()
  await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
  assert.ok(scenario.spy.readProfile >= 1, 'CLI не прочитал профиль — откуда тогда ключи?')
  // Прямой доступ к fs здесь физически невозможен: require('fs') в песочнице
  // бросает. Значит путь в профиль ровно один — внедрённая зависимость.
})

check('просьба и папка доезжают до ядра', async () => {
  const scenario = makeScenario()
  await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
  assert.equal(scenario.spy.runTurnCalls.length, 1, `ходов ядра ожидался один, записано ${scenario.spy.runTurnCalls.length}`)
  const dump = callDump(scenario).text
  assert.ok(dump.includes(REQUEST), `просьба не доехала: ${dump.slice(0, 400)}`)
  assert.ok(dump.includes(FOLDER) || dump.includes(FOLDER.replace(/\//g, '\\')), `папка не доехала: ${dump.slice(0, 400)}`)
})

check('без --allow-write ядро получает права «только чтение»', async () => {
  const scenario = makeScenario()
  await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
  const { text, arrays } = callDump(scenario)
  const lists = arrays.filter(list => list.some(name => /^(read_file|list_files|search_files|fetch_url)$/.test(name)))
  if (lists.length) {
    const leaked = lists.flat().filter(name => MUTATING_TOOLS.includes(name))
    noItems(leaked, `CLI передал ядру пишущие инструменты без --allow-write: ${leaked.join(', ')}`)
  } else {
    assert.match(text, /"readOnly"\s*:\s*true|"allowWrite"\s*:\s*false|"permission"\s*:\s*"plan"|"denyWrite"\s*:\s*true/,
      'CLI не передал ядру ни списка читающих инструментов, ни явного знака «только чтение»')
  }
})

check('--allow-write доводит право записи до ядра', async () => {
  const scenario = makeScenario()
  const result = await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER, '--allow-write'))
  const { text, arrays } = callDump(scenario)
  assert.equal(result.code, EXIT_WANTED.OK)
  const lists = arrays.filter(list => list.some(name => /^(read_file|list_files|search_files|fetch_url)$/.test(name)))
  if (lists.length) {
    assert.ok(lists.flat().includes('write_file'), `с --allow-write write_file так и не попал в ядро: ${JSON.stringify(lists)}`)
  } else {
    assert.match(text, /"readOnly"\s*:\s*false|"allowWrite"\s*:\s*true|"permission"\s*:\s*"(acceptEdits|auto)"|"canWrite"\s*:\s*true/,
      'с --allow-write ядро не получило знака, что запись разрешена')
  }
})

check('исход хода = код выхода: успех → 0 и ответ в stdout', async () => {
  const scenario = makeScenario({ turn: { ok: true, content: 'Готово: в файле слово «пальма».' } })
  const result = await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
  assert.equal(result.code, EXIT_WANTED.OK)
  const shown = scenario.spy.out.join('')
  assert.ok(shown.includes('пальма'), `ответ не напечатан в stdout: ${JSON.stringify(shown)}`)
  assert.ok(shown.length > 0, 'успешный ход ничего не вывел')
})

check('исход хода = код выхода: ошибка модели → 1, причина в stderr', async () => {
  const scenario = makeScenario({ turn: { ok: false, error: 'Модель не ответила (500)' } })
  const result = await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
  assert.equal(result.code, EXIT_WANTED.TURN_FAILED)
  const shown = norm(scenario.spy.err.join(' ') + ' ' + scenario.spy.out.join(' '))
  assert.match(shown, /500|не ответ|ошибк/i, `причина отказа не названа человеку: ${shown}`)
})

check('исход хода = код выхода: отмена (Ctrl+C) → 4', async () => {
  const scenario = makeScenario({ turn: { ok: true, aborted: true, content: '' } })
  const result = await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
  assert.equal(result.code, EXIT_WANTED.ABORTED)
  const shown = norm(scenario.spy.out.join(' ') + ' ' + scenario.spy.err.join(' '))
  assert.match(shown, /сня|отмен|останов/i, `отмену не объяснить человеку: ${shown}`)
})

check('исход хода = код выхода: запись без флага → 3, отказ виден строкой', async () => {
  const scenario = makeScenario({ turn: { ok: true, denied: true, content: 'Запись не выполнена' } })
  const result = await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
  assert.equal(result.code, EXIT_WANTED.WRITE_REFUSED)
  const shown = norm(scenario.spy.out.join(' ') + ' ' + scenario.spy.err.join(' '))
  assert.match(shown, /--allow-write/, `отказ проглочен молча: ${JSON.stringify(shown)}`)
  assert.ok(/[а-яё]/.test(shown), `отказ не по-русски: ${shown}`)
})

check('ни в stdout, ни в stderr, ни в журнале нет ни ключа, ни его части', async () => {
  const cases = [
    { label: 'успех', turn: { ok: true, content: `Провайдер принял ключ ${FAKE_SECRET}.` } },
    { label: 'ошибка', turn: { ok: false, error: `Ключ ${FAKE_SECRET} отклонён (401)` } },
    { label: 'отказ по правам', turn: { ok: true, denied: true, content: 'Не выполнено' } },
    { label: 'отмена', turn: { ok: true, aborted: true } },
    { label: 'вброшенное исключение', turn: new Error(`Сбой: секрет ${FAKE_SECRET} в тексте стека`) }
  ]
  for (const testCase of cases) {
    const scenario = makeScenario({ turn: testCase.turn })
    await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER, '--log', 'D:/onlyone-cli-7-5/out/journal.jsonl'))
    const bytes = outputBytes(scenario.spy)
    const hit = FRAGMENTS.filter(piece => bytes.includes(piece))
    assert.deepEqual(hit, [], `случай «${testCase.label}»: в выводе остались куски ключа ${JSON.stringify(hit)} → ${bytes.slice(0, 300)}`)
    assert.ok(bytes.length > 0, `случай «${testCase.label}»: вывод пуст — проверка ничего не меряла`)
  }
})

check('журнал прогона пишется через deps.log', async () => {
  const scenario = makeScenario()
  await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER, '--log', 'D:/onlyone-cli-7-5/out/journal.jsonl'))
  assert.ok(scenario.spy.logEntries.length >= 1, 'ход не оставил ни одной записи журнала')
  const dump = scenario.spy.logEntries.map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')
  assert.ok(dump.includes(REQUEST) || dump.includes(FOLDER), `в журнале нет ни просьбы, ни папки: ${dump.slice(0, 300)}`)
})

check('обратно в профиль пишет только deps.writeProfile и без открытого ключа', async () => {
  for (const turn of [{ ok: true, content: 'Готово' }, { ok: false, error: 'упало' }, { ok: true, denied: true }]) {
    const scenario = makeScenario({ turn })
    await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
    for (const body of scenario.spy.writeProfile) {
      const dump = typeof body === 'string' ? body : JSON.stringify(body)
      const hit = FRAGMENTS.filter(piece => piece.length >= 8 && dump.includes(piece))
      assert.deepEqual(hit, [], `в профиль лег открытый ключ: ${JSON.stringify(hit)}`)
    }
  }
})

check('человеческие строки идут через deps.t и остаются русской речью', async () => {
  const scenario = makeScenario({ turn: { ok: true, denied: true, content: 'Не выполнено' } })
  await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
  assert.ok(scenario.spy.t.length >= 1, 'ни одна строка не прошла через t() — интерфейс не переводится')
  const sources = scenario.spy.t.filter(text => /[а-яёА-ЯЁ]/.test(text))
  assert.ok(sources.length >= 1, `в t() не попало ни одной русской строки: ${JSON.stringify(scenario.spy.t).slice(0, 300)}`)
  assert.ok(sources.some(text => /--allow-write|ход|папк|прав/i.test(text)),
    `подсказки человека идут мимо внятных строк: ${JSON.stringify(sources).slice(0, 300)}`)
})

check('мимо deps.out/err модуль ничего человеку не печатает', async () => {
  for (const turn of [{ ok: true, content: 'Готово' }, { ok: true, aborted: true }, { ok: false, error: 'упало' }]) {
    const scenario = makeScenario({ turn })
    await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
    assert.deepEqual(scenario.spy.stdio, [], 'модуль wrote в process.stdout/stderr — набор не измерит вывод в байтах')
    assert.deepEqual(scenario.spy.console, [], 'модуль пишет в console вместо deps.out/err/log')
    assert.deepEqual(scenario.spy.exit, [], 'модуль зовёт process.exit вместо возврата кода из run(argv)')
  }
})

check('повторный прогон тем же deps не роняет CLI и не меняет коды', async () => {
  const scenario = makeScenario({ turn: { ok: true, content: 'Готово: слово «пальма».' } })
  const first = await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER))
  const second = await codeOfRun(scenario, argv(REQUEST, '--folder', FOLDER, '--allow-write'))
  assert.equal(first.code, EXIT_WANTED.OK)
  assert.equal(second.code, EXIT_WANTED.OK)
  assert.equal(scenario.spy.runTurnCalls.length, 2, 'CLI живёт одним прогоном: второй вызов не дошёл до ядра')
})

check('названного набора deps хватает на прогон — лишних зависимостей реализатор не требует', async () => {
  const cli = need()
  const scenario = makeScenario()
  const bare = {}
  for (const key of DEPS_REQUIRED) bare[key] = scenario.deps[key]
  const api = cli.createCli(bare)
  assert.ok(api && typeof api.run === 'function', 'createCli на голом наборе deps не вернул { run }')
  const result = await api.run(argv(REQUEST, '--folder', FOLDER))
  assert.equal(result.code, EXIT_WANTED.OK, 'прогон на голом наборе deps не дошёл до успеха')
  assert.equal(scenario.spy.runTurnCalls.length, 1, 'ход не дошёл до ядра через голые deps')
})

// ---------------------------------------------------------------------------
// Итог
// ---------------------------------------------------------------------------

;(async () => {
  for (const item of queue) {
    total++
    try {
      await item.fn()
      console.log('  ok  ' + item.name)
    } catch (error) {
      failed++
      const message = oneLine(error)
      if (/ещё не написан|не подключается чистым node/.test(message)) redForMissingModule++
      console.error(`ПРОВАЛ [${item.name}]: ${message}`)
    }
  }
  console.log(`\nИтог: ${total - failed}/${total} успешно, ${failed} провалов.`)
  if (failed && redForMissingModule === failed) {
    console.log(`КРАСНЫХ проверок: ${failed} — все по причине «точки входа ${rel(MODULE_PATH)} ещё нет» `
      + '(пункт 7.5, набор написан до кода, так и задумано)')
  } else if (failed) {
    console.log(`КРАСНЫХ проверок: ${failed}, из них «модуля ещё нет»: ${redForMissingModule}. `
      + 'Остальные красны ПОВЕДЕНИЕМ: реализация не отвечает контракту 7.5.')
  }
  process.exit(failed ? 1 : 0)
})()
