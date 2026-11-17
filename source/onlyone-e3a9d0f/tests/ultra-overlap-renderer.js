// Внутриоконный зонд U-6: наложение символов и текста в Ultra.
//
// Слово владельца 01.10: «в режиме Ultra символы и значки накладываются друг на
// друга (иконки статусов, глифы, подписи в компактных блоках и ленте)». Смотреть
// на это одним кадром бессмысленно: наложение живёт в геометрии, зависит от
// размера окна и от того, в каком состоянии блок, и на 1240×800 его может не
// оказаться вовсе.
//
// Поэтому зонд меряет то, чем наложение и является: прямоугольники ВИДИМОГО
// ТЕКСТА и прямоугольники ЗНАЧКОВ слоя Ultra, попарно. Меряется не элемент, а
// текстовый узел через `Range.getBoundingClientRect()` — иначе рамка родителя
// накрыла бы собой наложение глифов внутри одного блока, и прибор сказал бы
// «всё чисто» там, где визуально каша.
//
// Четыре отсечения, без которых прибор врал бы в обе стороны:
//   1. Пара «родитель — потомок» не наложение: рамка родителя по построению
//      накрывает текст внутри него.
//   2. Пересечение меньше 1 px по обеим осям — округление и сглаживание краёв
//      глифов, а не наложение.
//   3. Текст, вылезающий из рамки с `overflow: hidden`, обрезан и на соседей не
//      ложится: меряется пересечение ВИДИМОЙ части.
//   4. Пустой и пробельный текст, `aria-hidden`, `display: none`, `opacity: 0`,
//      нулевой прямоугольник — не символы на экране.
//
// Отдельным классом меряется то, что попарным пересечением не ловится: у
// свободных блоков кнопка возврата `.ublock-restore` и пилюля свёрнутого
// `.ublock-pill` стоят абсолютным позиционированием в слое `.ublocks`. Их
// наезд на чужой текст — это не «текст на тексте», а потерянная подпись и
// недоступная кнопка, и сказать о нём прибор обязан отдельной строкой.
//
// Режим приходит в `__ONECODE_ARG__` (base64 JSON): mode, lang, chatId, titles,
// width, height. Никакой подделки DOM: окно настоящее, стили настоящие.
(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms = 12000) => {
    const stop = Date.now() + ms
    for (;;) {
      try { if (fn()) return true } catch (error) { /* узла ещё нет */ }
      if (Date.now() >= stop) return false
      await wait(40)
    }
  }
  const norm = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  const checks = []
  const note = (name, pass, detail) =>
    checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })

  const arg = (() => {
    try {
      const bin = atob('__ONECODE_ARG__')
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  })()
  const mode = arg.mode || 'chat'
  const lang = arg.lang || 'ru'
  const chatId = arg.chatId || 'chat-a'
  const titles = arg.titles || []

  const ready = await until(() => document.documentElement.dataset.appReady === '1', 30000)
  note('окно поднялось', ready, 'appReady=' + document.documentElement.dataset.appReady)
  if ($('onboarding')) {
    $('onboarding').querySelector('.ob-skip')?.click()
    await until(() => !$('onboarding'), 6000)
  }
  if (window.onlyoneApp?.lang && window.onlyoneApp.lang() !== lang) {
    window.onlyoneApp.setLanguage(lang)
    await wait(600)
  }

  // Размер окна заказывает сам зонд: `window.resizeTo` здесь работает (замер
  // 29.09 в `ultra-blocks-renderer.js`: `innerWidth` становится ровно заказанным),
  // а `main.js` ради набора править нельзя. Наложение — величина зависимая от
  // ширины, поэтому каждый кадр меряется на своём размере, а не на одном.
  if (Number(arg.width)) {
    window.resizeTo(Number(arg.width), Number(arg.height) || 900)
    await until(() => Math.abs(window.innerWidth - Number(arg.width)) <= 8 &&
      Math.abs(window.innerHeight - (Number(arg.height) || 900)) <= 8, 6000)
    await wait(260)
  }
  const tag = `${Number(arg.width) || window.innerWidth}×${Number(arg.height) || window.innerHeight}`

  const shell = () => document.querySelector('#ultraHost .ultra')
  const blocks = () => [...document.querySelectorAll('.ublock')]

  // ─── посев: диалог с ходом, чтобы было что открывать ────────────────────────
  if (mode === 'seed') {
    const now = Date.now()
    const stored = await window.electronAPI?.getConversations?.() || []
    const mine = stored.find(item => item.id === chatId) || {
      id: chatId, title: 'Прогон наложений Ultra', createdAt: now - 60000, updatedAt: now - 20000
    }
    mine.messages = [
      { role: 'user', content: 'Покажи результаты', timestamp: now - 60000 },
      { role: 'assistant', content: 'Вот результаты этого диалога.', timestamp: now - 55000 }
    ]
    const saved = await window.electronAPI?.setConversations?.(
      [mine, ...stored.filter(item => item.id !== chatId)])
    note('посев: диалог записан в историю окна', saved?.ok === true, JSON.stringify(saved || {}).slice(0, 70))
    await window.__reloadChats?.()
    window.__joinProject?.(null)
    await wait(1200)
    const onDisk = await window.electronAPI?.getConversations?.() || []
    note('посев: диалог лежит на диске', onDisk.some(item => item.id === chatId), `диалогов: ${onDisk.length}`)
    return { ok: checks.every(one => one.pass), checks }
  }

  const mounted = await until(() => Boolean(shell()), 15000)
  note('оболочка Ultra смонтирована', mounted &&
    document.documentElement.getAttribute('data-version-preset') === 'ultra',
    `признак=${document.documentElement.getAttribute('data-version-preset')}`)

  if (mode === 'entry') {
    // Вход: искра, приветствие, строка ввода, список «Сессии». Наложение там —
    // на подписях сессий и на времени у правого края колонки.
    // Список обязан быть НАРИСОВАН: пустой экран входа дал бы зелёный отчёт
    // «наложений нет» там, где прибор просто ничего не видел.
    const rows = await until(() => document.querySelectorAll('.urow').length > 0, 10000)
    const list = [...document.querySelectorAll('.urow')]
    note('вход: список «Сессии» нарисован', rows && list.length > 0, `строк ${list.length}`)
    note('вход: у сессии есть подпись', list.some(one => norm(one.textContent).length > 0),
      list.map(one => norm(one.textContent).slice(0, 20)).join(' / '))
    await wait(700)
  } else {
    const row = await until(() => shell()?.querySelector(`[data-chat-id="${chatId}"]`), 10000)
      ? shell().querySelector(`[data-chat-id="${chatId}"]`) : null
    row?.click()
    const inChat = await until(() => shell()?.classList.contains('is-chat'), 10000)
    note('чат открыт кликом по строке Sessions', inChat, `режим=${shell()?.className}`)
    if (titles.length) {
      const shown = await until(() => blocks().length === titles.length, 15000)
      note('блок на каждый результат, и ни одного лишнего', shown, `блоков ${blocks().length}`)
    }
    if (mode === 'min' || mode === 'closed') {
      const first = blocks()[0]
      first?.querySelector(mode === 'min' ? '.ublock-min' : '.ublock-close')?.click()
      await until(() => mode === 'min'
        ? Boolean(document.querySelector('.ublock-pill'))
        : Boolean(document.querySelector('.ublock-restore')), 8000)
      await wait(500)
    }
  }

  // ─── прибор: прямоугольники видимого текста и значков ───────────────────────
  // Слой — это не только оболочка. В режиме одного чата (`is-chat`) Ultra держит
  // на экране ОБЫЧНУЮ ленту разговора: `.chat-feed` с сообщениями, а оболочка
  // лежит поверх неё отдельным слоем. Владелец назвал наложение и в ленте, —
  // значит прибор обязан мерить её наравне со слоем блоков, иначе он назовёт
  // Ultra чистой, не заглянув туда, где жалоба была.
  const LAYER = '.ultra, .ublocks, #chatFeed .feed-container'
  const CONTROLS = '.ublock-restore, .ublock-pill, .ub-set, .ub-set2'

  const visible = el => {
    if (!el || !el.getBoundingClientRect) return false
    const style = window.getComputedStyle(el)
    if (style.display === 'none') return false
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (Number(style.opacity) === 0) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  // Прямоугольник ВИДИМОЙ части: обрезка по каждому предку с обрезанием.
  const clipTo = (rect, el) => {
    let node = el.parentElement
    let top = rect.top
    let left = rect.left
    let right = rect.right
    let bottom = rect.bottom
    while (node) {
      const style = window.getComputedStyle(node)
      if (/hidden|clip|auto|scroll/.test(style.overflow + style.overflowX + style.overflowY)) {
        const box = node.getBoundingClientRect()
        top = Math.max(top, box.top)
        left = Math.max(left, box.left)
        right = Math.min(right, box.right)
        bottom = Math.min(bottom, box.bottom)
      }
      node = node.parentElement
    }
    if (right - left <= 1 || bottom - top <= 1) return null
    return { top, left, right, bottom }
  }

  const label = el => {
    const parts = []
    for (let node = el; node && node !== document.body && parts.length < 3; node = node.parentElement) {
      const name = String(node.tagName || '').toLowerCase()
      if (node.id) { parts.unshift('#' + node.id); break }
      if (node.classList && node.classList.length) {
        parts.unshift(name + '.' + [...node.classList].slice(0, 2).join('.'))
      }
    }
    return parts.join(' < ')
  }

  const items = []
  const collect = root => {
    for (const node of root.querySelectorAll('*')) {
      if (node.closest(CONTROLS)) continue
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') continue
      if (node.tagName && node.tagName.toLowerCase() === 'svg') {
        if (!visible(node)) continue
        const rect = clipTo(node.getBoundingClientRect(), node)
        if (rect) items.push({ kind: 'значок', rect, el: node, text: norm(node.getAttribute('aria-label') || '') })
        continue
      }
      for (const child of node.childNodes) {
        if (child.nodeType !== 3) continue
        const text = norm(child.nodeValue)
        if (!text) continue
        if (!visible(node)) continue
        const range = document.createRange()
        range.selectNodeContents(child)
        const box = range.getBoundingClientRect()
        if (!box || box.width < 1 || box.height < 1) continue
        const rect = clipTo(box, node)
        if (rect) items.push({ kind: 'текст', rect, el: node, text })
      }
    }
  }

  const overlap = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return (w <= 1 || h <= 1) ? null : {
      w, h, area: w * h,
      x: Math.max(a.left, b.left) + w / 2,
      y: Math.max(a.top, b.top) + h / 2
    }
  }

  // ─── кто кого на самом деле закрывает ──────────────────────────────────────
  // Пересечение прямоугольников ещё не наложение на экране. Свободный блок
  // нарисован полупрозрачно (`color-mix(... 92%)`), и блок, лежащий СВЕРХУ, гасит
  // то, что под ним. Объявлять это дефектом было бы враньём прибора, поэтому
  // проверка своя, а не на глаз:
  //   1. `elementFromPoint` в точке пересечения отвечает, кто там сверху — это
  //      встроенная проверка попадания, а не наш хит-тест.
  //   2. От отвечавшего вверх ищем, до кого из двоих дойдём: этот лежит сверху.
  //      Если не дошли до обоих — сверху третий элемент, наши двое под ним.
  //   3. Идём от отвечавшего вверх по всей цепочке предков. Фон узла гасит
  //      нижний прямоугольник, если узел НЕ внутри нижнего (тогда это его
  //      собственный фон, который рисуется под его же текстом) и непрозрачен.
  //
  // ПОРОГ «ГАСИТ». Слой считается гасящим при альфе от 0,9. Обоснование: при
  // 0,9 и выше то, что под ним, остаётся не более чем десятью процентами
  // контраста и глазом не читается как отдельный символ. Порог объявлен явно и
  // не подгонялся под ответ: измеренная альфа попадает в отчёт, и владелец
  // может пересмотреть границу, не перезапуская разбор.
  const HIDE_ALPHA = 0.9
  const alphaOf = value => {
    const text = String(value == null ? '' : value).trim()
    if (!text || text === 'transparent') return 0
    const match = text.match(/^rgba?\(([^)]+)\)$/i)
    if (match) {
      const parts = match[1].split(/[,/\s]+/).filter(Boolean)
      if (parts.length >= 4) {
        const last = Number(parts[3])
        return Number.isFinite(last) ? last : 1
      }
      return 1
    }
    // Chromium отдаёт `color-mix` как `color(srgb r g b / a)` — разбираем и его.
    const modern = text.match(/^color\(srgb\s+([^)]+)\)$/i)
    if (modern) {
      const parts = modern[1].split(/[\s/]+/).filter(Boolean)
      const last = Number(parts[parts.length - 1])
      return Number.isFinite(last) ? last : 1
    }
    return 1
  }

  const blocker = (a, b, hit) => {
    const top = document.elementFromPoint(hit.x, hit.y)
    if (!top) return { visible: false, why: 'точка вне окна', alpha: 0 }
    let node = top
    let upper = null
    while (node) {
      if (node === a.el) { upper = a; break }
      if (node === b.el) { upper = b; break }
      node = node.parentElement
    }
    if (!upper) return { visible: false, why: `сверху ${label(top)} — наши двое под ним`, alpha: 0 }
    const lower = upper === a ? b : a
    let best = 0
    node = top
    while (node) {
      const inside = lower.el.contains(node) || node === lower.el
      if (!inside) {
        const alpha = alphaOf(window.getComputedStyle(node).backgroundColor)
        if (alpha > best) best = alpha
        if (alpha >= HIDE_ALPHA) {
          return { visible: false, why: `закрыто фоном ${label(node)} (альфа ${alpha})`, alpha }
        }
      }
      node = node.parentElement
    }
    return {
      visible: true, alpha: best,
      why: `сверху ${label(upper.el)}, гасящего слоя нет (максимальная альфа ${best.toFixed(2)})`
    }
  }

  const scan = () => {
    const layers = [...document.querySelectorAll(LAYER)]
    for (const one of layers) collect(one)
    const found = []
    let covered = 0
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]
        const b = items[j]
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue
        const hit = overlap(a.rect, b.rect)
        if (!hit) continue
        // Прямоугольники пересеклись. Видно ли это человеку — решает проверка
        // выше: непрозрачный слой сверху гасит нижний, и наложения на экране нет.
        const verdict = blocker(a, b, hit)
        if (!verdict.visible) {
          covered++
          continue
        }
        found.push({ a, b, hit, why: verdict.why })
      }
    }
    found.sort((left, right) => right.hit.area - left.hit.area)
    return { found, covered }
  }

  // ─── что блокам накрывать запрещено, а что нет ─────────────────────────────
  // Свободный блок по замыслу плавает ПОВЕРХ ленты — так он и выглядит: результат
  // лежит поверх разговора. Поэтому «блок закрыл текст сообщения» дефектом не
  // является, и проверять это как провал значило бы требовать от продукта того,
  // чего в макете нет. Запрещено ровно другое, и это уже записано в продукте:
  //   — блок не накрывает строку ввода (Н95, её меряет `run-ultra-blocks-ui`);
  //   — блок не накрывает кнопки шапки чата и кнопку настроек — иначе человек
  //     не может ни свернуть окно, ни открыть настройки.
  // Всё прочее уходит в отчёт ЧИСЛОМ, а не в провал: насколько блок накрыл
  // ленту — это вопрос к макету, и решать его владельцу, а не прибору.
  const BANNED = ['#composerTextarea', '.composer-container', '.chat-header', '.ub-set', '.ub-set2']
  const scanControls = () => {
    const texts = items.filter(one => one.kind === 'текст')
    const found = []
    const feedCovered = []
    for (const control of document.querySelectorAll(CONTROLS)) {
      if (!visible(control)) continue
      const box = clipTo(control.getBoundingClientRect(), control)
      if (!box) continue
      for (const one of texts) {
        if (one.el.contains(control) || control.contains(one.el)) continue
        const hit = overlap(box, one.rect)
        if (!hit) continue
        const banned = BANNED.some(selector => one.el.closest(selector))
        if (banned) found.push({ control, text: one, hit })
        else feedCovered.push({ control, text: one, hit })
      }
    }
    found.sort((left, right) => right.hit.area - left.hit.area)
    return { found, feedCovered }
  }

  // ─── второй класс: глифы наезжают на глифы ВНУТРИ строки ───────────────────
  // Попарное пересечение его не ловит by design: там накладываются не два узла,
  // а соседние строки ОДНОГО текста, когда межстрочный интервал меньше кегля.
  // Владелец назвал «глифы» отдельно от «подписей» — значит это другой дефект.
  // Меряется computed `line-height` против `font-size` у видимого текста слоя:
  // интервал меньше кегля означает, что выносные элементы соседних строк
  // (верхние и нижние) наезжают друг на друга.
  const scanLeading = () => {
    const bad = []
    const seenEls = new Set()
    for (const root of document.querySelectorAll(LAYER)) {
      for (const node of root.querySelectorAll('*')) {
        if (node.closest(CONTROLS)) continue
        if (seenEls.has(node)) continue
        if (!node.firstChild) continue
        const hasOwnText = [...node.childNodes].some(one => one.nodeType === 3 && norm(one.nodeValue))
        if (!hasOwnText) continue
        if (!visible(node)) continue
        const style = window.getComputedStyle(node)
        const size = Number.parseFloat(style.fontSize)
        const leading = style.lineHeight === 'normal' ? size : Number.parseFloat(style.lineHeight)
        if (!Number.isFinite(size) || !Number.isFinite(leading)) continue
        if (leading >= size - 0.5) continue
        // Мелкий кегль в компактной строке — не дефект: там нечего наезжать.
        if (size < 12) continue
        seenEls.add(node)
        bad.push(`${label(node)} «${norm(node.textContent).slice(0, 20)}» интервал ${leading} при кегле ${size}`)
      }
    }
    return bad
  }

  const show = list => list.slice(0, 6).map(one => {
    const size = `${Math.round(one.hit.w)}×${Math.round(one.hit.h)}`
    return one.control
      ? `${label(one.control)} на «${one.text.text.slice(0, 26)}» (${label(one.text.el)}) ${size}`
      : `«${one.a.text.slice(0, 26)}» (${label(one.a.el)}) на «${one.b.text.slice(0, 26)}» (${label(one.b.el)}) ${size}`
  }).join('; ')

  const { found, covered } = scan()
  note(`U-6 ${tag} · ${mode}: наложений символов нет`, found.length === 0,
    show(found) + (covered ? ` · пересечений, закрытых полупрозрачным слоем: ${covered}` : ''))

  const leading = scanLeading()
  note(`U-6 ${tag} · ${mode}: межстрочный интервал не меньше кегля`, leading.length === 0,
    leading.join('; '))

  const controls = scanControls()
  note(`U-6 ${tag} · ${mode}: блок не накрыл строку ввода и шапку чата`, controls.found.length === 0,
    show(controls.found))

  // Если наложений нет, а мерить нечего — прибор молчит не потому, что всё
  // хорошо, а потому, что слой пуст. Эта строка ловит именно такой прибор.
  note(`U-6 ${tag} · ${mode}: прибору было что мерить`, items.length >= 4,
    `прямоугольников ${items.length}`)

  await wait(500)
  return { ok: checks.every(one => one.pass), checks, measure: {
    items: items.length, overlaps: found.length, covered,
    leading: leading.length, banned: controls.found.length,
    overFeed: controls.feedCovered.length, dpr: window.devicePixelRatio } }
})().catch(error => ({ error: String(error && error.stack || error) }))
