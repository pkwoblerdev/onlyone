// 3.10 — команды и режимы компактным списком над «/» (план, 3.10): оконные
// проверки состояния.
//
// Сеть наружу не трогается, модель не вызывается: проверяется только то, что
// экран уже умеет сам — поле ввода, список над ним и пилюля режимов. Текст
// набирается в поле, список открывается штатным механизмом окна, дальше меряется
// настоящая раскладка: зазор до поля, ширина по самому длинному имени, высота
// строки, отступы, радиусы, шрифт имени, цвет выбранной строки, подсказка
// справа, прокрутка и появление.
//
// ПРОГОН ОБЯЗАН закончить с открытым списком: `main.js` снимает кадр сразу после
// возврата отчёта, и если к этому моменту список закрыт, на кадре будет
// приветственный экран вместо доказательства. Перед съёмкой — scrollIntoView и
// несколько кадров requestAnimationFrame.
(async () => {
  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')
  const mode = arg.mode || 'commands-ru'
  const english = /-en$/.test(mode)
  const isModes = /^modes/.test(mode)
  const withHint = !/^commands/.test(mode)
  const label = mode

  const $ = id => document.getElementById(id)
  const boxEl = () => document.querySelector('.composer-input-box') || $('composerCard')
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms = 8000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch { return false }
      await wait(80)
    }
    return false
  }
  // Несколько кадров: класс состояния и раскладка подсказки приходят не в том же
  // кадре, что событие.
  const frames = (count = 2) => new Promise(resolve => {
    let left = count
    const step = () => { if (--left > 0) requestAnimationFrame(step); else resolve() }
    requestAnimationFrame(step)
  })

  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const RU = /[а-яё]/i
  const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
  const round = value => Math.round(value * 10) / 10
  const num = value => parseFloat(String(value)) || 0
  const rect = el => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }
  }
  const shown = el => {
    if (!el || el.hidden) return false
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden'
  }

  // Значение токена так, как его увидит глаз: пробный элемент с этим токеном. В лоб
  // `getPropertyValue('--bg-raised')` отдаёт `var(--bg-composer)`, и сравнить с
  // вычисленным цветом строки было бы нельзя.
  function tokenValue (token, prop) {
    const probe = document.createElement('span')
    probe.style.position = 'absolute'
    probe.style.left = '-2000px'
    probe.style[prop] = `var(${token})`
    document.body.appendChild(probe)
    const value = getComputedStyle(probe)[prop]
    probe.remove()
    return value
  }

  const listboxes = () => [...document.querySelectorAll('[role="listbox"]')].filter(shown)
  const openMenu = () => listboxes()[0] || null
  const rowsIn = menu => (menu ? [...menu.querySelectorAll('[role="option"]')].filter(shown) : [])
  const selectedRow = menu => rowsIn(menu).find(row => row.getAttribute('aria-selected') === 'true') || rowsIn(menu)[0] || null

  // Видимые_leaf_-тексты документа: по разнице «до» и «после» находим подсказку,
  // а не гадаем, какой из вечных текстов экрана на неё похож.
  const leafTexts = () => {
    const out = new Map()
    for (const el of [...document.querySelectorAll('body *')]) {
      if (!shown(el)) continue
      if ([...el.children].some(one => shown(one))) continue
      const value = text(el)
      if (value.length > 12 && !out.has(value)) out.set(value, el)
    }
    return out
  }

  async function pressKey (key) {
    // Клавиша идёт и на документ (своя проводка модуля), и на поле, и на пилюлю:
    // слушать экран вправе где угодно, а проверяем мы поведение.
    for (const target of [document, $('composerTextarea'), $('permModeBtn')]) {
      if (!target) continue
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
    }
    await frames()
  }

  async function typeInto (value) {
    const ta = $('composerTextarea')
    ta.focus()
    ta.value = value
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await frames()
  }

  async function openPill () {
    $('permModeBtn')?.click()
    await frames()
  }

  const nameElement = row => {
    const wanted = text(row)
    return [row, ...row.querySelectorAll('*')].find(one => text(one) === wanted && !one.children.length) || row
  }

  // ─── проверки состояния ─────────────────────────────────────────────────────
  function measureLayout (menu) {
    const rows = rowsIn(menu)
    if (!rows.length) { note(`${label}: список не рисует строки`, false); return }
    // Появление масштабирует блок (scale 0.97 → 1 за 120 ms), и getBoundingClientRect
    // в этот момент отдаёт уменьшенную коробку: 155.2 px вместо 160. Геометрию
    // снимаем по устоявшемуся виду; движение проверяется отдельно, в checkMotion.
    try { (menu.getAnimations() || []).forEach(one => { try { one.finish() } catch (e) {} }) } catch (e) {}
    const box = rect(menu)
    const anchor = rect(isModes ? $('permModeBtn') : boxEl())
    const gap = round(anchor.top - box.bottom)
    note(`${label}: список стоит НАД якорем, нижний край на 6 px выше поля`,
      Math.abs(gap - 6) <= 1.5,
      `зазор ${gap} px (низ списка ${round(box.bottom)}, верх якоря ${round(anchor.top)}; ` +
      `до карточки композера ${round(rect($('composerCard')).top - box.bottom)} px)`)
    const ta = $('composerTextarea')
    const taStyle = getComputedStyle(ta)
    const textLeft = round(rect(ta).left + num(taStyle.paddingLeft) + num(taStyle.borderLeftWidth))
    const expectLeft = isModes ? round(anchor.left) : textLeft
    note(`${label}: левый край ${isModes ? 'по левому краю пилюли' : 'по левому краю текста поля'}`,
      Math.abs(round(box.left) - expectLeft) <= 2,
      `край списка ${round(box.left)}, ждали ${expectLeft} (рамка поля ${round(rect(boxEl()).left)})`)
    const widest = Math.max(...rows.map(row => rect(nameElement(row)).w))
    const expected = Math.min(240, Math.max(160, Math.round(widest + 24)))
    note(`${label}: ширина = самое длинное имя + 24 px, но не уже 160 и не шире 240`,
      Math.abs(round(box.w) - expected) <= 2,
      `ширина ${round(box.w)} px, самое длинное имя ${round(widest)} px → ждали ${expected} px`)
    const heights = rows.map(row => round(rect(row).h))
    note(`${label}: строка списка 28 px`, heights.every(one => Math.abs(one - 28) <= 1), heights.join(', '))
    const style = getComputedStyle(menu)
    const padLeft = round(rect(rows[0]).left - box.left - num(style.borderLeftWidth))
    const padTop = round(rect(rows[0]).top - box.top - num(style.borderTopWidth))
    note(`${label}: внутренний отступ списка 10 px`, Math.abs(padLeft - 10) <= 1.5 && Math.abs(padTop - 10) <= 1.5,
      `слева ${padLeft} px, сверху ${padTop} px`)
    note(`${label}: радиусы — у списка 12 px, у пункта 8 px`,
      Math.abs(num(style.borderTopLeftRadius) - 12) <= 0.6 &&
      Math.abs(num(getComputedStyle(rows[0]).borderTopLeftRadius) - 8) <= 0.6,
      `меню ${style.borderTopLeftRadius}, пункт ${getComputedStyle(rows[0]).borderTopLeftRadius}`)
  }

  function checkRowTypographic (menu) {
    const row = rowsIn(menu)[0]
    const name = nameElement(row)
    const style = getComputedStyle(name)
    const ui = String(getComputedStyle(document.documentElement).getPropertyValue('--font-ui') || '').split(',')[0].replace(/["\s]/g, '')
    const mono = String(getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || '').split(',')[0].replace(/["\s]/g, '')
    const first = style.fontFamily.split(',')[0].replace(/["\s]/g, '')
    note(`${label}: имя набрано интерфейсным шрифтом, а не моноширинным`,
      first === ui && !/Fira Code|Cascadia|Consolas|monospace/i.test(style.fontFamily),
      `font-family: ${style.fontFamily}; ждали ${ui || '?'}, не ${mono || '?'}`)
    note(`${label}: имя 13.5 px начертания 400`,
      Math.abs(num(style.fontSize) - 13.5) <= 0.3 && num(style.fontWeight) === 400,
      `${style.fontSize} / ${style.fontWeight}`)
    // Акцентные токены сверяются по вычисленному цвету; служебные ('--accent-strong'
    // в этом проекте — чернила) в список не берём, иначе проверка краснела бы на
    // законном цвете текста.
    const ink = tokenValue('--text', 'color')
    const accents = ['--accent-primary', '--accent', '--accent-hover']
      .map(token => tokenValue(token, 'color')).filter(one => one && one !== ink)
    note(`${label}: имя не подкрашено акцентом`, accents.includes(style.color) === false,
      `цвет имени ${style.color}, акценты: ${accents.join(', ')}`)
  }

  function checkSelectedRow (menu) {
    const selected = selectedRow(menu)
    if (!selected) { note(`${label}: в списке есть выбранная строка`, false, `строк: ${rowsIn(menu).length}`); return null }
    const style = getComputedStyle(selected)
    const raised = tokenValue('--bg-raised', 'backgroundColor')
    const ink = tokenValue('--text', 'color')
    note(`${label}: выбранная строка — фон bg-raised, текст ink`,
      style.backgroundColor === raised && style.color === ink,
      `фон ${style.backgroundColor} (ждали ${raised}), текст ${style.color} (ждали ${ink})`)
    return selected
  }

  function checkNoHeaderNoDescription (menu) {
    const rows = rowsIn(menu)
    const header = [...menu.querySelectorAll('*')].find(one =>
      /^(доступные команды|commands|available commands)\b/i.test(text(one)))
    note(`${label}: шапки «Доступные команды»/«Commands» над списком нет`, !header, header ? text(header) : '')
    const described = rows.filter(row => RU.test(text(row)))
    note(`${label}: в строке нет описания (имена латиницей, кириллицы в строке быть не должно)`,
      described.length === 0, described.map(row => text(row).slice(0, 70)).join(' | '))
    const titles = [...menu.querySelectorAll('[title]')]
    note(`${label}: ни у чего в списке нет атрибута title (единственная подпись — data-tooltip)`,
      titles.length === 0, `узлов с title: ${titles.length}`)
  }

  function checkHint (el, row, where) {
    if (!el) { note(`${where}: справа от выбранной строки есть отдельная подсказка-описание`, false); return }
    const style = getComputedStyle(el)
    const hintBox = rect(el)
    const rowBox = rect(row)
    note(`${where}: подсказка стоит СПРАВА от своей строки, а не над списком и не под ним`,
      hintBox.left >= rowBox.right - 1 &&
      Math.min(hintBox.bottom, rowBox.bottom) - Math.max(hintBox.top, rowBox.top) > 0,
      `подсказка: left ${round(hintBox.left)}, top ${round(hintBox.top)}; строка: right ${round(rowBox.right)}, ` +
      `top ${round(rowBox.top)}, bottom ${round(rowBox.bottom)}`)
    note(`${where}: подсказка — 12 px при высоте строки 16 и не шире 280 px`,
      Math.abs(num(style.fontSize) - 12) <= 0.3 && Math.abs(num(style.lineHeight) - 16) <= 1 && hintBox.w <= 281,
      `${style.fontSize}/${style.lineHeight}, ширина ${round(hintBox.w)} px`)
    if (english) {
      note(`${where}: на английском подсказка переведена`, RU.test(text(el)) === false, text(el).slice(0, 80))
    }
  }

  async function checkScroll (menu) {
    const rows = rowsIn(menu)
    if (rows.length <= 8) return
    const scroller = [menu, ...menu.querySelectorAll('*')].find(one => /auto|scroll/.test(getComputedStyle(one).overflowY))
    note(`${label}: при ${rows.length} строках прокрутка внутри списка, а не растущий блок`,
      Boolean(scroller) && scroller.scrollHeight > scroller.clientHeight + 1 && rect(scroller).h <= 8 * 28 + 2 * 10 + 2,
      scroller ? `видно ${scroller.clientHeight} px из ${scroller.scrollHeight} px, высота блока ${round(rect(scroller).h)} px`
        : 'ни один узел списка не прокручивается')
    const anchor = rect(isModes ? $('permModeBtn') : boxEl())
    note(`${label}: с ${rows.length} строками список держит те же 6 px над якорем`,
      Math.abs(round(anchor.top - rect(menu).bottom) - 6) <= 2,
      `зазор ${round(anchor.top - rect(menu).bottom)} px`)
  }

  async function checkMotion (menu) {
    const style = getComputedStyle(menu)
    const raw = String(style.animationDuration).split(',')[0].trim()
    const ms = /ms$/.test(raw) ? parseFloat(raw) : parseFloat(raw) * 1000
    note(`${label}: появление идёт 120 ms`, Math.abs(ms - 120) <= 15,
      `animation: ${style.animationName} ${style.animationDuration}`)
    // Анимация к моменту замера уже успевает закончиться и пропадает из
    // getAnimations() — перечитываем ключевые кадры на перезапуске.
    let framesList = []
    try {
      menu.style.animation = 'none'
      void menu.offsetWidth
      menu.style.animation = ''
      await frames(2)
      framesList = menu.getAnimations().flatMap(one => (one.effect && one.effect.getKeyframes) ? one.effect.getKeyframes() : [])
    } catch (error) { framesList = [] }
    const dump = JSON.stringify(framesList.map(one => ({ offset: one.offset, transform: one.transform, opacity: one.opacity })))
    // getKeyframes() отдаёт opacity строкой ("0"), а не числом: прежний шаблон
    // "opacity":0 не совпадал ни с какой реализацией — проверка была мертва.
    note(`${label}: появление стартует из scale(0.97) и прозрачности`,
      /scale\(0\.97\)/.test(dump) && /"opacity":\s*"?0(\.0+)?"?/.test(dump),
      `кадры: ${dump.slice(0, 240) || 'получить не удалось'}`)
  }

  async function checkRoles (menu) {
    note(`${label}: открытое меню — role="listbox" с aria-activedescendant`,
      menu.getAttribute('role') === 'listbox' && Boolean(menu.getAttribute('aria-activedescendant')),
      `aria-activedescendant: ${menu.getAttribute('aria-activedescendant') || 'нет'}, aria-label: ${menu.getAttribute('aria-label') || 'нет'}`)
    const before = menu.getAttribute('aria-activedescendant')
    const beforeTexts = leafTexts()
    await pressKey('ArrowDown')
    const again = openMenu()
    const after = again ? again.getAttribute('aria-activedescendant') : null
    note(`${label}: стрелка вниз переводит выбор`, Boolean(after) && after !== before, `${before} → ${after}`)
    if (again) {
      const fresh = [...leafTexts().entries()].filter(([value]) => !beforeTexts.has(value))
        .map(([, el]) => el)
        .filter(el => !rowsIn(again).some(row => row.contains(el)))
      checkHint(fresh[0] || null, selectedRow(again), `${label} после стрелки`)
    }
  }

  async function checkEscapeCloses () {
    await pressKey('Escape')
    note(`${label}: Escape закрывает список`, listboxes().length === 0,
      listboxes().map(one => one.id || one.className).join(', '))
  }

  async function checkOutsideClickCloses () {
    if (!openMenu()) { note(`${label}: клик вне списка закрывает его`, false, 'списка нет — проверять нечего'); return }
    document.body.click()
    await frames()
    note(`${label}: клик вне списка закрывает его`, listboxes().length === 0,
      listboxes().map(one => one.id || one.className).join(', '))
  }

  async function commandsFlow () {
    await typeInto('/')
    const menu = openMenu()
    note(`${label}: набор «/» открывает список команд`, Boolean(menu),
      menu ? `строк: ${rowsIn(menu).length}` : 'после «/» видимого role="listbox" нет')
    if (!menu) return
    measureLayout(menu)
    checkRowTypographic(menu)
    const selected = checkSelectedRow(menu)
    checkNoHeaderNoDescription(menu)
    await checkScroll(menu)
    await checkMotion(menu)

    // Подсказка по наведению мышью: до наведения её нет, после — справа.
    const beforeTexts = leafTexts()
    const rows = rowsIn(menu)
    rows[rows.length - 1]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await frames()
    const appeared = [...leafTexts().entries()].filter(([value]) => !beforeTexts.has(value))
      .map(([, el]) => el).filter(el => !rows.some(row => row.contains(el)))
    checkHint(appeared[0] || null, rows[rows.length - 1], `${label} после наведения мышью`)
    if (withHint) note(`${label}: после наведения мышью подсказка появилась`, Boolean(appeared[0]),
      appeared[0] ? text(appeared[0]).slice(0, 70) : 'ни одного нового текста вне строк')

    await typeInto('/rev')
    const filtered = openMenu()
    note(`${label}: фильтр по мере набора сужает список`,
      Boolean(filtered) && rowsIn(filtered).length === 1 && /review/i.test(text(rowsIn(filtered)[0])),
      filtered ? `строк ${rowsIn(filtered).length}: ${rowsIn(filtered).map(text).join(', ')}` : 'после «/rev» списка нет')

    await typeInto('/')
    const full = openMenu()
    if (full) {
      await checkRoles(full)
      const again = openMenu() || full
      if (withHint) checkHint(leafHint(again), selectedRow(again), `${label} (кадр)`)
      await pressKey('Tab')
      note(`${label}: Tab вставляет выбранную команду в поле ввода`,
        /^\/[\w-]+ ?$/.test($('composerTextarea').value), `в поле: «${$('composerTextarea').value}»`)
      await typeInto('/')
      await checkEscapeCloses()
      await typeInto('/')
      await checkOutsideClickCloses()
    }
  }

  // Подсказка открытого состояния: новый текст вне строк, которого не было до
  // открытия списка (поэтому вечные надписи экрана в выборку не попадают).
  let baseline = new Map()

  function leafHint (menu) {
    const rows = rowsIn(menu)
    const fresh = [...leafTexts().entries()]
      .filter(([value]) => !baseline.has(value))
      .map(([, el]) => el)
      .filter(el => !rows.some(row => row.contains(el)))
    return fresh.sort((a, b) => text(b).length - text(a).length)[0] || null
  }

  async function modesFlow () {
    await openPill()
    const menu = openMenu()
    note(`${label}: пилюля открывает список режимов`, Boolean(menu),
      menu ? `строк: ${rowsIn(menu).length}` : 'после клика по пилюле видимого role="listbox" нет')
    if (!menu) return
    measureLayout(menu)
    checkRowTypographic(menu)
    const selected = checkSelectedRow(menu)
    checkNoHeaderNoDescription(menu)
    await checkMotion(menu)
    note(`${label}: подпись режима в строке композера осталась на месте`, Boolean($('permModeLabel')) &&
      text($('permModeLabel')).length > 0, `подпись: «${text($('permModeLabel'))}»`)
    await checkRoles(menu)
    const again = openMenu() || menu
    // Подсказка идёт за текущим выбором, а `checkRoles` уже сдвинул его стрелкой:
    // сверять надо со строкой, выбранной ПОСЛЕ стрелки (в сценарии команд так и есть).
    if (withHint) checkHint(leafHint(again), selectedRow(again) || selected, `${label} (подсказка режима)`)

    // Выбор режима остаётся выбором режима: подпись меняется и уходит в setWorkspace.
    const wanted = rowsIn(openMenu() || again).find(row => text(row) !== text($('permModeLabel')))
    // Мост окна может быть заморожен preload-ом: тогда шпион не ставится, и
    // признаком того, что выбор дошёл до сохранения, служит data-mode пилюли —
    // его `renderPermissionMode` ставит ровно перед вызовом setWorkspace.
    let spied = false
    try {
      const original = window.electronAPI.setWorkspace
      window.__setWorkspaceCalls = 0
      window.electronAPI.setWorkspace = (...args) => {
        window.__setWorkspaceCalls++
        return original.apply(window.electronAPI, args)
      }
      spied = window.electronAPI.setWorkspace !== original
    } catch (error) { spied = false }
    const modeBefore = $('permModeBtn')?.dataset?.mode || ''
    wanted?.click()
    await wait(500)
    note(`${label}: выбранный режим меняет подпись в строке композера`,
      Boolean(wanted) && text($('permModeLabel')) === text(wanted),
      `подпись «${text($('permModeLabel'))}», кликали «${wanted ? text(wanted) : 'нечего'}»`)
    const modeAfter = $('permModeBtn')?.dataset?.mode || ''
    if (spied) {
      note(`${label}: выбор режима по-прежнему уходит в setWorkspace`, window.__setWorkspaceCalls > 0,
        `вызовов setWorkspace: ${window.__setWorkspaceCalls}`)
    } else {
      note(`${label}: выбор режима по-прежнему уходит в setWorkspace`,
        Boolean(modeAfter) && modeAfter !== modeBefore,
        `шпион не поставился (мост заморожен), проверено по data-mode пилюли: ${modeBefore} → ${modeAfter}`)
    }
    await openPill()
    await checkOutsideClickCloses()
  }

  async function run () {
    const booted = await until(() => document.documentElement.dataset.appReady === '1' || $('composerTextarea'))
    note('окно поднялось', booted)
    if (!booted) return { ok: false, checks }
    if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
    await wait(250)
    if (english) {
      if (typeof window.__setLanguage === 'function') await window.__setLanguage('en')
      await wait(350)
      note(`${label}: переключатель языка сработал (html lang=en)`, document.documentElement.lang === 'en',
        `lang=${document.documentElement.lang}`)
    }
    // Сниматель текстов ДО открытия: подсказка — это НОВЫЙ текст, а не любая
    // длинная строка экрана.
    baseline = leafTexts()
    if (isModes) await modesFlow()
    else await commandsFlow()

    // Финал — открытое состояние, которое и должен показать кадр.
    if (isModes) await openPill()
    else await typeInto(withHint ? '/rev' : '/')
    if (withHint && !isModes) await pressKey('ArrowDown')
    const final = openMenu()
    if (final) {
      final.scrollIntoView({ block: 'center' })
      boxEl()?.scrollIntoView({ block: 'center' })
      $('composerTextarea')?.focus()
    }
    await frames(3)
    note(`${label}: прогон заканчивает с открытым списком (кадр показывает именно это)`, Boolean(final),
      final ? `${rowsIn(final).length} строк, низ ${round(rect(final).bottom)} px, верх поля ${round(rect(boxEl()).top)} px`
        : 'список закрыт — на кадре будет приветственный экран')
    return { ok: checks.every(one => one.pass), checks }
  }

  try {
    return await run()
  } catch (error) {
    note('проверка упала', false, String((error && error.stack) || error).slice(0, 500))
    return { ok: false, checks }
  }
})()
