// Хранилище артефактов чата (план, 3.2) на настоящем каталоге во временной папке.
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('node:os')
const path = require('node:path')
const { create } = require('../src/main/artifacts')

const failures = []
async function test(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const fresh = () => create({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-artifacts-')) })

// Junction (Windows) или symlink (остальные) — способ проверить границу там,
// где лексически путь выглядит правильным. Если система не даёт создать,
// проверка пропускается громко, а не молча «зелёная».
function junction(link, target) {
  const { spawnSync } = require('node:child_process')
  if (process.platform === 'win32') {
    return spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { windowsHide: true, stdio: 'ignore' }).status === 0
  }
  try { fs.symlinkSync(target, link, 'dir'); return true } catch { return false }
}

async function main() {
  await test('страница ложится файлом и остаётся читаемой', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'c1', title: 'Пальмы', kind: 'page', content: '<h1>Пальмы</h1>' })
    assert.equal(made.kind, 'page')
    assert.equal(made.current, 1)
    assert.equal(made.versions[0].file, '1-index.html')
    const onDisk = fs.readFileSync(path.join(store.folderOf(made.id), '1-index.html'), 'utf8')
    assert.equal(onDisk, '<h1>Пальмы</h1>')
    assert.equal((await store.versionText(made.id, 1)), '<h1>Пальмы</h1>')
  })

  await test('новая версия не затирает прежнюю', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'c1', kind: 'page', content: '<body>светлый фон</body>' })
    const next = await store.update(made.id, '<body>тёмный фон</body>')
    assert.equal(next.current, 2)
    assert.equal(next.versions.length, 2)
    assert.equal(await store.versionText(made.id, 1), '<body>светлый фон</body>', 'первая версия пропала')
    assert.equal(await store.versionText(made.id, 2), '<body>тёмный фон</body>')
    assert.ok(next.updatedAt >= made.updatedAt)
  })

  await test('пустая версия не убивает артефакт', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'c1', kind: 'code', content: 'console.log(1)' })
    await assert.rejects(() => store.update(made.id, '   '), /Пустая версия/)
    assert.equal((await store.readMeta(made.id)).current, 1)
    await assert.rejects(() => store.add({ kind: 'page', content: '' }), /без содержимого/)
  })

  await test('виды ограничены списком, а идентификатор — формой', async () => {
    const store = fresh()
    await assert.rejects(() => store.add({ kind: 'exe', content: 'x' }), /Неизвестный вид/)
    assert.throws(() => store.folderOf('../../windows'), /Недопустимый идентификатор/)
    assert.throws(() => store.servedFile('..', 'x'), /Недопустимый идентификатор/)
  })

  await test('из каталога артефакта наружу не выйти', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'c1', kind: 'page', content: '<p>раз</p>' })
    assert.ok(store.servedFile(made.id, '1-index.html'), 'свой файл не отдаётся')
    assert.equal(store.servedFile(made.id, '../etc/passwd'), null)
    assert.equal(store.servedFile(made.id, '/1-index.html').includes(store.folderOf(made.id)), true)
    assert.equal(store.servedFile(made.id, 'нет-такого-файла.html'), null)
  })

  await test('список фильтруется по диалогу и не показывает снятое', async () => {
    const store = fresh()
    const one = await store.add({ chatId: 'a', kind: 'code', content: 'один' })
    await store.add({ chatId: 'b', kind: 'code', content: 'два' })
    assert.deepEqual((await store.list({ chatId: 'a' })).map(m => m.id), [one.id])
    assert.equal((await store.list()).length, 2)
    await store.archive(one.id)
    assert.equal((await store.list({ chatId: 'a' })).length, 0)
    assert.equal((await store.list({ chatId: 'a', includeArchived: true })).length, 1)
    assert.ok(fs.existsSync(path.join(store.folderOf(one.id), '1-source')), 'файл работы удалён вместо архивирования')
  })

  await test('история версий ограничена, порядок не ломается', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'a', kind: 'page', content: 'v1' })
    for (let i = 2; i <= 25; i++) await store.update(made.id, `v${i}`)
    const meta = await store.readMeta(made.id)
    assert.equal(meta.current, 25)
    assert.ok(meta.versions.length <= 20, `версий в истории ${meta.versions.length}`)
    assert.equal(meta.versions[meta.versions.length - 1].n, 25)
    await assert.rejects(() => store.versionText(made.id, 1), /Версии 1/)
  })

  await test('сломанный meta читается как отсутствие, а не как падение', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'a', kind: 'page', content: 'x' })
    fs.writeFileSync(path.join(store.folderOf(made.id), 'meta.json'), '{сломано')
    const events = []
    const reader = create({ dir: path.dirname(store.folderOf(made.id)), onEvent: (kind, info) => events.push([kind, info.id]) })
    assert.equal(await reader.readMeta(made.id), null)
    assert.deepEqual(events, [['meta-unreadable', made.id]])
  })

  await test('одновременные сохранения не затирают друг друга', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'a', kind: 'code', content: 'v0' })
    // Модель дописывает версию, человек правит свою: без очереди на один
    // артефакт оба берут номер N+1 и второй перетирает файл первого.
    const results = await Promise.all([
      store.update(made.id, 'v1'),
      store.update(made.id, 'v2'),
      store.update(made.id, 'v3')
    ])
    const numbers = results.map(item => item.current).sort((x, y) => x - y)
    assert.deepEqual(numbers, [2, 3, 4], `версии получились ${numbers.join(', ')}`)
    const meta = await store.readMeta(made.id)
    assert.equal(meta.current, 4)
    assert.equal(new Set(meta.versions.map(item => item.file)).size, meta.versions.length, 'файлы версий совпали')
    assert.equal(await store.versionText(made.id, 2), 'v1')
    assert.equal(await store.versionText(made.id, 3), 'v2')
    assert.equal(await store.versionText(made.id, 4), 'v3')
  })

  await test('meta с чужим путём версии наружу не читает', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'a', kind: 'page', content: '<p>своё</p>' })
    const secret = path.join(path.dirname(store.folderOf(made.id)), 'secret.txt')
    fs.writeFileSync(secret, 'чужой файл')
    const file = path.join(store.folderOf(made.id), 'meta.json')
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    meta.versions[0].file = '../secret.txt'
    fs.writeFileSync(file, JSON.stringify(meta))
    // Такое имя либо отвергается целиком, либо остаётся внутри папки:
    // прочесть соседний файл через артефакт нельзя.
    assert.equal(await store.readMeta(made.id), null)
    await assert.rejects(() => store.versionText(made.id, 1), /Артефакт не найден/)
    fs.rmSync(secret)
  })

  await test('meta без пригодных версий — отсутствие, а не падение', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'a', kind: 'page', content: 'x' })
    const file = path.join(store.folderOf(made.id), 'meta.json')
    for (const broken of [{ kind: 'page' }, { kind: 'page', versions: 'не список' },
      { kind: 'exe', versions: [{ n: 1, file: '1-index.html' }] },
      { kind: 'page', versions: [{ n: 1, file: '..\\..\\windows\\win.ini' }] }]) {
      fs.writeFileSync(file, JSON.stringify(broken))
      assert.equal(await store.readMeta(made.id), null, JSON.stringify(broken))
    }
  })

  await test('срезанные историей версии снимаются с диска', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'a', kind: 'code', content: 'v1' })
    for (let i = 2; i <= 25; i++) await store.update(made.id, `v${i}`)
    const meta = await store.readMeta(made.id)
    const kept = new Set(meta.versions.map(item => item.file))
    const onDisk = fs.readdirSync(store.folderOf(made.id)).filter(name => name !== 'meta.json')
    assert.deepEqual(onDisk.sort(), [...kept].sort(), `на диске осталось лишнее: ${onDisk.filter(n => !kept.has(n)).join(', ')}`)
    assert.equal(onDisk.length, 20)
  })

  await test('папка-ссылка внутри артефакта наружу не ведёт', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'a', kind: 'page', content: '<p>своё</p>' })
    // Внешняя папка — за пределами хранилища: иначе проверка границы
    // («всё ещё внутри корня артефактов») на ней не срабатывает.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-artifacts-outside-'))
    fs.writeFileSync(path.join(outside, '1-index.html'), 'чужой файл')
    const folder = store.folderOf(made.id)
    fs.cpSync(folder, path.join(outside, 'копия'), { recursive: true })
    fs.rmSync(folder, { recursive: true, force: true })
    try {
      if (!junction(folder, outside)) {
        console.log('   (система не дала создать ссылку — проверка пропущена)')
        return
      }
      assert.equal(store.servedFile(made.id, '1-index.html'), null, 'протокол отдал файл за пределами хранилища')
      await assert.rejects(() => store.versionText(made.id, 1), /вне папки артефакта|Артефакт не найден/)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  await test('ссылка вместо файла версии наружу не читается', async () => {
    const store = fresh()
    const made = await store.add({ chatId: 'a', kind: 'page', content: '<p>своё</p>' })
    const outside = path.join(path.dirname(store.folderOf(made.id)), 'метка-' + made.id)
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'внешняя метка')
    const link = path.join(store.folderOf(made.id), '1-index.html')
    fs.rmSync(link, { force: true })
    const ok = process.platform === 'win32'
      ? require('node:child_process').spawnSync('cmd', ['/c', 'mklink', '/J', link, outside], { windowsHide: true, stdio: 'ignore' }).status === 0
      : (() => { try { fs.symlinkSync(outside, link, 'dir'); return true } catch { return false } })()
    if (!ok) {
      console.log('   (система не дала создать ссылку — проверка пропущена)')
      return
    }
    assert.equal(store.servedFile(made.id, '1-index.html'), null, 'servedFile пропустил ссылку')
    await assert.rejects(() => store.versionText(made.id, 1), /вне папки артефакта/)
  })

  await test('артефакт чужого диалога не правится', async () => {
    const store = fresh()
    const mine = await store.add({ chatId: 'мой', kind: 'code', content: 'моя работа' })
    await assert.rejects(() => store.update(mine.id, 'чужая правка', { chatId: 'чужой' }), /другому диалогу/)
    assert.equal(await store.versionText(mine.id, 1, { chatId: 'мой' }), 'моя работа')
    await assert.rejects(() => store.archive(mine.id, { chatId: 'чужой' }), /другому диалогу/)
    // Без указания диалога (например, из окна, где чат не известен) поведение
    // прежнее: проверка срабатывает только тогда, когда диалог назван.
    assert.equal((await store.update(mine.id, 'своя правка')).current, 2)
  })

  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
}

main().catch(error => { console.error('FAIL', error.message); process.exitCode = 1 })
