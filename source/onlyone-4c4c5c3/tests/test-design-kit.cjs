// Новый инструментарий дизайна: замер, каркасы, разборы, оформление.
//
// Раньше у модели было тринадцать инструментов, которыми можно писать и читать
// компоненты, и один, которым можно узнать, не сломалось ли. Судить о работе
// было нечем: контракт ревью требует называть кегли и контрасты, а взять их
// неоткуда — и модель называла их по памяти о том, что сама написала.
//
// Здесь проверяется то, что появилось взамен, и главное свойство каждого:
// каркас не выдаёт себя за готовую работу, разбор говорит о структуре, а не о
// вкусе, оформление не подсовывает заглушку там, где можно построить.
const fs = require('node:fs')
const path = require('node:path')

const { designToolSchemas } = require('../src/main/design/tools')
const { starter, starterList, reference, referenceList } = require('../src/main/design/starters')
const { imagery, KINDS } = require('../src/main/design/imagery')
const { readingOf } = require('../src/main/design/measure')

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- инструменты подключены ---------------------------------------------------

const names = designToolSchemas().map(t => t.function.name)
for (const tool of ['dc_measure', 'dc_starter', 'dc_reference', 'dc_imagery']) {
  check('инструмент подключён: ' + tool, names.includes(tool))
}

// --- каркасы ------------------------------------------------------------------

check('каркасов несколько', starterList().length >= 4, String(starterList().length))
const slide = starter('slide')
check('сцена слайда отдаёт разметку и логику',
  slide.success && slide.b_dc_html.includes('1920px') && slide.c_dc_js.includes('componentDidMount'))
check('слайд вписывается в окно сам', /scale\(/.test(slide.c_dc_js))
check('каркас не выдаёт себя за готовую работу',
  /не готовая работа|Замени содержимое/.test(slide.note), slide.note)

const doc = starter('doc')
check('печатная страница держит читаемую полосу',
  doc.success && /max-width:780px/.test(doc.b_dc_html))
check('у каркаса есть, что проверить после сборки', Boolean(doc.check))
check('несуществующий каркас называет доступные',
  starter('нет такого').success === false && /slide/.test(starter('нет такого').error))

const phone = starter('phone')
check('экран телефона держит цели попадания', /min-height:44px/.test(phone.b_dc_html))

// --- разборы ------------------------------------------------------------------

check('разборов несколько', referenceList().length >= 5, String(referenceList().length))
const landing = reference('landing')
check('разбор говорит о структуре по разделам', landing.success && landing.structure.length >= 4)
check('разбор предлагает разные направления, а не одно',
  landing.variants.length >= 3, String(landing.variants?.length))
check('разбор называет главную беду этого вида работы',
  /непринятого решения|ломать ритм/.test(landing.watch), landing.watch)
check('направления различаются устройством, а не только цветом',
  landing.variants.some(v => /типографик|сетк|скриншот|воздух/i.test(v)))
check('несуществующий разбор называет доступные',
  reference('нет').success === false && /landing/.test(reference('нет').error))

// --- оформление ---------------------------------------------------------------

check('видов оформления несколько', KINDS.length >= 5)
const mesh = imagery({ kind: 'mesh', colors: ['#e08c62', '#6b8f71', '#15120e'] })
check('градиентное поле строится из переданных цветов',
  mesh.success && mesh.css.includes('#e08c62') && mesh.css.includes('#6b8f71'))
check('поле предупреждает про текст поверх', /контраст/.test(mesh.note))

const pattern = imagery({ kind: 'pattern', colors: ['#b08968', '#15120e'], seed: 2 })
check('мотив возвращается готовым фоном', pattern.success && pattern.css.startsWith('background-image:url('))
check('мотив не тянет ничего извне', !/https?:/.test(pattern.css))
check('семя меняет мотив',
  imagery({ kind: 'pattern', colors: ['#b08968'], seed: 0 }).css !==
  imagery({ kind: 'pattern', colors: ['#b08968'], seed: 3 }).css)

const grain = imagery({ kind: 'grain', colors: ['#15120e'] })
check('зерно строится фильтром, а не картинкой', /feTurbulence/.test(decodeURIComponent(grain.css)))

const hole = imagery({ kind: 'placeholder', colors: ['#6f665a', '#201c18'], label: 'фото продукта' })
check('заглушка остаётся для настоящей фотографии', hole.src.startsWith('data:image/svg+xml'))
check('в заглушке видно, чего не хватает', decodeURIComponent(hole.src).includes('фото продукта'))
check('заглушка объясняет, когда её брать не надо',
  /узор|текстур|недоделанность/.test(hole.note), hole.note)

// Цвет приходит от модели и попадает прямо в значение CSS: всё, что похоже на
// вылезание из значения, должно отбрасываться, а не подставляться.
const evil = imagery({ kind: 'mesh', colors: ['url(http://x/a.png);background:red', 'expression(1)', '#fff'] })
check('подозрительный цвет не попадает в CSS',
  !/url\(http|expression/.test(evil.css), evil.css.slice(0, 90))
check('вместо него берётся запасной', /#e08c62|#6b8f71/.test(evil.css))

const list = imagery({})
check('без вида возвращается список с пояснением', list.success && list.kinds.length === KINDS.length)

// --- прочтение замера ---------------------------------------------------------

const flat = readingOf([{ scale: [{ px: 20 }, { px: 18 }, { px: 16 }], rhythm: [], palette: [],
  lowContrast: [], smallTargets: [], lineLength: { median: 60 } }])
check('плоская иерархия названа вслух', /иерархия почти плоская/.test(flat), flat)

const bad = readingOf([{ scale: [{ px: 64 }, { px: 16 }], rhythm: [], palette: [],
  lowContrast: [{ ratio: 2.1, need: 4.5 }], smallTargets: [{ w: 20, h: 20 }],
  lineLength: { median: 120 } }])
check('слабый контраст назван числом', /худший 2\.1/.test(bad), bad)
check('мелкие цели посчитаны', /меньше 44px: 1/.test(bad))
check('слишком длинная строка названа', /120 знаков/.test(bad))

const fine = readingOf([{ scale: [{ px: 64 }, { px: 32 }, { px: 16 }], rhythm: [{ px: 8 }, { px: 16 }],
  palette: [], lowContrast: [], smallTargets: [], lineLength: { median: 66 } }])
check('когда придраться не к чему, так и сказано', /вкуса, а не измерения/.test(fine), fine)

// --- проверка ссылок ----------------------------------------------------------

const checkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'design', 'check.js'), 'utf8')
check('проверка собирает внутренние ссылки', /links: \[\.\.\.new Set/.test(checkSrc))
check('внешние адреса и якоря не считаются битыми',
  /!\/\^\(https\?:\|mailto:\|tel:\|data:\)\/i\.test\(h\)/.test(checkSrc))
check('битые ссылки роняют проверку', /&& !broken\.length/.test(checkSrc))

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
check('проверке передан список компонентов', /exists: href => known\.has\(href\)/.test(mainSrc))

// --- шрифты видит и проверка, и человек ---------------------------------------

check('проверка пускает шрифтовые хосты', /FONT_HOSTS/.test(checkSrc))
check('и больше ничего', /cancel: !own && !FONT_HOSTS\.test\(url\)/.test(checkSrc))

// --- каркас сайта и приложения -------------------------------------------------
//
// «Разработай сайт» кончалось одной страницей: каждая следующая стоила сборки с
// нуля, а общего CSS здесь нет по устройству — и к третьей странице получалось
// три разных сайта.
const { scaffold, resolveTokens, typeScale } = require('../src/main/design/scaffold')

const fakeStore = () => {
  const files = new Map()
  return {
    files,
    write: async (_id, path, pieces) => { files.set(path, pieces); return { name: path } },
    setEntry: async (_id, name) => { files.set('__entry', name); return { name } }
  }
}

;(async () => {
  const store = fakeStore()
  const site = await scaffold({ store, designId: 'd', kind: 'site', pages: [
    { name: 'Home', title: 'Главная', headline: 'Обещание' },
    { name: 'Catalog', title: 'Каталог' },
    { name: 'Contact', title: 'Контакты' }
  ], tokens: { accent: '#7a5c3e', bg: '#faf6ef', ink: '#1d1a16' } })

  check('каркас сайта собирается', site.success === true, site.error)
  check('страницы и общие части написаны', site.written.length === 5, String(site.written.length))
  check('входная страница выбрана', store.files.get('__entry') === 'Home.dc.html')

  const home = store.files.get('Home.dc.html').b_dc_html
  check('страница подключает общую шапку и подвал',
    home.includes('dc-import name="SiteNav"') && home.includes('dc-import name="SiteFooter"'))
  check('цвета впечатаны в страницу', home.includes('#faf6ef') && home.includes('#1d1a16'))

  const nav = store.files.get('SiteNav.dc.html').b_dc_html
  check('навигация ведёт на все страницы',
    ['Home', 'Catalog', 'Contact'].every(n => nav.includes(n + '.dc.html')))
  check('у главного действия есть акцент', nav.includes('#7a5c3e'))

  const one = await scaffold({ store, designId: 'd', kind: 'site', pages: [{ name: 'Only' }] })
  check('одна страница каркасом не считается',
    one.success === false && /две страницы/.test(one.error))

  const appStore = fakeStore()
  const app = await scaffold({ store: appStore, designId: 'd', kind: 'app', pages: [
    { name: 'Feed', title: 'Лента' }, { name: 'Search', title: 'Поиск' }, { name: 'Profile', title: 'Профиль' }
  ] })
  check('каркас приложения собирается', app.success === true, app.error)

  const feed = appStore.files.get('Feed.dc.html').b_dc_html
  check('экран подключает общую навигацию', feed.includes('dc-import name="AppTabs"'))
  check('экран держит размер телефона', feed.includes('390px') && feed.includes('844px'))

  const tabs = appStore.files.get('AppTabs.dc.html').b_dc_html
  check('цели попадания не меньше 44px', tabs.includes('min-height:44px'))
  check('вкладки ведут на экраны',
    ['Feed', 'Search', 'Profile'].every(n => tabs.includes(n + '.dc.html')))
  check('нижняя навигация учитывает безопасную зону', tabs.includes('safe-area-inset-bottom'))

  // Цвет и шрифт приходят от модели и попадают прямо в значение style.
  const evil = resolveTokens({ accent: 'red;position:fixed;inset:0', font: '"><script>x</script>' })
  check('подозрительный цвет в каркас не попадает', !/position:fixed/.test(evil.accent), evil.accent)
  check('подозрительный шрифт тоже', !/script/.test(evil.font), evil.font)

  const scale = typeScale(17, 1.34)
  check('шкала имеет размах', scale.display / scale.body >= 3, String(scale.display / scale.body))
  check('мелкий текст не проваливается ниже читаемого', scale.micro >= 11)

  const appRef = reference('app')
  check('есть разбор экранов приложения', appRef.success === true)
  check('в нём сказано про пустые состояния',
    appRef.structure.some(line => /Пустое состояние/.test(line)))
  check('есть разбор первого запуска', reference('onboarding').success === true)

  check('каркас подключён как инструмент', names.includes('dc_scaffold'))

  // Самый большой изъян был не в инструментах, а в том, что весь их набор
  // состоял из косвенных свидетельств: модель ни разу не видела того, что сделала.
  check('снимок подключён', names.includes('dc_screenshot'))
  const shotSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'design', 'shot.js'), 'utf8')
  check('снимок снимается с живого рендера', /capturePage\(\)/.test(shotSrc))
  check('снимок берёт всю высоту страницы', /scrollHeight/.test(shotSrc))
  check('снимок уменьшается перед отправкой', /resize\(\{ width: 900 \}\)/.test(shotSrc))
  check('снимок видит шрифты, но не сеть целиком',
    /FONT_HOSTS/.test(shotSrc) && /cancel: !own && !FONT_HOSTS\.test\(url\)/.test(shotSrc))

  // Макет шире колонки вписывается уменьшением, а не полосой прокрутки.
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')
  check('окно вписывает макет в колонку', /function fitDesignPreview\(\)/.test(uiSrc))
  check('масштаб только вниз и учитывает обе стороны viewport', /Math\.min\(1, room \/ width, height \? roomHeight \/ height : 1\)/.test(uiSrc))
  const designHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
  check('лишняя панель viewport и процент масштаба удалены',
    !designHtml.includes('designPreviewViewport') && !designHtml.includes('designPreviewZoom') &&
    !uiSrc.includes('data-design-viewport'))
  check('в превью есть выбор элемента и отдельное удаление',
    /id="designSelectElementBtn"/.test(designHtml) && /id="designRemoveElementBtn"[^>]*disabled/.test(designHtml) &&
    /onecode-design-element-selected/.test(uiSrc) && /async function removeSelectedDesignElement\(\)/.test(uiSrc))
  check('кадр сам сообщает свою ширину', /onecode-design-size/.test(uiSrc))
  check('сайдбар сворачивается до иконок', /sidebar-narrow/.test(uiSrc))
  check('состояние сайдбара переживает перезапуск', /SIDEBAR_KEY/.test(uiSrc))
  check('выгрузка подключена', names.includes('dc_export'))

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
})()
