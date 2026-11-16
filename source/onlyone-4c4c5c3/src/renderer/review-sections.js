(function (root) {
  'use strict'

  // Окно «Участки изменений»: файл, отдельная правка и выполненная команда.
  // Данные берутся у главного процесса; здесь только выбор, предпросмотр и
  // подтверждение. Содержимое файлов выводится текстом (textContent), не HTML.

  const STATUS = {
    ready: 'Можно откатить',
    partial: 'Часть участков можно откатить',
    conflict: 'Есть более поздние правки',
    busy: 'Ход ещё выполняется',
    unavailable: 'Снимок недоступен',
    empty: 'Файлы не менялись',
    done: 'Уже откатано'
  }

  async function open ({ entries = [], t = text => text, onApplied = () => {}, opener } = {}) {
    const existing = root.document.querySelector('.review-sections-dialog')
    if (existing?.open) { existing.focus(); return }
    existing?.remove()
    const origin = opener || root.document.activeElement
    const el = (tag, text, className) => {
      const node = root.document.createElement(tag)
      if (text != null) node.textContent = text
      if (className) node.className = className
      return node
    }
    const dialog = el('dialog', null, 'review-sections-dialog')
    const header = el('header'), title = el('h2', t('Участки изменений'))
    const close = el('button', t('Закрыть'), 'btn-secondary'); close.type = 'button'
    title.id = 'review-sections-title'; dialog.setAttribute('aria-labelledby', title.id)
    close.addEventListener('click', () => dialog.close()); header.append(title, close)
    const help = el('p', t('Файлы, отдельные правки и выполненные команды этого чата. Откат возвращает только выбранный участок; более поздняя работа защищена проверкой отпечатка и не затирается.'))
    const toolbar = el('div', null, 'review-sections-toolbar')
    const refresh = el('button', t('Обновить'), 'btn-secondary'); refresh.type = 'button'
    const apply = el('button', t('Откатить выбранные'), 'btn-primary'); apply.type = 'button'; apply.disabled = true
    const message = el('p'); message.setAttribute('role', 'status')
    const list = el('section', null, 'review-sections-list')
    const detail = el('section', null, 'review-sections-detail')
    toolbar.append(refresh, apply)
    dialog.append(header, help, toolbar, message, list, detail)
    root.document.body.append(dialog)

    let generation = 0
    let writing = false
    let sections = []
    const selected = new Set()
    const owners = new Map()
    const ids = [...new Set(entries.filter(entry => /^[a-zA-Z0-9_-]{1,64}$/.test(entry?.requestId || '')).map(entry => entry.requestId))].slice(-64).reverse()

    const state = text => { message.textContent = t(text) }
    const statusText = status => t(STATUS[status] || STATUS.unavailable)
    // Номер хода входит в ключ выбора: один и тот же файл, правленный в двух
    // ответах, даёт два участка с одинаковым sectionId. Без requestId выбор
    // попадал в чужой ход (и откат упирался в конфликт).
    const SEP = String.fromCharCode(0)
    const keyOf = (requestId, sectionId) => `${requestId}${SEP}${sectionId}`
    const sectionIdOfKey = key => key.slice(key.indexOf(SEP) + 1)
    const sectionKey = section => keyOf(section.requestId, section.sectionId)

    function syncApply () {
      apply.disabled = writing || selected.size === 0
      apply.textContent = selected.size ? t('Откатить выбранные (%s)', String(selected.size)) : t('Откатить выбранные')
      // Список перерисовывается во время записи, и его флажки создаются
      // выключенными. После записи их нужно вернуть, иначе один откат оставляет
      // весь обзор неактивным до повторного открытия.
      for (const check of dialog.querySelectorAll('[data-action=select-section]')) {
        check.disabled = writing || ['busy', 'unavailable', 'empty', 'done'].includes(check.dataset.status)
      }
    }

    async function confirmAndUndo (keys) {
      if (writing || !keys.length) return
      writing = true; syncApply(); refresh.disabled = true; close.disabled = true
      try {
        const grouped = new Map()
        for (const key of keys) {
          const requestId = owners.get(key)
          if (!requestId) continue
          if (!grouped.has(requestId)) grouped.set(requestId, [])
          grouped.get(requestId).push(sectionIdOfKey(key))
        }
        const totals = { restored: 0, removed: 0, conflicts: 0, failed: 0, kept: 0 }
        const reasons = []
        for (const [requestId, sectionIdsForTurn] of grouped) {
          for (let offset = 0; offset < sectionIdsForTurn.length; offset += 64) {
            try {
              const outcome = await root.electronAPI.undoAgentSections({ requestId, sectionIds: sectionIdsForTurn.slice(offset, offset + 64) })
              if (!outcome?.ok) { totals.failed++; reasons.push(statusText('unavailable')); continue }
              totals.restored += (outcome.restored || []).length
              totals.removed += (outcome.removed || []).length
              totals.conflicts += (outcome.conflicts || []).length
              totals.failed += (outcome.failed || []).length
              if (outcome.snapshotKept) totals.kept++
              for (const item of outcome.sections || []) if (item.reason && !reasons.includes(item.reason)) reasons.push(item.reason)
              for (const failure of outcome.failed || []) {
                const reason = String(failure).replace(/^.*?:\s/, '')
                if (reason && !reasons.includes(reason)) reasons.push(reason)
              }
              onApplied(outcome, requestId)
            } catch { totals.failed++ }
          }
        }
        selected.clear(); syncApply()
        const parts = [
          totals.restored ? t('Возвращено файлов: %s.', String(totals.restored)) : '',
          totals.removed ? t('Удалено созданных файлов: %s.', String(totals.removed)) : '',
          totals.conflicts ? t('Пропущено из-за поздних правок: %s.', String(totals.conflicts)) : '',
          totals.failed ? t('Не удалось откатить: %s.', String(totals.failed)) : ''
        ].filter(Boolean)
        await load()
        message.textContent = parts.join(' ') || t('Ничего не изменено.')
        if (reasons.length) {
          const reason = el('ul', null, 'review-sections-reasons')
          for (const text of reasons.slice(0, 6)) reason.append(el('li', t(text)))
          detail.append(reason)
        }
      } finally {
        writing = false; refresh.disabled = false; close.disabled = false; syncApply()
      }
    }

    function confirmSelection (keys) {
      if (!keys.length) return
      const warning = el('div', null, 'review-sections-confirm')
      warning.append(el('p', t('Подтвердите откат выбранных участков. Поздние правки будут пропущены, остальные изменения сохранятся.')))
      const confirm = el('button', t('Подтвердить откат'), 'btn-primary'); confirm.type = 'button'; confirm.dataset.action = 'confirm-sections'
      const cancel = el('button', t('Отмена'), 'btn-secondary'); cancel.type = 'button'
      cancel.addEventListener('click', () => warning.remove())
      confirm.addEventListener('click', () => { warning.remove(); void confirmAndUndo(keys) })
      warning.append(confirm, cancel)
      detail.append(warning)
      confirm.focus()
    }

    async function preview (section) {
      if (writing) return
      const current = ++generation
      detail.replaceChildren(); state('Загрузка…')
      try {
        const result = await root.electronAPI.previewAgentSection({ requestId: section.requestId, sectionId: section.sectionId })
        if (!dialog.isConnected || current !== generation) return
        if (!result?.ok) { state('Не удалось прочитать участок.'); return }
        owners.set(keyOf(section.requestId, section.sectionId), section.requestId)
        if (result.kind === 'command') {
          detail.append(el('h3', result.command || t('Команда')), el('p', statusText(result.status)))
          if (result.reason) detail.append(el('p', t(String(result.reason))))
          const table = el('table'), head = el('tr'), body = el('tbody'), thead = el('thead')
          for (const label of ['Файл', 'Действие', 'Состояние']) head.append(el('th', t(label)))
          thead.append(head)
          for (const file of result.files || []) {
            const tr = el('tr')
            tr.append(el('td', file.file || '—'), el('td', t(file.action === 'created' ? 'Создан' : file.action === 'deleted' ? 'Удалён' : 'Изменён')), el('td', t(statusText(file.status))))
            body.append(tr)
          }
          table.append(thead, body); detail.append(table)
          const restore = el('button', t('Откатить команду'), 'btn-secondary'); restore.type = 'button'; restore.dataset.action = 'restore-command'
          restore.addEventListener('click', () => confirmSelection([keyOf(section.requestId, result.sectionId)]))
          if (result.status === 'ready' || result.status === 'partial') detail.append(restore)
          if (result.truncated) detail.append(el('p', t('Показаны не все файлы команды.')))
        } else if (result.kind === 'fragment') {
          owners.set(keyOf(section.requestId, result.id), section.requestId)
          detail.append(el('h3', result.file || '—'), el('p', statusText(result.status)))
          detail.append(comparison(result, t))
          if (result.status === 'ready') {
            const restore = el('button', t('Откатить участок'), 'btn-secondary'); restore.type = 'button'; restore.dataset.action = 'restore-fragment'
            restore.addEventListener('click', () => confirmSelection([keyOf(section.requestId, result.id)]))
            detail.append(restore)
          }
        } else {
          detail.append(el('h3', result.file || '—'), el('p', statusText(result.status)))
          detail.append(comparison(result, t))
          const fragments = el('div', null, 'review-sections-fragments')
          for (const [index, fragment] of (result.fragments || []).entries()) {
            owners.set(keyOf(section.requestId, fragment.id), section.requestId)
            const card = el('article', null, 'review-sections-fragment')
            card.append(el('h4', t('Участок %s', String(index + 1))), el('p', statusText(fragment.status)))
            card.append(comparison(fragment, t))
            if (fragment.status === 'ready') {
              const restore = el('button', t('Откатить участок'), 'btn-secondary'); restore.type = 'button'; restore.dataset.action = 'restore-fragment'
              restore.addEventListener('click', () => confirmSelection([keyOf(section.requestId, fragment.id)]))
              card.append(restore)
            }
            fragments.append(card)
          }
          if (result.fragments?.length) detail.append(fragments)
          if (result.truncated) detail.append(el('p', t('Предпросмотр сокращён. Откат использует полный снимок.')))
        }
        state('Предпросмотр готов.')
        detail.scrollIntoView({ block: 'nearest' })
      } catch { if (dialog.isConnected && current === generation) state('Не удалось прочитать участок.') }
    }

    function comparison (result, translate) {
      const wrap = el('div', null, 'review-sections-comparison')
      for (const [key, label] of [['before', 'До участка'], ['after', 'Сейчас на диске']]) {
        const section = el('section')
        section.append(el('h4', translate(label)), el('pre', result[key] === null || result[key] === undefined ? translate('Файл не существует') : result[key]))
        wrap.append(section)
      }
      return wrap
    }

    function row (section) {
      const tr = el('tr')
      const cell = el('td')
      const check = root.document.createElement('input'); check.type = 'checkbox'; check.dataset.action = 'select-section'
      check.dataset.status = section.status
      check.checked = selected.has(sectionKey(section))
      check.disabled = writing || ['busy', 'unavailable', 'empty', 'done'].includes(section.status)
      check.addEventListener('change', () => {
        if (check.checked) selected.add(sectionKey(section)); else selected.delete(sectionKey(section))
        syncApply()
      })
      cell.append(check)
      const kind = el('td', section.kind === 'command' ? t('Команда') : t('Файл'))
      const name = el('td', section.kind === 'command' ? (section.command || '—') : (section.file || '—'))
      const edits = el('td', String(section.kind === 'command' ? section.fileCount : section.edits || 0))
      const status = el('td', t(statusText(section.status)))
      const action = el('td'), view = el('button', t('Просмотреть'), 'btn-secondary'); view.type = 'button'; view.dataset.action = 'preview-section'
      view.addEventListener('click', () => { void preview(section) })
      action.append(view)
      tr.append(cell, kind, name, edits, status, action)
      return tr
    }

    async function load () {
      const current = ++generation
      refresh.disabled = true; apply.disabled = true; list.replaceChildren(); detail.replaceChildren(); state('Загрузка…')
      try {
        const result = await root.electronAPI.reviewAgentSections({ requestIds: ids })
        if (!dialog.isConnected || current !== generation) return
        if (!result?.ok) { state('Не удалось прочитать изменения сессии.'); return }
        sections = result.sections || []
        owners.clear()
        for (const section of sections) owners.set(sectionKey(section), section.requestId)
        const known = new Set(sections.map(sectionKey))
        for (const key of [...selected]) if (!known.has(key)) selected.delete(key)
        syncApply()
        const table = el('table'), head = el('tr'), body = el('tbody'), thead = el('thead')
        for (const label of ['', 'Участок', 'Что изменено', 'Правок', 'Состояние', 'Действие']) head.append(el('th', t(label)))
        thead.append(head)
        for (const section of sections) body.append(row(section))
        table.append(thead, body); list.append(table)
        state(sections.length ? 'Выберите участки для просмотра и отката.' : 'Доступных изменений нет.')
        if (result.missing?.length) list.append(el('p', t('Некоторые снимки недоступны или уже использованы.')))
        if (result.truncated || ids.length > 64) list.append(el('p', t('Показаны последние 64 ответа, до 256 участков.')))
      } catch { if (dialog.isConnected && current === generation) state('Не удалось прочитать изменения сессии.') }
      finally { if (dialog.isConnected && current === generation) refresh.disabled = false }
    }

    refresh.addEventListener('click', () => { if (!writing) void load() })
    apply.addEventListener('click', () => confirmSelection([...selected]))
    dialog.addEventListener('keydown', event => event.stopPropagation())
    dialog.addEventListener('cancel', event => { if (writing) event.preventDefault() })
    dialog.addEventListener('close', () => { generation++; dialog.remove(); if (origin?.isConnected) origin.focus() })
    dialog.showModal(); await load()
  }

  root.OnlyoneReviewSections = { open }
})(window)
