'use strict'
// Четыре первых сквозных сценария стенда качества. Проверка каждого живёт здесь,
// вне Workspace попытки: агенту передаются только файлы задания. Это не
// граница ОС: целенаправленный доступ к исходникам проверок не исключён. Ответы сценарного провайдера здесь же — стенд проверяет сам
// себя, а не качество модели.
const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { runScript, moduleCases } = require('./verify.cjs')
const crypto = require('node:crypto')

const write = (file, content) => ({ toolCalls: [{ name: 'write_file', args: { path: file, content } }] })
const run = command => ({ toolCalls: [{ name: 'run_command', args: { command } }] })
const read = file => ({ toolCalls: [{ name: 'read_file', args: { path: file } }] })
const DONE = { content: 'ВЕРДИКТ: ГОТОВО' }

const CORRECT_RESULT = 'alpha\nbeta=2\ngamma\n'
const CORRECT_DATA = { ok: true, items: [1, 2, 3] }

function readJson (workspace, file) {
  try { return JSON.parse(fs.readFileSync(path.join(workspace, file), 'utf8')) } catch (error) { return { error: error.message } }
}

function hashFile (file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}

function scenarioResult ({ workspace, run: result }) {
  const problems = []
  const text = path.join(workspace, 'notes', 'result.txt')
  const lines = fs.existsSync(text) ? fs.readFileSync(text, 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n') : null
  if (!lines) problems.push('notes/result.txt не создан')
  else if (lines.length !== 3 || lines[0] !== 'alpha' || lines[1] !== 'beta=2' || lines[2] !== 'gamma') problems.push('строки result.txt не совпадают с заданием: ' + JSON.stringify(lines))
  const data = readJson(workspace, 'data.json')
  if (data.error) problems.push('data.json не читается: ' + data.error)
  else if (!isDeepStrictEqual(data, CORRECT_DATA)) problems.push('data.json не совпадает с заданием: ' + JSON.stringify(data))
  return { ok: problems.length === 0, detail: problems.join('; ') || 'оба файла соответствуют заданию' }
}

function scenarioFix ({ workspace }) {
  const visible = runScript(workspace, 'verify.js')
  if (!visible.ok) return visible
  return moduleCases(workspace, 'lib.js', 'add', [[[2, 3], 5], [[-1, 1], 0], [[0, 0], 0], [[10, -4], 6]])
}

function scenarioResume ({ workspace, first, second, context }) {
  const problems = []
  const file = path.join(workspace, 'state.txt')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null
  if (text === null) problems.push('state.txt не создан первым ходом')
  else if (text !== 'side-effect-1\n' && text !== 'side-effect-1') problems.push('state.txt изменён или дописан: ' + JSON.stringify(text))
  if (!context?.beforeResume) problems.push('нет снимка файла до продолжения')
  else {
    const now = { hash: hashFile(file), mtimeMs: fs.existsSync(file) ? fs.statSync(file).mtimeMs : null }
    if (now.hash !== context.beforeResume.hash) problems.push('продолжение перезаписало state.txt')
    if (now.mtimeMs !== context.beforeResume.mtimeMs) problems.push('время записи state.txt изменилось при продолжении')
  }
  // Первый ход снят стендом намеренно: отчёта у него нет, доказательство записи —
  // сам файл и опись продолжения.
  if (!second?.ok) problems.push('продолжение не завершилось: ' + String(second?.error || '').slice(0, 160))
  const ledger = String(second?.prompt || '')
  if (!/state\.txt/.test(ledger)) problems.push('опись продолжения не называет уже сделанную запись state.txt')
  if (!/Уже сделано|не повторяй/i.test(ledger)) problems.push('опись продолжения не просит не повторять сделанное')
  return { ok: problems.length === 0, detail: problems.join('; ') || 'запись одна, продолжение её не повторило и знало об описи' }
}

const FALSE_DONE_CODE = [
  "exports.isEven = n => n === 3 ? false : false",
  "if (require.main === module) {",
  "  if (exports.isEven(3) !== false) { console.error('FAIL'); process.exit(1) }",
  "  console.log('OK')",
  "}"
].join('\n')

const CORRECT_EVEN = [
  "exports.isEven = n => n % 2 === 0",
  "if (require.main === module) {",
  "  if (exports.isEven(3) !== false) { console.error('FAIL'); process.exit(1) }",
  "  console.log('OK')",
  "}"
].join('\n')

function scenarioFalseDone ({ workspace }) {
  const visible = runScript(workspace, 'even.js')
  if (!visible.ok) return visible
  return moduleCases(workspace, 'even.js', 'isEven', [[[2], true], [[0], true], [[3], false], [[5], false]])
}

const protectedTasks = require('./tasks.cjs')
const lessons = require('./lessons.cjs')

const scenarios = [
  {
    id: 'file-result',
    title: 'Файловый результат по нескольким требованиям',
    request: 'Создай notes/result.txt с тремя строками: alpha, beta=2, gamma. Создай data.json с объектом {"ok":true,"items":[1,2,3]}. Ничего другого не меняй.',
    fixture: { 'brief.txt': 'result.txt: alpha, beta=2, gamma; data.json: {"ok":true,"items":[1,2,3]}\n' },
    turns: [write('notes/result.txt', CORRECT_RESULT), write('data.json', JSON.stringify(CORRECT_DATA, null, 2) + '\n'), { text: 'Готово: оба файла созданы.' }, DONE],
    brokenTurns: [write('notes/result.txt', CORRECT_RESULT), write('data.json', JSON.stringify({ ok: true, items: [1, 2] }, null, 2) + '\n'), { text: 'Готово: оба файла созданы.' }, DONE],
    expect: 'pass',
    verify: scenarioResult
  },
  {
    id: 'fix-after-check',
    title: 'Исправление после неуспешной проверки',
    request: 'Проверь lib.js командой node verify.js. Если проверка падает — исправь ошибку и снова выполни node verify.js.',
    fixture: {
      'lib.js': 'exports.add = (a, b) => a - b\n',
      'verify.js': "const { add } = require('./lib.js')\nif (add(2, 3) !== 5) { console.error('FAIL add(2,3)=' + add(2, 3)); process.exit(1) }\nconsole.log('OK')\n"
    },
    // Шаг цикла кончается ответом без вызовов: текст «проверка упала» идёт
    // вместе с исправляющим вызовом, а не отдельным шагом перед ним.
    turns: [run('node verify.js'), { ...write('lib.js', 'exports.add = (a, b) => a + b\n'), text: 'Проверка упала: add(2,3) вернул -1. Исправляю.' }, run('node verify.js'), { text: 'Готово: проверка проходит.' }, DONE],
    brokenTurns: [run('node verify.js'), { ...write('lib.js', 'exports.add = (a, b) => a - b\n'), text: 'Проверка упала.' }, run('node verify.js'), { text: 'Готово: проверка проходит.' }, DONE],
    expect: 'pass',
    verify: scenarioFix
  },
  {
    id: 'interrupt-resume',
    title: 'Прерывание и продолжение без повторного побочного действия',
    request: 'Запиши state.txt со строкой side-effect-1, затем прочитай его и подтверди.',
    fixture: { 'brief.txt': 'state.txt должен содержать ровно одну строку side-effect-1\n' },
    turns: [write('state.txt', 'side-effect-1\n'), { text: 'Продолжаю работу.', delayMs: 5000 }, { text: 'Готово.' }],
    resumeTurns: [read('state.txt'), { text: 'Файл уже записан, повторять запись не нужно. Готово.' }, DONE],
    interruptWhen: 'state.txt',
    expect: 'pass',
    verify: scenarioResume
  },
  {
    id: 'false-done',
    title: 'Агент заявил «готово», но результат неверен',
    request: 'Создай even.js с функцией isEven(n) и тестом для 2 и 3. Запусти свой тест.',
    fixture: { 'brief.txt': 'isEven(n) должна возвращать true для чётных и false для нечётных\n' },
    turns: [write('even.js', FALSE_DONE_CODE + '\n'), run('node even.js'), { text: 'Готово: isEven реализована, тест проходит.' }, DONE],
    brokenTurns: [write('even.js', CORRECT_EVEN + '\n'), run('node even.js'), { text: 'Готово: isEven реализована, тест проходит.' }, DONE],
    expect: 'agent-error',
    verify: scenarioFalseDone
  }
]

scenarios.push(...protectedTasks.scenarios)
scenarios.push(...lessons.scenarios)

module.exports = { scenarios, CORRECT_RESULT, CORRECT_DATA, FALSE_DONE_CODE, CORRECT_EVEN }
