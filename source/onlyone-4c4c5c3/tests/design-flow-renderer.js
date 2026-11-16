(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })

  // Ждать миллисекунды — значит угадывать. Инициализация окна читает настройки,
  // диалоги, проекты и дизайны, и на занятой машине не укладывалась в паузу:
  // обработчики раздела Design ещё не были подключены, нажатия пропадали, и
  // дальше валилась вся цепочка. Отсюда падения примерно раз в пять прогонов.
  const until = async (fn, ms = 20000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch {}
      await wait(50)
    }
    return false
  }

  const ready = await until(() => document.documentElement.dataset.appReady === '1')
  note('Окно сообщило о готовности', ready)
  if (!ready) return { ok: false, checks }
  $('sidebarToggle').click()
  await wait(350)
  const newBounds = $('newChatBtn').getBoundingClientRect()
  const toggleBounds = $('sidebarToggle').getBoundingClientRect()
  const sideBounds = document.querySelector('.sidebar').getBoundingClientRect()
  note('Свёрнутый сайдбар: кнопки не пересекаются', newBounds.top >= toggleBounds.bottom && newBounds.right <= sideBounds.right)
  const settingsBounds = $('openSettingsBtn').getBoundingClientRect()
  note('Настройки помещаются в свёрнутом сайдбаре', settingsBounds.right <= sideBounds.right)
  $('sidebarToggle').click()

  note('Кнопка подсказки удалена', !$('promptSuggestBtn'))
  const fastToggle = $('fastModeToggle')
  note('Fast находится в каталоге моделей', $('modelModal').contains(fastToggle))
  fastToggle.checked = true
  fastToggle.dispatchEvent(new Event('change', { bubbles: true }))
  note('Fast виден у модели и сохранён', $('pillEffortName').textContent === 'Fast' && localStorage.getItem('1code.fast-mode') === 'true')
  let booted = false
  let reportedDesignWidth = 0
  let reportedViewportWidth = 0
  let reportedViewportHeight = 0
  let designSizeReports = 0
  window.addEventListener('message', e => {
    if (e.source !== $('designPreviewFrame').contentWindow) return
    if (e.data?.type === '__dc_booted') booted = true
    if (e.data?.type === 'onecode-design-size') {
      designSizeReports++
      reportedDesignWidth = Number(e.data.width) || 0
      reportedViewportWidth = Number(e.data.viewportWidth) || 0
      reportedViewportHeight = Number(e.data.viewportHeight) || 0
    }
  })
  $('navDesign').click()
  await until(() => $('designView')?.classList.contains('active'))
  // Галерея по макету: строка «что нарисовать», полка из 13 форматов; формат
  // только выбирается, дизайн рождается из слов
  note('Строка «что нарисовать» и полка форматов', !!$('dsNewIn') && document.querySelectorAll('#designGallery .shelf-item').length === 13)
  document.querySelector('#designGallery .shelf-item[data-f="slides"]')?.click()
  note('Выбор формата ставит его, а не создаёт дизайн', $('designWorkspace').hidden && /1280 × 720/.test($('dsSize')?.textContent || ''))
  document.querySelector('#designGallery .shelf-item[data-f="blank"]')?.click()
  const askBox = $('dsNewIn')
  askBox.value = 'Создай тестовую страницу'
  askBox.dispatchEvent(new Event('input', { bubbles: true }))
  $('dsNewForm').requestSubmit()
  // Создание дизайна уходит в главный процесс и возвращается через IPC. Поле
  // ввода существует в разметке всегда, поэтому признаком служит не оно само, а
  // то, что оно оказалось на экране.
  const composerShown = await until(() => $('designComposerTextarea')?.offsetParent)
  note('Поле ввода дизайна открылось', composerShown)
  const box = $('designComposerTextarea')
  box.value = Array(12).fill('Проверка роста поля ввода').join('\n')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  note('Поле растёт', box.getBoundingClientRect().height > 130)
  box.value = ''
  box.dispatchEvent(new Event('input', { bubbles: true }))
  // Признак работающего хода — та же кнопка отправки в состоянии «стоп»:
  // отдельной кнопки «Остановить» в строке ввода больше нет, она налезала
  // на имя модели в узкой колонке.
  const running = () => $('designSendBtn').classList.contains('is-stop')
  let streamed = false
  for (let i = 0; i < 80; i++) {
    if (running() && $('designMessages').textContent.includes('Создаю основной экран')) streamed = true
    if (streamed && booted && !running()) break
    await wait(100)
  }
  note('Текст виден до завершения запроса', streamed)
  // Шторка «Задачи» открывается кнопкой в шапке переписки, сама не выезжает
  if (!$('tasksPanel')) document.querySelector('#designTaskActions .tasks-header-btn')?.click()
  await until(() => document.querySelector('#tasksPanel .ag'), 3000)
  note('В Design доступна общая панель агентов', !!document.querySelector('#tasksPanel .ag') && !!document.querySelector('#designTaskActions .tasks-header-btn'))
  document.querySelector('#tasksPanel .tasks-close')?.click()
  note('Панель Design закрывается', !$('tasksPanel'))
  document.querySelector('#designTaskActions .tasks-header-btn')?.click()
  note('Панель Design открывается повторно', !!$('tasksPanel'))
  // Законченный ход — свёрнутый блок с итогом; строки вызовов строятся при раскрытии
  document.querySelectorAll('#designMessages .thought-group').forEach(group => { group.open = true })
  await wait(300)
  note('Инструмент отображается общей строкой обычного чата', [...document.querySelectorAll('#designMessages .rail-verb')].some(n => n.textContent.includes('Записал макет')))
  note('Рассуждение использует общий сворачиваемый блок', document.querySelector('#designMessages details.think-row .think-chevron') && $('designMessages').textContent.includes('проверка хода мысли'))
  note('Значок инструмента совпадает с обычным чатом', document.querySelector('#designMessages .tool .rail-dot'))
  // Знак в подписи стал картинкой вместо геометрической фигуры, а проверка
  // всё ещё искала SVG. Смысл правила другой: в подписи есть знак
  // приложения, и именем модели не подписано само приложение.
  note('В подписи ответа нет бренда 1code',
    !!document.querySelector('#designMessages .msg-footer .agent-mark, #designMessages .msg-footer svg') &&
    !document.querySelector('#designMessages .cli-model')?.textContent.includes('1code'))
  const storedDesigns = await window.electronAPI.getDesigns()
  const storedAssistant = storedDesigns.flatMap(d => d.messages || []).find(m => m.role === 'assistant' && m.blocks?.some(b => b.kind === 'tool'))
  note('История рассуждений и инструментов сохранена', storedAssistant?.blocks.some(b => b.kind === 'thinking') && storedAssistant?.blocks.some(b => b.kind === 'text'))
  $('designBackBtn').click()
  await until(() => document.querySelector('#designList .ds-card'))
  const sizeReportsBeforeReopen = designSizeReports
  document.querySelector('#designList .ds-card')?.click()
  await until(() => document.querySelector('#designMessages .thought-group'))
  // Законченный ход — свёрнутый блок с итогом; строки вызовов строятся при раскрытии
  document.querySelectorAll('#designMessages .thought-group').forEach(group => { group.open = true })
  await wait(300)
  await until(() => document.querySelector('#designMessages .tool .rail-dot'))
  note('При повторном открытии сохранились блоки и значки', document.querySelector('#designMessages .tool .rail-dot') && document.querySelector('#designMessages .think-row .think-chevron'))
  let forgedPrompt = false
  const originalPrompt = window.prompt
  window.prompt = () => { forgedPrompt = true; return null }
  window.postMessage({ type: 'onecode-design-element-selected', element: 'forged' }, '*')
  window.postMessage({ type: 'onecode-design-comment', element: 'forged' }, '*')
  await wait(100)
  window.prompt = originalPrompt
  note('Постороннее сообщение не выбирает элемент и не открывает комментарий', !forgedPrompt && $('designPickedStrip').hidden)
  note('Настоящий движок загрузил страницу', booted)
  note('Выбрана основная страница', $('designPreviewName').textContent === 'Landing.dc.html')
  const previewFrame = $('designPreviewFrame')
  note('Панель устройств и процент масштаба отсутствуют',
    !$('designPreviewViewport') && !$('designPreviewZoom') && !document.querySelector('[data-design-viewport]'))
  const previewFittedAgain = await until(() => designSizeReports > sizeReportsBeforeReopen &&
    Boolean(previewFrame.style.width || previewFrame.offsetWidth) && reportedDesignWidth > 0)
  note('После повторного открытия превью сообщает размер и вписывается',
    previewFittedAgain, {reports: designSizeReports - sizeReportsBeforeReopen, width: reportedDesignWidth})
  const selectElement = $('designSelectElementBtn')
  const removeElement = $('designRemoveElementBtn')
  selectElement.click()
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'onecode-design-element-selected', element: 'button.primary — “Continue”', tplId: '7' },
    source: previewFrame.contentWindow
  }))
  note('Выбранный элемент показан отдельно и доступен для удаления',
    $('designSelectedElementName').textContent === 'button.primary — “Continue”' && !removeElement.disabled)
  removeElement.click()
  await until(() => $('confirmModal').style.display === 'flex')
  $('confirmCancelBtn').click()
  note('Удаление требует явного подтверждения', $('confirmModal').style.display !== 'flex')
  const previewPane = document.querySelector('.design-preview')
  const previewBar = document.querySelector('.design-preview-bar')
  const previousWidth = previewPane.style.width
  previewPane.style.width = '360px'
  await wait(80)
  const barBounds = previewBar.getBoundingClientRect()
  const controlsFit = [...previewBar.querySelectorAll('button')].every(button => {
    if (!button.getClientRects().length) return true
    const rect = button.getBoundingClientRect()
    return rect.left >= barBounds.left - 1 && rect.right <= barBounds.right + 1 &&
      rect.top >= barBounds.top - 1 && rect.bottom <= barBounds.bottom + 1
  })
  note('Узкая панель не обрезает кнопки превью', controlsFit && previewBar.scrollHeight <= previewBar.clientHeight + 1)
  note('Выбранный элемент виден в строке ввода',
    $('designSelectedElementName').getAttribute('aria-label') === 'button.primary — “Continue”')
  previewPane.style.width = previousWidth
  await wait(80)
  note('Чат не выделен в разделе Design', !document.querySelector('.history-item.active'))
  $('designMoreBtn').click()
  ;[...document.querySelectorAll('.mk .mi')].find(n => /В чат/.test(n.textContent))?.click()
  const destination = [...document.querySelectorAll('.ctx-item')].find(n => n.textContent.includes('Новый диалог'))
  note('Выбор места передачи доступен', destination)
  destination?.click()
  for (let i = 0; i < 50 && !$('composerTextarea').value.includes('Исходники и движок'); i++) await wait(100)
  note('Передача заполнила черновик', $('composerTextarea').value.includes('Landing.dc.html'))
  note('Передача не отправляет запрос сама', !$('chatFeed').textContent.includes('Используй дизайн'))
  await wait(600) // History persistence is intentionally debounced by 400ms.
  const chats = await window.electronAPI.getConversations()
  const serialized = JSON.stringify(chats)
  note('Копия исходников подключена к диалогу', serialized.includes('design-handoffs'))
  $('composerTextarea').value = Array(80).fill('Проверка открытия длинного диалога у последнего сообщения.').join('\n\n')
  $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()
  for (let i = 0; i < 80 && !document.querySelector('#chatFeed .msg-item.assistant .msg-actions'); i++) await wait(100)
  $('chatFeed').scrollTo({ top: 0, behavior: 'instant' })
  await wait(100)
  $('newChatBtn').click()
  const oldChat = [...document.querySelectorAll('.history-item')].find(n => n.textContent.includes('Проверка открытия'))
  oldChat?.querySelector('.history-item-title').click()
  const feed = $('chatFeed')
  // Лента открывается у последнего сообщения после отрисовки и прокрутки.
  await until(() => feed.scrollHeight > feed.clientHeight && feed.scrollTop > 0)
  note('Длинный чат открывается у последнего сообщения', oldChat && feed.scrollHeight > feed.clientHeight && feed.scrollHeight - feed.clientHeight - feed.scrollTop < 80,
    {found: Boolean(oldChat), height:feed.scrollHeight, viewport:feed.clientHeight, top:feed.scrollTop})
  $('composerTextarea').value = 'Мой незавершённый текст'
  fastToggle.checked = false
  fastToggle.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(100)
  note('Выключение Fast не меняет ввод', $('composerTextarea').value === 'Мой незавершённый текст')
  note('Обычная глубина восстановлена', $('pillEffortName').textContent !== 'Fast' && localStorage.getItem('1code.fast-mode') === 'false')
  $('navDesign').click()
  await until(() => $('designView')?.classList.contains('active'))
  return { ok: checks.every(c => c.pass), checks }
})()
