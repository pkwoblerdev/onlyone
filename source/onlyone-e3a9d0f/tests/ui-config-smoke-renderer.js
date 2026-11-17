// ---------------------------------------------------------------------------
// Внутриоконный зонд проверки предложения, примерки и отката интерфейса
// Пункты 7.1, 7.2 (Макет 2.0: .prop, .trybar, .trying, .appliedline)
// ---------------------------------------------------------------------------
(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

  const until = async (fn, ms = 20000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch {}
      await wait(50)
    }
    return false
  }

  // Ожидание готовности приложения
  await until(() => document.documentElement.dataset.appReady === '1')

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
  const { step = 'proposal', lang = 'ru' } = arg

  // Переключение языка при необходимости
  if (lang === 'en' && window.onlyoneApp?.setLanguage) {
    window.onlyoneApp.setLanguage('en')
    await wait(200)
  }

  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })

  // Рендерим тестовое предложение интерфейса через window.onlyoneApp
  const label = lang === 'en' ? 'Increase code font size to 15px' : 'Увеличить шрифт кода до 15px'
  const patch = { codeFontSize: 15, sidebarWidth: 290 }

  window.onlyoneApp?.renderProposal(null, {
    id: 'prop-test-1',
    label,
    patch,
    state: 'pending'
  })
  await wait(100)

  const propCard = document.querySelector('.prop')
  note('карточка предложения .prop отрендерена в ленте', Boolean(propCard))

  const tryBtn = document.querySelector('.btn-ui-try')
  note('кнопка примерить присутствует в карточке', Boolean(tryBtn))
  if (lang === 'en') {
    note('текст кнопки примерить на английском (Try on)', tryBtn?.textContent.includes('Try on'))
  } else {
    note('текст кнопки примерить на русском (Примерить)', tryBtn?.textContent.includes('Примерить'))
  }

  if (step === 'proposal') {
    return { ok: checks.every(c => c.pass), checks }
  }

  // Шаг 2: Нажатие «Примерить»
  if (tryBtn) {
    tryBtn.click()
    await wait(150)
  }

  const tryBar = document.querySelector('.trybar')
  note('панель примерки .trybar появилась вверху окна', Boolean(tryBar))

  const revertBtn = document.querySelector('.btn-ui-revert')
  const keepBtn = document.querySelector('.btn-ui-keep')
  note('кнопки Вернуть и Оставить присутствуют в .trybar', Boolean(revertBtn) && Boolean(keepBtn))

  if (lang === 'en') {
    note('кнопки в .trybar переведены на английский (Revert, Keep)',
      revertBtn?.textContent.includes('Revert') && keepBtn?.textContent.includes('Keep'))
  } else {
    note('кнопки в .trybar на русском (Вернуть, Оставить)',
      revertBtn?.textContent.includes('Вернуть') && keepBtn?.textContent.includes('Оставить'))
  }

  const tryingElement = document.querySelector('.trying')
  note('пунктирный контур .trying наложен на изменяемый элемент', Boolean(tryingElement))

  const tryingLine = document.querySelector('.appliedline.tr')
  note('строка «Примеряю — решите вверху окна» (.appliedline.tr) отображается в чате', Boolean(tryingLine))

  const rootStyle = document.documentElement.style
  note('CSS-переменная --sidebar-width обновилась вживую', rootStyle.getPropertyValue('--sidebar-width') === '290px')
  note('CSS-переменная --code-font-size обновилась вживую', rootStyle.getPropertyValue('--code-font-size') === '15px')

  if (step === 'try') {
    return { ok: checks.every(c => c.pass), checks }
  }

  // Шаг 3: Нажатие «Оставить» (Keep)
  if (step === 'keep' || step === 'undo') {
    if (keepBtn) {
      keepBtn.click()
      await wait(200)
    }

    const tryBarAfterKeep = document.querySelector('.trybar')
    note('панель .trybar исчезла после подтверждения', !tryBarAfterKeep)

    const tryingAfterKeep = document.querySelector('.trying')
    note('контур .trying снят после подтверждения', !tryingAfterKeep)

    const appliedLine = document.querySelector('.appliedline:not(.tr)')
    note('строка применённого изменения .appliedline появилась в чате', Boolean(appliedLine))

    const undoBtn = document.querySelector('.btn-ui-undo')
    note('кнопка отката присутствует в .appliedline', Boolean(undoBtn))

    if (lang === 'en') {
      note('кнопка отката на английском (Undo)', undoBtn?.textContent.includes('Undo'))
    } else {
      note('кнопка отката на русском (Откатить)', undoBtn?.textContent.includes('Откатить'))
    }

    if (step === 'keep') {
      return { ok: checks.every(c => c.pass), checks }
    }

    // Шаг 4: Нажатие «Откатить» (Undo)
    if (undoBtn) {
      undoBtn.click()
      await wait(200)
    }

    const restoredProp = document.querySelector('.prop')
    note('карточка предложения .prop восстановилась после отката', Boolean(restoredProp))

    return { ok: checks.every(c => c.pass), checks }
  }

  return { ok: checks.every(c => c.pass), checks }
})()
