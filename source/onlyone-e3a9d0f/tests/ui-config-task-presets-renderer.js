// ---------------------------------------------------------------------------
// Внутриоконный зонд проверки смены наборов интерфейса под задачи (пункт 9.5)
// Наборы: «дизайн» (design), «код» (code), «исследование» (research) в RU и EN
// Полный цикл: запрос в чат → карточка .prop → «Примерить» → проверка раскладки
// и контура .trying → «Оставить» → фиксация раскладки → «Откатить» → возврат
// ---------------------------------------------------------------------------

/* global document, window, Event, setTimeout */
(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))

  const until = async (fn, ms = 20000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch {}
      await wait(50)
    }
    return false
  }

  // Ожидание полной инициализации приложения
  await until(() => document.documentElement.dataset.appReady === '1', 25000)
  await wait(500)

  // Закрываем онбординг, если появился
  const ob = $('onboarding')
  if (ob) {
    ob.remove()
    try { localStorage.setItem('onlyone.onboarded', '1') } catch {}
  }

  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')
  const { lang = 'ru', preset = 'design', shotsDir = '' } = arg

  // Переключение языка интерфейса
  if (lang === 'en' && window.onlyoneApp?.setLanguage) {
    window.onlyoneApp.setLanguage('en')
    await wait(300)
  }

  const checks = []
  const facts = { lang, preset }
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail || '' })

  const takeShot = async (filename) => {
    if (!shotsDir) return
    const target = shotsDir.replace(/\\/g, '/') + '/' + filename
    document.title = 'SNAP:' + target
    await wait(400)
  }

  try {
    const rootStyle = document.documentElement.style
    const initialSidebarWidth = rootStyle.getPropertyValue('--sidebar-width') || '260px'
    const initialCodeFontSize = rootStyle.getPropertyValue('--code-font-size') || '14px'
    const initialWorkPanelWidth = rootStyle.getPropertyValue('--work-panel-width') || '360px'

    facts.initialLayout = {
      sidebarWidth: initialSidebarWidth,
      codeFontSize: initialCodeFontSize,
      workPanelWidth: initialWorkPanelWidth
    }

    // 1. Формирование запроса в чат
    let promptText = ''
    if (preset === 'design') {
      promptText = lang === 'en' ? 'tune for design' : 'настрой под дизайн'
    } else if (preset === 'code') {
      promptText = lang === 'en' ? 'tune for code' : 'настрой под код'
    } else if (preset === 'research') {
      promptText = lang === 'en' ? 'tune for research' : 'настрой под исследование'
    }

    // Ввод текста в composer и отправка
    const ta = $('composerTextarea')
    if (!ta) throw new Error('Поле ввода #composerTextarea не найдено')
    ta.value = promptText
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(200)

    $('composerForm')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await wait(400)

    // 2. Проверка появления карточки предложения (.prop) в ленте
    const propAppeared = await until(() => document.querySelector('.prop'), 10000)
    note(`карточка предложения .prop для набора «${preset}» появилась в ленте`, propAppeared)

    const propCard = document.querySelector('.prop')
    const propLabel = propCard?.querySelector('span')?.textContent || ''
    facts.propLabel = propLabel

    let patch = {}
    try { patch = JSON.parse(propCard?.dataset.propPatch || '{}') } catch {}
    facts.patch = patch

    note(`в карточке передан корректный taskPreset: "${preset}"`, patch.taskPreset === preset, JSON.stringify(patch))

    const tryBtn = propCard?.querySelector('.btn-ui-try')
    note('кнопка «Примерить» присутствует в карточке', Boolean(tryBtn))
    if (lang === 'en') {
      note('надпись кнопки на английском (Try on)', tryBtn?.textContent.includes('Try on'), tryBtn?.textContent)
    } else {
      note('надпись кнопки на русском (Примерить)', tryBtn?.textContent.includes('Примерить'), tryBtn?.textContent)
    }

    // Снимок 1: карточка предложения в чате
    await takeShot(`ui-config-preset-${preset}-prop-${lang}.png`)
    facts.shotProp = `ui-config-preset-${preset}-prop-${lang}.png`

    // 3. Клик «Примерить» (Try on)
    if (tryBtn) {
      tryBtn.click()
      await wait(300)
    }

    const tryBar = document.querySelector('.trybar')
    note('панель примерки .trybar отображается вверху окна', Boolean(tryBar))

    const tryingLine = document.querySelector('.appliedline.tr')
    note('строка «Примеряю — решите вверху окна» (.appliedline.tr) отображается в чате', Boolean(tryingLine))

    const tryingOutline = document.querySelector('.trying')
    note('пунктирный контур .trying наложен на изменяемую зону интерфейса', Boolean(tryingOutline))

    const revertBtn = document.querySelector('.btn-ui-revert')
    const keepBtn = document.querySelector('.btn-ui-keep')
    note('в панели .trybar присутствуют кнопки Вернуть и Оставить', Boolean(revertBtn) && Boolean(keepBtn))

    // Проверка геометрии раскладки в режиме примерки
    const trySidebarW = rootStyle.getPropertyValue('--sidebar-width')
    const tryWorkPanelW = rootStyle.getPropertyValue('--work-panel-width')
    const tryCodeFont = rootStyle.getPropertyValue('--code-font-size')
    const tryWorkDisplay = rootStyle.getPropertyValue('--work-panel-display')

    facts.tryingLayout = {
      sidebarWidth: trySidebarW,
      workPanelWidth: tryWorkPanelW,
      codeFontSize: tryCodeFont,
      workPanelDisplay: tryWorkDisplay
    }

    if (preset === 'design') {
      note('дизайн: боковая панель компактна (200px)', trySidebarW === '200px', trySidebarW)
      note('дизайн: панель работы расширена (480px)', tryWorkPanelW === '480px', tryWorkPanelW)
    } else if (preset === 'code') {
      note('код: шрифт кода увеличен до 16px', tryCodeFont === '16px', tryCodeFont)
      note('код: рабочая панель установлена в 420px', tryWorkPanelW === '420px', tryWorkPanelW)
    } else if (preset === 'research') {
      note('исследование: боковая панель развёрнута (320px)', trySidebarW === '320px', trySidebarW)
      note('исследование: рабочая панель скрыта (--work-panel-display: none)', tryWorkDisplay === 'none', tryWorkDisplay)
    }

    // Снимок 2: режим примерки набора
    await takeShot(`ui-config-preset-${preset}-try-${lang}.png`)
    facts.shotTry = `ui-config-preset-${preset}-try-${lang}.png`

    // 4. Клик «Оставить» (Keep)
    if (keepBtn) {
      keepBtn.click()
      await wait(400)
    }

    const tryBarGone = !document.querySelector('.trybar')
    note('панель .trybar исчезла после нажатия «Оставить»', tryBarGone)

    const tryingOutlineGone = !document.querySelector('.trying')
    note('контур .trying снят после фиксации изменения', tryingOutlineGone)

    const appliedLine = document.querySelector('.appliedline:not(.tr)')
    note('строка применённого изменения .appliedline появилась в чате', Boolean(appliedLine))

    const undoBtn = document.querySelector('.btn-ui-undo')
    note('кнопка отката присутствует в .appliedline', Boolean(undoBtn))
    if (lang === 'en') {
      note('надпись кнопки отката на английском (Undo)', undoBtn?.textContent.includes('Undo'), undoBtn?.textContent)
    } else {
      note('надпись кнопки отката на русском (Откатить)', undoBtn?.textContent.includes('Откатить'), undoBtn?.textContent)
    }

    // Проверка, что раскладка осталась новой
    const keptSidebarW = rootStyle.getPropertyValue('--sidebar-width')
    const keptWorkPanelW = rootStyle.getPropertyValue('--work-panel-width')
    const keptCodeFont = rootStyle.getPropertyValue('--code-font-size')
    const keptWorkDisplay = rootStyle.getPropertyValue('--work-panel-display')

    facts.keptLayout = {
      sidebarWidth: keptSidebarW,
      workPanelWidth: keptWorkPanelW,
      codeFontSize: keptCodeFont,
      workPanelDisplay: keptWorkDisplay
    }

    if (preset === 'design') {
      note('раскладка «дизайн» зафиксирована (200px / 480px)', keptSidebarW === '200px' && keptWorkPanelW === '480px')
    } else if (preset === 'code') {
      note('раскладка «код» зафиксирована (16px / 420px)', keptCodeFont === '16px' && keptWorkPanelW === '420px')
    } else if (preset === 'research') {
      note('раскладка «исследование» зафиксирована (320px / hidden)', keptSidebarW === '320px' && keptWorkDisplay === 'none')
    }

    // Снимок 3: зафиксированная раскладка
    await takeShot(`ui-config-preset-${preset}-keep-${lang}.png`)
    facts.shotKeep = `ui-config-preset-${preset}-keep-${lang}.png`

    // 5. Клик «Откатить» (Undo)
    if (undoBtn) {
      undoBtn.click()
      await wait(400)
    }

    const restoredProp = document.querySelector('.prop')
    note('карточка предложения .prop восстановилась после нажатия «Откатить»', Boolean(restoredProp))

    // Проверка возврата раскладки к исходной
    const restoredSidebarW = rootStyle.getPropertyValue('--sidebar-width')
    const restoredCodeFont = rootStyle.getPropertyValue('--code-font-size')
    const restoredWorkDisplay = rootStyle.getPropertyValue('--work-panel-display')

    facts.restoredLayout = {
      sidebarWidth: restoredSidebarW,
      codeFontSize: restoredCodeFont,
      workPanelDisplay: restoredWorkDisplay
    }

    if (preset === 'research') {
      note('после отката боковая панель вернулась к прежней ширине', restoredSidebarW !== '320px', restoredSidebarW)
    } else if (preset === 'code') {
      note('после отката шрифт кода вернулся к исходному', restoredCodeFont !== '16px', restoredCodeFont)
    } else if (preset === 'design') {
      note('после отката боковая панель вернулась к прежней ширине', restoredSidebarW !== '200px', restoredSidebarW)
    }

    // Снимок 4: результат после отката
    await takeShot(`ui-config-preset-${preset}-undo-${lang}.png`)
    facts.shotUndo = `ui-config-preset-${preset}-undo-${lang}.png`

  } catch (err) {
    note('сбой в ходе выполнения сценария', false, err.message)
    facts.fatalError = err.message
  }

  const ok = checks.every(c => c.pass)
  const report = { ok, facts, checks }
  window.__smokeReport = report
  return report
})()
