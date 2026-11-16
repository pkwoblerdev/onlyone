// Н37: куда уходит нечитаемый конверт из файла настроек (быстрая проверка).
//
// `tests/run-settings-archive-ui.cjs` показывает беду настоящим окном на
// временном профиле: прежний дубль `store.set(`${key}.corrupt.bak`, raw)` для
// electron-store означает вложенный путь, поэтому копия оседала внутри живого
// конверта (файл настроек удваивался), а у строки или массива живое значение
// ещё и заменялось подставным объектом. Этот набор проверяет то же самое на
// тех же функциях `main.js`, но за миллисекунды и без Electron: вырезаны и
// вызваны `archiveCorruptSettings`, `takeCorruptBackup`, `migrateCorruptBackups`
// и `readStoreSecure`.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const fsSync = require('fs')   // тот же объект модуля, что берёт profile-notice.cjs
const root = path.join(__dirname, '..')
const { createProfileNotice } = require('../src/main/profile-notice.cjs')
// Путь подменяется только мутационному харнессу
// `audits/qoder-2-2026-09-24/settings-archive-mutation.cjs`, который возвращает
// в копию прежний дубль в настройках и проверяет, что набор краснеет.
const main = fs.readFileSync(process.env.ONECODE_MAIN_UNDER_TEST ||
  path.join(root, 'src', 'main', 'main.js'), 'utf8')

function at(marker, from = 0) {
  const index = main.indexOf(marker, from)
  assert.ok(index >= 0, 'якорь пропал из main.js: ' + marker)
  return index
}

// Архив вынесен в profile-notice.cjs (А-3): из main.js проверяется чтение
// настроек, которое зовёт архив, а сам архив приходит модулем.
const REGION = main.slice(at('// Что именно оставила прежняя версия'),
  at('function storageEncrypted(key)'))

let checks = 0
const failures = []
function check(name, fn) {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-settings-archive-unit-'))
const BLOB = 'QUJD' + 'x'.repeat(400)
const SECRET = 'Секрет: sk-or-v1-EXAMPLE233cf8ed4'

// Хранилище настроек с теми же правилами, что у electron-store: имя с точкой —
// не имя, а вложенный путь (dot-prop), и по дороге на место не-объекта встаёт
// `{}`. Без этого проверка «живое значение не тронуто» была бы слабее, чем
// называется: настоящий механизм портил данные именно так.
function fakeStore(initial) {
  const data = { ...initial }
  const isPlain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
  const walk = (parts, make) => {
    let node = data
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]
      if (!isPlain(node[key])) {
        if (!make) return null
        node[key] = {}
      }
      node = node[key]
    }
    return { node, last: parts[parts.length - 1] }
  }
  return {
    get: (key, dflt) => {
      const found = walk(String(key).split('.'), false)
      if (!found) return dflt
      return found.node[found.last] === undefined ? dflt : found.node[found.last]
    },
    set: (key, value) => {
      const parts = String(key).split('.')
      const found = parts.length === 1 ? { node: data, last: parts[0] } : walk(parts, true)
      found.node[found.last] = value
    },
    has: key => {
      const found = walk(String(key).split('.'), false)
      return Boolean(found) && found.node[found.last] !== undefined
    },
    delete: key => {
      const found = walk(String(key).split('.'), false)
      if (found) delete found.node[found.last]
    },
    get store() { return { ...data } },
    dump: () => data
  }
}

function build(dir, initial, options = {}) {
  const log = []
  const store = fakeStore(initial)
  const latency = { write: (text, info) => log.push(`${text} ${info === undefined ? '' : JSON.stringify(info)}`) }
  const notice = createProfileNotice({
    bulk: () => ({ integrity: () => ({ keyLost: [], unreadable: [], blocked: [] }) }),
    bulkKeys: new Set(),
    dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
    app: { getPath: () => dir },
    join: path.join,
    tr: text => text,
    latency,
    fs: fsSync
  })
  const api = new Function('archiveCorruptSettings', 'join', 'app', 'latency', 'store', 'safeStorage', 'requireWindowsEncryption',
    `${REGION}
     return { takeCorruptBackup, migrateCorruptBackups, readStoreSecure, store }`)(
    notice.archiveCorruptSettings,
    path.join,
    { getPath: () => dir },
    latency,
    store,
    { decryptString: () => { throw new Error('decrypt failed') } },
    options.encryptionAvailable !== false)
  return { ...notice, ...api, log, store, dir }
}

const archiveDirOf = dir => path.join(dir, 'settings-corrupt')
const readArchive = (dir, key) => {
  const file = path.join(archiveDirOf(dir), `${key}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

try {
  // -------------------------------------------------------------------------
  // Что пишет readStoreSecure при отказе
  // -------------------------------------------------------------------------

  check('сбой дешифрования не трогает живое значение в настройках', () => {
    const dir = mkDir()
    try {
      const ctx = build(dir, { conversations: { enc: 'safeStorage', data: BLOB } })
      assert.deepEqual(ctx.readStoreSecure('conversations', []), [])
      assert.deepEqual(ctx.store.dump().conversations, { enc: 'safeStorage', data: BLOB },
        'живой конверт изменён — прежний механизм вставлял в него копию')
      assert.ok(!JSON.stringify(ctx.store.dump()).includes('"corrupt"'), 'в настройках остался дубль')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  check('нечитаемый конверт уходит в файл архива один раз на ключ', () => {
    const dir = mkDir()
    try {
      const ctx = build(dir, { mcpServers: BLOB })
      ctx.readStoreSecure('mcpServers', [])
      ctx.readStoreSecure('mcpServers', [])
      ctx.readStoreSecure('mcpServers', [])
      assert.deepEqual(readArchive(dir, 'mcpServers'), BLOB, 'архива нет или он не тот')
      assert.deepEqual(fs.readdirSync(archiveDirOf(dir)), ['mcpServers.json'],
        'файлов архива больше одного')
      assert.equal(ctx.store.dump().mcpServers, BLOB, 'строковое значение съедено подменой формы')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  check('в архиве — шифр, а не расшифрованное содержимое', () => {
    const dir = mkDir()
    try {
      const ctx = build(dir, { skills: { enc: 'safeStorage', data: Buffer.from(SECRET).toString('base64') } })
      ctx.readStoreSecure('skills', [])
      const dumped = JSON.stringify(readArchive(dir, 'skills')) + ctx.log.join('\n')
      assert.ok(!dumped.includes(SECRET), 'в архив или журнал уехало содержимое')
      assert.ok(dumped.includes(Buffer.from(SECRET).toString('base64')), 'в архиве нет того, что не читается')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  check('файл архива пишется атомарно и не оставляет мусора', () => {
    const dir = mkDir()
    try {
      const ctx = build(dir, { projects: { enc: 'safeStorage', data: BLOB } })
      ctx.readStoreSecure('projects', [])
      assert.deepEqual(fs.readdirSync(archiveDirOf(dir)), ['projects.json'],
        'рядом с архивом осталась временная запись')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  check('архив недоступен — настройки не трогаются и ход не падает', () => {
    const dir = mkDir()
    const realMkdir = fsSync.mkdirSync
    try {
      const ctx = build(dir, { conversations: { enc: 'safeStorage', data: BLOB } })
      // Путь папки архива занят файлом: ни mkdir, ни запись не пройдут.
      fs.writeFileSync(archiveDirOf(dir), 'занято')
      assert.deepEqual(ctx.readStoreSecure('conversations', []), [])
      assert.deepEqual(ctx.store.dump().conversations, { enc: 'safeStorage', data: BLOB },
        'без архива значение пострадало')
      assert.ok(ctx.log.some(text => text.includes('settings archive-failed')), 'отказ архива не описан')
    } finally {
      fsSync.mkdirSync = realMkdir
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // Что происходит с профилем, который уже испортила прежняя версия
  // -------------------------------------------------------------------------

  check('копия внутри живого конверта выносится, конверт остаётся', () => {
    const dir = mkDir()
    try {
      const ctx = build(dir, {
        conversations: { enc: 'safeStorage', data: BLOB, corrupt: { bak: { enc: 'safeStorage', data: BLOB } } }
      })
      ctx.migrateCorruptBackups()
      assert.deepEqual(ctx.store.dump().conversations, { enc: 'safeStorage', data: BLOB },
        'живой конверт не очищен от копии')
      assert.deepEqual(readArchive(dir, 'conversations'), { enc: 'safeStorage', data: BLOB },
        'копия не перенесена в архив')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  check('съеденное значение возвращается на место, а не дублируется', () => {
    const dir = mkDir()
    try {
      const ctx = build(dir, { mcpServers: { corrupt: { bak: BLOB } } })
      ctx.migrateCorruptBackups()
      assert.equal(ctx.store.dump().mcpServers, BLOB, 'значение не восстановлено из копии')
      assert.equal(readArchive(dir, 'mcpServers'), null,
        'создан лишний архив: копия и есть живое значение')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  check('повторный перенос не трогает то, что уже разобран', () => {
    const dir = mkDir()
    try {
      const ctx = build(dir, { mcpServers: { corrupt: { bak: BLOB } } })
      ctx.migrateCorruptBackups()
      const once = JSON.stringify(ctx.store.dump())
      ctx.migrateCorruptBackups()
      assert.equal(JSON.stringify(ctx.store.dump()), once, 'второй запуск что-то переписал')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  check('чтение архива не подменяет живые данные', () => {
    const dir = mkDir()
    try {
      const ctx = build(dir, {
        projects: [{ id: 'p1' }],
        personal: { name: 'Паша' }
      })
      ctx.migrateCorruptBackups()
      assert.deepEqual(ctx.store.dump().projects, [{ id: 'p1' }], 'затронут ключ без копии')
      assert.deepEqual(ctx.store.dump().personal, { name: 'Паша' })
      assert.equal(fs.existsSync(archiveDirOf(dir)), false, 'на пустом профиле создана папка архива')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  check('массивное значение, сведённое прежним механизмом в объект, тоже возвращается', () => {
    const dir = mkDir()
    try {
      const ctx = build(dir, { skills: { corrupt: { bak: [{ id: 's1', name: 'скилл' }] } } })
      ctx.migrateCorruptBackups()
      assert.deepEqual(ctx.store.dump().skills, [{ id: 's1', name: 'скилл' }])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // -------------------------------------------------------------------------
  // Проводка: перенос обязан запускаться до первого чтения настроек
  // -------------------------------------------------------------------------

  check('разбор прежних копий стоит на старте, до первого чтения', () => {
    const ready = at('app.whenReady().then(() => {')
    const migrate = at('migrateCorruptBackups()', ready)
    const window = at('createWindow()', ready)
    assert.ok(migrate < window, 'профиль разбирается уже после того, как окно начало читать настройки')
  })
} finally {
  if (failures.length) console.error(`\nпровалено проверок: ${failures.length} из ${checks + failures.length}`)
}
console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
process.exit(failures.length ? 1 : 0)
