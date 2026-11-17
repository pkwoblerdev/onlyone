/* Свой выпадающий список (план, 1.2) — виджет окна (план, 2d).
 *
 * Родной <select> остаётся в документе невидимым и хранит значение: код,
 * который читает select.value, меняет его и слушает «change», работает как
 * раньше. Запись значения из кода сразу видна и в своём списке. Список — из
 * дизайн-системы, а не окно Windows: окно со своими списками выглядит чужим и
 * не переводится (план, 1.3).
 */
(function (root) {
  'use strict'

  function create(deps) {
    const { escapeHtml, document, window } = deps
    const SELECT_VALUE = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')
    const SELECT_INDEX = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'selectedIndex')

    function enhance(select) {
      if (!select || select.dataset.enhanced || !window.OnlyoneUI?.mount) return
      select.dataset.enhanced = '1'
      const wrap = document.createElement('div')
      wrap.className = 'one-ui select-ui'
      const listId = `${select.id || `select-${Math.random().toString(36).slice(2)}`}-options`
      wrap.innerHTML = `
        <div class="ui-select">
          <button type="button" class="ui-button select-ui-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${listId}">
            <span data-value-label></span>
            <svg fill="none" class="ui-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 5.6L8 10.4l4.8-4.8"/></svg>
          </button>
          <ul id="${listId}" class="ui-options" role="listbox" hidden></ul>
        </div>`
      select.after(wrap)
      select.classList.add('select-native')
      select.tabIndex = -1
      select.setAttribute('aria-hidden', 'true')
      const box = wrap.querySelector('.ui-select')
      const trigger = wrap.querySelector('.select-ui-trigger')
      const list = wrap.querySelector('[role="listbox"]')
      // Подпись поля переходит к видимой кнопке: у скрытого списка её никто не прочтёт.
      const label = select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null
      if (label) {
        label.id = label.id || `${select.id}-label`
        label.htmlFor = ''
        label.addEventListener('click', () => trigger.focus())
        trigger.setAttribute('aria-labelledby', label.id)
        list.setAttribute('aria-labelledby', label.id)
      }
      // Без <label> имя поля — в aria-label самого списка; кнопке оно нужно вместе
      // со значением, иначе чтец экрана назовёт только «Кодер» без «Роль ключа».
      const ariaName = label ? '' : select.getAttribute('aria-label') || ''
      let dispose = null

      const sync = () => {
        const current = select.options[SELECT_INDEX.get.call(select)]
        wrap.querySelector('[data-value-label]').textContent = current ? current.textContent : ''
        if (ariaName) trigger.setAttribute('aria-label', `${ariaName}: ${current ? current.textContent : ''}`)
        box.dataset.value = SELECT_VALUE.get.call(select)
        for (const option of list.children) option.setAttribute('aria-selected', String(option.dataset.value === box.dataset.value))
        trigger.disabled = select.disabled
      }
      const build = () => {
        list.innerHTML = [...select.options].map(option =>
          `<li class="ui-option" role="option" tabindex="-1" aria-selected="false" data-value="${escapeHtml(option.value)}">${escapeHtml(option.textContent)}</li>`).join('')
        sync()
        dispose?.()
        dispose = window.OnlyoneUI.mount(wrap)
      }

      Object.defineProperty(select, 'value', {
        configurable: true,
        get() { return SELECT_VALUE.get.call(this) },
        set(value) { SELECT_VALUE.set.call(this, value); sync() }
      })
      Object.defineProperty(select, 'selectedIndex', {
        configurable: true,
        get() { return SELECT_INDEX.get.call(this) },
        set(index) { SELECT_INDEX.set.call(this, index); sync() }
      })
      // Выбор в своём списке — в родной и дальше обычным «change». Своё событие
      // списка наружу не всплывает: слушатели ждут «change» от <select>.
      box.addEventListener('change', event => {
        event.stopPropagation()
        if (box.dataset.value === SELECT_VALUE.get.call(select)) return
        SELECT_VALUE.set.call(select, box.dataset.value)
        select.dispatchEvent(new Event('input', { bubbles: true }))
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      // Варианты меняются (перевод, новые пункты) — список пересобирается.
      new MutationObserver(build).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] })
      build()
    }

    return Object.freeze({ enhance })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneSelectWidget = api
})(typeof window === 'object' ? window : globalThis)
