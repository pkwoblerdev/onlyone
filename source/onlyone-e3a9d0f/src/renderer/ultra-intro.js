/* Представление onlyone Ultra (план, 9.2).
 *
 * Кому и когда: человеку, который впервые открыл новую сессию в Ultra, —
 * один раз (правило — shouldShow/maybeShow, ключ onlyone.ultraIntro). Оболочка
 * Ultra зовёт window.onlyoneUltraIntro.maybeShow() после первой новой сессии;
 * повторно — кнопкой в Настройках → «Вид приложения».
 *
 * Что показывает: Ultra сам — тот же тёмный экран с живым горизонтом в цвете
 * акцента и одним разговором. Пять спокойных сцен: один запрос делает всю
 * работу; результат — свободный блок (прилипает к краю, растягивается,
 * сворачивается); окно меняется по просьбе — сначала «Примерить», потом
 * «Оставить»; порядок работы собирается сам графом; фокус — только разговор.
 * К концу темп нарастает, всё собирается в искру: «onlyone Ultra», одна строка
 * и кнопка.
 *
 * Без имён, моделей и папок; текст — только названия сцен. Искра в Ultra не
 * вращается. Движение — сдвиг и прозрачность; при «уменьшить движение» сразу
 * итог со списком возможностей.
 */
(function () {
  'use strict'

  const SEEN_KEY = 'onlyone.ultraIntro'
  const REV = '2026-09-28'
  const W = 1280
  const H = 760

  const app = () => window.onlyoneApp || {}
  // Перевод — тем же словарём, что и всё приложение.
  const t = text => {
    if (app().t) return app().t(text)
    const en = (document.documentElement.lang || '').startsWith('en') && window.__I18N__ && window.__I18N__.en
    return en && Object.prototype.hasOwnProperty.call(en, text) ? en[text] : text
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const read = key => { try { return localStorage.getItem(key) } catch { return null } }
  const write = (key, value) => { try { localStorage.setItem(key, value) } catch {} }
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const markPath = () => document.getElementById('appGlyph')?.querySelector('path')?.getAttribute('d') || ''

  const ICON = (paths, cls = '') => `<svg class="ux-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`
  const MARK = cls => `<svg class="${cls}" viewBox="9 9 46 46" aria-hidden="true"><path fill-rule="evenodd" class="ux-mark" d="${markPath()}"/></svg>`
  const I = {
    check: '<path d="m3.6 8.4 2.8 2.8 6-6.2"/>',
    eye: '<path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/>',
    down: '<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>',
    close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    up: '<path d="M8 12.6V3.4M4 7.4l4-4 4 4"/>'
  }

  const SCENES = [
    ['Один запрос', 'onlyone делает всю работу'],
    ['Результат — где удобно', 'Двигать, прилеплять, растягивать, сворачивать'],
    ['Окно меняется по просьбе', 'Сначала примерить, потом оставить'],
    ['Порядок работы — сам', 'Этапы по очереди и параллельно'],
    ['Фокус', 'Только разговор']
  ]
  const STEPS = [
    ['Понял задачу', 'экраны, хранение, напоминание'],
    ['Дизайн', 'три экрана'],
    ['Код', 'экраны и хранение'],
    ['Тесты', '23 из 23'],
    ['Отчёт', '']
  ]
  // Граф: этапы и связи; Дизайн и Код идут параллельно.
  const NODES = [
    ['plan', 'План', 90, 150], ['design', 'Дизайн', 350, 70], ['code', 'Код', 350, 230],
    ['tests', 'Тесты', 640, 150], ['report', 'Отчёт', 910, 150]
  ]
  const LINKS = [['plan', 'design'], ['plan', 'code'], ['design', 'tests'], ['code', 'tests'], ['tests', 'report']]

  let root = null
  let run = 0
  let returnFocus = null
  let doneCallback = null

  function stageHtml() {
    const at = id => NODES.find(node => node[0] === id)
    const link = ([a, b]) => {
      const [, , x1, y1] = at(a)
      const [, , x2, y2] = at(b)
      const sx = x1 + 75, ex = x2 - 75, mx = (sx + ex) / 2
      return `<path pathLength="1" data-link="${a}-${b}" d="M${sx} ${y1} C${mx} ${y1} ${mx} ${y2} ${ex} ${y2}"/>`
    }
    const phone = (title, n) => `<div class="ux-phone"><b>${esc(t(title))}</b>${[0, 1, 2].map(k => `<i class="${k === n ? 'is-on' : ''}"></i>`).join('')}</div>`
    return `
      <div class="ux-cap" aria-live="polite"><span class="ux-cap-n"></span><h2 id="uxTitle"></h2><p></p></div>
      <div class="ux-spark">${MARK('')}</div>
      <div class="ux-main">
        <div class="ux-col">
          <div class="ux-bubble" data-item="ask"><span>${esc(t('Сделай приложение для привычек'))}</span></div>
          <div class="ux-steps" data-item="steps">${STEPS.map(([a, b]) => `
            <div class="ux-step"><i><svg class="ux-run" viewBox="9 9 46 46"><path fill-rule="evenodd" d="${markPath()}"/></svg>${ICON(I.check, 'ux-ok')}</i><span>${esc(t(a))}${b ? ` <em>· ${esc(t(b))}</em>` : ''}</span></div>`).join('')}
          </div>
          <div class="ux-answer" data-item="answer">${esc(t('Готово: три экрана, хранение на устройстве и напоминание.'))}</div>
          <div class="ux-bubble" data-item="ask2"><span>${esc(t('Перенеси результат влево'))}</span></div>
          <div class="ux-prop" data-item="prop"><span>${esc(t('Результат слева'))}<b>${ICON(I.eye)}${esc(t('Примерить'))}</b></span></div>
          <div class="ux-applied" data-item="applied">${ICON(I.check)}<span>${esc(t('Применено'))}</span><u>${esc(t('Откатить'))}</u></div>
        </div>
        <div class="ux-comp">
          <div class="ux-comp-in"><span class="ux-ph">${esc(t('Напишите свои мысли'))}</span><span class="ux-typed"></span><span class="ux-caret"></span></div>
          <div class="ux-comp-row">${ICON(I.plus)}<span class="ux-sp"></span><span class="ux-send">${ICON(I.up)}</span></div>
        </div>
      </div>
      <div class="ux-snap"></div>
      <div class="ux-block">
        <div class="ux-block-in">
          <div class="ux-block-h"><b>${ICON(I.eye)}${esc(t('Экраны'))}</b>${ICON(I.down)}${ICON(I.close)}</div>
          <div class="ux-phones">${phone('Сегодня', 0)}${phone('Привычка', 1)}${phone('Напоминание', 2)}</div>
        </div>
        <span class="ux-edge"></span>
      </div>
      <div class="ux-pill">${ICON(I.eye)}${esc(t('Экраны'))}</div>
      <div class="ux-try"><span>${esc(t('Результат слева'))}<i class="is-quiet">${esc(t('Вернуть как было'))}</i><i class="is-main">${esc(t('Оставить'))}</i></span></div>
      <div class="ux-graph">
        <svg class="ux-links" viewBox="0 0 1000 300" aria-hidden="true">${LINKS.map(link).join('')}</svg>
        ${NODES.map(([id, label, x, y]) => `<div class="ux-node" data-node="${id}" style="left:${x}px;top:${y}px"><i><span class="ux-dot"></span><svg class="ux-run" viewBox="9 9 46 46"><path fill-rule="evenodd" d="${markPath()}"/></svg>${ICON(I.check, 'ux-ok')}</i><span>${esc(t(label))}</span></div>`).join('')}
      </div>
      <div class="ux-final">
        <div class="ux-final-mark">${MARK('')}</div>
        <h2>onlyone <span>Ultra</span></h2>
        <p>${esc(t('Всё, что умеет onlyone, — в одном окне.'))}</p>
        <button type="button" class="ux-cta">${esc(t('Попробовать'))}</button>
      </div>
      <div class="ux-list">${SCENES.map(([title]) => `<span>${esc(t(title))}</span>`).join('')}</div>`
  }

  // --- Фон: живой горизонт в цвет акцента (как в макете 2.0) -------------------
  function accentHsl() {
    const probe = document.createElement('span')
    probe.style.color = 'var(--accent)'
    document.body.appendChild(probe)
    const rgb = (getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) || [224, 140, 98]).slice(0, 3).map(Number)
    probe.remove()
    const [r, g, b] = rgb.map(v => v / 255)
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    let h = 0, s = 0
    const l = (mx + mn) / 2
    if (mx !== mn) {
      const d = mx - mn
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
      h *= 60
    }
    return [h, s * 100]
  }
  const hsla = (h, s, l, a) => `hsla(${(h + 360) % 360},${s}%,${l}%,${a})`

  function startSky(canvas) {
    const sky = { dim: 0, rise: 0, target: { dim: 0, rise: 0 }, stop: false }
    const [h, sat] = accentHsl()
    const s2 = Math.min(90, sat + 10)
    const t0 = performance.now()
    let last = t0
    const frame = now => {
      if (sky.stop) return
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      // Яркость фона догоняет цель плавно, без скачков между сценами.
      sky.dim += (sky.target.dim - sky.dim) * Math.min(1, dt * 1.4)
      sky.rise += (sky.target.rise - sky.rise) * Math.min(1, dt * 0.9)
      const dpr = window.devicePixelRatio || 1
      const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch }
      const x = canvas.getContext('2d')
      const tt = reducedMotion() ? 0 : (now - t0) / 1000
      x.globalCompositeOperation = 'source-over'
      x.fillStyle = '#0b0a09'
      x.fillRect(0, 0, cw, ch)
      x.globalCompositeOperation = 'screen'
      const glow = sky.rise * (1 - 0.55 * sky.dim)
      const blobs = [[h, 46, 0.11, 0, 0.44], [h + 14, 40, 0.08, 2.1, 0.41], [h - 12, 36, 0.07, 4.2, 0.38]]
      blobs.forEach(([bh, bl, a, ph, rk], k) => {
        const cx = cw * (0.5 + 0.36 * Math.sin(tt * 0.06 * (k + 1) + ph))
        const cy = ch * (0.28 + 0.16 * Math.cos(tt * 0.045 * (k + 1.3) + ph * 1.7))
        const rr = cw * rk
        const g = x.createRadialGradient(cx, cy, 0, cx, cy, rr)
        g.addColorStop(0, hsla(bh, sat, bl, a * glow))
        g.addColorStop(1, hsla(bh, sat, bl, 0))
        x.fillStyle = g
        x.fillRect(0, 0, cw, ch)
      })
      // Планета: тёмный диск у нижнего края, тонкая кромка и свет над ней.
      const px = cw / 2, rx = cw * 0.82, ry = ch * 0.56
      const py = ch + ry - ch * 0.19 + Math.sin(tt * 0.2) * 3 * dpr
      x.save()
      x.translate(px, py)
      x.scale(1, ry / rx)
      const hg = x.createRadialGradient(0, 0, rx * 0.98, 0, 0, rx * 1.32)
      hg.addColorStop(0, hsla(h, s2, 60, 0.55 * glow))
      hg.addColorStop(0.35, hsla(h + 10, s2, 44, 0.22 * glow))
      hg.addColorStop(1, hsla(h, s2, 40, 0))
      x.fillStyle = hg
      x.beginPath()
      x.arc(0, 0, rx * 1.32, 0, Math.PI * 2)
      x.fill()
      x.restore()
      x.globalCompositeOperation = 'source-over'
      x.fillStyle = '#080706'
      x.beginPath()
      x.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2)
      x.fill()
      const rim = x.createLinearGradient(px - rx * 0.7, 0, px + rx * 0.7, 0)
      rim.addColorStop(0, hsla(h, s2, 70, 0))
      rim.addColorStop(0.5, hsla(h + 6, s2, 84, glow))
      rim.addColorStop(1, hsla(h, s2, 70, 0))
      x.strokeStyle = rim
      x.lineWidth = 1.5 * dpr
      x.beginPath()
      x.ellipse(px, py, rx, ry, 0, Math.PI * 1.12, Math.PI * 1.88)
      x.stroke()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    return sky
  }

  // --- Сцена ------------------------------------------------------------------
  function fit() {
    if (!root) return
    const stage = root.querySelector('.ux-stage')
    const w = root.clientWidth, h = root.clientHeight
    const k = Math.min(w / W, h / H)
    stage.style.transform = `translate(${(w - W * k) / 2}px, ${(h - H * k) / 2}px) scale(${k})`
  }

  async function play(sky, pace = 1) {
    const my = ++run
    const $ = selector => root.querySelector(selector)
    // pace < 1 — только для оконной проверки: тот же сценарий быстрее.
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms * pace)).then(() => { if (my !== run || !root) throw new Error('stop') })
    const item = name => $(`[data-item="${name}"]`)
    const on = (name, y = 0) => { const node = item(name); node.style.setProperty('--y', y + 'px'); node.classList.remove('is-gone'); node.classList.add('is-on') }
    const off = name => { const node = item(name); node.classList.remove('is-on'); node.classList.add('is-gone') }
    const hit = node => { node.classList.remove('is-hit'); void node.offsetWidth; node.classList.add('is-hit') }
    const main = $('.ux-main'), block = $('.ux-block'), snap = $('.ux-snap'), pill = $('.ux-pill')
    const comp = $('.ux-comp'), typed = $('.ux-typed'), graph = $('.ux-graph'), cap = $('.ux-cap')
    const shift = px => { main.style.transform = `translateX(${px}px)` }
    const place = (el, x, y) => { el.style.setProperty('--x', x + 'px'); el.style.setProperty('--y', y + 'px') }
    const caption = async (index) => {
      if (cap.classList.contains('is-on')) {
        cap.classList.remove('is-on')
        cap.classList.add('is-off')
        await wait(520)
      }
      const [title, line] = SCENES[index]
      cap.querySelector('.ux-cap-n').innerHTML = `<b>0${index + 1}</b> / 0${SCENES.length}`
      cap.querySelector('h2').textContent = t(title)
      cap.querySelector('p').textContent = t(line)
      cap.classList.remove('is-off')
      void cap.offsetWidth
      cap.classList.add('is-on')
    }
    const type = async (text, pace = 58) => {
      comp.classList.add('is-typing')
      typed.textContent = ''
      for (const ch of text) { typed.textContent += ch; await wait(pace + (ch === ' ' ? 40 : 0)) }
    }
    const send = async () => {
      await wait(420)
      hit($('.ux-send'))
      comp.classList.remove('is-typing')
      typed.textContent = ''
    }

    // Открытие: горизонт разгорается, в центре — искра.
    sky.target.rise = 1
    await wait(500)
    $('.ux-spark').classList.add('is-on')
    await wait(2600)
    $('.ux-spark').classList.add('is-away')

    // 01 — один запрос делает всю работу.
    await caption(0)
    await wait(300)
    comp.classList.add('is-on')
    await wait(1000)
    await type(t('Сделай приложение для привычек'))
    await send()
    on('ask', 0)
    await wait(600)
    sky.target.dim = 1
    on('steps', 62)
    const steps = [...root.querySelectorAll('.ux-step')]
    for (const step of steps) {
      step.classList.add('is-on')
      await wait(820)
      step.classList.add('is-done')
      await wait(200)
    }
    on('answer', 232)
    sky.target.dim = 0.25
    await wait(2300)

    // 02 — результат: свободный блок прилипает к краю, растягивается, сворачивается.
    await caption(1)
    off('steps')
    item('answer').style.setProperty('--y', '62px')
    shift(-280)
    place(block, 500, 250)
    block.style.setProperty('--clip', '160px')
    block.classList.add('is-on')
    await wait(1700)
    place(snap, 836, 176)
    snap.classList.add('is-on')
    await wait(500)
    place(block, 676, 176)
    await wait(1400)
    snap.classList.remove('is-on')
    await wait(500)
    block.classList.add('is-pull')
    await wait(350)
    block.style.setProperty('--clip', '0px')
    await wait(1400)
    block.classList.remove('is-pull')
    await wait(700)
    place(pill, 1100, 176)
    block.classList.remove('is-on')
    pill.classList.add('is-on')
    await wait(1500)
    pill.classList.remove('is-on')
    block.classList.add('is-on')
    await wait(1600)

    // 03 — окно меняется по просьбе: примерить, потом оставить.
    await caption(2)
    await wait(300)
    await type(t('Перенеси результат влево'), 50)
    await send()
    on('ask2', 132)
    await wait(900)
    on('prop', 198)
    await wait(1500)
    hit(item('prop').querySelector('b'))
    await wait(380)
    block.classList.add('is-trying')
    place(block, 44, 198)
    shift(280)
    $('.ux-try').classList.add('is-on')
    await wait(2000)
    hit($('.ux-try .is-main'))
    await wait(420)
    $('.ux-try').classList.remove('is-on')
    block.classList.remove('is-trying')
    off('prop')
    on('applied', 198)
    await wait(2100)

    // 04 — порядок работы собирается сам: граф этапов и ход по нему.
    await caption(3)
    main.style.opacity = '0'
    block.classList.remove('is-on')
    await wait(500)
    graph.classList.add('is-on')
    const node = id => graph.querySelector(`[data-node="${id}"]`)
    const path = (a, b) => graph.querySelector(`[data-link="${a}-${b}"]`)
    for (const [id] of NODES) {
      node(id).classList.add('is-on')
      for (const [a, b] of LINKS.filter(([, to]) => to === id)) path(a, b).classList.add('is-on')
      await wait(420)
    }
    await wait(500)
    const stage = async (ids, next) => {
      ids.forEach(id => node(id).classList.add('is-run'))
      await wait(900)
      ids.forEach(id => { node(id).classList.remove('is-run'); node(id).classList.add('is-done') })
      for (const [a, b] of LINKS.filter(([from]) => ids.includes(from))) path(a, b).classList.add('is-done')
      if (next) await wait(200)
    }
    await stage(['plan'], true)
    await stage(['design', 'code'], true)
    await stage(['tests'], true)
    await stage(['report'])
    await wait(1300)

    // 05 — фокус: только разговор.
    await caption(4)
    graph.classList.remove('is-on')
    await wait(400)
    shift(0)
    main.style.opacity = '1'
    sky.target.dim = 0
    await wait(3200)

    // Финал: темп нарастает, всё собирается в искру.
    cap.classList.remove('is-on')
    cap.classList.add('is-off')
    const stageEl = $('.ux-stage')
    stageEl.classList.add('is-rush')
    shift(-280)
    place(block, 676, 176)
    block.classList.add('is-on')
    await wait(560)
    place(block, 44, 176)
    shift(280)
    await wait(430)
    main.style.opacity = '0'
    block.classList.remove('is-on')
    graph.classList.add('is-on')
    await wait(330)
    graph.classList.remove('is-on')
    stageEl.classList.add('is-gather')
    sky.target.dim = -0.25
    await wait(420)
    root.classList.add('is-final')
    await wait(900)
    root.querySelector('.ux-cta').focus({ preventScroll: true, focusVisible: false })
  }

  function finish() {
    if (!root) return
    write(SEEN_KEY, REV)
    run++
    const node = root
    root = null
    node.classList.add('is-out')
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', fit)
    setTimeout(() => { node._sky && (node._sky.stop = true); node.remove() }, 560)
    ;(returnFocus && document.contains(returnFocus) ? returnFocus : document.getElementById('composerTextarea'))?.focus?.()
    const done = doneCallback
    doneCallback = null
    done?.()
  }

  function onKey(event) {
    if (!root) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); return }
    if (event.key === 'Tab') {
      // Фокус не уходит под представление.
      const items = [...root.querySelectorAll('button')].filter(b => b.offsetParent !== null && getComputedStyle(b).pointerEvents !== 'none')
      if (!items.length) return
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }

  function show({ onDone, pace = 1 } = {}) {
    if (root) return
    returnFocus = document.activeElement
    doneCallback = onDone || null
    root = document.createElement('div')
    root.id = 'ultraIntro'
    root.className = 'ux'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'uxTitle')
    root.setAttribute('aria-label', 'onlyone Ultra')
    // Под строкой заголовка окна: окно можно двигать и закрыть и во время показа.
    const bar = document.querySelector('.window-titlebar')
    root.style.top = (bar?.offsetHeight || 0) + 'px'
    root.innerHTML = `<canvas class="ux-sky" aria-hidden="true"></canvas><div class="ux-grain" aria-hidden="true"></div><div class="ux-vig" aria-hidden="true"></div>
      <button type="button" class="ux-skip">${esc(t('Пропустить'))}</button>
      <div class="ux-stage">${stageHtml()}</div>`
    document.body.appendChild(root)
    root.querySelector('.ux-skip').addEventListener('click', finish)
    root.querySelector('.ux-cta').addEventListener('click', finish)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', fit)
    fit()
    const sky = startSky(root.querySelector('.ux-sky'))
    root._sky = sky
    requestAnimationFrame(() => root?.classList.add('is-in'))
    if (reducedMotion()) {
      // Без движения — сразу итог и список возможностей.
      sky.target.rise = sky.rise = 1
      root.classList.add('is-final')
      root.querySelector('.ux-cta').focus({ preventScroll: true, focusVisible: false })
      return
    }
    root.querySelector('.ux-skip').focus({ preventScroll: true, focusVisible: false })
    play(sky, Math.min(1, Math.max(0.05, Number(pace) || 1))).catch(() => {})
  }

  const shouldShow = () => read(SEEN_KEY) !== REV
  const maybeShow = options => { if (shouldShow()) show(options) }

  function init() {
    document.getElementById('showUltraIntroBtn')?.addEventListener('click', () => {
      document.querySelector('#settingsModal [data-close="settingsModal"]')?.click()
      show()
    })
  }

  window.onlyoneUltraIntro = { REV, SEEN_KEY, shouldShow, maybeShow, show, close: finish }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
