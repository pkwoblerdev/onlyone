'use strict'
// Очередь фоновых задач в экране Центра задач (план, 3.4): карточка из
// `task-list` становится той же строкой, что ходы чатов, и получает действия.
//
// ТЕСТЫ ДО КОДА: экран умеет показывать только ходы чатов и Дизайна,
// про очередь он не знает — набор обязан быть красным и говорить почему.
//
// Проверяется и то, чего делать нельзя: карточки чатов не должны сдвинуться ни
// на байт (их разметку ведут другие), командная строка задачи не должна
// показываться, а чужой текст — становиться разметкой. DOM подставной, как в
// `tests/test-task-center-screen.cjs`; сети, Electron и живых часов нет.
const assert = require('node:assert/strict')
const { create, queueTaskItem, collectTaskItems, taskCardHtml } = require('../src/renderer/task-center')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let total = 0
let failed = 0
async function check(name, fn) {
  total++
  try {
    await fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 300)}`)
  }
}
const worlds = []

function makeNode(id, extra = {}) {
  return {
    id, dataset: { ...(extra.dataset || {}) }, attrs: {}, listeners: {},
    textContent: '', innerHTML: '', hidden: false,
    offsetParent: extra.closed ? null : {},
    setAttribute(key, value) { this.attrs[key] = String(value) },
    getAttribute(key) { return this.attrs[key] ?? null },
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn) },
    contains() { return true }
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function makeWorld({ tasks = async () => [], action = async () => ({ ok: true }), closed = false } = {}) {
  const world = { opened: [], actions: [] }
  const section = makeNode('taskCenterView')
  const list = makeNode('taskCenterList', { closed })
  const search = makeNode('taskCenterSearch')
  const count = makeNode('taskCenterCount')
  const filters = ['all', 'active', 'problems', 'complete'].map(status =>
    makeNode(`filter-${status}`, { dataset: { taskFilter: status } }))
  const ids = new Map([[section.id, section], [list.id, list], [search.id, search], [count.id, count]])
  world.view = create({
    document: { getElementById: id => ids.get(id) || null, querySelectorAll: () => filters },
    t: value => value,
    escapeHtml,
    readInterrupted: async () => [],
    readTasks: async () => (typeof tasks === 'function' ? await tasks() : tasks),
    runTaskAction: async (name, id) => { world.actions.push([name, id]); return action(name, id) },
    getChats: () => [], getDesigns: () => [], getPanes: () => [], getDesignPanes: () => new Map(),
    openTask: item => world.opened.push(item),
    setBadge: () => {}
  })
  worlds.push(world.view)
  return Object.assign(world, { section, list, count, filters })
}

// Карточка планировщика ровно в той форме, в какой её отдаёт `task-list`:
// `can*` приходят с карточкой, экран их не пересчитывает.
const CAN = {
  queued: { canPause: true, canResume: false, canCancel: true, canRestart: false },
  running: { canPause: true, canResume: false, canCancel: true, canRestart: false },
  paused: { canPause: false, canResume: true, canCancel: true, canRestart: true },
  error: { canPause: false, canResume: false, canCancel: false, canRestart: true },
  done: { canPause: false, canResume: false, canCancel: false, canRestart: true },
  interrupted: { canPause: false, canResume: true, canCancel: true, canRestart: true }
}
const card = (over = {}) => {
  const state = over.state || 'running'
  return {
    id: 'q1', title: 'Собрать отчёт', kind: 'shell', priority: 'normal', state,
    progress: null, startedAt: 1000, finishedAt: null, error: '', attempts: 1, log: [],
    ...CAN[state], ...over
  }
}

function click(node, target) {
  for (const fn of node.listeners.click || []) fn({ target })
}

async function main() {
  await check('экран знает, как назвать карточку очереди', () => {
    assert.equal(typeof queueTaskItem, 'function',
      'task-center.js не экспортирует queueTaskItem — карточку очереди строить нечем')
    const item = queueTaskItem(card())
    assert.equal(item.source, 'queue', 'у карточки очереди нет признака источника')
    assert.equal(item.status, 'running', `исполняемая задача показана как ${item.status}`)
    assert.equal(item.cardId, 'q1', 'потерян id планировщика — действию не к чему привязаться')
    assert.equal(item.id, 'queue:q1', `id карточки ${item.id}: чужие id не должны сливаться с чатом`)
    assert.equal(item.surface, 'queue', 'очередь притворяется чатом или дизайном')
  })

  await check('каждое состояние планировщика имеет своё слово на экране', () => {
    const seen = { queued: 'waiting', running: 'running', paused: 'waiting', error: 'problem', done: 'complete', interrupted: 'interrupted' }
    for (const [state, status] of Object.entries(seen)) {
      const item = queueTaskItem(card({ state }))
      assert.equal(item.status, status, `состояние ${state} показано как ${item.status}, а экран такого не поймёт`)
      assert.match(taskCardHtml(item, 0, escapeHtml, t => t), /task-center-item/, `карточка ${state} не собралась`)
    }
  })

  await check('задачи очереди встают в общий список рядом с остальными', async () => {
    const items = collectTaskItems({ conversations: [], designs: [], panes: [], interruptedRuns: [], queueTasks: [card(), card({ id: 'q2', state: 'done' })] })
    const queue = items.filter(one => one.source === 'queue')
    assert.equal(queue.length, 2, `в общем списке ${queue.length} карточек очереди из двух`)
    assert.ok(items.every(one => one.updatedAt !== undefined), 'у карточек нет времени сортировки')
  })

  await check('карточка очереди показывает действия, которые планировщик не отвергает', () => {
    const html = taskCardHtml(queueTaskItem(card({ progress: 0.4 })), 0, escapeHtml, t => t)
    assert.match(html, /data-task-action="pause"/, 'нет паузы у исполняемой задачи')
    assert.match(html, /data-task-action="cancel"/, 'нет отмены у исполняемой задачи')
    assert.equal(/data-task-action="resume"/.test(html), false, 'возобновить предлагается там, где возобновлять нечего')
    assert.equal(/data-task-action="restart"/.test(html), false, 'перезапуск предлагается на живой задаче')
    assert.match(html, /role="progressbar"/, 'доля работы не показана: человек не видит, живой ли процесс')
    assert.match(html, /40%/, `полоса прогресса не отражает 0.4: ${html.slice(0, 200)}`)
    const quiet = taskCardHtml(queueTaskItem(card({ progress: null })), 0, escapeHtml, t => t)
    assert.equal(/role="progressbar"/.test(quiet), false, 'прогресс нарисован там, где его нет: экран выдумает процент')
  })

  await check('завершённую карточку очередь предлагает перезапустить, а не снять с паузы', () => {
    const html = taskCardHtml(queueTaskItem(card({ state: 'error', error: 'процесс завершился с кодом 3' })), 0, escapeHtml, t => t)
    assert.match(html, /data-task-action="restart"/, 'упавшую задачу нельзя перезапустить кнопкой')
    assert.match(html, /кодом 3/, 'причина отказа не видна на карточке')
  })

  await check('карточка чата не получила действий очереди', () => {
    const item = { id: 'chat:1', title: 'Ход чата', status: 'complete', updatedAt: 1, surface: 'chat', agents: [] }
    const html = taskCardHtml(item, 0, escapeHtml, t => t)
    assert.equal(/task-center-actions/.test(html), false, 'у обычной карточки появились кнопки очереди')
  })

  await check('чужой текст карточки не становится разметкой', () => {
    const evil = queueTaskItem(card({ title: '<img src=x onerror=alert(1)>' }))
    const html = taskCardHtml(evil, 0, escapeHtml, t => t)
    assert.equal(/<img src=x/.test(html), false, `заголовок прошёл без зачистки: ${html.slice(0, 200)}`)
  })

  await check('нажатие на действие уходит планировщику с id задачи', async () => {
    const w = makeWorld({ tasks: [card()] })
    w.view.ensure()
    await w.view.refresh()
    assert.match(w.list.innerHTML, /Собрать отчёт/, 'карточка очереди не отрисована в разделе')
    const button = { closest: selector => (selector === '[data-task-action]' ? { dataset: { taskAction: 'pause', taskCard: 'q1' } } : null) }
    click(w.list, button)
    await wait(30)
    assert.deepEqual(w.actions.map(one => one[0]), ['pause'], `экран послал ${JSON.stringify(w.actions)}`)
    assert.equal(w.actions[0][1], 'q1', 'действие ушло без id задачи планировщика')
  })

  await check('карточка очереди не открывается как чат', async () => {
    const w = makeWorld({ tasks: [card()] })
    w.view.ensure()
    await w.view.refresh()
    const cardButton = { closest: selector => (selector === '[data-task-action]' ? null : { dataset: { taskIndex: '0' } }) }
    click(w.list, cardButton)
    await wait(20)
    assert.deepEqual(w.opened.filter(one => one && one.source === 'queue'), [],
      'кнопка карточки очереди повела экран открывать несуществующий чат')
  })

  await check('сбой очереди не обрывает остальные карточки и говорит словами', async () => {
    const w = makeWorld({ tasks: async () => { throw new Error('нет доступа к списку задач') } })
    w.view.ensure()
    await w.view.refresh()
    assert.doesNotThrow(() => w.view.refresh(), 'сбой чтения очереди роняет раздел')
    await wait(20)
    assert.match(String(w.count.textContent) + w.list.innerHTML, /не прочитал|очеред|ошиб/i,
      `отказ очереди проигнорирован молча: ${w.count.textContent}`)
  })

  await check('событие очереди перечитывает список, а не перерисовывает прежние карточки', async () => {
    const w = makeWorld({ tasks: async () => [] })
    assert.equal(typeof w.view.queueChanged, 'function',
      'у раздела нет ответа на событие очереди: экран нечем известить, что состояние изменилось')
    // Тело события несёт только изменившиеся карточки (троттл главного
    // процесса), поэтому экран обязан перечитать список, а не латать его.
    let reads = 0
    const live = makeWorld({ tasks: async () => { const state = reads++ ? 'done' : 'running'; return [card({ state })] } })
    live.view.ensure()
    await live.view.refresh()
    assert.equal(reads, 1, `первое чтение списка дало ${reads} обращений к планировщику`)
    assert.match(live.list.innerHTML, /В работе/, 'исполняемая карточка не отрисована')
    live.view.queueChanged()
    live.view.queueChanged()
    live.view.queueChanged()
    await wait(900)
    assert.equal(reads, 2, `на три события пришлось ${reads - 1} перечиток: события либо не сливаются, либо их нет`)
    assert.match(live.list.innerHTML, /Завершено/,
      'карточка осталась «в работе» после события: экран показывает прежний снимок')
  })

  await check('закрытый раздел на событие очереди тоже перечитывает — метка обязана быть правдой', async () => {
    let reads = 0
    const w = makeWorld({ closed: true, tasks: async () => { reads++; return [card({ state: reads > 1 ? 'done' : 'running' })] } })
    w.view.ensure()
    await w.view.refresh()
    w.view.queueChanged()
    await wait(900)
    assert.equal(reads, 2, `закрытый раздел пропустил событие очереди: обращений ${reads}`)
  })

  for (const view of worlds) { try { view.stop && view.stop() } catch { /* часы раздела */ } }
  console.log(`Проверок: ${total}, отказов: ${failed}`)
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => {
  console.error('ПРОВАЛ [набор]:', error && error.message)
  process.exitCode = 1
})
