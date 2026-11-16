const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { readGuide, buildGuideContext } = require('../src/main/work-guides')
const { completionContract } = require('../src/main/agent-completion')

const mainSrc = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')

console.log('--- 1. Тестирование распознавания интентов Автономность и синтез инструментов & Continuous ---')

const marksMatch = mainSrc.match(/const WHOLE_JOB_MARKS = \[([\s\S]*?)\]\r?\n\r?\nfunction wantsWholeJob/m)
assert(marksMatch, 'WHOLE_JOB_MARKS должен быть определён в main.js')

const requiredPatterns = [
  /беспрерывн/i,
  /без\s+остановок/i,
  /нон-?стоп/i,
  /автономн/i,
  /harness/i,
  /deepseek[-_ ]?harness/i,
  /не\s+прерывайся/i,
  /работай\s+сам\s+до\s+конца/i
]

for (const p of requiredPatterns) {
  assert(requiredPatterns.some(req => marksMatch[1].includes(req.source)), `Паттерн ${p} должен присутствовать в WHOLE_JOB_MARKS`)
}

const testRegexes = eval(`[${marksMatch[1]}]`)
function testWantsWholeJob(text) {
  return testRegexes.some(re => re.test(text))
}

const positiveCases = [
  'работать полностью беспрерывно',
  'делай без остановок',
  'выполняй нон-стоп',
  'работай нонстоп до результата',
  'переходи в автономный режим',
  'действуй автономно',
  'используй deepseek-harness для автоматизации',
  'включи deepseek harness',
  'не прерывайся пока всё не проверишь',
  'работай сам до конца',
  'сделай всё полностью',
  'доделай до конца'
]

for (const text of positiveCases) {
  assert(testWantsWholeJob(text), `Должен распознать непрерывную работу: "${text}"`)
}

const negativeCases = [
  'привет, как дела?',
  'почему здесь ошибка?',
  'покажи файл main.js',
  'что делает эта функция?'
]

for (const text of negativeCases) {
  assert(!testWantsWholeJob(text), `Не должен ложно срабатывать на обычный вопрос: "${text}"`)
}

console.log('✓ Распознавание интентов непрерывной/автономной работы успешно')

console.log('--- 2. Тестирование рабочей памятки agent-tool-harness ---')

const catalog = readGuide().guides
const guideEntry = catalog.find(g => g.id === 'agent-tool-harness')
assert(guideEntry, 'Памятка должна быть в каталоге')
assert.equal(guideEntry.scope, 'agent', 'Памятка должна иметь scope agent')

const guide = readGuide('agent-tool-harness')
assert.equal(guide.success, true, 'Памятка должна успешно читаться')
assert(guide.instructions.length > 200, 'Памятка должна содержать подробные инструкции')
assert(guide.instructions.includes('define_tool'), 'Памятка должна описывать define_tool')
assert(guide.instructions.includes('own_'), 'Памятка должна упоминать префикс own_')
assert(guide.instructions.includes('harnessHint'), 'Памятка должна описывать harnessHint')

const contextWithHarness = buildGuideContext('работай автономно и создавай нужные инструменты через deepseek-harness', false)
assert(contextWithHarness.includes('[agent-tool-harness;'), 'Роутер памяток должен подключать agent-tool-harness для релевантной задачи')

console.log('✓ Памятка agent-tool-harness проверена')

console.log('--- 3. Тестирование контракта завершения (completionContract) ---')

const contract = completionContract()
assert(contract.includes('Автономность и синтез инструментов'), 'Контракт должен содержать секцию Автономность и синтез инструментов')
assert(contract.includes('define_tool'), 'Контракт должен упоминать define_tool')
assert(contract.includes('own_<имя>'), 'Контракт должен упоминать own_<имя>')
assert(contract.includes('harnessHint'), 'Контракт должен упоминать подсказку harnessHint')

console.log('✓ Контракт завершения содержит правила синтеза инструментов и самовосстановления')

console.log('--- 4. Тестирование подсказки самовосстановления в runCustomTool ---')

assert(mainSrc.includes('harnessHint: `При ошибке инструмента исправь его код через define_tool'), 'runCustomTool должен возвращать harnessHint при ошибке выполнения инструмента')

console.log('✓ Механизм самовосстановления инструментов подтверждён')

console.log('--- 5. Тестирование buildWholeJobBlock ---')

assert(mainSrc.includes('продолжай автономную работу до завершения задачи.'), 'buildWholeJobBlock сохраняет правило непрерывной работы')

console.log('Проверки автономной работы пройдены')
