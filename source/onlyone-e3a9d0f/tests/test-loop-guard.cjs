// Защита от зацикливания кодом, а не словами промпта: один и тот же вызов с тем же результатом подряд.
// В промпте правило «не повторяй неудавшийся вызов дважды» стоит давно, и слабые модели его не держат: ход жжёт запросы
// (а на бесплатных моделях лимит считается именно в них), пока не упрётся в предел шагов.
const assert = require('node:assert/strict')
const { createLoopGuard } = require('../src/main/loop-guard.cjs')

let failed = 0
function test (name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '—', error.message) }
}

// Один вызов целиком: проверка, «выполнение», запись результата.
function call (guard, name, args, result) {
  const verdict = guard.check(name, args)
  if (verdict.action === 'run') guard.record(name, args, result)
  return verdict
}

test('два одинаковых вызова с тем же результатом проходят, третий — нет', () => {
  const guard = createLoopGuard()
  const same = { success: false, error: 'нет файла' }
  assert.equal(call(guard, 'read_file', { path: 'a.js' }, same).action, 'run')
  assert.equal(call(guard, 'read_file', { path: 'a.js' }, same).action, 'run')
  const third = call(guard, 'read_file', { path: 'a.js' }, same)
  assert.equal(third.action, 'block')
  assert.equal(third.times, 3)
  assert.match(third.message, /Смени подход/)
})

test('пятый подряд — остановка хода', () => {
  const guard = createLoopGuard()
  const same = { success: true, content: 'x' }
  const verdicts = []
  for (let i = 0; i < 5; i++) verdicts.push(call(guard, 'run_command', { command: 'npm test' }, same).action)
  assert.deepEqual(verdicts, ['run', 'run', 'block', 'block', 'stop'])
})

// Результат длиннее окна дайджеста (20 000 знаков): правка в середине, куда
// усечённый дайджест не смотрелся. `read_file` упирается в бюджет 40 000 знаков
// (`tool-protocol.cjs`), так что такой результат — норма, а не экзотика.
function longResult (marker) {
  return { success: true, content: 'x'.repeat(15000) + marker + 'y'.repeat(15000) }
}

test('Н1: перечитывание большого файла с изменённой серединой — не повтор', () => {
  const guard = createLoopGuard()
  const args = { path: 'big.js', startLine: 1, endLine: 900 }
  const verdicts = []
  for (let i = 0; i < 5; i++) verdicts.push(call(guard, 'read_file', args, longResult('ПРАВКА ' + i)).action)
  assert.deepEqual(verdicts, ['run', 'run', 'run', 'run', 'run'], 'легитимные ходы blocks: ' + verdicts.join(','))
})

test('Н1 контроль: тот же большой результат пять раз подряд — настоящая защита цела', () => {
  const guard = createLoopGuard()
  const args = { path: 'big.js', startLine: 1, endLine: 900 }
  const same = longResult('ОДИН И ТОТ ЖЕ')
  const verdicts = []
  for (let i = 0; i < 5; i++) verdicts.push(call(guard, 'read_file', args, same).action)
  assert.deepEqual(verdicts, ['run', 'run', 'block', 'block', 'stop'])
})

test('другой результат сбрасывает счёт: файл перечитывают после правки', () => {
  const guard = createLoopGuard()
  for (let i = 0; i < 6; i++) {
    const verdict = call(guard, 'read_file', { path: 'a.js' }, { success: true, content: 'версия ' + i })
    assert.equal(verdict.action, 'run', 'шаг ' + i)
  }
})

test('другой вызов между повторами сбрасывает счёт', () => {
  const guard = createLoopGuard()
  const same = { success: true, content: 'x' }
  call(guard, 'read_file', { path: 'a.js' }, same)
  call(guard, 'read_file', { path: 'a.js' }, same)
  call(guard, 'write_file', { path: 'b.js', content: '1' }, { success: true })
  assert.equal(call(guard, 'read_file', { path: 'a.js' }, same).action, 'run')
})

test('порядок ключей в аргументах не важен', () => {
  const guard = createLoopGuard()
  const same = { success: true }
  call(guard, 'search_files', { query: 'x', path: 'src' }, same)
  call(guard, 'search_files', { path: 'src', query: 'x' }, same)
  assert.equal(call(guard, 'search_files', { query: 'x', path: 'src' }, same).action, 'block')
})

test('время выполнения в результате не прячет повтор', () => {
  const guard = createLoopGuard()
  call(guard, 'run_command', { command: 'npm test' }, { success: false, exitCode: 1, output: 'FAIL', durationMs: 1200 })
  call(guard, 'run_command', { command: 'npm test' }, { success: false, exitCode: 1, output: 'FAIL', durationMs: 1337 })
  assert.equal(call(guard, 'run_command', { command: 'npm test' }, { success: false, exitCode: 1, output: 'FAIL', durationMs: 990 }).action, 'block')
})

test('служебные инструменты хода не считаются повтором', () => {
  const guard = createLoopGuard()
  for (let i = 0; i < 8; i++) {
    assert.equal(call(guard, 'task_plan', { items: [{ id: 'a', title: 'x', status: 'doing' }] }, { success: true }).action, 'run')
    assert.equal(call(guard, 'board_read', {}, { success: true, items: [] }).action, 'run')
  }
})

test('заблокированный вызов не исполняется и счёт копится дальше', () => {
  const guard = createLoopGuard()
  const same = { success: false, error: 'e' }
  call(guard, 'fetch_url', { url: 'https://a.test' }, same)
  call(guard, 'fetch_url', { url: 'https://a.test' }, same)
  const verdicts = []
  for (let i = 0; i < 3; i++) verdicts.push(guard.check('fetch_url', { url: 'https://a.test' }).action)
  assert.deepEqual(verdicts, ['block', 'block', 'stop'])
})

test('подключено: цикл агента спрашивает защиту до вызова и записывает результат после', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
  assert.match(main, /require\('\.\/loop-guard\.cjs'\)/)
  assert.match(main, /loopGuard\.check\(toolName, args\)/)
  assert.match(main, /loopGuard\.record\(toolName, args, result\)/)
  assert.match(main, /lastGaps = \['агент зациклился на одном вызове'\]/)
})

if (failed) process.exit(1)
console.log('\nЗащита от зацикливания: проверки пройдены')
