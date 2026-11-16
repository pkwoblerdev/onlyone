/* Общий набор для страниц разделов по макету (audits/ui-2026-10-18/onlyone-mockup.html):
 * значки в рисовке боковой панели, строители разметки (кнопка, ссылка, переключатель,
 * сегменты, группа, строка, поле с подписью), шаблон состояния и пружинное появление.
 *
 * Разметка собирается в области `.mk` (стили — look-pages.css), чтобы старые классы
 * приложения (.btn, .seg, .state, .list) не путались с новыми. Тексты идут через
 * общий переводчик окна `window.__t`: строки собираются после того, как словарь обошёл
 * разметку, и без него остались бы русскими в английском интерфейсе.
 */
(function (root) {
  'use strict'

  const t = (text, ...args) => (root.__t ? root.__t(text, ...args) : text)

  const I = {
    check: '<path d="M3.4 8.4l3 3 6.2-6.6"/>',
    close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.1 1.4"/>',
    stop: '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.6"/>',
    edit: '<path d="M2.6 12.4c0-1.2.6-2.1 1.5-2.5l4.8-4.8a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4l-4.8 4.8c-.4.9-1.3 1.5-2.5 1.5H2.6zM9.6 13.4h3.8"/>',
    file: '<path d="M9 2.2H4.6c-.9 0-1.6.7-1.6 1.6v8.4c0 .9.7 1.6 1.6 1.6h6.8c.9 0 1.6-.7 1.6-1.6V6.2zM9 2.2v4h4"/>',
    globe: '<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c1.5 1.6 2.2 3.5 2.2 5.6s-.7 4-2.2 5.6c-1.5-1.6-2.2-3.5-2.2-5.6S6.5 4 8 2.4z"/>',
    key: '<circle cx="5.4" cy="10.6" r="2.4"/><path d="M7.1 8.9l5.1-5.1M10.6 5.4l1.6 1.6"/>',
    retry: '<path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4"/><path d="M11.8 2.2V5H9"/>',
    copy: '<rect x="5.6" y="5.6" width="8" height="8" rx="2"/><path d="M10.4 3.6c-.2-.8-.9-1.4-1.7-1.4H4c-1 0-1.8.8-1.8 1.8v4.7c0 .8.6 1.5 1.4 1.7"/>',
    alert: '<path d="M8 2.6l5.8 10.2H2.2z"/><path d="M8 6.6v2.8M8 11v.01"/>',
    chevron: '<path d="M3.2 5.6L8 10.4l4.8-4.8"/>',
    chevR: '<path d="M6 3.2l4.8 4.8L6 12.8"/>',
    terminal: '<rect x="2.2" y="3" width="11.6" height="10" rx="2.4"/><path d="M5 6.4l1.8 1.6L5 9.6M8.4 9.6H11"/>',
    search: '<circle cx="7.2" cy="7.2" r="4"/><path d="M10.2 10.2l3 3"/>',
    folder: '<path d="M2.3 5.1c0-.9.7-1.6 1.6-1.6h2l1.4 1.8h5c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H3.9c-.9 0-1.6-.7-1.6-1.6z"/>',
    skill: '<path d="M8 2.2l1.5 3.9 3.9 1.5-3.9 1.5L8 13l-1.5-3.9L2.6 7.6l3.9-1.5z"/>',
    plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    more: '<circle cx="3.8" cy="8" r=".75"/><circle cx="8" cy="8" r=".75"/><circle cx="12.2" cy="8" r=".75"/>',
    trash: '<path d="M3.4 4.6h9.2M6.4 4.6V3.4h3.2v1.2M5 4.6l.5 8h5l.5-8"/>',
    user: '<circle cx="8" cy="5.6" r="2.4"/><path d="M3.4 13.2c.5-2.1 2.3-3.4 4.6-3.4s4.1 1.3 4.6 3.4"/>',
    look: '<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4v11.2M8 5l3.8-1.4M8 8.4l5.4-1.6M8 11.6l4.2-1.8"/>',
    sliders: '<path d="M2.6 5.4h10.8M2.6 10.6h10.8"/><circle cx="6" cy="5.4" r="1.7"/><circle cx="10.4" cy="10.6" r="1.7"/>',
    keyboard: '<rect x="2.2" y="4" width="11.6" height="8" rx="2.4"/><path d="M5.4 9.6h5.2M5.2 6.8h.01M8 6.8h.01M10.8 6.8h.01"/>',
    update: '<path d="M3.2 8a4.8 4.8 0 0 1 8.5-3.1M12.8 8a4.8 4.8 0 0 1-8.5 3.1M11.8 2.4v2.6H9.2M4.2 13.6V11h2.6"/>',
    lock: '<rect x="3.4" y="7" width="9.2" height="6.4" rx="2"/><path d="M5.4 7V5.4a2.6 2.6 0 0 1 5.2 0V7"/>',
    design: '<path d="M2.6 12.4c0-1.2.6-2.1 1.5-2.5l5.6-5.6a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4l-5.6 5.6c-.4.9-1.3 1.5-2.5 1.5H2.6z"/>',
    mcp: '<circle cx="8" cy="3.7" r="1.7"/><circle cx="3.8" cy="12.2" r="1.7"/><circle cx="12.2" cy="12.2" r="1.7"/><path d="M7.1 5.3L4.7 10.6M8.9 5.3l2.4 5.3M5.5 12.2h5"/>',
    team: '<circle cx="5.6" cy="5.8" r="2"/><circle cx="11" cy="6.6" r="1.6"/><path d="M2.2 12.8c.4-1.9 1.8-3 3.4-3s3 1.1 3.4 3M9.6 9.8c1.6-.4 3.6.4 4.2 2.6"/>',
    phone: '<rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.8"/><path d="M7 12h2"/>',
    back: '<path d="M9.8 3.4L5.2 8l4.6 4.6"/>',
    download: '<path d="M8 2.6v7.6M4.8 7.2L8 10.4l3.2-3.2M3 13.2h10"/>',
    upload: '<path d="M8 10.4V2.8M4.8 6L8 2.8 11.2 6M3 13.2h10"/>',
    external: '<path d="M6.4 3.4H3.6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.6M9.4 2.6h4v4M13.4 2.6L7.6 8.4"/>',
    target: '<path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/><circle cx="8" cy="8" r="2.5"/>',
    play: '<path d="M5 3.4l7.4 4.6L5 12.6z"/>',
    send: '<path d="M8 12.8V3.2M4 7.2l4-4 4 4"/>'
  }
  const ico = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 16 16" aria-hidden="true">${I[name] || ''}</svg>`
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const plural = (n, one, few, many) => {
    const a = n % 10, b = n % 100
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many
  }
  // Знак onlyone в состояниях: пусто — цветом искры, сбой — приглушён (символ #mark в index.html)
  const art = (size = 32, mood = 'idle') =>
    `<svg class="state-mark${mood === 'sad' ? ' sad' : ''}" viewBox="10.5 10.5 43 43" width="${size}" height="${size}" aria-hidden="true"><use href="#mark"/></svg>`

  // Строители. o.x — действие (data-x), o.attrs — сырые атрибуты, o.dis — недоступно
  const attrs = o => (o.x ? ` data-x="${o.x}"` : '') + (o.id ? ` id="${o.id}"` : '') + (o.attrs || '') + (o.dis ? ' disabled' : '')
  const B = (label, o = {}) => `<button class="btn btn-${o.kind || 'quiet'}${o.sm ? ' btn-sm' : ''}" type="${o.type || 'button'}"${attrs(o)}>${o.icon ? ico(o.icon, 'i-sm') : ''}<span>${label}</span></button>`
  const L = (label, o = {}) => `<button class="lnk${o.accent ? ' lnk-accent' : ''}${o.danger ? ' lnk-danger' : ''}" type="button"${attrs(o)}>${o.icon ? ico(o.icon, 'i-sm') : ''}${label}</button>`
  const IX = (icon, label, o = {}) => `<button class="ibtn" type="button" aria-label="${esc(label)}" data-tooltip="${esc(o.tip || label)}"${attrs(o)}>${ico(icon)}</button>`
  const SW = (on, label, o = {}) => `<button class="switch" type="button" role="switch" aria-checked="${Boolean(on)}" aria-label="${esc(label)}"${attrs(o)}></button>`
  const SEG = (name, opts, cur, label, o = {}) => `<span class="seg" role="group" aria-label="${esc(label)}" data-seg="${name}">${opts.map(([v, txt]) =>
    `<button type="button" data-v="${esc(v)}" aria-pressed="${v === cur}"${o.dis ? ' disabled' : ''}>${txt}</button>`).join('')}</span>`
  const GRP = (title, sub = '', id = '') => `<h2 class="grp"${id ? ` id="${id}"` : ''}>${title}${sub ? `<span class="sub">${sub}</span>` : ''}</h2>`
  const ROW = (title, desc, ctrl, cls = '') => `<div class="row ${cls}"><div><div class="row-t">${title}</div>${desc ? `<div class="row-d">${desc}</div>` : ''}</div><div class="row-c">${ctrl}</div></div>`
  const FLD = (id, label, ctrl, o = {}) => `<div class="fld"${o.hidden ? ' hidden' : ''}${o.attrs || ''}><label for="${id}">${label}${o.opt ? `<span class="opt">${o.opt}</span>` : ''}</label>${ctrl}<span class="fld-err" id="${id}Err" aria-live="polite"></span>${o.d ? `<span class="fld-d" id="${id}D">${o.d}</span>` : ''}</div>`
  const INP = (id, o = {}) => `<input class="field${o.cls ? ' ' + o.cls : ''}" id="${id}" autocomplete="off" spellcheck="false"${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}${o.v ? ` value="${esc(o.v)}"` : ''}${o.type ? ` type="${o.type}"` : ''}${o.max ? ` maxlength="${o.max}"` : ''} aria-describedby="${id}Err${o.d ? ` ${id}D` : ''}">`
  const AREA = (id, o = {}) => `<textarea class="field area" id="${id}" rows="${o.rows || 3}" spellcheck="false"${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}${o.max ? ` maxlength="${o.max}"` : ''} aria-describedby="${id}Err${o.d ? ` ${id}D` : ''}">${esc(o.v || '')}</textarea>`
  const pageHead = (title, desc, acts = '') => `<header class="page-head"><div class="ttl"><h1>${title}</h1>${desc ? `<p>${desc}</p>` : ''}</div>${acts ? `<div class="page-acts">${acts}</div>` : ''}</header>`
  // Состояние: знак, что случилось, что цело, одно главное действие; технический текст — под «Подробностями»
  const stateBlock = ({ mood = 'idle', title, body, acts = '', tech = '', inline = false }) =>
    `<section class="state${inline ? ' inline' : ''}"${mood === 'sad' ? ' role="alert"' : ''}>${art(32, mood)}<h2>${esc(title)}</h2><p>${body}</p>` +
    `<div class="fail-acts">${acts}${tech ? `<button class="lnk" type="button" data-x="tech" aria-expanded="false">${esc(t('Подробности'))}</button>` : ''}</div>` +
    (tech ? `<pre class="fail-tech" hidden>${esc(tech)}</pre>` : '') + '</section>'

  // Ошибки у полей: текст под полем, aria-invalid; первое неверное поле получает фокус
  function fieldErrors(box, errs) {
    box.querySelectorAll('.fld-err').forEach(x => { x.textContent = '' })
    box.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'))
    let first = null
    for (const [id, text] of errs) {
      const f = box.querySelector('#' + id)
      if (!f) continue
      f.setAttribute('aria-invalid', 'true')
      const err = box.querySelector('#' + id + 'Err')
      if (err) err.textContent = text
      first = first || f
    }
    first?.focus()
    return !errs.length
  }

  // Пружины макета: m·x'' = −k(x − 1) − c·x'. Одна пружина — одна анимация transform/opacity.
  const RM = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false }
  const SPRINGS = { snap: { k: 1100, c: 58 }, glide: { k: 1000, c: 58 }, soft: { k: 850, c: 40 }, press: { k: 1400, c: 34 } }
  const LINEAR_OK = root.CSS?.supports?.('transition-timing-function', 'linear(0, 1)')
  for (const s of Object.values(SPRINGS)) {
    const fps = 60, sub = 8, dt = 1 / fps / sub
    let x = 0, v = 0
    const pts = [0]
    for (let f = 0; f < 240; f++) {
      for (let i = 0; i < sub; i++) { const a = -s.k * (x - 1) - s.c * v; v += a * dt; x += v * dt }
      pts.push(x)
      if (Math.abs(1 - x) < 0.01 && Math.abs(v) < 0.05) break
    }
    pts[pts.length - 1] = 1
    s.ms = Math.round((pts.length - 1) / fps * 1000)
    s.easing = LINEAR_OK ? `linear(${pts.map(p => +p.toFixed(4)).join(', ')})` : 'cubic-bezier(.23, 1, .32, 1)'
  }
  function springIn(el, name = 'soft', from = { transform: 'translateY(6px)', opacity: 0 }) {
    if (!el || RM.matches || !el.animate) return Promise.resolve()
    const s = SPRINGS[name] || SPRINGS.soft
    return el.animate([from, { transform: 'none', opacity: 1 }], { duration: s.ms, easing: s.easing, fill: 'backwards' }).finished.catch(() => {})
  }

  // Меню «Ещё» у кнопки (макет: .menu.pop): то же меню, что у строки ввода, привязано к кнопке.
  // ↑↓ Home End ходят по пунктам, Esc и Tab закрывают и возвращают фокус на кнопку.
  let popEl = null, popOwner = null
  function closePop(refocus) {
    if (!popEl) return
    const owner = popOwner
    popEl.remove(); popEl = null; popOwner = null
    owner?.setAttribute('aria-expanded', 'false')
    if (refocus) owner?.focus({ preventScroll: true })
  }
  function popMenu(btn, items) {
    const was = popOwner === btn
    closePop()
    if (was) return
    const wrap = document.createElement('div')
    wrap.className = 'mk'
    const pop = document.createElement('div')
    pop.className = 'menu pop on'
    pop.setAttribute('role', 'menu')
    for (const [label, fn, o = {}] of items) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'mi' + (o.danger ? ' danger' : '')
      // o.on — пункт-выбор: галочка справа показывает текущее значение
      b.setAttribute('role', o.on === undefined ? 'menuitem' : 'menuitemradio')
      if (o.on !== undefined) b.setAttribute('aria-checked', String(Boolean(o.on)))
      b.innerHTML = `<span class="mi-t">${esc(label)}</span>${o.d ? `<span class="mi-d">${esc(o.d)}</span>` : ''}${o.on === undefined ? '' : `<span class="mi-c">${ico('check', 'i-sm')}</span>`}`
      b.addEventListener('click', e => { e.stopPropagation(); closePop(true); fn() })
      pop.append(b)
    }
    wrap.append(pop)
    document.body.append(wrap)
    popEl = wrap; popOwner = btn
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth, ph = pop.offsetHeight
    pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px'
    pop.style.top = (r.bottom + 8 + ph > innerHeight - 8 ? r.top - ph - 8 : r.bottom + 8) + 'px'
    btn.setAttribute('aria-expanded', 'true')
    springIn(pop, 'snap', { transform: 'translateY(4px)', opacity: 0 })
    pop.querySelector('.mi')?.focus({ preventScroll: true })
    pop.addEventListener('keydown', e => {
      const list = [...pop.querySelectorAll('.mi')], i = list.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus() }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus() }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus() }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closePop(true) }
    })
  }
  document.addEventListener('pointerdown', e => { if (popEl && !popEl.contains(e.target) && !popOwner?.contains(e.target)) closePop() }, true)

  // Переключатель макета: aria-checked переворачивается, возвращается новое значение
  const flipSw = sw => { const on = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(on)); return on }

  root.OnlyoneMk = Object.freeze({ t, I, ico, esc, plural, art, B, L, IX, SW, SEG, GRP, ROW, FLD, INP, AREA, pageHead, stateBlock, fieldErrors, springIn, flipSw, popMenu, closePop, SPRINGS })
})(window)
