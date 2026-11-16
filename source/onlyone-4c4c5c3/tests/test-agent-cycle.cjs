'use strict'

// Общий бюджет цикла «исполнитель → проверка → доработка → итог» (план, этап 6,
// 2a). Проверяется то, чего не было раньше: один предел на ход для ведущего и
// всех помощников, явные результаты проверки и остаток бюджета после падения.

const assert = require('node:assert/strict')
const { LIMITS, createCycle, cleanCycle } = require('../src/main/agent-cycle')

const cases = []
const check = (name, fn) => { cases.push(name); try { fn() } catch (err) { console.error('ПРОВАЛ ' + name + ': ' + err.message); process.exitCode = 1 } }

check('бюджет один на ход: помощники тратят его вместе с ведущим', () => {
  const cycle = createCycle({})
  assert.equal(cycle.limits.reworks, LIMITS.reworks)
  assert.equal(cycle.spend('reworks'), true)
  assert.equal(cycle.spend('reworks'), true)
  assert.equal(cycle.spend('reworks'), true)
  assert.equal(cycle.spend('reworks'), false, 'четвёртое продление того же хода')
  assert.equal(cycle.left('reworks'), 0)
})

check('просьба сделать полностью поднимает предел, но не возвращает потраченное', () => {
  const cycle = createCycle({ wholeJob: true })
  assert.equal(cycle.limits.reworks, LIMITS.reworksWholeJob)
  cycle.spend('reworks')
  assert.equal(cycle.left('reworks'), LIMITS.reworksWholeJob - 1)
})

check('судья ограничена числом запросов на ход', () => {
  const cycle = createCycle({})
  assert.equal(cycle.spend('judge'), true)
  assert.equal(cycle.spend('judge'), true)
  assert.equal(cycle.spend('judge'), false)
})

check('неизвестный вид расхода не тратит ничего и отказывает', () => {
  const cycle = createCycle({})
  assert.equal(cycle.spend('tokens'), false)
  assert.equal(cycle.spend('reworks'), true)
})

check('результаты проверки явные: последний вердикт перекрывает прежний', () => {
  const cycle = createCycle({})
  cycle.record({ source: 'plan', verdict: 'fail', gaps: ['Кнопка отмены не работает'], agentIndex: 0 })
  assert.deepEqual(cycle.openGaps(), ['Кнопка отмены не работает'])
  cycle.record({ source: 'plan', verdict: 'pass' })
  assert.deepEqual(cycle.openGaps(), [], 'закрытая проверка не должна висеть в пробелах')
  assert.equal(cycle.failing().length, 0)
})

check('неопределённый вердикт переделку не запускает', () => {
  const cycle = createCycle({})
  cycle.record({ source: 'acceptance', verdict: 'unknown', gaps: ['непонятно'] })
  assert.deepEqual(cycle.openGaps(), [])
  assert.equal(cycle.last('acceptance').verdict, 'unknown')
})

check('запись с чужим источником или вердиктом отклоняется', () => {
  const cycle = createCycle({})
  assert.equal(cycle.record({ source: 'magazine', verdict: 'pass' }), null)
  assert.equal(cycle.record({ source: 'plan', verdict: 'может быть' }), null)
  assert.equal(cycle.checks().length, 0)
})

check('проход одного агента не затирает провал другого', () => {
  const cycle = createCycle({})
  cycle.record({ source: 'acceptance', verdict: 'fail', gaps: ['у ведущего не закрыто'], agentIndex: 0 })
  cycle.record({ source: 'acceptance', verdict: 'pass', agentIndex: 1 })
  assert.deepEqual(cycle.openGaps(), ['у ведущего не закрыто'],
    'приёмка помощника не отменяет непройденную приёмку ведущего')
  assert.equal(cycle.failing().length, 1)
  assert.match(cycle.summary().text, /приёмка по просьбе \(Агент 1\) — не пройдена/)
  assert.match(cycle.summary().text, /приёмка по просьбе \(Агент 2\) — пройдена/)
})

check('тот же исполнитель закрывает свою проверку', () => {
  const cycle = createCycle({})
  cycle.record({ source: 'plan', verdict: 'fail', gaps: ['пункт открыт'], agentIndex: 2 })
  assert.deepEqual(cycle.openGaps(), ['пункт открыт'])
  cycle.record({ source: 'plan', verdict: 'pass', agentIndex: 2 })
  assert.deepEqual(cycle.openGaps(), [])
  assert.equal(cycle.failing().length, 0)
})

check('пробелы режутся до трёх и в одну строку', () => {
  const cycle = createCycle({})
  const long = 'а'.repeat(900)
  cycle.record({ source: 'claims', verdict: 'fail', gaps: [long, 'b', 'c', 'd', 'e'] })
  const entry = cycle.last('claims')
  assert.equal(entry.gaps.length, 3)
  assert.ok(entry.gaps[0].length <= 301, 'длина пробела: ' + entry.gaps[0].length)
  assert.equal(/\n/.test(entry.gaps[0]), false)
})

check('список проверок не растёт бесконечно', () => {
  const cycle = createCycle({})
  for (let i = 0; i < 120; i++) cycle.record({ source: 'plan', verdict: 'pass', gaps: [`пункт ${i}`] })
  assert.ok(cycle.checks().length <= 40, 'записей: ' + cycle.checks().length)
})

check('итог хода называется словами: что проверялось и сколько потрачено', () => {
  const cycle = createCycle({})
  cycle.spend('reworks')
  cycle.record({ source: 'plan', verdict: 'pass' })
  cycle.record({ source: 'acceptance', verdict: 'fail', gaps: ['нет тестов'] })
  const summary = cycle.summary()
  assert.match(summary.text, /чек-лист \(Агент 1\) — пройдена/)
  assert.match(summary.text, /приёмка по просьбе \(Агент 1\) — не пройдена: нет тестов/)
  assert.match(summary.text, /доработка 1 из 3/)
  assert.equal(/остатк/.test(summary.text), false, 'без перезапуска про остаток писать нечего')
})

check('срок хода считается и истекает', () => {
  let clock = 1000
  const cycle = createCycle({ durationMs: 5000, now: () => clock })
  assert.equal(cycle.deadlineAt, 6000)
  assert.equal(cycle.timeLeftMs(), 5000)
  clock = 6000
  assert.equal(cycle.outOfTime(), true)
  assert.equal(cycle.timeLeftMs(), 0)
})

check('без срока ход не считается истёкшим никогда', () => {
  const cycle = createCycle({ now: () => 5 })
  assert.equal(cycle.outOfTime(), false)
  assert.equal(cycle.timeLeftMs(), Infinity)
})

check('бюджет сохраняется на каждом расходе', () => {
  const saved = []
  const cycle = createCycle({ onSave: snapshot => saved.push(snapshot.spent.reworks.used) })
  cycle.spend('reworks')
  cycle.record({ source: 'board', verdict: 'fail', gaps: ['возражение'] })
  assert.deepEqual(saved, [1, 1], 'сохранение и на расходе, и на записи проверки: ' + JSON.stringify(saved))
})

check('сбой диска не роняет ход', () => {
  const cycle = createCycle({ onSave: () => { throw new Error('нет диска') } })
  assert.equal(cycle.spend('reworks'), true)
  assert.equal(cycle.record({ source: 'plan', verdict: 'pass' }) !== null, true)
})

check('остаток бюджета переживает перезапуск', () => {
  const first = createCycle({ durationMs: 60000 })
  first.spend('reworks')
  first.spend('reworks')
  first.spend('judge')
  first.record({ source: 'plan', verdict: 'fail', gaps: ['не закрыт пункт'] })
  const snapshot = first.snapshot()

  const second = createCycle({ restored: snapshot, durationMs: 60000 })
  assert.equal(second.left('reworks'), LIMITS.reworks - 2, 'продолжение получило остаток, а не полный бюджет')
  assert.equal(second.left('judge'), 1)
  assert.deepEqual(second.openGaps(), ['не закрыт пункт'], 'не сданные проверки помнят')
  assert.equal(second.restored, true)
  assert.match(second.summary().text, /остатк/)
})

check('данные с диска недоверенные: лишнее и придуманное отбрасывается', () => {
  const dirty = {
    schemaVersion: 99,
    wholeJob: 'да',
    deadlineAt: 'завтра',
    spent: { reworks: { used: -5, limit: 99 }, judge: 'нет', rounds: [1, 2] },
    checks: [
      { source: 'plan', verdict: 'pass' },
      { source: 'выдумано', verdict: 'pass' },
      { source: 'board', verdict: 'может быть' },
      null,
      'строка'
    ],
    secrets: { token: 'abc' }
  }
  const clean = cleanCycle(dirty)
  assert.equal(clean.wholeJob, false)
  assert.equal(clean.deadlineAt, 0)
  assert.equal(clean.spent.reworks.used, 0)
  assert.deepEqual(clean.spent.judge, { used: 0, limit: 0 })
  assert.equal(clean.checks.length, 1)
  assert.equal(JSON.stringify(clean).includes('abc'), false, 'в снимок не должно попадать ничего лишнего')

  const cycle = createCycle({ restored: dirty })
  assert.equal(cycle.left('reworks'), LIMITS.reworks, 'испорченный расход не должен съесть бюджет')
  assert.equal(cycle.checks().length, 1)
})

check('восстановленный расход не может превысить новый предел', () => {
  const inflated = { spent: { reworks: { used: 99, limit: 99 } }, checks: [], wholeJob: false, deadlineAt: 0 }
  const cycle = createCycle({ restored: inflated })
  assert.equal(cycle.left('reworks'), 0)
  assert.equal(cycle.spend('reworks'), false)
})

check('просьба сделать полностью переживает перезапуск', () => {
  const first = createCycle({ wholeJob: true })
  first.spend('reworks')
  const second = createCycle({ restored: first.snapshot(), wholeJob: true })
  assert.equal(second.wholeJob, true)
  assert.equal(second.left('reworks'), LIMITS.reworksWholeJob - 1)
})

check('снимок — данные, а не ссылка: наружу нельзя вытащить и поменять живое состояние', () => {
  const cycle = createCycle({})
  cycle.record({ source: 'plan', verdict: 'fail', gaps: ['один'] })
  const snapshot = cycle.snapshot()
  snapshot.checks[0].gaps.push('второй')
  snapshot.spent.reworks.used = 99
  assert.deepEqual(cycle.last('plan').gaps, ['один'])
  assert.equal(cycle.left('reworks'), LIMITS.reworks)
  const copy = cycle.checks()
  copy[0].verdict = 'pass'
  assert.equal(cycle.last('plan').verdict, 'fail')
})

check('модуль не меняет своё состояние извне', () => {
  const cycle = createCycle({})
  assert.throws(() => { cycle.spend = () => true }, TypeError)
  assert.throws(() => { cycle.limits.reworks = 99 }, TypeError)
})

// Проверка макета: «проверка выполнилась» и «макет прошёл» — разные факты.
const outcome = require('../src/main/agent-cycle').designCheckOutcome

check('dc_check, который не вызывался, не выдаётся за пройденный', () => {
  const result = outcome([{ tool: 'dc_write', ok: true }])
  assert.equal(result.verdict, 'unknown')
  assert.match(result.gaps.join(' '), /dc_check/)
})

check('выполненная, но непройденная проверка макета — провал', () => {
  // Ровно тот случай, который раньше уходил зелёным: success есть, passed нет.
  const result = outcome([{ tool: 'dc_check', ok: true, passed: false }])
  assert.equal(result.verdict, 'fail')
  assert.match(result.gaps.join(' '), /не пройдена/)
})

check('сорвавшаяся проверка макета называется отдельно', () => {
  const result = outcome([{ tool: 'dc_check', ok: false }])
  assert.equal(result.verdict, 'fail')
  assert.match(result.gaps.join(' '), /не выполнилась/)
})

check('проверка после правки макета протухает', () => {
  const fresh = outcome([{ tool: 'dc_check', ok: true, passed: true }])
  assert.equal(fresh.verdict, 'pass')
  const stale = outcome([
    { tool: 'dc_check', ok: true, passed: true },
    { tool: 'dc_html_str_replace', ok: true }
  ])
  assert.equal(stale.verdict, 'fail')
  assert.match(stale.gaps.join(' '), /менялся/)
})

check('решает последняя проверка, а не первая', () => {
  const result = outcome([
    { tool: 'dc_check', ok: true, passed: false },
    { tool: 'dc_html_str_replace', ok: true },
    { tool: 'dc_check', ok: true, passed: true }
  ])
  assert.equal(result.verdict, 'pass', JSON.stringify(result))
})

check('снимок цикла переживает диск вместе со стадиями и проверками', () => {
  const cycle = createCycle({})
  cycle.mark('execute')
  cycle.record({ source: 'design', verdict: 'fail', gaps: ['переполнение'] })
  const restored = createCycle({ restored: cycle.snapshot() })
  assert.deepEqual(restored.stages(), ['execute'])
  assert.deepEqual(restored.openGaps(), ['переполнение'])
})

const failed = cases.length && process.exitCode === 1 ? 'с ошибками' : 'без ошибок'
console.log(`Общий цикл: ${cases.length} проверок, ${failed}`)
