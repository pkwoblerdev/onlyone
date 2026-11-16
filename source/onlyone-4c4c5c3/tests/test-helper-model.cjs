// Модель помощника по просьбе: «второго поставь на GLM 5.3». Бесплатную назначать можно, платную — только если человек назвал её сам.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { resolveHelperModel } = require('../src/main/helper-model.cjs')
const { namedModelInText, similarModels, maxAgentsInText } = require('../src/main/named-model.cjs')

let failed = 0
function check(name, fn) { try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) } }

const catalog = [
  { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', isFree: false },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra', isFree: true },
  { id: 'openai/gpt-x', name: 'GPT X', isFree: false },
  { id: 'vendor/no-tools', name: 'Без инструментов', isFree: true }
]
const deps = userText => ({
  catalog, userText,
  exists: id => catalog.some(model => model.id === id),
  canCallTools: id => id !== 'vendor/no-tools',
  isFree: id => catalog.find(model => model.id === id)?.isFree === true
})

check('модель не названа — всё как раньше (помощник идёт на подобранной)', () => {
  assert.deepEqual(resolveHelperModel('', deps('')), { ok: true, id: '' })
  assert.deepEqual(resolveHelperModel(undefined, deps('')), { ok: true, id: '' })
})
check('бесплатную модель назначить можно по имени, по id и по концу id', () => {
  for (const ask of ['Nemotron 3 Ultra', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'nemotron-3-ultra-550b-a55b:free']) {
    assert.equal(resolveHelperModel(ask, deps('')).id, 'nvidia/nemotron-3-ultra-550b-a55b:free', ask)
  }
})
check('платную — только если человек назвал именно её', () => {
  assert.equal(resolveHelperModel('GLM 5.3 Flash', deps('второго поставь на GLM 5.3 Flash')).ok, true)
  assert.equal(resolveHelperModel('z-ai/glm-5.3-flash', deps('помощника на z-ai/glm-5.3-flash')).ok, true)
  const refused = resolveHelperModel('GLM 5.3 Flash', deps('сделай рефакторинг'))
  assert.equal(refused.ok, false)
  assert.match(refused.error, /платная/)
})
check('несуществующая и неумеющая в инструменты модель отклоняются с понятной причиной', () => {
  assert.match(resolveHelperModel('Выдуманная-9', deps('')).error, /не найдена/)
  assert.match(resolveHelperModel('vendor/no-tools', deps('')).error, /инструмент/)
})
check('в assign_work есть поле model, а /agent вернулся и называет модель помощника', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.match(main, /model: \{ type: 'string', description: 'Необязательно\. Модель этого помощника/)
  assert.match(main, /recordAssignment\(payload\.requestId, args, payload\.helperCount \|\| 0, lastUserMessage\(payload\)\)/)
  // Список команд «/» живёт в slash-commands.js (вынесен из app.js)
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/slash-commands.js'), 'utf8')
  assert.match(app, /cmd: '\/agent'/)
  assert.match(app, /Агент-режим: разбери задачу/)
})

check('модель, названная в просьбе, находится (случай владельца: agent inception/mercury-decide:free)', () => {
  const cat = [{ id: 'inception/mercury-decide:free', name: 'Mercury Decide' }, { id: 'openai/gpt-x', name: 'GPT X' }]
  const prompt = 'Your task with agent inception/mercury-decide:free is to monitor the 5-minute Bitcoin chart on Polymarket. Reply in Russian.'
  assert.equal(namedModelInText(prompt, cat).id, 'inception/mercury-decide:free')
  assert.equal(namedModelInText('сделай через openai/gpt-x.', cat).id, 'openai/gpt-x', 'точка в конце не мешает')
  assert.deepEqual(namedModelInText('поставь модель openai/ghost-9 пожалуйста', cat), { unknown: 'openai/ghost-9' })
  assert.deepEqual(namedModelInText('agent vendor/ghost-9', cat), {}, 'вендора нет в каталоге — это не имя модели')
  assert.deepEqual(namedModelInText('открой src/main/main.js и https://polymarket.com/event', cat), {}, 'пути и адреса — не модели')
  assert.deepEqual(namedModelInText('привет', cat), {})
})
check('случай владельца: модели нет в каталоге чат-моделей — «неизвестная», найдены похожие; «only 2 agent» — предел команды', () => {
  const cat = [{ id: 'inception/mercury-2.5', name: 'Mercury 2.5' }, { id: 'inception/mercury-2', name: 'Mercury 2' }, { id: 'openai/gpt-x', name: 'GPT X' }]
  const prompt = '/agent Your task with agent inception/mercury-decide:free is to monitor. Only 2 agent you and inception/mercury-decide:free.'
  assert.deepEqual(namedModelInText(prompt, cat), { unknown: 'inception/mercury-decide:free' })
  assert.deepEqual(similarModels('inception/mercury-decide:free', cat).map(item => item.id), ['inception/mercury-2.5', 'inception/mercury-2'])
  assert.equal(maxAgentsInText(prompt), 2)
  assert.equal(maxAgentsInText('только два агента'), 2)
  assert.equal(maxAgentsInText('Только 3 агента'), 3)
  assert.equal(maxAgentsInText('работайте вместе'), null)
})
check('названная модель становится Агентом 2 при прежнем ведущем; случайных помощников нет', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.ok(!main.includes('if (named.id) payload.collaborative = true'), 'командная работа включается только вместе с созданным помощником')
  assert.ok(/ {6}payload.collaborative = true/.test(main))
  assert.ok(main.includes('if (named.id && lead.modelId !== named.id) {'))
  assert.ok(main.includes("modelId: named.id, modelName: record?.name || named.name"))
  assert.ok(!main.includes('payload.model = named.id'), 'ведущего названная модель не подменяет')
  assert.ok(!main.includes('soloNamed'))
})

if (failed) process.exit(1)
console.log('\nМодель помощника по просьбе: проверки пройдены')
