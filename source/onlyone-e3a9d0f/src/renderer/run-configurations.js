/* Captured inputs and explicit restoration of model/effort only. */
(function (root) {
  'use strict'
  function flattenRecords (records) {
    if (!Array.isArray(records)) return []
    return records.slice(-16).filter(record => record && Array.isArray(record.configurations))
      .sort((a, b) => b.startedAt - a.startedAt).flatMap(record => record.configurations.slice(-32)
        .map((configuration, index, all) => ({ runId: record.runId, startedAt: record.startedAt, state: record.state,
          dropped: record.droppedConfigurations || 0, version: (record.droppedConfigurations || 0) + record.configurations.length - all.length + index + 1, configuration,
          skillReads: Array.isArray(record.skillReads) ? record.skillReads.slice(-128) : [],
          modelCalls: Array.isArray(record.modelCalls) ? record.modelCalls.slice(-128) : [],
          truncatedObservations: Boolean(record.droppedSkillReads || record.droppedModelCalls) }))
        .filter(row => row.configuration && typeof row.configuration.model === 'string' && Array.isArray(row.configuration.tools) && Array.isArray(row.configuration.skills)).reverse())
  }
  function setChanges (before, after, key, beforeCount, afterCount) {
    const a = new Map(before.map(item => [item[key], item.hash])), b = new Map(after.map(item => [item[key], item.hash]))
    return { added: [...b.keys()].filter(id => !a.has(id)).sort(), removed: [...a.keys()].filter(id => !b.has(id)).sort(),
      changed: [...b.keys()].filter(id => a.has(id) && a.get(id) !== b.get(id)).sort(),
      truncated: before.length < beforeCount || after.length < afterCount }
  }
  function compareConfigurations (before, after) {
    return { fields: ['model', 'reasoningEffort', 'agentIndex', 'instructions', 'toolCount', 'skillCount', 'toolSetHash', 'skillSetHash']
      .map(key => ({ key, before: before[key], after: after[key], changed: before[key] !== after[key] })),
    tools: setChanges(before.tools, after.tools, 'name', before.toolCount, after.toolCount),
    skills: setChanges(before.skills, after.skills, 'id', before.skillCount, after.skillCount) }
  }
  async function open ({ t = value => value, opener, parameters } = {}) {
    const existing = root.document.querySelector('.run-configurations-dialog')
    if (existing?.open) { existing.focus(); return }
    existing?.remove()
    const previousFocus = opener || root.document.activeElement
    const el = (tag, text, className) => {
      const node = root.document.createElement(tag)
      if (text != null) node.textContent = text
      if (className) node.className = className
      return node
    }
    const dialog = el('dialog', null, 'run-configurations-dialog')
    dialog.addEventListener('keydown', event => event.stopPropagation())
    const title = el('h2', t('Конфигурации запусков'))
    title.id = 'run-configurations-title'; dialog.setAttribute('aria-labelledby', title.id)
    const close = el('button', t('Закрыть'), 'btn-secondary'); close.type = 'button'
    close.addEventListener('click', () => dialog.close())
    const head = el('header'); head.append(title, close)
    const help = el('p', t('Архив последних 16 запусков из чатов и Design. Можно вернуть модель и effort из B после просмотра изменений. Инструкции, навыки, провайдер, ключи и права доступа не восстанавливаются.'))
    const refresh = el('button', t('Обновить'), 'btn-secondary'); refresh.type = 'button'
    const message = el('p', '', 'run-configurations-message'); message.setAttribute('role', 'status')
    const selectors = el('div', null, 'run-configurations-selectors')
    const a = el('select'), b = el('select')
    for (const [select, name] of [[a, 'A'], [b, 'B']]) {
      const label = el('label', t('Конфигурация') + ' ' + name); label.append(select); selectors.append(label)
    }
    const body = el('section', null, 'run-configurations-comparison')
    const restore = el('button', t('Вернуть параметры B'), 'btn-secondary'); restore.type = 'button'
    restore.dataset.action = 'preview-parameters'; restore.disabled = true
    const preview = el('section', null, 'run-configurations-restore'); preview.hidden = true
    dialog.append(head, help, refresh, message, selectors, restore, preview, body)
    let rows = [], generation = 0, applying = false
    const reasons = { forbidden: 'Восстановление разрешено только в основном окне.', missing: 'Запись больше недоступна. Обновите архив.',
      unavailable: 'Модель из архива недоступна у текущего провайдера.', effort: 'Сохранённый effort недоступен для этой модели. Параметры не изменены.',
      busy: 'Дождитесь завершения активных задач.', changed: 'Параметры или провайдер изменились. Откройте предпросмотр заново.',
      expired: 'Предпросмотр устарел. Откройте его заново.', write_failed: 'Не удалось сохранить параметры. Попробуйте ещё раз.',
      fast: 'Выключите Fast перед восстановлением параметров.', refresh: 'Параметры сохранены. Обновите каталог моделей.',
      read_failed: 'Не удалось прочитать архив конфигураций.' }
    const failure = code => { message.textContent = t(reasons[code] || 'Не удалось восстановить параметры.') }
    const resetPreview = () => { preview.replaceChildren(); preview.hidden = true }
    const fields = { model: 'Запрошенная модель', reasoningEffort: 'Усилие рассуждения', agentIndex: 'Номер агента',
      instructions: 'Инструкции (SHA-256)', toolCount: 'Количество инструментов', skillCount: 'Количество навыков',
      toolSetHash: 'Все инструменты (SHA-256)', skillSetHash: 'Все навыки (SHA-256)' }
    function render () {
      resetPreview()
      body.replaceChildren()
      const first = rows[Number(a.value)], second = rows[Number(b.value)]
      if (!first || !second) return
      const diff = compareConfigurations(first.configuration, second.configuration)
      message.textContent = t(diff.fields.some(field => field.changed) ? 'Конфигурации отличаются.' : 'Конфигурации совпадают.')
      const table = el('table'), thead = el('thead'), header = el('tr'), tbody = el('tbody')
      for (const name of [t('Параметр'), 'A', 'B']) header.append(el('th', name))
      thead.append(header)
      for (const field of diff.fields) {
        const row = el('tr', null, field.changed ? 'configuration-different' : '')
        const label = el('th', t(fields[field.key])); label.scope = 'row'; row.append(label)
        for (const value of [field.before, field.after]) {
          const cell = el('td'), text = field.key === 'agentIndex' ? String(value + 1) : String(value)
          cell.append(el('code', text)); row.append(cell)
        }
        tbody.append(row)
      }
      table.append(thead, tbody); body.append(table)
      for (const [group, changes] of [[t('Инструменты'), diff.tools], [t('Навыки (идентификаторы SHA-256)'), diff.skills]]) {
        const details = el('details'), summary = el('summary', group)
        details.append(summary)
        const list = el('ul')
        for (const [key, label] of [['added', 'Добавлены'], ['removed', 'Удалены'], ['changed', 'Изменены']]) {
          for (const name of changes[key]) list.append(el('li', t(label) + ': ' + name))
        }
        if (!list.children.length) list.append(el('li', t('В сохранённых списках изменений нет.')))
        details.append(list)
        if (changes.truncated) details.append(el('p', t('Списки сокращены. Полные наборы сравниваются по отпечаткам в таблице.')))
        body.append(details)
      }
      if (first.dropped || second.dropped) body.append(el('p', t('Часть ранних конфигураций этого запуска вышла за лимит архива.')))
      const ids = el('p', null, 'run-configurations-ids')
      ids.textContent = `A: ${first.runId} · B: ${second.runId}`; body.append(ids)
      for (const [name, row] of [['A', first], ['B', second]]) {
        const details = el('details'); details.append(el('summary', t('Фактические обращения и чтения навыков') + ' · ' + name))
        details.append(el('p', t('Данные всего запуска, а не только выбранной версии. Модель указана по ответу провайдера; отсутствие имени означает неизвестность. Содержимое инструкций не сохраняется.')))
        const list = el('ul')
        for (const call of row.modelCalls) {
          const kinds = { agent: 'Агент', chat: 'Чат', coordinator: 'Координатор', judge: 'Приёмка', summary: 'Сводка', closing: 'Итог' }
          const outcomes = { completed: 'Ответ получен', failed: 'Ошибка', cancelled: 'Отменено' }
          const item = el('li', t(kinds[call.kind] || 'Агент') + ' ' + (call.agentIndex + 1) + ' · ' + t(outcomes[call.outcome] || 'Ошибка') + ': ')
          item.append(el('code', call.model + ' → ' + (call.answeredModel || t('Неизвестно'))))
          item.append(el('p', t('Вход запроса (SHA-256)') + ': ' + call.inputHash)); list.append(item)
        }
        for (const read of row.skillReads) {
          const item = el('li', t(read.source === 'file' ? 'Файл навыка' : 'Инструкция навыка') + ' · ' + t('Агент') + ' ' + (read.agentIndex + 1))
          item.append(el('p', t('Навык / путь (SHA-256)') + ': ' + read.skillId + ' / ' + read.path))
          item.append(el('p', t('Содержимое (SHA-256)') + ': ' + read.hash + ' · ' + read.bytes + ' ' + t('байт'))); list.append(item)
        }
        if (!list.children.length) list.append(el('li', t('В этой записи нет данных обращений и чтения навыков.')))
        details.append(list)
        if (row.truncatedObservations) details.append(el('p', t('Ранние наблюдения вышли за лимит: сохранены последние 128 обращений и 128 версий прочитанных инструкций.')))
        body.append(details)
      }
    }
    restore.addEventListener('click', async () => {
      if (applying || !parameters || !rows[Number(b.value)]) return
      resetPreview()
      const row = rows[Number(b.value)], current = ++generation
      applying = true; restore.disabled = true; refresh.disabled = true; a.disabled = true; b.disabled = true
      try {
        const result = await parameters.preview({ runId: row.runId, configurationId: row.configuration.id })
        if (!dialog.isConnected || current !== generation) return
        if (!result?.ok) { failure(result?.code); return }
        preview.hidden = false
        preview.append(el('p', t('Изменятся только параметры следующих запусков. Текущие инструкции и доступы сохранятся.')))
        for (const key of ['defaultModel', 'thinkingEffort']) {
          const line = el('p', t(key === 'defaultModel' ? 'Запрошенная модель' : 'Усилие рассуждения') + ': ')
          line.append(el('code', String(result.before[key] || '—') + ' → ' + String(result.after[key]))); preview.append(line)
        }
        const apply = el('button', t('Применить параметры'), 'btn-primary'); apply.type = 'button'; apply.dataset.action = 'apply-parameters'
        const cancel = el('button', t('Отмена'), 'btn-secondary'); cancel.type = 'button'; cancel.addEventListener('click', resetPreview)
        apply.addEventListener('click', async () => {
          if (applying) return
          applying = true; apply.disabled = true; cancel.disabled = true; restore.disabled = true; refresh.disabled = true; a.disabled = true; b.disabled = true
          try {
            const saved = await parameters.apply(result.token)
            if (dialog.isConnected) {
              resetPreview()
              if (saved?.ok) message.textContent = t('Модель и effort восстановлены для следующих запусков.')
              else failure(saved?.code)
            }
          } catch { if (dialog.isConnected) { resetPreview(); failure('write_failed') } }
          finally { applying = false; if (dialog.isConnected) { restore.disabled = false; refresh.disabled = false; a.disabled = false; b.disabled = false; restore.focus() } }
        })
        preview.append(apply, cancel); apply.focus()
      } catch { if (dialog.isConnected && current === generation) failure('read_failed') }
      finally { applying = false; if (dialog.isConnected && current === generation) { restore.disabled = false; refresh.disabled = false; a.disabled = false; b.disabled = false } }
    })
    async function load () {
      const current = ++generation
      resetPreview(); restore.disabled = true; refresh.disabled = true; a.disabled = true; b.disabled = true
      rows = []; a.replaceChildren(); b.replaceChildren()
      body.replaceChildren(); message.textContent = t('Загрузка…')
      try {
        const result = await root.electronAPI.getRunConfigurations()
        if (!dialog.isConnected || current !== generation) return
        if (!result?.ok) throw Error('archive unavailable')
        rows = flattenRecords(result.records)
        for (const select of [a, b]) {
          select.replaceChildren()
          rows.forEach((row, index) => {
            const date = new Date(row.startedAt)
            const when = Number.isFinite(date.getTime()) ? date.toLocaleString(root.document.documentElement.lang || 'ru') : '—'
            const option = el('option', `${when} · ${row.configuration.model} · ${t('Версия')} ${row.version} · ${t('Агент')} ${row.configuration.agentIndex + 1}`)
            option.value = String(index); select.append(option)
          })
          select.disabled = rows.length === 0
        }
        a.value = rows.length > 1 ? '1' : '0'; b.value = '0'
        if (!rows.length) message.textContent = t('Сохранённых конфигураций пока нет.')
        else { render(); restore.disabled = !parameters }
      } catch { if (dialog.isConnected && current === generation) message.textContent = t('Не удалось прочитать архив конфигураций.') }
      finally { if (dialog.isConnected && current === generation) refresh.disabled = false }
    }
    a.addEventListener('change', render); b.addEventListener('change', render); refresh.addEventListener('click', () => { void load() })
    dialog.addEventListener('close', () => {
      generation++; dialog.remove()
      const target = previousFocus?.isConnected ? previousFocus : root.document.querySelector('.tasks-configurations')
      if (!root.document.querySelector('.run-configurations-dialog[open]')) target?.focus()
    })
    root.document.body.append(dialog); dialog.showModal(); await load()
  }
  const api = { flattenRecords, compareConfigurations, open }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneRunConfigurations = api
})(typeof window === 'object' ? window : globalThis)
