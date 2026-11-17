// 9.8, шаг 1: вид артефакта «видео».
//
// Ролик — не текст: он лежит файлом, который агент отрендерил в рабочей папке
// (ffmpeg через run_command), а в чат попадает копией внутри папки артефакта.
// Копия, а не ссылка: ролик в рабочей папке могут переименовать или пересобрать,
// и версия артефакта не должна пропадать вместе с ним. Проверяется настоящее
// хранилище на настоящем каталоге, настоящий экспорт и наличие вида в окне.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { create, KINDS, FILENAME } = require('../src/main/artifacts')
const { createArtifactExporter } = require('../src/main/artifact-export')

const failures = []
async function test(name, fn) {
  try { await fn(); console.log('ok', name) } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-video-'))
const fresh = opts => create({ dir: fs.mkdtempSync(path.join(tmp, 'store-')), ...opts })
// Заголовок настоящего mp4 (ftyp) и хвост: для хранилища важны байты, не кодек.
const fakeMp4 = size => Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]), Buffer.alloc(size, 7)])
const source = (name, bytes = fakeMp4(4096)) => {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, bytes)
  return file
}
const read = (dir, name) => fs.readFileSync(path.join(dir, name))

async function main() {
  await test('вид «video» есть в общем списке и в именах файлов', () => {
    assert.ok(KINDS.has('video'))
    assert.match(FILENAME.video, /^video\./)
  })

  await test('ролик копируется в папку артефакта байт в байт', async () => {
    const store = fresh()
    const bytes = fakeMp4(9000)
    const made = await store.addFile({ chatId: 'c1', title: 'Ролик 1', kind: 'video', sourcePath: source('a.mp4', bytes) })
    assert.equal(made.kind, 'video')
    assert.equal(made.current, 1)
    assert.equal(made.versions[0].file, '1-video.mp4')
    assert.equal(made.versions[0].chars, bytes.length, 'размер версии — в байтах')
    assert.deepEqual(read(store.folderOf(made.id), '1-video.mp4'), bytes)
  })

  await test('расширение версии — от источника: webm остаётся webm', async () => {
    const store = fresh()
    const made = await store.addFile({ chatId: 'c1', title: 'Клип', kind: 'video', sourcePath: source('b.webm') })
    assert.equal(made.versions[0].file, '1-video.webm')
  })

  await test('не видеофайл не принимается: расширение решает', async () => {
    const store = fresh()
    for (const name of ['c.txt', 'd.exe', 'e.html', 'f']) {
      await assert.rejects(store.addFile({ chatId: 'c1', title: 'x', kind: 'video', sourcePath: source(name) }), /mp4|webm|видео/i, name)
    }
  })

  await test('пустой и несуществующий файл отказывают словами', async () => {
    const store = fresh()
    await assert.rejects(store.addFile({ chatId: 'c1', kind: 'video', sourcePath: source('g.mp4', Buffer.alloc(0)) }), /пуст/i)
    await assert.rejects(store.addFile({ chatId: 'c1', kind: 'video', sourcePath: path.join(tmp, 'нет-такого.mp4') }), /не найден|нет/i)
    await assert.rejects(store.addFile({ chatId: 'c1', kind: 'video', sourcePath: '' }), /путь|файл/i)
  })

  await test('слишком большой ролик отказывает до копирования', async () => {
    const store = fresh({ maxFileBytes: 1000 })
    await assert.rejects(store.addFile({ chatId: 'c1', kind: 'video', sourcePath: source('h.mp4', fakeMp4(5000)) }), /большой|предел/i)
    assert.deepEqual(await store.list({ chatId: 'c1' }), [], 'после отказа артефакт не остаётся')
  })

  await test('текстовый add() видео не принимает: ролик — только файлом', async () => {
    const store = fresh()
    await assert.rejects(store.add({ chatId: 'c1', kind: 'video', content: 'AAAA' }), /файл/i)
  })

  await test('addFile не заводит текстовые виды', async () => {
    const store = fresh()
    await assert.rejects(store.addFile({ chatId: 'c1', kind: 'page', sourcePath: source('i.mp4') }), /видео/i)
  })

  await test('новая версия ролика не затирает прежнюю', async () => {
    const store = fresh()
    const first = fakeMp4(3000)
    const second = fakeMp4(5000)
    const made = await store.addFile({ chatId: 'c1', title: 'Ролик', kind: 'video', sourcePath: source('j.mp4', first) })
    const next = await store.updateFile(made.id, source('k.mp4', second), { chatId: 'c1', title: 'Ролик, вторая сборка' })
    assert.equal(next.current, 2)
    assert.equal(next.title, 'Ролик, вторая сборка')
    assert.deepEqual(read(store.folderOf(made.id), '1-video.mp4'), first)
    assert.deepEqual(read(store.folderOf(made.id), '2-video.mp4'), second)
  })

  await test('правка ролика чужого диалога отказывает', async () => {
    const store = fresh()
    const made = await store.addFile({ chatId: 'c1', title: 'Ролик', kind: 'video', sourcePath: source('l.mp4') })
    await assert.rejects(store.updateFile(made.id, source('m.mp4'), { chatId: 'c2' }), /другому диалогу/)
  })

  await test('versionText видео не читает файл в память, но диалог проверяет', async () => {
    const store = fresh()
    const made = await store.addFile({ chatId: 'c1', title: 'Ролик', kind: 'video', sourcePath: source('n.mp4', fakeMp4(200000)) })
    assert.equal(await store.versionText(made.id, 1, { chatId: 'c1' }), '')
    await assert.rejects(store.versionText(made.id, 1, { chatId: 'c2' }), /другому диалогу/)
  })

  await test('ролик лежит на диске открыто даже при шифровании меты, и отдаётся протоколом', async () => {
    const store = fresh({ protect: text => Buffer.from(text).toString('base64'), unprotect: text => Buffer.from(text, 'base64').toString('utf8') })
    const bytes = fakeMp4(2048)
    const made = await store.addFile({ chatId: 'c1', title: 'Ролик', kind: 'video', sourcePath: source('o.mp4', bytes) })
    assert.deepEqual(read(store.folderOf(made.id), '1-video.mp4'), bytes,
      'видео не оборачивается в конверт: иначе его не проиграть потоком, а память съест целиком')
    const again = await store.readMeta(made.id)
    assert.equal(again.kind, 'video', 'мета читается обратно')
    assert.ok(store.servedFile(made.id, '1-video.mp4'))
  })

  await test('список диалога видит ролик рядом с прочими артефактами', async () => {
    const store = fresh()
    await store.add({ chatId: 'c1', title: 'Страница', kind: 'page', content: '<h1>x</h1>' })
    await store.addFile({ chatId: 'c1', title: 'Ролик', kind: 'video', sourcePath: source('p.mp4') })
    const kinds = (await store.list({ chatId: 'c1' })).map(item => item.kind).sort()
    assert.deepEqual(kinds, ['page', 'video'])
  })

  await test('экспорт «файл как есть» копирует ролик, остальные форматы отказывают', async () => {
    const store = fresh()
    const bytes = fakeMp4(7000)
    const made = await store.addFile({ chatId: 'c1', title: 'Мой: ролик?', kind: 'video', sourcePath: source('q.mp4', bytes) })
    const target = path.join(tmp, 'saved.mp4')
    const asked = []
    const exporter = createArtifactExporter({
      artifacts: store,
      showSaveDialog: async (_w, options) => { asked.push(options); return { filePath: target } }
    })
    const done = await exporter.export({ artifactId: made.id, format: 'file', chatId: 'c1' })
    assert.equal(done.ok, true, JSON.stringify(done))
    assert.deepEqual(fs.readFileSync(target), bytes)
    assert.match(path.basename(asked[0].defaultPath), /\.mp4$/)
    for (const format of ['html', 'png', 'svg']) {
      const refused = await exporter.export({ artifactId: made.id, format, chatId: 'c1' })
      assert.equal(refused.ok, false, format)
    }
  })

  // Окно: вид назван, воспроизводится нативным <video>, ссылка на ролик разрешена CSP.
  const root = path.join(__dirname, '..', 'src', 'renderer')
  const panel = fs.readFileSync(path.join(root, 'artifact-panel.js'), 'utf8')
  const blocks = fs.readFileSync(path.join(root, 'ultra-blocks.js'), 'utf8')
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')

  await test('панель называет вид и умеет выгрузить ролик файлом', () => {
    assert.match(panel, /video:\s*'Видео'/)
    assert.match(panel, /video:\s*\[\['file'/)
    assert.match(panel, /getElementById|\$\('artifactVideo'\)/, 'панель ведёт нативный <video>')
    assert.match(html, /<video id="artifactVideo"/, 'в окне есть <video> для ролика')
  })

  await test('блок Ultra называет вид словом', () => {
    assert.match(blocks, /video:\s*'видео'/)
  })

  await test('блок Ultra с роликом — окно с плеером, а не карточка с подписью', () => {
    assert.match(blocks, /item\.kind === 'video' && item\.url/)
    assert.match(blocks, /make\('video', 'ublock-video'\)/)
    const css = fs.readFileSync(path.join(root, 'ultra-blocks.css'), 'utf8')
    assert.match(css, /\.ublock-video\s*\{/)
    assert.match(css, /object-fit:\s*contain/)
  })

  await test('CSP окна разрешает media-src только для артефактов', () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1]
    assert.match(csp, /media-src onecode-artifact:(;|$)/)
  })

  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  await test('main.js: show_video заявлен, диспетчеризован и отдаёт ролик потоком с Range', () => {
    assert.match(main, /name: 'show_video'/)
    assert.match(main, /name === 'show_video'/)
    assert.match(main, /\.mp4': 'video\/mp4'/)
    assert.match(main, /serveVideoRange\(real, request, type\)/, 'ролик отдаётся потоком, а не readFile целиком')
    assert.match(main, /status = 206/)
    assert.match(main, /'content-range'/)
  })

  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* временная папка теста */ }
  if (failures.length) { console.error(`\nПРОВАЛ ${failures.length}`); process.exit(1) }
  console.log('\nВсе проверки видео-артефакта пройдены')
}

main().catch(error => { console.error(error); process.exit(1) })
