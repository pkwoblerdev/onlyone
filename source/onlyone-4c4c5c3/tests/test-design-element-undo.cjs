// Версии компонента перед разрушительной правкой.
//
// Правка выбранного элемента в живом превью и откат по Ctrl+Z идут в тот же
// файл, который человек писал руками или скачал из Claude Design: `.dc.html` —
// это результат работы, а не кэш. Одна адресная замена, оказавшаяся не той,
// без прежних байтов не отменяется ничем, и «я случайно удалил кнопку» становится
// историей о потерянном макете. Поэтому до записи должны остаться прежние байты,
// их обязано быть видно, их обязан возвращать откат, и вернуться по чужому или
// вымышленному идентификатору нельзя.
//
// Проверки красные намеренно: версий в хранителе пока нет.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DesignStore } = require('../src/main/design/store.js')

let failed = 0
let total = 0

const check = (name, fn) => {
  total++
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
async function acheck (name, fn) {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (err) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message))
  }
}

// Сколько версий на компонент разрешено держать. Число — верхняя граница, а не
// обязательный размер: хранить бесконечно нельзя (дизайн правят сотнями замен за
// сеанс, и папка растёт на глазу), а резать до одной — значит лишить отката
// цепочки «вернулся, посмотрел, отменил своё возвращение». Реализация вправе
// держать меньше, больше — нет.
const VERSION_CAP = 20

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-versions-'))
const store = new DesignStore(root)
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-versions-outside-'))

// Байты компонента читаются с диска напрямую, а не через `store.read`: тот
// разбирает файл на три куски и собирает обратно, и побайтового равенства прежнего
// состояния он доказать не может — ровно та причина, по которой версия и обязана
// быть байтами, а не разбором.
const componentFile = (designId, name) =>
  path.join(root, designId, name.endsWith('.dc.html') ? name : `${name}.dc.html`)
const readRaw = (designId, name) => fs.promises.readFile(componentFile(designId, name))

// Идентификатор версии достаётся терпеливо: как именно он назван и что ещё лежит
// в записи — вопрос реализации. Важно другое — идентификатор обязан быть
// собственным, а не позицией в списке: после вытеснения старейшей версии индексы
// съезжают, и «вернуть нулевую» означало бы вернуть не то, что человек видел.
function versionId (entry) {
  const id = entry && (entry.id ?? entry.versionId ?? entry.name ?? entry.file ?? entry.version)
  if (id === undefined || id === null || id === '') {
    throw new Error('у записи о версии нет идентификатора: ' + JSON.stringify(entry))
  }
  return String(id)
}

const idsOf = list => list.map(versionId)

// Счётчик для шаблонного фрагмента, который меняется единственным образом.
const mark = i => `<i>${String(i).padStart(2, '0')}</i>`
const bodyOf = i => `<p>экран</p>${mark(i)}`

const run = async () => {
  // --- появление версии -------------------------------------------------------

  await acheck('у несменённого компонента версий нет, и это не ошибка', async () => {
    // Отказ здесь означал бы, что Ctrl+Z и список версий падают на свежем
    // макете, где никто ничего не менял.
    await store.write('plain', 'Card', { template: bodyOf(0), logic: 'class A extends DCLogic {}' })
    assert.deepEqual(await store.listVersions('plain', 'Card'), [])
  })

  await acheck('replace() сохраняет прежние байты отдельной версией', async () => {
    const before = await store.write('undo', 'Card', { template: bodyOf(0), logic: 'class A extends DCLogic {}' })
    assert.equal(before.name, 'Card.dc.html')
    const pre = await readRaw('undo', 'Card.dc.html')
    assert.deepEqual(await store.listVersions('undo', 'Card'), [], 'версия появилась до правки')

    await store.replace('undo', 'Card', 'template', bodyOf(0), bodyOf(1))
    const post = await readRaw('undo', 'Card.dc.html')
    assert.equal(post.equals(pre), false, 'файл не изменился — замена не дошла до диска')
    const versions = await store.listVersions('undo', 'Card')
    assert.equal(versions.length, 1, `ожидалась одна версия, а в списке ${versions.length}`)
  })

  await acheck('версия равна прежнему состоянию побайтно и возвращается откатом', async () => {
    // Это и есть смысл версии: то, что было до правки, можно получить обратно
    // дословно, со всеми отступами и окончаниями строк, а не «примерно так же».
    await store.write('byte', 'Card', { template: bodyOf(0), logic: 'class A extends DCLogic {}' })
    const pre = await readRaw('byte', 'Card.dc.html')
    await store.replace('byte', 'Card', 'template', bodyOf(0), bodyOf(1))
    const [first] = await store.listVersions('byte', 'Card')
    assert.ok(first, 'версии нет в списке')
    await store.restoreVersion('byte', 'Card', versionId(first))
    const back = await readRaw('byte', 'Card.dc.html')
    assert.equal(back.equals(pre), true, 'откат вернул не те байты')
  })

  await acheck('откат сам сохраняет текущее состояние — откат обратим', async () => {
    // Откат, после которого прежнее состояние недоступно, — это ещё одна
    // разрушительная правка: человек нажал Ctrl+Z «посмотреть», а вернуть
    // свою работу уже не может. Поэтому перед восстановлением пишутся текущие
    // байты, и шаг назад остаётся отменяемым шагом вперёд.
    await store.write('back', 'Card', { template: bodyOf(0), logic: '' })
    const zero = await readRaw('back', 'Card.dc.html')
    await store.replace('back', 'Card', 'template', bodyOf(0), bodyOf(1))
    const one = await readRaw('back', 'Card.dc.html')

    const [only] = await store.listVersions('back', 'Card')
    const seen = new Set(idsOf(await store.listVersions('back', 'Card')))
    await store.restoreVersion('back', 'Card', versionId(only))
    assert.equal((await readRaw('back', 'Card.dc.html')).equals(zero), true, 'откат не вернул прежнее')

    const after = await store.listVersions('back', 'Card')
    assert.equal(after.length, 2, `откат должен добавить версию текущего состояния, а в списке ${after.length}`)
    const [fresh] = after.map(versionId).filter(id => !seen.has(id))
    assert.ok(fresh, 'новая версия неотличима от прежней — идентификаторы не уникальны')
    await store.restoreVersion('back', 'Card', fresh)
    assert.equal((await readRaw('back', 'Card.dc.html')).equals(one), true,
      'шаг назад не откатывается шагом вперёд')
  })

  await acheck('несостоявшаяся правка не порождает фантомную версию', async () => {
    // Замена отказана («текст не найден», «встречается twice»), а версия
    // записана — в списке появляется состояние, которого на диске никогда не
    // было, и откат по нему уводит в выдуманный текст.
    await store.write('phantom', 'Card', { template: '<p>повтор</p>\n<p>повтор</p>', logic: '' })
    const before = await readRaw('phantom', 'Card.dc.html')
    await assert.rejects(() => store.replace('phantom', 'Card', 'template', 'такого нет', 'x'))
    await assert.rejects(() => store.replace('phantom', 'Card', 'template', '<p>повтор</p>', '<p>раз</p>'))
    await assert.rejects(() => store.replace('phantom', 'Нет', 'template', 'x', 'y'))
    assert.deepEqual(await store.listVersions('phantom', 'Card'), [], 'отказавшая запись оставила версию')
    assert.equal((await readRaw('phantom', 'Card.dc.html')).equals(before), true, 'отказавшая запись тронула файл')
  })

  await acheck('версии не притворяются компонентами макета', async () => {
    // Вкладки макета — это `list()`, который берёт всё, что оканчивается на
    // `.dc.html`, из папки дизайна. Версии, сложенные рядом с компонентами в
    // виде `Card.dc.html.1.dc.html`, превратили бы одну правку в десять вкладок.
    await store.write('tabs', 'A', { template: bodyOf(0) })
    await store.write('tabs', 'B', { template: '<p>б</p>' })
    await store.setEntry('tabs', 'A')
    await store.replace('tabs', 'A', 'template', bodyOf(0), bodyOf(1))
    assert.deepEqual(await store.list('tabs'), ['A.dc.html', 'B.dc.html'])
    assert.equal(await store.getEntry('tabs'), 'A.dc.html')
  })

  // --- предел -----------------------------------------------------------------

  await acheck('список версий ограничен, и вытесняется из него старейшая', async () => {
    await store.write('cap', 'Card', { template: bodyOf(0), logic: '' })
    await store.replace('cap', 'Card', 'template', bodyOf(0), bodyOf(1))
    const [oldest] = await store.listVersions('cap', 'Card')
    const oldestId = versionId(oldest)
    assert.ok(oldestId, 'первая версия не именуется')

    for (let i = 2; i <= 25; i++) {
      await store.replace('cap', 'Card', 'template', bodyOf(i - 1), bodyOf(i))
    }
    const list = await store.listVersions('cap', 'Card')
    assert.ok(list.length >= 2, `версий осталась ${list.length} — откат цепочки правок невозможен`)
    assert.ok(list.length <= VERSION_CAP,
      `версий ${list.length}, а ожидалось не больше ${VERSION_CAP}: список обязан вытеснять, а не расти`)
    assert.equal(idsOf(list).includes(oldestId), false,
      'старейшая версия пережила вытеснение — значит из списка уходит не она')

    // Оставшиеся обязаны быть рабочими, а не только перечислимыми.
    await store.restoreVersion('cap', 'Card', versionId(list[0]))
    assert.ok((await store.listVersions('cap', 'Card')).length <= VERSION_CAP + 1,
      'откат сам выбрасывает лимит за границу')
  })

  // --- границы отказа ---------------------------------------------------------

  await acheck('чужую версию не вернуть ни в другой компонент, ни в другой дизайн', async () => {
    // Идентификатор приходит из окна и из истории: «верни версию V» ничего не
    // говорит о том, чья она. Без привязки к паре «дизайн + компонент» один
    // идентификатор из открытого макета затирал бы байты соседнего — молча и
    // необратимо.
    await store.write('owner', 'Card', { template: bodyOf(0) })
    await store.write('owner', 'Other', { template: '<p>чужая разметка</p>' })
    await store.write('guest', 'Card', { template: '<p>совсем другой дизайн</p>' })
    await store.replace('owner', 'Card', 'template', bodyOf(0), bodyOf(1))
    const [mine] = await store.listVersions('owner', 'Card')
    const id = versionId(mine)

    const otherBefore = await readRaw('owner', 'Other.dc.html')
    const guestBefore = await readRaw('guest', 'Card.dc.html')

    await assert.rejects(() => store.restoreVersion('owner', 'Other', id))
    await assert.rejects(() => store.restoreVersion('guest', 'Card', id))
    assert.equal((await readRaw('owner', 'Other.dc.html')).equals(otherBefore), true,
      'чужая версия перезаписала другой компонент этого же дизайна')
    assert.equal((await readRaw('guest', 'Card.dc.html')).equals(guestBefore), true,
      'версия из другого дизайна перезаписала компонент чужого макета')
    assert.deepEqual(await store.listVersions('guest', 'Card'), [],
      'отказ не должен был оставить после себя версию')
  })

  await acheck('выход за пределы папки дизайна отвергается и для компонента, и для версии', async () => {
    // `safeComponentName` уже обрубает директории, но `versionId` — строка
    // произвольная, и она попадает в путь сборки: `../../<другой дизайн>/Card/<файл>`
    // вернул бы чужие байты, а абсолютный путь записал бы их куда угодно.
    const victim = path.join(outside, 'Card.dc.html')
    const untouched = Buffer.from('этого файла касаться не должны были')
    fs.writeFileSync(victim, untouched)

    await store.write('escape', 'Card', { template: bodyOf(0) })
    await store.replace('escape', 'Card', 'template', bodyOf(0), bodyOf(1))
    const [version] = await store.listVersions('escape', 'Card')
    const id = versionId(version)
    const inPlace = await readRaw('escape', 'Card.dc.html')

    await assert.rejects(() => store.restoreVersion('escape', '../..', id))
    await assert.rejects(() => store.restoreVersion('escape', victim, id), 'абсолютный путь')
    await assert.rejects(() => store.restoreVersion('escape', 'Card', path.join(outside, 'x')))
    await assert.rejects(() => store.restoreVersion('escape', 'Card', `../../escape/Card/${id}`))
    await assert.rejects(() => store.restoreVersion('../etc', 'Card', id))

    assert.equal(fs.readFileSync(victim).equals(untouched), true, 'запись ушла за пределы дизайна')
    assert.equal((await readRaw('escape', 'Card.dc.html')).equals(inPlace), true,
      'отказавший откат тронул компонент')
  })

  await acheck('вымышленная версия отвергается, файл остаётся', async () => {
    await store.write('ghost', 'Card', { template: bodyOf(0) })
    await store.replace('ghost', 'Card', 'template', bodyOf(0), bodyOf(1))
    const before = await readRaw('ghost', 'Card.dc.html')
    await assert.rejects(() => store.restoreVersion('ghost', 'Card', 'no-such-version'))
    await assert.rejects(() => store.restoreVersion('ghost', 'Card', ''))
    assert.equal((await readRaw('ghost', 'Card.dc.html')).equals(before), true,
      'отказ откатил что-то до того, как проверить, что откатывать')
    assert.equal((await store.listVersions('ghost', 'Card')).length, 1, 'отказ породил версию')
  })

  await acheck('удаление дизайна уносит и версии', async () => {
    // Версии — часть макета, а не мусор кэша: остаться в профиле после того,
    // как человек удалил дизайн, значит оставить его правки там, где их уже
    // никто не ждёт и не чистит.
    await store.write('gone', 'Card', { template: bodyOf(0) })
    await store.replace('gone', 'Card', 'template', bodyOf(0), bodyOf(1))
    assert.ok((await store.listVersions('gone', 'Card')).length === 1)
    await store.removeDesign('gone')
    assert.deepEqual(await store.list('gone'), [])
    assert.deepEqual(await store.listVersions('gone', 'Card'), [])
  })

  // --- то, что не должно разъехаться с существующим поведением ------------------

  await acheck('версии не мешают обычной записи и точечной правке', async () => {
    // Смысл проверки: версионирование не должно изменить ни ответа `replace`,
    // ни отказа на неоднозначность — на этих строках держатся соседние наборы.
    await store.write('same', 'Card', { template: '<p>повтор</p>\n<p>повтор</p>' })
    await assert.rejects(() => store.replace('same', 'Card', 'template', '<p>повтор</p>', '<p>раз</p>'), /встречается 2/)
    const result = await store.replace('same', 'Card', 'template', '<p>повтор</p>\n<p>повтор</p>', '<p>раз</p>')
    assert.deepEqual(result, { name: 'Card.dc.html', replaced: 1 })
    await store.setProps('same', 'Card', '{"$preview":{"width":400}}')
    assert.equal((await store.read('same', 'Card')).props, '{"$preview":{"width":400}}')
  })
}

run()
  .then(async () => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
    console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
    process.exit(failed ? 1 : 0)
  })
  .catch(async err => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
    console.error('ПРОВАЛ: ' + (err && err.stack || err))
    console.log(JSON.stringify({ ok: false, checks: total, failed: failed + 1 }))
    process.exit(1)
  })
