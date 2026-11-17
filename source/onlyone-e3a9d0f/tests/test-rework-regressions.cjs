const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { McpManager } = require('../src/main/mcp-manager')
// Кольцо контекста живёт в окне, блоки ленты — своим модулем (план, 2d):
// берём весь код окна одним текстом.
const source = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
function extract(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a)
  assert(a >= 0 && b > a)
  return source.slice(a, b)
}

const contextUsed = new Function('chatOf', 'estimateTokens',
  extract('  function contextUsed(pane)', '  function renderContextRing(') + ';return contextUsed'
)(p => p.chat, s => String(s || '').length)
const pane = { dom: { textarea: { value: 'abc' } }, chat: { messages: [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'world', tokens: 900000, reasoning: 'not sent' }
] } }
assert.equal(contextUsed(pane), 13, 'cumulative tool-loop usage must not fill the context ring')
pane.chat.messages[1].contextTokens = 40
assert.equal(contextUsed(pane), 43)

function element(block) {
  return { snapshot: JSON.stringify(block), open: false, classList: { toggle() {} } }
}
const holder = { children: [], appendChild(node) { this.children.push(node) },
  replaceChild(node, old) { this.children[this.children.indexOf(old)] = node },
  replaceChildren() { this.children = [] },
  insertBefore(node) { this.children.push(node) },
  querySelector: () => null }
// Живая лента рисует мысли (U-4), а для этого создаёт узлы через `document` и
// раскладывает блоки по слотам. Харнесс режет модуль по кускам, поэтому новые
// помощники он берёт из ТОГО ЖЕ исходника, а не пишет здесь свои: иначе через
// месяц проверка мерила бы не тот код, который в окне. Порог сворачивания —
// тот же, что в ленте, мысль из одного шага не сворачивается.
const documentStub = {
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(), className: '', innerHTML: '', open: false,
      children: [], dataset: {}, classList: { toggle() {} },
      appendChild(node) { this.children.push(node); return node },
      insertBefore(node) { this.children.push(node); return node },
      querySelector() { return null },
      addEventListener() {}
    }
  }
}
const liveModule = new Function('blockElement', 'document', 't', 'countWord', 'escapeHtml',
  extract('  const STEP_RUN_COLLAPSE = 3', '  function updateLiveAssistantUI(') +
  extract('  function paintBlocks(pane)', '  const STEP_RUN_COLLAPSE = 3') +
  '; return { paintBlocks }'
)(element, documentStub, x => String(x == null ? '' : x),
  (n, one, few, many) => `${n} ${one}`, x => String(x == null ? '' : x))
const paintBlocks = liveModule.paintBlocks
const live = { assistantEl: { querySelector: () => holder }, generating: true,
  blocks: [{ kind: 'plan', text: 'read', parts: { meta: '' }, items: ['a'] }], paintedBlocks: [] }
paintBlocks(live)
holder.children[0].open = true
live.blocks[0].items.push('b')
paintBlocks(live)
assert.equal(JSON.parse(holder.children[0].snapshot).items.length, 2, 'group changes must repaint without a text-length change')
assert.equal(holder.children[0].open, true, 'expanded tool remains expanded')
live.blocks[0].text = 'finished'
paintBlocks(live)
assert.equal(JSON.parse(holder.children[0].snapshot).text, 'finished', 'tool structure survives update')

const mcp = new McpManager()
for (const id of ['abcdefghij-server-a', 'abcdefghij-server-b']) {
  mcp.sessions.set(id, { status: 'connected', tools: [
    { name: 'file.read' }, { name: 'file_read' },
    { name: 'x'.repeat(60) + 'a' }, { name: 'x'.repeat(60) + 'b' }
  ] })
}
mcp.rebuildToolMap()
assert.equal(mcp.toolMap.size, 8, 'normalised and truncated MCP names must not overwrite each other')
const before = [...mcp.toolMap.keys()]
mcp.rebuildToolMap()
assert.deepEqual([...mcp.toolMap.keys()], before)
assert(before.every(name => /^[a-zA-Z0-9_-]{1,64}$/.test(name)))
console.log('Rework regressions: context estimate, grouped tool repaint, MCP name collisions passed')

const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const start = mainSource.indexOf("ipcMain.handle('abort-message'")
const end = mainSource.indexOf('\n// Under the smoke test', start)
assert(start >= 0 && end > start)
let abortHandler
const controllers = new Map(), approvals = new Map(), questions = new Map()
let aborted = false, declined = false, unrelatedDeclined = false
let questionDropped = false, unrelatedQuestionDropped = false
controllers.set('one', { abort() { aborted = true } })
approvals.set('a', { requestId: 'one', resolve(value) { declined = value === false } })
approvals.set('b', { requestId: 'two', resolve() { unrelatedDeclined = true } })
// Отменённый ход оставлял в ленте карточку вопроса, которая уже никого не
// ждала: нажатие по ней получало «вопрос больше не активен», и выглядело это
// как сломанный интерфейс, а не как отменённая работа.
questions.set('q1', { requestId: 'one', resolve() { questionDropped = true } })
questions.set('q2', { requestId: 'two', resolve() { unrelatedQuestionDropped = true } })
new Function('ipcMain', 'activeAbortControllers', 'pendingApprovals', 'pendingQuestions',
  mainSource.slice(start, end))(
  { handle(channel, handler) { abortHandler = handler } }, controllers, approvals, questions
)
abortHandler({}, 'one').then(result => {
  assert.equal(result.aborted, true)
  assert(aborted && declined)
  assert(!unrelatedDeclined && approvals.has('b') && !approvals.has('a'))
  assert(questionDropped && !questions.has('q1'))
  assert(!unrelatedQuestionDropped && questions.has('q2'))
  console.log('Approval and question cancellation is isolated to its request')
}).catch(error => { console.error(error); process.exitCode = 1 })
