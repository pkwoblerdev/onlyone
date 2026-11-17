// Внутриоконный зонд свободных блоков результата Ultra (план, 9.2, вторая часть)
// и дефекта Н95 (прилипший блок закрывает строку ввода).
//
// Режим приходит в `__ONECODE_ARG__` (base64 JSON): mode, lang, chatId, titles и
// для режима `inset` ещё width/height — заказанный размер окна. Артефакты
// заранее лежат в профиле прогона — их кладёт раннер тем же
// `src/main/artifacts.js`, чем их пишет живая программа, а диалоги сеются
// штатным каналом окна (`setConversations`). Никакой подделки DOM: блок
// нарисован по-настоящему, по настоящему списку результатов открытого чата.
//
// Проверки двигают блок НАСТОЯЩИМИ pointer-событиями: `pointerdown` по заголовку
// или ручке, `pointermove` по документу, `pointerup`. Кадр главный процесс
// снимает после отчёта, поэтому экран обязан дожить до съёмки.
//
// Что меряет Н95 (требование 29.09 14:40): на КОРНЕ опубликованы
// `--ultra-block-inset-right` / `--ultra-block-inset-left` = ширина прилипшего
// блока + 16 (иначе 0px); `.feed-container` и `.composer-col` под
// `:root[data-version-preset="ultra"]` прочитали их в `padding-inline` — переход
// по padding, не «all»; узлы колонок никто инлайном не трогает; и главное —
// прямоугольник прилипшего блока НЕ пересекается с прямоугольником строки ввода
// (`#composerTextarea`), а сама строка ввода целиком остаётся во вьюпорте. В
// режиме `inset` это меряется на трёх реальных размерах окна.
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
  const hasCyr = value => /[а-яё]/i.test(String(value == null ? '' : value))
  const cs = el => (el ? window.getComputedStyle(el) : null)
  const box = el => (el && el.getBoundingClientRect ? el.getBoundingClientRect() : null)

  // ─── Н95: отступ колонок под прилипший блок ─────────────────────────────────
  // Требование 29.09 14:40: оболочка публикует на КОРНЕ
  // `--ultra-block-inset-right` / `--ultra-block-inset-left` (ширина прилипшего
  // блока + 16, иначе 0); `.feed-container` и `.composer-col` под
  // `:root[data-version-preset="ultra"]` берут из них `padding-inline`, с
  // переходом только по `padding`. Узлы колонок никто не трогает — отступ
  // приходит переменной, а не инлайном поверх чужих стилей.
  const INSET_GAP = 16                       // зазор блок↔колонка из решения
  const INSET_RIGHT = '--ultra-block-inset-right'
  const INSET_LEFT = '--ultra-block-inset-left'
  const COLUMNS = ['.feed-container', '.composer-col']
  const PAD_TOKENS = ['padding', 'padding-inline', 'padding-inline-start',
    'padding-inline-end', 'padding-left', 'padding-right']
  const pxOf = value => {
    const text = String(value == null ? '' : value).trim()
    const num = Number(text.replace(/[^0-9.\-]/g, ''))
    return { text, num: Number.isFinite(num) ? num : NaN }
  }
  // Меряем именно корень: на слое `.ublocks` переменная бесполезна — колонки не
  // его потомки, и `padding-inline: var(...)` их бы не увидел.
  const insetOnRoot = name => pxOf(cs(document.documentElement).getPropertyValue(name))
  // В разметке три `.feed-container` и три `.composer-col` (чат, второй экран,
  // сплит): берём видимый, а не первый попавшийся.
  const visible = selector => [...document.querySelectorAll(selector)]
    .find(el => { const rect = box(el); return rect && rect.width > 0 && rect.height > 0 }) || null
  const padEnd = selector => { const el = visible(selector); return el ? pxOf(cs(el).paddingInlineEnd) : null }
  const padStart = selector => { const el = visible(selector); return el ? pxOf(cs(el).paddingInlineStart) : null }
  const transitionOf = selector => {
    const el = visible(selector)
    if (!el) return null
    return String(cs(el).transitionProperty || '').split(',').map(part => part.trim()).filter(Boolean)
  }
  // Пересечение двух прямоугольников с допуском в 1 px на дробные координаты;
  // в отчёт идёт площадь наезда — по ней видно, наехал ли блок заметно или на
  // волосок (волосок тоже красный: печатать в строку невозможно).
  const overlapOf = (a, b) => {
    if (!a || !b) return { w: NaN, h: NaN, area: NaN, noRect: true }
    const TOL = 1
    const wide = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const tall = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return wide > TOL && tall > TOL ? { w: Math.round(wide), h: Math.round(tall), area: Math.round(wide * tall) } : null
  }
  const inViewport = rect => Boolean(rect) && rect.left >= -1 && rect.top >= -1 &&
    rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1
  const edge = rect => `${Math.round(rect.left)}..${Math.round(rect.right)}×${Math.round(rect.top)}..${Math.round(rect.bottom)}`
  const composerRect = () => box($('composerTextarea'))
  // Padding колонки меняется с переходом, поэтому прямоугольник строки ввода
  // берём только после того, как раскладка устоялась: иначе проверка ловила бы
  // промежуток анимации вместо результата.
  const composerSettled = async () => { await wait(320); return composerRect() }
  // Переход по padding значит, что сразу после перемены значения ещё в пути:
  // меряем устоявшееся значение.
  const settledPad = async (el, side) => {
    const read = () => pxOf(side === 'right' ? cs(el).paddingInlineEnd : cs(el).paddingInlineStart)
    await wait(260)
    return read()
  }
  const settledPadOf = async (selector, side) => {
    const el = visible(selector)
    return el ? await settledPad(el, side) : null
  }
  // Дифференциал «колонка читает переменную»: на САМОЙ колонке подменяем
  // переменную известной засечкой и смотрим, сдвинулся ли её padding. Засечку
  // ставим на узел, а не на корень, — оболочка пересчитывает корень когда хочет,
  // и её пересчёт сбил бы проверку; на элементе засечку перебивать нечем.
  // Сравнение «padding == отступ» тут не годится: на широком окне коробка
  // колонки (720 px в Ultra) меньше запрошенного отступа, и браузер подрезает
  // used padding (замер 29.09: заказ 680 px, в computed 627,7 px). Что колонка
  // действительно связана с переменной — видно по сдвигу.
  const readsVariable = async (selector, side) => {
    const el = visible(selector)
    const name = side === 'right' ? INSET_RIGHT : INSET_LEFT
    if (!el) return { ok: false, detail: 'узла колонки нет' }
    const read = () => pxOf(side === 'right' ? cs(el).paddingInlineEnd : cs(el).paddingInlineStart)
    await wait(260)
    const before = read()
    el.style.setProperty(name, '123px')
    await wait(260)
    const after = read()
    el.style.removeProperty(name)
    await wait(260)
    return {
      ok: Number.isFinite(before.num) && Number.isFinite(after.num) && Math.abs(after.num - before.num) >= 8,
      detail: `${name}=123px на узле: padding-inline-${side} ${before.text} → «${after.text}» (отступ должен добегать до значения переменной)`
    }
  }
  // База колонок до всякого прилипания: по ней видно, что отступ правда вырос.
  const basePad = {}
  for (const selector of COLUMNS) basePad[selector] = { start: padStart(selector), end: padEnd(selector) }
  const padHold = {}
  const clashReport = (rect, composer, inset, side) => {
    if (!composer) return 'узла строки ввода нет — мерить пересечение нечем'
    const hit = overlapOf(rect, composer)
    const free = side === 'right' ? rect.left - composer.right : composer.left - rect.right
    if (!hit) return `зазор ${Math.round(free)}px: блок ${edge(rect)}, строка ввода ${edge(composer)}, отступ ${Math.round(inset)}px`
    return `наезд ${hit.w}×${hit.h}px, площадь ${hit.area}: блок ${edge(rect)}, строка ввода ${edge(composer)}, отступ ${Math.round(inset)}px`
  }

  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })

  const arg = (() => {
    try {
      const bin = atob('__ONECODE_ARG__')
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  })()
  const mode = arg.mode || 'blocks'
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
  note('язык окна выставлен штатным переключателем', window.onlyoneApp?.lang?.() === lang, window.onlyoneApp?.lang?.())

  // Н95: пересечение блока со строкой ввода меряется на ТРЕХ реальных размерах
  // окна. Размер заказывает сам зонд: `window.resizeTo` в этом окне работает
  // (замер 29.09: innerWidth становится ровно заказанным), а `main.js` править
  // нельзя — он не для этого набора. Остальным кадрам нужен один фиксированный
  // размер, поэтому ветка одна.
  if (mode === 'inset' && Number(arg.width)) {
    window.resizeTo(Number(arg.width), Number(arg.height) || 900)
    const settled = await until(() => Math.abs(window.innerWidth - Number(arg.width)) <= 8 &&
      Math.abs(window.innerHeight - (Number(arg.height) || 900)) <= 8, 6000)
    note(`Н95: окно приняло размер ${arg.width}×${arg.height}`, settled,
      `внутри ${window.innerWidth}×${window.innerHeight}`)
    await wait(220)
  }

  const shell = () => document.querySelector('#ultraHost .ultra')
  const layer = () => document.querySelector('.ublocks')
  const blocks = () => [...document.querySelectorAll('.ublock')]
  const pills = () => [...document.querySelectorAll('.ublock-pill')]
  const blockOf = title => blocks().find(el => norm(el.querySelector('.ublock-title')?.textContent).includes(title)) || null

  // ─── посев: диалог с ходом, чтобы было что открывать ────────────────────────
  if (mode === 'seed') {
    const now = Date.now()
    const stored = await window.electronAPI?.getConversations?.() || []
    const mine = stored.find(item => item.id === chatId) || {
      id: chatId, title: 'Прогон свободных блоков', createdAt: now - 60000, updatedAt: now - 20000
    }
    mine.messages = [
      { role: 'user', content: 'Покажи результаты', timestamp: now - 60000 },
      { role: 'assistant', content: 'Вот результаты этого диалога.', timestamp: now - 55000 }
    ]
    const others = stored.filter(item => item.id !== chatId)
    const saved = await window.electronAPI?.setConversations?.([mine, ...others])
    note('посев: диалог записан в историю окна', saved?.ok === true, JSON.stringify(saved || {}).slice(0, 70))
    await window.__reloadChats?.()
    window.__joinProject?.(null)
    await wait(1400)
    const onDisk = await window.electronAPI?.getConversations?.() || []
    note('посев: диалог лежит на диске', onDisk.some(item => item.id === chatId), `диалогов: ${onDisk.length}`)
    return { ok: checks.every(one => one.pass), checks }
  }

  // ─── контроль: обычный вид не заводит слоя блоков ───────────────────────────
  if (mode === 'control') {
    await wait(600)
    note('контроль default: слоя свободных блоков нет', !layer(), layer() ? 'слой на месте' : '')
    note('контроль default: обычного окна оболочка не тронула',
      norm($('composerTextarea')?.placeholder).length > 0 && cs(document.querySelector('.sidebar')).display !== 'none',
      `поле ввода есть, sidebar=${cs(document.querySelector('.sidebar'))?.display}`)
    // Н95: отступ живёт под признаком пресета. В обычном виде ни переменной, ни
    // сдвига колонок быть не должно — иначе правка задела бы не Ultra.
    note('Н95 контроль default: переменных отступа на корне нет',
      [INSET_LEFT, INSET_RIGHT].every(name => { const one = insetOnRoot(name); return one.text === '' || one.num === 0 }),
      `${INSET_LEFT}=«${insetOnRoot(INSET_LEFT).text}», ${INSET_RIGHT}=«${insetOnRoot(INSET_RIGHT).text}»`)
    note('Н95 контроль default: колонки обычного вида не сдвинуты',
      COLUMNS.every(selector => { const one = padEnd(selector); return !one || one.num < 200 }) &&
      COLUMNS.some(selector => padEnd(selector)),
      COLUMNS.map(selector => `${selector} padding-inline-end=«${padEnd(selector)?.text || 'узла нет'}»`).join(', '))
    return { ok: checks.every(one => one.pass), checks }
  }

  // ─── экран одного чата с результатами ───────────────────────────────────────
  const mounted = await until(() => Boolean(shell()), 12000)
  note('оболочка Ultra смонтирована', mounted && document.documentElement.getAttribute('data-version-preset') === 'ultra',
    `признак=${document.documentElement.getAttribute('data-version-preset')}`)
  const row = await until(() => shell()?.querySelector(`[data-chat-id="${chatId}"]`), 8000)
    ? shell().querySelector(`[data-chat-id="${chatId}"]`) : null
  row?.click()
  const inChat = await until(() => shell()?.classList.contains('is-chat'), 8000)
  note('чат открыт кликом по строке Sessions', inChat, `режим=${shell()?.className}`)
  const shown = await until(() => blocks().length === titles.length, 12000)
  note('блок на каждый результат, и ни одного лишнего', shown,
    `блоков ${blocks().length}, артефактов в диалоге ${titles.length}`)

  const body = box(document.querySelector('.app-body'))
  let first = blockOf(titles[0] || '')
  if (!first) {
    note('первый блок найден по названию', false, `на экране блоки: ${blocks().map(el => norm(el.querySelector('.ublock-title')?.textContent)).join(' | ')}`)
    return { ok: false, checks }
  }
  const rect = box(first)
  note('блок стоит внутри тела окна и не меньше минимума',
    rect.width >= 280 && rect.height >= 200 && rect.left >= body.left - 1 && rect.top >= body.top - 1 &&
    rect.right <= body.right + 1 && rect.bottom <= body.bottom + 1,
    `${Math.round(rect.width)}×${Math.round(rect.height)} в ${Math.round(body.width)}×${Math.round(body.height)}`)
  const meta = norm(first.querySelector('.ublock-meta')?.textContent)
  note('блок говорит, чем является результат и сколько в нём версий',
    meta.length > 0 && !/%s/.test(meta) && /версий|versions/.test(meta), meta)

  // U-1: полоса снята и у слоя свободных блоков. Тело блока на этом кадре
  // не переполняется, поэтому меряется применённое правило на настоящем узле
  // окна, а не геометрия: сам механизм «полоса removal» измерен в кадрах ленты
  // (run-ultra-shell-ui, режим scroll), где она и обязана исчезнуть.
  const metaEl = first.querySelector('.ublock-meta')
  note('U-1: у тела блока в Ultra полосы прокрутки нет',
    cs(metaEl)?.scrollbarWidth === 'none',
    `scrollbar-width=«${cs(metaEl)?.scrollbarWidth}», overflow-y=${cs(metaEl)?.overflowY}`)

  // ─── Н95: что есть ДО всякого прилипания ────────────────────────────────────
  // Ни один блок не у края: обе переменные пусты или нули, колонки на своей базе.
  // Проверка зелёная и сейчас — она сторожит «иначе 0» и не даёт решить дефект
  // тем, что колонка съехала навсегда.
  note('Н95: до прилипания обе переменные отступа на корне пусты или нули',
    [INSET_LEFT, INSET_RIGHT].every(name => { const one = insetOnRoot(name); return one.text === '' || one.num === 0 }),
    `${INSET_LEFT}=«${insetOnRoot(INSET_LEFT).text}», ${INSET_RIGHT}=«${insetOnRoot(INSET_RIGHT).text}»`)
  note('Н95: колонки разговора видны — есть что отодвигать',
    COLUMNS.every(selector => Boolean(visible(selector)) && Boolean(basePad[selector].end)),
    COLUMNS.map(selector => `${selector}: ${basePad[selector].end ? basePad[selector].end.text : 'нет узла'} (слева ${basePad[selector].start ? basePad[selector].start.text : '—'})`).join(', '))
  note('Н95: до прилипания колонки не размечены инлайном',
    COLUMNS.every(selector => {
      const el = visible(selector)
      return !el || !['padding', 'padding-inline', 'padding-left', 'padding-right',
        'padding-inline-start', 'padding-inline-end'].some(prop => String(el.style.getPropertyValue(prop) || '').trim())
    }),
    COLUMNS.map(selector => `${selector}: inline="${visible(selector) ? (visible(selector).getAttribute('style') || '') : 'нет узла'}"`).join(', '))

  const pointer = (el, type, at) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, pointerId: 1, button: 0
  }))
  const drag = async (el, from, to) => {
    pointer(el, 'pointerdown', from)
    pointer(document, 'pointermove', to)
    await wait(60)
    pointer(document, 'pointerup', to)
    await wait(120)
  }
  const head = first.querySelector('.ublock-head')
  const centre = { x: rect.left + rect.width / 2, y: rect.top + 12 }
  const again = () => { first = blockOf(titles[0] || '') || first }

  // Порядок артефактов на диске не постоянен, а проверки меряют сдвиги: блок
  // сначала ставится в известное место тем же перетаскиванием.
  await drag(head, centre, { x: body.left + 340, y: body.top + 140 })
  again()
  const base = box(first)
  note('блок переставлен в известное место окна',
    base.left > body.left + 40 && base.top > body.top + 40 && base.bottom < body.bottom - 220 && base.right < body.right - 220,
    `${Math.round(base.left)},${Math.round(base.top)} — ${Math.round(base.width)}×${Math.round(base.height)}`)

  // ─── Н95: прилипший блок против строки ввода, на трёх реальных размерах ──────
  // Кадр `inset` отличается от `blocks` только заказанным размером окна и этим
  // блоком: здесь меряется то, ради чего дефект — пересечение прямоугольника
  // прилипшего блока с прямоугольником строки ввода (textarea) и то, что строка
  // ввода осталась целиком во вьюпорте. Оба борта, левый первым: снимок делается
  // после отчёта, и на нём должен остаться ПРАВый блок — ровно тот случай, где
  // человек терял ввод.
  if (mode === 'inset') {
    const tag = `${Number(arg.width) || window.innerWidth}×${Number(arg.height) || window.innerHeight}`
    const trace = []
    for (const side of ['left', 'right']) {
      const start = box(first)
      const grabAt = { x: start.left + Math.min(60, start.width / 2), y: start.top + 12 }
      const dropAt = { x: side === 'right' ? body.right - 6 : body.left + 6, y: body.top + Math.round(body.height / 2) }
      await drag(first.querySelector('.ublock-head') || head, grabAt, dropAt)
      again()
      const dockedRect = box(first)
      const name = side === 'right' ? INSET_RIGHT : INSET_LEFT
      const otherName = side === 'right' ? INSET_LEFT : INSET_RIGHT
      const inset = insetOnRoot(name)
      const other = insetOnRoot(otherName)
      const composer = await composerSettled()
      const hit = overlapOf(dockedRect, composer)
      note(`Н95 ${tag} ${side}: на корне ширина прилипшего блока плюс ${INSET_GAP}`,
        inset.text !== '' && Math.abs(inset.num - (dockedRect.width + INSET_GAP)) <= 1.5,
        `${name} = «${inset.text}», блок ${Math.round(dockedRect.width)}px, жали ${Math.round(dockedRect.width + INSET_GAP)}px`)
      note(`Н95 ${tag} ${side}: свободная сторона опубликована нулём`,
        other.text !== '' && other.num === 0,
        `${otherName} = «${other.text}» — жали «0px», пустое значение значит, что колонка осталась под блоком`)
      for (const selector of COLUMNS) {
        const now = await settledPadOf(selector, side)
        const was = side === 'right' ? basePad[selector].end : basePad[selector].start
        const holder = box(visible(selector))
        note(`Н95 ${tag} ${side}: ${selector} отступил вместе с отступом`,
          Boolean(now) && Boolean(was) && now.num > was.num,
          `padding-inline-${side}: ${was ? was.text : '—'} → «${now ? now.text : 'нет узла'}» при отступе «${inset.text}»; ` +
          `коробка колонки ${Math.round(holder ? holder.width : 0)}px — на широком окне браузер подрезает used padding, поэтому цифра может быть меньше заказа`)
        const link = await readsVariable(selector, side)
        note(`Н95 ${tag} ${side}: ${selector} читает ${name}`, link.ok, link.detail)
        if (side === 'right') padHold[selector] = now
      }
      note(`Н95 ${tag} ${side}: прилипший блок не наезжает на строку ввода`,
        Boolean(composer) && !hit, clashReport(dockedRect, composer, inset.num, side))
      note(`Н95 ${tag} ${side}: строка ввода целиком в окне`,
        inViewport(composer) && Boolean(composer) && composer.width > 0,
        composer ? `${edge(composer)} при окне ${window.innerWidth}×${window.innerHeight}, ширина ${Math.round(composer.width)}px` : 'узла #composerTextarea нет')
      trace.push(`${side}: отступ «${inset.text || '—'}», блок ${Math.round(dockedRect.width)}px, ` +
        `строка ввода ${Math.round(composer ? composer.width : 0)}px, наезд ${hit ? hit.area + 'px²' : 'нет'}`)
    }
    const lastRect = box(first)
    const lastInset = insetOnRoot(INSET_RIGHT)
    const lastComposer = await composerSettled()
    note(`Н95 ${tag}: экран с прилипшим справа блоком доживает до снимка`,
      Boolean(layer()) && blocks().length === titles.length &&
      document.documentElement.getAttribute('data-version-preset') === 'ultra' &&
      !overlapOf(lastRect, lastComposer) && lastInset.num > 0,
      `блоков ${blocks().length}, ${INSET_RIGHT} = «${lastInset.text}», ${clashReport(lastRect, lastComposer, lastInset.num, 'right')}`)
    return {
      ok: checks.every(one => one.pass),
      checks,
      size: { wanted: tag, inner: `${window.innerWidth}×${window.innerHeight}` },
      trace
    }
  }

  // растяжение за любой край: ручка «se»
  const grip = [...first.querySelectorAll('.ublock-grip')].find(el => el.getAttribute('data-edge') === 'se')
  note('ручек размера восемь — тянуть можно за любой край и угол',
    first.querySelectorAll('.ublock-grip').length === 8 && Boolean(grip),
    `ручек: ${first.querySelectorAll('.ublock-grip').length}`)
  await drag(grip, { x: base.right - 3, y: base.bottom - 3 }, { x: base.right - 3 + 96, y: base.bottom - 3 + 72 })
  again()
  const grown = box(first)
  note('за юго-восточный угол блок растягивается, левый верх стоит',
    Math.abs(grown.width - (base.width + 96)) <= 8 && Math.abs(grown.height - (base.height + 72)) <= 8 &&
    Math.abs(grown.left - base.left) <= 1 && Math.abs(grown.top - base.top) <= 1,
    `${Math.round(base.width)}×${Math.round(base.height)} → ${Math.round(grown.width)}×${Math.round(grown.height)}`)

  // перетаскивание за заголовок: размер при этом не меняется
  const grab = { x: grown.left + grown.width / 2, y: grown.top + 12 }
  await drag(first.querySelector('.ublock-head') || head, grab, { x: grab.x + 160, y: grab.y + 88 })
  again()
  const moved = box(first)
  note('заголовок перетаскивает блок, размер не меняется',
    Math.abs(moved.left - (grown.left + 160)) <= 8 && Math.abs(moved.top - (grown.top + 88)) <= 8 &&
    Math.abs(moved.width - grown.width) <= 1 && Math.abs(moved.height - grown.height) <= 1,
    `(${Math.round(grown.left)},${Math.round(grown.top)}) → (${Math.round(moved.left)},${Math.round(moved.top)})`)

  // прилипание к правому краю: призрак во время движения, зона после отпускания
  const handle = first.querySelector('.ublock-head') || head
  const at = { x: moved.left + 60, y: moved.top + 12 }
  const target = { x: body.right - 6, y: body.top + body.height / 2 }
  pointer(handle, 'pointerdown', at)
  pointer(document, 'pointermove', target)
  await wait(80)
  const ghost = document.querySelector('.ublock-snap')
  note('у края окна появляется призрак зоны', Boolean(ghost),
    ghost ? `${Math.round(box(ghost).width)}×${Math.round(box(ghost).height)}` : 'узла .ublock-snap нет')
  pointer(document, 'pointerup', target)
  await wait(160)
  again()
  const docked = box(first)
  note('после отпускания блок сел в правую зону',
    docked.right >= body.right - 24 && docked.width >= 280 && !document.querySelector('.ublock-snap'),
    `правый край ${Math.round(docked.right)} против ${Math.round(body.right)}, ширина ${Math.round(docked.width)}`)

  // ─── Н95: прилипший справа блок обязан отодвинуть колонки, а не лечь на них ───
  const rightInset = insetOnRoot(INSET_RIGHT)
  const leftInset = insetOnRoot(INSET_LEFT)
  const composerNow = await composerSettled()
  note('Н95: правый отступ опубликован на корне и равен «ширина блока + 16»',
    rightInset.text !== '' && Math.abs(rightInset.num - (docked.width + INSET_GAP)) <= 1.5,
    `:root ${INSET_RIGHT} = «${rightInset.text}», блок ${Math.round(docked.width)}px, жали ${Math.round(docked.width + INSET_GAP)}px`)
  note('Н95: левый край свободен — на корне левый отступ 0px',
    leftInset.text !== '' && leftInset.num === 0,
    `${INSET_LEFT} = «${leftInset.text}» — жали «0px»; пустое значение значит, что оболочка переменную не публикует`)
  for (const selector of COLUMNS) {
    const now = await settledPadOf(selector, 'right')
    const was = basePad[selector].end
    const holder = box(visible(selector))
    padHold[selector] = now
    note(`Н95: ${selector} отступил справа вместе с отступом`,
      Boolean(now) && Boolean(was) && now.num > was.num,
      `padding-inline-end: ${was ? was.text : '—'} → «${now ? now.text : 'нет узла'}» при отступе «${rightInset.text}»; ` +
      `коробка колонки ${Math.round(holder ? holder.width : 0)}px — на широком окне браузер подрезает used padding, поэтому цифра может быть меньше заказа`)
    const link = await readsVariable(selector, 'right')
    note(`Н95: ${selector} читает ${INSET_RIGHT}`, link.ok, link.detail)
    const glide = transitionOf(selector)
    note(`Н95: у ${selector} переход по padding и не «all»`,
      Array.isArray(glide) && glide.some(token => PAD_TOKENS.includes(token)) && !glide.includes('all'),
      `transition-property: «${glide ? glide.join(' ') : 'нет узла'}» — «all» здесь либо начальное значение (перехода нет вовсе), ` +
      `либо запрещённый сторожем test-interface-rules.cjs переход по всем свойствам; ждём токен padding`)
  }
  const inlinePad = []
  for (const selector of COLUMNS) {
    const el = visible(selector)
    if (!el) continue
    for (const prop of ['padding', 'padding-inline', 'padding-inline-start', 'padding-inline-end', 'padding-left', 'padding-right']) {
      const value = String(el.style.getPropertyValue(prop) || '').trim()
      if (value) inlinePad.push(`${selector}: ${prop} = ${value}`)
    }
  }
  note('Н95: колонки отодвигает переменная, а не инлайн поверх их собственных стилей',
    inlinePad.length === 0, inlinePad.join('; ') || 'инлайна на колонках нет')
  note('Н95: прилипший справа блок не наезжает на строку ввода',
    Boolean(composerNow) && !overlapOf(docked, composerNow),
    clashReport(docked, composerNow, rightInset.num, 'right'))
  note('Н95: строка ввода целиком в окне',
    inViewport(composerNow) && Boolean(composerNow) && composerNow.width > 0,
    composerNow ? `${edge(composerNow)} при окне ${window.innerWidth}×${window.innerHeight}, ширина ${Math.round(composerNow.width)}px` : 'узла #composerTextarea нет')

  // сворачивание в пилюлю и обратно
  const place = { left: Math.round(docked.left), top: Math.round(docked.top) }
  first.querySelector('.ublock-min').click()
  await wait(160)
  const pill = pills().find(el => norm(el.textContent).includes(titles[0] || ''))
  note('свёрнутый блок стал пилюлей с тем же названием',
    Boolean(pill) && !blockOf(titles[0] || ''), `пилюль: ${pills().length}, блоков: ${blocks().length}`)
  note('Н95: свёрнутый в пилюлю блок правый отступ отпускает',
    insetOnRoot(INSET_RIGHT).num === 0,
    `${INSET_RIGHT} = «${insetOnRoot(INSET_RIGHT).text}», жали «0px»: пилюля не занимает край от верха до низа`)
  pill?.click()
  await wait(160)
  const back = blockOf(titles[0] || '')
  note('пилюля разворачивает блок на то же место',
    Boolean(back) && Math.abs(box(back).left - place.left) <= 2 && Math.abs(box(back).top - place.top) <= 2 && pills().length === 0,
    `вернулся в (${Math.round(box(back)?.left)},${Math.round(box(back)?.top)}), было (${place.left},${place.top})`)
  const backRect = box(back)
  note('Н95: развёрнутый на край блок возвращает правый отступ',
    Boolean(backRect) && Math.abs(insetOnRoot(INSET_RIGHT).num - (backRect.width + INSET_GAP)) <= 1.5,
    `${INSET_RIGHT} = «${insetOnRoot(INSET_RIGHT).text}», блок ${Math.round(backRect ? backRect.width : 0)}px, жали ${Math.round((backRect ? backRect.width : 0) + INSET_GAP)}px`)

  // уборка и возврат
  for (const block of blocks()) block.querySelector('.ublock-close').click()
  await wait(160)
  const restore = document.querySelector('.ublock-restore')
  note('убранные блоки возвращаются одной кнопкой',
    blocks().length === 0 && Boolean(restore) && norm(restore.textContent).length > 0,
    `кнопка «${norm(restore?.textContent)}»`)
  note('Н95: убранный блок отступ не держит',
    insetOnRoot(INSET_RIGHT).num === 0,
    `${INSET_RIGHT} = «${insetOnRoot(INSET_RIGHT).text}», жали «0px»: колонка не должна съезжать в пустоту`)
  restore?.click()
  await wait(200)
  note('возврат поставил все блоки обратно', blocks().length === titles.length, `блоков: ${blocks().length}`)
  note('Н95: возврат блока возвращает и правый отступ',
    Math.abs(insetOnRoot(INSET_RIGHT).num - (docked.width + INSET_GAP)) <= 1.5,
    `${INSET_RIGHT} = «${insetOnRoot(INSET_RIGHT).text}», жали ${Math.round(docked.width + INSET_GAP)}px`)

  // ─── Н95: отклеивание от правого края — на примере левого борта ──────────────
  // Свободной позиции в этом окне для проверки не берём: блок шириной в половину
  // экрана куда бы его ни тащить остаётся у края, а отпускать отступ он должен по
  // факту зоны. Поэтому уводим его на ЛЕВЫЙ край: правый отступ обязан стать 0px,
  // левый — равен ширине блока, а строка ввода — остаться свободной с другой
  // стороны и вернуться к своей базе справа.
  const before = blockOf(titles[0] || '') || first
  const cur = box(before)
  await drag(before.querySelector('.ublock-head') || handle,
    { x: cur.left + Math.min(60, cur.width / 2), y: cur.top + 12 },
    { x: body.left + 6, y: body.top + Math.round(body.height / 2) })
  again()
  const dockedLeft = box(first)
  const leftNow = insetOnRoot(INSET_LEFT)
  const rightNow = insetOnRoot(INSET_RIGHT)
  note('Н95: блок уехал на левый край — правый отступ опубликован нулём',
    rightNow.text !== '' && rightNow.num === 0,
    `${INSET_RIGHT} = «${rightNow.text}», жали «0px» (блок ${Math.round(dockedLeft.left)}..${Math.round(dockedLeft.right)})`)
  note('Н95: прилипший слева блок даёт левый отступ «ширина + 16»',
    leftNow.text !== '' && Math.abs(leftNow.num - (dockedLeft.width + INSET_GAP)) <= 1.5,
    `${INSET_LEFT} = «${leftNow.text}», блок ${Math.round(dockedLeft.width)}px, жали ${Math.round(dockedLeft.width + INSET_GAP)}px`)
  for (const selector of COLUMNS) {
    const startNow = await settledPadOf(selector, 'left')
    const endNow = await settledPadOf(selector, 'right')
    note(`Н95: ${selector} отпустил правый край и получил левый`,
      Boolean(endNow) && Boolean(startNow) && Boolean(padHold[selector]) &&
      startNow.num > basePad[selector].start.num && endNow.num + 1 < padHold[selector].num,
      `padding-inline-start ${basePad[selector].start.text} → «${startNow ? startNow.text : '—'}», ` +
      `padding-inline-end при правом прилипании держал ${padHold[selector] ? padHold[selector].text : '—'}, стал «${endNow ? endNow.text : '—'}»`)
    const link = await readsVariable(selector, 'left')
    note(`Н95: ${selector} читает ${INSET_LEFT}`, link.ok, link.detail)
  }
  const composerLeft = await composerSettled()
  note('Н95: прилипший слева блок не наезжает на строку ввода',
    Boolean(composerLeft) && !overlapOf(dockedLeft, composerLeft),
    clashReport(dockedLeft, composerLeft, leftNow.num, 'left'))
  note('Н95: после отклеивания строка ввода целиком в окне',
    inViewport(composerLeft) && Boolean(composerLeft) && composerLeft.width > 0,
    composerLeft ? `${edge(composerLeft)}, ширина ${Math.round(composerLeft.width)}px при окне ${window.innerWidth}×${window.innerHeight}` : 'узла нет')

  // открытие результата идёт тем же путём, что кнопка в ряду артефактов
  const opened = blockOf(titles[0] || '')
  opened?.querySelector('.ublock-open')?.click()
  const panelShown = await until(() => $('artifactPanel') && !$('artifactPanel').hidden, 8000)
  note('«Открыть» показывает результат штатной панелью',
    panelShown && norm($('artifactTitle')?.textContent).includes(titles[0] || ''),
    `панель ${panelShown ? 'открыта' : 'закрыта'}, заголовок «${norm($('artifactTitle')?.textContent)}»`)
  $('artifactClose')?.click()
  await wait(160)

  // хром блока на английском: подписи кнопок и строка результата
  const chrome = []
  for (const el of (layer()?.querySelectorAll('*') || [])) {
    if (el.closest('.ublock-title')) continue
    for (const name of ['aria-label', 'data-tooltip']) {
      const value = norm(el.getAttribute(name))
      if (value) chrome.push(value)
    }
    if (/^(BUTTON|SPAN|DIV)$/.test(el.tagName) && el.children.length === 0) {
      const value = norm(el.textContent)
      if (value && !titles.some(title => value.includes(title))) chrome.push(value)
    }
  }
  const stray = [...new Set(chrome.filter(hasCyr))]
  if (lang === 'en') {
    note('на английском хром блока молчит по-русски', stray.length === 0, stray.slice(0, 6).join(' | ') || `строк: ${new Set(chrome).size}`)
  } else {
    note('подписи блока переведены на язык окна', stray.length > 0, `русских строк: ${stray.length} из ${new Set(chrome).size}`)
  }

  await wait(1400)
  note('экран с блоками держится до снимка',
    Boolean(layer()) && blocks().length === titles.length && document.documentElement.getAttribute('data-version-preset') === 'ultra',
    `блоков: ${blocks().length}`)
  // Слой обязан быть один, а состояний — ровно столько, сколько результатов:
  // прежний слой, оставшийся после пересборки экрана, дал бы на кадре лишние
  // пилюли и призрачные блоки (это и видно на снимке, если проверка краснеет).
  const layers = document.querySelectorAll('.ublocks').length
  note('слой блоков один, на экране нет узлов прежнего состояния',
    layers === 1 && blocks().length === titles.length && pills().length === 0 && !document.querySelector('.ublock-restore'),
    `слоёв: ${layers}, блоков: ${blocks().length}, пилюль: ${pills().length}, возврат: ${Boolean(document.querySelector('.ublock-restore'))}`)

  return { ok: checks.every(one => one.pass), checks }
})()
