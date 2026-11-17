'use strict'

// break-4 Н10: пучок мелких подтверждённых дефектов состояния задачи.
// 1) dependsOn: [] (пустой массив истинный) — подтверждение никогда не отзывается
//    при изменении входов; путь — унаследованный/правленый файл контрольной точки.
// 3) cleanTaskState выбрасывает требования свыше 80 без счётчика droppedRequirements.
// 4) `node ./tests/x.cjs` не распознаётся как проверка (класс не содержит `.`).
// Подпункт 2 (полный журнал неизвестных) НЕ чинится: намеренный контракт вытеснения
// (test-task-state-eviction «при 200 неизвестных ни одно не вытесняется», аудит 31.10).

const assert = require('node:assert/strict')
const { createTaskState, cleanTaskState } = require('../src/main/task-state.cjs')
const { isVerificationCommand } = require('../src/main/verification.cjs')

let fails = 0
const check = (name, fn) => {
  try { fn(); console.log('ok   ' + name) } catch (error) { fails++; console.log('FAIL ' + name + ' :: ' + error.message) }
}

// 1. Пустой dependsOn из файла — это «карта неизвестна», а не «ни от чего не зависит».
check('Н10: empty dependsOn from file goes stale on input change', () => {
  const task = createTaskState({
    now: () => 1,
    restored: {
      schemaVersion: 1,
      inputs: {},
      evidence: [{ id: 'e1', source: 'command', verdict: 'pass', inputs: {}, at: 1 }],
      requirements: [{ id: 'r1', expected: 'A', state: 'confirmed', confirmedBy: 'e1', dependsOn: [], history: [] }]
    }
  })
  assert.equal(task.get('r1').state, 'confirmed')
  task.setInput('api', 'v1')
  assert.equal(task.get('r1').state, 'stale', 'подтверждение не отозвано при изменении входов (dependsOn: [])')
})

// 1b. require с пустым массивом нормализуется так же.
check('Н10: require normalizes empty dependsOn to unknown map', () => {
  const task = createTaskState({ now: () => 1 })
  task.require({ id: 'r2', expected: 'B', dependsOn: [] })
  assert.equal(task.snapshot().requirements.find(r => r.id === 'r2').dependsOn, null, 'пустой массив сохранён как карта')
})

// Отрицательный контроль: названная карта зависимостей остаётся адресной.
check('NEG: named dependsOn stays address-based', () => {
  const task = createTaskState({ now: () => 1 })
  task.require({ id: 'api', expected: 'API отвечает', dependsOn: ['api'] })
  task.require({ id: 'ui', expected: 'Кнопка видна', dependsOn: ['ui'] })
  for (const id of ['api', 'ui']) { task.move(id, 'in_progress'); task.move(id, 'verifying') }
  task.setInput('api', 'v1'); task.setInput('ui', 'v1')
  task.addEvidence({ source: 'observation', verdict: 'pass', coverage: 'оба сверены' })
  task.setInput('api', 'v2')
  assert.equal(task.get('api').state, 'stale')
  assert.equal(task.get('ui').state, 'confirmed', 'чужой вход отозвал подтверждение')
})

// 3. Требования свыше 80 считаются выпавшими, а не исчезают молча.
check('Н10: requirements over 80 increase droppedRequirements', () => {
  const raw = {
    schemaVersion: 1,
    droppedRequirements: 2,
    requirements: Array.from({ length: 85 }, (_, i) => ({ id: 'r' + i, expected: 'R' + i, state: 'not_started' }))
  }
  const clean = cleanTaskState(raw)
  assert.equal(clean.requirements.length, 80)
  assert.equal(clean.droppedRequirements, 7, 'выпавшие требования не посчитаны: ' + clean.droppedRequirements)
})

// Отрицательный контроль: ровно 80 — счётчик не растёт, прежний счёт наследуется.
check('NEG: exactly 80 requirements keep the inherited counter', () => {
  const raw = {
    schemaVersion: 1,
    droppedRequirements: 3,
    requirements: Array.from({ length: 80 }, (_, i) => ({ id: 'r' + i, expected: 'R' + i, state: 'not_started' }))
  }
  const clean = cleanTaskState(raw)
  assert.equal(clean.requirements.length, 80)
  assert.equal(clean.droppedRequirements, 3)
})

// 4. node ./tests/x.cjs — проверка.
check('Н10: node ./tests/x.cjs is a verification command', () => {
  assert.equal(isVerificationCommand('node ./tests/x.cjs --grep nothing'), true)
  assert.equal(isVerificationCommand('node ./test/x.cjs'), true)
})

// Отрицательные контроли: прежние распознавания и отказы на месте.
check('NEG: verification recognition unchanged otherwise', () => {
  assert.equal(isVerificationCommand('node tests/x.cjs'), true)
  assert.equal(isVerificationCommand('npm test'), true)
  assert.equal(isVerificationCommand('npx jest'), true)
  assert.equal(isVerificationCommand('node ./secret.cjs'), false)
  assert.equal(isVerificationCommand('echo test'), false)
  assert.equal(isVerificationCommand('git checkout test-branch'), false)
  assert.equal(isVerificationCommand('cat tests/fixture.json'), false)
  assert.equal(isVerificationCommand('node ./tests/x.cjs && rm -rf /'), false, 'цепочка стала проверкой')
})

console.log(fails ? `\nFAILS=${fails}` : '\nALL OK')
process.exit(fails ? 1 : 0)