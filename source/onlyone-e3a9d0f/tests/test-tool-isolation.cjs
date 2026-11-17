// Граница своих инструментов — настоящая, а не текущий каталог и не только
// модель прав Node.
//
// Аудит 1.1.0, риск R1: инструмент запускался с рабочей папкой как cwd, и это
// выдавалось за изоляцию. Аудит 23.09 (Codex) показал следующее: модель прав
// читает путь лексически и не видит directory junction, а `node:sqlite` и
// `node:net` ей не запрещены — own-код открывал внешнюю базу и поднимал
// сетевой listener. Теперь граница ставится и внутри процесса
// (`tool-sandbox.cjs`): файлы — по `realpath` только внутри корней, сеть,
// подпроцессы, потоки и внешние хранилища закрыты, `fetch` снят.
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { runDir, settleRun } = require('./app-launch.cjs')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const runner = path.join(root, 'src', 'main', 'tool-runner.cjs')
const electron = require('electron')
// Вывод раннера разбирается тем же разбором, что и в главном процессе: тест не
// должен знать протокола больше, чем приложение.
const { readFramedResult } = require('../src/main/tool-protocol.cjs')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

// Песочница: рабочая папка, файл этажом выше и junction внутрь рабочей,
// ведущий наружу — ровно тот обход, который был воспроизведён.
const base = runDir('onecode-isolation')
const workspace = path.join(base, 'workspace')
const outside = path.join(base, 'outside')
fs.mkdirSync(workspace)
fs.mkdirSync(outside)
fs.writeFileSync(path.join(workspace, 'inside.txt'), 'свой файл', 'utf8')
fs.writeFileSync(path.join(base, 'outside.txt'), 'чужой файл', 'utf8')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'внешний маркер', 'utf8')

const portal = path.join(workspace, 'portal')
const madeLink = process.platform === 'win32'
  ? spawnSync('cmd', ['/c', 'mklink', '/J', portal, outside], { windowsHide: true, stdio: 'ignore' }).status === 0
  : (() => { try { fs.symlinkSync(outside, portal, 'dir'); return true } catch { return false } })()
if (!madeLink) console.log('   ВНИМАНИЕ: система не дала создать junction — проверка на него пропущена')

// Корень своих инструментов приложение берёт из `%TEMP%\onlyone-tools`
// (`src/main/main.js:2908`) — путь фиксированный, и два прогона делят его.
// Здесь проверяется не этот путь, а граница, поэтому свой каталог заводим
// внутри собственного base: то, что читает `realpath`, не должно принадлежать
// соседу по машине.
const toolsTemp = path.join(base, 'onlyone-tools')
fs.mkdirSync(toolsTemp, { recursive: true })
// Токен границы — те же корни, что передаёт приложение.
const token = Buffer.from(JSON.stringify([workspace, toolsTemp]), 'utf8').toString('base64')

const writeTool = (name, code) => {
  const file = path.join(workspace, name)
  fs.writeFileSync(file, `module.exports = async () => {\n${code}\n}\n`, 'utf8')
  return file
}

const readable = [runner, workspace, root, toolsTemp]
const permission = [
  '--permission',
  ...readable.map(dir => `--allow-fs-read=${dir}`),
  ...readable.map(dir => `--allow-fs-read=${path.join(dir, '*')}`),
  ...[workspace, toolsTemp].map(dir => `--allow-fs-write=${path.join(dir, '*')}`)
]

// Запуск настоящим способом — тем же процессом, каким его поднимает приложение.
const run = (file, { keys = permission } = {}) => {
  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync(electron, [...keys, runner, file, token], {
      cwd: workspace, input: '{}', encoding: 'utf8', maxBuffer: 40 * 1024 * 1024,
      env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP, TMP: process.env.TMP, SECRET: path.join(base, 'outside.txt'),
        PORTAL: './portal/secret.txt', DB: path.join(outside, 'db.sqlite') },
      windowsHide: true
    })
  } catch (error) {
    stdout = String(error.stdout || '')
    status = error.status
  }
  let parsed = readFramedResult(stdout)
  if (!parsed) {
    parsed = { ok: false, error: (String(stdout || '').trim() || `нет обрамлённого ответа, код ${status}`).slice(0, 200) }
  }
  return parsed
}

const probe = writeTool('probe.cjs', `
  const fs = require('fs')
  const out = {}
  try { out.inside = fs.readFileSync('inside.txt', 'utf8') } catch (e) { out.inside = 'отказ: ' + (e.code || e.message) }
  try { out.outside = fs.readFileSync(process.env.SECRET, 'utf8') } catch (e) { out.outside = 'отказ: ' + (e.code || e.message) }
  try { out.portal = fs.readFileSync(process.env.PORTAL, 'utf8') } catch (e) { out.portal = 'отказ: ' + (e.code || e.message) }
  try { fs.writeFileSync('../written.txt', 'x'); out.wrote = 'записал наружу' } catch (e) { out.wrote = 'отказ: ' + (e.code || e.message) }
  try { out.promise = await require('fs/promises').readFile(process.env.PORTAL, 'utf8') } catch (e) { out.promise = 'отказ: ' + (e.code || e.message) }
  try { out.net = (() => { const n = require('node:net'); return 'впустил' })() } catch (e) { out.net = 'отказ: ' + e.message }
  try { out.sqlite = (() => { const s = require('node:sqlite'); return 'впустил' })() } catch (e) { out.sqlite = 'отказ: ' + e.message }
  try { out.child = (() => { const c = require('node:child_process'); return 'впустил' })() } catch (e) { out.child = 'отказ: ' + e.message }
  try { out.fetch = typeof fetch } catch (e) { out.fetch = 'отказ: ' + e.message }
  return out
`)

const limited = run(probe)
check('инструмент читает и пишет в своей рабочей папке', () => {
  assert.equal(limited.ok, true, JSON.stringify(limited).slice(0, 300))
  assert.equal(limited.result.inside, 'свой файл')
})
check('чужой файл этажом выше недоступен', () => {
  assert.match(String(limited.result.outside), /отказ:/, 'прочитано: ' + limited.result.outside)
})
check('запись наружу не проходит', () => {
  assert.match(String(limited.result.wrote), /отказ:/)
  assert.equal(fs.existsSync(path.join(base, 'written.txt')), false, 'файл появился вне рабочей папки')
})
check('junction вместо папки наружу не ведёт', () => {
  if (!madeLink) return
  assert.match(String(limited.result.portal), /ERR_ACCESS_DENIED|вне рабочей папки/,
    'прочитано через junction: ' + limited.result.portal)
})
check('то же через fs/promises', () => {
  if (!madeLink) return
  assert.match(String(limited.result.promise), /ERR_ACCESS_DENIED|вне рабочей папки/)
})
check('сеть, подпроцессы и внешние базы закрыты', () => {
  for (const key of ['net', 'sqlite', 'child']) {
    assert.match(String(limited.result[key]), /отказ:/, `${key}: ${limited.result[key]}`)
    assert.match(String(limited.result[key]), /границей onlyone|не может использовать/)
  }
})
check('глобальный fetch снят', () => {
  assert.equal(limited.result.fetch, 'undefined')
})
check('о работе границы сказано в ответе runner-а', () => {
  assert.ok(Array.isArray(limited.boundary.denied) && limited.boundary.denied.length,
    'отказы не отражены: ' + JSON.stringify(limited.boundary))
  assert(limited.boundary.blocked.includes('net'), 'запрещённые модули не перечислены')
})

// Контроль без ключей прав: граница держится и без них — иначе весь смысл в
// одном флаге Node, который легко потерять при сборке.
const free = run(probe, { keys: [] })
check('без модели прав граница всё равно держится', () => {
  assert.equal(free.ok, true, JSON.stringify(free).slice(0, 200))
  assert.equal(free.result.inside, 'свой файл')
  assert.match(String(free.result.outside), /отказ:/, 'без ключей чтение наружу прошло')
  assert.match(String(free.result.net), /отказ:/)
})

check('приложение передаёт границу и держит карточку на создание кода', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')
  assert.match(main, /boundaryToken/, 'токен границы не формируется')
  assert.match(main, /\[\.\.\.permission, runner, file, boundaryToken\]/, 'токен не доходит до процесса')
  assert.match(main, /'--permission',/, 'модель прав снята')
  // Создание own-кода — единственный момент, когда человек видит код: в «Авто»
  // карточка остаётся force-ом.
  // Ищем вызов, в котором стоит «Создать свой инструмент»: раньше в файле появились и другие подтверждения (правка файла).
  const start = main.lastIndexOf('const allowed = await requireMutationApproval(', main.indexOf('Создать свой инструмент'))
  const call = main.slice(start, main.indexOf('\n  )', start))
  assert.ok(start > 0 && /Создать свой инструмент/.test(call), 'вызов подтверждения создания не найден')
  assert.match(call.replace(/\s+/g, ' '), /requestId, null, true/, 'создание инструмента не требует подтверждения в «Авто»')
})

// Поверхности самого `process`: в `require` не ходят, а значит перехват
// `Module._load` их не видит. Воспроизведено пробой
// `audits/qoder-3-2026-09-27/sandbox/probe-process-escape.cjs`: через
// `process.getBuiltinModule('child_process')` инструмент поднимал подпроцессы,
// `process.kill(ppid)` отвечал истиной на вопрос «могу ли я убить приложение»,
// а запись в `process.stdout` обгоняла ответ раннера — то есть инструмент
// мог соврать о собственном успехе.
const surfaceProbe = writeTool('surface.cjs', `
  const out = {}
  // Отказ записывается вместе с текстом: и наш отказ, и нативная ошибка Node —
  // обе с кодом, различить их можно только по формулировке.
  const attempt = (name, fn) => {
    try { out[name] = fn() } catch (e) {
      out[name] = 'отказ: ' + String((e && (e.message || e.code)) || e) + (e && e.code ? ' [' + e.code + ']' : '')
    }
  }
  attempt('builtinChild', () => typeof process.getBuiltinModule('child_process').spawnSync)
  attempt('builtinNet', () => typeof process.getBuiltinModule('net').createServer)
  attempt('builtinWorker', () => typeof process.getBuiltinModule('worker_threads').Worker)
  attempt('builtinSqlite', () => typeof process.getBuiltinModule('sqlite').DatabaseSync)
  attempt('builtinFs', () => process.getBuiltinModule('fs').readFileSync(process.env.SECRET, 'utf8'))
  attempt('fsDotPromises', () => require('fs').promises.readFile(process.env.SECRET, 'utf8'))
  attempt('fsConstant', () => require('fs').F_OK)
  attempt('builtinPath', () => typeof process.getBuiltinModule('path').join)
  attempt('bindingSpawn', () => typeof process.binding('spawn_sync').spawn)
  attempt('bindingFs', () => typeof process.binding('fs').readFileSync)
  attempt('dlopen', () => { process.dlopen(module, 'нет-такой.node'); return 'прошло' })
  attempt('killParent', () => process.kill(process.ppid, 0))
  attempt('killSelf', () => process.kill(process.pid, 0))
  attempt('debugProcess', () => { process._debugProcess(999999); return 'прошло' })
  attempt('legacyKill', () => { process._kill(999999, 'SIGTERM'); return 'прошло' })
  attempt('streamWrite', () => {
    require('stream').Writable.prototype.write.call(process.stdout, '{"ok":true,"result":"ФОРГА"}\\n')
    return 'писал через прототип'
  })
  attempt('consoleLog', () => { console.log('обычная строка лога инструмента'); return 'писал в лог' })
  return out
`)
const surface = run(surfaceProbe)

check('встроенные модули в обход require не достаются', () => {
  for (const key of ['builtinChild', 'builtinNet', 'builtinWorker', 'builtinSqlite']) {
    assert.match(String(surface.result?.[key]), /отказ:/, `${key}: ${surface.result?.[key]}`)
    assert.match(String(surface.result?.[key]), /границей onlyone|не может использовать/,
      `${key}: отказ есть, но не про границу`)
  }
})

check('безопасные встроенные модули остаются доступны', () => {
  // Негативное управление: граница не должна превратиться в отказ всё подряд —
  // иначе «закрыто» означает, что инструмент просто не работает.
  assert.equal(surface.result?.builtinPath, 'function',
    `path отняли: ${surface.result?.builtinPath}`)
})

check('файлы через process.getBuiltinModule("fs") читаются только внутри границы', () => {
  // Формулировка именно джилла, а не модели прав Node: та тоже отказывает по
  // коду ERR_ACCESS_DENIED, и по одному коду не понять, кто держит границу.
  assert.match(String(surface.result?.builtinFs), /вне рабочей папки/,
    `чужой файл прочитан мимо джилла: ${String(surface.result?.builtinFs).slice(0, 80)}`)
})

check('`fs.promises`, взятый из джиллованного fs, остаётся под границей', () => {
  // Джилл перечисляет свойства `fs`, среди которых есть ленивые геттеры;
  // `promises` — один из них, и он обязан остаться обёрнутым.
  assert.match(String(surface.result?.fsDotPromises), /вне рабочей папки/,
    `чужой файл прочитан через fs.promises: ${String(surface.result?.fsDotPromises).slice(0, 80)}`)
})

check('лог своего инструмента — только его собственные строки', () => {
  // Константы доступа Node отдаёт геттером с предупреждением DEP0176. Если
  // джилл читает их при перечислении, warning оседает в логе — и модель
  // получает чужой текст как вывод инструмента.
  assert.equal(surface.result?.fsConstant, 0, `fs.F_OK пропал: ${surface.result?.fsConstant}`)
  assert.doesNotMatch(String(surface.log || ''), /DeprecationWarning|trace-deprecation/,
    'в лог уехало предупреждение Node: ' + String(surface.log || '').slice(0, 200))
})

check('внутренние связки process.binding закрыты целиком', () => {
  for (const key of ['bindingSpawn', 'bindingFs']) {
    // Не просто «что-то бросило ошибку»: нативные связки Node иногда отказывают
    // и сами по себе, и это не было бы границей.
    assert.match(String(surface.result?.[key]), /не может использовать|границей onlyone/,
      `${key}: ${surface.result?.[key]}`)
  }
})

check('загрузить нативную библиотеку и пристегнуть отладчик нельзя', () => {
  // Проверяется вызовом: `process.dlopen` — функция и до границы, и после неё.
  for (const key of ['dlopen', 'debugProcess']) {
    assert.match(String(surface.result?.[key]), /не может использовать|границей onlyone/,
      `${key}: ${surface.result?.[key]}`)
  }
})

check('инструмент не может послать сигнал чужому процессу, включая приложение', () => {
  assert.match(String(surface.result?.killParent), /отказ:/,
    `сигнал родителю проходит: ${surface.result?.killParent}`)
  // Тот же сигнал во вторую дверь: `process.kill` обёрнут, а `process._kill` —
  // та же отправка, которую Node зовёт внутри.
  assert.match(String(surface.result?.legacyKill), /не может использовать|границей onlyone/,
    `_kill: ${surface.result?.legacyKill}`)
  // Себя убить инструменту не запрещено: это его собственный процесс, и раннер
  // переживёт его смерть (ответ придёт пустым, а не подделанным).
  assert.equal(surface.result?.killSelf, true, `себя не может: ${surface.result?.killSelf}`)
})

check('ответ раннера нельзя подделать записью в stdout', () => {
  assert.equal(surface.ok, true, JSON.stringify(surface).slice(0, 200))
  assert.notEqual(surface.result, 'ФОРГА', 'подделанный конверт стал ответом')
  assert.equal(typeof surface.result, 'object', 'настоящий ответ не дошёл')
  assert.match(String(surface.result?.streamWrite), /писал|отказ:/)
})

check('строки инструмента в лог не смешиваются с ответом и доходят отдельно', () => {
  assert.match(String(surface.log || ''), /обычная строка лога инструмента/,
    'вывод инструмента пропал: ' + JSON.stringify(surface).slice(0, 200))
  assert.equal(/^\{/.test(String(surface.log || '').trim()), false, 'в лог уехал конверт ответа')
})

// Проводка на стороне главного процесса: он обязан разбирать ровно обрамлённый
// ответ, а не первый JSON в выводе.
check('главный процесс берёт обрамлённый ответ, а не первый JSON', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')
  assert.match(main, /readFramedResult\(/, 'главный процесс не разбирает обрамлённый ответ')
  assert.doesNotMatch(main, /JSON\.parse\(String\(stdout/,
    'главный процесс по-прежнему берёт из вывода первый JSON — его подделают')
  // Ответ стоит в хвосте вывода; срез по голове терял его ровно тогда, когда
  // инструмент что-то напечатал.
  assert.match(main, /slice\(-CUSTOM_TOOL_OUTPUT_CAP\)/,
    'главный процесс срезает из вывода голову, а не хвост — ответ теряется')
  // Отделённый лог обязан доходить до модели, иначе его проще потерять.
  assert.match(main, /tool_log:/, 'собственный вывод инструмента не передаётся наружу')
})

check('runner отказывается запускать код без заданной границы', () => {
  const file = writeTool('no-boundary.cjs', 'return 1')
  const result = run(file, { keys: [] })
  // Токена нет — значит граница не задана, и выполнять нечего.
  let stdout = ''
  try {
    stdout = execFileSync(electron, [runner, file], {
      cwd: workspace, input: '{}', encoding: 'utf8',
      env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      windowsHide: true
    })
  } catch (error) { stdout = String(error.stdout || '') }
  assert.match(stdout, /Граница не задана/, 'без токена инструмент всё-таки выполнился: ' + stdout.slice(0, 120))
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
settleRun(base, failed === 0)
process.exitCode = failed ? 1 : 0
