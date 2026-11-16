// Цитата выделенного текста (план, 3.1). Раньше «Ответить» дописывал в поле
// ввода строки с «>» — они выглядели стрелками, а модель не знала, откуда
// фрагмент. Теперь цитата — плашка над полем, в сообщении — блок, а модели
// уходит явная пометка: фрагмент какого ответа цитирует человек.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')
const start = src.indexOf('  const QUOTE_MAX = 1200')
const end = src.indexOf('  function renderQuotes(pane) {')
const sentAt = src.indexOf('  function sentQuotesHtml(msg) {')
const sentEnd = src.indexOf('\n  function showQuoteButton(', sentAt)
if (start < 0 || end < 0 || sentAt < 0) throw new Error('функции цитат не найдены')

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// eslint-disable-next-line no-new-func
const lib = new Function('t', 'escapeHtml', 'formatWithEmoji',
  src.slice(start, end) + src.slice(sentAt, sentEnd) + '\nreturn { quoteText, quoteSource, quoteLabel, quotesForModel, sentQuotesHtml }'
)(s => s, escapeHtml, s => s)

let failed = 0
const check = (name, ok, detail) => { if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) } }

// Что уходит модели.
const one = lib.quotesForModel([{ text: 'Сайт собран\nпревью открыто', role: 'assistant', answer: 2 }], 'Почему превью пустое?')
check('модель знает, из какого ответа фрагмент', /из твоего ответа №2/.test(one), one)
check('фрагмент — строками цитаты', /\n> Сайт собран\n> превью открыто\n/.test(one), one)
check('конец цитаты помечен, вопрос отдельно после', /\[Конец цитаты\]\n\nПочему превью пустое\?$/.test(one), one)
const mine = lib.quotesForModel([{ text: 'сделай тёмную тему', role: 'user', answer: null }], 'и светлую')
check('цитата своего сообщения названа своей', /из своего прошлого сообщения/.test(mine), mine)
check('без цитат вопрос уходит как есть', lib.quotesForModel([], 'вопрос') === 'вопрос')
const two = lib.quotesForModel([{ text: 'a', role: 'assistant', answer: 1 }, { text: 'b', role: 'assistant', answer: 3 }], 'q')
check('несколько цитат — по порядку', two.indexOf('№1') < two.indexOf('№3') && two.endsWith('q'), two)

// Обрезка длинного.
const long = lib.quoteText('слово '.repeat(400))
check('длинная цитата обрезается по слову с многоточием', long.length <= 1201 && long.endsWith('…'), String(long.length))
check('пустое выделение не цитата', lib.quoteText('   ') === '')

// Подпись и блок в отправленном сообщении.
check('подпись ответа с номером', lib.quoteLabel({ role: 'assistant', answer: 4 }) === 'Ответ 4')
check('подпись своего сообщения', lib.quoteLabel({ role: 'user' }) === 'Ваше сообщение')
const html = lib.sentQuotesHtml({ quotes: [{ text: '<b>x</b>\nстрока', role: 'assistant', answer: 1 }] })
check('в сообщении — блок цитаты с подписью', /<blockquote class="msg-quote">/.test(html) && /Ответ 1/.test(html), html)
check('текст цитаты экранирован', /&lt;b&gt;x&lt;\/b&gt;<br>строка/.test(html) && !/<b>x/.test(html), html)
check('без цитат блока нет', lib.sentQuotesHtml({}) === '')

// Номер ответа считается по порядку ответов в ленте.
const node = role => ({ classList: { contains: cls => cls === role } })
const a1 = node('assistant'), a2 = node('assistant'), a3 = node('assistant')
const list = { querySelectorAll: () => [a1, a2, a3] }
const second = lib.quoteSource(a2, list)
check('второй ответ в ленте — «Ответ 2»', second.role === 'assistant' && second.answer === 2, JSON.stringify(second))
check('своё сообщение — «Ваше сообщение»', lib.quoteSource(node('user'), list).role === 'user')
check('ответ не из ленты — без номера', lib.quoteSource(node('assistant'), list).answer === null)

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
