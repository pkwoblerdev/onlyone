// Н77: окно принимает за независимую ширину макета то, что страница имела только
// в своей колонке.
//
// Раздел Design показывает макет в кросс-ориджинном кадре (`sandbox="allow-scripts"`),
// который сам докладывает окну свои размеры сообщением `onecode-design-size`.
// Поле `width` в этом докладе двусмысленно по построению: `reportSize()` в
// `src/main/main.js` кладёт в него задекларированный страницей `$preview.width`,
// а если страница ничего не декларировала — измеренный `scrollWidth`, то есть
// ширину, которую страница имеет ПРИ ТОЙ колонке, в которую её поставили в эту
// секунду. Окно же сегодня трактует любое приехавшее число как независимую ширину
// и назначает кадру `style.width` в пикселях.
//
// Замер 26.09 с живого прогона: кадр доложил `width: 270` при `viewportWidth: 270`
// (страница целиком помещалась в свою область, горизонтальной прокрутки внутри не
// было), сцена к этому моменту была 428 px. Окно заморозило кадр в 270 px — превью
// оказалось на 158 px уже доступного места, заголовок обрезался, а внутри самой
// страницы появилась горизонтальная прокрутка. ResizeObserver по сцене срабатывает,
// но пересчитывает масштаб по уже замороженной ширине: сама она не обновляется, и
// превью висит узким до конца сеанса.
//
// Отсюда правило, которое здесь фиксируется: если страница влезает в свою область
// (`viewportWidth > 0` и `width <= viewportWidth + 1`), независимой ширины у неё
// нет — окно снимает с кадра явные `width`/`height`/`zoom`/`transform` и отдаёт его
// CSS `.design-preview-frame { width: 100%; height: 100% }`, который сам следует за
// колонкой. Если же содержимое в область не влезает (`width > viewportWidth + 1`,
// в том числе задекларированные 1440 в колонке 660) — это настоящая фиксированная
// ширина, и для неё работает сегодняшняя логика вписывания; именно ради неё
// вписывание и заводилось, сломать его нельзя.
//
// Проверки красные намеренно и ровно там, где окно сегодня замораживает кадр в
// «влезает»-случае (плюс объявление функции приёма доклада внутри блока превью).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.css'), 'utf8')

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

// --- вырезаемый блок -----------------------------------------------------------
//
// Харнесс независимый от соседнего `test-design-100-regressions.cjs`, но маркеры
// те же самые осознанно: сосед исполняет этот блок в песочнице со списком имён
// `$`, `setElementPicking`, `t`, `initialDesign`, `initialComponent`. Новый код,
// вынесенный за маркеры или потянувший там верхнеуровневый `window`/`document`,
// сломал бы не этот набор, а его — поэтому проверка 13 прогоняет блок ровно в тех
// же условиях.
const BLOCK_START = '// Превью само вписывает макет'
const BLOCK_END = '// --- review comments'

const cut = (text, from, to, what) => {
  const start = text.indexOf(from)
  assert.notEqual(start, -1, `не найден маркер начала «${from}» — блок ${what} разъехался`)
  const end = text.indexOf(to, start + from.length)
  assert.ok(end > start, `не найден маркер конца «${to}» — блок ${what} разъехался`)
  return text.slice(start, end)
}

const previewBlock = cut(appSource, BLOCK_START, BLOCK_END, 'превью')

// Поведение приёма доклада сегодня: обработчик `message` стоит вне блока и сам
// делает охрану значения. После правки весь этот путь обязан оказаться внутри
// блока (см. проверку 13), и харнесс перестанет использовать ветку ниже.
const intakeToday = `
  function __intakeToday(data) {
    const width = Number(data.width) || 0
    if (!Number.isFinite(width) || width < 200 || width > 20000) return
    previewNatural = width
    const height = Number(data.previewHeight)
    previewNaturalHeight = Number.isFinite(height) && height >= 100 && height <= 20000 ? height : 0
    fitDesignPreview()
  }`

// --- заглушки DOM --------------------------------------------------------------
//
// Минимальные нарочно: кадр и сцена нужны ровно в том объёме, в котором их трогает
// окно (`style`, `parentElement`, `clientWidth`, `clientHeight`). Потянется
// реализация к чему-то ещё — проверка покраснеет с внятным «is not a function»,
// и это будет сигнал дописать заглушку, а не снять поведение.
const makeStage = (clientWidth, clientHeight) => {
  const custom = Object.create(null)
  return {
    clientWidth,
    clientHeight,
    style: {
      setProperty(name, value) { custom[name] = String(value) },
      removeProperty(name) { delete custom[name] },
      __custom: custom
    }
  }
}

const makeFrame = stage => ({
  style: {},
  parentElement: stage,
  hidden: false,
  attrs: new Map(),
  setAttribute(name, value) { this.attrs.set(name, String(value)) },
  removeAttribute(name) { this.attrs.delete(name) }
})

// `--preview-scale` окно пишет либо `setProperty`-ом, либо прямым присваиванием —
// читается здесь и то, и другое, чтобы проверка держала поведение, а не способ
// записи в стиль.
const customOf = (stage, name) => {
  const viaApi = stage.style.__custom && stage.style.__custom[name]
  return viaApi === undefined ? stage.style[name] : viaApi
}

// Что именно обязано быть снято в «влезает»-случае — перечислено контрактом;
// `boxSizing` сюда не входит: он не задаёт геометрию колонки, и требовать его
// очистки значило бы связывать проверку со способом записи, а не с поведением.
const GEOMETRY_KEYS = ['width', 'height', 'zoom', 'transform']

// Снимок — наоборот, полный: охрана доклада обязана не сдвинуть ни одно свойство
// стиля, в том числе то, которого здесь ещё нет. Иначе реализация сможет прятать
// заморозку в `max-width` или `flex-basis` и остаться незаметной.
const snapshotOf = (frame, stage) => ({
  style: { ...frame.style },
  custom: { ...(stage.style.__custom || {}) },
  overflow: stage.style.overflow
})

// «Снято» — это и пустая строка, и отсутствующее свойство: реализация вправе
// присвоить '' (как делает сегодняшний код) или удалить значение. Заморозкой
// считается любое непустое число — ровно оно и есть дефект.
const cleared = value => value === undefined || value === null || value === ''

const notCleared = frame => GEOMETRY_KEYS
  .filter(key => !cleared(frame.style[key]))
  .map(key => `${key}: ${JSON.stringify(frame.style[key])}`)

// Доклад кадра в том же составе полей, что шлёт `reportSize()`: `width`, `height`,
// `previewHeight`, `viewportWidth`, `viewportHeight`.
const sizeReport = data => ({
  type: 'onecode-design-size',
  previewHeight: 0,
  viewportHeight: 0,
  height: 0,
  ...data
})

// Сцена широкая (428 px — как в живом замере), страница в неё целиком помещается
// (270 из 270) и ничего не декларировала: `previewHeight` отсутствует, как у
// настоящей отзывчивой страницы.
const RESPONSIVE = sizeReport({ width: 270, viewportWidth: 270 })
// Задекларированный макет 1440 в колонке 660: тот случай, ради которого
// вписывание и заводилось.
const FIXED_WIDE = sizeReport({ width: 1440, viewportWidth: 660, previewHeight: 1000, viewportHeight: 900 })

// Как считает доступную ширину сегодняшний `fitDesignPreview`.
const roomOf = stage => stage.clientWidth - 36

function makePreviewRuntime (stage, { design, component } = {}) {
  const frame = makeFrame(stage)
  const empty = { setAttribute () {}, removeAttribute () {} }
  const label = { textContent: '' }
  const $ = id => (id === 'designPreviewFrame' ? frame
    : id === 'designPreviewEmpty' ? empty
      : id === 'designPreviewName' ? label : null)
  const runtime = new Function('$', 'setElementPicking', 't', 'initialDesign', 'initialComponent',
    `let activeDesign = initialDesign
     let designActiveComponent = initialComponent
     ${previewBlock}
     ${intakeToday}
     return {
       // Кадр достаётся тем же способом, каким его берёт окно, — через $ , чтобы
       // харнесс не заводил собственных ручных ссылок в обход реализованного пути.
       frame: $('designPreviewFrame'),
       render () { renderDesignPreview() },
       fit () { fitDesignPreview() },
       setTarget (design, component) { activeDesign = design; designActiveComponent = component },
       report (data) {
         if (typeof applyDesignPreviewSize === 'function') return applyDesignPreviewSize(data)
         return __intakeToday(data)
       }
     }`)(
    $, () => {}, value => value, design || { id: 'design-a' }, component || 'Landing.dc.html')
  return { frame, stage, runtime }
}

// --- «влезает» — независимой ширины нет ----------------------------------------

check('доклад «страница влезла в свою область» не назначает кадру ширину (замер 270 при сцене 428)', () => {
  const { frame, runtime } = makePreviewRuntime(makeStage(428, 600))
  runtime.report(RESPONSIVE)
  const frozen = notCleared(frame)
  assert.ok(!frozen.some(item => item.startsWith('width:')),
    `кадр заморожен по докладу, который описывает только колонку (${frozen.join(', ')}); ` +
    'при сцене 428 px превью стало на 158 px уже доступного места')
  assert.deepEqual(frozen, [],
    'в «влезает»-случае окно не задаёт кадру ни ширину, ни высоту, ни масштаб, ни смещение')
  // Число 270 не должно всплыть ни в одном свойстве кадра: его нельзя ни
  // «пересидеть» ресайзом, ни отменить масштабированием.
  assert.equal(Object.values(frame.style).some(value => String(value).includes('270')), false,
    'размер колонки остался в стилях кадра под другим именем')
})

check('доклад «не влезла, но и не вылезает»: ширина впритык к области тоже не независимая', () => {
  // Граница правила: `width <= viewportWidth + 1`. Страница, которой ровно хватило
  // своей области (660 из 660), независимой ширины не имеет — заморозить её значит
  // заставить её ползать по пол-пикселя на каждое движение разделителя.
  const { frame, runtime } = makePreviewRuntime(makeStage(696, 1400))
  runtime.report(sizeReport({ width: 660, viewportWidth: 660, previewHeight: 900 }))
  assert.ok(cleared(frame.style.width), `кадр заморожен в ${frame.style.width} при одинаковых 660 px`)
})

check('после «влезает»-доклада расширение сцены не оставляет замороженного числа', () => {
  // Это и есть вторая половина дефекта: ResizeObserver по сцене дёргает
  // вписывание, но сегодняшнее вписывание пересчитывает только масштаб по уже
  // назначенной ширине, и превью так и висит 270 px в сцене 900 px.
  const { frame, stage, runtime } = makePreviewRuntime(makeStage(428, 600))
  runtime.report(RESPONSIVE)
  stage.clientWidth = 900
  stage.clientHeight = 900
  runtime.fit()
  assert.ok(cleared(frame.style.width),
    `сцена выросла до 900 px, а кадр всё ещё ${frame.style.width} — пересидеть заморозку нечем`)
  assert.ok(cleared(frame.style.zoom), `масштаб при пустой сцене-заморозке не нужен: ${frame.style.zoom}`)
})

check('уже замороженный кадр обязан отпустить: «влезает»-доклад снимает прежние числа', () => {
  // Кадр мог получить явные размеры от предыдущей же заморозки (или от фиксированной
  // страницы, открытой до неё). Снять — значит записать пустые значения, а не
  // «оставить как есть»: иначе дефект переживает повторный доклад и починить его
  // можно только перезагрузкой окна.
  const { frame, runtime } = makePreviewRuntime(makeStage(428, 600))
  Object.assign(frame.style, { width: '270px', height: '564px', zoom: '0.63', transform: 'scale(0.63)' })
  runtime.report(RESPONSIVE)
  for (const key of ['width', 'height', 'zoom', 'transform']) {
    assert.ok(cleared(frame.style[key]), `${key} остался ${frame.style[key]} — заморозка не снята`)
  }
})

// --- «не влезает» — сегодняшняя логика остаётся как есть -----------------------

check('фиксированная ширина, не влезающая в сцену, получает 1440px и zoom = room / 1440', () => {
  const { frame, stage, runtime } = makePreviewRuntime(makeStage(696, 1400))
  runtime.report(FIXED_WIDE)
  const room = roomOf(stage)
  const scale = room / 1440
  assert.ok(room > 0 && scale < 1, `сам расчёт комнаты поехал: room = ${room}`)
  assert.equal(frame.style.width, '1440px')
  assert.ok(!cleared(frame.style.zoom), 'вписывание перестало масштабировать широкий макет')
  assert.equal(Number(frame.style.zoom), scale, `zoom ${frame.style.zoom}, ожидалось ${scale} (room ${room} / 1440)`)
  assert.equal(Number(customOf(stage, '--preview-scale')), scale,
    '`--preview-scale` на сцене разошёлся с масштабом кадра')
  assert.ok(Number.parseFloat(frame.style.height) > 0, `высота кадра в фиксированном случае потеряна: ${frame.style.height}`)
})

check('фиксированная ширина, которая в сцену входит, пишется без масштаба', () => {
  // Масштаб 1 в стиль писать нечего: сегодня так и есть, и это надо сохранить —
  // иначе на широком экране появляется дробный zoom, вокруг которого кадр
  // округляется до пикселя и плывёт.
  const { frame, stage, runtime } = makePreviewRuntime(makeStage(1200, 1000))
  runtime.report(sizeReport({ width: 900, viewportWidth: 400, previewHeight: 500 }))
  assert.ok(roomOf(stage) >= 900, 'сцена нарочно широкая')
  assert.equal(frame.style.width, '900px')
  assert.ok(cleared(frame.style.zoom), `zoom ${frame.style.zoom} при масштабе 1`)
  assert.equal(Number(customOf(stage, '--preview-scale')), 1)
})

check('доклад без viewportWidth остаётся в фиксированной ветке', () => {
  // Старый или неполный доклад: права считать страницу отзывчивой у него нет, и
  // поведение не должно тихонько измениться — иначе такое же молчание вернёт
  // заморозку обратно.
  const { frame, stage, runtime } = makePreviewRuntime(makeStage(696, 1400))
  runtime.report(sizeReport({ width: 1440 }))
  assert.equal(frame.style.width, '1440px')
  assert.ok(Number(frame.style.zoom) < 1, `широкий макет остался без вписывания: zoom ${frame.style.zoom}`)
})

// --- охрана доклада и состояние «доклада не было» ------------------------------

check('негодный доклад ничего не меняет: width < 200, > 20000, NaN и отсутствующее поле', () => {
  const { frame, stage, runtime } = makePreviewRuntime(makeStage(696, 1400))
  runtime.report(FIXED_WIDE)
  const before = snapshotOf(frame, stage)
  const bad = [
    sizeReport({ width: 100, viewportWidth: 100 }),
    sizeReport({ width: 30000, viewportWidth: 30000 }),
    sizeReport({ width: NaN, viewportWidth: 660 }),
    sizeReport({ width: 'ширина', viewportWidth: 660 }),
    { type: 'onecode-design-size', viewportWidth: 660 }
  ]
  for (const report of bad) {
    runtime.report(report)
    assert.deepEqual(snapshotOf(frame, stage), before,
      `доклад ${JSON.stringify(report)} сдвинул кадр или масштаб`)
  }
  runtime.fit()
  assert.deepEqual(snapshotOf(frame, stage), before, 'вписывание после негодного доклада дорисовало мусор')
  // И приём не должен заклинить: следующий годный доклад обязан примениться.
  runtime.report(sizeReport({ width: 1000, viewportWidth: 500, previewHeight: 700 }))
  assert.equal(frame.style.width, '1000px', `годный доклад не применился: ${JSON.stringify(snapshotOf(frame, stage))}`)
})

check('пока кадр ни о чём не доложил, у него нет ни ширины, ни высоты, ни масштаба', () => {
  // Базовое состояние, на котором держится отзывчивая ветка: до первого доклада
  // кадр живёт на CSS `width: 100%; height: 100%`.
  const { frame, runtime } = makePreviewRuntime(makeStage(696, 1400))
  runtime.render()
  assert.deepEqual(notCleared(frame), [],
    'до первого доклада кадр обязан жить на CSS 100% на 100%, а не на вчерашних числах')
})

// --- кэш раскладок -------------------------------------------------------------

check('повторное открытие отзывчивого компонента не возвращает замороженную ширину', () => {
  // Кэш раскладок обязан различать «заморожено по колонке» и «задекларировано»:
  // иначе переход «вкладка — другая вкладка — обратно» восстанавливает 270 px в
  // сцене 428 px, и дефект возвращается без единого нового доклада.
  const { frame, runtime } = makePreviewRuntime(makeStage(428, 600))
  runtime.report(RESPONSIVE)
  runtime.render()
  const frozen = notCleared(frame).filter(item => item.startsWith('width'))
  assert.deepEqual(frozen, [], `кэш вернул замороженную ширину: ${frozen.join(', ')}`)
})

check('отзывчивый доклад затирает прежнюю замороженную раскладку того же компонента', () => {
  // Колонку растянули: страница, которая минуту назад докладывала 1440 из 660 и
  // была честно вписана, теперь влезает в свою область (900 из 1200). Кэш помнит
  // вчерашнюю раскладку с явной шириной, и переоткрытие вкладки вернёт её обратно
  // без единого нового доклада — то есть дефект выживает «сам по себе».
  const { frame, stage, runtime } = makePreviewRuntime(makeStage(696, 1400))
  runtime.report(FIXED_WIDE)
  assert.equal(frame.style.width, '1440px', 'широкий макет не вписался')
  stage.clientWidth = 1236
  runtime.report(sizeReport({ width: 900, viewportWidth: 1200 }))
  assert.ok(cleared(frame.style.width), `страница влезла в 1200 px, а кадр остался ${frame.style.width}`)
  runtime.render()
  assert.ok(cleared(frame.style.width), `кэш вернул прежнюю заморозку: ${frame.style.width}`)
})

check('повторное открытие фиксированного компонента возвращает и ширину, и масштаб', () => {
  // Здесь кэш нужен ровно в нынешнем виде: без него при возврате на вкладку
  // макет на миг разворачивается на 100% и снова сжимается — прыгающий layout.
  const { frame, stage, runtime } = makePreviewRuntime(makeStage(696, 1400))
  const scale = roomOf(stage) / 1440
  runtime.report(FIXED_WIDE)
  runtime.setTarget({ id: 'design-b' }, 'Dashboard.dc.html')
  runtime.render()
  runtime.setTarget({ id: 'design-a' }, 'Landing.dc.html')
  runtime.render()
  assert.equal(frame.style.width, '1440px', 'кэш потерял ширину фиксированного макета')
  assert.equal(Number(frame.style.zoom), scale, `кэш потерял масштаб: ${frame.style.zoom} вместо ${scale}`)
})

// --- границы совместимости с соседним прогоном ----------------------------------

check('блок превью собирается в песочнице соседа и объявляет приём доклада в себе', () => {
  // Соседний `test-design-100-regressions.cjs` (проверка 22 — `test-design-preview-engine.cjs`)
  // исполняет вырезанный блок в `new Function`, где есть только `$`,
  // `setElementPicking`, `t`, `initialDesign`, `initialComponent`. Верхнеуровневое
  // обращение к `window` или `document` внутри блока убило бы их прогон, а
  // объявление приёма доклада вне блока — спрятало бы его от их харнесса.
  const sandbox = new Function('$', 'setElementPicking', 't', 'initialDesign', 'initialComponent',
    `${previewBlock}\nreturn { intake: typeof applyDesignPreviewSize, fit: typeof fitDesignPreview }`)
  const types = sandbox(() => null, () => {}, value => value, { id: 'design-a' }, 'Landing.dc.html')
  assert.equal(types.fit, 'function', 'fitDesignPreview выпала из блока превью')
  assert.equal(types.intake, 'function',
    'applyDesignPreviewSize не объявлена внутри блока между маркерами — сосед её не увидит')
})

check('отзывная ветка опирается на CSS кадра: .design-preview-frame остаётся 100% на 100%', () => {
  // Снятие явных размеров имеет смысл только потому, что кадр заполняет колонку
  // стилями. Уберут `width: 100%` — «влезает»-случай схлопнется в 0 px вместо
  // заморозки в 270, и проверка 1 станет зелёной по неправильной причине.
  const rule = /\.design-preview-frame\s*\{([^}]*)\}/.exec(cssSource)
  assert.ok(rule, 'правило `.design-preview-frame` не найдено в src/renderer/index.css')
  assert.match(rule[1], /width:\s*100%/, 'у кадра нет ширины 100% — пустой style.width схлопнет превью')
  assert.match(rule[1], /height:\s*100%/, 'у кадра нет высоты 100% — пустой style.height оставит его без роста')
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exit(failed ? 1 : 0)
