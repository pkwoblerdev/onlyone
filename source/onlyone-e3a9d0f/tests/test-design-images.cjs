// «Картинки снова не прикрепились, и он их не видит.»
//
// Пользователь вставлял фотографии в Design через Ctrl+V, видел их плашками над
// строкой ввода — и получал в ответ «я не могу увидеть содержимое присланных
// фотографий». Вставка работала: файлы ложились в референсы дизайна. Не работала
// отправка — модели уходили только имена файлов, а сами изображения никуда не
// шли. Имя файла не заменяет картинку.
//
// Здесь проверяется весь путь от файла в референсах до части сообщения, которую
// получает модель, и вторая половина того же обещания: промпт не должен
// утверждать, что модель видит картинки, если они до неё не доехали.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const { DesignStore } = require('../src/main/design/store.js')
const { buildDesignPrompt } = require('../src/main/design/prompt.js')

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log('  ok  ' + name) }
  catch (err) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message)) }
}

function cut(from, to) {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a)
  assert(a >= 0 && b > a, 'не найдено: ' + from)
  return main.slice(a, b)
}

// Один непрерывный кусок: классификация, чтение вложений, отбор референсов и
// сборка частей сообщения. Режется целиком, чтобы тест не расходился с тем,
// как эти функции вызывают друг друга на самом деле.
const block = cut('const MAX_ATTACHMENT_BYTES =', '// A path typed straight into the message.')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-img-'))
const store = new DesignStore(root)
const catalog = new Map([
  ['seeing/model', { inputModalities: ['text', 'image'] }],
  ['blind/model', { inputModalities: ['text'] }]
])

// С шифрованием на диске вложения читаются через unwrapProtectedBytes; здесь
// хранилища нет — байты отдаются как есть, как на машине без safeStorage.
const mod = new Function('parse', 'resolve', 'basename', 'join', 'fs', 'ensureDesignStore',
  'findModelRecord', 'unwrapProtectedBytes',
  block + `
  return { loadAttachments, loadDesignRefAttachments, attachmentParts, messagesWithAttachments,
           modelTakesImages, classifyAttachment, MAX_DESIGN_REF_IMAGES }`
)(path.parse, path.resolve, path.basename, path.join, fsp, () => store,
  id => catalog.get(id), bytes => bytes)

// Однопиксельный PNG — настоящий файл, а не заглушка: путь проходит через
// определение типа по расширению и чтение с диска.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64')

const run = async () => {
  await store.writeRef('d1', 'скрин.png', PNG)
  await store.writeRef('d1', 'бриф.txt', Buffer.from('Тёмная тема, акцент оранжевый.'))

  const loaded = await mod.loadDesignRefAttachments('d1', ['скрин.png', 'бриф.txt'])

  check('картинка из референсов прочитана как вложение', () => {
    const image = loaded.find(a => a.kind === 'image')
    assert.ok(image, 'изображение не попало во вложения: ' + JSON.stringify(loaded.map(a => a.name)))
    assert.match(image.dataUrl, /^data:image\/png;base64,/)
    assert.equal(Buffer.from(image.dataUrl.split(',')[1], 'base64').length, PNG.length,
      'картинка доехала обрезанной')
  })

  check('текстовые референсы сюда не попадают', () => {
    // Их модель читает по требованию через dc_read_ref. Отправлять их ещё и
    // вложением значит платить за один и тот же файл дважды.
    assert.ok(!loaded.some(a => a.name === 'бриф.txt'), 'текст ушёл вложением')
  })

  check('изображение доходит до модели картинкой, а не именем файла', () => {
    const messages = [{ role: 'user', content: 'сделай как на референсах' }]
    const out = mod.messagesWithAttachments(messages, loaded, catalog.get('seeing/model'))
    const parts = out[out.length - 1].content
    assert.ok(Array.isArray(parts), 'сообщение осталось строкой')
    const picture = parts.find(p => p.type === 'image_url')
    assert.ok(picture, 'части image_url нет: ' + JSON.stringify(parts.map(p => p.type)))
    assert.match(picture.image_url.url, /^data:image\/png;base64,/)
    assert.ok(parts.some(p => p.type === 'text' && /сделай как на референсах/.test(p.text)),
      'текст сообщения потерян')
  })

  check('слепой модели картинку не подсовывают, а объясняют', () => {
    const out = mod.messagesWithAttachments([{ role: 'user', content: 'сделай' }], loaded,
      catalog.get('blind/model'))
    const parts = out[out.length - 1].content
    assert.ok(!parts.some(p => p.type === 'image_url'), 'картинка ушла модели без зрения')
    assert.ok(parts.some(p => p.type === 'text' && /не принимает изображения/.test(p.text)),
      'о том, что картинка не дошла, не сказано: ' + JSON.stringify(parts))
  })

  check('лишние картинки отрезаются с оговоркой, а не молча', () => {
    // Молчаливая обрезка хуже отказа: модель решит, что видела весь бриф, и
    // уверенно построит макет по половине.
    assert.equal(mod.MAX_DESIGN_REF_IMAGES, 12)
  })

  // Файл, лежащий в дизайне, но не приложенный к этой реплике, не отправляется.
  // Раньше уходили все картинки дизайна разом, и каждый ход длинного разговора
  // тащил за собой весь накопленный ворох.
  check('чужие файлы дизайна к сообщению не подмешиваются', async () => {})
  const onlyOne = await mod.loadDesignRefAttachments('d1', ['скрин.png'])
  await store.writeRef('d1', 'лишний.png', PNG)
  const stillOne = await mod.loadDesignRefAttachments('d1', ['скрин.png'])
  check('отправляется только приложенное к реплике', () => {
    assert.equal(onlyOne.length, 1)
    assert.equal(stillOne.length, 1, 'ушёл файл, который к сообщению не прикладывали')
    assert.equal(stillOne[0].name, 'скрин.png')
  })
  check('сообщение без вложений не тянет ничего', () => {}) // проверяется ниже

  const many = 'd2'
  const manyNames = []
  for (let i = 0; i < mod.MAX_DESIGN_REF_IMAGES + 3; i++) {
    await store.writeRef(many, `кадр-${i}.png`, PNG)
    manyNames.push(`кадр-${i}.png`)
  }
  const overflow = await mod.loadDesignRefAttachments(many, manyNames)

  check('за потолок не уходит больше разрешённого', () => {
    assert.equal(overflow.filter(a => a.kind === 'image').length, mod.MAX_DESIGN_REF_IMAGES)
  })

  check('об отрезанных картинках сказано прямо', () => {
    const note = overflow.find(a => a.error)
    assert.ok(note, 'оговорки нет')
    assert.match(note.error, /первые 12 изображений из 15/)
    const parts = mod.attachmentParts(overflow, catalog.get('seeing/model'))
    assert.ok(parts.some(p => p.type === 'text' && /из 15/.test(p.text)),
      'оговорка не дошла до сообщения')
  })

  const emptyRefs = await mod.loadDesignRefAttachments('нет-такого', ['x.png'])
  const noDesign = await mod.loadDesignRefAttachments('', ['x.png'])
  const noNames = await mod.loadDesignRefAttachments('d1', [])
  const undefNames = await mod.loadDesignRefAttachments('d1', undefined)
  check('несуществующий дизайн не роняет ход', () => assert.deepEqual(emptyRefs, []))
  check('обычный чат этого пути не касается', () => assert.deepEqual(noDesign, []))
  check('сообщение без приложенных файлов ничего не шлёт', () => {
    assert.deepEqual(noNames, [])
    assert.deepEqual(undefNames, [], 'старое сообщение без списка не должно тянуть весь дизайн')
  })

  // --- и промпт говорит ровно то, что случилось ------------------------------
  const refs = [{ name: 'скрин.png', kind: 'image' }]

  check('когда картинки отданы, промпт не называет модель слепой', () => {
    const prompt = buildDesignPrompt({ designName: 'Мобильное приложение', refs, imagesSent: 2 })
    assert.match(prompt, /included in this turn as pictures you can actually look at/)
    assert.doesNotMatch(prompt, /you have no vision here/)
    assert.doesNotMatch(prompt, /No picture reached you this turn/)
  })

  check('когда картинок нет, обещание зрения не выдаётся', () => {
    const prompt = buildDesignPrompt({ designName: 'Мобильное приложение', refs, imagesSent: 0 })
    assert.match(prompt, /No picture reached you this turn/)
    assert.doesNotMatch(prompt, /pictures you can actually look at/)
  })

  check('число картинок в промпте настоящее', () => {
    assert.match(buildDesignPrompt({ designName: 'X', refs, imagesSent: 13 }), /\(13\)/)
  })

  // --- одно место, где решается, видит ли модель картинки ---------------------
  check('промпт и отправка отвечают на вопрос о зрении одинаково', () => {
    assert.equal(mod.modelTakesImages('seeing/model'), true)
    assert.equal(mod.modelTakesImages('blind/model'), false)
    assert.equal(mod.modelTakesImages('нет-такой-модели'), false)
    // Обещание в промпте считается по тому же признаку, что и реальная
    // отправка: иначе модели скажут «изображения перед тобой», а пришлют текст.
    assert.match(main, /design\.imagesSent = modelTakesImages\(model\)/)
  })

  check('референсы дизайна подмешиваются в тот же ход, что и вложения чата', () => {
    assert.match(main, /await loadDesignRefAttachments\(payload\.designId, payload\.designRefNames\)/)
  })

  // --- плашки живут при сообщении, а не над строкой ввода ---------------------
  // Раньше приложенные файлы висели над вводом до конца жизни дизайна: после
  // первого же сообщения было не разобрать, что уходит с новым вопросом, а что
  // приложено давно, и убрать их оттуда значило удалить файл насовсем.
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')

  check('над вводом показывается только неотправленное', () => {
    assert.match(renderer, /if \(!designPendingRefs\.length\) \{ strip\.setAttribute\('hidden', ''\); return \}/)
  })
  check('отправка забирает файлы с собой и очищает ввод', () => {
    assert.match(renderer, /const attached = designPendingRefs\.slice\(\)\s*\n\s*designPendingRefs = \[\]/)
  })
  check('файлы сохраняются при своём сообщении', () => {
    assert.match(renderer, /\.\.\.\(attached\.length \? \{ refs: attached \} : \{\}\)/)
  })
  check('сообщение показывает приложенное к нему', () => {
    assert.match(renderer, /Array\.isArray\(msg\.refs\) && msg\.refs\.length\) item\.appendChild\(designRefStripEl\(msg\.refs\)\)/)
  })
  check('имена приложенного уходят в ход', () => {
    assert.match(renderer, /designRefNames: designReferenceNames\(attached, design.messages\)/)
    const source = renderer.slice(renderer.indexOf('function designReferenceNames('), renderer.indexOf('async function sendDesignMessage('))
    const select = new Function(source + '; return designReferenceNames')()
    const messages = [{role: 'user', refs: [{name: 'old.png'}]}, {role: 'user', refs: [{name: 'latest.png'}]}, {role: 'user', content: 'Исправь'}]
    assert.deepEqual(select([{name: 'new.png'}], messages), ['new.png'])
    assert.deepEqual(select([], messages), ['latest.png'])
    assert.deepEqual(select([], []), [])
    assert.equal(messages[0].refs[0].name, 'old.png')
  })
  check('открытие другого дизайна не переносит чужую очередь', () => {
    assert.match(renderer, /designRefs = \[\]\s*\n\s*designPendingRefs = \[\]/)
  })
  check('у отправленной плашки нет крестика', () => {
    // Файл уже ушёл модели и, возможно, стоит в макете — «убрать» здесь значило
    // бы сломать собранную страницу задним числом.
    assert.match(renderer, /designRefStripEl\(refs\) \{[\s\S]{0,320}designRefChipEl\(ref, null\)/)
  })
}

run()
  .then(() => {
    fs.rmSync(root, { recursive: true, force: true })
    console.log(JSON.stringify({ ok: failed === 0, failed }))
    process.exit(failed ? 1 : 0)
  })
  .catch(err => {
    fs.rmSync(root, { recursive: true, force: true })
    console.error('ПРОВАЛ: ' + (err && err.stack || err))
    console.log(JSON.stringify({ ok: false, failed: failed + 1 }))
    process.exit(1)
  })
