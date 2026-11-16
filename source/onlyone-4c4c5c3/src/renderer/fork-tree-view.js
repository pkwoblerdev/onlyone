/* Представление дерева связанных чатов в боковике (Ф-2).
 *
 * Модель — `fork-tree-model.js`; здесь только DOM, клавиатура и сохранение
 * раскрытия как настройки отображения. Никаких новых запросов и никакого
 * обращения к модели — переходы идут через selectChat, который даёт app.js.
 *
 * Строка дерева — не чат в списке проектов, а его место в ветке форков:
 * родитель, дети, пометка удалённого/архивного родителя и путь при поиске.
 */
(function (root) {
  'use strict'

  const model = typeof module === 'object' && module.exports
    ? require('./fork-tree-model.js')
    : root.OnlyoneForkTreeModel

  function create (options = {}) {
    const document = options.document || root.document
    const container = options.container
    const t = options.t || (text => text)
    const storage = options.storage === undefined ? root.localStorage : options.storage
    const getConversations = options.getConversations || (() => [])
    const getActiveId = options.getActiveId || (() => null)
    const selectChat = options.selectChat || (() => {})
    const openContextMenu = options.openContextMenu || null
    const openParentChat = options.onOpenParent || selectChat

    const state = {
      collapsed: loadCollapsed(),
      query: '',
      rows: [],
      focusId: null,
      tree: null
    }
    const rowEls = new Map()
    let head = null
    let countEl = null
    let searchInput = null
    let list = null
    let hint = null

    function loadCollapsed () {
      try {
        return model.decodeCollapsed(storage?.getItem?.(model.COLLAPSED_KEY) ?? '')
      } catch {
        return new Set()
      }
    }

    function persist () {
      try { storage?.setItem?.(model.COLLAPSED_KEY, model.encodeCollapsed(state.collapsed)) } catch {}
    }

    function displayTitle (title) {
      const value = typeof title === 'string' ? title.trim() : ''
      if (!value) return t('Новый диалог')
      return value === 'Новый диалог' || value === 'New chat' ? t('Новый диалог') : value
    }

    function icon (d) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('class', 'icon')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d)
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.4')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      svg.appendChild(path)
      return svg
    }

    function buildSkeleton () {
      if (head || !container) return
      head = document.createElement('div')
      head.className = 'fork-tree-head'
      const title = document.createElement('span')
      title.className = 'fork-tree-title'
      title.textContent = t('Связанные чаты')
      countEl = document.createElement('span')
      countEl.className = 'fork-tree-count'
      head.appendChild(title)
      head.appendChild(countEl)

      const searchWrap = document.createElement('div')
      searchWrap.className = 'fork-tree-search-wrap'
      searchInput = document.createElement('input')
      searchInput.type = 'search'
      searchInput.className = 'fork-tree-search'
      searchInput.autocomplete = 'off'
      searchInput.placeholder = t('Найти чат в дереве')
      searchInput.setAttribute('aria-label', t('Найти чат в дереве'))
      searchInput.addEventListener('input', () => {
        state.query = String(searchInput.value || '')
        renderRows()
      })
      searchInput.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        searchInput.value = ''
        state.query = ''
        renderRows()
      })
      searchWrap.appendChild(searchInput)

      list = document.createElement('div')
      list.className = 'fork-tree-list'
      list.setAttribute('role', 'tree')
      list.setAttribute('aria-label', t('Связанные чаты'))
      list.setAttribute('aria-multiselectable', 'false')
      list.addEventListener('keydown', onKeyDown)

      hint = document.createElement('div')
      hint.className = 'fork-tree-hint'
      hint.hidden = true

      container.appendChild(head)
      container.appendChild(searchWrap)
      container.appendChild(list)
      container.appendChild(hint)
    }

    function badgeOf (row) {
      if (row.missingParent) return { key: 'родитель удалён', cls: 'is-missing' }
      if (row.cycle) return { key: 'связь повреждена', cls: 'is-broken' }
      if (row.archivedParent) return { key: 'родитель в архиве', cls: 'is-archived' }
      if (row.archived) return { key: 'в архиве', cls: 'is-archived' }
      return null
    }

    function makeRow (row, activeId, focusId) {
      const active = row.id === activeId
      const el = document.createElement('div')
      el.className = 'fork-tree-row' + (active ? ' active' : '') +
        (row.missingParent ? ' missing-parent' : '') + (row.search ? ' search-result' : '')
      el.dataset.chatId = row.id
      el.tabIndex = row.id === focusId ? 0 : -1
      el.setAttribute('role', 'treeitem')
      el.setAttribute('aria-level', String(row.depth + 1))
      el.setAttribute('aria-selected', active ? 'true' : 'false')
      if (row.hasChildren) el.setAttribute('aria-expanded', row.expanded ? 'true' : 'false')
      el.style.setProperty('--fork-depth', String(row.depth))

      if (row.hasChildren) {
        const caret = document.createElement('button')
        caret.type = 'button'
        caret.className = 'fork-tree-caret'
        caret.tabIndex = -1
        caret.setAttribute('aria-label', row.expanded ? t('Свернуть ветку') : t('Развернуть ветку'))
        caret.setAttribute('aria-expanded', row.expanded ? 'true' : 'false')
        caret.appendChild(icon('M3.5 5.5L8 10l4.5-4.5'))
        caret.addEventListener('click', event => {
          event.preventDefault()
          event.stopPropagation()
          if (event.detail > 1) return
          toggle(row.id)
        })
        el.appendChild(caret)
      } else {
        const spacer = document.createElement('span')
        spacer.className = 'fork-tree-caret-spacer'
        spacer.setAttribute('aria-hidden', 'true')
        el.appendChild(spacer)
      }

      const main = document.createElement('div')
      main.className = 'fork-tree-main'
      const title = document.createElement('span')
      title.className = 'fork-tree-title'
      title.textContent = displayTitle(row.title)
      // Длинное название обрезается CSS, но целиком остаётся в подсказке.
      title.title = title.textContent
      main.appendChild(title)
      if (row.search && row.path && row.path.length) {
        const path = document.createElement('span')
        path.className = 'fork-tree-path'
        path.textContent = row.path.map(item => displayTitle(item.title)).join(' / ')
        main.appendChild(path)
      }
      el.appendChild(main)

      const badge = badgeOf(row)
      if (badge) {
        const mark = document.createElement('span')
        mark.className = 'fork-tree-badge ' + badge.cls
        mark.textContent = t(badge.key)
        el.appendChild(mark)
      }

      if (row.parentId) {
        const parent = document.createElement('button')
        parent.type = 'button'
        parent.className = 'fork-tree-parent'
        parent.tabIndex = -1
        parent.disabled = !row.parentAvailable
        const label = row.parentAvailable ? t('К родительскому чату') : t('Родительский чат недоступен')
        parent.setAttribute('aria-label', label)
        parent.title = label
        parent.appendChild(icon('M8 13V3.6M4.8 6.8L8 3.6l3.2 3.2'))
        parent.addEventListener('click', event => {
          event.preventDefault()
          event.stopPropagation()
          if (!row.parentAvailable || event.detail > 1) return
          openParentChat(row.parentId)
        })
        el.appendChild(parent)
      }

      el.addEventListener('click', event => {
        // Двойной щелчок — тот же один переход, а не второй.
        if (event.detail > 1) return
        selectChat(row.id)
      })
      el.addEventListener('contextmenu', event => {
        event.preventDefault()
        event.stopPropagation()
        if (!openContextMenu) return
        const items = [{ label: t('Открыть чат'), onPick: () => selectChat(row.id) }]
        if (row.parentId) {
          items.push({
            label: row.parentAvailable ? t('К родительскому чату') : t('Родительский чат недоступен'),
            disabled: !row.parentAvailable,
            onPick: () => openParentChat(row.parentId)
          })
        }
        if (row.hasChildren) {
          items.push({
            label: row.expanded ? t('Свернуть ветку') : t('Развернуть ветку'),
            onPick: () => toggle(row.id)
          })
        }
        openContextMenu(event.clientX, event.clientY, items)
      })

      rowEls.set(row.id, el)
      return el
    }

    function renderRows () {
      if (!list || !state.tree) return
      while (list.firstChild) list.removeChild(list.firstChild)
      rowEls.clear()

      const activeId = getActiveId()
      state.rows = state.query
        ? model.search(getConversations(), state.query)
        : model.visibleRows(state.tree, state.collapsed)

      const hasFocus = state.rows.some(row => row.id === state.focusId)
      const focusId = hasFocus
        ? state.focusId
        : (state.rows.find(row => row.id === activeId) || state.rows[0] || {}).id || null

      for (const row of state.rows) list.appendChild(makeRow(row, activeId, focusId))

      hint.hidden = state.rows.length > 0
      hint.textContent = state.rows.length ? '' : t('Ничего не найдено')
    }

    function render () {
      if (!container || !document) return
      const tree = model.build(getConversations())
      state.tree = tree
      // Нет ни одной связи — секции нет вовсе: пустой заголовок в боковике
      // дороже, чем отсутствие дерева.
      if (!tree.linkedCount) {
        container.hidden = true
        container.textContent = ''
        head = null; countEl = null; searchInput = null; list = null; hint = null
        rowEls.clear()
        state.rows = []
        state.query = ''
        return
      }
      container.hidden = false
      buildSkeleton()
      countEl.textContent = String(tree.linkedCount)
      renderRows()
    }

    function focusRow (id) {
      const el = rowEls.get(id)
      if (!el) return
      for (const [rowId, rowEl] of rowEls) rowEl.tabIndex = rowId === id ? 0 : -1
      state.focusId = id
      el.focus()
    }

    function focusAt (index) {
      const row = state.rows[index]
      if (row) focusRow(row.id)
    }

    function toggle (id) {
      state.collapsed = model.toggleCollapsed(state.collapsed, id)
      persist()
      renderRows()
      focusRow(id)
    }

    function onKeyDown (event) {
      const el = event.target?.closest?.('.fork-tree-row')
      if (!el) return
      const id = el.dataset.chatId
      const index = state.rows.findIndex(row => row.id === id)
      if (index < 0) return
      const row = state.rows[index]

      if (event.key === 'ArrowDown') { event.preventDefault(); focusAt(Math.min(state.rows.length - 1, index + 1)) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); focusAt(Math.max(0, index - 1)) }
      else if (event.key === 'Home') { event.preventDefault(); focusAt(0) }
      else if (event.key === 'End') { event.preventDefault(); focusAt(state.rows.length - 1) }
      else if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (row.hasChildren && !row.expanded) toggle(row.id)
        else if (row.hasChildren && row.expanded) focusAt(index + 1)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (row.hasChildren && row.expanded) toggle(row.id)
        else if (row.parentAvailable) focusRow(row.parentId)
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        selectChat(row.id)
      }
    }

    function setQuery (value) {
      state.query = String(value == null ? '' : value)
      if (searchInput) searchInput.value = state.query
      renderRows()
    }

    function destroy () {
      if (!container) return
      container.textContent = ''
      container.hidden = true
      head = null; countEl = null; searchInput = null; list = null; hint = null
      rowEls.clear()
      state.rows = []
    }

    return Object.freeze({
      render,
      renderRows,
      destroy,
      toggle,
      setQuery,
      focus: focusRow,
      rows: () => state.rows.slice(),
      isCollapsed: id => state.collapsed.has(id),
      collapsedIds: () => [...state.collapsed]
    })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneForkTree = api
})(typeof window === 'object' ? window : globalThis)
