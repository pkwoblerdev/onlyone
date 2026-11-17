// Тест детерминированного завершения (план 1.3.14):
// пропуск LLM-судьи при успешном коде 0 от тестов/проверок в toolLog.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

// Извлекаем функцию hasDeterministicProof из main.js
const start = src.indexOf('function hasDeterministicProof(')
assert.ok(start > 0, 'hasDeterministicProof не найден в main.js')
const end = src.indexOf('function ', start + 30)
assert.ok(end > start, 'конец hasDeterministicProof не найден')

// eslint-disable-next-line no-new-func
const { isVerificationCommand } = require('../src/main/verification.cjs')
const buildChecker = new Function('isVerificationCommand', `${src.slice(start, end)}\nreturn hasDeterministicProof;`)
const hasDeterministicProof = buildChecker(isVerificationCommand)

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log('ok', name)
  } catch (err) {
    failed++
    console.error('ПРОВАЛ', name, '-', err.message)
  }
}

check('npm test с кодом 0 признаётся детерминированным доказательством', () => {
  const log = [
    { tool: 'read_file', ok: true },
    { tool: 'edit_file', ok: true },
    { tool: 'run_command', command: 'npm test', ok: true, exitCode: 0 }
  ]
  assert.equal(hasDeterministicProof(log), true)
})

check('node tests/test-x.cjs с кодом 0 после правки признаётся детерминированным доказательством', () => {
  const log = [
    { tool: 'write_file', ok: true },
    { tool: 'run_command', detail: 'node tests/test-x.cjs', ok: true, exitCode: 0 }
  ]
  assert.equal(hasDeterministicProof(log), true)
})

// 11.10.2026: зелёный тест, который ничего не проверял в этом ходе, к просьбе не относится. Агент, не менявший ничего,
// мог прогнать любой посторонний тест и получить «готово» без судьи. Без правки решает судья.
check('зелёный тест без единой правки в ходе НЕ признаётся доказательством', () => {
  assert.equal(hasDeterministicProof([{ tool: 'read_file', ok: true }, { tool: 'run_command', command: 'npm test', ok: true, exitCode: 0 }]), false)
  assert.equal(hasDeterministicProof([{ tool: 'run_command', command: 'node tests/test-x.cjs', ok: true, exitCode: 0 }]), false)
})
check('правка, которая не удалась, не считается правкой', () => {
  assert.equal(hasDeterministicProof([{ tool: 'edit_file', ok: false }, { tool: 'run_command', command: 'npm test', ok: true, exitCode: 0 }]), false)
})
check('правка до проверки, а не после: считается', () => {
  assert.equal(hasDeterministicProof([{ tool: 'edit_file', ok: true }, { tool: 'read_file', ok: true }, { tool: 'run_command', command: 'npm test', ok: true, exitCode: 0 }]), true)
})

check('падающий тест (код 1) НЕ признаётся доказательством', () => {
  const log = [
    { tool: 'run_command', command: 'npm test', ok: false, exitCode: 1 }
  ]
  assert.equal(hasDeterministicProof(log), false)
})

check('обычная команда (git status / ls) без проверок НЕ признаётся доказательством', () => {
  const log = [
    { tool: 'run_command', command: 'git status', ok: true, exitCode: 0 }
  ]
  assert.equal(hasDeterministicProof(log), false)
})

check('dc_check с passed: true признаётся доказательством для дизайна', () => {
  const log = [
    { tool: 'dc_write', ok: true },
    { tool: 'dc_check', ok: true, passed: true }
  ]
  assert.equal(hasDeterministicProof(log), true)
})

check('dc_check с passed: false НЕ признаётся доказательством', () => {
  const log = [
    { tool: 'dc_check', ok: true, passed: false }
  ]
  assert.equal(hasDeterministicProof(log), false)
})

check('пустой журнал или без команд проверки возвращает false', () => {
  assert.equal(hasDeterministicProof([]), false)
  assert.equal(hasDeterministicProof([{ tool: 'read_file', ok: true }]), false)
})

check('команды git checkout test-branch или echo test НЕ признаются верификацией', () => {
  const log = [
    { tool: 'run_command', command: 'git checkout test-branch', ok: true, exitCode: 0 }
  ]
  assert.equal(hasDeterministicProof(log), false)
  const log2 = [
    { tool: 'run_command', command: 'echo test', ok: true, exitCode: 0 }
  ]
  assert.equal(hasDeterministicProof(log2), false)
})

check('успешный тест, после которого был упавший тест, НЕ признаётся доказательством', () => {
  const log = [
    { tool: 'run_command', command: 'npm test', ok: true, exitCode: 0 },
    { tool: 'run_command', command: 'npm test', ok: false, exitCode: 1 }
  ]
  assert.equal(hasDeterministicProof(log), false)
})

check('правка файлов (edit_file / write_file) ПОСЛЕ успешного теста аннулирует доказательство', () => {
  const log = [
    { tool: 'run_command', command: 'npm test', ok: true, exitCode: 0 },
    { tool: 'edit_file', ok: true }
  ]
  assert.equal(hasDeterministicProof(log), false)
})

check('TDD цикл (красный тест -> правка -> зелёный тест) признаётся доказательством', () => {
  const log = [
    { tool: 'run_command', command: 'npm test', ok: false, exitCode: 1 },
    { tool: 'edit_file', ok: true },
    { tool: 'run_command', command: 'npm test', ok: true, exitCode: 0 }
  ]
  assert.equal(hasDeterministicProof(log), true)
})

check('dc_write ПОСЛЕ успешного dc_check аннулирует доказательство', () => {
  const log = [
    { tool: 'dc_check', ok: true, passed: true },
    { tool: 'dc_write', ok: true }
  ]
  assert.equal(hasDeterministicProof(log), false)
})

check('missing exit code is not a successful verification', () => {
  assert.equal(hasDeterministicProof([{ tool: 'edit_file', ok: true }, { tool: 'run_command', command: 'npm test', ok: true }]), false)
})
check('arbitrary commands after tests invalidate file evidence, even on failure', () => {
  for (const ok of [true, false]) assert.equal(hasDeterministicProof([
    { tool: 'edit_file', ok: true }, { tool: 'run_command', command: 'npm test', ok: true, exitCode: 0 },
    { tool: 'run_command', command: 'node mutate.js', ok, exitCode: ok ? 0 : 1 }
  ]), false)
})
check('all Design mutation tools invalidate stale checks', () => {
  for (const tool of require('../src/main/agent-cycle').DC_MUTATION) {
    assert.equal(hasDeterministicProof([{ tool: 'dc_write', ok: true }, { tool: 'dc_check', ok: true, passed: true }, { tool, ok: true }]), false, tool)
  }
})

if (failed > 0) {
  process.exit(1)
}
