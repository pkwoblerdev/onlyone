// Лишние инструменты не едут в каждом запросе: основа остаётся, редкие группы — по разговору.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const diet = require('../src/main/tool-diet.cjs')

let failed = 0
function check(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) }
}

// Настоящие схемы из main.js: считаем то, что реально уходит модели.
const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
const start = source.indexOf('const TOOL_DEFINITIONS = [')
let depth = 0
let end = -1
for (let i = source.indexOf('[', start); i < source.length; i++) {
  if (source[i] === '[') depth++
  else if (source[i] === ']') { depth--; if (depth === 0) { end = i; break } }
}
const FORK_PROPOSAL_TOOL = require('../src/main/fork-proposal-tool.cjs').TOOL_DEFINITION
const TOOLS = new Function('require', 'FORK_PROPOSAL_TOOL', 'return ' + source.slice(source.indexOf('[', start), end + 1))(require('node:module').createRequire(path.join(__dirname, '../src/main/main.js')), FORK_PROPOSAL_TOOL)
const names = list => list.map(tool => tool.function.name)
const size = list => JSON.stringify(list).length

check('в схемах есть все группы, которые прячет модуль (имена не разошлись)', () => {
  const have = new Set(names(TOOLS))
  for (const group of diet.GROUPS) for (const name of group.names) assert.ok(have.has(name), `${group.id}: нет инструмента ${name}`)
})

check('обычный разговор про код: редкие группы не уходят, основа на месте', () => {
  const slim = names(diet.slimTools(TOOLS, { texts: ['Разбери папку и найди, где считается итог'] }))
  for (const need of ['read_file', 'write_file', 'list_files', 'search_files', 'run_command', 'task_plan', 'ask_user', 'fetch_url', 'use_skill', 'list_skills']) {
    assert.ok(slim.includes(need), 'пропал ' + need)
  }
  for (const gone of ['video_render_html', 'video_render', 'design_task', 'define_tool', 'add_mcp_server', 'add_skill', 'browse_page', 'watch_page', 'show_artifact']) {
    assert.ok(!slim.includes(gone), 'не должен уходить: ' + gone)
  }
})

check('описания в запросе короче больше чем вдвое', () => {
  const full = size(TOOLS)
  const slim = size(diet.slimTools(TOOLS, { texts: ['Разбери папку'] }))
  console.log(`   было ${full} знаков (≈${Math.round(full / 3.2)} токенов), стало ${slim} (≈${Math.round(slim / 3.2)}) — на каждом шаге хода`)
  assert.ok(slim * 2 < full, `${slim} против ${full}`)
})

check('слово из разговора возвращает свою группу', () => {
  assert.ok(names(diet.slimTools(TOOLS, { texts: ['сделай ролик из этих кадров'] })).includes('video_render'))
  assert.ok(names(diet.slimTools(TOOLS, { texts: ['следи за страницей localhost:3000'] })).includes('watch_page'))
  assert.ok(names(diet.slimTools(TOOLS, { texts: ['открой мне youtube.com'] })).includes('browse_page'))
  assert.ok(names(diet.slimTools(TOOLS, { texts: ['открой сайт и покажи'] })).includes('browse_page'))
  assert.ok(names(diet.slimTools(TOOLS, { texts: ['добавь скилл для отчётов'] })).includes('add_skill'))
  assert.ok(names(diet.slimTools(TOOLS, { texts: ['нарисуй макет лендинга'] })).includes('design_task'))
  assert.ok(names(diet.slimTools(TOOLS, { texts: ['Fix the layout from the window run'] })).includes('design_task'))
  assert.ok(names(diet.slimTools(TOOLS, { texts: ['покажи график продаж'] })).includes('show_artifact'))
  assert.ok(names(diet.slimTools(TOOLS, { texts: ['подключи MCP сервер'] })).includes('add_mcp_server'))
})

check('группа, уже использованная в этом ходе, остаётся до конца хода', () => {
  const slim = names(diet.slimTools(TOOLS, { texts: ['продолжай'], used: new Set(['video_analyze']) }))
  assert.ok(slim.includes('video_render') && slim.includes('video_analyze'))
})

check('идущее слежение за страницей оставляет инструменты браузера', () => {
  const slim = names(diet.slimTools(TOOLS, { texts: ['ок'], keep: new Set(['stop_watching']) }))
  assert.ok(slim.includes('stop_watching') && slim.includes('watch_page'))
})

check('выключатель возвращает полный список', () => {
  assert.equal(diet.slimTools(TOOLS, { texts: ['код'], enabled: false }).length, TOOLS.length)
})

check('тексты берутся из последних сообщений человека (строкой и частями)', () => {
  const texts = diet.userTexts([
    { role: 'user', content: 'раз' }, { role: 'assistant', content: 'ответ' },
    { role: 'user', content: [{ type: 'text', text: 'два видео' }, { type: 'image_url', image_url: { url: 'x' } }] },
    { role: 'user', content: 'три' }, { role: 'user', content: 'четыре' }
  ])
  assert.deepEqual(texts, ['два видео', 'три', 'четыре'])
})

check('проводка: main.js подменяет список инструментов в начале и при пересборке', () => {
  assert.match(source, /require\('\.\/tool-diet\.cjs'\)/)
  assert.ok(source.includes('const slimToolsFor = '), 'нет определения')
  const uses = source.match(/slimToolsFor\(/g) || []
  assert.ok(uses.length >= 2, 'ожидалось два вызова (начало хода и пересборка), найдено ' + uses.length)
})

if (failed) process.exit(1)
console.log('\nИнструменты по разговору: проверки пройдены')
