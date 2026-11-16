// Regression test suite for fixes in 1.0.5
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const mainSource = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
// Уведомление о потере ключа и архив настроек вынесены в модуль (А-3, 31.10).
const noticeSource = fs.readFileSync(path.join(root, 'src/main/profile-notice.cjs'), 'utf8')
// Код окна теперь разложен по модулям (план, 2d) — проверяем весь исполняемый текст.
const appSource = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))

let total = 0
let passed = 0
function check(label, condition, detail = '') {
  total++
  if (!condition) {
    console.error('FAIL: ' + label + (detail ? ' — ' + detail : ''))
    process.exit(1)
  }
  passed++
  console.log('  ok  ' + label)
}

console.log('=== 1. Workspace root deletion guard in delete_path ===')
{
  check('delete_path проверяет roots.includes(resolve(target))',
    mainSource.includes('const roots = workspaceRoots().map(r => resolve(r))') &&
    mainSource.includes('roots.includes(resolve(target))') &&
    mainSource.includes('Удаление корня рабочей папки запрещено.'))
}

console.log('=== 2. Think seam buffering across chunk boundaries ===')
{
  check('streamChatOpenRouter содержит thinkBuffer',
    mainSource.includes("let thinkBuffer = ''") &&
    mainSource.includes('let text = thinkBuffer + delta.content') &&
    mainSource.includes("thinkBuffer = ''"))

  check('streamChatOpenRouter проверяет частичные совпадения <think> и </think>',
    mainSource.includes("'<think>'.startsWith(tail)") &&
    mainSource.includes("'</think>'.startsWith(tail)"))

  check('streamChatOpenRouter сбрасывает thinkBuffer при завершении потока',
    mainSource.includes('if (thinkBuffer) {') &&
    mainSource.includes('fullReasoning += thinkBuffer'))
}

console.log('=== 3. Safe encrypted storage fallback preserving unreadable bytes ===')
{
  // Смысл проверки не менялся: сбой дешифрования обязан сохранить байты, а не
  // проглотить их молча. Изменился способ — прежний дубль внутри файла настроек
  // (`store.set(`${key}.corrupt.bak`, raw)`) портил данные: для electron-store имя
  // с точкой — вложенный путь, и копия оседала внутри конверта, а у строк и
  // массивов съедала живое значение. См. tests/run-settings-archive-ui.cjs.
  check('readSecure сохраняет нечитаемый конверт и не трогает живое значение',
    noticeSource.includes('archiveCorruptSettings(key, raw)') &&
    noticeSource.includes('function archiveCorruptSettings') &&
    !mainSource.includes('store.set(`${key}.corrupt.bak`, raw)') &&
    !noticeSource.includes('store.set(`${key}.corrupt.bak`, raw)'))
}

console.log('=== 4. Task pane signature stability & card expansion ===')
{
  // Панель «Задачи» по макету 20.10 (work-panel.js): смысл проверок прежний —
  // подпись без тикающего времени, часы хода обновляются отдельно, раскрытие плана помнится
  const panelSignature = (appSource.match(/const signature = JSON\.stringify\(\[tab,[^\n]*\n[^\n]*\n[^\n]*/) || [''])[0]
  check('подпись панели «Задачи» без тикающего времени, часы — отдельно',
    Boolean(panelSignature) && !/Date\.now\(\)/.test(panelSignature) &&
    appSource.includes("const tick = panel.querySelector('[data-tick]')") &&
    appSource.includes('tick.textContent = clockOf(runStartOf(tasks))'))

  check('раскрытый и свёрнутый план агента переживают перерисовку',
    panelSignature.includes('agentPlanOpen') && panelSignature.includes('agentPlanShut') &&
    appSource.includes('pane.agentPlanOpen.add(i)') && appSource.includes('pane.agentPlanShut.add(i)'))
}

console.log('=== 5. Design mode tasksFinishedDuration termination ===')
{
  check('runDesignAgent в блоке finally вычисляет tasksFinishedDuration',
    appSource.includes('taskPane.tasksFinishedDuration = Math.max(1, Math.round((Date.now() - earliest) / 1000))'))
}

console.log('=== 6. setupProjectsPage saveConversations after merge ===')
{
  check('setupProjectsPage сохраняет диалоги на диск после mergeConversations',
    appSource.includes('conversations = mergeConversations(local, conversations)') &&
    appSource.includes('await saveConversations()'))
}

console.log(`\nВсе ${passed} проверок регрессионного набора 1.0.5 успешно пройдены!`)
