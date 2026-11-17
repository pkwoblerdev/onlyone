// Project tools reach across chats and rewrite the plan, so their guards matter:
// an agent must not read a chat from another project, invent a plan step that
// depends on nothing, or file a note into a conversation that is not its own.
const fs = require('fs')
const path = require('path')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const start = src.indexOf('async function executeProjectTool')
const end = src.indexOf('function buildSystemPrompt(')
if (start < 0 || end < 0) throw new Error('executeProjectTool не найдена')

// Настоящая точка отправки хода в окно: инструменты пишут в ленту через неё, и
// подставка здесь спрятала бы бросок на уничтоженном окне — ровно тот дефект,
// который теперь закрыт.
const guardStart = src.indexOf('function sendToWindow(event, channel, body) {')
const guardEnd = src.indexOf('async function runAgentMode(', guardStart)
if (guardStart < 0 || guardEnd < guardStart) throw new Error('sendToWindow не найдена')

const schemaStart = src.indexOf('function projectToolSchemas')
const schemaEnd = src.indexOf('async function executeProjectTool')

let stored = { conversations: [], projects: [] }
const sent = []

const scope = {
  cleanString: (v, max) => String(v ?? '').trim().slice(0, max || 200),
  readSecure: key => stored[key] || [],
  writeSecure: (key, value) => { stored[key] = value },
  conversationsForProject: id => (stored.conversations || []).filter(c => c && c.projectId === id),
  currentProject: () => (stored.projects || [])[0] || null,
  projectsList: () => stored.projects || [],
  crypto: { randomUUID: () => 'new-' + (sent.length + 1) },
  BrowserWindow: { getAllWindows: () => [] },
  historyGuard: { wrote() {}, seen() {}, reconcile: (_id, list) => list },
  // Where the running turn stands. The tools used to read this off module
  // globals; now it belongs to the turn, and here the turn is the test.
  turnHere: () => ({ chatId: stored.hereId || null, projectId: (stored.projects[0] || {}).id }),
  // The knowledge reader needs a disk and a way to tell text from a picture.
  fs: require('fs').promises,
  basename: path.basename,
  classifyAttachment: file => ({ kind: /\.(png|jpg|jpeg|gif|webp)$/i.test(file) ? 'image' : 'text' }),
  PROJECT_FILE_MAX_BYTES: 2 * 1024 * 1024,
  PROJECT_FILE_MAX_CHARS: 60000
}

// eslint-disable-next-line no-new-func
const build = new Function(
  ...Object.keys(scope),
  src.slice(guardStart, guardEnd) + '\n' + src.slice(schemaStart, schemaEnd) + src.slice(start, end) +
  '\nreturn { executeProjectTool, projectToolSchemas }'
)(...Object.values(scope))

const event = { sender: { send: (channel, data) => sent.push({ channel, data }) } }

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

function reset() {
  stored = {
    projects: [{ id: 'p1', name: 'Проект', plan: [] }],
    conversations: [
      { id: 'c1', title: 'Архитектура', projectId: 'p1', messages: [{ role: 'user', content: 'как устроено?' }], updatedAt: 1 },
      { id: 'c2', title: 'Баги', projectId: 'p1', messages: [], updatedAt: 2 },
      { id: 'other', title: 'Чужой', projectId: 'p2', messages: [{ role: 'user', content: 'секрет' }], updatedAt: 3 }
    ]
  }
  sent.length = 0
}


// --- what the agent is told before it starts --------------------------------
// Naming the tools was not enough: an agent that does not know a neighbouring
// chat exists never opens it. The digest is the part that makes it look.

const blockStart = src.indexOf('function buildProjectBlock')
const blockEnd = src.indexOf('function conversationsForProject')
if (blockStart < 0 || blockEnd < 0) throw new Error('buildProjectBlock не найдена')

function digestFor(state, currentChatId) {
  const scoped = {
    cleanString: (v, max) => String(v ?? '').trim().slice(0, max || 200),
    currentProject: () => state.projects[0] || null,
    conversationsForProject: id => state.conversations.filter(c => c && c.projectId === id),
    // The digest asks the running turn which chat it is being built for.
    turnHere: () => ({ chatId: currentChatId || null }),
    basename: path.basename,
    cleanToolNames: require('../src/main/mode-prompts/tools').cleanNames,
    PROJECT_DIGEST_CHATS: 8
  }
  // eslint-disable-next-line no-new-func
  return new Function(
    ...Object.keys(scoped),
    src.slice(blockStart, blockEnd) +
    // Проектные инструменты подключены: блок описывает проект так, как он
    // описывается обычному ходу. Случай «проекта нет в этом ходе» проверяет
    // test-projects.
    '\nreturn buildProjectBlock(["project_chats", "project_chat", "project_file", "project_note",' +
    ' "project_topic_set", "project_plan_set", "project_plan_get"])'
  )(...Object.values(scoped))
}

function digestChecks() {
  reset()
  stored.projects[0].description = 'Магазин на Telegram'
  stored.projects[0].instructions = 'Возвраты денег не делаем.'
  stored.conversations[1].messages = [
    { role: 'user', content: 'почему падает оплата' },
    { role: 'assistant', content: 'дело в таймауте Bybit', pinned: true }
  ]

  const text = digestFor(stored, 'c1')

  check('в контекст попало описание проекта', text.includes('Магазин на Telegram'))
  check('в контекст попали инструкции', text.includes('Возвраты денег не делаем'))
  check('соседний диалог назван', text.includes('Баги'), text.slice(0, 200))
  check('видно, о чём спрашивали', text.includes('почему падает оплата'))
  check('видно, чем кончилось', text.includes('таймауте Bybit'))
  check('идентификатор для project_chat указан', text.includes('[c2]'))
  check('текущий диалог в выжимку не попал', !text.includes('[c1]'), text.slice(0, 200))
  check('сказано не решать заново по-другому', /не решай заново/.test(text))

  // A pinned answer wins over whatever happened to be last.
  reset()
  stored.conversations[1].messages = [
    { role: 'user', content: 'вопрос' },
    { role: 'assistant', content: 'ВАЖНОЕ РЕШЕНИЕ', pinned: true },
    { role: 'assistant', content: 'проходная реплика' }
  ]
  check('закреплённое важнее последнего', digestFor(stored, 'c1').includes('ВАЖНОЕ РЕШЕНИЕ'))

  // An agent's own note is filed to be found later, so it carries too.
  reset()
  stored.conversations[1].messages = [
    { role: 'user', content: 'вопрос' },
    { role: 'assistant', content: 'заметка агента', fromAgentNote: true }
  ]
  check('заметка агента попадает в выжимку', digestFor(stored, 'c1').includes('заметка агента'))

  // The chat's own topic is a boundary, not trivia — it goes in first.
  reset()
  stored.conversations[0].topic = 'Только архитектура. Маркетинг в соседнем чате.'
  stored.conversations[1].topic = 'Только баги оплаты.'
  // A chat with no messages is not in the digest at all, so give it one.
  stored.conversations[1].messages = [{ role: 'user', content: 'падает оплата' }]
  const bounded = digestFor(stored, 'c1')
  check('своя тема названа', bounded.includes('Только архитектура'))
  check('тема служит контекстом, не отменяя текущую просьбу', /Тема помогает восстановить контекст, но не заменяет текущую просьбу/.test(bounded))
  check('перенос и заметки в соседних чатах требуют просьбы пользователя', /Не переноси разговор и не создавай заметки в соседних чатах без просьбы пользователя/.test(bounded))
  check('тема соседа видна', bounded.includes('Только баги оплаты'))

  reset()
  check('без темы предлагается её записать',
    /Тема этого диалога ещё не записана/.test(digestFor(stored, 'c1')))

  // The plan is the project's logic; without it in the prompt nobody advances it.
  reset()
  stored.projects[0].plan = [
    { id: 'a', title: 'Собрать требования', status: 'done', dependsOn: [] },
    { id: 'b', title: 'Починить оплату', status: 'doing', dependsOn: ['a'] }
  ]
  const withPlan = digestFor(stored, 'c1')
  check('план виден агенту', withPlan.includes('Починить оплату') && withPlan.includes('[b]'))
  check('в плане видно зависимости', withPlan.includes('после: a'))
  check('в плане видно статус', withPlan.includes('doing'))
  check('велено держать план в актуальном виде', /закончил шаг/.test(withPlan))

  reset()
  stored.projects[0].plan = []
  check('без плана предлагается его составить',
    /Плана у проекта пока нет/.test(digestFor(stored, 'c1')))

  // Outside a project none of this appears.
  stored.projects = []
  check('вне проекта блок пустой', digestFor(stored, 'c1') === '')
}

async function main() {
  // Tools only exist inside a project.
  reset()
  check('в проекте инструменты есть', build.projectToolSchemas().length >= 5)
  stored.projects = []
  check('вне проекта инструментов нет', build.projectToolSchemas().length === 0)

  // Listing sees only this project's chats.
  reset()
  const list = await build.executeProjectTool(event, 'project_chats', {}, 'r1')
  check('список отдаёт только свои диалоги',
    list.success && list.chats.length === 2 && !list.chats.some(c => c.id === 'other'),
    JSON.stringify(list.chats?.map(c => c.id)))

  // Reading a chat from another project is refused.
  reset()
  const foreign = await build.executeProjectTool(event, 'project_chat', { id: 'other' }, 'r1')
  check('чужой диалог не читается', foreign.success === false, JSON.stringify(foreign))

  reset()
  const own = await build.executeProjectTool(event, 'project_chat', { id: 'c1' }, 'r1')
  check('свой диалог читается', own.success && own.messages.length === 1, JSON.stringify(own))

  // A note lands in an existing chat of the project.
  reset()
  const noted = await build.executeProjectTool(event, 'project_note', { id: 'c2', text: 'нашёл утечку' }, 'r1')
  check('запись попадает в указанный диалог',
    noted.success && stored.conversations.find(c => c.id === 'c2').messages.at(-1).content === 'нашёл утечку')
  check('запись помечена как заметка агента',
    stored.conversations.find(c => c.id === 'c2').messages.at(-1).fromAgentNote === true)

  // Without an id a new chat appears inside the project, not loose.
  reset()
  const fresh = await build.executeProjectTool(event, 'project_note', { title: 'Итоги', text: 'вывод' }, 'r1')
  const created = stored.conversations.find(c => c.id === fresh.chatId)
  check('новый диалог создаётся в проекте', created && created.projectId === 'p1', JSON.stringify(fresh))

  // Writing into another project's chat is refused.
  reset()
  const intrusion = await build.executeProjectTool(event, 'project_note', { id: 'other', text: 'привет' }, 'r1')
  check('в чужой диалог писать нельзя', intrusion.success === false, JSON.stringify(intrusion))

  // Empty notes are rejected rather than filed.
  reset()
  const empty = await build.executeProjectTool(event, 'project_note', { text: '   ' }, 'r1')
  check('пустая запись отклонена', empty.success === false)

  // The plan keeps only well-formed steps and drops dangling dependencies.
  reset()
  const plan = await build.executeProjectTool(event, 'project_plan_set', {
    steps: [
      { id: 'a', title: 'Собрать требования' },
      { id: 'b', title: 'Сделать', dependsOn: ['a', 'нет-такого', 'b'] },
      { id: '', title: 'Без id' },
      { id: 'c', title: '' }
    ]
  }, 'r1')
  const saved = stored.projects[0].plan
  check('план сохранён', plan.success && saved.length === 2, JSON.stringify(plan))
  check('шаги без id и без названия отброшены', saved.every(s => s.id && s.title))
  check('висячая зависимость убрана', saved[1].dependsOn.length === 1 && saved[1].dependsOn[0] === 'a',
    JSON.stringify(saved[1].dependsOn))
  check('шаг не зависит сам от себя', !saved[1].dependsOn.includes('b'))
  check('статус по умолчанию — todo', saved[0].status === 'todo')

  reset()
  const emptyPlan = await build.executeProjectTool(event, 'project_plan_set', { steps: [] }, 'r1')
  check('пустой план отклонён', emptyPlan.success === false)

  // Each chat remembers what it is for, so an agent does not write game code in
  // the marketing chat just because that is where it was standing.
  reset()
  const topic = await build.executeProjectTool(event, 'project_topic_set',
    { id: 'c2', topic: 'Только баги оплаты. Код игры сюда не писать.' }, 'r1')
  check('тема записалась', topic.success &&
    stored.conversations.find(c => c.id === 'c2').topic.includes('баги оплаты'),
    JSON.stringify(topic))

  reset()
  const foreignTopic = await build.executeProjectTool(event, 'project_topic_set',
    { id: 'other', topic: 'чужое' }, 'r1')
  check('чужому диалогу тему не поставить', foreignTopic.success === false)

  reset()
  const emptyTopic = await build.executeProjectTool(event, 'project_topic_set', { topic: '  ' }, 'r1')
  check('пустая тема отклонена', emptyTopic.success === false)

  // --- the knowledge base -----------------------------------------------------
  // The files sit wherever the user keeps them, which is outside the working
  // folders, so this tool is the only way in. Its guard is the project's own
  // list: a name the model composed matches nothing.
  const sample = path.join(require('os').tmpdir(), 'onecode-знания-проверка.md')
  fs.writeFileSync(sample, 'Оптовая цена одной единицы товара — 417 рублей.', 'utf8')

  reset()
  stored.projects[0].knowledgeFiles = [
    { path: sample, name: 'справочник-цен.md' },
    { path: 'C:/фото/схема.png', name: 'схема.png' }
  ]

  const read = await build.executeProjectTool(event, 'project_file',
    { name: 'справочник-цен.md' }, 'r1')
  check('файл базы знаний читается по имени',
    read.success === true && /417/.test(read.text || ''), JSON.stringify(read).slice(0, 120))

  const byPath = await build.executeProjectTool(event, 'project_file', { name: sample }, 'r1')
  check('и по полному пути из списка тоже', byPath.success === true)

  // The whole point of matching against the list: anything else reads nothing.
  const invented = await build.executeProjectTool(event, 'project_file',
    { name: 'C:/Windows/System32/drivers/etc/hosts' }, 'r1')
  check('придуманный путь ничего не открывает', invented.success === false,
    JSON.stringify(invented).slice(0, 120))
  check('и в отказе перечислено, что вообще есть',
    Array.isArray(invented.files) && invented.files.includes('справочник-цен.md'),
    JSON.stringify(invented.files))

  const picture = await build.executeProjectTool(event, 'project_file', { name: 'схема.png' }, 'r1')
  check('картинка не выдаётся как текст', picture.success === false,
    JSON.stringify(picture).slice(0, 120))

  const nameless = await build.executeProjectTool(event, 'project_file', {}, 'r1')
  check('без имени файла отказ', nameless.success === false)

  // A project with no knowledge base at all must not fall over.
  reset()
  const nothing = await build.executeProjectTool(event, 'project_file', { name: 'что-нибудь' }, 'r1')
  check('в проекте без базы знаний — понятный отказ', nothing.success === false)

  fs.unlinkSync(sample)

  digestChecks()

  console.log(JSON.stringify({ ok: failed === 0, failed }))
  process.exit(failed ? 1 : 0)
}

main()
