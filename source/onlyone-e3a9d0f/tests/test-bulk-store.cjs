// История и дизайны — в своих файлах, журнал задержек (план, пункт 1.7).
//
// Проверяется настоящий модуль на настоящем диске: перенос из старого места
// со сверкой и резервной копией, отказ переноса без потерь, испорченный файл,
// атомарная запись, склейка частых сохранений, запись при выходе. И журнал:
// медленная операция, долгая задача окна, зависание главного процесса.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bulkStore = require('../src/main/bulk-store.js')
const latencyLog = require('../src/main/latency-log.js')

let failed = 0
let total = 0
const check = async (name, fn) => {
  total++
  try { await fn() } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

// Конверт как у настоящего: base64 JSON-строки. Шифрование — забота вызывающего.
const encode = json => ({ enc: 'plain', data: Buffer.from(json, 'utf8').toString('base64') })
const decode = envelope => JSON.parse(Buffer.from(envelope.data, 'base64').toString('utf8'))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-store-'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function legacyOf(initial) {
  const data = new Map(Object.entries(initial))
  const log = { dropped: [], backups: 0, writes: 0 }
  return {
    log,
    data,
    has: key => data.has(key),
    read: (key, fallback) => data.has(key) ? data.get(key) : fallback,
    write: (key, value) => { log.writes++; data.set(key, value) },
    drop: key => { log.dropped.push(key); data.delete(key) },
    backup: () => { log.backups++ }
  }
}

async function main() {
  await check('новый набор: запись в фоне, чтение из памяти и с диска', async () => {
    const dir = tmp()
    const store = bulkStore.create({ dir, encode, decode })
    assert.deepEqual(store.get('conversations', []), [])
    store.set('conversations', [{ id: 'a', title: 'Первый' }])
    assert.deepEqual(store.get('conversations', []), [{ id: 'a', title: 'Первый' }], 'сразу из памяти')
    await store.flush()
    const again = bulkStore.create({ dir, encode, decode })
    assert.deepEqual(again.get('conversations', []), [{ id: 'a', title: 'Первый' }], 'после перезапуска — с диска')
    assert.equal(fs.existsSync(store.fileOf('conversations') + '.tmp'), false, 'временный файл не остаётся')
  })

  await check('перенос из старого места: сверка, копия, удаление старого', async () => {
    const dir = tmp()
    const chats = [{ id: 'x', messages: [{ role: 'user', content: 'привет' }] }]
    const legacy = legacyOf({ conversations: chats })
    const store = bulkStore.create({ dir, encode, decode, legacy })
    assert.deepEqual(store.get('conversations', []), chats)
    assert.deepEqual(legacy.log.dropped, ['conversations'], 'старое удалено после сверки')
    assert.equal(legacy.log.backups, 1, 'копия настроек снята до удаления')
    assert.deepEqual(bulkStore.create({ dir, encode, decode }).get('conversations', []), chats, 'новый файл читается сам')
  })

  await check('перенос не сошёлся — старое остаётся, работа идёт по-старому', async () => {
    const dir = tmp()
    const legacy = legacyOf({ designs: [{ id: 'd1' }] })
    // Порча при чтении: записанное не совпадёт с прочитанным.
    const badDecode = envelope => ({ broken: decode(envelope) })
    const store = bulkStore.create({ dir, encode, decode: badDecode, legacy })
    assert.deepEqual(store.get('designs', []), [{ id: 'd1' }])
    assert.deepEqual(legacy.log.dropped, [], 'старое не удалено')
    assert.equal(fs.existsSync(store.fileOf('designs')), false, 'недоделанный файл убран')
    store.set('designs', [{ id: 'd2' }])
    assert.equal(legacy.log.writes, 1, 'запись ушла в старое место')
    assert.deepEqual(legacy.data.get('designs'), [{ id: 'd2' }])
  })

  await check('испорченный файл откладывается рядом, а не затирается', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'conversations.json'), '{не json')
    const events = []
    const store = bulkStore.create({ dir, encode, decode, onEvent: (kind, info) => events.push({ kind, info }) })
    assert.deepEqual(store.get('conversations', ['пусто']), ['пусто'])
    const aside = fs.readdirSync(dir).filter(name => name.startsWith('conversations.json.corrupt-'))
    assert.equal(aside.length, 1, 'испорченный файл сохранён для разбора')
    assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{не json')
    assert(events.some(event => event.kind === 'corrupt'), 'событие о порче записано')
  })

  await check('частые сохранения склеиваются в одну запись с последним значением', async () => {
    const dir = tmp()
    const written = []
    const store = bulkStore.create({ dir, encode, decode, onEvent: (kind, info) => kind === 'written' && written.push(info.key) })
    store.get('conversations', [])
    for (let i = 0; i < 25; i++) store.set('conversations', [{ id: String(i) }])
    await wait(bulkStore.WRITE_DELAY_MS + 150)
    await store.flush()
    assert.equal(written.length, 1, 'записей: ' + written.length)
    assert.deepEqual(bulkStore.create({ dir, encode, decode }).get('conversations', []), [{ id: '24' }])
  })

  await check('при выходе несохранённое пишется сразу', async () => {
    const dir = tmp()
    const store = bulkStore.create({ dir, encode, decode })
    store.get('designs', [])
    store.set('designs', [{ id: 'поздний' }])
    assert.equal(store.pending(), 1)
    store.flushSync()
    assert.equal(store.pending(), 0)
    assert.deepEqual(bulkStore.create({ dir, encode, decode }).get('designs', []), [{ id: 'поздний' }])
  })

  await check('журнал: медленная операция, долгая задача окна, что шло в этот момент', async () => {
    const dir = tmp()
    let now = 0
    const log = latencyLog.create({ dir, clock: () => now })
    const endIpc = log.begin('ipc get-settings')
    log.measure('store.get conversations', () => { now += 90 })
    log.fromWindow({ ms: 812.4, what: 'нажатие button#settingsBtn' })
    endIpc()
    const text = fs.readFileSync(log.file, 'utf8')
    assert.match(text, /main slow store\.get conversations 90мс/)
    assert.match(text, /window long 812мс; после: нажатие button#settingsBtn; главный: ipc get-settings/)
  })

  await check('журнал ловит зависание главного процесса', async () => {
    const dir = tmp()
    const log = latencyLog.create({ dir })
    log.startLoopMonitor()
    await wait(latencyLog.LOOP_INTERVAL_MS + 20)
    const end = log.begin('ipc set-conversations')
    const stop = Date.now() + 600
    while (Date.now() < stop) { /* держим поток, как тяжёлая синхронная запись */ }
    end()
    await wait(latencyLog.LOOP_INTERVAL_MS * 2)
    log.stop()
    const text = fs.existsSync(log.file) ? fs.readFileSync(log.file, 'utf8') : ''
    assert.match(text, /main lag \d+мс/, 'зависание не записано: ' + text)
  })

  await check('журнал не растёт бесконечно', async () => {
    const dir = tmp()
    const log = latencyLog.create({ dir })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(log.file, 'x'.repeat(latencyLog.MAX_BYTES + 10))
    log.write('после переполнения')
    assert(fs.existsSync(path.join(dir, 'latency.1.log')), 'старый журнал отложен')
    assert(fs.statSync(log.file).size < 200, 'новый начат заново')
  })

  await check('main.js: история и дизайны идут в свои файлы, выход дописывает', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
    const declaration = main.match(/const BULK_KEYS = new Set\(\[[^\]]+\]\)/)
    assert.ok(declaration)
    const bulkKeys = new Function(declaration[0] + '; return BULK_KEYS')()
    for (const key of ['conversations', 'designs', 'runConfigurations']) assert.ok(bulkKeys.has(key), key + ' uses protected bulk storage')
    assert.equal(bulkKeys.has('openrouterKeys'), false, 'provider keys retain their dedicated storage route')
    assert.match(main, /if \(BULK_KEYS\.has\(key\)\) return bulk\(\)\.get\(key, fallback\)/)
    assert.match(main, /if \(BULK_KEYS\.has\(key\)\) return bulk\(\)\.set\(key, value\)/)
    assert.match(main, /bulkData\?\.flushSync\(\)/)
    assert.match(main, /latency\.startLoopMonitor\(\)/)
    assert.match(main, /ipcMain\.on\('perf-longtask'/)
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8')
    assert.match(preload, /reportLongTask: report => ipcRenderer\.send\('perf-longtask', report\)/)
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main()
