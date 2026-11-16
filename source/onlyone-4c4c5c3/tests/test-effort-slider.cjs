// Глубина мышления — ползунок, а не ряд фишек.
//
// Просьба была простая: «поменьше текста, и мышление чтобы менялось отдельным
// ползунком вправо и влево». Здесь проверяется то, что за ползунком стоит: какие
// у него ступени, куда он встаёт и что происходит с выбором человека, когда тот
// переходит между моделями.
//
// Самая неприятная ошибка этого места — тихая: человек выключил мышление, а после
// перезапуска или смены модели оно снова включено. Раньше так и было: «off» не
// входил в список фишек модели, и выбор заменялся самой глубокой ступенью.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const CR = String.fromCharCode(13)
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').split(CR).join('')
const app = read('src', 'renderer', 'app.js')
const html = read('src', 'renderer', 'index.html')

const cut = (from, to) => {
  const a = app.indexOf(from)
  const b = app.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return app.slice(a, b)
}

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const { effortStops, pickEffort } = new Function(
  cut('  const EFFORT_ORDER =', '  function renderEffortChips()') +
  '; return { effortStops, pickEffort }')()

// --- ступени -------------------------------------------------------------------

check('ступени идут от мелкого к глубокому, как бы их ни прислал каталог',
  effortStops({ supportedEfforts: ['max', 'low', 'high', 'medium'] }).join(',') === 'low,medium,high,max',
  effortStops({ supportedEfforts: ['max', 'low', 'high', 'medium'] }).join(','))

check('модель без ступеней — ползунка нет', effortStops({ supportedEfforts: [] }).length === 0)
check('модель без каталога ступеней — ползунка нет', effortStops({}).length === 0)

check('«Выкл» не предлагается никогда: тише Low ступени нет (слово владельца 05.10)',
  !effortStops({ supportedEfforts: ['low', 'high'] }).includes('off') && !effortStops({ supportedEfforts: ['minimal', 'low', 'high'] }).includes('minimal'))

check('нулевая ступень модели не попадает на ползунок',
  effortStops({ supportedEfforts: ['none', 'low', 'high'] }).join(',') === 'low,high')

check('неизвестная ступень не попадает на ползунок',
  !effortStops({ supportedEfforts: ['high', 'turbo'] }).includes('turbo'))

// --- куда встаёт ползунок --------------------------------------------------------

const glm = effortStops({ supportedEfforts: ['low', 'medium', 'high', 'xhigh'] })

check('выбранная ступень остаётся, если модель её принимает', pickEffort(glm, 'medium') === 'medium')
check('сохранённое прежде «Выкл» становится Low', pickEffort(glm, 'off') === 'low')
check('у модели без Low «Выкл» становится самой тихой из имеющихся',
  pickEffort(effortStops({ supportedEfforts: ['none', 'high'] }), 'off') === 'high')
check('чужая ступень заменяется самой глубокой настоящей, а не «Выкл»',
  pickEffort(glm, 'max') === 'xhigh', pickEffort(glm, 'max'))

// --- выбор человека живёт отдельно от вынужденного ----------------------------------

const render = cut('  function renderEffortChips() {', '  // Подпись и заливка дорожки.')
check('модель без ступеней не затирает выбор человека',
  /currentThinkingEffort = pickEffort\(stops, preferredThinkingEffort \|\| currentThinkingEffort\)/.test(render))
check('выбор человека запоминается при установке',
  /function setEffort\(effort\) \{\s*currentThinkingEffort = effort\s*preferredThinkingEffort = effort/.test(app))
check('сохранённый выбор восстанавливается как выбор, а не как случайное значение',
  /currentThinkingEffort = settings\.thinkingEffort\s*preferredThinkingEffort = settings\.thinkingEffort/.test(app))

// --- сам ползунок -----------------------------------------------------------------

check('в каталоге настоящий ползунок', /<input id="effortSlider" class="effort-range" type="range"/.test(html))
check('у ползунка есть подпись для чтения с экрана', /<label class="effort-bar-label" for="effortSlider">Мышление<\/label>/.test(html))
check('озвучивается значение словом, а не номером ступени', /setAttribute\('aria-valuetext', label\)/.test(app))
check('глубина сохраняется, когда ползунок отпустили, а не на каждое движение',
  /effortSlider\?\.addEventListener\('change'/.test(app) && /effortSlider\?\.addEventListener\('input', \(\) => paintEffortSlider/.test(app))
check('пока включён Fast, ползунок показывает «авто» и не двигается',
  /el\.effortSlider\.disabled = Boolean\(fastMode\)/.test(app) && /fastMode \? t\('авто'\)/.test(app))

// --- меньше текста ------------------------------------------------------------------

check('фишек глубины больше нет', !/effortChipsGroup|effort-chip/.test(html))
check('абзацев пояснений в каталоге больше нет',
  !/Глубина подбирается сама, вместо настройки ниже/.test(html) && !/Обязательны для этой модели/.test(html))
check('описание модели не стоит в каждой строке',
  /\$\{selected && model\.description \?/.test(app))
check('Fast остаётся в каталоге', /<input id="fastModeToggle" type="checkbox"/.test(html))

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
