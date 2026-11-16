// Карточка задачи Дизайна в ленте чата (план, этап 4 «Чат + Дизайн») —
// настоящая оконная проверка.
//
// Один файл на четыре запуска: режим приходит base64-аргументом (`__ONECODE_ARG__`
// подставляет главный процесс, main.js:9360), как в соседнем
// `artifacts-state-renderer.js`. Снимок окно делает один в конце прогона,
// поэтому каждое состояние — отдельный запуск.
//
// Задача поднимается тем же путём, что в продукте: человек пишет просьбу в чат,
// ход идёт через обычного провайдера, а провайдер в этом прогоне дымовый и
// вызывает НАСТОЯЩИЙ инструмент `design_task` (main.js:11806-11822,
// `fixture.toolStream`). Отдельного канала «запустить задачу из окна» для
// прогона не заводили: второй вход в движок в обход прав хода проверял бы не то,
// что видит человек. Исполнитель локальный — `dc_scaffold`, `dc_write` и
// `dc_check` настоящие, платного вызова модели в прогоне быть не может.
(async () => {
  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')
  const mode = arg.mode || 'running'
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const until = async (fn, ms = 20000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch { /* состояние ещё не собрано */ }
      await wait(60)
    }
    return false
  }
  const TEXT = el => (el && (el.textContent || '')).replace(/\s+/g, ' ').trim()
  const decodeSrc = url => { try { return decodeURIComponent(String(url)) } catch { return String(url) } }
  const MARK = arg.marker || 'МИШЕНА-ОКНО'

  const ready = await until(() => document.documentElement.dataset.appReady === '1', 30000)
  note('окно сообщило о готовности', ready)
  if (!ready) return { ok: false, checks }

  const api = window.electronAPI || {}
  note('мост отдаёт подписку на прогресс задачи Дизайна', typeof api.onDesignTaskEvent === 'function',
    'канал: electronAPI.onDesignTaskEvent(cb)')
  if (typeof api.onDesignTaskEvent !== 'function') {
    note('проводки прогресса в мосту ещё нет — прогон красный по этой причине', false,
      'карточку честным путём получить нечем: дальше были бы только поддельные события')
    return { ok: false, checks }
  }

  // Прогресс пишется из настоящего канала: без пришедших событий прогон не
  // отличил бы честную карточку от нарисованной наугад.
  const events = []
  api.onDesignTaskEvent(payload => events.push(payload))

  // Настоящий диалог и настоящий ход: просьба уходит через форму чата, ответ
  // ведёт дымов провайдер с фикстурой.
  $('newChatBtn')?.click()
  await wait(300)
  const box = $('composerTextarea')
  note('есть поле ввода чата', Boolean(box))
  if (!box) return { ok: false, checks }
  // Просьба в чат НЕ содержит маркер: карточка ищется по тексту брифа, и
  // пузырь собственного сообщения человека нашёлся бы первым — прогон тогда
  // проверял бы не карточку, а эхо своей же строки ввода.
  box.value = 'Сделай макет по просьбе оконного прогона'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm')?.requestSubmit()

  // Карточка ищется по тексту задачи, а не по имени узла: контракт не фиксирует
  // классы, и проверка обязана видеть то, что видит человек.
  function cardEls () {
    const list = $('messagesList')
    if (!list) return []
    const top = [...list.children].filter(el => TEXT(el).includes(MARK))
    if (top.length) return top
    const hits = [...list.querySelectorAll('*')].filter(el => TEXT(el).includes(MARK))
    return hits.filter(el => !hits.includes(el.parentElement))
  }
  const cardTexts = () => cardEls().map(el => TEXT(el)).join(' || ')
  const framesOf = card => [...(card ? card.querySelectorAll('iframe') : [])]
  const openButtonOf = card => [...(card ? card.querySelectorAll('button') : [])]
    .find(el => /откры/i.test(TEXT(el) + ' ' + (el.getAttribute('aria-label') || '')) &&
      /дизайн/i.test(TEXT(el) + ' ' + (el.getAttribute('aria-label') || '')))

  const gotEvent = await until(() => events.length > 0, 40000)
  note('событие прогресса пришло из главного процесса', gotEvent,
    events.map(e => `${e.status}#${e.version} ${e.designId}`).join(', ') || 'ни одного события')
  const gotCard = await until(() => cardEls().length > 0, 15000)
  note('карточка задачи появилась в ленте чата', gotCard, cardTexts() || 'в #messagesList нет узла с текстом задачи')
  if (!gotCard) return { ok: false, checks }

  // --- «идёт»: состояние до финального события ---------------------------------
  if (mode === 'running') {
    // Снимок окно делает ПОСЛЕ возврата скрипта, значит вернуться надо в тот же
    // миг, когда карточка увидена без кадра: досидеть до финального события —
    // это снять уже «готово» и подписать его «идёт».
    let frameEarly = false
    let sawRunning = false
    let finished = false
    for (let i = 0; i < 120; i++) {
      const card = cardEls()[0]
      const frames = framesOf(card)
      finished = events.some(e => e.status === 'ready' || e.status === 'failed')
      if (card && frames.length && !finished) frameEarly = true
      if (card && !frames.length && !finished) { sawRunning = true; break }
      if (finished) break
      await wait(50)
    }
    const card = cardEls()[0]
    note('кадр не показан раньше времени', !frameEarly, frameEarly ? 'iframe появился до события ready/failed' : '')
    note('состояние «идёт» зафиксировано: карточка есть, кадра нет', sawRunning,
      `текст: ${TEXT(card || '')}`.slice(0, 200))
    note('в карточке «идёт» есть текст ожидания',
      /ожид|жд[её]м|ид[её]т\s|собир|созда|формир|печат|работ|провер/i.test(TEXT(card)), TEXT(card))
    // Снимок окно делает после возврата скрипта, поэтому карточку надо ещё и
    // показать: прокрутить в поле зрения и убедиться, что она в кадре экрана, а
    // не существует где-то под лентой. Иначе «состояние «идёт» снято» означает
    // только то, что лента была прокручена не туда.
    if (card && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'center' })
      await wait(150)
    }
    const rect = card && typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect() : null
    const onScreen = Boolean(rect) && rect.top >= -2 && rect.bottom <= (window.innerHeight || 0) + 2 && rect.height > 40
    note('карточка «идёт» видна на экране: она в поле зрения ленты', onScreen,
      rect ? `${Math.round(rect.top)}..${Math.round(rect.bottom)} при окне ${window.innerHeight}` : 'размеров нет')
    note('снимок сделан в состоянии «идёт»', sawRunning && framesOf(card).length === 0,
      `кадров: ${framesOf(card).length}, событий: ${events.length}, финал: ${finished}`)
    return { ok: checks.every(item => item.pass), checks }
  }

  // --- «ошибка»: отказ настоящего движка -----------------------------------------
  if (mode === 'failed') {
    // Отказ здесь настоящий: задача просит править макет, которого в реестре нет,
    // и движок обязан отказать до единой записи на диск.
    const failedSeen = await until(() => events.some(e => e.status === 'failed'), 60000)
    note('движок сообщил об отказе событием failed', failedSeen,
      events.map(e => e.status).join(', ') || 'ни одного события')
    await wait(400)
    const cards = cardEls()
    note('после отказа карточка осталась в ленте', cards.length === 1, `карточек: ${cards.length} — ${cardTexts()}`)
    const text = TEXT(cards[0])
    note('в карточке видна причина отказа словами',
      /[о-яa-z]{6,}/i.test(text) &&
      /ошибк|отказ|не вышло|не удал|не собрал|не получит|не сделан|сорв|не прош|прерван|слом|проверк|бит|некоррект|нет в реестре|провал/i.test(text), text)
    note('на отказе кадра нет', framesOf(cards[0]).length === 0, `кадров: ${framesOf(cards[0]).length}`)
    note('отказанная задача не названа выполненной',
      !/готов|успешн/i.test(TEXT(cards[0]).replace(/не\s+(будет\s+)?готов\w*/gi, '')), TEXT(cards[0]))
    note('в карточке нет служебного «undefined»', !/undefined|null/.test(text), text)
    return { ok: checks.every(item => item.pass), checks }
  }

  // --- «готово» и «открыть в дизайне»: готовый макет ----------------------------
  const readySeen = await until(() => events.some(e => e.status === 'ready'), 60000)
  const readyEvent = events.find(e => e.status === 'ready') || {}
  note('движок сообщил о готовности событием ready', readySeen,
    events.map(e => `${e.status}#${e.version}`).join(', ') || 'ни одного события')
  const frameShown = await until(() => framesOf(cardEls()[0]).length > 0, 15000)
  const card = cardEls()[0]
  const frames = framesOf(card)
  note('кадр превью появился после ready', frameShown, `кадров: ${frames.length}`)
  if (!frameShown) return { ok: false, checks }

  const designId = String(readyEvent.designId || '')
  const src = frames[0].getAttribute('src') || ''
  note('кадр указывает на превью этого макета', Boolean(designId) && src.startsWith(`onecode-design://${designId}/`),
    `${src} при designId=${designId}`)
  const listed = await api.designComponents(designId).catch(() => null)
  // Канал отдаёт `{ ok, components, entry }`, а не голый список.
  const components = Array.isArray(listed?.components) ? listed.components : []
  note('макт действительно появился в хранилище Дизайна', components.length > 0, components.join(', '))
  const componentNamed = components.some(name => decodeSrc(src).includes(name))
  note('в адресе кадра есть имя компонента', componentNamed, `${src} при компонентах ${components.join(', ')}`)
  note('у адреса кадра есть «свежий» параметр', /\?[^\s]*=/i.test(src), src)
  note('кадр изолирован: sandbox ровно allow-scripts',
    (frames[0].getAttribute('sandbox') || '') === 'allow-scripts',
    `sandbox="${frames[0].getAttribute('sandbox') || ''}"`)

  // Кадр обязан и загрузиться: снимок окно делает после возврата скрипта, и
  // пустой прямоугольник на нём — это не «проверка прошла», а «не успели».
  const painted = await new Promise(resolve => {
    const frame = frames[0]
    if (!frame) return resolve(false)
    let done = false
    const finish = value => { if (!done) { done = true; resolve(value) } }
    frame.addEventListener('load', () => finish(true), { once: true })
    frame.addEventListener('error', () => finish(false), { once: true })
    setTimeout(() => finish(false), 8000)
  })
  note('кадр загрузился: событие load на самом деле было', painted, `src=${src.slice(0, 70)}`)
  await wait(400)
  note('версия показана в карточке', /верс|v\.?\s*\d|№\s*\d|сборк/i.test(TEXT(card)), TEXT(card))

  const openButton = openButtonOf(card)
  note('кнопка «Открыть в Дизайне» есть и это button type="button"',
    Boolean(openButton) && openButton.tagName === 'BUTTON' && openButton.getAttribute('type') === 'button',
    openButton ? `${openButton.tagName} type=${openButton.getAttribute('type')} · ${TEXT(openButton)}` : `кнопки нет: ${TEXT(card)}`)

  if (mode === 'open') {
    if (!openButton) return { ok: false, checks }
    // До клика мы обязаны быть в ленте чата: иначе «перенесло в Дизайн» было бы
    // верно само по себе, ещё до нажатия.
    note('до клика открыт чат, а не рабочее место Дизайна',
      $('designView')?.classList.contains('active') !== true && $('chatView')?.classList.contains('active') === true,
      `chatView активен=${$('chatView')?.classList.contains('active')}, designView активен=${$('designView')?.classList.contains('active')}`)
    openButton.click()
    // Слушатель ставится ДО клика: событие load у рабочего кадра может пройти
    // между нажатием и первой проверкой, и тогда снимок снова вышел бы пустым,
    // а проверка — зелёной.
    const workspace = $('designPreviewFrame')
    const workspaceLoaded = new Promise(resolve => {
      if (!workspace) return resolve(false)
      let done = false
      const finish = value => { if (!done) { done = true; resolve(value) } }
      workspace.addEventListener('load', () => finish(true), { once: true })
      workspace.addEventListener('error', () => finish(false), { once: true })
      setTimeout(() => finish(false), 9000)
    })
    const opened = await until(() => $('designView')?.classList.contains('active') &&
      $('designWorkspace') && !$('designWorkspace').hidden, 15000)
    note('клик по кнопке перенёс в рабочую область Дизайна', opened,
      `designView активен=${$('designView')?.classList.contains('active')}, hidden=${$('designWorkspace') ? $('designWorkspace').hidden : 'нет узла'}`)
    const workspaceSrc = $('designPreviewFrame')?.getAttribute('src') || ''
    // Тот же макет по адресу — не обязательно тот же компонент: рабочее место
    // открывает входной файл, а карточка показывает собранный.
    note('клик открыл тот же макет, чей кадр показан в карточке',
      workspaceSrc.startsWith(`onecode-design://${designId}/`) && src.startsWith(`onecode-design://${designId}/`),
      `карточка: ${src} · рабочее место: ${workspaceSrc}`)
    // Заглушка «здесь появится макет» под открытым превью значит, что рабочее
    // место макета не увидело, — адрес в кадре сам по себе этого не доказывает.
    const empty = $('designPreviewEmpty')
    note('рабочее место Дизайна показывает макет, а не заглушку',
      Boolean(empty) && empty.hidden !== false,
      empty && empty.hidden !== true ? TEXT(empty) : 'заглушка скрыта')
    const workspacePainted = await workspaceLoaded
    const box = workspace ? workspace.getBoundingClientRect() : { width: 0, height: 0 }
    note('кадр рабочего места загрузился и занимает место на экране',
      workspacePainted && box.width > 100 && box.height > 100,
      `load=${workspacePainted}, кадр ${Math.round(box.width)}×${Math.round(box.height)}`)
    // Снимок окно делает после возврата скрипта: даём странице отрисоваться.
    await wait(500)
  } else {
    // Снимок состояния «готово» не должен содержать открытое рабочее место.
    note('лента чата с готовой карточкой осталась на экране',
      !$('messagesList').hidden && Boolean(card), cardTexts().slice(0, 200))
  }

  return { ok: checks.every(item => item.pass), checks }
})()
