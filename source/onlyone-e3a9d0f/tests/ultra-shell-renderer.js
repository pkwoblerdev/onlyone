// Внутриоконный зонд оболочки Ultra (план, 9.2).
//
// Режим приходит в `__ONECODE_ARG__` (base64 JSON): mode, lang, chatA, chatB.
// Каждый режим — один кадр настоящего окна: конфигурация интерфейса лежит в
// профиле прогона (её пишет `ui-config.save` прогоном), диалоги посеяны через
// `setConversations` — то есть экран собран из тех же данных, что видит человек.
//
// Проверки намеренно не ослаблены: ширины и высоты меряются на экране, а не в
// атрибутах, акцент сравнивается с тем же токеном, что у искры, а «ни одной
// русской подписи» смотрит на хром оболочки (подписи, подсказки, названия
// экранов) и НЕ трогает данные окна — названия диалогов и колонку «когда»,
// которые оболочка только переносит из `deps`.
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
  const wide = el => { const box = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null; return box ? box.width : 0 }
  const tall = el => { const box = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null; return box ? box.height : 0 }
  const near = (value, want, tol) => Math.abs(value - want) <= tol

  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })

  const arg = (() => {
    try {
      const bin = atob('__ONECODE_ARG__')
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  })()
  const mode = arg.mode || 'entry'
  const lang = arg.lang || 'ru'
  const chatA = arg.chatA || 'chat-a'
  const chatB = arg.chatB || 'chat-b'
  const titleA = 'Report build'
  const titleB = 'Test run'
  const askA = 'Build the report and show the result'
  const NEW_SESSION = lang === 'en' ? 'New session' : 'Новая сессия'
  // Правка 3 приёмки: по-русски список и полоса возврата говорят «Сессии».
  const SESSIONS_LABEL = lang === 'en' ? 'Sessions' : 'Сессии'

  // ─── общий вход: окно поднялось, знакомство закрыто своей кнопкой, язык штатный ───
  const ready = await until(() => document.documentElement.dataset.appReady === '1', 30000)
  note('окно поднялось', ready, 'appReady=' + document.documentElement.dataset.appReady)
  if ($('onboarding')) {
    $('onboarding').querySelector('.ob-skip')?.click()
    await until(() => !$('onboarding'), 6000)
  }
  note('экран знакомства закрыт и не закрывает оболочку', !$('onboarding'))
  if (window.onlyoneApp?.lang && window.onlyoneApp.lang() !== lang) {
    window.onlyoneApp.setLanguage(lang)
    await wait(600)
  }
  note('язык окна выставлен штатным переключателем', window.onlyoneApp?.lang?.() === lang, window.onlyoneApp?.lang?.())

  const shell = () => document.querySelector('#ultraHost .ultra')
  // Кадры выбора версии стартуют с обычной раскладки: оболочки там нет ВСЕГДА ДО
  // клика, и ждать её 12 секунд — значит просто тормозить прогон. Остальные
  // режимы ждут как ждали.
  const versionMode = /^version-/.test(mode)
  const mounted = versionMode ? false : await until(() => Boolean(shell()), 12000)
  const flagOn = () => document.documentElement.getAttribute('data-version-preset')
  const rootVar = name => document.documentElement.style.getPropertyValue(name)
  const sidebar = () => document.querySelector('.sidebar')
  const workPanel = () => document.querySelector('.tasks-panel')

  // Панели гасятся ДВУМЯ существующими переменными: config просит их показать,
  // оболочка обязана победить.
  function checkPanelsHidden (where) {
    const sideHidden = rootVar('--sidebar-display') === 'none' && cs(sidebar())?.display === 'none'
    const workHidden = rootVar('--work-panel-display') === 'none' &&
      (!workPanel() || cs(workPanel()).display === 'none')
    note(where + ': боковая панель и панель «Работа» погашены существующими переменными',
      sideHidden && workHidden,
      `--sidebar-display=${rootVar('--sidebar-display')}, sidebar=${cs(sidebar())?.display}, ` +
      `--work-panel-display=${rootVar('--work-panel-display')}`)
  }

  // Хром оболочки на английском: подписи, подсказки и названия экранов. Данные
  // окна (названия диалогов, «когда») сюда не входят — их оболочка переносит из
  // deps, они переводятся не здесь.
  function checkChromeLanguage (where) {
    const root = shell()
    if (!root) { note(where + ': хрома оболочки нет вовсе', false, 'нет узла .ultra'); return }
    const texts = []
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('[data-chat-id]') || el.classList.contains('urow-when')) continue
      for (const name of ['placeholder', 'aria-label', 'data-tooltip']) {
        const value = norm(el.getAttribute && el.getAttribute(name))
        if (value) texts.push(value)
      }
      if (/^(H1|DIV|SPAN|BUTTON)$/.test(el.tagName) && el.children.length === 0) {
        const value = norm(el.textContent)
        if (value) texts.push(value)
      }
    }
    const stray = [...new Set(texts.filter(hasCyr))]
    if (lang === 'en') {
      note(where + ': на английском нет ни одной русской подписи оболочки',
        stray.length === 0, stray.slice(0, 6).join(' | ') || `строк хрома: ${new Set(texts).size}`)
    } else {
      note(where + ': подписи хрома переведены на язык окна',
        texts.some(text => hasCyr(text)), `строк хрома: ${new Set(texts).size}, русских: ${stray.length}`)
    }
  }

  // ─── 9.2 остаток: выбор версии в Настройках («Вид приложения») ──────────────
  //
  // Требование 29.09 14:40: карточка «onlyone Ultra» в настройках
  // выбирается и пишет `versionPreset` через тот же `setUiConfig` (7.1), без
  // перезапуска; возврат на onlyone — так же; Pro остаётся «скоро» и не
  // выбирается. Три режима — три кадра ОДНОГО И ТОГО ЖЕ окна: «выбор сделан»
  // (настройки с выбранной Ultra), «окно Ultra» (модалка закрыта, экран —
  // оболочка) и «возврат» (та же карточка «onlyone», обычный вид).
  //
  // Зонд ничего не подделывает: карточка нажимается кликом, как её нажимает
  // человек, конфигурация читается тем же мостом, что настройки панелей, а экран
  // мерится ТЕМ ЖЕ механизмом переменных (--sidebar-display,
  // --work-panel-display) и тем же признаком на корне (data-version-preset), что
  // уже проверяют кадры `entry`/`empty`/`chat`.
  //
  // «Без перезапуска» меряется не словами: в начале кадра в `window` кладётся
  // объект-метка с сердцебиением, а на поле ввода окна — метка узла. Перезапуск
  // снёс бы и то и другое (и сам main.js объявляет навигацию провалом
  // «окно перезагружено»).
  if (mode === 'version-choose' || mode === 'version-ultra' || mode === 'version-return') {
    const chatC = arg.chatC || 'chat-c'
    // Все поля конфигурации интерфейса, КРОМЕ версии: именно они обязаны
    // пережить запись `versionPreset` неизменными.
    const FIELDS = ['sidebarWidth', 'workPanelWidth', 'codeFontSize', 'fontUiSize',
      'lineHeight', 'showSidebar', 'showWorkPanel', 'panelsOrder']
    const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const driftOf = (before, after) => FIELDS.filter(name => !sameJson(before && before[name], after && after[name]))
    const driftText = (before, after) => driftOf(before, after)
      .map(name => `${name}: ${JSON.stringify(before && before[name])} → ${JSON.stringify(after && after[name])}`).join(', ')
    const modal = () => $('settingsModal')
    const modalShown = () => Boolean(modal() && modal().style.display !== 'none')
    const card = id => document.querySelector(`#editionChoices [data-edition="${id}"]`)
    const soonOf = el => Boolean(el) && (Boolean(el.querySelector('[class*="soon"]')) || /скоро|\bsoon\b/i.test(norm(el.textContent)))
    const checkedOf = id => norm(card(id) && card(id).getAttribute('aria-checked'))
    const cardsInGroup = () => document.querySelectorAll('#editionChoices [data-edition]').length
    const hostNodes = () => ($('ultraHost') ? $('ultraHost').children.length : -1)

    // Метка «это то же окно»: переживает только отсутствие перезапуска.
    window.__onlyoneNoReload = { ticks: 0 }
    const heartbeat = setInterval(() => { window.__onlyoneNoReload.ticks++ }, 40)
    const feedNode = $('composerTextarea')
    if (feedNode) feedNode.__onlyoneProbe = 1
    const alive = () => Boolean(window.__onlyoneNoReload) && window.__onlyoneNoReload.ticks > 0 &&
      $('composerTextarea') && $('composerTextarea').__onlyoneProbe === 1

    // Снимок данных: диалоги, результаты отдельного диалога `chatC`, рабочая
    // папка и ключи. Подпись карточки обещает, что данные общие при любой
    // версии, — значит переход версиями не вправе их тронуть.
    async function snapshot () {
      const chats = await window.electronAPI?.getConversations?.() || []
      const arts = (await window.electronAPI?.getArtifacts?.(chatC) || {}).artifacts || []
      const ws = await window.electronAPI?.getWorkspace?.()
      return {
        chats: chats.length,
        withMessages: chats.filter(one => (one.messages || []).length).length,
        artifacts: arts.length,
        project: (ws && ws.path) || '',
        keys: (window.onlyoneApp && window.onlyoneApp.keysCount?.()) || 0
      }
    }

    // Отложенное сохранение истории на старте окна дописывает диалог: первый
    // снимок данных берётся после паузы, иначе «данные не тронуты» мерилось бы
    // на двух разных состояниях профиля.
    await wait(1800)
    const cfg0 = await window.electronAPI?.getUiConfig?.() || null
    const data0 = await snapshot()
    note('выбор версии: профиль стартовал с обычной раскладки', flagOn() !== 'ultra' && !shell(),
      `признак=${flagOn()}, узлов в #ultraHost: ${hostNodes()}`)
    note('выбор версии: конфигурация читается из моста 7.1', cfg0 && cfg0.versionPreset === 'default',
      cfg0 ? `versionPreset=${cfg0.versionPreset}, sidebarWidth=${cfg0.sidebarWidth}, codeFontSize=${cfg0.codeFontSize}` : 'getUiConfig ничего не отдал')

    $('openSettingsBtn')?.click()
    const opened = await until(modalShown, 8000)
    note('настройки открыты', opened, `модал=«${modal() ? modal().style.display : 'нет узла'}»`)
    document.querySelector('#settingsModal [data-settings-tab="appearance"]')?.click()
    const cardsReady = await until(() => Boolean(card('default') && card('pro') && card('ultra')), 6000)
    note('вкладка «Вид приложения» показывает группу «Версия» тремя карточками', cardsReady,
      `карточек: ${cardsInGroup()}`)

    note('карточка Ultra выбираемая: без aria-disabled и без пометки «скоро»',
      Boolean(card('ultra')) && !card('ultra').hasAttribute('aria-disabled') && !soonOf(card('ultra')),
      card('ultra') ? `aria-disabled=«${card('ultra').getAttribute('aria-disabled')}», пометка «скоро»: ${soonOf(card('ultra'))}` : 'карточки Ultra нет')
    note('Pro остаётся «скоро» и остаётся недоступным',
      Boolean(card('pro')) && card('pro').getAttribute('aria-disabled') === 'true' && soonOf(card('pro')),
      card('pro') ? `aria-disabled=«${card('pro').getAttribute('aria-disabled')}», пометка «скоро»: ${soonOf(card('pro'))}` : 'карточки Pro нет')
    note('до всякого клика выбранной показана версия из конфигурации',
      checkedOf('default') === 'true' && checkedOf('ultra') === 'false',
      `default=${checkedOf('default')}, pro=${checkedOf('pro')}, ultra=${checkedOf('ultra')}`)

    card('pro')?.click()
    await wait(500)
    const cfgPro = await window.electronAPI?.getUiConfig?.() || null
    note('клик по Pro не выбирается: ни записи, ни экрана',
      cfgPro && cfgPro.versionPreset === 'default' && !shell() && flagOn() !== 'ultra' && checkedOf('pro') === 'false',
      `versionPreset=${cfgPro && cfgPro.versionPreset}, признак=${flagOn()}, aria-checked Pro=${checkedOf('pro')}`)

    card('ultra')?.click()
    const flipped = await until(() => flagOn() === 'ultra', 12000)
    note('выбор Ultra в настройках включает экран БЕЗ перезапуска', flipped && alive(),
      `признак=${flagOn()}, метка окна жива: ${alive()}, тиков: ${window.__onlyoneNoReload.ticks}`)
    const cfg1 = await window.electronAPI?.getUiConfig?.() || null
    note('выбор записан как versionPreset=ultra в конфигурацию интерфейса (7.1)',
      cfg1 && cfg1.versionPreset === 'ultra', `getUiConfig вернул versionPreset=${cfg1 && cfg1.versionPreset}`)
    note('чужие поля конфигурации не обнулены: ширины, шрифты и порядок панелей целы',
      flipped && Boolean(cfg0) && Boolean(cfg1) && driftOf(cfg0, cfg1).length === 0,
      cfg1 ? (driftText(cfg0, cfg1) || `sidebarWidth=${cfg1.sidebarWidth}, workPanelWidth=${cfg1.workPanelWidth}, codeFontSize=${cfg1.codeFontSize}, fontUiSize=${cfg1.fontUiSize}, lineHeight=${cfg1.lineHeight}, showSidebar=${cfg1.showSidebar}, showWorkPanel=${cfg1.showWorkPanel}, panelsOrder=${JSON.stringify(cfg1.panelsOrder)}`) : 'мост ничего не вернул')
    note('оболочка Ultra на экране: узел стоит в своём хосте один',
      Boolean(shell()) && document.querySelectorAll('#ultraHost .ultra').length === 1,
      `узлов оболочки: ${document.querySelectorAll('#ultraHost .ultra').length}, в хосте: ${hostNodes()}`)
    checkPanelsHidden('настройки: Ultra')
    note('карточка Ultra показана выбранной после записи', checkedOf('ultra') === 'true',
      `aria-checked: default=${checkedOf('default')}, ultra=${checkedOf('ultra')}`)
    const data1 = await snapshot()
    note('смена версии не тронула данные: диалоги, результаты, проект и ключи те же',
      flipped && sameJson(data0, data1), `${JSON.stringify(data0)} → ${JSON.stringify(data1)}`)

    if (mode === 'version-choose') {
      // Кадр «выбор сделан»: настройки с выбранной Ultra, модалка не закрыта.
      // Отрицательная опора харнесса: если карточка НЕ записала версию, тот же
      // `versionPreset` пишется в мост руками — и по тому, включился ли экран,
      // видно, что краснеет именно запись с карточки, а не оболочка и не метки
      // окна. Когда карточка работает, опора не нужна и не срабатывает.
      if (!shell()) {
        await window.electronAPI?.setUiConfig?.(Object.assign({}, cfg1 || cfg0 || {}, { versionPreset: 'ultra' }))
        const helped = await until(() => flagOn() === 'ultra' && Boolean(shell()), 12000)
        note('опора харнесса: versionPreset=ultra, записанный в мост в обход карточки, включает экран',
          helped, `признак=${flagOn()}, узлов оболочки: ${document.querySelectorAll('#ultraHost .ultra').length} — значит краснеет запись с карточки, а не оболочка`)
      }
      await wait(1600)
      note('кадр «выбор сделан»: настройки поверх Ultra держатся до снимка',
        modalShown() && flagOn() === 'ultra' && checkedOf('ultra') === 'true' && alive(),
        `признак=${flagOn()}, aria-checked Ultra=${checkedOf('ultra')}`)
      clearInterval(heartbeat)
      return { ok: checks.every(one => one.pass), checks }
    }

    if (mode === 'version-ultra') {
      document.querySelector('#settingsModal .btn-close-modal')?.click()
      const closed = await until(() => !modalShown(), 6000)
      note('кадр «окно Ultra»: настройки закрыты, на экране — оболочка',
        closed && flagOn() === 'ultra' && cs(shell())?.pointerEvents === 'auto' &&
        cs(document.querySelector('.main-content'))?.visibility === 'hidden',
        `модал=«${modal() ? modal().style.display : 'нет узла'}», оболочка=${cs(shell())?.pointerEvents}, main-content=${cs(document.querySelector('.main-content'))?.visibility}`)
      checkPanelsHidden('кадр «окно Ultra»')
      await hold('кадр «окно Ultra»', 'is-entry')
      clearInterval(heartbeat)
      return { ok: checks.every(one => one.pass), checks }
    }

    // Кадр «возврат»: путь назад — та же группа карточек, а не перезапуск.
    const setBtn = shell() ? shell().querySelector('.ub-set') : null
    note('в Ultra есть кнопка настроек: до карточек версии человек доходит из экрана',
      Boolean(setBtn), setBtn ? norm(setBtn.getAttribute('aria-label') || setBtn.textContent) : 'кнопки .ub-set в оболочке нет')
    if (setBtn) setBtn.click()
    else $('openSettingsBtn')?.click()
    const reopened = await until(modalShown, 8000)
    note('настройки открылись поверх Ultra', reopened, `модал=«${modal() ? modal().style.display : 'нет узла'}»`)

    card('default')?.click()
    const back = await until(() => flagOn() !== 'ultra', 12000)
    // Возврат засчитывается только ТОГДА, когда Ultra действительно включился
    // первым кликом: иначе «признака нет, оболочки нет» стало бы зелёным на
    // пустом месте — ровно том, где карточка ничего и не писала.
    const reallyBack = flipped && back && !shell() && hostNodes() === 0 && alive()
    note('возврат на onlyone — тем же кликом по карточке: Ultra снята', reallyBack,
      `включился до возврата: ${flipped}, признак=${flagOn()}, узлов в хосте: ${hostNodes()}, метка окна жива: ${alive()}`)
    const restored = reallyBack && rootVar('--sidebar-display') === 'flex' && cs(sidebar())?.display !== 'none' &&
      wide(sidebar()) >= 100 && rootVar('--work-panel-display') === 'flex' &&
      (!workPanel() || cs(workPanel()).display !== 'none')
    note('панели вернулись ТЕМ ЖЕ механизмом переменных', restored,
      `--sidebar-display=${rootVar('--sidebar-display')}, sidebar=${cs(sidebar())?.display}, ` +
      `ширина=${Math.round(wide(sidebar()))}, --work-panel-display=${rootVar('--work-panel-display')}`)
    const cfg2 = await window.electronAPI?.getUiConfig?.() || null
    note('возврат записан как versionPreset=default, чужие поля по-прежнему целы',
      reallyBack && Boolean(cfg2) && cfg2.versionPreset === 'default' && driftOf(cfg0, cfg2).length === 0,
      cfg2 ? (driftText(cfg0, cfg2) || `versionPreset=${cfg2.versionPreset}, sidebarWidth=${cfg2.sidebarWidth}`) : 'мост ничего не вернул')
    note('карточки отразили возврат',
      reallyBack && checkedOf('default') === 'true' && checkedOf('ultra') === 'false',
      `включился до возврата: ${flipped}, default=${checkedOf('default')}, ultra=${checkedOf('ultra')}`)
    const data2 = await snapshot()
    note('за два перехода данные не потерялись', reallyBack && sameJson(data0, data2),
      `${JSON.stringify(data0)} → ${JSON.stringify(data2)}`)
    await wait(1600)
    note('кадр «возврат»: обычный вид с открытыми настройками держится до снимка',
      reallyBack && modalShown() && flagOn() !== 'ultra' && alive(),
      `признак=${flagOn()}, узлов в хосте: ${hostNodes()}`)
    clearInterval(heartbeat)
    return { ok: checks.every(one => one.pass), checks }
  }

  // Кадр главный процесс снимает уже после отчёта, и окно за эти секунды
  // успевает сбросить отложенное сохранение истории с эхом в renderer. Если
  // экран к моменту съёмки спрыгнул — это дефект, и поймать его обязана
  // проверка, а не глаза на снимке.
  async function hold (where, expectClass) {
    await wait(1800)
    const still = Boolean(shell()?.classList.contains(expectClass))
    note(where + ': экран держится до снимка', still && flagOn() === 'ultra',
      `режим=${shell()?.className || 'нет узла'}, признак=${flagOn()}`)
  }

  // Живой фон. Пустой холст даёт кадр «как будто всё на месте», но ровно так же
  // ведёт себя и НАРИСОВАННЫЙ холст, который ушёл за непрозрачный фон предков:
  // слой с отрицательным z-index рисуется ПОД background'ом body и #app. Поэтому
  // проверки три: холст нарисован, под ним до корня ничего крашеного не
  // осталось, и горизонт в нижней половине холста отличается от верха по цвету.
  function opaqueAncestors (node) {
    const out = []
    let current = node && node.parentElement
    while (current && current !== document.documentElement) {
      const style = cs(current)
      const paint = style ? style.backgroundColor : ''
      const parts = /rgba?\(([^)]+)\)/.exec(paint || '')
      const alpha = parts ? Number(parts[1].split(/[,/\s]+/).filter(Boolean)[3] ?? 1) : (paint && paint !== 'transparent' ? 1 : 0)
      if (alpha > 0) out.push(`${(current.id ? '#' + current.id : current.tagName.toLowerCase())} → ${paint}`)
      current = current.parentElement
    }
    return out
  }

  function checkAuraPainted (where) {
    const layer = shell()?.querySelector('.ubg')
    const sky = layer && layer.querySelector('canvas.ubg-sky')
    if (!sky) { note(where + ': живой фон — холст на месте', false, 'canvas.ubg-sky не найден'); return }
    let top = null
    let horizon = null
    let colors = 0
    try {
      const ctx = sky.getContext('2d')
      const sample = y => {
        const data = ctx.getImageData(Math.round(sky.width / 2), Math.round(y), 1, 1).data
        return [data[0], data[1], data[2], data[3]].join(',')
      }
      const alpha = ctx.getImageData(Math.round(sky.width / 2), Math.round(sky.height * 0.3), 1, 1).data[3]
      top = sample(sky.height * 0.22)
      horizon = sample(sky.height * 0.78)
      colors = new Set([sample(sky.height * 0.2), sample(sky.height * 0.45), sample(sky.height * 0.7),
        sample(sky.height * 0.85), sample(sky.height * 0.95)]).size
      note(where + ': живой фон нарисован на холсте',
        sky.width > 0 && sky.height > 0 && alpha > 0,
        `холст ${sky.width}×${sky.height}, альфа в центре ${alpha}`)
    } catch (error) {
      note(where + ': живой фон нарисован на холсте', false, ' getImageData не отдал пиксели: ' + error)
    }
    const covered = opaqueAncestors(layer)
    note(where + ': живой фон не перекрыто фоном окна', covered.length === 0,
      covered.join(', ') || 'между холстом и корнем непрозрачных предков нет')
    note(where + ': горизонт светится в нижней части холста',
      Boolean(horizon) && horizon !== top && colors >= 3,
      `верх ${top}, горизонт ${horizon}, разных цветов в столбце: ${colors}`)
    note(where + ': слой фона уходит за содержимое окна', cs(layer).zIndex === '-1', `z-index ${cs(layer).zIndex}`)
  }

  const sparkOf = size => {
    const mark = shell()?.querySelector('svg.uspark')
    if (!mark) return null
    if (mark.getAttribute('width') !== String(size)) return null
    return mark
  }

  // ─── посев: два диалога через штатную запись истории окна ──────────────────
  if (mode === 'seed') {
    note('посев: оболочка смонтирована в настоящем окне', mounted && flagOn() === 'ultra', `признак=${flagOn()}`)
    // Стартовый пустой диалог ставит отложенное сохранение истории: без паузы
    // оно вышло бы поверх посева, и следующий запуск нашёл бы пустой список.
    await wait(1800)
    const now = Date.now()
    const chats = [
      {
        id: chatA, title: titleA, createdAt: now - 7200000, updatedAt: now - 3600000,
        messages: [
          { role: 'user', content: askA, timestamp: now - 3700000 },
          { role: 'assistant', content: 'Report is built, three sections are in it.', timestamp: now - 3600000 }
        ]
      },
      {
        id: chatB, title: titleB, createdAt: now - 1800000, updatedAt: now - 1200000,
        messages: [
          { role: 'user', content: 'Run the tests and fix what falls', timestamp: now - 1300000 },
          { role: 'assistant', content: 'Two suites pass, one assertion was fixed.', timestamp: now - 1200000 }
        ]
      }
    ]
    const saved = await window.electronAPI?.setConversations?.(chats)
    note('посев: диалоги записаны в историю окна', saved?.ok === true, JSON.stringify(saved || {}).slice(0, 80))
    const reloaded = await window.__reloadChats?.()
    note('посев: история перечитана оболочкой', typeof reloaded === 'number' && reloaded >= 2, `диалогов: ${reloaded}`)
    const rows = [...document.querySelectorAll('#ultraHost [data-chat-id]')]
    note('посев: список Sessions принял посеянные диалоги',
      rows.some(row => row.getAttribute('data-chat-id') === chatA) &&
      rows.some(row => row.getAttribute('data-chat-id') === chatB),
      rows.map(row => row.getAttribute('data-chat-id')).join(', ').slice(0, 90))
    // Окно при выходе пишет свой список, а не тот, что на диске: штатный путь,
    // который делает это сохранение, — `__joinProject`.
    window.__joinProject?.(null)
    await wait(1200)
    await hold('посев', 'is-entry')
    return { ok: checks.every(one => one.pass), checks }
  }

  // ─── контроль: versionPreset НЕ ultra — оболочки на экране нет ──────────────
  if (mode === 'control') {
    await wait(400)
    note('контроль default: оболочки Ultra на экране нет',
      !shell() && $('ultraHost') && $('ultraHost').children.length === 0,
      `узлов в хосте: ${$('ultraHost') ? $('ultraHost').children.length : 'хоста нет'}`)
    note('контроль default: признака пресета на <html> нет', flagOn() !== 'ultra', `признак=${flagOn()}`)
    note('контроль default: боковая панель видна — её не тронула оболочка',
      cs(sidebar())?.display !== 'none' && wide(sidebar()) >= 100 && rootVar('--sidebar-display') === 'flex',
      `display=${cs(sidebar())?.display}, ширина=${Math.round(wide(sidebar()))}, переменная=${rootVar('--sidebar-display')}`)
    note('контроль default: панель «Работа» тоже не погашена оболочкой',
      rootVar('--work-panel-display') === 'flex' && (!workPanel() || cs(workPanel()).display !== 'none'),
      `переменная=${rootVar('--work-panel-display')}`)
    note('контроль default: обычное окно работает',
      wide($('composerTextarea')) > 0 && cs(document.querySelector('.main-content')).visibility !== 'hidden',
      `поле ввода ${Math.round(wide($('composerTextarea')))}px`)
    // И через две секунды, к моменту съёмки кадра, обычный вид обязан остаться
    // обычным: иначе «оболочки нет» означало бы «ещё не успела появиться».
    //
    // И в обычном окне полоса ленты обязана остаться: правило U-1 живёт строго
    // под `data-version-preset="ultra"` и не имеет права перетечь на Default.
    const now = Date.now()
    const prose = Array.from({ length: 40 }, (_, index) =>
      `Абзац ${index + 1}: в отчёте три раздела, и каждый описывает свой кусок работы достаточно подробно, ` +
      `чтобы строк хватило переполнить любое окно прогона.`).join('\n\n')
    await window.electronAPI?.setConversations?.([{
      id: chatA, title: titleA, createdAt: now - 7200000, updatedAt: now - 3600000,
      messages: [
        { role: 'user', content: askA, timestamp: now - 3700000 },
        { role: 'assistant', content: prose, timestamp: now - 3600000 }
      ]
    }])
    await window.__reloadChats?.()
    await wait(400)
    document.querySelector(`#chatHistoryList [data-chat-id="${chatA}"]`)?.click()
    const feed = document.querySelector('#chatFeed')
    const overflowed = await until(() => feed && feed.scrollHeight - feed.clientHeight > 40, 8000)
    const bar = feed ? feed.offsetWidth - feed.clientWidth : -1
    note('контроль default: полоса прокрутки ленты на месте',
      overflowed && bar > 0, `прокручивается: ${overflowed}, полоса ${bar}px`)
    await wait(1800)
    note('контроль default: обычный вид держится до снимка',
      !shell() && flagOn() !== 'ultra' && cs(sidebar())?.display !== 'none',
      `узлов оболочки: ${$('ultraHost') ? $('ultraHost').children.length : 0}, признак=${flagOn()}`)
    return { ok: checks.every(one => one.pass), checks }
  }

  // Всё остальное — экраны Ultra.
  note('оболочка смонтирована настоящим пресетом', mounted && flagOn() === 'ultra', `признак=${flagOn()}`)

  // ─── вход ───────────────────────────────────────────────────────────────────
  if (mode === 'entry') {
    const entry = shell() && shell().querySelector('.uentry')
    const body = document.querySelector('.app-body')
    note('экран входа: оболочка занимает тело окна',
      Boolean(entry) && shell().classList.contains('is-entry') &&
      near(wide(shell()), wide(body), 2) && near(tall(shell()), tall(body), 2),
      `${Math.round(wide(shell()))}×${Math.round(tall(shell()))} в ${Math.round(wide(body))}×${Math.round(tall(body))}`)
    checkAuraPainted('экран входа')
    const spark = sparkOf(56)
    note('экран входа: искра 56 px', Boolean(spark) && tall(spark) >= 50,
      spark ? `атрибут 56, на экране ${Math.round(wide(spark))}×${Math.round(tall(spark))}` : 'искры нужного размера нет')
    const hello = norm(shell()?.querySelector('.uhello')?.textContent)
    note('экран входа: приветствие окна переведено',
      Boolean(hello) && (lang === 'en' ? !hasCyr(hello) : hasCyr(hello)), hello.slice(0, 60))
    const composer = shell()?.querySelector('.ucmp')
    note('экран входа: строка ввода 680 px с полем',
      Boolean(composer) && near(wide(composer), 680, 3) && Boolean(composer.querySelector('textarea.uint')),
      composer ? `${Math.round(wide(composer))}px` : 'строки ввода нет')
    const list = shell()?.querySelector('.usess')
    // Правка 2 приёмки: список стоит в колонке строки ввода — та же ширина и тот
    // же левый край, время — у правого края этой колонки.
    const listBox = list && list.getBoundingClientRect ? list.getBoundingClientRect() : null
    const composerBox = composer && composer.getBoundingClientRect ? composer.getBoundingClientRect() : null
    note('экран входа: список Sessions — в колонке строки ввода, время по её правому краю',
      Boolean(list) && Boolean(composerBox) && near(wide(list), wide(composer), 3) &&
      Math.abs(listBox.left - composerBox.left) <= 2 &&
      norm(list.querySelector('.usess-label')?.textContent) === SESSIONS_LABEL &&
      [...list.querySelectorAll('.urow')].filter(row => row.hasAttribute('data-chat-id')).every(row => {
        const when = row.querySelector('.urow-when')
        const box = when && when.getBoundingClientRect ? when.getBoundingClientRect() : null
        return box && Math.abs(box.right - composerBox.right) <= 3
      }),
      list && composerBox ? `список ${Math.round(wide(list))}px слева ${Math.round(listBox.left)}, ввод ${Math.round(wide(composer))}px слева ${Math.round(composerBox.left)}, подпись «${norm(list.querySelector('.usess-label')?.textContent)}»` : 'списка нет')
    const rows = list ? [...list.querySelectorAll('.urow')] : []
    const first = rows[0]
    const accent = norm(shell()?.querySelector('.uspark') && cs(shell().querySelector('.uspark')).color)
    note('экран входа: первой стоит акцентная «Новая сессия»',
      Boolean(first) && first.classList.contains('urow-new') && norm(first.textContent) === NEW_SESSION &&
      accent !== '' && cs(first).color === accent,
      `первая строка «${norm(first?.textContent)}», цвет ${cs(first)?.color}, акцент ${accent}`)
    const dialogs = rows.filter(row => row.hasAttribute('data-chat-id'))
    note('экран входа: диалоги окна в списке, каждый со временем',
      dialogs.length >= 2 &&
      dialogs.some(row => row.getAttribute('data-chat-id') === chatA) &&
      dialogs.some(row => row.getAttribute('data-chat-id') === chatB) &&
      dialogs.every(row => norm(row.querySelector('.urow-when')?.textContent).length > 0) &&
      dialogs.some(row => norm(row.textContent).includes(titleA)),
      `строк: ${dialogs.length}, «когда»: ${dialogs.map(row => norm(row.querySelector('.urow-when')?.textContent)).join(', ').slice(0, 60)}`)
    checkPanelsHidden('экран входа')
    note('экран входа: содержимое окна убрано, оболочка ловит клики',
      cs(document.querySelector('.main-content'))?.visibility === 'hidden' &&
      cs(shell())?.pointerEvents === 'auto',
      `main-content=${cs(document.querySelector('.main-content'))?.visibility}, оболочка=${cs(shell())?.pointerEvents}`)
    checkChromeLanguage('экран входа')
    // Поломка 30.09: на входе нельзя было добавить папку и выбрать модель.
    // Кнопки обязаны открывать настоящие меню окна, а не только стоять на месте.
    const folderBtn = shell()?.querySelector('.uopt-folder')
    const modelBtn = shell()?.querySelector('.uopt-model')
    note('экран входа: под строкой ввода есть кнопки «папка» и «модель»', Boolean(folderBtn && modelBtn),
      `папка=${Boolean(folderBtn)}, модель=${Boolean(modelBtn)}`)
    const labels = [folderBtn, modelBtn].map(node => String(node?.querySelector('.uopt-text')?.textContent || ''))
    await wait(1700)
    const later = [folderBtn, modelBtn].map(node => String(node?.querySelector('.uopt-text')?.textContent || ''))
    note('экран входа: подписи папки и модели не копятся от обновления к обновлению',
      later[0].length > 0 && later[1].length > 0 && !/^(.+?)+$/.test(later[0]) && !/^(.+?)+$/.test(later[1]) &&
        later[1] === String(document.getElementById('pillModelName')?.textContent || '').trim(),
      `было=${JSON.stringify(labels)}, стало=${JSON.stringify(later)}, в окне: ${JSON.stringify(String(document.getElementById('pillModelName')?.textContent || ''))}`)
    folderBtn?.click()
    await wait(400)
    const menu = document.querySelector('.ctx-menu')
    const menuShown = Boolean(menu && menu.querySelectorAll('.ctx-item').length > 0)
    note('экран входа: «папка» открывает меню папок с пунктами', menuShown,
      `меню=${Boolean(menu)}, пунктов=${menu ? menu.querySelectorAll('.ctx-item').length : 0}`)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.body.click()
    await wait(200)
    modelBtn?.click()
    await wait(500)
    const picker = document.getElementById('modelPopover')
    const pickerShown = Boolean(picker && !picker.hidden && picker.getBoundingClientRect().height > 0)
    note('экран входа: «модель» открывает блок со списком моделей у кнопки, окна-каталога нет', pickerShown && picker.querySelectorAll('.mp-row').length > 6,
      `блок: hidden=${picker ? picker.hidden : 'нет узла'}, строк=${picker ? picker.querySelectorAll('.mp-row').length : 0}`)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    // «Добавить папку» обязано дойти до конца: из кнопки Ultra и из меню «+».
    // Раньше пункт «+» звал функцию из чужой области видимости и не делал ничего.
    const folderOf = state => [state && state.path, ...((state && state.extraPaths) || [])].filter(Boolean)
    const pickList = (arg && arg.pick) || []
    if (pickList.length === 2) {
      const before = folderOf(await window.electronAPI.getWorkspace()).length
      folderBtn?.click()
      await wait(400)
      const addItem = [...document.querySelectorAll('.ctx-menu .ctx-item')].find(node => /Добавить папку|Add folder/i.test(node.textContent || ''))
      addItem?.click()
      await wait(900)
      const afterUltra = folderOf(await window.electronAPI.getWorkspace())
      note('экран входа: «папка» → «Добавить папку» подключает выбранную папку',
        afterUltra.length === before + 1 && afterUltra.includes(pickList[0]),
        `было=${before}, стало=${afterUltra.length}, ждали ${pickList[0]}, есть=${JSON.stringify(afterUltra)}`)
      document.getElementById('attachBtn')?.click()
      await wait(400)
      const plusItem = [...document.querySelectorAll('.ctx-menu .ctx-item')].find(node => /Добавить папку|Add folder/i.test(node.textContent || ''))
      note('меню «+»: пункт «Добавить папку» есть', Boolean(plusItem), 'пункт не найден в меню «+»')
      plusItem?.click()
      await wait(900)
      const afterPlus = folderOf(await window.electronAPI.getWorkspace())
      note('меню «+»: «Добавить папку» подключает выбранную папку (раньше не делало ничего)',
        afterPlus.length === afterUltra.length + 1 && afterPlus.includes(pickList[1]),
        `было=${afterUltra.length}, стало=${afterPlus.length}, ждали ${pickList[1]}, есть=${JSON.stringify(afterPlus)}`)
    }
    await hold('экран входа', 'is-entry')
    return { ok: checks.every(one => one.pass), checks }
  }

  // ─── пустая новая сессия: клик по «Новая сессия» ────────────────────────────
  if (mode === 'empty') {
    // Пустая сессия проверяется не «с листа», из входа: сначала окно реально
    // открывает диалог с сообщениями, потом возвращается к Sessions и только
    // затем жмёт «Новая сессия». Иначе проверка была бы невнятной: незанятый
    // пустой диалог окно переиспользует, и счётчик строк стоял бы на месте,
    // даже если бы клик вообще никуда не вёл.
    const openedRow = await until(() => shell()?.querySelector(`[data-chat-id="${chatA}"]`), 8000)
      ? shell().querySelector(`[data-chat-id="${chatA}"]`) : null
    openedRow?.click()
    const chatFirst = await until(() => shell()?.classList.contains('is-chat'), 8000)
    const filled = ($('messagesList')?.querySelectorAll('.msg-item') || []).length
    note('пустая сессия: окно сначала открыло диалог с сообщениями', chatFirst && filled >= 2, `сообщений в ленте: ${filled}`)
    shell()?.querySelector('.ubk')?.click()
    const back = await until(() => shell()?.classList.contains('is-entry'), 8000)
    const rowsBack = (shell()?.querySelectorAll('[data-chat-id]') || []).length
    note('пустая сессия: возврат к Sessions одной кнопкой полосы', back && rowsBack >= 2, `строк списка после возврата: ${rowsBack}`)
    const fresh = shell()?.querySelector('.urow-new')
    note('пустая сессия: кнопка «Новая сессия» найдена на входе', Boolean(fresh), fresh ? norm(fresh.textContent) : 'строки нет')
    fresh?.click()
    const shown = await until(() => shell()?.classList.contains('is-empty'), 8000)
    const feedNow = ($('messagesList')?.querySelectorAll('.msg-item') || []).length
    // Шапка у пустого чата видна (макет 19.10), но без названия: признак пустого диалога — .is-empty
    const headerHidden = $('chatHeader')?.hidden === true || $('chatHeader')?.classList.contains('is-empty') === true
    // Открытый диалог был с двумя сообщениями, теперь лента пуста, а шапка
    // чата скрыта самим окном (оно прячет её у диалога без сообщений):
    // окно реально перешло на новую беседу, а не дорисовало экран поверх прежней.
    note('пустая сессия: окно перешло на новый диалог без сообщений',
      feedNow === 0 && filled >= 2 && headerHidden,
      `лента: ${filled} → ${feedNow}, шапка чата скрыта: ${headerHidden}`)
    note('пустая сессия: экран показан', shown && Boolean(shell()?.querySelector('.uempty')), `режим=${shell()?.className}`)
    checkAuraPainted('пустая сессия')
    const spark = sparkOf(44)
    note('пустая сессия: искра 44 px', Boolean(spark) && tall(spark) >= 38,
      spark ? `атрибут 44, на экране ${Math.round(tall(spark))}` : 'искры нужного размера нет')
    const hello = norm(shell()?.querySelector('.uempty .uhello')?.textContent)
    note('пустая сессия: приветствие видно', Boolean(hello) && (lang === 'en' ? !hasCyr(hello) : hasCyr(hello)), hello.slice(0, 60))
    const composer = shell()?.querySelector('.ucmp')
    note('пустая сессия: строка ввода 680 px', Boolean(composer) && near(wide(composer), 680, 3),
      composer ? `${Math.round(wide(composer))}px` : 'строки ввода нет')
    const bar = shell()?.querySelector('.ubar')
    note('пустая сессия: полоса 48 px с возвратом и названием',
      Boolean(bar) && near(tall(bar), 48, 2) && norm(bar.querySelector('.ubk')?.textContent) === SESSIONS_LABEL &&
      norm(bar.querySelector('.ut')?.textContent) === NEW_SESSION,
      bar ? `${Math.round(tall(bar))}px, «${norm(bar.querySelector('.ubk')?.textContent)}» / «${norm(bar.querySelector('.ut')?.textContent)}»` : 'полосы нет')
    note('пустая сессия: списка Sessions на этом экране нет', !shell()?.querySelector('.usess'),
      shell()?.querySelector('.usess') ? 'список остался' : '')
    checkPanelsHidden('пустая сессия')
    checkChromeLanguage('пустая сессия')
    await hold('пустая сессия', 'is-empty')
    return { ok: checks.every(one => one.pass), checks }
  }

  // ─── один открытый чат: клик по строке диалога ─────────────────────────────
  if (mode === 'chat') {
    const row = await until(() => shell()?.querySelector(`[data-chat-id="${chatA}"]`), 8000)
      ? shell().querySelector(`[data-chat-id="${chatA}"]`) : null
    note('один чат: строка диалога найдена на входе', Boolean(row), row ? norm(row.textContent) : 'строки нет')
    row?.click()
    const opened = await until(() => shell()?.classList.contains('is-chat'), 8000)
    note('один чат: экран чата показан', opened && Boolean(shell()?.querySelector('.ubar')), `режим=${shell()?.className}`)
    const feed = $('messagesList')
    const items = feed ? feed.querySelectorAll('.msg-item') : []
    note('один чат: лента открыла именно этот диалог',
      items.length >= 2 && norm(feed.textContent).includes(askA),
      `сообщений: ${items.length}`)
    note('один чат, слева пусто: ни рейки, ни второго списка',
      !shell()?.querySelector('.usess') && !shell()?.querySelector('[data-chat-id]') &&
      cs(sidebar())?.display === 'none',
      `узлов списка в оболочке: ${(shell()?.querySelectorAll('.usess, [data-chat-id]') || []).length}, sidebar=${cs(sidebar())?.display}`)
    const header = $('chatHeaderTitle')
    const repeats = [shell()?.textContent || '', norm(header?.textContent)]
      .filter(text => text.includes(titleA)).length
    note('один чат: название диалога осталось за шапкой и не повторилось',
      norm(header?.textContent) === titleA && !shell()?.querySelector('.ubar .ut') && repeats === 1,
      `шапка «${norm(header?.textContent)}», повторов: ${repeats}`)
    const bar = shell()?.querySelector('.ubar')
    const body = document.querySelector('.app-body')
    note('один чат: полоса 48 px и шапка стоят в ней',
      Boolean(bar) && near(tall(bar), 48, 2) && near(tall(header?.parentElement || header), 48, 2) &&
      Math.round(bar.getBoundingClientRect().top) === Math.round(body.getBoundingClientRect().top),
      `полоса ${Math.round(tall(bar))}px, шапка ${Math.round(tall(header?.parentElement || header))}px, сверху ${Math.round(bar?.getBoundingClientRect().top)} против ${Math.round(body?.getBoundingClientRect().top)}`)
    note('один чат: лента не шире 720 px',
      cs(document.querySelector('.feed-container'))?.maxWidth === '720px',
      `max-width: ${cs(document.querySelector('.feed-container'))?.maxWidth}`)
    note('один чат: оболочка не перекрывает содержимое окна',
      cs(shell())?.pointerEvents === 'none' && cs(document.querySelector('.main-content'))?.visibility !== 'hidden' &&
      wide($('composerTextarea')) > 0,
      `оболочка=${cs(shell())?.pointerEvents}, поле ввода ${Math.round(wide($('composerTextarea')))}px`)
    checkPanelsHidden('один чат')

    // Правка 4 приёмки: в одном чате Ultra нет кнопок разделения и панели
    // «Работа», а «Задачи» — только при не-нуле.
    const split = $('splitViewBtn')
    const workBtn = document.querySelector('#chatHeader .tasks-header-btn')
    note('один чат: кнопок разделения окна и панели «Работа» на экране нет',
      cs(split)?.display === 'none' && (!workBtn || cs(workBtn).display === 'none'),
      `разделение display=${cs(split)?.display}, кнопка панели ${workBtn ? cs(workBtn).display : 'нет узла'}`)
    const tasks = $('navTasks')
    const badge = $('taskCenterBadge')
    const tasksVisible = () => cs(tasks)?.display !== 'none'
    const zeroHidden = !badge || norm(badge.textContent) !== '0' || !tasksVisible()
    note('один чат: «Задачи» скрыты, пока задач нет', zeroHidden,
      `счётчик «${norm(badge?.textContent)}», display=${cs(tasks)?.display}`)
    // Состояние поднимается тем же путём, что в окне: `setBadge` центра задач
    // пишет текст этом же узлу, а наблюдатель оболочки на него реагирует.
    if (badge) {
      // Счётчик пишется так же, как его пишет центр задач окна, — одним
      // `textContent`. Центр тут же переставляет своё значение обратно, так что
      // ловить не гонку, а все переходы признака: наблюдатель за атрибутом
      // записывает каждый вид, который корень принял за время пробы.
      const seen = []
      const watcher = new MutationObserver(records => {
        for (const record of records) {
          if (record.attributeName !== 'data-ultra-tasks') continue
          // Вид кнопки снимается в тот же момент: центр задач вправе вернуть
          // ноль, и проверка не должна ловить состояние «позже».
          seen.push(`${document.documentElement.getAttribute('data-ultra-tasks') || '-'}=${cs(tasks)?.display}`)
        }
      })
      watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ultra-tasks'] })
      badge.textContent = '3'
      await wait(500)
      const shownAgain = seen.some(entry => entry.startsWith('some') && !/none/.test(entry))
      badge.textContent = '0'
      const hiddenAgain = await until(() => !tasksVisible() &&
        document.documentElement.getAttribute('data-ultra-tasks') === 'zero', 4000)
      watcher.disconnect()
      note('один чат: «Задачи» возвращаются с первой задачей и снова гаснут при нуле',
        shownAgain && hiddenAgain,
        `переходы признака: ${seen.join(' → ') || 'ни одного'}, после «0» скрыта: ${hiddenAgain}`)
    } else {
      note('один чат: «Задачи» возвращаются с первой задачей', false, 'счётчика задач в шапке нет')
    }

    checkChromeLanguage('один чат')
    // Снимок главный процесс делает уже после отчёта: экран обязан дожить до
    // него — на входе, в пустой сессии и в открытом чате кадр выглядит по-разному.
    await hold('один чат', 'is-chat')
    const stillItems = ($('messagesList')?.querySelectorAll('.msg-item') || []).length
    note('один чат: лента не опустела до снимка', stillItems >= 2 && flagOn() === 'ultra',
      `сообщений в ленте: ${stillItems}, признак=${flagOn()}`)
    return { ok: checks.every(one => one.pass), checks }
  }

  // ─── отправка из строки Ultra идёт тем же путём, что отправка окна ──────────
  if (mode === 'send') {
    const text = 'Проверка отправки из Ultra'
    shell()?.querySelector('.urow-new')?.click()
    const empty = await until(() => shell()?.classList.contains('is-empty'), 8000)
    note('отправка: пустая сессия открыта', empty, `режим=${shell()?.className}`)
    const field = shell()?.querySelector('.uint')
    const form = shell()?.querySelector('.ucmp')
    if (field && form) {
      field.value = text
      form.requestSubmit()
    }
    const accepted = await until(() => {
      const users = $('messagesList')?.querySelectorAll('.msg-item.user') || []
      return [...users].some(item => norm(item.textContent).includes(text))
    }, 15000)
    note('отправка: текст ушёл в окно тем же полем и формой',
      accepted && norm($('composerTextarea')?.value) === '',
      `пузырей: ${($('messagesList')?.querySelectorAll('.msg-item.user') || []).length}, поле окна «${norm($('composerTextarea')?.value)}»`)
    const flipped = await until(() => shell()?.classList.contains('is-chat'), 6000)
    note('отправка: экран переключился на чат', flipped, `режим=${shell()?.className}`)
    const answered = await until(() => {
      const items = [...($('messagesList')?.querySelectorAll('.msg-item.assistant') || [])]
      return items.some(item => norm(item.textContent).length > 0)
    }, 20000)
    note('отправка: ответ дошёл до ленты', answered,
      norm([...($('messagesList')?.querySelectorAll('.msg-item.assistant') || [])]
        .map(item => item.textContent).join(' ')).slice(0, 70))
    checkPanelsHidden('отправка')
    await hold('отправка', 'is-chat')
    return { ok: checks.every(one => one.pass), checks }
  }

  // ─── U-1: в Ultra полос прокрутки на ленте не видно ────────────────────────
  //
  // Размер окна задаёт прогон (1240×800 и 1920×1080): полоса появляется ровно
  // тогда, когда содержимое выше окна, поэтому лента наполняется длинным ответом
  // НАСТОЯЩИМ путём (`setConversations` + перечитывание истории), а не подделкой
  // узлов. Без переполнения проверка «полосы нет» краснеть не умела бы.
  if (mode === 'scroll') {
    const wantW = Number(arg.width) || 1240
    const wantH = Number(arg.height) || 800
    const tag = `полосы ${wantW}×${wantH}`
    window.resizeTo(wantW, wantH)
    // Меряется КЛИЕНТСКАЯ область и доступный экран: на машине 1920×1080 панель
    // задач оставляет 1040 px, и рамка в 1080 просто не помещается. Окно обязано
    // стать таким большим, каким оно может быть, — иначе кадр снимался бы с
    // маленького окна, а проверка полосы выглядела бы пройденной.
    const availW = Math.min(wantW, window.screen.availWidth)
    const availH = Math.min(wantH, window.screen.availHeight)
    const resized = await until(() => window.innerWidth >= availW - 8 && window.innerHeight >= availH - 8, 8000)
    note(tag + ': окно заняло запрошенный размер (насколько хватает экрана)', resized,
      `экран ${window.innerWidth}×${window.innerHeight}, просили ${wantW}×${wantH}, доступно ${window.screen.availWidth}×${window.screen.availHeight}`)

    const now = Date.now()
    const prose = Array.from({ length: 40 }, (_, index) =>
      `Абзац ${index + 1}: в отчёте три раздела, и каждый описывает свой кусок работы достаточно подробно, ` +
      `чтобы строк хватило переполнить любое окно прогона.`).join('\n\n')
    const saved = await window.electronAPI?.setConversations?.([
      {
        id: chatA, title: titleA, createdAt: now - 7200000, updatedAt: now - 3600000,
        messages: [
          { role: 'user', content: askA, timestamp: now - 3700000 },
          // Длинная строка внутри fenced-блока — затем, чтобы у кода осталась
          // собственная горизонтальная прокрутка: по ней и проверяется, что
          // Ultra сняла полосы у ленты, а не у всего окна сразу.
          { role: 'assistant', content: prose + '\n\n```text\n' + 'x'.repeat(400) + '\n```', timestamp: now - 3600000 }
        ]
      },
      {
        id: chatB, title: titleB, createdAt: now - 1800000, updatedAt: now - 1200000,
        messages: [{ role: 'user', content: 'Run the tests and fix what falls', timestamp: now - 1300000 }]
      }
    ])
    note(tag + ': диалог с длинным ответом записан', saved?.ok === true, JSON.stringify(saved || {}).slice(0, 70))
    await window.__reloadChats?.()
    await wait(400)
    shell()?.querySelector(`[data-chat-id="${chatA}"]`)?.click()
    const opened = await until(() => shell()?.classList.contains('is-chat'), 8000)

    const feed = document.querySelector('.chat-feed')
    const overflowed = await until(() => feed && feed.scrollHeight - feed.clientHeight > 40, 8000)
    note(tag + ': прокручивать есть что', opened && overflowed,
      `лента scrollHeight=${feed?.scrollHeight}, clientHeight=${feed?.clientHeight}`)

    // Ширина вертикальной полосы — ровно столько места она съедает у содержимого:
    // `offsetWidth - clientWidth` на экране, а не признак в атрибуте.
    const barWidth = el => el.offsetWidth - el.clientWidth
    const scrollers = []
    for (let node = feed; node; node = node.parentElement) {
      const style = cs(node)
      const scrolls = style && (style.overflowY === 'auto' || style.overflowY === 'scroll')
      const overflows = scrolls && node.scrollHeight - node.clientHeight > 4
      const width = node === document.documentElement
        ? window.innerWidth - document.documentElement.clientWidth
        : (overflows ? barWidth(node) : 0)
      if (overflows || node === document.documentElement) {
        const name = node.id ? '#' + node.id : (norm(node.className).split(' ')[0] || node.tagName.toLowerCase())
        scrollers.push(`${name} полоса=${width}px`)
      }
      if (node === document.documentElement) break
    }
    const withBar = scrollers.filter(line => !line.endsWith('полоса=0px'))
    note(tag + ': ни у одного прокручиваемого предка ленты полоса не занимает место',
      withBar.length === 0,
      `прокручиваемых предков: ${scrollers.length}; ${withBar.join(' | ') || 'с полосой никого'}`)

    // Полосу сняли — прокрутку трогать нельзя: элемент обязан остаться
    // прокручиваемым, иначе «полосы нет» означало бы «обрезали содержимое».
    if (feed) { feed.scrollTop = 240 }
    await wait(150)
    const stillScrolls = feed ? feed.scrollTop > 0 : false
    note(tag + ': лента осталась прокручиваемой (overflow не срезан)',
      stillScrolls && cs(feed)?.overflowY === 'auto',
      `scrollTop=${feed?.scrollTop}, overflow-y=${cs(feed)?.overflowY}`)
    if (feed) { feed.scrollTop = 0 }

    // Отрицательный контроль: у внутреннего прокручиваемого узла (блок кода)
    // полоса обязана остаться — иначе проверка меряла бы глобальное отключение.
    const pre = $('messagesList')?.querySelector('.code-block pre')
    const preWide = Boolean(pre && pre.scrollWidth - pre.clientWidth > 4)
    note(tag + ': внутри блока кода полоса осталась',
      preWide && pre.offsetHeight - pre.clientHeight > 0,
      `pre: scrollWidth=${pre?.scrollWidth}, clientWidth=${pre?.clientWidth}, полоса=${pre ? pre.offsetHeight - pre.clientHeight : -1}px`)

    await hold(tag, 'is-chat')
    return { ok: checks.every(one => one.pass), checks }
  }

  // ─── U-2: «Задачи» в Ultra — свободный блок того же слоя ───────────────────
  if (mode === 'tasks') {
    const BLOCK = '.ublock[data-block-id="ultra-tasks"]'
    const row = await until(() => shell()?.querySelector(`[data-chat-id="${chatA}"]`), 8000)
      ? shell().querySelector(`[data-chat-id="${chatA}"]`) : null
    row?.click()
    const inChat = await until(() => shell()?.classList.contains('is-chat'), 8000)
    note('задачи: чат открыт кликом', inChat, `режим=${shell()?.className}`)

    const button = $('navTasks')
    note('задачи: кнопка окна на месте', Boolean(button), button ? norm(button.textContent) : 'узла нет')
    button?.click()
    const found = await until(() => Boolean(document.querySelector(BLOCK)), 8000)
    const block = document.querySelector(BLOCK)
    note('задачи: открылись свободным блоком слоя результатов', found,
      `слоёв: ${document.querySelectorAll('.ublocks').length}, блоков: ${document.querySelectorAll('.ublock').length} ` +
      `[${[...document.querySelectorAll('.ublock')].map(el => el.getAttribute('data-block-id')).join(', ')}], ` +
      `пилюль: ${document.querySelectorAll('.ublock-pill').length}, ` +
      `признак тела=${document.body.classList.contains('ultra-tasks-block') ? 'есть' : 'нет'}`)
    if (!block) {
      await hold('задачи', 'is-chat')
      return { ok: checks.every(one => one.pass) && false, checks }
    }
    note('задачи: экрана на пол-окна не было',
      !document.body.classList.contains('task-center-open') &&
      document.body.classList.contains('ultra-tasks-block'),
      `task-center-open=${document.body.classList.contains('task-center-open')}, ` +
      `ultra-tasks-block=${document.body.classList.contains('ultra-tasks-block')}`)
    const view = $('taskCenterView')
    note('задачи: экран центра задач живёт ВНУТРИ блока', Boolean(block && view && block.contains(view)),
      `родитель #taskCenterView: ${view?.parentElement?.className || 'нет узла'}`)
    const viewBox = view ? view.getBoundingClientRect() : null
    note('задачи: список задач рисуется в блоке',
      Boolean(block?.querySelector('.task-center-head')) && Boolean(viewBox && viewBox.height > 120 && viewBox.width > 200),
      `экран ${Math.round(viewBox?.width || 0)}×${Math.round(viewBox?.height || 0)}`)

    const rect = block ? block.getBoundingClientRect() : null
    const composer = $('composerTextarea') ? $('composerTextarea').getBoundingClientRect() : null
    const hits = rect && composer
      ? !(rect.right <= composer.left || rect.left >= composer.right || rect.bottom <= composer.top || rect.top >= composer.bottom)
      : true
    note('задачи: блок не наезжает на строку ввода', Boolean(rect) && !hits,
      rect && composer ? `блок ${Math.round(rect.left)}…${Math.round(rect.right)} × ${Math.round(rect.top)}…${Math.round(rect.bottom)}, ввод ${Math.round(composer.top)}…${Math.round(composer.bottom)}` : 'узлов нет')

    if (arg.expect) {
      const want = arg.expect
      note('задачи после перезапуска: место и размер вернулись',
        Boolean(rect) && Math.abs(rect.left - want.x) <= 8 && Math.abs(rect.top - want.y) <= 8 &&
        Math.abs(rect.width - want.w) <= 8 && Math.abs(rect.height - want.h) <= 8,
        `сейчас ${Math.round(rect?.left)},${Math.round(rect?.top)} ${Math.round(rect?.width)}×${Math.round(rect?.height)}, жали ${JSON.stringify(want)}`)
      await hold('задачи', 'is-chat')
      return { ok: checks.every(one => one.pass), checks, extra: { place: rect ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : null } }
    }

    note('задачи: первый блок 360×480',
      Boolean(rect) && Math.abs(rect.width - 360) <= 8 && Math.abs(rect.height - 480) <= 8,
      rect ? `${Math.round(rect.width)}×${Math.round(rect.height)}` : 'блока нет')
    const at = button ? button.getBoundingClientRect() : null
    // Кнопка «Задачи» в Ultra спрятана при нулевом счётчике (правка 4 приёмки
    // 9.2), и в этом состоянии её прямоугольник — нули: проверить «под кнопкой»
    // можно только когда кнопка видна. Иначе мерим то, что от человека не
    // скрыто: блок в правой половине окна и не поверх строки ввода.
    const shown = Boolean(at) && at.width > 0 && at.height > 0
    if (shown) {
      note('задачи: первый блок встал под кнопкой',
        Math.abs(rect.right - at.right) <= 16 && rect.top >= at.bottom - 8,
        `низ кнопки ${Math.round(at.bottom)}, верх блока ${Math.round(rect.top)}, правые края ${Math.round(at.right)} / ${Math.round(rect.right)}`)
    } else {
      note('задачи: при спрятанной кнопке блок встал в правой половине окна',
        rect.left > window.innerWidth / 2 - rect.width / 2,
        `кнопка скрыта (признак ${document.documentElement.getAttribute('data-ultra-tasks') || 'нет'}), блок слева ${Math.round(rect.left)} из ${window.innerWidth}`)
    }

    // Перетаскивание НАСТОЯЩИМИ pointer-событиями: по нему и проверяется, что
    // сохранённое место — результат действия человека, а не стартовая точка.
    const head = block?.querySelector('.ublock-head')
    const from = { x: rect.left + rect.width / 2, y: rect.top + 12 }
    const to = { x: from.x - 160, y: from.y + 96 }
    const pointer = (el, type, point) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, pointerId: 1, button: 0
    }))
    if (head) {
      pointer(head, 'pointerdown', from)
      pointer(document, 'pointermove', to)
      await wait(80)
      pointer(document, 'pointerup', to)
      await wait(400)
    }
    const moved = block ? block.getBoundingClientRect() : null
    const movedAtAll = Boolean(moved) && (Math.abs(moved.left - rect.left) > 40 || Math.abs(moved.top - rect.top) > 40)
    note('задачи: блок переставлен перетаскиванием', movedAtAll,
      moved ? `${Math.round(rect.left)},${Math.round(rect.top)} → ${Math.round(moved.left)},${Math.round(moved.top)}` : 'блока нет')
    // Правило `keepOut` может вернуть блок вверх из полосы строки ввода —
    // поэтому после отпускания проверяется и перемещение, и то, что поле
    // ввода снова свободно.
    const after = moved && $('composerTextarea') ? $('composerTextarea').getBoundingClientRect() : null
    const hitsAfter = Boolean(after) && !(moved.right <= after.left || moved.left >= after.right ||
      moved.bottom <= after.top || moved.top >= after.bottom)
    note('задачи: после перетаскивания блок не закрыл строку ввода', Boolean(moved) && !hitsAfter,
      after ? `блок ${Math.round(moved.left)}…${Math.round(moved.right)} × ${Math.round(moved.top)}…${Math.round(moved.bottom)}, ввод ${Math.round(after.top)}…${Math.round(after.bottom)}` : 'узла ввода нет')
    await hold('задачи', 'is-chat')
    return {
      ok: checks.every(one => one.pass),
      checks,
      extra: { place: moved ? { x: moved.left, y: moved.top, w: moved.width, h: moved.height } : null }
    }
  }

  note('режим прогона неизвестен', false, 'mode=' + mode)
  return { ok: false, checks }
})()
