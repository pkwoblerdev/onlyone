// Пункт 6.2: системные промпты — данные по режимам, а не текст, выбираемый по
// имени модели.
//
// Проверка смотрит на фактические промпты, собранные настоящим модулем
// `src/main/mode-prompts`, а не на строки исходника: правка текста в главном
// процессе не должна уметь проходить тест молча.
//
// Что здесь закреплено и почему:
//
// 1. Рельсов по имени модели больше нет. `modelNeedsRails` и её списки решали,
//    кому достанутся правила, по подстрочнику в идентификаторе; из-за этого
//    «Nemotron 3 Nano» и «Gemma … 27B» оставались без них, а сильной модели
//    правила были нужны ровно в те же моменты.
// 2. Каждый режим отвечает на четыре вопроса: где модель и что видит человек,
//    какие инструменты есть в этом режиме, как здесь отвечают, как сдают работу.
// 3. В промпте нет ни одного имени инструмента, которого нет у этого режима.
//    Обещанный вызов, которого нет, — это ход, кончившийся ожиданием результата;
//    именно ради этого когда-то и появились рельсы.
// 4. Контекст человека — имя, «кто вы», упор, тон — обязателен: сборка без него
//    не собирается, а не дописывается по дороге.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const modePrompts = require('../src/main/mode-prompts')
const { renderToolManifest, cleanNames, GUIDANCE } = require('../src/main/mode-prompts/tools')
const { designToolSchemas } = require('../src/main/design/tools')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const designPromptSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'design', 'prompt.js'), 'utf8')
const dir = path.join(__dirname, '..', 'src', 'main', 'mode-prompts')

let failed = 0
let checks = 0
function check(name, fn) {
  try { fn(); checks++ } catch (err) {
    failed++
    console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message))
  }
}

// ---------------------------------------------------------------------------
// Полные каталоги инструментов: их берут себе в промпт только подключённые
// ---------------------------------------------------------------------------

const TOOL_DEFS = main.slice(main.indexOf('const TOOL_DEFINITIONS = ['),
  main.indexOf('\n]', main.indexOf('const TOOL_DEFINITIONS = [')))
const CHAT_TOOLS = [...TOOL_DEFS.matchAll(/name: '([a-z_0-9]+)'/g)].map(m => m[1]).concat(
  require('../src/main/fork-proposal-tool.cjs').TOOL_NAME,
  require('../src/main/desk-tools.cjs').deskToolSchemas.map(tool => tool.function.name))
const DC_TOOLS = designToolSchemas().map(tool => tool.function.name)
const PROJECT_TOOLS = ['project_chats', 'project_chat', 'project_file', 'project_note',
  'project_topic_set', 'project_plan_set', 'project_plan_get']
const DYNAMIC = ['own_report_cards', 'mcp_github__get_file']

// Всё, что модуль в принципе может назвать. Если имя есть здесь и его не
// подключили, в собранном промпте его быть не должно.
const UNIVERSE = [...new Set([...CHAT_TOOLS, ...DC_TOOLS, ...PROJECT_TOOLS, ...DYNAMIC, ...GUIDANCE.keys()])]

const PERSONAL = '--- О пользователе ---\nОбращайся к человеку по имени: Паша.\n' +
  'Кто он: продакт-менеджер. Подбирай глубину и язык объяснений под это.\n' +
  'Упор в его работе: код, дизайн и интерфейсы.\n' +
  'Он просит отвечать короче обычного: только суть, без разогрева и пересказа сделанного.'

const LANGUAGE = 'Отвечай по-русски и описывай видимый прогресс по-русски, если пользователь не попросил другой язык.'

const CHAT_TURN = [...CHAT_TOOLS, ...PROJECT_TOOLS, ...DYNAMIC]
const READ_ONLY_TURN = cleanNames(CHAT_TURN).filter(name =>
  ['write_file', 'create_directory', 'move_path', 'delete_path', 'run_command', 'define_tool',
    'add_skill', 'update_skill', 'delete_skill', 'toggle_skill', 'add_mcp_server',
    'project_note', 'project_topic_set', 'project_plan_set', 'assign_work'].includes(name) === false)
const DESIGN_TURN = [...DC_TOOLS, 'read_guide', 'task_plan', 'ask_user', 'list_skills', 'use_skill',
  'add_skill', 'update_skill', 'delete_skill', 'toggle_skill', 'board_update', 'board_read', 'agent_message', 'assign_work']

const ROUTES = [
  { name: 'разговор', mode: 'conversation', ctx: { toolNames: [] } },
  { name: 'чат-агент', mode: 'agent', ctx: { toolNames: CHAT_TURN } },
  { name: 'чат-агент без папки', mode: 'agent', ctx: { toolNames: ['ask_user', 'task_plan', 'read_guide'] } },
  { name: 'часть только на чтение', mode: 'agent', ctx: { toolNames: READ_ONLY_TURN } },
  { name: 'ведущий команды', mode: 'agent', ctx: { toolNames: [...CHAT_TURN, 'assign_work'] } },
  { name: 'Дизайн', mode: 'design', ctx: {
    toolNames: DESIGN_TURN, designName: 'Пальмы', components: ['home.dc.html'],
    refs: [{ name: 'brief.txt', kind: 'text' }], imagesSent: 0
  } },
  { name: 'Дизайн без скриншота', mode: 'design', ctx: {
    toolNames: DESIGN_TURN.filter(name => name !== 'dc_screenshot'), designName: 'Пальмы'
  } },
  { name: 'самодоработка', mode: 'agent', ctx: { toolNames: CHAT_TURN, selfDevelopment: true } }
]

function build(route) {
  return modePrompts.buildModePrompt(route.mode, {
    language: LANGUAGE, personal: PERSONAL, workspace: 'Рабочая папка проекта: "D:/проект".',
    mcpCount: 2, rootLabels: [], permission: 'acceptEdits', ...route.ctx
  }, [route.name === 'ведущий команды' ? modePrompts.team.leadBrief(2, '') : ''])
}

// ---------------------------------------------------------------------------
// 1. Рельсов по имени модели нет ни в главном процессе, ни в Дизайне
// ---------------------------------------------------------------------------

check('главный процесс не выбирает текст по имени модели', () => {
  for (const gone of ['WEAK_MODEL_HINTS', 'STRONG_MODELS', 'modelNeedsRails',
    'buildWeakModelRails', 'buildAgentRails', 'buildAgentProtocol', 'buildSelfDevBlock']) {
    assert.ok(!main.includes(gone), 'осталось в main.js: ' + gone)
  }
})

check('Дизайн не получает рельсов по имени модели', () => {
  for (const gone of ['weakModel', 'designRails', 'modelNeedsRails']) {
    assert.ok(!designPromptSrc.includes(gone), 'осталось в design/prompt.js: ' + gone)
  }
  assert.ok(!main.includes('weakModel'), 'main.js по-прежнему передаёт weakModel')
})

check('ни один промпт не меняется от имени модели', () => {
  // Функция сборки не принимает modelId: единственное, что отличает один ход от
  // другого, — подключённые инструменты и настройки человека.
  const source = modePrompts.buildModePrompt.toString() +
    require('../src/main/mode-prompts/agent').build.toString()
  assert.ok(!/modelId|model_id|:free|nano|mini|flash/i.test(source),
    'в сборке режима всплыло имя модели')
  assert.ok(!main.includes('buildSystemPrompt({ withTools'), 'старая сигнатура сборки ещё вызывается')
})

// ---------------------------------------------------------------------------
// 2. Режимы лежат данными, по файлу на режим
// ---------------------------------------------------------------------------

check('файлы режимов на месте и требуются как данные', () => {
  for (const file of ['index.js', 'shared.js', 'tools.js', 'conversation.js', 'agent.js',
    'team.js', 'design.js', 'artifacts.js', 'self-dev.js']) {
    assert.ok(fs.existsSync(path.join(dir, file)), 'нет файла mode-prompts/' + file)
  }
  assert.equal(modePrompts.MODES.map(m => m.id).sort().join(','),
    ['agent', 'artifacts', 'conversation', 'design', 'self-dev', 'team'].sort().join(','),
    'список режимов разошёлся с планом 6.2')
})

check('главный процесс не хранит тексты режимов', () => {
  // Семь фраз, которые раньше были строками внутри main.js. Если они вернутся
  // туда, режимы снова перестанут быть данными.
  for (const phrase of ['Ты Агент 1 в приложении onlyone', 'ВКЛЮЧЁН РЕЖИМ «ПЛАН»',
    '## Ты правишь само приложение onlyone', 'Working instructions for onlyone',
    '## Жёсткие правила ответа']) {
    assert.ok(!main.includes(phrase), 'текст режима вернулся в main.js: ' + phrase)
  }
})

// ---------------------------------------------------------------------------
// 3. Каждый режим отвечает на четыре своих вопроса
// ---------------------------------------------------------------------------

for (const route of ROUTES) {
  check(`режим «${route.name}»: собран, четыре части на месте`, () => {
    const prompt = build(route)
    assert.ok(prompt.length > 1500, 'слишком короткий промпт: ' + prompt.length)
    assert.match(prompt, /## Инструменты этого режима/, 'нет перечня инструментов')
    assert.match(prompt, /Как здесь отвечают/, 'нет правил ответа')
    assert.match(prompt, /Как сдаётся работа/, 'нет правил сдачи работы')
    assert.match(prompt, /Где ты|Ты — onlyone|Ты — |Тебя зовут|Ты — этап/, 'не сказано, где модель')
    assert.ok(prompt.includes(PERSONAL.trim().slice(0, 40)), 'не дошёл контекст человека')
    assert.ok(prompt.lastIndexOf('--- О пользователе ---') > prompt.lastIndexOf('Как сдаётся работа'),
      'личное должно идти после ролей и правил')
  })
}

check('правило о языке замыкает текст режима', () => {
  // Между правилом о языке и вопросом пользователя остаются только русские
  // части конкретного входа (бриф ведущего, памятки) и человек. Английского
  // блока после него быть не должно: длинный английский текст сам по себе
  // тянет ответ в английский — за этим правилом и стояло в старых рельсах.
  for (const route of ROUTES) {
    const block = modePrompts[route.mode].build({
      language: LANGUAGE, personal: PERSONAL, workspace: 'Рабочая папка: "D:/проект".',
      mcpCount: 2, rootLabels: [], permission: 'acceptEdits', ...route.ctx
    })
    const language = block.lastIndexOf(LANGUAGE)
    assert.ok(language > 0, 'нет строки о языке: ' + route.name)
    const after = block.slice(language)
    assert.ok(!/## /.test(after), 'после правила о языке в тексте режима встало новое правило: ' + route.name)
    assert.ok(!/[A-Za-z]{4}\s+[A-Za-z]{4}\s+[A-Za-z]{4}\s+[A-Za-z]{4}/.test(after.replace(/^Отвечай[^\n]*/, '')),
      'после правила о языке остался английский блок: ' + route.name)
    const prompt = build(route)
    assert.ok(prompt.lastIndexOf('О пользователе') > language, 'человек должен быть в самом конце: ' + route.name)
  }
})

// ---------------------------------------------------------------------------
// 4. Ни одного инструмента, которого у режима нет
// ---------------------------------------------------------------------------

// Имя допускается, только если рядом прямо сказано, что его нет: из этого
// исключения живёт Дизайн, где отречение поимённое работает лучше общего слова.
const DENIAL = /not attached|are not attached|does not exist|do not exist|not a tool in this host|Named in full|there is no|не привязан|не существует|того нет|не подключен|не подключены|недоступен|в этом ходе нет|не здесь|отсутствует|нет в этом|не делал|не увидишь/i

function absentTools(prompt, present) {
  const bad = []
  // Первая половина промпта Дизайна — дословный текст Claude Design, и он
  // называет инструменты своего хоста. Отменяется он манифестом, где сказано
  // «если инструмент назван выше и его нет в списке — его не существует»; за
  // тем, что происходит в самой цитате, следит test-design-prompt.
  const craftEnd = prompt.indexOf('# Tools')
  const offending = name => {
    let at = prompt.indexOf(name)
    while (at >= 0) {
      const insideCraft = craftEnd >= 0 && at < craftEnd
      const window = prompt.slice(Math.max(0, at - 700), at + 700)
      if (!insideCraft && !DENIAL.test(window)) return true
      at = prompt.indexOf(name, at + 1)
    }
    return false
  }
  for (const name of UNIVERSE) {
    if (present.includes(name)) continue
    if (offending(name)) bad.push(name)
  }
  return bad
}

for (const route of ROUTES) {
  check(`режим «${route.name}»: в промпте только его инструменты`, () => {
    const prompt = build(route)
    const present = cleanNames(route.ctx.toolNames)
    const bad = absentTools(prompt, present)
    assert.deepEqual(bad, [], 'названы без подключения: ' + bad.join(', '))
  })
}

check('разговор без инструментов не обещает ни одного вызова', () => {
  const prompt = build(ROUTES[0])
  for (const name of ['read_file', 'write_file', 'list_files', 'use_skill', 'task_plan', 'dc_write']) {
    assert.ok(!prompt.includes(name), 'разговор называет инструмент: ' + name)
  }
  assert.match(prompt, /Инструментов в этом запросе нет/)
  assert.match(prompt, /Не пиши «я посмотрел»|не утверждай/i)
})

check('часть «только на чтение» не читает про запись', () => {
  const route = ROUTES.find(r => r.name === 'часть только на чтение')
  const prompt = build(route)
  const bad = absentTools(prompt, cleanNames(route.ctx.toolNames))
  for (const name of ['write_file', 'delete_path', 'run_command', 'define_tool', 'assign_work']) {
    assert.ok(!bad.includes(name), 'read-only ход называет инструмент изменения: ' + name)
  }
  assert.ok(prompt.includes('read_file'), 'чтение осталось без собственного инструмента')
})

check('Дизайн не обещает файловых инструментов проекта', () => {
  const prompt = build(ROUTES.find(r => r.name === 'Дизайн'))
  assert.match(prompt, /not attached in the design|нет отдельной файловой системы/i)
  assert.ok(prompt.includes('dc_resolve_comment'), 'dc_* описаны не все подключённые')
})

check('Дизайн без dc_screenshot не обещает, что модель посмотрит макет', () => {
  const prompt = build(ROUTES.find(r => r.name === 'Дизайн без скриншота'))
  assert.ok(!prompt.includes('dc_screenshot({ path'), 'инструмент описан, хотя его не подключили')
  assert.match(prompt, /не может видеть|cannot look at|не принимает изображения|Do not announce visual screenshot review|that does not mean/i)
})

check('список инструментов собирается из переданных имён, а не из памяти', () => {
  const empty = renderToolManifest([])
  assert.match(empty, /Инструментов в этом запросе нет/)
  const one = renderToolManifest(['read_file'])
  assert.ok(one.includes('`read_file`'))
  assert.ok(!one.includes('write_file'), 'отсутствующий инструмент всё же назван')
  const dynamic = renderToolManifest(['own_z', 'mcp_a__b'])
  assert.ok(dynamic.includes('own_z') && dynamic.includes('mcp_a__b'), 'динамические имена потеряны')
  assert.equal(cleanNames(['read_file', 'read_file', '', null, 'BAD NAME']).join(','), 'read_file')
})

// ---------------------------------------------------------------------------
// 5. Годные для всех правила рельс переехали в общие правила режима
// ---------------------------------------------------------------------------

// Правила, переехавшие из рельс. `tools: true` означает, что правило держится
// на инструменте и потому звучит только там, где инструмент подключён: говорить
// «не проси прислать файл» модели без read_file — значит советовать ей сделать
// ровно обратное.
const MIGRATED = [
  { name: 'не отвечает по памяти, а проверяет', tools: false, re: /Проверяй, а не вспоминай/ },
  { name: 'не отчитывается о несделанном', tools: false, re: /«Сделал», «исправил», «записал»|Не называй незавершённое завершённым/ },
  { name: 'не раздувает ответ', tools: false, re: /Десять строк — обычная длина/ },
  { name: 'просьба сделать — указание сделать', tools: false, re: /Просьба сделать — это указание сделать/ },
  { name: 'отчёт о недоделанном — не результат', tools: false, re: /Прогресс — это изменённое состояние|Не называй незавершённое завершённым/ },
  { name: 'отчёт о недоделанном назван именно этой формой отказа', tools: true, requires: [], re: /Отчёт о недоделанном — не ответ на просьбу реализовать/ },
  { name: 'не тащит попутные улучшения', tools: true, requires: [], re: /никаких попутных улучшений соседнего кода/ },
  { name: 'скобки в тексте — не вызов', tools: true, requires: [], re: /не является: оттуда ничего не придёт|not a call/i },
  { name: 'читает файл перед записью', tools: true, requires: ['read_file', 'write_file'], re: /сначала читают целиком|read it first|Файл сначала читают/i },
  { name: 'не просит прислать то, что может прочитать сам', tools: true, requires: ['read_file'], re: /Не проси человека прислать|не проси прислать/i }
]

for (const rule of MIGRATED) {
  check(`правило «${rule.name}» действует для всех моделей, а не только слабых`, () => {
    for (const route of ROUTES) {
      const prompt = build(route)
      const present = cleanNames(route.ctx.toolNames)
      if (rule.tools && !present.length) continue
      if ((rule.requires || []).some(tool => !present.includes(tool))) continue
      assert.match(prompt, rule.re, 'пропало в режиме «' + route.name + '»')
    }
  })
}

check('английский блок механики сохранён там, где есть инструменты', () => {
  // Правило о буквальности английских инструкций для слабых моделей было верным
  // наблюдением; неверным было применять его по имени модели. Механика вызова
  // осталась русской и прикладывается по наличию инструментов.
  const withTools = build(ROUTES[1])
  assert.match(withTools, /## Механика вызова инструментов/)
  assert.ok(!/## Tool execution contract/.test(withTools), 'старый английский блок вернулся')
})

// ---------------------------------------------------------------------------
// 6. Контекст человека обязателен, а не дописывается по дороге
// ---------------------------------------------------------------------------

check('сборка без контекста человека не проходит', () => {
  assert.throws(() => modePrompts.buildModePrompt('agent', { toolNames: ['read_file'] }),
    /ctx\.personal/)
  assert.throws(() => modePrompts.buildModePrompt('нет-такого-режима', { personal: '' }),
    /Неизвестный режим/)
})

check('пустой контекст человека не добавляет раздела', () => {
  const prompt = modePrompts.buildModePrompt('conversation', { toolNames: [], personal: '', language: LANGUAGE })
  assert.ok(!prompt.includes('О пользователе'))
})

check('имя, роль, упор и тон доходят до режима', () => {
  const prompt = build(ROUTES[1])
  for (const line of ['Паша', 'продакт-менеджер', 'дизайн и интерфейсы', 'отвечать короче обычного']) {
    assert.ok(prompt.includes(line), 'не дошло: ' + line)
  }
})

// ---------------------------------------------------------------------------
// 7. Слои: артефакты и самодоработка
// ---------------------------------------------------------------------------

check('слой артефактов включается только с своими инструментами', () => {
  const withArtifacts = build(ROUTES[1])
  assert.match(withArtifacts, /## Превью и артефакты/)
  const without = build(ROUTES.find(r => r.name === 'чат-агент без папки'))
  assert.ok(!without.includes('## Превью и артефакты'), 'слой пришёл без инструментов')
  assert.ok(!build(ROUTES.find(r => r.name === 'Дизайн')).includes('## Превью и артефакты'),
    'артефакты лезут в Дизайн, где свои инструменты')
})

check('самодоработка доходит до Дизайна и до разговора', () => {
  for (const mode of ['conversation', 'design']) {
    const prompt = modePrompts.buildModePrompt(mode, {
      toolNames: mode === 'design' ? DESIGN_TURN : [],
      personal: PERSONAL, language: LANGUAGE, selfDevelopment: true,
      designName: 'Пальмы'
    })
    assert.match(prompt, /Ты правишь само приложение onlyone/, 'нет слоя в режиме ' + mode)
  }
})

check('слой самодоработки не приходит, когда он выключен', () => {
  const prompt = build(ROUTES[1])
  assert.ok(!prompt.includes('Ты правишь само приложение onlyone'),
    'самодоработка включена без переключателя')
})

console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exit(failed ? 1 : 0)
