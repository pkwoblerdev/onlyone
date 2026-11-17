// The design store, held to the things that would quietly lose a user's work.
//
// A design is the deliverable, not a cache: a component overwritten by a
// half-parsed round trip cannot be recovered, and an ambiguous string replace
// that edits the first of three matches removes a section nobody asked about.
// Both are silent, so both are checked here.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DesignStore, assemble, parse, safeComponentName, RUNTIME } =
  require('../src/main/design/store.js')

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

const checkAsync = async (name, fn) => {
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (err) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message))
  }
}

// Windows не отпускает цель переименования мгновенно: антивирус и поисковый
// индекс держат файл сотни миллисекунд, и первая попытка отдаёт EPERM. Данные
// при этом целы, поэтому «версия не сохранилась» на ровном месте — это дефект
// терпения, а не диска. Подменяем ровно то переименование, которое проверяем,
// и считаем попытки: так видно, ждёт ли конкретное место записи.
function holdRenameOnce (endsWith, code = 'EPERM') {
  const fsp = require('node:fs').promises
  const real = fsp.rename
  const seen = []
  fsp.rename = async (from, to) => {
    seen.push(to)
    if (to.endsWith(endsWith) && seen.filter(one => one.endsWith(endsWith)).length === 1) {
      const error = new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`)
      error.code = code
      throw error
    }
    return real(from, to)
  }
  return {
    calls: () => seen.filter(one => one.endsWith(endsWith)).length,
    restore () { fsp.rename = real }
  }
}

// --- names -------------------------------------------------------------------
check('имя не выходит за пределы папки', () => {
  assert.equal(safeComponentName('../../etc/passwd'), 'passwd.dc.html')
  assert.equal(safeComponentName('sub/dir/Card.dc.html'), 'Card.dc.html')
})
check('расширение добавляется само', () => {
  assert.equal(safeComponentName('Landing Page'), 'Landing Page.dc.html')
  assert.equal(safeComponentName('Card.dc.html'), 'Card.dc.html')
})
// Аудит 1.1.0, находка F4: закрывающий тег скрипта внутри строки обрывал файл
// на середине, и компонент возвращался обрезанным — «class Demo { value = "».
check('закрывающий тег внутри логики не обрезает компонент', () => {
  const logic = 'class Demo { value = "</script>" }'
  const file = assemble({ template: '<p>hi</p>', logic, props: '' })
  assert.equal(parse(file).logic, logic)
  assert.equal(parse(file).template, '<p>hi</p>')
})

check('экранирование не портит обычную логику', () => {
  const logic = 'export default { count: 0, add() { this.count += 1 } }'
  assert.equal(parse(assemble({ template: '<b>x</b>', logic })).logic, logic)
})

check('имя рантайма занять нельзя', () => {
  assert.throws(() => safeComponentName(RUNTIME), /занято/)
})
check('пустое имя отвергается', () => {
  assert.throws(() => safeComponentName('   '), /Пустое/)
  assert.throws(() => safeComponentName('..'), /Пустое/)
})

// --- round trip --------------------------------------------------------------
// Assembling and parsing back has to return exactly what went in. If it does
// not, every targeted edit silently rewrites the pieces it did not touch.
check('сборка и разбор возвращают то же самое', () => {
  const pieces = {
    template: '<div class="card">\n  <h1>Привет</h1>\n</div>',
    logic: 'class Component extends DCLogic {\n  renderVals() { return { a: 1 } }\n}',
    props: '{"$preview":{"width":800,"height":600},"accent":{"editor":"color","default":"#E08C62"}}'
  }
  const back = parse(assemble(pieces))
  assert.equal(back.template, pieces.template)
  assert.equal(back.logic, pieces.logic)
  assert.equal(back.props, pieces.props)
})

check('кавычки в props переживают круг', () => {
  const props = '{"label":"Он сказал \\"да\\" и <ушёл>"}'
  const back = parse(assemble({ template: '<p>x</p>', logic: '', props }))
  assert.equal(back.props, props)
})

check('шаблон без логики собирается', () => {
  const file = assemble({ template: '<p>только разметка</p>' })
  assert.ok(file.includes('<x-dc>'))
  assert.ok(!file.includes('data-dc-script'), 'пустой script не нужен')
  assert.equal(parse(file).template, '<p>только разметка</p>')
})

check('рантайм подключён относительным путём', () => {
  assert.ok(assemble({ template: '<p>x</p>' }).includes(`src="./${RUNTIME}"`))
})

// --- the runtime has to boot with no network ---------------------------------
// This is the defect that shipped: the preview stayed blank for every design,
// because the bundled runtime fetched React, ReactDOM and Babel from unpkg —
// and this app has no network, a strict CSP, and a sandboxed frame. Nothing
// errored anywhere the user could see it; the mockup was simply empty.
const runtimeFile = path.join(__dirname, '..', 'src', 'renderer', 'dc-runtime.js')
const runtime = fs.readFileSync(runtimeFile, 'utf8')

check('движок превью не тянет React из сети', () => {
  const boot = [...runtime.matchAll(/var (REACT_URL|REACT_DOM_URL) = "([^"]+)"/g)]
  assert.equal(boot.length, 2, 'не найдены адреса React и ReactDOM')
  for (const [, name, url] of boot) {
    assert.ok(!/^https?:/.test(url), `${name} ведёт наружу: ${url}`)
  }
})

check('всё, что движок грузит локально, лежит рядом с макетом', () => {
  // The list is read out of the runtime rather than typed here, so adding a
  // dependency to it and forgetting to ship the file fails this check.
  const local = [...runtime.matchAll(/var [A-Z_]+_URL = "(\.\/[^"]+)"/g)].map(m => m[1].slice(2))
  assert.ok(local.length >= 2, 'движок не ссылается ни на один локальный файл')
  const vendor = path.join(__dirname, '..', 'src', 'renderer', 'vendor')
  for (const file of local) {
    assert.ok(fs.existsSync(path.join(vendor, file)), `нет файла в vendor: ${file}`)
  }
})

// Babel is the one thing still fetched, and only when a design imports a JSX
// module — the base render never needs it. Recorded here so that if it ever
// becomes load-bearing, someone has to change this check on purpose.
check('из сети остаётся только Babel, и только для JSX-импорта', () => {
  const external = [...new Set([...runtime.matchAll(/https?:\/\/[^"' )]+/g)].map(m => m[0]))]
  assert.deepEqual(external.map(u => new URL(u).pathname.split('/')[1] || u),
    ['@babel'], 'наружу ходит что-то кроме Babel: ' + external.join(', '))
  const at = runtime.indexOf('BABEL_URL')
  assert.ok(/kind === "jsx" \? ensureBabel\(\)/.test(runtime),
    'Babel должен грузиться только для JSX-импорта')
  assert.ok(at > 0)
})

// --- on disk -----------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-design-'))
const store = new DesignStore(root)

const run = async () => {
  await store.write('d1', 'Card', {
    template: '<div class="a">один</div>\n<div class="b">два</div>',
    logic: 'class Component extends DCLogic {}',
    props: '{}'
  })

  const listed = await store.list('d1')
  assert.deepEqual(listed, ['Card.dc.html'], 'компонент попал в список')

  const read = await store.read('d1', 'Card')
  assert.equal(read.template, '<div class="a">один</div>\n<div class="b">два</div>')

  // A unique fragment is replaced; the rest of the file is untouched.
  await store.replace('d1', 'Card', 'template', '<div class="a">один</div>', '<div class="a">ОДИН</div>')
  const after = await store.read('d1', 'Card')
  assert.equal(after.template, '<div class="a">ОДИН</div>\n<div class="b">два</div>')
  assert.equal(after.logic, 'class Component extends DCLogic {}', 'логика не тронута')

  // Ambiguity is refused, not guessed.
  await store.write('d1', 'Twice', { template: '<p>повтор</p>\n<p>повтор</p>' })
  await assert.rejects(
    () => store.replace('d1', 'Twice', 'template', '<p>повтор</p>', '<p>один</p>'),
    /встречается 2/,
    'неоднозначная замена должна отвергаться'
  )
  const untouched = await store.read('d1', 'Twice')
  assert.equal(untouched.template, '<p>повтор</p>\n<p>повтор</p>', 'файл не изменился после отказа')

  await assert.rejects(
    () => store.replace('d1', 'Card', 'template', 'такого текста нет', 'x'),
    /не найден/
  )

  // The runtime is copied in, so the folder renders on its own — and so are the
  // files the runtime loads beside it. A design folder the user zips up has to
  // open in a plain browser with no network.
  assert.ok(fs.existsSync(path.join(root, 'd1', RUNTIME)), 'рантайм скопирован в папку дизайна')
  const runtimeText = fs.readFileSync(path.join(root, 'd1', RUNTIME), 'utf8')
  for (const m of runtimeText.matchAll(/var [A-Z_]+_URL = "\.\/([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(root, 'd1', m[1])),
      `движок грузит ${m[1]}, но файла нет рядом с макетом`)
  }

  await store.setProps('d1', 'Card', '{"$preview":{"width":400,"height":300}}')
  const withProps = await store.read('d1', 'Card')
  assert.equal(withProps.props, '{"$preview":{"width":400,"height":300}}')
  assert.equal(withProps.template, '<div class="a">ОДИН</div>\n<div class="b">два</div>',
    'смена props не трогает разметку')

  await store.remove('d1', 'Twice')
  assert.deepEqual(await store.list('d1'), ['Card.dc.html'])

  // ЭПРМ на переименовании: файл на месте, а пользователь видит «не сохранилось».
  await checkAsync('осечка переименования компонента не теряет запись (EPERM)', async () => {
    const stub = holdRenameOnce('Card.dc.html')
    try {
      await store.write('lock', 'Card', { template: '<p>целый</p>', logic: '', props: '{}' })
    } finally { stub.restore() }
    assert.ok(stub.calls() >= 2, `переименование пробовали ${stub.calls()} раз — первую осечку не повторили`)
    const back = await store.read('lock', 'Card')
    assert.equal(back.template, '<p>целый</p>', 'компонент не дописался после осечки')
  })

  await checkAsync('осечка переименования рантайма не теряет копию (EPERM)', async () => {
    const stub = holdRenameOnce(RUNTIME)
    try {
      await store.write('lock2', 'Card', { template: '<p>x</p>', logic: '', props: '{}' })
    } finally { stub.restore() }
    assert.ok(stub.calls() >= 2, `рантайм переименовывали ${stub.calls()} раз — терпения нет`)
    assert.ok(fs.existsSync(path.join(root, 'lock2', RUNTIME)), 'рантайм не лёг в папку после осечки')
  })

  await checkAsync('ошибку «нет места на диске» повторять нечем', async () => {
    const stub = holdRenameOnce('Soon.dc.html', 'ENOSPC')
    let thrown = null
    try {
      await store.write('lock3', 'Soon', { template: '<p>x</p>', logic: '', props: '{}' })
    } catch (error) { thrown = error } finally { stub.restore() }
    assert.ok(thrown && /ENOSPC/.test(String(thrown.message)), `чужая ошибка не ушла наружу: ${thrown && thrown.message}`)
    assert.equal(stub.calls(), 1, `ENOSPC повторили ${stub.calls()} раз — диск от этого свободнее не станет`)
  })

  await store.removeDesign('lock')
  await store.removeDesign('lock2')
  await store.removeDesign('lock3')

  // An id that could climb out of the store is refused.
  assert.throws(() => store.folder('../escape'), /идентификатор/)
  assert.throws(() => store.folder(''), /идентификатор/)

  await store.removeDesign('d1')
  assert.deepEqual(await store.list('d1'), [])
}

run()
  .then(() => {
    fs.rmSync(root, { recursive: true, force: true })
    for (const name of ['компонент пишется и читается', 'замена точечная',
                        'неоднозначная замена отвергается', 'рантайм копируется',
                        'props меняются отдельно', 'идентификатор проверяется']) {
      console.log('  ok  ' + name)
    }
    console.log(JSON.stringify({ ok: failed === 0, failed }))
    process.exit(failed ? 1 : 0)
  })
  .catch(err => {
    fs.rmSync(root, { recursive: true, force: true })
    console.error('ПРОВАЛ: ' + (err && err.message))
    console.log(JSON.stringify({ ok: false, failed: failed + 1 }))
    process.exit(1)
  })
