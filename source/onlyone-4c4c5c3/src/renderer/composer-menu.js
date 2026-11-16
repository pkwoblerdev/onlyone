// Компактный список команд и режимов над «/» (план, 3.10).
//
// Один список на два места: команды над полем ввода и режимы над пилюлей.
// Модуль не знает, какие команды существуют и что такое режимы: пункты приносят
// вызывающие (`app.js` для команд, пилюля для режимов) и сами забирают выбор в
// onPick. Ни моста, ни сети, ни настроек: всё нужное извне приходит через deps.
//
// Координаты считает JS (зазор 6 px, левый край по якорю, ширина по самому
// длинному имени), а внешний вид держит composer-menu.css: здесь только те
// числа, которые без измерения текста не вычислить.
(function (root) {
  'use strict'

  const GAP = 6                 // низ списка над верхом якоря — цифра из поручения
  const NAME_SLACK = 24         // ширина = имя + 24 px: отступы списка и строки
  const MIN_WIDTH = 160
  const MAX_WIDTH = 240
  const HINT_GAP = 8            // подсказка стоит справа от списка, а не над ним
  const EDGE = 8                // ни один блок не липнет к краю окна
  const CHAR_GUESS = 7          // прикидка ширины символа, если 2d-контекста нет
  const OPTION_ID = 'onlyone-composer-menu-option-'

  const ROOT_CLASS = 'composer-menu'
  const ROW_CLASS = 'composer-menu-row'
  const NAME_CLASS = 'composer-menu-name'
  const HINT_CLASS = 'composer-menu-hint'
  const SHOWN_CLASS = 'is-shown'

  const num = value => {
    const parsed = parseFloat(String(value))
    return Number.isFinite(parsed) ? parsed : 0
  }

  function create (deps) {
    const doc = deps.document
    const win = deps.window
    const t = typeof deps.t === 'function' ? deps.t : value => String(value)

    let ownRoot = null          // список, когда host не прислали
    let rootEl = null           // узел списка: чужой host или ownRoot
    let ownsRoot = false
    let addedRole = false       // role="listbox" навешен нами — нам и снимать
    let hintEl = null
    let anchor = null
    let items = []
    let rowEls = []
    let onPick = null
    let itemClass = ''
    let nameClass = ''
    let index = 0
    let opened = false
    let menuLeft = 0
    let menuWidth = 0
    let ruler = null            // одно полотно для замеров ширины имён
    const bound = []            // вся проводка: снять её надо целиком

    function on (target, type, fn) {
      if (!target || typeof target.addEventListener !== 'function') return
      target.addEventListener(type, fn)
      bound.push([target, type, fn])
    }

    function offAll () {
      while (bound.length) {
        const one = bound.pop()
        if (typeof one[0].removeEventListener === 'function') one[0].removeEventListener(one[1], one[2])
      }
    }

    function rectOf (el) {
      return el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
    }

    // Свои размеры мерим по offsetHeight: getBoundingClientRect во время
    // появления отдаёт уменьшенный масштабом rect, и зазор в 6 px поехал бы.
    function selfHeight (el) {
      return el && Number.isFinite(el.offsetHeight) && el.offsetHeight > 0 ? el.offsetHeight : 0
    }

    function uiFont () {
      try {
        const family = String(win.getComputedStyle(doc.documentElement).getPropertyValue('--font-ui') || '').trim()
        if (family) return '400 13.5px ' + family
      } catch { /* подставка без токенов: измеряем в default-шрифте */ }
      return '400 13.5px sans-serif'
    }

    // Длина имени в пикселях: без неё формулу ширины не посчитать, а прикидка
    // по числу символов врёт и на «/effort», и на «Accept Edits» сразу.
    function measure (text) {
      const value = String(text == null ? '' : text)
      try {
        if (!ruler) ruler = doc.createElement('canvas')
        const ctx = ruler.getContext && ruler.getContext('2d')
        if (ctx) {
          ctx.font = uiFont()
          const width = Number(ctx.measureText(value).width)
          if (Number.isFinite(width) && width >= 0) return width
        }
      } catch { /* canvas недоступен */ }
      return value.length * CHAR_GUESS
    }

    // У поля ввода край держат по началу наборного текста, у кнопки — по её
    // рамке: внутреннюю отбивку знают только поля.
    function anchorLeft (el, rect) {
      const tag = String(el.tagName || '').toUpperCase()
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && !el.isContentEditable) return rect.left
      let style = null
      try { style = win.getComputedStyle(el) } catch { style = null }
      if (!style) return rect.left
      return rect.left + num(style.paddingLeft) + num(style.borderLeftWidth)
    }

    function rootFor (host) {
      if (host) {
        host.classList.add(ROOT_CLASS)
        if (!host.getAttribute('role')) {
          host.setAttribute('role', 'listbox')
          addedRole = true
        }
        return host
      }
      if (!ownRoot) {
        ownRoot = doc.createElement('div')
        ownRoot.className = ROOT_CLASS
      }
      // Класс снимает close(), а владение узлом переживает закрытие: сюда
      // заходят и на втором, и на десятом open одного экземпляра.
      ownRoot.classList.add(ROOT_CLASS)
      ownRoot.setAttribute('role', 'listbox')
      if (!ownRoot.parentNode && doc.body) doc.body.appendChild(ownRoot)
      return ownRoot
    }

    function rowNode (item, at) {
      const row = doc.createElement('div')
      row.className = ROW_CLASS + (itemClass ? ' ' + itemClass : '')
      row.setAttribute('role', 'option')
      row.setAttribute('id', OPTION_ID + at)
      row.setAttribute('aria-selected', 'false')
      // Текст — только текстовым узлом: собирать из данных разметку нельзя,
      // тогда и name, и hint попадают в DOM как есть, без экранирования-гадалки.
      const name = doc.createElement('span')
      name.className = NAME_CLASS + (nameClass ? ' ' + nameClass : '')
      name.textContent = item && item.name != null ? String(item.name) : ''
      row.appendChild(name)
      return row
    }

    function clearRows () {
      if (!rootEl) return
      while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild)
      rowEls = []
    }

    function renderRows () {
      clearRows()
      if (!rootEl || typeof doc.createDocumentFragment !== 'function') return
      const box = doc.createDocumentFragment()
      rowEls = items.map((item, at) => {
        const row = rowNode(item, at)
        box.appendChild(row)
        return row
      })
      rootEl.appendChild(box)
    }

    function clampIndex (value) {
      const wanted = Number.isInteger(value) ? value : 0
      return Math.max(0, Math.min(rowEls.length - 1, wanted))
    }

    function hideHint () {
      if (!hintEl) return
      hintEl.classList.remove(SHOWN_CLASS)
    }

    function hintNode () {
      if (hintEl) return hintEl
      hintEl = doc.createElement('div')
      hintEl.className = HINT_CLASS
      if (doc.body) doc.body.appendChild(hintEl)
      return hintEl
    }

    // Подсказка — отдельный узел вне строк: в host её класть нельзя, она
    // попала бы в children списка режимов и сбила бы соседний подсчёт.
    function showHint (at) {
      const item = items[at]
      const text = item && item.hint ? t(String(item.hint)) : ''
      if (!text) { hideHint(); return }
      const hint = hintNode()
      hint.textContent = text
      hint.classList.add(SHOWN_CLASS)
      const row = rowEls[at]
      const rowRect = rectOf(row)
      if (!rowRect || !hint.parentNode) return
      const height = selfHeight(hint) || rectOf(hint).height || 0
      const width = (Number.isFinite(hint.offsetWidth) && hint.offsetWidth) || 0
      let left = menuLeft + menuWidth + HINT_GAP
      const viewWidth = num(win && win.innerWidth) || 0
      if (viewWidth && left + width > viewWidth - EDGE) left = Math.max(EDGE, viewWidth - EDGE - width)
      hint.style.left = Math.round(left) + 'px'
      hint.style.top = Math.round(Math.max(EDGE, rowRect.top + rowRect.height / 2 - height / 2)) + 'px'
    }

    function select (next, withHint) {
      if (!rowEls.length || !rootEl) return
      index = Math.max(0, Math.min(rowEls.length - 1, next))
      rowEls.forEach((row, at) => row.setAttribute('aria-selected', at === index ? 'true' : 'false'))
      rootEl.setAttribute('aria-activedescendant', rowEls[index].getAttribute('id') || '')
      if (withHint) showHint(index)
    }

    function place () {
      if (!rootEl) return
      const widest = items.reduce((best, item) => Math.max(best, measure(item && item.name)), 0)
      menuWidth = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, widest + NAME_SLACK)))
      rootEl.style.width = menuWidth + 'px'
      const rect = rectOf(anchor)
      if (!rect) return
      menuLeft = Math.round(anchorLeft(anchor, rect))
      const height = selfHeight(rootEl) || rectOf(rootEl).height || 0
      rootEl.style.left = menuLeft + 'px'
      // Список над якорем: координаты считаем от фактической высоты блока,
      // иначе десять строк и тридцать едут в разные стороны.
      rootEl.style.top = Math.round(rect.top - GAP - height) + 'px'
    }

    function rowAt (target) {
      if (!target || typeof target.closest !== 'function') return -1
      const row = target.closest('[role="option"]')
      return row ? rowEls.indexOf(row) : -1
    }

    function inside (el, target) {
      if (!el || !target) return false
      return typeof el.contains === 'function' ? el.contains(target) : false
    }

    function onKeyDown (event) {
      if (!opened || (event && event.defaultPrevented)) return
      const key = String((event && event.key) || '')
      if (key === 'Escape') { close(); return }
      // ↑↓ здесь, а не в вызывающем коде: список сам знает, где его выбор.
      if (key === 'ArrowDown') { if (event.preventDefault) event.preventDefault(); move(1); return }
      if (key === 'ArrowUp') { if (event.preventDefault) event.preventDefault(); move(-1) }
    }

    function onPointerDown (event) {
      if (!opened) return
      const target = event && event.target
      if (inside(rootEl, target) || inside(anchor, target)) return
      close()
    }

    function onClick (event) {
      if (!opened) return
      const target = event && event.target
      const at = rowAt(target)
      if (at >= 0) { choose(at); return }
      if (inside(rootEl, target) || inside(anchor, target)) return
      close()
    }

    function onHover (event) {
      if (!opened) return
      const at = rowAt(event && event.target)
      if (at >= 0) showHint(at)
    }

    function close () {
      opened = false
      offAll()
      hideHint()
      clearRows()
      if (rootEl) {
        rootEl.removeAttribute('aria-activedescendant')
        // Чужой host остаётся узлом экрана, поэтому свои классы и свой role
        // снимаем у обоих: закрытый список не должен держать новую раскладку.
        rootEl.classList.remove(ROOT_CLASS)
        if (addedRole) rootEl.removeAttribute('role')
        if (ownsRoot && rootEl.parentNode) rootEl.remove()
      }
      rootEl = null
      ownsRoot = false
      addedRole = false
    }

    function open (options) {
      const opts = options || {}
      close()
      items = Array.isArray(opts.items) ? opts.items.slice() : []
      onPick = typeof opts.onPick === 'function' ? opts.onPick : null
      anchor = opts.anchor || null
      itemClass = String(opts.itemClass || '')
      nameClass = String(opts.nameClass || '')
      rootEl = rootFor(opts.host || null)
      ownsRoot = !opts.host
      if (opts.ariaLabel) rootEl.setAttribute('aria-label', String(opts.ariaLabel))
      renderRows()
      select(clampIndex(opts.selected), false)
      place()
      on(doc, 'keydown', onKeyDown)
      on(doc, 'click', onClick)
      on(doc, 'pointerdown', onPointerDown)
      on(doc, 'pointerover', onHover)
      on(doc, 'mouseover', onHover)
      opened = true
    }

    // Клик по строке и выбор с клавиатуры ведут в одно место: вызывающий код
    // получает пункт и сам решает, чем он для него (команда или режим).
    function choose (at) {
      const item = items[at]
      close()
      if (item && onPick) onPick(item)
      return item || null
    }

    function move (delta) {
      if (!opened || !rowEls.length) return null
      const step = Number(delta) || 0
      select(index + step, true)
      return items[index] || null
    }

    function accept () {
      if (!opened || !rowEls.length) return null
      const item = items[index] || null
      close()
      return item
    }

    function isOpen () {
      return opened
    }

    function dispose () {
      close()
      items = []
      onPick = null
      anchor = null
      if (hintEl && hintEl.parentNode) hintEl.remove()
      hintEl = null
      if (ownRoot && ownRoot.parentNode) ownRoot.remove()
      ownRoot = null
    }

    return Object.freeze({ open, close, move, accept, isOpen, dispose })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneComposerMenu = api
})(typeof window === 'object' ? window : globalThis)
