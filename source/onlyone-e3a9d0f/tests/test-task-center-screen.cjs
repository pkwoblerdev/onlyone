// Экран центра задач (план, 3.4) на подставном DOM.
//
// Индекс проверяет `test-task-center.cjs` — там данные. Здесь проверяется то,
// без чего индекс остаётся списком в модуле: состояния «читаю»/«пусто»/«не
// прочиталось», счётчик и метка раздела, фильтры и поиск, переход из карточки
// и то, что чужой текст не становится разметкой.
const assert = require('node:assert/strict')
const { create } = require('../src/renderer/task-center')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let total = 0
let failed = 0

function check(name, fn) {
  total++
  return Promise.resolve().then(fn).then(
    () => console.log('  ok  ' + name),
    error => { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
  )
}

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

// Раздел держит часы: пока они идут, Node не выходит. Прогон гасит их все.
const worlds = []

// Раздел так, как его видит экран: секция, поле поиска, четыре кнопки фильтра,
// список, строка счёта. Данные — свои, чтобы каждая проверка начинала с чистого.
function makeWorld({ closed = false, countless = false, interrupted = async () => [] } = {}) {
  const world = { chats: [], designs: [], panes: [], badges: [] }
  const section = makeNode('taskCenterView')
  const list = makeNode('taskCenterList', { closed })
  const search = makeNode('taskCenterSearch')
  const count = makeNode('taskCenterCount')
  const filters = ['all', 'active', 'problems', 'complete'].map(status =>
    makeNode(`filter-${status}`, { dataset: { taskFilter: status } }))
  const ids = new Map([[section.id, section], [list.id, list], [search.id, search], [count.id, count]])
  if (countless) ids.delete('taskCenterCount')
  world.view = create({
    document: { getElementById: id => ids.get(id) || null, querySelectorAll: () => filters },
    t: value => value,
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g,
      char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
    readInterrupted: interrupted,
    getChats: () => world.chats, getDesigns: () => world.designs, getPanes: () => world.panes,
    getDesignPanes: () => new Map(),
    openTask: item => world.badges.push(item),
    setBadge: n => world.badges.push(`badge:${n}`)
  })
  worlds.push(world.view)
  return Object.assign(world, { section, list, search, count, filters })
}

// Готовый ход чата: та форма, в которой история лежит на диске.
function chatRun(id, ask, outcome = 'done', at = 10) {
  return { id, title: 'Сборка', messages: [
    { role: 'user', content: ask },
    { role: 'assistant', timestamp: at, agentRun: { at, ask, agents: [{ name: 'Агент 1', outcome }] } }
  ] }
}

async function main() {
  await check('первая отрисовка говорит «читаю», а не «пусто»', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const w = makeWorld({ interrupted: () => gate })
    w.chats = [chatRun('c1', 'Собери проект')]
    w.view.ensure()
    const running = w.view.refresh()
    assert.match(w.list.innerHTML, /task-center-loading/, 'нет заготовки списка')
    assert.equal(w.count.textContent, 'Читаю задачи…')
    release([])
    await running
    assert.doesNotMatch(w.list.innerHTML, /task-center-loading/, 'заготовка осталась после ответа')
  })

  await check('завершённый ход чата виден с состоянием и счётом', async () => {
    const w = makeWorld()
    w.chats = [chatRun('c1', 'Собери проект')]
    w.view.ensure()
    await w.view.refresh()
    assert.match(w.list.innerHTML, /task-center-item/, 'карточек нет')
    assert.match(w.list.innerHTML, /Собери проект/, 'нет текста просьбы')
    assert.match(w.list.innerHTML, /Завершено/, 'нет подписи состояния')
    assert.match(w.count.textContent, /Активных 0 · Всего 1/, `счётчик: ${w.count.textContent}`)
  })

  await check('фильтр по нажатию меняет список и кнопки', async () => {
    const w = makeWorld()
    w.chats = [chatRun('c1', 'Собери проект', 'failed', 10), chatRun('c2', 'Прочитай лог', 'done', 20)]
    w.view.ensure()
    await w.view.refresh()
    assert.equal(w.filters[0].getAttribute('aria-pressed'), 'true')
    w.section.listeners.click[0]({ target: { closest: () => w.filters[2] } })
    assert.equal(w.filters[2].getAttribute('aria-pressed'), 'true')
    assert.equal(w.filters[0].getAttribute('aria-pressed'), 'false')
    assert.match(w.list.innerHTML, /Есть проблема/, 'ход с проблемой не показан')
    assert.doesNotMatch(w.list.innerHTML, /Прочитай лог/, 'в фильтр попал завершённый ход')
    // Список сужен — и счёт говорит об этом: «Показано 1» при двух ходах.
    assert.match(w.count.textContent, /Показано 1 · Активных 0 · Всего 2/, `счётчик: ${w.count.textContent}`)
  })

  await check('поиск идёт по тексту просьбы, а мимо — особое состояние', async () => {
    const w = makeWorld()
    w.chats = [chatRun('c1', 'Собери проект')]
    w.view.ensure()
    await w.view.refresh()
    assert.equal(w.view.setQuery('макет'), 0, 'найдено то, чего нет')
    assert.match(w.list.innerHTML, /Ничего не найдено/, 'нет состояния «не найдено»')
    assert.equal(w.view.setQuery('проект'), 1, 'поиск по тексту просьбы не сработал')
  })

  await check('поле поиска передаёт запрос в список', async () => {
    const w = makeWorld()
    w.chats = [chatRun('c1', 'Собери проект')]
    w.view.ensure()
    await w.view.refresh()
    w.search.value = 'проект'
    w.section.listeners.input[0]({ target: { id: 'taskCenterSearch', value: 'проект' } })
    await wait(200)
    assert.equal(w.view.shown().length, 1)
    w.section.listeners.input[0]({ target: { id: 'taskCenterSearch', value: 'нет-такого' } })
    await wait(200)
    assert.equal(w.view.shown().length, 0)
    assert.match(w.list.innerHTML, /Ничего не найдено/, 'поле поиска не дошло до списка')
  })

  await check('чужой текст остаётся текстом', async () => {
    const w = makeWorld()
    w.chats = [chatRun('cx', '<img src=x onerror=alert(1)>')]
    w.view.ensure()
    await w.view.refresh()
    assert.doesNotMatch(w.list.innerHTML, /<img/, 'в списке появился <img>')
    assert.match(w.list.innerHTML, /&lt;img/, 'текст должен остаться видимым, а не исчезнуть')
    assert.doesNotMatch(w.list.innerHTML, /onclick=/, 'в разметке карточки появился обработчик')
  })

  await check('клик по карточке уводит к нарисованному ходу', async () => {
    const w = makeWorld()
    w.chats = [chatRun('c1', 'Собери проект'), chatRun('c2', 'Почини тесты', 'done', 20)]
    w.view.ensure()
    await w.view.refresh()
    const items = w.view.items()
    w.list.listeners.click[0]({ target: { closest: () => ({ dataset: { taskIndex: '0' } }) } })
    assert.equal(w.badges.at(-1), items[0], 'открыт не тот элемент')
    // Номер мог уехать при перерисовке — это молчание, а не падение.
    w.list.listeners.click[0]({ target: { closest: () => ({ dataset: { taskIndex: '99' } }) } })
    assert.equal(w.badges.filter(item => !String(item).startsWith('badge:')).length, 1)
  })

  await check('пустой раздел объясняет себя словами', async () => {
    const w = makeWorld()
    w.view.ensure()
    await w.view.refresh()
    assert.match(w.list.innerHTML, /task-center-empty/, 'нет состояния пусто')
    assert.match(w.list.innerHTML, /Пока нет задач/, 'нет заголовка пустого состояния')
  })

  await check('отказ чтения не обнуляет список', async () => {
    const w = makeWorld({ interrupted: async () => { throw new Error('нет доступа') } })
    w.chats = [chatRun('c1', 'Собери проект')]
    w.view.ensure()
    await w.view.refresh()
    assert.match(w.list.innerHTML, /task-center-item/, 'ход чата пропал из-за отказа')
    assert.match(w.count.textContent, /Прерванные ходы не прочитались/, 'отказ не назван')
  })

  await check('активный ход дорисовывается без перезахода, пачки сливаются', async () => {
    const w = makeWorld()
    w.chats = [chatRun('c1', 'Собери проект')]
    w.view.ensure()
    await w.view.refresh()
    assert.doesNotMatch(w.list.innerHTML, /В работе/, 'живого хода ещё нет')
    w.panes = [{ chatId: 'c1', generating: true, agentTasks: new Map([[0, { name: 'Агент 1', what: 'Пишет', done: false }]]) }]
    w.view.rebuildSoon()
    w.view.rebuildSoon()
    w.view.rebuildSoon()
    await wait(500)
    assert.match(w.list.innerHTML, /В работе/, 'перерисовки не было')
    assert.ok(w.badges.some(item => item === 'badge:1'), 'метка раздела не показывает активный ход')
  })

  await check('закрытый раздел не перерисовывается', async () => {
    const w = makeWorld({ closed: true })
    w.chats = [chatRun('c1', 'Собери проект')]
    w.view.ensure()
    await w.view.refresh()
    const snapshot = w.list.innerHTML
    w.chats = [chatRun('c2', 'Другая работа', 'failed', 99)]
    w.view.rebuildSoon()
    await wait(500)
    assert.equal(w.list.innerHTML, snapshot, 'закрытый раздел перерисовался')
  })

  // Ниже — три случая, найденные независимой приёмкой экрана: метка без
  // строки счёта, поиск по видимому слову поверхности и пустота под фильтром.
  await check('метка навигации пишется и без строки счёта на экране', async () => {
    const w = makeWorld({ countless: true })
    w.chats = [chatRun('c1', 'Собери проект')]
    w.panes = [{ chatId: 'c1', generating: true, agentTasks: new Map([[0, { name: 'Агент 1', what: 'Пишет', done: false }]]) }]
    w.view.ensure()
    await w.view.refresh()
    assert.ok(w.badges.includes('badge:1'), `метка не обновилась: ${JSON.stringify(w.badges)}`)
    assert.equal(w.view.syncBadge(), 1, 'syncBadge не вернул число активных')
  })

  await check('поиск по видимому слову поверхности находит ход', async () => {
    const w = makeWorld()
    w.designs = [{ id: 'd1', name: 'Лендинг', messages: [
      { role: 'user', content: 'Собери макет' },
      { role: 'assistant', timestamp: 30, agentRun: { at: 30, agents: [{ name: 'Дизайн', outcome: 'done' }] } }
    ] }]
    w.view.ensure()
    await w.view.refresh()
    assert.equal(w.view.shown().length, 1)
    assert.match(w.list.innerHTML, /Дизайн/, 'карточка не названа поверхностью')
    assert.equal(w.view.setQuery('дизайн'), 1, 'поиск по видимому слову не работает')
  })

  await check('пусто под фильтром объясняет, что ходы другого состояния остались', async () => {
    const w = makeWorld()
    w.chats = [chatRun('c1', 'Собери проект', 'done', 10)]
    w.view.ensure()
    await w.view.refresh()
    w.view.setStatus('problems')
    assert.match(w.list.innerHTML, /Ничего не найдено/, 'фильтр назван пустотой списка')
    assert.match(w.list.innerHTML, /Смените фильтр/, 'не сказано, что ходы остались выше')
  })

  for (const view of worlds) view.stop()
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error('ПРОВАЛ прогона', error); process.exitCode = 1 })
