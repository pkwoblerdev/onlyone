const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
// Код окна разложен по модулям (план, 2d): берём весь исполняемый текст.
const renderer = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr
const cut = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))
// Вырезанные ветки исполняют настоящие отправки хода: `sendToWindow` берётся из
// main.js, иначе песочница краснеет на имени, а не на поведении.
const GUARD = cut(main, 'function sendToWindow(event, channel, body) {', 'async function runAgentMode(')
async function run() {
  let skills = [{ id: 'one', name: 'Original', description: 'Keep', systemPrompt: 'Instructions', enabled: false, category: 'docs' }]
  let allowed = true, pending
  const handler = new Function('loadSkills', 'saveSkills', 'workspace', 'planModeRefusal', 'requestApproval',
    `return async function(event,name,args,requestId,design,signal){${GUARD}\n${cut(main, "    if (name === 'update_skill' || name === 'delete_skill')", "    if (name === 'toggle_skill')")} }`)(
    () => structuredClone(skills), value => { skills = value }, { permission: 'auto' }, () => ({ denied: true }),
    async (_, options) => { assert.equal(options.force, true); assert(options.summary); if (pending) pending(); return allowed })
  const event = { sender: { send() {} } }
  assert((await handler(event, 'update_skill', { id: 'one', name: 'Updated' }, 'r')).success)
  assert.equal(skills[0].description, 'Keep'); assert.equal(skills[0].enabled, false)
  allowed = false
  assert((await handler(event, 'delete_skill', { id: 'one' }, 'r')).denied)
  assert.equal(skills.length, 1)
  allowed = true; pending = () => { skills[0].description = 'Concurrent edit' }
  assert.equal((await handler(event, 'delete_skill', { id: 'one' }, 'r')).success, false)
  pending = null
  assert((await handler(event, 'delete_skill', { id: 'one' }, 'r')).success)
  assert.equal(skills.length, 0)
  assert.equal((await handler(event, 'delete_skill', { id: 'missing' }, 'r')).success, false)

  let chunkHandler, reasoningHandler
  const run = { requestId: 'design-test', placeholder: { content: '' }, design: { id: 'test' }, blocks: [], reasoningSegments: [],
    taskPane: { agentTasks: new Map() } }
  const activity = []
  const laneTasks = new Map()
  // Дорожки помощников — настоящие, из окна; вокруг них только то, что рисует панель.
  new Function('window', 'designRun', 'activeDesign', 'scheduleDesignPaint', 'noteAgentDoing',
    'agentTaskState', 'renderAgentTasks', 'thinkingHeadline', 't',
    cut(renderer, '  function isHelperChunk(', '  function blocksForStorage(') +
    cut(renderer, '  function reasoningSegmentsToText(', '  function reasoningInnerHtml(') +
    cut(renderer, '    window.electronAPI.onMessageChunk(chunk => {\n      if (designRun?', '    window.electronAPI.onAgentEvent(event => {'))(
    { electronAPI: {
      onMessageChunk(fn) { chunkHandler = fn },
      onMessageReasoningChunk(fn) { reasoningHandler = fn }
    } }, run, { id: 'test' }, () => {}, (_pane, event, what) => activity.push({requestId: event.requestId, what}),
    (_pane, index) => { if (!laneTasks.has(index)) laneTasks.set(index, { index, tools: 0 }); return laneTasks.get(index) },
    () => {}, text => String(text || '').slice(0, 20), text => text)
  chunkHandler({ requestId: 'other', choices: [{ delta: { content: 'wrong' } }] })
  chunkHandler({ requestId: 'design-test', choices: [{ delta: { content: 'Visible' } }] })
  chunkHandler({ requestId: 'design-test', text: ' progress' })
  assert.equal(run.placeholder.content, 'Visible progress')

  // Помощник пишет одновременно с ведущим. Его текст не должен попасть в ответ
  // дизайна: раньше он вклеивался в него посимвольно, и ответ читался обрывками.
  chunkHandler({ requestId: 'design-test', choices: [{ delta: { content: 'отчёт помощника' } }], agentIndex: 2, agentName: 'Агент 3' })
  assert.equal(run.placeholder.content, 'Visible progress')
  assert.equal(run.lanes.get(2).text, 'отчёт помощника')

  // Ход мысли доходит до экрана. Без этого долгое размышление выглядело как
  // зависшее приложение: статусные строки шли, а ответа не было — модель тратила
  // весь бюджет на рассуждение, и показать это было нечем.
  assert(reasoningHandler, 'подписка на поток размышлений не найдена')
  reasoningHandler({ requestId: 'other', text: 'чужое' })
  reasoningHandler({ requestId: 'design-test', text: 'Сначала ' })
  reasoningHandler({ requestId: 'design-test', text: 'разберу задачу' })
  assert.equal(run.placeholder.reasoning, 'Сначала разберу задачу')
  assert(activity.length === 4 && activity.every(item => item.requestId === 'design-test'))
  assert(activity.some(item => item.what === 'Пишет ответ'))
  assert(activity.some(item => item.what === 'Обрабатывает задачу'))
  assert.deepEqual(run.blocks.map(b => b.kind), ['text', 'thinking'])
  assert.equal(run.blocks[1].text, 'Сначала разберу задачу')

  // Обрыв соединения объясняется по-человечески, а написанное не затирается.
  const describe = new Function('cleanErrorText', 't',
    cut(renderer, '  function describeTurnFailure(err) {', '\n  function recordDesignActivity') +
    '\n  return describeTurnFailure')(
    value => String(value?.message ?? value ?? ''), x => x)
  assert.match(describe(new TypeError('terminated')), /оборвалось/)
  assert.match(describe(new Error('429 rate limit')), /ограничил/)
  assert.match(describe(new Error('maximum context length')), /не помещается/)
  assert.equal(describe(new Error('прочее')), 'прочее')
  assert(renderer.includes('written ? `${written}'), 'написанное до ошибки должно сохраняться')
  assert(renderer.includes('.filter(m => m.content && !m.activity)'))
  assert(renderer.includes('jumpToBottom(pane, 8, false)'))

  const { DesignStore } = require('../src/main/design/store')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-test-'))
  const store = new DesignStore(dir)
  await store.write('test', 'Coin', { template: '<div>Coin</div>' })
  await store.write('test', 'Landing', { template: '<main>Page</main>' })
  assert.equal(await store.getEntry('test'), 'Landing.dc.html')
  await store.setEntry('test', 'Coin')
  assert.equal(await store.getEntry('test'), 'Coin.dc.html')
  await assert.rejects(store.setEntry('test', 'Missing'))
  const runtimePath = path.join(dir, 'test', 'dc-runtime.js')
  const runtimeBytes = fs.readFileSync(runtimePath)
  const stamp = fs.statSync(runtimePath).mtimeMs
  await Promise.all(Array.from({ length: 12 }, () => store.ensure('test')))
  assert.equal(fs.statSync(runtimePath).mtimeMs, stamp, 'reopening must not rewrite the runtime')
  assert.deepEqual(fs.readFileSync(runtimePath), runtimeBytes)
  console.log('0.71 regressions: skill CRUD/denial/race, actual streamed chunks, activity isolation, chat opening, design entry passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
