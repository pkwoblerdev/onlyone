// Стиль ответа в чате и защита от дрейфа в долгих разговорах.
//
// Свободные модели по умолчанию отвечают стеной буллетов и заголовков: на
// простой вопрос приходит документ с разделами. Правила формата — единственное,
// что это останавливает, и они легко теряются при следующей правке промпта.
//
// Отдельно проверяется напоминание для длинных переписок. Чем дольше разговор,
// тем сильнее каждый ответ опирается на предыдущие: модель соглашается охотнее,
// чем следует из фактов, и перестаёт говорить «это не сработает».
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (err) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message))
  }
}

// Вырезаем функцию вместе с её константой и зовём по-настоящему.
const cut = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)))
const longNote = new Function(
  cut('const LONG_TURN_THRESHOLD', 'function buildSystemPrompt') +
  '\nreturn buildLongConversationNote'
)()

check('в коротком разговоре напоминания нет', () => {
  assert.equal(longNote(0), '')
  assert.equal(longNote(6), '')
  assert.equal(longNote(23), '')
})

check('в длинном — появляется', () => {
  const note = longNote(24)
  assert.ok(note.length > 100, 'напоминание подозрительно короткое')
  assert.match(note, /увидел бы эту задачу впервые|без груза прошлых реплик/,
    'должно предлагать сверку со свежим взглядом')
  assert.match(note, /следует из фактов/, 'должно отделять согласие от фактов')
})

check('напоминание разрешает менять оценку', () => {
  // Без этого модель, однажды предложившая плохое решение, будет его защищать.
  assert.match(longNote(40), /Менять оценку по ходу — нормально/)
})

check('порог не занижен до бытового разговора', () => {
  const threshold = Number(main.match(/const LONG_TURN_THRESHOLD = (\d+)/)?.[1])
  assert.ok(threshold >= 12, 'слишком рано: обычная переписка не длинный разговор')
  assert.ok(threshold <= 60, 'слишком поздно: дрейф начинается раньше')
})

// --- правила формата ----------------------------------------------------------
//
// Правила ответа — данными в ./mode-prompts/shared.js (план, 6.2): один текст на
// все режимы, а не ветвление по имени модели. Берём настоящий собранный промпт
// режима «разговор», чтобы проверка не прошла молча, когда текст перестанут
// подставлять.
const modePrompts = require('../src/main/mode-prompts')
const LANGUAGE = 'Отвечай по-русски и описывай видимый прогресс по-русски, если пользователь не попросил другой язык.'
const style = modePrompts.buildModePrompt('conversation', { toolNames: [], personal: '', language: LANGUAGE })

check('проза — состояние по умолчанию, а не список', () => {
  assert.match(style, /По умолчанию — сплошной текст, а не список/)
  assert.match(style, /прозой/)
})

check('списки разрешены только по делу', () => {
  assert.match(style, /только если попросили или без них теряется ясность/)
})

check('отказ пишется без списка', () => {
  // Пункты в отказе читаются как приговор по статьям.
  assert.match(style, /Отказыва\S+.*не используй списки/s)
})

check('оговорки не съедают ответ', () => {
  assert.match(style, /Оговорки.*коротк/s)
})

check('уточняющий вопрос — не больше одного', () => {
  assert.match(style, /не больше одного за ответ/)
})

check('пустые усилители запрещены', () => {
  for (const word of ['честно говоря', 'на самом деле']) {
    assert.ok(style.includes(word), 'не назван оборот: ' + word)
  }
})

check('код остаётся кодом, а не форматированием', () => {
  assert.match(style, /Код — в блоках с указанием языка/)
})

check('язык ответа задаётся последним', () => {
  // Правило о языке должно стоять ближе всего к вопросу: длинный блок на другом
  // языке сам по себе тянет ответ на него.
  const lines = style.trim().split('\n').map(line => line.trim()).filter(Boolean)
  assert.equal(lines[lines.length - 1], LANGUAGE,
    'правило про язык должно быть последней строкой текста режима')
  const prompt = modePrompts.buildModePrompt('conversation',
    { toolNames: [], personal: '--- О пользователе ---\nОбращайся к человеку по имени: Паша.', language: LANGUAGE })
  assert.ok(prompt.lastIndexOf('О пользователе') > prompt.lastIndexOf(LANGUAGE),
    'после правила о языке остаётся только человек')
})

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
