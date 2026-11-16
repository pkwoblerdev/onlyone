// Does a skill work? That is two questions, and they have different answers.
//
// Does the app deliver it — deterministic, and checked here: an enabled skill's
// instruction reaches the system prompt, a disabled one does not, and no skills
// means no block at all.
//
// Does the model obey it — not deterministic, and not the app's to guarantee.
// Measured with a skill whose instruction cannot be satisfied by accident: GLM
// 5.3 Flash obeyed three runs out of three; dots-3-note-preview, a small free
// model, about one in three. Same prompt both times.
//
// So a skill that seems ignored is a model that ignores it, and the place to
// check that is `npm run test:e2e skill-glm`, not here.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return src.slice(a, b)
}

// eslint-disable-next-line no-new-func
// allSkills — свои и скиллы проекта (макет 21.10); в проверке промпта это тот же список
const build = new Function('loadSkills', 'cleanToolNames', 'allSkills',
  cut('function buildSkillsSystemPrompt(toolNames = []) {', '// Системные промпты режимов — в ./mode-prompts') +
  '\nreturn buildSkillsSystemPrompt'
)

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const SKILL_TOOLS = ['list_skills', 'use_skill', 'skill_file', 'add_skill', 'update_skill', 'delete_skill', 'toggle_skill']
const prompt = skills => build(() => skills, require('../src/main/mode-prompts/tools').cleanNames, () => skills)(SKILL_TOOLS)

// --- what reaches the model --------------------------------------------------

const one = prompt([{ name: 'Ревьюер', systemPrompt: 'Проверяй код построчно.', enabled: true }])
check('инструкция включённого скилла попадает в промпт',
  one.includes('Проверяй код построчно.'), JSON.stringify(one))
check('его имя названо', one.includes('Ревьюер'), JSON.stringify(one))

const off = prompt([
  { name: 'Включённый', systemPrompt: 'ДЕЛАЙ ЭТО.', enabled: true },
  { name: 'Выключенный', systemPrompt: 'НИКОГДА ТАК НЕ ДЕЛАЙ.', enabled: false }
])
check('выключенный скилл не доходит до модели',
  !off.includes('НИКОГДА ТАК НЕ ДЕЛАЙ'), JSON.stringify(off))
check('а включённый рядом с ним — доходит', off.includes('ДЕЛАЙ ЭТО.'))

// The catalogue now travels on every turn, empty or not. It used to be omitted
// when nothing was enabled, which meant a model could not learn that skills
// exist at all — and the moment that matters most is precisely the empty one,
// when the right move is to offer to save a repeatable process as a new skill.
const empty = prompt([])
check('каталог доходит даже пустым', empty.includes('Каталог скиллов'), JSON.stringify(empty))
check('пустой каталог назван пустым', empty.includes('(пусто)'))
check('модель знает, как создать скилл', empty.includes('add_skill'))
check('модель знает, как прочитать скилл', empty.includes('use_skill'))

// Off means off: the catalogue may name a disabled skill, but its instructions
// must never reach the model without permission.
const allOff = prompt([{ id: 'x', name: 'X', description: 'опись', systemPrompt: 'СЕКРЕТНЫЕ ШАГИ', enabled: false }])
check('выключенный виден в каталоге', allOff.includes('X') && allOff.includes('выключен'))
check('но его инструкции не подставлены', !allOff.includes('СЕКРЕТНЫЕ ШАГИ'), JSON.stringify(allOff))
check('и раздела активных скиллов нет', !allOff.includes('Активные скиллы'))

// Several enabled skills all arrive, in order, each on its own line: a person who
// switched on three expects three.
const many = prompt([
  { name: 'Первый', systemPrompt: 'Раз.', enabled: true },
  { name: 'Второй', systemPrompt: 'Два.', enabled: true },
  { name: 'Третий', systemPrompt: 'Три.', enabled: true }
])
check('несколько включённых доходят все',
  ['Раз.', 'Два.', 'Три.'].every(t => many.includes(t)), JSON.stringify(many))
check('каждый на своей строке', many.split('\n').filter(l => l.startsWith('•')).length === 3,
  JSON.stringify(many))

// --- token optimization: lazy loading for large skills/packs -----------------
const hugePrompt = 'A'.repeat(2500)
const large = prompt([
  { id: 'huge', name: 'Тяжелый скилл', description: 'Краткое описание гигантского скилла.', systemPrompt: hugePrompt, enabled: true }
])
check('тяжелый скилл (>2000 знаков) не сжигает контекст целиком при наличии use_skill',
  !large.includes(hugePrompt) && large.includes('полная инструкция читается через use_skill'),
  JSON.stringify(large))
check('его краткое описание названо',
  large.includes('Краткое описание гигантского скилла.'),
  JSON.stringify(large))

const promptWithoutTools = skills => build(() => skills, require('../src/main/mode-prompts/tools').cleanNames, () => skills)([])
const largeNoTools = promptWithoutTools([
  { id: 'huge', name: 'Тяжелый скилл', description: 'Краткое описание.', systemPrompt: hugePrompt, enabled: true }
])
check('в режиме без инструментов тяжелый скилл доходит целиком, чтобы не потерять инструкции',
  largeNoTools.includes(hugePrompt),
  JSON.stringify(largeNoTools))

// --- what ships switched on --------------------------------------------------
// Five personas talking at once is not five times the help, and nobody chose
// them. They stay in the list, ready to switch on.

const defaults = cut('const DEFAULT_SKILLS = [', '\n]')
const enabledByDefault = (defaults.match(/enabled: true/g) || []).length
check('готовые скиллы поставляются выключенными', enabledByDefault === 0,
  'включённых по умолчанию ' + enabledByDefault)
// Решение владельца 04.10.2026: пять готовых персон каждый запрос тратили строку каталога,
// а никто их не включал. Встроенных скиллов нет; прежние выключенные снимает одноразовая
// чистка, и снятое сначала уходит в archive/.
check('встроенных скиллов нет — каталог не тратит токены на чужие персоны',
  (defaults.match(/systemPrompt:/g) || []).length === 0,
  'скиллов ' + (defaults.match(/systemPrompt:/g) || []).length)
{
  const from = src.indexOf('function retireSkills()')
  const body = from < 0 ? '' : src.slice(from, src.indexOf('return { removed: gone', from))
  const ok = body.includes('!skill.enabled') && body.includes('!skill.pack') && body.includes('SKILLS_RETIRED_MARK') &&
    body.indexOf('archive') > 0 && body.indexOf('archive') < body.indexOf("writeSecure('skills'")
  check('чистка снимает только выключенные и сначала архивирует снятое', ok, body ? '' : 'нет retireSkills')
}

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
