'use strict'

const assert = require('node:assert/strict')
const { collectTaskItems, filterTaskItems, taskCardHtml, renderTaskItems, bindTaskItems } = require('../src/renderer/task-center')

const conversations = [{
  id: 'chat-1', title: 'Рефакторинг', messages: [
    { role: 'user', content: 'Проверь сборку' },
    { role: 'assistant', timestamp: 20, agentRun: { at: 20, seconds: 8, ask: 'Проверь сборку', agents: [
      { name: 'Агент 1', title: 'Проверка', outcome: 'done' },
      { name: 'Агент 2', title: 'Тесты', outcome: 'failed' }
    ] } }
  ]
}]
const designs = [{ id: 'design-1', name: 'Лендинг', messages: [
  { role: 'user', content: 'Собери макет' },
  { role: 'assistant', timestamp: 30, agentRun: { at: 30, agents: [{ name: 'Дизайн', outcome: 'done' }] } }
]}]
const panes = [{ chatId: 'chat-2', generating: true, currentAsk: 'Исправь тесты', agentTasks: new Map([
  [0, { name: 'Агент 1', what: 'Читает лог', model: 'Model A' }]
]) }]
const designTaskPanes = new Map([['design-2', { generating: true, ask: 'Обнови макет', agentTasks: new Map() }]])
const interruptedRuns = [{ runId: 'run-1', chatId: 'chat-3', ask: 'Продолжи миграцию', updatedAt: 40 }]

const items = collectTaskItems({ conversations, designs, panes, designTaskPanes, interruptedRuns })
assert.equal(items.length, 5)
assert.deepEqual(items.map(item => item.id), [
  'interrupted:run-1', 'history:design:design-1:30', 'history:chat:chat-1:20',
  'live:chat:chat-2', 'live:design:design-2'
])
assert.equal(items.find(item => item.id === 'history:chat:chat-1:20').status, 'problem')
assert.equal(items.find(item => item.id === 'history:design:design-1:30').title, 'Собери макет')
assert.equal(items.find(item => item.id === 'live:chat:chat-2').status, 'running')
assert.equal(items.find(item => item.id === 'live:chat:chat-2').title, 'Исправь тесты')
assert.equal(items.find(item => item.id === 'interrupted:run-1').status, 'interrupted')
assert.equal(filterTaskItems(items, { status: 'active' }).length, 3)
assert.equal(filterTaskItems(items, { status: 'problems' }).length, 2)
assert.equal(filterTaskItems(items, { query: 'лендинг' }).length, 1)
assert.match(taskCardHtml({ title: '<img src=x>', status: 'complete', surface: 'chat', agents: [] }, 0,
  value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')), /&lt;img src=x&gt;/)
// Имя кнопки — её текст (`aria-label` перекрывал бы состояние), а чужая строка
// не должна открывать ни тег, ни атрибут.
const nasty = taskCardHtml({ title: '<script>', status: 'bad" onclick="x', surface: 'chat', agents: [] }, 0)
assert.match(nasty, /class="task-center-item status-unknown" data-task-index="0">/)
assert.match(nasty, /&lt;script&gt;/, 'заголовок должен остаться видимым текстом')
assert.doesNotMatch(nasty, /<script|onclick=/, 'в карточку попала исполняемая разметка')
const container = { innerHTML: '', handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn }, contains: () => true }
assert.deepEqual(renderTaskItems(container, items, { query: '', status: 'all', escapeHtml: String }), items)
assert.match(container.innerHTML, /data-task-index="0"/)
let opened = null
assert.equal(bindTaskItems(container, item => { opened = item }), true)
container.handlers.click({ target: { closest: () => ({ dataset: { taskIndex: '0' } }) } })
assert.equal(opened, items[0])
assert.equal(bindTaskItems(container, () => {}), false)
assert.equal(collectTaskItems({ conversations: [{ id: 'plain', messages: [
  { role: 'user', content: 'Обычный вопрос' }, { role: 'assistant', content: 'Обычный ответ' }
]}] }).length, 0)

console.log('Task center index: chat, Design, live and interrupted records passed')
