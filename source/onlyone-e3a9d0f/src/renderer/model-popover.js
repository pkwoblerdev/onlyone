/* Выбор модели и глубины мышления выпадающими блоками у поля ввода.
 *
 * Было: пилюля «модель + effort + шеврон» открывала окно-каталог на весь экран. Стало, как
 * список у Claude: блок над кнопкой — поиск, прокручиваемый список ВСЕХ моделей и внизу Fast.
 * Окна-каталога больше нет: листать и искать нужно здесь же.
 * Effort — отдельная кнопка рядом со своим блоком; кольцо контекста стоит правее и от них
 * не зависит.
 *
 * Модуль не знает о состоянии приложения: всё приходит через `deps` и обратно уходит
 * теми же функциями (setModel, setEffort, setFast).
 */
(function (root) {
  'use strict'

  function cleanModelName (name) {
    if (!name) return ''
    return String(name).replace(/^[A-Za-z0-9._ -]+:\s*/, '').trim() || name
  }

  function create (deps) {
    const { $, t, escapeHtml, document } = deps
    let open = null        // 'model' | 'effort' | null
    let customAnchor = null  // кнопка модели в другом экране (Дизайн): блок встаёт у неё
    let picker = null        // {current, onPick}: выбор модели не для чата, а для другого места (команда агентов)
    let wired = false

    const pop = () => $('modelPopover')
    const efp = () => $('effortPopover')
    const modelBtn = () => $('modelEffortPillBtn')
    const effortBtn = () => $('effortPillBtn')

    function place (popover, anchor) {
      const rect = anchor.getBoundingClientRect()
      const width = popover.offsetWidth || 320
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
      popover.style.left = left + 'px'
      popover.style.bottom = Math.max(8, window.innerHeight - rect.top + 8) + 'px'
    }

    function close () {
      const m = pop(); const e = efp()
      if (m) m.hidden = true
      if (e) e.hidden = true
      modelBtn()?.setAttribute('aria-expanded', 'false')
      effortBtn()?.setAttribute('aria-expanded', 'false')
      open = null
    }

    // ─── модели ────────────────────────────────────────────────────────────────
    function rowsFor (query) {
      const catalog = deps.getCatalog() || []
      const q = String(query || '').trim().toLowerCase()
      // «Auto Router» и подобные — не модель, а выбор за человека: в списке ему не место, называть нужно конкретную.
      const isAuto = m => /(^|[/])auto(:|$)/i.test(m.id || '') || /auto[ _-]*router/i.test(m.name || '')
      const usable = catalog.filter(m => !m.unavailable && !isAuto(m))
      const list = q
        ? usable.filter(m => (m.name || '').toLowerCase().includes(q) || (m.id || '').toLowerCase().includes(q) ||
          (m.provider || '').toLowerCase().includes(q))
        : usable
      // Без поиска — весь каталог, выбранная модель первой; список прокручивается.
      const picked = picker ? (catalog.find(m => m.id === picker.current) || null) : deps.getSelected()
      const ordered = q || !picked ? list : [picked, ...list.filter(m => m.id !== picked.id)]
      return { list: ordered, total: list.length, searching: Boolean(q) }
    }

    function renderModels () {
      const box = pop()
      if (!box) return
      const selected = picker ? ((deps.getCatalog() || []).find(m => m.id === picker.current) || null) : deps.getSelected()
      const query = box.querySelector('.mp-search')?.value || ''
      const { list, total, searching } = rowsFor(query)
      const holder = box.querySelector('.mp-list')
      holder.replaceChildren()
      if (!list.length) {
        const empty = document.createElement('div')
        empty.className = 'mp-empty'
        empty.textContent = t('Модели не найдены')
        holder.appendChild(empty)
      }
      for (const model of list) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'mp-row' + (selected && model.id === selected.id ? ' is-selected' : '')
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', String(Boolean(selected && model.id === selected.id)))
        const price = model.isFree ? 'Free' : deps.formatPrice(model.promptPrice)
        row.innerHTML = `
          <span class="mp-name">${escapeHtml(cleanModelName(model.name))}</span>
          ${price ? `<span class="mp-price${model.isFree ? ' is-free' : ''}">${escapeHtml(price)}</span>` : ''}
          <svg class="mp-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 8.4 6.6 11.4 12.6 4.8"/></svg>`
        row.addEventListener('click', () => { const pick = picker; close(); if (pick) pick.onPick(model); else deps.setModel(model) })
        holder.appendChild(row)
      }
      // Свёрнутый список открывается на выбранной модели.
      const current = holder.querySelector('.is-selected')
      if (current && !searching) current.scrollIntoView({ block: 'nearest' })
      renderFast()
    }

    function renderFast () {
      const box = pop()
      const row = box && box.querySelector('.mp-fast')
      if (!row) return
      const allowed = deps.fastAllowed()
      const on = deps.isFast()
      row.setAttribute('aria-pressed', String(on))
      row.disabled = !allowed && !on
      // Строка называется просто «Fast»: пояснение появляется, только когда режим недоступен
      if (allowed || on) delete row.dataset.tooltip
      else row.dataset.tooltip = t('Fast доступен для бесплатных моделей и GLM 5.3 Flash')
    }

    function openModels (anchorEl, pickMode) {
      const box = pop(); const anchor = anchorEl || modelBtn()
      if (!box || !anchor) return
      close()
      customAnchor = anchorEl || null
      picker = pickMode && typeof pickMode.onPick === 'function' ? pickMode : null
      const foot = box.querySelector('.mp-foot')
      if (foot) foot.hidden = Boolean(picker)
      box.hidden = false
      open = 'model'
      anchor.setAttribute('aria-expanded', 'true')
      const search = box.querySelector('.mp-search')
      search.value = ''
      renderModels()
      place(box, anchor)
      search.focus()
    }

    // ─── effort ────────────────────────────────────────────────────────────────
    function renderEffort () {
      const box = efp()
      if (!box) return
      const stops = deps.effortStops()
      const current = deps.getEffort()
      const fast = deps.isFast()
      box.replaceChildren()
      // У модели без списка ступеней глубина одна и не выбирается (например, Max): блок показывает
      // её единственной отмеченной строкой, а не пустым окном.
      const shown = stops.length ? [...stops].reverse() : (current && current !== 'off' ? [current] : [])
      for (const stop of shown) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'mp-row' + (!fast && stop === current ? ' is-selected' : '')
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', String(!fast && stop === current))
        row.disabled = fast || !stops.length
        row.innerHTML = `<span class="mp-name">${escapeHtml(deps.effortLabel(stop))}</span>
          <svg class="mp-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 8.4 6.6 11.4 12.6 4.8"/></svg>`
        row.addEventListener('click', () => { deps.setEffort(stop); close() })
        box.appendChild(row)
      }
      if (fast) {
        const note = document.createElement('div')
        note.className = 'mp-more'
        note.textContent = t('Включён Fast: глубину выбирает он сам')
        box.appendChild(note)
      }
    }

    function openEffort () {
      const box = efp(); const anchor = effortBtn()
      if (!box || !anchor || anchor.hidden) return
      close()
      renderEffort()
      box.hidden = false
      open = 'effort'
      anchor.setAttribute('aria-expanded', 'true')
      place(box, anchor)
      box.querySelector('.is-selected, .mp-row')?.focus()
    }

    // Кнопка Effort видна, только когда у модели есть что выбирать; подпись рисует app.js.
    function syncEffort () {
      const button = effortBtn()
      if (!button) return
      const label = $('pillEffortName')
      const visible = Boolean(label && label.style.display !== 'none' && label.textContent)
      button.hidden = !visible
      if (!visible && open === 'effort') close()
    }

    function wire () {
      if (wired) return
      wired = true
      modelBtn()?.addEventListener('click', event => { event.stopPropagation(); open === 'model' ? close() : openModels() })
      effortBtn()?.addEventListener('click', event => { event.stopPropagation(); open === 'effort' ? close() : openEffort() })
      pop()?.querySelector('.mp-search')?.addEventListener('input', renderModels)
      pop()?.querySelector('.mp-search')?.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); pop().querySelector('.mp-row')?.focus() }
        if (event.key === 'Enter') { event.preventDefault(); if (event.isComposing || event.keyCode === 229) return; pop().querySelector('.mp-row')?.click() }
      })
      pop()?.querySelector('.mp-fast')?.addEventListener('click', () => { deps.setFast(!deps.isFast()); renderFast(); renderEffort() })
      for (const box of [pop(), efp()]) {
        box?.addEventListener('keydown', event => {
          const rows = [...box.querySelectorAll('.mp-row:not(:disabled)')]
          const at = rows.indexOf(document.activeElement)
          if (event.key === 'ArrowDown' && at >= 0) { event.preventDefault(); rows[Math.min(rows.length - 1, at + 1)].focus() }
          if (event.key === 'ArrowUp' && at >= 0) { event.preventDefault(); if (at === 0 && box === pop()) box.querySelector('.mp-search').focus(); else rows[Math.max(0, at - 1)].focus() }
        })
      }
      document.addEventListener('mousedown', event => {
        if (!open) return
        if (pop()?.contains(event.target) || efp()?.contains(event.target) || modelBtn()?.contains(event.target) || effortBtn()?.contains(event.target) || customAnchor?.contains(event.target)) return
        close()
      }, true)
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && open) { const anchor = open === 'model' ? (customAnchor || modelBtn()) : effortBtn(); close(); anchor?.focus() }
      }, true)
      window.addEventListener('resize', close)
    }

    return { wire, openModels, openEffort, close, syncEffort, renderFast, isOpen: () => open }
  }

  const api = { create, cleanModelName }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneModelPopover = api
})(typeof window !== 'undefined' ? window : globalThis)
