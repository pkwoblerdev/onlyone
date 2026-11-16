// Состояния панели артефактов изнутри настоящего окна. Вызывается прогоном
// run-artifacts-ui.cjs; идентификаторы приходят через __ONECODE_ARG__ в base64.
(async () => {
  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const ids = decode('__ONECODE_ARG__')
  const $ = id => document.getElementById(id)
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms = 8000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(80) }
    return false
  }

  if (!await until(() => $('artifactPanel') && $('artifactChips'))) return { ok: false, checks: [{ name: 'интерфейс загрузился', pass: false }] }
  note('интерфейс загрузился', true)
  await wait(600)

  // Ряд кнопок принадлежит открытому диалогу (Н79), а артефакты прогона лежат
  // под диалогом `ids.chatId` — значит, прогон обязан открыть именно его. Путь
  // штатный: клик по строке истории (selectChat перестраивает ряд). Порядок
  // списка окно пересобирает по свежести, и «первый в списке» между прогонами не
  // постоянен, поэтому клик повторяется (образец — `artifact-chips-renderer.js`).
  let opened = false
  for (let attempt = 0; attempt < 8 && !opened; attempt++) {
    document.querySelector(`#chatHistoryList [data-chat-id="${ids.chatId}"] .history-item-title`)?.click()
    opened = await until(() => $('messagesList')?.dataset?.chatId === ids.chatId, 4000)
    if (!opened) await wait(250)
  }
  note('открыт диалог прогона (клик по строке истории)', opened,
    `открыт «${$('messagesList')?.dataset?.chatId || '?'}»`)
  if (!opened) return { ok: false, checks }

  // 1. Модель прислала результат: панель открылась, превью указывает на артефакт.
  await electronAPI.saveArtifactVersion({ id: ids.page, content: '<h1>Пальмы, тёмный фон</h1>' })
  if (!await until(() => !$('artifactPanel').hidden)) return { ok: false, checks }
  const frame = $('artifactFrame')
  note('панель открылась сама', !$('artifactPanel').hidden)
  note('превью ссылается на артефакт', (frame.currentSrc || frame.src).includes('onecode-artifact://' + ids.page + '/2-'), frame.currentSrc || frame.src)
  note('состояние загрузки снято после ответа', await until(() => $('artifactLoading').hidden, 4000))
  note('ошибки нет', $('artifactNotice').hidden, $('artifactNotice').textContent)

  // 2. Список версий — свой, с двумя пунктами и выбранной свежей.
  const select = $('artifactVersion')
  note('версий в списке две', select.options.length === 2, select.options.length)
  note('выбрана последняя', select.value === '2', select.value)
  note('список стал своим компонентом', select.dataset.enhanced === '1', select.className)

  // 3. Переключение версии меняет адрес превью.
  select.value = '1'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await until(() => (frame.currentSrc || frame.src).includes('/1-index.html'), 4000)
  note('старая версия открывается', (frame.currentSrc || frame.src).includes('/1-index.html'), frame.currentSrc || frame.src)

  // 4. Таблица показывается таблицей, а не текстом с запятыми.
  await electronAPI.saveArtifactVersion({ id: ids.table, content: 'план,цена\nстарт,0' })
  await until(() => $('artifactPanel').dataset.kind === 'table' && !$('artifactText').hidden, 4000)
  const cells = $('artifactText').querySelectorAll('th, td').length
  note('таблица размечена как таблица', !!$('artifactText').querySelector('table') && cells >= 4, 'ячеек: ' + cells)

  // 5. JSON-график открывается как визуализация, исходная структура остаётся
  // доступной для редактирования и не подставляется в HTML.
  await electronAPI.saveArtifactVersion({ id: ids.chart, content: JSON.stringify({
    type: 'line', title: 'Заказы по неделям', xLabel: 'Неделя', yLabel: 'Заказы',
    categories: ['1', '2', '3', '4'], series: [{ name: 'Факт', values: [4, 7, 5, 9] }]
  }) })
  await until(() => $('artifactPanel').dataset.kind === 'chart' && $('artifactText').querySelector('.artifact-chart-svg'), 4000)
  const chart = $('artifactText').querySelector('.artifact-chart-svg')
  note('JSON графика нарисован SVG, а не показан исходным текстом', !!chart && $('artifactText').textContent.includes('Заказы по неделям'), $('artifactText').textContent.slice(0, 120))
  note('линейная диаграмма содержит путь и маркеры данных', !!chart?.querySelector('.artifact-chart-line') && chart.querySelectorAll('.artifact-chart-point').length === 4)
  note('график доступен по имени и описанию', chart?.getAttribute('role') === 'img' && !!chart.querySelector('title') && !!chart.querySelector('desc'))

  // 6. Правка в панели уходит новой версией.
  await electronAPI.saveArtifactVersion({ id: ids.page, content: '<h1>третий вариант</h1>' })
  await wait(200)
  note('после правки версий три', select.options.length === 3, select.options.length)

  // 7. Файл версии потерян — панель говорит об этом словами.
  const renamed = await electronAPI.renameArtifact({ id: ids.broken, title: 'Потерянный файл' })
  await until(() => !$('artifactNotice').hidden, 4000)
  note('исчезнувшее содержимое замечено', !$('artifactNotice').hidden && !$('artifactPanel').hidden, $('artifactNotice').textContent)
  note('версия возвращена из переименования', renamed?.artifact?.title === 'Потерянный файл', renamed?.artifact?.title)

  // 7. Escape закрывает панель и возвращает фокус туда, где его взяли.
  $('artifactClose').click()
  await until(() => $('artifactPanel').hidden, 3000)
  $('newChatBtn').focus()
  await electronAPI.saveArtifactVersion({ id: ids.page, content: '<h1>финальное превью</h1>' })
  await until(() => !$('artifactPanel').hidden, 4000)
  await wait(400)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const closed = await until(() => $('artifactPanel').hidden, 3000)
  note('Escape закрывает панель', closed)
  note('фокус вернулся в интерфейс', document.activeElement === $('newChatBtn'), document.activeElement?.id)

  // 8. Ряд артефактов диалога существует и скрывается, когда показывать нечего.
  const chips = $('artifactChips')
  note('ряд артефактов есть в разметке', !!chips)

  // 9. Длинное имя в ряду: кнопка — flex-контейнер, и без своей подписи в
  // <span> имя обрезается с двух сторон вместо многоточия в конце.
  await electronAPI.saveArtifactVersion({ id: ids.long, content: '<p>длинное имя</p>' })
  await until(() => document.querySelector('#artifactChips .artifact-chip[data-id="' + ids.long + '"]'), 4000)
  const longChip = document.querySelector('#artifactChips .artifact-chip[data-id="' + ids.long + '"]')
  const chipLabel = longChip?.querySelector('span')
  const labelStyle = chipLabel && getComputedStyle(chipLabel)
  note('подпись в ряду — своим блоком', !!chipLabel && chipLabel.textContent.length > 40, longChip?.textContent)
  note('длинное имя обрезано с многоточием', labelStyle?.textOverflow === 'ellipsis' &&
    labelStyle?.whiteSpace === 'nowrap' && chipLabel.scrollWidth > chipLabel.clientWidth,
    chipLabel?.scrollWidth + ' > ' + chipLabel?.clientWidth)
  note('кнопка не расходится шире ряда', longChip.getBoundingClientRect().width <= 221,
    Math.round(longChip.getBoundingClientRect().width) + ' пикс.')
  // Переключатель версии в тесной шапке не должен схлопываться до стрелки.
  await until(() => !$('artifactPanel').hidden && $('artifactLoading').hidden, 4000)
  const label = document.querySelector('#artifactVersion + .select-ui [data-value-label]')
  note('номер версии в шапке виден', /^#\d+$/.test(label?.textContent || ''), label?.textContent)
  const wide = el => Math.round(el?.getBoundingClientRect().width || 0)
  note('переключатель не сжат в ноль', wide(label) > 0,
    'панель ' + wide($('artifactPanel')) + ' · поле ' + wide(document.querySelector('#artifactVersion + .select-ui')) +
    ' · кнопка ' + wide(document.querySelector('#artifactVersion + .select-ui .select-ui-trigger')) +
    ' · подпись ' + wide(label))
  // 10. Панель не лежит на ленте (замечание владельца 22.09: «плашка не
  // корректируется, половина накладывается»).
  const edge = el => Math.round(el.getBoundingClientRect().right)
  const panelLeft = Math.round($('artifactPanel').getBoundingClientRect().left)
  note('лента не заезжает под панель', edge($('chatFeed')) <= panelLeft + 1,
    edge($('chatFeed')) + ' против ' + panelLeft)
  note('поле ввода не под панелью', edge($('composerCard')) <= panelLeft + 1,
    edge($('composerCard')) + ' против ' + panelLeft)
  note('ряд артефактов не под панелью', edge(chips) <= panelLeft + 1, edge(chips) + ' против ' + panelLeft)

  // 11. Шапка: пять подписанных кнопок не оставляли места ни названию, ни
  // номеру версии — редкие действия ушли в «Ещё», добавился «Развернуть».
  // С 23.09 шапка в две строки: название с крестиком сверху, инструменты ниже.
  const actions = [...document.querySelectorAll('.artifact-head .artifact-action, .artifact-head .artifact-close')].map(node => node.id)
  note('в шапке четыре кнопки', actions.length === 4 && actions.includes('artifactExpand') &&
    actions.includes('artifactMore') && actions.includes('artifactClose') &&
    !actions.includes('artifactRename') && !actions.includes('artifactArchive'),
    actions.join(', '))
  const titleWidth = $('artifactTitle').getBoundingClientRect().width
  const headWidth = document.querySelector('.artifact-titlebar').getBoundingClientRect().width
  note('название занимает строку, а не остаток', titleWidth >= headWidth * 0.5, Math.round(titleWidth) + ' из ' + Math.round(headWidth))
  $('artifactMore').click()
  const menu = await until(() => document.querySelector('.ctx-menu'), 3000)
  const items = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(node => node.textContent.trim())
  // Число здесь — не смысл: смысл в том, что редкие действия живут в меню, а не
  // в шапке (см. «в шапке четыре кнопки» выше). 26.09 в меню добавила выгрузка
  // артефакта, и проверка обновлена до четырёх — объявлено в плане, файл ведёт
  // не Design-зона.
  note('в «Ещё» четыре действия', Boolean(menu) && items.length === 4, items.join(' | '))
  note('из меню можно переименовать, открыть папку и убрать',
    /переимен/i.test(items.join(' ')) && /папк/i.test(items.join(' ')) && /убрат/i.test(items.join(' ')),
    items.join(' | '))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until(() => !document.querySelector('.ctx-menu'), 3000)
  note('Escape снимает меню, а не панель', !document.querySelector('.ctx-menu') && !$('artifactPanel').hidden)

  // 12. «Развернуть» — панель на весь чат и обратно.
  const before = $('artifactPanel').getBoundingClientRect().width
  const viewWidth = $('chatView').getBoundingClientRect().width
  $('artifactExpand').click()
  await wait(200)
  const expandedWidth = $('artifactPanel').getBoundingClientRect().width
  note('развёрнутая панель занимает весь чат', expandedWidth > viewWidth - 40,
    Math.round(expandedWidth) + ' из ' + Math.round(viewWidth))
  note('кнопка говорит «Свернуть»', /Свернуть|Collapse/.test($('artifactExpand').textContent) &&
    $('artifactExpand').getAttribute('aria-pressed') === 'true', $('artifactExpand').textContent)
  $('artifactExpand').click()
  await wait(200)
  note('обратно — та же ширина, что была', Math.abs($('artifactPanel').getBoundingClientRect().width - before) < 2,
    Math.round(before) + ' → ' + Math.round($('artifactPanel').getBoundingClientRect().width))

  // The old starter-command cards were removed from the welcome screen; slash
  // commands remain discoverable from the composer instead.
  note('карточек команд нет на экране приветствия', !document.querySelector('.starter-grid, .starter-card'))

  return { ok: checks.every(item => item.pass), checks }
})()
