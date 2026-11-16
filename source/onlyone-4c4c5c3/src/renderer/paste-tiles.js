/* Вставка в строку ввода: плитки вместо слов.
 * Картинка из буфера ложится квадратной плиткой над полем, длинный текст — карточкой с его началом и меткой «Вставлено».
 * Раньше картинка была строкой «paste-1787.png», по которой не понять, какая именно, а длинный текст высыпался в само поле и
 * закрывал его целиком. Плитка — это и есть вложение: уходит вместе с сообщением, крестик убирает её.
 * Модуль только строит узлы и решает, что считать «длинным»; сохранение файла и миниатюры делает главный процесс. */
(function (root) {
  'use strict'

  // Короче — это обычная вставка в поле. Порог по знакам и по строкам: колонка из тридцати коротких строк длиннее экрана.
  const LONG_CHARS = 1200
  const LONG_LINES = 20

  function isLongPaste (text) {
    const value = String(text == null ? '' : text)
    if (!value.trim()) return false
    return value.length >= LONG_CHARS || value.split(/\r?\n/).length >= LONG_LINES
  }

  // Плиткой показываются картинки и вставленный текст; остальные файлы (PDF, видео, файл с диска) остаются полосой с именем.
  function isTile (item) {
    return Boolean(item) && (item.kind === 'image' || item.pasted === true)
  }

  const CROSS = '<svg fill="none" class="icon small" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>'

  function buildTile (doc, item, { t = text => text, onRemove = () => {} } = {}) {
    const tile = doc.createElement('div')
    const pasted = item.pasted === true
    tile.className = `attachment-tile kind-${item.kind}${pasted ? ' is-pasted' : ''}${item.error ? ' has-error' : ''}`
    tile.setAttribute('role', 'group')
    const label = pasted ? t('Вставленный текст, строк: %s', item.lines || 1) : (item.name || '')
    tile.dataset.tooltip = item.error ? `${label} — ${item.error}` : label
    tile.setAttribute('aria-label', label)

    if (pasted) {
      const text = doc.createElement('span')
      text.className = 'tile-text'
      text.textContent = String(item.preview || '')
      const badge = doc.createElement('span')
      badge.className = 'tile-badge'
      badge.textContent = t('Вставлено')
      tile.appendChild(text)
      tile.appendChild(badge)
    } else {
      const thumb = doc.createElement('span')
      thumb.className = 'attachment-thumb tile-img'
      tile.appendChild(thumb)
    }

    const remove = doc.createElement('button')
    remove.type = 'button'
    remove.className = 'tile-remove'
    remove.setAttribute('aria-label', 'Убрать вложение')
    remove.innerHTML = CROSS
    remove.addEventListener('click', event => {
      if (event && event.stopPropagation) event.stopPropagation()
      onRemove(item)
    })
    tile.appendChild(remove)
    return tile
  }

  // Отправленное сообщение: те же плитки, только меньше и без крестика; остальные вложения — прежняя полоса с именем.
  // Снимок «только для хода» (modelOnly) не рисуется: человек его не прикладывал.
  function sentHtml (list, { escapeHtml = text => String(text), kindLabel = {}, t = text => text } = {}) {
    const items = (Array.isArray(list) ? list : []).filter(item => item && !item.modelOnly)
    if (!items.length) return ''
    const body = items.map(item => {
      if (item.pasted === true) {
        const tip = escapeHtml(t('Вставленный текст, строк: %s', item.lines || 1))
        return `<div class="attachment-tile kind-text is-pasted" data-tooltip="${tip}"><span class="tile-text">${escapeHtml(item.preview || '')}</span><span class="tile-badge">${escapeHtml(t('Вставлено'))}</span></div>`
      }
      if (item.kind === 'image') {
        return `<div class="attachment-tile kind-image" data-thumb="${escapeHtml(item.path || '')}" data-tooltip="${escapeHtml(item.name || item.path || '')}"><span class="attachment-thumb tile-img"></span></div>`
      }
      return `<div class="attachment-chip kind-${escapeHtml(item.kind || 'binary')}" data-tooltip="${escapeHtml(item.path || '')}"><span class="attachment-name">${escapeHtml(item.name || '')}</span><span class="attachment-meta">${escapeHtml(kindLabel[item.kind] || item.kind || '')}</span></div>`
    }).join('')
    return `<div class="attachment-strip sent">${body}</div>`
  }

  const api = { LONG_CHARS, LONG_LINES, isLongPaste, isTile, buildTile, sentHtml }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyonePasteTiles = api
})(typeof window !== 'undefined' ? window : globalThis)
