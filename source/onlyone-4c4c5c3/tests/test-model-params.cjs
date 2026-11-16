// A request carries a chain: a primary and up to two spares. The parameters were
// built from the primary alone, so when the primary did not think, `reasoning`
// was left off — and a thinking spare, asked for nothing, answered with its raw
// chain of thought. Measured on Nemotron Ultra, seen in the app as an answer
// that was visibly the model talking to itself.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return src.slice(a, b)
}

const CATALOG = {
  'plain/model:free': { id: 'plain/model:free' },
  'thinker/model:free': { id: 'thinker/model:free', supportsReasoning: true },
  'effort/model:free': { id: 'effort/model:free', supportsReasoning: true, supportedEfforts: ['low', 'high'] },
  'must/model:free': { id: 'must/model:free', reasoningMandatory: true, supportedEfforts: ['high'] }
}

// The real lookup is kept — only the catalogue under it is replaced, so the test
// exercises the same record-matching the app uses.
// The slice carries ANSWER_TOKENS with it, and that reads `app.isPackaged` to
// decide whether the end-to-end run may force the output cap down. A packaged
// app is the answer that keeps the constant at its real value.
const applyModelParams = new Function('modelCache', 'PRESET_MODELS', 'app', `
  const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'max']
  ${cut('function resolveEffort(model, requested) {', 'function applyModelParams(')}
  ${cut('function applyModelParams(bodyData, modelId, requestedEffort) {', 'async function fetchOpenRouterModels(')}
  return applyModelParams
`)({ models: Object.values(CATALOG) }, [], { isPackaged: true })

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const run = (model, models, effort = 'max') => {
  const body = { model, models }
  applyModelParams(body, model, effort)
  return body
}

// The case that produced the duplicate: a primary that does not think, a spare
// that does.
const rescued = run('plain/model:free', ['plain/model:free', 'thinker/model:free'])
check('за думающую запасную просят рассуждение',
  !!rescued.reasoning, JSON.stringify(rescued.reasoning))

// Nobody in the chain thinks: nothing is asked for, as before.
const quiet = run('plain/model:free', ['plain/model:free'])
check('без думающих моделей поле не добавляется',
  !quiet.reasoning, JSON.stringify(quiet.reasoning))

// The primary already decided the effort — a spare must not overwrite it.
const owned = run('effort/model:free', ['effort/model:free', 'thinker/model:free'], 'high')
check('усилие основной модели сохраняется',
  owned.reasoning?.effort === 'high', JSON.stringify(owned.reasoning))

// Reasoning explicitly off stays off, spares or not.
const off = run('plain/model:free', ['plain/model:free', 'thinker/model:free'], 'off')
check('явное «выключено» уважается', !off.reasoning, JSON.stringify(off.reasoning))

// A model that cannot run without reasoning still gets it even when it is the
// only entry.
const forced = run('must/model:free', ['must/model:free'], 'off')
check('обязательное рассуждение включено', !!forced.reasoning, JSON.stringify(forced.reasoning))

// An unknown primary with a thinking spare: unknown means no record, so the
// spare is the only evidence there is.
const unknown = run('nobody/knows:free', ['nobody/knows:free', 'must/model:free'])
check('неизвестная основная не мешает запасной', !!unknown.reasoning, JSON.stringify(unknown.reasoning))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
