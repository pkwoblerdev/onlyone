'use strict'
// Regression test for chat rendering bug:
// Ensures getUiLang is defined in app.js and messageBlocks / fileChangesBlockHtml
// can render assistant messages with tool calls, thinking blocks, and file changes.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

console.log('--- Проверка наличия getUiLang в src/renderer/app.js ---')
{
  const appJs = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8')
  assert.ok(appJs.includes('function getUiLang()'), 'app.js должен объявлять функцию getUiLang()')
  const start = appJs.indexOf('  function renderMessages(pane)')
  const loop = appJs.indexOf('    for (const [messageIndex, msg] of chat.messages.entries())', start)
  const end = appJs.indexOf('    // An answer in flight', loop)
  assert.ok(loop > start && end > loop)
  const appended = [], errors = []
  const pane = { dom: { list: { appendChild: node => appended.push(node) } } }
  const renderLoop = new Function('pane', 'chat', 'createMessageElement', 'decorateTurnFailure', 'console', appJs.slice(loop, end))
  renderLoop(pane, { messages: ['broken', 'valid'] }, (_, msg) => {
    if (msg === 'broken') throw new Error('fixture bad message')
    return { text: msg, dataset: {}, addEventListener() {} }
  }, () => {}, { error: (...args) => errors.push(args) })
  assert.equal(errors.length, 1)
  assert.deepEqual(appended.map(node => node.text), ['valid'], 'a broken message must not hide later messages')
  assert.equal(appended[0].dataset.forkMessageIndex, '1')
  console.log('  ok: getUiLang объявлен и цикл renderMessages защищён')
}

console.log('--- Проверка работы messageBlocks и рендера блоков ---')
{
  const MessageBlocks = require(path.join(ROOT, 'src/renderer/message-blocks.js'))
  let uiLang = 'ru'
  const mb = MessageBlocks.create({
    t: x => x,
    escapeHtml: s => String(s || ''),
    getUiLang: () => uiLang,
    countWord: (count, one, few, many) => `${count} ${one}`,
    renderMarkdownHtml: s => `<p>${s}</p>`,
    bindCopyButtons: () => {},
    formatDuration: () => '1 с',
    normalizePlanSteps: s => s,
    PLAN_STATUS: {},
    schedulePaint: () => {},
    agentTaskState: () => ({}),
    renderAgentTasks: () => {}
  })

  // Mock DOM host
  function createMockElement(tag) {
    return {
      tagName: tag.toUpperCase(),
      className: '',
      dataset: {},
      children: [],
      style: {},
      innerHTML: '',
      appendChild(child) { this.children.push(child); return child },
      insertBefore(child, before) { this.children.push(child); return child },
      querySelector() { return null },
      addEventListener() {},
      setAttribute(k, v) { this[k] = v }
    }
  }

  globalThis.document = {
    createElement: createMockElement
  }

  const host = createMockElement('div')
  const blocks = [
    { kind: 'thinking', text: 'Анализирую ошибки приложения XKing...' },
    { kind: 'tool', title: 'читаю package.json', tool: 'read_file', text: 'reading file' },
    { kind: 'tool', title: 'ищу ошибки в логах', tool: 'search_files', text: 'searching logs' },
    { kind: 'text', text: 'Вот результаты анализа ошибок XKing...' }
  ]

  // Test blocksHtmlInto
  assert.doesNotThrow(() => {
    mb.blocksHtmlInto(host, blocks)
  }, 'blocksHtmlInto не должен бросать исключений при рендере цепочки мыслей и инструментов')

  assert.ok(host.children.length > 0, 'host должен содержать отрендеренные узлы')
  console.log('  ok: цепочка мыслей и инструментов успешно отрендерена без ошибок')

  // Test in EN locale
  uiLang = 'en'
  const hostEn = createMockElement('div')
  assert.doesNotThrow(() => {
    mb.blocksHtmlInto(hostEn, blocks)
  }, 'blocksHtmlInto не должен бросать исключений в английской локали')
  console.log('  ok: рендер в английской локали успешен')
}

console.log('Все регрессионные проверки отрисовки чатов успешно пройдены!')
