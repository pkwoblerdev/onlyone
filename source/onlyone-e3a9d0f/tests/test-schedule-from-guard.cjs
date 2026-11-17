'use strict'
// break-4 Н11: interval.from проверялся только на Number.isFinite — значение -1e300
// проходило, а nextInterval схлопывал nextRunAt в 0 (потеря значимости) → интервал
// исполнялся без остановки, время не двигалось. Отсчёт — целое число миллисекунд
// (безопасный integer), огромное/дробное значение отклоняется на валидации.
// Контроль: нормальный from принимается и шаг уходит в будущее.
const assert = require('node:assert/strict')
const { validateSchedule, nextAfter } = require('../src/main/schedule-model')

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }
const T0 = Date.parse('2026-05-01T00:00:00.000Z')
const rec = from => ({
  id: 'sch_from_1', name: 'Интервал', enabled: true, timeZone: 'Europe/Berlin', misfire: 'skip',
  kind: 'interval', interval: { everyMinutes: 60, from }, action: { type: 'note', text: 'заметка' }, createdAt: T0
})
const fromErrors = record => validateSchedule(record).errors.filter(e => e.field === 'interval.from')

check('from: -1e300 отклоняется (иначе интервал крутится без остановки)', () => {
  const res = validateSchedule(rec(-1e300))
  assert.equal(res.ok, false, 'огромный отрицательный from принят — расписание обречено на runaway')
  assert.equal(fromErrors(rec(-1e300)).length, 1, 'ошибка должна назвать interval.from')
})
check('from: 1e300 отклоняется', () => {
  assert.equal(validateSchedule(rec(1e300)).ok, false)
  assert.equal(fromErrors(rec(1e300)).length, 1)
})
check('from: дробное значение отклоняется', () => {
  assert.equal(validateSchedule(rec(T0 + 0.5)).ok, false)
})
check('контроль: нормальный from принимается', () => {
  assert.equal(validateSchedule(rec(T0)).ok, true)
  assert.equal(fromErrors(rec(T0)).length, 0)
})
check('контроль: from отсутствует — принимается (отсчёт от createdAt)', () => {
  const record = rec(undefined); delete record.interval.from
  assert.equal(validateSchedule(record).ok, true)
})
check('контроль: шаг от нормального from уходит в будущее, а не в 0', () => {
  const now = T0 + 90 * 60 * 1000
  const next = nextAfter(rec(T0), now)
  assert.ok(Number.isFinite(next) && next > now, `nextAfter обязан дать будущий момент, получил ${next}`)
  assert.equal((next - T0) % (60 * 60 * 1000), 0, 'следующий запуск на сетке шага от from')
})

if (failed) process.exit(1)
console.log('Интервал: отсчёт защищён от нечисловых по масштабу значений')