// Вкладка «Провайдеры и ключи» в настоящем окне (план, 2.8б).
//
// Проверяется то, что нельзя увидеть по одному снимку: что именно показано при
// каждом выбранном пути, где чип состояния, раскрывается ли меню строки, и
// накладывается ли что-нибудь где-нибудь — на ширине настроек и при 125%
// масштабе Windows. Локаль меряется словом: на английском экране панель не
// обязана содержать ни одного кириллического знака.
(async () => {
  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(60) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const text = id => ($(id)?.textContent || '').replace(/\s+/g, ' ').trim()
  const box = el => el.getBoundingClientRect()
  const live = id => {
    const node = $(id)
    if (!node) return false
    const r = box(node)
    return r.width > 0 && r.height > 0
  }
  const panel = $('panel-keys')
  const rows = () => [...document.querySelectorAll('#customConnectionsList .conn-row')]
  const rowByName = name => rows().find(one => (one.querySelector('.key-name')?.textContent || '').trim() === name)
  const choose = async id => {
    const select = $('providerSelect')
    select.value = id
    select.dispatchEvent(new Event('change', { bubbles: true }))
    // Ждём не таймера, а конца перерисовки: строку пути пишет тот же проход,
    // который прячет и показывает группы. Без этого проверка снимала экран на
    // середине перехода и падала от скорости машины.
    await until(() => new RegExp(arg.noteOf[id] || id, 'i').test(text('providerPathNote')), 12000)
    await wait(350)
  }

  await until(() => document.documentElement.dataset.appReady === '1')
  await wait(1200)
  // Язык берётся из профиля, а не переключается здесь: первый экран с
  // английским профилем обязан быть английским сам, без ручного `setLanguage`.
  $('openSettingsBtn')?.click()
  await wait(700)
  $('tab-keys')?.click()
  await wait(600)
  note('язык окна применён при первой же отрисовке вкладки',
    (panel.innerText || '').includes(arg.labels.pathTitle), arg.labels.pathTitle)

  // ── состояния ──────────────────────────────────────────────────────────────
  if (arg.state === 'openrouter') {
    // Путь выбирается явно: профиль может стартовать с любого из них, а
    // проверка утверждает экран, а не удачное совпадение с посевом.
    await choose('openrouter')
    note('на OpenRouter остался один пул ключей',
      live('openrouterKeysGroup') && !live('providerFieldsGroup') && !live('customConnectionsGroup'),
      `пул=${live('openrouterKeysGroup')} поля=${live('providerFieldsGroup')} список=${live('customConnectionsGroup')} | ${text('providerPathNote').slice(0, 70)}`)
    note('путь в списке выбран встроенный', $('providerSelect')?.value === 'openrouter', $('providerSelect')?.value)
    note('пул показал свои строки', document.querySelectorAll('#keysPoolList .key-row').length === 2,
      'строк: ' + document.querySelectorAll('#keysPoolList .key-row').length)
    note('у пула есть строка добавления с подписью',
      (document.querySelector('#openrouterKeysGroup .row-title')?.textContent || '').length > 0)
  }

  if (arg.state === 'named') {
    await choose('anthropic')
    note('у именованного пути показаны его поля, а не список подключений и не пул',
      live('providerFieldsGroup') && !live('customConnectionsGroup') && !live('openrouterKeysGroup'))
    note('группа названа провайдером',
      /Anthropic/.test(text('providerFieldsTitle')), text('providerFieldsTitle'))
    note('чип состояния показывает, чего не хватает',
      /Нет ключа|Не проверен|Подключено|Ошибка|No API key|Not checked|Connected|Error/.test(text('providerPathState')),
      text('providerPathState'))
    const buttons = [...document.querySelectorAll('#providerActions button')]
    note('действий в строке два, и порядок — проверить, потом сохранить',
      buttons.map(one => one.id).join(',') === 'btnCheckCustomProvider,btnSaveCustomProvider',
      buttons.map(one => one.id).join(','))
    note('адрес по умолчанию пришёл из каталога',
      ($('customBaseUrlInput')?.placeholder || '').startsWith('https://api.anthropic.com'),
      $('customBaseUrlInput')?.placeholder)
    note('ограничения пути спрятаны в раскрытие и не занимают экран',
      !$('customProviderUnsupported')?.open && ($('customProviderUnsupportedNotes')?.textContent || '').length > 10,
      (text('customProviderUnsupportedNotes') || '').slice(0, 60))
  }

  if (arg.state === 'connections') {
    await choose('openai-compatible')
    note('на своём пути показан список подключений и его поля, пул скрыт',
      live('customConnectionsGroup') && live('providerFieldsGroup') && !live('openrouterKeysGroup'))
    note('в списке обе строки со своими именами',
      Boolean(rowByName(arg.names[0])) && Boolean(rowByName(arg.names[1])),
      rows().map(one => one.querySelector('.key-name')?.textContent).join(', '))
    note('строка называет короткий адрес, а не полный URL',
      (rowByName(arg.names[0])?.querySelector('.conn-addr')?.textContent || '').includes('/home/v1'),
      rowByName(arg.names[0])?.querySelector('.conn-addr')?.textContent)
    note('ход подписан у того подключения, который действует',
      rowByName(arg.names[0])?.querySelector('.conn-flag')?.textContent === arg.labels.turnsHere,
      rowByName(arg.names[0])?.querySelector('.conn-flag')?.textContent)
    rowByName(arg.names[1])?.querySelector('.conn-more')?.click()
    await wait(300)
    const menu = rowByName(arg.names[1])?.querySelector('.conn-menu')
    note('меню «⋯» раскрывается над тремя пунктами',
      menu && menu.hidden === false && menu.querySelectorAll('.conn-menu-item').length === 3)
    note('раскрытое меню не легло на соседнюю строку',
      box(menu).bottom <= box(panel).bottom + 1 &&
      !rows().some((one, index) => index !== 1 && box(one).height > 0 &&
        Math.min(box(one).bottom, box(menu).bottom) - Math.max(box(one).top, box(menu).top) > 2))
    // «Удалить» из меню обязано спросить, а не стереть: карточка подключения
    // дорогая, и ход на неё мог быть действующим. Спрашиваем и ОТМЕНЯЕМ —
    // удаление до диска в этом прогоне не доходит.
    rowByName(arg.names[1])?.querySelector('.conn-menu-item[data-action=remove]')?.click()
    const asked = await until(() => {
      const modal = $('confirmModal')
      return Boolean(modal) && modal.hidden !== true && box(modal).height > 0
    }, 6000)
    const askedText = ($('confirmMessage')?.textContent || '').trim()
    note('удаление подключения спрашивает и называет его именем',
      asked && askedText.includes(arg.names[1]), askedText)
    $('confirmCancelBtn')?.click()
    await wait(400)
    note('после отказа подключение осталось в списке',
      Boolean(rowByName(arg.names[1])) && rows().length === 2,
      'строк: ' + rows().length)
    // Чипы относятся к своей строке: проверенный путь говорит «Подключено»,
    // а отказ эндпоинта — «Ошибка: …» с причиной. Один чип на всю группу тут
    // врал бы про второе подключение.
    const chipOf = name => (rowByName(name)?.querySelector('.conn-state')?.textContent || '').trim()
    note('строка проверенного подключения говорит «подключено»',
      /Подключено|Connected/.test(chipOf(arg.names[0])), chipOf(arg.names[0]))
    note('строка с отказом эндпоинта говорит «ошибка» и называет причину',
      /^Ошибка:|^Error:/.test(chipOf(arg.names[1])) && chipOf(arg.names[1]).includes('HTTP 401'),
      chipOf(arg.names[1]))
  }

  if (arg.state === 'fields') {
    await choose('openai-compatible')
    rowByName(arg.names[1])?.querySelector('.conn-more')?.click()
    await wait(250)
    rowByName(arg.names[1])?.querySelector('.conn-menu-item[data-action=edit]')?.click()
    await wait(600)
    note('«Изменить» показало поля этого подключения',
      $('customProviderNameInput')?.value === arg.names[1] &&
      ($('customBaseUrlInput')?.value || '').includes('/work/v1'),
      ($('customBaseUrlInput')?.value || ''))
    note('у своего пути есть строка имени', live('customProviderNameRow'))
    $('customProviderUnsupported') && ($('customProviderUnsupported').open = true)
    await wait(250)
    note('ограничения раскрываются одной строкой',
      $('customProviderUnsupported')?.open === true && box($('customProviderUnsupportedNotes')).height > 8)
    note('ключ назван состоянием, а не символами',
      /(способ защиты неизвестен|protection unknown|Ключ защищён|is protected)/.test(text('customProviderKeyState')),
      text('customProviderKeyState'))
    note('в окне нет ни одного символа сохранённого ключа',
      !document.documentElement.innerHTML.includes(arg.secretMark), arg.secretMark)
  }

  // ── наложения и подписи: одна и та же мера на всех четырёх состояниях ──────
  const sameParentPairs = () => {
    const items = [...panel.querySelectorAll('.setting-row, .conn-row, .key-row, .row-foot, .settings-group-more, .settings-group-head')]
      .filter(one => box(one).height > 0 && one.offsetParent !== null)
    const bad = []
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (items[i].parentElement !== items[j].parentElement) continue
        const a = box(items[i]), b = box(items[j])
        const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (dx > 2 && dy > 2) bad.push(`${items[i].className} / ${items[j].className}`)
      }
    }
    return bad
  }
  const spill = () => {
    const p = box(panel)
    return [...panel.querySelectorAll('.setting-row, .conn-row, .key-row, .row-foot')]
      .filter(one => box(one).height > 0)
      .filter(one => box(one).right > p.right + 1 || box(one).left < p.left - 1)
      .map(one => one.className)
  }
  const collide = () => [...panel.querySelectorAll('.setting-row')]
    .filter(row => {
      const label = row.querySelector('.row-label')
      const control = row.querySelector('.field-input, .field-select, .password-input-wrap, .toggle-switch, .add-key-row')
      if (!label || !control) return false
      if (row.classList.contains('setting-row-stack')) return false
      return Math.min(box(label).right, box(control).right) - Math.max(box(label).left, box(control).left) > 2
    })
    .map(row => (row.querySelector('input, select') || {}).id || row.className)
  const unsigned = [...panel.querySelectorAll('.setting-row')]
    .filter(row => {
      const control = row.querySelector('input:not([type="checkbox"]), select')
      if (!control || control.hidden) return false
      return !(row.querySelector('.row-title')?.textContent || '').trim()
    })
    .map(row => row.querySelector('input, select').id)

  // Внутри строки — та же беда, что и между блоками: длинный чип сжимает имя
  // до нуля и налезает на соседний элемент. Меряется по детям `.key-head`.
  const inlineCollide = () => {
    const bad = []
    for (const head of panel.querySelectorAll('.key-head')) {
      const kids = [...head.children].filter(one => box(one).width > 0)
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = box(kids[i]), b = box(kids[j])
          const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          if (dx > 2 && dy > 2) {
            bad.push(`${kids[i].className} / ${kids[j].className}`)
          }
        }
      }
    }
    return bad
  }

  // Имена меряются только на видимых строках: скрытая группа пула даёт нулевую
  // ширину, и проверка падала бы на том, чего человек не видит.
  const squeezed = [...panel.querySelectorAll('.key-name')]
    .filter(one => one.offsetParent !== null)
    .filter(one => box(one).width <= 24)
    .map(one => `${one.textContent.trim().slice(0, 18)}=${Math.round(box(one).width)}px`)

  note('ни один блок вкладки не лёг на соседний', sameParentPairs().length === 0, sameParentPairs().join(' | '))
  note('элементы внутри строки не налезают друг на друга', inlineCollide().length === 0, inlineCollide().join(' | '))
  note('имя в строке видно, а не сжато чипом', squeezed.length === 0, squeezed.join(' | '))

  // ── правки приёмки 28.09 19:40 ──────────────────────────────────────
  // 1) Имена строк списка стояли в разных колонках (465 и 486 px): глобальная
  //    кнопка центрирует содержимое, и флаг «ход идёт здесь» менял ширину кнопки
  //    вместе с местом имени. 2) «Сохранить» выглядела вторичной, как
  //    «Проверить»: по карточке `Button` главное действие экрана — акцентное.
  const fill = node => getComputedStyle(node).backgroundColor
  const tokenFill = expression => {
    const probe = document.createElement('span')
    probe.style.cssText = `position:absolute;left:-9999px;top:0;background:${expression}`
    panel.appendChild(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
  }
  const accentFill = tokenFill('var(--accent)')
  const accentFillFor = node => tokenFill(node.matches(':hover:not(:disabled)') && matchMedia('(hover: hover)').matches
    ? 'var(--accent-hover)' : 'var(--accent)')
  const nameCols = [...panel.querySelectorAll('.conn-row .key-name')]
    .filter(one => one.offsetParent !== null)
    .map(one => ({ name: (one.textContent || '').trim().slice(0, 12), x: Math.round(box(one).left) }))
  const nameSpread = nameCols.length > 1
    ? Math.max(...nameCols.map(one => one.x)) - Math.min(...nameCols.map(one => one.x))
    : 0
  const primaries = [...panel.querySelectorAll('.btn-primary')].filter(one => one.offsetParent !== null)
  const save = $('btnSaveCustomProvider')

  note('имена строк списка стоят в одной колонке', nameSpread <= 1,
    `${nameCols.map(one => `${one.name}=${one.x}px`).join(' | ')} · разница ${nameSpread}px`)
  note('главное действие экрана одно и оно залито акцентом',
    primaries.length === 1 && fill(primaries[0]) === accentFillFor(primaries[0]),
    `${primaries.map(one => `${one.id}=${fill(one)}`).join(' | ')} · акцент ${accentFill}`)
  if (save && save.offsetParent !== null) {
    const checkBtn = $('btnCheckCustomProvider')
    note('«Сохранить» не похожа на «Проверить»: акцент против вторичной',
      fill(save) === accentFillFor(save) && ![accentFill, tokenFill('var(--accent-hover)')].includes(fill(checkBtn)),
      `save=${fill(save)} check=${fill(checkBtn)} акцент=${accentFill} текст=${getComputedStyle(save).color}`)
  }
  note('ничего не вылезло за панель настроек', spill().length === 0, spill().join(' | '))
  note('подпись и управление в строке не слиплись', collide().length === 0, collide().join(' | '))
  note('у каждого видимого поля есть подпись', unsigned.length === 0, unsigned.join(' | '))
  const leaks = []
  if (arg.lang === 'en') {
    // Кириллица меряется по элементом, а не по всему экрану: подписи раскладки
    // (заголовки групп, строки, подсказки, кнопки, раскрытие) обязаны быть
    // переведены. Русское слово внутри чипа «Ошибка: …», в строке отказа и в
    // названиях путей — текст главного процесса: у него нет языка окна, и по
    // этому пути его снимает пункт 2.6б, а не эта вкладка.
    const FROM_MAIN = ['.conn-state', '#providerPathState', '#customProviderMessage', 'option']
    const selector = '.settings-group-title, .row-title, .row-hint, .section-badge, summary, button, .conn-state, #customProviderMessage, .field-select option'
    const offenders = [...panel.querySelectorAll(selector)]
      .filter(one => one.tagName === 'OPTION' || one.offsetParent !== null)
      .map(one => ({
        text: (one.textContent || '').replace(/\s+/g, ' ').trim(),
        fromMain: FROM_MAIN.some(what => one.matches(what))
      }))
      .filter(one => /[А-Яа-яЁё]/.test(one.text))
    const own = offenders.filter(one => !one.fromMain).map(one => one.text)
    note('ни одной русской подписи раскладки на английском экране', own.length === 0, own.join(' | '))
    // Русское слово в подсказке поля — дефект, только если оно принадлежит
    // вкладке. Каталог путей называет ключ своими словами («API-ключ
    // Anthropic (sk-ant-…)»), и у окна на это языка нет: провайдера выдаёт
    // латинское имя в самой строке, и чинит её пункт 2.6б.
    const catalogShaped = /Anthropic|OpenAI|Google|Ollama|OpenCode/
    const placeholders = [...panel.querySelectorAll('input[placeholder], textarea[placeholder]')]
      .filter(one => one.offsetParent !== null)
      .map(one => ({ node: one, value: one.getAttribute('placeholder') || '' }))
      .filter(one => /[А-Яа-яЁё]/.test(one.value))
    const myPlaceholders = placeholders.filter(one => !catalogShaped.test(one.value))
      .map(one => `${one.node.id}: ${one.value}`)
    note('ни одного русского подсказочного слова в поле на английском экране',
      myPlaceholders.length === 0, myPlaceholders.join(' | '))
    for (const one of placeholders.filter(one => catalogShaped.test(one.value))) {
      leaks.push(`подсказка поля из каталога: ${one.value.slice(0, 60)}`)
    }
    for (const one of offenders.filter(one => one.fromMain)) {
      leaks.push(`${one.text.slice(0, 64)}`)
    }
  }

  return { ok: checks.every(one => one.pass), checks, leaks, state: arg.state, lang: arg.lang }
})()
