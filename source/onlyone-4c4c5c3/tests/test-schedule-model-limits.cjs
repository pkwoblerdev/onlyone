// break-4 Н12+Н14: редкий cron и длина просьбы расписания.
//
// Н12: окно поиска MAX_DAYS=800 не покрывало разрыв между 29 февраля (4 года,
// 1460 дней; через невисокосный век — 8 лет): nextAfter возвращал null, а
// validateSchedule говорил «валидно» — расписание молча никогда не исполнялось.
// Н14: просьба на 200 КБ принималась без ограничения; 50 расписаний давали файл
// 20 МБ и 265 мс главного процесса на одну запись журнала (три перезаписи за прогон).
//
// Отрицательные контроли: невозможная дата («30 февраля») по-прежнему честно null
// и не съедает процесс; обычная просьба и ежедневный cron не задеты; граница
// длины включительно принимается.

const assert = require('node:assert/strict')
const path = require('node:path')
const model = require(path.join(__dirname, '..', 'src', 'main', 'schedule-model.js'))

let failed = 0
let total = 0
function check (name, fn) {
  total++
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message))
  }
}

const cronRecord = expression => ({
  id: 's1', name: 'редкий', kind: 'cron', timeZone: 'UTC', enabled: true,
  cron: { expression }, action: { type: 'note', text: 'раз в четыре года' }
})

// Н12: после 1 марта високосного года ближайшее 29 февраля дальше 800 дней.
check('Н12: cron «29 февраля» находит следующий високосный год', () => {
  const record = cronRecord('0 0 29 2 *')
  assert.equal(model.validateSchedule(record).ok, true, 'выражение законно')
  const now = Date.parse('2028-03-01T00:00:00Z')
  const at = model.nextAfter(record, now)
  assert.equal(at, Date.parse('2032-02-29T00:00:00Z'),
    'ожидалось 29.02.2032, получено ' + (at === null ? 'null' : new Date(at).toISOString()))
})

// Н12: век без високосного года (2100) — разрыв 2096→2104 больше 2000 дней.
check('Н12: cron «29 февраля» переживает невисокосный век (2096→2104)', () => {
  const record = cronRecord('0 0 29 2 *')
  const now = Date.parse('2096-03-01T00:00:00Z')
  const at = model.nextAfter(record, now)
  assert.equal(at, Date.parse('2104-02-29T00:00:00Z'),
    'ожидалось 29.02.2104, получено ' + (at === null ? 'null' : new Date(at).toISOString()))
})

// Отрицательный контроль: невозможная дата остаётся null и поиск ограничен.
check('Н12 контроль: «30 февраля» — null, без зависания', () => {
  const record = cronRecord('0 0 30 2 *')
  const started = Date.now()
  const at = model.nextAfter(record, Date.parse('2026-11-11T00:00:00Z'))
  const elapsed = Date.now() - started
  assert.equal(at, null)
  assert.ok(elapsed < 2000, 'поиск занял ' + elapsed + ' мс — окно не съедает процесс')
})

// Контроль: ежедневный cron не задет окном.
check('Н12 контроль: ежедневный cron находит завтра', () => {
  const record = cronRecord('0 9 * * *')
  const at = model.nextAfter(record, Date.parse('2026-11-11T10:00:00Z'))
  assert.equal(at, Date.parse('2026-11-12T09:00:00Z'))
})

const turnRecord = prompt => ({
  id: 's2', name: 'просьба', kind: 'daily', timeZone: 'UTC', daily: { time: '09:00' },
  action: { type: 'agent-turn', prompt }
})

// Н14: просьба на 200 КБ отклоняется с понятной ошибкой (файл не пухнет до 20 МБ).
check('Н14: просьба на 200 КБ отклоняется', () => {
  const verdict = model.validateSchedule(turnRecord('я'.repeat(200000)))
  assert.equal(verdict.ok, false, '200 КБ приняты без ограничения')
  const err = verdict.errors.find(e => e.field === 'action.prompt')
  assert.ok(err, 'ошибка указывает на action.prompt: ' + JSON.stringify(verdict.errors))
  assert.equal(err.code, 'action_prompt_long')
})

// Граница: ровно на пределе — принимается.
check('Н14: просьба ровно на пределе принимается', () => {
  const limit = model.ACTION_TEXT_LIMIT
  assert.ok(Number.isInteger(limit) && limit > 0, 'предел объявлен моделью')
  assert.equal(model.validateSchedule(turnRecord('я'.repeat(limit))).ok, true)
})

// Отрицательный контроль: обычная просьба проходит.
check('Н14 контроль: обычная просьба проходит', () => {
  assert.equal(model.validateSchedule(turnRecord('Сделай отчёт по продажам за неделю')).ok, true)
})

// Тот же механизм: заметка и команда тоже лежат в файле целиком.
check('Н14: длинные заметка и команда тоже отклоняются', () => {
  const note = { id: 's3', kind: 'daily', timeZone: 'UTC', daily: { time: '09:00' }, action: { type: 'note', text: 'я'.repeat(200000) } }
  const command = { id: 's4', kind: 'daily', timeZone: 'UTC', daily: { time: '09:00' }, action: { type: 'command', command: 'x'.repeat(200000) } }
  assert.equal(model.validateSchedule(note).ok, false, 'заметка на 200 КБ принята')
  assert.equal(model.validateSchedule(command).ok, false, 'команда на 200 КБ принята')
})

console.log(`\n${total - failed}/${total} ok`)
if (failed) process.exit(1)