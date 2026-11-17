// Н21: запись истории блокирует главный процесс.
//
// На store 27,6 МБ одна запись — это JSON.stringify всего набора, шифрование и
// 27 МБ на диск: 167–228 мс в главном потоке на каждое сообщение. В самом
// `bulk-store.js` склейка уже была (WRITE_DELAY_MS), но обработчик
// `set-conversations` каждый раз сам звал `flush()` и отменял её. Здесь
// проверяется, что N быстрых записей дают меньше файловых записей, что последнее
// значение и `flushSync` на выходе целы и что ошибка диска доходит до того, кто
// ждёт записи (окно показывает её человеку).
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bulkStore = require('../src/main/bulk-store.js')

const encode = json => ({ enc: 'plain', data: Buffer.from(json, 'utf8').toString('base64') })
const decode = envelope => JSON.parse(Buffer.from(envelope.data, 'base64').toString('utf8'))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-coalesce-'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

let checks = 0
const failures = []
async function check (name, fn) {
  try { await fn(); checks++; console.log('ok', name) } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

async function main () {
  await check('хранилище умеет дождаться склеенной записи', () => {
    const store = bulkStore.create({ dir: tmp(), encode, decode })
    assert.equal(typeof store.whenIdle, 'function', 'bulk-store не отдаёт whenIdle — ждать склейку нечем')
    assert.ok(bulkStore.WRITE_DELAY_MS >= 100 && bulkStore.WRITE_DELAY_MS <= 200,
      'задержка склейки вне 100–200 мс: ' + bulkStore.WRITE_DELAY_MS)
  })

  await check('40 быстрых записей — одна файловая, на диске последнее значение', async () => {
    const dir = tmp()
    const written = []
    const store = bulkStore.create({ dir, encode, decode, onEvent: (kind, info) => kind === 'written' && written.push(info) })
    store.get('conversations', [])
    const waits = []
    for (let i = 0; i < 40; i++) {
      store.set('conversations', [{ id: String(i) }])
      waits.push(store.whenIdle())
    }
    // Таймер склейки в хранилище намеренно unref'нут: без живой работы у
    // процесса нет причин ждать, и тест обязан держать его сам.
    const keep = setInterval(() => {}, 1000)
    try { await Promise.all(waits) } finally { clearInterval(keep) }
    assert.equal(written.length, 1, 'файловых записей: ' + written.length + ' вместо одной склеенной')
    assert.deepEqual(bulkStore.create({ dir, encode, decode }).get('conversations', []), [{ id: '39' }])
  })

  await check('пока идёт запись, новые изменения не теряются', async () => {
    const dir = tmp()
    const store = bulkStore.create({ dir, encode, decode })
    store.get('conversations', [])
    store.set('conversations', [{ id: 'first' }])
    const started = store.whenIdle()
    store.set('conversations', [{ id: 'second' }])
    const keep = setInterval(() => {}, 1000)
    try { await started; await store.whenIdle() } finally { clearInterval(keep) }
    assert.deepEqual(bulkStore.create({ dir, encode, decode }).get('conversations', []), [{ id: 'second' }])
  })

  await check('flushSync при выходе пишет всё, что ещё не легло на диск', async () => {
    const dir = tmp()
    const store = bulkStore.create({ dir, encode, decode })
    store.get('designs', [])
    store.set('designs', [{ id: 'поздний' }])
    assert.equal(store.pending(), 1)
    store.flushSync()
    assert.equal(store.pending(), 0)
    assert.deepEqual(bulkStore.create({ dir, encode, decode }).get('designs', []), [{ id: 'поздний' }])
  })

  await check('отказ диска доходит до ожидающего, а не только до журнала', async () => {
    const dir = tmp()
    const store = bulkStore.create({ dir, encode: json => {
      if (json.includes('fail')) throw new Error('диск недоступен')
      return encode(json)
    }, decode })
    store.get('conversations', [])
    store.set('conversations', [{ id: 'fail' }])
    const keep = setInterval(() => {}, 1000)
    try { await assert.rejects(store.whenIdle(), /bulk-store|диск недоступен/) } finally { clearInterval(keep) }
    store.set('conversations', [{ id: 'ok' }])
    const keep2 = setInterval(() => {}, 1000)
    try { await store.whenIdle() } finally { clearInterval(keep2) }
    assert.deepEqual(bulkStore.create({ dir, encode, decode }).get('conversations', []), [{ id: 'ok' }])
  })

  await check('выход не ждёт асинхронную запись и не теряет её', async () => {
    const dir = tmp()
    const store = bulkStore.create({ dir, encode, decode })
    store.get('conversations', [])
    store.set('conversations', ['new'])
    const writing = store.whenIdle().catch(() => {})
    store.flushSync()
    await wait(50)
    await writing
    assert.deepEqual(bulkStore.create({ dir, encode, decode }).get('conversations', []), ['new'])
  })

  // Проводка: обработчик не должен снова включать склейку в обход.
  await check('set-conversations ждёт записи на диск', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
    const start = main.indexOf("ipcMain.handle('set-conversations'")
    const end = main.indexOf('// One-time hand-off', start)
    assert.ok(start >= 0 && end > start, 'обработчик set-conversations не найден')
    const handler = main.slice(start, end)
    // whenIdle откатан: склейка перетирала принятую карточку форка устаревшим
    // сохранением (run-fork-proposal-restart-ui), поэтому здесь снова flush.
    assert.match(handler, /await bulk\(\)\.(flush|whenIdle)\(\)/, 'обработчик не ждёт записи')
  })

  console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
  process.exit(failures.length ? 1 : 0)
}

main().catch(error => { console.error('харнесс упал: ' + error.stack); process.exit(2) })
