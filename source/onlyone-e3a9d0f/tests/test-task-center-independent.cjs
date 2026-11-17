// Центр задач (план, 3.4): НЕЗАВИСИМЫЙ набор проверок экрана раздела.
//
// `test-task-center.cjs` проверяет индекс, `test-task-center-screen.cjs` —
// экран по сценариям автора. Этот файл набран заново и по своей логике: свои
// fixtures, свой подставной DOM, свой разбор готовой разметки. Проверяется
// поведение, а не строки из соседних проверок. Четыре опоры набора:
//   1. переход — клик по карточке обязан привести туда, где работа делалась,
//      и привести именно тот объект, который на ней нарисован;
//   2. поиск — по просьбе, хозяину, агенту, модели; регистр, пробелы, пустая
//      строка и очень длинная строка;
//   3. фильтры — предсказуемый состав каждого, включая живые ходы и все шесть
//      «плохих» исходов;
//   4. безопасность — чужой текст не становится ни тегом, ни атрибутом события,
//      причём разметка разбирается по-настоящему, а не по подстроке.
//
// Раздел поднимает свои `setInterval`/`setTimeout`. В прогоне часы подменены:
// тик вызывает сама проверка, а после каждой проверки всё поднятое гасится,
// чтобы Node вышел сам.
'use strict'

const assert = require('node:assert/strict')
const { create, renderTaskItems } = require('../src/renderer/task-center')

const STATUSES = ['all', 'active', 'problems', 'complete']
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let total = 0
let failed = 0

// Та же функция экранирования, что у окна (`app.js:1052`): экран получает её
// из проводки и отвечает за разметку ровно ею.
const appEscape = value => String(value || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;')

// ─── часы ────────────────────────────────────────────────────────────────────
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const clock = []
globalThis.setInterval = (fn, ms) => {
  const handle = { fn, ms, cleared: false, onlyoneClock: true }
  clock.push(handle)
  return handle
}
globalThis.clearInterval = handle => {
  if (handle && handle.onlyoneClock) { handle.cleared = true; return undefined }
  return realClearInterval(handle)
}
const tickHandles = from => clock.slice(from)
const liveTicks = from => tickHandles(from).filter(handle => !handle.cleared)

// ─── подставной DOM ──────────────────────────────────────────────────────────
function makeNode(id, extra = {}) {
  return {
    id,
    dataset: { ...(extra.dataset || {}) },
    attrs: {},
    listeners: {},
    textContent: '',
    innerHTML: '',
    // У узла со `display:none` нет offsetParent — так экран понимает, что
    // раздела не видно.
    offsetParent: extra.closed ? null : {},
    setAttribute(key, value) { this.attrs[key] = String(value) },
    getAttribute(key) { return this.attrs[key] ?? null },
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn) },
    contains() { return !extra.detached }
  }
}

const raised = []

function makeWorld(opts = {}) {
  const world = {
    chats: opts.chats || [],
    designs: opts.designs || [],
    panes: opts.panes || [],
    designPanes: opts.designPanes || new Map(),
    opened: [],
    badges: [],
    interruptedCalls: 0
  }
  const section = makeNode('taskCenterView')
  const list = makeNode('taskCenterList', { closed: opts.closed, detached: opts.detached })
  const search = makeNode('taskCenterSearch')
  const count = makeNode('taskCenterCount')
  const filters = STATUSES.map(status => makeNode(`filter-${status}`, { dataset: { taskFilter: status } }))
  const nodes = new Map([[section.id, section], [list.id, list], [search.id, search], [count.id, count]])
  if (opts.noCountNode) nodes.delete('taskCenterCount')
  const noDom = opts.noDom === true
  const deps = {
    document: noDom
      ? { getElementById: () => null, querySelectorAll: () => [] }
      : { getElementById: id => nodes.get(id) || null, querySelectorAll: sel => (sel === '[data-task-filter]' ? filters : []) },
    t: opts.t || (value => value),
    readInterrupted: async () => {
      world.interruptedCalls++
      return typeof opts.interrupted === 'function' ? await opts.interrupted() : []
    },
    getChats: () => world.chats,
    getDesigns: () => world.designs,
    getPanes: () => world.panes,
    getDesignPanes: () => world.designPanes,
    setBadge: value => world.badges.push(value)
  }
  // `escapeHtml: null` — проверка отката на собственный экранинг модуля.
  if (opts.escapeHtml !== null) deps.escapeHtml = opts.escapeHtml || appEscape
  if (opts.openTask !== null) {
    deps.openTask = item => {
      world.opened.push(item)
      return opts.openTask ? opts.openTask(item) : true
    }
  }
  const view = create(deps)
  raised.push(view)
  return Object.assign(world, {
    view, section, list, search, count, filters,
    // Открыть раздел так, как его открывает окно: проводка + перечитывание.
    async open() {
      const n = view.ensure()
      world.ensureResult = n
      return view.refresh()
    },
    // Клик по карточке: список слушает click и сам ищет `[data-task-index]`.
    // `taskIndex: null` — клик мимо карточки.
    clickCard(taskIndex) {
      const button = taskIndex === null ? null
        : { dataset: { taskIndex: String(taskIndex) }, nodeType: 1, tagName: 'BUTTON' }
      list.listeners.click[0]({ target: { closest: () => button, nodeType: 1 } })
    },
    // Нажатие на кнопку фильтра — событие всплывает до секции.
    clickFilter(status) {
      const button = filters[STATUSES.indexOf(status)]
      section.listeners.click[0]({ target: { closest: () => button } })
    },
    // Ввод в поле поиска: секция слушает input и бережёт задержку.
    type(value) {
      search.value = value
      section.listeners.input[0]({ target: { id: 'taskCenterSearch', value } })
    }
  })
}

function stopAll() {
  for (const view of raised) view.stop()
}

// Проверка живёт одна от другой: после каждой гасим часы и отложки всех
// поднятых экранов, иначе процесс не выйдет.
function check(name, fn) {
  total++
  return Promise.resolve().then(fn).then(
    () => console.log('  ok  ' + name),
    error => { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
  ).finally(stopAll)
}

// ─── fixtures: та же форма данных, что лежит в истории и в живых панелях ─────
function historyRun(id, caption, ask, agents, at, messageMeta = {}) {
  const row = { id, messages: [
    { role: 'user', content: ask, timestamp: at - 5 },
    { role: 'assistant', timestamp: at, ...messageMeta, agentRun: { at, ask, seconds: 24, agents } }
  ] }
  row[caption.field] = caption.value
  return row
}
const chatRun = (id, title, ...rest) => historyRun(id, { field: 'title', value: title }, ...rest)
const designRun = (id, name, ...rest) => historyRun(id, { field: 'name', value: name }, ...rest)
const oneAgent = (outcome, extra = {}) => [{ name: 'Агент 1', title: 'Работа', outcome, ...extra }]

const liveChatPane = (chatId, extra = {}) => ({
  chatId, generating: true, startedAt: extra.at || 1000,
  agentTasks: new Map([[0, { name: extra.agent || 'Агент 1', what: extra.what || 'Читает лог', model: 'Model A', since: extra.at || 1000 }]]),
  ...extra.pane
})

// ─── разбор разметки ─────────────────────────────────────────────────────────
// Атрибуты читаем так, как их прочитал бы браузер: значение ограниченно
// СЫРЫМИ кавычками, поэтому `&quot;` внутри значения атрибут не ломает.
function scanTags(html) {
  const tags = []
  let pos = 0
  while (pos < html.length) {
    const lt = html.indexOf('<', pos)
    if (lt === -1) break
    const rest = html.slice(lt)
    if (/^<!--/.test(rest)) { tags.push({ bad: true, raw: rest.slice(0, 24) }); pos = lt + 1; continue }
    const closing = /^<\//.test(rest)
    const head = closing ? /^<\/([a-zA-Z][\w-]*)/.exec(rest) : /^<([a-zA-Z][\w-]*)/.exec(rest)
    if (!head) { tags.push({ bad: true, raw: rest.slice(0, 24) }); pos = lt + 1; continue }
    const name = head[1].toLowerCase()
    let i = head[0].length
    const attrs = []
    let bad = false
    while (i < rest.length) {
      const ch = rest[i]
      if (ch === '>') { i++; break }
      if (/\s/.test(ch) || ch === '/') { if (ch === '/' && rest[i + 1] === '>') i++; else i++; continue }
      if (closing) { bad = true; i++; continue }
      const keyMatch = /^[^\s=>/]+/.exec(rest.slice(i))
      const key = keyMatch ? keyMatch[0].toLowerCase() : ''
      i += keyMatch ? keyMatch[0].length : 1
      let value = ''
      if (rest[i] === '=') {
        i++
        const quote = rest[i]
        if (quote === '"' || quote === "'") {
          const end = rest.indexOf(quote, i + 1)
          value = rest.slice(i + 1, end === -1 ? rest.length : end)
          if (end === -1) bad = true
          i = end === -1 ? rest.length : end + 1
        } else {
          const bare = /^[^\s>]*/.exec(rest.slice(i))[0]
          value = bare
          i += bare.length
        }
      }
      if (key) attrs.push({ key, value })
    }
    tags.push({ name, closing, attrs, bad, raw: rest.slice(0, i) })
    pos = lt + i
  }
  return tags
}

// Карточка и служебные состояния раздела рисуют только этот каркас.
const CARD_TAGS = {
  button: ['type', 'class', 'data-task-index', 'aria-label'],
  span: ['class', 'aria-hidden'],
  div: ['class', 'role'],
  strong: []
}

function assertInert(html, label) {
  const tags = scanTags(html)
  assert.equal(tags.some(tag => tag.bad), false,
    `${label}: в разметке чужой тег или незакрытая кавычка — ${JSON.stringify(tags.find(tag => tag.bad)?.raw)}`)
  for (const tag of tags) {
    assert.equal(Object.prototype.hasOwnProperty.call(CARD_TAGS, tag.name), true,
      `${label}: появился чужой тег <${tag.name}>`)
    if (tag.closing) continue
    for (const attr of tag.attrs) {
      assert.equal(/^on[a-z]/i.test(attr.key), false, `${label}: атрибут события ${attr.key}`)
      assert.ok(CARD_TAGS[tag.name].includes(attr.key),
        `${label}: неизвестный атрибут ${attr.key} у <${tag.name}>`)
      assert.equal(/[<>]/.test(attr.value), false, `${label}: сырой «<» или «>» внутри ${attr.key}`)
      assert.equal(/javascript:/i.test(attr.value), false, `${label}: javascript: в ${attr.key}`)
    }
  }
  assert.equal(/<\s*script/i.test(html), false, `${label}: <script> в разметке`)
  assert.equal(/<\s*\/\s*(?:script|style)\b/i.test(html), false, `${label}: закрывающий тег чужого блока`)
}

// Текст обязан остаться видимым: экранирование не имеет права его съедать.
function assertReadable(html, text, label) {
  assert.ok(html.includes(text), `${label}: текст «${text}» должен остаться на экране`)
}

// Обратно к прочитанному: то, что человек видит в карточке, — тот же текст,
// что лежит в ходе. Экранирование, потерявшее знак, даёт `undefined` вместо
// кавычки, и проверка на возврат это ловит.
const decodeEntities = text => String(text)
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')

function assertRoundTrip(html, payloads, label) {
  assert.equal(/undefined/.test(html), false, `${label}: в разметку утекло «undefined» — экранинг потерял знак`)
  const decoded = decodeEntities(html)
  for (const payload of payloads) {
    assert.ok(decoded.includes(payload), `${label}: текст «${payload}» не читается обратно из карточки`)
  }
}

// ─── прогон ─────────────────────────────────────────────────────────────────
async function main() {
  // 1. Переходы ----------------------------------------------------------------
  await check('переход: клик по карточке каждого входа зовёт свой ход и правильного хозяина', async () => {
    const w = makeWorld({
      chats: [
        chatRun('c-chat', 'Диалог сборки', 'Собери проект', oneAgent('done'), 100),
        chatRun('c-flow', 'Диалог проверки', 'Прогони проверку', oneAgent('done'), 300),
        chatRun('c-live', 'Живой диалог', 'Найди ошибку в сборке', oneAgent('done'), 50),
        { id: 'c-cut', title: 'Диалог прерванного хода', messages: [] },
        { id: 'c-bare', title: 'Только прерванный ход', messages: [] }
      ],
      designs: [
        designRun('d-1', 'Лендинг банка', 'Править шапку', oneAgent('done'), 200),
        { id: 'd-cut', name: 'Макет из прерванного хода', messages: [] },
        { id: 'd-live', name: 'Живой макет', messages: [] }
      ],
      panes: [liveChatPane('c-live')],
      designPanes: new Map([['d-live', { generating: true, currentAsk: 'Обнови сетку', startedAt: 400, agentTasks: new Map() }]]),
      interrupted: () => [
        { runId: 'r-cut-design', designId: 'd-cut', ask: 'Продолжи макет', updatedAt: 600 },
        { runId: 'r-cut-chat', chatId: 'c-cut', ask: 'Продолжи миграцию', updatedAt: 700 }
      ]
    })
    await w.open()
    // Хозяин карточки: куда поведёт клик. `surface` + `ownerId` — вся пара.
    // «Живой диалог» даёт две карточки — завершённый ход в истории и текущий
    // живой ход; обе ведут в один и тот же диалог.
    const expected = new Map([
      ['history:chat:c-chat:100', ['chat', 'c-chat']],
      ['history:chat:c-live:50', ['chat', 'c-live']],
      ['history:design:d-1:200', ['design', 'd-1']],
      ['history:chat:c-flow:300', ['chat', 'c-flow']],
      ['live:chat:c-live', ['chat', 'c-live']],
      ['live:design:d-live', ['design', 'd-live']],
      ['interrupted:r-cut-design', ['design', 'd-cut']],
      ['interrupted:r-cut-chat', ['chat', 'c-cut']]
    ])
    const shown = w.view.shown()
    assert.deepEqual(shown.map(item => item.id).sort(), [...expected.keys()].sort(), 'на экране не тот набор ходов')
    shown.forEach((item, index) => {
      const [surface, ownerId] = expected.get(item.id)
      assert.deepEqual([item.surface, item.ownerId], [surface, ownerId], `карточка ${item.id} подписана неверно`)
      const before = w.opened.length
      w.clickCard(index)
      assert.equal(w.opened.length, before + 1, `клик по ${item.id} не позвал openTask`)
      assert.equal(w.opened.at(-1), item, `клик по ${item.id} принёс не тот объект`)
      assert.equal(w.opened.at(-1).ownerId, ownerId, `клик по ${item.id} унёс не к тому хозяину`)
      // Тот же владелец, что реально открывает окно: дизайн — из макетов,
      // чат — из диалогов.
      const pool = item.surface === 'design' ? w.designs : w.chats
      assert.ok(pool.some(row => row.id === item.ownerId), `карточка ${item.id} ведёт в никуда`)
    })
  })

  await check('переход: живой ход диалога остаётся хозяином диалога, даже если в панели затесался designId', async () => {
    // Окно сегодня не кладёт `designId` в панель чата, но `work-panel.js` уже
    // читает `pane.designId`: если поле появится, карточка живого хода не
    // должна увести клик в макет вместо диалога.
    const w = makeWorld({
      chats: [{ id: 'c-run', title: 'Идёт сейчас', messages: [] }],
      designs: [{ id: 'd-stray', name: 'Соседний макет', messages: [] }],
      panes: [{ ...liveChatPane('c-run'), designId: 'd-stray' }]
    })
    await w.open()
    const [item] = w.view.shown()
    assert.equal(item.surface, 'chat')
    assert.equal(item.ownerId, 'c-run', 'живой ход диалога отдал чужого хозяина')
    w.clickCard(0)
    assert.equal(w.opened[0], item)
    assert.ok(w.chats.some(chat => chat.id === w.opened[0].ownerId), 'клик по живой карточке не ведёт в диалог')
  })

  await check('переход: карточка при фильтре и при поиске ведёт к показанному, а не к первому в списке', async () => {
    const w = makeWorld({
      chats: [
        chatRun('c-ok', 'Сборка', 'Собери проект', oneAgent('done'), 10),
        chatRun('c-bad', 'Сборка', 'Почини тесты', oneAgent('failed'), 20)
      ]
    })
    await w.open()
    const all = w.view.items()
    assert.equal(all.length, 2)
    assert.equal(w.view.setStatus('problems'), 1)
    const shown = w.view.shown()
    assert.equal(shown[0].id, 'history:chat:c-bad:20', 'фильтр показал не тот ход')
    w.clickCard(0)
    assert.equal(w.opened.at(-1), shown[0], 'клик открыл ход из полного списка')
    assert.equal(w.opened.at(-1).ownerId, 'c-bad', 'открыт не тот диалог')
    // Номер карточки живёт в перерисованном списке: после смены фильтра на
    // «Все» нулевой карточкой становится другой ход.
    w.view.setStatus('all')
    w.clickCard(0)
    assert.equal(w.opened.at(-1).id, w.view.shown()[0].id, 'после смены фильтра клик промахнулся')
    // То же самое после сужения поиском: номер относится к показанному списку.
    w.view.setQuery('проект')
    assert.deepEqual(w.view.shown().map(item => item.id), ['history:chat:c-ok:10'])
    w.clickCard(0)
    assert.equal(w.opened.at(-1).ownerId, 'c-ok', 'клик после поиска открыл не тот ход')
    // Номер за краем сузившегося списка не должен найти ход в полном списке.
    const opened = w.opened.length
    assert.doesNotThrow(() => w.clickCard(1), 'клик по номеру за краем сузившегося списка уронил экран')
    assert.equal(w.opened.length, opened, 'клик за краем сузившегося списка открыл ход из полного')
  })

  await check('переход: прерванный ход без хозяина остаётся при своём runId и клик по нему не роняет экран', async () => {
    const w = makeWorld({
      interrupted: () => [{ runId: 'r-alone', ask: 'Ход без диалога', updatedAt: 900 }]
    })
    await w.open()
    const [item] = w.view.shown()
    assert.equal(item.id, 'interrupted:r-alone')
    assert.equal(item.ownerId, 'r-alone', 'у хода без хозяина должен остаться runId')
    assert.equal(item.surface, 'chat')
    assert.equal(item.status, 'interrupted')
    w.clickCard(0)
    assert.equal(w.opened.length, 1)
    assert.equal(w.opened[0], item)
  })

  await check('переход: несуществующий номер, номер за краем списка и клик мимо карточки безопасны', async () => {
    const w = makeWorld({ chats: [chatRun('c1', 'Сборка', 'Собери проект', oneAgent('done'), 10)] })
    await w.open()
    assert.equal(w.view.shown().length, 1, 'карточка не нарисовалась')
    // '1' — ровно длина списка: такой ход в списке есть под номером 0, а
    // единицы нет. Граница должна ловить и её.
    for (const index of ['1', '99', '-1', 'abc', '1.5', '1e9']) {
      assert.doesNotThrow(() => w.clickCard(index), `клик по номеру ${index} уронил экран`)
    }
    assert.doesNotThrow(() => w.clickCard(null), 'клик мимо карточки уронил экран')
    assert.equal(w.opened.length, 0, 'на неверный номер открылся ход')
    // Экран после таких кликов жив: обычный переход работает.
    w.clickCard(0)
    assert.equal(w.opened.length, 1)
    assert.equal(w.opened[0].id, 'history:chat:c1:10')
  })

  await check('переход: карточка вне списка и чужое событие клика игнорируются', async () => {
    const w = makeWorld({ detached: true, chats: [chatRun('c1', 'Сборка', 'Собери проект', oneAgent('done'), 10)] })
    await w.open()
    w.clickCard(0)
    assert.equal(w.opened.length, 0, 'клик по карточке, которой нет в списке, открыл ход')
    // Чужая кнопка фильтра вне секции не меняет состояние.
    const outside = makeNode('outside', { dataset: { taskFilter: 'problems' } })
    w.section.listeners.click[0]({ target: { closest: () => outside } })
    assert.equal(w.view.setStatus('all'), 1, 'чужая кнопка сменила фильтр')
  })

  await check('переход: без openTask клик молчит, экран остаётся рабочим', async () => {
    const w = makeWorld({ openTask: null, chats: [chatRun('c1', 'Сборка', 'Собери проект', oneAgent('done'), 10)] })
    await w.open()
    assert.doesNotThrow(() => w.clickCard(0))
    assert.equal(w.view.shown().length, 1)
    assert.match(w.list.innerHTML, /task-center-item/)
  })

  // 2. Поиск -------------------------------------------------------------------
  const SEARCH_CHATS = () => [
    chatRun('c-1', 'Рефакторинг ядра', 'Перепиши загрузчик', [{ name: 'QA-бот', title: 'Проверка типов', model: 'openrouter/deepseek', outcome: 'done' }], 10),
    chatRun('c-2', 'Сборка', 'Найди ошибку в сборке', oneAgent('running?'), 20),
    chatRun('c-flow', 'Релиз', 'Прогони проверку', oneAgent('done'), 30)
  ]
  const SEARCH_DESIGNS = () => [
    designRun('d-1', 'Лендинг банка', 'Собери макет', [{ name: 'Дизайнер', title: 'Первый экран', outcome: 'done' }], 40)
  ]

  await check('поиск: просьба, диалог, макет, имя агента, его задача и модель — каждый находит своё', async () => {
    const w = makeWorld({ chats: SEARCH_CHATS(), designs: SEARCH_DESIGNS() })
    await w.open()
    assert.equal(w.view.shown().length, 4, 'без запроса видно не всё')
    const probes = [
      ['загрузчик', 'history:chat:c-1:10'],
      ['Рефакторинг ядра', 'history:chat:c-1:10'],
      ['Лендинг банка', 'history:design:d-1:40'],
      ['QA-бот', 'history:chat:c-1:10'],
      ['Проверка типов', 'history:chat:c-1:10'],
      ['openrouter/deepseek', 'history:chat:c-1:10'],
      ['Первый экран', 'history:design:d-1:40'],
      ['maket', null],
      ['ошибку в сборке', 'history:chat:c-2:20']
    ]
    for (const [query, id] of probes) {
      const shown = w.view.shown()
      w.view.setQuery(query)
      const found = w.view.shown().map(item => item.id)
      assert.deepEqual(found, id ? [id] : [], `запрос «${query}» нашёл ${JSON.stringify(found)}`)
      assert.ok(shown.length >= 0)
    }
    w.view.setQuery('')
  })

  await check('поиск: регистр и лишние пробелы не мешают, табуляция и перенос строки тоже', async () => {
    const w = makeWorld({ chats: SEARCH_CHATS(), designs: SEARCH_DESIGNS() })
    await w.open()
    for (const query of ['ПЕРЕПИШИ ЗАГРУЗЧИК', '   перепиши    загрузчик  ', 'Перепиши\tзагрузчик\n', 'qa-бот', 'OPENROUTER/DEEPSEEK']) {
      assert.equal(w.view.setQuery(query), 1, `запрос «${JSON.stringify(query)}» не нашёл ход`)
    }
    assert.equal(w.view.setQuery('лендинг   БАНКА'), 1, 'поиск по имени макета с пробелами не сработал')
  })

  await check('поиск: пустая строка и одни пробелы показывают весь список', async () => {
    const w = makeWorld({ chats: SEARCH_CHATS(), designs: SEARCH_DESIGNS() })
    await w.open()
    assert.equal(w.view.setQuery(''), 4)
    assert.equal(w.view.setQuery('   '), 4, 'запрос из пробелов сузил список')
    assert.equal(w.view.setQuery('\t\n '), 4, 'запрос из переносов сузил список')
    assert.doesNotMatch(w.list.innerHTML, /task-center-empty/, 'пустой запрос показал пустое состояние')
  })

  await check('поиск: очень длинная строка не роняет экран и не находит лишнего', async () => {
    const w = makeWorld({ chats: SEARCH_CHATS(), designs: SEARCH_DESIGNS() })
    await w.open()
    const monster = 'перепиши ' + 'з'.repeat(6000)
    assert.doesNotThrow(() => w.view.setQuery(monster))
    assert.equal(w.view.setQuery(monster), 0, 'мусорный хвост длинной строки что-то нашёл')
    assert.match(w.list.innerHTML, /Ничего не найдено/)
    // Одинаковый « шум» вокруг настоящего слова не должен искать 6000 символов.
    assert.equal(w.view.setQuery('перепиши'), 1)
    assert.equal(w.view.setQuery('з'.repeat(3000)), 0)
  })

  await check('поиск: поле ввода доносит запрос с задержкой и только последнее значение', async () => {
    const w = makeWorld({ chats: SEARCH_CHATS(), designs: SEARCH_DESIGNS() })
    await w.open()
    w.type('лендинг')
    assert.equal(w.view.shown().length, 4, 'список сузился до отложки ввода')
    await wait(200)
    assert.equal(w.view.shown().length, 1, 'поле поиска не дошло до списка')
    w.type('загрузчик')
    w.type('ошибку')
    await wait(220)
    assert.equal(w.view.shown()[0]?.id, 'history:chat:c-2:20', 'применился не последний запрос')
    // Отменённый хвост: stop() снимает отложку, и список остаётся как было.
    w.type('Проверка релиза')
    w.view.stop()
    await wait(220)
    assert.equal(w.view.shown()[0]?.id, 'history:chat:c-2:20', 'stop() не отменил отложенный поиск')
  })

  await check('поиск: поверхность находится по своему ключу, а фильтр и поиск работают вместе', async () => {
    const w = makeWorld({
      chats: [
        chatRun('c-flow', 'Релиз', 'Прогони проверку', oneAgent('done'), 30),
        chatRun('c-plain', 'Релиз', 'Просто собери', oneAgent('failed'), 40)
      ],
      designs: [designRun('d-1', 'Лендинг', 'Собери макет', oneAgent('done'), 50)]
    })
    await w.open()
    assert.equal(w.view.setQuery('design'), 1, 'поиск по ключу поверхности не нашёл дизайн')
    assert.equal(w.view.setQuery('chat'), 2, 'поиск по ключу поверхности не нашёл чаты')
    // Поиск + фильтр: пересечение, а не замена.
    w.view.setQuery('Релиз')
    assert.equal(w.view.shown().length, 2, 'поиск по общему имени диалогов не сузил до двух')
    assert.equal(w.view.setStatus('problems'), 1, 'фильтр поверх поиска не сработал')
    assert.equal(w.view.shown()[0].id, 'history:chat:c-plain:40')
    assert.equal(w.view.setStatus('complete'), 1)
    assert.equal(w.view.shown()[0].id, 'history:chat:c-flow:30')
  })

  // 3. Фильтры -----------------------------------------------------------------
  function filterWorld(extra = {}) {
    return makeWorld({
      chats: [
        chatRun('c-done', 'Готово', 'Всё сделал', [{ name: 'Агент 1', outcome: 'done' }, { name: 'Агент 2', outcome: 'done' }], 10),
        chatRun('c-failed', 'Упало', 'Собери проект', oneAgent('failed'), 20),
        chatRun('c-int', 'Прервалось', 'Дочитай лог', oneAgent('interrupted'), 30),
        chatRun('c-inc', 'Не завершено', 'Правь стили', oneAgent('incomplete'), 40),
        chatRun('c-ns', 'Не запускался', 'Гоняй тесты', oneAgent('not-started'), 50),
        chatRun('c-blk', 'Заблокировано', 'Слей ветки', oneAgent('blocked'), 60),
        chatRun('c-mix', 'Смешанный', 'Собери и проверь', [{ name: 'Агент 1', outcome: 'done' }, { name: 'Агент 2', outcome: 'failed' }], 70),
        chatRun('c-und', 'Непонятно', 'Сделай что-то', oneAgent('cancelled'), 80),
        { id: 'c-cut', title: 'Прерванный ход', messages: [] },
        { id: 'c-run', title: 'Идёт сейчас', messages: [] },
        { id: 'c-wait', title: 'Готовится', messages: [] }
      ],
      designs: [designRun('d-done', 'Макет готов', 'Собери макет', oneAgent('done'), 90),
        { id: 'd-live', name: 'Живой макет', messages: [] }],
      panes: [liveChatPane('c-run'), { chatId: 'c-wait', preparing: true, startedAt: 95, agentTasks: new Map() }],
      designPanes: new Map([['d-live', { generating: true, currentAsk: 'Обнови сетку', startedAt: 95, agentTasks: new Map() }]]),
      interrupted: () => [{ runId: 'r-1', chatId: 'c-cut', ask: 'Продолжи миграцию', updatedAt: 100 }],
      ...extra
    })
  }

  const shownIds = (w, status, query = '') => {
    w.view.setStatus(status)
    w.view.setQuery(query)
    return w.view.shown().map(item => item.id).sort()
  }

  await check('фильтр «Все»: весь список, включая статус «не определён»', async () => {
    const w = filterWorld()
    await w.open()
    const all = w.view.items().map(item => item.id)
    assert.equal(all.length, 13, 'в «Всех» видно не весь список')
    assert.deepEqual(shownIds(w, 'all'), [...all].sort())
    assert.ok(all.includes('history:chat:c-und:80'), 'ход с неизвестным исходом пропал из «Всех»')
    // Инвариант перехода для каждого фильтра: карточка Дизайна отдаёт id
    // макета, карточка диалога — id диалога.
    for (const status of STATUSES) {
      for (const item of (w.view.setStatus(status), w.view.shown())) {
        const pool = item.surface === 'design' ? w.designs : w.chats
        assert.ok(pool.some(row => row.id === item.ownerId),
          `${status}: карточка ${item.id} (${item.surface}) ведёт в никуда — ownerId ${item.ownerId}`)
      }
    }
  })

  await check('фильтр «Активные»: живой ход, ожидающий и прерванный; завершённый и проблемный — нет', async () => {
    const w = filterWorld()
    await w.open()
    assert.deepEqual(shownIds(w, 'active'), ['interrupted:r-1', 'live:chat:c-run', 'live:design:d-live', 'live:chat:c-wait'].sort(),
      'состав «Активных» не совпал')
    assert.equal(shownIds(w, 'active').includes('history:chat:c-failed:20'), false, 'упавший ход ушёл в активные')
    assert.equal(shownIds(w, 'active').includes('history:chat:c-done:10'), false, 'завершённый ход ушёл в активные')
    // Ход, у которого в истории записан прерванный исход, — это проблема, а не
    // живая работа: в «Активных» его быть не должно.
    assert.equal(shownIds(w, 'active').includes('history:chat:c-int:30'), false, 'прерванный исход попал в активные')
  })

  await check('фильтр «С проблемами»: все шесть плохих исходов плюс прерванный ход', async () => {
    const w = filterWorld()
    await w.open()
    assert.deepEqual(shownIds(w, 'problems'), [
      'history:chat:c-failed:20', 'history:chat:c-int:30', 'history:chat:c-inc:40',
      'history:chat:c-ns:50', 'history:chat:c-blk:60', 'history:chat:c-mix:70', 'interrupted:r-1'
    ].sort(), 'состав «С проблемами» не совпал')
    assert.equal(shownIds(w, 'problems').includes('history:chat:c-und:80'), false, 'непонятный исход стал проблемой')
    assert.equal(shownIds(w, 'problems').includes('live:chat:c-run'), false, 'живой ход стал проблемой')
  })

  await check('фильтр «Завершённые»: только ходы, где все агенты done', async () => {
    const w = filterWorld()
    await w.open()
    assert.deepEqual(shownIds(w, 'complete'), ['history:chat:c-done:10', 'history:design:d-done:90'].sort(),
      'состав «Завершённых» не совпал')
    assert.equal(shownIds(w, 'complete').includes('history:chat:c-mix:70'), false, 'ход с упавшим агентом стал завершённым')
  })

  await check('фильтры: три группы не пересекаются и целиком лежат в «Всех»', async () => {
    const w = filterWorld()
    await w.open()
    const active = new Set(shownIds(w, 'active'))
    const problems = new Set(shownIds(w, 'problems'))
    const complete = new Set(shownIds(w, 'complete'))
    const all = shownIds(w, 'all')
    const overlap = [...active].filter(id => problems.has(id) && id !== 'interrupted:r-1')
    assert.deepEqual(overlap, [], '«Активные» и «С проблемами» пересеклись мимо прерванного хода')
    for (const id of [...complete]) assert.equal(active.has(id) || problems.has(id), false, `${id} в двух группах сразу`)
    for (const id of [...complete, ...problems]) assert.ok(all.includes(id), `${id} исчез из «Всех»`)
    const orphan = all.filter(id => !active.has(id) && !problems.has(id) && !complete.has(id))
    assert.deepEqual(orphan.sort(), ['history:chat:c-und:80'],
      'из «Всех» вне трёх групп должен остаться только ход с неопределённым статусом')
  })

  await check('фильтр: чужое имя и пустое значение возвращают к «Все»', async () => {
    const w = filterWorld()
    await w.open()
    const all = shownIds(w, 'all')
    assert.equal(w.view.setStatus('всего'), all.length)
    assert.equal(w.view.setStatus(''), all.length)
    assert.equal(w.view.setStatus('ACTIVE'), all.length, 'регистр в имени фильтра не должен решать')
    assert.deepEqual(w.view.shown().map(item => item.id).sort(), all.sort())
    // Кнопки на экране отражают состояние: нажата ровно одна.
    w.view.setStatus('problems')
    w.clickFilter('complete')
    assert.equal(w.filters[3].getAttribute('aria-pressed'), 'true')
    assert.equal(w.filters.filter(button => button.getAttribute('aria-pressed') === 'true').length, 1,
      'нажаты несколько фильтров сразу')
  })

  await check('фильтр «Активные»: живой ход уходит, как только генерация кончилась', async () => {
    const w = makeWorld({ chats: [{ id: 'c-run', title: 'Идёт сейчас', messages: [] }], panes: [liveChatPane('c-run')] })
    await w.open()
    assert.equal(w.view.setStatus('active'), 1)
    assert.match(w.list.innerHTML, /В работе/)
    const [pane] = w.panes
    pane.generating = false
    pane.agentTasks.get(0).done = true
    w.view.rebuild()
    assert.equal(w.view.setStatus('active'), 0, 'конченный ход остался в активных')
    // Ходов в истории у этого мира не было вовсе, поэтому пусто — а не
    // «не найдено»: фильтр ничего не спрятал, прятать нечего.
    assert.match(w.list.innerHTML, /Пока нет задач/)
    assert.equal(w.badges.at(-1), 0, 'метка не сняла число активных')
  })

  // 4. Состояния ---------------------------------------------------------------
  await check('состояние: первая отрисовка — «читаю», вторая не прячет известные данные за скелетом', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    let calls = 0
    const w = makeWorld({ interrupted: async () => { calls++; return calls === 1 ? gate : [] } })
    w.chats = [chatRun('c1', 'Сборка', 'Собери проект', oneAgent('done'), 10)]
    assert.equal(w.view.ensure(), true)
    const first = w.view.refresh()
    assert.match(w.list.innerHTML, /task-center-loading/, 'первая отрисовка не показала «читаю»')
    assert.match(w.list.innerHTML, /Читаю задачи/, 'в скелете нет слова «читаю»')
    assert.equal(w.count.textContent, 'Читаю задачи…', 'счёт не сказал, что идёт чтение')
    assert.doesNotMatch(w.list.innerHTML, /task-center-item/, 'во время чтения показался список')
    release([])
    await first
    assert.doesNotMatch(w.list.innerHTML, /task-center-loading/, 'скелет остался после ответа')
    const second = w.view.refresh()
    assert.doesNotMatch(w.list.innerHTML, /task-center-loading/,
      'повторное перечитывание спрятало уже известные данные')
    assert.match(w.list.innerHTML, /Собери проект/, 'при перечитывании список исчез')
    await second
    assert.equal(calls, 2)
  })

  await check('состояние: пустой раздел и «ничего не найдено» говорят разными фразами', async () => {
    const w = makeWorld()
    await w.open()
    assert.equal(w.view.items().length, 0)
    assert.match(w.list.innerHTML, /task-center-empty/, 'пустой раздел не показал пустое состояние')
    assert.match(w.list.innerHTML, /Пока нет задач/, 'нет заголовка пустого раздела')
    assert.match(w.list.innerHTML, /Здесь появятся активные и завершённые ходы/)
    // Запрос в пустом списке — уже не «пусто», а «не найдено».
    assert.equal(w.view.setQuery('что угодно'), 0)
    assert.match(w.list.innerHTML, /Ничего не найдено/, 'пустой список с запросом не сказал «не найдено»')
    assert.match(w.list.innerHTML, /Измените запрос или фильтр/)
    assert.doesNotMatch(w.list.innerHTML, /Пока нет задач/, 'фраза «пусто» осталась при запросе')
    // Счёт при пустом разделе не врёт.
    assert.match(w.count.textContent, /Активных 0 · Всего 0/)
  })

  await check('состояние: пустой раздел переводится на язык интерфейса', async () => {
    const w = makeWorld({ t: value => `«${value}»` })
    await w.open()
    assert.match(w.list.innerHTML, /«Пока нет задач»/, 'пустое состояние не переведено')
    assert.match(w.list.innerHTML, /«Здесь появятся активные и завершённые ходы из чатов и Дизайна.»/)
    w.chats = [chatRun('c1', 'Сборка', 'Собери проект', oneAgent('failed'), 10)]
    w.view.setQuery('')
    w.view.setStatus('all')
    w.view.rebuild()
    assert.match(w.list.innerHTML, /«Есть проблема»/, 'подпись состояния не переведена')
    assert.match(w.list.innerHTML, /«Чат»/, 'подпись поверхности не переведена')
    assert.match(w.count.textContent, /«Активных»/, 'счёт не переведён')
  })

  await check('состояние: отказ чтения прерванных ходов не съедает локальные данные и назван в счёте', async () => {
    let fail = true
    const w = makeWorld({ interrupted: async () => { if (fail) throw new Error('нет доступа к описи'); return [] } })
    w.chats = [chatRun('c1', 'Сборка', 'Собери проект', oneAgent('done'), 10)]
    w.panes = [liveChatPane('c1')]
    await w.open()
    assert.match(w.list.innerHTML, /task-center-item/, 'ход чата пропал из-за отказа чтения')
    assert.match(w.list.innerHTML, /Собери проект/, 'просьба исчезла из карточки')
    assert.match(w.count.textContent, /Прерванные ходы не прочитались/, 'отказ не назван')
    // Один диалог даёт две карточки: завершённый ход и живую генерацию.
    assert.match(w.count.textContent, /Активных 1 · Всего 2/, `счёт после отказа: ${w.count.textContent}`)
    assert.equal(w.view.items().some(item => item.origin === 'interrupted'), false)
    // Успешное чтение снимает надпись и доносит опись.
    fail = false
    await w.view.refresh()
    assert.doesNotMatch(w.count.textContent, /Прерванные ходы не прочитались/, 'надпись об отказе осталась')
    assert.equal(w.view.items().filter(item => item.origin === 'interrupted').length, 0)
  })

  await check('состояние: раздел без узлов в разметке не падает и ничего не рисует', async () => {
    const w = makeWorld({ noDom: true, chats: [chatRun('c1', 'Сборка', 'Собери проект', oneAgent('done'), 10)] })
    assert.equal(w.view.ensure(), false, 'ensure() нашёл узлы, которых нет')
    assert.equal(await w.view.refresh(), 0)
    assert.equal(w.view.rebuild(), 1, 'rebuild() всё-таки собрал индекс')
    assert.equal(w.view.setStatus('active'), 0)
    assert.equal(w.view.setQuery('проект'), 0)
    assert.equal(w.view.rebuildSoon(), 1)
    w.view.stop()
    assert.equal(w.list.innerHTML, '')
    assert.equal(w.opened.length, 0)
  })

  await check('состояние: закрытый раздел не перерисовывается и не держит часы', async () => {
    const before = clock.length
    const w = makeWorld({ closed: true, chats: [chatRun('c1', 'Сборка', 'Собери проект', oneAgent('done'), 10)] })
    w.panes = [liveChatPane('c1')]
    await w.open()
    assert.deepEqual(liveTicks(before), [], 'закрытый раздел завёл часы')
    const snapshot = w.list.innerHTML
    w.chats = [chatRun('c2', 'Другое', 'Соверши чудо', oneAgent('failed'), 99)]
    assert.equal(w.view.rebuildSoon(), w.view.items().length)
    await wait(500)
    assert.equal(w.list.innerHTML, snapshot, 'закрытый раздел перерисовался')
    assert.equal(w.view.rebuildSoon(), w.view.items().length)
  })

  await check('часы: открытый раздел с живым ходом тикает, перечитывает данные и гасится сам', async () => {
    const before = clock.length
    const w = makeWorld({ chats: [{ id: 'c-run', title: 'Идёт сейчас', messages: [] }] })
    w.panes = [liveChatPane('c-run', { what: 'Читает лог' })]
    await w.open()
    const started = liveTicks(before)
    assert.equal(started.length, 1, 'часы раздела не завелись')
    assert.equal(started[0].ms, 5000, 'интервал перечитывания уехал')
    // Тик перечитывает панели и дорисовывает движение.
    w.panes[0].agentTasks.get(0).what = 'Пишет патч'
    started[0].fn()
    assert.match(w.list.innerHTML, /Пишет патч/, 'тик не перечитал живые данные')
    assert.equal(liveTicks(before).length, 1, 'тик поднял вторые часы')
    // Ход кончился — часы снимают себя сами.
    w.panes = []
    started[0].fn()
    assert.equal(liveTicks(before).length, 0, 'часы остались после конца хода')
    assert.match(w.list.innerHTML, /Пока нет задач/)
  })

  await check('часы: stop() гасит тик и снимает отложенную перерисовку', async () => {
    const before = clock.length
    const w = makeWorld({ chats: [{ id: 'c-run', title: 'Идёт сейчас', messages: [] }] })
    w.panes = [liveChatPane('c-run')]
    await w.open()
    assert.equal(liveTicks(before).length, 1)
    w.view.stop()
    assert.equal(liveTicks(before).length, 0, 'stop() оставил часы идти')
    // Отложенная перерисовка, поставленная до stop(), после него не приходит:
    // окно уходит из раздела, и раздел не должен дёргаться в пустоте.
    const snapshot = w.list.innerHTML
    w.chats = [chatRun('c9', 'Позднее', 'Соверши чудо', oneAgent('done'), 77)]
    w.view.rebuildSoon()
    w.view.stop()
    await wait(500)
    assert.equal(w.list.innerHTML, snapshot, 'после stop() пришла отложенная перерисовка')
  })

  await check('состояние: метка навигации считает активные ходы, а счёт — «Показано»', async () => {
    const w = makeWorld({ chats: [
      chatRun('c-ok', 'Сборка', 'Собери проект', oneAgent('done'), 10),
      chatRun('c-bad', 'Сборка', 'Почини тесты', oneAgent('failed'), 20),
      { id: 'c-run', title: 'Идёт сейчас', messages: [] }
    ], panes: [liveChatPane('c-run')] })
    await w.open()
    assert.equal(w.badges.at(-1), 1, `метка навигации: ${JSON.stringify(w.badges)}`)
    // Новый живой ход — новая метка, без перезахода в раздел.
    w.chats.push({ id: 'c-wait', title: 'Готовится', messages: [] })
    w.panes.push({ chatId: 'c-wait', preparing: true, startedAt: 5, agentTasks: new Map() })
    w.view.rebuild()
    assert.equal(w.badges.at(-1), 2, `метка не догнала второй живой ход: ${JSON.stringify(w.badges)}`)
    w.view.setStatus('all')
    w.view.setQuery('тесты')
    assert.match(w.count.textContent, /Показано 1 · Активных 0 · Всего 1/, `счёт при поиске: ${w.count.textContent}`)
    w.view.setQuery('')
    assert.doesNotMatch(w.count.textContent, /Показано/, 'счёт сузил список, которого нет')
    assert.match(w.count.textContent, /Активных 2 · Всего 4/, `счёт: ${w.count.textContent}`)
  })

  // 5. Безопасность ------------------------------------------------------------
  const HOSTILE = {
    ask: '</script><script>alert(1)</script>',
    agentName: '<img src=x onerror=alert(1)>',
    agentTitle: '"><b onclick="alert(2)">',
    model: "--><script>evil()</script>",
    owner: "<svg/onload='alert(3)'>"
  }

  function hostileWorld(opts = {}) {
    return makeWorld({
      chats: [
        { id: 'c-hostile', title: HOSTILE.owner, messages: [
          { role: 'user', content: HOSTILE.ask, timestamp: 5 },
          { role: 'assistant', timestamp: 10, agentRun: {
            at: 10, ask: HOSTILE.ask, agents: [
              // В карточке от агента видны его задача, а без задачи — имя:
              // держим оба варианта, чтобы проверить обе строки.
              { name: HOSTILE.agentName, title: '', model: HOSTILE.model, outcome: 'done' },
              { name: 'Агент 2', title: HOSTILE.agentTitle, model: HOSTILE.model, outcome: 'done' }
            ] } }
        ] }
      ],
      designs: [{ id: 'd-hostile', name: HOSTILE.owner, messages: [
        { role: 'user', content: HOSTILE.agentTitle, timestamp: 15 },
        { role: 'assistant', timestamp: 20, agentRun: { at: 20, ask: HOSTILE.agentTitle, agents: [{ name: 'Дизайнер', outcome: 'failed' }] } }
      ] }],
      panes: [{ ...liveChatPane('c-live', { agent: HOSTILE.agentName }), currentAsk: HOSTILE.ask }],
      interrupted: () => [{ runId: 'r-hostile', chatId: 'c-live', ask: HOSTILE.model, updatedAt: 30 }],
      ...opts
    })
  }

  await check('безопасность: весь экран с враждебными данными не рождает ни чужого тега, ни атрибута события', async () => {
    const w = hostileWorld()
    await w.open()
    assert.equal(w.view.shown().length, 4, 'враждебные данные потерялись из списка')
    assertInert(w.list.innerHTML, 'список задач')
    // Текст обязан остаться видимым, а не исчезнуть.
    assertReadable(w.list.innerHTML, '&lt;/script&gt;', 'просьба')
    assertReadable(w.list.innerHTML, '&lt;img src=x onerror=alert(1)&gt;', 'имя агента')
    assertReadable(w.list.innerHTML, '--&gt;&lt;script&gt;evil()', 'комментарий-разрыв')
    assert.equal(/<\s*(script|img|svg|b|a)\b/i.test(w.list.innerHTML), false, 'в разметке появился чужой тег')
  })

  await check('безопасность: заголовок хода остаётся текстом — и в атрибуте, и в подписи кнопки', async () => {
    const w = hostileWorld()
    await w.open()
    const cards = scanTags(w.list.innerHTML).filter(tag => tag.name === 'button' && !tag.closing)
    assert.equal(cards.length, 4, 'карточек с заголовком меньше, чем ходов')
    // 1) Имя кнопки может сидеть в `aria-label`. Если он есть — ни сырой
    //    кавычки, ни скобки: иначе заголовок ломает атрибут.
    const names = cards.map(card => card.attrs.find(attr => attr.key === 'aria-label')?.value).filter(Boolean)
    for (const name of names) {
      assert.equal(/[<>"']/.test(name), false, `в aria-label прошли сырые кавычки: ${JSON.stringify(name)}`)
      assert.equal(/^on[a-z]/i.test(name), false, 'aria-label прервался и стал атрибутом события')
    }
    // 2) В любом варианте враждебный заголовок читается как текст: карточка
    //    называет ход его строкой, а не разметкой.
    const texts = w.list.innerHTML.split(/<[^>]*>/).map(decodeEntities)
    for (const title of [HOSTILE.ask, HOSTILE.agentTitle]) {
      const inName = names.some(name => decodeEntities(name).includes(title))
      const inText = texts.some(text => text.includes(title))
      assert.ok(inName || inText, `заголовок «${title}» не читается из карточки текстом`)
    }
    assert.equal(/<\s*(?:b|img|script|svg)\b/i.test(w.list.innerHTML), false, 'из заголовка вырос тег')
  })

  await check('безопасность: имя поверхности с разметкой не проходит в карточку', async () => {
    const container = { innerHTML: '' }
    renderTaskItems(container, [{
      id: 'x', surface: '<img src=x onerror=alert(1)>', title: 'Обычный ход',
      ownerName: '--><script>bad()</script>', status: 'unknown', agents: []
    }], {})
    assertInert(container.innerHTML, 'подпись поверхности')
    assertReadable(container.innerHTML, '&lt;img src=x onerror=alert(1)&gt;', 'подпись поверхности')
    assertReadable(container.innerHTML, '--&gt;&lt;script&gt;bad()', 'имя хозяина')
  })

  await check('безопасность: собственный экранинг модуля (без deps.escapeHtml) тоже бережёт кавычки', async () => {
    const w = hostileWorld({ escapeHtml: null })
    await w.open()
    assert.equal(w.view.shown().length, 4)
    assertInert(w.list.innerHTML, 'список без внешнего escapeHtml')
    assertReadable(w.list.innerHTML, '&#39;alert(3)&#39;', 'апострофы в имени хозяина')
    assertReadable(w.list.innerHTML, '&lt;svg/onload=&#39;alert(3)&#39;&gt;', 'svg/onload')
  })

  await check('безопасность: пустое состояние и строки перевода не становятся разметкой', async () => {
    const w = makeWorld({ t: value => `<b>${value}</b>` })
    await w.open()
    assertInert(w.list.innerHTML, 'пустое состояние с переводом-разметкой')
    assertReadable(w.list.innerHTML, '&lt;b&gt;Пока нет задач&lt;/b&gt;', 'перевод пустого состояния')
    const w2 = makeWorld({ chats: [chatRun('c1', 'Сборка', 'Собери проект', oneAgent('done'), 10)], t: value => `<i>${value}</i>` })
    await w2.open()
    assertInert(w2.list.innerHTML, 'карточка с переводом-разметкой')
    assertReadable(w2.list.innerHTML, '&lt;i&gt;Завершено&lt;/i&gt;', 'подпись состояния')
  })

  await check('безопасность: экранированный текст читается обратно без потерь', async () => {
    const payloads = [HOSTILE.ask, HOSTILE.agentName, HOSTILE.agentTitle, HOSTILE.owner, HOSTILE.model]
    const withAppEscape = hostileWorld()
    await withAppEscape.open()
    assertRoundTrip(withAppEscape.list.innerHTML, payloads, 'экранинг окна')
    const withOwnEscape = hostileWorld({ escapeHtml: null })
    await withOwnEscape.open()
    assertRoundTrip(withOwnEscape.list.innerHTML, payloads, 'собственный экранинг модуля')
    // Экран обязан передавать свой escape в рисование карточек, а не подменять
    // его внутренним: формы у них разные (`&#039;` против `&#39;`).
    assert.match(withAppEscape.list.innerHTML, /&#039;alert\(3\)&#039;/, 'карточка рисовалась не экранингом окна')
    assert.match(withOwnEscape.list.innerHTML, /&#39;alert\(3\)&#39;/, 'откатный экранинг модуля не применился')
  })

  await check('безопасность: очень длинная враждебная строка остаётся текстом', async () => {
    const payload = `${HOSTILE.ask}${'x'.repeat(3000)}${HOSTILE.agentName}`
    const w = makeWorld({ chats: [chatRun('c1', 'Сборка', payload, oneAgent('done'), 10)] })
    await w.open()
    assertInert(w.list.innerHTML, 'длинная просьба')
    // Заголовок карточки обрезается на 240 знаках: хвост с `<img>` не обязан
    // долетать до разметки вообще.
    assert.equal(w.view.items()[0].title.length, 240, 'длинный заголовок не обрезан')
    assert.equal(w.list.innerHTML.includes('&lt;img'), false, 'хвост длинной строки попал в разметку')
    // Запрос режется до 200 знаков: префикс своей же просьбы находится,
    // мусор такой же длины — нет.
    assert.equal(w.view.setQuery(payload.slice(0, 150)), 1, 'префикс длинной просьбы не нашёлся')
    assert.equal(w.view.setQuery(`нет-такого${'з'.repeat(3000)}`), 0, 'длинный мусор что-то нашёл')
    assertInert(w.list.innerHTML, 'пустой результат длинного запроса')
    assert.equal(w.view.setQuery(payload), 1, 'длинный запрос не нашёл свой же заголовок')
    assertInert(w.list.innerHTML, 'карточка после длинного запроса')
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => {
  failed++
  console.error('ПРОВАЛ прогона', error)
  console.log(JSON.stringify({ ok: false, checks: total, failed }))
  process.exitCode = 1
}).finally(() => {
  stopAll()
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
})
