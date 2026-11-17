'use strict'
// Сжатие длинного разговора (план, 3.9; поручение 29.09 10:45).
//
// ТЕСТЫ ДО КОДА: модуля `conversation-compression.js` в дереве нет — набор
// обязан быть красным и говорить, чего не хватает.
//
// Что здесь меряется, а что нет. Это чистая раскладка: какие сообщения покрывает
// сохранённая сводка, что из них едет в модель и что человек видит в ленте.
// Просьбу к модели свернуть середину пишет главный процесс — её проверяет
// оконный прогон `run-conversation-compression-ui.cjs` на подставной модели,
// а не этот файл.
//
// Главное требование владельца, которое меряется здесь: исходные сообщения никуда
// не деваются. Сжатие меняет только то, что уходит в модель, и то, что нарисовано
// в ленте, — массив `chat.messages` остаётся полным.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

let checks = 0
let failed = 0
function check(name, fn) {
  checks++
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 300)}`)
  }
}

const modulePath = path.join(root, 'src', 'renderer', 'conversation-compression.js')
let api = null
check('модуль сжатия существует и отдаётся в node', () => {
  assert.ok(fs.existsSync(modulePath),
    'нет файла `src/renderer/conversation-compression.js`: раскладка сжатия негде проверить')
  api = require(modulePath)
  assert.equal(typeof api.createConversationCompression, 'function',
    'модуль не отдаёт `createConversationCompression` — его нельзя собрать с языком окна')
})

// Дальше — поведенческие проверки. Если модуля ещё нет, они краснеют одной
// строкой каждая, а не падают исключением на загрузке всего набора. `t` здесь
// повторяет настоящий `t()` из `app.js`: подставляет «%s» по порядку, иначе
// проверка числа свёрнутых сообщений меряла бы пустое место.
const view = () => api && api.createConversationCompression({
  t: (text, ...args) => String(text || '').replace(/%s/g, () => String(args.shift() ?? '')),
  escapeHtml: value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
})

const history = () => ([
  { role: 'user', content: 'Задача: разобрать отчёт' },
  { role: 'assistant', content: 'Первый ответ' },
  { role: 'user', content: 'Уточнение одна' },
  { role: 'assistant', content: 'Ответ два' },
  { role: 'user', content: 'Уточнение два' },
  { role: 'assistant', content: 'Ответ три' },
  { role: 'user', content: 'Последняя просьба' }
])

const record = (extra = {}) => ({
  fromIndex: 1,
  throughIndex: 4,
  throughMark: 'Уточнение два',
  folded: 4,
  summary: 'Обсудили требования и два уточнения.',
  line: '[Начало разговора свёрнуто (4 сообщения): Обсудили требования и два уточнения.]',
  at: 1700000000000,
  ...extra
})

check('без записи о сжатии история уходит целиком', () => {
  const v = view()
  assert.ok(v, 'модуль не загрузился')
  const source = history()
  assert.deepEqual(v.applyCompression(source, null), source)
})

check('свежая запись: свёрнутые выпадают, сводка встаёт на их место', () => {
  const v = view()
  assert.ok(v, 'модуль не загрузился')
  const out = v.applyCompression(history(), record())
  assert.deepEqual(out.map(one => one.content), [
    'Задача: разобрать отчёт',
    record().line,
    'Ответ три',
    'Последняя просьба'
  ], 'сводка встала не туда, где лежала свёрнутая середина')
  assert.equal(out[1].role, 'system',
    'сводка ушла в модель репликой человека — модель приняла бы её за просьбу')
})

check('протухшая запись не имеет права ничего прятать', () => {
  const v = view()
  assert.ok(v, 'модуль не загрузился')
  // Человек убрал или переписал сообщение из середины: то, на что указывала
  // запись, сдвинулось. Молча отправить обрезок по старым номерам — значит
  // потерять чужие слова, поэтому история уходит целиком.
  const moved = history()
  moved[4] = { role: 'user', content: 'Совершенно другое сообщение' }
  assert.deepEqual(v.applyCompression(moved, record()), moved)
  // Обрезанный хвост — тот же случай: указателя больше нет.
  const shorter = history().slice(0, 4)
  assert.deepEqual(v.applyCompression(shorter, record()), shorter)
})

check('запись не трогает исходный массив', () => {
  const v = view()
  assert.ok(v, 'модуль не загрузился')
  const source = history()
  const copy = JSON.parse(JSON.stringify(source))
  v.applyCompression(source, record())
  assert.deepEqual(source, copy, 'модуль переписал историю человека — сообщения должны оставаться на месте')
})

check('в ленте стоит одна строка с раскрытием, а не пропажа сообщений', () => {
  const v = view()
  assert.ok(v, 'модуль не загрузился')
  const html = v.lineHtml(record())
  assert.match(html, /^<details class="[^"]*chat-compressed/, 'строка сжатия не раскрывается')
  assert.match(html, /Разговор сжат/, 'в подписи нет слова о том, что разговор сжат')
  assert.match(html, /4/, 'в подписи нет числа свёрнутых сообщений')
  assert.ok(html.includes('Обсудили требования'), 'в раскрытии нет самой сводки — человеку нечего читать')
})

check('сводка и подписи не могут протащить разметку в ленту', () => {
  const v = view()
  assert.ok(v, 'модуль не загрузился')
  const html = v.lineHtml(record({ summary: '<img src=x onerror=alert(1)>' }))
  assert.ok(!/<img /.test(html), 'сводка модели попала в ленту неотфильтрованной')
  assert.ok(/&lt;img/.test(html), 'сводка должна читаться текстом, а не исполняться')
})

// ─── проводка в приложении: без неё модуль был бы мёртвым кодом ──────────────

const app = read('src', 'renderer', 'app.js')
const main = read('src', 'main', 'main.js')
const i18n = read('src', 'renderer', 'i18n.js')

check('история для модели собирается через сжатие', () => {
  const at = app.indexOf('const history = chat.messages.map')
  assert.ok(at > 0, 'не найдена сборка истории для отправки — непонятно, что править')
  const block = app.slice(at, at + 2000)
  assert.match(block, /applyCompression\(/,
    'история уходит в модель целиком: у предела окна середина по-прежнему режется `trimHistory` без сводки')
})

check('лента рисует строку сжатия', () => {
  const at = app.indexOf('function renderMessages')
  assert.ok(at > 0, 'не найден `renderMessages`')
  const block = app.slice(at, at + 2500)
  assert.match(block, /lineHtml\(/, 'в ленте нет строки «Разговор сжат: …»')
})

check('кольцо контекста считает то, что реально уходит, а не весь архив', () => {
  const at = app.indexOf('function contextUsed')
  assert.ok(at > 0, 'не найден `contextUsed`')
  const block = app.slice(at, at + 2200)
  assert.match(block, /applyCompression\(|compressedHistory\(/,
    'после сжатия кольцо продолжало бы показывать полный архив — человек не понял бы, что разговор уже лёг')
})

check('сжатие живёт на чате отдельной записью, а не сообщением в ленте', () => {
  assert.match(app, /chat\.compression\s*=/,
    'нет поля `chat.compression`: служебное сообщение в `chat.messages` задело бы счётчики, заголовки и память')
  assert.doesNotMatch(app, /messages\.push\(\s*\{\s*role:\s*'system'/,
    'служебная системная реплика вставлена в переписку — её увидят экспорт, заголовок и память')
})

check('главный процесс планирует сворачивание середины и отдаёт запись окну', () => {
  assert.match(main, /function planHistoryFold/, 'в главном процессе нет решения о том, что сворачивать')
  assert.match(main, /function compressHistoryForTurn/, 'нет места, где середина разговора просит сводку у модели')
  const at = main.indexOf("ipcMain.handle('send-message'")
  assert.ok(at > 0, 'не найден обработчик `send-message`')
  const block = main.slice(at, at + 16000)
  assert.match(block, /compressHistoryForTurn\(/, 'ход не сжимает историю на входе — сводка не появится никогда')
  assert.match(block, /compression/, 'запись о сжатии не возвращается окну: renderer не сможет её сохранить и переиспользовать')
})

check('каждая новая русская подпись имеет английскую пару', () => {
  // Подписи строки сжатия живут в модуле, а не в `app.js`: там язык окна, и
  // сканировать надо оба файла, иначе пара не проверялась бы вовсе.
  const sources = app + (fs.existsSync(modulePath) ? read('src', 'renderer', 'conversation-compression.js') : '')
  const needed = [...sources.matchAll(/\bt\(\s*'(Разговор сжат[^']*|Свёрнуто[^']*|Показать сводку[^']*)'/g)].map(m => m[1])
  assert.ok(needed.length, 'в коде нет ни одной подписи строки сжатия — нечего и переводить?')
  const missing = [...new Set(needed)].filter(one => !i18n.includes(`'${one}'`))
  assert.deepEqual(missing, [], 'без английской пары: ' + missing.join(' | '))
})

check('вид строки сжатия собран из токенов, без новых литералов', () => {
  const css = read('src', 'renderer', 'index.css')
  const at = css.indexOf('.chat-compressed')
  assert.ok(at > 0, 'в CSS нет вида строки «Разговор сжат: …»')
  const block = css.slice(at, at + 900)
  assert.match(block, /var\(--/, 'раскладка строки сжатия не опирается на токены дизайн-системы')
  assert.ok(!/#[0-9a-fA-F]{3,6}/.test(block), 'в новом блоке CSS нарисован цвет литералом')
})

// ─── граница сворачивания в главном процессе ─────────────────────────────────
// `planHistoryFold` вырезается из `main.js` и вызывается с подставной мерой
// токенов: здесь проверяется арифметика границы (что остаётся, а что сворачивается),
// а не точность самой меры — её считает `roughTokens` рядом с окном модели.

const foldRegion = (() => {
  const from = main.indexOf('const COMPRESSION_MIN_FOLDED')
  const to = main.indexOf('function historyCompressionLine')
  if (from < 0 || to < 0) return ''
  return main.slice(from, to)
})()

const tokensOf = messages => messages
  .reduce((sum, m) => sum + Math.ceil(String(m.content || '').length / 3.2), 0)

let fold = null
check('граница сворачивания читается из главного процесса', () => {
  assert.ok(foldRegion.length > 200, 'в `main.js` не найден участок `planHistoryFold` — нечего вырезать')
  // eslint-disable-next-line no-new-func
  fold = new Function('messagesRoughTokens', `${foldRegion}\nreturn { planHistoryFold, COMPRESSION_MIN_FOLDED, COMPRESSION_TAIL_MIN }`)(tokensOf)
})

// Реплика ~4 КБ символов ≈ 1280 условных токенов в подставной мере.
const longTurns = n => Array.from({ length: n }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  content: `${i} `.padEnd(4000, 'х')
}))

check('пока переписка помещается — не сворачивается ничего', () => {
  assert.ok(fold, 'граница не вырезалась')
  const messages = longTurns(8)
  assert.equal(fold.planHistoryFold(messages, tokensOf(messages) + 1000), null)
})

check('у предела начало и хвост остаются, середина сворачивается', () => {
  assert.ok(fold, 'граница не вырезалась')
  const messages = [{ role: 'system', content: 'Инструкция окна' }, ...longTurns(20)]
  const budget = Math.ceil(tokensOf(messages) * 0.5)
  const plan = fold.planHistoryFold(messages, budget)
  assert.ok(plan, 'сворачивание не сработало там, где история вдвое больше бюджета')
  assert.equal(plan.fromIndex, 2,
    'сворачивание тронуло первое обращение человека: без задачи модель не знает, о чём разговор')
  assert.ok(messages.length - 1 - plan.throughIndex >= fold.COMPRESSION_TAIL_MIN,
    'хвост короче обещанного: последние сообщения обязаны ехать своими словами')
  assert.ok(plan.throughIndex - plan.fromIndex + 1 >= fold.COMPRESSION_MIN_FOLDED,
    'свёрнуто меньше минимума — платить за это отдельным вызовом модели нельзя')
  const kept = [...messages.slice(0, plan.fromIndex), { role: 'system', content: 'сводка' }, ...messages.slice(plan.throughIndex + 1)]
  assert.ok(tokensOf(kept) <= budget + fold.COMPRESSION_TAIL_MIN * 1300,
    `после сворачивания история всё равно не влезает: ${tokensOf(kept)} против ${budget}`)
})

check('сворачивать нечего — запись не рождается', () => {
  assert.ok(fold, 'граница не вырезалась')
  // Бюджет меньше, чем может оставить даже минимальный хвост: середины нет, и
  // главный процесс не имеет права резать разговор — дальше его ужмёт
  // `trimHistory`, который умеет обходиться без вызова модели.
  const tiny = [{ role: 'system', content: 'Инструкция' }, ...longTurns(3)]
  assert.equal(fold.planHistoryFold(tiny, 100), null)
  assert.equal(fold.planHistoryFold([], 1000), null)
  assert.equal(fold.planHistoryFold(null, 1000), null)
})

// 12.10.2026, директива «.compact»: бюджет в единицу сворачивает историю, которая в обычный бюджет помещается.
check('«.compact»: принудительный бюджет сворачивает то, что и так помещалось', () => {
  assert.ok(fold, 'граница не вырезалась')
  const messages = [{ role: 'system', content: 'Инструкция окна' }, ...longTurns(14)]
  assert.equal(fold.planHistoryFold(messages, tokensOf(messages) + 1000), null, 'без директивы история помещается и не сворачивается')
  const plan = fold.planHistoryFold(messages, 1)
  assert.ok(plan, 'принудительный бюджет не свернул историю')
  assert.equal(plan.fromIndex, 2, 'первое обращение человека должно остаться')
  assert.ok(messages.length - 1 - plan.throughIndex >= fold.COMPRESSION_TAIL_MIN, 'свежий хвост должен остаться')
})
check('«.compact»: главный процесс читает флаг запроса и подставляет принудительный бюджет', () => {
  assert.ok(/budget: payload\.forceCompression \? 1 : modelBudget\(payload\.model\)/.test(main), 'в send-message нет принудительного бюджета')
})

console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
