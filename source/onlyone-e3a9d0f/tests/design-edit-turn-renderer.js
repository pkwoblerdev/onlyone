// design-edit-turn-renderer.js — оконная проверка шага 2 пункта 4.2: правка
// макета из чата идёт ХОДОМ ДИЗАЙНА, и только когда макет открыт в окне.
//
// Запускается главным процессом по ONECODE_SMOKE (см. `tests/app-launch.cjs`),
// режим и язык приходят base64-аргументом `__ONECODE_ARG__`, как в
// `tests/design-task-renderer.js`. Путь настоящий, поддельных событий нет:
// макет лежит в профиле, просьба уходит через форму чата, ход ведёт тестовый
// провайдер из файла-сценария (`ONECODE_PROVIDER_FILE`, шов плана 2c), ключ
// фиктивный, сети нет.
//
// Режимы:
//   waiting  — макет НЕ открыт в окне → карточка «ждёт — откроется при следующем
//              запуске», версия макета не изменилась;
//   turn     — макет открыт → карточка «правка идёт ходом Дизайна», и версия того
//              же макета выросла (правку сделал ход Дизайна);
//   unfocus  — макет открывали и закрыли → снова «ждёт».
//
// Снимок окно делает ПОСЛЕ возврата этого скрипта, поэтому каждый режим
// возвращается ровно в том состоянии, которое доказывает, и карточку перед этим
// прокручивает в поле зрения.
//
// С 29.09 (дефект Н96) в режиме `turn` добавлено ожидание загрузки кадра-превью:
// лента обязана уйти на снимок с загруженным показанным `<iframe>`, а не с тем,
// который только начал грузиться. Мерка — событие `load` узла (содержимое кадра
// окно не читает: sandbox без allow-same-origin).
(async () => {
  const decodeArg = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decodeArg('__ONECODE_ARG__')
  const mode = arg.mode || 'waiting'
  const lang = arg.lang || 'ru'
  const MARKER = arg.marker || 'МИШЕНА-ПРАВОК'
  const DESIGN_ID = arg.designId || 'dproof42'
  const COMPONENT = arg.component || 'Home.dc.html'
  const CHAT_ID = arg.chatId || 'chat-edit-turn'
  const TOPIC = arg.topic || 'Лендинг доставки цветов'
  const ASK = arg.ask || 'Поправь макет из окна'
  // Просьба модели печатается в карточке как текст задачи: её надо снять перед
  // поиском слов состояния, иначе «правка» находилась бы в самой просьбе, а не в
  // подписи состояния.
  const INSTRUCTION = String(arg.instruction || '')
  const L = arg.labels || {}
  // Слова состояния приходят аргументом: английский кадр проверяется на
  // английские подписи, иначе краснел бы язык, а не поведение.
  const rx = source => {
    const text = String(source || '')
    try { return new RegExp(text, 'i') } catch { return /(?!)/ }
  }
  const WAITING = rx(L.waiting || 'жд[её]т|жд[её]м')
  const PROMISE = rx(L.promiseWord || 'следующ|запуск|откро')
  const REVISION = rx(L.revision || 'правк')
  const VIA_TURN = rx(L.viaTurn || 'ход|дизайна')
  const READY = rx(L.ready || 'готов')

  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const checks = []
  const note = (name, pass, detail) => checks.push({
    name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail).slice(0, 260)
  })
  const TEXT = el => (el && (el.textContent || '')).replace(/\s+/g, ' ').trim()
  // Ждать и синхронного признака, и асинхронного: `until` обязан ДОЖИДАТЬСЯ
  // результата предиката. Без `await` асинхронный предикат возвращает промис,
  // а промис истинный всегда — и проверка «версий стало больше» зелёнела на
  // нуле версий, ничего не дожидаясь.
  const until = async (fn, ms = 20000) => {
    const stop = Date.now() + ms
    for (;;) {
      let value = false
      try { value = await fn() } catch { /* состояние ещё не собрано */ }
      if (value) return true
      if (Date.now() > stop) return false
      await wait(80)
    }
  }
  // Текст состояния — та же лента БЕЗ слов просьбы: иначе «правка» и «edit»
  // находились бы в самой инструкции модели, а не в подписи состояния карточки.
  // Снимается ТОЛЬКО для поиска слов состояния: в журнал про карточку идёт
  // сырой текст, иначе строка вида `делает правку « »` вводила бы в заблуждение
  // — пустые кавычки появляются именно из-за этой вычистки, а не из окна.
  const STATE = el => {
    let out = TEXT(el)
    for (const frag of [INSTRUCTION, MARKER]) if (frag) out = out.split(frag).join(' ')
    return out.replace(/\s+/g, ' ').trim()
  }
  const result = () => ({ ok: checks.every(item => item.pass) && checks.length > 0, checks })

  // --- Н96: загрузка кадра-превью ------------------------------------------------
  //
  // Дефект Н96 (аудит 28.09): карточка готовой правки попадала в снимок с пустым
  // прямоугольником превью. На `ready` модуль снимал прежний `<iframe>` и тут же
  // вставлял новый с новым адресом, а главный процесс снимает кадр сразу после
  // отчёта прогона — съёмка опережала загрузку документа. Решение владельца от
  // 29.09: «на ready превью не перезагружается, если версия не сменилась; если
  // сменилась — новая версия грузится во второй кадр и подменяет первый по его
  // load. Прогон ждёт load».
  //
  // Здесь прогон ждёт именно так: событие `load` не всплывает, но проходит фазу
  // захвата от `window` к узлу, поэтому слушатель на окне с `capture: true`
  // слышит загрузку ЛЮБОГО кадра в ленте, не заглядывая в него. Содержимое кадра
  // окно не читает и не обязано: кадр открыт `sandbox="allow-scripts"` без
  // `allow-same-origin`, его документ для окна — чужой Origin (тот же закон, из-за
  // которого модулю запрещена подписка на `message`). Мерка загрузки — событие
  // `load`; в `contentDocument` ниже окно заглядывает только ради уточнения и не
  // считает закрытый Origin признаком провала.
  const loadedFrames = new WeakSet()
  const onLoad = event => {
    const node = event && event.target
    if (node && node.tagName === 'IFRAME') loadedFrames.add(node)
  }
  window.addEventListener('load', onLoad, true)
  document.addEventListener('load', onLoad, true)

  // Кадры превью самой карточки: ищутся по узлу ленты, а не по классу — имён
  // узлов контрактом не задано.
  const previewFrames = () => {
    const card = cardOf()
    return card ? [...card.querySelectorAll('iframe')] : []
  }
  // «Показан» = сам узел и ни один предок не спрятаны (hidden, display:none,
  // visibility:hidden, opacity:0) — те же четыре признака, что меряет юнит
  // `tests/test-design-task-card.cjs`, чтобы два набора не расходились.
  const isShown = node => {
    let el = node
    while (el && el.nodeType === 1) {
      if (el.hidden === true) return false
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
      if (style && (style.display === 'none' || style.visibility === 'hidden' || String(style.opacity) === '0')) return false
      el = el.parentElement
    }
    return Boolean(node)
  }
  const shownFrames = () => previewFrames().filter(isShown)
  const srcOf = node => String((node && (node.getAttribute('src') || node.src)) || '')
  // Номер версии из «свежего» параметра адреса: имя ключа модулем не задано,
  // поэтому подходит любой из принятых (`?v=` и аналоги, как в юните).
  const versionMark = src => {
    const match = /[?&](?:v|version|ver|rev|ts|t|nonce|cache)[^=]*=(\d+)/i.exec(String(src))
    return match ? match[1] : ''
  }
  const frameDocState = node => {
    if (!node) return 'кадра нет'
    if (loadedFrames.has(node)) return 'load услышан'
    try {
      const doc = node.contentDocument || (node.contentWindow && node.contentWindow.document)
      const root = doc && doc.documentElement
      return doc ? `без load: readyState=${doc.readyState}, знаков=${root ? String(root.textContent || '').length : 0}` : 'без load: документа нет'
    } catch (foreign) {
      // Ожидаемое: sandbox без allow-same-origin закрывает документ кадра от окна.
      return `без load: чужой Origin (${String((foreign && foreign.name) || foreign)})`
    }
  }

  // Снимок лента обязана встречать загруженным кадром: ни один показанный
  // `<iframe>` не стоит с недогруженным документом (это и есть миг из Н96), и двух
  // показанных кадров рядом быть не может. В состояниях без макета кадров нет
  // вовсе, и проверка остаётся верной сама по себе.
  function expectLoadedPreview (phase) {
    const all = previewFrames()
    const shown = all.filter(isShown)
    const blank = shown.filter(node => !loadedFrames.has(node))
    note(`${phase}: показанный кадр превью загружен, двух показанных нет (Н96: прогон ждёт load)`,
      shown.length <= 1 && blank.length === 0,
      `кадров ${all.length}, показано ${shown.length}, незагруженных ${blank.length}: ` +
      `${all.map(node => `${srcOf(node) || 'без адреса'}${isShown(node) ? '' : ' [спрятан]'} (${frameDocState(node)})`).join(' | ')}`)
  }

  const ready = await until(() => document.documentElement.dataset.appReady === '1', 30000)
  note('окно сообщило о готовности', ready)
  if (!ready) return result()

  // Английский кадр: язык переключается до всего остального, чтобы подписи
  // карточки строились уже по-английски.
  if (lang === 'en' && typeof window.__setLanguage === 'function') {
    try { await window.__setLanguage('en') } catch { /* переключатель разберётся сам */ }
    await wait(200)
  }

  const api = window.electronAPI || {}
  // 1. Мост: узкий канал фокуса, который вводит контракт. Его ещё нет — прогон
  //    красный по этой причине, но идёт дальше, чтобы показать и остальные звенья.
  note('мост отдаёт designFocus (узел контракта 4.2: окно сообщает открытый макет)',
    typeof api.designFocus === 'function',
    `есть в мосту: ${Object.keys(api).filter(name => /design/i.test(name)).join(', ')}`)

  // Диалог прогона: метка на ленте ставится при отрисовке сообщений, поэтому
  // она проверяется позже — когда карточка уже в ленте.
  const designsOf = async () => {
    const list = await api.getDesigns?.()
    return Array.isArray(list) ? list : []
  }
  const versionsOf = async () => {
    const res = await api.designVersions?.(DESIGN_ID, COMPONENT)
    return Array.isArray(res?.versions) ? res.versions : []
  }

  const seeded = await designsOf()
  const entry = seeded.find(item => item && item.id === DESIGN_ID) || null
  note('макет прогона есть в реестре Дизайна', Boolean(entry), seeded.map(item => item.id).join(', '))
  if (!entry) return result()

  const versionsBefore = await versionsOf()
  const versionBefore = Number(entry.version) || 1

  // 2. Раздел «Дизайн»: открываем макет тем же путём, каким его открывает человек.
  if (mode === 'turn' || mode === 'unfocus') {
    $('navDesign')?.click()
    const inDesign = await until(() => $('designView')?.classList.contains('active'), 8000)
    note('раздел «Дизайн» открыт', inDesign)
    const row = await until(() => [...($('designList')?.children || [])]
      .some(node => TEXT(node).includes(TOPIC)), 8000)
    note('макет виден в списке Дизайна', row, TEXT($('designList') || ''))
    const target = [...($('designList')?.children || [])].find(node => TEXT(node).includes(TOPIC))
    if (target) target.click()
    const workspace = await until(() => $('designWorkspace') && !$('designWorkspace').hidden, 10000)
    note('рабочее место этого макета открыто (макет в окне)', workspace,
      `designWorkspace hidden=${$('designWorkspace') ? $('designWorkspace').hidden : 'нет узла'}`)
    if (mode === 'unfocus') {
      $('designBackBtn')?.click()
      const closed = await until(() => $('designWorkspace')?.hidden !== false, 8000)
      note('макет снят с открытого (вернулись ко всем дизайнам)', closed)
    }
    $('navChats')?.click()
    const backToChat = await until(() => $('chatView')?.classList.contains('active'), 8000)
    note('чат снова на экране', backToChat)
  }

  // 3. Просьба в чат — настоящим ходом: форма, дымового провайдера нет, работает
  //    файл-сценарий. Маркер только в просьбе модели (её args), чтобы карточка
  //    искалась по своему тексту, а не по эху сообщения человека.
  const events = []
  if (typeof api.onDesignTaskEvent === 'function') api.onDesignTaskEvent(payload => events.push(payload))

  const box = $('composerTextarea')
  note('есть поле ввода чата', Boolean(box))
  if (!box) return result()
  box.value = ASK
  box.dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm')?.requestSubmit()

  const cardOf = () => [...($('messagesList')?.children || [])].find(node => TEXT(node).includes(MARKER))
  const cardFound = await until(() => Boolean(cardOf()), 40000)
  note('карточка задачи появилась в ленте чата', cardFound,
    cardFound ? TEXT(cardOf()).slice(0, 200) : `в #messagesList нет узла с «${MARKER}»`)
  if (!cardFound) return result()
  // Диалог прогона проверяется здесь, а не на старте: метку `data-chat-id` лента
  // получает при отрисовке сообщений, и на пустом чате она ещё пустая.
  note('лента принадлежит диалогу прогона',
    ($('messagesList')?.dataset?.chatId || '') === CHAT_ID,
    `data-chat-id="${$('messagesList')?.dataset?.chatId || ''}", ожидался «${CHAT_ID}»`)

  const card = cardOf()
  if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center' })

  // 4. Состояние.
  if (mode === 'turn') {
    const shown = await until(() => {
      const text = STATE(cardOf())
      return REVISION.test(text) && VIA_TURN.test(text) && !WAITING.test(text)
    }, 25000)
    note('карточка говорит «правка идёт ходом Дизайна»', shown, TEXT(cardOf()))
    // Что человек видит в карточке — текст самой правки, а не пустые кавычки:
    // `turnWords` обязан донести инструкцию до подписи. Проверка по СЫРОМУ
    // тексту ленты: вычищенный `STATE` как раз и сжигает эти слова.
    note('в карточке видно текст правки, а не пустые кавычки',
      TEXT(cardOf()).includes(INSTRUCTION) && !/правку\s*«\s*»/.test(TEXT(cardOf())),
      TEXT(cardOf()).slice(0, 240))
    note('это не подписано как сборка нового макета',
      !/новый|новый макет|собран/i.test(STATE(cardOf())) || shown, TEXT(cardOf()))
    // 5. Ход Дизайна в окне. Признак конца — тот же, по которому окно само
    //    перестаёт держать макет занятым: кнопка отправки Дизайна выходит из
    //    состояния «стоп» (`designBusy` снимается в `finally` хода). Снимок
    //    делается ПОСЛЕ возврата этого скрипта и окно тогда же закрывается,
    //    поэтому недождавшийсяся хода прогон обрывал бы его на первом шаге.
    const busy = () => $('designSendBtn')?.dataset?.stop === '1'
    // Начало хода видно по ленте самого макета: просьба правки легла туда
    // сообщением. Это остаётся и после хода, поэтому признак не гонится с
    // кнопкой на скорость.
    const lane = () => TEXT($('designMessages'))
    const started = await until(() => busy() || lane().includes(MARKER), 40000)
    note('правка ушла в ход Дизайна этого макета (лента макета её получила)',
      started, `лента макета: ${lane().slice(0, 160)}`)
    const finished = await until(() => !busy(), 180000)
    note('ход Дизайна этого макета закончился (окно сняло занятость)', finished,
      `designSendBtn data-stop=${JSON.stringify($('designSendBtn')?.dataset?.stop ?? null)}`)
    const grew = await until(async () => (await versionsOf()).length > versionsBefore.length, 30000)
    const versionsAfter = await versionsOf()
    note('правка сделана: у того же макета появилась новая версия', grew,
      `версий было ${versionsBefore.length}, стало ${versionsAfter.length}`)
    const list = await designsOf()
    note('второго макета не завелось', list.length === 1, list.map(item => item.id).join(', '))
    note('ожидания в карточке нет', !PROMISE.test(STATE(cardOf())), TEXT(cardOf()))
    // 4.2 остаток: ход Дизайна кончился и версия выпущена — карточка обязана
    // дойти до «готово» с её номером, а не остаться в «правка идёт ходом».
    const READY = /готов|ready/i
    const ready = await until(() => READY.test(STATE(cardOf())), 30000)
    const registry = (await designsOf()).find(item => item && item.id === DESIGN_ID) || {}
    note('после конца хода карточка говорит «готово»', ready, `${STATE(cardOf())}, реестр: версия ${registry.version}`)
    note('в «готово» назван номер версии того же макета',
      ready && String(registry.version || '').length > 0 &&
      new RegExp(`версия\\s*${registry.version}|version\\s*${registry.version}`, 'i').test(TEXT(cardOf())),
      TEXT(cardOf()).slice(0, 220))
    note('правка больше не висит в работе: последнее событие карточки — «ready» с версией',
      (() => {
        const last = events[events.length - 1] || {}
        return last.status === 'ready' && Number(last.version) > 0
      })(),
      (() => {
        const last = events[events.length - 1] || {}
        return `последнее событие: status=${last.status}, version=${last.version}, событий всего ${events.length}`
      })())

    // --- Н96: кадр готовой правки обязан догрузиться ДО снимка --------------------
    //
    // Ход Дизайна выпустил версию, карточка дошла до «готово» — именно здесь
    // прогон раньше снимал пустой прямоугольник превью. Ждём событие `load`
    // показанного кадра, а не фиксированную паузу: мерка — загруженный документ,
    // а не везение с таймингом.
    const announced = String((events[events.length - 1] || {}).version || registry.version || '')
    const srcAtFirstLook = srcOf(shownFrames()[0])
    const previewLoaded = await until(() => {
      const shown = shownFrames()
      return shown.length === 1 && loadedFrames.has(shown[0])
    }, 25000)
    note('превью готовой правки дождалось загрузки (Н96: прогон ждёт load)', previewLoaded,
      `показано ${shownFrames().length} из ${previewFrames().length}: ` +
      `${shownFrames().map(node => `${srcOf(node) || 'без адреса'} (${frameDocState(node)})`).join(' | ') || 'кадра нет'}`)
    // Ровно один незагруженный показанный кадр — это и есть миг из Н96; два
    // показанных рядом — второй способ его увидеть.
    expectLoadedPreview('готовая правка')
    // На снимке обязан быть кадр объявленной версии, а не прежний: пока новый
    // грузился, на экране стоял он, и `load` старого здесь ничего не доказывает.
    note('показанный кадр грузился для объявленной версии',
      previewLoaded && (!announced || !versionMark(srcOf(shownFrames()[0])) ||
        versionMark(srcOf(shownFrames()[0])) === announced),
      `адрес «${srcOf(shownFrames()[0])}», версия события ${announced || 'не названа'}, ` +
      `первым видели «${srcAtFirstLook}»`)
    // Подмена не имеет права оставить в ленте лишний узел: спрятанный кадр
    // грузит отброшенную страницу молча.
    note('после подмены в карточке один кадр превью', previewFrames().length === 1,
      `кадров: ${previewFrames().map(node => srcOf(node) || 'без адреса').join(' | ')}`)
  } else {
    const waiting = await until(() => {
      const text = STATE(cardOf())
      return WAITING.test(text) && PROMISE.test(text)
    }, 25000)
    note('карточка говорит «ждёт — откроется при следующем запуске»', waiting, TEXT(cardOf()))
    note('правка не названа готовой',
      !READY.test(STATE(cardOf()).replace(/не\s+готов\w*/gi, '')), TEXT(cardOf()))
    note('кадра в карточке ожидания нет', (cardOf()?.querySelectorAll('iframe') || []).length === 0,
      `кадров: ${(cardOf()?.querySelectorAll('iframe') || []).length}`)
    await wait(1500)
    const versionsAfter = await versionsOf()
    note('версия макета не изменилась', versionsAfter.length === versionsBefore.length,
      `было ${versionsBefore.length}, стало ${versionsAfter.length}`)
    const list = await designsOf()
    const after = list.find(item => item && item.id === DESIGN_ID) || {}
    note('макет в реестре не тронут', list.length === 1 && (Number(after.version) || 1) === versionBefore,
      `записей ${list.length}, версия ${JSON.stringify(after.version)}`)
    note('ожидание: событием «готово» карточка не обманута',
      events.filter(item => item && item.status === 'ready').length === 0,
      events.map(item => item && item.status).join(', ') || 'событий прогресса не было')
  }

  // Последняя мерка перед тем, как окно вернёт управление и главный процесс
  // сделает снимок: лента идёт на кадр с загруженным превью (Н96).
  expectLoadedPreview('момент снимка')

  // Снимок: карточка обязана быть в кадре.
  const shownCard = cardOf()
  if (shownCard && typeof shownCard.scrollIntoView === 'function') {
    shownCard.scrollIntoView({ block: 'center' })
    await wait(250)
  }
  const rect = shownCard ? shownCard.getBoundingClientRect() : null
  note('карточка видна на экране (попадёт в снимок)',
    Boolean(rect) && rect.height > 30 && rect.top < window.innerHeight && rect.bottom > 0,
    rect ? `${Math.round(rect.top)}..${Math.round(rect.bottom)} при окне ${window.innerHeight}` : 'нет размеров')
  await wait(400)
  return result()
})()
