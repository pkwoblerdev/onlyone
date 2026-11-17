// Галерея версий и выгрузка артефакта (план, 1.4).
//
// Узловые наборы проверяют хранитель и модуль экспорта по отдельности; здесь
// нужна связка целиком: настоящий ряд артефактов, настоящая панель, настоящее
// меню «Ещё» и настоящий канал выгрузки в главном процессе.
//
// Системный диалог сохранения специально НЕ открывается: он модальный и
// машинному прогону не отвечают, а его отсутствие — не повод оставить весь путь
// непроверенным. Поэтому вызовы выгрузки записываются заглушкой, а настоящий
// канал проверяется на отказе, который случается ДО диалога.
(async () => {
  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const until = async (fn, ms = 12000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch (err) { /* состояние ещё не собрано */ }
      await wait(60)
    }
    return false
  }

  if (!await until(() => $('artifactPanel') && $('artifactChips'))) {
    return { ok: false, checks: [{ name: 'интерфейс загрузился', pass: false }] }
  }

  // Ряд кнопок принадлежит открытому диалогу (Н79), а артефакты прогона лежат
  // под диалогом `arg.chatId`: прогон открывает именно его строкой истории — тем
  // же путём, каким это делает человек. Порядок список пересобирает по свежести,
  // «первый в списке» между прогонами не постоянен, поэтому клик повторяется
  // (образец — `artifact-chips-renderer.js`).
  let opened = false
  for (let attempt = 0; attempt < 8 && !opened; attempt++) {
    document.querySelector(`#chatHistoryList [data-chat-id="${arg.chatId}"] .history-item-title`)?.click()
    opened = await until(() => $('messagesList')?.dataset?.chatId === arg.chatId, 4000)
    if (!opened) await wait(250)
  }
  note('открыт диалог прогона (клик по строке истории)', opened,
    `открыт «${$('messagesList')?.dataset?.chatId || '?'}»`)
  if (!opened) return { ok: false, checks }

  const ID = arg.page
  if (!ID) return { ok: false, checks: [{ name: 'артефакт подсеян в прогон', pass: false }] }
  // Ряд наполняется событием об артефакте, а не списком с диска: без этого
  // кнопка открыть нечего (тот же приём у соседнего прогона артефактов). Ряд
  // принадлежит открытому диалогу (Н79), и подсечённые кнопки в нём — только
  // пока открыт диалог прогона, поэтому ряд и проверяется, и пополняется через
  // `ensureChips`: тем путём, каким это делает сама программа — событием об
  // артефакте. Им служит график «Заказы по неделям»: его версий прогон не
  // касается, а ряд перестраивается по всему диалогу сразу.
  const chipOf = id => document.querySelector(`#artifactChips .artifact-chip[data-id="${id}"]`)
  const CHART_SPEC = JSON.stringify({
    type: 'bar', title: 'Заказы по неделям', xLabel: 'Неделя', yLabel: 'Заказы',
    categories: ['1', '2', '3'], series: [{ name: 'Факт', values: [4, 7, 5] }]
  })
  // Запись меты на Windows ловит временную блокировку файла (находка Н78);
  // прогон повторяет событие, потому что проверяет галерею, а не устойчивость
  // диска. Артефакт при этом остаётся тот же — повтор версии, не новый артефакт.
  const refill = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await window.electronAPI.saveArtifactVersion({ id: arg.chart, content: CHART_SPEC })
      } catch { await wait(250); continue }
      // Событие показывает сам артефакт: этого показания надо дождаться, иначе
      // следующий клик станет соревноваться с ним за то, что на экране.
      await until(() => $('artifactTitle')?.textContent.trim() === 'Заказы по неделям', 3000)
      return true
    }
    return false
  }
  const ensureChips = async id => {
    if (await until(() => Boolean(chipOf(id)), 2500)) return true
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await refill()) break
      if (await until(() => Boolean(chipOf(id)), 3000)) return true
    }
    return false
  }
  await window.electronAPI.saveArtifactVersion({ id: ID, content: '<h1>Третья</h1>' })
  if (!await ensureChips(ID)) {
    return { ok: false, checks: [{ name: 'ряд артефактов наполнен', pass: false }] }
  }
  chipOf(ID)?.click()
  const shown = await until(() => $('artifactPanel').hidden === false &&
    $('artifactVersion')?.options?.length === 3)
  note('Артефакт с тремя версиями открыт в панели', shown,
    $('artifactVersion')?.options?.length ?? 0)

  const rows = () => [...document.querySelectorAll('#artifactVersions .artifact-version-row')]
  const texts = () => rows().map(row => row.textContent.trim())
  note('галерея показывает все три версии', await until(() => rows().length === 3), texts().join(' | '))
  note('в строке есть вид, местная дата и размер',
    rows().every(row => /Страница/.test(row.textContent) &&
      /\d{2}\.\d{2}\.\d{4}/.test(row.textContent) && /знак/.test(row.textContent)),
    texts()[0] || '')
  note('строки — кнопки с доступным именем',
    rows().every(row => row.tagName === 'BUTTON' && row.type === 'button' && row.getAttribute('aria-label')),
    rows().map(row => row.getAttribute('aria-label')).join(' | '))
  const marked = () => rows().filter(row => row.getAttribute('aria-current') === 'true')
  note('помечена ровно одна версия', marked().length === 1, marked().map(row => row.dataset.version).join(','))

  const second = rows().find(row => row.dataset.version === '2')
  second?.click()
  // Строка живёт в DOM, который перерисовывается вместе с показом: между
  // запросом и нажатием узел мог быть заменён, поэтому нажатие повторяется по
  // свежему списку. Это не снисходительность к продукту: если бы перерисовка
  // возвращала показанную версию к последней, ни одна попытка не сработала бы,
  // и проверка осталась красной.
  let switched = false
  for (let attempt = 0; attempt < 10 && !switched; attempt++) {
    const row = rows().find(item => item.dataset.version === '2')
    row?.click()
    await wait(120)
    switched = $('artifactVersion').value === '2' &&
      marked().length === 1 && marked()[0].dataset.version === '2'
  }
  note('клик по строке переключает версию и метку', switched,
    `select=${$('artifactVersion').value}, помечена=${marked().map(row => row.dataset.version).join(',')}`)
  note('подпись в шапке едет за версией', $('artifactMeta').textContent.includes('версия 2 из 3'),
    $('artifactMeta').textContent)

  // Настоящее меню открывается одним узлом на весь экран, но между двумя
  // открытиями его обязано не быть: иначе следующая порция пунктов наложится на
  // прежнюю, и прогон станет сравнивать себя с прошлым открытием.
  const menuItems = () => [...document.querySelectorAll('.ctx-menu .ctx-item')]
  // Escape без открытого меню закрывает саму панель — прогон тогда продолжал бы
  // сравнивать себя с уже убранным экраном. Клавиша уходит, только пока узел
  // меню действительно есть.
  const closeMenu = async () => {
    for (let attempt = 0; attempt < 3 && document.querySelector('.ctx-menu'); attempt++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wait(80)
    }
    return until(() => !document.querySelector('.ctx-menu'), 2000)
  }
  const openMenu = async action => {
    if (!await closeMenu()) return false
    $('artifactMore').click()
    return until(() => menuItems().some(item => item.textContent.trim() === action) &&
      document.querySelectorAll('.ctx-menu').length === 1)
  }
  const menuOpen = await openMenu('Выгрузить артефакт')
  note('в «Ещё» есть пункт выгрузки', menuOpen, menuItems().map(item => item.textContent.trim()).join(' | '))
  menuItems().find(item => item.textContent.trim() === 'Выгрузить артефакт')?.click()
  const formatsShown = await until(() => {
    const items = menuItems().map(item => item.textContent.trim())
    return items.includes('Файл как есть') && items.includes('HTML-страницей') && items.includes('PNG-картинкой')
  })
  note('выгрузка предлагает форматы вида', formatsShown,
    menuItems().map(item => item.textContent.trim()).join(' | '))

  // Путь «клик по формату → канал → главный процесс → ответ панели» проверяется
  // на артефакте, версии которого нет на диске: отказ случается до диалога
  // сохранения, а модальное окно машина не закрыла бы. Заодно это настоящая
  // проверка того, что у одноверсионного артефакта галерея не показывается.
  await closeMenu()
  const chipCount = () => document.querySelectorAll('#artifactChips .artifact-chip').length
  await ensureChips(arg.broken)
  // Ряд перестраивается целиком (`innerHTML = ''` и новые кнопки), поэтому между
  // поиском кнопки и нажатием её могли заменить: прогон промахивался молча и
  // дальше говорил о не показанном артефакте. Кнопка берётся свежей, нажатие
  // повторяется. Настоящую подмену показа это не прячет: если клик не переключает
  // панель, условие не выполнится ни с какой попытки.
  let brokenShown = false
  for (let attempt = 0; attempt < 12 && !brokenShown; attempt++) {
    const chip = document.querySelector(`#artifactChips .artifact-chip[data-id="${arg.broken}"]`)
    if (chip) chip.click()
    await wait(150)
    brokenShown = $('artifactPanel').hidden === false &&
      $('artifactTitle').textContent.includes('Потерянный')
  }
  note('артефакт с одной версией открыт', brokenShown,
    `${$('artifactTitle').textContent} · кнопок в ряду ${chipCount()}`)
  note('у одной версии галерея не показывается',
    !brokenShown || $('artifactVersions').hidden === true && rows().length === 0,
    `строк: ${rows().length}`)

  const secondMenu = await openMenu('Выгрузить артефакт')
  note('«Ещё» открылось заново одним узлом меню', secondMenu,
    `узлов меню ${document.querySelectorAll('.ctx-menu').length}`)
  menuItems().find(item => item.textContent.trim() === 'Выгрузить артефакт')?.click()
  // Один узел требуется и здесь: наложившееся прежнее меню показало бы три
  // формата под подписью «только файл», и проверка стала бы самообманом.
  const onlyFile = await until(() => document.querySelectorAll('.ctx-menu').length === 1 &&
    menuItems().length === 1 && menuItems()[0].textContent.trim() === 'Файл как есть')
  note('коду предлагается только файл', onlyFile,
    menuItems().map(item => item.textContent.trim()).join(' | '))
  const notice = $('artifactNotice')
  menuItems().find(item => item.textContent.trim() === 'Файл как есть')?.click()
  const told = await until(() => notice.hidden === false && /не вышло|нет|найден/.test(notice.textContent), 8000)
  note('выгрузка отказывает до диалога и говорит об этом словами', told, notice.textContent)

  // Настоящий канал: отказ до диалога проверяется без модального окна — формат,
  // который виду не принадлежит, главный процесс отвергает сам.
  const refused = await window.electronAPI.exportArtifact({ artifactId: ID, version: 2, format: 'svg' })
  note('настоящий канал отвергает формат, несовместимый с видом',
    refused?.ok === false && refused?.cancelled !== true && String(refused?.error || '').length > 4,
    JSON.stringify(refused || {}))

  const missing = await window.electronAPI.exportArtifact({ artifactId: 'net-takogo', format: 'file' })
  note('настоящий канал отвергает чужой артефакт',
    missing?.ok === false && missing?.cancelled !== true, JSON.stringify(missing || {}))

  return { ok: checks.every(item => item.pass), checks }
})()
