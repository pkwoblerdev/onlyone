// What a project actually hands the agent. Deterministic, so it is checked here;
// whether the model then obeys is a separate question, answered by the live run.
//
// A project is the only place where one conversation can affect another: an agent
// reads its siblings, writes notes into them, sets a plan the next turn will see.
// So the block that carries all that has to be exactly right — a project whose
// instructions silently fail to arrive looks like a model that ignores them.
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
const make = new Function(
  // The digest asks the running turn which chat it is being built for; here
  // the turn is the test.
  'currentProject', 'turnHere', 'conversationsForProject', 'cleanString',
  'basename', 'cleanToolNames',
  // The digest limits are declared above the function and have to come with it.
  cut('const PROJECT_DIGEST_CHATS', 'function projectsList') +
  cut('function buildProjectBlock(toolNames = []) {', '\nfunction conversationsForProject') +
  '\nreturn buildProjectBlock'
)

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const clean = (v, n) => String(v || '').slice(0, n)
const cleanNames = require('../src/main/mode-prompts/tools').cleanNames
const PROJECT_TOOL_NAMES = ['project_chats', 'project_chat', 'project_file', 'project_note',
  'project_topic_set', 'project_plan_set', 'project_plan_get']
const build = (project, chats = [], hereId = null, names = PROJECT_TOOL_NAMES) =>
  make(() => project, () => ({ chatId: hereId }), () => chats, clean, path.basename, cleanNames)(names)

// --- no project, nothing said ------------------------------------------------
check('без проекта блока нет', build(null) === '', JSON.stringify(build(null)))

// --- the basics ---------------------------------------------------------------
const basic = build({
  id: 'p', name: 'Магазин', description: 'Продажа аккаунтов', instructions: ''
})
check('название проекта названо', basic.includes('Магазин'), basic.slice(0, 80))
check('описание проекта передано', basic.includes('Продажа аккаунтов'))
check('блок помечен заголовком', basic.includes('## Проект'))

// --- цель проекта (макет 21.10): агент держит её в голове в каждом чате ---------
const withGoal = build({ id: 'p', name: 'Магазин', goal: 'p95 ниже 200 мс во всём API' })
check('цель проекта передана', withGoal.includes('p95 ниже 200 мс во всём API'), withGoal.slice(0, 200))
check('цель названа целью', /Цель проекта/.test(withGoal))

// --- instructions outrank the general rules, and say so -----------------------
const instructed = build({
  id: 'p', name: 'Магазин', instructions: 'Всегда отвечай по-русски и коротко.'
})
check('инструкции проекта переданы',
  instructed.includes('Всегда отвечай по-русски и коротко.'), instructed.slice(-120))
check('сказано, что они важнее общих правил',
  /важнее общих правил/.test(instructed))
check('но не важнее безопасности',
  /кроме безопасности/.test(instructed), instructed.slice(-160))

// --- the knowledge base -------------------------------------------------------
const withFiles = build({
  id: 'p', name: 'Магазин',
  knowledgeFiles: [{ path: 'C:/Users/user/Документы/правила.md' }, { name: 'цены.csv' }]
})
check('файлы базы знаний перечислены',
  withFiles.includes('правила.md') && withFiles.includes('цены.csv'),
  withFiles.slice(0, 200))

// The files are chosen through a file dialog, so they are stored with absolute
// paths — and the file tools reject absolute paths by design. Listing the path
// told the agent to do the one thing that cannot work.
check('абсолютный путь агенту не показывают',
  !withFiles.includes('C:/Users'), 'в промпте оказался путь с диска')
check('сказано, чем их читать',
  /project_file/.test(withFiles), withFiles.slice(0, 300))

// A project with twenty-five files must not push everything else out of the
// prompt: the list is capped.
const many = build({
  id: 'p', name: 'Магазин',
  knowledgeFiles: Array.from({ length: 40 }, (_, i) => ({ path: `файл-${i}.md` }))
})
check('длинный список файлов усечён',
  !many.includes('файл-30.md'), 'в промпте оказался 31-й файл')
check('но начало списка на месте', many.includes('файл-0.md'))

// --- the topic keeps one conversation in its lane -----------------------------
const chats = [
  { id: 'a', title: 'Маркетинг', topic: 'только реклама и воронки' },
  { id: 'b', title: 'Код бота', topic: 'только код' }
]

const inMarketing = build({ id: 'p', name: 'Магазин' }, chats, 'a')
check('тема текущего диалога передана',
  inMarketing.includes('только реклама и воронки'), inMarketing.slice(-300))
check('сказано, куда девать постороннее',
  /project_chats/.test(inMarketing) && /project_note/.test(inMarketing))

// A chat with no topic yet is told to set one rather than left to drift.
const noTopic = build({ id: 'p', name: 'Магазин' }, [{ id: 'a', title: 'Новый' }], 'a')
check('без темы предлагается её записать',
  /project_topic_set/.test(noTopic), noTopic.slice(-200))

// Без проектных инструментов блок остаётся фактами о проекте и не обещает
// вызовов: ход без `project_file` не может прочитать базу знаний и не должен
// делать вид, что может (план, 6.2).
const noTools = build({ id: 'p', name: 'Магазин', knowledgeFiles: [{ name: 'прайс.md', path: 'D:/база/прайс.md' }] },
  [{ id: 'a', title: 'Новый' }], 'a', [])
check('ход без проектных инструментов не называет ни одного',
  !/project_file|project_chats|project_note|project_topic_set/.test(noTools), noTools.slice(0, 400))
check('без инструментов база знаний всё равно названа',
  /прайс\.md/.test(noTools) && /присылает человек/.test(noTools), noTools.slice(0, 400))

// --- the tools that make a project more than a folder -------------------------
const tools = cut('function projectToolSchemas() {', '\nasync function executeProjectTool')
for (const name of ['project_chats', 'project_chat', 'project_note', 'project_file',
  'project_topic_set', 'project_plan_set', 'project_plan_get']) {
  check(`инструмент ${name} объявлен`, tools.includes(`name: '${name}'`))
}

// Writing into a sibling chat is the one that can duplicate work, so it has to
// find an existing note rather than making a new chat every time.
const exec = cut('async function executeProjectTool(', '\nfunction ')
check('запись в диалог ищет существующий по названию',
  /project_note/.test(exec) && /title/.test(exec), 'нет поиска по названию')

// The knowledge reader takes a name and matches it against the project's own
// list. If it ever took a path straight from the model it would be a way
// around the sandbox that keeps agents inside the working folders.
check('чтение базы знаний идёт по списку проекта, а не по пути от модели',
  /knowledgeFiles/.test(exec) && !/assertSafeWorkspacePath/.test(
    exec.slice(exec.indexOf("project_file"), exec.indexOf("project_note"))),
  'файл берётся не из списка проекта')
check('размер файла базы знаний ограничен',
  /PROJECT_FILE_MAX_BYTES/.test(exec) && /PROJECT_FILE_MAX_CHARS/.test(exec))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
