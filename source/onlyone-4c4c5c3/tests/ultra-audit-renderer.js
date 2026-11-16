// Внутриоконный зонд U-5: полный проход Ultra живым окном.
//
// Слово владельца 01.10 после первого дня в Ultra: «ошибок много, не работает
// так, как нужно — нужен полный проход Ultra живым окном». И отдельно U-6:
// «символы и значки накладываются друг на друга».
//
// ПОЧЕМУ ЭТОТ ЗОНД НЕ ПРИБОР U-6, А ОБХОД. U-6 отвечает на узкий вопрос —
// накладываются ли прямоугольники. U-5 отвечает на широкий: работает ли Ultra
// так, как задумано, и если нет — где именно, что ждали и что вышло. Разница в
// том, что здесь сценарии идут ПО ПОРЯДКУ, как человек: вошёл, открыл сессию,
// написал, посмотрел результат, перетащил блок, перезапустил окно, сменил
// версию туда и обратно. Прибор U-6 меряет геометрию на экране; здесь важно
// ПОВЕДЕНИЕ, и почти все находки здесь — не про наложения вовсе.
//
// ПРО КАЖДУЮ НАХОДКУ. Находка — это строка «где · что ждали · что вышло», и
// она попадает в отчёт отдельным списком, а не только в счётчик провалов. Владелец
// читает список, а не код теста. Находка, которую нельзя воспроизвести по
// шагам, находкой не считается: у каждой строки есть имя сценария.
//
// ЧЕСТНОСТЬ ПРИБОРА. Пустой экран, неоткрывшийся диалог и ненарисованный блок
// дали бы зелёный отчёт «всё работает» там, где на самом деле ничего не
// проверено. Поэтому у каждого сценария есть проверка, что состояние вообще
// достигнуто, и она падает отдельно от проверок поведения.
(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms = 15000) => {
    const stop = Date.now() + ms
    for (;;) {
      try { if (fn()) return true } catch (error) { /* узла ещё нет */ }
      if (Date.now() >= stop) return false
      await wait(40)
    }
  }
  const norm = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  const checks = []
  // Находки — отдельно от провалов: их читает человек, а не счётчик.
  const found = []
  let scenario = 'start'
  const note = (name, pass, detail, where) => {
    const good = Boolean(pass)
    // Деталь — это описание того, ЧТО ВЫШЛО ВМЕСТО ОЖИДАЕМОГО. У зелёной строки
    // её печатать нельзя: в журнале вышло бы «ok · оболочка осталась на месте»,
    // и человек прочитал бы находку там, где её нет.
    checks.push({ name, pass: good, detail: good || detail === undefined ? '' : String(detail) })
    if (!good) found.push({ scenario, where: where || name, name, detail: String(detail == null ? '' : detail) })
  }
  // Ожидание «что ждали» против «что вышло» — так строка находки читается.
  const expect = (name, wanted, got, where) => {
    const pass = norm(wanted) === norm(got)
    note(name, pass, `ждали «${norm(wanted)}», вышло «${norm(got)}»`, where)
    return pass
  }

  const arg = (() => {
    try {
      const bin = atob('__ONECODE_ARG__')
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  })()
  const lang = arg.lang || 'ru'
  const chatId = arg.chatId || 'chat-a'

  const preset = () => document.documentElement.getAttribute('data-version-preset')
  const shell = () => document.querySelector('#ultraHost .ultra')
  const blocks = () => [...document.querySelectorAll('.ublock')]
  // У оболочки Ultra СВОЯ строка ввода: `form.ucmp > textarea.uint` с кнопкой
  // `.usend`. Поле окна `#composerTextarea` под Ultra скрыто — на входе и в
  // пустой сессии рисует экран оболочка, и набирать надо в её поле. Проверять
  // `#composerTextarea` в Ultra значило бы проверять то, чего человек не видит.
  const ultraInput = () => document.querySelector('#ultraHost textarea.uint, #ultraHost .ucmp textarea')
  const ultraSend = () => document.querySelector('#ultraHost .usend, #ultraHost .ucmp button')
  const visible = el => {
    if (!el) return false
    const style = window.getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }

  // ─── вход в окно ───────────────────────────────────────────────────────────
  scenario = 'окно'
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
  expect('язык окна', lang, window.onlyoneApp?.lang?.() || '—', 'окно')

  // ─── посев: диалог с ходом, чтобы было что открывать ────────────────────────
  // Без посева список «Сессии» пуст, кликать не по чему, и девять сценариев
  // подряд краснеют на одном неверном предположении. Это повторилось дважды,
  // поэтому посев — отдельный кадр, а не неявное условие остальных.
  if (arg.mode === 'seed') {
    const now = Date.now()
    const stored = await window.electronAPI?.getConversations?.() || []
    const mine = stored.find(item => item.id === chatId) || {
      id: chatId, title: 'Прогон Ultra', createdAt: now - 60000, updatedAt: now - 20000
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
    return { ok: checks.every(one => one.pass), checks, found, summary: { checks: checks.length } }
  }

  // ─── 1. вход и «Сессии» ───────────────────────────────────────────────────
  scenario = 'вход Ultra'
  note('оболочка Ultra смонтирована', await until(() => Boolean(shell()), 15000), preset() || 'признака нет')
  expect('пресет версии — ultra', 'ultra', preset(), 'вход Ultra')
  const rows = await until(() => document.querySelectorAll('.urow').length > 0, 10000)
  const list = [...document.querySelectorAll('.urow')]
  note('список «Сессии» нарисован', rows && list.length > 0, `строк ${list.length}`, 'вход Ultra')
  note('у каждой сессии есть подпись', list.every(one => norm(one.textContent).length > 0),
    list.map(one => norm(one.textContent).slice(0, 24)).join(' / '), 'вход Ultra')
  note('искра на входе нарисована', Boolean(document.querySelector('.spk, .uspark')),
    'svg искры нет', 'вход Ultra')
  // Новая сессия — это строка «Новая сессия» в списке Sessions, а не сама искра:
  // искра на входе узлов не несёт, это только знак экрана.
  note('в списке есть строка «Новая сессия»', Boolean(document.querySelector('.urow-new')),
    'строки .urow-new нет', 'вход Ultra')
  note('поле ввода оболочки доступно на входе', visible(ultraInput()),
    ultraInput() ? 'поле скрыто' : 'поля оболочки нет', 'вход Ultra')

  // ─── 2. новая сессия ─────────────────────────────────────────────────────
  scenario = 'новая сессия'
  document.querySelector('.urow-new')?.click()
  const wentEmpty = await until(() => shell()?.classList.contains('is-empty'), 10000)
  note('«Новая сессия» открыла пустую сессию', wentEmpty,
    `режим=${shell()?.className}`, 'новая сессия')
  note('в пустой сессии поле ввода на месте', visible(ultraInput()),
    ultraInput() ? 'поле скрыто' : 'поля нет', 'новая сессия')

  // ─── 3. чат с ходом: мысль, файлы, ответ ──────────────────────────────────
  scenario = 'чат с ходом'
  // Из пустой сессии список «Сессии» не виден — он на экране входа. Возврат
  // делает кнопка «‹ Sessions» в полосе чата, и это единственный путь назад.
  const back = shell()?.querySelector('.ubk')
  note('в полосе чата есть возврат к списку Sessions', Boolean(back),
    back ? norm(back.textContent) : 'кнопки .ubk нет', 'чат с ходом')
  back?.click()
  const atEntry = await until(() => shell()?.classList.contains('is-entry'), 8000)
  note('возврат открыл список Sessions', atEntry, `режим=${shell()?.className}`, 'чат с ходом')
  const row = await until(() => shell()?.querySelector(`[data-chat-id="${chatId}"]`), 10000)
    ? shell().querySelector(`[data-chat-id="${chatId}"]`) : null
  if (row) {
    row.click()
    await until(() => shell()?.classList.contains('is-chat'), 10000)
  }
  note('чат открыт кликом по строке Sessions', shell()?.classList.contains('is-chat'),
    `режим=${shell()?.className}`, 'чат с ходом')
  // U-3: пока ход идёт, блока изменений в ленте быть не должно.
  note('U-3: посреди хода блока «Изменения в файлах» нет',
    !document.querySelector('.msg-item.assistant .agent-file-changes'),
    document.querySelectorAll('.agent-file-changes').length + ' штук в ленте', 'чат с ходом')

  // ─── 4. «Задачи» ─────────────────────────────────────────────────────────
  scenario = 'Задачи'
  // ПРАВИЛО, КОТОРОЕ ЗДЕСЬ ПРОВЕРЯЕТСЯ, А НЕ «КНОПКА ВИДНА». По замыслу
  // (ultra-shell.css, последняя строка) кнопка «Задачи» показывается только
  // при непустом центре задач, и при нуле её быть не должно. Проверять обратное
  // значило бы требовать от продукта лишнего. Сам блок «Задачи» и его место
  // меряет `run-ultra-shell-ui.cjs` (кадр `tasks-open`); здесь — правило видимости
  // и то, что при ненуле кнопка приводит к блоку, а не к экрану на пол-окна.
  const tasksCount = document.documentElement.getAttribute('data-ultra-tasks')
  const tasksBtn = $('navTasks')
  note('признак счётчика задач выставлен', tasksCount === 'zero' || /^\d+$/.test(String(tasksCount || '')),
    `data-ultra-tasks=${tasksCount || 'нет'}`, 'Задачи')
  note('U-2: при нуле задач кнопка «Задачи» скрыта', tasksCount === 'zero' ? !visible(tasksBtn) : visible(tasksBtn),
    `счётчик ${tasksCount}, кнопка ${visible(tasksBtn) ? 'видна' : 'скрыта'}`, 'Задачи')
  if (visible(tasksBtn)) {
    tasksBtn.click()
    const TASKS_BLOCK = '.ublock[data-block-id="ultra-tasks"]'
    const opened = await until(() => Boolean(document.querySelector(TASKS_BLOCK)), 8000)
    const taskBlock = document.querySelector(TASKS_BLOCK)
    note('U-2: «Задачи» открылись свободным блоком слоя результатов', opened,
      `блоков в слое: ${document.querySelectorAll('.ublock').length}`, 'Задачи')
    note('U-2: экрана центра задач на пол-окна не было', !document.body.classList.contains('task-center-open'),
      `task-center-open=${document.body.classList.contains('task-center-open')}`, 'Задачи')
    if (taskBlock) {
      const view = $('taskCenterView')
      note('U-2: экран центра задач живёт ВНУТРИ блока', Boolean(view && taskBlock.contains(view)),
        `родитель #taskCenterView: ${view?.parentElement?.className || 'нет узла'}`, 'Задачи')
      const box = taskBlock.getBoundingClientRect()
      note('U-2: блок «Задачи» размером около 360×480', box.width > 260 && box.width <= 520 && box.height > 300 && box.height <= 640,
        `${Math.round(box.width)}×${Math.round(box.height)}`, 'Задачи')
      const half = window.innerWidth / 2
      note('U-2: блок стоит в правой половине', box.left > half - 40,
        `левая край ${Math.round(box.left)}, окно ${window.innerWidth}`, 'Задачи')
      const composer = field ? field.getBoundingClientRect() : null
      const overlap = composer && box.bottom > composer.top && box.top < composer.bottom &&
        box.right > composer.left && box.left < composer.right
      note('Н95: блок не перекрывает строку ввода', !overlap,
        composer ? `ввод ${Math.round(composer.top)}–${Math.round(composer.bottom)}` : 'поля ввода нет', 'Задачи')
    }
  }

  // ─── 5. результаты-блоки ──────────────────────────────────────────────────
  scenario = 'результаты'
  // Блоки приезжают после того, как окно перечитает результаты открытого
  // диалога, поэтому ждём их, а не смотрим один раз и не заключаем «их нет».
  const gotBlock = await until(() => blocks().length > 0, 12000)
  note('появился блок результата', gotBlock,
    `блоков в слое ${blocks().length}, артефактов у диалога ждём от ленты`, 'результаты')
  const resultBlock = blocks().find(node => !/Задач|Task/i.test(node.textContent || '')) || blocks()[0]
  if (resultBlock) {
    const before = resultBlock.getBoundingClientRect()
    // Перетаскивание настоящими указателями, как это делает человек.
    const head = resultBlock.querySelector('.ublock-head')
    const down = new PointerEvent('pointerdown', { bubbles: true, clientX: before.left + 40, clientY: before.top + 12 })
    head?.dispatchEvent(down)
    for (let i = 1; i <= 6; i++) {
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: before.left + 40 - i * 30, clientY: before.top + 12 + i * 12
      }))
      await wait(40)
    }
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await wait(400)
    const after = resultBlock.getBoundingClientRect()
    note('блок перетаскивается за заголовок', Math.abs(after.left - before.left) > 20 || Math.abs(after.top - before.top) > 20,
      `было ${Math.round(before.left)},${Math.round(before.top)} — стало ${Math.round(after.left)},${Math.round(after.top)}`, 'результаты')

    const grip = resultBlock.querySelector('.ublock-grip[data-edge="se"]')
    if (grip) {
      const size0 = resultBlock.getBoundingClientRect()
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: size0.right - 4, clientY: size0.bottom - 4 }))
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: size0.right + 120, clientY: size0.bottom + 90 }))
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      await wait(400)
      const size1 = resultBlock.getBoundingClientRect()
      note('блок растягивается за угол', size1.width - size0.width > 40,
        `${Math.round(size0.width)}×${Math.round(size0.height)} → ${Math.round(size1.width)}×${Math.round(size1.height)}`, 'результаты')
    }
    resultBlock.querySelector('.ublock-min')?.click()
    await until(() => document.querySelector('.ublock-pill'), 6000)
    note('блок сворачивается в пилюлю', Boolean(document.querySelector('.ublock-pill')), 'пилюли нет', 'результаты')
    document.querySelector('.ublock-pill')?.click()
    await until(() => document.querySelector('.ublock'), 6000)
    note('пилюля разворачивается обратно', blocks().length > 0, 'блок не вернулся', 'результаты')
  }

  // ─── 6. строка ввода: в Ultra своя, а в чате — окна ─────────────────────────
  scenario = 'строка ввода'
  // ПРАВИЛО, РАЗЛИЧАЮЩЕЕ ДВА РЕЖИМА. На входе и в пустой сессии экран рисует
  // оболочка, и набирать надо в её поле (`textarea.uint`). В чате оболочка молчит,
  // и человек пишет в обычное поле окна. Проверять одно и то же поле в обоих
  // режимах значило бы требовать невозможного: в чате поля оболочки нет, и это
  // правильно.
  const inChat = shell()?.classList.contains('is-chat')
  const field = inChat ? $('composerTextarea') : ultraInput()
  note('строка ввода видна в том режиме, где человек пишет', visible(field),
    `режим=${shell()?.className}, поле=${field ? (visible(field) ? 'видно' : 'скрыто') : 'отсутствует'}`,
    'строка ввода')
  if (field && visible(field)) {
    field.value = 'Проверка ввода в Ultra'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(300)
    const send = inChat
      ? document.querySelector('.composer-send, .btn-send')
      : ultraSend()
    note('после набора кнопка отправки просыпается',
      send ? !send.disabled : false, send ? (send.disabled ? 'кнопка неактивна' : 'активна') : 'кнопки нет', 'строка ввода')
    note('кнопка отправки видна', visible(send), 'скрыта', 'строка ввода')
  }

  // ─── 7. длинный ответ и полосы прокрутки ─────────────────────────────────
  scenario = 'длинный ответ'
  const feed = document.querySelector('#chatFeed .feed-container')
  const scrollers = feed ? [...feed.querySelectorAll('*')].filter(node => {
    const style = window.getComputedStyle(node)
    return /auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight
  }) : []
  const widths = scrollers.map(node => Math.round(node.offsetWidth - node.clientWidth))
  note('U-1: в Ultra у ленты не видно полосы прокрутки', widths.every(w => w <= 1),
    `прокручиваемых предков ${scrollers.length}, ширина полосы ${widths.join(', ') || '—'}`, 'длинный ответ')

  // ─── 8. версия: оболочка следует за значением, без перезапуска ───────────
  // САМ ПЕРЕХОД ВЕРСИИ здесь не проверяется намеренно: он меряется шестью
  // кадрами `version-*` в `run-ultra-shell-ui.cjs` (выбор Ultra, окно Ultra,
  // возврат — RU и EN), и второй способ это мерить значит второй источник
  // правды. Здесь проверяется то, ради чего переключение и нужно: оболочка
  // живёт по значению `versionPreset` и перерисовывается сама, без перезапуска
  // окна. Значение подставляет сам тест, как это делает окно Настроек.
  scenario = 'смена версии'
  const cardOf = id => document.querySelector(`#editionChoices [data-edition="${id}"]`)
  const modal = () => $('settingsModal')
  const modalShown = () => Boolean(modal() && modal().style.display !== 'none')
  // Карточки и сам переход меряются шестью кадрами `version-*` в
  // `run-ultra-shell-ui.cjs`. Здесь проверяется другое: версия, выбранная
  // человеком, применяется к УЖЕ ОТКРЫТОМУ окну, и оболочка уходит и
  // возвращается сама. Нажимается та же карточка, что и в Настройках, — вызов
  // `setUiConfig` из пробы проверял бы не путь человека, а свой собственный.
  note('карточки версий есть в Настройках', Boolean(cardOf('ultra')) && Boolean(cardOf('default')),
    'карточек версии в разметке нет', 'смена версии')
  $('openSettingsBtn')?.click()
  const settingsOpen = await until(() => modalShown(), 8000)
  note('Настройки открылись', settingsOpen, 'окно настроек не открылось', 'смена версии')
  cardOf('default')?.click()
  await wait(800)
  // ПРИЗНАК, А НЕ ЗНАЧЕНИЕ. Признак `data-version-preset` ставится только для
  // НЕ обычной версии: в обычном виде его на корне нет вовсе. Проверять, что он
  // равен «default», значило бы требовать от разметки того, чего в ней нет, —
  // и находкой выдала бы правду. Проверяем, что Ultra больше не помечена, и что
  // конфигурация действительно перешла на обычную версию.
  const fell = await until(() => preset() !== 'ultra', 8000)
  note('карточка onlyone сняла признак Ultra без перезапуска', fell,
    `признак на корне: «${preset()}»`, 'смена версии')
  const cfg = await window.electronAPI.getUiConfig?.()
  expect('в конфигурации интерфейса версия — onlyone', 'default', cfg?.versionPreset || '(пусто)', 'смена версии')
  if (fell) {
    note('в обычном виде оболочка Ultra убрана сама', !document.querySelector('#ultraHost .ultra'),
      'оболочка осталась на месте', 'смена версии')
    note('в обычном виде поле ввода окна вернулось', visible($('composerTextarea')),
      'поле окна не вернулось', 'смена версии')
  }
  $('openSettingsBtn')?.click()
  await until(() => modalShown(), 8000)
  cardOf('ultra')?.click()
  await wait(800)
  const rose = await until(() => preset() === 'ultra', 8000)
  expect('карточка Ultra вернула оболочку, тоже без перезапуска', 'ultra', preset(), 'смена версии')
  if (rose) {
    note('после возврата оболочка нарисована', Boolean(shell()),
      'оболочки нет', 'смена версии')
  }

  await wait(500)
  return { ok: checks.every(one => one.pass), checks, found,
    summary: { checks: checks.length, failed: checks.filter(one => !one.pass).length, found: found.length } }
})().catch(error => ({ error: String(error && error.stack || error) }))
