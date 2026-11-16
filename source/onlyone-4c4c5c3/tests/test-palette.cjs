// The look, held in place mechanically.
//
// A redesign is not a state, it is a direction, and it decays one edit at a
// time: someone needs a red for an error and writes `#f87171`, someone needs a
// panel and writes `#1a1a1a`, and six months later the app is back to being
// blue-black with a rainbow of accents. None of those edits looks wrong on its
// own, which is exactly why a person cannot police it.
//
// So the rules are written down: one warm neutral ladder, one accent, ivory
// instead of white, no gradients on controls, and colour that comes from tokens
// rather than from whatever hex was to hand.
const fs = require('fs')
const path = require('path')

// Tokens live in their own file now, so «the stylesheet» is the two of them
// concatenated in load order — that is what the browser resolves against.
const read = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', name), 'utf8')
const tokens = read('tokens.css')
const css = [tokens, read('index.css')].join('\n')
// Код окна теперь разложен по модулям (план, 2d) — проверяем весь исполняемый текст.
const app = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

let failed = 0
const problems = []
const check = (name, ok, detail) => {
  if (!ok) {
    failed++
    problems.push(detail ? `${name}: ${detail}` : name)
    console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`)
  }
}

// The highlight theme is one minified line of its own palette, and holding it to
// the app's token rules would mean tokenising a vendor stylesheet. It is checked
// separately, by eye, and excluded here.
const hljsLine = css.slice(css.indexOf('.hljs{color:'), css.indexOf('\n', css.indexOf('.hljs{color:')))
const body = css.replace(hljsLine, '')
// Declarations only: a comment explaining why a colour changed names the colour
// it replaced, and that is not a use.
const code = body.replace(/\/\*[\s\S]*?\*\//g, '')

// --- the cool greys are gone -------------------------------------------------
// Slate on warm charcoal is what made the app read as two different products
// stacked on top of each other.
const slate = ['#f8fafc', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#a3adbb',
  '#0f172a', '#1e293b', '#334155', '#475569']
// A banned colour written as rgb() is the same colour. `rgba(148, 163, 184, .42)`
// sat in the composer for three releases because this list held hexes and the
// declaration held channels.
const channels = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  return new RegExp(String.raw`rgba?\(\s*${r}\s*,\s*${g}\s*,\s*${b}\s*[,)]`)
}
for (const hex of slate) {
  const asRgb = code.split('\n').filter(l => channels(hex).test(l))
  check(`холодный серый ${hex} не используется и в rgb()`, asRgb.length === 0,
    asRgb.slice(0, 2).map(l => l.trim().slice(0, 60)).join(' | '))
}
for (const hex of slate) {
  // Comments record why a value changed and name the old one, so they are cut
  // out rather than filtered around: a rule written on one line puts the
  // declaration after the selector, and matching on how a line begins missed it.
  const live = code.split('\n').filter(l => l.includes(hex))
  check(`холодный серый ${hex} не используется`, live.length === 0,
    live.slice(0, 2).map(l => l.trim().slice(0, 60)).join(' | '))
}

// --- white is not a text colour ----------------------------------------------
// Pure white on this ground glares. Ivory is the top of the scale; white is left
// for the two places it belongs — text on the accent, and the close button.
const whiteRules = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(m => /color:\s*#(fff|ffffff)\b/i.test(m[2]))
  .map(m => m[1].trim().replace(/\s+/g, ' '))
// White belongs on the accent and on the close button's red. Nowhere else — and
// the exception lives in the selector, on a different line from the declaration,
// so reading line by line reported the one place white is correct.
const whiteText = whiteRules.filter(sel => !/win-close|:root/.test(sel))
check('белый не используется как цвет текста', whiteText.length === 0,
  whiteText.slice(0, 3).map(l => l.trim().slice(0, 60)).join(' | '))

// --- one accent, and it is the clay one --------------------------------------
check('старый акцент убран', !body.includes('#e27d60') && !body.includes('rgba(226, 125, 96'),
  'terracotta из прежней палитры')
// The clay before this one. It survived as 28 hardcoded literals after the token
// moved to #E08C62 — near enough to look like a mistake rather than a second
// colour, which is exactly why nobody spots it by eye.
const priorClay = code.split('\n').filter(l => /#d97757|217, ?119, ?87/.test(l))
check('предыдущий акцент не остался в литералах', priorClay.length === 0,
  priorClay.slice(0, 2).map(l => l.trim().slice(0, 60)).join(' | '))

// The surfaces before the handoff. Same trap: a panel left on #212120 sits a
// shade off the ladder and reads as grime, not as a level.
const priorGround = ['#1a1a19', '#161615', '#212120', '#242423', '#2b2b29', '#272726', '#1e1e1c']
const staleGround = priorGround.filter(hex => code.includes(hex))
check('поверхности прежней лестницы не остались', staleGround.length === 0,
  staleGround.join(', '))
// Moved from #d97757 to #E08C62 by the Claude Design handoff. Same clay, a shade
// lighter, and it is now the value the whole design is drawn against.
// Акцент стал выбираемым: значение по умолчанию живёт в --accent-base, а сам
// --accent собирается из него и выбора человека. Производные оттенки считаются
// от --accent, поэтому смена цвета тянет за собой подложки и рамки.
// С переноса макета (19.10.2026) акцент — искра #ff8a50 (тёмная) и #b83c0a
// (светлая), выбор владельца из трёх кандидатов. Выбирать его в настройках
// больше нельзя (решение 19.10): --accent-user ни на что не влияет.
check('акцент объявлен токеном',
  /--accent:\s*#ff8a50/i.test(tokens) && /--accent:\s*#b83c0a/i.test(tokens) &&
  !/--accent-user/.test(tokens) &&
  /--accent-primary:\s*var\(--accent\)/.test(tokens))
check('оттенки акцента следуют за выбранным цветом',
  /--accent-08:\s*color-mix\(in srgb, var\(--accent\)/.test(tokens) &&
  /--focus:\s*color-mix\(in srgb, var\(--accent\)/.test(tokens) &&
  /--accent-focus:\s*var\(--focus\)/.test(tokens))
check('акцент без градиента',
  !/--accent-gradient:\s*linear-gradient\(135deg/.test(css),
  'градиент под углом — след прежнего оформления')

// A control that fades from one white to another is the shape of a template.
const controlGradients = body.split('\n')
  .filter(l => /background:\s*linear-gradient/.test(l))
  .filter(l => /rgba\(255/.test(l))
check('на контролах нет белых градиентов', controlGradients.length === 0,
  controlGradients.slice(0, 2).map(l => l.trim().slice(0, 70)).join(' | '))

// --- one overlay tint, and it matches the ground -----------------------------
// The surfaces are near-neutral now, so a neutral white is the tint that leaves
// them alone. The warm white this rule used to require was correct while the
// ground was warm; kept alongside neutral surfaces it tints them back towards
// brown, which is the thing that was removed.
//
// What matters either way is that there is exactly one: two tints mean two
// materials, and a hover state stops looking like the same surface lit.
const warmTint = (code.match(/rgba\(255, 250, 240,/g) || []).length
const neutralTint = (code.match(/rgba\(255, 255, 255,/g) || []).length
check('подложка одного тона, а не двух', warmTint === 0 || neutralTint === 0,
  `тёплых ${warmTint}, нейтральных ${neutralTint}`)
check('подложка не синит', !/rgba\(2[0-4][0-9], 2[0-4][0-9], 25[0-5],/.test(code),
  'холодная альфа с синим уклоном')

// --- ни одного холодного цвета мимо палитры ----------------------------------
// Список запрещённых серых ловил ровно те девять значений, которые кто-то
// однажды выписал. Мимо него спокойно прошли #4b5563, #a1a1aa, #7d8694,
// #8b95a3, #121215 и #1b1b1f — включая цвет целого блока размышлений и фон
// выпадающего списка. Правило сформулировано по существу: холодным считается
// цвет, у которого синего больше и красного, и зелёного, и запрещён он тогда,
// когда его нет среди значений токенов.
const tokenColours = new Set(
  [...tokens.matchAll(/#([0-9a-fA-F]{6})\b/g)].map(m => m[1].toLowerCase())
)
const isCold = hex => {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16))
  return b > r && b > g
}
const strayCold = [...new Set([...code.matchAll(/#([0-9a-fA-F]{6})\b/g)].map(m => m[1].toLowerCase()))]
  .filter(hex => isCold(hex) && !tokenColours.has(hex))
check('нет холодных цветов мимо палитры', strayCold.length === 0,
  strayCold.map(h => '#' + h).join(', '))

// --- the ground has one cast, and it does not drift --------------------------
// Channel spread is what the eye reads as a colour cast.
//
// This threshold was 3, set in 0.58.0 after the warm redesign came out brown and
// the owner said so. The Claude Design handoff draws every surface warmer than
// that — 4 to 7 — and the user bubble warmer still, so holding the old number
// would have meant shipping a different design from the one that was approved.
//
// The number moved; the rule did not. What it catches is drift: a surface added
// later by eye, warmer than anything the handoff drew. If the room reads brown
// again, lower MAX_SPREAD and the ladder gets pulled back with it.
// 19.10.2026 владелец выбрал тёплый графит макета (#1c1917 и его лестница):
// разброс у поверхностей до 10, у выбранной строки светлой темы — 12.
const MAX_SPREAD = 12
const BUBBLE_SPREAD = 11   // --bg-user-bubble, the one deliberately warm surface
// Hover tints are not rungs on the ladder: they exist for the fraction of a
// second the pointer is over a row, and the handoff draws them a touch warmer
// than the surface underneath so the row lifts rather than just lightens. Both
// values are the handoff's own — they were literals inside rules until the
// tokens were extracted, which is why the ladder check never saw them before.
const TINT_SPREAD = 10
const tints = ['--bg-hover', '--bg-popover-row']
const surfaceSpread = []
// Тёмная тема — эталон из хендоффа, у неё правило по абсолютному разбросу.
const darkTokens = code.split(':root[data-theme="light"]')[0]
for (const m of darkTokens.matchAll(/(--bg-[a-z-]+):\s*#([0-9a-f]{6})/g)) {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[2].slice(i, i + 2), 16))
  const spread = Math.max(r, g, b) - Math.min(r, g, b)
  const cap = m[1] === '--bg-user-bubble' ? BUBBLE_SPREAD
    : tints.includes(m[1]) ? TINT_SPREAD
    : MAX_SPREAD
  if (spread > cap) surfaceSpread.push(`${m[1]} #${m[2]} (разброс ${spread})`)
}

// Светлая тема живёт по тому же правилу: бумага тёплая, но не кремовая.
// Мерка одна на обе темы — разброс каналов; иначе «тёплый фон» пролезал бы в
// светлую тему под видом того, что на белом он якобы незаметен.
const lightTokens = code.split(':root[data-theme="light"]')[1] || ''
for (const m of lightTokens.matchAll(/(--bg-[a-z-]+):\s*#([0-9a-f]{6})/g)) {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[2].slice(i, i + 2), 16))
  const spread = Math.max(r, g, b) - Math.min(r, g, b)
  const cap = tints.includes(m[1]) ? TINT_SPREAD : MAX_SPREAD
  if (spread > cap) surfaceSpread.push(`${m[1]} #${m[2]} (разброс ${spread})`)
}
check('ни одна поверхность не теплее рисованных', surfaceSpread.length === 0,
  surfaceSpread.join(', '))

// The ladder still has to be a ladder: every surface warm in the same direction,
// never one warm and the next cool. A cool surface among warm ones is the two
// stacked products the whole repaint removed.
const cool = []
for (const m of code.matchAll(/(--bg-[a-z-]+):\s*#([0-9a-f]{6})/g)) {
  const [r, , b] = [0, 2, 4].map(i => parseInt(m[2].slice(i, i + 2), 16))
  if (b > r) cool.push(`${m[1]} #${m[2]}`)
}
check('поверхности тёплые, ни одной холодной', cool.length === 0, cool.join(', '))

// --- the display face is used, and only where it belongs ---------------------
// Georgia was the display face while type had to come from the system. The
// handoff bundles its own, so the token now points at Literata — and Literata
// rather than the handoff's Newsreader because Newsreader has no Cyrillic and
// every heading in this app is Russian.
// Один шрифт везде (слово владельца 18.10): заголовки, код и пути набраны тем же
// стеком, что интерфейс. Прежние имена гарнитур остались псевдонимами.
for (const name of ['--font-display', '--font-mono', '--font-prose'])
  check(name + ' ведёт на интерфейсный стек', new RegExp(name + ':\\s*var\\(--font-ui\\)').test(tokens))
check('серифный токен ведёт на заголовочный', /--font-serif:\s*var\(--font-display\)/.test(css))

// The sidebar's type is the one thing the handoff rules out changing — the owner
// said outright that he likes it. Instrument Sans heads the stack because that is
// what the handoff names; carrying no Cyrillic, it hands Russian to the system
// face, which is what was there before. Either way the rule is the same: no
// bundled family may take over the chrome.
check('интерфейсная гарнитура — системная, как была',
  /--font-ui:\s*"Instrument Sans", "Segoe UI"/.test(css))
check('в хром не подставлена своя гарнитура',
  !/--font-ui:[^;]*(Golos|Onest|Literata)/.test(css))

// Bundled, not fetched: the app runs offline and its own policy forbids the
// network. A @font-face pointing at a CDN would fail silently and fall back to
// the system face, which is the look this redesign exists to remove.
const fonts = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'fonts.css'), 'utf8')
check('шрифты лежат локально', !/https?:/.test(fonts), 'в fonts.css есть внешний адрес')
check('каждый шрифт объявлен с диапазоном',
  (fonts.match(/@font-face/g) || []).length === (fonts.match(/unicode-range:/g) || []).length,
  'без unicode-range кириллица выпадет из семейства')

// Prose and code carry Russian and have to contain it. Newsreader is exempt by
// design: it is Latin-only, and its stack hands Cyrillic to Georgia — the
// handoff's own fallback, and what this app used for headings before.
for (const family of ['onest', 'fira-code']) {
  check(`${family} везёт кириллицу`,
    fonts.includes(`${family}-cyrillic-`), 'нет кириллического начертания')
}
check('в токенах нет отдельных гарнитур для кода и заголовков',
  !/Newsreader|Fira Code|Consolas|Georgia/.test(tokens.replace(/\/\*[\s\S]*?\*\//g, '')))

// A @font-face pointing at a file that is not there fails without a word: the
// text renders in the fallback and looks merely a bit off. Cheapest possible
// check, and the only one that catches a rename.
const fontDir = path.join(__dirname, '..', 'src', 'renderer', 'fonts')
const missing = [...fonts.matchAll(/url\('fonts\/([^']+)'\)/g)]
  .map(m => m[1])
  .filter(file => !fs.existsSync(path.join(fontDir, file)))
check('каждый объявленный файл шрифта лежит на диске', missing.length === 0,
  missing.slice(0, 4).join(', '))

// Roles, not decoration — но ролей теперь две, не три: план 1.14 часть 5 и
// решение владельца от 27.09 («один шрифт на всё», строка «Шрифты сообщений не
// менять» внесена в «Опровергнуто и отменено») оставили два начертания —
// интерфейсный текст и моноширинный для кода. Прежняя проверка требовала,
// чтобы ответ набирался читаемой гарнитурой (Onest), и на новом правиле она
// краснеет как раз тогда, когда правка сделана верно. Проверяется то же самое
// по силе: ответ набором не отличается от панели.
const proseRules = [...body.matchAll(/\.msg-content \{([^}]*)\}/g)].map(m => m[1])
check('текст ответа набран тем же шрифтом, что и панель',
  proseRules.some(r => /--font-ui/.test(r)) && !proseRules.some(r => /--font-prose|--font-serif|--font-display/.test(r)),
  `правил ${proseRules.length}`)

// --- the column ---------------------------------------------------------------
// The one measure of width on the screen, and the single change the handoff
// called «70% of the visual difference». At 800px the line is about 65
// characters; on a 1920px window the answer used to run nearly the full sash.
const feedRule = body.slice(body.indexOf('.feed-container {'),
  body.indexOf('}', body.indexOf('.feed-container {')))
check('колонка чата шириной 800', /max-width:\s*800px/.test(feedRule), feedRule.replace(/\s+/g, ' ').slice(0, 70))
const composerRule = body.slice(body.indexOf('.composer-col {'),
  body.indexOf('}', body.indexOf('.composer-col {')))
check('композер той же ширины, что и лента',
  /max-width:\s*800px/.test(composerRule), composerRule.replace(/\s+/g, ' ').slice(0, 70))

// --- colour belongs to its job -----------------------------------------------
// The accent is for UI — buttons, pills, active states. Inline code is lavender.
// Clay on a token in a sentence made every `vless` look like a link to click.
const inlineRule = body.slice(body.indexOf('.msg-content code:not(.hljs) {'),
  body.indexOf('}', body.indexOf('.msg-content code:not(.hljs) {')))
check('инлайн-код лавандовый, а не акцентный',
  /--color-purple|184, 166, 214/.test(inlineRule) && !/accent/.test(inlineRule),
  inlineRule.replace(/\s+/g, ' ').slice(0, 80))

// --- no glyphs standing in for icons -----------------------------------------
// The mark in the meta row was a three-ray asterisk that read as `✳` at 13px.
// The handoff rules out glyphs as icons; everything there is SVG.
// Требование было к гексагону, но смысл правила — «не глиф, а картинка».
// Гексагон с точкой ничего не значил и ни к чему не отсылал; на его месте
// теперь знак самого приложения. Проверяется то, ради чего правило писалось.
// С 1.11 это знак «Росчерк», встроенный SVG с цветами темы.
check('знак модели — картинка, а не текстовый символ',
  /<svg class="agent-mark"[^>]*>\s*<path /.test(app),
  'в разметке знака нет картинки')
check('у знака есть состояния: работа и нажатие',
  /\.msg-meta\.live \.agent-mark \{ animation: markPulse/.test(body) &&
  /\.agent-mark\.spun \{ animation: markSpun/.test(body) &&
  /\.agent-mark\.burst \{ animation: markBurst/.test(body))

// Состояний было два — «идёт» и «не идёт», — и весь ход знак выглядел
// одинаково, хотя ход всё это время менялся: думает, зовёт инструмент,
// пишет ответ, закончил.
check('знак различает фазы хода',
  /animation: markThink/.test(body) && /animation: markAnswer/.test(body) &&
  /animation: markTick/.test(body) && /animation: markSettle/.test(body))
check('фазы знака действительно переключаются',
  /markState\(pane, 'thinking'\)/.test(app) && /markState\(pane, 'answering'\)/.test(app) &&
  /markState\(p, 'tooling'\)/.test(app))
// Отметка конца хода ставилась на живой узел, а он удаляется перестройкой
// ленты в том же обороте: анимацию длиной в секунду никто ни разу не видел.
check('конец хода отмечается на том сообщении, что остаётся',
  /settled\.classList\.add\('is-settled'\)/.test(app))
check('вызов инструмента имеет свой вид, а не падает в базовый',
  /animation: markTool/.test(body) && /\.agent-mark\.is-tooling/.test(body))
// 19 px с 1.1.9: при 15 в обёртке 13 px владелец назвал знак «очень мелко».
check('знак стал крупнее',
  /<svg class="agent-mark"[^>]*width="19" height="19"/.test(app) && /\.mark-btn \{[^}]*width: 19px/.test(body))

// Подпись под ответом — модель, время и расход, и больше ничего. Строка
// «2 задачи · чем занят» там была третьим пересказом того, что уже показывает
// панель работы; на длинном ходе она превращалась в «2 задачи · Ревью:
// этапов 3» — набор слов рядом с именем модели.
check('подпись под ответом не пересказывает панель работы',
  !/class="cli-work/.test(app) && !/liveWorkText\(pane\)/.test(app))
check('в подписи остались модель, время и расход',
  /class="cli-model"/.test(app) && /class="cli-duration"/.test(app) && /class="cli-tokens/.test(app))
// «готово · 3 действ.» стояло в каждой сданной строке и ничего не добавляло.
check('строка сдавшего агента показывает время, а не счётчики',
  !/\$\{parts\.tools\.length\} \$\{t\('действ\.'\)\}/.test(app) &&
  /parts\.outcome !== 'done'/.test(app))

// --- the block that is actually on screen ------------------------------------
// The step rail is what fills a turn. The first pass at this redesign styled
// `.plan-*` and `.approval-diff` — both rare — and left the rows you watch every
// turn as a chevron and a grey sentence, then reported the design as done. The
// lesson is in the check: the rail has to be styled, and its parts named.
for (const cls of ['.think.rail-step', '.rail-dot', '.rail-verb', '.rail-target', '.rail-meta']) {
  check(`рельса шагов оформлена: ${cls}`, body.includes(cls + ' ') || body.includes(cls + ','),
    'нет правила')
}
check('строка шага собирается из трёх колонок',
  /rail-verb/.test(app) && /rail-target/.test(app) && /rail-meta/.test(app),
  'разметка шага не разложена на части')
check('исход шага виден по точке, а не по слову',
  /\.tone-ok \.rail-dot/.test(body) && /\.tone-err \.rail-dot/.test(body))

// The plan rows were overridden a thousand lines below by a more specific rule
// that kept the boxes and a mint green from no palette. One rule per thing.
check('строки плана не в рамках',
  !/\.plan-inline \.plan-node \{[^}]*background:\s*rgba\(255/.test(body),
  'у строки плана снова своя подложка')
check('в плане нет цвета мимо палитры', !body.includes('6ee7a8'), 'мятный зелёный вернулся')

// --- one definition per token ------------------------------------------------
// A second `:root` a thousand lines below the first put --font-sans and
// --font-mono back to IBM Plex, and being later it won. The bundled Fira Code
// was never used: the Plex files had been deleted, so the browser fell through
// to Consolas. Monospace looks like monospace, which is why it survived a
// screenshot review. Twice now the bug has been «the same thing defined twice,
// far apart» — so the rule is one `:root`.
// One `:root` across the whole app, and it is the one in tokens.css. Twice a
// second block far from the first silently overrode it — once putting the mono
// face back to a family whose files had been deleted.
const roots = (css.match(/^:root \{/gm) || []).length
check('токены объявлены в одном месте', roots === 1, 'блоков :root — ' + roots)
check('единственный :root лежит в tokens.css',
  (tokens.match(/^:root \{/gm) || []).length === 1 &&
  !/^:root \{/m.test(read('index.css')), 'index.css снова объявляет токены')
for (const token of ['--font-sans', '--font-mono', '--font-prose', '--font-display', '--accent-primary']) {
  const times = (code.match(new RegExp('^\\s*' + token + ':', 'gm')) || []).length
  check(`${token} объявлен один раз`, times === 1, 'объявлений ' + times)
}

// Every family the stylesheet names has to be one the bundle actually ships, or
// the text renders in whatever the system had and the change is invisible.
const named = [...new Set([...code.matchAll(/font-family:[^;]*?["']([A-Z][A-Za-z ]+)["']/g)].map(m => m[1]))]
const shipped = ['Onest', 'Fira Code', 'Newsreader', 'Instrument Sans', 'Georgia', 'Cambria',
  'Times New Roman', 'Segoe UI', 'Cascadia Code', 'Consolas', 'Menlo', 'Roboto', 'Arial']
const orphans = named.filter(f => !shipped.includes(f))
check('в стилях нет гарнитур, которых нет в сборке', orphans.length === 0, orphans.join(', '))

// The list bullet is drawn, not typed: the font's `•` follows the text size and
// sits on a baseline the browser picks, so at 15px it came out heavy and low.
check('маркер списка нарисован точкой',
  /\.msg-content ul > li::before/.test(body) && /width:\s*4px/.test(
    body.slice(body.indexOf('.msg-content ul > li::before'),
      body.indexOf('}', body.indexOf('.msg-content ul > li::before')))),
  'нет отрисованного маркера')
const preRule = body.slice(body.indexOf('.code-block pre {'),
  body.indexOf('}', body.indexOf('.code-block pre {')))
check('код набран кодовой гарнитурой', /--font-code/.test(preRule), preRule.slice(0, 60))
// Заголовки разделов и окон перешли на шрифт боковой панели в 1.3, приветствие —
// в 1.10 по выбору владельца: Newsreader не знает кириллицы, и русские
// заголовки падали в Georgia.
for (const sel of ['.brand-name', '.chat-header-title', '.page-title', '.modal-title', '.hero-title']) {
  const at = body.indexOf(sel + ' {')
  const rule = at < 0 ? '' : body.slice(at, body.indexOf('}', at))
  check(`${sel} набран интерфейсной гарнитурой`,
    /--font-ui/.test(rule), rule ? rule.replace(/\s+/g, ' ').slice(0, 60) : 'правило не найдено')
}
// Body text is not: a serif paragraph at 14px is a magazine, not a tool.
const bodyRule = body.slice(body.indexOf('.msg-content {'), body.indexOf('}', body.indexOf('.msg-content {')))
check('текст ответа набран не серифом', !/--font-serif/.test(bodyRule))

// --- the window agrees with the stylesheet -----------------------------------
// It paints before the stylesheet loads; a cool grey there flashes on every start.
check('фон окна совпадает с фоном приложения', /backgroundColor: '#1c1917'/.test(main),
  (main.match(/backgroundColor: '#[0-9a-f]{6}'/) || [''])[0])

// --- colour is not written into the window from script -----------------------
const inlineHex = [...app.matchAll(/style\.(?:background|backgroundColor|color|borderColor)\s*=\s*'(#[0-9a-fA-F]{3,6})'/g)]
  .map(m => m[1])
check('в коде окна нет цветов мимо токенов', inlineHex.length === 0, inlineHex.join(', '))

console.log(JSON.stringify({ ok: failed === 0, failed, problems }))
process.exit(failed ? 1 : 0)
