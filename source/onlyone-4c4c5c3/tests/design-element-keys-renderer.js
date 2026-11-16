(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })
  let lastError = null

  // Паузы здесь — не вежливость, а гадание: окно поднимается на занятой машине,
  // соседние прогоны держат своё окно, а ход Design уходит в главный процесс и
  // возвращается когда вернётся. Поэтому ждём признака, а не времени.
  const until = async (fn, ms = 30000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch (err) { lastError = err }
      await wait(50)
    }
    return false
  }

  // «не делает ничего и не бросает» без этого не отличается от «упало молча».
  const errors = []
  window.addEventListener('error', event => errors.push(String(event.message)))
  window.addEventListener('unhandledrejection', event =>
    errors.push('rejection: ' + String(event.reason?.message || event.reason)))

  const ready = await until(() => document.documentElement.dataset.appReady === '1', 40000)
  note('Окно сообщило о готовности', ready)
  if (!ready) return { ok: false, checks }

  const frame = $('designPreviewFrame')
  let booted = 0
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow) return
    if (event.data?.type === '__dc_booted') booted++
  })

  // Кадр кросс-ориджинный: заглянуть в него нельзя, поэтому он сам докладывает
  // свой настоящий размер сообщением `onecode-design-size`. Рядом кладётся то,
  // какую геометрию окно в итоге назначило элементу iframe. Без пары «что
  // измерили → что применили» не отличить тесноту колонки от дробного масштаба,
  // на котором страница внутри кадра начинает ползти сама по себе.
  const sizeReports = []
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow) return
    if (event.data?.type === 'onecode-design-size') {
      sizeReports.push({ width: Number(event.data.width) || 0,
        viewportWidth: Number(event.data.viewportWidth) || 0 })
    }
  })
  const geometry = () => ({
    frameWidth: frame.style.width, frameHeight: frame.style.height,
    zoom: frame.style.zoom || '', reported: sizeReports.slice(-3),
    stage: frame.parentElement?.clientWidth || 0
  })

  // --- довести до живого превью --------------------------------------------------
  // Фикстура требует настоящий скорость-режим в запросе: smoke-ответ отказывается
  // отвечать, если `speedMode` не доехал из интерфейса, — так что Fast включается
  // по-настоящему, а не в обход.
  const fastToggle = $('fastModeToggle')
  fastToggle.checked = true
  fastToggle.dispatchEvent(new Event('change', { bubbles: true }))
  $('navDesign').click()
  await until(() => $('designView')?.classList.contains('active'))
  const askBox = $('dsNewIn')
  askBox.value = 'Создай тестовую страницу'
  askBox.dispatchEvent(new Event('input', { bubbles: true }))
  $('dsNewForm').requestSubmit()
  await until(() => $('designComposerTextarea')?.offsetParent)
  const box = $('designComposerTextarea')
  const previewShown = await until(() => $('designPreviewName').textContent === 'Landing.dc.html' &&
    booted > 0 && !$('designSendBtn').classList.contains('is-stop'), 90000)
  note('Настоящая страница макета загружена в превью', previewShown,
    { booted, lastError: String(lastError?.message || '') })
  if (!previewShown) return { ok: false, checks }

  const designs = await window.electronAPI.getDesigns()
  const designId = designs[0]?.id
  note('Макет виден в хранилище дизайнов', Boolean(designId))

  // Размер компонента на диске. `designHandoff` отдаёт метаданные настоящих
  // файлов — это единственный способ увидеть байты из окна: кадр кросс-ориджинный,
  // а CSP не даёт превью ни `fetch`, ни чтения чужих файлов.
  const onDisk = async () => {
    const res = await window.electronAPI?.designHandoff?.(designId)
    const file = (res?.attachments || []).find(item => item.name === 'Landing.dc.html')
    return Number(file?.size) || 0
  }
  const disk0 = await onDisk()
  note('Размер компонента на диске снят', disk0 > 0, { disk0 })

  // --- общие приёмчики -------------------------------------------------------------
  const confirmOpen = () => $('confirmModal')?.style.display === 'flex'
  const askMessage = () => $('confirmMessage')?.textContent || ''
  const selected = () => $('designSelectedElementName')
  const hasSelection = () => Boolean(selected() && !selected().hidden && selected().textContent)
  const pickingOn = () => $('designSelectElementBtn')?.getAttribute('aria-pressed') === 'true'
  const removeDisabled = () => $('designRemoveElementBtn')?.disabled === true

  // Нажатие в документе окна — путь, когда фокус остался на кнопке «Выбрать».
  const press = (key, extra = {}) => document.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
  // То же нажатие, но пришедшее из кадра: после клика по элементу фокус уходит в
  // макет, и до родителя такое нажатие не доходит никогда.
  const pressInFrame = data => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'onecode-design-key', ctrlKey: false, metaKey: false, ...data },
    source: frame.contentWindow
  }))
  // Чужое окно: то же сообщение, но `source` — не кадр превью. Граница
  // безопасности, а не удобство: обрабатывать такое нельзя ничем.
  const pressFromStranger = (data, source = window) => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'onecode-design-key', ctrlKey: false, metaKey: false, ...data },
    source
  }))

  const LABEL = 'button.primary — «Продолжить»'
  const selectElement = async (label = LABEL) => {
    // В режим выбора кнопка ставит кадр сообщением; если режим уже включён,
    // второй клик выключил бы его, и сообщение о выборе родителя не нашло бы.
    if (!pickingOn()) $('designSelectElementBtn').click()
    if (!await until(pickingOn, 5000)) return false
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'onecode-design-element-selected', element: label, tplId: '7' },
      source: frame.contentWindow
    }))
    return await until(() => hasSelection() && selected().textContent === label && !removeDisabled())
  }
  const closeModal = async () => {
    $('confirmCancelBtn')?.click()
    return await until(() => !confirmOpen(), 5000)
  }
  // «Удали выбранный элемент» — реплика, которая появляется в ленте только когда
  // удаление действительно пошло в модель. Отменённое подтверждение не имеет
  // права оставить и её.
  const removalRequested = () => $('designMessages')?.textContent.includes('Удали выбранный элемент')

  // --- выбор элемента -------------------------------------------------------------
  note('Элемент выбирается сообщением из кадра', await selectElement())

  // --- Delete и Backspace ---------------------------------------------------------
  press('Delete')
  const askedByDelete = await until(confirmOpen, 5000)
  note('Delete открывает то же подтверждение, что и кнопка удаления',
    askedByDelete && askMessage().includes('выбранный элемент'), { ask: askMessage() })
  note('Delete без подтверждения ничего не удаляет',
    (await closeModal()) && !removalRequested() && hasSelection() && disk0 === await onDisk())

  press('Backspace')
  const askedByBackspace = await until(confirmOpen, 5000)
  note('Backspace удаляет тем же путём, что и кнопка', askedByBackspace && !removalRequested())
  await closeModal()

  pressInFrame({ key: 'Delete' })
  const askedFromFrame = await until(confirmOpen, 5000)
  note('Delete из кадра работает так же, как нажатие в окне', askedFromFrame && !removalRequested())
  await closeModal()

  // --- граница: чужие окна и лишние клавиши ----------------------------------------
  pressFromStranger({ key: 'Delete' })
  pressFromStranger({ key: 'Escape' })
  pressFromStranger({ key: 'z', ctrlKey: true }, undefined)
  await wait(250)
  note('Сообщение из чужого окна не удаляет, не снимает выбор и не откатывает',
    !confirmOpen() && hasSelection() && disk0 === await onDisk(), { selection: selected().textContent })

  pressInFrame({ key: 'a' })
  pressInFrame({ key: 'ArrowUp' })
  pressInFrame({ key: 'Enter' })
  pressInFrame({ key: ' ' })
  await wait(250)
  note('Клавиши вне списка четырёх ничего не делают',
    !confirmOpen() && hasSelection() && !pickingOn() && disk0 === await onDisk(),
    { selection: selected().textContent })

  // Текст в поле ввода — не команда: Backspace и Delete печатаются в черновик, и
  // модальное подтверждение на каждое нажатие отняло бы у окна возможность писать.
  const textarea = $('designComposerTextarea')
  textarea.focus()
  for (const key of ['Backspace', 'Delete']) textarea.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  await wait(250)
  note('Правка текста в поле ввода не превращается в удаление элемента',
    !confirmOpen() && hasSelection() && !removalRequested(), { selection: selected().textContent })
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
  await wait(250)
  note('Ctrl+Z в поле ввода остаётся отменой набора, а не откатом макета',
    !confirmOpen() && hasSelection() && disk0 === await onDisk())
  textarea.blur()

  // --- Escape и модальное подтверждение --------------------------------------------
  // Глобальный обработчик окна закрывает модалку раньше любого раздела, и это
  // единственно правильное: Escape из диалога подтверждения отменяет диалог, а не
  // выбор элемента. Проверка зелёная и сейчас — она сторожит именно приоритет.
  $('designRemoveElementBtn').click()
  const openedByButton = await until(confirmOpen, 5000)
  press('Escape')
  const modalClosed = await until(() => !confirmOpen(), 5000)
  note('Escape в открытом подтверждении закрывает диалог и бережёт выбор',
    openedByButton && modalClosed && hasSelection() && !removalRequested(),
    { openedByButton, modalClosed, selection: selected().textContent })

  // --- Escape снимает выбор и выключает режим --------------------------------------
  press('Escape')
  note('Escape снимает имя выбранного элемента', await until(() => !hasSelection() && removeDisabled(), 5000))

  await selectElement()
  $('designSelectElementBtn').click()
  const picked = await until(pickingOn, 5000)
  press('Escape')
  const modeOff = await until(() => !pickingOn(), 5000)
  note('Escape выключает режим выбора элемента', picked && modeOff, { picked, modeOff })

  // --- Ctrl+Z без версий ------------------------------------------------------------
  await selectElement('h1 — «Проверка Design»')
  press('z', { ctrlKey: true })
  const undone = await until(() => !hasSelection(), 5000)
  note('Ctrl+Z снимает выбор и не бросается, когда версий нет',
    undone && !removalRequested() && disk0 === await onDisk() && errors.length === 0,
    { errors: errors.slice(0, 3) })

  // Откат обязан быть таким же по сочетанию, пришедшему из кадра.
  await selectElement('p — «Страница создана»')
  pressInFrame({ key: 'z', ctrlKey: true })
  const undoneFromFrame = await until(() => !hasSelection(), 5000)
  note('Ctrl+Z из кадра откатывает тот же открытый компонент',
    undoneFromFrame && disk0 === await onDisk() && errors.length === 0, { errors: errors.slice(0, 3) })

  // --- откат настоящим каналом ---------------------------------------------------
  // Узловой набор (`test-design-element-undo.cjs`) доказывает побайтовость возврата.
  // Здесь доказывается другое, чего узловой набор не видит: что путь «окно → IPC →
  // хранитель → диск → перерисовка превью» проходит целиком, а не существует только
  // в вызове функции. Для этого макет пишется вторично — перезапись существующего
  // файла и есть тот случай, ради которого версия заводится.

  const versionsBefore = await window.electronAPI.designVersions(designId, 'Landing.dc.html')
  note('До второй правки версий у открытого компонента нет',
    versionsBefore?.ok === true && versionsBefore.versions.length === 0,
    { error: versionsBefore?.error, found: versionsBefore?.versions?.length })

  box.value = 'Перепиши страницу ещё раз'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  $('designComposerForm').requestSubmit()
  const bootedAgain = await until(() => booted > 1 && !$('designSendBtn').classList.contains('is-stop'), 90000)
  note('Второй ход Дизайна дошёл до превью', bootedAgain, { booted })

  const afterSecondWrite = await window.electronAPI.designVersions(designId, 'Landing.dc.html')
  const countBeforeUndo = (afterSecondWrite?.versions || []).length
  note('Перезапись компонента оставила версию прежних байтов',
    afterSecondWrite?.ok === true && countBeforeUndo >= 1,
    { versions: countBeforeUndo, error: afterSecondWrite?.error })

  await selectElement('h1 — «Проверка Design»')
  press('z', { ctrlKey: true })
  const clearedByUndo = await until(() => !hasSelection(), 5000)
  const told = await until(() => $('toastNotification')?.classList.contains('show') &&
    /прежн/i.test($('toastNotification').textContent || ''), 5000)
  const afterUndo = await window.electronAPI.designVersions(designId, 'Landing.dc.html')
  note('Ctrl+Z прошёл весь путь: окно → главный процесс → диск → перерисовка',
    clearedByUndo && told && afterUndo?.ok === true && afterUndo.versions.length === countBeforeUndo + 1 &&
    errors.length === 0,
    { clearedByUndo, told, до: countBeforeUndo, после: afterUndo?.versions?.length,
      error: afterUndo?.error, errors: errors.slice(0, 3) })

  // Главная проверка среза про вписывание: превью не имеет права оставаться уже
  // колонки, если странице хватает её собственной области. Кадр кросс-ориджинный,
  // поэтому опираемся на его же доклад и на реальную геометрию элемента в окне.
  const lastReport = sizeReports[sizeReports.length - 1] || null
  const stageRoom = (frame.parentElement?.clientWidth || 0) - 36
  const fitsColumn = Boolean(lastReport) && lastReport.viewportWidth > 0 &&
    lastReport.width <= lastReport.viewportWidth + 1
  const frameBox = frame.getBoundingClientRect().width
  note('Странице хватает колонки — превью не заморожено её шириной',
    !fitsColumn || (frame.style.width === '' && Math.abs(frameBox - stageRoom) <= 2),
    { report: lastReport, stageRoom, frameBox, styleWidth: frame.style.width })

  // Главное приложение после скрипта читает текст страницы в кадре: вид должен
  // остаться тем же макетом, что лежал на диске до всех нажатий. Геометрия
  // приложена деталью: это замер, а не проверка, и притворяться вердиктом он
  // не имеет права.
  note('Ни одной необработанной ошибки за прогон', errors.length === 0,
    { errors: errors.slice(0, 5), geometry: geometry() })
  $('navDesign').click()
  await until(() => $('designView')?.classList.contains('active'))
  return { ok: checks.every(item => item.pass), checks }
})()
