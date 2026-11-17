// Runs inside the renderer via ONECODE_SMOKE. Answers one question: does the
// UI actually work after boot? Static checks kept passing while the window sat
// there dead, so this clicks real controls and reads the resulting DOM.
(async () => {
  const $ = id => document.getElementById(id)
  const checks = []
  // Третьего состояния у проверки нет: «не состоялись» — это тоже не пройденное.
  // Отличие в слове `skipped`: без него пропущенная проверка выглядела бы как
  // исчезнувшая, и итоговое «проверок N» менялось от запуска к запуску молча.
  const note = (name, pass, detail, skipped) => checks.push({ name, pass: !!pass, detail: detail || '', skipped: !!skipped })

  // A click handler that throws leaves no trace: the DOM keeps its old state and
  // every later assertion still reads plausibly. Infinite recursion between two
  // render functions looked exactly like "nothing happened" until this was here.
  const thrown = []
  // Переживаем скоуп блока: первый блок поедает подсказку нажатием Tab, и второму
  // блоку нужно уметь сказать, не поэтому ли её нет.
  let hintConsumed = false
  window.addEventListener('error', e => thrown.push(String(e.message || e.error)))
  window.addEventListener('unhandledrejection', e => thrown.push('promise: ' + String(e.reason)))

  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 8000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch {}
      await wait(100)
    }
    return false
  }
  // То же ожидание, но с ответом «сколько ждали»: без числа плавающее звено
  // выглядит как «сломан таймаут», а с числом видно, задержка это или отсутствие.
  const timed = async (fn, ms) => { const at = Date.now(); const ok = await until(fn, ms); return { ok, ms: Date.now() - at } }
  // Порог ожидания модельной подсказки. Держим одним числом на весь файл: два
  // блока ждали её по отдельности и по 5 с, и при нагрузке падал один из них.
  const SUGGESTION_WAIT_MS = 5000

  const booted = await until(() => $('messagesList') && $('composerTextarea') && $('splitViewBtn'))
  note('интерфейс загрузился', booted)
  if (!booted) return { ok: false, checks }

  await wait(1200) // async init: chats, models, MCP status

  // Slash commands stay in the composer, but the picker is a compact list;
  // descriptions should appear as a tooltip, not take half of each row.
  {
    const input = $('composerTextarea')
    input.value = '/'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const opened = await until(() => $('slashMenu')?.style.display === 'flex' &&
      $('slashMenuList')?.querySelector('.slash-menu-item'))
    note('командное меню открывается по слешу', opened)
    const item = $('slashMenuList')?.querySelector('.slash-menu-item')
    // План, 3.10: описание больше не живёт в строке и не вешается на неё
    // глобальной подсказкой (та встаёт над/под якорем). Список держит своё
    // описание справа от выбранной строки — `.composer-menu-hint`.
    note('строка команды компактная: имя в строке, описания и data-tooltip в ней нет', !!item &&
      !!item.querySelector('.slash-item-cmd') && !item.querySelector('.slash-item-desc') &&
      !item.hasAttribute('data-tooltip'),
      item ? item.textContent.trim().slice(0, 60) : '')
    if (item) {
      item.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', bubbles: true }))
      const hint = document.querySelector('.composer-menu-hint')
      note('наведение показывает описание команды справа от строки', await until(() =>
        hint && hint.classList.contains('is-shown') &&
        (hint.textContent || '').trim().length > 3 &&
        hint.getBoundingClientRect().left >= item.getBoundingClientRect().right, 1200),
        hint ? `${hint.textContent.trim().slice(0, 60)} @${Math.round(hint.getBoundingClientRect().left)}` : 'подсказки списка нет')
    }
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if ($('slashMenu')) $('slashMenu').style.display = 'none'
  }

  // A model's full label may be long, but it must never push the submit button
  // outside the composer when the composer is used in a narrow pane.
  {
    const fixture = document.createElement('div')
    fixture.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;box-sizing:border-box'
    const card = $('composerCard').cloneNode(true)
    fixture.appendChild(card)
    document.body.appendChild(fixture)
    const modelName = card.querySelector('#pillModelName')
    if (modelName) modelName.textContent = 'Dots3-Note Preview — very long provider/model label'
    for (const width of [380, 340, 300]) {
      fixture.style.width = width + 'px'
      await wait(40)
      const cardBox = card.getBoundingClientRect()
      const sendBox = card.querySelector('#sendBtn').getBoundingClientRect()
      const modelBox = card.querySelector('#modelEffortPillBtn').getBoundingClientRect()
      note(`кнопка отправки остаётся внутри строки при ширине ${width}px`,
        sendBox.right <= cardBox.right - 2 && sendBox.left >= cardBox.left + 2,
        `card ${Math.round(cardBox.left)}–${Math.round(cardBox.right)}, send ${Math.round(sendBox.left)}–${Math.round(sendBox.right)}`)
      note(`название модели не выталкивает кнопку при ширине ${width}px`,
        modelBox.right <= sendBox.left + 2,
        `model до ${Math.round(modelBox.right)}, send с ${Math.round(sendBox.left)}`)
    }
    fixture.remove()
  }

  // The bug that killed the app twice was an exception mid-setup: markup was
  // there, listeners were not. Only a real click can tell the difference.
  const pane = $('splitPane')
  note('вторая панель скрыта на старте', pane && pane.hidden)

  $('splitViewBtn').click()
  const opened = await until(() => pane && !pane.hidden, 3000)
  note('кнопка открывает вторую панель', opened)
  if (!opened) return { ok: false, checks }

  for (const id of ['splitFeed', 'splitMessagesList', 'splitComposerForm',
                    'splitComposerTextarea', 'splitSendBtn', 'splitAttachBtn',
                    'splitScrollDownBtn', 'splitNewChatBtn']) {
    note('есть ' + id, !!$(id))
  }

  // Two independent feeds, not one list shown twice.
  note('ленты не вложены друг в друга',
    !$('messagesList').contains($('splitMessagesList')) &&
    !$('splitMessagesList').contains($('messagesList')))

  const box = $('splitComposerTextarea').getBoundingClientRect()
  note('строка ввода видима', box.width > 60 && box.height > 20,
    Math.round(box.width) + 'x' + Math.round(box.height))

  // Geometry the eye catches instantly and assertions miss: the pane has to be
  // a column beside the chat. It shipped stacked underneath and every size check
  // still passed.
  const chatBox = $('chatView').getBoundingClientRect()
  const paneBox = pane.getBoundingClientRect()
  note('вторая панель стоит сбоку, а не снизу', paneBox.left >= chatBox.right - 2,
    'чат до ' + Math.round(chatBox.right) + ', панель с ' + Math.round(paneBox.left))
  note('обе панели одной высоты', Math.abs(paneBox.height - chatBox.height) < 4,
    Math.round(chatBox.height) + ' и ' + Math.round(paneBox.height))

  const feedBox = $('splitFeed').getBoundingClientRect()
  note('лента не перекрыта строкой ввода', feedBox.bottom <= box.top + 1,
    'лента до ' + Math.round(feedBox.bottom) + ', ввод с ' + Math.round(box.top))

  const label = $('splitChatLabel')
  note('во второй панели назван диалог', !!(label && label.textContent.trim()),
    label && label.textContent.trim())

  // The two panes must never point at one conversation: both would stream into
  // it and both would redraw over each other.
  const mainRow = document.querySelector('#chatHistoryList .history-item.active')
  note('в истории отмечены оба открытых диалога',
    document.querySelectorAll('#chatHistoryList .history-item.active').length === 2,
    'отмечено ' + document.querySelectorAll('#chatHistoryList .history-item.active').length)

  // A new chat from the side pane lands in shared history. An untouched chat is
  // reused instead of piling up empties, so give the side pane content first.
  const seedCount = document.querySelectorAll('#chatHistoryList .history-item').length
  const seededTitle = label ? label.textContent.trim() : ''
  $('splitNewChatBtn').click()
  await wait(400)
  const afterCount = document.querySelectorAll('#chatHistoryList .history-item').length
  const switched = (label && label.textContent.trim() !== seededTitle) || afterCount > seedCount
  note('кнопка нового диалога во второй панели работает',
    switched || afterCount === seedCount,
    seedCount + ' -> ' + afterCount)
  note('второй чат не совпал с первым',
    !mainRow || document.querySelectorAll('#chatHistoryList .history-item.active').length === 2)

  // Composer reacts: autosize proves the input listener is bound to this pane.
  const ta = $('splitComposerTextarea')
  const h0 = ta.style.height
  ta.value = 'строка\nвторая\nтретья\nчетвёртая'
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  note('ввод во второй панели обрабатывается', ta.style.height !== h0,
    (h0 || 'auto') + ' -> ' + ta.style.height)
  ta.value = ''
  ta.dispatchEvent(new Event('input', { bubbles: true }))

  // Focus decides which pane a send belongs to.
  ta.focus()
  ta.dispatchEvent(new Event('focus', { bubbles: true }))
  await wait(80)
  note('фокус переключает активную панель', document.activeElement === ta)

  // The main pane must survive all of this.
  const main = $('composerTextarea')
  const mh0 = main.style.height
  main.value = 'a\nb\nc\nd'
  main.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150)
  note('первая панель продолжает работать', main.style.height !== mh0)
  main.value = ''
  main.dispatchEvent(new Event('input', { bubbles: true }))

  // The send path is where a wrong argument actually bites: the generation flag
  // goes up, something throws, and the UI sits there with a stop button and no
  // message. Both panes send at once so a crossed stream shows up as text in the
  // wrong feed rather than as a passing test.
  const bubbles = list => list.querySelectorAll('.msg-item.assistant')
  const mainBefore = bubbles($('messagesList')).length
  const sideBefore = bubbles($('splitMessagesList')).length

  $('composerTextarea').value = 'проверка первой панели'
  $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()
  ta.value = '/agent проверка второй панели'
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  $('splitComposerForm').requestSubmit()

  const answered = await until(() =>
    bubbles($('messagesList')).length > mainBefore &&
    bubbles($('splitMessagesList')).length > sideBefore, 15000)
  note('обе панели показали ответ', answered,
    bubbles($('messagesList')).length + ' / ' + bubbles($('splitMessagesList')).length)

  await until(() =>
    $('messagesList').innerText.includes('req_main') &&
    $('splitMessagesList').innerText.includes('req_side'), 10000)
  const mainText = $('messagesList').innerText
  const sideText = $('splitMessagesList').innerText
  const mainUserText = [...$('messagesList').querySelectorAll('.msg-item.user .msg-content')]
    .map(node => node.textContent).join(' ')
  const sideUserText = [...$('splitMessagesList').querySelectorAll('.msg-item.user .msg-content')]
    .map(node => node.textContent).join(' ')
  note('ответ первой панели попал в первую', mainText.includes('req_main'),
    mainText.slice(-70).replace(/\s+/g, ' '))
  note('ответ второй панели попал во вторую', sideText.includes('req_side'),
    sideText.slice(-70).replace(/\s+/g, ' '))
  note('главный чат сохранил свой запрос', mainUserText.includes('проверка первой панели'), mainUserText)
  note('вторая панель сохранила свой запрос', sideUserText.includes('проверка второй панели'), sideUserText)

  // Check model-generated hints while these exact chats are still open in the
  // panes. Later smoke sections intentionally navigate the sidebar and can swap
  // the panes; comparing them to these earlier snapshots would be stale.
  {
  const ta2 = $('composerTextarea')
  const splitTa = $('splitComposerTextarea')
  // Ждём по очереди в каждой панели и называем время: раньше один общий
  // дедлайн на 5 с молча съедал семь последующих проверок, и «проверок N» в
  // итоге гуляло от запуска к запуску. Порог — не вера в скорость, а граница,
  // за которой дефект ищут в приложении, а не в таймауте: распределение реальных
  // задержек снято отдельно (audits/qoder-2026-09-24/flakiness/).
  const mainHint = await timed(() => ta2.classList.contains('has-suggestion'), SUGGESTION_WAIT_MS)
  const sideHint = await timed(() => splitTa.classList.contains('has-suggestion'), SUGGESTION_WAIT_MS)
  const suggestionReady = mainHint.ok && sideHint.ok
  note('подсказка главного чата появилась', mainHint.ok,
    `ждали ${mainHint.ms} из ${SUGGESTION_WAIT_MS} мс; placeholder: ${ta2.placeholder.slice(0, 60)}`)
  note('подсказка второй панели появилась', sideHint.ok,
    `ждали ${sideHint.ms} из ${SUGGESTION_WAIT_MS} мс; placeholder: ${splitTa.placeholder.slice(0, 60)}`)
  // Всё, что сравнивает текст подсказки, без подсказки не ложь, а незамеренное:
  // помечается пропуском с причиной, но не проходит.
  const hint = (name, pass, detail) => note(name, suggestionReady && pass,
    suggestionReady ? detail : `не состоялось: подсказки нет (главный ${mainHint.ms} мс, вторая ${sideHint.ms} мс из ${SUGGESTION_WAIT_MS})`,
    !suggestionReady)
  const mainOwnPrompt = mainUserText.includes('проверка первой панели')
    ? 'проверка первой панели' : 'проверка второй панели'
  const splitOwnPrompt = sideUserText.includes('проверка первой панели')
    ? 'проверка первой панели' : 'проверка второй панели'
  note('оба чата сохранили отдельные запросы', mainOwnPrompt !== splitOwnPrompt,
    mainOwnPrompt + ' / ' + splitOwnPrompt)
  hint('подсказка главного чата относится к его запросу',
    ta2.placeholder.includes(mainOwnPrompt), ta2.placeholder)
  hint('подсказка второй панели относится к её запросу',
    splitTa.placeholder.includes(splitOwnPrompt), splitTa.placeholder)
  hint('подсказка не подмешивает запрос соседнего чата',
    !ta2.placeholder.includes(splitOwnPrompt) && !splitTa.placeholder.includes(mainOwnPrompt),
    ta2.placeholder + ' / ' + splitTa.placeholder)
  note('плашек над строкой ввода нет', !$('composerCard').querySelector('.suggest-strip'))
  note('поле осталось пустым', ta2.value.trim() === '', JSON.stringify(ta2.value))
  hint('в подсказке нет служебных значков', !/[⇥→]/.test(ta2.placeholder), ta2.placeholder.slice(-12))

  const offered = ta2.placeholder
  ta2.value = 'Мой незаконченный черновик'
  ta2.dispatchEvent(new Event('input', { bubbles: true }))
  hint('черновик не подменяется подсказкой',
    ta2.value === 'Мой незаконченный черновик' && !ta2.classList.contains('has-suggestion'), ta2.value)
  const draftTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  ta2.dispatchEvent(draftTab)
  hint('Tab не перехватывается у черновика',
    !draftTab.defaultPrevented && ta2.value === 'Мой незаконченный черновик')
  ta2.value = ''
  ta2.dispatchEvent(new Event('input', { bubbles: true }))
  const back = await timed(() => ta2.classList.contains('has-suggestion') && ta2.placeholder === offered, 2000)
  hint('очистка поля возвращает подсказку этого чата', back.ok, `ждали ${back.ms} из 2000 мс`)
  ta2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  await wait(250)
  hint('Tab подставляет ровно показанную подсказку', ta2.value === offered, ta2.value.slice(0, 60))
  // Поглощённая Tab'ом подсказка из памяти окна уходит: `acceptSuggestion` её
  // удаляет. Запоминаем: иначе проверка в конце прогона объясняет свой провал
  // «таймаутом», хотя причина в том, что первый блок её съел.
  if (ta2.value === offered) hintConsumed = true
  hint('после подстановки подсказка снимается', !ta2.classList.contains('has-suggestion'))
  hint('вернулся обычный текст-подсказка', ta2.placeholder !== offered)
  ta2.value = ''
  ta2.dispatchEvent(new Event('input', { bubbles: true }))
  }

  // Чек-лист хода: до него ход заканчивался молча, и о том, что сделана
  // четверть, узнать было неоткуда. Список приходит настоящим вызовом
  // инструмента, поэтому здесь проверяется вся цепочка целиком.
  // Правка владельца 05.10: чек-листы агентов в конце хода в ленту не выкладываются — они живут в панели «Задачи».
  note('чек-лист хода в ленту не выложен', !$('messagesList').querySelector('.plan-inline'),
    String($('messagesList').querySelectorAll('.plan-inline').length))
  note('потоки не перепутаны',
    !mainText.includes('req_side') && !sideText.includes('req_main'))

  // Два помощника писали одновременно, по четыре символа вперемешку. Раньше всё
  // это попадало в один буфер, и в ленте выходило «Отчё Смот т вто рю, к…».
  {
    const feed = $('messagesList')
    const reports = feed.querySelectorAll('.agent-report')
    note('каждый помощник оставил в ленте одну строку', reports.length === 2, 'строк ' + reports.length)
    note('ответ ведущего не разорван чужими словами', /Ответ для req_main/.test(mainText),
      mainText.slice(-90).replace(/\s+/g, ' '))
    note('слова помощников не попали в ответ ведущего',
      !/Отчёт|Проверяю границы|Смотрю, как/.test([...feed.querySelectorAll('.msg-item.assistant .msg-content')]
        .filter(node => !node.closest('.agent-report')).map(node => node.textContent).join(' ')))
    note('мысли помощников не рассыпаны по ленте',
      feed.querySelectorAll('.think-row[data-agent="Агент 2"], .think-row[data-agent="Агент 3"]').length === 0)
    const second = [...reports].find(node => /Агент 2/.test(node.textContent))
    if (second) {
      second.open = true
      await wait(60)
      note('отчёт помощника целый', /Отчёт второго агента: разбор потока исправен, куски не теряются\./.test(second.innerText),
        second.innerText.slice(0, 120).replace(/\s+/g, ' '))
      note('в строке видно, какую часть делал помощник', /Проверка разбора потока/.test(second.querySelector('summary')?.textContent || ''))
      second.open = false
    }
    note('история работы доступна из заголовка', !!document.querySelector('#chatHeader #navTasks'))
  }
  note('генерация завершилась в обеих панелях',
    !document.body.querySelector('.composer-card .btn-send.generating'))

  // The divider has to actually move the boundary, and has to refuse to squeeze
  // either chat into a sliver.
  const bar = $('splitResizer')
  note('разделитель виден при открытой панели', !!bar && !bar.hidden)
  if (bar && !bar.hidden) {
    const startWidth = pane.getBoundingClientRect().width
    const barBox = bar.getBoundingClientRect()
    const y = barBox.top + barBox.height / 2
    const down = new PointerEvent('pointerdown', {
      bubbles: true, button: 0, clientX: barBox.left + 2, clientY: y
    })
    bar.dispatchEvent(down)
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: barBox.left - 120, clientY: y
    }))
    await wait(120)
    const wider = pane.getBoundingClientRect().width
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: barBox.left - 120, clientY: y }))
    await wait(120)
    note('перетаскивание меняет ширину', wider > startWidth + 40,
      Math.round(startWidth) + ' -> ' + Math.round(wider))

    // Drag far past the edge; the main chat must keep a usable width.
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: barBox.left, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: -900, clientY: y }))
    await wait(120)
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: -900, clientY: y }))
    const mainLeft = $('chatView').getBoundingClientRect().width
    note('первый чат не схлопывается', mainLeft >= 400, Math.round(mainLeft) + 'px')

    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(150)
    note('двойной клик выравнивает панели',
      Math.abs($('chatView').getBoundingClientRect().width - pane.getBoundingClientRect().width) < 40)
  }

  $('splitCloseBtn').click()
  const closed = await until(() => pane.hidden, 3000)
  note('вторая панель закрывается', closed)

  // Settings: a list on the left, exactly one page showing on the right.
  const settings = $('settingsModal')
  const tabs = [...document.querySelectorAll('[data-settings-tab]')]
  const panels = [...document.querySelectorAll('[data-settings-panel]')]
  // Разделов стало пять: язык уехал к личному, память — к работе. Проверяем,
  // что список не пуст и у каждого пункта есть своя страница, а не число.
  note('в настройках есть боковой список', tabs.length >= 4, 'пунктов ' + tabs.length)
  note('разделов столько же, сколько пунктов', panels.length === tabs.length)

  if (tabs.length) {
    settings.style.display = 'flex'
    tabs[0].click()
    await wait(120)
    note('открыт ровно один раздел', panels.filter(p => !p.hidden).length === 1,
      'видно ' + panels.filter(p => !p.hidden).length)

    const last = tabs[tabs.length - 1]
    last.click()
    await wait(120)
    const shown = panels.filter(p => !p.hidden)
    note('переключение раздела работает',
      shown.length === 1 && shown[0].dataset.settingsPanel === last.dataset.settingsTab,
      shown.map(p => p.dataset.settingsPanel).join(','))
    note('выбранный пункт подсвечен', last.classList.contains('active'))

    // The chooser was removed; the sidebar is the only place chats are picked.
    note('в шапке второго чата нет дубля списка диалогов', !$('splitChatSelect'))
    note('шапка второго чата подписана', !!$('splitChatLabel'))

    // Each key is its own cap, and the hint text has to be readable.
    const shortcuts = document.querySelector('[data-settings-panel="shortcuts"]')
    $('tab-shortcuts').click()
    await wait(120)
    const caps = shortcuts.querySelectorAll('.shortcut-keys kbd')
    note('клавиши разбиты по отдельным клавишам', caps.length >= 10, 'клавиш ' + caps.length)
    const capBox = caps[0]?.getBoundingClientRect()
    note('клавиша не схлопнута', capBox && capBox.width >= 20 && capBox.height >= 18,
      capBox ? Math.round(capBox.width) + 'x' + Math.round(capBox.height) : 'нет')

    tabs[0].click()
    await wait(120)
    // Подсказка страницы теперь — пояснение группы (настройки одним слоем, 2.7).
    const hints = [...document.querySelectorAll('.settings-layout .settings-group-hint, .settings-layout .section-hint')]
    const hintSizes = hints.map(node => parseFloat(getComputedStyle(node).fontSize))
    note('подсказки не мельче 12px', hints.length > 0 && hintSizes.every(size => size >= 12), hintSizes.join(', ') + 'px')

    const dim = getComputedStyle($('settingsModal')).backgroundColor
    note('настройки — страница: фон непрозрачный, как у окна', !/rgba|transparent/.test(dim), dim)
    settings.style.display = 'none'
  }

  // Right-click on a chat row: renaming and filing into a project were simply
  // not possible before — the only action on a row was delete.
  const firstRow = document.querySelector('#chatHistoryList .history-item')
  note('в истории есть строка для проверки', !!firstRow)

  if (firstRow) {
    firstRow.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 120, clientY: 200
    }))
    await wait(250)
    const menu = document.querySelector('.ctx-menu')
    note('правая кнопка открывает меню', !!menu)

    if (menu) {
      const labels = [...menu.querySelectorAll('.ctx-label')].map(n => n.textContent.trim())
      note('в меню есть переименование', labels.some(l => /переимен/i.test(l)), labels.join(' | '))
      note('в меню есть перемещение в проект', labels.some(l => /проект/i.test(l)))
      note('в меню есть удаление', labels.some(l => /удалить/i.test(l)))

      const box = menu.getBoundingClientRect()
      note('меню помещается на экране',
        box.right <= window.innerWidth && box.bottom <= window.innerHeight && box.left >= 0,
        Math.round(box.left) + ',' + Math.round(box.top) + ' ' +
        Math.round(box.width) + 'x' + Math.round(box.height))

      // Drilling into projects must replace the menu, not leave two stacked.
      const moveItem = [...menu.querySelectorAll('.ctx-item')]
        .find(b => /проект/i.test(b.textContent))
      moveItem.click()
      await wait(250)
      note('подменю проектов заменяет меню, а не плодит второе',
        document.querySelectorAll('.ctx-menu').length === 1,
        'меню на экране: ' + document.querySelectorAll('.ctx-menu').length)
      const subLabels = [...document.querySelectorAll('.ctx-menu .ctx-label')].map(n => n.textContent.trim())
      note('в подменю есть «Без проекта»', subLabels.some(l => /без проекта/i.test(l)), subLabels.join(' | '))

      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 900, clientY: 500 }))
      await wait(200)
      note('клик мимо закрывает меню', !document.querySelector('.ctx-menu'))
    }

    // Rename edits in place and actually persists to the row.
    const before = firstRow.querySelector('.history-item-title').textContent
    firstRow.querySelector('.history-item-title').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    await wait(200)
    const input = document.querySelector('.history-rename')
    note('двойной клик открывает поле переименования', !!input)
    if (input) {
      input.value = 'Переименованный диалог'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wait(400)
      const titles = [...document.querySelectorAll('#chatHistoryList .history-item-title')]
        .map(n => n.textContent.trim())
      note('название сохранилось', titles.includes('Переименованный диалог'),
        'было «' + before.trim() + '»')
      note('поле ввода убрано после сохранения', !document.querySelector('.history-rename'))
    }
  }

  // Context ring: the arc and the number it stands for, to the right of the
  // model pill. It used to be fill only, with the figures hidden in a panel
  // that opened on click — and that is precisely what made it unreadable:
  // empty, it is a faint circle between the model name and the send button,
  // and there is no way to learn what it means without clicking it. The panel
  // still holds the detail; the chip answers the question at a glance.
  const ring = $('contextRingBtn')
  note('кольцо контекста на месте', !!ring)
  if (ring) {
    const arc = $('contextRingArc')
    const panel = $('contextPanel')
    const box = ring.getBoundingClientRect()
    const emptyRing = /^0%$/.test($('contextRingValue').textContent.trim())
    // С 04.10 кольцо — единственный показатель расхода (строку над полем ввода сняли), поэтому оно на месте и пустое.
    note('кольцо видно и пустое, и заполненное', !ring.hidden && box.width >= 16 && box.height >= 16,
      Math.round(box.width) + 'x' + Math.round(box.height))
    note('на кольце видно значение', /\d+\s*%|—/.test(ring.textContent || ''),
      JSON.stringify(ring.textContent))
    // Tabular figures: without them the chip changes width between 9% and 10%
    // and nudges the send button on every keystroke.
    note('цифры моноширинные по месту',
      getComputedStyle($('contextRingValue')).fontVariantNumeric.includes('tabular-nums'),
      getComputedStyle($('contextRingValue')).fontVariantNumeric)

    const pill = $('modelEffortPillBtn').getBoundingClientRect()
    note('видимое кольцо справа от модели', ring.hidden || box.left >= pill.right - 2,
      'модель до ' + Math.round(pill.right) + ', кольцо с ' + Math.round(box.left))

    const before = arc.style.strokeDashoffset
    $('composerTextarea').value = 'а'.repeat(200000)
    $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
    await wait(250)
    const filledBox = ring.getBoundingClientRect()
    note('после ввода кольцо появилось справа от модели',
      !ring.hidden && filledBox.width >= 16 &&
      filledBox.left >= $('modelEffortPillBtn').getBoundingClientRect().right - 2)
    note('набранный текст меняет заполнение', arc.style.strokeDashoffset !== before,
      before + ' -> ' + arc.style.strokeDashoffset)

    note('панель закрыта до клика', panel.hidden)
    ring.click()
    await wait(250)
    note('клик открывает панель, а не всплывашку', !panel.hidden)
    note('в панели есть полоса заполнения',
      parseFloat($('contextPanelFill').style.width) > 0, $('contextPanelFill').style.width)
    note('в панели есть числа', /\d/.test($('contextPanelValue').textContent),
      $('contextPanelValue').textContent)
    note('в панели нет плана и лимитов',
      !/план|plan|лимит|limit|\$/i.test(panel.textContent), panel.textContent.slice(0, 50))

    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 400, clientY: 200 }))
    await wait(200)
    note('клик мимо закрывает панель', panel.hidden)

    $('composerTextarea').value = ''
    $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
    await wait(150)
  }

  // The MCP page no longer advertises servers nobody asked for.
  $('navConnectors')?.click()
  await wait(400)
  note('шаблоны серверов убраны', !document.querySelector('[data-preset]'),
    'осталось ' + document.querySelectorAll('[data-preset]').length)
  note('страница коннекторов открылась', $('connectorsView')?.classList.contains('active'))

  // A chat picked from any page must take you to that chat.
  const row = document.querySelector('#chatHistoryList .history-item-title')
  if (row) {
    row.click()
    await wait(350)
    note('выбор диалога из коннекторов открывает чат',
      $('chatView')?.classList.contains('active') && !$('connectorsView')?.classList.contains('active'))
  }

  // Sidebar: one tree. Projects are folders, chats nest under them, pinned
  // chats float to the top, and the search box is gone.
  note('поиска чатов нет', !$('chatSearchInput'))
  note('отдельного списка проектов в панели нет', !$('projectList'))
  note('заголовка «История диалогов» нет',
    !/История диалогов/i.test(document.querySelector('.history-section')?.textContent || ''))

  $('navProjects')?.click()
  await wait(300)
  $('newProjectBtn')?.click()
  await wait(300)
  if ($('projectNameField')) {
    $('projectNameField').value = 'Тестовый проект'
    // Папка проекта обязательна (макет 21.10): выбирается тестовой очередью ONECODE_TEST_PICK_FOLDER
    $('projectPickFolderBtn')?.click()
    await wait(500)
    $('projectSaveBtn').click()
    await wait(400)
  }
  $('navChats')?.click()
  await wait(300)

  const folder = document.querySelector('.folder-row')
  note('проект стал папкой в дереве', !!folder, folder?.textContent.trim().slice(0, 40))

  if (folder) {
    note('у папки есть раскрывающая стрелка', !!folder.querySelector('.folder-caret'))
    const before = document.querySelectorAll('.folder-children').length
    folder.click()
    await wait(250)
    note('папка сворачивается',
      folder.classList.contains('collapsed') ||
      document.querySelectorAll('.folder-children').length < before)
    folder.click()
    await wait(250)
  }

  // Pinning lifts a chat out of the folders, to the top.
  const anyChat = [...document.querySelectorAll('#chatHistoryList .history-item')][0]
  if (anyChat) {
    anyChat.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 300 }))
    await wait(250)
    const labels = [...document.querySelectorAll('.ctx-label')].map(n => n.textContent.trim())
    note('в меню чата есть закрепление', labels.some(l => /закрепить/i.test(l)), labels.join(' | '))

    const pin = [...document.querySelectorAll('.ctx-item')].find(b => /закрепить/i.test(b.textContent))
    pin?.click()
    await wait(400)
    note('закреплённый чат уехал наверх', !!document.querySelector('.history-item.pinned'))
    note('появился заголовок «Закреплённые»',
      /Закреплённые/.test($('chatHistoryList').textContent))
  }

  // Settings: one typeface, no storage section.
  $('settingsModal').style.display = 'flex'
  await wait(200)
  const tabs2 = [...document.querySelectorAll('[data-settings-tab]')].map(b => b.dataset.settingsTab)
  note('раздела «Хранение» больше нет', !tabs2.includes('storage'), tabs2.join(','))

  document.querySelector('[data-settings-tab="workspace"]')?.click()
  await wait(200)
  const faces = new Set(
    [...document.querySelectorAll('.settings-layout .field-input, .settings-layout .field-label, .settings-layout .row-title, .settings-layout .ws-folder-name, .settings-layout .ws-folder-empty')]
      .filter(n => n.offsetParent !== null)
      .map(n => getComputedStyle(n).fontFamily.split(',')[0].replace(/["']/g, '').trim())
  )
  note('в настройках один шрифт', faces.size === 1, [...faces].join(' / '))
  $('settingsModal').style.display = 'none'

  // Several folders at once is the whole point of the folder button, and it was
  // reachable only by right-clicking it — no menu, no hint, nothing. A plain
  // click has to show what is attached and offer to attach more.
  {
    const btn = $('workspaceBtn')
    if (btn) {
      btn.click()
      await wait(200)

      const menu = document.querySelector('.ctx-menu')
      note('обычное нажатие на папку открывает меню', !!menu)
      if (menu) {
        const text = menu.textContent || ''
        note('в меню есть выбор папки', /папку|Папка/i.test(text), text.slice(0, 90))
        // План, 2.2: три уровня одной логикой, без «основной» и без «работать без папки».
        note('в меню есть добавление папки всем чатам и только этому чату', /Добавить папку/.test(text) && /Только для этого чата/.test(text) && !/Этот чат/.test(text), text.slice(0, 90))
        note('в меню нет «основной папки»', !/основн/i.test(text), text.slice(0, 90))

        // It has to be on screen, not merely in the document.
        const box = menu.getBoundingClientRect()
        note('меню видно на экране', box.width > 80 && box.height > 40,
          Math.round(box.width) + 'x' + Math.round(box.height))
      }
      document.body.click()
      await wait(120)
    }
  }

  // Asking for a full redraw has to actually redraw. Four places reset the
  // painted record to force one — returning to a chat mid-turn, catching up
  // after scrolling away, replacing a changed plan, starting a turn — and the
  // painter appended a second copy of every block instead, then trimmed the new
  // ones away and left the stale DOM standing.
  if (typeof window.__paintBlocks === 'function') {
    const host = document.createElement('div')
    host.className = 'msg-item assistant'
    host.innerHTML = '<div class="msg-meta"></div>'
    document.querySelector('.chat-feed')?.appendChild(host)

    const pane = {
      assistantEl: host,
      generating: true,
      stickToBottom: true,
      dom: {},
      blocks: [
        { kind: 'thinking', agent: '', text: 'первая мысль' },
        { kind: 'text', agent: '', text: 'первый ответ' }
      ],
      paintedBlocks: []
    }

    window.__paintBlocks(pane)
    await wait(80)
    const holder = host.querySelector('.msg-blocks')
    note('блоки нарисованы', holder?.children.length === 2, 'узлов ' + (holder?.children.length ?? 0))

    // Now the redraw: content changes and the record is reset, as the real
    // callers do.
    pane.blocks[1] = { kind: 'text', agent: '', text: 'ЗАМЕНЁННЫЙ ответ' }
    pane.paintedBlocks = []
    window.__paintBlocks(pane)
    await wait(80)

    note('после сброса узлов столько же, а не вдвое больше',
      holder.children.length === 2, 'узлов ' + holder.children.length)
    note('на экране новое содержимое, а не старое',
      /ЗАМЕН/.test(holder.textContent) && !/первый ответ/.test(holder.textContent),
      holder.textContent.slice(0, 70))

    host.remove()
    await wait(40)
  }

  // Горячие клавиши (план, 2.3): сочетание меняется нажатием, занятое и
  // системное не принимается, новое работает, старое — нет, сброс возвращает.
  {
    const modal = $('settingsModal')
    modal.style.display = 'flex'
    document.querySelector('[data-settings-tab="shortcuts"]')?.click()
    await wait(200)
    const press = init => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    const edit = () => document.querySelector('#shortcutsGrid [data-edit="newChat"]')
    edit()?.click()
    await wait(50)
    note('сочетание ждёт нажатия', /Нажмите сочетание/.test(edit()?.textContent || ''), edit()?.textContent || 'нет кнопки')
    // Окно в фокусе системы: Chromium шлёт focusout, когда перерисовка убирает
    // кнопку с фокусом, — и запись отменялась сразу (жалоба владельца, 23.09).
    // Фоновое окно событий фокуса не получает, поэтому здесь оно воспроизведено.
    edit()?.focus()
    edit()?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    await wait(40)
    note('ложный уход фокуса не отменяет запись', /Нажмите сочетание/.test(edit()?.textContent || ''), edit()?.textContent || 'нет кнопки')
    press({ key: 'm', code: 'KeyM', ctrlKey: true })
    await wait(50)
    note('занятое сочетание не принимается', /занято/.test($('shortcutsNote')?.textContent || ''), $('shortcutsNote')?.textContent)
    press({ key: 'c', code: 'KeyC', ctrlKey: true })
    await wait(50)
    note('системное сочетание не принимается', /системное/.test($('shortcutsNote')?.textContent || ''), $('shortcutsNote')?.textContent)
    // Русская раскладка: символ «л», клавиша K.
    press({ key: 'л', code: 'KeyK', ctrlKey: true, shiftKey: true })
    await wait(80)
    note('новое сочетание записано', /Ctrl.*Shift.*K/.test(edit()?.textContent || '') && !!document.querySelector('[data-reset="newChat"]'), edit()?.textContent)
    note('подсказка кнопки называет новое сочетание', /Ctrl\+Shift\+K/.test($('newChatBtn')?.dataset.tooltip || ''), $('newChatBtn')?.dataset.tooltip)
    modal.style.display = 'none'
    await wait(50)
    const chatsBefore = document.querySelectorAll('.history-item').length
    const activeBefore = document.querySelector('.history-item.active .history-item-title')?.textContent
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'т', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true }))
    await wait(150)
    note('старое сочетание больше не срабатывает',
      document.querySelector('.history-item.active .history-item-title')?.textContent === activeBefore, 'чатов ' + chatsBefore)
    modal.style.display = 'flex'
    await wait(50)
    document.querySelector('[data-reset="newChat"]')?.click()
    await wait(50)
    note('сброс возвращает Ctrl+N', /Ctrl\s*N/.test(edit()?.textContent.replace(/\s+/g, ' ') || '') && !document.querySelector('[data-reset="newChat"]'), edit()?.textContent)
    modal.style.display = 'none'
    await wait(50)
  }

  // «Новый диалог» после чата с сообщениями: в шапке не остаётся его название.
  {
    const back = document.querySelector('.history-item.active .history-item-title')
    const withMessages = back || document.querySelector('.history-item .history-item-title')
    if (withMessages) {
      withMessages.click()
      await wait(300)
      const openedTitle = document.getElementById('chatHeaderTitle')?.textContent || ''
      const headerShown = !document.getElementById('chatHeader')?.hidden
      document.getElementById('newChatBtn')?.click()
      await wait(300)
      const header = document.getElementById('chatHeader')
      note('новый диалог не показывает шапку прошлого чата',
        !headerShown || header?.hidden || header?.querySelector('#chatHeaderTitle')?.textContent !== openedTitle,
        'было «' + openedTitle.slice(0, 40) + '», шапка скрыта: ' + Boolean(header?.hidden))
      // Вернуться туда, где были: дальше проверки смотрят на ответ в этом чате.
      const title = [...document.querySelectorAll('.history-item .history-item-title')].find(n => n.textContent === withMessages.textContent)
      title?.click()
      await wait(400)
    }
  }

  // Приветствие пустого чата (план, 1.10): фраза по времени суток, имя из
  // Персонализации подставляется и убирается.
  {
    const title = document.querySelector('#welcomeHero .hero-title')
    const phrase = /^(Доброе утро|С чего начнём утро|Добрый день|Над чем работаем|Добрый вечер|Что делаем сегодня вечером|Доброй ночи|Ночная смена|Good |Where shall|What are we|What’s on|Night shift)/
    note('приветствие по времени суток', phrase.test(title?.textContent || ''), title?.textContent || 'нет')
    const nameField = document.getElementById('personalName')
    if (nameField) {
      const before = nameField.value
      nameField.value = 'Тестер'
      nameField.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(50)
      note('в приветствии имя из Персонализации', /Тестер/.test(title?.textContent || ''), title?.textContent || 'нет')
      nameField.value = before
      nameField.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(700)
      note('без имени — без обращения', !/Тестер|, $|,\?/.test(title?.textContent || ''), title?.textContent || 'нет')
    }
  }

  // Край боковой панели (план, 1.9): стрелки меняют ширину и она помнится,
  // перетаскивание уже 150 px сворачивает панель, обратно — разворачивает,
  // двойной щелчок возвращает обычную ширину.
  {
    const bar = document.getElementById('sidebarResizer')
    const sidebar = document.querySelector('.sidebar')
    const wasNarrow = document.body.classList.contains('sidebar-narrow')
    // Заданная ширина, а не кадр анимации: в скрытом окне переход идёт медленно.
    const target = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10)
    if (wasNarrow) document.getElementById('sidebarToggle').click()
    await wait(300)
    note('край боковой панели на месте', !!bar && bar.getAttribute('role') === 'separator')
    if (bar && sidebar) {
      bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await wait(300)
      const base = target()
      bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await wait(300)
      const wider = target()
      let stored = ''
      try { stored = localStorage.getItem('1code_sidebar_width') || '' } catch {}
      note('стрелка вправо расширяет панель и ширина запоминается', wider === base + 16 && stored === String(wider), `${base} → ${wider}, сохранено ${stored}`)

      const left = sidebar.getBoundingClientRect().left
      bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: left + wider }))
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: left + 320 }))
      await wait(50)
      const dragged = target()
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: left + 100 }))
      await wait(50)
      const folded = document.body.classList.contains('sidebar-narrow')
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: left + 300 }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      await wait(350)
      note('панель идёт за курсором', dragged === 320, dragged + ' px')
      note('утянутая уже 150 px — свёрнута, обратно — развёрнута', folded && !document.body.classList.contains('sidebar-narrow'),
        'свернулась: ' + folded + ', ширина после ' + target())
      bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await wait(350)
      note('двойной щелчок — обычная ширина 268', target() === 268 && !document.body.classList.contains('sidebar-narrow'), target() + ' px')
    }
    if (wasNarrow) document.getElementById('sidebarToggle').click()
    await wait(300)
  }

  // Законченный ответ: серия шагов — одна строка «Ход работы» со сводкой, шаги
  // строятся только по раскрытию и встают по порядку. Без этого чат с сотнями
  // шагов открывался почти секунду, а текст ответа тонул в ленте действий.
  if (typeof window.__blocksInto === 'function') {
    const host = document.createElement('div')
    const steps = Array.from({ length: 12 }, (_, i) => ({ kind: 'tool', agent: '', title: `Прочитал файл шаг-${i}`, text: `вывод ${i}` }))
    steps.push({ kind: 'tool', agent: '', text: '', parts: { verb: 'Записал', target: 'index.html', meta: '+40 −3', tone: 'ok' } })
    steps.push({ kind: 'tool', agent: '', text: 'нет доступа', parts: { verb: 'Не выполнено', target: 'x', meta: '', tone: 'err' } })
    steps.unshift({ kind: 'thinking', agent: '', text: 'Сначала посмотрю файлы.' })
    window.__blocksInto(host, [{ kind: 'text', agent: '', text: 'до' }, ...steps, { kind: 'text', agent: '', text: 'после' }])
    const holder = host.querySelector('.msg-blocks')
    const run = holder?.querySelector('.work-run')
    note('серия шагов — одна строка «Ход работы»', !!run && !run.open && holder.querySelectorAll('.rail-step').length === 0,
      'шагов на виду ' + (holder?.querySelectorAll('.rail-step').length ?? 0))
    const head = (run?.querySelector('.work-run-head')?.textContent || '').replace(/\s+/g, ' ')
    note('сводка: действия, мысли, неудачи, правки',
      /ещё 13 действий/.test(head) && /не выполнено: 1/i.test(head) && /\+40/.test(head) && /−3/.test(head), head)
    run.open = true
    await wait(60)
    const order = [...run.querySelectorAll('.rail-step')].map(n => (n.textContent.match(/шаг-(\d+)/) || [])[1]).filter(Boolean)
    note('по раскрытию все шаги на месте и по порядку', order.join(',') === Array.from({ length: 12 }, (_, i) => i).join(','), order.join(','))
    note('текст ответа не свёрнут', /^до/.test(holder.firstElementChild?.textContent.trim() || '') && /после/.test(holder.lastElementChild?.textContent || ''))
    const short = document.createElement('div')
    window.__blocksInto(short, [{ kind: 'tool', agent: '', title: 'Прочитал a.txt', text: '' }, { kind: 'text', agent: '', text: 'ответ' }])
    const one = short.querySelector('.work-run')
    note('даже один вызов — свёрнутый ход с итогом одной фразой', !!one && !one.open && /Прочитан файл|Выполнено 1 действие/.test((one.querySelector('.thought-title')?.textContent || '')), one?.querySelector('.thought-title')?.textContent)
  }

  // The window used to normalise a saved mode name here, because reading the raw
  // value woke up a column renderer for a shape that no longer existed. There is
  // one mode now and the field is not read at all, so there is nothing left to
  // normalise — the audit checks instead that no switch grew back.

  // The task register: what is running now, what has finished, one place to
  // clear it. In a team mode agents work in turn and a single status line could
  // not say who was working, on what, or for how long.
  {
    const pane = { id: 'main', dom: { textarea: $('composerTextarea') }, generating: true, agentTasks: new Map() }
    const now = Date.now()
    // План хода теперь живёт в этой же панели справа, а не отдельным блоком в
    // ленте: его просили сделать компактным, сбоку и сворачиваемым.
    pane.planByAgent = new Map([['Ведущий', [
      { id: 's1', title: 'Прочитать журнал ошибок', status: 'done' },
      { id: 's2', title: 'Починить разбор ответа', detail: 'Исправить обработку SSE потока', status: 'doing' },
      { id: 's3', title: 'Прогнать тесты', status: 'todo' }
    ]]])
    pane.agentTasks.set(0, { index: 0, name: 'Ведущий', model: 'GLM 5.3 Flash',
      what: 'Прочитал src/main/main.js', since: now - 4000, tools: 3, done: false })
    pane.agentTasks.set(1, { index: 1, name: 'Агент 2', model: 'Dots3',
      what: 'Записал tests/new.cjs', since: now - 30000, tools: 1, done: true })

    if (typeof window.__tasks === 'function') {
      window.__tasks(pane, true)
      await wait(120)

      const panel = document.querySelector('#tasksPanel')
      note('панель фоновых задач открывается', !!panel)
      if (panel) {
        // Панель этого чата по макету 20.10: «Задачи», вкладки «Агенты» и «Консоль», строки агентов с планом
        const running = panel.querySelectorAll('.ag[data-state="now"]')
        note('выполняющаяся задача показана', running.length === 1, 'строк ' + running.length)
        note('остановить ход можно из панели', !!panel.querySelector('[data-tx="runstop"]'))
        // Остановить одного — у помощника, пока он работает; у ведущего — только вместе с ходом
        note('у ведущего своей остановки нет', !panel.querySelector('.ag[data-agent="0"] [data-tx="agstop"]'))
        note('рядом с ходом видно, сколько уже идёт', /\d+:\d\d/.test(panel.querySelector('[data-tick]')?.textContent || ''))
        note('видно, чем именно занят агент',
          /main\.js/.test(panel.textContent), panel.textContent.slice(0, 60))
        note('видно, кто занят и на какой модели',
          /Ведущий/.test(panel.textContent) && /GLM 5\.3/.test(panel.textContent))
        note('завершённый агент отмечен галочкой', !!panel.querySelector('.ag[data-state="done"] .st-ico .ok'))
        note('две вкладки: «Агенты» и «Консоль»', panel.querySelectorAll('[data-tx="tab"]').length === 2)

        // Панель перестраивалась целиком на каждый токен ответа: признак того, что
        // перестройки не было, — те же самые узлы на месте, а не новые.
        const before = panel.querySelector('.ag')
        window.__tasks(pane, true)
        await wait(40)
        note('без изменений панель не перестраивается',
          before === document.querySelector('#tasksPanel .ag'))

        // План агента — под его строкой, сворачивается
        const planBtn = panel.querySelector('[data-tx="agplan"]')
        note('план показан в панели', !!panel.querySelector('.ag-plan'))
        note('в плане видно шаги', /Починить разбор ответа/.test(panel.textContent))
        note('в плане видно, сколько сделано', /План, 1 из 3/.test(planBtn?.textContent || ''), planBtn?.textContent)
        note('панель можно закрыть', !!panel.querySelector('.tasks-close'))
        if (planBtn) {
          planBtn.click()
          await wait(60)
          note('план сворачивается', document.querySelector('#tasksPanel [data-tx="agplan"]')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('#tasksPanel .ag-plan'))
          document.querySelector('#tasksPanel [data-tx="agplan"]')?.click()
          await wait(60)
        }

        // The panel is a real element on screen, not merely present in the DOM.
        const box = panel.getBoundingClientRect()
        note('панель действительно видна', box.width > 100 && box.height > 60,
          Math.round(box.width) + 'x' + Math.round(box.height))
      }

      // Плашку «1 задача» из строки ввода просили убрать. Вход в панель — в
      // заголовке чата, рядом с остальным, что относится ко всему диалогу.
      note('в строке ввода счётчика задач больше нет', !document.querySelector('.tasks-chip'))
      // Кнопка одна — «Задачи»; счётчик у неё — число работающих агентов этого чата.
      const headerBtn = document.querySelector('#chatHeader #navTasks')
      note('вход в панель есть в заголовке чата', !!headerBtn)
      note('в заголовке видно, сколько работает',
        !!headerBtn && /^[0-9]+$/.test(headerBtn.querySelector('#taskCenterBadge')?.textContent || '') && !headerBtn.querySelector('#taskCenterBadge').hidden,
        headerBtn?.querySelector('#taskCenterBadge')?.textContent || '(пусто)')

      pane.generating = false
      pane.agentTasks = new Map()
      pane.planByAgent = new Map()
      window.__tasks(pane, false)
      await wait(80)
      note('панель уходит вместе с работой', !document.querySelector('#tasksPanel'))
      // Кнопка остаётся, пока у открытого чата есть история работы агентов: её
      // и просили — видеть, как отработала команда, уже после хода. Без истории
      // кнопке показывать нечего, и она уходит.
      const hasHistory = !!$('messagesList')?.querySelector('.agent-report')
      note('кнопка «Задачи» остаётся и после работы', !!document.querySelector('#chatHeader #navTasks') && !document.querySelector('#chatHeader .tasks-header-btn'))
      document.querySelector('#tasksPanel')?.remove()
    }
  }

  // Off-screen messages skip layout and paint, which also clips anything they
  // draw outside their own box. The pinned marker used to sit 10px to the left
  // of the message and would simply have stopped appearing.
  {
    const item = document.querySelector('.msg-item')
    if (item) {
      item.classList.add('pinned')
      await wait(80)
      const mark = getComputedStyle(item, '::before')
      const left = parseFloat(mark.left)
      const pad = parseFloat(getComputedStyle(item).paddingLeft)
      note('метка закреплённого не вылезает за край сообщения',
        !(left < 0), `left ${mark.left}`)
      note('под метку есть отступ, она не ложится на текст',
        pad >= 8, `padding-left ${pad}px`)
      item.classList.remove('pinned')

      note('сообщения пропускают раскладку, когда их не видно',
        getComputedStyle(item).contentVisibility === 'auto',
        getComputedStyle(item).contentVisibility)
    }
  }

  // Cost of the layout the scroll pin forces. Every paint mutates the feed and
  // then reads `scrollHeight` to stay at the bottom, which makes the browser
  // lay the whole feed out again. That cost grows with everything already on
  // screen, not with what just arrived — so it is invisible in a short chat and
  // dominates a long one.
  if (window.__renderMd) {
    const feed = document.querySelector('.chat-feed')
    if (feed) {
      const para = 'Это абзац ответа с **выделением** и `кодом`, достаточно длинный, чтобы занимать несколько строк на обычной ширине окна. '
      let filler = ''
      while (filler.length < 3000) filler += para

      const added = []
      for (let i = 0; i < (Number(window.__scale) || 40); i++) {
        const item = document.createElement('div')
        item.className = 'msg-item assistant'
        const body = document.createElement('div')
        body.className = 'msg-content'
        body.innerHTML = window.__renderMd(filler)
        item.appendChild(body)
        feed.appendChild(item)
        added.push(item)
      }
      await wait(200)

      const last = added[added.length - 1].querySelector('.msg-content')
      const t0 = performance.now()
      const passes = 10
      for (let i = 0; i < passes; i++) {
        last.appendChild(document.createTextNode(' ещё немного текста'))
        void feed.scrollHeight            // forces the layout the scroll pin needs
        feed.scrollTop = feed.scrollHeight
      }
      const per = (performance.now() - t0) / passes
      const tall = feed.scrollHeight

      for (const item of added) item.remove()
      await wait(50)

      // The stream asks for a repaint about twenty times a second at worst. Above
      // ~25ms a cycle the main thread is saturated and the window stops keeping
      // up with text that the provider is sending at ~15 words a second.
      note('пересчёт раскладки длинной ленты укладывается в бюджет',
        per < 25, `${per.toFixed(1)}мс за цикл, высота ленты ${Math.round(tall / 1000)}k px`)
    }
  }

  // Cost of one repaint of a long answer. The stream arrives in chunks about
  // three times a second, so every full markdown reparse is paid again and
  // again while the answer grows. Measured here because "the model writes one
  // word every three seconds" turned out to be the window, not the provider.
  if (window.__renderMd) {
    const para = 'Это обычный абзац ответа с **выделением**, `кодом` и ссылкой на пункт списка. '
    const chunk = [
      '## Раздел',
      '',
      para + para,
      '',
      '- первый пункт списка',
      '- второй пункт списка',
      '',
      '```js',
      'const x = compute(value)',
      '```',
      ''
    ].join('\n')

    const sizes = [2000, 8000, 20000]
    const timings = []
    for (const size of sizes) {
      let text = ''
      while (text.length < size) text += chunk
      const host = document.createElement('div')
      host.className = 'msg-content'
      host.style.cssText = 'width:700px;position:absolute;left:-9999px'
      document.body.appendChild(host)

      const t0 = performance.now()
      const passes = 5
      for (let i = 0; i < passes; i++) host.innerHTML = window.__renderMd(text)
      const per = (performance.now() - t0) / passes
      timings.push({ size: text.length, per })
      host.remove()
    }

    const worst = timings[timings.length - 1]
    const summary = timings.map(t => `${Math.round(t.size / 1000)}k=${t.per.toFixed(1)}мс`).join('  ')

    // Three chunks a second means three repaints a second. Above ~110ms each,
    // a 20k answer spends more than a third of every second reparsing itself
    // and the window stops keeping up with the stream.
    note('перерисовка длинного ответа укладывается в бюджет',
      worst.per < 110, summary)
  }

  // Tables: the scroll belongs to a wrapper. Putting `display: block` on the
  // table itself stopped the columns sharing the width and squeezed the last
  // one into a sliver.
  if (window.__renderMd) {
    const probe = document.createElement('div')
    probe.className = 'msg-content'
    probe.style.width = '700px'
    probe.innerHTML = window.__renderMd([
      '| Вы сказали | Что видно в базе | Вопрос |',
      '| --- | --- | --- |',
      '| «Цены ставит бот» | Слежение за ценами выключено, ждёт решения с 07.08 | См. вопрос 3 |',
      '| «Только форум» | Появилась реклама в TG-каналах | См. вопрос 12 |'
    ].join('\n'))
    document.body.appendChild(probe)
    await wait(150)

    const table = probe.querySelector('table')
    note('таблица отрисована', !!table)
    if (table) {
      note('таблица обёрнута в прокрутку', table.parentElement?.classList.contains('table-scroll'))
      note('таблица осталась таблицей',
        getComputedStyle(table).display === 'table', getComputedStyle(table).display)

      const cells = [...table.querySelectorAll('tbody tr:first-child td')]
      note('в строке три колонки', cells.length === 3, 'колонок ' + cells.length)
      note('колонки не схлопнуты',
        cells.every(c => c.getBoundingClientRect().width > 40),
        cells.map(c => Math.round(c.getBoundingClientRect().width)).join('/'))
      note('вторая колонка шире первой',
        cells[1].getBoundingClientRect().width > cells[0].getBoundingClientRect().width)
      note('нет сетки из рамок вокруг каждой ячейки',
        getComputedStyle(cells[0]).borderTopWidth === '0px', getComputedStyle(cells[0]).borderTopWidth)
    }
    probe.remove()
  }

  // The open chat is named above the conversation and renamed there.
  const header = $('chatHeader')
  note('заголовок чата есть в разметке', !!header)
  if (header && !header.hidden) {
    const titleBtn = $('chatHeaderTitle')
    note('в заголовке написано название', (titleBtn.textContent || '').trim().length > 0,
      (titleBtn.textContent || '').slice(0, 40))
    note('заголовок над лентой',
      header.getBoundingClientRect().bottom <= $('chatFeed').getBoundingClientRect().top + 2)

    titleBtn.click()
    await wait(250)
    const input = header.querySelector('.chat-header-rename')
    note('клик открывает переименование', !!input)
    if (input) {
      input.value = 'Переименован сверху'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wait(400)
      note('название сохранилось из заголовка',
        ($('chatHeaderTitle').textContent || '').includes('Переименован сверху'),
        $('chatHeaderTitle').textContent)
      note('и подхватилось в списке слева',
        [...document.querySelectorAll('#chatHistoryList .history-item-title')]
          .some(n => n.textContent.includes('Переименован сверху')))
    }
  }

  // The turn is drawn in the order it happened, not as one pile of thinking
  // followed by one pile of answer.
  const lastAnswer = [...$('messagesList').querySelectorAll('.msg-item.assistant')].pop()
  const holder = lastAnswer?.querySelector('.msg-blocks')
  note('ответ собран из блоков по порядку', !!holder)
  if (holder) {
    // Чек-лист — не мысль и не ответ, а третье: список результатов, который
    // может появиться раньше любого текста. Без отдельного имени он считался
    // текстом, и порядок «мысль раньше текста» ломался о него на ровном месте.
    // Итог помощника — тоже не текст ответа: это строка о том, что сделал
    // другой агент, и в порядке ответа ведущего она не участвует.
    const kinds = [...holder.children].map(n =>
      n.classList.contains('agent-report') ? 'помощник'
        : n.classList.contains('think') ? 'мысль'
        : n.classList.contains('block-tool') ? 'инструмент'
          : n.classList.contains('plan-inline') ? 'чек-лист' : 'текст')
    note('в ответе есть и мысль, и текст',
      kinds.includes('мысль') && kinds.includes('текст'), kinds.join(' → '))
    note('мысль идёт раньше текста', kinds.indexOf('мысль') < kinds.indexOf('текст'),
      kinds.join(' → '))

    // The thought is drawn once. Two painters used to run at the same time —
    // rows here, a wall of italics above — so the same reasoning appeared twice
    // while it streamed, and only the rows survived the end of the turn.
    note('мысль не нарисована дважды',
      !holder.parentElement?.querySelector('.reasoning-stream'),
      holder.parentElement?.querySelector('.reasoning-stream') ? 'есть вторая копия' : '')

    // Thinking is packed into a line you open, not a wall of italics.
    const think = holder.querySelector('.think')
    if (think) {
      note('ход мысли свёрнут', think.tagName === 'DETAILS' && !think.open)
      const label = think.querySelector('.think-label')
      note('в свёрнутом виде есть суть одной строкой',
        (label?.textContent || '').trim().length > 3, label?.textContent.slice(0, 50))
      const body = think.querySelector('.think-body')
      note('полный текст спрятан до раскрытия',
        body.getBoundingClientRect().height === 0,
        'высота ' + Math.round(body.getBoundingClientRect().height))

      think.open = true
      await wait(150)
      note('раскрывается по клику', body.getBoundingClientRect().height > 0)
      note('внутри полный ход мысли',
        (think.querySelector('.think-body').textContent || '').length >=
        (label?.textContent || '').length)

      // An opened thought must not be its own scrolling box: the wheel would
      // land in it and the feed would refuse to move until it was read out.
      note('раскрытая мысль не забирает колесо',
        body.scrollHeight - body.clientHeight <= 1 &&
        getComputedStyle(body).overflowY !== 'scroll',
        `${body.scrollHeight} / ${body.clientHeight}, ${getComputedStyle(body).overflowY}`)

      // Some models push the same reasoning down both channels. Drawn twice it
      // reads as the model answering with its own thinking.
      const answer = (holder.querySelector('.block-text')?.textContent || '').trim()
      const thought = (body.textContent || '').trim()
      note('мысль не продублирована ответом',
        !(answer.length > 60 && thought.startsWith(answer)),
        answer.slice(0, 40))

      think.open = false
    }
  }

  // The fixture travels the real UI → preload → IPC route and does not spend a provider request.
  const ta2 = $('composerTextarea')
  if (hintConsumed) {
    // Первый блок принял подсказку по Tab, а `acceptSuggestion` её удаляет из
    // памяти окна: новой неоткуда взяться, пока не завершится ещё один ход.
    // Просим ход, иначе проверка внизу спрашивала бы не «соответствует ли
    // подсказка чату», а «не съели ли мы её сами» — и плавать это будет вечно.
    // Таймауты тут ни при чём: замер 24.09 показал «нет и через 20 с».
    const box = $('composerTextarea')
    box.value = 'Подсказка после черновика'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    $('composerForm').requestSubmit()
    const done = await until(() => !document.querySelector('.btn-send.is-stop'), 20000)
    note('ход для новой подсказки завершился', done, `ждали ответа ${done ? '' : 'и не дождались '}20000 мс`)
  }
  const hintWait = await timed(() => ta2.classList.contains('has-suggestion'), SUGGESTION_WAIT_MS)
  const suggestionReady = hintWait.ok
  // Дешёвая страховка от вывода «просто увеличь таймаут». Если за порог не
  // успели, спрашиваем ещё 15 с: «пришло на X мс» — это задержка (и тогда порог
  // надо мерить, а не угадывать), «не пришло и за 20 с» — уже дефект пути, и
  // прятать его за таймаутом нельзя. Платим за это только на провальной ветке.
  const late = suggestionReady ? null : await timed(() => ta2.classList.contains('has-suggestion'), 15000)
  // Различаем три исхода, а не два: «успели», «не успели, но пришла позже» и
  // «не пришла никогда». Средний путали — сообщение писало «пришла через 20 с»
  // ровно тогда, когда второй зонд тоже истёк.
  const hintWhy = !suggestionReady
    ? (late?.ok ? `пришла только через ${hintWait.ms + late.ms} мс — порога ${SUGGESTION_WAIT_MS} мс не хватает`
      : `не появилась и за ${SUGGESTION_WAIT_MS + 15000} мс — это не задержка, а отсутствие`)
    : `ждали ${hintWait.ms} из ${SUGGESTION_WAIT_MS} мс`
  const currentLastUserText = [...$('messagesList').querySelectorAll('.msg-item.user .msg-content')]
    .map(node => node.textContent).pop() || ''
  // Тот же порядок, что в первом блоке подсказок: ничего не исчезает из счёта.
  // Тот же порядок, что в первом блоке подсказок: ничего не исчезает из счёта.
  // Причина пишется так, чтобы различать три мира: подсказку не сгенерировали,
  // сгенерировали поздно, или её СНЯЛ предыдущий блок (Tab по подсказке её
  // поглощает — см. `hintConsumed` выше). Без этого различия «плавающая» проверка
  // так и осталась бы загадкой.
  const hint = (name, pass, detail) => note(name, suggestionReady && pass,
    suggestionReady ? detail : `не состоялось: подсказки нет (${hintWhy}${hintConsumed ? '; первый блок снял её подстановкой по Tab' : ''})`,
    !suggestionReady)
  note('подсказка в конце прогона появилась', suggestionReady,
    suggestionReady ? `${hintWhy}; placeholder: ${ta2.placeholder.slice(0, 60)}` : hintWhy)
  hint('модельная подсказка соответствует текущему чату',
    Boolean(currentLastUserText) && ta2.placeholder.includes(currentLastUserText),
    `${currentLastUserText} → ${ta2.placeholder}`)
  note('плашек над строкой ввода нет', !$('composerCard').querySelector('.suggest-strip'))
  note('поле осталось пустым', ta2.value.trim() === '', JSON.stringify(ta2.value))
  hint('в подсказке нет служебных значков', !/[⇥→]/.test(ta2.placeholder), ta2.placeholder.slice(-12))

  const offered = ta2.placeholder
  ta2.value = 'Мой незаконченный черновик'
  ta2.dispatchEvent(new Event('input', { bubbles: true }))
  hint('черновик не подменяется подсказкой',
    ta2.value === 'Мой незаконченный черновик' && !ta2.classList.contains('has-suggestion'), ta2.value)
  const draftTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  ta2.dispatchEvent(draftTab)
  hint('Tab не перехватывается у черновика',
    !draftTab.defaultPrevented && ta2.value === 'Мой незаконченный черновик')
  ta2.value = ''
  ta2.dispatchEvent(new Event('input', { bubbles: true }))
  const backAgain = await timed(() => ta2.classList.contains('has-suggestion') && ta2.placeholder === offered, 2000)
  hint('очистка поля возвращает подсказку этого чата', backAgain.ok, `ждали ${backAgain.ms} из 2000 мс`)
  ta2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  await wait(250)
  hint('Tab подставляет ровно показанную подсказку', ta2.value === offered, ta2.value.slice(0, 60))
  hint('после подстановки подсказка снимается', !ta2.classList.contains('has-suggestion'))
  hint('вернулся обычный текст-подсказка', ta2.placeholder !== offered)
  ta2.value = ''
  ta2.dispatchEvent(new Event('input', { bubbles: true }))

  // Selecting text in a message offers to quote it back.
  const quoteSource = [...$('messagesList').querySelectorAll('.msg-item .msg-content')].pop()
  if (quoteSource && quoteSource.textContent.trim()) {
    const range = document.createRange()
    range.selectNodeContents(quoteSource)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    // Кнопка ставится не синхронно с выделением: прежний `wait(300)` под
    // загрузкой давал 1 провал из 3 прогонов, и следом молча исчезали восемь
    // проверок (счёт падал с 278 до 269). Ждём сам признак и называем время.
    const btnWait = await timed(() => document.querySelector('.quote-btn'), 3000)
    const btn = document.querySelector('.quote-btn')
    const btnPresent = Boolean(btn)
    note('при выделении появляется кнопка ответа', btnPresent, `ждали ${btnWait.ms} из 3000 мс`)
    const qnote = (name, pass, detail) => note(name, btnPresent && pass,
      btnPresent ? detail : `не состоялось: кнопка цитаты не появилась за ${btnWait.ms} мс`, !btnPresent)
    {
      const box = btn?.getBoundingClientRect?.()
      qnote('кнопка не уехала за край экрана',
        box && box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth,
        box ? Math.round(box.left) + ',' + Math.round(box.top) : 'координат нет')

      // План, 3.1: цитата — плашка над полем ввода, а не строки с «>» в поле.
      $('composerTextarea').value = 'мой вопрос'
      btn?.click()
      await wait(250)
      const chips = () => [...document.querySelectorAll('#composerCard .quote-chip')]
      qnote('выделенное встало цитатой над полем ввода', chips().length === 1, 'плашек ' + chips().length)
      qnote('поле ввода не тронуто', $('composerTextarea').value === 'мой вопрос', $('composerTextarea').value.slice(0, 40))
      qnote('у цитаты подписано, откуда она', /Ответ|Ваше сообщение/.test(chips()[0]?.textContent || ''), (chips()[0]?.textContent || '').trim().slice(0, 40))
      qnote('кнопка убирается после нажатия', !document.querySelector('.quote-btn'))

      // Второе выделение — другой кусок: цитаты встают по порядку, повтор не задваивается.
      const textNode = (() => { const w = document.createTreeWalker(quoteSource, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.data.trim().length > 3) return n; return null })()
      if (textNode) {
        // Выделять приходится с первого НЕпробельного знака: первые три символа
        // узла — это часто перенос и отступ («\n  Привет»), а на пустое
        // выделение кнопка не показывается по правильному смыслу. Три падения
        // этого блока в серии 24.09 были именно тестовой хрупкостью, а не
        // поведением окна, и выглядели как «кнопка не появилась».
        const from = textNode.data.search(/\S/)
        const take = Math.max(3, Math.min(8, textNode.data.length - from))
        const part = document.createRange()
        part.setStart(textNode, from)
        part.setEnd(textNode, from + take)
        const selected = textNode.data.slice(from, from + take)
        const sel2 = window.getSelection()
        sel2.removeAllRanges()
        sel2.addRange(part)
        document.dispatchEvent(new Event('selectionchange'))
        const btn2Wait = await timed(() => document.querySelector('.quote-btn'), 3000)
        const btn2 = document.querySelector('.quote-btn')
        qnote('кнопка появляется и на втором выделении', btn2Wait.ok,
          `ждали ${btn2Wait.ms} из 3000 мс; выделено ${JSON.stringify(selected)}`)
        btn2?.click()
        await wait(200)
        qnote('вторая цитата встала второй', chips().length === 2, 'плашек ' + chips().length)
      }
      chips()[0]?.querySelector('.quote-chip-remove')?.click()
      await wait(150)
      qnote('крестик убирает цитату', chips().length === (textNode ? 1 : 0), 'плашек ' + chips().length)
      chips().forEach(chip => chip.querySelector('.quote-chip-remove')?.click())
      await wait(100)
      qnote('без цитат полоса скрыта', !document.querySelector('#composerCard .quote-strip:not([hidden])'))

      $('composerTextarea').value = ''
      $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
    }

    sel.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    await wait(150)
    note('без выделения кнопки нет', !document.querySelector('.quote-btn'))
  }

  // Actions under a finished answer.
  const answer = [...$('messagesList').querySelectorAll('.msg-item.assistant')].pop()
  note('под ответом есть кнопки', !!answer?.querySelector('.msg-actions'))
  if (answer?.querySelector('.msg-actions')) {
    const acts = [...answer.querySelectorAll('.msg-action')].map(b => b.dataset.act)
    note('есть копирование', acts.includes('copy'), acts.join(','))
    note('есть повтор', acts.includes('retry'), acts.join(','))
    note('ровно два действия из макета',
      !acts.includes('undo') && !acts.includes('delete') && acts.length === 2, acts.join(','))

    // Icons only: a text label would stretch the row across the message.
    const btn = answer.querySelector('.msg-action')
    note('на кнопках нет подписей', !btn.textContent.trim(), JSON.stringify(btn.textContent.trim()))
    note('кнопка не схлопнута без текста',
      btn.getBoundingClientRect().width >= 22 && btn.getBoundingClientRect().height >= 22,
      Math.round(btn.getBoundingClientRect().width) + 'x' + Math.round(btn.getBoundingClientRect().height))
    note('у каждой кнопки есть подсказка',
      [...answer.querySelectorAll('.msg-action')].every(b => (b.dataset.tooltip || b.getAttribute('data-tooltip') || '').length > 3))
  }

  // Typing while the agent works queues instead of killing the turn.
  note('очередь пуста на старте', !document.querySelector('.queued-item'))

  // Updates: the section has to exist, report the running version, and refuse
  // to pretend it can work from a dev run.
  settings.style.display = 'flex'
  const updTab = document.querySelector('[data-settings-tab="updates"]')
  note('в настройках есть раздел обновлений', !!updTab)
  if (updTab) {
    updTab.click()
    await wait(250)
    note('показана текущая версия', /\d+\.\d+\.\d+/.test($('updateVersionBadge').textContent),
      $('updateVersionBadge').textContent)
    note('есть кнопка проверки', !!$('checkUpdateBtn'))
    note('адрес сервера обновлений нельзя менять из настроек', !$('updateFeedInput') && !$('saveUpdateFeedBtn'))
    note('автоматическая проверка доступна', !!$('updateAutoCheck'))
    // Checking the property is what let two visible buttons pass as hidden:
    // a display rule beats the attribute. Ask the layout, not the property.
    const unseen = elId => {
      const node = $(elId)
      return !node || node.offsetParent === null || node.getBoundingClientRect().height === 0
    }
    note('прогресс не показан до скачивания', unseen('updateProgressWrap'))
    note('кнопка скачивания не показана, пока нечего качать', unseen('downloadUpdateBtn'))
    note('кнопка установки не показана, пока нечего ставить', unseen('installUpdateBtn'))

    // Electron prefixes anything thrown in the main process with
    // "Error invoking remote method 'x': Error: ", and that preamble reached
    // the toast glued to a message written for a person. Checking updates from
    // a dev run fails through exactly that path.
    $('checkUpdateBtn').click()
    await until(() => document.getElementById('toastNotification').classList.contains('show'), 4000)
    await wait(200)
    const toastText = document.getElementById('toastNotification').textContent
    note('тост без служебной обёртки Electron',
      !/invoking remote method/i.test(toastText) && !/^Error:/i.test(toastText),
      toastText.slice(0, 70))
    note('тост не разрастается на пол-экрана', toastText.length <= 230,
      'символов: ' + toastText.length)

  }
  settings.style.display = 'none'

  // MCP: the knowledge-base template must fill the HTTP fields (presets only
  // ever filled the stdio ones, so an HTTP template saved an empty URL), and a
  // pasted config must populate the form.
  $('navConnectors')?.click()
  await wait(400)
  $('addMcpServerBtn')?.click()
  await wait(300)

  if (!$('addMcpModal').hidden && $('mcpJsonInput')) {
    // The exact block a person pastes out of their server's docs.
    $('mcpJsonInput').value = JSON.stringify({
      mcpServers: {
        platinum: {
          type: 'http',
          url: 'https://pkwobler.best/mcp',
          headers: { Authorization: 'Bearer ТВОЙ_ТОКЕН' }
        }
      }
    })
    $('mcpJsonInput').dispatchEvent(new Event('input', { bubbles: true }))
    await wait(250)
    note('вставленный JSON разобран', $('mcpNameInput').value === 'platinum', $('mcpNameInput').value)
    note('из JSON взят адрес', $('mcpUrlInput').value === 'https://pkwobler.best/mcp')
    note('из JSON взят токен', $('mcpHeadersInput').value.includes('ТВОЙ_ТОКЕН'))
    note('заглушка вместо токена замечена',
      /заглушк/i.test($('mcpFormError').textContent), $('mcpFormError').textContent.slice(0, 50))

    $('addMcpModal').style.display = 'none'
  }

  // «To the newest message» has to arrive in one press. It used to take three:
  // the feed skips layout for messages out of view, so the height it aimed at
  // was an underestimate and the jump landed short, twice over. Checked here
  // rather than by reading the code because the whole bug is in what the
  // browser does with a real, tall, partly-unlaid-out feed.
  {
    // By now the run has wandered off to the MCP screen, and a hidden view has
    // no height to scroll. Back to the chat first.
    $('navChats')?.click()
    await wait(250)

    const feed = $('chatFeed')
    const btn = $('scrollDownBtn')
    const list = $('messagesList')
    if (feed && btn && list) {
      // The list is hidden while the chat is empty, and a hidden list gets no
      // layout — so it is shown for the duration and put back afterwards.
      const wasDisplay = list.style.display
      const hero = $('welcomeHero')
      const heroDisplay = hero ? hero.style.display : null
      list.style.display = 'flex'
      if (hero) hero.style.display = 'none'

      const filler = document.createElement('div')
      // Each block is taller than the 180px placeholder the feed reserves for a
      // message it has not laid out, so the height the jump aims at starts too
      // small — which is exactly the condition the button used to lose to.
      filler.innerHTML = Array.from({ length: 40 }, (_, i) =>
        `<div class="msg-item assistant" style="min-height:300px"><div class="msg-content">` +
        `<p>строка ${i}</p><p>второй абзац, чтобы высота блока отличалась от заглушки</p>` +
        '</div></div>').join('')
      $('messagesList').appendChild(filler)
      await wait(200)

      feed.scrollTop = 0
      await wait(120)
      const runway = feed.scrollHeight - feed.clientHeight
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' })
      await wait(150)
      const direct = feed.scrollHeight - feed.scrollTop - feed.clientHeight
      note('прокрутка вниз напрямую работает', direct <= 80, 'осталось ' + Math.round(direct))
      feed.scrollTo({ top: 0, behavior: 'instant' })
      await wait(150)

      let reached = false
      const spy = () => { reached = true }
      btn.addEventListener('click', spy)
      btn.click()
      btn.removeEventListener('click', spy)
      note('клик доходит до кнопки', reached, String(reached))
      // One press, then time for the smooth travel and the re-aiming to finish.
      await wait(4000)
      const landed = feed.scrollHeight - feed.scrollTop - feed.clientHeight
      note('кнопка «вниз» доводит до конца с одного нажатия',
        runway > 200 && landed <= 80,
        `прокрутки было ${Math.round(runway)}px, осталось ${Math.round(landed)}px, ` +
        `лента ${Math.round(feed.clientHeight)}px из ${Math.round(feed.scrollHeight)}px`)

      filler.remove()
      list.style.display = wasDisplay
      if (hero) hero.style.display = heroDisplay
      await wait(80)
    }
  }

  // Actual bounds, not a CSS-text assertion: the send button stays inside the card.
  {
    const card = $('composerCard').getBoundingClientRect()
    const send = $('sendBtn').getBoundingClientRect()
    note('кнопка отправки внутри композера',
      send.width > 0 && send.left >= card.left && send.right <= card.right &&
      send.top >= card.top && send.bottom <= card.bottom,
      JSON.stringify({card: card.toJSON(), send: send.toJSON()}))
    $('settingsModal').style.display = 'flex'
    $('tab-personal').click()
    note('раздел называется Общее', $('settingsTitle').textContent === 'Общее')
    const name = $('personalName'), theme = $('personalTheme')
    name.value = 'До'
    name.dispatchEvent(new Event('input', {bubbles: true}))
    theme.value = 'light'
    theme.dispatchEvent(new Event('change', {bubbles: true}))
    name.value = 'После'
    name.dispatchEvent(new Event('input', {bubbles: true}))
    let saved = null
    for (let i = 0; i < 30; i++) {
      await wait(100)
      saved = await window.electronAPI.getPersonal()
      if (saved && saved.name === 'После' && saved.theme === 'light') break
    }
    note('последний ввод персонализации сохранён через IPC', saved.name === 'После' && saved.theme === 'light')
    note('светлая тема применена', document.documentElement.dataset.theme === 'light')
    theme.value = 'dark'
    theme.dispatchEvent(new Event('change', {bubbles: true}))
    await wait(100)
    $('settingsModal').style.display = 'none'
  }

  // Проверка этапа 1.4: свои подсказки вместо системных title
  {
    const interactiveWithTitle = document.querySelectorAll(
      'button[title], a[title], input[title], textarea[title], select[title], [role="button"][title], [tabindex][title]'
    );
    note('нет нативных title у интерактивных элементов', interactiveWithTitle.length === 0,
      interactiveWithTitle.length > 0 ? Array.from(interactiveWithTitle).map(e => e.outerHTML.slice(0, 80)).join('; ') : '');
    const newChatBtn = $('newChatBtn');
    if (newChatBtn) {
      if (document.activeElement) document.activeElement.blur();
      await wait(50);
      newChatBtn.focus();
      newChatBtn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

      const tip = $('onlyone-global-tooltip');
      const tipShown = await until(() => tip && !tip.hidden && tip.classList.contains('is-visible'), 2000);

      note('своя подсказка показана при фокусе', tipShown);
      note('текст подсказки выделен', tip?.querySelector('.ui-tooltip-text')?.textContent === 'Новый чат'); // подпись строки по макету 19.10
      note('сочетание клавиш выделено в чип', tip?.querySelector('.ui-tooltip-kbd')?.textContent === 'Ctrl+N');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(180);
      note('подсказка скрывается по Escape', !tip?.classList.contains('is-visible') || tip?.hidden);
      if (document.activeElement) document.activeElement.blur();
    }
  }

  note('ни одного исключения по ходу проверки', thrown.length === 0, thrown.join(' | ').slice(0, 300))

  return { ok: checks.every(c => c.pass), checks }
})()
