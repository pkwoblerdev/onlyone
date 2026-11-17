// Some models send the same reasoning down both channels — once as reasoning,
// once as content. Drawn as-is, the answer becomes a second copy of the thought,
// which is what the screenshot showed. This pins the behaviour down.
const fs = require('fs')
const path = require('path')

// Блоки ленты рисует отдельный модуль (план, 2d), `syncTextBlock` остался в
// окне: берём весь код окна одним текстом, чтобы тела были настоящими.
const src = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
const messageBlocks = require('../src/renderer/message-blocks.js').create({})

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return src.slice(a, b)
}

const syncTextBlock = new Function(
  cut('  function syncTextBlock(pane) {', '  function renderLiveContent(pane) {') +
  cut('  function pushBlock(pane, kind, text', '  function blockElement(block, isLive) {') +
  '\nreturn syncTextBlock'
)()

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const textOf = pane => pane.blocks.filter(b => b.kind === 'text').map(b => b.text).join('')
const paneWith = (thought, content) => ({
  blocks: thought ? [{ kind: 'thinking', agent: '', text: thought }] : [],
  contentBuffer: content
})

const THOUGHT = 'The user wants me to add to the previous analysis but without creating separate chats. Let me think about what is missing.'

// An ordinary answer is drawn whole.
const plain = paneWith('', 'Вот ответ.')
syncTextBlock(plain)
check('обычный ответ рисуется', textOf(plain) === 'Вот ответ.', textOf(plain))

// Content that is only repeating the thought is not an answer.
const echoing = paneWith(THOUGHT, THOUGHT.slice(0, 80))
syncTextBlock(echoing)
check('эхо не рисуется', textOf(echoing) === '', textOf(echoing))

// The echo completes and the real answer starts: only the answer survives.
const after = paneWith(THOUGHT, THOUGHT)
syncTextBlock(after)
after.contentBuffer = THOUGHT + ' Итого: три направления роста.'
syncTextBlock(after)
check('после эха остаётся только ответ',
  textOf(after) === ' Итого: три направления роста.', JSON.stringify(textOf(after)))

// A short thought is not enough evidence of an echo — the answer stays intact.
const short = paneWith('Ага', 'Ага, это так.')
syncTextBlock(short)
check('короткая мысль не съедает ответ', textOf(short) === 'Ага, это так.', textOf(short))

// Chunk by chunk, an answer that merely happens to open like the thought is
// still drawn once and only once.
const streamed = paneWith(THOUGHT, '')
for (const piece of ['Сна', 'чала ', 'разберём ', 'воронку.']) {
  streamed.contentBuffer += piece
  syncTextBlock(streamed)
}
check('поток без эха собирается ровно один раз',
  textOf(streamed) === 'Сначала разберём воронку.', textOf(streamed))

// The whole thought echoed and nothing else: still nothing to show.
const only = paneWith(THOUGHT, THOUGHT)
syncTextBlock(only)
check('чистое эхо не оставляет пустого ответа', textOf(only) === '', textOf(only))

// Use the real module API: blocksForStorage now shares the tool-argument
// redactor with rendering, so evaluating this function in isolation would
// omit the helper and test a different implementation.
const blocksForStorage = messageBlocks.blocksForStorage
const savedText = (blocks, answer) => blocksForStorage({ blocks }, answer).filter(b => b.kind === 'text').map(b => b.text).join('')
check('конец ответа не теряется при сохранении', savedText([{ kind: 'text', text: 'Начало.' }], 'Начало. Конец.') === 'Начало. Конец.')
check('сохранённый ответ не дублируется', savedText([{ kind: 'text', text: 'Готово.' }], 'Готово.') === 'Готово.')
check('ответ после инструментов сохраняется', savedText([{ kind: 'tool', text: 'dc_write' }], 'Готово.') === 'Готово.')

// Tool details are useful context, but raw arguments can contain credentials.
// Exercise both the summary and the expandable/persisted payload, including
// legacy rows that were saved before display redaction existed.
const secret = 'ONLYONE_TEST_SECRET_7f82c3a915'
const rawArgs = JSON.stringify({
  path: 'src/renderer/app.js',
  url: `https://example.test/data?api_key=${secret}`,
  headers: { Authorization: `Bearer ${secret}` },
  api_key: secret,
  note: 'Мой токен можно проверить вручную'
}, null, 2)
const serializedTool = JSON.stringify(messageBlocks.toolParts({ tool: 'fetch_url', detail: `https://example.test/data?api_key=${secret}` }))
check('сводка действия маскирует секретный query-параметр', !serializedTool.includes(secret), serializedTool)
check('обычная фраза про ключ остаётся читаемой',
  messageBlocks.toolHeadline({ tool: 'read_file', detail: 'Мой токен можно проверить вручную' }) === 'Прочитал Мой токен можно проверить вручную')
check('путь к обычному файлу секретов не скрывается',
  messageBlocks.toolHeadline({ tool: 'read_file', detail: 'src/secrets.js' }) === 'Прочитал src/secrets.js')
check('помеченный секрет скрывается даже без исходного имени поля',
  !messageBlocks.toolHeadline({ tool: 'read_file', detail: secret }).includes(secret))

const newPane = { blocks: [] }
messageBlocks.pushBlock(newPane, 'tool', rawArgs, '', 'Проверка', messageBlocks.toolParts({
  tool: 'fetch_url', detail: `https://example.test/data?api_key=${secret}`
}))
check('новый блок инструмента очищен до помещения в ленту', !JSON.stringify(newPane.blocks).includes(secret))
check('группировка не возвращает секрет в подстроках',
  (messageBlocks.pushBlock(newPane, 'tool', rawArgs, '', 'Проверка', messageBlocks.toolParts({
    tool: 'fetch_url', detail: `https://example.test/again?api_key=${secret}`
  })), !JSON.stringify(newPane.blocks).includes(secret)))
check('сохранение вычищает старый сырой блок инструмента',
  !JSON.stringify(messageBlocks.blocksForStorage({ blocks: [{ kind: 'tool', text: rawArgs, title: rawArgs,
    parts: { verb: 'Вызов', target: secret, detail: secret, tool: 'fetch_url' },
    items: [{ detail: secret }] }] }, '')).includes(secret))

const priorDocument = global.document
const paintedNodes = []
function fakeNode(tag) {
  const childNodes = new Map()
  const node = {
    tagName: tag, children: [], className: '', textContent: '', open: false,
    classList: { add() {} },
    querySelector(selector) {
      if (!childNodes.has(selector)) childNodes.set(selector, fakeNode(selector))
      return childNodes.get(selector)
    },
    appendChild(child) { this.children.push(child); return child },
    after() {}
  }
  paintedNodes.push(node)
  return node
}
global.document = { createElement: fakeNode }
try {
  messageBlocks.blockElement({ kind: 'tool', text: rawArgs, title: rawArgs,
    parts: { verb: 'Вызов', target: secret, detail: secret, tone: 'read' } }, false)
  check('ранее сохранённый сырой блок не показывает секрет при отрисовке',
    !paintedNodes.some(node => String(node.textContent).includes(secret)))
} finally {
  if (priorDocument === undefined) delete global.document
  else global.document = priorDocument
}

console.log(JSON.stringify({ ok: failed === 0, failed }))
if (!failed) require('./test-rework-regressions.cjs')
process.exitCode = failed ? 1 : 0
