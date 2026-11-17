// Н20: окно о потере ключа проверялось ДО чтения, которое эту потерю находит.
//
// `noticeKeyLoss()` стоял первой строкой обработчиков `get-conversations` и
// `get-designs`, а нечитаемый конверт обнаруживал `readSecure` ниже. В первом
// (часто единственном) вызове список `lostThisSession` ещё пуст, диалога нет, и
// человек видит пустое окно «Сначала познакомимся» вместо «данные не открылись».
// Здесь проверяется порядок и следствие: чтение сначала, объяснение — после.
// Отдельно — молчаливый архив секций настроек (`skills`, `mcpServers`): о нём
// раньше была только строка в журнале.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
globalThis.tr = require('../src/main/ui-text.cjs').tr
const { createProfileNotice } = require('../src/main/profile-notice.cjs')
const main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')

function at (marker, from = 0) {
  const index = main.indexOf(marker, from)
  assert.ok(index >= 0, 'якорь пропал из main.js: ' + marker)
  return index
}
const cut = (from, to) => main.slice(at(from), at(to, at(from) + from.length))

// Окно потеряло из main.js (вынос А-3) — проверяется настоящий модуль; архив
// нечитаемых секций тоже живёт там, а чтение настроек осталось в main.js.
const ARCHIVE = cut('// Что именно оставила прежняя версия', 'function storageEncrypted(key)')
const CHATS = cut("ipcMain.handle('get-conversations'", "ipcMain.handle('set-conversations'")
const DESIGNS = cut("ipcMain.handle('get-designs'", "ipcMain.handle('set-designs'")

let checks = 0
const failures = []
function check (name, fn) {
  try { fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}
async function checkAsync (name, fn) {
  try { await fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-key-notice-'))
const dropDir = dir => { if (!failures.length) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} } }

function buildMain (options = {}) {
  const dir = options.dir || mkDir()
  const dialogCalls = []
  const store = options.store || { get: () => undefined }
  const notice = createProfileNotice({
    bulk: () => ({ integrity: options.integrity || (() => ({ keyLost: [], unreadable: [], blocked: [] })) }),
    bulkKeys: new Set(['conversations', 'designs']),
    dialog: { showMessageBox: message => { dialogCalls.push(message); return Promise.resolve({ response: 0 }) } },
    app: { getPath: () => dir },
    join: path.join,
    tr: globalThis.tr,
    latency: { write: () => {} },
    fs
  })
  const api = new Function(
    'archiveCorruptSettings', 'join', 'app', 'latency', 'store', 'safeStorage',
    'requireWindowsEncryption', 'require',
    `${ARCHIVE}
     return { readStoreSecure }`)(
    notice.archiveCorruptSettings,
    path.join,
    { getPath: () => dir },
    { write: () => {} },
    store,
    { decryptString: () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.') } },
    () => true,
    require
  )
  return { ...notice, ...api, dialogCalls, dir }
}

function buildHandlers (noticeKeyLoss, readSecure) {
  const handlers = {}
  new Function('ipcMain', 'noticeKeyLoss', 'readSecure', 'historyGuard', 'app',
    `${CHATS}\n${DESIGNS}`)(
    { handle: (channel, fn) => { handlers[channel] = fn } },
    noticeKeyLoss,
    readSecure,
    { seen: () => {} },
    { isPackaged: true })
  return handlers
}

async function mainTest () {
  // Порядок: объяснение не может стоять до чтения, которое находит потерю.
  check('чтение переписки сначала читает, потом объясняет потерю', () => {
    const read = CHATS.indexOf('readSecure(')
    const notice = CHATS.indexOf('noticeKeyLoss()')
    assert.ok(read >= 0, 'get-conversations больше не читает историю')
    assert.ok(notice >= 0, 'get-conversations молчит о потере ключа')
    assert.ok(notice > read, 'noticeKeyLoss() стоит до readSecure — в первом вызове потеря ещё не найдена')
  })

  check('чтение дизайнов сначала читает, потом объясняет потерю', () => {
    const read = DESIGNS.indexOf('readSecure(')
    const notice = DESIGNS.indexOf('noticeKeyLoss()')
    assert.ok(read >= 0, 'get-designs больше не читает дизайны')
    assert.ok(notice >= 0, 'get-designs молчит о потере ключа')
    assert.ok(notice > read, 'noticeKeyLoss() стоит до readSecure — в первом вызове потеря ещё не найдена')
  })

  // Поведение: чтение и есть то место, где потеря обнаруживается. Диалог обязан
  // появиться уже после первого запроса, а не со второго.
  await checkAsync('пустой ответ из-за потерянного ключа объясняется в первом же запросе', async () => {
    let lost = false
    const ctx = buildMain({
      integrity: () => ({ keyLost: [], unreadable: lost ? ['conversations', 'designs'] : [], blocked: [] })
    })
    const handlers = buildHandlers(ctx.noticeKeyLoss, () => { lost = true; return [] })
    await handlers['get-conversations']({ sender: { id: 1 } })
    assert.equal(ctx.dialogCalls.length, 1, 'потеря найдена чтением, а человеку о ней не сказали')
    assert.match(ctx.dialogCalls[0].message, /не открыл/i)
    await handlers['get-designs']()
    assert.equal(ctx.dialogCalls.length, 1, 'одно и то же окно показывается на каждый запрос')
  })

  // Молчаливый архив секций настроек: `skills` и `mcpServers` уезжали в
  // settings-corrupt со строкой в журнале и больше ничем.
  await checkAsync('архив секции настроек не молчит, а называется в окне', async () => {
    const dir = mkDir()
    const ctx = buildMain({ dir, store: { get: () => ({ enc: 'safeStorage', data: 'AAAA' }) } })
    try {
      assert.deepEqual(ctx.readStoreSecure('skills', []), [])
      assert.ok(fs.existsSync(path.join(dir, 'settings-corrupt', 'skills.json')), 'секция не ушла в архив')
      ctx.noticeKeyLoss()
      assert.equal(ctx.dialogCalls.length, 1, 'о потерянных скиллах и MCP человеку не сказали')
      const text = ctx.dialogCalls[0].message + ' ' + ctx.dialogCalls[0].detail
      assert.match(text, /Скиллы/, 'архив не назван по имени: ' + text.slice(0, 160))
      assert.match(text, /settings-corrupt/, 'не сказано, где лежит архив')
      ctx.noticeKeyLoss()
      assert.equal(ctx.dialogCalls.length, 1, 'окно повторяется на каждый запрос')
    } finally { dropDir(dir) }
  })

  await checkAsync('на целом профиле окон нет', async () => {
    const ctx = buildMain()
    ctx.noticeKeyLoss()
    assert.deepEqual(ctx.dialogCalls, [], 'пугающее окно на ровном месте')
  })

  if (failures.length) console.error(`\nпровалено проверок: ${failures.length} из ${checks + failures.length}`)
  console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
  process.exit(failures.length ? 1 : 0)
}

mainTest().catch(error => {
  console.error('харнесс упал: ' + error.stack)
  process.exit(2)
})
