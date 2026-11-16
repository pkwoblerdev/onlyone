// Экспорт активного артефакта в файл (план, 1.4) — логика главного процесса.
//
// `src/main/artifact-export.js` получает все зависимости внутрь (`artifacts`,
// `root`, `showSaveDialog`, `capturePage`), поэтому здесь настоящие артефакты во
// временной папке и заглушки диалога и растра со счётчиками: ни окна, ни сети, ни
// настоящего «Сохранить как…».
//
// Счётчик вызова диалога — не формальность. Негодный вход (нет артефакта, нет
// версии, формат не подходит виду, подозрительный svgText) обязан отвергаться ДО
// того, как человек увидит окно сохранения: спросить «куда писать» и затем
// отказаться — значит заставить его выбирать место под файл, которого не будет.
//
// Отдельная граница — `svgText`: график рисует окно, главный процесс про макет не
// знает ничего, значит содержимое для .svg приезжает со стороны, которую диктует
// модель, и проверяется до записи на диск.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const artifactsLib = require('../src/main/artifacts')

const EXPORTER = path.join(__dirname, '..', 'src', 'main', 'artifact-export.js')

// require ловится заранее: без этого файл упал бы один раз на загрузке, и ни одна
// проверка не сказала бы, чего именно из поведения не хватает.
let createArtifactExporter = null
let exporterLoadError = null
try {
  createArtifactExporter = require(EXPORTER).createArtifactExporter
} catch (error) {
  exporterLoadError = error
}

let failed = 0
let total = 0
async function check (name, fn) {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message))
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x10, 0xde, 0xad, 0xbe, 0xef])

const SVG_OK = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">' +
  '<title>Заказы по неделям</title><rect x="10" y="20" width="30" height="80" fill="var(--accent)" />' +
  '<text x="12" y="112" text-anchor="middle">Неделя 1</text></svg>'

// Имя файла версии у каждого вида своё — берётся из того же справочника, что и
// хранилище, чтобы проверка не разъехалась с ним в один вечер.
const FILENAME = artifactsLib.FILENAME

// Содержимое видов — то, что реально лежит на диске: экспорт «как есть» обязан
// совпадать с этим побайтово, а не «в целом похоже».
const FIXTURES = {
  page: '<!doctype html>\n<html><body><h1>Пальмы</h1></body></html>',
  image: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==',
  table: 'план,цена\nстарт,0\nпремиум,4900',
  chart: JSON.stringify({
    type: 'bar', title: 'Заказы', xLabel: 'Неделя', yLabel: 'Штуки',
    categories: ['Неделя 1', 'Неделя 2'], series: [{ name: 'Факт', values: [4, 7] }]
  }),
  code: 'const a = 1\nconsole.log(a) // юникод тоже байт в байт',
  diff: '--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-старое\n+новое\n'
}

const trash = []
function tempDir (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  trash.push(dir)
  return dir
}

// stem — имя без последнего расширения: «не длиннее 80 знаков» и «без завершающей
// точки или пробела» относятся к имени, а не к хвосту `.png`.
function stemOf (name) {
  const cut = name.lastIndexOf('.')
  return cut > 0 ? name.slice(0, cut) : name
}

async function makeStore (kinds) {
  const dir = tempDir('onlyone-artifact-export-')
  const store = artifactsLib.create({ dir })
  const ctx = { dir, store, made: {} }
  for (const kind of Object.keys(kinds)) {
    const spec = kinds[kind]
    const meta = await store.add({
      chatId: 'чат-1', kind, title: spec.title || ('Название ' + kind), content: spec.content
    })
    const text = {}
    for (const version of meta.versions) text[version.n] = await store.versionText(meta.id, version.n)
    ctx.made[kind] = { id: meta.id, current: meta.current, versions: meta.versions, text }
  }
  return ctx
}

function makeHarness (ctx, { capture = true } = {}) {
  const h = {
    ctx,
    dialogCalls: [],
    captureCalls: [],
    dialogReply: { canceled: true },
    captureBytes: PNG,
    captureError: null
  }
  h.showSaveDialog = (...args) => { h.dialogCalls.push(args); return h.dialogReply }
  h.capturePage = (...args) => {
    h.captureCalls.push(args)
    if (h.captureError) throw h.captureError
    return h.captureBytes
  }
  h.build = () => {
    // Обычный throw вместо assert: провал обязан звучать как «модуля нет», а не
    // как «выражение дало falsy», иначе список красных читается не пойми о чём.
    if (typeof createArtifactExporter !== 'function') {
      throw new Error('нет src/main/artifact-export.js:createArtifactExporter — ' +
        (exporterLoadError ? String(exporterLoadError.message).split('\n')[0] : 'экспортируется не то'))
    }
    const deps = { artifacts: ctx.store, root: ctx.dir, showSaveDialog: h.showSaveDialog }
    if (capture) deps.capturePage = h.capturePage
    return createArtifactExporter(deps)
  }
  // «Человек выбрал место» — единственный способ, которым диалог разрешает запись.
  h.pick = target => {
    h.dialogReply = { filePath: target }
    return target
  }
  h.target = (name = 'файл') => path.join(tempDir('onlyone-export-target-'), name)
  return h
}

// Параметры диалога реализация вправе развернуть как угодно (options, window,
// properties) — значение ищется в глубине, чтобы проверка держала смысл (куда
// предлагать сохранять), а не форму вызова.
function deepFind (value, key, seen = new Set()) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || seen.has(value)) return undefined
  seen.add(value)
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)) return value[key]
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = deepFind(item, key, seen)
    if (found !== undefined) return found
  }
  return undefined
}

function defaultPathOf (h) {
  assert.ok(h.dialogCalls.length, 'диалог сохранения не открылся — спрашивать нечего')
  const value = deepFind(h.dialogCalls[0], 'defaultPath')
  assert.equal(typeof value, 'string', 'у диалога нет defaultPath — некуда сохранять')
  return value
}

// Что реально встанет на то место, которое отдаст capturePage: адрес может быть
// data: URL, file:// или путём к временному файлу — проверяется содержимое, а не
// способ его доставить.
function renderedBehind (value, out = [], seen = new Set()) {
  if (!value || seen.has(value)) return out.join('\n')
  seen.add(value)
  if (typeof value === 'string') {
    out.push(value)
    const base64 = /^data:[^,]*;base64,([\s\S]*)$/.exec(value)
    if (base64) out.push(Buffer.from(base64[1], 'base64').toString('utf8'))
    else if (/^data:[^,]*,/.test(value)) {
      const inline = value.slice(value.indexOf(',') + 1)
      try { out.push(decodeURIComponent(inline)) } catch { out.push(inline) }
    } else if (/^file:/i.test(value)) {
      try { out.push(fs.readFileSync(fileURLToPath(value), 'utf8')) } catch { /* адрес не читается — решение за реализацией */ }
    }
    return out.join('\n')
  }
  if (Buffer.isBuffer(value)) { out.push(value.toString('utf8')); return out.join('\n') }
  if (typeof value !== 'object') return out.join('\n')
  for (const nested of Array.isArray(value) ? value : Object.values(value)) renderedBehind(nested, out, seen)
  return out.join('\n')
}

async function main () {
  const all = await makeStore({
    page: { content: FIXTURES.page },
    image: { content: FIXTURES.image },
    table: { content: FIXTURES.table },
    chart: { content: FIXTURES.chart },
    code: { content: FIXTURES.code },
    diff: { content: FIXTURES.diff }
  })

  await check('модуль экспорта существует и отдаёт обещанный контракт', async () => {
    if (typeof createArtifactExporter !== 'function') {
      throw new Error('src/main/artifact-export.js:createArtifactExporter отсутствует — ' +
        (exporterLoadError ? String(exporterLoadError.message).split('\n')[0] : 'экспортируется не то'))
    }
    const h = makeHarness(all)
    assert.equal(typeof h.build().export, 'function', 'у экспортёра нет export()')
  })

  // --- формат «файл»: то, что лежит на диске -----------------------------------

  for (const kind of Object.keys(FIXTURES)) {
    await check(`формат file для «${kind}» — байт в байт содержимое версии`, async () => {
      const h = makeHarness(all)
      const target = h.pick(h.target(kind + '.out'))
      const res = await h.build().export({ artifactId: all.made[kind].id, format: 'file' }, { w: kind })
      assert.equal(res.ok, true, `экспорт отказал: ${JSON.stringify(res)}`)
      assert.equal(path.resolve(res.path), path.resolve(target), 'ответ не совпал с выбранным местом')
      const onDisk = fs.readFileSync(path.join(all.store.folderOf(all.made[kind].id), '1-' + FILENAME[kind]))
      assert.deepEqual(fs.readFileSync(target), onDisk, 'сохранено не то, что лежит на диске')
      assert.equal(h.dialogCalls.length, 1, 'диалог открытия не один')
    })
  }

  await check('формат file берёт запрошенную версию, а не только текущую', async () => {
    const dir = tempDir('onlyone-artifact-export-')
    const store = artifactsLib.create({ dir })
    const made = await store.add({ chatId: 'чат-1', kind: 'code', title: 'Скрипт', content: 'версия одна' })
    await store.update(made.id, 'версия две')
    const h = makeHarness({ dir, store, made: { code: { id: made.id } } })
    const exporter = h.build()
    const one = h.target('v1.txt')
    const two = h.target('v2.txt')
    h.pick(one)
    const old = await exporter.export({ artifactId: made.id, version: 1, format: 'file' }, null)
    h.pick(two)
    const cur = await exporter.export({ artifactId: made.id, format: 'file' }, null)
    assert.equal(old.ok, true, JSON.stringify(old))
    assert.equal(cur.ok, true, JSON.stringify(cur))
    assert.equal(fs.readFileSync(old.path, 'utf8'), 'версия одна', 'версия 1 поехала: ' + fs.readFileSync(old.path, 'utf8'))
    assert.equal(fs.readFileSync(cur.path, 'utf8'), 'версия две', 'без version обязана быть текущая')
  })

  await check('defaultPath формата file — папка артефакта и имя вида', async () => {
    const expected = { page: /\.html$/, table: /\.csv$/, chart: /\.json$/, diff: /\.patch$/ }
    for (const [kind, re] of Object.entries(expected)) {
      const h = makeHarness(all)
      await h.build().export({ artifactId: all.made[kind].id, format: 'file' }, null)
      const chosen = defaultPathOf(h)
      assert.equal(path.dirname(chosen), all.store.folderOf(all.made[kind].id),
        `${kind}: диалог открывается не в папке артефакта — ${chosen}`)
      assert.match(path.basename(chosen), re, `${kind}: расширение не то — ${chosen}`)
      assert.ok(stemOf(path.basename(chosen)).includes('Название'), `${kind}: заголовок потерялся — ${chosen}`)
    }
    // У code и image расширения у вида нет — требуется только папка и чистота имени.
    for (const kind of ['code', 'image']) {
      const h = makeHarness(all)
      await h.build().export({ artifactId: all.made[kind].id, format: 'file' }, null)
      const chosen = defaultPathOf(h)
      assert.equal(path.dirname(chosen), all.store.folderOf(all.made[kind].id), `${kind}: не та папка — ${chosen}`)
      assert.equal(/[\\/]/.test(path.basename(chosen)), false, `${kind}: разделитель в имени — ${chosen}`)
    }
  })

  // --- формат «html»: обёртка, которая открывается двойным щелчком --------------

  await check('html для page — содержимое версии как есть, без второго обрамления', async () => {
    const h = makeHarness(all)
    const target = h.pick(h.target('page.html'))
    const res = await h.build().export({ artifactId: all.made.page.id, format: 'html' }, null)
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(fs.readFileSync(target, 'utf8'), FIXTURES.page,
      'страницу обернули второй раз: вложенный документ открывается иначе, чем задуман')
  })

  await check('html для image — картинка встроена, протокол приложения не нужен', async () => {
    const h = makeHarness(all)
    const target = h.pick(h.target('image.html'))
    const res = await h.build().export({ artifactId: all.made.image.id, format: 'html' }, null)
    assert.equal(res.ok, true, JSON.stringify(res))
    const body = fs.readFileSync(target, 'utf8')
    assert.match(body, /<!doctype html>/i, 'нет doctype — браузер откроет файл в режиме совместимости')
    assert.ok(body.includes(FIXTURES.image), 'data-ссылка картинки не встроена: двойной щелчок даст пустоту')
    // Экспортированный файл живёт вне приложения: ссылка на свой протокол в нём
    // означала бы «открыл в браузере — белая страница».
    assert.equal(body.includes('onecode-artifact://'), false, 'обёртка ссылается на протокол приложения')
  })

  await check('html для chart — данные графика встроены, протокол приложения не нужен', async () => {
    const h = makeHarness(all)
    const target = h.pick(h.target('chart.html'))
    const res = await h.build().export({ artifactId: all.made.chart.id, format: 'html' }, null)
    assert.equal(res.ok, true, JSON.stringify(res))
    const body = fs.readFileSync(target, 'utf8')
    assert.match(body, /<!doctype html>/i, 'нет doctype')
    for (const marker of ['Факт', 'Неделя 1', 'Заказы']) {
      assert.ok(body.includes(marker), `в обёртке графика нет данных «${marker}»`)
    }
    assert.equal(body.includes('onecode-artifact://'), false, 'обёртка графика ссылается на протокол приложения')
  })

  await check('html для chart не разрывается из </script> в данных', async () => {
    // Данные графика пишет модель, и файл человек открывает двойным щелчком: если
    // реализация вставляет их в <script> как есть, `</script>` из имени серии
    // закрывает блок, и следующий текст становится кодом страницы.
    const ctx = await makeStore({ chart: { content: JSON.stringify({
      type: 'bar', categories: ['А'], series: [{ name: '</script><img src=x onerror=alert(1)>', values: [1] }]
    }) } })
    const h = makeHarness(ctx)
    const target = h.pick(h.target('evil.html'))
    const res = await h.build().export({ artifactId: ctx.made.chart.id, format: 'html' }, null)
    assert.equal(res.ok, true, JSON.stringify(res))
    const body = fs.readFileSync(target, 'utf8')
    assert.equal(/<\/script\s*>\s*<img/i.test(body), false, 'данные закрыли скрипт и открылись разметкой')
    assert.equal(/<img[^>]*onerror/i.test(body), false, 'в файле появился рабочий тег img, собранный из данных графика')
  })

  await check('html для table — отказ, и диалог не открывался', async () => {
    const h = makeHarness(all)
    const res = await h.build().export({ artifactId: all.made.table.id, format: 'html' }, null)
    assert.equal(res.ok, false, JSON.stringify(res))
    assert.notEqual(res.cancelled, true, 'несовместимый вид записан как отмена человека')
    assert.ok(String(res.error || '').length > 4, 'отказ без внятной ошибки')
    assert.equal(h.dialogCalls.length, 0, 'диалог открылся под заведомый отказ')
  })

  // --- формат «svg»: содержимое присылает окно ----------------------------------

  await check('svg для chart — файл равен присланному svgText', async () => {
    const h = makeHarness(all)
    const target = h.pick(h.target('chart.svg'))
    const res = await h.build().export({ artifactId: all.made.chart.id, format: 'svg', svgText: SVG_OK }, null)
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(fs.readFileSync(target, 'utf8'), SVG_OK, 'svgText переписан при записи')
    assert.match(path.basename(defaultPathOf(h)), /\.svg$/, 'диалог предлагает не .svg')
  })

  await check('svg: ведущие пробелы и декларация XML допускаются', async () => {
    const h = makeHarness(all)
    const target = h.pick(h.target('chart2.svg'))
    const text = '\n\n  <?xml version="1.0" encoding="UTF-8"?>\n' + SVG_OK
    const res = await h.build().export({ artifactId: all.made.chart.id, format: 'svg', svgText: text }, null)
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(fs.readFileSync(target, 'utf8'), text)
  })

  await check('svg: не-svg на входе — отказ до диалога, файла нет', async () => {
    const h = makeHarness(all)
    const target = h.pick(h.target('chart.svg'))
    for (const bad of ['', '   ', undefined, null, '<div><svg/></div>', 'svg xmlns=x', '<html><svg/></html>']) {
      const res = await h.build().export({ artifactId: all.made.chart.id, format: 'svg', svgText: bad }, null)
      assert.equal(res.ok, false, `принято не-svg: ${JSON.stringify(bad)}`)
      assert.notEqual(res.cancelled, true, `отказ по входу записан как отмена: ${JSON.stringify(bad)}`)
    }
    assert.equal(h.dialogCalls.length, 0, 'диалог открылся под негодный svgText')
    assert.equal(fs.existsSync(target), false, 'отказал — и всё равно создал файл')
  })

  await check('svg: опасное содержимое отвергается и не пишется', async () => {
    // Любой из этих фрагментов превращает «файл графика» в страницу с чужим
    // скриптом, а открыть её двойным щелчком — то же самое, что скормить модель
    // окну с allow-scripts. Регистр спасает ровно до первого браузера, который
    // разбирает html без его учёта.
    const cases = [
      SVG_OK.replace('</svg>', '<script>alert(1)</script></svg>'),
      SVG_OK.replace('</svg>', '</SCRIPT></svg>'),
      '<svg onload="alert(1)"></svg>',
      '<svg ONLOAD="alert(1)"></svg>',
      SVG_OK.replace('</svg>', '<a onclick="alert(1)">x</a></svg>'),
      SVG_OK.replace('</svg>', '<iframe src="https://example.test"></iframe></svg>'),
      SVG_OK.replace('</svg>', '<object data="x"></object></svg>'),
      SVG_OK.replace('</svg>', '<embed src="x"></embed></svg>'),
      SVG_OK.replace('</svg>', '<link rel="stylesheet" href="https://example.test/a.css"></svg>'),
      SVG_OK.replace('</svg>', '<a href="javascript:alert(1)">x</a></svg>')
    ]
    for (const text of cases) {
      const h = makeHarness(all)
      const target = h.pick(h.target('bad.svg'))
      const res = await h.build().export({ artifactId: all.made.chart.id, format: 'svg', svgText: text }, null)
      assert.equal(res.ok, false, `пропустили в файл: ${text.slice(0, 74)}`)
      assert.equal(h.dialogCalls.length, 0, `диалог открыт под: ${text.slice(0, 74)}`)
      assert.equal(fs.existsSync(target), false, `файл создан под: ${text.slice(0, 74)}`)
    }
  })

  await check('svg: предел длины 2 000 000 знака включительно, сверх — отказ', async () => {
    const head = '<svg xmlns="http://www.w3.org/2000/svg">'
    const tail = '</svg>'
    const fill = n => head + 'x'.repeat(n - head.length - tail.length) + tail
    const atLimit = fill(2_000_000)
    const overLimit = fill(2_000_001)
    assert.equal(atLimit.length, 2_000_000)
    assert.equal(overLimit.length, 2_000_001)

    const ok = makeHarness(all)
    const good = ok.pick(ok.target('at-limit.svg'))
    assert.equal((await ok.build().export({ artifactId: all.made.chart.id, format: 'svg', svgText: atLimit }, null)).ok, true,
      'ровно предел отвергнут — граница сдвинута')
    assert.equal(fs.readFileSync(good, 'utf8').length, 2_000_000)

    const bad = makeHarness(all)
    const target = bad.pick(bad.target('over-limit.svg'))
    const res = await bad.build().export({ artifactId: all.made.chart.id, format: 'svg', svgText: overLimit }, null)
    assert.equal(res.ok, false, 'сверх предела принято')
    assert.equal(fs.existsSync(target), false, 'длинный svg всё-таки легли на диск')
    assert.equal(bad.dialogCalls.length, 0, 'под заведомо длинный svg открыли диалог')
  })

  await check('svg для чужих видов — отказ до диалога', async () => {
    for (const kind of ['table', 'page', 'image', 'code', 'diff']) {
      const h = makeHarness(all)
      const res = await h.build().export({ artifactId: all.made[kind].id, format: 'svg', svgText: SVG_OK }, null)
      assert.equal(res.ok, false, `svg пропустили вид ${kind}`)
      assert.equal(h.dialogCalls.length, 0, `для ${kind} диалог всё равно открылся`)
    }
  })
  // --- формат «png»: растр ------------------------------------------------------

  await check('png для page и image — capturePage получает ссылку на эту версию', async () => {
    for (const kind of ['page', 'image']) {
      const h = makeHarness(all)
      const target = h.pick(h.target(kind + '.png'))
      const res = await h.build().export({ artifactId: all.made[kind].id, format: 'png' }, { window: kind })
      assert.equal(res.ok, true, `${kind}: ${JSON.stringify(res)}`)
      assert.equal(h.captureCalls.length, 1, `${kind}: растр снят ${h.captureCalls.length} раз`)
      const args = h.captureCalls[0]
      const url = deepFind(args, 'url') ?? (typeof args[0] === 'string' ? args[0] : undefined)
      assert.equal(typeof url, 'string', `${kind}: capturePage без адреса`)
      assert.ok(url.startsWith(`onecode-artifact://${all.made[kind].id}/`),
        `${kind}: снимается не этот артефакт — ${url}`)
      assert.ok(url.includes('1-' + FILENAME[kind]), `${kind}: в адресе нет файла версии — ${url}`)
      const width = Number(deepFind(args, 'width'))
      const height = Number(deepFind(args, 'height'))
      assert.ok(Number.isFinite(width) && width > 0, `${kind}: нет ширины кадра — ${width}`)
      assert.ok(Number.isFinite(height) && height > 0, `${kind}: нет высоты кадра — ${height}`)
      assert.deepEqual(fs.readFileSync(target), PNG, 'растр переписан или усечён при записи')
      assert.match(path.basename(defaultPathOf(h)), /\.png$/, 'диалог предлагает не .png')
    }
  })

  await check('png для chart — снимается обёртка с присланным svgText', async () => {
    const h = makeHarness(all)
    const target = h.pick(h.target('chart.png'))
    const res = await h.build().export({ artifactId: all.made.chart.id, format: 'png', svgText: SVG_OK }, null)
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(h.captureCalls.length, 1, `вызовов capturePage: ${h.captureCalls.length}`)
    const url = deepFind(h.captureCalls[0], 'url')
    assert.equal(typeof url, 'string', 'capturePage вызван без url')
    assert.equal(String(url).startsWith('onecode-artifact://'), false,
      'график снимают по ссылке хранилища: json растр не нарисует')
    const behind = renderedBehind(h.captureCalls[0])
    assert.ok(behind.includes('Заказы по неделям') || behind.includes(Buffer.from(SVG_OK).toString('base64')),
      'присланный svgText до растра не дошёл — ' + String(url).slice(0, 80))
    assert.deepEqual(fs.readFileSync(target), PNG)
  })

  await check('png: пустой ответ capturePage — отказ, частичного файла нет', async () => {
    for (const empty of [null, undefined, Buffer.alloc(0)]) {
      const h = makeHarness(all)
      const target = h.pick(h.target('empty.png'))
      h.captureBytes = empty
      const res = await h.build().export({ artifactId: all.made.page.id, format: 'png' }, null)
      assert.equal(res.ok, false, 'пустой растр записали как успех')
      assert.ok(String(res.error || '').length > 4, 'отказ без внятной ошибки')
      assert.equal(fs.existsSync(target), false, 'пустой файл остался на месте отказа')
    }
  })

  await check('png: capturePage бросил — отказ вместо падения главного процесса', async () => {
    const h = makeHarness(all)
    const target = h.pick(h.target('threw.png'))
    h.captureError = new Error('окно закрылось в момент съёмки')
    const res = await h.build().export({ artifactId: all.made.page.id, format: 'png' }, null)
    assert.equal(res.ok, false, JSON.stringify(res))
    assert.ok(typeof res.error === 'string' && res.error.length > 4 && !/undefined|\[object/.test(res.error),
      'ошибка нечитаемая: ' + JSON.stringify(res.error))
    assert.equal(fs.existsSync(target), false, 'незаписанный файл всё равно появился')
  })

  await check('png без capturePage (headless) — отказ до диалога, не TypeError', async () => {
    // Случай отдельный: экспорт вызывается, но растра в этом окружении нет вовсе.
    // Непойманный TypeError ушёл бы в окно rejected promise, и панель висела бы с
    // «Сохраняем…» до перезапуска.
    const h = makeHarness(all, { capture: false })
    const res = await h.build().export({ artifactId: all.made.page.id, format: 'png' }, null)
    assert.equal(res.ok, false, JSON.stringify(res))
    assert.equal(h.dialogCalls.length, 0, 'спросили место под файл, который нечем снять')
  })

  await check('png для table, code и diff — отказ до диалога', async () => {
    for (const kind of ['table', 'code', 'diff']) {
      const h = makeHarness(all)
      const res = await h.build().export({ artifactId: all.made[kind].id, format: 'png' }, null)
      assert.equal(res.ok, false, `растр для ${kind} принят`)
      assert.equal(h.dialogCalls.length, 0, `для ${kind} диалог открылся`)
      assert.equal(h.captureCalls.length, 0, `для ${kind} растр всё равно сняли`)
    }
  })

  // --- отказ по входу ------------------------------------------------------------

  await check('неизвестный артефакт, версия и формат — отказ до диалога', async () => {
    const h = makeHarness(all)
    for (const payload of [
      { artifactId: 'net-takogo-arta', format: 'file' },
      { artifactId: all.made.code.id, version: 99, format: 'file' },
      { artifactId: all.made.code.id, version: 'abc', format: 'file' },
      { artifactId: '', format: 'file' },
      { artifactId: all.made.code.id, format: 'pdf' },
      { artifactId: all.made.code.id, format: '' },
      { artifactId: all.made.code.id },
      { format: 'file' },
      {}
    ]) {
      const res = await h.build().export(payload, null)
      assert.equal(res.ok, false, `принято: ${JSON.stringify(payload)} → ${JSON.stringify(res)}`)
      assert.notEqual(res.cancelled, true, `отказ по входу выдан за отмену: ${JSON.stringify(payload)}`)
    }
    assert.equal(h.dialogCalls.length, 0, 'хотя бы один отказ открыл диалог')
  })

  await check('artifactId с «..» не роняет экспорт и не открывает диалог', async () => {
    // `folderOf` в хранилище бросает синхронно: не поймает это экспортёр — вместо
    // `{ok:false}` окно получит rejected promise.
    const h = makeHarness(all)
    for (const id of ['..', '../../windows', 'a/..', '../' + all.made.code.id, 'x'.repeat(80)]) {
      const res = await h.build().export({ artifactId: id, format: 'file' }, null)
      assert.equal(res.ok, false, `принят идентификатор ${JSON.stringify(id)}`)
      assert.ok(typeof res.error === 'string' && res.error.length > 4, 'нет описания отказа')
    }
    assert.equal(h.dialogCalls.length, 0, 'диалог открылся под чужой идентификатор')
  })

  await check('чужое имя версии из meta.json наружу не читается', async () => {
    // `meta.json` — файл на диске: его мог подправить кто-то вне приложения. Имя
    // версии обязано проходить ту же границу, что в хранилище (VERSION_FILE),
    // иначе экспорт становится «прочитай любой файл по относительному пути».
    for (const badFile of ['../secret.txt', '1-../../secret.txt', '2-secret.txt']) {
      const ctx = await makeStore({ page: { content: '<p>своё</p>' } })
      const id = ctx.made.page.id
      fs.writeFileSync(path.join(path.dirname(ctx.store.folderOf(id)), 'secret.txt'), 'чужой файл')
      const file = path.join(ctx.store.folderOf(id), 'meta.json')
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
      meta.versions[0].file = badFile
      fs.writeFileSync(file, JSON.stringify(meta))
      const h = makeHarness(ctx)
      const target = h.pick(h.target('leak.html'))
      const res = await h.build().export({ artifactId: id, format: 'file' }, null)
      assert.equal(res.ok, false, `экспорт принял meta с file=${badFile}`)
      assert.equal(fs.existsSync(target), false, `файл создан по ${badFile}`)
      assert.equal(h.dialogCalls.length, 0, `под ${badFile} диалог открылся`)
    }
  })

  await check('файл версии стёрт с диска — отказ называет пропажу, а не побег', async () => {
    // У `resolveServed` два разных «нет»: путь смотрит наружу папки и файла нет
    // на диске. Сваливать второе в «лежит вне папки» — значит отправить человека
    // искать несуществующий побег вместо версии, которую стерло.
    const ctx = await makeStore({ page: { content: '<p>своё</p>' } })
    const id = ctx.made.page.id
    const meta = await ctx.store.readMeta(id)
    fs.rmSync(path.join(ctx.store.folderOf(id), meta.versions[0].file))
    const h = makeHarness(ctx)
    const res = await h.build().export({ artifactId: id, format: 'file' }, null)
    assert.equal(res.ok, false, 'выгруженный файл версии пропущен как обычный')
    assert.match(String(res.error || ''), /не найден|пропал|нет на диске|отсутству/,
      'причина отказа названа не та: ' + JSON.stringify(res.error))
    assert.equal(/вне папки/.test(String(res.error || '')), false,
      'пропажа названа побегом наружу: ' + JSON.stringify(res.error))
    assert.equal(h.dialogCalls.length, 0, 'отказ всё равно открыл диалог')
  })

  // --- диалог и запись ------------------------------------------------------------

  await check('отмена диалога — cancelled, файл не создан', async () => {
    const h = makeHarness(all)
    const target = h.target('cancelled.csv')
    h.dialogReply = { canceled: true }
    const res = await h.build().export({ artifactId: all.made.table.id, format: 'file' }, null)
    assert.equal(res.ok, false, JSON.stringify(res))
    assert.equal(res.cancelled, true, 'отмена человека не отличается от отказа')
    assert.equal(h.dialogCalls.length, 1, 'диалог должен был открыться ровно раз')
    // Отмена обязана отпустить и уже существующий файл: человек мог передумать
    // перезаписывать свою работу.
    fs.writeFileSync(target, 'метка: по отмене не пишем')
    h.dialogReply = { canceled: true, filePath: undefined }
    const again = await h.build().export({ artifactId: all.made.table.id, format: 'file' }, null)
    assert.equal(again.cancelled, true, JSON.stringify(again))
    assert.equal(fs.readFileSync(target, 'utf8'), 'метка: по отмене не пишем', 'отмена перезаписала существующий файл')
  })

  await check('путь из диалога — пишется ровно по нему, вне папки артефакта', async () => {
    const h = makeHarness(all)
    const dir = tempDir('onlyone-export-deep-')
    const target = path.join(dir, 'Мой отчёт за сентябрь 2026')
    h.pick(target)
    const res = await h.build().export({ artifactId: all.made.table.id, format: 'file' }, null)
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(path.resolve(res.path), path.resolve(target), 'реализация дописала расширение сама')
    assert.equal(fs.readFileSync(target, 'utf8'), FIXTURES.table)
    assert.deepEqual(fs.readdirSync(all.store.folderOf(all.made.table.id)).sort(), ['1-table.csv', 'meta.json'],
      'в папке артефакта появился мусор')
  })

  await check('диалог вызывается один раз и с тем окном, что попросил', async () => {
    const h = makeHarness(all)
    const owner = { __owner: 'окно-чата-1' }
    h.pick(h.target('owner.csv'))
    await h.build().export({ artifactId: all.made.table.id, format: 'file' }, owner)
    assert.equal(h.dialogCalls.length, 1, `диалог открыт ${h.dialogCalls.length} раз`)
    // Electron прикрепляет модальное окно к переданному родителю: без него лист
    // сохранения вырастает над не тем окном, когда чатов два.
    assert.ok(JSON.stringify(h.dialogCalls).includes('окно-чата-1'), 'ownerWindow не дошёл до диалога')
  })

  await check('несуществующая папка цели — отказ с ошибкой, а не падение', async () => {
    const outside = tempDir('onlyone-export-gone-')
    const h = makeHarness(all)
    h.pick(path.join(outside, 'нет-такой-папки', 'файл.csv'))
    const res = await h.build().export({ artifactId: all.made.table.id, format: 'file' }, null)
    assert.equal(res.ok, false, JSON.stringify(res))
    assert.ok(String(res.error || '').length > 4, 'отказ без объяснения')
    assert.notEqual(res.cancelled, true, 'сбой записи выдан за отмену человека')
  })

  await check('экспорт не трогает хранилище и повторяем', async () => {
    const ctx = await makeStore({ code: { content: 'константа' } })
    const folder = ctx.store.folderOf(ctx.made.code.id)
    const before = fs.readdirSync(folder).sort()
    const meta = fs.readFileSync(path.join(folder, 'meta.json'), 'utf8')
    const h = makeHarness(ctx)
    const exporter = h.build()
    const one = h.target('a.txt')
    const two = h.target('b.txt')
    h.pick(one)
    const first = await exporter.export({ artifactId: ctx.made.code.id, format: 'file' }, null)
    h.pick(two)
    const second = await exporter.export({ artifactId: ctx.made.code.id, format: 'file' }, null)
    assert.equal(first.ok && second.ok, true, `${JSON.stringify(first)} ${JSON.stringify(second)}`)
    assert.equal(fs.readFileSync(one, 'utf8'), 'константа')
    assert.equal(fs.readFileSync(two, 'utf8'), 'константа', 'второй экспорт той же версии дал другой текст')
    assert.deepEqual(fs.readdirSync(folder).sort(), before, 'в хранилище добавился файл')
    assert.equal(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'), meta, 'meta.json переписан экспортом')
  })

  // --- имя по умолчанию: санитизация ---------------------------------------------

  await check('defaultPath: имя очищается, но остаётся читаемым', async () => {
    const cases = [
      { title: 'Отчёт за сентябрь', wants: name => assert.ok(name.includes('Отчёт за сентябрь'), 'пробелы и кириллица потеряны: ' + name) },
      { title: 'а/б\\в', wants: name => assert.equal(/[\\/]/.test(name), false, 'разделитель пути в имени: ' + name) },
      { title: '../../windows/system32/config', wants: name => {
        assert.equal(name.includes('..'), false, '«..» осталось в имени: ' + name)
        assert.equal(/[\\/]/.test(name), false, 'имя ушло из папки артефакта: ' + name)
      } },
      { title: 'а"б<в>г|д?е*з:и', wants: name => assert.equal(/[<>:"|?*]/.test(name), false, 'запрещённый символ в имени: ' + name) },
      { title: 'привет\tмир\nконец', wants: name => {
        // Управляющие символы: перевод строки в имени файл на диске оставляет
        // непроверяемым, а на части систем его вообще не открыть.
        assert.equal(/[\u0000-\u001f]/.test(name), false, 'управляющий символ в имени: ' + JSON.stringify(name))
      } },
      { title: 'Хвост из точек и пробелов...   ', wants: name => {
        assert.equal(/[.\s]$/.test(stemOf(name)), false, 'имя кончается точкой или пробелом: ' + name)
        assert.ok(stemOf(name).includes('Хвост'), 'заголовок стёрт до неузнаваемости: ' + name)
      } },
      { title: 'Очень длинный заголовок артефакта, который '.repeat(12).trim(), wants: name => {
        assert.ok(stemOf(name).length <= 80, `имя длиннее 80 знаков: ${stemOf(name).length}`)
        assert.ok(stemOf(name).length > 8, `имя сжалось в мусор: ${stemOf(name)}`)
      } }
    ]
    for (const item of cases) {
      const ctx = await makeStore({ page: { content: '<p>раз</p>', title: item.title } })
      const h = makeHarness(ctx)
      h.pick(h.target('x.html'))
      const res = await h.build().export({ artifactId: ctx.made.page.id, format: 'file' }, null)
      assert.equal(res.ok, true, `${JSON.stringify(item.title)}: ${JSON.stringify(res)}`)
      const chosen = defaultPathOf(h)
      assert.equal(path.dirname(chosen), ctx.store.folderOf(ctx.made.page.id),
        `${JSON.stringify(item.title)}: диалог открылся вне папки артефакта — ${chosen}`)
      item.wants(path.basename(chosen))
    }
  })

  await check('defaultPath: пустое после очистки имя — artifact, а не точка', async () => {
    // Пустой указатель в диалоге Electron ломает окно сохранения, а «.» или «..»
    // в defaultPath означает попытку выйти из папки артефакта.
    for (const title of ['???', '...', '   ', '::']) {
      const ctx = await makeStore({ page: { content: '<p>раз</p>', title } })
      const h = makeHarness(ctx)
      h.pick(h.target('y.html'))
      const res = await h.build().export({ artifactId: ctx.made.page.id, format: 'file' }, null)
      assert.equal(res.ok, true, JSON.stringify(res))
      const name = path.basename(defaultPathOf(h))
      assert.match(name, /^artifact(\.[A-Za-z0-9]+)?$/, `имя не фолбэк: ${JSON.stringify(name)} для ${JSON.stringify(title)}`)
    }
  })

  await check('png для chart не оставляет временных файлов в хранилище', async () => {
    // Обёртку под растр приходится где-то материализовать; если она осталась в
    // папке артефакта, следующий `list` и протокол отдачи видят чужой файл как
    // версию, а человек получает версионный мусор в истории.
    const h = makeHarness(all)
    h.pick(h.target('chart.png'))
    const res = await h.build().export({ artifactId: all.made.chart.id, format: 'png', svgText: SVG_OK }, null)
    assert.equal(res.ok, true, JSON.stringify(res))
    const folder = all.store.folderOf(all.made.chart.id)
    assert.deepEqual(fs.readdirSync(folder).sort(), ['1-chart.json', 'meta.json'],
      'в папке артефакта остались следы экспорта: ' + fs.readdirSync(folder).join(', '))
  })

  for (const dir of trash) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* временная папка — не доказательство */ }
  }
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed, module: exporterLoadError ? 'отсутствует' : 'есть' }))
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error('ПРОВАЛ харнесса: ' + (error && error.stack) || error)
  process.exit(1)
})
