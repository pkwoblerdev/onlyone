// The app measured against the Web Interface Guidelines, so that «интерфейс
// сделан хорошо» is a list of satisfied rules rather than an impression.
//
// Source: github.com/vercel-labs/web-interface-guidelines. Only the rules a file
// can actually prove are here — «error messages include a next step» is a real
// rule and not one a regular expression can judge.
const fs = require('fs')
const path = require('path')

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
// Стили живут в нескольких файлах, и правила действуют на все: новый файл не
// должен быть способом их обойти.
const css = ['src/renderer/index.css', 'src/renderer/ui-system.css', 'src/renderer/onboarding.css',
  'src/renderer/task-center.css', 'src/renderer/model-popover.css', 'src/renderer/remote-settings.css', 'src/renderer/approval-compact.css', 'src/renderer/paste-tiles.css', 'src/renderer/look.css', 'src/renderer/look-pages.css', 'src/renderer/fork-tree.css', 'src/renderer/review-sections.css'].map(read).join('\n')
const app = read('src/renderer/app.js')
const html = read('src/renderer/index.html')

let failed = 0
const problems = []
const check = (name, ok, detail) => {
  if (!ok) {
    failed++
    problems.push(detail ? `${name}: ${detail}` : name)
    console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`)
  }
}

// --- motion ------------------------------------------------------------------
check('движение подчиняется системной настройке', /@media\s*\(prefers-reduced-motion/.test(css))
check('нет transition: all', !/transition:\s*all\b/.test(css))

// Only properties that force the browser to lay the page out again matter here.
// Paint-only ones — colour, background, shadow — are cheap and are what a hover
// state is normally made of; listing them as violations trains you to skip the
// output.
const LAYOUT_PROPS = ['width', 'height', 'margin', 'padding', 'left', 'right',
  'inset', 'font-size', 'line-height', 'border-width']
const laidOut = new Set()
for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
  // cubic-bezier(...) carries commas of its own, so it goes before the split.
  const cleaned = m[1].replace(/cubic-bezier\([^)]*\)/g, 'ease')
  for (const part of cleaned.split(',')) {
    const prop = part.trim().split(/\s+/)[0]
    if (LAYOUT_PROPS.includes(prop)) laidOut.add(prop)
  }
}
// One documented exception: the sidebar collapse. Its whole purpose is to give
// the feed the space back, so the layout has to move — a transform would slide
// the panel out and leave a hole where it was. It is one element, on a
// deliberate click, and it is the only place width may be animated.
const sidebarOnly = [...laidOut].length === 1 && laidOut.has('width') &&
  /\.sidebar\s*\{[^}]*transition:\s*width/s.test(css)
check('не анимируются свойства, вызывающие пересчёт раскладки',
  laidOut.size === 0 || sidebarOnly, [...laidOut].join(', '))

// --- focus -------------------------------------------------------------------
const focusVisible = (css.match(/:focus-visible/g) || []).length
check('видимый фокус описан через :focus-visible', focusVisible >= 15,
  'правил ' + focusVisible)

// --- accessibility -----------------------------------------------------------
// A button whose whole content is a picture needs a name a screen reader can
// say. The question is asked of each button separately: the pattern this
// replaced looked for `</svg>` followed by `</button>`, which `[\s\S]*?` was
// free to find inside a *later* button — so one labelled button was reported as
// unlabelled purely because of what happened to follow it in the document, and
// the report moved every time the markup was reordered.
const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
const unlabelled = buttons.filter(([, attrs, inner]) => {
  // Visible text of its own is a label already.
  const text = inner.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, '').trim()
  const glyphOnly = text.length > 0 && /^[✕×✓⌄›‹—·]+$/.test(text)
  if (text && !glyphOnly) return false
  return !/aria-label=|title=/.test(attrs)
})
check('у каждой кнопки-иконки есть подпись для чтения с экрана',
  unlabelled.length === 0,
  unlabelled.map(m => (m[1].match(/id="([^"]+)"/) || [, '(без id)'])[1]).join(', '))

// --- every class in the markup is a class the stylesheet knows ----------------
// Styling a name nothing renders is the defect that has cost the most time in
// this project: a whole view was written against `.feed-scroll`, `.msg-list`,
// `.btn-ghost` and `.composer-wrap` — names taken from a design handoff, none of
// which exist here — and it looked merely «not quite right» rather than broken.
// Nothing errors, so only a check finds it.
//
// A handful of classes are hooks for script or state and carry no rule of their
// own; they are named here rather than guessed at.
const HOOK_CLASSES = new Set([
  'send-icon', 'stop-icon', 'icon', 'small', 'active', 'hidden', 'chevron'
])
const markupClasses = new Set()
for (const m of html.matchAll(/class="([^"]+)"/g)) {
  for (const name of m[1].split(/\s+/)) if (name) markupClasses.add(name)
}
const unstyled = [...markupClasses]
  .filter(name => !HOOK_CLASSES.has(name))
  .filter(name => !new RegExp('\\.' + name.replace(/[-]/g, '\\-') + '\\b').test(css))
  .sort()
check('каждый класс в разметке описан в стилях', unstyled.length === 0,
  unstyled.slice(0, 8).join(', '))

check('декоративные значки скрыты от чтения с экрана',
  (html.match(/aria-hidden="true"/g) || []).length >= 10)
check('обновляемые области помечены aria-live', /aria-live/.test(html))
check('есть ссылка к содержимому', /class="skip-link"/.test(html))
check('у полей ввода задан autocomplete',
  ![...html.matchAll(/<input\b([^>]*)>/g)]
    .some(m => !/autocomplete=/.test(m[1]) && !/type="(checkbox|radio|range|file)"/.test(m[1])))

// --- theme -------------------------------------------------------------------
check('на документе задан color-scheme', /color-scheme/.test(css) || /color-scheme/.test(html))
check('цвет системной рамки совпадает с фоном', /name="theme-color" content="#1c1917"/.test(html))

// --- typography --------------------------------------------------------------
// `...` in the sources is almost always the spread operator; only text a person
// reads counts. Strings and markup, not code.
// A string literal cannot span lines, and leaving line breaks out of the class
// is what keeps this from stitching two unrelated quotes together. Carriage
// return counts as a line break here: the sources are stored with CRLF, and
// excluding only the newline let a match cross a line through the spread
// operator and report prose that does not exist.
// A string literal cannot span lines, and leaving newlines out of the class is
// the difference between finding three dots in a sentence and stitching two
// unrelated quotes together across half a file.
const proseDots = [
  ...html.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/\.\.\./g),
  ...app.matchAll(/(['"])(?:(?!\1)[^\\\r\n]|\\.)*\.\.\.(?:(?!\1)[^\\\r\n]|\\.)*\1/g)
]
check('многоточие набрано одним знаком', proseDots.length === 0,
  proseDots.length + ' раз три точки')

const placeholders = [...html.matchAll(/placeholder="([^"]*)"/g)].map(m => m[1])
check('заполнители не обрываются тремя точками',
  !placeholders.some(p => p.trim().endsWith('...')))
check('у числовых значений моноширинные цифры',
  /font-variant-numeric:\s*tabular-nums/.test(css))
check('у заголовков сбалансированный перенос', /text-wrap:\s*balance/.test(css))

// --- interaction -------------------------------------------------------------
check('нажатие не ждёт двойного касания', /touch-action:\s*manipulation/.test(css))
check('прокрутка панели не утягивает страницу', /overscroll-behavior:\s*contain/.test(css))
check('наведение описано только для мыши', /@media\s*\(hover:\s*hover\)/.test(css))
check('гибкие потомки умеют обрезаться', /min-width:\s*0/.test(css))
check('длинные ленты не считают раскладку целиком', /content-visibility/.test(css))
// Строка шага без значка рисует точку: вне сетки строки она сдвигала колонки, и глагол вставал столбиком (24.10)
check('точка шага без значка — колонка сетки, а не вынесена из неё',
  /\.rail-line > \.rail-dot:not\(\.rail-ico\)\s*\{[^}]*position:\s*static/.test(css))

console.log(JSON.stringify({ ok: failed === 0, failed, problems }))
process.exit(failed ? 1 : 0)
