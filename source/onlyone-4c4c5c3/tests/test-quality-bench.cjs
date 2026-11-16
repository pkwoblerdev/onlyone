'use strict'
// Быстрые проверки самого стенда: критерии сценариев различают правильный и
// испорченный результат, продолжение замечает вторую запись, дерево процессов
// снимается целиком. Настоящие окна и модели здесь не запускаются.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { scenarios, CORRECT_DATA } = require('../scripts/quality-bench/scenarios.cjs')
const { classify, killTree } = require('../scripts/quality-bench/launch.cjs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-bench-unit-'))
const space = name => { const value = path.join(dir, name); fs.mkdirSync(value, { recursive: true }); return value }
let runningChild = null
const byId = id => scenarios.find(item => item.id === id)
const writeFiles = (workspace, files) => { for (const [file, content] of Object.entries(files)) { const target = path.join(workspace, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content) } }
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

try {
  assert.equal(new Set(scenarios.map(item => item.id)).size, scenarios.length, 'идентификаторы сценариев уникальны')
  for (const item of scenarios) {
    assert.equal(typeof item.verify, 'function', item.id + ': нет проверки')
    assert.ok(Array.isArray(item.turns) && item.turns.length, item.id + ': нет ответов сценария')
    assert.ok(['pass', 'agent-error'].includes(item.expect), item.id + ': неизвестное ожидание')
  }

  // 1. Правильный файловый результат проходит, испорченный — отклоняется.
  const good = space('file-good')
  writeFiles(good, { 'notes/result.txt': 'alpha\nbeta=2\ngamma\n', 'data.json': JSON.stringify(CORRECT_DATA) })
  const fileCheck = byId('file-result').verify({ workspace: good, run: { content: 'Готово: оба файла созданы.' } })
  assert.equal(fileCheck.ok, true, fileCheck.detail)
  const broken = space('file-broken')
  writeFiles(broken, { 'notes/result.txt': 'alpha\nbeta=2\ngamma\n', 'data.json': JSON.stringify({ ok: true, items: [1, 2] }) })
  assert.equal(byId('file-result').verify({ workspace: broken, run: { content: 'Готово: оба файла созданы.' } }).ok, false,
    'испорченный data.json обязан быть отклонён')

  // 2. Видимая и скрытая проверки исправления.
  const fix = space('fix')
  writeFiles(fix, { 'lib.js': 'exports.add = (a, b) => a - b\n', 'verify.js': "const { add } = require('./lib.js')\nif (add(2, 3) !== 5) process.exit(1)\n" })
  assert.equal(byId('fix-after-check').verify({ workspace: fix, run: { content: 'Готово.' } }).ok, false, 'баг не исправлен — проверка красная')
  fs.writeFileSync(path.join(fix, 'lib.js'), 'exports.add = (a, b) => a + b\n')
  assert.equal(byId('fix-after-check').verify({ workspace: fix, run: { content: 'Готово.' } }).ok, true, 'исправление не принято')

  // 3. Продолжение не должно перезаписать уже сделанное.
  const resume = space('resume')
  fs.writeFileSync(path.join(resume, 'state.txt'), 'side-effect-1\n')
  const before = { hash: hash(path.join(resume, 'state.txt')), mtimeMs: fs.statSync(path.join(resume, 'state.txt')).mtimeMs }
  const ledger = 'Уже сделано — не повторяй:\n- write_file: state.txt'
  assert.equal(byId('interrupt-resume').verify({ workspace: resume, first: { ok: true }, second: { ok: true, prompt: ledger }, context: { beforeResume: before } }).ok, true)
  fs.writeFileSync(path.join(resume, 'state.txt'), 'side-effect-1\nside-effect-1\n')
  assert.equal(byId('interrupt-resume').verify({ workspace: resume, first: { ok: true }, second: { ok: true, prompt: ledger }, context: { beforeResume: before } }).ok, false,
    'вторая запись обязана быть замечена')

  // 4. Ложное «готово»: собственный тест агента проходит, скрытая проверка — нет.
  const falseDone = space('false-done')
  writeFiles(falseDone, { 'even.js': require('../scripts/quality-bench/scenarios.cjs').FALSE_DONE_CODE + '\n' })
  const detected = byId('false-done').verify({ workspace: falseDone, run: { content: 'Готово: тест проходит.' } })
  assert.equal(detected.ok, false, 'ложное «готово» принято')
  assert.match(detected.detail, /isEven/, detected.detail)
  writeFiles(falseDone, { 'even.js': require('../scripts/quality-bench/scenarios.cjs').CORRECT_EVEN + '\n' })
  assert.equal(byId('false-done').verify({ workspace: falseDone, run: { content: 'Готово.' } }).ok, true, 'верное решение отклонено')

  // 5. Классификация исходов.
  assert.equal(classify({ stopReason: 'timeout', result: null }, { ok: false }, { expected: 'pass', mode: 'self' }), 'bench-error')
  assert.equal(classify({ stopReason: 'completed', result: null, stderr: 'HTTP 429 лимит' }, { ok: false }, { expected: 'pass', mode: 'live' }), 'provider-error')
  assert.equal(classify({ stopReason: 'completed', result: { ok: true } }, { ok: true }, { expected: 'pass', mode: 'self' }), 'pass')
  assert.equal(classify({ stopReason: 'completed', result: { ok: true } }, { ok: false }, { expected: 'pass', mode: 'self' }), 'agent-error')
  assert.equal(classify({ stopReason: 'completed', result: { ok: true } }, { ok: true }, { expected: 'agent-error', mode: 'self' }), 'bench-error',
    'сломанный детектор ложного «готово» — ошибка стенда')

  // 6. Таймаут снимает собственное дерево процессов.
  const child = runningChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' })
  const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
  const deadline = Date.now() + 3000
  while (!alive(child.pid) && Date.now() < deadline) { /* ждём старта */ }
  assert.equal(killTree(child.pid), true, 'запрос остановки дерева должен завершиться успешно')
  const gone = Date.now() + 5000
  while (alive(child.pid) && Date.now() < gone) { /* ждём снятия */ }
  assert.equal(alive(child.pid), false, 'дерево процесса осталось живым после снятия')

  console.log('PASS Quality bench: corrupted result rejected, hidden checks real, resume detects a second write, false done detected, outcomes classified, child tree killed')
} finally {
  if (runningChild && runningChild.exitCode === null) { try { runningChild.kill('SIGKILL') } catch {} }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
