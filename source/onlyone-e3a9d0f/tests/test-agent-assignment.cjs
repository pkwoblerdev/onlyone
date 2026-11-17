// The agent hands out work by calling a tool, not by writing «Агент 2 — тесты»
// and hoping a regex finds it. That regex missed English, missed reformatting,
// and dropped whole assignments silently — after which every helper was skipped
// or, before that, every helper ran on the whole task.
//
// A tool call is structured, but the values in it still come from a model, so
// what arrives has to be checked: a number outside the team, the same agent
// twice, an empty brief. Acting on any of those produces exactly the invented
// work this design exists to avoid.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return src.slice(a, b)
}

const api = new Function(
  'const assignmentsByRequest = new Map()\n' +
  cut('function assignWorkSchema(helperCount) {', '// Тексты ролей команды') +
  '\nreturn { assignWorkSchema, recordAssignment, assignmentsByRequest }'
)()

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- the schema handed to the model -----------------------------------------

const schema = api.assignWorkSchema(3)
check('инструмент называется assign_work', schema.function.name === 'assign_work')
check('в описании сказано не вызывать без нужды',
  /Если справишься сам — не вызывай/.test(schema.function.description),
  schema.function.description)
check('названо число доступных помощников',
  /Помощников доступно: 3/.test(schema.function.description))

const props = schema.function.parameters.properties
check('назначение требует номера и задачи',
  props.assignments.items.required.join(',') === 'agent,task')
check('верхняя граница номера — по числу помощников',
  /до 4/.test(props.assignments.items.properties.agent.description),
  props.assignments.items.properties.agent.description)
check('от задачи требуют конкретики, а не «помочь»',
  /Не «помочь с задачей»/.test(props.assignments.items.properties.task.description))

// --- what comes back from the model -----------------------------------------

const record = (args, helpers = 3) => {
  api.assignmentsByRequest.delete('req')
  const out = api.recordAssignment('req', args, helpers)
  return { out, saved: api.assignmentsByRequest.get('req') }
}

const good = record({ assignments: [
  { agent: 2, task: 'прочитать тесты' },
  { agent: 3, task: 'проверить стили' }
] })
check('нормальное назначение принято', good.out.success === true, JSON.stringify(good.out))
check('оба помощника сохранены', good.saved.assignments.length === 2)
check('в ответ модели видно, кому что поручено',
  /Агент 2: прочитать тесты/.test(good.out.assigned), good.out.assigned)
check('модели сказано, что помощники ждут конца её хода',
  /пока ты не закончишь этот ход/.test(good.out.note))

// A number outside the team is not an assignment.
const outside = record({ assignments: [{ agent: 9, task: 'что-то' }] })
check('номер вне команды отброшен', outside.saved.assignments.length === 0)
check('и это признано неудачей', outside.out.success === false)
check('сказано, что делать вместо этого',
  /не вызывай assign_work, просто ответь сам/.test(outside.out.error), outside.out.error)

// The agent cannot assign work to itself: it is already running.
const itself = record({ assignments: [{ agent: 1, task: 'сам себе' }] })
check('сам себе задачу не поручает', itself.saved.assignments.length === 0)

// The same helper named twice is one helper.
const twice = record({ assignments: [
  { agent: 2, task: 'первое' },
  { agent: 2, task: 'второе' }
] })
check('повтор номера схлопывается', twice.saved.assignments.length === 1,
  JSON.stringify(twice.saved.assignments))
check('остаётся первое поручение', twice.saved.assignments[0].task === 'первое')

// An empty brief is worse than no assignment: it is an agent with nothing to do.
const empty = record({ assignments: [
  { agent: 2, task: '   ' },
  { agent: 3, task: 'настоящая часть' }
] })
check('пустое поручение отброшено', empty.saved.assignments.length === 1,
  JSON.stringify(empty.saved.assignments))
check('осмысленное рядом с пустым сохраняется', empty.saved.assignments[0].agent === 3)

// Nonsense shapes must not throw — this comes from a model.
check('без массива не падает', record({}).out.success === false)
check('мусор вместо номера не падает',
  record({ assignments: [{ agent: 'два', task: 'x' }] }).saved.assignments.length === 0)
check('null вместо аргументов не падает', record(null).out.success === false)

// Review defaults to on: the work coming back unchecked is the worse failure.
check('разбор работы по умолчанию включён',
  record({ assignments: [{ agent: 2, task: 'x' }] }).saved.review === true)
check('разбор нельзя выключить даже старым параметром',
  record({ assignments: [{ agent: 2, task: 'x' }], review: false }).saved.review === true)

// --- how the mode uses it ---------------------------------------------------

check('инструмент даётся только на ходе назначения',
  /payload\.canAssign \? \[assignWorkSchema/.test(src))
check('вызов перехватывается до обычных инструментов',
  src.indexOf("toolName === 'assign_work'") < src.indexOf("toolName.startsWith('mcp_')"))
check('без назначения помощники не запускаются',
  /if \(!plan\?\.assignments\?\.length\) break/.test(src))
// Круги переделки больше не отдельный счётчик режима: они тратят общий бюджет
// хода (agent-cycle.js, rounds) — иначе команда получала по два лимита на каждый
// лад и ни одного на весь ход.
check('число кругов ограничено общим бюджетом хода',
  /rounds: 2/.test(require('fs').readFileSync(require('path').join(__dirname, '../src/main/agent-cycle.js'), 'utf8')) &&
  /cycle\.spend\('rounds'\)/.test(src))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
