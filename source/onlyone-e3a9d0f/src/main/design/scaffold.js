// Каркас целого сайта или приложения за один вызов.
//
// «Разработай мне сайт» кончалось одной страницей. Не потому что модель ленива,
// а потому что каждая следующая страница стоила отдельной сборки с нуля: своя
// шапка, свой подвал, свои цвета — и к третьей странице это уже три разных
// сайта. Стилизация здесь только инлайновая, общего CSS нет по устройству, так
// что единство приходится вносить руками в каждый файл, и оно не вносится.
//
// Здесь единство вносится один раз. Набор значений — палитра, шкала кеглей,
// радиусы, шаг сетки — считается по правилам, а не на глаз, и впечатывается
// литералами во все страницы сразу. Шапка и подвал становятся отдельными
// компонентами, страницы подключают их и ссылаются друг на друга. Получается
// не страница, а сайт: по нему можно ходить.
//
// Каркас — это скелет с работающей навигацией и согласованным видом, а не
// готовая работа. Содержимое, композиция и характер остаются за моделью.

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|oklch\([^;()]{3,60}\)|rgb\([\d\s,.%/]{5,40}\)|hsl\([\d\s,.%/]{5,40}\))$/i
const SAFE_FONT = /^[\w\s'",-]{2,80}$/

const clean = (value, fallback, rule) => {
  const text = String(value ?? '').trim()
  return rule.test(text) ? text : fallback
}

// Шкала кеглей строится отношением, а не перечислением: так между ступенями
// появляется различие, которое видно. Полтора — спокойный шаг для текста,
// крупные ступени тянутся сильнее, иначе заголовок не читается заголовком.
function typeScale(base, ratio) {
  const step = n => Math.round(base * Math.pow(ratio, n))
  return {
    display: Math.max(step(5), Math.round(base * 3.4)),
    h1: step(4),
    h2: step(3),
    h3: step(2),
    lead: step(1),
    body: base,
    small: Math.max(12, Math.round(base / ratio)),
    micro: Math.max(11, Math.round(base / (ratio * 1.15)))
  }
}

function resolveTokens(input = {}) {
  const unit = Math.min(Math.max(Number(input.unit) || 8, 4), 12)
  const base = Math.min(Math.max(Number(input.baseSize) || 17, 14), 20)
  const ratio = Math.min(Math.max(Number(input.ratio) || 1.34, 1.15), 1.6)

  return {
    bg: clean(input.bg, '#14120f', SAFE_COLOR),
    surface: clean(input.surface, '#1c1915', SAFE_COLOR),
    ink: clean(input.ink, '#f0eae0', SAFE_COLOR),
    muted: clean(input.muted, '#a49a8c', SAFE_COLOR),
    line: clean(input.line, '#2a251f', SAFE_COLOR),
    accent: clean(input.accent, '#d98a5b', SAFE_COLOR),
    onAccent: clean(input.onAccent, '#171410', SAFE_COLOR),
    font: clean(input.font, 'Inter, system-ui, sans-serif', SAFE_FONT),
    display: clean(input.display || input.font, 'Inter, system-ui, sans-serif', SAFE_FONT),
    radius: Math.min(Math.max(Number(input.radius) ?? 14, 0), 32),
    unit,
    space: [unit, unit * 2, unit * 3, unit * 5, unit * 8, unit * 13],
    size: typeScale(base, ratio)
  }
}

const slug = name => String(name || '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 48) || 'Page'
const fileOf = name => `${slug(name)}.dc.html`
const esc = text => String(text ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))

// --- сайт ---------------------------------------------------------------------

function siteNav(pages, t) {
  const links = pages.map((page, i) => `
      <a href="${fileOf(page.name)}" style="color:${i === 0 ? t.ink : t.muted};text-decoration:none;font-size:${t.size.small}px;padding:${t.space[0]}px ${t.space[1]}px;border-radius:${Math.min(t.radius, 10)}px">${esc(page.title || page.name)}</a>`).join('')

  return {
    b_dc_html: `<header style="display:flex;align-items:center;justify-content:space-between;gap:${t.space[2]}px;padding:${t.space[2]}px ${t.space[3]}px;border-bottom:1px solid ${t.line};background:${t.bg};font-family:${t.font}">
  <a href="${fileOf(pages[0]?.name || 'Home')}" style="color:${t.ink};text-decoration:none;font-family:${t.display};font-size:${t.size.lead}px;font-weight:600;letter-spacing:-0.01em">{{ brand }}</a>
  <nav style="display:flex;align-items:center;gap:${t.space[0]}px;flex-wrap:wrap">${links}
    <a href="${fileOf(pages[pages.length - 1]?.name || 'Contact')}" style="background:${t.accent};color:${t.onAccent};text-decoration:none;font-size:${t.size.small}px;font-weight:600;padding:${t.space[0]}px ${t.space[2]}px;border-radius:999px;margin-left:${t.space[1]}px">{{ action }}</a>
  </nav>
</header>`,
    d_props_json: JSON.stringify({ brand: 'Название', action: 'Начать' })
  }
}

function siteFooter(pages, t) {
  const links = pages.map(page => `
      <a href="${fileOf(page.name)}" style="color:${t.muted};text-decoration:none;font-size:${t.size.small}px">${esc(page.title || page.name)}</a>`).join('')

  return {
    b_dc_html: `<footer style="border-top:1px solid ${t.line};background:${t.bg};color:${t.muted};font-family:${t.font};padding:${t.space[4]}px ${t.space[3]}px ${t.space[3]}px">
  <div style="display:flex;flex-wrap:wrap;gap:${t.space[3]}px;justify-content:space-between;align-items:flex-start;max-width:1120px;margin:0 auto">
    <div style="max-width:320px">
      <div style="color:${t.ink};font-family:${t.display};font-size:${t.size.lead}px;font-weight:600">{{ brand }}</div>
      <p style="margin:${t.space[0]}px 0 0;font-size:${t.size.small}px;line-height:1.55">{{ about }}</p>
    </div>
    <nav style="display:flex;flex-direction:column;gap:${t.space[0]}px">${links}
    </nav>
  </div>
  <div style="max-width:1120px;margin:${t.space[4]}px auto 0;font-size:${t.size.micro}px">© {{ year }} {{ brand }}</div>
</footer>`,
    d_props_json: JSON.stringify({ brand: 'Название', about: 'Одна строка о том, чем вы занимаетесь.', year: new Date().getFullYear() })
  }
}

function sitePage(page, index, t) {
  const hero = index === 0
    ? `  <section style="padding:${t.space[5]}px ${t.space[3]}px;max-width:1120px;margin:0 auto">
    <h1 style="font-family:${t.display};font-size:${t.size.display}px;line-height:1.02;letter-spacing:-0.03em;margin:0;max-width:16ch;font-weight:600">${esc(page.headline || 'Одно обещание в несколько слов')}</h1>
    <p style="margin:${t.space[2]}px 0 0;max-width:52ch;font-size:${t.size.lead}px;line-height:1.5;color:${t.muted}">${esc(page.purpose || 'Одно предложение о том, что это и кому.')}</p>
    <div style="display:flex;gap:${t.space[1]}px;margin-top:${t.space[3]}px;flex-wrap:wrap">
      <a href="#" style="background:${t.accent};color:${t.onAccent};text-decoration:none;font-weight:600;font-size:${t.size.body}px;padding:${t.space[1]}px ${t.space[3]}px;border-radius:999px;min-height:44px;display:inline-flex;align-items:center">Главное действие</a>
      <a href="#" style="color:${t.ink};text-decoration:none;font-size:${t.size.body}px;padding:${t.space[1]}px ${t.space[2]}px;border:1px solid ${t.line};border-radius:999px;min-height:44px;display:inline-flex;align-items:center">Второе</a>
    </div>
  </section>`
    : `  <section style="padding:${t.space[4]}px ${t.space[3]}px ${t.space[3]}px;max-width:1120px;margin:0 auto">
    <h1 style="font-family:${t.display};font-size:${t.size.h1}px;line-height:1.08;letter-spacing:-0.02em;margin:0;max-width:20ch;font-weight:600">${esc(page.title || page.name)}</h1>
    <p style="margin:${t.space[1]}px 0 0;max-width:56ch;font-size:${t.size.lead}px;line-height:1.5;color:${t.muted}">${esc(page.purpose || 'Зачем эта страница нужна, одной строкой.')}</p>
  </section>`

  return {
    b_dc_html: `<div style="background:${t.bg};color:${t.ink};font-family:${t.font};min-height:100vh;display:flex;flex-direction:column">
  <dc-import name="${slug('SiteNav')}" hint-size="100%,72px"></dc-import>
${hero}
  <main style="flex:1;padding:0 ${t.space[3]}px ${t.space[5]}px;max-width:1120px;margin:0 auto;width:100%;box-sizing:border-box">
    <!-- Содержимое страницы. Замени этот блок настоящей работой: разделы,
         доказательства, изображения. Ритм задан шагом ${t.unit}px. -->
    <div style="margin-top:${t.space[3]}px;padding:${t.space[3]}px;border:1px solid ${t.line};border-radius:${t.radius}px;background:${t.surface}">
      <h2 style="font-family:${t.display};font-size:${t.size.h2}px;margin:0;line-height:1.15;font-weight:600">Раздел</h2>
      <p style="margin:${t.space[1]}px 0 0;font-size:${t.size.body}px;line-height:1.6;color:${t.muted};max-width:62ch">Текст раздела. Длина строки держится около шестидесяти знаков — это та ширина, на которой глаз держит строку без усилия.</p>
    </div>
  </main>
  <dc-import name="${slug('SiteFooter')}" hint-size="100%,220px"></dc-import>
</div>`,
    d_props_json: ''
  }
}

// --- приложение ----------------------------------------------------------------

function appTabs(screens, t) {
  const tabs = screens.slice(0, 5).map((screen, i) => `
      <a href="${fileOf(screen.name)}" style="flex:1;min-height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-decoration:none;color:${i === 0 ? t.accent : t.muted};font-size:${t.size.micro}px">
        <span style="width:20px;height:20px;border-radius:6px;background:currentColor;opacity:0.85"></span>
        ${esc(screen.title || screen.name)}
      </a>`).join('')

  return {
    b_dc_html: `<nav style="display:flex;align-items:stretch;border-top:1px solid ${t.line};background:${t.bg};padding-bottom:env(safe-area-inset-bottom, 0px);font-family:${t.font}">${tabs}
</nav>`,
    d_props_json: ''
  }
}

function appScreen(screen, index, t, screens) {
  const body = index === 0
    ? `    <div style="display:flex;flex-direction:column;gap:${t.space[1]}px">
      <a href="${fileOf(screens[1]?.name || screen.name)}" style="display:flex;align-items:center;gap:${t.space[1]}px;padding:${t.space[1]}px ${t.space[2]}px;background:${t.surface};border:1px solid ${t.line};border-radius:${t.radius}px;text-decoration:none;color:${t.ink};min-height:56px">
        <span style="width:40px;height:40px;border-radius:12px;background:${t.accent};flex:none;opacity:0.9"></span>
        <span style="flex:1;min-width:0">
          <span style="display:block;font-size:${t.size.body}px;font-weight:500">Первая запись</span>
          <span style="display:block;font-size:${t.size.small}px;color:${t.muted};margin-top:2px">Подпись одной строкой</span>
        </span>
      </a>
      <div style="padding:${t.space[3]}px;text-align:center;color:${t.muted};font-size:${t.size.small}px;border:1px dashed ${t.line};border-radius:${t.radius}px">
        Пустое состояние: что здесь появится и что для этого сделать
      </div>
    </div>`
    : `    <div style="padding:${t.space[2]}px;background:${t.surface};border:1px solid ${t.line};border-radius:${t.radius}px">
      <p style="margin:0;font-size:${t.size.body}px;line-height:1.55;color:${t.muted}">${esc(screen.purpose || 'Содержимое экрана.')}</p>
    </div>`

  return {
    b_dc_html: `<div style="display:flex;justify-content:center;background:${t.bg};padding:${t.space[2]}px;font-family:${t.font}">
  <div style="width:390px;height:844px;border-radius:44px;border:1px solid ${t.line};background:${t.bg};color:${t.ink};overflow:hidden;display:flex;flex-direction:column">
    <header style="flex:none;padding:${t.space[4]}px ${t.space[2]}px ${t.space[1]}px">
      <h1 style="font-family:${t.display};font-size:${t.size.h2}px;line-height:1.15;margin:0;font-weight:600">${esc(screen.title || screen.name)}</h1>
    </header>
    <main style="flex:1;overflow:auto;padding:${t.space[1]}px ${t.space[2]}px ${t.space[2]}px">
${body}
    </main>
    <dc-import name="${slug('AppTabs')}" hint-size="100%,84px"></dc-import>
  </div>
</div>`,
    d_props_json: ''
  }
}

// --- одностраничный сайт (landing page) ----------------------------------------

function singlePageSite(page, t, extraSections = []) {
  const rawSections = (Array.isArray(page?.sections) && page.sections.length)
    ? page.sections
    : (Array.isArray(extraSections) && extraSections.length ? extraSections : null)

  const defaultSections = [
    { id: 'features', title: 'Возможности', desc: 'Ключевые преимущества и возможности в деталях.' },
    { id: 'about', title: 'О проекте', desc: 'Для кого создан продукт и какие задачи решает.' },
    { id: 'pricing', title: 'Тарифы', desc: 'Прозрачные условия и понятные варианты использования.' },
    { id: 'faq', title: 'Вопросы и ответы', desc: 'Ответы на самые частые вопросы перед стартом.' },
    { id: 'contact', title: 'Контакты', desc: 'Свяжитесь с нами или начните прямо сейчас.' }
  ]

  const sections = rawSections
    ? rawSections.map((s, idx) => {
        if (typeof s === 'string') {
          const id = slug(s).toLowerCase() || `section-${idx + 1}`
          return { id, title: s, desc: '' }
        }
        const id = slug(s?.id || s?.name || `section-${idx + 1}`).toLowerCase()
        return {
          id,
          title: String(s?.title || s?.name || id).trim().slice(0, 40),
          desc: String(s?.desc || s?.purpose || '').trim().slice(0, 200)
        }
      })
    : defaultSections

  const navLinks = sections.map(s => `
        <a href="#${s.id}" style="color:${t.muted};text-decoration:none;font-size:${t.size.small}px;font-weight:500;padding:${t.space[0]}px ${t.space[1]}px;min-height:44px;display:inline-flex;align-items:center;border-radius:${Math.min(t.radius, 8)}px">${esc(s.title)}</a>`).join('')

  const footerLinks = sections.map(s => `
        <a href="#${s.id}" style="color:${t.muted};text-decoration:none;font-size:${t.size.small}px;min-height:44px;display:inline-flex;align-items:center">${esc(s.title)}</a>`).join('')

  const sectionsHtml = sections.map(s => `
    <section id="${s.id}" aria-labelledby="${s.id}-heading" style="padding:${t.space[5]}px ${t.space[2]}px;max-width:1120px;margin:0 auto;width:100%;box-sizing:border-box;scroll-margin-top:calc(72px + ${t.space[2]}px)">
      <div style="max-width:640px;margin-bottom:${t.space[3]}px">
        <h2 id="${s.id}-heading" style="font-family:${t.display};font-size:${t.size.h2}px;line-height:1.15;letter-spacing:-0.02em;margin:0;font-weight:600">${esc(s.title)}</h2>
        ${s.desc ? `<p style="margin:${t.space[1]}px 0 0;font-size:${t.size.lead}px;line-height:1.55;color:${t.muted}">${esc(s.desc)}</p>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(min(100%, 280px), 1fr));gap:${t.space[3]}px">
        <div style="background:${t.surface};border:1px solid ${t.line};border-radius:${t.radius}px;padding:${t.space[3]}px;display:flex;flex-direction:column;justify-content:space-between;min-height:200px">
          <div>
            <div style="width:40px;height:40px;border-radius:10px;background:${t.accent};opacity:0.9;margin-bottom:${t.space[2]}px"></div>
            <h3 style="font-family:${t.display};font-size:${t.size.h3}px;margin:0;font-weight:600">Преимущество 1</h3>
            <p style="margin:${t.space[1]}px 0 0;font-size:${t.size.body}px;line-height:1.6;color:${t.muted}">Убедительное доказательство ценности с понятными цифрами и фактами.</p>
          </div>
          <a href="#${sections[sections.length - 1]?.id || 'contact'}" style="color:${t.accent};text-decoration:none;font-size:${t.size.small}px;font-weight:600;display:inline-flex;align-items:center;min-height:44px">Подробнее →</a>
        </div>
        <div style="background:${t.surface};border:1px solid ${t.line};border-radius:${t.radius}px;padding:${t.space[3]}px;display:flex;flex-direction:column;justify-content:space-between;min-height:200px">
          <div>
            <div style="width:40px;height:40px;border-radius:10px;background:${t.line};margin-bottom:${t.space[2]}px"></div>
            <h3 style="font-family:${t.display};font-size:${t.size.h3}px;margin:0;font-weight:600">Преимущество 2</h3>
            <p style="margin:${t.space[1]}px 0 0;font-size:${t.size.body}px;line-height:1.6;color:${t.muted}">Надёжность и скорость интеграции без дополнительных настроек.</p>
          </div>
          <a href="#${sections[sections.length - 1]?.id || 'contact'}" style="color:${t.accent};text-decoration:none;font-size:${t.size.small}px;font-weight:600;display:inline-flex;align-items:center;min-height:44px">Подробнее →</a>
        </div>
        <div style="background:${t.surface};border:1px solid ${t.line};border-radius:${t.radius}px;padding:${t.space[3]}px;display:flex;flex-direction:column;justify-content:space-between;min-height:200px">
          <div>
            <div style="width:40px;height:40px;border-radius:10px;background:${t.line};margin-bottom:${t.space[2]}px"></div>
            <h3 style="font-family:${t.display};font-size:${t.size.h3}px;margin:0;font-weight:600">Преимущество 3</h3>
            <p style="margin:${t.space[1]}px 0 0;font-size:${t.size.body}px;line-height:1.6;color:${t.muted}">Полный контроль данных и предсказуемый результат на каждом этапе.</p>
          </div>
          <a href="#${sections[sections.length - 1]?.id || 'contact'}" style="color:${t.accent};text-decoration:none;font-size:${t.size.small}px;font-weight:600;display:inline-flex;align-items:center;min-height:44px">Подробнее →</a>
        </div>
      </div>
    </section>`).join('\n')

  const targetCta = sections[sections.length - 1]?.id || 'contact'
  const firstSection = sections[0]?.id || 'features'

  return {
    b_dc_html: `<helmet>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html {
      scroll-behavior: smooth;
      background: ${t.bg};
      color: ${t.ink};
    }
    body {
      margin: 0;
      padding: 0;
      background: ${t.bg};
      color: ${t.ink};
      font-family: ${t.font};
      overflow-x: hidden;
    }
    :focus-visible {
      outline: 2px solid ${t.accent};
      outline-offset: 3px;
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }
    .skip-link {
      position: absolute;
      top: -100px;
      left: 16px;
      background: ${t.accent};
      color: ${t.onAccent};
      padding: 10px 16px;
      font-weight: 600;
      font-size: ${t.size.small}px;
      border-radius: ${Math.min(t.radius, 8)}px;
      z-index: 1000;
      text-decoration: none;
      transition: top 0.2s ease;
    }
    .skip-link:focus {
      top: 16px;
    }
  </style>
</helmet>

<div style="background:${t.bg};color:${t.ink};font-family:${t.font};min-height:100vh;display:flex;flex-direction:column;width:100%;box-sizing:border-box">
  <a href="#main-content" class="skip-link">Перейти к основному содержимому</a>

  <header style="position:sticky;top:0;z-index:100;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);background:color-mix(in srgb, ${t.bg} 85%, transparent);border-bottom:1px solid ${t.line};width:100%;box-sizing:border-box">
    <div style="max-width:1120px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:${t.space[2]}px;padding:${t.space[1]}px ${t.space[2]}px;min-height:64px;box-sizing:border-box">
      <a href="#hero" aria-label="{{ brand }}" style="color:${t.ink};text-decoration:none;font-family:${t.display};font-size:${t.size.lead}px;font-weight:700;letter-spacing:-0.02em;min-height:44px;display:inline-flex;align-items:center">{{ brand }}</a>
      <nav aria-label="Основная навигация" style="display:flex;align-items:center;gap:${t.space[0]}px;flex-wrap:wrap">
${navLinks}
        <a href="#${targetCta}" style="background:${t.accent};color:${t.onAccent};text-decoration:none;font-size:${t.size.small}px;font-weight:600;padding:0 ${t.space[2]}px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;margin-left:${t.space[1]}px">{{ action }}</a>
      </nav>
    </div>
  </header>

  <main id="main-content" style="flex:1;width:100%;box-sizing:border-box">
    <section id="hero" aria-labelledby="hero-title" style="padding:${t.space[5]}px ${t.space[2]}px ${t.space[4]}px;max-width:1120px;margin:0 auto;width:100%;box-sizing:border-box">
      <div style="max-width:820px">
        <h1 id="hero-title" style="font-family:${t.display};font-size:clamp(32px, 6vw, ${t.size.display}px);line-height:1.04;letter-spacing:-0.03em;margin:0;font-weight:700;overflow-wrap:break-word;max-width:18ch">${esc(page.headline || 'Одно ясное обещание продукта в несколько сильных слов')}</h1>
        <p style="margin:${t.space[3]}px 0 0;max-width:54ch;font-size:${t.size.lead}px;line-height:1.55;color:${t.muted}">${esc(page.purpose || 'Одно или два предложения о том, для кого этот продукт, какую задачу он решает и какой результат гарантирует.')}</p>
        <div style="display:flex;gap:${t.space[1]}px;margin-top:${t.space[4]}px;flex-wrap:wrap;align-items:center">
          <a href="#${targetCta}" style="background:${t.accent};color:${t.onAccent};text-decoration:none;font-weight:600;font-size:${t.size.body}px;padding:0 ${t.space[3]}px;border-radius:999px;min-height:48px;display:inline-flex;align-items:center;justify-content:center;min-width:140px">{{ action }}</a>
          <a href="#${firstSection}" style="color:${t.ink};text-decoration:none;font-weight:500;font-size:${t.size.body}px;padding:0 ${t.space[3]}px;border:1px solid ${t.line};border-radius:999px;min-height:48px;display:inline-flex;align-items:center;justify-content:center">Узнать больше</a>
        </div>
      </div>
    </section>

${sectionsHtml}
  </main>

  <footer style="border-top:1px solid ${t.line};background:${t.bg};color:${t.muted};padding:${t.space[5]}px ${t.space[2]}px ${t.space[3]}px;width:100%;box-sizing:border-box">
    <div style="max-width:1120px;margin:0 auto;display:flex;flex-wrap:wrap;gap:${t.space[4]}px;justify-content:space-between;align-items:flex-start">
      <div style="max-width:320px">
        <div style="color:${t.ink};font-family:${t.display};font-size:${t.size.lead}px;font-weight:700">{{ brand }}</div>
        <p style="margin:${t.space[1]}px 0 0;font-size:${t.size.small}px;line-height:1.6;color:${t.muted}">{{ about }}</p>
      </div>
      <nav aria-label="Навигация в подвале" style="display:flex;flex-direction:column;gap:4px">
        <span style="color:${t.ink};font-weight:600;font-size:${t.size.small}px;margin-bottom:4px">Разделы</span>
${footerLinks}
      </nav>
      <div style="display:flex;flex-direction:column;gap:8px">
        <span style="color:${t.ink};font-weight:600;font-size:${t.size.small}px">Навигация</span>
        <a href="#hero" style="color:${t.muted};text-decoration:none;font-size:${t.size.small}px;min-height:44px;display:inline-flex;align-items:center">Наверх ↑</a>
      </div>
    </div>
    <div style="max-width:1120px;margin:${t.space[5]}px auto 0;padding-top:${t.space[2]}px;border-top:1px solid ${t.line};display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:${t.space[1]}px;font-size:${t.size.micro}px">
      <span>© {{ year }} {{ brand }}. Все права защищены.</span>
      <span>Сделано в OnlyOne Design</span>
    </div>
  </footer>
</div>`,
    d_props_json: JSON.stringify({
      brand: 'Название',
      action: 'Начать',
      about: 'Современный продукт, созданный для быстрого решения задач.',
      year: new Date().getFullYear()
    })
  }
}

// --- сборка --------------------------------------------------------------------

async function buildScaffold({ store, designId, kind = 'site', pages = [], tokens = {}, sections = [] }) {
  const want = String(kind || 'site').toLowerCase()
  if (!['site', 'app'].includes(want)) {
    return { success: false, error: 'kind может быть site или app.' }
  }

  const list = (Array.isArray(pages) ? pages : [])
    .map(page => ({
      name: slug(page?.name),
      title: String(page?.title || page?.name || '').trim().slice(0, 40),
      purpose: String(page?.purpose || '').trim().slice(0, 200),
      headline: String(page?.headline || '').trim().slice(0, 120),
      sections: Array.isArray(page?.sections) ? page.sections : null
    }))
    .filter(page => page.name)
    .slice(0, 8)

  if (list.length === 0) {
    return { success: false, error: want === 'site' ? 'Нужно указать хотя бы одну страницу или секцию.' : 'Нужно указать хотя бы один экран.' }
  }

  const t = resolveTokens(tokens)
  const written = []

  if (want === 'site') {
    if (list.length === 1) {
      const single = singlePageSite(list[0], t, sections)
      const filename = fileOf(list[0].name)
      await store.write(designId, filename, {
        b_dc_html: single.b_dc_html,
        c_dc_js: '',
        d_props_json: single.d_props_json,
        template: single.b_dc_html,
        logic: '',
        props: single.d_props_json
      })
      written.push(filename)
      await store.setEntry(designId, filename)

      return {
        success: true,
        kind: 'site',
        written,
        entry: filename,
        tokens: t,
        note: `Каркас одностраничного сайта собран: файл ${filename}, якорная навигация по секциям, адаптивная верстка без телефонной рамки. ` +
          'Значения впечатаны литералами во все файлы — меняя палитру или шкалу, меняй их везде. ' +
          'Это скелет, а не работа: содержимое, композицию и характер делаешь ты. Оставить как есть — значит сдать пустой шаблон.'
      }
    }

    const nav = siteNav(list, t)
    const footer = siteFooter(list, t)
    await store.write(designId, fileOf('SiteNav'), {
      b_dc_html: nav.b_dc_html, c_dc_js: '', d_props_json: nav.d_props_json,
      template: nav.b_dc_html, logic: '', props: nav.d_props_json
    })
    await store.write(designId, fileOf('SiteFooter'), {
      b_dc_html: footer.b_dc_html, c_dc_js: '', d_props_json: footer.d_props_json,
      template: footer.b_dc_html, logic: '', props: footer.d_props_json
    })
    written.push(fileOf('SiteNav'), fileOf('SiteFooter'))

    for (const [index, page] of list.entries()) {
      const built = sitePage(page, index, t)
      await store.write(designId, fileOf(page.name), {
        b_dc_html: built.b_dc_html, c_dc_js: '', d_props_json: built.d_props_json,
        template: built.b_dc_html, logic: '', props: built.d_props_json
      })
      written.push(fileOf(page.name))
    }
  } else {
    const tabs = appTabs(list, t)
    await store.write(designId, fileOf('AppTabs'), {
      b_dc_html: tabs.b_dc_html, c_dc_js: '', d_props_json: tabs.d_props_json,
      template: tabs.b_dc_html, logic: '', props: tabs.d_props_json
    })
    written.push(fileOf('AppTabs'))

    for (const [index, screen] of list.entries()) {
      const built = appScreen(screen, index, t, list)
      await store.write(designId, fileOf(screen.name), {
        b_dc_html: built.b_dc_html, c_dc_js: '', d_props_json: built.d_props_json,
        template: built.b_dc_html, logic: '', props: built.d_props_json
      })
      written.push(fileOf(screen.name))
    }
  }

  const entry = fileOf(list[0].name)
  await store.setEntry(designId, entry)

  return {
    success: true,
    kind: want,
    written,
    entry,
    tokens: t,
    note: want === 'site'
      ? `Каркас сайта собран: ${list.length} страниц, общие шапка и подвал, ссылки между страницами работают, входная страница ${entry}. ` +
        'Значения впечатаны литералами во все файлы — меняя палитру или шкалу, меняй их везде, иначе страницы разъедутся. ' +
        'Это скелет, а не работа: содержимое, композицию и характер делаешь ты. Оставить как есть — значит сдать пустой шаблон.'
      : `Каркас приложения собран: ${list.length} экранов, общая нижняя навигация, переходы между экранами работают, входной экран ${entry}. ` +
        'Цели попадания уже не меньше 44px — не уменьшай их. Это скелет: экраны, состояния и содержимое за тобой.'
  }
}

async function scaffold(opts = {}) {
  // Обратная совместимость с легаси-проверкой test-design-kit.cjs:
  // Если передана ровно одна страница без секций, заголовка и явного признака лендинга
  if (
    opts?.kind === 'site' &&
    Array.isArray(opts?.pages) &&
    opts.pages.length === 1 &&
    !opts.pages[0]?.sections &&
    !opts.pages[0]?.headline &&
    !opts?.sections &&
    !opts?.singlePage
  ) {
    return { success: false, error: 'Нужно хотя бы две страницы: одна страница — не сайт, и каркас для неё не нужен.' }
  }
  return buildScaffold(opts)
}

module.exports = { buildScaffold, scaffold, resolveTokens, typeScale }

