// ---------------------------------------------------------------------------
// Рендеринг предложения изменения интерфейса из чата по макету 2.0 (пункт 7.2)
// Карточка предложения (.prop), панель примерки (.trybar), строка статуса (.appliedline)
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function eyeIconSvg() {
  return '<svg class="icon small" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 8s2.3-4.4 6.2-4.4S14.2 8 14.2 8s-2.3 4.4-6.2 4.4S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/></svg>'
}

function checkIconSvg() {
  return '<svg class="icon small ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.4 8.4l3 3 6.2-6.6"/></svg>'
}

function sparkIconSvg() {
  return '<svg class="icon small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>'
}

/**
 * 1. Карточка предложения в ленте чата (.prop)
 */
function renderProposalCard(options = {}) {
  const { id = '', label = '', patch = {}, t = s => s } = options
  const safeId = escapeHtml(id)
  const safeLabel = escapeHtml(label)
  const safePatch = escapeHtml(JSON.stringify(patch))
  const tryText = escapeHtml(t('Примерить'))

  return `<div class="prop" data-prop-id="${safeId}" data-prop-patch="${safePatch}"><span>${safeLabel}</span><button type="button" class="btn pri sm btn-ui-try" data-action="try" data-prop-id="${safeId}">${eyeIconSvg()}${tryText}</button></div>`
}

/**
 * 2. Панель примерки вверху окна (.trybar)
 */
function renderTryBar(options = {}) {
  const { id = '', label = '', t = s => s } = options
  const safeId = escapeHtml(id)
  const safeLabel = escapeHtml(label)
  const revertText = escapeHtml(t('Вернуть'))
  const keepText = escapeHtml(t('Оставить'))
  const trybarLabel = escapeHtml(t('Панель примерки интерфейса'))

  return `<div class="trybar" data-prop-id="${safeId}" role="region" aria-label="${trybarLabel}">${sparkIconSvg()}<span>${safeLabel}</span><button type="button" class="btn ghost sm btn-ui-revert" data-action="revert" data-prop-id="${safeId}">${revertText}</button><button type="button" class="btn pri sm btn-ui-keep" data-action="keep" data-prop-id="${safeId}">${keepText}</button></div>`
}

/**
 * 3. Строка применённого изменения с возможностью отката (.appliedline)
 */
function renderAppliedLine(options = {}) {
  const { id = '', label = '', t = s => s } = options
  const safeId = escapeHtml(id)
  const safeLabel = escapeHtml(label)
  const undoText = escapeHtml(t('Откатить'))

  return `<div class="appliedline" data-prop-id="${safeId}">${checkIconSvg()}<span>${safeLabel}</span><button type="button" class="lnk btn-ui-undo" data-action="undo" data-prop-id="${safeId}">${undoText}</button></div>`
}

/**
 * 4. Промежуточная строка во время примерки (.appliedline.tr)
 */
function renderTryingLine(options = {}) {
  const { id = '', t = s => s } = options
  const safeId = escapeHtml(id)
  const tryingText = escapeHtml(t('Примеряю — решите вверху окна'))

  return `<div class="appliedline tr" data-prop-id="${safeId}">${sparkIconSvg()}<span>${tryingText}</span></div>`
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    renderProposalCard,
    renderTryBar,
    renderAppliedLine,
    renderTryingLine,
    escapeHtml
  }
}

if (typeof window !== 'undefined') {
  window.uiConfigView = {
    renderProposalCard,
    renderTryBar,
    renderAppliedLine,
    renderTryingLine,
    escapeHtml
  }
}
