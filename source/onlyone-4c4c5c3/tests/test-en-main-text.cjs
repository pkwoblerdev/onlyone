// Сторож 2.6б (Н89): то, что главный процесс показывает человеку, переводится
// им самим — шаблоном с аргументами, а не собранной русской фразой.
//
// Почему не «переведёт окно»: окно ищет в словаре строку целиком, а главное
// окно собирает фразы с подстановкой — «Путь «Anthropic» не настроен: нужно
// заполнить модель, ключ.». Для словаря это неизвестная строка, и на английском
// экране она оставалась русской. Поэтому главный процесс получает язык окна и
// отправляет `tr(шаблон, аргументы)`; адаптеры путей — тем же письмом, через
// `uiText`, который им передаёт главный процесс.
//
// Разбор здесь свой, а не регуляркой: `reason:` часто ведёт к тернарному
// выражению с двумя шаблонами, и скобка вызова должна быть найдена так же
// надёжно, как и сама фраза. Комментарии токенизатор пропускает — кавычка в
// пояснении не строка.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const MAIN = 'src/main/main.js'
const ADAPTERS = ['src/main/providers/openai-compatible.js', 'src/main/providers/anthropic-messages.js']
const CATALOG = 'src/main/providers/catalog.js'
const dict = new Function('window', `${read('src/renderer/i18n.js')}
return window.__I18N__.en`)({})

const CYR = /[а-яё]{3,}/
const FIELDS = /(?:^|[^\w$])(reason|note|summary|details)\s*:/y

function readString (text, i) {
  const quote = text[i]
  let j = i + 1
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue }
    if (text[j] === quote) return j + 1
    if (quote === '`' && text[j] === '$' && text[j + 1] === '{') { j = readBraces(text, j + 1); continue }
    j++
  }
  return j
}
function readBraces (text, i) {
  let depth = 0
  let j = i
  while (j < text.length) {
    const ch = text[j]
    if (ch === '"' || ch === "'" || ch === '`') { j = readString(text, j); continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (!depth) return j + 1 }
    j++
  }
  return j
}
// Конец выражения после `поле:` — запятая или закрывающая скобка своего уровня.
function readExpression (text, i) {
  let depth = 0
  let j = i
  while (j < text.length) {
    const ch = text[j]
    if (ch === '"' || ch === "'" || ch === '`') { j = readString(text, j); continue }
    if (text.startsWith('//', j)) { j = text.indexOf('\n', j); if (j < 0) return text.length; continue }
    if (text.startsWith('/*', j)) { j = (text.indexOf('*/', j) + 2) || text.length; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; j++; continue }
    if (ch === ')' || ch === ']' || ch === '}') { if (!depth) return j; depth--; j++; continue }
    if ((ch === ',' || ch === ';' || ch === ':') && !depth) return j
    j++
  }
  return j
}

// Что файл отправляет на перевод: `strings` — все строковые литералы,
// `spans` — аргументы вызовов tr( / uiText(.
function scan (text, names) {
  const strings = []
  const spans = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue }
    if (ch === '/' && text[i + 1] === '*') { i = (text.indexOf('*/', i + 2) + 2) || text.length; continue }
    if (ch === '"' || ch === "'" || ch === '`') {
      const to = readString(text, i)
      const body = text.slice(i + 1, to - 1)
      // Русским считается то, что написано вне `${}`: рамка «${a} (${b})» слов
      // не содержит, и требовать от неё перевода — значит ловить ложь.
      let spoken = ''
      for (let j = 0; j < body.length; j++) {
        if (body[j] === '$' && body[j + 1] === '{') { j = readBraces(body, j + 1) - 1; continue }
        spoken += body[j]
      }
      strings.push({ from: i, to, body, spoken, interpolated: body.includes('${') })
      i = to - 1
      continue
    }
    const name = names.find(candidate => text.startsWith(`${candidate}(`, i) && !/[\w$.]/.test(text[i - 1] || ''))
    if (name) {
      // Глубина с единицы:_scan начинается сразу после открывающей скобки, и
      // первая закрывающая — это конец вызова, а не минус один уровень.
      let depth = 1
      let j = i + name.length + 1
      for (; j < text.length; j++) {
        const c = text[j]
        if (c === '"' || c === "'" || c === '`') { j = readString(text, j) - 1; continue }
        if (c === '(') depth++
        else if (c === ')') { depth--; if (!depth) break }
      }
      spans.push({ from: i + name.length + 1, to: j })
      // Не перепрыгиваем вызов: внутри него бывает ещё один (рамка +.detail),
      // и его шаблон тоже обязан иметь пару.
      i = i + name.length
      continue
    }
  }
  return { text, strings, spans }
}

const main = scan(read(MAIN), ['tr'])
const adapters = ADAPTERS.map(file => ({ file, ...scan(read(file), ['uiText']) }))
const insideTr = item => main.spans.some(span => item.from > span.from && item.to <= span.to)

// Поля, которые окно рисует как есть: каждое выражение после `reason:` и
// соседей обязано быть переводимым — либо русской строкой без подстановки (её
// догоняет словарь), либо шаблоном внутри вызова.
const humanFields = []
for (let i = 0; i < main.text.length; i++) {
  const ch = main.text[i]
  if (ch === '/' && main.text[i + 1] === '/') { i = main.text.indexOf('\n', i); if (i < 0) break; continue }
  if (ch === '/' && main.text[i + 1] === '*') { i = (main.text.indexOf('*/', i + 2) + 2) || main.text.length; continue }
  if (ch === '"' || ch === "'" || ch === '`') { i = readString(main.text, i) - 1; continue }
  FIELDS.lastIndex = i
  const match = FIELDS.exec(main.text)
  if (!match || match.index !== i) continue
  const valueStart = i + match[0].length
  const valueEnd = readExpression(main.text, valueStart)
  const items = main.strings.filter(item =>
    item.from >= valueStart && item.to <= valueEnd && CYR.test(item.spoken))
  if (items.length) humanFields.push({ field: match[1], items })
  i = valueEnd - 1
}

const raw = humanFields.flatMap(entry => entry.items
  .filter(item => item.interpolated && !insideTr(item))
  .map(item => ({ field: entry.field, item })))

const lineOf = index => main.text.slice(0, index).split('\n').length
const show = list => list.map(row => `${row.field} на ${lineOf(row.item.from)}: ${row.item.body.slice(0, 56)}`)

let failed = 0
const check = (name, fn) => {
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

// Планка-трещотка: число имеет право только падать. Мерка 28.09 — 20 мест;
// Н89 закрыл панель путей и карточку спроса; остаются внутренние причины хода и
// полотна (6660, 6671, 7010, 7548) — их счёт ведёт пункт 5.5.
const RAW_LIMIT = 4

check(`непереведённых фраз для человека не больше планки ${RAW_LIMIT}`, () => {
  assert.ok(raw.length <= RAW_LIMIT,
    `${raw.length} (планка ${RAW_LIMIT}): ` + show(raw).join(' | '))
})

// Метки, которые лента подставляет не литералом: из таблиц `const word = {…}`,
// из(defaultов тернарных выражений и из аргументов функций (`what` у `askLead`).
// У `tr(переменная)` шаблон неизвестен, поэтому покрытие проверяется перечнем
// возможных значений: он собирается из тех же таблиц, а чего в таблицах нет —
// дописано ниже руками.
const mapWords = [...main.text.matchAll(/const word = \{([^}]*)\}/g)]
  .flatMap(entry => [...entry[1].matchAll(/'([^']*[а-яё]{3,}[^']*)'/g)].map(m => m[1]))
const FEED_WORDS = [...new Set([...mapWords,
  'отметил', 'написал', 'ждёт подтверждения', 'приёмка', 'работа ведущего'])]
const DYNAMIC_LABEL = /^\s*(?:word\b|word\[|what\b|state\.status\b)/

check('метки ленты переведены', () => {
  const missing = FEED_WORDS.filter(word => !dict[String(word).trim()])
  assert.deepEqual(missing, [])
})

// Каждая фраза, отправленная на перевод, обязана иметь пару и не разойтись с
// ней числом подстановок: шаблон без пары молча уйдёт на экран по-русски, а
// лишний «%s» в паре останется прямо в тексте.
check('у tr() и uiText() есть английская пара с тем же числом подстановок', () => {
  const filled = text => (String(text).match(/%s/g) || []).length
  const nums = text => [...String(text).matchAll(/\{(\d+)\}/g)].map(m => Number(m[1]))
  const bad = []
  for (const part of [{ file: MAIN, text: main.text, spans: main.spans }, ...adapters]) {
    for (const span of part.spans) {
      const body = part.text.slice(span.from, span.to)
      const template = body.match(/^(['"`])((?:(?!\1)[\s\S]|\\.)*)\1/)
      if (!template) {
        // Переменная вместо шаблона законна только для меток из перечня выше.
        if (CYR.test(body) && !DYNAMIC_LABEL.test(body)) {
          bad.push(`${part.file}: tr(${body.slice(0, 40)}…) — шаблон не литерал`)
        }
        continue
      }
      const key = template[2].replace(/\s+/g, ' ').trim()
      if (!CYR.test(key)) continue
      const pair = dict[key]
      if (!pair) { bad.push(`${part.file}: нет пары «${key.slice(0, 56)}»`); continue }
      if (filled(pair) !== filled(key)) bad.push(`«${key.slice(0, 44)}»: подстановок ${filled(key)}, в паре ${filled(pair)}`)
      if (Math.max(-1, ...nums(key)) !== Math.max(-1, ...nums(pair))) {
        bad.push(`«${key.slice(0, 44)}»: номера подстановок разошлись с парой`)
      }
    }
  }
  assert.deepEqual(bad, [])
})

// Подсказка ключа в панели путей приходит из реестра провайдеров и окно
// показывает её как есть — пара нужна каждой строке.
check('подсказки ключа из реестра провайдеров переведены', () => {
  const missing = [...read(CATALOG).matchAll(/keyPlaceholder:\s*'([^']*)'/g)]
    .map(match => match[1].trim())
    .filter(text => CYR.test(text) && !dict[text])
  assert.deepEqual(missing, [])
})

console.log(JSON.stringify({
  ok: failed === 0, failed,
  trВызовов: main.spans.length + adapters.reduce((sum, part) => sum + part.spans.length, 0),
  полейСРусским: humanFields.length,
  непереведённых: raw.length,
  список: show(raw)
}, null, 2))
process.exit(failed ? 1 : 0)
