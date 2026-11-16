// Команда агентов по слову человека: чистка настройки и подключение к сборке команды в главном процессе.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { sanitizeAgentTeam, isConfigured, modelOfAgent } = require('../src/main/agent-team.cjs')

let failed = 0
function check(name, fn) { try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) } }

check('по умолчанию — «Авто»: число не задано, моделей нет', () => {
  assert.deepEqual(sanitizeAgentTeam(undefined), { count: null, models: [] })
  assert.deepEqual(sanitizeAgentTeam({}), { count: null, models: [] })
  assert.equal(isConfigured(sanitizeAgentTeam(null)), false)
})
check('число агентов — целое от 1 до 8, остальное сбрасывается в «Авто»', () => {
  assert.equal(sanitizeAgentTeam({ count: 3 }).count, 3)
  for (const bad of [0, 9, -1, 2.5, '3', NaN, null]) assert.equal(sanitizeAgentTeam({ count: bad }).count, null, String(bad))
})
check('модели помощников: только настоящие id «вендор/имя», мусор становится «Авто», хвост пустых срезается', () => {
  const team = sanitizeAgentTeam({ count: 3, models: ['inception/mercury-2.5', 'не модель', 'cohere/north-mini-code:free', '', ''] })
  assert.deepEqual(team.models, ['inception/mercury-2.5', '', 'cohere/north-mini-code:free'])
  assert.deepEqual(sanitizeAgentTeam({ models: ['', ''] }).models, [])
  assert.equal(sanitizeAgentTeam({ models: ['a/b'.repeat(80)] }).models.length, 0, 'слишком длинный id отбрасывается')
  assert.ok(sanitizeAgentTeam({ models: new Array(30).fill('x/y') }).models.length <= 7, 'помощников не больше семи')
})
check('модель Агента N берётся из настройки со второго агента', () => {
  const team = sanitizeAgentTeam({ count: 3, models: ['a/one', 'b/two'] })
  assert.equal(modelOfAgent(team, 1), '', 'ведущего настройка не трогает')
  assert.equal(modelOfAgent(team, 2), 'a/one')
  assert.equal(modelOfAgent(team, 3), 'b/two')
  assert.equal(modelOfAgent(team, 4), '')
  assert.equal(isConfigured(team), true)
  assert.equal(isConfigured({ count: null, models: ['a/one'] }), true)
})
check('главный процесс: число и модели идут в сборку команды, один агент — без придуманных помощников', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.ok(main.includes('buildTeamRoster(team.count || keys.length)'))
  assert.ok(main.includes('const bound = chosenForSlot || keyObj.modelId'))
  assert.ok(main.includes('(Boolean(chosenForSlot) || !usedHelperModels.has(boundModel))'), 'одна и та же выбранная модель у двух агентов допустима')
  assert.ok(main.includes('readAgentTeam().count === 1'))
})
check('выбранная человеком модель не подменяется на бесплатную, даже платная (как привязка к ключу)', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.ok(main.includes('const chosenByHuman = Boolean(bound) && modelId === bound'))
})

if (failed) process.exit(1)
console.log('\nКоманда агентов: проверки пройдены')
