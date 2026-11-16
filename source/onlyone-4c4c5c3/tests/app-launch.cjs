// Запуск настоящего окна приложения из тестов. Вынесено отдельно из-за двух
// тонкостей, на которых прогоны молча разваливались.
//
// Путь к бинарю берётся у самого пакета electron, а не у shim-а в node_modules/.bin:
// тот — скрипт, который зовёт node. Нет node в системе — нет и окна, а тест
// сообщает только «приложение не догрузилось».
//
// ELECTRON_RUN_AS_NODE наследуется дочерним процессом. Если прогон запущен
// Node-ом, встроенным в Electron, переменная достаётся и окну: electron.exe
// стартует как Node, отчёт не появляется, проверки считаются проваленными.
// Для GUI-запуска её снимаем.
const fs = require('fs')
const path = require('path')
const os = require('os')

const electronBinary = () => require('electron')

// Каталоги, заведённые ЭТИМ процессом через runDir(). Удалять разрешается
// только их — так «убрать мусор после прогона» перестаёт быть возможностью
// снести чужой живой прогон или улики своего провала. 24.09 по этому поводу
// был реальный случай: уборка по маске `%TEMP%\onlyone-*` сняла каталоги
// чужих сеансов, один из которых ещё работал.
const owned = new Set()

function runDir (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'))
  owned.add(dir)
  // Путь печатается сразу: прогон может умереть на полуслове, и тогда единственная
  // зацепка — строка, которую он успел показать.
  console.log('RUN DIR: ' + dir)
  return dir
}

// Зелёный прогон убирает свой каталог, красный — оставляет: без профиля,
// кадра и вердикта «плавающее» звено разбирается неделями.
function settleRun (dir, ok) {
  if (!owned.has(dir)) throw new Error('settleRun: каталог ' + dir + ' заведён не этим прогоном — удалять его нельзя')
  if (ok) {
    // Windows may briefly keep Chromium profile files open after Electron exits.
    // Retry transient EPERM/EBUSY instead of failing a green functional test.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
    owned.delete(dir)
    return
  }
  console.error('УЛИКИ ОСТАВЛЕНЫ: ' + dir)
}

// Оконные прогоны не должны идти параллельно: проверка подсказок наводит мышь на
// координаты, и второе окно поверх первого даёт красное «текст подсказки не тот»
// при полностью исправном приложении (замерено 24.09: 1 из 3 прогонов красным под
// соседним окном, следом 2/2 зелёных). Замок машинный, а не в рамках процесса:
// иначе два сеанса, которые правят тесты одновременно, топят прогоны друг друга.
//
// Снятый процесс (SIGKILL) замок не освободит, поэтому замок смотрит на жив ли
// владелец. По возрасту забирать нельзя: звено с двумя-тремя окнами держит замок
// дольше восьми минут, и «просроченный» замок у живого соседа означает, что два
// окна всё-таки встали рядом — ровно то, от чего замок защищает.
//
// Живой, но зависший владелец виден по времени: он пишет в замок при каждом
// захвате и обновляет его между окнами, поэтому молчание дольше STALE — повод
// тревожиться. Тревогу при этом печатаем, а не молча снимаем чужой замок:
// освобождать его может только дождавшийся, и ошибка у него громкая.
// Путь замка можно подменить переменной: регрессии на сам замок проверяются в
// отдельном файле, иначе она писала бы и стирала замок живого прогона соседа.
const LOCK_FILE = process.env.ONECODE_WINDOW_LOCK_FILE || path.join(os.tmpdir(), 'onlyone-window-tests.lock')
// Сколько не обновляемый, но живой замок считается подозрительным — только для
// предупреждения в журнале.
const LOCK_STALE_MS = 8 * 60 * 1000

// Жив ли владелец замка. `process.kill(pid, 0)` ничего не убивает — он либо
// бросает ESRCH (процесса нет), либо молча возвращает true.
function pidAlive (pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

// Запись замка: кто держит, с какого момента и чем. `wx` — атомарный захват
// (файл не должен существовать), без флага — обновление своего же замка.
function writeLock (fresh) {
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), argv: process.argv[1] || '' })
    , fresh ? { flag: 'wx' } : undefined)
}

function acquireWindowLock () {
  // Повторный захват своим же процессом (звено гоняет окна одно за другим):
  // обновляем время замка, чтобы длинная цепочка не выглядела просроченной.
  if (process.env.ONECODE_WINDOW_LOCK_HELD === '1') {
    try {
      if (JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid === process.pid) writeLock(false)
    } catch { /* замок уже чужой или снят */ }
    return
  }
  const waitMs = Number(process.env.ONECODE_WINDOW_LOCK_WAIT || 30 * 60 * 1000)
  const started = Date.now()
  let warned = false
  for (;;) {
    try {
      // 'wx' — единственный атомарный способ занять замок: два процесса, пришедшие
      // в одну миллисекунду, не могут оба решить, что они первые.
      writeLock(true)
      process.env.ONECODE_WINDOW_LOCK_HELD = '1'
      // Свой замок снимаем своим же процессом при любом выходе — и только свой.
      process.on('exit', () => {
        try {
          const owner = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
          if (owner.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true })
        } catch { /* замок уже чужой или снят */ }
      })
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let held = null
      try { held = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) } catch { /* запись создана на полуслове */ }
      const age = held ? Date.now() - new Date(held.at).getTime() : Infinity
      // Мёртвый владелец — снимаем сразу, ждать не за чем: у процесса, убитого
      // посреди окна, освободить замок некому, а восемь минут ожидания на каждый
      // прогон — значит своими руками замедлить набор.
      if (!held || !pidAlive(held.pid)) {
        console.error('окно: снимаю замок ' + (held?.pid || '?') + ' (процесс мёртв)')
        try { fs.rmSync(LOCK_FILE, { force: true }) } catch {}
        continue
      }
      // Владелец жив — ждём, сколько бы он ни держал замок, и говорим об этом
      // вслух один раз. Молча обходить замок нельзя: «зелёный» прогон начал бы
      // означать «повезло, соседнее окно ещё не встало».
      if (age > LOCK_STALE_MS && !warned) {
        warned = true
        console.error('окно: замок держит живой процесс ' + held.pid + ' (' + (held.argv || '?')
          + ') уже ' + Math.round(age / 60000) + ' мин — жду, не обходя замок')
      }
      if (Date.now() - started > waitMs) throw new Error('окно: замок занят уже ' + Math.round(waitMs / 1000)
        + ' с — держит живой процесс ' + (held?.pid || '?') + ' (' + (held?.argv || '') + '); прогон либо висит, либо выставь ONECODE_WINDOW_LOCK_WAIT')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
    }
  }
}

function guiEnv (extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  // Версии Pro и Ultra выключены для людей (channel.cjs); оконные проверки их оболочек включают их явно.
  if (env.ONECODE_SMOKE && env.ONECODE_VERSIONS === undefined) env.ONECODE_VERSIONS = '1'
  // `src/main/main.js` при ONECODE_SMOKE без ONECODE_SMOKE_OUT пишет вердикт в
  // общий `%TEMP%\onecode-smoke.json`: два прогона читают чужой результат, и
  // «окно не отчиталось» приходит от того, кто закончил позже. Main.js правит не
  // этот сеанс, поэтому запрет на стороне харнесса — здесь он и должен жить.
  if (env.ONECODE_SMOKE && !env.ONECODE_SMOKE_OUT) {
    throw new Error('ONECODE_SMOKE без ONECODE_SMOKE_OUT: вердикт пойдёт в общий %TEMP%\\onecode-smoke.json. '
      + 'Заведи каталог через runDir() и передай в ONECODE_SMOKE_OUT свой путь.')
  }
  // Окно за окном: сериализуем именно запуск окна (он задан через ONECODE_SMOKE),
  // а не любой прогон — проверки без окна стоят в очереди бесполезно.
  if (env.ONECODE_SMOKE) acquireWindowLock()
  return env
}

module.exports = { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock }
