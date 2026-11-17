// Лишние инструменты не едут в каждом запросе (волна 4, расход токенов).
//
// Описания 43 инструментов весят около 10 тысяч токенов, и модели отправляются на КАЖДОМ шаге хода:
// двадцать пять шагов — это те самые 260 тысяч «за просто анализ». Большая часть описаний нужна
// редко: монтаж видео, дизайн, свои инструменты и MCP, правка скиллов, браузер и
// слежение за страницей. Эти группы подключаются, когда о них речь в последних сообщениях человека
// или когда ход уже вызывал инструмент группы. Основа — файлы, поиск, команды, чек-лист, вопрос,
// чтение страниц по адресу — остаётся всегда.
//
// Подмена только в том, что УХОДИТ провайдеру: вызвать инструмент по имени можно в любой момент,
// исполнение не ограничено, так что ошибка в словах-триггерах стоит одного лишнего вопроса, а не
// сломанной работы.

const GROUPS = [
  { id: 'desk', names: ['desk_workspace'], rx: /\bdesk\b|деск|рабоч(?:ая|ую|ей) сред|рабоч(?:ее|его) пространств|workspace/i },
  {
    id: 'video',
    names: ['video_render_html', 'video_render', 'show_video', 'video_analyze', 'video_download', 'ffmpeg_install', 'ffmpeg_info'],
    rx: /видео|ролик|монтаж|ffmpeg|рилс|рилз|reels?|клип|субтитр|озвуч|video|footage|trailer|shorts/i
  },
  {
    id: 'design',
    names: ['design_task'],
    rx: /дизайн|макет|вёрстк|верстк|лендинг|landing|mockup|design|\blayout\b|интерфейс экран|прототип/i
  },
  {
    id: 'tooling',
    names: ['define_tool', 'add_mcp_server', 'list_mcp_servers'],
    rx: /инструмент|mcp|мцп|tool|плагин|подключи\s+сервер|интеграц/i
  },
  {
    id: 'skills-admin',
    names: ['add_skill', 'update_skill', 'toggle_skill', 'delete_skill'],
    rx: /скилл|skill|навык/i
  },
  {
    id: 'browser',
    names: ['browse_page', 'browse_click', 'browse_input', 'browse_screenshot', 'watch_page', 'stop_watching'],
    rx: /браузер|страниц|сайт|веб|http|localhost|вкладк|скрин|слеж|наблюда|следи|открой|откройте|watch|browser|website|web ?page|url|ссылк|\b[a-z0-9-]+\.(com|ru|org|net|io|dev|app|su)\b/i
  },
  {
    id: 'artifacts',
    names: ['show_artifact', 'update_artifact', 'artifacts_list'],
    rx: /покажи|показа|превью|предпросмотр|график|диаграмм|таблиц|артефакт|chart|preview|artifact|html|svg|дашборд|dashboard|отчёт|отчет/i
  }
]

// Реплика, которую вставило само приложение (поручение помощнику, отчёты команды, приёмка), помечена символом SYNTHETIC:
// это не слова человека, и по ним нельзя решать, какие инструменты включать. Символ, а не строковое поле: его не видят
// провайдеры (JSON.stringify), но копия `{ ...message }` его сохраняет.
const SYNTHETIC = Symbol.for('onlyone.synthetic')

function userTexts (messages, count = 3) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== 'user' || message[SYNTHETIC]) continue
    const content = message.content
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join(' ').trim() : ''
    if (text) out.push(text)
  }
  return out.slice(-count)
}

// tools — полный список схем; options.texts — последние сообщения человека; options.used — имена инструментов,
// уже вызванных в этом ходе.
function slimTools (tools, options = {}) {
  if (options.enabled === false) return tools
  const texts = Array.isArray(options.texts) ? options.texts.join('\n') : String(options.texts || '')
  const used = options.used instanceof Set ? options.used : new Set(options.used || [])
  const hide = new Set()
  for (const group of GROUPS) {
    const spoken = group.rx.test(texts)
    const inUse = group.names.some(name => used.has(name))
    if (!spoken && !inUse && !(options.keep && group.names.some(name => options.keep.has(name)))) {
      for (const name of group.names) hide.add(name)
    }
  }
  return (tools || []).filter(tool => !hide.has(tool && tool.function && tool.function.name))
}

module.exports = { GROUPS, SYNTHETIC, slimTools, userTexts }
