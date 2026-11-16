'use strict'
// Название диалога без эмодзи (план, 1.14, часть 3).
//
// ТЕСТЫ ДО КОДА: модуля `src/main/chat-title.js` нет — набор обязан быть
// красным и сказать почему СВОИМ текстом, а не `TypeError` в середине стека.
//
// Проверяется ровно то, что решил владелец: боковая панель переезжает на
// дизайн-систему, где у названия чата один знак — рисованный значок состояния,
// а не эмодзи, которые модель любит ставить в начало. Правило живёт в двух
// местах, и оба под проверкой: просьба к модели («называй без эмодзи») и
// зачистка ответа (модель всё равно ставит значок, а человек видит его в
// списке).
//
// Ни Electron, ни сети, ни живых ключей: ответ модели сюда приходит строкой,
// как он пришёл бы из провайдера.

const assert = require('node:assert/strict')

let mod = null
let loadError = null
try {
  mod = require('../src/main/chat-title')
} catch (error) {
  loadError = String(error && error.message).split('\n')[0]
}

const fs = require('node:fs')
const path = require('node:path')
function read(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')
}

let checks = 0
let failed = 0
const queue = []
function check(name, fn) { queue.push({ name, fn }) }
async function runQueue() {
  for (const item of queue) {
    checks++
    if (!mod) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: модуля нет — src/main/chat-title.js (${loadError}) · тесты написаны до кода, набор красный`)
      continue
    }
    try {
      await item.fn()
      console.log('ok', item.name)
    } catch (error) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 300)}`)
    }
  }
}

const show = value => JSON.stringify(value === undefined ? '<undefined>' : value)

// ---------------------------------------------------------------------------

check('модуль отдаёт и текст просьбы, и зачистку ответа', () => {
  assert.equal(typeof mod.TITLE_PROMPT, 'string', 'TITLE_PROMPT — не строка: просьбу к модели нечем формулировать')
  assert.ok(mod.TITLE_PROMPT.length > 40, `TITLE_PROMPT подозрительно короткий: ${show(mod.TITLE_PROMPT)}`)
  assert.equal(typeof mod.cleanTitle, 'function', 'нет cleanTitle — ответ модели некому приводить к названию')
})

check('просьба к модели называет правила, включая запрет эмодзи', () => {
  const prompt = mod.TITLE_PROMPT
  // Прежние правила терялись один раз, когда текст просьбы переезжал: проверка
  // держит их все на месте.
  for (const rule of ['2–5 слов', 'на языке запроса', 'без кавычек', 'без точки в конце', 'Название:']) {
    assert.ok(prompt.includes(rule), `из просьбы пропало правило «${rule}»: ${show(prompt.slice(0, 200))}`)
  }
  assert.match(prompt, /без эмодзи|без значков|эмодзи[^.]{0,40}нельзя|не ставь эмодзи/i,
    `просьба не запрещает эмодзи: ${show(prompt.slice(0, 240))}`)
  // Просьба — про название, а не про решение задачи: модель отвечает одной
  // строкой, и это тоже часть правила.
  assert.match(prompt, /ТОЛЬКО названием/, 'просьба не требует ответить именно названием')
})

check('эмодзи снимаются в начале, в конце и внутри, буквы остаются', () => {
  const cases = [
    ['🚀 Сборка проекта', 'Сборка проекта'],
    ['Чиним тесты 🔧', 'Чиним тесты'],
    ['🐛 сбой в сборке на windows', 'сбой в сборке на windows'],
    ['✨ правка ✨ описания', 'правка описания'],
    ['🇷🇺 русский флаг в начале', 'русский флаг в начале'],
    ['⏱ таймер сборки', 'таймер сборки'],
    ['👨‍👧 семейный набор значков', 'семейный набор значков']
  ]
  for (const [raw, want] of cases) {
    const got = mod.cleanTitle(raw)
    assert.equal(got, want, `«${raw}» зачистилось в ${show(got)}, ожидалось ${show(want)}`)
  }
})

check('текстовые знаки человеком не считаются эмодзи и остаются', () => {
  const kept = [
    'Правка — и только',
    '№ 12 в очереди',
    'a ± b',
    'Список: • пункт • пункт',
    'Проверка 100% готова'
  ]
  for (const raw of kept) {
    assert.equal(mod.cleanTitle(raw), raw, `зачистка съела не-эмодзи в «${raw}»: ${show(mod.cleanTitle(raw))}`)
  }
})

check('прежние правила зачистки ответа сохранены', () => {
  // Reasoning-модель иногда выдаёт поток рассуждений перед названием: берётся
  // последняя непустая строка.
  assert.equal(mod.cleanTitle('Думаю, о чём спросили\n\nСборка и тесты'), 'Сборка и тесты',
    'многострочный ответ не сведён к последней строке')
  assert.equal(mod.cleanTitle('«Название: правка readme»'), 'правка readme',
    `префикс или кавычки остались: ${show(mod.cleanTitle('«Название: правка readme»'))}`)
  assert.equal(mod.cleanTitle('   «Сборка проекта».   '), 'Сборка проекта',
    'кавычки и точка в конце не сняты')
  const long = mod.cleanTitle('а'.repeat(200))
  assert.ok(long.length <= 60, `название длиннее предела: ${long.length}`)
  assert.equal(mod.cleanTitle(''), null, 'пустой ответ притворился названием')
  assert.equal(mod.cleanTitle('   '), null, 'пробелы притворились названием')
  assert.equal(mod.cleanTitle('🚀🔥✨'), null, 'из одних эмодзи получилось название: ' + show(mod.cleanTitle('🚀✨')))
  assert.equal(mod.cleanTitle(null), null, 'null на входе бросает или даёт мусор')
  assert.equal(mod.cleanTitle(undefined), null, 'undefined на входе бросает или даёт мусор')
  assert.equal(mod.cleanTitle(42), null, 'число на входе притворилось названием')
})

check('главный процесс берёт просьбу и зачистку из модуля, а не держит свою копию', () => {
  const main = read('src', 'main', 'main.js')
  assert.ok(main.includes(`require('./chat-title')`), 'main.js не требует ./chat-title')
  assert.match(main, /TITLE_PROMPT/, 'текст просьбы не подставляется из модуля: запрет эмодзи можно потерять при правке')
  assert.match(main, /cleanTitle\(/, 'ответ модели не проходит через cleanTitle главного процесса')
  // Старая копия просьбы, оставшаяся в главном процессе, — это два источника
  // правила, из которых один обязательно уедет вперёд.
  assert.equal(/Ты придумываешь короткие названия диалогов/.test(main), false,
    'в main.js осталась своя копия просьбы о названии: правило живёт в двух местах')
})

// ---------------------------------------------------------------------------

runQueue()
  .catch(error => {
    failed++
    console.error(`ПРОВАЛ [набор]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ')}`)
  })
  .finally(() => {
    console.log(`Проверок: ${checks}, отказов: ${failed}`)
    console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
    process.exitCode = failed ? 1 : 0
  })
