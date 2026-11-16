/* Шторка правил проекта (макет 19–21.10, #drawer): выезжает справа пружиной glide поверх
 * раздела или ленты, лента за ней видна. Текст — инструкции проекта, которые агент читает
 * в начале каждого чата проекта. Одна шторка на всё окно: её открывают «Проекты»
 * («Изменить» у инструкций) и кнопка «Правила» в шапке чата.
 * Ctrl S — сохранить, Esc — закрыть; несохранённый текст не теряется, пока окно открыто.
 */
(function (root) {
  'use strict'
  const K = () => root.OnlyoneMk
  let layer = null, cur = null
  const drafts = new Map()

  function build(host) {
    const { t, ico, esc } = K()
    layer = document.createElement('div')
    layer.className = 'mk drawer-layer'
    layer.innerHTML = `<div class="drawer-scrim" data-dx="close"></div>` +
      `<aside class="drawer" role="dialog" aria-modal="false" aria-labelledby="drawerTitle" inert>` +
      `<header class="drawer-head"><div class="drawer-ttl"><h2 id="drawerTitle"></h2><div class="drawer-sub" id="drawerSub"></div></div>` +
      `<button class="ibtn" type="button" data-dx="close" aria-label="${esc(t('Закрыть'))}" data-tooltip="${esc(t('Закрыть'))}">${ico('close')}</button></header>` +
      `<label class="sr" for="drawerText" id="drawerLabel"></label><textarea class="drawer-text" id="drawerText" spellcheck="false"></textarea>` +
      `<footer class="drawer-foot"><span class="drawer-state" id="drawerState" aria-live="polite"></span>` +
      `<button class="btn btn-quiet btn-sm" type="button" data-dx="revert" disabled data-tooltip="${esc(t('Вернуть сохранённый текст'))}"><span>${esc(t('Отменить'))}</span></button>` +
      `<button class="btn btn-primary btn-sm" type="button" data-dx="save" disabled data-tooltip="${esc(t('Сохранить'))}" data-key="Ctrl S"><span>${esc(t('Сохранить'))}</span></button></footer></aside>`
    host.append(layer)
    const text = layer.querySelector('#drawerText')
    layer.addEventListener('click', e => {
      const a = e.target.closest('[data-dx]')
      if (!a || a.disabled) return
      if (a.dataset.dx === 'close') close()
      if (a.dataset.dx === 'revert') { text.value = cur.saved; paint(); text.focus() }
      if (a.dataset.dx === 'save') save()
    })
    text.addEventListener('input', () => { drafts.set(cur.key, text.value); paint() })
    text.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save() }
    })
    layer.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } })
  }
  const lines = s => { const n = String(s || '').split('\n').filter((l, i, a) => i < a.length - 1 || l).length; return n }
  function paint(note) {
    const { t, esc, plural } = K()
    const text = layer.querySelector('#drawerText'), dirty = text.value !== cur.saved
    const n = lines(text.value)
    layer.querySelector('#drawerSub').innerHTML = [cur.where ? `<span>${esc(cur.where)}</span>` : '',
      `<span class="num">${esc(n ? t(plural(n, '%s строка', '%s строки', '%s строк'), n) : t('пусто'))}</span>`,
      `<span>${esc(t('агент читает в начале чата'))}</span>`].join('')
    const st = layer.querySelector('#drawerState')
    st.textContent = dirty ? t('Не сохранено') : (note || t('Сохранено'))
    st.classList.toggle('dirty', dirty)
    layer.querySelector('[data-dx="save"]').disabled = !dirty
    layer.querySelector('[data-dx="revert"]').disabled = !dirty
  }
  async function save() {
    const text = layer.querySelector('#drawerText')
    if (text.value === cur.saved) return
    const was = cur.saved, value = text.value, mine = cur
    try {
      await mine.onSave(value)
      mine.saved = value
      drafts.delete(mine.key)
      if (cur === mine) paint(K().t('Сохранено только что'))
      mine.toast?.(K().t('Правила сохранены: агент возьмёт их со следующего хода'), false, { undo: async () => {
        await mine.onSave(was); mine.saved = was
        if (cur === mine && isOpen()) { text.value = was; paint() }
      } })
    } catch (e) { mine.toast?.(String(e?.message || e), true) }
  }
  const isOpen = () => Boolean(layer?.classList.contains('on'))
  // open({ key, host, title, where, label, text, onSave(text), toast, back })
  function open(o) {
    if (!layer || layer.parentNode !== o.host) { layer?.remove(); build(o.host) }
    cur = { ...o, saved: String(o.text || '') }
    layer.querySelector('#drawerTitle').textContent = o.title
    layer.querySelector('#drawerLabel').textContent = o.label || o.title
    const text = layer.querySelector('#drawerText')
    text.value = drafts.has(o.key) ? drafts.get(o.key) : cur.saved
    paint()
    layer.classList.add('on')
    layer.querySelector('.drawer').inert = false
    o.back?.setAttribute('aria-expanded', 'true')
    requestAnimationFrame(() => text.focus({ preventScroll: true }))
  }
  function close() {
    if (!isOpen()) return false
    const had = layer.contains(document.activeElement)
    layer.classList.remove('on')
    layer.querySelector('.drawer').inert = true
    cur?.back?.setAttribute('aria-expanded', 'false')
    if (had && cur?.back?.isConnected) cur.back.focus({ preventScroll: true })
    return true
  }
  root.OnlyoneRulesDrawer = Object.freeze({ open, close, isOpen, get key() { return cur?.key } })
})(window)
