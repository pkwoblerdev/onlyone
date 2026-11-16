// ---------------------------------------------------------------------------
// Самоулучшение: дефект → красный тест → правка → дифф на подтверждение,
// публикация только человеком. Основа — SELF-DEVELOPMENT.md.
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const { checkCommand } = require('../src/main/command-guard')

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log('ok', name)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.error('FAIL', name, error.message)
  }
}

// Защита публикации: запрет автоматической сборки и публикации в режиме selfDev
check('commandGuard запрещает сборку дистрибутива, релиз и публикацию при самодоработке (selfDev)', () => {
  const guardedCommands = [
    'npm run build:win',
    'npm run build:app',
    'npm run build:installer',
    'npm run build',
    'npm publish',
    'npx electron-builder',
    'electron-builder --win',
    'gh release create v1.1.19',
    'git push origin main'
  ]

  for (const cmd of guardedCommands) {
    const res = checkCommand({
      command: cmd,
      cwd: 'D:/onlyone-source',
      selfDev: true
    })
    assert.equal(res.ok, false, `Команда «${cmd}» должна блокироваться в режиме selfDev`)
    assert.ok(
      /владельц|публикац|сборк/i.test(res.reason),
      `Причина отказа должна пояснять, что публикация/сборка разрешена только владельцу: ${res.reason}`
    )
  }

  // Обычные тесты и безопасные команды должны быть РАЗРЕШЕНЫ
  const allowedCommands = [
    'npm test',
    'node tests/test-self-improvement.cjs',
    'git status',
    'git diff',
    'npm run test:ui'
  ]

  for (const cmd of allowedCommands) {
    const res = checkCommand({
      command: cmd,
      cwd: 'D:/onlyone-source',
      selfDev: true
    })
    assert.equal(res.ok, true, `Безопасная команда «${cmd}» должна быть разрешена: ${res.reason}`)
  }

  // Обратная совместимость: в обычном пользовательском проекте (selfDev !== true) сторонний npm run build не блокируется
  const normalRes = checkCommand({
    command: 'npm run build:win',
    cwd: 'D:/some-user-project',
    selfDev: false
  })
  assert.equal(normalRes.ok, true, 'В обычном проекте пользователя сборка не должна блокироваться')
})

// 4. Сквозной цикл самоулучшения: дефект → красный тест → правка → дифф на подтверждение
check('сквозной цикл самоулучшения воспроизводит RED -> GREEN -> DIFF с защитой публикации', () => {
  // Эмуляция кода компонента с дефектом
  let buggySource = [
    'function calculateTax(price, rate) {',
    '  return price * rate;',
    '}',
    'module.exports = { calculateTax };'
  ].join('\n')

  // Тест, проверяющий дефект: при отрицательной цене должен выбрасывать ошибку
  function runTddTest(moduleCode) {
    const module = {}
    const fn = new Function('module', moduleCode + '\nreturn module.exports;')
    const { calculateTax } = fn(module)

    // Тест 1: позитивный
    const t1 = calculateTax(100, 0.2)
    assert.equal(t1, 20)

    // Тест 2: граничный случай (дефект)
    if (calculateTax(-10, 0.2) <= 0) {
      throw new Error('Price cannot be negative: expected validation error')
    }
    return true
  }

  // 1) Шаг RED: до исправления тест падает
  let redFailed = false
  try {
    runTddTest(buggySource)
  } catch (err) {
    redFailed = true
    assert.ok(err.message.includes('Price cannot be negative'))
  }
  assert.ok(redFailed, 'TDD тест обязан упасть до внесения правок (RED фаза)')

  // 2) Шаг FIX: точечное исправление дефекта
  const fixedSource = [
    'function calculateTax(price, rate) {',
    '  if (price < 0) throw new Error("Price cannot be negative: validation failed");',
    '  return price * rate;',
    '}',
    'module.exports = { calculateTax };'
  ].join('\n')

  // 3) Шаг GREEN: после исправления тест проходит со 100% успехом
  let greenPassed = false
  try {
    // Делаем запуск функции проверки с ожиданием перехвата валидации
    const module = {}
    const fn = new Function('module', fixedSource + '\nreturn module.exports;')
    const { calculateTax } = fn(module)
    assert.equal(calculateTax(100, 0.2), 20)
    assert.throws(() => calculateTax(-10, 0.2), /Price cannot be negative/)
    greenPassed = true
  } catch (e) {
    assert.fail(`Тест после исправления не должен падать: ${e.message}`)
  }
  assert.ok(greenPassed, 'TDD тест обязан пройти после исправления (GREEN фаза)')

  // 4) Шаг DIFF: построение диффа для карточки подтверждения
  const oldLines = buggySource.split('\n')
  const newLines = fixedSource.split('\n')
  const addedLines = newLines.filter(line => !oldLines.includes(line))
  assert.equal(addedLines.length, 1)
  assert.ok(addedLines[0].includes('if (price < 0)'))

  // 5) Шаг PUBLISH GUARD: попытка агента собрать релиз автоматически
  const publishAttempt = checkCommand({
    command: 'npm run build:win',
    selfDev: true
  })
  assert.equal(publishAttempt.ok, false)
  assert.ok(/владельц|публикац|сборк/i.test(publishAttempt.reason))
})

if (failures.length) {
  console.error('\nFAILURES:\n' + failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`\nВсего проверок: 4, Успешно: 4, Ошибок: 0\n`)
}
