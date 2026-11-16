// Галерея раздела «Дизайн» по макету 20.10: строка «что нарисовать» с пилюлей
// формата, полка форматов листами в пропорциях холста и «Ваши дизайны» с
// превью. Выбор формата только ставит его — дизайн рождается из слов и Enter,
// а не из щелчка по листу. Рабочее место макета остаётся в app.js.
(function (root) {
  'use strict'
  const MK = () => root.OnlyoneMk

  // Лист одной площади для всех: пропорция читается сразу, а полка не прыгает по высоте от формата к формату
  const paperSize = (w, h, area = 4600) => [Math.round(Math.sqrt(area * w / h)), Math.round(Math.sqrt(area * h / w))]
  // Эскизы в пикселях листа: sR — плашка, sO — контур, sL — линия, sC — круг; o — непрозрачность
  const sR = (x, y, w, h, o = 1, r = 1.5) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="currentColor" opacity="${o}"/>`
  const sO = (x, y, w, h) => `<rect x="${x + .6}" y="${y + .6}" width="${w - 1.2}" height="${h - 1.2}" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>`
  const sL = (x1, y1, x2, y2, o = 1, d = '') => `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="${o}"${d ? ` stroke-dasharray="${d}"` : ''}/>`
  const sC = (cx, cy, r, o = 1) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" opacity="${o}"/>`
  const lines = (x, y, w, n, step = 6, o = .5) => Array.from({ length: n }, (_, i) => sR(x, y + i * step, i === n - 1 ? w * .6 : w, 2, o, 1)).join('')
  const SKETCH = {
    blank: (W, H) => sL(W / 2 - 6, H / 2, W / 2 + 6, H / 2, .8) + sL(W / 2, H / 2 - 6, W / 2, H / 2 + 6, .8),
    mobile: (W, H) => sR(6, 9, W * .5, 4) + [0, 1, 2, 3].map(i => sC(9, 25 + i * 15, 3, .6) + sR(16, 23 + i * 15, W - 22, 3, .45, 1)).join('') + sL(4, H - 12, W - 4, H - 12, .35) + [.25, .5, .75].map(k => sC(W * k, H - 6, 1.6, .6)).join(''),
    slides: (W, H) => sR(8, 9, W * .4, 5) + sR(8, 19, W * .3, 2.5, .5, 1) + sR(8, 25, W * .26, 2.5, .5, 1) + sR(W * .56, 8, W * .44 - 8, H - 16, .3, 2),
    document: (W, H) => sR(8, 8, W * .55, 4.5) + lines(8, 19, W - 16, Math.floor((H - 26) / 6)),
    wireframe: (W, H) => sO(6, 6, W - 12, 8) + sO(6, 18, W * .24, H - 24) + sO(W * .24 + 10, 18, W - W * .24 - 16, H - 24) + sL(W * .24 + 13, 21, W - 9, H - 9, .5) + sL(W - 9, 21, W * .24 + 13, H - 9, .5),
    animation: (W, H) => sL(W * .1, H * .78, W * .78, H * .3, .35, '2 3') + sC(W * .26, H * .66, 4.5, .3) + sC(W * .46, H * .52, 5, .55) + sC(W * .68, H * .37, 6, 1),
    ui: (W, H) => sR(5, 5, W * .2, H - 10, .3, 1.5) + sR(W * .2 + 9, 6, W * .5, 4) + sR(W * .2 + 9, 15, (W * .8 - 18) / 2 - 2, H * .36, .3, 1.5) + sR(W * .2 + 9 + (W * .8 - 18) / 2 + 2, 15, (W * .8 - 18) / 2 - 2, H * .36, .3, 1.5) + lines(W * .2 + 9, 19 + H * .36, W * .8 - 18, 2),
    resume: (W, H) => sC(13, 13, 6, .55) + sR(23, 9, W * .42, 4) + sR(23, 16, W * .3, 2.5, .5, 1) + sR(7, 27, W * .28, 3, .8, 1) + lines(7, 34, W - 14, 3) + sR(7, 54, W * .28, 3, .8, 1) + lines(7, 61, W - 14, 2),
    research: (W, H) => sR(7, 8, W * .6, 4.5) + [.5, .8, .35, .65].map((k, i) => sR(9 + i * ((W - 18) / 4), 20 + (1 - k) * 26, (W - 18) / 4 - 4, k * 26, .45, 1)).join('') + sL(7, 47, W - 7, 47, .4) + lines(7, 53, W - 14, Math.floor((H - 58) / 6)),
    email: (W, H) => sR(0, 0, W, 13, .25, 0) + sR(W * .19, 18, W * .62, 4) + lines(W * .19, 27, W * .62, 5) + sR(W / 2 - 11, H - 16, 22, 7, .8, 3.5),
    palette: (W, H) => [.25, .45, .65, .85, 1].map((o, i) => sC(11 + i * ((W - 22) / 4), H * .34, 5.5, o)).join('') + sR(8, H * .6, W * .34, 6) + sR(8, H * .6 + 10, W * .52, 2.5, .5, 1),
    diagram: (W, H) => sO(6, 7, W * .3, 12) + sO(W * .7 - 6, 7, W * .3, 12) + sO(W * .35, H - 19, W * .3, 12) + sL(6 + W * .15, 19, W * .5, H - 19, .55) + sL(W * .85 - 6, 19, W * .5, H - 19, .55),
    flier: (W, H) => sR(6, 6, W - 12, H * .34, .3, 2) + sR(6, H * .34 + 12, W * .74, 5) + sR(6, H * .34 + 20, W * .5, 5) + lines(6, H * .34 + 30, W - 12, 2) + sR(6, H - 11, W * .4, 6, .8, 3)
  }

  function create(deps) {
    const { formats, designs, liveId, open, start, relTime, remove } = deps
    const fmtOf = id => formats().find(f => f.id === id) || formats()[0]
    const paper = id => {
      const f = fmtOf(id), [W, H] = paperSize(f.w, f.h)
      const draw = SKETCH[f.id] || SKETCH.blank
      return `<span class="paper" style="width:${W}px;height:${H}px" aria-hidden="true"><svg viewBox="0 0 ${W} ${H}">${draw(W, H)}</svg></span>`
    }
    let fmt = 'blank'
    let host = null
    // Точка входа каждого дизайна: превью — сам макет, уменьшенный, а не значок
    const entries = new Map()

    function render(el) {
      const { t, esc, ico, pageHead, GRP } = MK()
      host = el
      const f = fmtOf(fmt)
      el.innerHTML = pageHead(t('Дизайн'), t('Опишите, что нужно, и выберите формат: модель соберёт макет и поправит его по вашим словам.')) +
        `<form class="composer ds-new" id="dsNewForm" autocomplete="off"><label class="sr" for="dsNewIn">${t('Что нарисовать')}</label>` +
        `<textarea id="dsNewIn" rows="2" placeholder="${esc(t('Например: первый экран сервиса дыхательных практик, спокойный, одна кнопка'))}" spellcheck="false"></textarea>` +
        `<div class="cmp-bar"><button type="button" class="pill" id="dsFmt" aria-haspopup="menu" data-tooltip="${esc(t('Формат холста'))}"><span>${esc(t(f.name))}</span>${ico('chevron', 'i-sm')}</button>` +
        `<span class="ds-size num" id="dsSize">${f.w} × ${f.h}</span><span class="grow"></span>` +
        `<button type="submit" class="send" id="dsNewSend" aria-label="${esc(t('Начать'))}" data-tooltip="${esc(t('Начать'))}" disabled>${ico('send')}</button></div></form>` +
        `<div class="shelf" role="group" aria-label="${esc(t('Формат'))}">${formats().map(x =>
          `<button class="shelf-item" type="button" data-f="${x.id}" aria-pressed="${x.id === fmt}" data-tooltip="${esc(t(x.hint))}, ${x.w} × ${x.h}">${paper(x.id)}<span class="shelf-name">${esc(t(x.name))}</span></button>`).join('')}</div>` +
        GRP(t('Ваши дизайны')) + '<div id="designList" class="ds-cards"></div>'
      const input = el.querySelector('#dsNewIn'), send = el.querySelector('#dsNewSend')
      input.addEventListener('input', () => {
        const was = send.disabled
        send.disabled = !input.value.trim()
        if (was && !send.disabled) MK().springIn(send.querySelector('.i'), 'soft', { transform: 'translateY(5px)', opacity: .3 })
      })
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); input.form.requestSubmit() }
      })
      el.querySelector('#dsNewForm').addEventListener('submit', e => {
        e.preventDefault()
        const text = input.value.trim()
        if (!text) return
        input.value = ''
        send.disabled = true
        start(fmt, text)
      })
      el.querySelectorAll('.shelf-item').forEach(b => b.addEventListener('click', () => pick(b.dataset.f)))
      const pill = el.querySelector('#dsFmt')
      pill.addEventListener('click', () => MK().popMenu(pill, formats().map(x => [t(x.name), () => pick(x.id), { d: `${x.w} × ${x.h}`, on: x.id === fmt }])))
      cards()
    }

    function pick(id) {
      const { t } = MK()
      fmt = fmtOf(id).id
      if (!host) return
      const f = fmtOf(fmt)
      host.querySelectorAll('.shelf-item').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === fmt)))
      host.querySelector('#dsFmt span').textContent = t(f.name)
      host.querySelector('#dsSize').textContent = `${f.w} × ${f.h}`
      host.querySelector('#dsNewIn').focus({ preventScroll: true })
    }

    function thumb(d) {
      const e = entries.get(d.id)
      if (!e || !e.entry) return `<span class="ds-thumb bare" aria-hidden="true">${paper(d.starter)}</span>`
      const narrow = fmtOf(d.starter).w < 600
      // Кадр без allow-same-origin, как и большое превью: окно в него не заглядывает
      return `<span class="ds-thumb" aria-hidden="true"><iframe class="ds-mini ds-frame${narrow ? ' narrow' : ''}" tabindex="-1" loading="lazy" sandbox="allow-scripts" ` +
        `src="onecode-design://${encodeURIComponent(d.id)}/${encodeURIComponent(e.entry)}?v=${Number(d.updatedAt) || 0}"></iframe></span>`
    }

    function cards() {
      const list = host && host.querySelector('#designList')
      if (!list) return
      const { t, esc, ico } = MK()
      const all = [...designs()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      if (!all.length) {
        list.className = 'ds-cards is-empty'
        list.innerHTML = `<div class="pj-none"><span>${esc(t('Пока ни одного — опишите, что нужно, выше.'))}</span></div>`
        return
      }
      list.className = 'ds-cards'
      list.innerHTML = all.map(d => `<div class="ds-card" role="button" tabindex="0" data-id="${esc(d.id)}">${thumb(d)}<span class="ds-cap"><b>${esc(d.name || t('Без названия'))}</b>` +
        `<small>${liveId() === d.id ? `<span class="live"><span class="dot dot-now"></span>${esc(t('модель собирает'))}</span>` : `${esc(t(fmtOf(d.starter).name))}, ${esc(relTime(d.updatedAt || d.createdAt))}`}</small></span>` +
        `<button class="ds-del" type="button" data-id="${esc(d.id)}" aria-label="${esc(t('Удалить дизайн'))}" data-tooltip="${esc(t('Удалить дизайн'))}">${ico('trash', 'i-sm')}</button></div>`).join('')
      list.querySelectorAll('.ds-card').forEach(b => {
        b.addEventListener('click', () => open(b.dataset.id))
        b.addEventListener('keydown', e => { if (e.target === b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(b.dataset.id) } })
      })
      list.querySelectorAll('.ds-del').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); if (remove) remove(b.dataset.id) }))
      // Точки входа узнаются по одной; узнали новую — перерисовать только эту карточку
      for (const d of all) {
        const known = entries.get(d.id)
        if (known && known.at === d.updatedAt) continue
        entries.set(d.id, { at: d.updatedAt, entry: known?.entry || '' })
        Promise.resolve(root.electronAPI?.designComponents?.(d.id)).then(res => {
          const entry = res && res.ok ? (res.entry && res.components?.includes(res.entry) ? res.entry : res.components?.[0] || '') : ''
          const was = entries.get(d.id)?.entry
          entries.set(d.id, { at: d.updatedAt, entry })
          if (entry === was) return
          const card = list.querySelector(`.ds-card[data-id="${CSS.escape(d.id)}"] .ds-thumb`)
          if (card) card.outerHTML = thumb(d)
        }).catch(() => { /* не узнали точку входа — в карточке остаётся лист формата */ })
      }
    }

    return { render, cards, pick, fmt: () => fmt }
  }

  root.OnlyoneDesignGallery = { create }
})(typeof window !== 'undefined' ? window : globalThis)
