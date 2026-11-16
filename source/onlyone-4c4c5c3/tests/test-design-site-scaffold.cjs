// Сквозной тест генерации одностраничного и многостраничного сайта в OnlyOne Design.
//
// Одностраничный kind: 'site' создаёт цельную адаптивную веб-страницу с рабочими
// якорями навигации (#hero, #features, #pricing, #contact), без корпуса телефона
// (нет 390px, нет 844px, нет border-radius: 44px) и без фиксированного мобильного viewport.
// Корпус телефона зарезервирован строго для kind: 'app'.
const assert = require('node:assert/strict')
const { buildScaffold, scaffold, resolveTokens } = require('../src/main/design/scaffold')
const { executeDesignTool } = require('../src/main/design/tools')

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

const fakeStore = () => {
  const files = new Map()
  let entryFile = null
  return {
    files,
    write: async (_id, path, pieces) => {
      files.set(path, pieces)
      return { name: path }
    },
    setEntry: async (_id, name) => {
      entryFile = name
      files.set('__entry', name)
      return { name }
    },
    read: async (_id, path) => {
      const f = files.get(path)
      if (!f) throw new Error('File not found: ' + path)
      return { name: path, ...f }
    },
    getEntry: () => entryFile
  }
}

;(async () => {
  console.log('--- Suite A: Одностраничный сайт (kind: site, 1 страница) ---')

  const storeA = fakeStore()
  const siteA = await buildScaffold({
    store: storeA,
    designId: 'test-landing',
    kind: 'site',
    pages: [{
      name: 'Landing',
      title: 'Главная',
      headline: 'Продукт для команд нового поколения',
      purpose: 'Платформа для совместной работы в реальном времени с нулевыми задержками.'
    }],
    tokens: {
      accent: '#2563eb',
      bg: '#0f172a',
      ink: '#f8fafc',
      surface: '#1e293b',
      line: '#334155'
    }
  })

  check('каркас одностраничника собирается успешно', () => {
    assert.equal(siteA.success, true, siteA.error)
    assert.equal(siteA.kind, 'site')
    assert.equal(siteA.entry, 'Landing.dc.html')
    assert.equal(siteA.written.length, 1)
  })

  const landingHtml = storeA.files.get('Landing.dc.html').b_dc_html

  check('одностраничник НЕ содержит корпуса телефона и мобильного вьюпорта', () => {
    assert.ok(!landingHtml.includes('390px'), 'содержит 390px — корпус телефона недопустим для сайта')
    assert.ok(!landingHtml.includes('844px'), 'содержит 844px — корпус телефона недопустим для сайта')
    assert.ok(!landingHtml.includes('border-radius:44px') && !landingHtml.includes('border-radius: 44px'),
      'содержит скругление корпуса телефона 44px')
    assert.ok(!landingHtml.includes('AppTabs'), 'подключает таб-бар приложения')
  })

  check('одностраничник имеет адаптивный лэйаут и семантическую структуру', () => {
    assert.ok(landingHtml.includes('max-width:1120px') || landingHtml.includes('max-width: 1120px'),
      'должна быть адаптивная ширина полосы (max-width: 1120px)')
    assert.ok(landingHtml.includes('width:100%'), 'ширина должна быть 100%')
    assert.ok(landingHtml.includes('min-height:100vh') || landingHtml.includes('min-height: 100vh'),
      'высота контейнера должна занимать viewport')
    assert.ok(landingHtml.includes('<header'), 'должен быть семантический тег header')
    assert.ok(landingHtml.includes('<nav'), 'должен быть семантический тег nav')
    assert.ok(landingHtml.includes('<main'), 'должен быть семантический тег main')
    assert.ok(landingHtml.includes('id="hero"'), 'должна быть секция hero')
    assert.ok(landingHtml.includes('id="features"'), 'должна быть секция features')
    assert.ok(landingHtml.includes('id="pricing"'), 'должна быть секция pricing')
    assert.ok(landingHtml.includes('id="contact"'), 'должна быть секция contact')
    assert.ok(landingHtml.includes('<footer'), 'должен быть семантический тег footer')
  })

  check('якорные ссылки навигации работают корректно', () => {
    assert.ok(landingHtml.includes('href="#hero"'), 'должна быть ссылка на #hero')
    assert.ok(landingHtml.includes('href="#features"'), 'должна быть ссылка на #features')
    assert.ok(landingHtml.includes('href="#pricing"'), 'должна быть ссылка на #pricing')
    assert.ok(landingHtml.includes('href="#contact"'), 'должна быть ссылка на #contact')
    assert.ok(!landingHtml.includes('Landing.dc.html#'), 'якоря не должны дублировать имя текущего файла')
  })

  check('стили содержат плавную прокрутку, отступы под шапку и a11y', () => {
    assert.ok(landingHtml.includes('scroll-behavior: smooth') || landingHtml.includes('scroll-behavior:smooth'),
      'нужен плавный якорный скролл')
    assert.ok(landingHtml.includes('scroll-margin-top'),
      'нужен scroll-margin-top для компенсации липкой шапки')
    assert.ok(landingHtml.includes('position:sticky') || landingHtml.includes('position: sticky'),
      'шапка должна быть sticky')
    assert.ok(landingHtml.includes(':focus-visible'), 'должен быть стилизован :focus-visible')
    assert.ok(landingHtml.includes('prefers-reduced-motion'), 'должна быть поддержка prefers-reduced-motion')
    assert.ok(landingHtml.includes('skip-link'), 'должна быть ссылка быстрой навигации skip-link')
  })

  check('цвета и токены впечатаны в разметку', () => {
    assert.ok(landingHtml.includes('#0f172a'), 'фоновый цвет токена не впечатан')
    assert.ok(landingHtml.includes('#2563eb'), 'акцентный цвет токена не впечатан')
    assert.ok(landingHtml.includes('#f8fafc'), 'цвет текста ink не впечатан')
    assert.ok(landingHtml.includes('Продукт для команд нового поколения'), 'headline не передан в hero')
  })

  console.log('--- Suite B: Кастомные секции одностраничника ---')

  const storeB = fakeStore()
  const siteB = await buildScaffold({
    store: storeB,
    designId: 'custom-sections',
    kind: 'site',
    pages: [{
      name: 'Index',
      title: 'Сервис',
      headline: 'Интеллектуальная автоматизация процессов',
      sections: [
        { id: 'capabilities', title: 'Возможности', desc: 'Автоматический анализ и маршрутизация.' },
        { id: 'security', title: 'Безопасность', desc: 'Шифрование данных и локальный контур.' },
        { id: 'cta', title: 'Старт', desc: 'Попробуйте бесплатно за 2 минуты.' }
      ]
    }]
  })

  check('кастомные секции формируются в разметке и навигации', () => {
    assert.equal(siteB.success, true)
    const html = storeB.files.get('Index.dc.html').b_dc_html
    assert.ok(html.includes('id="capabilities"'), 'нет секции capabilities')
    assert.ok(html.includes('id="security"'), 'нет секции security')
    assert.ok(html.includes('id="cta"'), 'нет секции cta')
    assert.ok(html.includes('href="#capabilities"'), 'нет ссылки на #capabilities')
    assert.ok(html.includes('href="#security"'), 'нет ссылки на #security')
    assert.ok(html.includes('href="#cta"'), 'нет ссылки на #cta')
    assert.ok(html.includes('Шифрование данных'), 'нет описания секции')
  })

  console.log('--- Suite C: Обратная совместимость многостраничного сайта (kind: site, 2+ страниц) ---')

  const storeC = fakeStore()
  const siteC = await buildScaffold({
    store: storeC,
    designId: 'multi-site',
    kind: 'site',
    pages: [
      { name: 'Home', title: 'Главная', headline: 'Главная страница' },
      { name: 'Features', title: 'Возможности' },
      { name: 'Pricing', title: 'Тарифы' },
      { name: 'Contact', title: 'Контакты' }
    ]
  })

  check('многостраничный сайт генерирует все страницы, общую шапку и подвал', () => {
    assert.equal(siteC.success, true)
    assert.equal(siteC.written.length, 6) // SiteNav, SiteFooter + 4 pages
    assert.ok(storeC.files.has('SiteNav.dc.html'))
    assert.ok(storeC.files.has('SiteFooter.dc.html'))
    assert.ok(storeC.files.has('Home.dc.html'))
    assert.ok(storeC.files.has('Features.dc.html'))
    assert.ok(storeC.files.has('Pricing.dc.html'))
    assert.ok(storeC.files.has('Contact.dc.html'))
  })

  check('многостраничный сайт использует dc-import и ссылки на .dc.html', () => {
    const homeHtml = storeC.files.get('Home.dc.html').b_dc_html
    assert.ok(homeHtml.includes('dc-import name="SiteNav"'))
    assert.ok(homeHtml.includes('dc-import name="SiteFooter"'))
    const navHtml = storeC.files.get('SiteNav.dc.html').b_dc_html
    assert.ok(navHtml.includes('Features.dc.html'))
    assert.ok(navHtml.includes('Pricing.dc.html'))
    assert.ok(!homeHtml.includes('390px'))
  })

  console.log('--- Suite D: Обратная совместимость мобильного приложения (kind: app) ---')

  const storeD = fakeStore()
  const appD = await buildScaffold({
    store: storeD,
    designId: 'mobile-app',
    kind: 'app',
    pages: [
      { name: 'Feed', title: 'Лента' },
      { name: 'Explore', title: 'Обзор' },
      { name: 'Profile', title: 'Профиль' }
    ]
  })

  check('мобильное приложение сохраняет телефонный корпус 390x844 и AppTabs', () => {
    assert.equal(appD.success, true)
    assert.ok(storeD.files.has('AppTabs.dc.html'))
    assert.ok(storeD.files.has('Feed.dc.html'))
    const feedHtml = storeD.files.get('Feed.dc.html').b_dc_html
    assert.ok(feedHtml.includes('width:390px') || feedHtml.includes('width: 390px'))
    assert.ok(feedHtml.includes('844px'))
    assert.ok(feedHtml.includes('border-radius:44px') || feedHtml.includes('border-radius: 44px'))
    assert.ok(feedHtml.includes('dc-import name="AppTabs"'))
  })

  console.log('--- Suite E: Граничные случаи, валидация и интеграция с executeDesignTool ---')

  check('отклонение неверного kind', async () => {
    const res = await buildScaffold({ store: fakeStore(), kind: 'tablet', pages: [{ name: 'A' }] })
    assert.equal(res.success, false)
    assert.match(res.error, /kind может быть site или app/)
  })

  check('отклонение пустого списка страниц', async () => {
    const res = await buildScaffold({ store: fakeStore(), kind: 'site', pages: [] })
    assert.equal(res.success, false)
    assert.match(res.error, /хотя бы одну страницу/)
  })

  check('scaffold legacy отказ при ровно 1 странице без секций и заголовка', async () => {
    const res = await scaffold({ store: fakeStore(), kind: 'site', pages: [{ name: 'Only' }] })
    assert.equal(res.success, false)
    assert.match(res.error, /две страницы/)
  })

  check('executeDesignTool собирает одностраничный сайт через dc_scaffold с 1 страницей', async () => {
    const storeE = fakeStore()
    const res = await executeDesignTool({
      store: storeE,
      designId: 'tool-test',
      name: 'dc_scaffold',
      args: {
        kind: 'site',
        pages: [{ name: 'Main', title: 'Главная', headline: 'Инструмент для создания сайтов' }]
      }
    })
    assert.equal(res.success, true)
    assert.equal(res.written.length, 1)
    assert.ok(storeE.files.has('Main.dc.html'))
    const mainHtml = storeE.files.get('Main.dc.html').b_dc_html
    assert.ok(!mainHtml.includes('390px'))
    assert.ok(mainHtml.includes('id="hero"'))
    assert.ok(mainHtml.includes('href="#features"'))
  })

  console.log(`\nИтог: ${total - failed}/${total} проверок пройдено. Ошибок: ${failed}`)
  process.exit(failed ? 1 : 0)
})()
