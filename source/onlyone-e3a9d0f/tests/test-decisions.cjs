// Помощник по решениям (inception/mercury-decide:free и подобные): разбор метаданных, проверка аргументов, ответ словами.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describeModelMeta, buildRequest, formatAnswers, TOOL } = require('../src/main/decisions.cjs')

let failed = 0
function check(name, fn) { try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) } }

const GOOD = {
  state: { symbol: 'BTC', window: '5m', open: 85735, now: 85717 },
  questions: {
    direction: { type: 'choice', instructions: 'Куда пойдёт следующая свеча?', criteria: { up: 'вверх', down: 'вниз', flat: 'без изменений' } },
    notable: { type: 'noul', instructions: 'Движение существенное?', criteria: { true: 'да', false: 'нет' } },
    urgency: { type: 'score', instructions: 'Насколько срочно смотреть?', criteria: ['можно подождать', 'посмотреть скоро', 'срочно'] }
  }
}

check('метаданные: модель-решатель распознаётся по выходной модальности «decisions»', () => {
  const meta = describeModelMeta({ data: { id: 'inception/mercury-decide:free', name: 'Inception: Mercury Decide (free)', architecture: { output_modalities: ['decisions'] } } })
  assert.deepEqual(meta, { found: true, id: 'inception/mercury-decide:free', name: 'Inception: Mercury Decide', decision: true, chat: false })
  assert.equal(describeModelMeta({ data: { id: 'x/y', architecture: { output_modalities: ['text'] } } }).decision, false)
  assert.equal(describeModelMeta({ error: { code: 404 } }).found, false)
})
check('запрос: корректные вопросы всех трёх типов собираются в тело для endpoint', () => {
  const built = buildRequest('inception/mercury-decide:free', GOOD)
  assert.equal(built.ok, true)
  assert.equal(built.body.model, 'inception/mercury-decide:free')
  assert.deepEqual(Object.keys(built.body.questions), ['direction', 'notable', 'urgency'])
  assert.deepEqual(built.body.questions.urgency.criteria, ['можно подождать', 'посмотреть скоро', 'срочно'])
})
check('запрос: кривые аргументы отклоняются словами, что поправить', () => {
  const bad = (change, rx) => { const copy = JSON.parse(JSON.stringify(GOOD)); change(copy); const r = buildRequest('m', copy); assert.equal(r.ok, false); assert.match(r.error, rx) }
  bad(c => { c.state = 'строка' }, /state должен быть объектом/)
  bad(c => { c.questions = {} }, /хотя бы один вопрос/)
  bad(c => { c.questions.direction.type = 'poem' }, /choice, noul или score/)
  bad(c => { c.questions.direction.instructions = '' }, /текст вопроса/)
  bad(c => { c.questions.notable.criteria = { yes: 'да' } }, /true и false/)
  bad(c => { c.questions.urgency.criteria = ['одна'] }, /2–10 описаний/)
  bad(c => { c.questions['плохой id'] = c.questions.notable }, /латиницы/)
  bad(c => { c.state = { text: 'я'.repeat(13000) } }, /слишком большой/)
})
check('ответ переводится в короткий текст с вероятностями', () => {
  const text = formatAnswers({ answers: {
    notable: { type: 'noul', noul: 0.04 },
    direction: { type: 'choice', choice: 'flat', confidence: 0.6, probabilities: { up: 0.2, down: 0.2, flat: 0.6 } },
    urgency: { type: 'score', score: 0.4, confidence: 0.9, probabilities: { 0: 0.6, 1: 0.4 }, legend: { 0: 'можно подождать', 1: 'посмотреть скоро', 2: 'срочно' } }
  } })
  assert.match(text, /notable: вероятность «да» 4%/)
  assert.match(text, /direction: выбор «flat», уверенность 60% \(flat 60%, up 20%, down 20%\)/)
  assert.match(text, /urgency: позиция 0\.40 на шкале 0…2 \(«можно подождать»\)/)
  assert.match(formatAnswers({}), /не вернул ответов/)
})
check('инструмент ask_decision описан и подключён в главном процессе к endpoint /api/alpha/decisions', () => {
  assert.equal(TOOL.function.name, 'ask_decision')
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.ok(main.includes('/api/alpha/decisions'))
  assert.ok(main.includes("toolName === 'ask_decision'"))
  assert.ok(main.includes('decisionTurns'))
})

if (failed) process.exit(1)
console.log('\nПомощник по решениям: проверки пройдены')
