/* Дерево связанных чатов — чистая модель (Ф-2).
 *
 * Единственный источник связи — поле переписки `chat.fork.parentChatId`,
 * которое уже пишет `chat-forks.js`. Второй базы статусов здесь нет: модель
 * только читает переписку и раскладывает её в лес. Раскрытие — настройка
 * отображения (ключ в localStorage, как у папок проектов), а не статус чата.
 *
 * Всё, что может прийти с диска, считается недоверенным: повторные id,
 * ссылки на удалённого родителя, петли, ссылка на себя. Такие связи не
 * ломают список — чат остаётся строкой, связь помечается.
 *
 * Модуль ничего не рисует и никого не зовёт: ни модели, ни IPC.
 */
(function (root) {
  'use strict'

  const COLLAPSED_KEY = '1code_fork_tree_collapsed'
  const MAX_STORED_IDS = 5000

  function titleOf (chat) {
    return typeof chat?.title === 'string' ? chat.title.trim() : ''
  }

  function parentIdOf (chat) {
    const value = chat && chat.fork && chat.fork.parentChatId
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

  function timeOf (chat) {
    const value = Number(chat?.updatedAt || chat?.createdAt)
    return Number.isFinite(value) ? value : 0
  }

  // Стабильный порядок: свежие выше, при равенстве — по названию. Без
  // localeCompare, чтобы порядок не зависел от локали машины.
  function compare (a, b) {
    const byTime = timeOf(b.chat) - timeOf(a.chat)
    if (byTime) return byTime
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0
  }

  // Петли находятся за один проход по лесу, а не шагом вверх для каждого узла.
  // Прежний `inCycle` шёл от узла до корня: на цепочке из n форков сборка
  // становилась O(n²) (замер 01.11: 4500 — ~2 с, 9000 — ~11 с чистого CPU).
  // Здесь каждый узел обходится ровно один раз: идём по ссылкам вверх, помечая
  // текущий путь; замкнулись внутри пути — это цикл, дошли до уже обработанного
  // или висячей ссылки — путь не на цикле.
  function findCycleIds (nodes) {
    const onCycle = new Set()
    const done = new Set()
    for (const startId of nodes.keys()) {
      if (done.has(startId)) continue
      const path = []
      const index = new Map()
      let current = startId
      while (current && !done.has(current) && !index.has(current)) {
        index.set(current, path.length)
        path.push(current)
        const next = nodes.get(current)?.parentId
        if (!next || next === current || !nodes.has(next)) { current = null; break }
        current = next
      }
      // Замкнулись на узле текущего пути — цикл от его первого появления до конца.
      if (current && index.has(current)) {
        for (let i = index.get(current); i < path.length; i++) onCycle.add(path[i])
      }
      for (const id of path) done.add(id)
    }
    return onCycle
  }

  function build (conversations) {
    const list = Array.isArray(conversations) ? conversations : []
    const byId = new Map()
    const duplicates = []

    for (const chat of list) {
      if (!chat || typeof chat.id !== 'string' || !chat.id) continue
      if (byId.has(chat.id)) { duplicates.push(chat.id); continue }
      byId.set(chat.id, chat)
    }

    const nodes = new Map()
    for (const [id, chat] of byId) {
      nodes.set(id, {
        id,
        chat,
        title: titleOf(chat),
        parentId: parentIdOf(chat),
        parent: null,
        children: [],
        depth: 0,
        missingParent: false,
        archivedParent: false,
        selfParent: false,
        cycle: false,
        archived: chat.archived === true
      })
    }

    // Одна связь на чат: родитель либо есть, либо связь помечена и чат
    // остаётся корнем. Половинчатых связей список не знает.
    const cycleIds = findCycleIds(nodes)
    for (const node of nodes.values()) {
      if (!node.parentId) continue
      if (node.parentId === node.id) { node.selfParent = true; continue }
      const parent = nodes.get(node.parentId)
      if (!parent) { node.missingParent = true; continue }
      if (cycleIds.has(node.id)) { node.cycle = true; continue }
      node.parent = parent
      parent.children.push(node)
    }

    const roots = [...nodes.values()].filter(node => !node.parent)
    const order = []
    // Явный стек, а не рекурсия: цепочка в тысячи форков иначе съедает стек.
    roots.sort(compare)
    const stack = roots.map(node => ({ node, depth: 0 })).reverse()
    while (stack.length) {
      const { node, depth } = stack.pop()
      node.depth = depth
      order.push(node)
      node.children.sort(compare)
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1 })
    }

    // Дети архивного родителя остаются детьми: архив — метка, не удаление.
    for (const node of nodes.values()) {
      if (node.parent) node.archivedParent = node.parent.archived === true
    }

    const linkedCount = order.filter(node => node.parentId || node.children.length).length
    return { nodes, roots, order, duplicates, linkedCount }
  }

  function rowOf (node, depth, hasChildren, expanded, extra) {
    return {
      id: node.id,
      title: node.title,
      depth,
      hasChildren,
      expanded,
      parentId: node.parent ? node.parent.id : node.parentId,
      parentAvailable: Boolean(node.parent),
      parentTitle: node.parent ? node.parent.title : '',
      missingParent: node.missingParent,
      archivedParent: node.archivedParent,
      archived: node.archived,
      cycle: node.cycle || node.selfParent,
      ...extra
    }
  }

  // Видимые строки дерева: свёрнутая ветка не отдаёт детей. Возвращает
  // описания, а не DOM, — их проверяет тест и рисует представление.
  function visibleRows (tree, collapsed) {
    const closed = decodeCollapsed(collapsed)
    const rows = []
    // Тот же порядок, что у рекурсивного обхода, но глубина не ограничена стеком.
    const stack = tree.roots.map(node => ({ node, depth: 0 })).reverse()
    while (stack.length) {
      const { node, depth } = stack.pop()
      const hasChildren = node.children.length > 0
      const expanded = hasChildren && !closed.has(node.id)
      rows.push(rowOf(node, depth, hasChildren, expanded))
      if (expanded) {
        for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1 })
      }
    }
    return rows
  }

  function pathOf (tree, id) {
    const node = tree.nodes.get(id)
    if (!node) return []
    const path = []
    const seen = new Set([id])
    let current = node.parent
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      path.unshift({ id: current.id, title: current.title })
      current = current.parent
    }
    return path
  }

  // Поиск дочернего чата: путь к родителю едет вместе с находкой, иначе
  // одинаковые названия веток не различить.
  function search (conversations, query, options = {}) {
    const needle = String(query == null ? '' : query).trim().toLowerCase()
    if (!needle) return []
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50
    const tree = build(conversations)
    const rows = []
    for (const node of tree.order) {
      if (!node.title.toLowerCase().includes(needle)) continue
      rows.push(rowOf(node, node.depth, false, false, { search: true, path: pathOf(tree, node.id) }))
      if (rows.length >= limit) break
    }
    return rows
  }

  function parentState (conversations, id) {
    const tree = build(conversations)
    const node = typeof id === 'string' ? tree.nodes.get(id) : null
    if (!node || !node.parentId) return { kind: 'none' }
    if (node.parent) return { kind: 'ok', id: node.parent.id, title: node.parent.title, archived: node.parent.archived }
    if (node.missingParent) return { kind: 'deleted', id: node.parentId }
    return { kind: 'broken', id: node.parentId }
  }

  function decodeCollapsed (raw) {
    let value = raw
    if (typeof raw === 'string') {
      if (!raw.trim()) return new Set()
      try { value = JSON.parse(raw) } catch { return new Set() }
    }
    const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : null
    const out = new Set()
    if (!list) return out
    for (const id of list) {
      if (typeof id === 'string' && id && id.length <= 200 && out.size < MAX_STORED_IDS) out.add(id)
    }
    return out
  }

  function encodeCollapsed (collapsed) {
    return JSON.stringify([...decodeCollapsed(collapsed)].sort())
  }

  function toggleCollapsed (collapsed, id) {
    const next = decodeCollapsed(collapsed)
    if (typeof id !== 'string' || !id) return next
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  const api = Object.freeze({
    COLLAPSED_KEY,
    build,
    visibleRows,
    pathOf,
    search,
    parentState,
    decodeCollapsed,
    encodeCollapsed,
    toggleCollapsed
  })

  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneForkTreeModel = api
})(typeof window === 'object' ? window : globalThis)
