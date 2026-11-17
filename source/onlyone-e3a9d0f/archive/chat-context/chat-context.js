// chat-context.js: модуль контекста чата одной строкой (этап 3.7).
// Тихая строка над полем ввода: рабочая папка, модель, заполненность контекста, вложения.
// Раскрытие подробностей по клику/Enter. Никаких новых вызовов модели.

function createChatContextBar(options = {}) {
  const {
    container,
    document = globalThis.document,
    t = k => k,
    formatTokens: customFormatTokens = null,
    escapeHtml = s => String(s || ''),
    onOpenFolder = null,
    onOpenModel = null,
    onOpenKeys = null
  } = options

  if (!container) throw new Error('createChatContextBar: container is required')

  function formatTokens(count) {
    const num = Number(count) || 0
    if (num <= 0) return '0'
    const isEn = t('файл') === 'file'
    if (num >= 1000000) {
      const millions = num / 1000000
      const val = millions.toFixed(2).replace(/\.?0+$/, '')
      return (isEn ? val : val.replace('.', ',')) + 'M'
    }
    if (num >= 1000) {
      const thousands = num / 1000
      const val = thousands % 1 === 0 ? thousands.toFixed(0) : thousands.toFixed(1)
      return (isEn ? val : val.replace('.', ',')) + 'k'
    }
    return String(num)
  }

  let root = container.querySelector('.chat-context-bar')
  if (!root) {
    root = document.createElement('div')
    root.className = 'chat-context-bar'
    root.setAttribute('role', 'region')
    root.setAttribute('aria-label', t('Контекст чата'))
    container.appendChild(root)
  }

  let currentState = {
    workspacePath: '',
    modelName: '',
    hasKey: true,
    usedTokens: 0,
    limitTokens: 0,
    attachmentCount: 0,
    historyTokens: 0,
    attachmentTokens: 0,
    systemTokens: 0,
    isOpen: false
  }

  function getFolderBaseName(fullPath) {
    if (!fullPath) return ''
    const norm = fullPath.replace(/\\/g, '/').replace(/\/$/, '')
    const parts = norm.split('/')
    return parts[parts.length - 1] || norm
  }

  function formatFileCount(count) {
    const c = Number(count) || 0
    if (c === 0) return ''
    const isEn = t('файл') === 'file'
    if (isEn) {
      return `${c} ${c === 1 ? 'file' : 'files'}`
    }
    // Русская плюрализация (1 файл, 2-4 файла, 5-20 файлов)
    const rem10 = c % 10
    const rem100 = c % 100
    let word = 'файлов'
    if (rem10 === 1 && rem100 !== 11) {
      word = 'файл'
    } else if (rem10 >= 2 && rem10 <= 4 && (rem100 < 10 || rem100 >= 20)) {
      word = 'файла'
    }
    return `${c} ${t(word)}`
  }

  function render() {
    const {
      workspacePath,
      modelName,
      hasKey,
      usedTokens,
      limitTokens,
      attachmentCount,
      historyTokens,
      attachmentTokens,
      systemTokens,
      isOpen
    } = currentState

    const isEmpty = usedTokens === 0 && attachmentCount === 0
    const ratio = limitTokens > 0 ? (usedTokens / limitTokens) : 0
    const percent = Math.min(100, Math.round(ratio * 100))
    const isWarn = !isEmpty && ratio >= 0.75 && ratio < 1.0
    const isOverflow = !isEmpty && ratio >= 1.0
    const isNormal = !isEmpty && !isWarn && !isOverflow
    const noFolder = !workspacePath
    const noKey = hasKey === false

    // CSS классы состояния
    root.className = 'chat-context-bar'
    if (isEmpty) root.classList.add('is-empty')
    if (isNormal) root.classList.add('is-normal')
    if (isWarn) root.classList.add('is-warn')
    if (isOverflow) root.classList.add('is-overflow')
    if (noFolder) root.classList.add('no-folder')
    if (noKey) root.classList.add('no-key')

    const stateAttr = isEmpty ? 'empty' : isOverflow ? 'overflow' : isWarn ? 'warn' : 'normal'
    root.setAttribute('data-state', stateAttr)

    // Данные для строки
    // Папку и модель показывает поле ввода: здесь они были второй копией. В строке остаётся
    // то, чего там нет, — расход контекста, вложения и предупреждение «Нет ключа».
    const modelText = hasKey ? (modelName || 'onlyone') : t('Нет ключа')
    const usageText = limitTokens > 0
      ? `${formatTokens(usedTokens)} / ${formatTokens(limitTokens)} (${percent}%)`
      : `${formatTokens(usedTokens)}`

    const filesText = formatFileCount(attachmentCount)

    // Тултипы (data-tooltip вместо title= по правилам дизайна OnlyOne)
    const summaryTooltip = t('Нажмите, чтобы увидеть распределение контекста чата')

    root.innerHTML = `
      <button type="button" class="chat-context-summary" aria-expanded="${isOpen ? 'true' : 'false'}" aria-controls="chatContextDetails" data-tooltip="${escapeHtml(summaryTooltip)}">
        ${noKey ? `
          <span class="context-item context-model" data-action="model" data-tooltip="${escapeHtml(modelText)}">
            <svg fill="none" class="context-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
            <span class="context-label">${escapeHtml(modelText)}</span>
          </span>
          <span class="context-sep" aria-hidden="true">·</span>
        ` : ''}

        <span class="context-item context-usage" data-tooltip="${escapeHtml(t('Использование контекста'))}: ${percent}%">
          <span class="context-gauge" aria-hidden="true">
            <span class="context-gauge-fill" style="width: ${percent}%"></span>
          </span>
          <span class="context-label">${escapeHtml(usageText)}</span>
        </span>

        ${filesText ? `
          <span class="context-sep" aria-hidden="true">·</span>
          <span class="context-item context-attachments" data-tooltip="${escapeHtml(filesText)}">
            <svg fill="none" class="context-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3a2.5 2.5 0 0 1 5 0v6.5a1.5 1.5 0 0 1-3 0V4a.5.5 0 0 1 1 0v5.5a.5.5 0 0 0 1 0V3a1.5 1.5 0 0 0-3 0v6.5a2.5 2.5 0 0 0 5 0V4a.5.5 0 0 1 1 0v5.5a3.5 3.5 0 1 1-7 0V3z"/></svg>
            <span class="context-label">${escapeHtml(filesText)}</span>
          </span>
        ` : ''}

        <svg class="context-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>

      <div id="chatContextDetails" class="chat-context-details"${isOpen ? '' : ' hidden'}>
        <div class="context-details-head">
          <span class="context-details-title">${escapeHtml(t('Контекст модели'))}</span>
          <span class="context-details-badge ${stateAttr}">${percent}%</span>
        </div>

        <div class="context-progress-bar">
          <div class="context-progress-fill ${stateAttr}" style="width: ${percent}%"></div>
        </div>

        <div class="context-breakdown">
          <div class="context-stat-row">
            <span class="context-stat-label">${escapeHtml(t('История сообщений'))}</span>
            <span class="context-stat-value">${formatTokens(historyTokens)}</span>
          </div>
          <div class="context-stat-row">
            <span class="context-stat-label">${escapeHtml(t('Вложения и файлы'))}</span>
            <span class="context-stat-value">${formatTokens(attachmentTokens)}</span>
          </div>
          <div class="context-stat-row">
            <span class="context-stat-label">${escapeHtml(t('Системные инструкции'))}</span>
            <span class="context-stat-value">${formatTokens(systemTokens)}</span>
          </div>
          <div class="context-stat-row total">
            <span class="context-stat-label">${escapeHtml(t('Всего занято'))}</span>
            <span class="context-stat-value">${formatTokens(usedTokens)} / ${formatTokens(limitTokens)}</span>
          </div>
        </div>
      </div>
    `

    // Обработчики событий
    const summaryBtn = root.querySelector('.chat-context-summary')
    summaryBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleDetails()
    })
  }

  function toggleDetails(force) {
    currentState.isOpen = typeof force === 'boolean' ? force : !currentState.isOpen
    const summaryBtn = root.querySelector('.chat-context-summary')
    const details = root.querySelector('.chat-context-details')
    if (summaryBtn) summaryBtn.setAttribute('aria-expanded', currentState.isOpen ? 'true' : 'false')
    if (details) details.hidden = !currentState.isOpen
  }

  // Закрытие по Escape или клику вне бара
  const onDocKeyDown = (e) => {
    if (e.key === 'Escape' && currentState.isOpen) {
      toggleDetails(false)
    }
  }

  const onDocClick = (e) => {
    if (currentState.isOpen && !root.contains(e.target)) {
      toggleDetails(false)
    }
  }

  document.addEventListener('keydown', onDocKeyDown)
  document.addEventListener('pointerdown', onDocClick)

  function update(newData = {}) {
    Object.assign(currentState, newData)
    render()
  }

  function destroy() {
    document.removeEventListener('keydown', onDocKeyDown)
    document.removeEventListener('pointerdown', onDocClick)
    if (root && root.parentNode) root.parentNode.removeChild(root)
  }

  // Первичный рендер
  render()

  return {
    update,
    render,
    toggleDetails,
    isOpen: () => currentState.isOpen,
    destroy
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createChatContextBar }
}
if (typeof window !== 'undefined') {
  window.createChatContextBar = createChatContextBar
}
