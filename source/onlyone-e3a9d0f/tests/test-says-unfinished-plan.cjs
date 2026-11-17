// Тест Д-6 (план 1.3.14):
// Самопродление saysUnfinished срабатывает ТОЛЬКО при наличии активного чек-листа task_plan с незавершёнными пунктами.
// Если плана нет или все пункты выполнены, рекомендации модели на будущее не запускают бесконечный платный цикл.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

// Извлекаем saysUnfinished и shouldSelfContinue из main.js
const start = src.indexOf('function shouldSelfContinue(')
assert.ok(start > 0, 'shouldSelfContinue не найден в main.js')
const end = src.indexOf('function seamOverlap(', start)
assert.ok(end > start, 'конец shouldSelfContinue не найден')

const { openPlanItems } = require('../src/main/agent-completion.js')

// Извлекаем UNFINISHED_MARKS и NEXT_STEP_MARKS
const marksStart = src.indexOf('const UNFINISHED_MARKS = [')
const marksEnd = src.indexOf('function saysUnfinished(', marksStart)
const marksCode = src.slice(marksStart, marksEnd)

const saysStart = src.indexOf('function saysUnfinished(')
const saysEnd = src.indexOf('function shouldSelfContinue(')
const saysCode = src.slice(saysStart, saysEnd)

const code = `${marksCode}\n${saysCode}\n${src.slice(start, end)}\nreturn shouldSelfContinue;`
// eslint-disable-next-line no-new-func
const buildShouldContinue = new Function('openPlanItems', 'messageText', code)
const messageText = (m) => typeof m === 'string' ? m : m?.text || m?.content || ''
const shouldSelfContinue = buildShouldContinue(openPlanItems, messageText)

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

const futureRecommendations = 'Всё готово. На будущее ещё не сделано: следующий шаг — можно добавить кэширование.'
const toolLog = [{ tool: 'run_command', ok: true }]

check('без плана текст с «не сделано/следующий шаг» НЕ вызывает самопродление', () => {
  const res = shouldSelfContinue({
    content: futureRecommendations,
    toolLog,
    selfContinues: 0,
    selfContinueLimit: 3,
    plan: null
  })
  assert.equal(res, false, 'без плана должно быть false')
})

check('когда все пункты плана закрыты, текст с «не сделано» НЕ вызывает самопродление', () => {
  const planAllDone = [
    { id: '1', title: 'Шаг 1', status: 'done' },
    { id: '2', title: 'Шаг 2', status: 'done' }
  ]
  const res = shouldSelfContinue({
    content: futureRecommendations,
    toolLog,
    selfContinues: 0,
    selfContinueLimit: 3,
    plan: planAllDone
  })
  assert.equal(res, false, 'при закрытом плане должно быть false')
})

check('когда в плане есть незавершённые пункты (todo/doing), самопродление срабатывает', () => {
  const planWithTodo = [
    { id: '1', title: 'Шаг 1', status: 'done' },
    { id: '2', title: 'Шаг 2', status: 'todo' }
  ]
  const res = shouldSelfContinue({
    content: futureRecommendations,
    toolLog,
    selfContinues: 0,
    selfContinueLimit: 3,
    plan: planWithTodo
  })
  assert.equal(res, true, 'при наличии незакрытых пунктов плана должно быть true')
})

check('при исчерпании лимита selfContinues самопродление НЕ срабатывает', () => {
  const planWithTodo = [{ id: '1', title: 'Шаг 1', status: 'todo' }]
  const res = shouldSelfContinue({
    content: futureRecommendations,
    toolLog,
    selfContinues: 3,
    selfContinueLimit: 3,
    plan: planWithTodo
  })
  assert.equal(res, false)
})

check('при пустом toolLog самопродление НЕ срабатывает', () => {
  const planWithTodo = [{ id: '1', title: 'Шаг 1', status: 'todo' }]
  const res = shouldSelfContinue({
    content: futureRecommendations,
    toolLog: [],
    selfContinues: 0,
    selfContinueLimit: 3,
    plan: planWithTodo
  })
  assert.equal(res, false)
})

if (failed > 0) {
  process.exit(1)
}
