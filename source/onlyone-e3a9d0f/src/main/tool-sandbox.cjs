// Граница исполнения для собственного кода агента.
//
// Правил пути и Node Permission Model мало: независимый аудит прошёл через
// directory junction наружу, открыл внешнюю базу `node:sqlite` и поднял
// сетевой listener. Этот модуль ставит границу в самом Processes, где живёт
// чужой код: файлы — только внутри канонических корней (по `realpath`, так что
// ссылка наружу не проходит), и целиком запрещены модули и глобальные функции,
// которыми own-код уходил бы за периметр.
//
// Устанавливается ДО загрузки файла инструмента: трогает только то, что
// инструмент запрашивает сам (`require('fs')`, `require('net')`), и не мешает
// внутренностям Node, которые взяли свои ссылки раньше.

const path = require('path')

// Что запрещено entirely: сеть, подпроцессы, потоки, внешние хранилища,
// нативные дополнения. Список закрытый — новое имя в Node не должно
// случайно оказаться разрешённым, поэтому проверяется и по «голому» имени.
const BLOCKED = new Set([
  'net', 'tls', 'dgram', 'dns', 'http', 'https', 'http2', 'worker_threads', 'child_process',
  'cluster', 'repl', 'inspector', 'sqlite', 'addon', 'wasi', 'sea'
])

// Функции fs, которым нужен путь, и номера аргументов с путём.
const PATH_ARGS = {
  readFile: [0], readFileSync: [0], writeFile: [0], writeFileSync: [0], appendFile: [0], appendFileSync: [0],
  copyFile: [0, 1], copyFileSync: [0, 1], exists: [0], existsSync: [0], stat: [0], fstat: [0], statSync: [0],
  lstat: [0], lstatSync: [0], readdir: [0], readdirSync: [0], mkdir: [0], mkdirSync: [0], rm: [0], rmSync: [0],
  rmdir: [0], rmdirSync: [0], unlink: [0], unlinkSync: [0], rename: [0, 1], renameSync: [0, 1],
  open: [0], openSync: [0], createReadStream: [0], createWriteStream: [0], truncate: [0], truncateSync: [0],
  chmod: [0], chmodSync: [0], chown: [0], chownSync: [0], utimes: [0], utimesSync: [0],
  lutimes: [0], lutimesSync: [0], access: [0], accessSync: [0], watch: [0], watchFile: [0], unwatchFile: [0],
  realpath: [0], realpathSync: [0], readlink: [0], readlinkSync: [0], link: [0, 1], linkSync: [0, 1],
  symlink: [0, 1], symlinkSync: [0, 1], glob: [0], globSync: [0], write: [1], writev: [1],
  // break-5 Н1: имена, которых список не знал, wrap() отдавал как есть —
  // cpSync/opendir/mkdtemp/statfs уводили чтение и запись через junction наружу.
  cp: [0, 1], cpSync: [0, 1], mkdtemp: [0], mkdtempSync: [0], mkdtempDisposableSync: [0],
  opendir: [0], opendirSync: [0], statfs: [0], statfsSync: [0], openAsBlob: [0],
  lchown: [0], lchownSync: [0], lchmod: [0], lchmodSync: [0], writeSync: [0], writevSync: [0]
}

// writeSync/writevSync принимают fd, а не путь: числовой fd законен (получить
// его можно только через обёрнутый open), всё остальное судится как путь.
const FD_ARGS = new Set(['writeSync', 'writevSync'])

// Что меняет файлы: для таких путь проверяется на запись, а не на чтение.
const WRITERS = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync',
  'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile',
  'copyFileSync', 'createWriteStream', 'truncate', 'truncateSync', 'chmod', 'chmodSync', 'chown',
  'chownSync', 'utimes', 'utimesSync', 'lutimes', 'lutimesSync', 'open', 'openSync', 'symlink',
  'symlinkSync', 'link', 'linkSync', 'write', 'writev', 'glob', 'globSync',
  'cp', 'cpSync', 'mkdtemp', 'mkdtempSync', 'mkdtempDisposableSync',
  'lchown', 'lchownSync', 'lchmod', 'lchmodSync', 'writeSync', 'writevSync'])

// Константы доступа: Node отдаёт их ленивым геттером, и чтение само по себе
// печатает предупреждение DEP0176. Пути они не выбирают, поэтому джилл их не
// оборачивает, а отдаёт как есть — иначе шум оседал бы в логе каждого своего
// инструмента.
const LAZY_CONSTANTS = new Set(['F_OK', 'R_OK', 'W_OK', 'X_OK'])

function describePath(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value && typeof value === 'object' && typeof value.pathname === 'string') return value.pathname
  return null
}

function create({ roots, fs: realFs, cwd = process.cwd(), onDeny = () => {} }) {
  // Корня дожидаемся один раз и замораживаем: инструмент не должен расширить
  // периметр, подделав переменные окружения или повторный вызов install.
  const allowed = []
  for (const root of roots) {
    let real = null
    try { real = realFs.realpathSync(root) } catch { continue }
    allowed.push(real)
  }
  Object.freeze(allowed)

  const inside = target => allowed.some(root => {
    if (target === root) return true
    const rel = path.relative(root, target)
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  })

  // Junction и symlink обманывают лексическую проверку: `refs/portal/x` выглядит
  // внутри, а реальный путь — снаружи. Поэтому проверяется самый глубокий
  // существующий элемент пути и, если сам файл существует, его реальный путь.
  function deny(text, target, kind) {
    onDeny({ path: target, kind })
    // Код тот же, что у модели прав Node: и человек, и независимая приёмка
    // различают «отказала граница» по знакомому коду, а не по формулировке.
    const error = new Error(text)
    error.code = 'ERR_ACCESS_DENIED'
    throw error
  }

  function assertAllowed(rawPath, kind) {
    const text = describePath(rawPath)
    if (text === null) deny('Свой инструмент обращается к файлу без имени — путь должен быть строкой.', String(rawPath), kind)
    const target = path.resolve(cwd, text)
    let probe = target
    for (;;) {
      let real = null
      try { real = realFs.realpathSync(probe) } catch { real = null }
      if (real !== null) {
        if (!inside(real)) deny(`Файл «${text}» лежит вне рабочей папки — свой инструмент ограничен ею.`, target, kind)
        return
      }
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    deny(`Файл «${text}» лежит вне рабочей папки — свой инструмент ограничен ею.`, target, kind)
  }

  function wrap(name, fn) {
    const indexes = PATH_ARGS[name]
    if (typeof fn !== 'function' || !indexes) return fn
    const wantsWrite = WRITERS.has(name)
    return function jail(...args) {
      for (const index of indexes) {
        if (index >= args.length) continue
        if (FD_ARGS.has(name) && typeof args[index] === 'number') continue
        assertAllowed(args[index], wantsWrite ? 'write' : 'read')
      }
      // glob судит и каталог поиска из options: паттерн сам по себе может быть
      // относительным, а cwd — вести наружу.
      if ((name === 'glob' || name === 'globSync') && args[1] && typeof args[1] === 'object' && args[1].cwd != null) {
        assertAllowed(args[1].cwd, 'read')
      }
      return fn.apply(this, args)
    }
  }

  function jailFs(original) {
    const copy = Object.create(null)
    const names = new Set([...Object.keys(original), ...Object.getOwnPropertyNames(original)])
    for (const name of names) {
      // Константы доступа Node отдаёт ленивым геттером с предупреждением
      // (DEP0176): читать их при перечислении — значит шуметь этим в логе
      // каждого своего инструмента. Путём они не управляют, а `promises` и
      // классы потоков читаются как читались — их джиллит `wrap`.
      if (LAZY_CONSTANTS.has(name)) {
        const descriptor = Object.getOwnPropertyDescriptor(original, name)
        if (descriptor && typeof descriptor.get === 'function') {
          Object.defineProperty(copy, name, { get: descriptor.get, enumerable: true, configurable: true })
          continue
        }
      }
      let value
      try { value = original[name] } catch { continue }
      copy[name] = name === 'promises' && value && typeof value === 'object'
        ? jailPromises(value)
        : wrap(name, value)
    }
    return new Proxy(copy, {
      get: (target, key) => (key in target ? target[key] : (() => {
        // Неизвестное имя с путём — не пропускать молча: пусть инструмент
        // получит явный отказ, чем тихий доступ мимо границы.
        if (typeof key === 'string' && /path/i.test(key)) {
          throw new Error(`Свой инструмент зовёт «fs.${key}» — вне рабочей папки это запрещено.`)
        }
        return undefined
      })())
    })
  }

  function jailPromises(promises) {
    const copy = Object.create(null)
    for (const name of new Set([...Object.keys(promises), ...Object.getOwnPropertyNames(promises)])) {
      let value
      try { value = promises[name] } catch { continue }
      copy[name] = wrap(name, value)
    }
    return copy
  }

  const fsJail = jailFs(realFs)

  return {
    allowed,
    assertAllowed,
    /** Что вернуть на `require('fs')` и `require('fs/promises')`. */
    for: specifier => {
      const bare = specifier.replace(/^node:/, '')
      if (bare === 'fs') return fsJail
      if (bare === 'fs/promises') return jailPromises(realFs.promises)
      return null
    },
    blocked: name => BLOCKED.has(name.replace(/^node:/, ''))
  }
}

// Поверхности самого `process`, которым не нужен `require`: `Module._load` их не
// видит, обёрнутый `fs` их не касается. Проба на настоящем runner-е:
// через `process.getBuiltinModule('child_process')` свой инструмент поднимал
// подпроцессы, `process.kill(ppid, 0)` отвечал истиной на вопрос «могу ли я
// послать сигнал приложению», `process.dlopen` и `process._debugProcess` были
// доступны как есть.
//
// Имена снимаются вызовом, а не стиранием: `process.dlopen` — функция и до границы,
// и после неё, поэтому проверяться может только тем, что происходит при обращении.
const PROCESS_DENY = ['dlopen', '_debugProcess', '_debugEnd', '_debugPauseOnConnect']

function guardProcess ({ jail, onDeny = () => {}, target = process }) {
  const refuse = what => {
    onDeny({ path: what, kind: 'process' })
    const error = new Error(`Свой инструмент не может использовать «${what}»: `
      + 'сеть, подпроцессы, потоки и внешние хранилища закрыты границей onlyone.')
    error.code = 'ERR_ACCESS_DENIED'
    throw error
  }

  // Встроенный модуль напрямую — то же правило, что и для `require`: список
  // закрытый, а `fs` отдаётся джиллованный, иначе чтение наружу вернулось бы
  // одной строчкой в обход всей границы.
  const realBuiltin = typeof target.getBuiltinModule === 'function'
    ? target.getBuiltinModule.bind(target) : null
  if (realBuiltin) {
    target.getBuiltinModule = id => {
      const bare = String(id || '').replace(/^node:/, '')
      if (jail.blocked(bare)) refuse(bare)
      return jail.for(bare) || realBuiltin(bare)
    }
  }

  // Внутренние связки Node — не поддерживаемый API: ни одному инструменту они не
  // нужны, а и чтение наружу, и запуск процессов через них делается в обход
  // всего, что поставлено выше.
  if (typeof target.binding === 'function') {
    target.binding = name => refuse(`process.binding(${String(name || '')})`)
  }

  // Сигнал — только собственному процессу: убить приложение, сборку соседа или
  // сервис машины своему инструменту не за чем. Закрывается не одно имя, а право:
  // `process.kill` на Windows внутри зовёт `process._kill`, и иначе сигнал чужому
  // процессу уходил бы в обход обёрнутого `kill`.
  const signalDoor = (name, real) => (pid, signal) =>
    (pid === target.pid ? real(pid, signal) : refuse(`${name} чужого процесса`))
  if (typeof target.kill === 'function') target.kill = signalDoor('process.kill', target.kill.bind(target))
  if (typeof target._kill === 'function') target._kill = signalDoor('process._kill', target._kill.bind(target))

  // Порядок важен: настоящая отправка сигнала захвачена до того, как имена
  // заменены на отказ.
  for (const name of PROCESS_DENY) {
    if (typeof target[name] === 'function') target[name] = () => refuse(`process.${name}`)
  }

  // Смена каталога процесса уводит настоящий fs от замороженного cwd границы:
  // относительные пути стали бы проверяться по одной папке, а открываться в другой.
  if (typeof target.chdir === 'function') target.chdir = () => refuse('process.chdir')
}

module.exports = { create, BLOCKED, PATH_ARGS, WRITERS, guardProcess, PROCESS_DENY }
