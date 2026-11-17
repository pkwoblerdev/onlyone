// Инициатива 6 (11.10.2026): пункт доски с правом записи нельзя закрыть как «сделано», если код менялся, а после последней
// правки не было зелёной проверки. Раньше доска проверяла лишь «что-то менялось» и только после хода. Замок включается там,
// где у проекта есть команда проверки: без неё закрыть пункт было бы нечем, и замок стал бы стеной.
const assert = require('node:assert/strict')
const board = require('../src/main/agent-board')
const { isVerificationCommand, projectHasTests } = require('../src/main/verification.cjs')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

let n = 0
function fresh({ readOnly = false, testsExpected = true } = {}) {
  const id = 'gate-' + (++n)
  board.clearBoard(id)
  board.seedBoard(id, [{ agent: 'Агент 2', task: 'править a.js', acceptance: 'a.js работает', readOnly }], ['Агент 1', 'Агент 2'])
  board.setTestsExpected(id, testsExpected)
  return id
}
const edit = (id, agent = 'Агент 2') => board.recordToolEvidence(id, { tool: 'edit_file', agent, path: 'a.js', ok: true })
const test = (id, agent = 'Агент 2', command = 'npm test') => board.recordToolEvidence(id, { tool: 'run_command', agent, command, exitCode: 0, ok: true })
const close = id => board.updateItem(id, 'Агент 2', { id: 't1', status: 'done', note: 'изменён a.js, npm test прошёл' })

check('правка без проверки: закрыть нельзя, причина названа', () => {
  const id = fresh(); edit(id)
  const res = close(id)
  assert.equal(res.success, false)
  assert.match(res.error, /код был изменён, но верификационный тест не запускался/)
})
check('правка, затем зелёная проверка: закрыть можно', () => {
  const id = fresh(); edit(id); test(id)
  assert.equal(close(id).success, true)
})
check('проверка ДО правки не считается: она старше последней правки', () => {
  const id = fresh(); test(id); edit(id)
  assert.equal(close(id).success, false)
})
check('красный, правка, зелёный — можно', () => {
  const id = fresh(); edit(id); test(id); edit(id); test(id, 'Агент 1')
  assert.equal(close(id).success, true, 'проверку мог запустить и ведущий')
})
check('правка после зелёной проверки обнуляет её', () => {
  const id = fresh(); edit(id); test(id); edit(id)
  assert.equal(close(id).success, false)
})
check('посторонняя команда не проверка', () => {
  const id = fresh(); edit(id); test(id, 'Агент 2', 'git status')
  assert.equal(close(id).success, false)
})
check('пункт «только чтение» закрывается без проверок', () => {
  const id = fresh({ readOnly: true })
  assert.equal(close(id).success, true)
})
check('проект без команды проверки: замок не мешает', () => {
  const id = fresh({ testsExpected: false }); edit(id)
  assert.equal(close(id).success, true)
})
check('правок не было вовсе: прежнее поведение (об этом скажет проверка хода)', () => {
  const id = fresh()
  assert.equal(close(id).success, true)
})
check('другие состояния замок не трогает', () => {
  const id = fresh(); edit(id)
  assert.equal(board.updateItem(id, 'Агент 2', { id: 't1', status: 'doing', note: 'начал' }).success, true)
  assert.equal(board.updateItem(id, 'Агент 2', { id: 't1', status: 'blocked', note: 'нет доступа к CI' }).success, true)
})

check('isVerificationCommand узнаёт проверки и не узнаёт остальное', () => {
  for (const ok of ['npm test', 'npm run test', 'npm run lint', 'node tests/test-x.cjs', 'npx vitest', 'pytest -q', 'cargo test', 'go test ./...']) assert.equal(isVerificationCommand(ok), true, ok)
  for (const no of ['git checkout test-branch', 'echo test', 'cat tests/fixture.json', 'git status', '', null]) assert.equal(isVerificationCommand(no), false, String(no))
})
check('projectHasTests: скрипт test в package.json — да; заглушка npm и пустая папка — нет', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-gate-'))
  assert.equal(projectHasTests([dir]), false, 'пустая папка')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))
  assert.equal(projectHasTests([dir]), false, 'заглушка npm init')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node tests/run.js' } }))
  assert.equal(projectHasTests([dir]), true)
  assert.equal(projectHasTests([path.join(dir, 'нет-такой'), dir]), true, 'достаточно одной папки')
  fs.rmSync(dir, { recursive: true, force: true })
})

check('another helper cannot supply verification for this part', () => {
  const id = fresh(); edit(id); test(id, 'Агент 3')
  assert.equal(close(id).success, false)
})
check('failed verification after green must remain visible', () => {
  const id = fresh(); edit(id); test(id)
  board.recordToolEvidence(id, { tool: 'run_command', agent: 'Агент 2', command: 'npm test', exitCode: 1, ok: false })
  assert.equal(close(id).success, false)
})
check('commands with unknown file effects invalidate earlier green checks', () => {
  const id = fresh(); edit(id); test(id)
  board.recordToolEvidence(id, { tool: 'run_command', agent: 'Агент 2', command: 'node mutate.js', exitCode: 1, ok: false })
  assert.equal(close(id).success, false)
})
check('two parts of one helper do not share checks', () => {
  const id = fresh()
  board.seedBoard(id, [{ agent: 'Агент 2', task: 'править b.js', readOnly: false }])
  board.recordToolEvidence(id, { tool: 'edit_file', agent: 'Агент 2', assignmentId: 't1', path: 'a.js', ok: true })
  board.recordToolEvidence(id, { tool: 'run_command', agent: 'Агент 2', assignmentId: 't2', command: 'npm test', exitCode: 0, ok: true })
  assert.equal(close(id).success, false)
})

check('shell chains and truncated commands do not prove verification', () => {
  for (const command of ['npm test && node mutate.js', 'npm test; node mutate.js', 'npm test || echo ok', 'npm test\nnode mutate.js']) {
    assert.equal(isVerificationCommand(command), false, command)
  }
  const id = fresh(); edit(id)
  board.recordToolEvidence(id, { tool: 'run_command', agent: 'Агент 2', command: 'npm test', commandTruncated: true, exitCode: 0, ok: true })
  assert.equal(close(id).success, false)
})

check('same helper may verify its own explicitly bound part', () => {
  const id = fresh()
  board.seedBoard(id, [{ agent: 'Агент 2', task: 'править b.js', readOnly: false }])
  board.recordToolEvidence(id, { tool: 'edit_file', agent: 'Агент 2', assignmentId: 't1', path: 'a.js', ok: true })
  board.recordToolEvidence(id, { tool: 'run_command', agent: 'Агент 2', assignmentId: 't1', command: 'npm test', exitCode: 0, ok: true })
  assert.equal(close(id).success, true)
  board.updateItem(id, 'Агент 2', { id: 't2', status: 'done', note: 'Вторая часть объявлена готовой' })
  assert(board.boardGaps(id).some(gap => gap.startsWith('пункт t2:')), 'first part writes cannot prove second part')
})

if (failed) process.exit(1)
console.log('Замок приёмки на доске: проверки пройдены')
