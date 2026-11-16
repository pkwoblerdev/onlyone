'use strict'
// Ф-2: дерево связанных чатов. Модель проверяется напрямую, представление —
// на маленьком DOM-двойнике: клики, клавиатура, фокус и перезапуск.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const model = require('../src/renderer/fork-tree-model.js')
const { create } = require('../src/renderer/fork-tree-view.js')

// Дерево — чтение уже сохранённых связей: ни модели, ни сети, ни IPC.
for (const file of ['fork-tree-model.js', 'fork-tree-view.js']) {
  const code = fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8')
  assert.equal(/electronAPI|ipcRenderer|\bfetch\s*\(|sendMessage/.test(code), false, file + ' must stay offline')
}

function chat (id, title, parentId, extra = {}) {
  return {
    id,
    title,
    updatedAt: extra.updatedAt ?? 1,
    messages: [],
    ...(parentId ? { fork: { version: 1, kind: 'text-snapshot', parentChatId: parentId } } : {}),
    ...extra
  }
}

// ── Модель ────────────────────────────────────────────────────────────────
{
  const chats = [
    chat('root', 'Root', null, { updatedAt: 10 }),
    chat('a', 'Child A', 'root', { updatedAt: 9 }),
    chat('b', 'Child B', 'root', { updatedAt: 8 }),
    chat('a1', 'Grand', 'a', { updatedAt: 7 })
  ]
  const tree = model.build(chats)
  assert.equal(tree.roots.length, 1)
  assert.equal(tree.roots[0].id, 'root')
  assert.equal(tree.linkedCount, 4)
  assert.deepEqual(model.visibleRows(tree, new Set()).map(row => [row.id, row.depth]), [
    ['root', 0], ['a', 1], ['a1', 2], ['b', 1]
  ])
  assert.deepEqual(model.pathOf(tree, 'a1').map(item => item.id), ['root', 'a'])
  assert.equal(model.visibleRows(tree, new Set(['a'])).map(row => row.id).join(','), 'root,a,b')
  console.log('PASS: parent/children, depth, order, collapse')
}

// Свёрнуто/развёрнуто — одна настройка отображения, повтор безопасен.
{
  let collapsed = new Set()
  collapsed = model.toggleCollapsed(collapsed, 'a')
  assert.equal(collapsed.has('a'), true)
  collapsed = model.toggleCollapsed(collapsed, 'a')
  assert.equal(collapsed.has('a'), false)
  assert.equal(model.toggleCollapsed(new Set(['a', 'a']), 'a').has('a'), false, 'duplicate ids in a set do not stick')
  assert.deepEqual([...model.decodeCollapsed('{"bad":1}')], [])
  assert.deepEqual([...model.decodeCollapsed('not json')], [])
  assert.deepEqual([...model.decodeCollapsed(null)], [])
  assert.deepEqual([...model.decodeCollapsed([1, null, '', 'ok', 'ok'])], ['ok'])
  assert.equal(model.encodeCollapsed(new Set(['b', 'a', 'a'])), '["a","b"]')
  assert.deepEqual([...model.decodeCollapsed(model.encodeCollapsed(new Set(['a', 'b'])))], ['a', 'b'])
  console.log('PASS: expansion toggle is idempotent, serialization is tolerant')
}

// Повторные записи переписки не удваивают строки.
{
  const chats = [chat('root', 'Root'), chat('root', 'Root duplicate'), chat('kid', 'Kid', 'root')]
  const tree = model.build(chats)
  assert.equal(tree.order.length, 2)
  assert.deepEqual(tree.duplicates, ['root'])
  assert.equal(model.visibleRows(tree, new Set()).length, 2)
  console.log('PASS: duplicate conversation records are ignored once')
}

// Петли и ссылка на себя: список конечен, все чаты на месте.
{
  const chats = [
    chat('a', 'A', 'b'),
    chat('b', 'B', 'a'),
    chat('c', 'C', 'a'),
    chat('self', 'Self', 'self')
  ]
  const tree = model.build(chats)
  assert.equal(tree.order.length, 4, 'no chat is lost')
  assert.equal(tree.nodes.get('a').cycle, true)
  assert.equal(tree.nodes.get('b').cycle, true)
  assert.equal(tree.nodes.get('c').cycle, false, 'descendant of a cycle is not itself a cycle')
  assert.equal(tree.nodes.get('self').selfParent, true)
  const rows = model.visibleRows(tree, new Set())
  assert.equal(rows.length, 4)
  assert.equal(rows.find(row => row.id === 'a').cycle, true)
  assert.equal(rows.find(row => row.id === 'self').cycle, true)
  assert.equal(rows.find(row => row.id === 'self').parentAvailable, false)
  console.log('PASS: cycles and self-links stay finite and explained')
}

// Удалённый родитель: ребёнок остаётся, связь помечена, переход недоступен.
{
  const chats = [chat('kid', 'Kid', 'gone'), chat('grand', 'Grand', 'kid')]
  const tree = model.build(chats)
  const kid = tree.nodes.get('kid')
  assert.equal(kid.missingParent, true)
  assert.equal(tree.roots.length, 1)
  assert.equal(tree.roots[0].id, 'kid')
  assert.equal(tree.nodes.get('grand').parent.id, 'kid', 'deleting a parent does not detach its grandchildren')
  assert.deepEqual(model.parentState(chats, 'kid'), { kind: 'deleted', id: 'gone' })
  const rows = model.visibleRows(tree, new Set())
  assert.deepEqual(rows.map(row => row.id), ['kid', 'grand'])
  assert.equal(rows[0].missingParent, true)
  console.log('PASS: deleted parent is marked, children and grandchildren survive')
}

// Архивный родитель остаётся родителем и помечается.
{
  const chats = [
    chat('root', 'Root', null, { archived: true }),
    chat('kid', 'Kid', 'root')
  ]
  const tree = model.build(chats)
  assert.equal(tree.nodes.get('root').archived, true)
  assert.equal(tree.nodes.get('kid').archivedParent, true)
  const rows = model.visibleRows(tree, new Set())
  assert.equal(rows[0].archived, true)
  assert.equal(rows[1].archivedParent, true)
  assert.equal(rows[1].parentAvailable, true, 'archived parent is still openable')
  assert.deepEqual(model.parentState(chats, 'kid'), { kind: 'ok', id: 'root', title: 'Root', archived: true })
  console.log('PASS: archived parent is marked without detaching children')
}

// Поиск дочернего чата отдаёт путь к родителю.
{
  const chats = [
    chat('root', 'Project Alpha'),
    chat('mid', 'Middle step', 'root'),
    chat('leaf', 'Fix the parser', 'mid'),
    chat('other', 'Other branch')
  ]
  const found = model.search(chats, 'PARSER')
  assert.equal(found.length, 1)
  assert.equal(found[0].id, 'leaf')
  assert.deepEqual(found[0].path.map(item => item.title), ['Project Alpha', 'Middle step'])
  assert.deepEqual(model.search(chats, '   '), [])
  assert.deepEqual(model.search(chats, 'zzz'), [])
  assert.equal(model.search(chats, 'a', { limit: 1 }).length, 1)
  assert.equal(model.search([], 'a').length, 0)
  console.log('PASS: search finds a child and carries the parent path')
}

// Длинное название не режется моделью и не теряется в поиске.
{
  const long = 'Очень длинное название ветки — ' + 'слово '.repeat(80)
  const chats = [chat('root', 'Root'), chat('kid', long.trim(), 'root')]
  const tree = model.build(chats)
  assert.equal(tree.nodes.get('kid').title, long.trim())
  const rows = model.visibleRows(tree, new Set())
  assert.equal(rows[1].title.length, long.trim().length)
  assert.equal(model.search(chats, 'Очень длинное')[0].id, 'kid')
  console.log('PASS: long titles are preserved by the model')
}

// ── Представление на маленьком DOM ───────────────────────────────────────
function fakeDom () {
  class ClassList {
    constructor (el) { this.el = el }
    set () { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)) }
    add (...names) { const next = this.set(); names.forEach(name => next.add(name)); this.el.className = [...next].join(' ') }
    remove (...names) { const next = this.set(); names.forEach(name => next.delete(name)); this.el.className = [...next].join(' ') }
    contains (name) { return this.set().has(name) }
    toggle (name, force) {
      const next = this.set()
      const on = force === undefined ? !next.has(name) : Boolean(force)
      if (on) next.add(name); else next.delete(name)
      this.el.className = [...next].join(' ')
      return on
    }
  }
  class Element {
    constructor (tag, doc) {
      this.tagName = String(tag).toUpperCase()
      this.ownerDocument = doc
      this.children = []
      this.parentNode = null
      this.dataset = {}
      this.attributes = new Map()
      this.listeners = new Map()
      this.style = { values: {}, setProperty (name, value) { this.values[name] = value } }
      this.classList = new ClassList(this)
      this.className = ''
      this._text = ''
      this.disabled = false
      this.hidden = false
      this.tabIndex = -1
      this.value = ''
      this.title = ''
      this.type = ''
      this.autocomplete = ''
      this.placeholder = ''
    }
    get textContent () { return this._text + this.children.map(child => child.textContent).join('') }
    set textContent (value) { this._text = String(value == null ? '' : value); this.children.forEach(child => { child.parentNode = null }); this.children = [] }
    get firstChild () { return this.children[0] || null }
    appendChild (child) { child.parentNode = this; this.children.push(child); return child }
    removeChild (child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      child.parentNode = null
      return child
    }
    setAttribute (name, value) { this.attributes.set(name, String(value)) }
    getAttribute (name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
    removeAttribute (name) { this.attributes.delete(name) }
    addEventListener (type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(handler)
    }
    dispatchEvent (event) {
      event.target = event.target || this
      for (const handler of this.listeners.get(event.type) || []) handler(event)
      if (event._stop) return event
      if (this.parentNode) this.parentNode.dispatchEvent(event)
      return event
    }
    closest (selector) {
      if (!selector.startsWith('.')) return null
      const name = selector.slice(1)
      let node = this
      while (node) {
        if (node.classList && node.classList.contains(name)) return node
        node = node.parentNode
      }
      return null
    }
    querySelectorAll (selector) {
      const attr = /^\[data-chat-id="(.*)"\]$/.exec(selector)
      const name = selector.startsWith('.') ? selector.slice(1) : null
      const matches = child => attr
        ? child.dataset.chatId === attr[1]
        : (name ? child.classList.contains(name) : true)
      const found = []
      const walk = node => {
        for (const child of node.children) {
          if (matches(child)) found.push(child)
          walk(child)
        }
      }
      walk(this)
      return found
    }
    querySelector (selector) { return this.querySelectorAll(selector)[0] || null }
    focus () { this.ownerDocument.activeElement = this }
  }
  const document = {
    activeElement: null,
    createElement (tag) { return new Element(tag, document) },
    createElementNS (_ns, tag) { return new Element(tag, document) }
  }
  return document
}

function fire (element, type, props = {}) {
  const event = {
    type,
    target: element,
    detail: 1,
    key: '',
    clientX: 0,
    clientY: 0,
    defaultPrevented: false,
    _stop: false,
    preventDefault () { this.defaultPrevented = true },
    stopPropagation () { this._stop = true },
    ...props
  }
  element.dispatchEvent(event)
  return event
}

function fakeStorage () {
  const values = new Map()
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values
  }
}

{
  const document = fakeDom()
  const container = document.createElement('div')
  const storage = fakeStorage()
  const chats = [
    chat('root', 'Root', null, { updatedAt: 10 }),
    chat('a', 'Child A', 'root', { updatedAt: 9 }),
    chat('b', 'Child B', 'root', { updatedAt: 8 }),
    chat('a1', 'Grand', 'a', { updatedAt: 7 })
  ]
  const opened = []
  let activeId = 'a'
  const view = create({
    container,
    document,
    t: text => text,
    storage,
    getConversations: () => chats,
    getActiveId: () => activeId,
    selectChat: id => { opened.push(id) }
  })

  view.render()
  assert.equal(container.hidden, false)
  assert.equal(container.querySelector('.fork-tree-count').textContent, '4')
  assert.equal(container.querySelectorAll('.fork-tree-row').length, 4)
  const rootRow = container.querySelector('[data-chat-id="root"]')
  const aRow = container.querySelector('[data-chat-id="a"]')
  assert.equal(rootRow.getAttribute('aria-expanded'), 'true')
  assert.equal(aRow.classList.contains('active'), true, 'active row follows the open chat')
  assert.equal(rootRow.children[0].tagName, 'BUTTON', 'parent has a caret')

  // Клик по строке открывает чат; второй клик двойного щелчка — не второй переход.
  fire(aRow, 'click', { detail: 1 })
  fire(aRow, 'click', { detail: 2 })
  assert.deepEqual(opened, ['a'], 'double click activates once')

  // Кнопка раскрытия: один клик сворачивает, второй клик двойного — нет.
  const rootCaret = rootRow.children[0]
  fire(rootCaret, 'click', { detail: 1 })
  assert.equal(container.querySelectorAll('.fork-tree-row').length, 1, 'collapsed branch hides children')
  fire(rootCaret, 'click', { detail: 2 })
  assert.equal(container.querySelectorAll('.fork-tree-row').length, 1, 'double click does not toggle twice')

  // Клавиатура: вниз, вправо/влево, ввод.
  const collapsedRoot = container.querySelector('[data-chat-id="root"]')
  view.focus('root')
  fire(collapsedRoot, 'keydown', { key: 'ArrowRight' })
  assert.equal(container.querySelectorAll('.fork-tree-row').length, 4, 'ArrowRight expands a collapsed branch')
  assert.equal(document.activeElement.dataset.chatId, 'root')
  fire(container.querySelector('[data-chat-id="root"]'), 'keydown', { key: 'ArrowDown' })
  assert.equal(document.activeElement.dataset.chatId, 'a', 'ArrowDown moves focus')
  fire(container.querySelector('[data-chat-id="a"]'), 'keydown', { key: 'ArrowLeft' })
  assert.equal(container.querySelectorAll('.fork-tree-row').length, 3, 'ArrowLeft collapses an expanded branch')
  fire(container.querySelector('[data-chat-id="a"]'), 'keydown', { key: 'ArrowRight' })
  assert.equal(container.querySelectorAll('.fork-tree-row').length, 4, 'ArrowRight expands again')
  fire(container.querySelector('[data-chat-id="a"]'), 'keydown', { key: 'ArrowLeft' })
  fire(container.querySelector('[data-chat-id="a"]'), 'keydown', { key: 'ArrowLeft' })
  assert.equal(document.activeElement.dataset.chatId, 'root', 'ArrowLeft on a leaf goes to its parent')
  fire(container.querySelector('[data-chat-id="root"]'), 'keydown', { key: 'Enter' })
  assert.deepEqual(opened, ['a', 'root'], 'Enter opens the focused chat')

  // Поиск: дочерний чат с путём к родителю.
  view.setQuery('GRAND')
  const found = container.querySelectorAll('.fork-tree-row')
  assert.equal(found.length, 1)
  assert.equal(found[0].dataset.chatId, 'a1')
  assert.equal(found[0].querySelector('.fork-tree-path').textContent, 'Root / Child A')
  view.setQuery('zzz')
  assert.equal(container.querySelectorAll('.fork-tree-row').length, 0)
  assert.equal(container.querySelector('.fork-tree-hint').hidden, false)
  view.setQuery('')
  assert.equal(container.querySelectorAll('.fork-tree-row').length, 3, 'child a is still collapsed')

  // Длинное название остаётся целиком в подсказке строки.
  const long = 'Длинное название '.repeat(30)
  chats.push(chat('long', long.trim(), 'root', { updatedAt: 6 }))
  view.render()
  const longRow = container.querySelector('[data-chat-id="long"]')
  assert.equal(longRow.querySelector('.fork-tree-title').title, long.trim())

  // Раскрытие сохраняется: второй экземпляр (перезапуск) читает ту же настройку.
  view.toggle('root')
  assert.equal(view.isCollapsed('root'), true)
  const restarted = create({
    container: document.createElement('div'),
    document,
    t: text => text,
    storage,
    getConversations: () => chats,
    getActiveId: () => 'a',
    selectChat: () => {}
  })
  restarted.render()
  assert.equal(restarted.isCollapsed('root'), true, 'collapsed branch survives restart')
  assert.deepEqual(restarted.rows().map(row => row.id), ['root'], 'restarted view keeps the branch closed')

  // Без связей секция не занимает место.
  const emptyContainer = document.createElement('div')
  const empty = create({
    container: emptyContainer,
    document,
    t: text => text,
    storage,
    getConversations: () => [chat('solo', 'Solo')],
    getActiveId: () => 'solo',
    selectChat: () => {}
  })
  empty.render()
  assert.equal(emptyContainer.hidden, true)
  assert.equal(emptyContainer.children.length, 0)

  // Переход к родителю и пометки удалённого/архивного родителя — в строках.
  const statusDocument = fakeDom()
  const statusContainer = statusDocument.createElement('div')
  const statusChats = [
    chat('orphan', 'Orphan', 'gone'),
    chat('arch', 'Archive root', null, { archived: true }),
    chat('arch-child', 'Archived child', 'arch')
  ]
  const jumps = []
  const statusView = create({
    container: statusContainer,
    document: statusDocument,
    t: text => text,
    storage: fakeStorage(),
    getConversations: () => statusChats,
    getActiveId: () => 'orphan',
    selectChat: id => jumps.push(id)
  })
  statusView.render()
  const orphanRow = statusContainer.querySelector('[data-chat-id="orphan"]')
  assert.equal(orphanRow.querySelector('.fork-tree-badge').textContent, 'родитель удалён')
  const orphanParent = orphanRow.children[orphanRow.children.length - 1]
  assert.equal(orphanParent.disabled, true, 'deleted parent cannot be opened')
  const archChildRow = statusContainer.querySelector('[data-chat-id="arch-child"]')
  assert.equal(archChildRow.querySelector('.fork-tree-badge').textContent, 'родитель в архиве')
  assert.equal(statusContainer.querySelector('[data-chat-id="arch"]').querySelector('.fork-tree-badge').textContent, 'в архиве')
  const archParent = archChildRow.children[archChildRow.children.length - 1]
  fire(archParent, 'click', { detail: 1 })
  assert.deepEqual(jumps, ['arch'], 'parent button jumps to the parent chat')
  console.log('PASS: view rows, active row, double clicks, keyboard/focus, search path, restart')
}

console.log('PASS: fork tree model and view')
