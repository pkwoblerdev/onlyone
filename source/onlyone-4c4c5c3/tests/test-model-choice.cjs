// Which model each agent ends up on, and why.
//
// The original bug: a model bound to the key beat the picker in every mode, so
// the answer came back from something else — Nemotron 3 Ultra instead of the GLM
// the user had just selected — with nothing on screen to say why.
//
// There is one mode now, so the old half of this file — «in Solo the picker is
// law» — describes nothing. What is left is the casting rule the roster actually
// uses: the agent taking the task gets the model that can read code, everyone it
// recruits gets a free one, and no two of them get the same.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return src.slice(a, b)
}

const CATALOG = {
  'z-ai/glm-5.3-flash':                     { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', supportsTools: true },
  'nvidia/nemotron-3-ultra-550b-a55b:free': { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra', supportsTools: true },
  'cohere/north-mini-code:free':            { id: 'cohere/north-mini-code:free', name: 'North Mini Code', supportsTools: true },
  'dots-studio/dots-3-note-preview:free':   { id: 'dots-studio/dots-3-note-preview:free', name: 'Dots3', supportsTools: true },
  'openai/gpt-oss-nothing:free':            { id: 'openai/gpt-oss-nothing:free', name: 'Без инструментов', supportsTools: false }
}

const resolveAgentSlots = new Function(
  'getEnabledKeys', 'buildTeamRoster',
  'findModelRecord', 'modelExists', 'modelCanCallTools', 'autoPickToolModel',
  'AUTO_CODER_MODELS', 'AUTO_REVIEWER_MODELS', 'DEFAULT_MODEL',
  'LEAD_MODEL', 'isFreeModel',
  cut('function resolveAgentSlots(payload) {', '\nfunction ') + '\nreturn resolveAgentSlots'
)

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

function build(keys) {
  return resolveAgentSlots(
    () => keys,
    n => Array.from({ length: n }, (_, i) => ({ role: i ? 'general' : 'lead', name: i ? 'Агент ' + (i + 1) : 'Агент' })),
    id => CATALOG[id] || null,
    id => Boolean(CATALOG[id]),
    id => Boolean(CATALOG[id] && CATALOG[id].supportsTools !== false),
    (pool, taken = new Set()) => pool.find(id => !taken.has(id)) || pool[0],
    ['cohere/north-mini-code:free', 'dots-studio/dots-3-note-preview:free'],
    ['dots-studio/dots-3-note-preview:free'],
    'dots-studio/dots-3-note-preview:free',
    'z-ai/glm-5.3-flash',
    id => String(id).endsWith(':free')
  )
}

// --- the roster is cast by job, not by binding -------------------------------

const team = build([
  { id: 'k1', name: 'A', modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  { id: 'k2', name: 'B', modelId: 'cohere/north-mini-code:free' }
])({ model: 'z-ai/glm-5.3-flash' })

check('ведущему модель назначает роль, а не привязка',
  team[0].modelId === 'z-ai/glm-5.3-flash', team[0].modelId)
check('у помощника привязка ключа ведёт, а не выбор в списке',
  team[1].modelId === 'cohere/north-mini-code:free', team[1].modelId)
check('и такая подмена подписана',
  team[1].overrodePick === true, JSON.stringify(team[1].overrodePick))

// --- replacements ------------------------------------------------------------

// A model that cannot call tools is no use to an agent that has to read files.
const weak = build([
  { id: 'k1', name: 'A' },
  { id: 'k2', name: 'B', modelId: 'openai/gpt-oss-nothing:free' }
])({})
check('модель без инструментов заменяется',
  weak[1].modelId !== 'openai/gpt-oss-nothing:free', weak[1].modelId)
check('замена помечена как подобранная', weak[1].autoPicked === true)

// A model that vanished from the catalogue is replaced too: leaving it bound
// means every request comes back «no endpoints found».
const gone = build([
  { id: 'k1', name: 'A' },
  { id: 'k2', name: 'B', modelId: 'stealth/ox-alpha' }
])({})
check('исчезнувшая модель заменяется',
  gone[1].modelId !== 'stealth/ox-alpha', gone[1].modelId)

// --- who sits on what --------------------------------------------------------

const cast = build([
  { id: 'k1', name: 'A', modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  { id: 'k2', name: 'B' },
  { id: 'k3', name: 'C' }
])({ model: 'cohere/north-mini-code:free' })

check('ведущий сидит на выбранной модели',
  cast[0].modelId === 'cohere/north-mini-code:free', cast[0].modelId)
check('больше платных моделей ни у кого',
  cast.slice(1).every(s => s.modelId.endsWith(':free')),
  cast.map(s => s.modelId).join(', '))
check('у помощников модели не повторяются',
  new Set(cast.slice(1).map(s => s.modelId)).size === cast.length - 1,
  cast.slice(1).map(s => s.modelId).join(', '))

// A key already bound to a free model keeps it — the rule is «no paid helpers»,
// not «ignore what the user set up».
const boundFree = build([
  { id: 'k1', name: 'A' },
  { id: 'k2', name: 'B', modelId: 'dots-studio/dots-3-note-preview:free' }
])({})
check('бесплатная привязка помощника сохраняется',
  boundFree[1].modelId === 'dots-studio/dots-3-note-preview:free', boundFree[1].modelId)

// --- one key ----------------------------------------------------------------

// With a single key the roster is one slot, and that slot is the one taking the
// task — so it is cast as such and lands on the paid lead model, whatever the
// key was bound to. This is what agent mode always did; it now applies to every
// turn, because there is no other mode to be in. Pinned because it is the one
// place collapsing the modes changed what a turn costs.
const solo = build([{ id: 'k1', name: 'A', modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free' }])({})
check('на одном ключе ход идёт по модели ведущего',
  solo.length === 1 && solo[0].modelId === 'nvidia/nemotron-3-ultra-550b-a55b:free', solo[0].modelId)

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
