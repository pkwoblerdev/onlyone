// Сборщик замеров вида для audit-design.cjs: исполняется в окне приложения и возвращает JSON-сводку текущего экрана.
// Что меряется: какими шрифтами РЕАЛЬНО набран текст (семейство, число знаков, примеры), какие размеры шрифта в ходу,
// какие видимые элементы налезают друг на друга, где текст обрезан без многоточия, шире ли страница окна и где стоят панели.
window.__audit = function () {
  const FAMILY_OK = /^(instrument sans|fira code|newsreader|twemoji)$/i
  const visible = el => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  }
  const label = el => {
    const id = el.id ? '#' + el.id : ''
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    return (el.tagName.toLowerCase() + id + cls).slice(0, 70)
  }
  // «Виден» — значит в центре его прямоугольника сверху именно он (или его потомок/предок): элементы под непрозрачной шапкой,
  // за краем прокрутки или под соседним слоем не считаются, и наложениями их называть нельзя.
  const onTop = el => {
    const r = el.getBoundingClientRect()
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2))
    const top = document.elementFromPoint(x, y)
    return Boolean(top) && (top === el || el.contains(top) || top.contains(el))
  }
  const firstFamily = css => String(css || '').split(',')[0].replace(/["']/g, '').trim()

  // 1. Шрифты: по текстовым узлам, с весом числом знаков
  const families = new Map()
  const sizes = new Map()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const el = node.parentElement
    if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName) || !visible(el)) continue
    const s = getComputedStyle(el)
    const fam = firstFamily(s.fontFamily)
    const row = families.get(fam) || { chars: 0, samples: [] }
    row.chars += text.length
    if (row.samples.length < 3) row.samples.push(label(el) + ' «' + text.slice(0, 28) + '»')
    families.set(fam, row)
    const px = Math.round(parseFloat(s.fontSize) * 10) / 10
    const sz = sizes.get(px) || { chars: 0, samples: [] }
    sz.chars += text.length
    if (sz.samples.length < 2) sz.samples.push(label(el) + ' «' + text.slice(0, 20) + '»')
    sizes.set(px, sz)
  }
  const fontReport = [...families.entries()].map(([family, v]) => ({ family, chars: v.chars, samples: v.samples, expected: FAMILY_OK.test(family) }))
    .sort((a, b) => b.chars - a.chars)
  const sizeReport = [...sizes.entries()].map(([px, v]) => ({ px, chars: v.chars, samples: v.samples })).sort((a, b) => a.px - b.px)

  // 2. Налезающие друг на друга элементы: листья с текстом, кнопки, поля, значки
  const atoms = []
  const all = document.body.querySelectorAll('*')
  for (const el of all) {
    if (atoms.length > 900) break
    const tag = el.tagName
    if (['SCRIPT', 'STYLE', 'PATH', 'CIRCLE', 'RECT', 'LINE', 'POLYLINE', 'G', 'DEFS', 'USE'].includes(tag)) continue
    const direct = [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())
    const kind = direct || ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'SVG'].includes(tag.toUpperCase())
    if (!kind || !visible(el) || !onTop(el)) continue
    atoms.push({ el, r: el.getBoundingClientRect() })
  }
  const overlaps = []
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const a = atoms[i], b = atoms[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (w <= 2 || h <= 2) continue
      const inter = w * h
      const small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height)
      if (inter / small < 0.25) continue
      // слой «над»: тень и подложки поля ввода, подсказки — это не налезание
      if (a.el.closest('[role="tooltip"], .toast-box, .modal-backdrop') || b.el.closest('[role="tooltip"], .toast-box, .modal-backdrop')) continue
      overlaps.push({ a: label(a.el), b: label(b.el), pct: Math.round(100 * inter / small), area: Math.round(inter),
        at: [Math.round(Math.max(a.r.left, b.r.left)), Math.round(Math.max(a.r.top, b.r.top))] })
    }
  }
  overlaps.sort((x, y) => y.area - x.area)

  // 3. Текст, обрезанный без многоточия
  const clipped = []
  for (const el of all) {
    if (clipped.length >= 15) break
    if (!el.firstChild || !visible(el)) continue
    const s = getComputedStyle(el)
    if (s.overflowX === 'visible' || s.overflowX === 'auto' || s.overflowX === 'scroll') continue
    if (el.scrollWidth > el.clientWidth + 2 && s.textOverflow !== 'ellipsis' && el.textContent.trim().length > 3 && el.clientWidth > 0) {
      clipped.push({ el: label(el), text: el.textContent.trim().slice(0, 30), client: el.clientWidth, scroll: el.scrollWidth })
    }
  }

  // 3b. Заголовки: размер, вес, цвет и отступы — чтобы страницы разделов были набраны одинаково
  const headings = []
  for (const el of document.querySelectorAll('h1, h2, h3, [class*="page-title"], [class*="view-title"], .settings-group-title, .section-title')) {
    if (headings.length >= 16 || !visible(el) || !el.textContent.trim()) continue
    const s = getComputedStyle(el)
    headings.push({ el: label(el), text: el.textContent.trim().slice(0, 24), size: s.fontSize, weight: s.fontWeight, family: firstFamily(s.fontFamily),
      color: s.color, lineHeight: s.lineHeight, marginTop: s.marginTop, left: Math.round(el.getBoundingClientRect().left) })
  }

  // 4. Страница и панели
  const doc = document.documentElement
  const panels = {}
  for (const sel of ['#sidebar, .sidebar', '#chatFeed', '.composer-container', '#tasksPanel', '#artifactPanel', '#contextPanel', '.browser-panel', '#chatHeader']) {
    const el = document.querySelector(sel)
    if (el && visible(el)) { const r = el.getBoundingClientRect(); panels[sel] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
  }
  return {
    viewport: [innerWidth, innerHeight],
    pageOverflow: doc.scrollWidth > innerWidth + 2 ? doc.scrollWidth - innerWidth : 0,
    fonts: fontReport, sizes: sizeReport,
    overlaps: overlaps.slice(0, 12), overlapCount: overlaps.length,
    clipped, panels, headings,
    badFonts: fontReport.filter(f => !f.expected)
  }
}
