// Референсы дизайна: приложенные файлы и архивы.
//
// Проверяется то, что ломается тихо: имя, которое вылезает за пределы папки;
// архив, распаковка которого перезаписывает чужой файл; второй файл с тем же
// именем, затирающий первый. Референс — это то, что принёс пользователь, и
// потерять его молча нельзя.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { deflateRawSync } = require('node:zlib')

const { DesignStore, safeRefName, refKind } = require('../src/main/design/store.js')
const { unzip } = require('../src/main/design/unzip.js')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (err) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message))
  }
}

// То же для асинхронных случаев: падение одной проверки не должно обрывать
// остальные, иначе о втором дефекте никто не узнает.
async function acheck(name, fn) {
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (err) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message))
  }
}

// --- имена -------------------------------------------------------------------
check('имя не выходит за пределы refs', () => {
  assert.equal(safeRefName('../../secret.txt'), 'secret.txt')
  assert.equal(safeRefName('a/../../b.png'), 'a/b.png')
  assert.equal(safeRefName('./logo.png'), 'logo.png')
})
check('подпапки сохраняются — распакованный архив это дерево', () => {
  assert.equal(safeRefName('kit/icons/home.svg'), 'kit/icons/home.svg')
  assert.equal(safeRefName('kit\\icons\\home.svg'), 'kit/icons/home.svg')
})
check('пустое имя отвергается', () => {
  assert.throws(() => safeRefName('   '), /Пустое/)
  assert.throws(() => safeRefName('../..'), /Пустое/)
})
check('длинное имя укорачивается, а не падает в ENOENT', () => {
  // Имя из архива или из буфера легко превышает лимит пути Windows. Отказ
  // приходил как «ENOENT: no such file or directory» с полным путём — по такой
  // строке нельзя понять ни что случилось, ни что делать.
  const long = safeRefName('о'.repeat(300) + '.png')
  assert.ok(long.length <= 96, 'сегмент не укорочен: ' + long.length)
  assert.ok(long.endsWith('.png'), 'расширение потеряно: ' + long)
})

check('непомерный путь отвергается с объяснением', () => {
  const deep = Array(6).fill('я'.repeat(90)).join('/')
  assert.throws(() => safeRefName(deep), err => {
    assert.match(err.message, /Слишком длинный путь/)
    assert.doesNotMatch(err.message, /ENOENT/, 'сырая ошибка ФС не должна доходить до пользователя')
    return true
  })
})

check('вид файла определяется по расширению', () => {
  assert.equal(refKind('logo.PNG'), 'image')
  assert.equal(refKind('brief.md'), 'text')
  assert.equal(refKind('kit.zip'), 'archive')
  assert.equal(refKind('font.woff2'), 'binary')
  assert.equal(refKind('noext'), 'binary')
})

// --- сборка архива для проверок ------------------------------------------------
// Пишется вручную, чтобы не тянуть зависимость ради теста.
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [rawName, content, store] of entries) {
    const name = Buffer.from(rawName, 'utf8')
    const data = Buffer.from(content)
    const body = store ? data : deflateRawSync(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(0x0800, 6)             // имена в UTF-8
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(store ? 0 : 8, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const localPart = Buffer.concat(locals)
  const centralPart = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralPart.length, 12)
  eocd.writeUInt32LE(localPart.length, 16)
  return Buffer.concat([localPart, centralPart, eocd])
}

check('deflate и store распаковываются одинаково', () => {
  const zip = makeZip([['a.txt', 'сжатый', false], ['b.txt', 'как есть', true]])
  const out = unzip(zip)
  assert.deepEqual(out.map(f => f.name).sort(), ['a.txt', 'b.txt'])
  assert.equal(out.find(f => f.name === 'a.txt').data.toString(), 'сжатый')
  assert.equal(out.find(f => f.name === 'b.txt').data.toString(), 'как есть')
})

check('кириллица в именах переживает распаковку', () => {
  const out = unzip(makeZip([['макет/экран входа.txt', 'ок', false]]))
  assert.equal(out[0].name, 'макет/экран входа.txt')
})

check('каталоги пропускаются', () => {
  const out = unzip(makeZip([['dir/', '', true], ['dir/f.txt', 'x', true]]))
  assert.deepEqual(out.map(f => f.name), ['dir/f.txt'])
})

check('мусор вместо архива отвергается внятно', () => {
  assert.throws(() => unzip(Buffer.from('это не архив, а просто текст подлиннее')), /не ZIP|повреждён/)
  assert.throws(() => unzip(Buffer.alloc(4)), /не ZIP/)
})

check('пределы соблюдаются', () => {
  const zip = makeZip([['a.txt', 'x'.repeat(1000), true]])
  assert.throws(() => unzip(zip, { maxEntryBytes: 10 }), /предела на один файл/)
  assert.throws(() => unzip(zip, { maxTotalBytes: 10 }), /превышает допустимый размер/)
  assert.throws(() => unzip(makeZip([['a', '1', true], ['b', '2', true]]), { maxEntries: 1 }), /больше предела/)
})

check('поддельный размер не обходит лимит распаковки', () => {
  // Zip-бомба: в каталоге заявлена одна байта, разворачивается на сто тысяч.
  // Предел должен считаться от настоящих ограничений, а не от того, что архив
  // сам о себе сообщил.
  const zip = makeZip([['bomb.txt', 'x'.repeat(100000), false]])
  const central = zip.readUInt32LE(zip.length - 6)
  zip.writeUInt32LE(1, central + 24)
  assert.throws(() => unzip(zip, { maxEntryBytes: 16 }), err => {
    // Текст обязан быть объяснением, а не строкой из внутренностей zlib:
    // «Cannot create a Buffer larger than N bytes» пользователю не говорит
    // ни что случилось, ни что с этим делать.
    assert.match(err.message, /разворачивается больше допустимого|Размер/,
      'сообщение должно объяснять, а не цитировать zlib')
    assert.doesNotMatch(err.message, /Cannot create a Buffer/,
      'сырой текст zlib не должен доходить до пользователя')
    return true
  })
})
check('несовпадение размера несжатого файла отвергается', () => {
  const zip = makeZip([['a.txt', 'hello', true]])
  zip.writeUInt32LE(2, zip.readUInt32LE(zip.length - 6) + 24)
  assert.throws(() => unzip(zip), /Размер/)
})
check('обрезанные данные не читаются из центрального каталога', () => {
  const zip = makeZip([['a.txt', 'hello', true]])
  zip.writeUInt32LE(1000, zip.readUInt32LE(zip.length - 6) + 20)
  assert.throws(() => unzip(zip), /обрезаны/)
})
check('многотомный ZIP не распаковывается частично', () => {
  const zip = makeZip([['a.txt', 'hello', true]])
  zip.writeUInt16LE(1, zip.length - 18)
  assert.throws(() => unzip(zip), /Многотомные/)
})

// --- на диске -----------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-refs-'))
const store = new DesignStore(root)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-src-'))

const run = async () => {
  const photo = path.join(scratch, 'logo.png')
  fs.writeFileSync(photo, Buffer.from('89504e470d0a1a0a', 'hex'))

  const first = await store.addRef('d1', photo)
  assert.equal(first.name, 'logo.png')
  assert.equal(first.kind, 'image')

  // Второй файл с тем же именем не затирает первый: оба принесены пользователем.
  const second = await store.addRef('d1', photo)
  assert.equal(second.name, 'logo (2).png')
  const listed = await store.listRefs('d1')
  assert.deepEqual(listed.map(r => r.name), ['logo (2).png', 'logo.png'])

  // Текст читается, бинарник — нет, и отказ объясняет, что с ним делать.
  await store.writeRef('d1', 'brief.md', Buffer.from('# Бриф\nСиний, воздушно.'))
  const brief = await store.readRef('d1', 'brief.md')
  assert.match(brief.text, /Бриф/)
  assert.equal(brief.truncated, false)
  await assert.rejects(() => store.readRef('d1', 'logo.png'), /не текстовый файл/)
  await assert.rejects(() => store.readRef('d1', 'нет.txt'), /не найден/)

  // Н97: файл, чьё содержимое — валидный JSON (число, null, true, строка,
  // объект без конверта), разбирался успешно, «конвертом» не был, и без
  // шифрования модель получала пустоту. Читается ровно то, что лежит в файле.
  for (const body of ['42', '0', 'null', 'true', 'false', '"привет"', '[1,2,3]', '{"цвет":"синий"}', '{"enc":"plain","data":"x"}']) {
    const stored = await store.writeRef('d1', 'json-like.txt', Buffer.from(body))
    assert.equal((await store.readRef('d1', stored.name)).text, body, 'без шифрования: ' + body)
  }
  {
    const sealed = new DesignStore(fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-refs-enc-')), {
      protect: text => Buffer.from(String(text), 'utf8').toString('hex'),
      unprotect: body => Buffer.from(body, 'hex').toString('utf8')
    })
    for (const body of ['42', '0', 'null', '{"цвет":"синий"}', 'обычный текст']) {
      const stored = await sealed.writeRef('d1', 'json-like.txt', Buffer.from(body))
      assert.equal((await sealed.readRef('d1', stored.name)).text, body, 'с шифрованием: ' + body)
      // Второе чтение — уже из зашифрованного файла: то же самое.
      assert.equal((await sealed.readRef('d1', stored.name)).text, body, 'повторно, с шифрованием: ' + body)
    }
  }

  // Длинный текст обрезается, и об этом сказано.
  await store.writeRef('d1', 'long.txt', Buffer.from('я'.repeat(500)))
  const long = await store.readRef('d1', 'long.txt', 100)
  assert.equal(long.truncated, true)
  assert.equal(long.text.length, 100)

  // Распакованный архив ложится деревом и не выходит за refs/.
  for (const file of unzip(makeZip([['kit/icon.svg', '<svg/>', true], ['kit/notes.txt', 'заметка', false]]))) {
    await store.writeRef('d1', `kit-архив/${file.name}`, file.data)
  }
  const tree = (await store.listRefs('d1')).map(r => r.name)
  assert(tree.includes('kit-архив/kit/icon.svg'), 'файл из архива не найден: ' + tree.join(', '))
  assert(tree.includes('kit-архив/kit/notes.txt'))

  // Попытка вылезти наружу упирается в refs/.
  await store.writeRef('d1', '../../побег.txt', Buffer.from('нет'))
  assert.ok(!fs.existsSync(path.join(root, 'побег.txt')), 'файл ушёл за пределы дизайна')
  assert.ok(fs.existsSync(path.join(root, 'd1', 'refs', 'побег.txt')))

  await store.removeRef('d1', 'logo (2).png')
  assert.ok(!(await store.listRefs('d1')).some(r => r.name === 'logo (2).png'))

  // --- отдельно: то, что раньше терялось молча --------------------------------
  await acheck('два имени, совпавших после очистки, не затирают друг друга', async () => {
    // `writeRef` использовал обычный `writeFile`: в архиве `эскиз<1>.txt` и
    // `эскиз_1_.txt` после очистки — один путь, и второй съедал первый.
    const one = await store.writeRef('d2', 'эскиз<1>.txt', Buffer.from('первый'))
    const two = await store.writeRef('d2', 'эскиз_1_.txt', Buffer.from('второй'))
    assert.notEqual(one.name, two.name, `оба легли в ${one.name}`)
    assert.equal((await store.readRef('d2', one.name)).text, 'первый')
    assert.equal((await store.readRef('d2', two.name)).text, 'второй')
  })

  await acheck('удаление референса не сносит папку с соседями', async () => {
    await store.writeRef('d2', 'подкаталог/один.txt', Buffer.from('1'))
    await store.writeRef('d2', 'подкаталог/два.txt', Buffer.from('2'))
    await assert.rejects(() => store.removeRef('d2', 'подкаталог'), /папка, а не файл/)
    const left = (await store.listRefs('d2')).map(item => item.name)
    assert(left.includes('подкаталог/один.txt') && left.includes('подкаталог/два.txt'),
      'вместо одного файла удалена папка: ' + left.join(', '))
  })

  await acheck('обрезка чтения не рвёт суррогатную пару и считает байты', async () => {
    // Эмодзи — два суррогата: если `limit` попадает между ними, модель
    // получает битый символ вместо честной границы.
    const text = 'a'.repeat(999) + '\u{1F600}' + 'b'.repeat(200)
    await store.writeRef('d2', 'эмодзи.txt', Buffer.from(text))
    const cut = await store.readRef('d2', 'эмодзи.txt', 1000)
    assert.equal(cut.truncated, true)
    assert.ok(!/[\uD800-\uDFFF]$/.test(cut.text), 'на конце обрезки осколок пары суррогатов')
    assert.ok(!cut.text.endsWith('\uFFFD'), 'на конце обрезки replacement character')
    const big = 'x'.repeat(2_000_000)
    await store.writeRef('d2', 'толстый.txt', Buffer.from(big))
    const read = await store.readRef('d2', 'толстый.txt', 500)
    assert.equal(read.bytes, Buffer.byteLength(big), 'размер назван не в байтах')
    assert.equal(read.text.length, 500)
  })

  await acheck('junction внутри refs наружу не читается и не пишет', async () => {
    const { spawnSync } = require('node:child_process')
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-refs-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'внешняя метка')
      await store.writeRef('d3', 'обычный.txt', Buffer.from('своё'))
      const dir = store.refsFolder('d3')
      const link = path.join(dir, 'portal')
      const made = process.platform === 'win32'
        ? spawnSync('cmd', ['/c', 'mklink', '/J', link, outside], { windowsHide: true, stdio: 'ignore' }).status === 0
        : (() => { try { fs.symlinkSync(outside, link, 'dir'); return true } catch { return false } })()
      if (!made) { console.log('   (система не дала создать ссылку — проверка пропущена)'); return }
      // Чтение: файл лексически «внутри» refs, но реальный путь — снаружи.
      await assert.rejects(() => store.readRef('d3', 'portal/secret.txt'), /за пределы папки референсов|не найден/)
      // Запись: нельзя положить файл в чужую папку через тот же переход.
      await assert.rejects(() => store.writeRef('d3', 'portal/новый.txt', Buffer.from('нет')), /за пределы папки референсов/)
      assert.equal(fs.existsSync(path.join(outside, 'новый.txt')), false, 'запись ушла за пределы дизайна')
      // Список не показывает чужое как своё.
      assert.ok(!(await store.listRefs('d3')).some(item => item.name.startsWith('portal/')))
      // Обычные референсы при этом живут как жили.
      assert.equal((await store.readRef('d3', 'обычный.txt')).text, 'своё')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  await acheck('повторный импорт архива с тем же именем не стирает прежний', async () => {
    // Два `kit.zip` с `brief.txt` внутри: раньше второй импорт без
    // предупреждения затирал содержимое первого.
    const first = unzip(makeZip([['brief.txt', 'первый бриф', false]]))
    const second = unzip(makeZip([['brief.txt', 'второй бриф', false]]))
    for (const file of first) await store.writeRef('d4', `kit/${file.name}`, file.data)
    for (const file of second) await store.writeRef('d4', `kit/${file.name}`, file.data)
    const listed = await store.listRefs('d4')
    const texts = []
    for (const item of listed.filter(item => item.name.startsWith('kit/brief'))) texts.push((await store.readRef('d4', item.name)).text)
    assert.equal(texts.length, 2, `файлов brief не два: ${listed.map(i => i.name).join(', ')}`)
    assert(texts.includes('первый бриф') && texts.includes('второй бриф'), 'одно содержимое потеряно: ' + texts.join(' | '))
  })

  // Референсы уезжают вместе с дизайном.
  await store.removeDesign('d1')
  assert.deepEqual(await store.listRefs('d1'), [])
}

run()
  .then(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(scratch, { recursive: true, force: true })
    for (const name of ['файл прикладывается и виден в списке', 'одинаковые имена не затирают друг друга',
                        'текст читается, бинарник отказывает внятно', 'длинный текст обрезается с пометкой',
                        'архив ложится деревом внутри refs', 'выход за пределы refs невозможен',
                        'референс удаляется', 'референсы уходят вместе с дизайном']) {
      console.log('  ok  ' + name)
    }
    console.log(JSON.stringify({ ok: failed === 0, failed }))
    process.exit(failed ? 1 : 0)
  })
  .catch(err => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(scratch, { recursive: true, force: true })
    console.error('ПРОВАЛ: ' + (err && err.message))
    console.log(JSON.stringify({ ok: false, failed: failed + 1 }))
    process.exit(1)
  })
