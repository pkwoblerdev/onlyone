// Порядок реплик после вызова инструментов.
//
// На сообщение модели с несколькими вызовами провайдер ждёт ответы на все вызовы
// подряд, и только потом что-то ещё. Снимок экрана шёл репликой сразу за своим
// ответом: вызов снимка и вызов проверки в одном шаге давали «ответ — картинка —
// ответ», и провайдер отвергал всю переписку. Новости команды — такая же реплика,
// и им место там же: после всех ответов.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const CR = String.fromCharCode(13)
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8').split(CR).join('')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const loopStart = main.indexOf('    for (const call of stepResult.toolCalls) {')
const loopEnd = main.indexOf('    messages.push(...afterTools)', loopStart)
const loop = main.slice(loopStart, loopEnd)

check('реплики после инструментов копятся до конца шага', () => {
  assert(main.lastIndexOf('const afterTools = []', loopStart) > 0, 'нет накопителя перед циклом вызовов')
  assert(loopEnd > loopStart, 'нет добавления после цикла вызовов')
})

check('внутри цикла вызовов в переписку попадают только ответы инструментов', () => {
  const pushes = [...loop.matchAll(/messages\.push\(\{\s*role: '([a-z]+)'/g)].map(m => m[1])
  assert(pushes.length > 0, 'в цикле нет ни одного ответа')
  assert(pushes.every(role => role === 'tool'), 'в цикле есть не-ответы: ' + pushes.join(', '))
})

check('снимок и пояснение к нему идут через накопитель', () => {
  assert.match(loop, /afterTools\.push\(\{ role: 'user', content: \[/)
  assert.match(loop, /afterTools\.push\(\{ role: 'user', content:\s*'Эта модель не принимает изображения/)
})

check('новости команды добавляются в начале следующего шага, когда все ответы уже есть', () => {
  const stepStart = main.indexOf('for (let step = 0; step < MAX_AGENT_STEPS; step++) {')
  const news = main.indexOf("messages.push({ role: 'user', content: news })", stepStart)
  const assistant = main.indexOf("role: 'assistant',\n      content: stepResult.content || '',", stepStart)
  assert(news > stepStart && news < assistant, 'новости должны приходить до запроса модели на шаге')
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
