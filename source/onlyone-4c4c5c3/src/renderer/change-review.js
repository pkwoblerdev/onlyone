(function (root) {
  'use strict'
  async function open ({ entries = [], t = text => text, onApplied = () => {}, opener } = {}) {
    const existing = root.document.querySelector('.change-review-dialog')
    if (existing?.open) { existing.focus(); return }
    existing?.remove()
    const origin = opener || root.document.activeElement
    const el = (tag, text, className) => {
      const node = root.document.createElement(tag)
      if (text != null) node.textContent = text
      if (className) node.className = className
      return node
    }
    const dialog = el('dialog', null, 'change-review-dialog')
    const header = el('header'), title = el('h2', t('Изменения сессии')), close = el('button', t('Закрыть'), 'btn-secondary')
    title.id = 'change-review-title'; dialog.setAttribute('aria-labelledby', title.id)
    close.type = 'button'; close.addEventListener('click', () => dialog.close()); header.append(title, close)
    const help = el('p', t('Файлы, записанные инструментами агента в этом чате. Изменения команд смотрите в «Участках изменений» (.sections). Откат возвращает выбранный файл к началу выбранного ответа; последующие правки защищены проверкой отпечатка.'))
    const refresh = el('button', t('Обновить'), 'btn-secondary'); refresh.type = 'button'
    const message = el('p'); message.setAttribute('role', 'status')
    const list = el('section', null, 'change-review-list'), detail = el('section', null, 'change-review-detail')
    dialog.append(header, help, refresh, message, list, detail)
    let generation = 0, writing = false
    const statuses = { ready: 'Можно откатить', conflict: 'Есть более поздние правки', busy: 'Ход ещё выполняется', unavailable: 'Снимок недоступен' }
    const ids = [...new Set(entries.filter(entry => /^[a-zA-Z0-9_-]{1,64}$/.test(entry?.requestId || '')).map(entry => entry.requestId))].slice(-64).reverse()
    const names = new Map(entries.map(entry => [entry.requestId, String(entry.label || '').slice(0, 120)]))
    function state (text) { message.textContent = t(text) }
    async function preview (row) {
      if (writing) return
      const current = ++generation
      detail.replaceChildren(); state('Загрузка…')
      try {
        const result = await root.electronAPI.previewAgentChange({ requestId: row.requestId, fileId: row.fileId })
        if (!dialog.isConnected || current !== generation) return
        if (!result?.ok || !Object.hasOwn(result, 'before')) { state('Не удалось прочитать снимок файла.'); return }
        detail.append(el('h3', result.file), el('p', t(statuses[result.status] || 'Снимок недоступен')))
        const comparison = el('div', null, 'change-review-comparison')
        for (const [key, label] of [['before', 'До ответа'], ['after', 'Сейчас на диске']]) {
          const section = el('section'), heading = el('h4', t(label)), text = el('pre', result[key] === null ? t('Файл не существует') : result[key])
          section.append(heading, text); comparison.append(section)
        }
        detail.append(comparison)
        if (result.truncated) detail.append(el('p', t('Предпросмотр сокращён до 64 000 символов на сторону. Откат использует полный снимок.')))
        if (result.status === 'ready') {
          const restore = el('button', t('Откатить этот файл'), 'btn-secondary'); restore.type = 'button'; restore.dataset.action = 'restore-file'
          restore.addEventListener('click', () => {
            restore.disabled = true
            const warning = el('p', t('Подтвердите возврат выбранного файла. Если агент создал его в этом ответе, файл будет удалён.'))
            const confirm = el('button', t('Подтвердить откат'), 'btn-primary'); confirm.type = 'button'; confirm.dataset.action = 'confirm-restore'
            const cancel = el('button', t('Отмена'), 'btn-secondary'); cancel.type = 'button'
            cancel.addEventListener('click', () => { warning.remove(); confirm.remove(); cancel.remove(); restore.disabled = false; restore.focus() })
            confirm.addEventListener('click', async () => {
              if (writing) return
              writing = true; confirm.disabled = true; cancel.disabled = true; close.disabled = true; refresh.disabled = true
              try {
                const outcome = await root.electronAPI.undoAgentChanges(row.requestId, { fileId: row.fileId })
                onApplied(outcome, row.requestId)
                await load()
                state(outcome.conflicts?.length ? 'Откат пропущен: файл изменён после ответа.' : outcome.failed?.length ? 'Не удалось откатить файл. Снимок сохранён.' : 'Файл возвращён к состоянию до ответа.')
              } catch { state('Не удалось откатить файл. Обновите список изменений.') }
              finally { writing = false; close.disabled = false; refresh.disabled = false; refresh.focus() }
            })
            detail.append(warning, confirm, cancel); confirm.focus()
          })
          detail.append(restore)
        }
        state('Предпросмотр готов.'); detail.scrollIntoView({ block: 'nearest' })
      } catch { if (dialog.isConnected && current === generation) state('Не удалось прочитать снимок файла.') }
    }
    async function load () {
      const current = ++generation
      refresh.disabled = true; list.replaceChildren(); detail.replaceChildren(); state('Загрузка…')
      try {
        const result = await root.electronAPI.reviewAgentChanges({ requestIds: ids })
        if (!dialog.isConnected || current !== generation) return
        if (!result?.ok) { state('Не удалось прочитать изменения сессии.'); return }
        const table = el('table'), head = el('tr'), body = el('tbody')
        for (const label of ['Ответ', 'Файл', 'Правок', 'Состояние', 'Действие']) head.append(el('th', t(label)))
        const thead = el('thead'); thead.append(head)
        for (const row of result.files) {
          const tr = el('tr')
          tr.append(el('td', names.get(row.requestId) || row.requestId), el('td', row.file || '—'), el('td', String(row.edits)), el('td', t(statuses[row.status] || 'Снимок недоступен')))
          const cell = el('td'), view = el('button', t('Просмотреть'), 'btn-secondary'); view.type = 'button'; view.dataset.action = 'preview-file'
          view.addEventListener('click', () => { void preview(row) }); cell.append(view); tr.append(cell); body.append(tr)
        }
        table.append(thead, body); list.append(table)
        state(result.files.length ? 'Выберите файл для просмотра и отката.' : 'Доступных изменений файлов нет.')
        if (result.missing.length) list.append(el('p', t('Некоторые снимки недоступны или уже использованы.')))
        if (result.truncated || entries.length > 64) list.append(el('p', t('Показаны последние 64 ответа, до 256 файлов.')))
      } catch { if (dialog.isConnected && current === generation) state('Не удалось прочитать изменения сессии.') }
      finally { if (dialog.isConnected && current === generation) refresh.disabled = false }
    }
    refresh.addEventListener('click', () => { if (!writing) void load() })
    dialog.addEventListener('keydown', event => event.stopPropagation())
    dialog.addEventListener('cancel', event => { if (writing) event.preventDefault() })
    dialog.addEventListener('close', () => { generation++; dialog.remove(); if (origin?.isConnected) origin.focus() })
    root.document.body.append(dialog); dialog.showModal(); await load()
  }
  root.OnlyoneChangeReview = { open }
})(window)
