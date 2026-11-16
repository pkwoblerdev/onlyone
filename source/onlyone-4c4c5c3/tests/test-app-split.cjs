// Разделение app.js (план, 2d): экраны и виджеты уходят своими модулями, и
// набор следит, чтобы они не вернулись обратно в общий файл.
//
// Проверяется не «файл существует», а три вещи сразу: модуль подключён до
// app.js (иначе окно не соберётся), поведение живёт в модуле, а не в ленте
// чата, и модуль не лезет в чужие владения — настройки и ключи (их держит
// Claude, план 2.4/2.7).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const app = read('src/renderer/app.js')
const html = read('src/renderer/index.html')

let failed = 0
let total = 0
function check(name, fn) {
  total++
  try { fn(); console.log('  ok  ' + name) } catch (err) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + (err && err.message)) }
}

const MODULES = [
  {
    file: 'artifact-panel.js',
    global: 'OnlyoneArtifactPanel',
    owns: ['showArtifact', 'closeArtifactPanel', 'refreshArtifactChips', 'artifactTableHtml'],
    // В app.js от панели остаются только имена-обёртки.
    left: ['function artifactTableHtml', 'function fillArtifactVersions', 'ARTIFACT_TABLE_ROWS']
  },
  {
    // Карточка задачи Дизайна (план, этап 4). Ведущий добавил этот модуль в
    // реестр: без записи в GETTERS проверка обёрток считала бы новый геттер
    // чужим и роняла набор не на проверке, а на форме провода.
    file: 'design-task-card.js',
    global: 'OnlyoneDesignTaskCard',
    owns: ['function renderTaskCard', 'function redrawTaskCards', 'function onDesignTaskEvent'],
    left: ['function ensureInFeed(', 'function normalize(', "className = 'approval-card kind-design-task'"]
  },
  {
    // Живой вид браузера агента (план, 3.6б): карточка в панели «Работа».
    file: 'agent-browser-view.js',
    global: 'OnlyoneAgentBrowserView',
    owns: ['function renderFrame', 'function setStopped', 'function dispose'],
    left: ['function mountPoint(', 'function subscribe (', 'function rememberShot(']
  },
  {
    // Компактный список над «/» и над пилюлей режимов (план, 3.10).
    file: 'composer-menu.js',
    global: 'OnlyoneComposerMenu',
    owns: ['function open (', 'function close (', 'function accept ('],
    left: ['function renderSlashMenu(', 'filteredSlashCommands', 'let selectedSlashIndex']
  },
  {
    file: 'context-menu.js',
    global: 'OnlyoneContextMenu',
    owns: ['function open(', 'function close(', '.ctx-item'],
    left: ['function openContextMenu(x, y, items)', 'let openMenu = null']
  },
  {
    file: 'select-widget.js',
    global: 'OnlyoneSelectWidget',
    owns: ['function enhance(', 'MutationObserver'],
    // В app.js остаются только имена-обёртки; проверка по телу, а не по имени.
    left: ['const SELECT_VALUE =', 'new MutationObserver(build).observe']
  },
  {
    file: 'work-panel.js',
    global: 'OnlyoneWorkPanel',
    owns: ['function renderAgentTasks(', 'function panelPane(', "id = 'tasksPanel'",
      'function agentRunRecord('],
    // Панель целиком: рисование, часы и строки агентов. Обёртки с (...) {
    // оставляют только вызов, тело не возвращается.
    // Проверяют только те тела, что из app.js не вызываются: имена-обёртки
    // (renderAgentTasks, panelPane, renderTasksHeaderButton…) остаться обязаны.
    left: ['function tasksStatus(', 'function historySectionHtml(', 'function checklistHtml(',
      'function agentTaskState(pane, index, name)', 'const TASK_ICONS =']
  },
  {
    file: 'message-blocks.js',
    global: 'OnlyoneMessageBlocks',
    owns: ['function paintBlocks(', 'function blockElement(', 'function pushBlock(',
      'function toolParts('],
    // Из ленты наружу торчат только имена-обёртки; черновиками блоков,
    // дорожками и разбором вызова пользуется самого модуля.
    left: ['function blockRevision(', 'function workRunElement(', 'function laneOf(',
      'const THOUGHT_MIN =']
  },
  {
    file: 'send-controls.js',
    global: 'OnlyoneSendControls',
    owns: ['function setGeneratingState(', 'function renderQueued(', 'function stopTurn(',
      'const designQueue ='],
    // Наружу от управления отправкой торчат только обёртки; очередь и знак
    // окна проверяются по телу, которого в `app.js` больше быть не должно.
    left: ['function paintGlyph() {', 'const designQueue = new Map()',
      'function queuedFor(designId) {']
  },
  {
    file: 'chat-list.js',
    global: 'OnlyoneChatList',
    owns: ['function renderChatHistory(', 'function chatRow(', 'function folderRow(',
      'function openChatContextMenu('],
    // Из списка наружу живут только два имени: перерисовать список и перенести
    // диалог в проект. Тела строк, папок и меню обратно в `app.js` не должны.
    left: ['function collapsedFolders()', 'function startRenameChat(chat, row)',
      'const COLLAPSED_KEY =']
  },
  {
    file: 'conversation-compression.js',
    global: 'createConversationCompression',
    invocation: 'createConversationCompression({',
    owns: ['function createConversationCompression(', 'function markOf(',
      'function isCompressionFresh(', 'function applyCompression(', 'function lineHtml('],
    left: ['function markOf(', 'function isCompressionFresh(', 'function lineHtml(']
  }
]

for (const item of MODULES) {
  check(`${item.file}: модуль подключён до app.js`, () => {
    const source = read('src/renderer', item.file)
    assert.ok(source.includes(item.global), `модуль не отдаёт окно через ${item.global}`)
    assert.match(html.replace(/\r/g, ''), new RegExp(`<script src="${item.file}"></script>\\s*\\n(?:(?!<script src="app\\.js")[\\s\\S])*<script src="app\\.js"></script>`),
      `${item.file} подключён после app.js — окно не соберётся`)
    assert.ok(app.includes(item.invocation || `${item.global}.create(`), `app.js не создаёт ${item.file}`)
  })

  check(`${item.file}: поведение не вернулось в app.js`, () => {
    for (const marker of item.left) {
      assert.equal(app.includes(marker), false, `в app.js снова появилось «${marker}»`)
    }
    const source = read('src/renderer', item.file)
    for (const marker of item.owns) assert.ok(source.includes(marker), `в модуле нет «${marker}»`)
  })
}

check('вынесенные модули не лезут в настройки и ключи', () => {
  for (const item of MODULES) {
    const source = read('src/renderer', item.file)
    assert.equal(/setSettings|openrouterKeys|getEnabledKeys|settingsView/.test(source), false,
      `${item.file} трогает чужую зону (2.4/2.7)`)
  }
})

check('app.js стал меньше — вынос не превратился в перенос туда же', () => {
  const lines = app.split('\n').length
  // Отправная точка — 12 137 строк до начала 2d; с учётом экранов 1.2 держим границу до 12 100.
  assert.ok(lines < 12_100, `в app.js ${lines} строк`)
  console.log(`   в app.js строк: ${lines}`)
})

check('обёртки зовут только то, что модуль отдаёт', () => {
  // Обёртка без экспорта — это «is not a function» в окне, а не ошибка
  // сборки: заметна только тогда, когда панель реально рисуют.
  const GETTERS = {
    artifactPanel: 'artifact-panel.js', contextMenu: 'context-menu.js',
    selectWidget: 'select-widget.js', workPanel: 'work-panel.js',
    messageBlocks: 'message-blocks.js', sendControls: 'send-controls.js',
    chatList: 'chat-list.js', designTaskCards: 'design-task-card.js'
  }
  const exportsOf = file => {
    const source = read('src/renderer', file)
    const body = (source.match(/return Object\.freeze\(\{([\s\S]*?)\}\)/) || [, ''])[1]
    return new Set(body.split(/[,\s]+/).filter(Boolean))
  }
  const tables = new Map(Object.entries(GETTERS).map(([getter, file]) => [getter, exportsOf(file)]))
  let wired = 0
  for (const line of app.split('\n')) {
    const m = line.match(/^  function (\w+)\(\.\.\.args\) \{ return (\w+)\(\)\.(\w+)\(\.\.\.args\) \}/)
    if (!m) continue
    const [, wrapper, getter, exported] = m
    // Имя обёртки может отличаться от имени в модуле: openContextMenu() → open().
    const names = tables.get(getter)
    assert.ok(names, `${getter}() не относится к вынесенным модулям`)
    assert.ok(names.has(exported), `${GETTERS[getter]} не возвращает ${exported} — вызов упадёт в окне`)
    wired++
  }
  assert.ok(wired >= 15, `обёрток найдено всего ${wired} — проводка потеряна`)
  console.log(`   обёрток над модулями: ${wired}`)
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
