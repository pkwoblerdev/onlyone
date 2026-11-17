// Фактически собранный системный промпт каждого входа.
//
// Тест на mode-prompts проверяет тексты режимов. Этот проверяет проводку: что
// реальный код главного процесса — те же строки, из которых складывается
// `messages[0]` у живого запроса, — подставляет правильный режим, правильный
// список инструментов и контекст человека. Разница между «в исходнике есть
// personalSection()» и «модель получила его в этом ходе» ровно та, на которую
// указала независимая приёмка 23.09: раздел о пользователе стоял только в
// агентском цикле, и обычный чат без инструментов его не видел.
//
// Функции вырезаны из main.js и вызваны по-настоящему; настоящими остаются
// сборщик buildSystemPrompt, personalSection, buildSkillsSystemPrompt, все тексты
// режимов и фильтр прав toolAllowedForAssignment. Заглушены только хранилище,
// каталог скиллов, память между чатами и блок проекта: они проверяются своими
// тестами, а здесь важны только как части, не меняющие сути маршрута.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const modePrompts = require('../src/main/mode-prompts')
const { cleanNames } = require('../src/main/mode-prompts/tools')
const { designToolSchemas } = require('../src/main/design/tools')
const { buildGuideContext } = require('../src/main/work-guides')
const { qualityContract, designQuality, toolAllowedForAssignment } = require('../src/main/agent-quality')
const { fastPrompt } = require('../src/main/fast-mode')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

function at(marker, from = 0) {
  const index = main.indexOf(marker, from)
  assert.ok(index >= 0, 'якорь пропал из main.js: ' + marker)
  return index
}
const cut = (from, to) => main.slice(at(from), at(to, at(from) + from.length))

let failed = 0
let checks = 0
const QUEUE = []
function check(name, fn) { QUEUE.push({ name, fn }) }

// ---------------------------------------------------------------------------
// Настоящие части главного процесса
// ---------------------------------------------------------------------------

function fakeStore(values) {
  const data = new Map(Object.entries(values))
  return { get: (key, dflt) => (data.has(key) ? data.get(key) : dflt), set: (key, value) => data.set(key, value) }
}

const PERSONAL_SAVED = {
  name: 'Паша', about: 'Веду продуктовые метрики в рознице.', role: 'product',
  focus: ['design', 'research'], tone: 'short'
}

const personalSection = new Function('store',
  cut("const PERSONAL_KEY = 'personal'", 'function buildSkillsSystemPrompt(') +
  '\nreturn personalSection')(fakeStore({ personal: PERSONAL_SAVED }))

const languageInstruction = new Function('store',
  cut('function languageInstruction()', '// ------') +
  '\nreturn languageInstruction')(fakeStore({ language: 'ru' }))

const loadSkillsStub = () => ([
  { id: 'sk-1', name: 'Проверка релиза', description: 'что проверить перед сборкой', enabled: true, systemPrompt: 'Смотри установщик.' },
  { id: 'sk-2', name: 'Выключенный', description: '', enabled: false, systemPrompt: 'не должен применяться' }
])

const buildSkillsSystemPrompt = new Function('loadSkills', 'cleanToolNames', 'allSkills',
  cut('function buildSkillsSystemPrompt(', '// Системные промпты режимов — в ./mode-prompts') +
  '\nreturn buildSkillsSystemPrompt')(loadSkillsStub, cleanNames, loadSkillsStub)

// Сборщик промпта — настоящий, тот же, что вызывают все три входа.
function makeComposer(options = {}) {
  const roots = options.roots === undefined ? ['D:/проект'] : options.roots
  return new Function(
    'modePrompts', 'cleanToolNames', 'workspaceRoots', 'rootLabels', 'basename', 'mcpManager',
    'workspace', 'selfDevActive', 'personalSection', 'languageInstruction', 'buildSkillsSystemPrompt',
    'buildProjectBlock', 'buildMemoryBlock', 'turnHere', 'buildWholeJobBlock', 'buildLongConversationNote', 'buildCarryoverBlock', 'buildLessonsBlock', 'clockNote',
    cut('function buildSystemPrompt({', '// PDFs need the file-parser plugin') + '\nreturn buildSystemPrompt'
  )(
    modePrompts, cleanNames, () => roots,
    list => list.map((root, i) => ({ root, label: path.basename(root) })),
    p => path.basename(p),
    options.mcp === false ? null : { openRouterTools: () => [{ function: { name: 'mcp_github__get_file' } }] },
    { permission: options.permission || 'acceptEdits' },
    () => Boolean(options.selfDev),
    options.noPersonal ? () => '' : personalSection,
    languageInstruction,
    names => buildSkillsSystemPrompt(names),
    () => '',
    () => '',
    () => ({ chatId: 'chat-1' }),
    () => '',
    () => '',
    () => '',
    options.lessons || (() => ''),
    () => ''
  )
}

// ---------------------------------------------------------------------------
// Маршруты: те же строки main.js, из которых складывается messages[0]
// ---------------------------------------------------------------------------

const TOOL_DEFS = cleanNames([...cut('const TOOL_DEFINITIONS = [', '\n]').matchAll(/name: '([a-z_0-9]+)'/g)].map(m => m[1])
  .concat(require('../src/main/fork-proposal-tool.cjs').TOOL_NAME, require('../src/main/desk-tools.cjs').deskToolSchemas.map(tool => tool.function.name)))
const PROJECT_TOOLS = ['project_chats', 'project_chat', 'project_file', 'project_note',
  'project_topic_set', 'project_plan_set', 'project_plan_get']
const DESIGN_EXTRA = ['read_guide', 'task_plan', 'ask_user', 'list_skills', 'use_skill',
  'add_skill', 'update_skill', 'delete_skill', 'toggle_skill']

// Набор, который runAgentLoop прикладывает к запросу: право назначения, право
// части на чтение и живая доска. Тот же фильтр прав, что в приложении.
function attached({ design = false, readOnly = false, canAssign = false, boardLive = false, mcp = true, own = true }) {
  const base = design
    ? [...designToolSchemas().map(tool => tool.function.name), ...DESIGN_EXTRA]
    : [...TOOL_DEFS, ...(mcp ? ['mcp_github__get_file'] : []), ...(own ? ['own_report_cards'] : []), ...PROJECT_TOOLS]
  const withAssign = canAssign ? [...base, 'assign_work'] : base
  const board = ['board_update', 'board_read', 'agent_message']
  return cleanNames(withAssign)
    .filter(name => toolAllowedForAssignment(name, readOnly))
    .filter(name => !board.includes(name) || boardLive)
}

// runAgentLoop: кусок, собирающий systemPrompt хода.
const loopSlice = cut('  const taskText = lastUserMessage(payload) || \'\'', 'const selfContinueLimit = wantsWholeJob(taskText)')
const IS_PURE_DESIGN_CODE = cut('  const isPureDesign = Boolean(', '\n')
function agentLoopPrompt(payload, options = {}) {
  const composer = makeComposer(options)
  const allTools = attached(options).map(name => ({ function: { name } }))
  const design = payload.designId
    ? { id: payload.designId, name: payload.designName || '', comments: [] } : null
  const model = String(payload.model || 'glm')
  return new Function('payload', 'allTools', 'design', 'model', 'buildSystemPrompt', 'modePrompts',
    'buildGuideContext', 'ensureDesignStore', 'modelTakesImages', 'lastUserMessage', 'designTeamNote',
    // isPureDesign выводится в main.js выше среза: берём ту же строку как есть.
    'return (async () => {\n' + IS_PURE_DESIGN_CODE + ';\n' + loopSlice + '\nreturn systemPrompt\n})()')(
    payload, allTools, design, model, composer, modePrompts, buildGuideContext,
    () => ({ list: async () => options.components || ['home.dc.html'], listRefs: async () => options.refs || [] }),
    () => options.vision !== false,
    p => (p.messages || []).filter(m => m.role === 'user').pop()?.content || '',
    modePrompts.team.designTeamNote
  )
}

// runAgentSlot: части роли, которые вход передаёт режиму.
const slotSlice = cut('  const roleParts = [', 'const shared = {')
function slotRoleParts(payload, slot, useTools) {
  return new Function('payload', 'slot', 'useTools', 'qualityContract', 'designQuality', 'fastPrompt',
    'buildGuideContext', 'lastUserMessage', 'selfDevActive',
    'return (() => {\n' + slotSlice + '\nreturn roleParts\n})()')(
    payload, slot, useTools, qualityContract, designQuality, fastPrompt, buildGuideContext,
    p => (p.messages || []).filter(m => m.role === 'user').pop()?.content || '',
    () => false
  )
}

// Разговор без инструментов: ветка streamChatOpenRouter.
const chatSlice = cut('  // Разговор без инструментов — отдельный режим', "const messages = [{ role: 'system', content: systemPrompt }")
function conversationPrompt(payload, options = {}) {
  return new Function('payload', 'buildSystemPrompt', 'lastUserMessage',
    'return (() => {\n' + chatSlice + '\nreturn systemPrompt\n})()')(
    payload, makeComposer(options),
    p => (p.messages || []).filter(m => m.role === 'user').pop()?.content || ''
  )
}

// ---------------------------------------------------------------------------
// Проверка списка инструментов на всём собранном тексте
// ---------------------------------------------------------------------------

const UNIVERSE = cleanNames([...TOOL_DEFS, ...designToolSchemas().map(tool => tool.function.name),
  ...PROJECT_TOOLS, 'own_report_cards', 'mcp_github__get_file'])
const DENIAL = /not attached|are not attached|does not exist|not a tool in this host|Named in full|there is no|не привязан|не существует|того нет|не подключен|не подключены|недоступен|в этом ходе нет|отсутствует|нет в этом|не делал|не увидишь/i

function undeclaredTools(prompt, present) {
  const craftEnd = prompt.indexOf('# Tools')
  const bad = []
  for (const name of UNIVERSE) {
    if (present.includes(name)) continue
    let at2 = prompt.indexOf(name)
    let found = false
    while (at2 >= 0) {
      const insideCraft = craftEnd >= 0 && at2 < craftEnd
      const window = prompt.slice(Math.max(0, at2 - 700), at2 + 700)
      if (!insideCraft && !DENIAL.test(window)) { found = true; break }
      at2 = prompt.indexOf(name, at2 + 1)
    }
    if (found) bad.push(name)
  }
  return bad
}

const MESSAGES = task => [{ role: 'user', content: task }]

// Полный путь хода: slot превращает роль в части, цикл собирает промпт. Так же,
// как в приложении, — иначе тест проверял бы маршрут, которого не существует.
function routePrompt(payload, options = {}, slot = {}) {
  const roleParts = slotRoleParts(payload, slot, !payload.params || payload.params.useTools !== false)
  return agentLoopPrompt({ ...payload, roleParts }, options)
}

// ---------------------------------------------------------------------------
// 1. Обычный чат без инструментов
// ---------------------------------------------------------------------------

check('чат без инструментов: режим «разговор», ни одного вызова, человек дошёл', async () => {
  const prompt = await conversationPrompt({ messages: MESSAGES('объясни, что такое гонка данных') })
  assert.match(prompt, /Ты — onlyone, инженерный ассистент в окне разговора/)
  assert.match(prompt, /Инструментов в этом запросе нет/)
  const bad = undeclaredTools(prompt, [])
  assert.deepEqual(bad, [], 'разговор называет инструменты: ' + bad.join(', '))
  assert.ok(prompt.includes('Обращайся к человеку по имени: Паша'), 'имя не дошло до разговора')
  assert.match(prompt, /Кто он: .+. Подбирай глубину/, 'роль не дошла до разговора')
  assert.ok(prompt.includes('Упор в его работе: дизайн и интерфейсы, исследования и анализ'), 'упор не дошёл')
  assert.ok(prompt.includes('отвечать короче обычного'), 'тон не дошёл')
  assert.ok(prompt.lastIndexOf('О пользователе') > prompt.lastIndexOf('## Как сдаётся работа'),
    'личное должно быть после правил')
})

check('чат без инструментов не зовёт в скиллы, которых нет', async () => {
  const prompt = await conversationPrompt({ messages: MESSAGES('привет') })
  assert.ok(prompt.includes('Каталог скиллов'), 'каталог скиллов пропал')
  assert.ok(prompt.includes('инструментов для этого в этом ходе нет'),
    'блок скиллов не сказал, что управлять ими здесь нечем')
  const bad = undeclaredTools(prompt, [])
  assert.deepEqual(bad, [], 'скилловый блок назвал вызов: ' + bad.join(', '))
})

// ---------------------------------------------------------------------------
// 2. Чат-агент, ведущий, помощник
// ---------------------------------------------------------------------------

check('чат-агент: режим, фактический список инструментов, человек', async () => {
  const names = attached({})
  const prompt = await routePrompt({ messages: MESSAGES('почини падение окна') }, {})
  assert.match(prompt, /Ты — onlyone, инженерный ассистент внутри приложения, где у тебя есть руки/)
  assert.deepEqual(undeclaredTools(prompt, names), [], 'названо не подключённое')
  for (const name of ['write_file', 'run_command', 'own_report_cards', 'mcp_github__get_file']) {
    assert.ok(prompt.includes(name), 'подключённый инструмент не назван: ' + name)
  }
  assert.ok(!undeclaredTools(prompt, names).includes('assign_work'), 'assign_work попал в ход без права раздачи')
  assert.ok(prompt.includes('Обращайся к человеку по имени: Паша'))
})

check('уроки проекта доходят хвостом в агента и в разговор, с режимом и текстом просьбы', async () => {
  const seen = []
  const lessons = (mode, request) => { seen.push([mode, request]); return '\n\n## Уроки этого проекта\n\n- УРОК-МЕТКА' }
  const agent = await routePrompt({ messages: MESSAGES('запусти тесты') }, { lessons })
  const chat = await conversationPrompt({ messages: MESSAGES('как запускать тесты?') }, { lessons })
  for (const prompt of [agent, chat]) {
    assert.ok(prompt.includes('УРОК-МЕТКА'), 'урок не дошёл до промпта')
    assert.ok(prompt.indexOf('УРОК-МЕТКА') > prompt.lastIndexOf('О пользователе'), 'урок должен стоять в хвосте, после постоянной части')
  }
  assert.deepEqual(seen, [['agent', 'запусти тесты'], ['conversation', 'как запускать тесты?']])
})

check('доска попадает в промпт только когда она живая', async () => {
  const dead = await routePrompt({ messages: MESSAGES('сделай план') }, {})
  assert.ok(!dead.includes('- `board_update`'), 'доска названа доступной, когда поручений нет')
  const live = await routePrompt({ messages: MESSAGES('сделай план') }, { boardLive: true })
  assert.ok(live.includes('- `board_update`'), 'живая доска не названа')
})

check('часть «только на чтение» не получает инструментов изменения', async () => {
  const names = attached({ readOnly: true, boardLive: true })
  const prompt = await routePrompt(
    { messages: MESSAGES('проверь'), readOnlyAssignment: true }, { readOnly: true, boardLive: true })
  for (const gone of ['write_file', 'delete_path', 'run_command', 'define_tool']) {
    assert.ok(!names.includes(gone), 'тест собрал не тот набор: ' + gone)
  }
  assert.deepEqual(undeclaredTools(prompt, names), [],
    'read-only ход называет инструмент изменения')
})

check('ведущий команды получает и режим, и бриф, и assign_work', async () => {
  const payload = {
    messages: MESSAGES('собери команду и сделай'), canAssign: true, helperCount: 2,
    customSystemPrompt: modePrompts.team.leadBrief(2, '')
  }
  const prompt = await routePrompt(payload, { canAssign: true })
  assert.match(prompt, /Ты — onlyone, инженерный ассистент внутри приложения/)
  assert.match(prompt, /Ты Агент 1 в приложении onlyone/, 'бриф ведущего не дошёл')
  assert.ok(prompt.includes('- `assign_work`'), 'assign_work не назван там, где он подключён')
  assert.ok(prompt.lastIndexOf('О пользователе') > prompt.lastIndexOf('Ты Агент 1'),
    'личное должно идти после ролевого брифа')
})

check('помощник: бриф доходит, чужих инструментов нет', async () => {
  const names = attached({ readOnly: true, boardLive: true })
  const payload = {
    messages: MESSAGES('проверь часть'), readOnlyAssignment: true,
    customSystemPrompt: modePrompts.team.helperBrief('Агент 2', 'Проверка по коду', { board: true })
  }
  const prompt = await routePrompt(payload, { readOnly: true, boardLive: true })
  assert.match(prompt, /Тебя зовут «Агент 2»/)
  assert.match(prompt, /Твоя часть:/)
  assert.deepEqual(undeclaredTools(prompt, names), [], 'помощник читает про запись')
  assert.ok(prompt.includes('Обращайся к человеку по имени: Паша'))
})

// ---------------------------------------------------------------------------
// 3. Дизайн
// ---------------------------------------------------------------------------

check('Дизайн: свой режим, свои инструменты, человек доходит', async () => {
  const names = attached({ design: true })
  const prompt = await routePrompt({
    messages: MESSAGES('сделай лендинг с пальмами'), designId: 'd-1', designName: 'Пальмы'
  }, { design: true })
  assert.match(prompt, /Ты — onlyone в разделе «Дизайн»/)
  assert.ok(prompt.includes('# Tools'), 'манифест инструментов Дизайна пропал')
  assert.ok(prompt.includes('dc_screenshot({ path'), 'описанный dc_* должен быть подключён')
  for (const gone of ['write_file', 'read_file', 'list_files', 'run_command', 'define_tool']) {
    assert.ok(!names.includes(gone), 'в Дизайн просочился файловый инструмент: ' + gone)
  }
  assert.deepEqual(undeclaredTools(prompt, names), [], 'Дизайн обещает чужие инструменты')
  assert.ok(prompt.includes('Обращайся к человеку по имени: Паша'), 'Дизайн не знает, с кем работает')
  assert.ok(prompt.includes('Пальмы'), 'имя макета не дошло')
})

check('Дизайн без права раздачи не зовёт assign_work', async () => {
  const names = attached({ design: true })
  const prompt = await routePrompt({ messages: MESSAGES('правку в макет'), designId: 'd-1' }, { design: true })
  assert.ok(!names.includes('assign_work'))
  assert.ok(!prompt.includes('- `assign_work`'), 'assign_work назван доступным в ход без него')
})

check('команда в Дизайне получает напоминание о раздаче только когда она возможна', async () => {
  const withTeam = await routePrompt({
    messages: MESSAGES('сделай сайт'), designId: 'd-1', canAssign: true, helperCount: 2
  }, { design: true, canAssign: true })
  assert.match(withTeam, /## Команда на этом ходе/)
  const alone = await routePrompt({ messages: MESSAGES('сделай сайт'), designId: 'd-1' }, { design: true })
  assert.ok(!alone.includes('## Команда на этом ходе'), 'напоминание о команде в одиночном ходе')
})

// ---------------------------------------------------------------------------
// 5. Части роли и слои
// ---------------------------------------------------------------------------

check('runAgentSlot передаёт роли частями, а не вместо режима', async () => {
  const parts = slotRoleParts({ messages: MESSAGES('сделай') }, { prompt: 'SLOT-PROMPT' }, true)
  assert.ok(parts.some(part => part.includes('Контракт качества')), 'контракт качества потерян')
  assert.ok(parts.includes('SLOT-PROMPT'), 'роль слота потеряна')
  assert.ok(!parts.some(part => part.includes('Инструменты этого режима')),
    'режим собрался в частях — он соберётся дважды')
  const noTools = slotRoleParts({ messages: MESSAGES('сделай') }, {}, false)
  assert.ok(noTools.some(part => part.includes('Памятки') || part.includes('памятки')),
    'без инструментов памятки должны приходить частями')
})

check('слой артефактов приходит с инструментами и не приходит без них', async () => {
  const withArtifacts = await routePrompt({ messages: MESSAGES('покажи страницу') }, {})
  assert.match(withArtifacts, /## Превью и артефакты/)
  const noMcpNoOwn = await routePrompt({ messages: MESSAGES('покажи страницу') }, { mcp: false, own: false })
  assert.match(noMcpNoOwn, /## Превью и артефакты/, 'артефакты пропали без MCP — их это не касается')
  const design = await routePrompt({ messages: MESSAGES('макет'), designId: 'd-1' }, { design: true })
  assert.ok(!design.includes('## Превью и артефакты'), 'артефактный слой лезет в Дизайн')
})

check('самодоработка доходит до всех входов, когда она включена', async () => {
  const chat = await routePrompt({ messages: MESSAGES('почини onlyone') }, { selfDev: true })
  const design = await routePrompt({ messages: MESSAGES('поправь экран Дизайна'), designId: 'd-1' }, { design: true, selfDev: true })
  const talk = await conversationPrompt({ messages: MESSAGES('а как устроен onlyone') }, { selfDev: true })
  for (const [name, prompt] of [['чат', chat], ['Дизайн', design], ['разговор', talk]]) {
    assert.ok(prompt.includes('Ты правишь само приложение onlyone'), 'слоя нет в ' + name)
  }
  const off = await routePrompt({ messages: MESSAGES('обычная задача') }, {})
  assert.ok(!off.includes('Ты правишь само приложение onlyone'), 'слой включился сам')
})

check('режим прав «план» меняет право, а не список инструментов', async () => {
  const names = attached({})
  const prompt = await routePrompt({ messages: MESSAGES('разберись и составь план') }, { permission: 'plan' })
  assert.match(prompt, /ВКЛЮЧЁН РЕЖИМ «ПЛАН»/)
  assert.ok(prompt.includes('`write_file`'), 'в «Плане» инструментов не отбирают — отбирают право')
  assert.deepEqual(undeclaredTools(prompt, names), [])
})

check('Fast и памятки не подменяют режим', async () => {
  const prompt = await routePrompt({ messages: MESSAGES('быстро поправь'), speedMode: 'fast' }, {})
  assert.match(prompt, /Ты — onlyone, инженерный ассистент внутри приложения/)
  assert.ok(prompt.includes('Стратегия Fast'), 'Fast не дошёл')
})

check('сборка без контекста человека не проходит ни у одного входа', () => {
  assert.throws(() => modePrompts.buildModePrompt('agent', { toolNames: [] }), /ctx\.personal/)
})

// ---------------------------------------------------------------------------
// 6. Если personalSection не вызывается — тест обязан покраснеть
// ---------------------------------------------------------------------------

check('проверка действительно смотрит на доставку, а не на наличие функции', async () => {
  const prompt = await conversationPrompt({ messages: MESSAGES('привет') }, { noPersonal: true })
  assert.ok(!prompt.includes('Паша'),
    'заглушка без человека всё равно содержит имя — проверка ничего не проверяет')
})

;(async () => {
  for (const item of QUEUE) {
    try {
      await item.fn()
      checks++
    } catch (err) {
      failed++
      console.error('ПРОВАЛ [' + item.name + ']: ' + (err && err.message))
    }
  }
  console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
  process.exit(failed ? 1 : 0)
})()
