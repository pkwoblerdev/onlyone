// Инициатива 1 (11.10.2026): помощники команды получали отчёты предшественников целиком — до 14 000 знаков на каждый плюс
// ответ ведущего, и «снежный ком» рос с каждым этапом. Теперь — выжимка с жёстким потолком на всю историю команды; полный
// текст отдаётся по адресному запросу (board_read с agent).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { digestBody, buildPrior, PRIOR_CAP } = require('../src/main/prior-digest.cjs')

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

const long = (head, tail, fill = 'Подробности работы, которые приходилось читать целиком. ') =>
  head + ' ' + fill.repeat(400) + ' ' + tail

check('потолок на всю историю — 1500 знаков', () => assert.equal(PRIOR_CAP, 1500))

check('короткий отчёт не меняется', () => {
  assert.equal(digestBody('Исправил src/a.js. Тесты зелёные.', 450), 'Исправил src/a.js. Тесты зелёные.')
})

check('длинный отчёт укладывается в предел, голова и итог сохранены', () => {
  const body = long('Прочитал src/main/auth.js и нашёл гонку в verifySession.', 'Итог: починил verifySession, npm test — 326 проверок, код 0.')
  const out = digestBody(body, 450)
  assert.ok(out.length <= 450, 'длина ' + out.length)
  assert.match(out, /src\/main\/auth\.js/, 'потеряна голова с файлом')
  assert.match(out, /код 0/, 'потерян итог')
})

check('код в блоках не раздувает выжимку', () => {
  const body = 'Правка.\n```js\n' + 'const x = 1\n'.repeat(500) + '```\nГотово: файл записан.'
  const out = digestBody(body, 450)
  assert.ok(out.length <= 450)
  assert.ok(!/const x = 1/.test(out), 'тело кода попало в выжимку')
  assert.match(out, /Готово: файл записан/)
})

check('пять отчётов по 14 000 знаков → вся история ≤ 1500', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ name: 'Агент ' + (i + 2), body: long('Задача ' + i + ': разбор модуля m' + i + '.', 'Итог ' + i + ': готово, файл m' + i + '.js.').slice(0, 14000) }))
  const out = buildPrior({ leadName: 'Агент 1', leadContent: long('Бриф ведущего.', 'Конец брифа.'), entries })
  assert.ok(out.length <= PRIOR_CAP, 'длина ' + out.length)
  for (let i = 0; i < 5; i++) assert.match(out, new RegExp('Агент ' + (i + 2)), 'нет агента ' + (i + 2))
})

check('при усечении называется способ получить полный отчёт', () => {
  const out = buildPrior({ leadName: 'Агент 1', leadContent: '', entries: [{ name: 'Агент 2', body: long('Начало.', 'Конец.') }] })
  assert.match(out, /board_read/)
  assert.match(out, /agent/)
})

check('короткая история целиком, без пометки об усечении', () => {
  const out = buildPrior({ leadName: 'Агент 1', leadContent: 'Раздай части.', entries: [{ name: 'Агент 2', body: 'Готово.' }] })
  assert.match(out, /Агент 1/); assert.match(out, /Раздай части\./); assert.match(out, /Агент 2/); assert.match(out, /Готово\./)
  assert.ok(!/board_read/.test(out), 'пометка об усечении там, где усечения не было')
})

check('пустая история — пустая строка', () => {
  assert.equal(buildPrior({ leadName: 'Агент 1', leadContent: '', entries: [] }), '')
})

check('много агентов: предел держится, каждый назван', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ name: 'Агент ' + (i + 2), body: long('Часть ' + i + '.', 'Итог ' + i + '.') }))
  const out = buildPrior({ leadName: 'Агент 1', leadContent: long('Бриф.', 'Конец.'), entries })
  assert.ok(out.length <= PRIOR_CAP, 'длина ' + out.length)
  for (let i = 0; i < 12; i++) assert.match(out, new RegExp('Агент ' + (i + 2) + '\\b'))
})

check('main.js строит предысторию через buildPrior, а не склейкой тел', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.ok(/require\('\.\/prior-digest\.cjs'\)/.test(main), 'нет в main.js: ' + String(/require\('\.\/prior-digest\.cjs'\)/))
  assert.ok(!/String\(d\.body\)\.slice\(0, 14000\)/.test(main), 'старая склейка по 14 000 знаков на месте')
})

check('board_read с agent отдаёт полный отчёт; чужой номер не путается', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  const from = main.indexOf('const turnReports = new Map()')
  const to = main.indexOf('function helperAssignmentMessage(', from)
  assert.ok(from > 0 && to > from, 'не найден склад отчётов в main.js')
  const { rememberReports, reportOfAgent, turnReports } = new Function(main.slice(from, to) + '\nreturn { rememberReports, reportOfAgent, turnReports }')()
  const full = 'Полный отчёт. ' + 'подробность '.repeat(500)
  rememberReports('r1', [{ name: 'Агент 2 · Вёрстка', body: full }, { name: 'Агент 20', body: 'двадцатый' }, { name: 'Агент 3', body: '' }])
  const two = reportOfAgent('r1', 2)
  assert.equal(two.success, true)
  assert.equal(two.reports.length, 1, 'номер 2 не должен цеплять «Агент 20»')
  assert.equal(two.reports[0].body, full, 'отчёт должен прийти целиком, не выжимкой')
  assert.equal(reportOfAgent('r1', 20).reports[0].body, 'двадцатый')
  assert.equal(reportOfAgent('r1', 3).success, false, 'пустой отчёт — это «не сдал»')
  assert.equal(reportOfAgent('r1', 'x').success, false)
  assert.equal(reportOfAgent('другой-ход', 2).success, false, 'чужой ход отчётов не видит')
  turnReports.clear()
})

if (failed) process.exit(1)
console.log('Сжатая предыстория команды: проверки пройдены')
