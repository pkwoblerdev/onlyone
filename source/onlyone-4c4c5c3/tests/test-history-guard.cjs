// Б-6: запись агента не пропадает, если окно сохраняет историю раньше, чем её перечитало.
//
// Настоящее хранилище на настоящем диске, слияние окна — то самое, вырезанное из
// app.js, обработчики главного процесса — как в main.js (set-conversations,
// get-conversations, project_note). Порядок событий задан руками: гонку по
// времени не поймать, а проигрыш при таком порядке — дефект кода.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bulkStore = require('../src/main/bulk-store.js')
const historyGuard = require('../src/main/history-guard.js')

const root = path.join(__dirname, '..')
const appSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8')
const mainSource = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')
const from = appSource.indexOf('  function mergeConversations(local, fromDisk) {')
const to = appSource.indexOf('  async function loadConversations() {')
if (from < 0 || to < 0) throw new Error('mergeConversations не найдена')
const mergeConversations = new Function(appSource.slice(from, to) + '\nreturn mergeConversations')()

const encode = json => ({ enc: 'plain', data: Buffer.from(json, 'utf8').toString('base64') })
const decode = envelope => JSON.parse(Buffer.from(envelope.data, 'base64').toString('utf8'))
const clone = value => JSON.parse(JSON.stringify(value))
const WINDOW = 7

let failed = 0
const check = async (name, fn) => {
  try { await fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

// Главный процесс: обработчики повторяют main.js.
async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-guard-'))
  const bulk = bulkStore.create({ dir, encode, decode })
  const guard = historyGuard.create()
  bulk.set('conversations', [{ id: 'a', updatedAt: 1000, messages: [{ role: 'user', content: 'q', timestamp: 1000 }] }])
  await bulk.flush()
  const main = {
    // Окно читает историю: `seen` получает ровно тот список, что ушёл окну, —
    // только по нему охранник различает «ещё не доехало» и «человек удалил».
    get(sender = WINDOW) {
      const saved = bulk.get('conversations', [])
      guard.seen(sender, clone(Array.isArray(saved) ? saved : []))
      return clone(Array.isArray(saved) ? saved : [])
    },
    async set(conversations, sender = WINDOW) {
      const incoming = Array.isArray(conversations) ? conversations : []
      bulk.set('conversations', guard.reconcile(sender, incoming))
      await bulk.flush()
    },
    note(chatId, text, timestamp, senders = [WINDOW]) {
      const chats = bulk.get('conversations', [])
      let target = chats.find(chat => chat.id === chatId)
      const created = !target
      if (created) { target = { id: chatId, title: 'От агента', messages: [], createdAt: timestamp, updatedAt: timestamp }; chats.unshift(target) }
      const message = { role: 'assistant', content: text, fromAgentNote: true, timestamp }
      target.messages.push(message)
      target.updatedAt = timestamp
      bulk.set('conversations', chats)
      guard.wrote({ chat: target, note: message, created }, senders)
    },
    idle: () => bulk.whenIdle(),
    disk: () => decode(JSON.parse(fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8')))
  }
  return { main, dir }
}

// Окно по conversations-changed: читает историю, сливает, сохраняет; а свое
// отложенное сохранение (`stale`) уже ушло — до чтения или сразу после него.
async function windowCycle(main, local, order) {
  const stale = clone(local)
  if (order === 'save-first') {
    await main.set(stale)
    local = mergeConversations(local, main.get())
  } else {
    const disk = main.get()
    await main.set(stale)
    local = mergeConversations(local, disk)
  }
  await main.set(clone(local))
  return local
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// Б-6: гонка по времени, а не по порядку. Окно сохраняет свою копию, а агент в
// это же время дописывает заметку; оба идут через настоящие модули и настоящий
// диск. Порядок задаёт таймер, и после записи ни одна из сторон не должна
// потерять чужое — ни заметку из-за устаревшего сохранения, ни вопрос человека
// из-за того, что заметка легла раньше.
async function concurrentRound(w, a) {
  const { main: m, dir } = await harness()
  const local = m.get()
  local[0].messages.push({ role: 'user', content: 'второй вопрос', timestamp: 1500 })
  local[0].updatedAt = 1500

  // Окно: отложенное сохранение ушло, ответа ещё нет (IPC + запись на диск).
  const window = (async () => {
    await wait(w.gap)
    // `stale` — копия окна на момент отправки, без заметки агента.
    const sent = clone(local)
    await m.set(sent)
    // conversations-changed: окно перечитывает историю и сливает её со своей.
    await wait(w.after)
    const merged = mergeConversations(local, m.get())
    await m.set(merged)
  })()

  // Агент: project_note — чтение, дописывание, запись.
  const agent = (async () => {
    await wait(a.gap)
    m.note('a', 'ЗАМЕТКА', 2000)
    await wait(a.after)
    await m.idle()
  })()

  await Promise.all([window, agent])
  await m.idle()
  const contents = m.disk()[0].messages.map(message => message.content)
  fs.rmSync(dir, { recursive: true, force: true })
  return contents
}

async function main() {
  for (const order of ['save-first', 'load-first']) {
    await check(`заметка агента переживает устаревшее сохранение окна (${order})`, async () => {
      const { main: m, dir } = await harness()
      const local = m.get()
      local[0].messages.push({ role: 'user', content: 'второй вопрос', timestamp: 1500 })
      local[0].updatedAt = 1500
      m.note('a', 'ЗАМЕТКА', 2000)
      await windowCycle(m, local, order)
      const contents = m.disk()[0].messages.map(message => message.content)
      assert.deepEqual(contents, ['q', 'второй вопрос', 'ЗАМЕТКА'])
      fs.rmSync(dir, { recursive: true, force: true })
    })
  }

  await check('чат, созданный агентом, не исчезает при устаревшем сохранении', async () => {
    const { main: m, dir } = await harness()
    const local = m.get()
    m.note('new-chat', 'ИТОГ', 3000)
    await m.set(clone(local))
    assert.deepEqual(m.disk().map(chat => chat.id).sort(), ['a', 'new-chat'])
    assert.equal(m.disk().find(chat => chat.id === 'new-chat').messages[0].content, 'ИТОГ')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await check('после чтения окном запись не навязывается: удаление чата работает', async () => {
    const { main: m, dir } = await harness()
    m.note('new-chat', 'ИТОГ', 3000)
    let local = m.get()
    local = local.filter(chat => chat.id !== 'new-chat')
    await m.set(clone(local))
    assert.deepEqual(m.disk().map(chat => chat.id), ['a'])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await check('чат, удалённый окном до заметки, не воскрешается', async () => {
    const { main: m, dir } = await harness()
    m.note('a', 'ПОЗДНЯЯ', 2000)
    await m.set([])
    assert.deepEqual(m.disk(), [])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await check('тема, назначенная агентом, не затирается', () => {
    const guard = historyGuard.create()
    guard.wrote({ chat: { id: 'a' }, topic: 'тема агента' }, [WINDOW])
    const out = guard.reconcile(WINDOW, [{ id: 'a', messages: [] }])
    assert.equal(out[0].topic, 'тема агента')
  })

  await check('второе окно не мешает первому, а истёкшие записи уходят', () => {
    let clock = 0
    const guard = historyGuard.create({ now: () => clock })
    guard.wrote({ chat: { id: 'a' }, note: { role: 'assistant', content: 'x', timestamp: 5 } }, [1, 2])
    guard.seen(1)
    assert.equal(guard.reconcile(1, [{ id: 'a', messages: [] }])[0].messages.length, 0)
    assert.equal(guard.reconcile(2, [{ id: 'a', messages: [] }])[0].messages.length, 1)
    clock = historyGuard.TTL_MS + 10
    assert.equal(guard.reconcile(2, [{ id: 'a', messages: [] }])[0].messages.length, 0, 'запись истекла')
    assert.equal(guard.pending(), 0)
  })

  await check('отказ записи виден: flush отклоняется, данные остаются в очереди, повтор доходит', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-guard-fail-'))
    const bulk = bulkStore.create({ dir, encode, decode })
    bulk.set('conversations', [{ id: 'a', messages: [] }])
    await bulk.flush()
    fs.rmSync(path.join(dir, 'conversations.json'))
    fs.mkdirSync(path.join(dir, 'conversations.json'))   // rename на каталог не пройдёт
    bulk.set('conversations', [{ id: 'a', messages: [{ role: 'user', content: 'новое' }] }])
    await assert.rejects(bulk.flush(), /запись не завершена/)
    assert.equal(bulk.pending(), 1, 'несохранённое остаётся в очереди')
    fs.rmSync(path.join(dir, 'conversations.json'), { recursive: true })
    await bulk.flush()
    assert.equal(bulk.pending(), 0)
    assert.equal(decode(JSON.parse(fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8')))[0].messages[0].content, 'новое')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // Н3 (адварк-тест 01.11): удаление, сделанное человеком, отменялось главным
  // процессом и отменялось повторно, а устаревшая копия второго окна возвращала
  // удалённое на диск.
  await check('Н3: удалённая человеком заметка не возвращается — ни этому окну, ни устаревшей копии второго', async () => {
    const { main: m, dir } = await harness()
    const STALE = 8                                   // второе окно, которое историю после записи не читало
    const stale = m.get(STALE)
    m.note('a', 'ЗАМЕТКА', 2000, [WINDOW, STALE])
    const shown = m.get(WINDOW)                       // человеку заметку показали
    const kept = clone(shown)
    kept[0].messages = kept[0].messages.filter(message => message.content !== 'ЗАМЕТКА')
    await m.set(kept, WINDOW)
    assert.deepEqual(m.disk()[0].messages.map(message => message.content), ['q'], 'заметка не удаляется сохранением')
    await m.set(stale, STALE)
    assert.deepEqual(m.disk()[0].messages.map(message => message.content), ['q'],
      'устаревшая копия второго окна вернула удалённое')
    await m.set(kept, WINDOW)
    assert.deepEqual(m.disk()[0].messages.map(message => message.content), ['q'], 'удаление отменилось повторным сохранением')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await check('Н3: удалённый человеком чат не возвращается устаревшей копией второго окна', async () => {
    const { main: m, dir } = await harness()
    const STALE = 8
    const stale = m.get(STALE)
    m.note('new-chat', 'ИТОГ', 3000, [WINDOW, STALE])
    const shown = m.get(WINDOW)
    const kept = shown.filter(chat => chat.id !== 'new-chat')
    await m.set(kept, WINDOW)
    assert.deepEqual(m.disk().map(chat => chat.id), ['a'], 'чат не удаляется сохранением')
    await m.set(stale, STALE)
    assert.deepEqual(m.disk().map(chat => chat.id), ['a'], 'устаревшая копия второго окна вернула удалённый чат')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await check('Н3: показанное не навязывается, а не показанное — по-прежнему спасается', async () => {
    // Устаревшее сохранение окна, которое записи не видело, обязано остаться с записью:
    // это исходная причина охранника (Б-6), и tombstone её отменять не должен.
    const guard = historyGuard.create()
    const note = { role: 'assistant', content: 'ЗАМЕТКА', timestamp: 20 }
    guard.wrote({ chat: { id: 'a', messages: [note] }, note }, [WINDOW])
    const out = guard.reconcile(WINDOW, [{ id: 'a', messages: [{ role: 'user', content: 'привет', timestamp: 10 }] }])
    assert.deepEqual(out[0].messages.map(message => message.content), ['привет', 'ЗАМЕТКА'])
  })

  await check('Н3: заметка без timestamp дописывается в конец, а не в начало', () => {
    const guard = historyGuard.create()
    guard.wrote({ chat: { id: 'c9', messages: [] }, note: { role: 'assistant', content: 'без времени' } }, [WINDOW])
    const out = guard.reconcile(WINDOW,
      [{ id: 'c9', messages: [{ role: 'user', content: 'раз', timestamp: 5 }, { role: 'assistant', content: 'важно', timestamp: 99 }] }])
    assert.deepEqual(out[0].messages.map(message => message.content), ['раз', 'важно', 'без времени'],
      'порядок прежних сообщений сдвинут вставкой в начало')
  })

  await check('Н3: две разные заметки с одним role и timestamp не сливаются в одну', () => {
    const guard = historyGuard.create()
    guard.wrote({ chat: { id: 'c9', messages: [] }, note: { role: 'assistant', content: 'ПЕРВАЯ', timestamp: 7 } }, [WINDOW])
    guard.wrote({ chat: { id: 'c9', messages: [] }, note: { role: 'assistant', content: 'ВТОРАЯ', timestamp: 7 } }, [WINDOW])
    const out = guard.reconcile(WINDOW, [{ id: 'c9', messages: [] }])
    assert.deepEqual(out[0].messages.map(message => message.content), ['ПЕРВАЯ', 'ВТОРАЯ'], 'вторая заметка потеряна')
  })

  await check('Б-6: одновременная запись окна и агента — обе правки на диске', async () => {
    // Пары задержек (окно, агент): заметка до сохранения, внутрь записи, после
    // ответа; и наоборот. Плюс разброс, при котором порядок решает таймер.
    const timings = [
      { w: { gap: 0, after: 0 }, a: { gap: 0, after: 0 } },
      { w: { gap: 0, after: 0 }, a: { gap: 1, after: 0 } },
      { w: { gap: 4, after: 0 }, a: { gap: 0, after: 0 } },
      { w: { gap: 4, after: 4 }, a: { gap: 2, after: 6 } },
      { w: { gap: 6, after: 2 }, a: { gap: 1, after: 1 } },
      { w: { gap: 2, after: 12 }, a: { gap: 6, after: 0 } }
    ]
    for (const [index, timing] of timings.entries()) {
      const contents = await concurrentRound(timing.w, timing.a)
      assert.deepEqual(contents, ['q', 'второй вопрос', 'ЗАМЕТКА'],
        `порядок ${index} (${JSON.stringify(timing)}): потеряна правка одного из писателей`)
    }
  })

  await check('main.js: чтение и сохранение идут через охранника', () => {
    assert.match(mainSource, /require\('\.\/history-guard'\)/)
    // Окну передаётся прочитанный список: по нему охранник узнаёт, что запись показана.
    assert.match(mainSource, /ipcMain\.handle\('get-conversations', async event => \{[\s\S]{0,500}historyGuard\.seen\(event\.sender\.id,\s*list\)/)
    assert.match(mainSource, /ipcMain\.handle\('set-conversations', async \(event, conversations\) => \{[\s\S]{0,300}historyGuard\.reconcile\(event\.sender\.id,/)
    assert.equal((mainSource.match(/historyGuard\.wrote\(/g) || []).length, 2, 'project_note и project_topic_set')
  })

  console.log(JSON.stringify({ ok: failed === 0, failed }))
  process.exitCode = failed ? 1 : 0
}

main()
