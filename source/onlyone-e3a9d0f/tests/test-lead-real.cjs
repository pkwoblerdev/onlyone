// The lead assignment, checked against the real constants rather than stubs.
//
// It was wrong twice. The first fix set the lead's model and the next block
// overwrote it; the stubbed test could not see that because its stub bindings
// were always valid, so the overwriting branch never ran. This test takes the
// pools, the lead model and the free-model rule straight out of main.js and
// feeds them a catalogue shaped like the real one.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const grabList = name => {
  const m = new RegExp('const ' + name + ' = \\[([^\\]]*)\\]').exec(src)
  if (!m) throw new Error(name + ' не найдена')
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}
const grabString = name => {
  const m = new RegExp("const " + name + " = '([^']+)'").exec(src)
  if (!m) throw new Error(name + ' не найдена')
  return m[1]
}

const LEAD_MODEL = grabString('LEAD_MODEL')
const AUTO_CODER_MODELS = grabList('AUTO_CODER_MODELS')
const AUTO_REVIEWER_MODELS = grabList('AUTO_REVIEWER_MODELS')
const DEFAULT_MODEL = grabString('DEFAULT_MODEL')

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return src.slice(a, b)
}

// The real roster and the real casting logic.
const buildTeamRoster = new Function(cut('function buildTeamRoster(keyCount) {', '\nfunction ') + '\nreturn buildTeamRoster')()

const resolveAgentSlots = new Function(
  'getEnabledKeys', 'buildTeamRoster',
  'findModelRecord', 'modelExists', 'modelCanCallTools', 'autoPickToolModel',
  'AUTO_CODER_MODELS', 'AUTO_REVIEWER_MODELS', 'DEFAULT_MODEL', 'LEAD_MODEL', 'isFreeModel',
  cut('function resolveAgentSlots(payload) {', '\nfunction ') + '\nreturn resolveAgentSlots'
)

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// A catalogue holding every model the app actually names.
const known = new Set([LEAD_MODEL, DEFAULT_MODEL, ...AUTO_CODER_MODELS, ...AUTO_REVIEWER_MODELS])
const isFree = id => id.endsWith(':free')

function build(keys, { brokenTools = new Set(), missing = new Set() } = {}) {
  return resolveAgentSlots(
    () => keys,
    buildTeamRoster,
    id => (known.has(id) && !missing.has(id) ? { id, name: id, isFree: isFree(id) } : null),
    id => known.has(id) && !missing.has(id),
    id => known.has(id) && !missing.has(id) && !brokenTools.has(id),
    (pool, taken = new Set()) => pool.filter(id => !brokenTools.has(id)).find(id => !taken.has(id)) || pool[0],
    AUTO_CODER_MODELS, AUTO_REVIEWER_MODELS, DEFAULT_MODEL, LEAD_MODEL, isFree
  )
}

// The configuration itself, before any casting.
check('платная модель ровно одна и это ведущий', !isFree(LEAD_MODEL), LEAD_MODEL)
check('в пуле исполнителей нет платных',
  AUTO_CODER_MODELS.every(isFree), AUTO_CODER_MODELS.filter(id => !isFree(id)).join(', '))
check('в пуле ревьюеров нет платных',
  AUTO_REVIEWER_MODELS.every(isFree), AUTO_REVIEWER_MODELS.filter(id => !isFree(id)).join(', '))
check('модель по умолчанию бесплатная', isFree(DEFAULT_MODEL), DEFAULT_MODEL)

const keys = n => Array.from({ length: n }, (_, i) => ({ id: 'k' + i, name: 'Ключ ' + i }))

// Four keys, nothing bound: the shape the user actually runs.
const four = build(keys(4))({ model: DEFAULT_MODEL })
check('четыре ключа — четыре агента', four.length === 4, 'слотов ' + four.length)
check('ведущий на выбранной модели', four[0].modelId === DEFAULT_MODEL, four[0].modelId)
check('остальные бесплатные', four.slice(1).every(s => isFree(s.modelId)),
  four.map(s => s.modelId).join(', '))
check('модели не повторяются',
  new Set(four.map(s => s.modelId)).size === four.length, four.map(s => s.modelId).join(', '))

// Every way the lead used to be unseated.
const cases = [
  ['ключ привязан к негодной модели', { modelId: 'openai/does-not-exist:free' }, {}],
  ['ключ привязан к исчезнувшей', { modelId: 'stealth/ox-alpha' }, {}],
  ['GLM объявлена негодной для инструментов', {}, { brokenTools: new Set([LEAD_MODEL]) }]
]
for (const [label, keyExtra, opts] of cases) {
  const slots = build([{ id: 'k0', name: 'A', ...keyExtra }, ...keys(2)], opts)({ model: DEFAULT_MODEL })
  check(`ведущий остаётся на выбранной модели: ${label}`, slots[0].modelId === DEFAULT_MODEL, slots[0].modelId)
  check(`и помощники остаются бесплатными: ${label}`,
    slots.slice(1).every(s => isFree(s.modelId)), slots.map(s => s.modelId).join(', '))
}

// If GLM itself vanished from the catalogue there is nothing to seat — and the
// replacement must still be free rather than some other paid model.
const gone = build(keys(3), { missing: new Set([LEAD_MODEL]) })({})
check('без GLM в каталоге ведущий получает бесплатную',
  isFree(gone[0].modelId), gone[0].modelId)

// One key is one slot, and that slot is the one taking the task — so it is cast
// as such and seated on the paid lead model whatever the picker said. Solo used
// to be the escape from that; there is no Solo now, so this is every turn on a
// single-key setup, and it is the one thing collapsing the modes made cost more.
const solo = build(keys(1))({ model: DEFAULT_MODEL })
check('на одном ключе слот один', solo.length === 1, 'слотов ' + solo.length)
check('и он садится на модель ведущего',
  solo[0].modelId === DEFAULT_MODEL, solo[0].modelId)

// The lead's own prompt has to actually hand out the work by name, or the others
// have nothing to act on and all do the same thing.
const roster = buildTeamRoster(4)
check('в составе ровно один ведущий',
  roster.filter(s => s.role === 'lead').length === 1, roster.map(s => s.role).join(','))
// What agents are told is written by agent mode from the task, so the roster
// carries no prompts at all — see test-agent-modes.
check('состав не несёт подсказок', roster.every(s => !s.prompt))

console.log(JSON.stringify({ ok: failed === 0, failed, lead: LEAD_MODEL }))
process.exit(failed ? 1 : 0)
