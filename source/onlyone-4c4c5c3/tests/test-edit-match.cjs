// Точечная правка файла: найти фрагмент, заменить его, не тронуть остальное.
// Файлы проекта бывают с CRLF, с табами и с хвостовыми пробелами — модель пишет фрагмент «как видит», и правка не должна
// ломаться об окончание строки или отступ, а неоднозначный фрагмент не должен молча заменяться в первом попавшемся месте.
const assert = require('node:assert/strict')
const { applyEdit, nearestHint } = require('../src/main/edit-match.cjs')

let failed = 0
function test (name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '—', error.message) }
}

test('точное совпадение заменяется ровно в одном месте', () => {
  const r = applyEdit('a\nconst x = 1\nb\n', 'const x = 1', 'const x = 2')
  assert.equal(r.ok, true)
  assert.equal(r.content, 'a\nconst x = 2\nb\n')
  assert.equal(r.replacements, 1)
  assert.equal(r.how, 'exact')
  assert.equal(r.line, 2)
})

test('неоднозначный фрагмент не заменяется молча', () => {
  const r = applyEdit('x\nfoo\nbar\nfoo\n', 'foo', 'baz')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ambiguous')
  assert.equal(r.count, 2)
  assert.deepEqual(r.lines, [2, 4])
})

test('replace_all заменяет все вхождения', () => {
  const r = applyEdit('foo\nbar\nfoo\n', 'foo', 'baz', { replaceAll: true })
  assert.equal(r.ok, true)
  assert.equal(r.content, 'baz\nbar\nbaz\n')
  assert.equal(r.replacements, 2)
})

test('отсутствующий фрагмент — причина «missing», а не тихий успех', () => {
  const r = applyEdit('one\ntwo\n', 'three', 'x')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'missing')
})

test('пустой и неизменяющий фрагмент отвергаются', () => {
  assert.equal(applyEdit('abc', '', 'x').reason, 'empty')
  assert.equal(applyEdit('abc', 'abc', 'abc').reason, 'same')
})

test('файл с CRLF: фрагмент, написанный с LF, находится и окончания строк сохраняются', () => {
  const file = 'line1\r\nfunction f () {\r\n  return 1\r\n}\r\nline5\r\n'
  const r = applyEdit(file, 'function f () {\n  return 1\n}', 'function f () {\n  return 2\n}\n// новая')
  assert.equal(r.ok, true)
  assert.equal(r.content, 'line1\r\nfunction f () {\r\n  return 2\r\n}\r\n// новая\r\nline5\r\n')
})

test('файл со смешанными окончаниями: нетронутые строки остаются байт в байт', () => {
  const file = 'a\r\nb\nc\r\nd\n'
  const r = applyEdit(file, 'c', 'C')
  assert.equal(r.ok, true)
  assert.equal(r.content, 'a\r\nb\nC\r\nd\n')
})

test('хвостовые пробелы в файле не мешают найти фрагмент', () => {
  const file = 'if (a) {   \n  go()  \n}\n'
  const r = applyEdit(file, 'if (a) {\n  go()\n}', 'if (a) {\n  stop()\n}')
  assert.equal(r.ok, true)
  assert.equal(r.how, 'whitespace')
  // Строка, которую модель не меняла, остаётся как в файле — вместе с её хвостовыми пробелами.
  assert.equal(r.content, 'if (a) {   \n  stop()\n}\n')
})

test('другой отступ: фрагмент находится, новый текст получает отступ файла', () => {
  const file = 'class A {\n\tm () {\n\t\treturn 1\n\t}\n}\n'
  const r = applyEdit(file, 'm () {\n  return 1\n}', 'm () {\n  return 2\n}')
  assert.equal(r.ok, true)
  assert.equal(r.how, 'indent')
  assert.equal(r.content, 'class A {\n\tm () {\n\t  return 2\n\t}\n}\n')
})

test('приблизительное совпадение не применяется, если оно неоднозначно', () => {
  const file = '{\n  x\n}\nmid\n{\n  x\n}\n'
  const r = applyEdit(file, '{\n x\n}', '{\n y\n}')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ambiguous')
})

test('подсказка называет ближайшую строку, чтобы повторить правку без перечитывания всего файла', () => {
  const file = 'alpha\nfunction runAgentLoop(event) {\n  go()\n}\nomega\n'
  const hint = nearestHint(file, 'function runAgentLoop(event, payload) {\n  go()\n}')
  assert.equal(hint.line, 2)
  assert.match(hint.preview, /runAgentLoop\(event\)/)
  assert.equal(nearestHint('abc\n', 'совсем другое'), null)
})

if (failed) process.exit(1)
console.log('\nТочечная правка файла: проверки пройдены')
