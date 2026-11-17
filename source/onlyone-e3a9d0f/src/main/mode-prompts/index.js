// Промпты режимов — данные, а не строки внутри главного процесса.
//
// Сознательное решение: особого системного промпта для маленьких
// моделей больше нет. Вместо него у каждого режима приложения свой текст,
// написанный так, чтобы в onlyone работала любая модель — знала, где она, какие у
// неё руки и как здесь принято сдавать работу.
//
// Каждый режим отвечает на четыре вопроса, и они стоят в одном порядке:
// где модель и что видит человек; какие инструменты есть в этом режиме и когда
// каким пользоваться; как здесь принято отвечать; как сдавать работу.
//
// Список инструментов берётся из фактически подключённых к запросу схем
// (ctx.toolNames), а не из текста: промпт, обещающий вызов, которого нет, стоит
// модели хода, закончившегося ожиданием.
//
// Личное (имя, «кто вы», упор, тон) подставляет главный процесс строкой
// ctx.personal, и сборка без этой строки не собирается: пропустить человека
// в одном из входов — ровно та ошибка, из-за которой обычный чат без
// инструментов годами отвечал не тому человеку.

const shared = require('./shared')
const tools = require('./tools')
const team = require('./team')

const conversation = require('./conversation')
const agent = require('./agent')
const design = require('./design')

// Слои, которые накладываются на режим, а не заменяют его: они включаются тогда,
// когда у режима есть под них инструменты или настройка.
const artifacts = require('./artifacts')
const selfDev = require('./self-dev')

const BASE = {
  [conversation.id]: conversation,
  [agent.id]: agent,
  [design.id]: design
}

// Так режимы называются для человека: список режимов виден в тестах и в окне
// отладки, а не только в коде.
const MODES = [
  { id: conversation.id, title: conversation.title, kind: 'mode' },
  { id: agent.id, title: agent.title, kind: 'mode' },
  { id: 'team', title: 'Команда', kind: 'roles' },
  { id: design.id, title: design.title, kind: 'mode' },
  { id: artifacts.id, title: artifacts.title, kind: 'layer' },
  { id: selfDev.id, title: selfDev.title, kind: 'layer' }
]

function modeTitle(mode) {
  const found = MODES.find(item => item.id === mode)
  return found ? found.title : mode
}

// Режимы, собираемые целиком одним вызовом.
// `tail` — то, что меняется от сообщения к сообщению (памятки по тексту просьбы, «сделай полностью», напоминание о
// длинном разговоре). Оно стоит ПОСЛЕ всего постоянного: провайдер кэширует начало запроса, и пока начало не
// менялось, оплачивается только хвост.
function buildModePrompt(mode, ctx = {}, parts = [], tail = []) {
  const module = BASE[mode]
  if (!module) {
    throw new Error(`Неизвестный режим промпта: ${mode}. Есть: ${Object.keys(BASE).join(', ')}.`)
  }
  if (ctx.personal === undefined) {
    throw new Error('buildModePrompt: не передан ctx.personal — контекст человека подставляется в каждый вход, а не дописывается по дороге.')
  }

  const text = [module.build(ctx)]

  const names = tools.cleanNames(ctx.toolNames)
  // Превью и артефакты — про показ результата, поэтому слой включается сам,
  // когда у режима есть чем показать. В Дизайне свои инструменты и своя панель.
  if (mode !== design.id && names.some(name => name === 'show_artifact')) {
    text.push(artifacts.build({ ...ctx, toolNames: names }))
  }
  if (ctx.selfDevelopment) text.push(selfDev.build(ctx))

  // Ролевые части конкретного входа (бриф ведущего, задание этапа, договорённости
  // команды, памятки) идут после текста режима.
  for (const part of parts) {
    const value = String(part || '').trim()
    if (value) text.push(value)
  }

  // Человек — последним, после всех ролей: это про него, а не про задачу хода.
  const personal = String(ctx.personal || '').trim()
  if (personal) text.push(personal)

  for (const part of tail) {
    const value = String(part || '').trim()
    if (value) text.push(value)
  }

  return text.join('\n\n')
}

module.exports = {
  BASE,
  MODES,
  agent,
  artifacts,
  buildModePrompt,
  conversation,
  design,
  modeTitle,
  selfDev,
  shared,
  team,
  tools
}
