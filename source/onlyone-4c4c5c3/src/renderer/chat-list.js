/* Список диалогов в боковике (план, 2d).
 * Один список вместо трёх: проект здесь — папка, её диалоги лежат под ней,
 * приколотые всплывают наверх, потому что для этого их и прикалывают.
 * Переименование идёт на месте строки, перенос и удаление — в её меню:
 * одно поле не стоит модального окна.
 *
 * Отдельный файл потому, что список читает историю целиком и перерисовывает
 * себя на любое её изменение. В `app.js` он стоял между панелями и меню
 * проектов, и правка одной строки списка задевала соседей.
 * Сам список не знает, кто открыт и что на диске: ему говорят геттерами.
 */
(function (root) {
  'use strict'

  // Что нужно от окна, приходит проводкой при первом обращении: к этому
  // моменту `app.js` уже объявил всё, что передаёт.
  let $, el, t, escapeHtml, showToast, openContextMenu, switchTab, createNewChat, forkChat, createProject, deleteChat, nameChat, openProject, openProjectEditor, paneOfChat, renderProjects, renderSplitPane, saveConversations, selectChat, toggleSplitView, getActivePane, getPanes, getConversations, getProjects

  function create(deps) {
    ;({ $, el, t, escapeHtml, showToast, openContextMenu, switchTab, createNewChat, forkChat, createProject, deleteChat, nameChat, openProject, openProjectEditor, paneOfChat, renderProjects, renderSplitPane, saveConversations, selectChat, toggleSplitView, getActivePane, getPanes, getConversations, getProjects } = deps)
    return Object.freeze({
      COLLAPSED_KEY,
      collapsedFolders,
      toggleFolder,
      chatRow,
      folderRow,
      renderChatHistory,
      startRenameChat,
      moveChatToProject,
      chatProjectMenu,
      openChatContextMenu
    })
  }

  // Chat History Management
  // One list instead of three. A project is a folder here and its chats sit
  // under it; setting a project up happens on the projects page. Pinned chats
  // float to the top because that is the whole point of pinning them.

  const COLLAPSED_KEY = '1code_collapsed_folders'
  const expandedGroups = new Set()

  function appendChats(host, chats, groupId, visibleCount) {
    const expanded = expandedGroups.has(groupId)
    for (const chat of expanded ? chats : chats.slice(0, visibleCount)) host.appendChild(chatRow(chat))
    if (chats.length <= visibleCount) return
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'history-view-all'
    toggle.textContent = expanded
      ? t('Показать меньше')
      : t('Показать все (%s)', chats.length)
    toggle.addEventListener('click', () => {
      if (expanded) expandedGroups.delete(groupId)
      else expandedGroups.add(groupId)
      renderChatHistory()
    })
    host.appendChild(toggle)
  }

  function collapsedFolders() {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')
      return new Set(Array.isArray(raw) ? raw : [])
    } catch {
      return new Set()
    }
  }

  function toggleFolder(id) {
    const set = collapsedFolders()
    if (set.has(id)) set.delete(id)
    else set.add(id)
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])) } catch {}
    renderChatHistory()
  }

  // Состояние хода у чата в списке (макет 19.10): «ждёт вас», пока агент ждёт
  // ответа на вопрос, и «шаг N/M», пока ход идёт. Видно только у чатов, открытых
  // в панели: у остальных хода нет.
  function chatState(chat) {
    const pane = paneOfChat(chat.id)
    if (!pane || !(pane.generating || pane.preparing || pane.resuming)) return null
    const tasks = [...(pane.agentTasks?.values?.() || [])]
    if (tasks.some(task => task && task.waiting)) return { cls: 'wait', text: t('ждёт вас') }
    const live = tasks.find(task => task && !task.done && Number(task.step) > 0 && Number(task.stepLimit) > 0)
    return live ? { cls: '', text: t('шаг %s/%s', live.step, live.stepLimit) } : null
  }

  function chatRow(chat) {
    const row = document.createElement('div')
    row.dataset.chatId = chat.id
    row.className = `history-item${el.chatView?.classList.contains('active') && paneOfChat(chat.id) ? ' active' : ''}${chat.pinned ? ' pinned' : ''}`

    // Без меток «сейчас / 13д» у каждой строки — владелец: не нужны, только
    // шум рядом с названием. Порядок списка и так по свежести.
    const displayTitle = (chat.title === 'Новый диалог' || chat.title === 'New chat') ? t('Новый диалог') : chat.title
    const state = chatState(chat)
    row.innerHTML = `
      ${chat.pinned ? '<svg fill="none" class="icon small pin-mark" viewBox="0 0 16 16"><path d="M6 2.6h4M6.6 2.6v3.6L4.6 8.8h6.8L9.4 6.2V2.6M8 8.8v4.6"/></svg>' : ''}
      ${chat.remote === true ? '<svg fill="none" class="icon small remote-mark" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.8"/><path d="M7 12h2"/></svg>' : ''}
      <span class="history-item-title">${formatWithEmoji(escapeHtml(displayTitle))}</span>
      ${state ? `<span class="history-item-state${state.cls ? ' ' + state.cls : ''}">${escapeHtml(state.text)}</span>` : ''}
      <button class="history-item-del" data-tooltip="Удалить диалог" aria-label="Удалить диалог"><svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>
    `

    row.querySelector('.history-item-title').addEventListener('click', () => {
      selectChat(getActivePane() || getPanes()[0], chat.id)
    })
    row.querySelector('.history-item-del').addEventListener('click', e => {
      e.stopPropagation()
      deleteChat(chat.id)
    })
    row.addEventListener('contextmenu', e => {
      e.preventDefault()
      e.stopPropagation()
      openChatContextMenu(chat, row, e.clientX, e.clientY)
    })
    row.querySelector('.history-item-title').addEventListener('dblclick', e => {
      e.preventDefault()
      e.stopPropagation()
      startRenameChat(chat, row)
    })

    return row
  }

  // Папка и имя проекта (макет 19.10): группа тише строк под ней — 12 px,
  // --ink-4. Шеврон справа виден под указателем и у свёрнутой группы: клик
  // сворачивает её, как и раньше.
  function folderRow(project, _count, collapsed) {
    const row = document.createElement('div')
    row.className = `folder-row${collapsed ? ' collapsed' : ''}`
    row.innerHTML = `
      <svg fill="none" class="icon folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.3 5.1c0-.9.7-1.6 1.6-1.6h2l1.4 1.8h5c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H3.9c-.9 0-1.6-.7-1.6-1.6z"/></svg>
      <span class="folder-name">${formatWithEmoji(escapeHtml(project.name))}</span>
      <svg fill="none" class="icon folder-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 5.6L8 10.4l4.8-4.8"/></svg>
    `
    row.addEventListener('click', () => toggleFolder(project.id))
    row.addEventListener('contextmenu', e => {
      e.preventDefault()
      e.stopPropagation()
      openContextMenu(e.clientX, e.clientY, [
        {
          label: t('Новый диалог здесь'),
          onPick: () => {
            createNewChat(getActivePane() || getPanes()[0], t('Новый диалог'), project.id)
            renderChatHistory()
          }
        },
        {
          label: t('Открыть настройки проекта'),
          onPick: () => {
            switchTab('projects')
            openProjectEditor(project.id)
          }
        }
      ])
    })
    return row
  }

  function renderChatHistory() {
    const list = el.chatHistoryList
    if (!list) return
    list.innerHTML = ''

    const byRecency = (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)

    // Pinned first, out of any folder: pinning means "I want this within reach",
    // and leaving it buried in a collapsed folder would defeat that.
    const pinned = getConversations().filter(c => c.pinned).sort(byRecency)
    if (pinned.length) {
      const head = document.createElement('div')
      head.className = 'history-group-title'
      head.textContent = t('Закреплённые')
      list.appendChild(head)
      appendChats(list, pinned, 'pinned', 4)
    }

    const collapsed = collapsedFolders()
    for (const project of getProjects()) {
      const chats = getConversations().filter(c => c.projectId === project.id && !c.pinned).sort(byRecency)
      const isCollapsed = collapsed.has(project.id)
      list.appendChild(folderRow(project, chats.length, isCollapsed))
      if (isCollapsed) continue

      const nest = document.createElement('div')
      nest.className = 'folder-children'
      if (!chats.length) {
        const empty = document.createElement('div')
        empty.className = 'folder-empty'
        empty.textContent = t('пусто')
        nest.appendChild(empty)
      }
      appendChats(nest, chats, project.id, 3)
      list.appendChild(nest)
    }

    const loose = getConversations()
      .filter(c => !c.pinned && !getProjects().some(p => p.id === c.projectId))
      .sort(byRecency)

    if (loose.length) {
      if (getProjects().length || pinned.length) {
        const head = document.createElement('div')
        head.className = 'history-group-title'
        head.textContent = t('Без проекта')
        list.appendChild(head)
      }
      appendChats(list, loose, 'loose', 5)
    }

    if (!getConversations().length) {
      const empty = document.createElement('div')
      empty.className = 'history-empty-hint'
      empty.textContent = t('Нет сохранённых диалогов')
      list.appendChild(empty)
    }
  }

  // Editing in place beats a modal for a one-field change.
  function startRenameChat(chat, row) {
    const titleEl = row?.querySelector('.history-item-title')
    if (!titleEl || row.querySelector('.history-rename')) return

    const input = document.createElement('input')
    input.className = 'history-rename'
    input.value = chat.title || ''
    input.setAttribute('aria-label', t('Название диалога'))
    titleEl.replaceWith(input)
    input.focus()
    input.select()

    let done = false
    const finish = save => {
      if (done) return
      done = true
      const next = input.value.trim()
      if (save && next && next !== chat.title) {
        chat.title = next.slice(0, 200)
        chat.updatedAt = Date.now()
        saveConversations()
        // The side pane names its chat in the header, so it has to catch up.
        if (el.splitPane && !el.splitPane.hidden) renderSplitPane()
      }
      renderChatHistory()
    }

    input.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); if (e.isComposing || e.keyCode === 229) return; finish(true) }
      if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
  }

  function moveChatToProject(chat, projectId) {
    chat.projectId = projectId
    chat.updatedAt = Date.now()
    saveConversations()
    renderChatHistory()
    renderProjects()
    const name = projectId
      ? (getProjects().find(p => p.id === projectId)?.name || t('проект'))
      : t('Все диалоги')
    showToast(`«${chat.title}» → ${name}`)
  }

  function chatProjectMenu(chat, x, y) {
    const items = [
      { heading: t('Переместить в проект') },
      {
        label: t('Без проекта'),
        checked: !chat.projectId,
        onPick: () => moveChatToProject(chat, null)
      }
    ]

    for (const project of getProjects()) {
      items.push({
        label: project.name,
        hint: project.workspacePath,
        checked: chat.projectId === project.id,
        onPick: () => moveChatToProject(chat, project.id)
      })
    }

    items.push({ separator: true })
    items.push({ label: t('Новый проект…'), onPick: () => createProject() })

    openContextMenu(x, y, items)
  }

  function openChatContextMenu(chat, row, x, y) {
    const side = getPanes()[1]
    const splitOpen = el.splitPane && !el.splitPane.hidden

    openContextMenu(x, y, [
      { label: t('Переименовать'), onPick: () => startRenameChat(chat, row) },
      { label: t('Создать форк чата'), onPick: () => forkChat?.(chat.id) },
      ...(() => {
        const link = OnlyoneForkTreeModel.parentState(getConversations(), chat.id)
        if (link.kind === 'none') return []
        return [{
          label: link.kind === 'ok'
            ? (link.archived ? t('К родительскому чату (в архиве)') : t('К родительскому чату'))
            : t('Родительский чат недоступен'),
          disabled: link.kind !== 'ok',
          onPick: () => selectChat(getActivePane() || getPanes()[0], link.id)
        }]
      })(),
      {
        label: chat.pinned ? t('Открепить') : t('Закрепить наверху'),
        checked: Boolean(chat.pinned),
        onPick: () => {
          chat.pinned = !chat.pinned
          chat.updatedAt = Date.now()
          saveConversations()
          renderChatHistory()
        }
      },
      {
        label: t('Открыть рядом (Split view)'),
        disabled: Boolean(side && splitOpen && side.chatId === chat.id),
        onPick: () => {
          if (!splitOpen) toggleSplitView(true)
          if (getPanes()[1]) selectChat(getPanes()[1], chat.id)
        }
      },
      {
        label: t('Переместить в проект'),
        submenu: true,
        keepOpen: true,
        onPick: () => chatProjectMenu(chat, x, y)
      },
      { separator: true },
      { label: t('Удалить'), danger: true, onPick: () => deleteChat(chat.id) }
    ])
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneChatList = api
})(typeof window === 'object' ? window : globalThis)
