// Хранилище Workspace (U-7): профиль на диске и перенос контейнера в файл.
//
// Ядро контейнера (`src/main/workspace-crate.js`) проверяется в
// `test-workspace-crate.cjs`. Здесь другое: как Workspace живёт в профиле и как
// он уходит к другому человеку и возвращается.
//
// ПРОВЕРЯЕТСЯ БЕЗ ELECTRON. Модуль получает файловую систему, каталог и
// `protect`/`unprotect` зависимостями, поэтому набор гоняет его на своём
// временном каталоге и с честным «шифром», который просто ходит туда-сюда. Если
// модуль полезет в `app.getPath` или в `safeStorage` напрямую, набор об этом
// скажет: не сможет подменить.
//
// ЧТО ЗДЕСЬ СУЩЕСТВЕННО. Три вещи, которые нельзя проверить ядром:
//   1. профиль переживает перезапуск и не остаётся в памяти;
//   2. профиль на диске зашифрован — как и всё остальное в `userData`;
//   3. ЭКСПОРТ и ИМПОРТ — симметричны: выгруженный файл, загруженный обратно на
//      ЧИСТОМ профиле, даёт тот же Workspace. Это и есть «Ultra = Ultra».
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createWorkspaceStore } = require('../src/main/workspace-store')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn(); console.log('ok', name) } catch (error) {
    failed++
    console.error('FAIL', name, error.message)
  }
}

const MINE = {
  name: 'Студия йоги',
  agents: ['Ведущий'],
  tools: ['write_file'],
  files: ['main.js', 'app.js'],
  context: 'Правка лендинга',
  blocks: [{ title: 'Лендинг', role: 'artifact', x: 10, y: 20, w: 360, h: 480, zone: 'left' }],
  scenarios: [{ title: 'Правка лендинга', blocks: ['Лендинг'] }]
}

// «Шифр» для проверки: не криптография, а факт, что данные прошли через
// protect и не лежат на диске открытым текстом. Именно это и проверяется.
const cipher = value => 'enc:' + Buffer.from(String(value), 'utf8').toString('base64')
const plain = value => Buffer.from(String(value).replace(/^enc:/, ''), 'base64').toString('utf8')

function store (dir, extra) {
  return createWorkspaceStore({ dir, fs, protect: cipher, unprotect: plain, ...extra })
}

const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), name))

// ─── профиль ─────────────────────────────────────────────────────────────────

check('новый профиль читается пустым, а не падает', () => {
  const s = store(tmp('onlyone-ws-empty-'))
  const got = s.load()
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.workspace.blocks.length, 0)
  assert.equal(got.workspace.name, 'Workspace', 'у пустого профиля должно быть имя, а не неопределённость')
})

check('Workspace переживает перезапуск: новый экземпляр видит то, что записали', () => {
  const dir = tmp('onlyone-ws-restart-')
  assert.equal(store(dir).save(MINE).ok, true)
  const again = store(dir).load()
  assert.equal(again.ok, true, again.reason)
  assert.deepEqual(again.workspace.blocks, store(dir).load().workspace.blocks)
  assert.equal(again.workspace.context, 'Правка лендинга')
  assert.deepEqual(again.workspace.agents, ['Ведущий'])
})

check('на диске профиль зашифрован, а не лежит открытым текстом', () => {
  const dir = tmp('onlyone-ws-enc-')
  store(dir).save(MINE)
  const file = path.join(dir, 'workspace.json')
  assert.ok(fs.existsSync(file), 'файла профиля нет')
  const raw = fs.readFileSync(file, 'utf8')
  assert.ok(!raw.includes('Правка лендинга'), 'контекст лежит на диске открытым текстом')
  const envelope = JSON.parse(raw)
  assert.equal(envelope.enc, 'safeStorage', 'конверт safeStorage обязателен')
  assert.equal(typeof envelope.data, 'string')
})

check('оборванная запись не портит прежний Workspace', () => {
  // Прежняя проверка «рядом не осталось мусора» была слабой: и без атомарной
  // записи временный файл не остаётся, и проверка проходила. Настоящее свойство
  // другое: если запись оборвалась (диск кончился, файл занят), прежний
  // Workspace должен УЦЕЛЕТЬ, а не превратиться в половину.
  const dir = tmp('onlyone-ws-torn-')
  const cipher = value => 'enc:' + Buffer.from(String(value), 'utf8').toString('base64')
  const plainOf = value => Buffer.from(String(value).replace(/^enc:/, ''), 'base64').toString('utf8')
  store(dir).save(MINE)
  const file = path.join(dir, 'workspace.json')
  const before = fs.readFileSync(file, 'utf8')

  // Диск, на котором `rename` не удаётся: запись дошла до конца, но файл не
  // переехал на место.
  const brokenFs = Object.create(fs)
  brokenFs.renameSync = () => { throw Object.assign(new Error('устройство занято'), { code: 'EBUSY' }) }
  const broken = createWorkspaceStore({ dir, fs: brokenFs, protect: cipher, unprotect: plainOf })
  const result = broken.save({ ...MINE, name: 'Порча' })
  assert.equal(result.ok, false, 'оборванная запись обязана называть причину, а не рапортовать об успехе')
  assert.ok(result.reason.length > 0, 'причина обязана быть')
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'прежний Workspace изменился при оборванной записи')
  assert.equal(store(dir).load().workspace.name, 'Студия йоги', 'прежний Workspace перестал читаться')
})

check('рядом с профилем не остаётся временных файлов', () => {
  const dir = tmp('onlyone-ws-atomic-')
  store(dir).save(MINE)
  const names = fs.readdirSync(dir).filter(name => name.includes('.tmp'))
  assert.deepEqual(names, [], `рядом осталось: ${names.join(', ')}`)
})

check('битый профиль не роняет окно, а называет причину', () => {
  const dir = tmp('onlyone-ws-corrupt-')
  fs.writeFileSync(path.join(dir, 'workspace.json'), '{ это не json', 'utf8')
  const got = store(dir).load()
  assert.equal(got.ok, false, 'битый профиль принят как пустой — человек бы решил, что Workspace не сохраняется')
  assert.ok(got.reason && got.reason.length > 0, 'причина обязана быть')
})

// ─── перенос: выгрузить и загрузить на чужом ────────────────────────────────

check('экспорт кладёт переносимый контейнер в выбранный файл', () => {
  const dir = tmp('onlyone-ws-export-')
  const to = path.join(tmp('onlyone-ws-out-'), 'moe.workspace')
  const done = store(dir).exportTo(to, MINE, { author: 'Владелец' })
  assert.equal(done.ok, true, done.reason)
  assert.ok(fs.existsSync(to), 'файл контейнера не создан')
  const body = JSON.parse(fs.readFileSync(to, 'utf8'))
  assert.equal(body.format, 'onlyone.workspace')
  assert.equal(body.author, 'Владелец')
})

check('импорт на ЧИСТОМ профиле даёт тот же Workspace — это и есть «Ultra = Ultra»', () => {
  const from = tmp('onlyone-ws-a-')
  const toDir = tmp('onlyone-ws-b-')
  const file = path.join(tmp('onlyone-ws-file-'), 'moe.workspace')
  store(from).save(MINE)
  const exported = store(from).exportTo(file, MINE)
  assert.equal(exported.ok, true, exported.reason)
  // Другой человек: другой профиль, чистый. Ничего своего, кроме пустого.
  const theirs = store(toDir)
  const got = theirs.importFrom(file, { available: ['main.js', 'app.js', 'index.html'] })
  assert.equal(got.ok, true, got.reason)
  assert.deepEqual(got.missing, [], 'файлы из контейнера нашлись — а список не пуст')
  assert.deepEqual(got.workspace, store(from).load().workspace, 'Workspace после переноса разошёлся с исходным')
})

check('экспорт и импорт сохраняют раскладку блоков до пикселя', () => {
  const dir = tmp('onlyone-ws-geom-')
  const file = path.join(tmp('onlyone-ws-geomfile-'), 'x.workspace')
  store(dir).exportTo(file, MINE)
  const got = store(dir).importFrom(file, { available: MINE.files })
  assert.equal(got.ok, true, got.reason)
  assert.deepEqual(got.workspace.blocks[0],
    { title: 'Лендинг', role: 'artifact', x: 10, y: 20, w: 360, h: 480, zone: 'left', minimized: false })
})

check('файл, которого у другого человека нет, назван вслух', () => {
  const dir = tmp('onlyone-ws-missing-')
  const file = path.join(tmp('onlyone-ws-mfile-'), 'x.workspace')
  store(dir).exportTo(file, MINE)
  const got = store(dir).importFrom(file, { available: ['main.js'] })
  assert.equal(got.ok, true, got.reason)
  assert.deepEqual(got.missing, ['app.js'], 'молча выбросить файл — значит выдать неполный разворот за полный')
  assert.deepEqual(got.workspace.files, ['main.js'])
})

check('подменённый на лету контейнер не разворачивается', () => {
  const dir = tmp('onlyone-ws-tamper-')
  const file = path.join(tmp('onlyone-ws-tfile-'), 'x.workspace')
  store(dir).exportTo(file, MINE)
  const body = JSON.parse(fs.readFileSync(file, 'utf8'))
  body.context = 'Подмена'
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
  const got = store(dir).importFrom(file, { available: MINE.files })
  assert.equal(got.ok, false, 'подменённый контейнер принят')
  assert.match(got.reason, /сумма|изменён/i, got.reason)
})

check('экспорт в файл, куда нельзя писать, говорит причину, а не роняет окно', () => {
  const dir = tmp('onlyone-ws-nowrite-')
  const blocked = path.join(dir, 'нет-такой-папки', 'x.workspace')
  const got = store(dir).exportTo(blocked, MINE)
  assert.equal(got.ok, false)
  assert.ok(got.reason && got.reason.length > 0, 'причина обязана быть')
})

check('импорт несуществующего файла говорит причину', () => {
  const dir = tmp('onlyone-ws-nofile-')
  const got = store(dir).importFrom(path.join(dir, 'нет.workspace'), { available: [] })
  assert.equal(got.ok, false)
  assert.ok(got.reason.length > 0)
})

// ─── профиль и перенос не должны быть разными правдами ─────────────────────

check('импорт сразу становится текущим профилем, а не лежит рядом', () => {
  const dir = tmp('onlyone-ws-adopt-')
  const file = path.join(tmp('onlyone-ws-afile-'), 'x.workspace')
  store(dir).exportTo(file, MINE)
  const s = store(dir)
  assert.equal(s.importFrom(file, { available: MINE.files }).ok, true)
  const after = s.load()
  assert.equal(after.ok, true, after.reason)
  assert.deepEqual(after.workspace.blocks[0].title, 'Лендинг', 'импортированный Workspace не стал текущим')
})

check('модуль не берёт ничего от Electron', () => {
  const source = fs.readFileSync(require.resolve('../src/main/workspace-store'), 'utf8')
  assert.ok(!/require\(['"]electron['"]\)/.test(source), 'хранилище не должно знать про Electron')
  // Именно ВЫЗОВ, а не упоминание: объясняющий комментарий про `app.getPath` и
  // `safeStorage` в модуле есть и должен быть — иначе следующий читатель не
  // поймёт, почему путь и шифр приходят снаружи.
  assert.ok(!/app\.getPath\(/.test(source), 'путь профиля должен приходить снаружи')
  assert.ok(!/safeStorage\.(encryptString|decryptString|isEncryptionAvailable)\(/.test(source),
    'шифр должен приходить снаружи, иначе модуль нельзя проверить без окна')
})

if (failed) { console.error(`проверок: ${total}, провалов: ${failed}`); process.exitCode = 1 }
else console.log(`проверок: ${total}, провалов: 0`)
