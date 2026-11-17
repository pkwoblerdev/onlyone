// break-4 Н21: buildPrior режет предысторию посимвольно и обрывает футер
// «полный отчёт — board_read с agent: <номер>» — единственный адрес, где помощник
// дочитает сокращённое. При 20+ частях даже MIN_PER_AGENT не умещается в потолок,
// и строка slice(0, limitCap) режет футер на середине.
//
// Отрицательные контроли: короткая история без футера не меняется; 8 частей —
// футер целиком (работало и до правки); когда всё умещается, строки не выбрасываются.

const assert = require('node:assert/strict')
const path = require('node:path')
const { buildPrior, PRIOR_CAP } = require(path.join(__dirname, '..', 'src', 'main', 'prior-digest.cjs'))

const FOOTER_TEXT = '(Отчёты сокращены. Полный отчёт агента — board_read с agent: <номер>.)'

let failed = 0
let total = 0
function check (name, fn) {
  total++
  try { fn(); console.log('  ok  ' + name) } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + (error && error.message)) }
}

const long = (head, tail) => head + ' ' + 'Подробности работы, которые приходилось читать целиком. '.repeat(120) + ' ' + tail
const entriesOf = n => Array.from({ length: n }, (_, i) => ({ name: 'Агент ' + (i + 2), body: long('Этап ' + i + ': разбор модуля.', 'Итог ' + i + ': зелёная.') }))

// Н21: 20 частей — футер целиком, потолок держится.
check('Н21: 20 частей — футер не обрезан', () => {
  const out = buildPrior({ leadName: 'Агент 1', leadContent: long('Бриф.', 'Конец.'), entries: entriesOf(20) })
  assert.ok(out.length <= PRIOR_CAP, 'длина ' + out.length)
  assert.ok(out.includes(FOOTER_TEXT), 'футер обрезан, хвост: ' + JSON.stringify(out.slice(-60)))
})

// Н21: 30 частей — футер целиком.
check('Н21: 30 частей — футер не обрезан', () => {
  const out = buildPrior({ leadName: 'Агент 1', leadContent: long('Бриф.', 'Конец.'), entries: entriesOf(30) })
  assert.ok(out.length <= PRIOR_CAP, 'длина ' + out.length)
  assert.ok(out.includes(FOOTER_TEXT), 'футер обрезан, хвост: ' + JSON.stringify(out.slice(-60)))
})

// Целостность строк: каждая оставшаяся строка — целый отчёт, не обрывок посередине.
check('Н21: строки целые, футер последней строкой', () => {
  const out = buildPrior({ leadName: 'Агент 1', leadContent: long('Бриф.', 'Конец.'), entries: entriesOf(30) })
  const lines = out.split('\n')
  assert.equal(lines[lines.length - 1], FOOTER_TEXT, 'футер — отдельная последняя строка')
  for (const line of lines.slice(0, -1)) assert.match(line, /^Агент \d+: \S/, 'обрывок строки: ' + JSON.stringify(line))
})

// Отрицательный контроль: 8 частей — футер целиком (работало и до правки).
check('Н21 контроль: 8 частей — футер целиком', () => {
  const out = buildPrior({ leadName: 'Агент 1', leadContent: long('Бриф.', 'Конец.'), entries: entriesOf(8) })
  assert.ok(out.length <= PRIOR_CAP)
  assert.ok(out.includes(FOOTER_TEXT))
})

// Контроль: короткая история без усечения — без футера, целиком.
check('Н21 контроль: короткая история без футера', () => {
  const out = buildPrior({ leadName: 'Агент 1', leadContent: 'Раздай части.', entries: [{ name: 'Агент 2', body: 'Готово.' }] })
  assert.equal(out, 'Агент 1: Раздай части.\nАгент 2: Готово.')
  assert.ok(!out.includes('board_read'))
})

// Контроль: когда всё умещается, каждый агент назван (строки не выбрасываются).
check('Н21 контроль: 12 агентов умещаются — каждый назван', () => {
  const out = buildPrior({ leadName: 'Агент 1', leadContent: long('Бриф.', 'Конец.'), entries: entriesOf(12) })
  assert.ok(out.length <= PRIOR_CAP)
  for (let i = 2; i <= 13; i++) assert.match(out, new RegExp('Агент ' + i + '\\b'), 'нет агента ' + i)
})

console.log(`\n${total - failed}/${total} ok`)
if (failed) process.exit(1)