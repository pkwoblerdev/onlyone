// Перечень инструментов режима собирается из фактически подключённых имён, а не
// из памяти о том, что в приложении вообще бывает.
//
// Промпт, называющий инструмент, которого в запросе нет, учит модель писать его
// вызов: приходит пустота, модель ждёт результат и на этом заканчивает ход.
// Именно из-за этого отказа в своё время появились «рельсы», а вместе с ними и
// соблазн выбирать текст по имени модели. Причина же была в списке инструментов,
// который не совпадал с реальным.
//
// Здесь описано, КОГДА каким инструментом пользуются в onlyone. Схемы с
// параметрами приходят отдельно, в том же запросе, и пересказывать их здесь
// значило бы только отнять место у задачи.

// Порядок групп — порядок, в котором их стоит читать: сначала то, чем делают
// работу, потом то, чем договариваются.
const GROUPS = [
  {
    title: 'Файлы рабочих папок',
    when: {
      list_files: 'узнать, что лежит в папке; начинать с «.»',
      search_files: 'найти текст или имя по проекту, а не перебором папок',
      find_symbol: 'найти, где определена функция, класс или константа; без имени — карта проекта',
      read_file: 'прочитать файл прежде, чем говорить о нём или править его',
      edit_file: 'поправить фрагмент существующего файла: old_str → new_str, без пересылки всего файла',
      write_file: 'создать файл или перезаписать целиком — только прочитав его',
      create_directory: 'создать папку, промежуточные тоже',
      move_path: 'перенести или переименовать',
      delete_path: 'удалить — только когда об этом просили'
    }
  },
  {
    title: 'Запуск и собственные инструменты',
    when: {
      run_command: 'выполнить команду в рабочей папке; вывод — начало и конец с отметкой, сколько середины выпало',
      define_tool: 'написать себе инструмент, когда задача — однотипный перебор многих файлов; вызывается как own_<имя>'
    }
  },
  {
    title: 'Сеть',
    when: {
      fetch_url: 'прочитать страницу текстом; длинную — по частям через offset'
    }
  },
  {
    title: 'Превью и артефакты',
    when: {
      desk_workspace: 'собрать отдельное окно Desk этого чата: read перед правкой, add с URL или artifact:id; общения внутри Desk нет',
      show_artifact: 'показать результат рядом с ответом: страницу, картинку, таблицу, график, код или дифф',
      update_artifact: 'править ту же работу новой версией, а не показывать вторую',
      show_video: 'показать готовый ролик из рабочей папки рядом с ответом и в блоке Ultra',
      artifacts_list: 'увидеть, что в этом диалоге уже показано, чтобы не дублировать',
      design_task: 'поручить разделу «Дизайн» макет по брифу и править тот же проект по design_id'
    }
  },
  {
    title: 'Скиллы',
    when: {
      list_skills: 'обновить каталог скиллов',
      use_skill: 'прочитать инструкцию подходящего скилла и применять её шаги',
      skill_file: 'прочитать файл пакета скилла, не загружая пакет целиком',
      add_skill: 'сохранить повторяемый процесс, когда об этом попросили',
      update_skill: 'изменить скилл по его точному ID, прочитав текущую версию',
      delete_skill: 'удалить один точный ID, когда об этом попросили',
      toggle_skill: 'включить или выключить скилл'
    }
  },
  {
    title: 'MCP',
    when: {
      list_mcp_servers: 'посмотреть подключённые серверы',
      add_mcp_server: 'подключить сервер по просьбе пользователя'
    }
  },
  {
    title: 'Порядок работы',
    when: {
      task_plan: 'вести чек-лист хода, когда шагов три или больше; пункт — проверяемый результат',
      read_guide: 'прочитать памятку приложения по типу задачи; id=catalog показывает список'
    }
  },
  {
    title: 'Разговор с человеком',
    when: {
      ask_user: 'спросить карточкой с вариантами там, где решение принимает только человек',
      propose_linked_chat: 'предложить человеку выделить тему в связанный чат; ничего не создаёт и не запускает'
    }
  },
  {
    title: 'Команда',
    when: {
      assign_work: 'раздать независимые части помощникам',
      board_read: 'прочитать доску поручений',
      board_update: 'отметить свой пункт: doing, когда взялся, done, когда сдано, blocked с причиной',
      agent_message: 'вопрос, возражение или ответ другому агенту'
    }
  },
  {
    title: 'Проект',
    when: {
      project_chats: 'найти диалоги и темы проекта',
      project_chat: 'прочитать диалог проекта',
      project_file: 'прочитать файл базы знаний проекта по его имени',
      project_note: 'записать вывод в диалог проекта',
      project_topic_set: 'задать тему диалога',
      project_plan_get: 'прочитать план проекта',
      project_plan_set: 'обновить план проекта'
    }
  }
]

// Инструменты раздела «Дизайн» описаны подробно в самом разделе (см.
// ../design/prompt.js), и пересказывать их здесь значило бы иметь два описания,
// которые разъезжаются при первой же правке. Поэтому для dc_* здесь только
// группа: имена приходят фактическим списком подключённых инструментов.
const DESIGN_GROUP = 'Инструменты дизайна'
const DESIGN_SHORT = 'создание, правка и проверка макета в разделе «Дизайн»; описаны ниже по тексту этого режима'

const GUIDANCE = new Map()
for (const group of GROUPS) {
  for (const [name, when] of Object.entries(group.when)) GUIDANCE.set(name, { group: group.title, when })
}

const OTHER_GROUP = 'Прочее'

function isToolName(value) {
  return /^[a-z][a-z0-9_]{1,63}$/i.test(String(value || ''))
}

// Имена, которые приносит сам ход: свои инструменты и инструменты MCP-серверов.
function isDynamic(name) {
  return name.startsWith('own_') || name.startsWith('mcp_')
}

function cleanNames(names) {
  const seen = new Set()
  const out = []
  const source = Array.isArray(names) ? names
    : (names && typeof names === 'object' ? Object.keys(names) : [])
  for (const raw of source) {
    const name = isToolName(raw) ? String(raw) : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out.sort()
}

// `names` — фактический список инструментов, приложенных к этому запросу.
function renderToolManifest(names) {
  const list = cleanNames(names)

  if (!list.length) {
    return '## Инструменты этого режима\n\n' +
      'Инструментов в этом запросе нет: ты не читаешь файлы, не запускаешь команды и ничего не изменяешь. ' +
      'Всё, что тебе известно о проекте, — присланное человеком и приведённое выше в этом же запросе. ' +
      'Не утверждай, что открыл файл, применил скилл или запустил проверку. Чего не хватает — назови прямо.'
  }

  const byGroup = new Map()
  const other = []
  for (const name of list) {
    const known = GUIDANCE.get(name)
    const group = known ? known.group
      : (name.startsWith('dc_') ? DESIGN_GROUP : null)
    if (!group) { other.push(name); continue }
    if (!byGroup.has(group)) byGroup.set(group, [])
    byGroup.get(group).push({ name, when: known ? known.when : DESIGN_SHORT })
  }

  const sections = []
  const titles = new Set([...GROUPS.map(group => group.title), DESIGN_GROUP])
  for (const title of titles) {
    const items = byGroup.get(title)
    if (!items || !items.length) continue
    // Командные инструменты называют, когда ими пользоваться: им не хватит одного имени. Остальные описаны схемами запроса.
    sections.push(title === 'Команда'
      ? `**${title}**\n` + items.map(item => `- \`${item.name}\` — ${item.when}`).join('\n')
      : `**${title}:** ` + items.map(item => `\`${item.name}\``).join(', '))
  }

  const dynamic = other.filter(isDynamic)
  const plain = other.filter(name => !isDynamic(name))
  if (dynamic.length) {
    sections.push(`**${OTHER_GROUP}:** ` +
      dynamic.map(name => `\`${name}\``).join(', ') + ' (имя точное, описание — в схеме запроса)')
  }
  if (plain.length) {
    sections.push('**Без описания режима:** ' + plain.map(name => `\`${name}\``).join(', ') + ' (схема — в запросе)')
  }

  return '## Инструменты этого режима\n\n' +
    'Ниже — весь набор этого хода (описания и параметры — в схемах запроса). Чего в списке нет, того нет, и звать это бесполезно.\n\n' +
    sections.join('\n')
}

module.exports = {
  GROUPS,
  GUIDANCE,
  DESIGN_GROUP,
  cleanNames,
  isDynamic,
  isToolName,
  renderToolManifest
}
