'use strict'
// Адресный набор чистого ядра планировщика (`src/main/schedule-model.js`), этап 3.5.
//
// ТЕСТЫ ДО КОДА: модуля ещё нет, набор обязан быть КРАСНЫМ и говорить почему.
// `require` оставлен в начале файла (его читает и человек, и мутационный харнесс),
// но обёрнут в try: без итоговых двух строк прогон неотличим от отсутствия
// прогона, а «модуля нет» должно считаться отказом КАЖДОЙ проверки, а не молча
// съесть набор.
//
// Контракт: audits/qoder-2-2026-09-26/schedule-contract.md. Мере́ние часов в нём
// снято на Node v24.21 этого окружения и перепроверено этим набором: берлинская
// стена «02:30 26.10.2025» бывает дважды (00:30Z и 01:30Z), стены «02:30
// 29.03.2026» нет ни в одном мгновении (01:00Z показывает уже 03:00).
//
// Часы — только вход `nowMs`: внутри набора нет ни одного суждения о «сегодня».
// `Date.now()` встречается ровно дважды и оба раза как защёлка, а не как данные:
// проверить, что функции не смотрят в часы машины, и что поиск не завис на
// невозможной дате. Ни сети, ни Electron, ни живых ключей: все значения выдуманы.
const assert = require('node:assert/strict')

let model = null
let loadError = null
try {
  model = require('../src/main/schedule-model')
} catch (error) {
  // Первая строка: `Cannot find module ...` — без простыни require stack ×56.
  loadError = String(error.message).split('\n')[0]
}

let checks = 0
let failed = 0
function check(name, fn) {
  checks++
  if (!model) {
    failed++
    console.error(`ПРОВАЛ [${name}]: модуля src/main/schedule-model.js нет (${loadError})`)
    return
  }
  try {
    fn()
    console.log('ok', name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

// Экспорт отсутствует = отказ, а не `TypeError: not a function` в середине стека.
function call(name, ...args) {
  const fn = model && model[name]
  if (typeof fn !== 'function') throw new Error(`модуль не экспортирует функцию ${name}`)
  return fn(...args)
}

// ---------------------------------------------------------------------------
// Вспомогательное: строение записи, стены часов, сбор проблем списком
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T = iso => Date.parse(iso)
const T0 = T('2026-05-01T00:00:00.000Z')

const AUTUMN_EARLY = T('2025-10-26T00:30:00.000Z') // 02:30 GMT+2, раннее из двух
const AUTUMN_LATE = T('2025-10-26T01:30:00.000Z') // 02:30 GMT+1, двойник того же дня
const SPRING_END = T('2026-03-29T01:00:00.000Z') // конец прыжка: на стене уже 03:00
const SPRING_LATE = T('2026-03-29T01:30:00.000Z') // стена 03:30 — контракт это запрещает
const AUTUMN_NEXT_DAY = T('2025-10-27T01:30:00.000Z') // 02:30 27.10 по Берлину

const base = (over = {}) => ({
  id: 'sch_test_1',
  name: 'Проверочное расписание',
  enabled: true,
  timeZone: 'Europe/Berlin',
  misfire: 'skip',
  action: { type: 'note', text: 'заметка' },
  ...over
})
const dailyRec = (time, over = {}) => base({ kind: 'daily', daily: { time }, ...over })
const weeklyRec = (time, weekdays, over = {}) => base({ kind: 'weekly', weekly: { time, weekdays }, ...over })
const cronRec = (expression, over = {}) => base({ kind: 'cron', cron: { expression }, ...over })
const everyRec = (everyMinutes, from = T0, over = {}) => base({ kind: 'interval', interval: { everyMinutes, from }, ...over })
const onceRec = (at, over = {}) => base({ kind: 'once', once: { at }, ...over })

// Стена в поясе — независимо от реализации: проверка сверяет календарную дату
// результата, а не копирует чужой поиск.
function wallDate(tz, ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms))
}
const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z')
const show = value => (typeof value === 'number' && Number.isFinite(value) ? iso(value) : JSON.stringify(value) === undefined ? String(value) : JSON.stringify(value))
const fieldsOf = result => (result && Array.isArray(result.errors) ? result.errors.map(error => String(error && error.field)) : [])
const problemsOf = result => (result && Array.isArray(result.errors) ? result.errors : [])
  .map(error => `${String(error && error.field)}:${String(error && error.code)} ${String(error && error.message)}`)

// Ожидание «невалидно» = ok:false со списком полей, а НЕ исключение (контракт,
// раздел «Что обязано быть чистым»). `fieldAnyOf` — маленькие куски имени поля:
// реализация вправе назвать вложенное поле `daily.time` или `time`, спорить с этим
// набор не должен, но и молчать об ошибке не вправе.
function expectInvalid(label, record, fieldAnyOf) {
  let result
  try {
    result = call('validateSchedule', record)
  } catch (error) {
    return [`${label}: бросило исключение вместо ok:false (${error.message})`]
  }
  if (!result || typeof result !== 'object') return [`${label}: вместо объекта { ok, errors } вернулось ${show(result)}`]
  const problems = []
  if (result.ok !== false) problems.push(`${label}: прошло как валидное, а должно быть невалидным [${problemsOf(result).join(' | ')}]`)
  if (!Array.isArray(result.errors)) problems.push(`${label}: errors не массив (${show(result.errors)})`)
  else if (!result.errors.length) problems.push(`${label}: ok:false с пустым списком ошибок — человеку нечего показать`)
  if (problems.length) return problems
  if (fieldAnyOf && fieldAnyOf.length) {
    const fields = fieldsOf(result).map(field => field.toLowerCase())
    if (!fields.some(field => fieldAnyOf.some(part => field.includes(part))))
      problems.push(`${label}: в списке нет поля про «${fieldAnyOf.join('|')}» [${fieldsOf(result).join(', ')}]`)
  }
  return problems
}

function expectValid(label, record) {
  let result
  try {
    result = call('validateSchedule', record)
  } catch (error) {
    return [`${label}: бросило исключение на валидной записи (${error.message})`]
  }
  if (!result || typeof result !== 'object') return [`${label}: вместо объекта { ok, errors } вернулось ${show(result)}`]
  if (result.ok !== true) return [`${label}: невалидно [${problemsOf(result).join(' | ')}]`]
  if (!Array.isArray(result.errors) || result.errors.length) return [`${label}: ok:true с непустым списком ошибок [${problemsOf(result).join(' | ')}]`]
  return []
}

function report(problems) {
  assert.deepEqual(problems, [], `${problems.length} проблем${problems.length === 1 ? 'а' : 'ы'}: ${problems.join('; ')}`)
}

// nextAfter: мгновенный ответ обязан быть числом-эпохой (или null).
function nextOf(record, nowMs, opts) {
  const value = call('nextAfter', record, nowMs, opts)
  if (value !== null && typeof value !== 'number') throw new Error(`nextAfter вернул ${show(value)}, а ждалось число или null`)
  return value
}

// ---------------------------------------------------------------------------
// 1. validateSchedule — границы и строение ошибок
// ---------------------------------------------------------------------------

function validateSuite() {
  check('validateSchedule: валидный минимум проходит без ошибок', () => {
    // Минимум: пояс, kind со своим туловом и действие. `name`, `enabled`,
    // `misfire`, `nextRunAt` здесь отсутствуют по правам: имя даёт человек, а
    // `enabled` и `misfire: 'skip'` — значения по умолчанию (правило 5).
    report(expectValid('минимум без name/enabled/misfire', {
      id: 'sch_min',
      timeZone: 'Europe/Berlin',
      kind: 'daily',
      daily: { time: '07:30' },
      action: { type: 'note', text: 'заметка' }
    }))
  })

  check('validateSchedule: все пять kind валидны', () => {
    const problems = []
    problems.push(...expectValid('once', onceRec('2027-04-01T07:30:00+02:00')))
    problems.push(...expectValid('interval', everyRec(90)))
    problems.push(...expectValid('daily', dailyRec('07:30')))
    problems.push(...expectValid('weekly', weeklyRec('07:30', [1, 3, 5])))
    problems.push(...expectValid('cron', cronRec('30 7 * * 1-5')))
    report(problems)
  })

  check('validateSchedule: everyMinutes вне 1..7*24*60 невалиден', () => {
    const problems = []
    for (const bad of [0, -1, 10081, 20000]) problems.push(...expectInvalid(`everyMinutes ${bad}`, everyRec(bad), ['everyminutes', 'interval']))
    for (const good of [1, 10080]) problems.push(...expectValid(`everyMinutes ${good} (край диапазона)`, everyRec(good)))
    report(problems)
  })

  check('validateSchedule: everyMinutes дробное, ноль и не-число невалидны', () => {
    const problems = []
    for (const bad of [90.5, 0.5, 0, NaN, '90', null])
      problems.push(...expectInvalid(`everyMinutes ${show(bad) === 'null' ? 'null' : String(bad)}`, everyRec(bad), ['everyminutes', 'interval']))
    report(problems)
  })

  check('validateSchedule: время «24:00», «7:5», «07:5» невалидны, «00:00» валидно', () => {
    const problems = []
    for (const bad of ['24:00', '7:5', '07:5', '07:60', '7:30', '0:00', '23:5', '', '07-30', 'всем привет'])
      problems.push(...expectInvalid(`daily.time «${bad}»`, dailyRec(bad), ['time', 'daily']))
    for (const good of ['00:00', '07:05', '23:59']) problems.push(...expectValid(`daily.time «${good}» (край)`, dailyRec(good)))
    // Тот же `HH:MM` у weekly — то же правило, отдельного ослабления тут нет.
    problems.push(...expectInvalid('weekly.time «24:00»', weeklyRec('24:00', [1]), ['time', 'weekly']))
    problems.push(...expectValid('weekly.time «07:05»', weeklyRec('07:05', [1])))
    report(problems)
  })

  check('validateSchedule: пустой weekdays невалиден', () => {
    const problems = []
    problems.push(...expectInvalid('weekdays []', weeklyRec('07:30', []), ['weekdays', 'weekly']))
    for (const good of [[0], [6], [1, 3, 5], [0, 1, 2, 3, 4, 5, 6]])
      problems.push(...expectValid(`weekdays ${JSON.stringify(good)}`, weeklyRec('07:30', good)))
    report(problems)
  })

  check('validateSchedule: неизвестная timeZone невалидна', () => {
    const problems = []
    // Сверка списком Intl, а не регэкспом: «Europe/Berlinx» невалиден.
    for (const bad of ['Europe/Berlinx', 'berlin', 'Europa/Berlin', '', '   ', 'GMT+1', 'Europe/Berlin Europe/London'])
      problems.push(...expectInvalid(`timeZone «${bad}»`, dailyRec('07:30', { timeZone: bad }), ['timezone', 'tz']))
    // «UTC» здесь НЕ закреплён: на Node v24.21 этого окружения
    // Intl.supportedValuesOf('timeZone') даёт 418 поясов и «UTC» в списке отсутствует,
    // то есть механизм, предписанный контрактом, «UTC» отвергает. Спор вынесен
    // в возражения, а не решён тестом молча.
    for (const good of ['Europe/Berlin', 'America/New_York', 'Australia/Eucla', 'Asia/Tokyo'])
      problems.push(...expectValid(`timeZone «${good}»`, dailyRec('07:30', { timeZone: good })))
    report(problems)
  })

  check('validateSchedule: once.at без смещения и не-ISO невалидны', () => {
    const problems = []
    for (const bad of ['2026-04-01T07:30:00', '01.04.2026 07:30', 'завтра утром', '2026-04-01', '', null])
      problems.push(...expectInvalid(`once.at «${String(bad)}»`, onceRec(bad), ['at', 'once']))
    problems.push(...expectValid('once.at со смещением +02:00', onceRec('2027-04-01T07:30:00+02:00')))
    // «Z» — то же смещение (ноль), записанное штатным способом.
    problems.push(...expectValid('once.at с Z', onceRec('2027-04-01T05:30:00Z')))
    report(problems)
  })

  check('validateSchedule: мусорная запись (null, строка, {}) даёт ok:false, а не исключение', () => {
    const problems = []
    for (const junk of [null, undefined, 'расписание', 42, true, {}, [], '', NaN])
      problems.push(...expectInvalid(`запись ${show(junk)}`, junk))
    // Kind вне списка, kind без своего тулова, чужой misfire — та же история:
    // список полей, а не стек.
    problems.push(...expectInvalid('kind «луна»', base({ kind: 'луна', daily: { time: '07:30' } }), ['kind']))
    problems.push(...expectInvalid('kind «daily» без тулова daily', base({ kind: 'daily' })))
    problems.push(...expectInvalid('misfire «догнать-всё»', dailyRec('07:30', { misfire: 'догнать-всё' }), ['misfire']))
    report(problems)
  })

  check('validateSchedule: id с точками и «__proto__» невалидны', () => {
    const problems = []
    // Точки разбивают путь dot-prop в electron-store: ломается не запись, а всё хранилище.
    for (const bad of ['sch.a.b', 'a.b', '__proto__', 'a'.repeat(41), 'привет мир', '', 'a/b', 'a\\b', 'sch 1'])
      problems.push(...expectInvalid(`id «${bad.slice(0, 20)}»`, dailyRec('07:30', { id: bad }), ['id']))
    for (const good of ['sch_01-AB', 'a'.repeat(40)]) problems.push(...expectValid(`id «${good.slice(0, 12)}»`, dailyRec('07:30', { id: good })))
    report(problems)
  })

  check('validateSchedule: запись с «__proto__» в теле не подменяет чужие прототипы', () => {
    const dirty = JSON.parse('{"id":"sch_proto","timeZone":"Europe/Berlin","kind":"daily","daily":{"time":"07:30"},"action":{"type":"note","text":"x"},"__proto__":{"polluted":"да"}}')
    assert.equal(Object.prototype.hasOwnProperty.call(dirty, '__proto__'), true, 'фикстура не годна: собственного поля __proto__ нет')
    let result
    assert.doesNotThrow(() => { result = call('validateSchedule', dirty) }, 'валидация чужого __proto__ роняет процесс')
    assert.ok(result && typeof result === 'object' && typeof result.ok === 'boolean', `нет объекта { ok, errors }: ${show(result)}`)
    // Главное последствие — дыра во всех объектах процесса, а не в одной записи.
    assert.equal({}.polluted, undefined, 'Object.prototype отравлен валидацией записи')
    assert.equal(Object.prototype.polluted, undefined, 'Object.prototype отравлен валидацией записи')
    assert.equal(([]).polluted, undefined, 'Array.prototype отравлен валидацией записи')
  })

  check('validateSchedule: каждая ошибка — это { field, code, message }', () => {
    const junkRecords = [null, {}, 'строка', dailyRec('24:00'), everyRec(0), weeklyRec('07:30', []),
      dailyRec('07:30', { timeZone: 'Europe/Berlinx' }), onceRec('завтра'), dailyRec('07:30', { id: 'a.b' }),
      cronRec('abc'), base({ kind: 'не-тот' }), dailyRec('07:30', { action: { type: 'sms' } })]
    const problems = []
    for (const record of junkRecords) {
      let result
      try {
        result = call('validateSchedule', record)
      } catch (error) {
        problems.push(`${show(record)}: исключение (${error.message})`)
        continue
      }
      if (!result || result.ok !== false || !Array.isArray(result.errors) || !result.errors.length) {
        problems.push(`${show(record)}: нет списка ошибок`)
        continue
      }
      for (const error of result.errors) {
        if (!error || typeof error !== 'object') { problems.push(`${show(record)}: ошибка не объект (${show(error)})`); continue }
        if (typeof error.field !== 'string' || !error.field.length) problems.push(`${show(record)}: у ошибки нет имени поля: ${show(error)}`)
        if (typeof error.code !== 'string' || !/^[a-z0-9_.-]+$/.test(error.code)) problems.push(`${show(record)}: код ошибки не метка в нижнем регистре: ${show(error)}`)
        if (typeof error.message !== 'string' || error.message.trim().length < 4) problems.push(`${show(record)}: сообщение пустое или непонятное: ${show(error)}`)
      }
    }
    report(problems)
  })

  check('validateSchedule: кривой cron даёт код cron_bad', () => {
    const problems = []
    for (const expression of ['abc', '', '* * * *', '70 * * * *']) {
      let result
      try {
        result = call('validateSchedule', cronRec(expression))
      } catch (error) {
        problems.push(`cron «${expression}»: бросило (${error.message})`)
        continue
      }
      if (!result || result.ok !== false) { problems.push(`cron «${expression}» прошёл как валидный`); continue }
      const codes = result.errors.map(error => String(error && error.code))
      if (!codes.includes('cron_bad')) problems.push(`cron «${expression}»: нет кода cron_bad [${codes.join(', ')}]`)
      if (!fieldsOf(result).map(f => f.toLowerCase()).some(field => field.includes('cron')))
        problems.push(`cron «${expression}»: в списке нет поля про cron [${fieldsOf(result).join(', ')}]`)
    }
    problems.push(...expectValid('cron верный', cronRec('30 7 * * 1-5')))
    report(problems)
  })

  check('validateSchedule: action обязано быть одной из трёх форм', () => {
    const problems = []
    problems.push(...expectValid('agent-turn с prompt', base({ kind: 'daily', daily: { time: '07:30' }, action: { type: 'agent-turn', prompt: 'разобрать ночь', chatId: 'chat-1' } })))
    problems.push(...expectValid('command с командой', base({ kind: 'daily', daily: { time: '07:30' }, action: { type: 'command', command: 'npm test' } })))
    problems.push(...expectInvalid('agent-turn без prompt', base({ kind: 'daily', daily: { time: '07:30' }, action: { type: 'agent-turn', chatId: 'chat-1' } }), ['action']))
    problems.push(...expectInvalid('command без команды', base({ kind: 'daily', daily: { time: '07:30' }, action: { type: 'command', command: '' } }), ['action']))
    problems.push(...expectInvalid('action неизвестного типа', dailyRec('07:30', { action: { type: 'sms', text: 'привет' } }), ['action']))
    problems.push(...expectInvalid('action без типа', dailyRec('07:30', { action: { text: 'привет' } }), ['action']))
    report(problems)
  })

  check('validateSchedule: lastError и history необязательны', () => {
    const problems = []
    problems.push(...expectValid('запись без lastError и history', dailyRec('07:30')))
    problems.push(...expectValid('запись с null lastError', dailyRec('07:30', { lastError: null, history: [] })))
    problems.push(...expectValid('запись с исходами', dailyRec('07:30', {
      lastError: 'прошлый запуск не дошёл',
      nextRunAt: T('2026-05-04T05:30:00.000Z'),
      lastRunAt: T('2026-05-03T05:30:00.000Z'),
      history: [{ at: T('2026-05-03T05:30:00.000Z'), ok: false, error: 'нет ответа' },
        { at: T('2026-05-02T05:30:00.000Z'), ok: true, runId: 'run-1' }]
    })))
    report(problems)
  })

  check('модель не хранит секретов: key или token в action отклоняются', () => {
    // Расписание лежит в electron-store открытым текстом: поле-ключ внутри action
    // сделало бы из плана хранилище секрета. Модель обязана такое не принимать.
    const problems = []
    problems.push(...expectInvalid('note с key', dailyRec('07:30', { action: { type: 'note', text: 'x', key: 'sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14' } }), ['action']))
    problems.push(...expectInvalid('agent-turn с token', base({ kind: 'daily', daily: { time: '07:30' }, action: { type: 'agent-turn', prompt: 'разбор', chatId: 'chat-1', token: 'ghp_AAAAAAAAAAAAAAAA' } }), ['action']))
    problems.push(...expectInvalid('command с apiKey', base({ kind: 'daily', daily: { time: '07:30' }, action: { type: 'command', command: 'npm test', apiKey: 'sk-abcdef123456' } }), ['action']))
    // И в сообщении секрет повторён быть не должен: оно доходит до `lastError`,
    // а там по контракту «текст без секретов».
    const result = call('validateSchedule', dailyRec('07:30', { action: { type: 'note', text: 'x', key: 'sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14' } }))
    if (JSON.stringify(result).includes('sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14'))
      problems.push('значение ключа повторено в списке ошибок: он поедет в lastError и в журнал')
    report(problems)
  })
}

// ---------------------------------------------------------------------------
// 2. parseCron — пять полей, диапазоны, шаг
// ---------------------------------------------------------------------------

function cronParseSuite() {
  const FIELDS = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek']

  check('parseCron: обычные выражения разбираются на пять полей', () => {
    const problems = []
    for (const expression of ['30 7 * * 1-5', '*/15 * * * *', '0 9 1,15 * *', '0 0 * * 0']) {
      let parsed
      try {
        parsed = call('parseCron', expression)
      } catch (error) {
        problems.push(`«${expression}»: бросило (${error.message})`)
        continue
      }
      if (!parsed || typeof parsed !== 'object') { problems.push(`«${expression}»: вернулось ${show(parsed)}, а ждался объект`); continue }
      const missing = FIELDS.filter(field => !(field in parsed))
      if (missing.length) problems.push(`«${expression}»: нет полей ${missing.join(', ')}`)
      if (Array.isArray(parsed.minute) && !parsed.minute.length) problems.push(`«${expression}»: список минут пустой`)
    }
    report(problems)
  })

  check('parseCron: день недели 7 принимается как воскресенье', () => {
    assert.ok(call('parseCron', '0 0 * * 0'), '«0 0 * * 0» не разобралось')
    assert.ok(call('parseCron', '0 0 * * 7'), '«0 0 * * 7» отклонено, хотя контракт разрешает день недели 0-7')
    // Что 7 == 0 по смыслу, а не по совпадению разбора, — закреплено на nextAfter.
  })

  check('parseCron: шаг в диапазоне 1-30/5 и списки с шагом', () => {
    const problems = []
    for (const expression of ['0 0 1-30/5 * *', '0 9 1-15/2 * 1,3', '5-35/10 * * * *']) {
      let parsed
      try { parsed = call('parseCron', expression) } catch (error) { problems.push(`«${expression}»: бросило (${error.message})`); continue }
      if (!parsed) problems.push(`«${expression}»: null, а контракт разрешает «1-30/5»`)
    }
    report(problems)
  })

  check('parseCron: отказ на значении вне диапазона (70 и 60 минут, 24 часа)', () => {
    const problems = []
    for (const expression of ['70 * * * *', '60 * * * *', '0 24 * * *', '* 60 * * *', '-1 * * * *']) {
      let parsed
      try { parsed = call('parseCron', expression) } catch (error) { problems.push(`«${expression}»: бросило (${error.message})`); continue }
      if (parsed !== null && parsed !== undefined) problems.push(`«${expression}»: принято (${show(parsed)}), а ждался null`)
    }
    report(problems)
  })

  check('parseCron: отказ на неверном числе полей (четыре и шесть)', () => {
    const problems = []
    // Контракт: ровно пять полей. Отказ на «* * * *» закреплён заказчиком; шесть
    // полей и одно поле отклоняются по тому же правилу.
    for (const expression of ['* * * *', '30 7 * * 1-5 2', '* *', '*', '   ']) {
      let parsed
      try { parsed = call('parseCron', expression) } catch (error) { problems.push(`«${expression}»: бросило (${error.message})`); continue }
      if (parsed !== null && parsed !== undefined) problems.push(`«${expression}»: принято, а контракт требует ровно пять полей`)
    }
    report(problems)
  })

  check('parseCron: отказ на «abc», пустой строке и шаге «*/0»', () => {
    const problems = []
    for (const expression of ['abc', '', '*/0 * * * *', 'a b c d e', '0 0 * * mon', '1-5/x * * * *', '*/0 0 * * *']) {
      let parsed
      try { parsed = call('parseCron', expression) } catch (error) { problems.push(`«${expression}»: бросило (${error.message})`); continue }
      if (parsed !== null && parsed !== undefined) problems.push(`«${expression}»: принято (${show(parsed)}), а ждался null`)
    }
    // Мусор на входе — null на выходе, а не исключение: так же ведут себя
    // `redactSecrets` и разбор графа.
    for (const junk of [null, undefined, 42, {}, []]) {
      let parsed
      try { parsed = call('parseCron', junk) } catch (error) { problems.push(`parseCron(${show(junk)}) бросило (${error.message})`); continue }
      if (parsed !== null && parsed !== undefined) problems.push(`parseCron(${show(junk)}) вернуло ${show(parsed)}`)
    }
    report(problems)
  })

  check('parseCron: отказ на дне недели вне 0-7, месяце вне 1-12, дне месяца вне 1-31', () => {
    const problems = []
    for (const expression of ['* * * * 8', '0 0 * 13 *', '0 0 32 * *', '0 0 * 0 *', '0 0 0 * *']) {
      let parsed
      try { parsed = call('parseCron', expression) } catch (error) { problems.push(`«${expression}»: бросило (${error.message})`); continue }
      if (parsed !== null && parsed !== undefined) problems.push(`«${expression}»: принято, а значение вне диапазона`)
    }
    report(problems)
  })
}

// ---------------------------------------------------------------------------
// 3. nextAfter — interval: чистый UTC-шаг от from
// ---------------------------------------------------------------------------

function intervalSuite() {
  check('nextAfter interval: обычный шаг от from', () => {
    const record = everyRec(90)
    const problems = []
    // Отсчёт — от `from` в UTC, стена в нём не участвует (контракт, правило 1).
    const cases = [
      [T0 + 10 * MINUTE, T0 + 90 * MINUTE],
      [T0 + 89 * MINUTE, T0 + 90 * MINUTE],
      [T0 + 90 * MINUTE, T0 + 180 * MINUTE],
      [T0 + 200 * MINUTE, T0 + 270 * MINUTE]
    ]
    for (const [now, want] of cases) {
      const got = nextOf(record, now)
      if (got !== want) problems.push(`now ${iso(now)}: ${got === null ? 'null' : iso(got)}, ждалось ${iso(want)}`)
    }
    report(problems)
  })

  check('nextAfter interval: никогда не возвращает мгновение не позже nowMs', () => {
    const record = everyRec(90)
    const problems = []
    for (const now of [T0, T0 - DAY, T0 + 90 * MINUTE, T0 + 91 * MINUTE, T0 + 400 * DAY]) {
      const got = nextOf(record, now)
      if (got === null) problems.push(`now ${iso(now)}: null для живого интервала`)
      else if (got <= now) problems.push(`now ${iso(now)}: вернулся ${iso(got)} — не позже nowMs, такой запуск повторялся бы вечно`)
    }
    report(problems)
  })

  check('nextAfter interval: run-once после долгого сна догоняет ровно один запуск', () => {
    // Спал пять с половиной часов при шаге в час: сетка накопила пять пропусков.
    const record = everyRec(60, T0, { misfire: 'run-once', lastRunAt: T0 })
    const now = T0 + 5 * HOUR + 30 * MINUTE
    const caught = nextOf(record, now)
    assert.ok(caught !== null, 'после сна интервал умер вместо одного догоняющего запуска')
    // Догоняющий обязано быть из пропущенных: на сетке, позже последнего запуска,
    // не позже «сейчас».
    assert.ok(caught > T0, `догоняющий ${iso(caught)} не позже последнего запуска ${iso(T0)}`)
    assert.equal((caught - T0) % HOUR, 0, `догоняющий ${iso(caught)} не на сетке шага от from`)
    assert.ok(caught <= now, `misfire run-once не догнал пропуск: ${iso(caught)} позже nowMs ${iso(now)}`)
    // Берётся ПОСЛЕДНИЙ пропущенный слот, а не самый ранний: иначе чистая функция
    // по { from, lastRunAt, nowMs } обязана будет выдавать пропуски и дальше, то
    // есть ровно та «очередь из догнать 40 запусков», которую контракт запрещает.
    // См. возражение к контракту.
    assert.equal(caught, T0 + 5 * HOUR, `догнан ${iso(caught)}, а не последний пропущенный слот ${iso(T0 + 5 * HOUR)} — ранний слот означает очередь`)
    // Дальше — обычная сетка, а не второй догон (контракт, правило 5).
    const after = nextOf({ ...record, lastRunAt: caught }, now)
    assert.ok(after !== null && after > now, `после одного догона выдан второй пропущенный (${after === null ? 'null' : iso(after)}), а не обычная сетка вперёд`)
    assert.equal(after, T0 + 6 * HOUR, `после догона ждался следующий слот ${iso(T0 + 6 * HOUR)}, а не ${after === null ? 'null' : iso(after)}`)
  })

  check('nextAfter interval: skip после долгого сна пересчитывает вперёд, пропусков не копит', () => {
    const record = everyRec(60, T0, { misfire: 'skip', lastRunAt: T0 })
    const now = T0 + 40 * HOUR
    const got = nextOf(record, now)
    assert.ok(got !== null, 'skip вернул null: расписание умерло после одного долгого сна')
    assert.ok(got > now, `skip вернул пропущенный ${iso(got)} <= nowMs ${iso(now)} — пропуски догоняются, хотя misfire skip`)
    assert.equal((got - T0) % HOUR, 0, `skip сошёл с сетки: ${iso(got)}`)
    assert.ok(got - now <= HOUR, `skip ушёл слишком далеко вперёд: ${iso(got)} вместо первого слота после nowMs`)
  })

  check('nextAfter interval: без misfire ведёт себя как skip', () => {
    // `misfire: 'skip'` — значение по умолчанию (контракт, правило 5).
    const record = everyRec(60, T0, { lastRunAt: T0 })
    delete record.misfire
    const now = T0 + 20 * HOUR
    const got = nextOf(record, now)
    assert.ok(got !== null && got > now, `без misfire получено ${got === null ? 'null' : iso(got)}, а ожидался пересчёт вперёд от nowMs`)
    assert.equal(got, nextOf({ ...record, misfire: 'skip' }, now), 'пропуск по умолчанию спорит с явным skip')
  })

  check('nextAfter interval: монотонность — цепочка из 200 запусков строго растёт', () => {
    const record = everyRec(90)
    let now = T0
    let previous = -Infinity
    const problems = []
    for (let i = 0; i < 200; i++) {
      const got = nextOf(record, now)
      if (got === null) { problems.push(`на итерации ${i} появился null`); break }
      if (got <= now) problems.push(`на итерации ${i}: ${iso(got)} не позже nowMs ${iso(now)}`)
      if (got <= previous) problems.push(`на итерации ${i}: ${iso(got)} не больше предыдущего ${iso(previous)} — цепочка встала`)
      previous = got
      now = got
    }
    report(problems)
  })

  check('nextAfter interval: произвольные nowMs — результат не убывает', () => {
    // Контракт (раздел «Границы») обещает строгий рост при n1 < n2. Для сетки это
    // выполнимо только как НЕУБЫВАНИЕ: две разные точки внутри одного шага дают
    // один и тот же следующий слот. Строгий рост закреплён на цепочке выше, здесь —
    // что часы не идут назад. См. возражение к контракту.
    const record = everyRec(90)
    let previous = -Infinity
    const problems = []
    for (let i = 0; i < 200; i++) {
      const now = T0 + i * 7 * MINUTE
      const got = nextOf(record, now)
      if (got === null) { problems.push(`now ${iso(now)}: null`); break }
      if (got < previous) problems.push(`now ${iso(now)}: ${iso(got)} раньше результата для более раннего nowMs (${iso(previous)}) — время пошло назад`)
      previous = got
    }
    report(problems)
  })
}

// ---------------------------------------------------------------------------
// 4. nextAfter — daily/weekly в Europe/Berlin: стена, переходы, полночь
// ---------------------------------------------------------------------------

function wallSuite() {
  check('nextAfter daily: обычный день в Europe/Berlin', () => {
    const record = dailyRec('07:30')
    const now = T('2026-04-01T00:00:00.000Z') // Берлин: 02:00 того же дня
    assert.equal(nextOf(record, now), T('2026-04-01T05:30:00.000Z'), 'обычный день считает не от стены пояса записи')
    assert.equal(wallDate('Europe/Berlin', nextOf(record, now)), '2026-04-01', 'следующий запуск уехал в другую календарную дату')
  })

  check('nextAfter daily: осенний переход 26.10.2025 — один запуск, раннее мгновение 00:30Z', () => {
    const got = nextOf(dailyRec('02:30'), T('2025-10-25T12:00:00.000Z'))
    // Стена «02:30 26 октября» бывает дважды (00:30Z и 01:30Z); берём РАННЕЕ.
    assert.equal(got, AUTUMN_EARLY, `осенний переход дал ${got === null ? 'null' : iso(got)}, а контракт требует раннее ${iso(AUTUMN_EARLY)}`)
    assert.equal(wallDate('Europe/Berlin', got), '2025-10-26', 'запуск уехал с даты перехода')
  })

  check('nextAfter daily: осенью двойного запуска нет ни при каком nowMs', () => {
    const record = dailyRec('02:30')
    const problems = []
    const probes = [
      [T('2025-10-26T00:00:00.000Z'), AUTUMN_EARLY, 'до обоих 02:30'],
      [AUTUMN_EARLY, AUTUMN_NEXT_DAY, 'сразу после раннего: следующий день, а не поздний 02:30'],
      [T('2025-10-26T01:00:00.000Z'), AUTUMN_NEXT_DAY, 'между двумя 02:30'],
      [T('2025-10-26T01:20:00.000Z'), AUTUMN_NEXT_DAY, 'вторая стена 02:20: поздний двойник уже не должен появляться'],
      [AUTUMN_LATE, AUTUMN_NEXT_DAY, 'ровно на позднем 02:30: его быть не должно']
    ]
    for (const [now, want, why] of probes) {
      const got = nextOf(record, now)
      if (got === AUTUMN_LATE) problems.push(`${why}: вернулся поздний двойник ${iso(AUTUMN_LATE)} — в один день два запуска`)
      else if (got !== want) problems.push(`${why}: ${got === null ? 'null' : iso(got)}, ждалось ${iso(want)}`)
    }
    report(problems)
  })

  check('nextAfter daily: весенний переход 29.03.2026 — запуск в конце прыжка 01:00Z', () => {
    const got = nextOf(dailyRec('02:30'), T('2026-03-28T12:00:00.000Z'))
    // Стены «02:30 29 марта» в Берлине нет ни в одном мгновении.
    assert.equal(got, SPRING_END, `29.03 02:30 дало ${got === null ? 'null' : iso(got)}, а контракт требует конец прыжка ${iso(SPRING_END)} (на стене уже 03:00)`)
    assert.notEqual(got, SPRING_LATE, 'запуск перенесён на стену 03:30 — контракт это запрещает')
    assert.equal(wallDate('Europe/Berlin', got), '2026-03-29', 'день перехода пропущен молча: запуск уехал на другую дату')
  })

  check('nextAfter daily: после весеннего перехода обычная сетка продолжается', () => {
    const record = dailyRec('02:30')
    const nextDay = nextOf(record, SPRING_END)
    assert.equal(nextDay, T('2026-03-30T00:30:00.000Z'), `следующий после перехода — ${nextDay === null ? 'null' : iso(nextDay)}, а ждалось 30.03 02:30 по Берлину`)
    assert.equal(wallDate('Europe/Berlin', nextDay), '2026-03-30', 'после перехода сетка дней съехала')
    // Днём раньше прыжка ничего ещё не видно: обычный день, обычный 01:30Z.
    assert.equal(nextOf(record, T('2026-03-28T00:00:00.000Z')), T('2026-03-28T01:30:00.000Z'), 'день до перехода живёт не по своим часам')
  })

  check('nextAfter daily: смена пояса пересчитывает, а не досчитывает', () => {
    // 2026-04-01T00:00Z — это в Берлине 02:00 того же дня, а в Нью-Йорке ещё
    // 2026-03-31 20:00: дата «сегодня» тоже разъезжается.
    const now = T('2026-04-01T00:00:00.000Z')
    const berlinGot = nextOf(dailyRec('07:30', { timeZone: 'Europe/Berlin' }), now)
    const newYorkGot = nextOf(dailyRec('07:30', { timeZone: 'America/New_York' }), now)
    assert.equal(berlinGot, T('2026-04-01T05:30:00.000Z'), 'Берлин 07:30 считает не по своей стене')
    assert.equal(newYorkGot, T('2026-04-01T11:30:00.000Z'), 'Нью-Йорк 07:30 считает не по своей стене')
    assert.notEqual(newYorkGot, berlinGot, 'пояс поменяли, а следующий запуск остался старым')
    assert.equal(wallDate('America/New_York', newYorkGot), '2026-04-01', 'после смены пояса локальная дата запуска уехала')
  })

  check('nextAfter: opts.nowZone не перекрывает пояс записи', () => {
    // nowMs абсолютный, а стена считается в timeZone записи (правила 1 и 4),
    // поэтому «зона сейчас» из opts не имеет права двигать следующий запуск.
    const record = dailyRec('07:30', { timeZone: 'Europe/Berlin' })
    const now = T('2026-04-01T00:00:00.000Z')
    const plain = nextOf(record, now)
    for (const nowZone of ['America/New_York', 'Asia/Tokyo', 'Australia/Eucla'])
      assert.equal(nextOf(record, now, { nowZone }), plain, `opts.nowZone «${nowZone}» сдвинул следующий запуск ${iso(plain)}`)
  })

  check('nextAfter daily: переход через полночь', () => {
    // 10.04 23:00Z = в Берлине уже суббота 11.04 01:00. Заказано 00:30, значит
    // этот день прошёл и следующий запуск — воскресенье 12.04 00:30 по Берлину,
    // то есть 11.04 22:30Z: UTC-дата ОТЛИЧАЕТСЯ от локальной.
    const got = nextOf(dailyRec('00:30'), T('2026-04-10T23:00:00.000Z'))
    assert.equal(got, T('2026-04-11T22:30:00.000Z'), `полночь перехода дала ${got === null ? 'null' : iso(got)}`)
    assert.equal(wallDate('Europe/Berlin', got), '2026-04-12', 'запуск остался в старой локальной дате')
  })

  check('nextAfter daily: переход через конец месяца и через конец года', () => {
    const record = dailyRec('07:30')
    const monthEnd = nextOf(record, T('2026-01-31T08:00:00.000Z')) // Берлин: суббота 09:00
    assert.equal(monthEnd, T('2026-02-01T06:30:00.000Z'), `конец месяца дал ${monthEnd === null ? 'null' : iso(monthEnd)}`)
    assert.equal(wallDate('Europe/Berlin', monthEnd), '2026-02-01', 'месяц не переехал')
    const yearEnd = nextOf(record, T('2025-12-31T10:00:00.000Z'))
    assert.equal(yearEnd, T('2026-01-01T06:30:00.000Z'), `конец года дал ${yearEnd === null ? 'null' : iso(yearEnd)}`)
    assert.equal(wallDate('Europe/Berlin', yearEnd), '2026-01-01', 'год не переехал')
  })

  check('nextAfter weekly: [0] — по воскресеньям', () => {
    // 1 апреля 2026 — среда; ближайшее воскресенье — 5 апреля.
    const record = weeklyRec('07:30', [0])
    const got = nextOf(record, T('2026-04-01T00:00:00.000Z'))
    assert.equal(got, T('2026-04-05T05:30:00.000Z'), `[0] дало ${got === null ? 'null' : iso(got)}, а ждалось воскресенье 05.04 07:30 по Берлину`)
    assert.equal(wallDate('Europe/Berlin', got), '2026-04-05', 'воскресенье не то')
    const next = nextOf(record, got)
    assert.equal(next, T('2026-04-12T05:30:00.000Z'), `неделя считает не по семь дней: ${next === null ? 'null' : iso(next)}`)
  })

  check('nextAfter weekly: [1,3,5] идёт по сетке будней', () => {
    // Среда 06:00 по Берлину: 07:30 того же дня, потом пятница, потом понедельник.
    const record = weeklyRec('07:30', [1, 3, 5])
    const first = nextOf(record, T('2026-04-01T04:00:00.000Z'))
    assert.equal(first, T('2026-04-01T05:30:00.000Z'), `среду пропустили: ${first === null ? 'null' : iso(first)}`)
    const second = nextOf(record, first)
    assert.equal(second, T('2026-04-03T05:30:00.000Z'), `вторая итерация дала ${second === null ? 'null' : iso(second)}, ждалась пятница`)
    const third = nextOf(record, second)
    assert.equal(third, T('2026-04-06T05:30:00.000Z'), `третья итерация дала ${third === null ? 'null' : iso(third)}, ждался понедельник`)
  })

  check('nextAfter weekly: осенний переход тоже один запуск', () => {
    // 26.10.2025 — воскресенье: тот же двойник 02:30, правило одно на календарную дату.
    const record = weeklyRec('02:30', [0])
    const got = nextOf(record, T('2025-10-25T12:00:00.000Z'))
    assert.equal(got, AUTUMN_EARLY, `weekly в день перехода дало ${got === null ? 'null' : iso(got)}, ждалось раннее ${iso(AUTUMN_EARLY)}`)
    const next = nextOf(record, got)
    assert.equal(next, T('2025-11-02T01:30:00.000Z'), `второй запуск того же дня: ${next === null ? 'null' : iso(next)} вместо воскресенья 02.11 02:30 по Берлину`)
    assert.equal(wallDate('Europe/Berlin', next), '2025-11-02', 'неделя после перехода съехала')
  })
}

// ---------------------------------------------------------------------------
// 5. nextAfter — cron и once
// ---------------------------------------------------------------------------

function cronAndOnceSuite() {
  check('nextAfter cron: будни в 07:30 (30 7 * * 1-5)', () => {
    const record = cronRec('30 7 * * 1-5')
    // Среда 06:00 по Берлину — сегодня ещё успеем.
    assert.equal(nextOf(record, T('2026-04-01T04:00:00.000Z')), T('2026-04-01T05:30:00.000Z'), 'будний день пропущен')
    // Суббота: следующий запуск понедельник, а не «через два дня по сетке».
    const sat = nextOf(record, T('2026-04-04T12:00:00.000Z'))
    assert.equal(sat, T('2026-04-06T05:30:00.000Z'), `суббота дала ${sat === null ? 'null' : iso(sat)}, ждался понедельник`)
    assert.equal(wallDate('Europe/Berlin', sat), '2026-04-06', 'выходные не перепрыгнуты')
    // Ровно на запуске — следующий, а не тот же.
    assert.equal(nextOf(record, T('2026-04-01T05:30:00.000Z')), T('2026-04-02T05:30:00.000Z'), 'nowMs на сетке вернул тот же запуск')
  })

  check('nextAfter cron: правило vixie — совпадение ЛЮБОГО из ограниченных дней', () => {
    // Ограничены и день месяца (13), и день недели (5 = пятница): по vixie
    // срабатывает ЛЮБОЕ совпадение. Интуитивно читается как «и» — поэтому и тест.
    const got = nextOf(cronRec('0 12 13 * 5'), T('2026-04-01T00:00:00.000Z')) // среда
    assert.equal(got, T('2026-04-03T10:00:00.000Z'), `пятница 3 апреля не признана запуском: ${got === null ? 'null' : iso(got)}`)
    assert.notEqual(got, T('2026-04-13T10:00:00.000Z'), 'выбрано «13-е И пятница», а контракт говорит «или»')
    assert.equal(wallDate('Europe/Berlin', got), '2026-04-03', 'дата запуска не та')
  })

  check('nextAfter cron: шаг */15 по минутам', () => {
    const record = cronRec('*/15 * * * *')
    // 09:07Z = 11:07 по Берлину: следующая кратная 15 минута стены — 11:15 = 09:15Z.
    const got = nextOf(record, T('2026-04-01T09:07:00.000Z'))
    assert.equal(got, T('2026-04-01T09:15:00.000Z'), `шаг */15 дал ${got === null ? 'null' : iso(got)}`)
    const second = nextOf(record, got)
    const third = nextOf(record, second)
    assert.deepEqual([got, second, third].map(one => one - got), [0, 15 * MINUTE, 30 * MINUTE],
      `цепочка шага не равна 15 минутам: ${[got, second, third].map(show).join(', ')}`)
  })

  check('nextAfter cron: 0 0 * * 0 и 0 0 * * 7 дают одно и то же', () => {
    const now = T('2026-04-01T00:00:00.000Z')
    const zero = nextOf(cronRec('0 0 * * 0'), now)
    const seven = nextOf(cronRec('0 0 * * 7'), now)
    assert.equal(zero, T('2026-04-04T22:00:00.000Z'), `ближайшее воскресенье найдено не по Берлину: ${zero === null ? 'null' : iso(zero)}`)
    assert.equal(seven, zero, '7 принят не как воскресенье: два вырашения разошлись')
  })

  check('nextAfter cron: невозможная дата (30 февраля) возвращает null и не зависает', () => {
    // 30 февраля не бывает: поиск обязан быть ограниченным и честно сказать «никогда».
    const started = Date.now()
    const got = nextOf(cronRec('30 7 30 2 *'), T('2026-01-01T00:00:00.000Z'))
    const spent = Date.now() - started
    assert.equal(got, null, `невозможная дата вернула ${got === null ? 'null' : iso(got)} вместо честного null`)
    // Захват от вечного цикла: заведомо щедрый предел, иначе проверка красна от
    // медленного диска, а не от кода.
    assert.ok(spent < 3000, `поиск невозможной даты занял ${spent} мс — он не ограничен`)
  })

  check('nextAfter на мусорной и невалидной записи возвращает null и не бросает', () => {
    const now = T('2026-04-01T00:00:00.000Z')
    for (const junk of [null, undefined, 'расписание', 42, {}, [], dailyRec('24:00'), cronRec('abc'),
      weeklyRec('07:30', []), base({ kind: 'нет-такого' }), dailyRec('07:30', { timeZone: 'Europe/Berlinx' })]) {
      let got
      assert.doesNotThrow(() => { got = nextOf(junk, now) }, `nextAfter на ${show(junk)} бросил`)
      assert.equal(got, null, `${show(junk)} дало ${got === null ? 'null' : iso(got)}: невалидное расписание обязано быть null`)
    }
  })

  check('nextAfter once: будущая дата возвращается как есть', () => {
    const record = onceRec('2027-04-01T07:30:00+02:00')
    assert.equal(nextOf(record, T('2026-05-01T00:00:00.000Z')), T('2027-04-01T05:30:00.000Z'), 'once считает не по смещению из ISO')
    // За миллисекунду до запуска — всё ещё он же.
    assert.equal(nextOf(record, T('2027-04-01T05:29:59.999Z')), T('2027-04-01T05:30:00.000Z'), 'последняя миллисекунда потеряла запуск')
  })

  check('nextAfter once: прошедшая дата — null, повторного запуска нет', () => {
    const record = onceRec('2020-01-01T00:30:00+02:00') // 2019-12-31T22:30Z
    assert.equal(nextOf(record, T('2026-04-01T00:00:00.000Z')), null, 'истёкший once притворяется живым')
    // Ровно на мгновении запуска — тоже null: nextAfter отвечает «что дальше».
    assert.equal(nextOf(record, T('2019-12-31T22:30:00.000Z')), null, 'nowMs на запуске вернул сам запуск')
    // И после «исполненного» once ничего не продолжает сетку.
    assert.equal(nextOf({ ...record, lastRunAt: T('2019-12-31T22:30:00.000Z') }, T('2026-04-01T00:00:00.000Z')), null, 'истёкший once завёл собственную сетку')
  })

  check('nextAfter once: смена пояса не превращает прошедшее в будущее', () => {
    // `once.at` — абсолютный миг со своим смещением (2026-04-11T22:30Z). nowMs
    // выбран между ним и тем же 00:30, перечитанным в Нью-Йорке (2026-04-12T04:30Z):
    // если реализация пересчитывает ISO по `timeZone` записи, прошедшее оживёт.
    const at = '2026-04-12T00:30:00+02:00'
    const now = T('2026-04-11T23:00:00.000Z')
    assert.equal(nextOf(onceRec(at, { timeZone: 'Europe/Berlin' }), now), null, 'once в Берлине пропущен или перенесён')
    assert.equal(nextOf(onceRec(at, { timeZone: 'America/New_York' }), now), null, 'правка пояса вернула прошедший запуск к жизни')
    assert.equal(nextOf(onceRec(at, { timeZone: 'Pacific/Kiritimati' }), now), null, 'за два пояса вперёд once тоже не должен ожить')
  })
}

// ---------------------------------------------------------------------------
// 6. describeNext и защёлки: часы машины, детерминизм, отсутствие мутаций
// ---------------------------------------------------------------------------

function textAndLocksSuite() {
  check('describeNext: не бросает на мусорных записях', () => {
    const now = T('2026-04-01T00:00:00.000Z')
    for (const junk of [null, undefined, 'расписание', 42, {}, [], dailyRec('24:00'), cronRec('abc'),
      weeklyRec('07:30', []), onceRec('завтра'), dailyRec('07:30', { timeZone: 'Europe/Berlinx' })]) {
      let text
      assert.doesNotThrow(() => { text = call('describeNext', junk, now) }, `describeNext на ${show(junk)} бросил`)
      assert.equal(typeof text, 'string', `describeNext вернул ${show(text)}, а не строку`)
    }
  })

  check('describeNext: daily 07:30 Europe/Berlin называет и время, и пояс', () => {
    const text = String(call('describeNext', dailyRec('07:30'), T('2026-04-01T00:00:00.000Z')))
    assert.match(text, /07:30/, `в строке нет заказанного времени: ${text}`)
    assert.match(text, /Europe\/Berlin/, `в строке нет пояса записи: ${text}`)
  })

  check('describeNext: все пять родов записей идут через переданный переводчик', () => {
    // Без переводчика модуль остаётся на исходном русском — это правильно.
    // С переводчиком он обязан отдать ему каждый шаблон, иначе английское
    // окно показал бы русские слова, а словарь бы молчал.
    const seen = []
    const say = (template, ...args) => { seen.push([template, args.length]); return `EN(${template}|${args.length})` }
    const now = T('2026-04-01T00:00:00.000Z')
    const records = [onceRec('2027-04-01T07:30:00+02:00'), everyRec(90), dailyRec('07:30'),
      weeklyRec('07:30', [1, 3]), cronRec('30 7 * * 1-5'), dailyRec('24:00')]
    const texts = records.map(record => String(call('describeNext', record, now, say)))
    assert.equal(texts.every(text => text.startsWith('EN(')), true, `переводчик обошёл часть родов: ${texts.join(' | ')}`);
    assert.equal(seen.length >= records.length, true, `шаблонов передано ${seen.length} на ${records.length} записей`)
    // Подстановки не теряются: время и пояс живут в аргументах, а не в ключе.
    assert.ok(seen.some(([template, args]) => /%s/.test(template) && args >= 1),
      'ни один шаблон не передан с подстановкой: даты уехали бы в ключ словаря')
    const plain = String(call('describeNext', dailyRec('07:30'), now))
    assert.equal(/EN\(/.test(plain), false, 'без переводчика английский макет просочился в русский текст')
  })

  check('describeNext: нигде нет undefined, NaN и Invalid', () => {
    const now = T('2026-04-01T00:00:00.000Z')
    const records = [dailyRec('07:30'), weeklyRec('07:30', [1, 3, 5]), cronRec('30 7 * * 1-5'),
      everyRec(90), onceRec('2027-04-01T07:30:00+02:00'), dailyRec('02:30', { timeZone: 'America/New_York' })]
    const problems = []
    for (const record of records) {
      const text = String(call('describeNext', record, now))
      if (!text.trim().length) problems.push(`${record.kind}: пустая строка, человеку нечего показать`)
      if (/undefined|NaN|Invalid/.test(text)) problems.push(`${record.kind}: «${text}»`)
    }
    report(problems)
  })

  check('nextAfter зависит только от nowMs, а не от часов машины', () => {
    // Единственное место, где набор трогает Date.now() как данные: крутим, пока
    // настоящие часы точно сдвинутся, и требуем тот же ответ на том же nowMs.
    const record = dailyRec('07:30')
    const now = T('2026-04-01T00:00:00.000Z')
    const first = nextOf(record, now)
    const started = Date.now()
    while (Date.now() - started < 3) { /* ждём сдвига стенных часов процесса */ }
    assert.notEqual(Date.now(), started, 'часы машины не сдвинулись — проверка ничего не доказала бы')
    assert.equal(nextOf(record, now), first, 'тот же nowMs дал другой ответ: функция смотрит в Date.now()')
    assert.equal(String(call('describeNext', record, now)), String(call('describeNext', record, now)), 'describeNext не детерминирован на одном nowMs')
  })

  check('функции не мутируют запись: повторный вызов даёт тот же результат', () => {
    const record = dailyRec('07:30')
    const before = JSON.stringify(record)
    const now = T('2026-04-01T00:00:00.000Z')
    const first = nextOf(record, now)
    const second = nextOf(record, now)
    call('validateSchedule', record)
    call('parseCron', '30 7 * * 1-5')
    String(call('describeNext', record, now))
    assert.equal(JSON.stringify(record), before, 'чистые функции переписали запись')
    assert.equal(second, first, `тот же вход дал ${show(second)} вместо ${show(first)}`)
    // Хранёный nextRunAt не перечёркивает nowMs: то же мгновение — тот же ответ.
    const withNext = dailyRec('07:30', { nextRunAt: T('2026-04-01T05:30:00.000Z') })
    assert.equal(nextOf(withNext, now), T('2026-04-01T05:30:00.000Z'), 'nextRunAt в записи сбитым не считается, но и не противоречит nowMs')
  })
}

function propertySuite() {
  check('свойство: запуск всегда на целой минуте и строго растёт (13 поясов, 7 времён)', () => {
    // Замечание Codex: при несуществующей стенке поиск не должен выдавать
    // «артефакт следующей секунды». Пояса выбраны с разными формами перехода:
    // получасовой шаг (Лорд Хау, Чатем), смещение не кратно часу (Катманду,
    // Тегеран), южное полушарие и исторические сдвиги.
    const zones = ['Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe', 'America/Santiago',
      'Asia/Tehran', 'Europe/Dublin', 'Australia/Sydney', 'Pacific/Chatham', 'America/Havana',
      'Europe/Lisbon', 'Asia/Kathmandu', 'America/Sao_Paulo', 'UTC']
    const times = ['00:00', '00:30', '01:30', '02:30', '03:00', '03:30', '23:30']
    const starts = ['2024-01-01', '2025-01-01', '2026-01-01', '2026-03-01', '2026-10-01']
    const problems = []
    let fired = 0
    for (const timeZone of zones) {
      for (const time of times) {
        const record = dailyRec(time, { timeZone })
        for (const start of starts) {
          let now = T(start + 'T00:00:00.000Z')
          for (let i = 0; i < 40; i++) {
            const got = nextOf(record, now)
            if (got === null) break
            fired++
            if (got % MINUTE !== 0) problems.push(`${timeZone} ${time}: ${iso(got)} — не граница минуты`)
            if (got <= now) problems.push(`${timeZone} ${time}: ${iso(got)} не позже ${iso(now)}`)
            if (problems.length > 6) break
            now = got
          }
        }
      }
    }
    assert.ok(fired > 10000, `свойство мерялось на ${fired} запусках — этого мало`)
    report([...new Set(problems)].slice(0, 6))
  })
}

validateSuite()
cronParseSuite()
intervalSuite()
wallSuite()
cronAndOnceSuite()
textAndLocksSuite()
propertySuite()

if (!model) console.error(`src/main/schedule-model.js отсутствует (${loadError}) — весь набор красным, и это правильно`)
console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
