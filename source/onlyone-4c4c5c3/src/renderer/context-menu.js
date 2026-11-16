/* Общее контекстное меню окна (план, 2d).
 *
 * Им пользуются строки диалогов, проекты, скиллы, панель артефактов и раздел
 * «Дизайн» — один виджет на всё приложение, как боковая панель является
 * эталоном внешнего вида. Поведение:Escape закрывает, стрелки ходят по пунктам,
 * меню не залезает за край экрана (замер, а не догадка: размер известен только
 * после вставки в документ), фокус возвращается в меню, а не теряется.
 *
 * Модуль не знает ни о каких данных: пункты приходят списком
 * { label, hint, heading, danger, disabled, checked, submenu, keepOpen, onPick }
 * или { separator: true }.
 */
(function (root) {
  'use strict'

  function create(deps) {
    const { t, escapeHtml, formatWithEmoji, document, window } = deps
    let openMenu = null

    function close() {
      if (!openMenu) return
      openMenu.remove()
      openMenu = null
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }

    function onOutside(e) {
      if (openMenu && !openMenu.contains(e.target)) close()
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...openMenu.querySelectorAll('.ctx-item:not([disabled])')]
      if (!items.length) return
      const at = items.indexOf(document.activeElement)
      const next = e.key === 'ArrowDown' ? at + 1 : at - 1
      items[(next + items.length) % items.length].focus()
    }

    function open(x, y, items) {
      close()

      const menu = document.createElement('div')
      menu.className = 'ctx-menu'
      menu.setAttribute('role', 'menu')

      for (const item of items) {
        if (item.separator) {
          const hr = document.createElement('div')
          hr.className = 'ctx-sep'
          menu.appendChild(hr)
          continue
        }
        if (item.heading) {
          const head = document.createElement('div')
          head.className = 'ctx-heading'
          head.textContent = t(item.heading)
          menu.appendChild(head)
          continue
        }

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.checked ? ' checked' : '')
        button.setAttribute('role', 'menuitem')
        if (item.disabled) button.disabled = true
        button.innerHTML = `
          <span class="ctx-label">${formatWithEmoji(escapeHtml(t(item.label)))}</span>
          ${item.checked ? '<svg fill="none" class="icon small ctx-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 8.4l3 3 6.2-6.6"/></svg>' : ''}
          ${item.hint ? `<span class="ctx-hint"><bdi>${formatWithEmoji(escapeHtml(item.hint))}</bdi></span>` : ''}
          ${item.submenu ? '<svg fill="none" class="icon small ctx-more" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.2L10.8 8 6 12.8"/></svg>' : ''}
        `
        button.addEventListener('click', () => {
          // A drill-down replaces the menu, so it must not be torn down first.
          if (!item.keepOpen) close()
          item.onPick?.()
        })
        menu.appendChild(button)
      }

      // Off-screen placement is measured, not guessed: the menu is sized only
      // once it is in the document.
      menu.style.visibility = 'hidden'
      document.body.appendChild(menu)
      const box = menu.getBoundingClientRect()
      const left = Math.max(6, Math.min(x, window.innerWidth - box.width - 6))
      const top = Math.max(6, Math.min(y, window.innerHeight - box.height - 6))
      menu.style.left = `${left}px`
      menu.style.top = `${top}px`
      menu.style.visibility = ''

      openMenu = menu
      document.addEventListener('pointerdown', onOutside, true)
      document.addEventListener('keydown', onKey, true)
      window.addEventListener('blur', close)
      window.addEventListener('resize', close)

      menu.querySelector('.ctx-item:not([disabled])')?.focus()
      return { menu, left, top }
    }

    return Object.freeze({ open, close })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneContextMenu = api
})(typeof window === 'object' ? window : globalThis)
