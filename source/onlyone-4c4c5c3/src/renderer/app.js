(() => {

  // Fallback catalog shown before the API answers. Free-first, matching the
  // main-process presets; the real capabilities arrive with the fetched catalog.
  const BUILTIN_DEFAULT_MODELS = [
    {
      id: "z-ai/glm-5.3-flash",
      name: "GLM 5.3 Flash",
      provider: "Z.AI",
      description: "Платная и очень дешёвая: $0.075 за миллион входных токенов, $0.25 за миллион выходных. 1.31M контекста, инструменты. Стоит на сложных задачах, потому что не упирается в лимиты бесплатного уровня.",
      contextLength: 1310720,
      isFree: false,
      promptPrice: 0.075,
      completionPrice: 0.25,
      supportsTools: true,
      supportedEfforts: ["minimal", "low", "medium", "high"],
      reasoningMandatory: false,
      category: "paid"
    },
    {
      id: "dots-studio/dots-3-note-preview:free",
      name: "Dots3-Note Preview",
      provider: "Dots Studio",
      description: "Открытая MoE-модель, 280B параметров, 16B активных. 512k контекста. Отвечает примерно за две секунды и вызывает инструменты — проверено живым замером.",
      contextLength: 512000,
      isFree: true,
      promptPrice: 0,
      completionPrice: 0,
      supportsTools: true,
      supportedEfforts: [],
      reasoningMandatory: false,
      category: "free"
    },
    {
      id: "minimax/minimax-m3:free",
      name: "MiniMax M3 (free)",
      provider: "MiniMax",
      description: "Бесплатная мультимодальная модель под долгую агентную работу. 1M контекста, инструменты проверены живым вызовом.",
      contextLength: 1048576,
      isFree: true,
      promptPrice: 0,
      completionPrice: 0,
      supportsTools: true,
      supportedEfforts: [],
      reasoningMandatory: false,
      category: "free"
    },
    {
      id: "cohere/north-mini-code:free",
      name: "North Mini Code (free)",
      provider: "Cohere",
      description: "Агентная модель под код, самая быстрая из бесплатных. 256K контекста.",
      contextLength: 256000,
      isFree: true,
      promptPrice: 0,
      completionPrice: 0,
      supportsTools: true,
      supportedEfforts: [],
      reasoningMandatory: false,
      category: "free"
    },
    {
      id: "z-ai/glm-5.2:free",
      name: "GLM 5.2 (free)",
      provider: "Z.AI",
      description: "Бесплатная reasoning-модель под кодинг. 256K контекста. Сейчас часто отвечает 429 — лимит провайдера.",
      contextLength: 256000,
      isFree: true,
      promptPrice: 0,
      completionPrice: 0,
      supportsTools: true,
      supportedEfforts: ["xhigh", "high"],
      reasoningMandatory: false,
      category: "free"
    },
    {
      id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      name: "Nemotron 3 Ultra",
      provider: "NVIDIA",
      description: "Открытая frontier-модель на 550B параметров. Бесплатная, 1M контекста.",
      contextLength: 1000000,
      isFree: true,
      promptPrice: 0,
      completionPrice: 0,
      supportsTools: true,
      supportedEfforts: ["high", "medium"],
      reasoningMandatory: false,
      category: "free"
    },

  ]

  const DEFAULT_MODEL = BUILTIN_DEFAULT_MODELS[0]

  // Preset MCP Configurations
  // Slash Commands Suite
  // The six workflow commands that used to head this list — /single, /agent,
  // /lead, /pipeline, /parallel, /consensus — are gone with the presets they
  // set. There is one way of working, and the mode worth choosing is the
  // permission mode, which lives on the composer pill.
  // Команды «/» и директивы «.»: список и логика — в slash-commands.js; здесь только то, чем они управляют.
  // Обёртки, а не прямые имена: часть функций объявлена ниже по файлу, и их значение читается в момент вызова.
  const SLASH_COMMANDS = OnlyoneSlashCommands.create({
    openMods: () => (modsClient ? modsClient.openPanels() : document.getElementById('mainMods')?.click()),
    t: (...a) => t(...a), showToast: (...a) => showToast(...a),
    toggleRemoteForChat: () => toggleRemoteForChat(), toggleSelfDevelopment: () => toggleSelfDevelopment(),
    clearChat: () => clearActiveChat(activePane || panes[0]),
    openDesk: async () => { try { const result = await window.electronAPI.openDesk((activePane || panes[0]).chatId); if (!result.ok) showToast(t('Не удалось открыть Desk')); else if (result.recovered) showToast(t('Раскладка Desk была повреждена: открыта пустая, прежний файл сохранён рядом.')) } catch { showToast(t('Не удалось открыть Desk')) } },
    openEffort: () => modelPopoverInstance?.openEffort(), openModels: () => modelPopoverInstance?.openModels(),
    openSkills: () => el.navSkills.click(), openSettings: () => openModal(el.settingsModal),
    permission: () => permissionMode(), selectPermission: id => selectPermissionMode(id),
    forceCompactNext: () => { (activePane || panes[0]).forceCompactNext = true },
    changeBlocks: () => (activePane || panes[0]).dom.list.querySelectorAll('.agent-file-changes'),
    openChangesReview: () => {
      const pane = activePane || panes[0], chat = chatOf(pane)
      const entries = (chat?.messages || []).filter(msg => msg.undoId).map(msg => ({ requestId: msg.undoId, label: new Date(msg.timestamp).toLocaleString(uiLang) }))
      if (!entries.length) { showToast(t('В этом диалоге ещё нет правок файлов')); return }
      return OnlyoneChangeReview.open({ entries, t, onApplied: (result, requestId) => {
        if (!result.snapshotKept) {
          for (const msg of chat.messages) if (msg.undoId === requestId) { msg.undoId = undefined; msg.undone = true }
          saveConversations(); renderMessages(pane)
        }
      } })
    },
    openSectionsReview: () => {
      const pane = activePane || panes[0], chat = chatOf(pane)
      const entries = (chat?.messages || []).filter(msg => msg.undoId).map(msg => ({ requestId: msg.undoId, label: new Date(msg.timestamp).toLocaleString(uiLang) }))
      if (!entries.length) { showToast(t('В этом диалоге ещё нет правок файлов')); return }
      return OnlyoneReviewSections.open({ entries, t, onApplied: (result, requestId) => {
        if (!result.snapshotKept) {
          for (const msg of chat.messages) if (msg.undoId === requestId) { msg.undoId = undefined; msg.undone = true }
          saveConversations(); renderMessages(pane)
        }
      } })
    },
    send: text => { const pane = activePane || panes[0]; pane.dom.textarea.value = text; pane.dom.form.requestSubmit() }
  })

  // ---------------------------------------------------------------------------
  // Language
  // ---------------------------------------------------------------------------
  // Russian is the source language: it lives in the markup and in the code, and
  // English is a lookup keyed by the Russian text. A string with no translation
  // simply stays Russian instead of turning into a missing-key placeholder.

  let uiLang = 'ru'
  function getUiLang() { return uiLang }
  const DICT = () => (window.__I18N__ && window.__I18N__[uiLang]) || null

  // Общий переводчик для отдельных модулей-экранов (расписания): их строки
  // собираются в шаблоне уже после того, как словарь обошёл разметку, и без
  // доступа к `t` они оставались бы русскими в английском интерфейсе.
  window.__t = t
  function t(text, ...args) {
    if (!text) return text
    // «%s» заполняются по порядку, «{0}» — по номеру. Раньше первый аргумент
    // заменял все «%s» сразу («версия %s из %s» → «версия 1 из 1»), а на русском
    // подстановки не было вовсе и на экран шло «%s».
    const fill = template => {
      if (!args.length) return template
      let cursor = 0
      return String(template).replace(/%s|\{\d+\}/g, all => {
        const take = all === '%s' ? cursor : Number(all.slice(1, -1))
        cursor += 1
        return take < args.length ? String(args[take]) : all
      })
    }
    const dict = DICT()
    if (uiLang === 'ru' || !dict) return fill(text)
    const key = String(text).replace(/\s+/g, ' ').trim()
    if (dict[key]) return fill(dict[key])
    if (args.length) return fill(key)
    // Dynamic toast and confirmation pattern recognition
    let m
    if ((m = key.match(/^Удалить скилл «(.*?)»\? Он перестанет подмешиваться в системный контекст\.$/))) {
      return (dict['Удалить скилл «%s»? Он перестанет подмешиваться в системный контекст.'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Отключить папку «(.*?)» от всех чатов\?$/))) {
      return (dict['Отключить папку «%s» от всех чатов?'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Удалить MCP-сервер «(.*?)»\? Соединение будет закрыто, а его инструменты станут недоступны агентам\.$/))) {
      return (dict['Удалить MCP-сервер «%s»? Соединение будет закрыто, а его инструменты станут недоступны агентам.'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Удалить ключ «(.*?)»\?$/))) {
      return (dict['Удалить ключ «%s»?'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Удалить дизайн «(.*?)» вместе с макетами\?$/))) {
      return (dict['Удалить дизайн «%s» вместе с макетами?'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Скилл «(.*?)» (включён|отключён)$/))) {
      return (dict['Скилл «%s» %s'] || key).replace('%s', m[1]).replace('%s', m[2] === 'включён' ? 'enabled' : 'disabled')
    }
    if ((m = key.match(/^Ключ «(.*?)» (включён|отключён)$/))) {
      return (dict['Ключ «%s» %s'] || key).replace('%s', m[1]).replace('%s', m[2] === 'включён' ? 'enabled' : 'disabled')
    }
    if ((m = key.match(/^Сервер «(.*?)» (включён|отключён|сохранён|добавлен)$/))) {
      return (dict['Сервер «%s» %s'] || key).replace('%s', m[1]).replace('%s', dict[m[2]] || m[2])
    }
    if ((m = key.match(/^Скилл «(.*?)» удалён$/))) {
      return (dict['Скилл «%s» удалён'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Скилл «(.*?)» создан!$/))) {
      return (dict['Скилл «%s» создан!'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Ключ «(.*?)» удалён$/))) {
      return (dict['Ключ «%s» удалён'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Модель для «(.*?)» обновлена$/))) {
      return (dict['Модель для «%s» обновлена'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Роль для «(.*?)» обновлена$/))) {
      return (dict['Роль для «%s» обновлена'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Проект «(.*?)» (создан|удалён|сохранён)$/))) {
      const act = dict['Проект «%s» ' + m[2]] || key
      return act.replace('%s', m[1])
    }
    if ((m = key.match(/^Дизайн «(.*?)» удалён$/))) {
      return (dict['Дизайн «%s» удалён'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Папка добавлена в чат: (.*)$/))) {
      return (dict['Папка добавлена в чат: %s'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Папка добавлена в проект: (.*)$/))) {
      return (dict['Папка добавлена в проект: %s'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Выбрана модель: (.*)$/))) {
      return (dict['Выбрана модель: %s'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^(.*?) сейчас недоступна в OpenRouter — выберите другую модель\.$/))) {
      return (dict['%s сейчас недоступна в OpenRouter — выберите другую модель.'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Вернуть файлы к состоянию до этого ответа\? (.*)$/))) {
      return (dict['Вернуть файлы к состоянию до этого ответа? %s'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Не тронуто, изменено после ответа: (.*)$/))) {
      return (dict['Не тронуто, изменено после ответа: %s'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Отменено: (.*)$/))) {
      return (dict['Отменено: %s'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Прикреплено файлов: (.*)$/))) {
      return (dict['Прикреплено файлов: %s'] || key).replace('%s', m[1])
    }
    if ((m = key.match(/^Найдено файлов по пути: (.*)$/))) {
      return (dict['Найдено файлов по пути: %s'] || key).replace('%s', m[1])
    }
    return text
  }

  // Everything outside the conversation itself: the conversation holds model
  // output and user text, which must never be rewritten.
  const TRANSLATABLE_ATTRS = ['title', 'placeholder', 'aria-label', 'data-tooltip']

  // Счётчик раздела панели (1.14, часть 4): ноль — шум, его не рисуют. Метка
  // прячется целиком, а не остаётся пустым кружком: пустое место выглядит как
  // незагруженное число, и глаз ждёт, когда оно появится.
  function setNavCount(node, value) {
    if (!node) return
    const count = Number(value) || 0
    node.textContent = String(count)
    node.hidden = count <= 0
  }

  function applyTranslations(root = document.body) {
    const dict = DICT()
    const isEn = uiLang === 'en'

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
        if (node.parentElement?.closest('.msg-content, .reasoning-stream, .messages-list, code, pre')) {
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_ACCEPT
      }
    })

    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)

    for (const node of nodes) {
      // «Как было» означает то, что поставлено НЕ нашим проходом: если код
      // сам заменил текст (например, уже переведённым через t()), прежний кэш
      // вернул бы на экран устаревшую строку.
      if (node.__ru_orig === undefined
        || (node.nodeValue !== node.__ru_orig && node.nodeValue !== node.__ru_written)) {
        node.__ru_orig = node.nodeValue
      }
      const key = String(node.__ru_orig).replace(/\s+/g, ' ').trim()
      const found = isEn && dict && dict[key]
      const next = found ? String(node.__ru_orig).replace(key, dict[key]) : node.__ru_orig
      // Пишем только когда значение правда другое: присваивание той же строки
      // тоже порождает запись мутации, и наблюдатель перезапускал бы сам себя.
      if (node.nodeValue !== next) node.nodeValue = next
      node.__ru_written = next
    }

    root.querySelectorAll('[title], [placeholder], [aria-label], [data-tooltip]').forEach(element => {
      element.__orig_attrs = element.__orig_attrs || {}
      element.__written_attrs = element.__written_attrs || {}
      for (const attr of TRANSLATABLE_ATTRS) {
        const current = element.getAttribute(attr)
        if (current === null) continue
        if (element.__orig_attrs[attr] === undefined
          || (current !== element.__orig_attrs[attr] && current !== element.__written_attrs[attr])) {
          // Значение переставил код — прежний оригинал устарел.
          element.__orig_attrs[attr] = current
        }
        const origVal = element.__orig_attrs[attr]
        if (!origVal) continue
        const next = isEn
          ? ((dict && dict[String(origVal).replace(/\s+/g, ' ').trim()]) || origVal)
          : origVal
        if (current !== next) element.setAttribute(attr, next)
        element.__written_attrs[attr] = next
      }
    })

    root.querySelectorAll('option').forEach(option => {
      if (option.__ru_orig === undefined
        || (option.textContent !== option.__ru_orig && option.textContent !== option.__ru_written)) {
        option.__ru_orig = option.textContent
      }
      const next = isEn
        ? ((dict && dict[String(option.__ru_orig).replace(/\s+/g, ' ').trim()]) || option.__ru_orig)
        : option.__ru_orig
      if (option.textContent !== next) option.textContent = next
      option.__ru_written = next
    })

    // The sidebar labels may be display:none in its icon-only layout. Keep the
    // controls named for assistive technology and expose the same localized
    // label through onlyone's tooltip system.
    syncSidebarNavLabels()
  }

  // Перевод догоняет то, что появилось ПОСЛЕ начального прохода: данные приходят
  // из главного процесса, разделы перерисовываются по навигации, и один проход
  // при загрузке не может перевести того, чего в момент прохода ещё не было.
  // Лента разговора исключена: там текст модели и человека, его менять нельзя.
  let translatingNow = false
  const translationPending = new Set()

  function flushTranslations () {
    const roots = [...translationPending]
    translationPending.clear()
    if (!roots.length) return
    translatingNow = true
    try {
      for (const root of roots) if (root.isConnected) applyTranslations(root)
    } finally {
      translatingNow = false
    }
  }

  function watchTranslations () {
    if (typeof MutationObserver !== 'function') return
    new MutationObserver(records => {
      if (translatingNow || uiLang !== 'en') return
      for (const record of records) {
        const node = record.type === 'characterData' ? record.target.parentElement : record.target
        if (!node || !node.closest || node.closest('.msg-content, .reasoning-stream, .messages-list, code, pre')) continue
        // Контейнер берётся ближайший к вставке: переводить из-за одной строки
        // всё окно — лишняя работа на каждом шаге хода.
        translationPending.add(node.closest('section, dialog, aside, .panel, .sidebar, body') || document.body)
      }
      if (translationPending.size && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(flushTranslations)
      } else if (translationPending.size) {
        flushTranslations()
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  }

  async function setLanguage(next, { persist = true } = {}) {
    uiLang = next === 'en' ? 'en' : 'ru'
    document.documentElement.lang = uiLang

    if (persist) {
      try { await window.electronAPI?.setSettings?.({ language: uiLang }) } catch {}
    }

    applyTranslations()
    // Подпись кнопки боковой панели ставится кодом при каждой смене ширины, а не разметкой.
    applySidebarWidth(document.body.classList.contains('sidebar-narrow'))
    // Панели, которые рисуются один раз и сами не перерисовываются: их текст
    // собран кодом (aria-label строки сочетания, подпись версии), и перевод по
    // дереву их не догоняет — нужен новый вызов отрисовки на новом языке.
    renderShortcuts()
    refreshUpdateState()
    syncDesignViewportControls()
    // Панель путей приходит из главного процесса уже со словами нужного языка:
    // имена путей, подсказки ключей и последняя причина отказа. Без нового
    // чтения она осталась бы на языке момента последней отрисовки.
    refreshCustomProvider()
    // Расписания показывают слово о следующем запуске тоже из главного
    // процесса: без нового чтения английская вкладка осталась бы на языке
    // прежнего снимка.
    if (window.OnlyoneSchedules?.mounted?.reload) window.OnlyoneSchedules.mounted.reload()

    if (el.languageSelect) el.languageSelect.value = uiLang
    paintGreeting()
    renderPermissionMode()
    renderEffortChips()
    renderModelCards()
    // Экран входа рисует оболочка, и её строки переводит deps.t: пересборка
    // идёт за `renderChatHistory` — то же движение, что и у остального окна.
    renderChatHistory()
    refreshTasksPanel()
    // Раздел задач подписывает состояния сам: без перерисовки он остался бы на
    // прежнем языке до ухода и возврата. Экземпляр не создаём — если раздела
    // ещё не было, перерисовывать нечего.
    if (taskCenterInstance) taskCenterInstance.rebuild()
  }
  window.__setLanguage = setLanguage

  // ---------------------------------------------------------------------------
  // The mark
  // ---------------------------------------------------------------------------
  // One sign on every assistant message. Geometric rather than pictorial: at
  // seventeen pixels a drawing turns to mush, while a few clean strokes stay
  // legible. It turns slowly while the model works and rests when it is done.

  // A hexagon with a core, not the three-ray asterisk it used to be: at 13px the
  // asterisk read as the `✳` glyph rather than as a mark, and the brief rules out
  // glyphs standing in for icons. Class names are unchanged so the click and its
  // animations still find their parts.
  // Под ответом стоял нарисованный шестиугольник с точкой — фигура, которая ничего
  // не значит и ни к чему не отсылает. Здесь место знака самого приложения.
  const AGENT_MARK_SVG = `
    <button type="button" class="mark-btn" aria-label="Знак onlyone" data-tooltip="onlyone">
      <svg class="agent-mark" viewBox="11 11 42 42" width="19" height="19" aria-hidden="true"><path style="fill: var(--accent)" d="M53.22 32.00L52.77 33.09L51.78 34.08L50.33 34.90L48.56 35.52L46.62 35.92L44.69 36.12L42.92 36.19L41.46 36.21L40.39 36.28L39.77 36.48L39.58 36.92L39.76 37.64L40.23 38.66L40.84 39.96L41.48 41.48L42.00 43.11L42.31 44.73L42.32 46.21L42.01 47.42L41.39 48.26L40.49 48.67L39.40 48.63L38.21 48.17L36.99 47.37L35.85 46.36L34.82 45.27L33.94 44.27L33.21 43.49L32.58 43.06L32.00 43.03L31.40 43.44L30.71 44.25L29.88 45.37L28.88 46.68L27.71 48.03L26.39 49.25L25.01 50.20L23.65 50.75L22.41 50.82L21.39 50.38L20.67 49.45L20.31 48.09L20.32 46.42L20.67 44.58L21.30 42.70L22.09 40.93L22.91 39.36L23.62 38.09L24.10 37.13L24.23 36.48L23.95 36.10L23.23 35.90L22.12 35.79L20.68 35.68L19.05 35.47L17.38 35.11L15.82 34.56L14.53 33.84L13.64 32.96L13.22 32.00L13.32 31.02L13.90 30.10L14.90 29.29L16.19 28.64L17.64 28.15L19.09 27.81L20.40 27.55L21.44 27.30L22.14 26.97L22.45 26.48L22.39 25.76L22.04 24.76L21.48 23.48L20.85 21.96L20.27 20.27L19.86 18.52L19.73 16.85L19.93 15.39L20.49 14.28L21.39 13.62L22.56 13.46L23.91 13.83L25.35 14.67L26.77 15.90L28.08 17.38L29.23 18.95L30.17 20.45L30.92 21.70L31.51 22.59L32.00 23.03L32.47 22.98L33.00 22.46L33.66 21.54L34.47 20.36L35.47 19.05L36.62 17.78L37.87 16.71L39.14 15.96L40.35 15.62L41.39 15.74L42.19 16.31L42.70 17.28L42.90 18.54L42.81 19.99L42.51 21.49L42.08 22.92L41.66 24.18L41.35 25.21L41.29 25.97L41.55 26.48L42.21 26.80L43.25 26.99L44.64 27.15L46.27 27.36L48.03 27.71L49.74 28.23L51.26 28.95L52.42 29.85L53.10 30.89Z"/></svg>
    </button>
  `

  // Kept under the old name so every call site still renders the mark.
  const PIXEL_CAT_SVG = AGENT_MARK_SVG

  // Знак живёт вместе с ходом: готовится, думает, пишет, сделал. Каждое
  // состояние — свой класс, и переход между ними виден. Раньше состояний было
  // два, «идёт» и «не идёт», и знак весь ход выглядел одинаково.
  function markState(pane, state) {
    if (pane) pane.markPhase = state
    const mark = pane?.assistantEl?.querySelector('.agent-mark')
    if (!mark) return
    mark.classList.remove('is-thinking', 'is-answering', 'is-tooling', 'is-settled')
    if (state) mark.classList.add(`is-${state}`)
    if (state === 'tooling') {
      // Отметка на один такт: вызов инструмента — событие, а не состояние.
      mark.classList.add('tick')
      setTimeout(() => mark.classList.remove('tick'), 460)
    }
  }

  const markClicks = new WeakMap()
  const markTimers = new WeakMap()

  function playMarkState(svg, cls, ms) {
    if (!svg) return
    svg.classList.remove("spun", "burst")
    void svg.offsetWidth
    svg.classList.add(cls)
    clearTimeout(markTimers.get(svg))
    markTimers.set(svg, setTimeout(() => svg.classList.remove(cls), ms))
  }

  function pokeMark(button) {
    const svg = button.querySelector(".agent-mark")
    if (!svg) return
    const now = Date.now()
    const history = (markClicks.get(button) || []).filter(t => now - t < 1500)
    history.push(now)
    markClicks.set(button, history)

    if (history.length >= 3) {
      markClicks.set(button, [])
      playMarkState(svg, "burst", 900)
      return
    }
    playMarkState(svg, "spun", 520)
  }

  function markEnter(button) {
    button.querySelector(".agent-mark")?.classList.add("lit")
  }

  function markLeave(button) {
    button.querySelector(".agent-mark")?.classList.remove("lit")
  }

  // DOM Elements
  const $ = id => document.getElementById(id)
  const el = {
    newChatBtn: $('newChatBtn'),
    navChats: $('navChats'),
    navProjects: $('navProjects'),
    projectsView: $('projectsView'),
    navTasks: $('navTasks'),
    // Имена с «TaskCenter» в конце: `#tasksPanel` и `body.tasks-open` уже
    // заняты панелью работы текущего чата (2d), и путаница была бы неминуемой.
    taskCenterView: $('taskCenterView'),
    taskCenterBadge: $('taskCenterBadge'),
    navSkills: $('navSkills'),
    navPlugins: $('navPlugins'),
    navDesign: $('navDesign'),
    designBadge: $('designBadge'),
    designView: $('designView'),
    navConnectors: $('navConnectors'),
    skillsBadge: $('skillsBadge'),
    mcpBadge: $('mcpBadge'),
    chatHistoryList: $('chatHistoryList'),
    forkTreeSection: $('forkTreeSection'),
    splitViewBtn: $('splitViewBtn'),
    splitPane: $('splitPane'),
    splitResizer: $('splitResizer'),
    splitChatLabel: $('splitChatLabel'),
    splitFeed: $('splitFeed'),
    openSettingsBtn: $('openSettingsBtn'),
    chatView: $('chatView'),
    skillsView: $('skillsView'),
    pluginsView: $('pluginsView'),
    connectorsView: $('connectorsView'),
    clearChatBtn: $('clearChatBtn'),
    chatFeed: $('chatFeed'),
    scrollDownBtn: $('scrollDownBtn'),
    welcomeHero: $('welcomeHero'),
    messagesList: $('messagesList'),
    slashMenu: $('slashMenu'),
    slashMenuList: $('slashMenuList'),
    composerForm: $('composerForm'),
    composerTextarea: $('composerTextarea'),
    modelEffortPillBtn: $('modelEffortPillBtn'),
    pillModelName: $('pillModelName'),
    pillEffortName: $('pillEffortName'),
    modalThinkingToggle: $('modalThinkingToggle'),
    effortSlider: $('effortSlider'),
    effortSliderStops: $('effortSliderStops'),
    effortSliderValue: $('effortSliderValue'),
    effortUnsupportedHint: $('effortUnsupportedHint'),
    sendBtn: $('sendBtn'),
    modelModal: $('modelModal'),
    modelCountBadge: $('modelCountBadge'),
    modelFilterInput: $('modelFilterInput'),
    refreshModelsBtn: $('refreshModelsBtn'),
    modalModelList: $('modalModelList'),
    settingsModal: $('settingsModal'),
    keysPoolList: $('keysPoolList'),
    newKeyValueInput: $('newKeyValueInput'),
    toggleNewKeyVisibility: $('toggleNewKeyVisibility'),
    composerCard: $('composerCard'),
    attachBtn: $('attachBtn'),
    attachmentStrip: $('attachmentStrip'),
    languageSelect: $('languageSelect'),
    permModeBtn: $('permModeBtn'),
    permModeMenu: $('permModeMenu'),
    permModeLabel: $('permModeLabel'),
    workspaceBtn: $('workspaceBtn'),
    workspaceLabel: $('workspaceLabel'),
    btnAddApiKey: $('btnAddApiKey'),
    apiKeyMessage: $('apiKeyMessage'),
    workspacePermissionSelect: $('workspacePermissionSelect'),
    addMcpServerBtn: $('addMcpServerBtn'),
    mcpServerList: $('mcpServerList'),
    addMcpModal: $('addMcpModal'),
    addMcpForm: $('addMcpForm'),
    mcpNameInput: $('mcpNameInput'),
    mcpCommandInput: $('mcpCommandInput'),
    mcpArgsInput: $('mcpArgsInput'),
    mcpEnvInput: $('mcpEnvInput'),
    mcpUrlInput: $('mcpUrlInput'),
    mcpHeadersInput: $('mcpHeadersInput'),
    mcpJsonInput: $('mcpJsonInput'),
    mcpStdioFields: $('mcpStdioFields'),
    mcpHttpFields: $('mcpHttpFields'),
    mcpFormError: $('mcpFormError'),
    toastNotification: $('toastNotification')
  }

  // State
  let conversations = []
  // Удалённое управление с телефона: мост к чатам и раздел настроек (setupRemoteControl).
  let remoteBridge = null
  let browserPanelHandle = null
  const nextSuggestionsByChat = new Map()
  const nextSuggestionJobsByChat = new Map()
  let nextSuggestionsEnabled = (() => {
    try { return localStorage.getItem('1code.next-suggestions-enabled') !== 'false' } catch { return true }
  })()
  let selectedModel = DEFAULT_MODEL
  let modelCatalog = [...BUILTIN_DEFAULT_MODELS]
  let modelCatalogMap = new Map(modelCatalog.map(m => [m.id, m]))

  function findCatalogModel(id) {
    if (!id) return null
    return modelCatalogMap.get(id) || modelCatalog.find(m => m.id === id) || null
  }
  let activeCategory = 'all'
  let currentThinkingEffort = 'max' // 'max' | 'high' | 'medium' | 'low' | 'off'
  // Что выбрал человек — отдельно от того, что сейчас действует. Модель без
  // ступеней мышления вынуждает «off», но это не выбор: перейдя на модель со
  // ступенями, человек должен получить свою глубину, а не выключенное мышление.
  let preferredThinkingEffort = null
  let fastMode = false
  let modelPopoverInstance = null
  try { fastMode = localStorage.getItem('1code.fast-mode') === 'true' } catch {}
  let toastTimer = null
  let mcpState = { servers: [], connectedTools: 0 }
  let skillsList = []
  let keysPool = []
  // Публичный вид своих подключений: адреса, модели, маски ключей.
  let customProviderView = null
  // Какое подключение сейчас на экране: оно же правится, оно же удаляется.
  let customProviderEditingId = ''
  // Какой путь из каталога сейчас на экране. Отдельно от активного пути: поля
  // следуют за выбором в списке, даже когда переключение отказало и ход ещё
  // идёт на прежнее — иначе настроить новый провайдер было бы нечем.
  let providerOnScreen = ''
  // id показанной в прошлый раз учётной записи: по смене видно, что черновик
  // набран уже для другого пути.
  let providerShownAccountId = ''
  let workspaceState = { path: '', permission: 'ask' }
  let mcpTransportType = 'stdio'
  // Set when the form is editing an existing server rather than creating one.
  let editingMcpId = null

  function setMcpFormNote(text, isError = false) {
    if (!el.mcpFormError) return
    el.mcpFormError.textContent = text || ''
    el.mcpFormError.classList.toggle('as-hint', Boolean(text) && !isError)
  }
  // Выбор в списке команд держит composer-menu.js — здесь больше нет своего
  // индекса и своего отфильтрованного списка.

  // ---------------------------------------------------------------------------
  // Panes
  // ---------------------------------------------------------------------------
  // Everything a running turn needs used to be a module-level variable, which
  // worked only because one conversation could run at a time. A second live chat
  // makes every one of those a collision, so the whole set moves into a pane
  // object and each pane owns its own copy.
  //
  // Events from the main process carry the requestId of the turn that produced
  // them; that is what maps an event back to the pane waiting for it. Nothing
  // else can: agentIndex identifies the agent within a turn, not the pane.

  function createPane(id, dom) {
    return {
      id,
      dom,
      chatId: null,
      generating: false,
      preparing: false,
      requestedModel: null,
      requestId: null,
      assistantEl: null,
      // In multi-agent modes each agent thinks separately, so reasoning is kept
      // as labelled segments — otherwise agent 2's thoughts run straight into
      // agent 3's with nothing between them.
      reasoningSegments: [],
      reasoningBuffer: '',
      contentBuffer: '',
      streamQueue: '', smoothCursor: 0, smoothTimer: null,
      lastRendered: -1,
      // The turn as an ordered list of thinking / text / tool pieces.
      blocks: [],
      paintedBlocks: [],
      // Which conversation the in-flight answer belongs to.
      liveChatId: null,
      // Messages typed while the agent is still working.
      queued: [],
      paintTimer: null,
      paintScheduled: false,
      lastPaintCost: 0,
      parallelRoster: [],
      totalTokens: 0,
      actualModelId: null,
      fileChanges: [],
      attachments: [],
      stickToBottom: true
    }
  }

  const panes = []

  // The pane the user last typed in — used by shortcuts and by anything that
  // acts on "the current chat" without being told which one.
  let activePane = null

  // Панель работы показывает открытый чат, поэтому её надо трогать везде, где
  // открытый чат меняется. Раньше смена чата и закрытие второй панели окна
  // оставляли на экране работу того, кого уже не видно.
  function setActivePane(pane) {
    if (!pane || activePane === pane) return
    activePane = pane
    refreshTasksPanel()
    if (typeof markActivePane === 'function') markActivePane()
  }

  function paneForRequest(requestId) {
    if (!requestId) return null
    const direct = panes.find(p => p.requestId && p.requestId === requestId)
    if (direct) return direct
    for (const p of panes) {
      if (p.liveTurnsByChat) {
        for (const [chatId, turn] of p.liveTurnsByChat.entries()) {
          if (turn.requestId === requestId) {
            if (p.chatId === chatId) return p
            turn.dom = turn.dom || p.dom
            turn.chatId = chatId
            return turn
          }
        }
      }
    }
    return null
  }

  // Карточка хода принадлежит чату хода, а не видимой панели: detached-ход
  // делит её DOM, и монтировать его вопрос/разрешение в чужую ленту нельзя.
  function isDetachedTurn(pane) {
    const owner = panes.find(p => p.dom === pane.dom)
    return Boolean(owner && owner.chatId !== pane.chatId)
  }

  function paneOfChat(chatId) {
    return panes.find(p => p.chatId === chatId) || null
  }

  function buildPanes() {
    panes.length = 0

    panes.push(createPane('main', {
      feed: $('chatFeed'),
      list: $('messagesList'),
      hero: $('welcomeHero'),
      textarea: $('composerTextarea'),
      form: $('composerForm'),
      card: $('composerCard'),
      sendBtn: $('sendBtn'),
      scrollBtn: $('scrollDownBtn'),
      attachStrip: $('attachmentStrip'),
      attachBtn: $('attachBtn')
    }))

    panes.push(createPane('side', {
      feed: $('splitFeed'),
      list: $('splitMessagesList'),
      hero: null,
      textarea: $('splitComposerTextarea'),
      form: $('splitComposerForm'),
      card: $('splitComposerCard'),
      sendBtn: $('splitSendBtn'),
      scrollBtn: $('splitScrollDownBtn'),
      attachStrip: $('splitAttachmentStrip'),
      attachBtn: $('splitAttachBtn')
    }))

    activePane = panes[0]
  }

  // Each pane drives its own composer. Focusing one makes it the target for
  // shortcuts and for anything that acts on "the current chat".
  function wireComposer(pane) {
    const { form, textarea, sendBtn } = pane.dom
    if (!form || !textarea) return

    textarea.addEventListener('focus', () => { setActivePane(pane) })

    textarea.addEventListener('input', () => {
      autoResizeTextarea(pane)
      paintSendButton(pane)
    })

    // The slash menu belongs to the main composer; in the side pane Enter just
    // sends, which keeps the second chat simple rather than half-featured.
    if (pane.id !== 'main') {
      textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          if (e.isComposing || e.keyCode === 229) return
          form.requestSubmit()
        }
      })
    }

    form.addEventListener('submit', e => {
      e.preventDefault()
      setActivePane(pane)

      const text = textarea.value.trim()

      // Sending while the agent works used to be the stop button in disguise:
      // the only way to add a thought was to kill the turn and start over.
      // Now it waits its turn, and stopping stays on the stop button.
      if (pane.generating || pane.preparing) {
        // Пустое поле во время хода — это остановка, и кнопка в этот момент
        // квадрат. Остановка жила только в панели фоновых задач: чтобы прервать
        // ход, надо было открыть панель и найти там маленький квадратик.
        if (!text) {
          stopTurn(pane)
          return
        }
        handleSendMessage(pane, text)
        return
      }

      // Плитка вставки или файл без слов — тоже сообщение: поле пустое, но у хода есть что читать.
      if (text || pane.attachments.length) handleSendMessage(pane, text || t('Посмотри вложение.'))
    })

    sendBtn?.addEventListener('click', () => { setActivePane(pane) })
    // «+» — это всё, что добавляют к ходу. Раньше папка и порядок работы стояли
    // отдельными подписанными кнопками, и строка ввода читалась как панель
    // инструментов: четыре слова там, где нужно поле для текста.
    pane.dom.attachBtn?.addEventListener('click', event => {
      setActivePane(pane)
      const box = event.currentTarget.getBoundingClientRect()
      const items = [
        { label: t('Прикрепить файлы'), hint: shortcutOf('attach'), onPick: () => pickAttachments(pane) },
        // Сразу системный выбор папки: раньше здесь звали openFolderMenu, которая
        // живёт внутри setupEventListeners и отсюда не видна — пункт не делал ничего.
        { label: t('Добавить папку'), onPick: () => addGlobalFolder() }
      ]
      openContextMenu(box.left, Math.max(8, box.top - 12 - items.length * 34), items)
      event.stopPropagation()
    })
  }

  // ---------------------------------------------------------------------------
  // Conversation storage
  // ---------------------------------------------------------------------------
  // History lives in the main process now, encrypted with safeStorage. It used to
  // sit here in localStorage as plain JSON: every message and every pasted
  // snippet readable by anything that could open the profile folder. The renderer
  // has no access to safeStorage, so the data had to move to be protected at all.

  const LEGACY_STORAGE_KEYS = [
    '1code_conversations_v7',
    '1code_conversations_v6',
    '1code_conversations_v5',
    '1code_conversations_v4',
    '1code_conversations_v3',
    '1code_conversations_v2',
    '1code_conversations_v1',
    '1code_conversations',
    'conversations'
  ]

  function readLegacyConversations() {
    const collected = []
    for (const key of LEGACY_STORAGE_KEYS) {
      try {
        const raw = localStorage.getItem(key)
        if (!raw) continue
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) continue
        for (const chat of parsed) {
          if (chat && chat.id && !collected.some(c => c.id === chat.id)) collected.push(chat)
        }
      } catch {}
    }
    return collected
  }

  function wipeLegacyConversations() {
    for (const key of LEGACY_STORAGE_KEYS) {
      try { localStorage.removeItem(key) } catch {}
    }
  }

  // Two versions of the same history: what this window holds and what was just
  // written to disk by the main process. Neither is authoritative on its own —
  // the agent's note exists only on disk, the user's newest message may exist
  // only here — so each chat keeps whichever side has more of it.
  function mergeConversations(local, fromDisk) {
    const byId = new Map(fromDisk.map(chat => [chat.id, chat]))

    for (const mine of local) {
      const theirs = byId.get(mine.id)

      if (!theirs) {
        // Created here and not yet saved: keep it rather than lose it.
        byId.set(mine.id, mine)
        continue
      }

      // Раньше здесь выбиралась более длинная сторона целиком, и это теряло
      // сообщения. Пользователь пишет вопрос — он есть только здесь; в ту же
      // секунду агент дописывает заметку — она есть только на диске. Длины
      // совпали, победил диск, вопрос исчез. Стороны объединяются.
      const messages = mergeMessages(mine.messages || [], theirs.messages || [])
      const keepMine = messages.length === (mine.messages || []).length &&
        messages.every((message, index) => message === mine.messages[index])

      // Saving is debounced, so a change made here a moment ago is not on disk
      // yet. Taking every field from disk regardless reverted it: a chat moved
      // into a project jumped straight back out, because an agent's note landed
      // in the meantime and the reload it triggered wrote the old row back over
      // the new one. Whichever copy is newer wins; ties go to disk, which is
      // where anything written by an agent arrives.
      const mineNewer = (mine.updatedAt || 0) > (theirs.updatedAt || 0)

      for (const key of Object.keys(theirs)) {
        if (key === 'messages') continue
        // A field this window holds nothing for cannot be an unsaved edit, so
        // the disk is the only one with an answer — that is how a topic the
        // agent has just written arrives even while this row is the newer one.
        const unset = mine[key] === undefined || mine[key] === null || mine[key] === ''
        if (mineNewer && !unset) continue
        mine[key] = theirs[key]
      }

      if (!keepMine) {
        // Same array, new contents: anything already holding it keeps working.
        mine.messages.length = 0
        mine.messages.push(...(messages || []))
      }

      byId.set(mine.id, mine)
    }

    return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  // Опознание сообщения между двумя копиями истории. Время создания ставится
  // один раз и переживает сохранение, поэтому роль плюс метка времени опознают
  // сообщение надёжнее содержимого: у ответа, который печатается прямо сейчас,
  // содержимое растёт с каждым чанком, и по нему копия не совпала бы сама с
  // собой. У старых записей метки нет — там опознаём по началу текста.
  function messageKey(message) {
    const role = message?.role || '?'
    if (message?.timestamp) return role + ':' + message.timestamp
    const content = message?.content
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(part => part?.text || '').join(' ')
      : ''
    return role + '#' + String(text).slice(0, 120)
  }

  // Объединение двух версий одной переписки. Общее начало у них почти всегда
  // одинаковое, расходятся хвосты: здесь — только что набранный вопрос, на
  // диске — только что дописанная агентом заметка. Обе стороны сохраняются,
  // порядок восстанавливается по времени.
  function mergeMessages(mine, theirs) {
    let common = 0
    while (common < mine.length && common < theirs.length &&
           messageKey(mine[common]) === messageKey(theirs[common])) common++

    const out = mine.slice(0, common)

    // Повторы считаются, а не просто отмечаются. У старых записей метки времени
    // нет, и ключ у них — начало текста: два «да» подряд давали один ключ, и
    // второе сообщение пропадало при каждом слиянии. Считается, сколько раз
    // сообщение встречается с каждой стороны, и берётся большее из двух — так
    // повтор остаётся повтором, а копия одного и того же не задваивается.
    const count = list => {
      const map = new Map()
      for (const message of list) {
        const key = messageKey(message)
        map.set(key, (map.get(key) || 0) + 1)
      }
      return map
    }

    const myTail = mine.slice(common)
    const theirTail = theirs.slice(common)
    const mineCount = count(myTail)
    const theirCount = count(theirTail)

    const taken = new Map()
    const tail = [...myTail, ...theirTail]
      .sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0))

    for (const message of tail) {
      const key = messageKey(message)
      const allowed = Math.max(mineCount.get(key) || 0, theirCount.get(key) || 0)
      const already = taken.get(key) || 0
      if (already >= allowed) continue
      taken.set(key, already + 1)
      out.push(message)
    }
    return out
  }

  // false — переписку прочитать не удалось (в `conversations` тогда пусто).
  async function loadConversations() {
    if (!window.electronAPI?.getConversations) {
      conversations = readLegacyConversations()
      return true
    }

    try {
      const legacy = readLegacyConversations()
      if (legacy.length) {
        // Hand the plaintext copy over once, then remove it from localStorage so
        // the unencrypted version stops existing.
        await window.electronAPI.migrateConversations(legacy)
        wipeLegacyConversations()
      }
      const stored = await window.electronAPI.getConversations()
      conversations = Array.isArray(stored) ? stored : []

      // removeItem above only tombstones the key. This drops the LevelDB store
      // itself, which is what actually removes the old plaintext from disk.
      await window.electronAPI.purgeLegacyStorage?.()
    } catch (err) {
      console.error('Не удалось загрузить историю:', err)
      conversations = []
      return false
    }
    return true
  }

  // Окно, которое при запуске не получило переписку, показывало пустоту —
  // «Новый диалог» вместо истории — и ни слова о том, что что-то не так.
  // А при отказе чтения и рабочей записи первое же
  // сохранение этого пустого чата ложилось поверх всей переписки. Теперь такое
  // окно один раз перезагружается само; если данных нет и после этого — говорит
  // об этом и переписку не сохраняет. Проверка — tests/run-boot-recovery-ui.cjs.
  const BOOT_RETRY_KEY = 'onlyone.bootRetry'
  const BOOT_DATA_WAIT_MS = 15000
  let historyUnavailable = false

  // true — окно уходит на перезагрузку, продолжать запуск незачем.
  function recoverFromMissingData(reason) {
    console.error('Окно не получило данные при запуске:', reason)
    window.electronAPI?.reportBootProblem?.(reason)
    // Не прочиталось хранилище — считаем, что перезагрузка уже была: цикл
    // перезагрузок хуже предупреждения.
    let retried = true
    try {
      retried = sessionStorage.getItem(BOOT_RETRY_KEY) === '1'
      if (!retried) sessionStorage.setItem(BOOT_RETRY_KEY, '1')
    } catch (err) {
      console.warn('Окно: sessionStorage недоступен, перезагрузки не будет:', err)
    }
    if (!retried) {
      location.reload()
      return true
    }
    historyUnavailable = true
    showBootWarning()
    return false
  }

  function noteBootRecovered() {
    if (historyUnavailable) {
      historyUnavailable = false
      document.getElementById('bootWarning')?.remove()
    }
    let retried = false
    try {
      retried = sessionStorage.getItem(BOOT_RETRY_KEY) === '1'
      sessionStorage.removeItem(BOOT_RETRY_KEY)
    } catch (err) {
      console.warn('Окно: sessionStorage недоступен:', err)
    }
    if (retried) showToast('Окно перезагрузилось: с первого раза данные не пришли. Сейчас всё на месте.')
  }

  function showBootWarning() {
    if (document.getElementById('bootWarning')) return
    const bar = document.createElement('div')
    bar.id = 'bootWarning'
    bar.className = 'toast-box show boot-warning'
    bar.setAttribute('role', 'alert')
    bar.textContent = t('Переписка не загрузилась. Чтобы не затереть её, изменения не сохраняются — закройте onlyone и откройте снова.')
    document.body.append(bar)
  }

  // Writes are coalesced: a turn touches the history several times in a row and
  // each write re-encrypts the whole set.
  let saveTimer = null
  let savePending = false

  // How many times in a row the history failed to save. Reset by a success.
  let saveFailures = 0

  function saveConversations() {
    if (historyUnavailable || !window.electronAPI?.setConversations) return
    savePending = true
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flushConversations, 400)
    if (remoteBridge) remoteBridge.pulse()
  }

  async function flushConversations() {
    if (!savePending || historyUnavailable || !window.electronAPI?.setConversations) return
    savePending = false
    try {
      await window.electronAPI.setConversations(conversations)
      if (saveFailures) {
        saveFailures = 0
        showToast('История снова сохраняется.')
      }
      return true
    } catch (err) {
      console.error('Не удалось сохранить историю:', err)
      savePending = true
      saveFailures++

      // The first failure retries on its own and is usually nothing. A second
      // in a row means the history is not being written, and continuing to
      // type into a conversation that is not being saved is the worst outcome
      // available — so it is said out loud, once, until a save succeeds.
      if (saveFailures === 2) {
        showToast('История не сохраняется на диск. Проверьте место и права доступа — ' +
          'написанное дальше может потеряться.', true)
      }

      // Keep trying: the cause is often temporary.
      clearTimeout(saveTimer)
      saveTimer = setTimeout(flushConversations, 4000)
      return false
    }
  }

  // Closing the window must not lose the last turn.
  window.addEventListener('beforeunload', () => {
    if (savePending) {
      clearTimeout(saveTimer)
      window.electronAPI?.setConversations?.(conversations)
    }
  })

  // ---- Предложения связанного чата: запись, восстановление, решения ----
  // Опись живёт на самом чате-родителе и едет существующим хранилищем переписок.
  // Событие одноразовое, поэтому ожидающие и принятые карточки собираются
  // заново при открытии чата и после чтения сохранённой истории.

  function acceptForkProposal(item, source, pane) {
    const busy = panes.some(p => (p.chatId === source.id || p.liveChatId === source.id) &&
      (p.generating || p.preparing || p.resuming))
    if (historyUnavailable || busy) {
      showToast(t('Дождитесь завершения хода перед созданием связанного чата.'), true)
      return Promise.reject(Error('turn-busy'))
    }
    const record = OnlyoneForkProposalStore.get(source, item.operationId)
    const check = OnlyoneForkProposalContext.check(record || item, { parent: source, conversations })
    if (!check.ok) {
      showToast(t(OnlyoneForkProposalRestore.PROBLEM_TEXT['context-changed']), true)
      return Promise.reject(Error(check.reason))
    }
    let result
    try {
      result = OnlyoneForkProposal.accept(item, {
        source,
        conversations,
        forkApi: OnlyoneChatForks,
        newId: crypto.randomUUID(),
        status: OnlyoneForkProposalStore.status(source, item.operationId)
      })
    } catch (error) {
      showToast(t('Не удалось создать связанный чат.'), true)
      return Promise.reject(error)
    }
    return (async () => {
      const target = pane || activePane || panes[0]
      if (!result.created) {
        const marked = OnlyoneForkProposalStore.setStatus(source, item.operationId, 'accepted', { childChatId: result.chat.id })
        if (marked.ok) { saveConversations(); await flushConversations() }
        selectChat(target, result.chat.id)
        renderChatHistory(); renderProjects()
        showToast(t('Связанный чат уже создан.'))
        return { created: false, saved: true, chat: result.chat }
      }
      conversations.unshift(result.chat)
      saveConversations()
      const childSaved = await flushConversations()
      if (!childSaved) {
        showToast(t('Связанный чат открыт, но ещё не сохранён на диск. Проверьте место и права доступа.'), true)
        return { created: true, saved: false, chat: result.chat }
      }
      // Статус «принято» пишется только после того, как дочерний чат уже на диске.
      OnlyoneForkProposalStore.setStatus(source, item.operationId, 'accepted', { childChatId: result.chat.id })
      saveConversations()
      const recordSaved = await flushConversations()
      selectChat(target, result.chat.id)
      renderChatHistory(); renderProjects()
      showToast(t(recordSaved
        ? 'Связанный чат создан. Модель не запускалась.'
        : 'Связанный чат создан, но запись предложения не обновлена. Она восстановится при следующем запуске.'), !recordSaved)
      return { created: true, saved: recordSaved, chat: result.chat }
    })()
  }

  async function rejectForkProposal(item, source) {
    if (OnlyoneForkProposalStore.status(source, item.operationId) === 'accepted') {
      showToast(t('Связанный чат уже создан.'), true)
      throw Error('already-accepted')
    }
    const marked = OnlyoneForkProposalStore.setStatus(source, item.operationId, 'rejected')
    // Старые переписки знают только список отклонённых: пишем туда, если записи
    // в описи уже нет. Нечитаемую опись не трогаем.
    if (!marked.ok) {
      if (marked.reason !== 'not-found') {
        showToast(t('Не удалось отклонить предложение.'), true)
        throw Error(marked.reason)
      }
      source.forkProposalDismissed = OnlyoneForkProposal.dismissedWith(source, item.operationId)
    }
    saveConversations()
    const saved = await flushConversations()
    if (!saved) {
      showToast(t('Не удалось отклонить предложение.'), true)
      return { saved: false }
    }
    const key = source.id + ':' + item.operationId
    const pending = forkProposalCards.get(key)
    if (pending) {
      pending.card.remove()
      forkProposalCards.delete(key)
    }
    refreshForkProposalSummary(panes.find(item => item.chatId === source.id || item.liveChatId === source.id))
    return { saved: true }
  }

  // Правка ожидающего предложения: магазин меняет запись, на диск её пишет
  // общий путь сохранения. Не сохранилось — запись возвращается к прежней, и
  // карточка показывает ошибку, а не выдуманный успех.
  async function editForkProposal(item, source) {
    const before = OnlyoneForkProposalStore.get(source, item.operationId)
    if (!before) {
      showToast(t('Не удалось сохранить изменения.'), true)
      throw Error('not-found')
    }
    const edited = OnlyoneForkProposalStore.update(source, item.operationId, {
      title: item.title,
      goal: item.goal,
      reason: item.reason,
      context: { mode: item.context?.mode, end: item.context?.end, summary: item.context?.summary }
    }, { now: Date.now() })
    if (!edited.ok) {
      showToast(t('Не удалось сохранить изменения.'), true)
      throw Error(edited.reason)
    }
    saveConversations()
    if (await flushConversations()) return { saved: true, record: edited.record }
    // Откат в памяти: на диск правка не легла, значит и показывать её нельзя.
    OnlyoneForkProposalStore.update(source, item.operationId, {
      title: before.title,
      goal: before.goal,
      reason: before.reason,
      context: { mode: before.context.mode, end: before.context.end, summary: before.context.summary }
    }, { now: before.updatedAt })
    saveConversations()
    showToast(t('Не удалось сохранить изменения.'), true)
    return { saved: false }
  }

  // Явный запуск связанного чата: создание модель не запускает, запуск —
  // отдельное действие человека. Цель предложения становится первым сообщением
  // хода в уже созданном чате; новый чат не создаётся.
  async function runForkProposal(item, source, pane) {
    const child = conversations.find(chat => chat.id === item?.childChatId)
    if (!child) {
      showToast(t('Связанный чат удалён.'), true)
      throw Error('child-deleted')
    }
    if (historyUnavailable) {
      showToast(t('Переписка не загрузилась. Чтобы не затереть её, изменения не сохраняются — закройте onlyone и откройте снова.'), true)
      throw Error('history-unavailable')
    }
    const target = pane || activePane || panes[0]
    const busy = panes.some(p => (p.chatId === child.id || p.liveChatId === child.id) &&
      (p.generating || p.preparing || p.resuming))
    if (busy) {
      showToast(t('Дождитесь завершения хода.'), true)
      throw Error('turn-busy')
    }
    const goal = typeof item?.goal === 'string' ? item.goal.trim() : ''
    if (!goal) {
      showToast(t('Не удалось создать связанный чат.'), true)
      throw Error('missing-goal')
    }
    selectChat(target, child.id)
    await handleSendMessage(target, goal)
    return { started: true, chatId: child.id }
  }

  // Возврат итога: одна адресная запись на последний ответ ребёнка, без
  // вызова модели и без копирования переписки. Повтор того же ответа не плодит.
  async function returnForkProposal(item, source, pane) {
    const child = conversations.find(chat => chat.id === item?.childChatId)
    if (!child) { showToast(t('Связанный чат удалён.'), true); throw Error('child-deleted') }
    const last = OnlyoneForkReturn.textOf(child)
    if (!last) { showToast(t('В дочернем чате ещё нет ответа.'), true); throw Error('no-answer') }
    if (OnlyoneForkReturn.isReturned(source, item.operationId, last.messageKey)) {
      showToast(t('Итог уже возвращён.'))
      return { saved: true, existing: true }
    }
    const stored = OnlyoneForkReturn.put(source, { operationId: item.operationId, childChatId: child.id, messageKey: last.messageKey, text: last.text, now: Date.now() })
    if (!stored.ok) { showToast(t('Не удалось вернуть итог.'), true); throw Error(stored.reason) }
    saveConversations()
    if (!(await flushConversations())) {
      OnlyoneForkReturn.drop(source, item.operationId, last.messageKey)
      saveConversations()
      showToast(t('Не удалось вернуть итог.'), true)
      return { saved: false }
    }
    const key = source.id + ':return:' + item.operationId + ':' + last.messageKey
    if (pane?.dom?.list && !forkProposalCards.has(key)) {
      const card = OnlyoneForkReturn.mountCard(pane.dom.list, stored.record, {
        t,
        childTitle: child.title || t('Связанный чат'),
        onOpenChild: record => { if (record?.childChatId) selectChat(pane, record.childChatId) }
      })
      if (card) forkProposalCards.set(key, { chatId: source.id, card })
    }
    showToast(t('Итог возвращён родителю.'))
    return { saved: true, record: stored.record }
  }

  function restoreForkReturns(pane) {
    if (!pane?.dom?.list || historyUnavailable) return
    const source = conversations.find(chat => chat.id === pane.chatId)
    if (!source) return
    const ledger = OnlyoneForkReturn.read(source)
    if (!ledger.ok || !ledger.returns.length) return
    for (const record of ledger.returns) {
      const key = source.id + ':return:' + record.operationId + ':' + record.messageKey
      if (forkProposalCards.has(key)) continue
      const child = conversations.find(chat => chat.id === record.childChatId)
      const card = OnlyoneForkReturn.mountCard(pane.dom.list, record, {
        t,
        childTitle: child?.title || t('Связанный чат'),
        onOpenChild: item => { if (child) selectChat(pane, item.childChatId); else showToast(t('Связанный чат удалён.'), true) }
      })
      if (card) forkProposalCards.set(key, { chatId: source.id, card })
    }
  }

  function forkProposalHandlers(source, pane) {
    return {
      onAccept: item => acceptForkProposal(item, source, pane),
      onReject: item => rejectForkProposal(item, source),
      onEdit: item => editForkProposal(item, source),
      onRun: item => runForkProposal(item, source, pane),
      onReturn: item => returnForkProposal(item, source, pane),
      onOpenChild: record => {
        if (!record?.childChatId) return
        // Ребёнка могли удалить уже после того, как карточка появилась: не
        // открываем пустоту и не обещаем успех.
        if (!conversations.some(chat => chat.id === record.childChatId)) {
          showToast(t('Связанный чат удалён.'), true)
          return
        }
        selectChat(pane || activePane || panes[0], record.childChatId)
      }
    }
  }

  function restoreForkProposalCards(pane) {
    if (!pane?.dom?.list || historyUnavailable) return
    const source = conversations.find(chat => chat.id === pane.chatId)
    if (!source) return
    // Не-массив в поле — тоже повод сказать человеку, что опись не читается:
    // раньше такой чат молча открывался без предупреждения.
    if (!source.forkProposals && !Array.isArray(source.forkProposalDismissed)) return
    const repaired = OnlyoneForkProposal.reconcile({ source, conversations, store: OnlyoneForkProposalStore })
    if (repaired.repaired) saveConversations()
    const result = OnlyoneForkProposalRestore.ensure({
      source,
      conversations,
      container: pane.dom.list,
      cache: forkProposalCards,
      t,
      parentTitle: source.title || t('Новый диалог'),
      handlers: forkProposalHandlers(source, pane)
    })
    const ledgerShapeBad = source.forkProposals !== undefined && !Array.isArray(source.forkProposals)
    if (ledgerShapeBad || (!result.ok && result.reason !== 'invalid-source')) {
      if (document.documentElement.dataset.appReady === '1') {
        // Метка на панели: перерисовки одной ленты не повторяют тост, а новое
        // открытие чата снова говорит человеку о повреждённой описи.
        if (pane.forkProposalWarned !== source.id) {
          pane.forkProposalWarned = source.id
          showToast(t('Предложения этого чата не читаются: запись повреждена.'), true)
        }
      } else if (!proposalLedgerWarned.has(source.id)) {
        // Во время загрузки окна тост мог уйти до подключения наблюдателей:
        // показываем его, когда окно уже готово.
        proposalLedgerWarned.add(source.id)
        setTimeout(() => showToast(t('Предложения этого чата не читаются: запись повреждена.'), true), 2000)
      }
    }
  }

  // Сводная карточка «Связанные задачи · N»: только записи описи, без статусов
  // исполнения — источника для них пока нет. Ожидающие остаются отдельными
  // карточками; здесь лишь счётчики и переходы в созданные чаты.
  function refreshForkProposalSummary(pane) {
    if (!pane?.dom?.list || historyUnavailable) return
    const list = pane.dom.list
    for (const node of list.querySelectorAll('[data-fork-proposal-summary]')) node.remove()
    const chatId = pane.chatId || pane.liveChatId
    const source = conversations.find(chat => chat.id === chatId)
    if (!source) return
    const running = new Set(panes.filter(item => item.generating || item.preparing || item.resuming)
      .map(item => item.chatId || item.liveChatId).filter(Boolean))
    const summary = OnlyoneForkProposal.summaryOf(source, conversations, OnlyoneForkProposalStore, running)
    const key = source.id + ':__summary'
    if (!summary.ok || summary.pending + summary.created === 0) {
      forkProposalCards.delete(key)
      return
    }
    const card = OnlyoneForkProposal.mountSummary(list, summary, {
      t,
      onOpenChild: record => { if (record?.chatId) selectChat(pane, record.chatId) }
    })
    forkProposalCards.set(key, { chatId: source.id, card })
  }

  const chatOf = pane => conversations.find(c => c.id === pane?.chatId) || null
  const currentChat = () => chatOf(activePane)

  // Toast
  // Electron wraps anything thrown inside ipcMain.handle as
  // "Error invoking remote method 'x': Error: …", so a message written for a
  // person arrives with a debugger's preamble glued to the front.
  function cleanErrorText(value) {
    return String(value?.message ?? value ?? '')
      .replace(/^Error invoking remote method '[^']*':\s*/i, '')
      .replace(/^(Uncaught\s+)?Error:\s*/i, '')
      .trim()
  }

  // Уведомление: одна строка, полоса-таймер 2 px внизу. С «Вернуть»
  // живёт 8 с, без него — 2,6 с; наведение и фокус ставят таймер на паузу.
  function showToast(message, isError = false, options = {}) {
    // An unbounded message once covered half the screen: a stack trace with a
    // whole HTML document in it. A toast is a glance, not a log.
    const text = t(cleanErrorText(message) || message)
    const box = el.toastNotification
    const undo = typeof options?.undo === 'function' ? options.undo : null
    const life = undo ? 8000 : 2600
    box.textContent = ''
    box.style.borderColor = ''
    const line = document.createElement('span')
    line.className = 'notice-text'
    line.textContent = text.length > 220 ? text.slice(0, 220) + '…' : text
    box.append(line)
    box.classList.toggle('is-error', Boolean(isError))
    box.classList.toggle('has-action', Boolean(undo))
    const hide = () => {
      clearTimeout(toastTimer)
      box.classList.remove('show')
    }
    if (undo) {
      const act = document.createElement('button')
      act.type = 'button'
      act.className = 'lnk lnk-accent'
      act.textContent = t('Вернуть')
      act.addEventListener('click', () => { hide(); undo() })
      box.append(act)
    }
    const bar = document.createElement('span')
    bar.className = 'notice-bar'
    bar.style.animationDuration = life + 'ms'
    box.append(bar)
    box.classList.add('show')
    let left = life
    let since = Date.now()
    clearTimeout(toastTimer)
    toastTimer = setTimeout(hide, left)
    box.onpointerenter = box.onfocusin = () => {
      clearTimeout(toastTimer)
      left = Math.max(800, left - (Date.now() - since))
      bar.style.animationPlayState = 'paused'
    }
    box.onpointerleave = box.onfocusout = () => {
      if (box.matches(':hover') || box.contains(document.activeElement)) return
      since = Date.now()
      bar.style.animationPlayState = 'running'
      clearTimeout(toastTimer)
      toastTimer = setTimeout(hide, left)
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  function cleanModelName(name) { return name ? (String(name).replace(/^[A-Za-z0-9._ -]+:\s*/, '').trim() || name) : '' }

  // Auto-scroll follows the answer only while the reader is already at the
  // bottom. Scroll up mid-generation and the view stays put — previously every
  // streamed chunk yanked it back down, so reading earlier output was impossible.

  function atBottom(pane, threshold = 80) {
    const feed = pane.dom.feed
    if (!feed) return true
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= threshold
  }

  function pinToBottom(pane, force = false) {
    if (!force && !pane.stickToBottom) return
    const feed = pane.dom.feed
    if (!feed) return

    // Smooth scrolling toward a target that keeps moving is exactly what makes
    // the text bounce: the browser animates to a bottom that has already moved
    // by the time it arrives, over and over. While anything is streaming the
    // view is pinned instantly — no animation, no chase, no bounce.
    // The stylesheet sets `scroll-behavior: smooth` on the feed, so assigning
    // scrollTop animates too — which is the chase this branch exists to avoid.
    // Only an explicit 'instant' gets out of it.
    const streaming = panes.some(p => p.generating)
    if (streaming || prefersReducedMotion()) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' })
      return
    }

    const remaining = feed.scrollHeight - feed.clientHeight - feed.scrollTop
    if (remaining > 320 || force) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' })
    } else {
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' })
    }
  }

  function scrollToBottom(pane, force = false) {
    requestAnimationFrame(() => pinToBottom(pane, force))
  }

  // «To the newest message», and it has to arrive in one press.
  //
  // It used to take three. The feed skips layout for messages scrolled out of
  // view — that is what keeps a long chat fast — so each one reports a
  // placeholder height until the view comes near it. `scrollHeight` at the
  // moment of the click is therefore an underestimate, sometimes badly: the
  // jump aims at it, the messages it passes lay out at their real heights, the
  // bottom moves further down, and the press lands short. Press again, land
  // closer, press a third time, arrive.
  //
  // So: aim, wait for the scroll to actually end, and if the bottom moved while
  // travelling, aim again. Bounded, because a feed that grows every frame — one
  // that is still streaming — must not trap this in a loop.
  function jumpToBottom(pane, tries = 8, animate = true) {
    const feed = pane.dom.feed
    if (!feed) return

    // Two traps here, and the press used to fall into both.
    //
    // `behavior: 'auto'` means «whatever the stylesheet says», and the feed's
    // stylesheet says smooth — so the branch meant to be instant never was.
    // Only 'instant' overrides it.
    //
    // And a smooth scroll is an animation: it needs frames. A window that is
    // not being painted does not get them, and the scroll simply never happens.
    // So the first press may animate, but every retry goes straight there. The
    // press arrives whether or not the animation ran.
    const instant = !animate || prefersReducedMotion() || panes.some(p => p.generating)
    feed.scrollTo({ top: feed.scrollHeight, behavior: instant ? 'instant' : 'smooth' })
    if (tries <= 0) return

    let handled = false
    const again = () => {
      if (handled) return
      handled = true
      feed.removeEventListener('scrollend', again)
      if (!atBottom(pane)) jumpToBottom(pane, tries - 1, false)
    }
    // `scrollend` is the precise signal; the timer is the fallback for the
    // instant path and for a scroll that had nowhere to go and so never ended.
    feed.addEventListener('scrollend', again, { once: true })
    setTimeout(again, instant ? 60 : 450)
  }

  function prefersReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  }

  function setupScrollTracking(pane) {
    const feed = pane.dom.feed
    if (!feed) return

    feed.addEventListener('scroll', () => {
      pane.stickToBottom = atBottom(pane)

      // Painting was skipped while they were reading further up; catch up now.
      if (pane.stickToBottom && pane.deferredPaint) {
        pane.deferredPaint = false
        pane.paintedBlocks = []
        paintBlocks(pane)
      }
      pane.dom.scrollBtn?.classList.toggle('visible', !pane.stickToBottom && feed.scrollHeight - feed.clientHeight > 120)
    }, { passive: true })

    // A wheel gesture upward detaches immediately, without waiting for the
    // scroll event to land — otherwise a fast stream can out-run the reader.
    feed.addEventListener('wheel', e => {
      if (e.deltaY < 0) pane.stickToBottom = false
    }, { passive: true })

    // Ленту, сжатую или выросшую по концу хода, не бросать выше конца ответа (см. followFeed).
    messageBlocks().followFeed(feed, () => pane.stickToBottom)

    pane.dom.scrollBtn?.addEventListener('click', () => {
      pane.stickToBottom = true
      jumpToBottom(pane)
      pane.dom.scrollBtn.classList.remove('visible')
    })
  }

  function autoResizeTextarea(pane) {
    const box = pane?.dom.textarea
    if (!box) return
    box.style.height = 'auto'
    // Строка ввода: одна строка 24 px, растёт до 192, дальше прокрутка
    const limit = Math.max(100, Math.min(192, Math.floor(window.innerHeight * 0.4)))
    box.style.maxHeight = `${limit}px`
    box.style.height = `${Math.max(Math.min(box.scrollHeight, limit), 24)}px`
    box.style.overflowY = box.scrollHeight > limit ? 'auto' : 'hidden'
  }

  // ---------------------------------------------------------------------------
  // Markdown rendering
  // ---------------------------------------------------------------------------
  // Model output and MCP tool results are untrusted text. marked has no sanitizer
  // of its own, so anything it passes through used to land straight in innerHTML —
  // and an injected handler would have had window.electronAPI in reach, including
  // resolveAgentApproval. Parsing happens in an inert document so nothing loads or
  // executes while we strip it.

  const ALLOWED_TAGS = new Set([
    'p', 'br', 'hr', 'span', 'div',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'sup', 'sub',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    'a', 'img'
  ])

  const ALLOWED_ATTRS = {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    code: ['class'],
    span: ['class'],
    div: ['class'],
    pre: ['class'],
    td: ['align'],
    th: ['align'],
    ol: ['start']
  }

  const SAFE_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i

  // Unwrapping these would spill their source into the page as visible text, and
  // in the case of svg/math the subtree can carry its own handlers. Drop whole.
  const DROP_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
    'form', 'input', 'textarea', 'select', 'option', 'button',
    'svg', 'math', 'template', 'noscript', 'audio', 'video', 'source', 'track'
  ])

  function scrubElement(root) {
    // Snapshot first: the list must not shift while we replace nodes.
    for (const node of [...root.querySelectorAll('*')]) {
      if (!node.isConnected) continue
      const tag = node.tagName.toLowerCase()

      if (DROP_TAGS.has(tag)) {
        node.remove()
        continue
      }

      if (!ALLOWED_TAGS.has(tag)) {
        // Keep whatever the user was meant to read, drop the element itself.
        node.replaceWith(...node.childNodes)
        continue
      }

      const allowed = ALLOWED_ATTRS[tag] || []
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase()
        if (!allowed.includes(name)) {
          node.removeAttribute(attr.name)
          continue
        }
        if ((name === 'href' || name === 'src') && !SAFE_URL.test(attr.value.trim())) {
          node.removeAttribute(attr.name)
        }
      }

      if (tag === 'a') {
        node.setAttribute('rel', 'noopener noreferrer')
        node.setAttribute('target', '_blank')
      }
    }
    return root
  }

  // A file path buried in a wall of prose is the thing you scan for, so it gets
  // its own treatment rather than looking like any other inline code.
  const PATH_LIKE = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[\w.\-@]+(?:[\\/][\w.\-@]+)+[\\/]?$|^[\w.\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|css|scss|html|md|py|rb|go|rs|java|kt|c|h|cpp|cs|php|sh|ps1|yml|yaml|toml|ini|env|sql|txt|log)$/

  // One renderer for a touched file, shared by the saved message and the live
  // feed — they used to carry two copies of the same inline styles.
  function fileChangesBlockHtml(changes, options) {
    return messageBlocks().fileChangesBlockHtml(changes, options)
  }

  function markTaskBoxes(...args) { return messageBlocks().markTaskBoxes(...args) }
  function linkifyImages(...args) { return messageBlocks().linkifyImages(...args) }

  function markInlinePaths(root) {
    root.querySelectorAll('code').forEach(code => {
      if (code.closest('pre')) return
      const text = (code.textContent || '').trim()
      if (text.length > 120) return
      if (PATH_LIKE.test(text)) code.classList.add('is-path')
    })
  }

  function highlightCodeBlocks(root) {
    if (typeof hljs === 'undefined') return
    root.querySelectorAll('pre > code').forEach(codeEl => {
      const raw = codeEl.textContent || ''
      const match = codeEl.className.match(/language-([a-zA-Z0-9_+-]+)/)
      const lang = match && hljs.getLanguage(match[1]) ? match[1] : null
      try {
        const result = lang
          ? hljs.highlight(raw, { language: lang })
          : hljs.highlightAuto(raw)
        codeEl.innerHTML = result.value
        codeEl.classList.add('hljs')
      } catch {
        /* leave the plain text in place */
      }
    })
  }

  // A table wide enough to overflow used to be made `display: block` so it could
  // scroll. That also stops it being a table for layout: columns no longer share
  // the width, and the last one gets squeezed into a two-line column of «См.
  // вопрос 3». The scrolling belongs to a wrapper, not to the table.
  function wrapTables(doc, root) {
    root.querySelectorAll('table').forEach(table => {
      if (table.parentElement?.classList.contains('table-scroll')) return
      const wrapper = doc.createElement('div')
      wrapper.className = 'table-scroll'
      table.replaceWith(wrapper)
      wrapper.appendChild(table)
    })
  }

  function wrapCodeBlocks(doc, root) {
    root.querySelectorAll('pre').forEach(pre => {
      const codeEl = pre.querySelector('code')
      let lang = 'code'
      if (codeEl) {
        const match = codeEl.className.match(/language-([a-zA-Z0-9_+-]+)/)
        if (match) lang = match[1]
      }

      const wrapper = doc.createElement('div')
      wrapper.className = 'code-block cb'
      wrapper.dataset.lang = lang

      const button = doc.createElement('button')
      button.type = 'button'
      button.className = 'btn-copy-code cb-copy'
      button.setAttribute('aria-label', t('Скопировать код'))
      button.dataset.tooltip = t('Скопировать код')
      button.innerHTML =
        '<svg fill="none" class="icon small" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.6" y="5.6" width="8" height="8" rx="2"/><path d="M10.4 3.6c-.2-.8-.9-1.4-1.7-1.4H4c-1 0-1.8.8-1.8 1.8v4.7c0 .8.6 1.5 1.4 1.7"/></svg>'

      pre.parentNode.insertBefore(wrapper, pre)
      wrapper.appendChild(pre)
      wrapper.appendChild(button)
    })
  }

  const MARKDOWN_CACHE_MAX = 300
  const markdownCache = new Map()

  // Огромный блок разбирался и раскладывался целиком на каждой перерисовке, а
  // живая лента повторяет её на каждый шаг потока: 5 МБ — ~1,15 с кадра (0,28 с
  // разбора + 0,85 с раскладки, замер 31.10). Голова блока рисуется сразу,
  // остальное ждёт кнопки: текст не теряется, кадр не блокируется.
  const MARKDOWN_INLINE_LIMIT = 128 * 1024
  const CAPPED_SOURCE_MAX = 64
  // shortcut: источники огромных блоков живут в карте под уникальным ключом;
  // когда карта растёт выше CAPPED_SOURCE_MAX, самый старый ключ вытесняется
  // вместе с источником — карта не разрастается до бесконечности (Н7).
  const cappedSources = new Map()
  let cappedSeq = 0
  let cappedClickBound = false

  function cappedHeadOf(source) {
    if (source.length <= MARKDOWN_INLINE_LIMIT) return ''
    // Режем по переводу строки, если он рядом: абзац не рвётся посередине.
    const hard = source.slice(0, MARKDOWN_INLINE_LIMIT)
    const soft = hard.lastIndexOf('\n')
    return soft > MARKDOWN_INLINE_LIMIT / 2 ? hard.slice(0, soft) : hard
  }

  // Ключ — отдельный на каждый рендер, а не на голову текста. Два разных
  // сообщения с одинаковым началом (повторяющиеся tool-выводы, логи) давали бы
  // один ключ по голове, второй рендер перезаписывал источник — и кнопка
  // первого сообщения открывала чужой полный текст (Н4). Разметка головы
  // кэшируется отдельно по head, а ключ с кнопкой собираются заново на рендер.
  function cappedKey(source) {
    const key = `md-capped-${++cappedSeq}`
    cappedSources.set(key, source)
    while (cappedSources.size > CAPPED_SOURCE_MAX) {
      cappedSources.delete(cappedSources.keys().next().value)
    }
    return key
  }

  function cappedNoteHtml(key, head, source) {
    const lang = typeof getUiLang === 'function' && getUiLang() === 'en' ? 'en-US' : 'ru-RU'
    const count = new Intl.NumberFormat(lang)
    const shown = t('Показаны первые %s из %s знаков.', count.format(head.length), count.format(source.length))
    return `<div class="md-capped-note"><span>${escapeHtml(shown)}</span>` +
      `<button type="button" class="btn sm ghost" data-md-more="${key}">${escapeHtml(t('Показать целиком'))}</button></div>`
  }

  // Кнопка приходит разметкой, поэтому обработчик один на документ.
  function bindCappedClick() {
    if (cappedClickBound || typeof document === 'undefined' || !document.addEventListener) return
    cappedClickBound = true
    document.addEventListener('click', event => {
      const button = event.target?.closest?.('[data-md-more]')
      if (!button) return
      const source = cappedSources.get(button.getAttribute('data-md-more'))
      const wrapper = button.closest('.md-capped')
      if (source == null || !wrapper) return
      const holder = document.createElement('div')
      holder.innerHTML = renderMarkdownHtml(source, { full: true })
      bindCopyButtons(holder)
      wrapper.replaceWith(...holder.childNodes)
    })
  }

  function renderMarkdownHtml(text, options) {
    const source = String(text || '')
    if (typeof marked === 'undefined') {
      return `<p>${escapeHtml(source)}</p>`
    }
    const head = options?.full ? '' : cappedHeadOf(source)
    const input = head || source
    // В кэше для головы лежит только разобранный текст: подпись «сколько
    // показано» и ключ кнопки собираются заново — иначе на потоке в ней
    // застыло бы число знаков с первой перерисовки.
    let key = ''
    if (head) { bindCappedClick(); key = cappedKey(source) }
    const cached = markdownCache.get(input)
    if (cached !== undefined) {
      markdownCache.delete(input)
      markdownCache.set(input, cached)
      return head ? `<div class="md-capped">${cached}${cappedNoteHtml(key, head, source)}</div>` : cached
    }

    try {
      const rawHtml = marked.parse(input)
      // parseFromString builds an inert document: no network, no script, no
      // handlers fire. Everything below runs before it reaches the live page.
      const doc = new DOMParser().parseFromString(rawHtml, 'text/html')
      const body = doc.body

      markTaskBoxes(doc, body)
      scrubElement(body)
      linkifyImages(doc, body)
      markInlinePaths(body)
      highlightCodeBlocks(body)
      wrapCodeBlocks(doc, body)
      wrapTables(doc, body)

      const result = typeof formatWithEmoji === 'function' ? formatWithEmoji(body.innerHTML) : body.innerHTML
      // Полный рендер мегабайтного блока в кэш не кладём: он там один занял бы
      // столько же, сколько весь кэш обычных ответов.
      if (input.length <= MARKDOWN_INLINE_LIMIT) {
        if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
          markdownCache.delete(markdownCache.keys().next().value)
        }
        markdownCache.set(input, result)
      }
      return head ? `<div class="md-capped">${result}${cappedNoteHtml(key, head, source)}</div>` : result
    } catch (err) {
      console.error('Markdown render failed:', err)
      return `<p>${escapeHtml(source)}</p>`
    }
  }

  // Flattens segments for storage. A single unnamed agent keeps its plain text so
  // one-agent chats read exactly as before.
  function reasoningSegmentsToText(pane) {
    if (pane.reasoningSegments.length === 1 && !pane.reasoningSegments[0].agent) {
      return pane.reasoningSegments[0].text
    }
    return pane.reasoningSegments
      .map(s => (s.agent ? `[${s.agent}]\n${s.text}` : s.text))
      .join('\n\n')
  }

  // Thinking reads as thinking: plain text in its own colour, above the answer.
  // No panel, no toggle — it is part of what the model said, not a drawer.
  function reasoningInnerHtml(segments) {
    return segments
      .map(s => `
        ${s.agent ? `<div class="reasoning-agent">${escapeHtml(s.agent)}</div>` : ''}
        <div class="reasoning-segment">${escapeHtml(s.text)}</div>
      `)
      .join('')
  }

  function reasoningStreamHtml(segments, { live = false } = {}) {
    return `<div class="reasoning-stream${live ? ' live' : ''}">${reasoningInnerHtml(segments)}</div>`
  }

  // Older messages stored reasoning as one string; wrap it as a single segment.
  function segmentsFromStored(reasoning) {
    if (Array.isArray(reasoning)) return reasoning
    const text = String(reasoning || '')
    if (!text) return []
    if (!text.startsWith('[')) return [{ agent: '', text }]
    return text
      .split(/\n\n(?=\[)/)
      .map(block => {
        const m = block.match(/^\[([^\]]+)\]\n([\s\S]*)$/)
        return m ? { agent: m[1], text: m[2] } : { agent: '', text: block }
      })
  }

  // Colours the -/+ lines of an approval diff. Input is escaped first, so the
  // only markup that reaches the page is the span wrappers added here.
  function renderDiffLines(diff) {
    return String(diff || '')
      .split('\n')
      .map(line => {
        const safe = escapeHtml(line)
        if (line.startsWith('+')) return `<span class="diff-add">${safe}</span>`
        if (line.startsWith('-')) return `<span class="diff-del">${safe}</span>`
        if (line.startsWith('@@')) return `<span class="diff-hunk">${safe}</span>`
        return safe
      })
      .join('\n')
  }


  function bindCopyButtons(container) {
    container.querySelectorAll('.btn-copy-code').forEach(btn => {
      if (btn.dataset.bound) return
      btn.dataset.bound = 'true'
      btn.addEventListener('click', async () => {
        const codeText = btn.closest('.code-block')?.querySelector('pre code, pre')?.textContent || ''
        try {
          await navigator.clipboard.writeText(codeText)
          btn.classList.add('copied')
          btn.dataset.tooltip = t('Скопировано')
          showToast(t('Код скопирован'))
          setTimeout(() => {
            btn.classList.remove('copied')
            btn.dataset.tooltip = t('Скопировать код')
          }, 1500)
        } catch {
          showToast('Не удалось скопировать', true)
        }
      })
    })
  }

  // Whole seconds, then minutes, then hours. Tenths flickering ten times a second
  // are noise — nobody reads them, they just twitch in the corner of the eye.
  function formatDuration(seconds) {
    const total = Math.floor(Number(seconds) || 0)
    // Единицы времени — подписаны словарём: «1 с» в английском ряду выглядит
    // русской строкой, а это ровно то, что видит человек под каждым ответом.
    if (total < 60) return t('%s с', total)

    const mins = Math.floor(total / 60)
    if (mins < 60) return t('%s мин %s с', mins, String(total % 60).padStart(2, '0'))

    const hours = Math.floor(mins / 60)
    return t('%s ч %s мин', hours, String(mins % 60).padStart(2, '0'))
  }

  // The number alone. «токенов» after it said what the third value in a row of
  // three already said by being there, and it was the only word in a line
  // otherwise made of figures.
  function formatTokens(count) {
    const n = Number(count) || 0
    if (n <= 0) return ''
    if (n < 1000) return String(n)
    return `${(n / 1000).toFixed(1)}k`
  }

  // Keeps the live footer in step with the running turn without re-rendering the
  // whole message on every tick.
  // Сколько задач в работе и чем занят тот, кто их делает. Это то же самое, что
  // показывает панель работы, но на виду: панель можно и не открыть, а строка
  // под ответом читается сама собой — там же, где имя модели и время.
  // Строка «2 задачи · чем занят» ушла из подписи под ответом: ровно то же
  // самое стоит в панели работы, и там ему место. Под ответом она удваивала
  // текст и на длинном ходе превращалась в «2 задачи · Ревью: этапов 3» —
  // набор слов рядом с именем модели.

  function updateLiveMeta(pane) {
    if (!pane.assistantEl) return

    const tokensEl = pane.assistantEl.querySelector('.cli-tokens')
    if (tokensEl) {
      const text = formatTokens(pane.totalTokens)
      tokensEl.textContent = text
      tokensEl.previousElementSibling?.classList.toggle('hidden', !text)
      tokensEl.classList.toggle('hidden', !text)
    }

    // A rate-limited model gets replaced by OpenRouter mid-request, so the name
    // in the footer has to be the one that actually answered, not the one asked.
    const requested = pane.requestedModel || selectedModel
    if (pane.actualModelId && pane.actualModelId !== requested?.id) {
      const nameEl = pane.assistantEl.querySelector('.cli-model')
      if (nameEl) {
        const record = findCatalogModel(pane.actualModelId)
        nameEl.textContent = `${record?.name || pane.actualModelId} (замена)`
        nameEl.dataset.tooltip = `Запрошена ${requested?.name || requested?.id}, ответила ${pane.actualModelId}`
        nameEl?.removeAttribute?.('title')
      }
    }
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return ''
    const diff = Date.now() - timestamp
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'сейчас'
    if (mins < 60) return `${mins}м`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}ч`
    const days = Math.floor(hours / 24)
    if (days === 1) return 'вчера'
    if (days < 30) return `${days}д`
    const months = Math.floor(days / 30)
    return `${months}мес`
  }

  // Smooth Token Typewriter Animation
  // The old typewriter re-parsed the entire markdown, re-ran syntax highlighting
  // and rebuilt the DOM on every animation frame — sixty times a second. Every
  // rebuild re-measured the layout, which is exactly why the text jittered while
  // nothing was being scrolled. The stream already arrives in chunks, so there is
  // nothing to simulate: render on a timer instead, at a rate the eye reads as
  // continuous but the layout can keep up with.
  const LIVE_RENDER_MS = 90

  // Cadence is measured: paint times itself, next waits ~4x that to bound main thread cost.
  const MAX_PAINT_GAP_MS = 600

  function schedulePaint(pane) {
    if (pane.paintScheduled) return
    pane.paintScheduled = true
    const wait = Math.min(MAX_PAINT_GAP_MS, Math.max(LIVE_RENDER_MS, (pane.lastPaintCost || 0) * 4))
    pane.paintTimer = setTimeout(() => {
      requestAnimationFrame(() => {
        pane.paintScheduled = false
        if (!pane.assistantEl) return
        const started = performance.now()
        renderLiveContent(pane)
        pinToBottom(pane)
        pane.lastPaintCost = performance.now() - started
      })
    }, wait)
  }

  const SMOOTH_STREAM_TICK_MS = 25

  function stepSmoothStream(pane) {
    const target = (pane.streamQueue || '').length
    const current = pane.smoothCursor || 0
    const delta = target - current
    if (delta <= 0) return false
    const step = delta > 60 ? Math.ceil(delta / 4) : delta > 20 ? Math.ceil(delta / 6) : delta > 8 ? 2 : 1
    pane.smoothCursor = Math.min(target, current + step)
    pane.contentBuffer = (pane.streamQueue || '').slice(0, pane.smoothCursor)
    renderLiveContent(pane); pinToBottom(pane)
    return pane.smoothCursor < target
  }

  function startSmoothStreamAnimation(pane) {
    if (pane.smoothCursor == null) pane.smoothCursor = 0
    if (pane.smoothTimer) return
    pane.smoothTimer = setTimeout(() => {
      pane.smoothTimer = setInterval(() => {
        if (!stepSmoothStream(pane)) { clearInterval(pane.smoothTimer); pane.smoothTimer = null }
      }, SMOOTH_STREAM_TICK_MS)
      stepSmoothStream(pane)
    }, LIVE_RENDER_MS)
  }

  function stopLiveRender(pane) {
    if (pane.smoothTimer) { clearTimeout(pane.smoothTimer); clearInterval(pane.smoothTimer); pane.smoothTimer = null }
    clearTimeout(pane.paintTimer)
    pane.paintTimer = null
    pane.paintScheduled = false
    pane.lastPaintCost = 0
    pane.lastRendered = -1
    pane.smoothCursor = (pane.streamQueue || '').length
    pane.contentBuffer = pane.streamQueue || ''
    if (pane.assistantEl) renderLiveContent(pane)
  }

  // Keeps the text block in step with what has been received so far. The
  // block is found by identity, not by position: thinking may have been
  // pushed after it and it must not be resurrected at the end.
  function syncTextBlock(pane) {
    const full = pane.contentBuffer || ''
    if (!full) return
    pane.blocks = pane.blocks || []

    // Some models send their reasoning down both channels at once: once as
    // reasoning, once as content. Drawn naively that is the same wall of text
    // twice — as the answer and inside the thought.
    const thought = pane.blocks
      .filter(b => b.kind === 'thinking')
      .map(b => b.text)
      .join('')

    if (thought.length > 60) {
      // Still mid-echo: nothing has arrived yet that the thought does not
      // already contain, so there is no answer to draw.
      if (thought.startsWith(full)) return

      // The echo finished and the real answer began. Remember how much of the
      // content channel was a repeat, or it gets drawn once the test above
      // stops holding.
      if (full.startsWith(thought)) pane.echoLen = thought.length
    }

    const echo = pane.echoLen || 0
    const drawnSoFar = pane.blocks
      .filter(b => b.kind === 'text')
      .reduce((sum, b) => sum + b.text.length, 0)

    const cursor = echo + drawnSoFar
    if (full.length > cursor) { const delta = full.slice(cursor); const last = pane.blocks[pane.blocks.length - 1]; if (last && last.kind === 'text') last.text += delta; else pushBlock(pane, 'text', delta) }
  }

  function renderLiveContent(pane) {
    if (!pane.assistantEl) return

    // Once the answer starts arriving the model has stopped thinking out loud.
    const liveStream = pane.assistantEl.querySelector('.reasoning-stream.live')
    if (liveStream) liveStream.classList.remove('live')

    syncTextBlock(pane)
    paintBlocks(pane)
    scrollToBottom(pane)
  }

  // Slash Menu Operations
  // Компактный список над «/» и над пилюлей режимов — один модуль на оба
  // Позиция над якорем, ширина по имени, строка 28 px и описание
  // подсказкой справа. Классы строки и имени передаются прежние — на них
  // смотрят прогоны окна (`smoke-renderer`, `design-renderer`).
  let composerMenuInstance = null
  function composerMenu() {
    if (!composerMenuInstance) {
      composerMenuInstance = OnlyoneComposerMenu.create({ $, el, t, escapeHtml, document, window })
    }
    return composerMenuInstance
  }

  function slashMatches(query) {
    return OnlyoneSlashCommands.match(SLASH_COMMANDS, query)
  }

  function closeSlashMenu() {
    composerMenu().close()
    if (el.slashMenu) el.slashMenu.style.display = 'none'
  }

  function updateSlashMenu(query) {
    const matches = slashMatches(query)
    if (!matches.length) { closeSlashMenu(); return }
    el.slashMenu.style.display = 'flex'
    composerMenu().open({
      anchor: el.composerTextarea,
      host: el.slashMenuList,
      items: matches.map(item => ({ id: item.cmd, name: item.cmd, hint: item.desc })),
      selected: 0,
      ariaLabel: t('Команды'),
      itemClass: 'slash-menu-item',
      nameClass: 'slash-item-cmd',
      onPick: picked => executeSlashCommand(SLASH_COMMANDS.find(c => c.cmd === picked.id))
    })
  }

  function executeSlashCommand(item) {
    closeSlashMenu()
    if (!item) return
    el.composerTextarea.value = `${item.cmd} `
    autoResizeTextarea(panes[0])
    el.composerTextarea.focus()
    el.composerTextarea.setSelectionRange(el.composerTextarea.value.length, el.composerTextarea.value.length)

    if (item.action) {
      item.action()
    }
  }

  // ─── Список диалогов ────────────────────────────────────────────
  // Строки истории, папки и меню диалога вынесены своим модулем:
  // `chat-list.js`. Здесь только проводка.
  let chatListInstance = null
  function chatList() {
    if (!chatListInstance) {
      chatListInstance = OnlyoneChatList.create({
        $, el, t, escapeHtml, showToast, openContextMenu, switchTab, createNewChat, forkChat,
        createProject, deleteChat, nameChat, openProject, openProjectEditor,
        paneOfChat, renderProjects, renderSplitPane, saveConversations, selectChat,
        toggleSplitView, getActivePane: () => activePane, getPanes: () => panes,
        getConversations: () => conversations, getProjects: () => projects
      })
    }
    return chatListInstance
  }
  // Список Sessions оболочки — те же диалоги, что видит боковая панель: без
  // перерисовки он остался бы тем, что был в момент сборки экрана. При старте
  // это пустой список — история доезжает позже `applyUiConfig`, и оболочка
  // молчала бы до первого переключения языка.
  // Дерево связанных чатов — та же переписка, что у списка: связь читается из
  // `chat.fork.parentChatId`, ничего нового на диск не пишется. Раскрытие —
  // настройка отображения (fork-tree-model.js, ключ 1code_fork_tree_collapsed).
  let forkTreeInstance = null
  function forkTree() {
    if (!forkTreeInstance) {
      forkTreeInstance = OnlyoneForkTree.create({
        container: el.forkTreeSection,
        t,
        storage: window.localStorage,
        getConversations: () => conversations,
        getActiveId: () => chatOf(activePane || panes[0])?.id || null,
        selectChat: id => selectChat(activePane || panes[0], id),
        openContextMenu,
        onOpenParent: id => selectChat(activePane || panes[0], id)
      })
    }
    return forkTreeInstance
  }
  function renderChatHistory(...args) {
    const result = chatList().renderChatHistory(...args)
    // Имя чата в шапке и в боковой панели — одно: список перерисовывается при каждой смене
    // названия (авто-имя, переименование), поэтому шапка догоняет его здесь же.
    if (typeof renderChatHeader === 'function' && panes[0]) renderChatHeader(panes[0])
    syncUltraShell()
    forkTree().render()
    return result
  }
  function moveChatToProject(...args) { return chatList().moveChatToProject(...args) }

  // ---------------------------------------------------------------------------
  // Context menu
  // ---------------------------------------------------------------------------
  // Общий виджет вынесен в `context-menu.js`: им пользуются строки
  // диалогов, проекты, скиллы и панель артефактов. Здесь — только имена, под
  // которыми их знает остальной экран.
  // Ленивая сборка и поднятые объявления: имена зовут и выше этого места, а
  // `const`-стрелка на время между стартом файла и этой строкой — ловушка.
  let contextMenuInstance = null
  function contextMenu() {
    if (!contextMenuInstance) {
      contextMenuInstance = OnlyoneContextMenu.create({ t, escapeHtml, formatWithEmoji, document, window })
    }
    return contextMenuInstance
  }
  function openContextMenu(...args) { return contextMenu().open(...args) }


  // A chat belongs to no folder unless it is deliberately put in one. It used to
  // inherit whatever project was opened last, so after touching a project once
  // every new chat silently landed inside it with no way back out.
  function createNewChat(pane = activePane || panes[0], initialTitle = t('Новый диалог'), projectId = null) {
    // An untouched chat is reused rather than piling up empty ones — but only
    // if it belongs where the new one would: reusing a blank from another
    // folder would silently move it.
    const active = chatOf(pane)
    if (active && active.messages.length === 0 && (active.projectId || null) === (projectId || null)) {
      renderMessages(pane)
      renderChatHistory()
      pane.dom.textarea?.focus()
      return active
    }

    const newChat = {
      id: crypto.randomUUID ? crypto.randomUUID() : `chat_${Date.now()}`,
      title: initialTitle,
      messages: [],
      projectId: projectId || null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    conversations.unshift(newChat)
    saveConversations()
    selectChat(pane, newChat.id)
    renderProjects()
    pane.dom.textarea?.focus()
    return newChat
  }

  let forkInProgress = false
  async function forkChat(sourceId, end) {
    if (forkInProgress) return
    const source = conversations.find(chat => chat.id === sourceId)
    const busy = panes.some(p => (p.chatId === sourceId || p.liveChatId === sourceId) && (p.generating || p.preparing || p.resuming))
    if (!source || historyUnavailable || busy) { showToast(t('Дождитесь завершения хода перед созданием форка.'), true); return }
    forkInProgress = true
    try {
      const preview = OnlyoneChatForks.snapshot(source, end)
      const title = source.title || t('Новый диалог')
      const confirmed = await OnlyoneForkPreview.open({ doc: document, name: title, end: preview.end,
        total: source.messages.length, copied: preview.messages.length, omitted: preview.omitted, t, opener: document.activeElement })
      if (!confirmed) return
      const fork = OnlyoneChatForks.child(source, preview, title, crypto.randomUUID())
      conversations.unshift(fork)
      saveConversations()
      const saved = await flushConversations()
      selectChat(activePane || panes[0], fork.id)
      renderChatHistory(); renderProjects()
      if (saved) showToast(t('Форк создан. Перенесён только текст; модель не запускалась.'))
      else showToast(t('Форк открыт, но ещё не сохранён на диск. Проверьте место и права доступа.'), true)
    } catch { showToast(t('Нет текстовых сообщений для форка.'), true) }
    finally { queueMicrotask(() => { forkInProgress = false }) }
  }

  // Lives here rather than inside the listener setup: choosing a chat from the
  // Skills or Connectors page has to switch the view, and that call happens far
  // from where the buttons are wired.
  // Сайдбар сворачивается до иконок и помнит своё состояние. На узком окне он
  // забирал двести семьдесят пикселей у превью — ровно у того, ради чего окно
  // и открыто.
  const SIDEBAR_KEY = '1code_sidebar_narrow'

  function syncSidebarNavLabels() {
    const collapsed = document.body.classList.contains('sidebar-narrow')
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(button => {
      const label = button.querySelector(':scope > span:not(.badge-count)')?.textContent?.trim()
      if (!label) return
      // Пишем только когда значение правда другое: эти подписи читаются из
      // переведённого текста, и бесконечная запись держала бы наблюдателя
      // переводов в постоянном круге.
      if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
      if (collapsed) {
        if (button.dataset.tooltip !== label) button.dataset.tooltip = label
      } else if (button.hasAttribute('data-tooltip')) {
        button.removeAttribute('data-tooltip')
      }
    })
  }

  function applySidebarWidth(narrow) {
    document.body.classList.toggle('sidebar-narrow', Boolean(narrow))
    syncSidebarNavLabels()
    const button = $('sidebarToggle')
    if (button) {
      const label = t(narrow ? 'Развернуть боковую панель' : 'Свернуть боковую панель')
      button.dataset.tooltip = label
      button?.removeAttribute?.('title')
      button.setAttribute('aria-label', label)
      button.setAttribute('aria-pressed', String(Boolean(narrow)))
    }
    // Ширина колонки изменилась — вписанный макет надо вписать заново.
    if (typeof fitDesignPreview === 'function') fitDesignPreview()
  }

  // Ширина переписки в разделе Design. Значение помнится между запусками: в
  // одном ходе смотрят на макет, в другом пишут длинное задание, и таскать
  // разделитель заново каждый раз — работа на ровном месте.
  const DESIGN_WIDTH_KEY = '1code_design_chat_width'
  const DESIGN_MIN = 260
  const DESIGN_MIN_PREVIEW = 420

  function applyDesignChatWidth(px) {
    const column = document.querySelector('.design-chat')
    const body = document.querySelector('.design-body')
    if (!column || !body) return
    const total = body.getBoundingClientRect().width || window.innerWidth
    const max = Math.max(DESIGN_MIN, total - DESIGN_MIN_PREVIEW)
    const width = Math.round(Math.min(max, Math.max(DESIGN_MIN, px)))
    // Проценты из стилей и max-width оба мешают точному значению.
    column.style.flex = `0 0 ${width}px`
    column.style.width = `${width}px`
    column.style.maxWidth = 'none'
    fitDesignPreview()
    return width
  }

  function setupDesignResizer() {
    const bar = $('designResizer')
    const column = document.querySelector('.design-chat')
    if (!bar || !column) return

    let saved = 0
    try { saved = Number(localStorage.getItem(DESIGN_WIDTH_KEY)) || 0 } catch {}
    if (saved) applyDesignChatWidth(saved)

    let dragging = false
    const onMove = event => {
      if (!dragging) return
      event.preventDefault()
      const left = document.querySelector('.design-body')?.getBoundingClientRect().left || 0
      applyDesignChatWidth(event.clientX - left)
    }
    const stop = () => {
      if (!dragging) return
      dragging = false
      document.body.classList.remove('resizing-design')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      try { localStorage.setItem(DESIGN_WIDTH_KEY, String(Math.round(column.getBoundingClientRect().width))) } catch {}
    }

    bar.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      dragging = true
      document.body.classList.add('resizing-design')
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', stop)
      event.preventDefault()
    })

    // С клавиатуры — теми же шагами, что и мышью, иначе разделитель недоступен
    // вовсе для тех, кто не пользуется мышью.
    bar.addEventListener('keydown', event => {
      const step = event.shiftKey ? 60 : 20
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const now = column.getBoundingClientRect().width
      const next = applyDesignChatWidth(now + (event.key === 'ArrowRight' ? step : -step))
      try { localStorage.setItem(DESIGN_WIDTH_KEY, String(next)) } catch {}
    })

    // Двойное нажатие возвращает к равновесию — быстрее, чем целиться мышью.
    bar.addEventListener('dblclick', () => {
      const total = document.querySelector('.design-body')?.getBoundingClientRect().width || 0
      const next = applyDesignChatWidth(Math.round(total * 0.38))
      try { localStorage.setItem(DESIGN_WIDTH_KEY, String(next)) } catch {}
    })
  }

  function setupSidebarToggle() {
    let narrow = false
    try { narrow = localStorage.getItem(SIDEBAR_KEY) === '1' } catch {}
    applySidebarWidth(narrow)
    $('sidebarToggle')?.addEventListener('click', () => {
      setSidebarNarrow(!document.body.classList.contains('sidebar-narrow'))
    })
    setupSidebarResizer()
  }

  // Человек сам решил, какой быть панели, — закрыв второй чат, её уже не
  // возвращаем.
  function setSidebarNarrow(narrow) {
    if (typeof sidebarCollapsedBySplit !== 'undefined') sidebarCollapsedBySplit = false
    forgetSidebarNarrowing()
    applySidebarWidth(narrow)
    try { localStorage.setItem(SIDEBAR_KEY, narrow ? '1' : '0') } catch {}
  }

  // Ширина боковой панели тянется за край и помнится между
  // запусками. Утянутая уже SIDEBAR_SNAP панель сворачивается до значков, как
  // по кнопке, и тем же движением разворачивается обратно.
  const SIDEBAR_WIDTH_KEY = '1code_sidebar_width'
  const SIDEBAR_MIN = 200
  const SIDEBAR_MAX = 420
  const SIDEBAR_DEFAULT = 268
  const SIDEBAR_SNAP = 150

  function applySidebarPixels(px) {
    const width = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)))
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`)
    $('sidebarResizer')?.setAttribute('aria-valuenow', String(width))
    return width
  }

  function sidebarPixels() {
    return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10) || SIDEBAR_DEFAULT
  }

  // Конфигурация интерфейса как данные и примерка (пункты 7.1, 7.2)
  let currentUiConfig = null
  let activeUiProposal = null

  function applyUiConfig(cfg) {
    if (!cfg) return
    currentUiConfig = { ...(currentUiConfig || {}), ...cfg }
    const root = document.documentElement
    if (cfg.sidebarWidth != null) {
      root.style.setProperty('--sidebar-width', `${cfg.sidebarWidth}px`)
      root.style.setProperty('--sidebar-w', `${cfg.sidebarWidth}px`)
      $('sidebarResizer')?.setAttribute('aria-valuenow', String(cfg.sidebarWidth))
    }
    if (cfg.workPanelWidth != null) {
      root.style.setProperty('--work-panel-width', `${cfg.workPanelWidth}px`)
    }
    if (cfg.codeFontSize != null) {
      root.style.setProperty('--code-font-size', `${cfg.codeFontSize}px`)
    }
    if (cfg.fontUiSize != null) {
      root.style.setProperty('--font-ui-size', `${cfg.fontUiSize}px`)
    }
    if (cfg.showSidebar != null) {
      root.style.setProperty('--sidebar-display', cfg.showSidebar ? 'flex' : 'none')
      if (document.body) {
        if (!cfg.showSidebar) document.body.classList.add('sidebar-narrow')
        else document.body.classList.remove('sidebar-narrow')
      }
    }
    if (cfg.showWorkPanel != null) {
      root.style.setProperty('--work-panel-display', cfg.showWorkPanel ? 'flex' : 'none')
    }
    // Оболочка Ultra выбирается ЗНАЧЕНИЕМ versionPreset, а панели гасятся
    // теми же переменными, что ставятся выше: значит перестраивать её надо
    // после них, иначе значение окна победило бы оболочку.
    syncUltraShell()
    // Видимость панели «Работа» могла измениться вместе с настройкой: пересчитать место под неё.
    try { refreshTasksPanel() } catch { /* до первой отрисовки панели нет */ }
  }

  // ─── Оболочка Ultra ───────────────────────────────────────────
  // Экран выбирает ЗНАЧЕНИЕ versionPreset из конфигурации интерфейса: своего
  // выключателя нет, а боковая панель и панель «Работа» прячутся теми двумя
  // переменными, что уже ставит applyUiConfig. Модуль рисует вход, пустую
  // сессию и полосу одного чата; список диалогов, «когда», приветствие, выбор
  // диалога и отправку он получает этой же проводкой — вторых копий нет.
  let ultraShellInstance = null
  // Меню папок живёт внутри setupEventListeners; оболочка Ultra зовёт его через эту ссылку.
  let ultraOpenFolderMenu = null

  function ultraShell() {
    if (!ultraShellInstance) {
      ultraShellInstance = OnlyoneUltraShell.create({
        document,
        window,
        t,
        escapeHtml,
        host: $('ultraHost'),
        // Чужие узлы оболочка только читает: по счётчику задач центра окна она
        // ставит признак на корень, а стиль решает, показывать ли «Задачи».
        $,
        chats: () => conversations,
        timeOf: chat => formatRelativeTime(chat.updatedAt),
        greeting: () => greetingText(),
        titleOf: id => (conversations.find(chat => chat.id === id) || {}).title || '',
        selectChat: id => selectChat(activePane || panes[0], id),
        newChat: () => createNewChat(activePane || panes[0]),
        send: text => sendFromUltra(text),
        // Папка и модель до первого слова: те же действия, что у обычной строки
        // ввода — меню папок и каталог моделей; подписи читаются из окна.
        openFolders: (x, y) => { if (ultraOpenFolderMenu) ultraOpenFolderMenu(x, y) },
        openModels: anchor => modelPopoverInstance?.openModels(anchor),
        folderLabel: () => ultraFolderLabel(),
        modelLabel: () => cleanModelName(selectedModel?.name) || '',
        openSettings: () => $('openSettingsBtn')?.click(),
        // Свободные блоки результата: список — те же
        // артефакты открытого диалога, что видит ряд под шапкой; открытие — тот
        // же `showArtifact` панели, второй путь к результату не заводим.
        blocks: typeof OnlyoneUltraBlocks === 'object' ? OnlyoneUltraBlocks : null,
        // В Ultra «Задачи» — свободный блок того
        // же слоя, что результаты. Телом отдаётся существующий экран окна
        // (`#taskCenterView`), второго центра задач не заводим; экран на
        // пол-окна при этом не открывается никогда.
        tasksBody: () => el.taskCenterView || null,
        // Первый блок садится под кнопкой окна; после того как человек её
        // передвинул, сохранённое место важнее.
        tasksAnchor: () => el.navTasks?.getBoundingClientRect?.() || null,
        // Пока блок открыт, на `<body>` висит `ultra-tasks-block` — по нему
        // экран центра задач принимает компактный вид внутри блока. Отдельного
        // класса для этого нет: `task-center-open` значит «экран на пол-окна»,
        // а он в Ultra не открывается.
        tasksShown: () => {
          document.body.classList.add('ultra-tasks-block')
          taskCenter().refresh()
        },
        tasksHidden: () => { document.body.classList.remove('ultra-tasks-block') },
        // Чистые модули журнала не ведут: отказ списка артефактов обязан быть
        // слышен от окна, а не пропадать в `catch`.
        resultsFailed: error => console.error('Ultra: список результатов не пришёл', error),
        // Полоса, которую свободный блок не имеет права закрывать: форма
        // строки ввода. Модуль просит её как меру и сам решает, куда
        // отпустить блок, чтобы поле и кнопка оставались на виду.
        composerRect: () => el.composerForm?.getBoundingClientRect?.() || null,
        // Оболочка читает сохранённое один раз при сборке слоя и пишет,
        // когда человек переставил блок. Отказ записи слышен: молчаливый
        // `catch` уже спрятал подмену синхронного `fs` обещательным.
        loadLayout: () => electronAPI.getUltraLayout?.(),
        saveLayout: map => Promise.resolve(electronAPI.setUltraLayout?.(map))
          .then(res => { if (res && res.ok === false) console.error('Ultra: место блоков не сохранено', res.error) })
          .catch(error => console.error('Ultra: сохранение места блоков не удалось', error)),

        // ─── Workspace Ultra ──────────────────────────────────────────────
        // Оболочка ничего не знает о том, как собирается Workspace: блоки и их
        // раскладка — её, а состав Workspace (агенты, инструменты, файлы,
        // контекст) — окна. Раскладку оболочка отдаёт сама, окно добавляет своё.
        //
        // НЕ ПУТАТЬ с `workspace` главного процесса: там рабочая ПАПКА проекта.
        // Здесь то, что человек крафтит в Ultra, и чем он делится.
        // Раскладку и её приём оболочка отдаёт сама (см. `ultra-workspace.js`),
        // поэтому в проводке она не нужна — модуль берёт оболочку целиком.
        // Человек нажал «выгрузить» или «открыть».
        onWorkspace: kind => ultraWorkspace().run(kind),
        results: async () => {
          const chatId = activePane?.chatId || panes[0]?.chatId || ''
          const listed = await electronAPI.getArtifacts(chatId)
          const items = (listed?.artifacts || []).map(item => ({ ...item }))
          if (ultraTasksOpen) {
            const shellNode = $('taskCenterView')?.querySelector('.task-center-shell')
            if (shellNode) {
              items.push({
                id: 'tasks',
                kind: 'tasks',
                title: t('Задачи'),
                element: shellNode
              })
            }
          }
          return items
        },
        openResult: item => artifactPanel().showArtifact(item),
        onCloseTasks: () => setUltraTasks(false)
      })
    }
    return ultraShellInstance
  }

  let ultraTasksOpen = false

  function isUltraPreset() {
    return document.documentElement.dataset.versionPreset === 'ultra'
  }

  function restoreTaskCenterShell() {
    const page = $('taskCenterView')?.querySelector('.task-center-page')
    const shellNode = document.querySelector('.ublock-tasks-body .task-center-shell') || $('taskCenterView')?.querySelector('.task-center-shell')
    if (page && shellNode && shellNode.parentElement !== page) page.appendChild(shellNode)
  }

  function setUltraTasks(open) {
    ultraTasksOpen = Boolean(open)
    el.navTasks?.classList.toggle('active', ultraTasksOpen)
    el.navTasks?.setAttribute('aria-expanded', String(ultraTasksOpen))
    if (!ultraTasksOpen) restoreTaskCenterShell()
    else taskCenter().refresh()
    if (ultraShellInstance && typeof ultraShellInstance.refresh === 'function') ultraShellInstance.refresh()
  }

  function toggleUltraTasks() { setUltraTasks(!ultraTasksOpen) }

  function ultraFolderLabel() {
    const pane = activePane || panes[0], chat = pane ? chatOf(pane) : null
    const all = [...globalFolders(), ...chatFoldersOf(chat)].filter(Boolean)
    if (!all.length) return t('Без папки')
    const name = String(all[0]).split(/[\/]/).filter(Boolean).pop() || String(all[0])
    return all.length > 1 ? name + ' +' + (all.length - 1) : name
  }

  let ultraWorkspaceInstance = null
  function ultraWorkspace () {
    if (!ultraWorkspaceInstance) {
      ultraWorkspaceInstance = OnlyoneUltraWorkspace.create({
        t, toast: (text, isErr) => showToast(text, isErr), electronAPI, shell: () => ultraShellInstance,
        lastAssistantRecord: () => {
          const pane = activePane || panes[0], chat = conversations.find(c => c.id === (pane && pane.chatId))
          return [...((chat && chat.messages) || [])].reverse().find(m => m && m.role === 'assistant') || null
        },
        onError: err => console.error('Ultra: действие с Workspace не выполнено', err)
      })
    }
    return ultraWorkspaceInstance
  }
  function syncUltraShell() {
    if (!currentUiConfig || !$('ultraHost')) return
    ultraShell().update(currentUiConfig)
  }

  // Событие панели артефактов обновляет и свободные блоки Ultra: экземпляр
  // оболочки создаётся только пресетом, поэтому здесь мы его не заводим.
  electronAPI.onArtifactChanged?.(() => {
    if (ultraShellInstance && typeof ultraShellInstance.refresh === 'function') ultraShellInstance.refresh()
  })

  // Строка ввода Ultra отдаёт текст тем же путём, что обычная отправка окна:
  // то же поле, та же форма, те же вложения и очередь.
  function sendFromUltra(text) {
    const area = $('composerTextarea')
    const form = $('composerForm')
    if (!area || !form) return
    const value = String(text || '')
    setActivePane(panes[0])
    area.value = value
    autoResizeTextarea(activePane || panes[0])
    if (typeof form.requestSubmit === 'function') form.requestSubmit()
    else handleSendMessage(panes[0], value)
  }
  async function setupUiConfig() {
    try {
      const cfg = await window.electronAPI?.getUiConfig?.()
      if (cfg) applyUiConfig(cfg)
    } catch (error) {
      console.warn('[ui-config] настройки интерфейса не прочитаны:', error?.message || error)
    }

    window.electronAPI?.onUiConfigChanged?.(cfg => {
      if (cfg) applyUiConfig(cfg)
    })

    document.addEventListener('click', async event => {
      const tryBtn = event.target.closest('.btn-ui-try')
      const revertBtn = event.target.closest('.btn-ui-revert')
      const keepBtn = event.target.closest('.btn-ui-keep')
      const undoBtn = event.target.closest('.btn-ui-undo')

      if (tryBtn) {
        event.preventDefault()
        const card = tryBtn.closest('.prop')
        const propId = tryBtn.dataset.propId || card?.dataset.propId || 'prop'
        let patch = {}
        try { patch = JSON.parse(card?.dataset.propPatch || '{}') } catch (error) {
          // Битое предложение не примеряем как пустое — говорим, что с ним не так.
          console.warn('[ui-config] предложение не разобрано:', error?.message || error)
          showToast(t('Изменение интерфейса повреждено — примерить нельзя'))
          return
        }
        const label = card?.querySelector('span')?.textContent || t('Изменение интерфейса')

        const prev = currentUiConfig ? { ...currentUiConfig } : await window.electronAPI?.getUiConfig?.()
        activeUiProposal = { id: propId, label, patch, previousConfig: prev, card }

        applyUiConfig(patch)

        if (patch.sidebarWidth != null || patch.showSidebar != null) {
          document.querySelector('.sidebar')?.classList.add('trying')
        }
        if (patch.workPanelWidth != null || patch.showWorkPanel != null) {
          document.querySelector('.tasks-panel')?.classList.add('trying')
        }
        if (patch.codeFontSize != null) {
          document.querySelectorAll('.code-block pre, .msg-content pre code').forEach(el => el.classList.add('trying'))
        }
        if (!patch.sidebarWidth && !patch.workPanelWidth && !patch.codeFontSize) {
          document.querySelector('.app-body')?.classList.add('trying')
        }

        let tryBarEl = document.getElementById('uiTryBar')
        if (!tryBarEl) {
          tryBarEl = document.createElement('div')
          tryBarEl.id = 'uiTryBar'
          document.body.appendChild(tryBarEl)
        }
        if (window.uiConfigView) {
          tryBarEl.innerHTML = window.uiConfigView.renderTryBar({ id: propId, label, t })
        }
        tryBarEl.hidden = false

        if (card && window.uiConfigView) {
          const trHtml = window.uiConfigView.renderTryingLine({ id: propId, t })
          const temp = document.createElement('div')
          temp.innerHTML = trHtml
          const trEl = temp.firstElementChild
          if (trEl) {
            trEl.dataset.savedPatch = JSON.stringify(patch)
            trEl.dataset.savedLabel = label
            card.replaceWith(trEl)
            activeUiProposal.currentEl = trEl
          }
        }
        return
      }

      if (revertBtn) {
        event.preventDefault()
        if (!activeUiProposal) return
        if (activeUiProposal.previousConfig) {
          applyUiConfig(activeUiProposal.previousConfig)
        }
        document.querySelectorAll('.trying').forEach(el => el.classList.remove('trying'))
        document.getElementById('uiTryBar')?.remove()

        if (activeUiProposal.currentEl && window.uiConfigView) {
          const propHtml = window.uiConfigView.renderProposalCard({
            id: activeUiProposal.id,
            label: activeUiProposal.label,
            patch: activeUiProposal.patch,
            t
          })
          const temp = document.createElement('div')
          temp.innerHTML = propHtml
          activeUiProposal.currentEl.replaceWith(temp.firstElementChild)
        }
        activeUiProposal = null
        return
      }

      if (keepBtn) {
        event.preventDefault()
        if (!activeUiProposal) return
        await window.electronAPI?.setUiConfig?.(activeUiProposal.patch)
        document.querySelectorAll('.trying').forEach(el => el.classList.remove('trying'))
        document.getElementById('uiTryBar')?.remove()

        if (activeUiProposal.currentEl && window.uiConfigView) {
          const appliedHtml = window.uiConfigView.renderAppliedLine({
            id: activeUiProposal.id,
            label: activeUiProposal.label,
            t
          })
          const temp = document.createElement('div')
          temp.innerHTML = appliedHtml
          const appliedEl = temp.firstElementChild
          if (appliedEl) {
            appliedEl.dataset.savedPatch = JSON.stringify(activeUiProposal.patch)
            appliedEl.dataset.savedLabel = activeUiProposal.label
            appliedEl.dataset.savedPrev = JSON.stringify(activeUiProposal.previousConfig || {})
            activeUiProposal.currentEl.replaceWith(appliedEl)
          }
        }
        showToast(t('Применено'))
        activeUiProposal = null
        return
      }

      if (undoBtn) {
        event.preventDefault()
        const appliedEl = undoBtn.closest('.appliedline')
        const propId = undoBtn.dataset.propId || appliedEl?.dataset.propId || 'prop'
        let prev = {}
        let patch = {}
        let label = appliedEl?.querySelector('span')?.textContent || t('Изменение интерфейса')
        try {
          if (appliedEl?.dataset.savedPrev) prev = JSON.parse(appliedEl.dataset.savedPrev)
          if (appliedEl?.dataset.savedPatch) patch = JSON.parse(appliedEl.dataset.savedPatch)
          if (appliedEl?.dataset.savedLabel) label = appliedEl.dataset.savedLabel
        } catch (error) {
          console.warn('[ui-config] прежнее состояние для отката не разобрано:', error?.message || error)
        }

        if (Object.keys(prev).length) {
          await window.electronAPI?.setUiConfig?.(prev)
          applyUiConfig(prev)
        } else {
          await window.electronAPI?.resetUiConfig?.()
          const def = await window.electronAPI?.getUiConfig?.()
          if (def) applyUiConfig(def)
        }

        if (appliedEl && window.uiConfigView) {
          const propHtml = window.uiConfigView.renderProposalCard({
            id: propId,
            label,
            patch,
            t
          })
          const temp = document.createElement('div')
          temp.innerHTML = propHtml
          appliedEl.replaceWith(temp.firstElementChild)
        }
        showToast(t('Откатить'))
        return
      }
    })
  }

  // Горячие клавиши: четыре действия меняются нажатием и помнятся.
  // Enter, Shift+Enter, «/» и Esc — это набор текста, их не переназначают.
  const SHORTCUTS_KEY = '1code_shortcuts'
  const SHORTCUT_ACTIONS = [
    { id: 'newChat', label: 'Новый диалог', key: 'Ctrl+N', run: () => el.newChatBtn?.click() },
    { id: 'models', label: 'Каталог моделей', key: 'Ctrl+M', run: () => modelPopoverInstance?.openModels() },
    { id: 'settings', label: 'Настройки', key: 'Ctrl+,', run: () => openModal(el.settingsModal) },
    { id: 'attach', label: 'Прикрепить файлы', key: 'Ctrl+U', run: () => pickAttachments(activePane || panes[0]) }
  ]
  const SHORTCUTS_FIXED = [['Отправить', 'Enter'], ['Перенос строки', 'Shift+Enter'], ['Меню команд', '/'], ['Закрыть', 'Esc']]
  // Отдать такое сочетание действию — сломать копирование, правку текста или окно.
  const SHORTCUTS_RESERVED = ['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z',
    'Ctrl+S', 'Ctrl+F', 'Ctrl+W', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+Shift+I', 'Alt+F4', 'F5', 'F11', 'F12']
  const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']
  let shortcutOverrides = {}
  let recordingShortcut = null
  let renderingShortcuts = false

  function shortcutOf(id) {
    const action = SHORTCUT_ACTIONS.find(item => item.id === id)
    return shortcutOverrides[id] || action?.key || ''
  }

  // «Ctrl+Shift+K» из нажатия. Клавиша берётся по месту (event.code), а не по
  // символу: на русской раскладке Ctrl+N приходит как «т», и сочетания,
  // сравнивавшие символ, не срабатывали. Без Ctrl или Alt и не F-клавиша — null:
  // такое сочетание мешало бы печатать.
  function comboOf(event) {
    if (MODIFIER_KEYS.includes(event.key)) return null
    const code = event.code || ''
    const fn = /^F([1-9]|1[0-2])$/.test(event.key)
    if (!(event.ctrlKey || event.metaKey || event.altKey || fn)) return null
    const parts = []
    if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')
    const NAMED = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '-', Equal: '=', Space: 'Space' }
    let name = event.key.length === 1 ? event.key.toUpperCase() : event.key
    if (/^Key[A-Z]$/.test(code)) name = code.slice(3)
    else if (/^Digit\d$/.test(code)) name = code.slice(5)
    else if (NAMED[code]) name = NAMED[code]
    parts.push(name)
    return parts.join('+')
  }

  function setShortcutNote(text, isError = false) {
    const note = $('shortcutsNote')
    if (!note) return
    note.textContent = text
    note.classList.toggle('error', isError)
  }

  function saveShortcuts() {
    writePref(SHORTCUTS_KEY, JSON.stringify(shortcutOverrides))
    refreshShortcutHints()
    renderShortcuts()
  }

  // Подсказки у кнопок называют текущее сочетание, а не то, что было в разметке.
  function refreshShortcutHints() {
    for (const [elementId, id] of [['newChatBtn', 'newChat'], ['openSettingsBtn', 'settings'], ['attachBtn', 'attach'], ['modelEffortPillBtn', 'models']]) {
      const node = $(elementId)
      if (!node?.dataset.tooltip) continue
      node.dataset.tooltip = node.dataset.tooltip.replace(/\((?:Ctrl|Alt|Shift|F\d)[^)]*\)$/, `(${shortcutOf(id)})`)
    }
  }

  function renderShortcuts() {
    const host = $('shortcutsGrid')
    if (!host) return
    const caps = combo => combo.split('+').map(key => `<kbd>${escapeHtml(key)}</kbd>`).join('')
    // Две группы того же вида, что и в «Персонализации»: сочетания, которые
    // меняются нажатием, и сочетания набора текста — они неизменны.
    const actions = SHORTCUT_ACTIONS.map(action => {
      const label = t(action.label)
      const recording = recordingShortcut === action.id
      const reset = shortcutOverrides[action.id]
        ? `<button type="button" class="shortcut-reset" data-reset="${action.id}" aria-label="${escapeHtml(t('Вернуть'))} ${escapeHtml(action.key)}" data-tooltip="${escapeHtml(t('Вернуть'))} ${escapeHtml(action.key)}"><svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.4 3.4L2.6 6.2 5.4 9M2.6 6.2h6.6a3.6 3.6 0 0 1 0 7.2H6.4"/></svg></button>`
        : ''
      return `<div class="setting-row shortcut-row${recording ? ' recording' : ''}">
          <span class="row-label"><span class="row-title shortcut-label">${escapeHtml(label)}</span></span>
          <span class="shortcut-actions">${reset}<button type="button" class="shortcut-keys shortcut-edit" data-edit="${action.id}"
            aria-label="${escapeHtml(label)}: ${escapeHtml(shortcutOf(action.id))}. ${escapeHtml(t('Нажмите, чтобы изменить'))}">${recording
              ? `<span class="shortcut-wait">${escapeHtml(t('Нажмите сочетание…'))}</span>`
              : caps(shortcutOf(action.id))}</button></span>
        </div>`
    }).join('')
    const fixed = SHORTCUTS_FIXED.map(([label, combo]) =>
      `<div class="setting-row shortcut-row fixed"><span class="row-label"><span class="row-title shortcut-label">${escapeHtml(t(label))}</span></span><span class="shortcut-keys">${caps(combo)}</span></div>`).join('')
    // Перерисовка убирает кнопку, на которой стоит фокус, и Chromium (когда
    // окно в фокусе системы) отвечает на это focusout — запись нового сочетания
    // отменялась в тот же миг, как начиналась. Своя перерисовка уходом с кнопки
    // не считается.
    renderingShortcuts = true
    try {
      host.innerHTML = buildShortcutGroups(actions, fixed)
    } finally {
      renderingShortcuts = false
    }
    const resetAll = $('shortcutsResetAll')
    if (resetAll) resetAll.hidden = !Object.keys(shortcutOverrides).length
  }

  function buildShortcutGroups(actions, fixed) {
    return `
      <div class="settings-group">
        <div class="settings-group-title">${escapeHtml(t('Действия'))}</div>
        <p class="settings-group-hint">${escapeHtml(t('Нажмите на сочетание и затем новые клавиши.'))}</p>
        ${actions}
      </div>
      <div class="settings-group">
        <div class="settings-group-title">${escapeHtml(t('Набор текста'))}</div>
        ${fixed}
      </div>`
  }

  function setupShortcuts() {
    try { shortcutOverrides = JSON.parse(readPref(SHORTCUTS_KEY) || '{}') || {} } catch { shortcutOverrides = {} }
    const host = $('shortcutsGrid')
    renderShortcuts()
    refreshShortcutHints()
    host?.addEventListener('click', event => {
      const reset = event.target.closest('[data-reset]')
      const edit = event.target.closest('[data-edit]')
      if (reset) {
        delete shortcutOverrides[reset.dataset.reset]
        setShortcutNote('')
        saveShortcuts()
      } else if (edit) {
        recordingShortcut = recordingShortcut === edit.dataset.edit ? null : edit.dataset.edit
        setShortcutNote('')
        renderShortcuts()
        host.querySelector(`[data-edit="${recordingShortcut}"]`)?.focus()
      }
    })
    // Ушли с кнопки, не нажав сочетание, — запись отменяется: иначе следующее
    // нажатие где-то ещё стало бы новым сочетанием.
    host?.addEventListener('focusout', event => {
      if (renderingShortcuts || !recordingShortcut || host.contains(event.relatedTarget)) return
      // Решаем после того, как фокус встанет на место: перерисовка сама
      // возвращает его на кнопку записи, и тогда уходить некуда.
      setTimeout(() => {
        if (!recordingShortcut || host.contains(document.activeElement)) return
        recordingShortcut = null
        renderShortcuts()
      }, 0)
    })
    $('shortcutsResetAll')?.addEventListener('click', () => {
      shortcutOverrides = {}
      setShortcutNote(t('Сочетания как по умолчанию'))
      saveShortcuts()
    })
  }

  // Запись нового сочетания. Вызывается из общего обработчика клавиш первой.
  function captureShortcut(event) {
    if (!recordingShortcut) return false
    const modal = el.settingsModal
    if (!modal || getComputedStyle(modal).display === 'none') {
      recordingShortcut = null
      return false
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      recordingShortcut = null
      setShortcutNote('')
      renderShortcuts()
      return true
    }
    if (MODIFIER_KEYS.includes(event.key)) return true
    const combo = comboOf(event)
    if (!combo) {
      setShortcutNote(t('Нужна клавиша вместе с Ctrl или Alt — иначе она мешала бы печатать'), true)
      return true
    }
    const action = SHORTCUT_ACTIONS.find(item => item.id === recordingShortcut)
    const taken = SHORTCUT_ACTIONS.find(item => item.id !== action.id && shortcutOf(item.id) === combo)
    if (taken) {
      setShortcutNote(`${combo} ${t('уже занято')}: «${t(taken.label)}»`, true)
      return true
    }
    if (SHORTCUTS_RESERVED.includes(combo)) {
      setShortcutNote(`${combo} — ${t('системное сочетание, его не занимаем')}`, true)
      return true
    }
    if (combo === action.key) delete shortcutOverrides[action.id]
    else shortcutOverrides[action.id] = combo
    recordingShortcut = null
    setShortcutNote(`«${t(action.label)}» — ${combo}`)
    saveShortcuts()
    return true
  }

  // Настройка окна в localStorage — удобство, а не данные: недоступное
  // хранилище значит «как по умолчанию», а не ошибку.
  function readPref(key) {
    try { return localStorage.getItem(key) } catch { return null }
  }
  function writePref(key, value) {
    try { localStorage.setItem(key, value); return true } catch { return false }
  }

  function setupSidebarResizer() {
    const bar = $('sidebarResizer')
    const sidebar = document.querySelector('.sidebar')
    if (!bar || !sidebar) return
    applySidebarPixels(Number(readPref(SIDEBAR_WIDTH_KEY)) || SIDEBAR_DEFAULT)
    const save = width => writePref(SIDEBAR_WIDTH_KEY, String(width))
    // Колонка справа поменяла ширину: вписанный макет и второй чат — заново.
    const settle = () => {
      if (typeof fitDesignPreview === 'function') fitDesignPreview()
      if (el.splitPane && !el.splitPane.hidden) applySplitWidth(loadSplitWidth())
    }

    let dragging = false
    const onMove = event => {
      if (!dragging) return
      event.preventDefault()
      const x = event.clientX - sidebar.getBoundingClientRect().left
      const narrow = document.body.classList.contains('sidebar-narrow')
      if (x < SIDEBAR_SNAP) {
        if (!narrow) setSidebarNarrow(true)
        return
      }
      if (narrow) setSidebarNarrow(false)
      applySidebarPixels(x)
    }
    const stop = () => {
      if (!dragging) return
      dragging = false
      document.body.classList.remove('resizing-sidebar')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      if (!document.body.classList.contains('sidebar-narrow')) save(sidebarPixels())
      settle()
    }
    bar.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      dragging = true
      document.body.classList.add('resizing-sidebar')
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', stop)
      event.preventDefault()
    })

    // С клавиатуры: стрелки меняют ширину; из свёрнутой панели стрелка вправо
    // её разворачивает.
    bar.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const narrow = document.body.classList.contains('sidebar-narrow')
      if (narrow) {
        if (event.key === 'ArrowRight') { setSidebarNarrow(false); settle() }
        return
      }
      const step = event.shiftKey ? 40 : 16
      save(applySidebarPixels(sidebarPixels() + (event.key === 'ArrowRight' ? step : -step)))
      settle()
    })

    bar.addEventListener('dblclick', () => {
      setSidebarNarrow(false)
      save(applySidebarPixels(SIDEBAR_DEFAULT))
      settle()
    })
  }

  function switchTab(tab) {
    if (el.settingsModal && el.settingsModal.style.display !== 'none') closeModal(el.settingsModal)
    if (isUltraPreset()) {
      if (tab === 'tasks') {
        toggleUltraTasks()
        return
      }
      if (ultraTasksOpen && tab !== 'chats') {
        setUltraTasks(false)
      }
    }
    // The task index shares the workspace with the chat. A second chat and
    // Tasks use the same right-hand slot, never a three-column squeeze.
    if (tab === 'tasks' && el.splitPane && !el.splitPane.hidden) toggleSplitView(false)
    document.body.classList.toggle('task-center-open', tab === 'tasks')
    el.navChats?.classList.toggle('active', tab === 'chats' || tab === 'tasks')
    el.navTasks?.classList.toggle('active', tab === 'tasks')
    el.navTasks?.setAttribute('aria-expanded', String(tab === 'tasks'))
    el.navProjects?.classList.toggle('active', tab === 'projects')
    el.navSkills?.classList.toggle('active', tab === 'skills')
    el.navDesign?.classList.toggle('active', tab === 'design')
    el.navConnectors?.classList.toggle('active', tab === 'connectors')
    el.navPlugins?.classList.toggle('active', tab === 'plugins')

    el.chatView?.classList.toggle('active', tab === 'chats' || tab === 'tasks')
    el.taskCenterView?.classList.toggle('active', tab === 'tasks')
    el.projectsView?.classList.toggle('active', tab === 'projects')
    el.skillsView?.classList.toggle('active', tab === 'skills')
    el.designView?.classList.toggle('active', tab === 'design')
    el.connectorsView?.classList.toggle('active', tab === 'connectors')
    el.pluginsView?.classList.toggle('active', tab === 'plugins')
    renderChatHistory()
    // Панель работы принадлежит чату: уходя в другой раздел, она уходит с экрана.
    refreshTasksPanel()

    if (tab === 'skills') refreshSkills()
    if (tab === 'connectors') refreshMcp()
    if (tab === 'plugins') refreshPlugins()
    if (tab === 'projects') refreshProjectsPage()
    if (tab === 'design') refreshDesignPage()
    // Центр задач при входе перечитывает прерванные ходы, при уходе гасит свои
    // часы: без этого он тикает и перечитывает историю, когда его не видно.
    if (tab === 'tasks') taskCenter().refresh()
    else taskCenter().stop()

    if (tab !== 'chats' && tab !== 'design') {
      $('tasksPanel')?.remove()
      document.body.classList.remove('tasks-open')
    } else {
      refreshTasksPanel()
    }

    // A row is highlighted because that chat is in front of you. Leaving for
    // Design or Skills does not close it, but you are no longer in it — and the
    // row went on claiming you were, because the tree is rebuilt only when the
    // history changes and switching tabs is not a history change.
    renderChatHistory()
  }

  // An untouched chat is not history, it is a blank the user walked away from.
  // Pressing «Новый диалог» twice, or switching away without typing, used to
  // leave one behind every time.
  function dropEmptyChats(exceptId, leavingPane) {
    const before = conversations.length
    const keep = new Set(panes.filter(p => p !== leavingPane).map(p => p.chatId).filter(Boolean))
    conversations = conversations.filter(chat =>
      chat.id === exceptId ||
      (chat.messages && chat.messages.length) ||
      keep.has(chat.id)
    )
    if (conversations.length !== before) saveConversations()
    return before - conversations.length
  }

  // Свап панелей меняет чаты местами вместе со всем состоянием хода: живые поля,
  // задачи, очередь и карты per-chat. DOM панели остаётся при ней — переезжает
  // именно чат, поэтому ход не остаётся «генерирующим» на чужом чате (break-2 Н1).
  function swapPaneChatState(a, b) {
    const fields = ['generating', 'preparing', 'requestId', 'liveChatId', 'assistantEl',
      'contentBuffer', 'streamQueue', 'smoothCursor', 'reasoningBuffer', 'reasoningSegments',
      'blocks', 'paintedBlocks', 'fileChanges', 'actualModelId', 'totalTokens', 'tokenTally',
      'contextTokens', 'answerStarted', 'markPhase', 'agentTasks', 'board', 'planByAgent',
      'tasksOpen', 'queuedMessage', 'liveTurnsByChat', 'tasksByChat', 'queuedByChat']
    for (const key of fields) { const tmp = a[key]; a[key] = b[key]; b[key] = tmp }
    const tmpChat = a.chatId; a.chatId = b.chatId; b.chatId = tmpChat
  }

  function selectChat(pane, chatId) {
    // Clean up whatever blank was left behind before moving on — but never the
    // one being opened, and never one another pane is showing.
    dropEmptyChats(chatId, pane)

    // Chats are reachable from every page, so choosing one has to take you to
    // it — otherwise the click did nothing visible and you had to go via
    // «Диалоги» first.
    if (!document.body.classList.contains('task-center-open')) switchTab('chats')
    // Ряд артефактов этого диалога — сразу под шапкой: результат должен
    // открываться и после того, как ход модели закончился.
    if (typeof refreshArtifactChips === 'function') refreshArtifactChips(chatId)

    // One conversation must not be open in both panes: each would stream into it
    // and each would overwrite the other's render. Give the other pane what this
    // one was showing — a swap, which is what moving a chat across should do.
    const other = panes.find(p => p !== pane && p.chatId === chatId)
    if (other) {
      cancelNextSuggestion(other.chatId)
      cancelNextSuggestion(pane.chatId)
      // Свап переносит ход вместе с чатом: иначе боковая панель остаётся
      // «генерирующей» на чужом чате, а принятая не показывает живой ход (Н1).
      swapPaneChatState(pane, other)
      renderMessages(other)
      if (other === panes[1]) splitChatId = other.chatId
      if (pane === panes[1]) splitChatId = pane.chatId
    }

    // Задачи принадлежат ходу, а ход — чату. Сохраняем состояние задач и живого хода
    // уходящего чата в кэш, чтобы при возвращении восстановить их, а для
    // нового открытого чата показываем его собственные задачи и актуальное состояние.
    if (pane.chatId !== chatId) {
      cancelNextSuggestion(pane.chatId)
      pane.queuedByChat = pane.queuedByChat || new Map()
      if (pane.chatId) {
        pane.queuedByChat.set(pane.chatId, pane.queuedMessage || '')
        pane.tasksByChat = pane.tasksByChat || new Map()
        pane.tasksByChat.set(pane.chatId, {
          agentTasks: pane.agentTasks || new Map(),
          board: pane.board || null,
          planByAgent: pane.planByAgent || null,
          tasksOpen: Boolean(pane.tasksOpen)
        })
        if (pane.liveTurnsByChat && pane.chatId && pane.liveTurnsByChat.has(pane.chatId)) {
          if (!pane.generating) {
            pane.liveTurnsByChat.delete(pane.chatId)
          } else {
            const turn = pane.liveTurnsByChat.get(pane.chatId)
            turn.generating = Boolean(pane.generating)
            turn.preparing = Boolean(pane.preparing)
            turn.requestId = pane.requestId
            turn.liveChatId = pane.liveChatId
            turn.assistantEl = pane.assistantEl
            turn.contentBuffer = pane.contentBuffer || ''
            turn.streamQueue = pane.streamQueue || ''; turn.smoothCursor = pane.smoothCursor || 0
            turn.reasoningBuffer = pane.reasoningBuffer || ''
            turn.reasoningSegments = pane.reasoningSegments || []
            turn.blocks = pane.blocks || []
            turn.paintedBlocks = pane.paintedBlocks || []
            turn.fileChanges = pane.fileChanges || []
            turn.actualModelId = pane.actualModelId || null
            turn.totalTokens = pane.totalTokens || 0; turn.tokenTally = pane.tokenTally
            turn.contextTokens = pane.contextTokens || 0
            turn.answerStarted = Boolean(pane.answerStarted)
            turn.markPhase = pane.markPhase || ''
          }
        }
      }
      pane.tasksByChat = pane.tasksByChat || new Map()
      const saved = pane.tasksByChat.get(chatId)
      if (saved) {
        pane.agentTasks = saved.agentTasks
        pane.board = saved.board
        pane.planByAgent = saved.planByAgent
        pane.tasksOpen = saved.tasksOpen
      } else {
        clearAgentTasks(pane)
        pane.board = null
        pane.planByAgent = null
        pane.tasksOpen = false
      }
      pane.queuedMessage = pane.queuedByChat.get(chatId) || ''
      if (typeof renderQueuedNotice === 'function') renderQueuedNotice(pane)

      if (pane.liveTurnsByChat) {
        const liveTurn = pane.liveTurnsByChat.get(chatId)
        if (liveTurn && liveTurn.generating) {
          pane.generating = true
          pane.preparing = Boolean(liveTurn.preparing)
          pane.requestId = liveTurn.requestId
          pane.liveChatId = liveTurn.liveChatId
          pane.assistantEl = liveTurn.assistantEl
          pane.contentBuffer = liveTurn.contentBuffer || ''
          pane.streamQueue = liveTurn.streamQueue || ''; pane.smoothCursor = liveTurn.smoothCursor || 0
          pane.reasoningBuffer = liveTurn.reasoningBuffer || ''
          pane.reasoningSegments = liveTurn.reasoningSegments || []
          pane.blocks = liveTurn.blocks || []
          pane.paintedBlocks = liveTurn.paintedBlocks || []
          pane.fileChanges = liveTurn.fileChanges || []
          pane.actualModelId = liveTurn.actualModelId || null
          pane.totalTokens = liveTurn.totalTokens || 0; pane.tokenTally = liveTurn.tokenTally || null
          pane.contextTokens = liveTurn.contextTokens || 0
          pane.answerStarted = Boolean(liveTurn.answerStarted)
          pane.markPhase = liveTurn.markPhase || ''
        } else {
          pane.generating = false
          pane.preparing = false
          pane.requestId = null
          pane.liveChatId = null
          pane.assistantEl = null
          pane.contentBuffer = ''
          pane.streamQueue = ''; pane.smoothCursor = 0
          pane.reasoningBuffer = ''
          pane.reasoningSegments = []
          pane.blocks = []
          pane.paintedBlocks = []
          pane.fileChanges = []
          pane.actualModelId = null
          pane.totalTokens = 0; pane.tokenTally = null
          pane.contextTokens = 0
          pane.answerStarted = false
          pane.markPhase = ''
        }
      }
    }

    pane.chatId = chatId
    pane.stickToBottom = true
    // Keep the side pane's remembered chat in step, or reopening the split
    // would snap it back to whatever it showed before.
    if (pane === panes[1]) splitChatId = chatId
    renderMessages(pane)
    renderChatHistory()
    if (typeof paintSendButton === 'function') paintSendButton(pane)

    if (!pane.generating && !pane.preparing && pane.queuedMessage && typeof handleSendMessage === 'function') {
      const queued = pane.queuedMessage
      pane.queuedMessage = ''
      pane.queuedByChat?.delete(chatId)
      if (typeof renderQueuedNotice === 'function') renderQueuedNotice(pane)
      handleSendMessage(pane, queued)
    }

    // Refresh the side chooser from the main pane only. Doing it from the side
    // pane calls straight back into here and never returns.
    if (pane === panes[0] && el.splitPane && !el.splitPane.hidden) renderSplitPane()

    // The folder pill counts this chat's own folders, so it follows the chat.
    refreshWorkspace()
    // A newly selected conversation opens at its latest message, even if the
    // previous conversation was scrolled up. Wait for layout before jumping.
    const openedId = chatId
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (pane.chatId === openedId) jumpToBottom(pane, 8, false)
    }))
  }

  function deleteChat(chatId) {
    cancelNextSuggestion(chatId, true)
    conversations = conversations.filter(c => c.id !== chatId)
    saveConversations()

    // Either pane could have been showing it.
    for (const pane of panes) {
      if (pane.chatId !== chatId) continue
      // Ход удалённого чата отменяем: иначе он продолжает тратить токены, а ответ
      // уходит в detached-объект и не сохраняется (break-2 Н2).
      if (pane.requestId && pane.liveChatId === chatId) window.electronAPI?.abortMessage?.(pane.requestId)?.catch?.(() => {})
      const next = conversations[0]?.id || null
      if (next) selectChat(pane, next)
      else if (pane === panes[0]) createNewChat(pane)
      else { pane.chatId = null; pane.generating = false; pane.preparing = false; pane.requestId = null; pane.liveChatId = null; pane.assistantEl = null; renderMessages(pane) }
    }
    renderChatHistory()
    renderProjects()
  }

  function clearActiveChat(pane = activePane || panes[0]) {
    const chat = chatOf(pane)
    if (chat) {
      cancelNextSuggestion(chat.id, true)
      // Очистка обратима: без окна подтверждения, с «Вернуть» 8 с
      const before = chat.messages
      const beforeAt = chat.updatedAt
      chat.messages = []
      chat.updatedAt = Date.now()
      saveConversations()
      renderMessages(pane)
      showToast('Диалог очищен', false, {
        undo: () => {
          if (chat.messages.length) return
          chat.messages = before
          chat.updatedAt = beforeAt
          saveConversations()
          if (pane.chatId === chat.id) renderMessages(pane)
          renderChatHistory()
        }
      })
    }
  }

  // Render Messages in Feed
  // The space above the feed was empty while the only clue to which
  // conversation is open sat in the sidebar. The name goes here too, and
  // renaming happens where you read it.
  function renderChatHeader(pane) {
    const header = $('chatHeader')
    const title = $('chatHeaderTitle')
    const meta = $('chatHeaderMeta')
    if (!header || !title) return

    const chat = chatOf(pane)
    const shown = chat && chat.messages.length
    // Шапка видна и у пустого чата: «Задачи» и «Браузер» нужны до
    // первого сообщения. Название, мету и «Очистить» прячет .is-empty.
    header.hidden = false
    header.classList.toggle('is-empty', !shown)
    paintChatPlace(chat)
    if ($('chatForkBtn')) $('chatForkBtn').hidden = !shown
    if (!shown) {
      title.textContent = ''
      if (meta) meta.innerHTML = ''
      return
    }

    title.innerHTML = formatWithEmoji(escapeHtml(chat.title))
    const forkButton = $('chatForkBtn')
    if (forkButton) forkButton.onclick = event => { if (event.detail < 2) forkChat(chat.id) }
    // The message count answered a question nobody asked; the project is the
    // part worth knowing at a glance.
    if (meta) {
      const project = projects.find(p => p.id === chat.projectId)
      // Имя проекта не повторяет имя папки рядом с ним
      const sameAsFolder = project && folderLeaf(chatPlaceFolder(chat)) === project.name
      meta.innerHTML = project && !sameAsFolder ? formatWithEmoji(escapeHtml(project.name)) : ''
      if (chat.remote === true) {
        meta.insertAdjacentHTML('beforeend', '<button type="button" class="remote-badge" data-tooltip="Чат виден на телефоне. Нажмите, чтобы скрыть" aria-label="Скрыть чат от телефона"><svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.8"/><path d="M7 12h2"/></svg><span>' + escapeHtml(t('Телефон')) + '</span></button>')
        meta.querySelector('.remote-badge')?.addEventListener('click', () => toggleRemoteForChat())
      }
    }
  }

  // Suggestions are model-generated for one exact exchange, stay transient,
  // and are keyed by chat so switching panes can never borrow another hint.
  function cancelNextSuggestion(chatId, discard = false) {
    if (!chatId) return
    const job = nextSuggestionJobsByChat.get(chatId)
    if (job) {
      if (job.timer) clearTimeout(job.timer)
      if (job.started) window.electronAPI?.cancelNextSuggestion?.(job.requestId)?.catch?.(() => {})
      nextSuggestionJobsByChat.delete(chatId)
    }
    if (discard) nextSuggestionsByChat.delete(chatId)
  }

  function requestNextSuggestion(pane, chat, { userText, assistantText, model } = {}) {
    if (!nextSuggestionsEnabled || !chat?.id || pane.chatId !== chat.id || fastMode || pane.dom.textarea?.value.trim()) return
    if (!window.electronAPI?.generateNextSuggestion) return

    const assistant = [...(chat.messages || [])].reverse().find(message => message.role === 'assistant')
    if (!assistant || !assistantText) return
    cancelNextSuggestion(chat.id)

    const requestId = `next_${chat.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const job = { requestId, timer: null, started: false }
    nextSuggestionJobsByChat.set(chat.id, job)
    job.timer = setTimeout(async () => {
      job.timer = null
      if (nextSuggestionJobsByChat.get(chat.id) !== job) return
      if (pane.chatId !== chat.id || pane.generating || pane.dom.textarea?.value.trim() || fastMode) {
        cancelNextSuggestion(chat.id)
        return
      }

      job.started = true
      try {
        const result = await window.electronAPI.generateNextSuggestion({
          requestId,
          userText,
          assistantText,
          model,
          fastMode: false
        })
        if (nextSuggestionJobsByChat.get(chat.id) !== job) return
        nextSuggestionJobsByChat.delete(chat.id)
        const latestChat = conversations.find(item => item.id === chat.id)
        const latestAssistant = [...(latestChat?.messages || [])].reverse().find(message => message.role === 'assistant')
        if (!result?.suggestion || latestAssistant?.timestamp !== assistant.timestamp) return
        nextSuggestionsByChat.set(chat.id, {
          assistantTimestamp: assistant.timestamp,
          text: String(result.suggestion).slice(0, 120)
        })
        if (pane.chatId === chat.id) renderSuggestion(pane)
      } catch {
        if (nextSuggestionJobsByChat.get(chat.id) === job) nextSuggestionJobsByChat.delete(chat.id)
      }
    }, 450)
  }

  function renderSuggestion(pane) {
    const textarea = pane.dom.textarea
    if (!textarea) return

    // Remembered once, so restoring it never depends on what was set last.
    if (textarea.dataset.basePlaceholder === undefined) {
      textarea.dataset.basePlaceholder = textarea.getAttribute('placeholder') || ''
    }

    // Any leftover chips from the previous shape.
    pane.dom.card?.querySelector('.suggest-strip')?.remove()

    const chat = chatOf(pane)
    const lastAssistant = chat && [...chat.messages].reverse().find(message => message.role === 'assistant')
    const saved = chat && nextSuggestionsByChat.get(chat.id)
    const idea = (nextSuggestionsEnabled && !pane.generating && !fastMode && !textarea.value.trim() && saved &&
      saved.assistantTimestamp === lastAssistant?.timestamp) ? saved.text : null

    if (!idea) {
      textarea.placeholder = textarea.dataset.basePlaceholder
      textarea.classList.remove('has-suggestion')
      pane.suggestion = null
      return
    }

    // Shown where the answer would be typed, dimmer than the standing prompt,
    // so it never reads as something the user already wrote.
    textarea.placeholder = idea
    textarea.classList.add('has-suggestion')
    pane.suggestion = idea
  }

  function acceptSuggestion(pane, text) {
    const chat = chatOf(pane)
    if (chat) nextSuggestionsByChat.delete(chat.id)
    pane.dom.textarea.value = text
    autoResizeTextarea(pane)
    renderSuggestion(pane)
    pane.dom.textarea.focus()
  }
  function setupSuggestions() {
    const toggle = $('nextSuggestionToggle')
    if (toggle) {
      toggle.checked = nextSuggestionsEnabled
      toggle.addEventListener('change', () => {
        nextSuggestionsEnabled = toggle.checked
        writePref('1code.next-suggestions-enabled', String(nextSuggestionsEnabled))

        if (!nextSuggestionsEnabled) {
          for (const chatId of [...nextSuggestionJobsByChat.keys()]) cancelNextSuggestion(chatId, true)
          nextSuggestionsByChat.clear()
          for (const pane of panes) renderSuggestion(pane)
          return
        }

        // Re-enabling resumes only from each currently open conversation's
        // latest successful exchange; it never borrows another chat's context.
        for (const pane of panes) {
          if (pane.generating || fastMode || pane.dom.textarea?.value.trim()) continue
          const chat = chatOf(pane)
          const messages = chat?.messages || []
          const assistantIndex = messages.findLastIndex(message => message.role === 'assistant')
          const assistant = assistantIndex >= 0 ? messages[assistantIndex] : null
          const user = assistantIndex > 0
            ? [...messages.slice(0, assistantIndex)].reverse().find(message => message.role === 'user')
            : null
          if (!assistant?.content || assistant.error || assistant.aborted || !user?.content) continue
          requestNextSuggestion(pane, chat, {
            userText: user.content,
            assistantText: assistant.content,
            model: assistant.modelId || selectedModel.id
          })
        }
      })
    }

    for (const pane of panes) {
      // Tab takes the first one, the way a shell completion does. Only when the
      // field is empty, so it never steals an indent from real typing.
      pane.dom.textarea?.addEventListener('keydown', e => {
        if (e.key !== 'Tab' || e.shiftKey) return
        if (pane.dom.textarea.value.trim()) return
        const offered = pane.suggestion
        if (!offered) return
        e.preventDefault()
        acceptSuggestion(pane, offered)
      })

      pane.dom.textarea?.addEventListener('input', () => {
        if (pane.dom.textarea.value.trim()) cancelNextSuggestion(chatOf(pane)?.id)
        renderSuggestion(pane)
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Quoting a selection
  // ---------------------------------------------------------------------------

  let quoteButton = null

  function hideQuoteButton() {
    quoteButton?.remove()
    quoteButton = null
  }

  // Цитата — отдельная плашка над полем ввода, а не строки с «>»
  // в самом поле: те выглядели стрелками, и модель не знала, откуда фрагмент.
  // Обрезается, чтобы целый вставленный ответ не похоронил сам вопрос.
  const QUOTE_MAX = 1200

  function quoteText(selection) {
    const text = String(selection || '').replace(/\s+$/, '').replace(/^\s+/, '')
    if (!text) return ''
    return text.length > QUOTE_MAX ? text.slice(0, QUOTE_MAX).replace(/\s+\S*$/, '') + '…' : text
  }

  // Откуда фрагмент: номер ответа модели или «ваше сообщение».
  function quoteSource(holder, list) {
    if (holder?.classList.contains('user')) return { role: 'user', answer: null }
    const answers = [...(list?.querySelectorAll('.msg-item.assistant') || [])]
    const at = answers.indexOf(holder)
    return { role: 'assistant', answer: at >= 0 ? at + 1 : null }
  }

  function quoteLabel(quote) {
    if (quote.role === 'user') return t('Ваше сообщение')
    return quote.answer ? `${t('Ответ')} ${quote.answer}` : t('Ответ')
  }

  // Что получает модель: явная пометка, на какой фрагмент какого ответа
  // ссылается человек, и отдельно — сам вопрос.
  function quotesForModel(quotes, question) {
    if (!quotes?.length) return question
    const blocks = quotes.map(quote => {
      const where = quote.role === 'user'
        ? 'из своего прошлого сообщения'
        : quote.answer ? `из твоего ответа №${quote.answer} в этом диалоге` : 'из твоего ответа в этом диалоге'
      return `[Пользователь цитирует фрагмент ${where}]\n${quote.text.split('\n').map(line => '> ' + line).join('\n')}\n[Конец цитаты]`
    })
    return `${blocks.join('\n\n')}\n\n${question}`
  }

  function renderQuotes(pane) {
    const attach = pane.dom.attachStrip
    if (!attach) return
    let strip = pane.dom.quoteStrip
    if (!strip) {
      strip = document.createElement('div')
      strip.className = 'quote-strip'
      attach.parentNode.insertBefore(strip, attach)
      pane.dom.quoteStrip = strip
    }
    const quotes = pane.quotes || []
    strip.hidden = !quotes.length
    strip.innerHTML = quotes.map((quote, index) => `
      <div class="quote-chip">
        <div class="quote-chip-body">
          <span class="quote-chip-from">${escapeHtml(quoteLabel(quote))}</span>
          <span class="quote-chip-text">${escapeHtml(quote.text)}</span>
        </div>
        <button type="button" class="quote-chip-remove" data-quote="${index}" aria-label="${escapeHtml(t('Убрать цитату'))}" data-tooltip="${escapeHtml(t('Убрать цитату'))}">
          <svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>
        </button>
      </div>`).join('')
    for (const button of strip.querySelectorAll('[data-quote]')) {
      button.addEventListener('click', () => {
        pane.quotes.splice(Number(button.dataset.quote), 1)
        renderQuotes(pane)
        pane.dom.textarea?.focus()
      })
    }
  }

  function addQuote(pane, quote) {
    if (!quote.text) return
    pane.quotes = pane.quotes || []
    if (pane.quotes.some(item => item.text === quote.text)) return
    pane.quotes.push(quote)
    renderQuotes(pane)
  }

  // Цитата в отправленном сообщении — оформленным блоком над текстом.
  function sentQuotesHtml(msg) {
    if (!Array.isArray(msg.quotes) || !msg.quotes.length) return ''
    return msg.quotes.map(quote => `
      <blockquote class="msg-quote">
        <span class="msg-quote-from">${escapeHtml(quoteLabel(quote))}</span>
        <span class="msg-quote-text">${formatWithEmoji(escapeHtml(quote.text)).replace(/\n/g, '<br>')}</span>
      </blockquote>`).join('')
  }

  function showQuoteButton(rect, text, pane, source = null) {
    hideQuoteButton()

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'quote-btn'
    button.innerHTML = `
      <svg fill="none" class="icon small" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.6h3.4V8H4.4c0 1.7.6 2.6 2 3M9.6 4.6H13V8h-2c0 1.7.6 2.6 2 3"/></svg>
      <span>${escapeHtml(t('Цитировать'))}</span>`

    // Placed after measuring, so it never hangs off the top or the side.
    button.style.visibility = 'hidden'
    document.body.appendChild(button)
    const box = button.getBoundingClientRect()
    button.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 8))}px`
    button.style.top = `${Math.max(8, rect.top - box.height - 8)}px`
    button.style.visibility = ''

    button.addEventListener('mousedown', e => e.preventDefault())
    button.addEventListener('click', () => {
      const target = pane || activePane || panes[0]
      const textarea = target.dom.textarea
      if (!textarea) return

      // Цитаты встают по порядку, в котором их выбрали; поле ввода не трогается.
      addQuote(target, { text: quoteText(text), ...(source || { role: 'assistant', answer: null }) })
      textarea.focus()

      window.getSelection()?.removeAllRanges()
      hideQuoteButton()
    })

    quoteButton = button
  }

  // Долгие задачи окна — в журнал задержек. На практике видно, как
  // окно не отвечает секунд десять, а в лаборатории это не повторилось; журнал
  // поймает момент у него. Что нажимали перед задержкой, описывается по
  // атрибутам элемента — без текста переписки и содержимого полей.
  function describeTarget(node) {
    const el = node?.closest?.('button, a, input, textarea, select, [role], [data-settings-tab], [data-tab], .nav-item, .history-item') || node
    if (!el || el.nodeType !== 1) return 'окно'
    const id = el.id ? `#${el.id}` : ''
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : ''
    const tag = el.tagName.toLowerCase()
    const label = el.getAttribute('aria-label') || el.dataset?.settingsTab || el.dataset?.tab || ''
    return `${tag}${id}${cls}${label ? ` «${label.slice(0, 40)}»` : ''}`
  }

  // Выпадающие списки — свои, из дизайн-системы (1.2), а не окно Windows (1.3).
  // Виджет вынесен в `select-widget.js`: им пользуются и настройки,
  // и панель артефактов, и раздел «Дизайн».
  let selectWidgetInstance = null
  function selectWidget() {
    if (!selectWidgetInstance) selectWidgetInstance = OnlyoneSelectWidget.create({ escapeHtml, document, window })
    return selectWidgetInstance
  }
  function enhanceSelect(select) { return selectWidget().enhance(select) }

  function watchLongTasks() {
    if (typeof PerformanceObserver === 'undefined' || !window.electronAPI?.reportLongTask) return
    let lastAction = 'запуск'
    document.addEventListener('pointerdown', event => { lastAction = `нажатие ${describeTarget(event.target)}` }, true)
    document.addEventListener('keydown', event => { lastAction = `клавиша ${event.key.length === 1 ? 'символ' : event.key}` }, true)
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 200) window.electronAPI.reportLongTask({ ms: entry.duration, what: lastAction })
        }
      }).observe({ type: 'longtask', buffered: true })
    } catch (error) {
      console.warn('Журнал долгих задач недоступен:', error)
    }
  }

  function setupQuoting() {
    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection()
      const text = selection?.toString() || ''

      if (!text.trim() || selection.isCollapsed) return hideQuoteButton()

      // Only text inside a message: selecting in the composer or the sidebar
      // is not something to quote back.
      const node = selection.anchorNode
      const holder = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('.msg-item')
      if (!holder) return hideQuoteButton()

      const pane = panes.find(p => p.dom.list?.contains(holder)) || panes[0]
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      if (!rect.width && !rect.height) return hideQuoteButton()

      showQuoteButton(rect, text, pane, quoteSource(holder, pane.dom.list))
    })

    // The button belongs to one selection; anything that moves the page ends it.
    for (const event of ['scroll', 'resize']) {
      window.addEventListener(event, hideQuoteButton, true)
    }
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') hideQuoteButton()
    })
  }

  function setupChatHeader() {
    $('chatHeaderTitle')?.addEventListener('click', () => {
      const pane = panes[0]
      const chat = chatOf(pane)
      if (!chat) return

      const title = $('chatHeaderTitle')
      if (title.querySelector('input')) return

      const input = document.createElement('input')
      input.className = 'chat-header-rename'
      input.value = chat.title || ''
      input.setAttribute('aria-label', t('Название диалога'))
      title.textContent = ''
      title.appendChild(input)
      input.focus()
      input.select()

      let done = false
      const finish = save => {
        if (done) return
        done = true
        const next = input.value.trim()
        if (save && next && next !== chat.title) {
          chat.title = next.slice(0, 200)
          chat.updatedAt = Date.now()
          saveConversations()
          renderChatHistory()
        }
        renderChatHeader(pane)
      }

      input.addEventListener('keydown', e => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); if (e.isComposing || e.keyCode === 229) return; finish(true) }
        if (e.key === 'Escape') { e.preventDefault(); finish(false) }
      })
      input.addEventListener('blur', () => finish(true))
    })
  }

  // ─── Панель «Работа» ────────────────────────────────────────────
  // Реестр того, что агенты делают сейчас, вынесен своим модулем:
  // `work-panel.js`. Здесь только проводка: модуль получает общие виджеты
  // окна и те состояния, которые живут в `app.js` и меняются на ходу.
  let workPanelInstance = null
  function configurationParameterBlock() {
    if (fastMode) return { ok: false, code: 'fast' }
    if (panes.some(pane => pane.preparing || pane.generating) || [...designTaskPanes.values()].some(pane => pane.preparing || pane.generating)) return { ok: false, code: 'busy' }
    return null
  }
  function workPanel() {
    if (!workPanelInstance) {
      workPanelInstance = OnlyoneWorkPanel.create({
        $, t, el, escapeHtml, showToast, prefersReducedMotion, updateLiveMeta,
        formatDuration, formatTokens, formatRelativeTime, chatOf, normalizePlanSteps,
        designTaskPanes, PLAN_STATUS, stopTurn, stopDesignRun,
        getUiLang: () => uiLang, getPanes: () => panes, getActivePane: () => activePane,
        getDesigns: () => designs, getActiveDesign: () => activeDesign,
        applySidebarWidth: narrow => applySidebarWidth(narrow),
        configurationParameters: {
          preview: selection => configurationParameterBlock() || window.electronAPI.previewRunParameters(selection),
          apply: async token => {
            const blocked = configurationParameterBlock()
            if (blocked) return blocked
            const result = await window.electronAPI.applyRunParameters(token)
            if (!result?.ok) return result
            const model = findCatalogModel(result.parameters.defaultModel)
            if (!model) return { ok: false, code: 'refresh' }
            selectedModel = model
            preferredThinkingEffort = result.parameters.thinkingEffort
            currentThinkingEffort = result.parameters.thinkingEffort
            if (el.modalThinkingToggle) el.modalThinkingToggle.checked = currentThinkingEffort !== 'off'
            renderEffortChips(); updateModelEffortPill(); updateToolWarning(); renderModelCards()
            return result
          }
        }
      })
    }
    return workPanelInstance
  }
  function agentTaskState(...args) { return workPanel().agentTaskState(...args) }
  function lastAskOf(...args) { return workPanel().lastAskOf(...args) }
  function noteAgentDoing(...args) { return workPanel().noteAgentDoing(...args) }
  function panelPane(...args) { return workPanel().panelPane(...args) }
  function panelWelcomeHere(...args) { return workPanel().panelWelcomeHere(...args) }
  function toggleTasksPanel(...args) { return workPanel().toggleTasksPanel(...args) }
  function refreshTasksPanel(...args) { return workPanel().refreshTasksPanel(...args) }
  function allTasks(...args) { return workPanel().allTasks(...args) }
  function countWord(...args) { return workPanel().countWord(...args) }
  function agentRunRecord(...args) { return workPanel().agentRunRecord(...args) }
  function settleAgentTasks(...args) { return workPanel().settleAgentTasks(...args) }
  function completeAgentTask(...args) { return workPanel().completeAgentTask(...args) }
  function renderAgentTasks(...args) { return workPanel().renderAgentTasks(...args) }
  function renderTasksHeaderButton(...args) { return workPanel().renderTasksHeaderButton(...args) }
  function clearAgentTasks(...args) { return workPanel().clearAgentTasks(...args) }

  // A plan the agent writes mid-turn is the part worth watching. Waiting for
  // the user to open the project page to see it defeats the point.
  function showPlanPopup(project) {
    const steps = normalizePlanSteps(project?.plan)
    if (!steps.length) return

    let popup = $('planPopup')
    if (!popup) {
      popup = document.createElement('div')
      popup.id = 'planPopup'
      popup.className = 'plan-popup'
      document.body.appendChild(popup)
    }

    const byId = new Map(steps.map(s => [s.id, s]))
    const rows = steps.map(step => {
      const needs = (step.dependsOn || []).map(id => byId.get(id)?.title).filter(Boolean)
      return `
        <div class="plan-node status-${step.status || 'todo'}">
          <div class="plan-dot"></div>
          <div class="plan-body">
            <div class="plan-title">${escapeHtml(step.title || 'Шаг')}</div>
            ${needs.length ? `<div class="plan-needs">после: ${escapeHtml(needs.join(', '))}</div>` : ''}
          </div>
          <span class="plan-status">${escapeHtml(PLAN_STATUS[step.status] || PLAN_STATUS.todo)}</span>
        </div>`
    }).join('')

    popup.innerHTML = `
      <div class="plan-popup-head">
        <span class="plan-popup-title">План · ${escapeHtml(project.name || 'проект')}</span>
        <button type="button" class="plan-popup-close" aria-label="Закрыть"><svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>
      </div>
      <div class="plan-popup-body">${rows}</div>
      <button type="button" class="plan-popup-open">Открыть проект</button>`

    popup.querySelector('.plan-popup-close').addEventListener('click', () => popup.remove())
    popup.querySelector('.plan-popup-open').addEventListener('click', () => {
      switchTab('projects')
      openProjectEditor(project.id)
      popup.remove()
    })

    popup.classList.remove('leaving')
    clearTimeout(popup.__hide)
    // Long enough to read a plan, short enough not to sit in the way.
    popup.__hide = setTimeout(() => popup.classList.add('leaving'), 30000)
  }

  function renderMessages(pane) {
    if (!pane?.dom.list) return
    const chat = chatOf(pane)
    modsClient?.syncDraft(pane)
    const empty = !chat || !chat.messages.length

    // The side pane has no welcome screen; only the main one does.
    if (pane.dom.hero) {
      // Новая фраза — только когда пустой чат появляется, а не на каждой
      // перерисовке: иначе приветствие менялось бы под глазами.
      if (empty && pane.dom.hero.style.display !== 'flex') paintGreeting(true)
      pane.dom.hero.style.display = empty ? 'flex' : 'none'
      // Главный экран: знак, место и строка ввода — одной группой
      // чуть выше середины. Раскладку держит класс раздела чата.
      $('chatView')?.classList.toggle('is-empty', empty)
    }
    pane.dom.list.style.display = empty ? 'none' : 'flex'
    pane.dom.list.innerHTML = ''
    // Шапка — и для пустого чата: иначе после «Нового диалога» в ней оставалось
    // название чата, из которого ушли.
    if (empty) {
      if (pane === panes[0]) renderChatHeader(pane)
      renderSuggestion(pane)
      return
    }

    // Одна строка над лентой: сообщения под ней — те же самые, ни одно не
    // исчезает.
    const compressionLine = chat.compression ? compressionView().lineHtml(chat.compression) : ''
    if (compressionLine) pane.dom.list.insertAdjacentHTML('beforeend', compressionLine)

    for (const [messageIndex, msg] of chat.messages.entries()) {
      // The mode notice is part of the conversation, not a transient overlay:
      // it was inserted straight into the list during the turn and this rebuild
      // wiped it the moment the answer finished. It rides on the message now.
      try {
        const node = createMessageElement(pane, msg)
        decorateTurnFailure(pane, node, msg)
        node.dataset.forkMessageIndex = String(messageIndex)
        node.addEventListener('contextmenu', event => {
          if (event.target.closest('a, input, textarea') || window.getSelection()?.toString()) return
          event.preventDefault(); event.stopPropagation()
          openContextMenu(event.clientX, event.clientY, [{ label: t('Создать форк чата'), onPick: () => forkChat(chat.id, Number(node.dataset.forkMessageIndex)) }])
        })
        pane.dom.list.appendChild(node)
      } catch (err) {
        console.error('Не удалось отрисовать сообщение:', err, msg)
      }
    }

    // An answer in flight is not part of chat.messages yet, so this rebuild used
    // to discard it: leave a chat while the agent thinks, come back, and the
    // thinking was gone even though the agent was still working. The element is
    // detached, not destroyed — put it back and repaint what has arrived.
    if (pane.generating && pane.assistantEl && pane.liveChatId === pane.chatId) {
      pane.dom.list.appendChild(pane.assistantEl)
      pane.paintedBlocks = []
      paintBlocks(pane)
      renderLiveContent(pane)
    }

    bindCopyButtons(pane.dom.list)
    fillSentThumbnails(pane.dom.list)
    // Лента знает, чей она разговор: по этой метке карточка задачи Дизайна
    // возвращается в свою ленту в разделённом окне и не попадает в чужую.
    pane.dom.list.dataset.chatId = pane.chatId || ''
    pane.dom.list.oncontextmenu = event => {
      if (event.target.closest('a, input, textarea') || window.getSelection()?.toString()) return
      event.preventDefault()
      openContextMenu(event.clientX, event.clientY, [{ label: t('Создать форк чата'), onPick: () => forkChat(chat.id) }])
    }
    for (const pending of questionCards.values()) {
      if (!pending.designId && pending.chatId === pane.chatId) pane.dom.list.appendChild(pending.card)
    }
    for (const pending of approvalCards.values()) {
      if (pending.chatId === pane.chatId) pane.dom.list.appendChild(pending.card)
    }
    for (const pending of forkProposalCards.values()) {
      if (pending.chatId === pane.chatId || pending.chatId === pane.liveChatId) OnlyoneForkProposal.placeCard(pane.dom.list, pending.card)
    }
    restoreForkProposalCards(pane)
    restoreForkReturns(pane)
    refreshForkProposalSummary(pane)
    const resume = resumeCards.get(pane.chatId)
    if (resume && !pane.generating) pane.dom.list.appendChild(resume)
    // Карточки задач Дизайна возвращаются теми же узлами: перерисовка ленты
    // обнуляет её целиком, а потерять уже собранный кадр — значит показать
    // человеку пустое место вместо работы.
    redrawDesignTaskCards()
    scrollToBottom(pane)
    if (pane === (activePane || panes[0])) renderContextRing(pane)
    if (pane === panes[0]) renderChatHeader(pane)
    renderSuggestion(pane)
  }


  // Actions under a finished answer. Live messages get none: half of them would
  // act on text that is still arriving.
  function messageActionsHtml(msg) {
    // Icon-only: the labels said what the icons already say and stretched the
    // row across half the message. The name lives in the tooltip, and the pin
    // states apart by fill rather than by changing its word.
    return `
      <div class="msg-actions">
        <button type="button" class="msg-action" data-act="copy" data-tooltip="Скопировать ответ" aria-label="Скопировать ответ">
          <svg fill="none" class="icon small" viewBox="0 0 16 16"><rect x="5.6" y="5.6" width="8" height="8" rx="2"/><path d="M10.4 3.6c-.2-.8-.9-1.4-1.7-1.4H4c-1 0-1.8.8-1.8 1.8v4.7c0 .8.6 1.5 1.4 1.7"/></svg>
        </button>
        <button type="button" class="msg-action" data-act="retry" data-tooltip="Повторить запрос" aria-label="Повторить запрос">
          <svg fill="none" class="icon small" viewBox="0 0 16 16"><path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4"/><path d="M11.8 2.2V5H9"/></svg>
        </button>
      </div>
    `
  }

  function bindMessageActions(pane, item, msg) {
    const actions = item.querySelector('.msg-actions')
    if (!actions) return
    item.classList.toggle('pinned', Boolean(msg.pinned))

    actions.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(msg.content || '')
        showToast('Ответ скопирован')
      } catch {
        showToast('Не удалось скопировать', true)
      }
    })

    actions.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
      const chat = chatOf(pane)
      if (!chat || pane.generating) return
      const at = chat.messages.indexOf(msg)
      const previous = chat.messages.slice(0, at).reverse().find(entry => entry.role === 'user')
      if (previous?.content) handleSendMessage(pane, previous.content)
    })

    actions.querySelector('[data-act="pin"]')?.addEventListener('click', () => {
      const chat = chatOf(pane)
      if (!chat) return
      msg.pinned = !msg.pinned
      chat.updatedAt = Date.now()
      saveConversations()
      renderMessages(pane)
      showToast(msg.pinned ? 'Закреплено в чате' : 'Откреплено')
    })

    // Puts the files back the way they were before this answer touched them.
    // The snapshot is spent on use, so the button goes away afterwards.
    actions.querySelector('[data-act="undo"]')?.addEventListener('click', async () => {
      const files = (msg.fileChanges || []).map(c => c.file).filter(Boolean)
      const shown = files.slice(0, 6).join(', ')
      const rest = files.length > 6 ? ` и ещё ${files.length - 6}` : ''
      if (!await askConfirm(`Вернуть файлы к состоянию до этого ответа? ${shown}${rest}`, 'Отменить')) return

      try {
        const result = await window.electronAPI.undoAgentChanges(msg.undoId)
        const parts = []
        if (result.restored?.length) parts.push(`возвращено ${result.restored.length}`)
        if (result.removed?.length) parts.push(`удалено созданных ${result.removed.length}`)
        if (result.failed?.length) parts.push(`не вышло ${result.failed.length}`)
        // Пропущенный файл — не мелочь: его не откатили, потому что поверх легла
        // более поздняя работа. Молча посчитать отмену удавшейся значит соврать.
        if (result.conflicts?.length) {
          const shownConflicts = result.conflicts.slice(0, 4).join(', ')
          showToast(`Не тронуто, изменено после ответа: ${shownConflicts}${
            result.conflicts.length > 4 ? ` и ещё ${result.conflicts.length - 4}` : ''}`, true)
        }
        showToast(parts.length ? `Отменено: ${parts.join(', ')}` : 'Отменять было нечего',
          Boolean(result.failed?.length))

        // Снимок расходуется только при полном откате. Если что-то осталось,
        // кнопка нужна снова: пользователь разберётся с конфликтом и повторит.
        if (!result.snapshotKept) {
          msg.undoId = undefined
          msg.undone = true
        }
        chatOf(pane) && saveConversations()
        renderMessages(pane)
      } catch (err) {
        showToast(cleanErrorText(err) || 'Не удалось отменить', true)
      }
    })

    actions.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      const chat = chatOf(pane)
      if (!chat) return
      if (!await askConfirm('Удалить это сообщение из диалога?')) return
      chat.messages = chat.messages.filter(m => m !== msg)
      chat.updatedAt = Date.now()
      saveConversations()
      renderMessages(pane)
    })
  }

  // Провал хода — шаблоном состояния: искорка, причина, что цело,
  // одно главное действие. Разметку строит turn-state.js, здесь — проводка.
  function decorateTurnFailure(pane, item, msg) {
    if (!window.OnlyoneTurnState || msg?.role !== 'assistant') return
    const chat = chatOf(pane)
    const providerSelect = $('providerSelect')
    const onOpenRouter = (providerSelect?.value || 'openrouter') === 'openrouter'
    OnlyoneTurnState.decorate(item, msg, {
      t,
      escapeHtml,
      version: document.documentElement.dataset.appVersion || '',
      markPath: () => $('appGlyph')?.querySelector('path')?.outerHTML || '',
      provider: () => providerSelect?.selectedOptions?.[0]?.textContent?.trim() || 'OpenRouter',
      retry: () => {
        if (!chat || pane.generating) return
        const at = chat.messages.indexOf(msg)
        const previous = chat.messages.slice(0, at).reverse().find(entry => entry.role === 'user')
        if (previous?.content) handleSendMessage(pane, previous.content)
      },
      changeModel: () => $('modelEffortPillBtn')?.click(),
      openKeys: () => {
        $('openSettingsBtn')?.click()
        showSettingsTab('keys')
      },
      addKey: onOpenRouter ? async value => {
        const updated = await window.electronAPI.addOpenRouterKey({ key: value })
        renderKeysPool(updated)
        await loadModelsCatalog(true)
      } : null
    })
  }

  function createMessageElement(pane, msg, isLive = false) {
    const item = document.createElement('div')
    item.className = `msg-item ${msg.role}`
    // По этой метке история работы находит ответ, к которому она относится.
    if (msg.timestamp) item.dataset.at = String(msg.timestamp)

    const isAssistant = msg.role === 'assistant'

    let cliHeaderHtml = ''
    if (isAssistant) {
      const answered = cleanModelName(msg.modelName) || cleanModelName(selectedModel?.name) || 'onlyone'
      // Who actually worked, and on what. Agent mode reports a stage per agent;
      // without keeping it, a chat read back a day later cannot say whether one
      // agent did the job or three shared it.
      const crew = Array.isArray(msg.stages) && msg.stages.length > 1
        ? msg.stages.map(s => `${s.name} · ${cleanModelName(s.modelName)}`).join(' → ')
        : ''
      // Marked in the saved message too, not only while it streams: a chat read
      // back a day later has to show that the chosen model was replaced.
      const modelName = msg.requestedModelName ? `${answered} (замена)` : answered
      const durText = msg.duration ? formatDuration(msg.duration) : (isLive ? '0.0 с' : '')
      const tokText = formatTokens(isLive ? pane.totalTokens : msg.tokens)
      cliHeaderHtml = `
        <div class="msg-meta ${isLive ? 'live' : ''}">
          ${PIXEL_CAT_SVG}
          <span class="cli-model">${escapeHtml(modelName)}</span>
          <span class="cli-dot">·</span>
          <span class="cli-duration">${durText}</span>
          <span class="cli-dot${tokText ? '' : ' hidden'}">·</span>
          <span class="cli-tokens${tokText ? '' : ' hidden'}">${tokText}</span>
        </div>
      `
      // Здесь была вторая строка состояния со своей кнопкой «Остановить».
      // Остановка теперь одна и живёт в строке ввода, а чем занят агент,
      // говорит панель работы и строки вызовов в самой ленте. Эта строка
      // осталась третьим местом с тем же смыслом — и единственным, которое
      // писало «анализ задачи», пока модель уже писала ответ.
    }

    const thinkingHtml = ''

    // Saved messages get the same collapsible panel as the live one, so the
    // reasoning stays readable after the turn instead of turning into a wall of
    // italics above every answer.
    let reasoningHtml = ''
    if (msg.reasoning) {
      reasoningHtml = reasoningStreamHtml(segmentsFromStored(msg.reasoning))
    }

    let contentHtml = ''
    if (isAssistant) {
      let fileChangesHtml = ''
      if (msg.fileChanges && msg.fileChanges.length > 0) {
        fileChangesHtml = fileChangesBlockHtml(msg.fileChanges, { stopped: Boolean(msg.turnAborted || msg.aborted) })
      }

      if (msg.parallelAnswers && Array.isArray(msg.parallelAnswers)) {
        contentHtml = `
          <div class="parallel-answers-grid">
            ${msg.parallelAnswers.map(ans => `
              <div class="parallel-answer-card">
                <div class="parallel-card-header">
                  <div class="parallel-card-title">${escapeHtml(ans.title || 'Вариант')}</div>
                  <span class="parallel-card-badge">${escapeHtml(ans.badge || 'Параллельно')}</span>
                </div>
                <div class="parallel-card-body">${renderMarkdownHtml(ans.content || '')}</div>
              </div>
            `).join('')}
          </div>
        `
      } else {
        contentHtml = msg.content ? renderMarkdownHtml(msg.content) : ''
        if (typeof fileChangesHtml !== 'undefined' && fileChangesHtml) contentHtml += fileChangesHtml
      }
    } else {
      const tilesHtml = OnlyonePasteTiles.sentHtml(msg.attachments, { escapeHtml, kindLabel: ATTACH_KIND_LABEL, t })
      const textHtml = `<p>${formatWithEmoji(escapeHtml(msg.content)).replace(/\n/g, '<br>')}</p>`
      contentHtml = sentQuotesHtml(msg) + tilesHtml + textHtml
    }

    // Messages recorded with an order are replayed in that order. Older ones
    // have only reasoning-then-content and keep the old shape.
    if (isAssistant && !isLive && Array.isArray(msg.blocks) && msg.blocks.length) {
      // Blocks with no text in them, next to an answer that exists: that is a
      // message saved before the answer was put into the blocks. The text was
      // never lost, only unrendered — so it is rendered now.
      const hasText = msg.blocks.some(b => b.kind === 'text' && String(b.text || '').trim())
      const rescued = !hasText && String(msg.content || '').trim()
        ? [...msg.blocks, { kind: 'text', agent: '', text: msg.content }]
        : msg.blocks

      blocksHtmlInto(item, rescued, { tokens: msg.tokens })
      // Signature and the buttons that act on it share one line, as the design
      // draws them: «who answered, how long, and what you can do about it»
      // instead of two faint strips stacked.
      item.insertAdjacentHTML('beforeend',
        '<div class="msg-footer">' + cliHeaderHtml + messageActionsHtml(msg) + '</div>')
      bindCopyButtons(item)
      bindMessageActions(pane, item, msg)
      return item
    }

    if (msg.uiProposal && window.uiConfigView) {
      const state = msg.uiProposal.state || 'pending'
      let propElHtml = ''
      if (state === 'applied') {
        propElHtml = window.uiConfigView.renderAppliedLine({
          id: msg.uiProposal.id,
          label: msg.uiProposal.label,
          t
        })
      } else if (state === 'trying') {
        propElHtml = window.uiConfigView.renderTryingLine({
          id: msg.uiProposal.id,
          label: msg.uiProposal.label,
          t
        })
      } else {
        propElHtml = window.uiConfigView.renderProposalCard({
          id: msg.uiProposal.id,
          label: msg.uiProposal.label,
          patch: msg.uiProposal.patch,
          t
        })
      }
      contentHtml += propElHtml
    }

    if (isAssistant) {
      // Model and elapsed time sit under the answer: the answer is what you came
      // for, the metadata is what you check afterwards.
      item.innerHTML = `
        ${thinkingHtml}
        ${reasoningHtml}
        <div class="msg-content">${contentHtml}</div>
        <div class="msg-footer">${cliHeaderHtml}${isLive ? '' : messageActionsHtml(msg)}</div>
      `
      if (!isLive) bindMessageActions(pane, item, msg)
    } else {
      item.innerHTML = `
        <div class="msg-content">${contentHtml}</div>
      `
    }

    return item
  }

  // Send Message Flow
  // hidden — то, что уходит модели вместо видимого текста: так продолжение
  // прерванного хода показывает в ленте короткую фразу, а модель получает опись.
  async function handleSendMessage(pane, rawText, { hidden = '', resumeRunId = '' } = {}) {
    let text = rawText.trim()
    if (!text) return

    const presetMatch = text.match(/(?:настрой(?:ка)?|переключи|включи|поставь|выбери|примени|set|tune|configure|switch|preset)\s+(?:интерфейс\s+|раскладку\s+|вид\s+|ui\s+|preset\s+)?(?:под\s+|на\s+|for\s+|to\s+)?(дизайн(?:у)?|код(?:у)?|исследован(?:ие|ию)?|design|code|research)(?:$|\s|[.,!?])/i) || text.match(/^\/ui\s+(design|code|research|дизайн|код|исследование)(?:$|\s|[.,!?])/i)
    if (/^\/ui\b/i.test(text) || presetMatch) {
      let patch = { codeFontSize: 15 }
      let label = t('Увеличить шрифт кода до 15px')
      if (presetMatch) {
        const rawPreset = presetMatch[1].toLowerCase()
        if (/дизайн|design/i.test(rawPreset)) {
          patch = { taskPreset: 'design', sidebarWidth: 200, workPanelWidth: 480, codeFontSize: 13, fontUiSize: 13.5, lineHeight: 1.45, showSidebar: true, showWorkPanel: true }
          label = t('Настроить интерфейс под дизайн')
        } else if (/код|code/i.test(rawPreset)) {
          patch = { taskPreset: 'code', sidebarWidth: 220, workPanelWidth: 420, codeFontSize: 16, fontUiSize: 13.5, lineHeight: 1.5, showSidebar: true, showWorkPanel: true }
          label = t('Настроить интерфейс под код')
        } else if (/исследован|research/i.test(rawPreset)) {
          patch = { taskPreset: 'research', sidebarWidth: 320, workPanelWidth: 360, codeFontSize: 13, fontUiSize: 14, lineHeight: 1.5, showSidebar: true, showWorkPanel: false }
          label = t('Настроить интерфейс под исследование')
        }
      } else if (/sidebar\s*(\d+)/i.test(text)) {
        const val = parseInt(text.match(/sidebar\s*(\d+)/i)[1], 10)
        patch = { sidebarWidth: val }
        label = t('Ширина боковой панели') + `: ${val}px`
      } else if (/font\s*(\d+)/i.test(text)) {
        const val = parseInt(text.match(/font\s*(\d+)/i)[1], 10)
        patch = { codeFontSize: val }
        label = t('Размер шрифта кода') + `: ${val}px`
      } else if (/work\s*(\d+)/i.test(text)) {
        const val = parseInt(text.match(/work\s*(\d+)/i)[1], 10)
        patch = { workPanelWidth: val, showWorkPanel: true }
        label = t('Панель «Работа»') + `: ${val}px`
      }

      const chat = chatOf(pane)
      if (chat) {
        // Чат ищется заново по id: историю могли перечитать, ссылке не верим.
        const target = conversations.find(c => c.id === chat.id) || chat
        target.messages.push({ role: 'user', content: text })
        target.messages.push({
          role: 'assistant',
          content: '',
          uiProposal: {
            id: 'prop-' + Date.now(),
            label,
            patch,
            state: 'pending'
          }
        })
        saveConversations()
        renderMessages(pane)
      }
      pane.dom.textarea.value = ''
      autoResizeTextarea(pane)
      return
    }

    // Правка на ходу. Перебить модель посреди ответа нельзя — провайдер не
    // принимает дописку в идущий запрос. Но человек, увидевший, что агент пошёл
    // не туда, не должен ни ждать молча, ни терять набранное: уточнение встаёт
    // в очередь и уходит сразу, как только ход закончится. Чтобы прервать
    // немедленно, есть кнопка «Остановить» — это второй, честный путь.
    if (pane.generating || pane.preparing) {
      if (!pane.generating && rawText === pane.preparingText) { pane.dom.textarea.value = ''; return } // двойной Enter/клик: тот же текст уже готовится к отправке
      if (!pane.queuedMessage) {
        pane.queuedMessage = text
      } else {
        pane.queuedMessage += '\n\n' + text
      }
      pane.queuedByChat = pane.queuedByChat || new Map()
      if (pane.chatId) pane.queuedByChat.set(pane.chatId, pane.queuedMessage)
      pane.dom.textarea.value = ''
      autoResizeTextarea(pane)
      renderQueuedNotice(pane)
      const curReq = pane.requestId || pane.liveTurnsByChat?.get(pane.chatId)?.requestId; if (curReq) { window.electronAPI.steerAgent?.({ requestId: curReq, text, force: false }); showToast(t('Указание передано в идущий ход')) } else { showToast(t('Уточнение уйдёт, как только агент закончит ход')) }
      return
    }
    const turnModel = { ...selectedModel }
    const turnFastMode = fastMode

    let promptToSend = hidden ? String(hidden) : text

    if (!hidden && OnlyoneSlashCommands.startsCommand(text)) {
      const parts = text.split(/\s+/)
      const commandName = parts[0].toLowerCase()
      const restOfText = parts.slice(1).join(' ').trim()

      const match = SLASH_COMMANDS.find(c => c.cmd.toLowerCase() === commandName)
      if (match) {
        if (match.action) {
          match.action(restOfText)
          if (!restOfText || match.directive) {
            pane.dom.textarea.value = ''
            autoResizeTextarea(pane)
            return
          }
          promptToSend = restOfText
        } else if (match.prompt) {
          if (restOfText) {
            promptToSend = `${match.prompt}\n\n**Контекст / Запрос пользователя:**\n${restOfText}`
          } else {
            promptToSend = match.prompt
          }
        }
      }
    }

    // A path named in the message counts as an attachment — pick it up before the
    // turn starts so it shows as a chip and travels with the request.
    const preparingChatId = pane.chatId
    pane.preparing = true; pane.preparingText = rawText
    try {
      await attachPathsFromText(pane, rawText)
    } finally {
      pane.preparing = false; pane.preparingText = null
    }
    // Человек переключил чат, пока шло сканирование путей: сообщение предназначалось
    // прежнему чату. Не отправляем его в чужой чат и не теряем набранное — оставляем
    // черновиком за прежним чатом, ход не начинаем (break-2 Н3).
    if (pane.chatId !== preparingChatId) {
      if (preparingChatId) {
        pane.queuedByChat = pane.queuedByChat || new Map()
        pane.queuedByChat.set(preparingChatId, rawText)
      }
      clearAttachments(pane)
      return
    }
    const turnAttachments = pane.attachments.slice()

    // Provisional title while the turn runs: the typed text with the slash
    // command stripped, so a chat is never called "/consensus Разберите пож…".
    // The real one is generated from the exchange once it finishes.
    const provisionalTitle = (() => {
      const stripped = rawText.replace(/^\/[a-z]+\s*/i, '').trim() || rawText.trim()
      return stripped.length > 40 ? `${stripped.slice(0, 40)}…` : stripped
    })()

    let chat = chatOf(pane)
    if (!chat) {
      chat = createNewChat(pane, provisionalTitle)
    } else if (chat.messages.length === 0) {
      chat.title = provisionalTitle
    }
    const isFirstTurn = chat.messages.length === 0
    cancelNextSuggestion(chat.id, true)

    // Цитаты уходят с этим сообщением: в чате — блоком над текстом, модели —
    // с пометкой, откуда фрагмент. Плашки над полем снимаются.
    const turnQuotes = (pane.quotes || []).slice()
    if (turnQuotes.length) {
      promptToSend = quotesForModel(turnQuotes, promptToSend)
      pane.quotes = []
      renderQuotes(pane)
    }

    // Add User Message
    const userMsg = {
      role: 'user',
      content: rawText,
      quotes: turnQuotes.length ? turnQuotes : undefined,
      // The bubble shows what was typed; the model gets the expanded command.
      // Storing only "/review" meant every later turn resent the literal slash.
      prompt: promptToSend !== rawText ? promptToSend : undefined,
      attachments: turnAttachments.length ? turnAttachments : undefined,
      timestamp: Date.now()
    }
    chat.messages.push(userMsg)
    saveConversations()
    renderMessages(pane)

    pane.dom.textarea.value = ''
    autoResizeTextarea(pane)
    clearAttachments(pane)

    // Start Generation State. Номер хода ставится до неё: живой ход запоминает
    // requestId в момент включения, и со старым номером второй ответ получал
    // снимок предыдущего хода.
    pane.requestId = `req_${pane.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    setGeneratingState(pane, true)
    pane.requestedModel = turnModel
    pane.liveChatId = chat.id
    pane.reasoningBuffer = ''
    pane.contentBuffer = ''
    pane.echoLen = 0
    pane.streamQueue = ''; pane.smoothCursor = 0
    pane.parallelRoster = []
    pane.reasoningSegments = []
    pane.blocks = []
    pane.paintedBlocks = []
    pane.totalTokens = 0; pane.tokenTally = null
    pane.contextTokens = 0
    pane.actualModelId = null

    pane.fileChanges = []
    const assistantMsg = {
      role: 'assistant',
      content: '',
      reasoning: '',
      modelId: turnModel.id,
      modelName: turnModel.name,
      timestamp: Date.now()
    }
    pane.assistantEl = createMessageElement(pane, assistantMsg, true)
    pane.dom.list.appendChild(pane.assistantEl)
    pane.stickToBottom = true
    scrollToBottom(pane, true)

    let liveTimerInterval = null
    const startTime = Date.now()

    const cliHeader = pane.assistantEl.querySelector('.msg-meta')
    const durEl = cliHeader?.querySelector('.cli-duration')
    if (durEl) {
      durEl.style.display = 'inline'
      durEl.textContent = formatDuration(0)
      liveTimerInterval = setInterval(() => {
        if (!pane.generating) {
          clearInterval(liveTimerInterval)
          return
        }
        durEl.textContent = formatDuration((Date.now() - startTime) / 1000)
      }, 1000)
    }

    let serverResponse = null

    let turnError = ''

    try {
      const history = chat.messages.map((m, idx) => {
        if (idx === chat.messages.length - 1 && m.role === 'user') {
          return { role: m.role, content: promptToSend }
        }
        return { role: m.role, content: m.prompt || m.content }
      })
      // Середина, свёрнутая в сводку, в модель не едет — но она
      // остаётся в `chat.messages`, и человек видит её в ленте как прежде.
      const outgoingHistory = compressionView().applyCompression(history, chat.compression)

      const forceCompression = pane.forceCompactNext === true; pane.forceCompactNext = false
      serverResponse = await window.electronAPI.sendMessage({
        ...(modsClient?.takeDraft(pane) || {}),
        forceCompression,  // «.compact»: сжать историю в этом ходе
        model: turnModel.id,
        messages: outgoingHistory,
        requestId: pane.requestId,
        // Продолжение оборванного хода: главный процесс заберёт из этой
        // контрольной точки остаток бюджета цикла и сам снимет файл.
        ...(resumeRunId ? { resumeRunId } : {}),
        // Lets the memory digest skip the conversation it is being built for.
        chatId: chat.id,
        // Pulls in the project's instructions, knowledge base and sibling chats.
        projectId: chat.projectId || null,
        // Folders attached to this conversation, on top of the global ones and
        // whatever the project carries.
        chatFolders: chatFoldersOf(chat),
        reasoningEffort: currentThinkingEffort,
        speedMode: turnFastMode ? 'fast' : 'standard',
        attachments: turnAttachments.map(a => ({ path: a.path, modelOnly: a.modelOnly === true })),
        // Командная работа не объявляется здесь. Этот флаг значит «пользователь
        // прямо попросил команду», и стоял он раньше на каждой отправке — из-за
        // чего любое сообщение, вплоть до «привет», запускало раздачу работы
        // помощникам и запрещало ведущему ответить самому. Решает текст просьбы
        // («работайте вместе», «агент-режим») и сам ведущий, когда задача
        // действительно делится.
        params: { useTools: true }
      })

      // Что свернули и чем заменили — на чате: в следующий раз свёрнутая
      // середина поедет вместо себя, а не будет сворачиваться заново.
      if (serverResponse?.compression?.folded) {
        chat.compression = serverResponse.compression
        saveConversations()
      }
      if (serverResponse && serverResponse.content) {
        if (serverResponse.answeredModel) pane.actualModelId = serverResponse.answeredModel
        pane.contentBuffer = serverResponse.content
        pane.streamQueue = serverResponse.content
        renderLiveContent(pane)
      }

      // Главный процесс различает провал и удачу явно, а окно этого не читало:
      // ход, где ведущий агент не собрал итог, попадал в переписку как обычный
      // ответ. Отличить его от настоящего можно было только прочитав текст.
      if (serverResponse && serverResponse.ok === false && !serverResponse.aborted) {
        turnError = serverResponse.error || 'Ход не завершился результатом.'
        showToast(turnError, true)
      }
    } catch (err) {
      console.error('Send message error:', err)
      const errorMsg = cleanErrorText(err) || 'Не удалось получить ответ.'
      // Kept for the record below: a toast is gone in four seconds and the
      // conversation is what the user comes back to.
      turnError = errorMsg
      if (!pane.contentBuffer && !pane.streamQueue) {
        pane.contentBuffer = `⚠️ **Ошибка генерации:** ${errorMsg}`
        renderLiveContent(pane)
      }
      showToast(errorMsg, true)
    } finally {
      clearInterval(liveTimerInterval)
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)

      if (cliHeader) {
        cliHeader.classList.remove('live')
        // Ход кончился — знак это показывает один раз и успокаивается. Ставить
        // класс на живой узел было бесполезно: он удаляется перестройкой ленты
        // в этом же обороте, и анимация на секунду с лишним играла на узле,
        // которого уже нет. Отметку получает то сообщение, что осталось.
        pane.answerStarted = false
        pane.markPhase = ''
        requestAnimationFrame(() => {
          const settled = [...(pane.dom.list?.querySelectorAll('.msg-item.assistant .agent-mark') || [])].pop()
          if (!settled) return
          settled.classList.add('is-settled')
          setTimeout(() => settled.classList.remove('is-settled'), 1300)
        })
        if (durEl) {
          durEl.style.display = 'inline'
          durEl.textContent = formatDuration(duration)
        }
      }

      // If the turn was aborted the server never returns composed answers, so fall
      // back to whatever each column managed to stream.
      // Answers from the parallel mode that no longer exists are still read
      // back from storage; nothing produces new ones.
      const finalParallel = serverResponse?.parallelAnswers || null

      const turnState = (pane.liveTurnsByChat?.get(chat.id)) || pane
      const finalContent = (serverResponse && serverResponse.content) || turnState.contentBuffer || turnState.streamQueue

      // A turn always leaves a record. Without this a run that failed before
      // anything streamed — context overflow, every agent rate-limited, an
      // abort — left the question alone in the chat with no answer and no
      // reason, which reads as the message having been swallowed.
      const recorded = finalContent || turnState.reasoningBuffer || finalParallel
      const fallback = recorded
        ? ''
        : (turnError
            ? `⚠️ ${t('Ответа нет: %s', turnError)}`
            : (serverResponse?.aborted
                ? '⚠️ Остановлено — ответ не был получен.'
                : '⚠️ Ход завершился, но ответа не пришло. Попробуйте ещё раз или смените модель.'))

      // Чек-листы агентов живут только в панели «Задачи» (в конце хода их в ленту не выкладывать).

      if (recorded || fallback) {
        // Twenty minutes have passed and the history may have been reloaded
        // since this turn began, so the chat is looked up again rather than
        // trusted as a reference. Belt as well as braces: the merge above no
        // longer replaces objects, but the answer is the thing that must not
        // be lost, and it costs one lookup.
        const activeBlocksTurn = (pane.chatId === chat.id && pane.blocks?.length) ? pane : (turnState.blocks?.length ? turnState : pane)
        const target = conversations.find(c => c.id === chat.id) || chat
        target.messages.push({
          role: 'assistant',
          content: finalContent || fallback || 'Ответ сформирован.',
          parallelAnswers: finalParallel,
          reasoning: turnState.reasoningBuffer || pane.reasoningBuffer || '',
          modelId: turnState.actualModelId || pane.actualModelId || turnModel.id,
          modelName: ((turnState.actualModelId || pane.actualModelId) && (turnState.actualModelId || pane.actualModelId) !== turnModel.id
            ? (findCatalogModel(turnState.actualModelId || pane.actualModelId)?.name || (turnState.actualModelId || pane.actualModelId))
            : turnModel.name),
          // Which model was asked for, when a different one answered. Without
          // this the stored footer names the substitute as if it had been the
          // choice, and a reader has no way to tell the model they picked
          // never ran.
          requestedModelName: ((turnState.actualModelId || pane.actualModelId) && (turnState.actualModelId || pane.actualModelId) !== turnModel.id
            ? turnModel.name
            : undefined),
            // Kept only for a real team: a single agent is already named by the
          // model beside it, and a one-item list would be noise.
          stages: Array.isArray(serverResponse?.stages) && serverResponse.stages.length > 1
            ? serverResponse.stages.map(st => ({ name: st.name, modelName: st.modelName }))
            : undefined,
          // Carries the mode notice into history. This is the object that is
          // stored — the live placeholder above is thrown away on the rebuild.
          // The order thinking and text actually arrived in, so a reopened
          // chat reads the same way it did live.
          // The title is the readable half of a step — "Прочитал main.js" —
          // while the text is the raw arguments. Dropping it here meant a
          // reopened chat showed JSON where the actions had been.
          blocks: blocksForStorage(activeBlocksTurn, finalContent || fallback),
          // Names the undo snapshot for the files this turn changed.
          undoId: (turnState.fileChanges || pane.fileChanges || []).length ? (turnState.requestId || pane.requestId) : undefined,
          duration: duration,
          tokens: turnState.totalTokens || pane.totalTokens,
          // Read back by the context ring. Without it the ring has nothing
          // measured to start from and estimates the whole transcript instead.
          contextTokens: turnState.contextTokens || pane.contextTokens || undefined,
          fileChanges: (turnState.fileChanges || pane.fileChanges || []).slice(),
          turnAborted: Boolean(serverResponse?.aborted) || undefined,
          // Причина провала — для блока состояния в ленте (turn-state.js)
          failure: turnError ? String(turnError).slice(0, 600) : undefined,
          aborted: Boolean(serverResponse?.aborted),
          // Как отработали агенты. Живая панель стирается со следующим ходом, а
          // эта запись остаётся и открывается кнопкой истории в заголовке.
          agentRun: agentRunRecord(pane.chatId === chat.id ? pane : (pane.tasksByChat?.get(chat.id) || pane), {
            ask: [...(target.messages || [])].reverse().find(m => m.role === 'user')?.content || '',
            seconds: Number(duration) || 0
          }),
          configurationRunId: serverResponse?.execution?.runId,
          runConfigurations: serverResponse?.execution?.configurations,
          droppedConfigurations: serverResponse?.execution?.droppedConfigurations,
          timestamp: Date.now()
        })
        target.updatedAt = Date.now()
        saveConversations()
        // The answer is stored now, so the live element is history. Releasing it
        // before the rebuild stops the "keep the in-flight message" path from
        // pinning the old node back on top of the freshly rendered one.
        if (pane.chatId === chat.id) {
          pane.liveChatId = null
          renderMessages(pane)
        }
      }
      pane.liveTurnsByChat?.delete(chat.id)
      if (pane.chatId === chat.id) {
        pane.liveChatId = null
        stopLiveRender(pane)
        pane.assistantEl = null
        setGeneratingState(pane, false, chat.id)
      } else {
        paintGlyph()
      }
      renderChatHistory()
      refreshToolCapability()

      if (!turnFastMode && finalContent && !turnError && !serverResponse?.aborted) {
        requestNextSuggestion(pane, chat, {
          userText: rawText,
          assistantText: finalContent,
          model: turnState.actualModelId || pane.actualModelId || turnModel.id
        })
      }

      // Уточнение, набранное во время хода, уходит следующим — но только если
      // человек не ушёл в другой чат: там оно было бы не к месту.
      if (pane.queuedMessage && pane.chatId === chat.id) {
        const queued = pane.queuedMessage
        pane.queuedMessage = ''
        pane.queuedByChat?.delete(chat.id)
        renderQueuedNotice(pane)
        handleSendMessage(pane, queued)
      }

      // Fast keeps the local title: no extra paid/background model request.
      if (!turnFastMode && isFirstTurn && !chat.titleGenerated) {
        nameChat(pane, chat, promptToSend, finalContent)
      }
    }
  }

  // Runs after the turn, off to the side: a title is a nicety and must never
  // block the answer or surface as an error.
  async function nameChat(pane, chat, userText, assistantText) {
    if (!window.electronAPI?.generateChatTitle) return
    chat.titleGenerated = true

    try {
      const { title } = await window.electronAPI.generateChatTitle({
        userText,
        assistantText,
        model: selectedModel.id
      })
      if (!title) return

      // Naming happens after the turn and after a round trip of its own, so
      // the chat is looked up again rather than held. If it was deleted while
      // the title was being written, there is nothing to name.
      const target = conversations.find(c => c.id === chat.id)
      if (!target) return

      target.title = title
      target.updatedAt = target.updatedAt || Date.now()
      saveConversations()
      renderChatHistory()
    } catch (err) {
      console.warn('Не удалось сгенерировать название чата:', err)
    }
  }

  // ─── Управление отправкой ───────────────────────────────────────
  // Кнопка, очередь и остановка хода вынесены своим модулем:
  // `send-controls.js`. Здесь только проводка.
  let sendControlsInstance = null
  function sendControls() {
    if (!sendControlsInstance) {
      sendControlsInstance = OnlyoneSendControls.create({
        $, el, t, escapeHtml, showToast, cleanErrorText, renderSuggestion,
        allTasks, clearAgentTasks, settleAgentTasks, renderAgentTasks,
        getPanes: () => panes, getActiveDesign: () => activeDesign, getDesignRun: () => designRun,
        onDesignQueueDrop: (_designId, entry) => {
          if (entry?.resumeRunId) void showInterruptedRuns()
        }
      })
    }
    return sendControlsInstance
  }
  function paintGlyph(...args) { return sendControls().paintGlyph(...args) }
  function paintSendButton(...args) { return sendControls().paintSendButton(...args) }
  function stopDesignRun(...args) { return sendControls().stopDesignRun(...args) }
  function queuedFor(...args) { return sendControls().queuedFor(...args) }
  function renderDesignQueue(...args) { return sendControls().renderDesignQueue(...args) }
  function paintDesignSendButton(...args) { return sendControls().paintDesignSendButton(...args) }
  function stopTurn(...args) { return sendControls().stopTurn(...args) }
  function setGeneratingState(...args) { return sendControls().setGeneratingState(...args) }
  function renderQueued(...args) { return sendControls().renderQueued(...args) }
  // Очередь отложенного ввода принадлежит модулю отправки, но она нужна и окну:
  // ею пользуются, когда продолжают прерванный ход.
  const designQueue = sendControls().designQueue

  // Очередь ввода Дизайна держит не только текст: у отложенного продолжения
  // прерванной работы вместе с текстом уходят скрытая опись и id хода. Без них
  // следующий ход начинал бы с нуля, хотя человек просил продолжить, а опись
  // показалась бы в полосе очереди как напечатанное им сообщение.
  function queueDesignMessage(designId, entry) {
    const previous = designQueue.get(designId)
    // Одну запись очереди нельзя заменить другим прерванным ходом: у каждого
    // своя контрольная точка. Обычное пожелание к уже поставленному продолжению
    // добавляем в его скрытый запрос, чтобы текст не потерялся.
    if (entry.resumeRunId && previous && previous.resumeRunId !== entry.resumeRunId) return false
    const appendedPrompt = previous?.resumeRunId && !entry.resumeRunId
      ? `${previous.hidden || ''}\n\nДополнительное пожелание пользователя: ${entry.text}`
      : ''
    designQueue.set(designId, {
      text: previous?.text ? `${previous.text}\n\n${entry.text}` : entry.text,
      hidden: entry.hidden || appendedPrompt || previous?.hidden || '',
      resumeRunId: entry.resumeRunId || previous?.resumeRunId || ''
    })
    renderDesignQueue()
    return true
  }

  function startQueuedDesignIfReady() {
    if (designBusy || !activeDesign) return
    const designId = activeDesign.id
    const waiting = designQueue.get(designId)
    if (!waiting) return
    designQueue.delete(designId)
    renderDesignQueue()
    setTimeout(() => {
      if (designBusy || activeDesign?.id !== designId) {
        if (!designQueue.has(designId)) designQueue.set(designId, waiting)
        renderDesignQueue()
        return
      }
      sendDesignMessage(waiting.text, {
        hidden: waiting.hidden || '',
        resumeRunId: waiting.resumeRunId || ''
      })
    }, 0)
  }

  // ─── Блоки агентной ленты ──────────────────────────────────────────
  // Способ рисования хода вынесен своим модулем: `message-blocks.js`.
  // Здесь только проводка — разметка, тексты и то, что живёт в окне.
  let messageBlocksInstance = null
  function messageBlocks() {
    if (!messageBlocksInstance) {
      messageBlocksInstance = OnlyoneMessageBlocks.create({
        $, el, t, escapeHtml, renderMarkdownHtml, bindCopyButtons, formatDuration,
        normalizePlanSteps, PLAN_STATUS, schedulePaint, agentTaskState, countWord,
        renderAgentTasks, getUiLang, formatTokens
      })
    }
    return messageBlocksInstance
  }
  function toolParts(...args) { return messageBlocks().toolParts(...args) }
  function toolHeadline(...args) { return messageBlocks().toolHeadline(...args) }
  function thinkingHeadline(...args) { return messageBlocks().thinkingHeadline(...args) }
  function pushThinking(...args) { return messageBlocks().pushThinking(...args) }
  function isHelperChunk(...args) { return messageBlocks().isHelperChunk(...args) }
  function feedLane(...args) { return messageBlocks().feedLane(...args) }
  function laneTool(...args) { return messageBlocks().laneTool(...args) }
  function settleLane(...args) { return messageBlocks().settleLane(...args) }
  function pushBlock(...args) { return messageBlocks().pushBlock(...args) }
  function blocksForStorage(...args) { return messageBlocks().blocksForStorage(...args) }
  function paintBlocks(...args) { return messageBlocks().paintBlocks(...args) }
  function blocksHtmlInto(...args) { return messageBlocks().blocksHtmlInto(...args) }
  function updateLiveAssistantUI(...args) { return messageBlocks().updateLiveAssistantUI(...args) }

  // Model Selection & Badges
  function getBadgeClass(provider) {
    const p = (provider || '').toLowerCase()
    if (p.includes('google')) return 'google'
    if (p.includes('anthropic')) return 'anthropic'
    if (p.includes('openai')) return 'openai'
    if (p.includes('deepseek')) return 'deepseek'
    if (p.includes('meta')) return 'meta'
    return 'other'
  }

  function formatPrice(p) {
    // Цену знает только каталог OpenRouter. У моделей своего эндпоинта её нет:
    // выдумывать «Free» нельзя, а падать на undefined — тем более.
    if (p === 0) return 'Free'
    if (typeof p !== 'number' || !Number.isFinite(p)) return ''
    return `$${p.toFixed(2)}/1M`
  }

  function formatContext(c) {
    if (!c) return ''
    if (c >= 1_000_000) return `${(c / 1_000_000).toFixed(1)}M ctx`
    return `${Math.round(c / 1000)}k ctx`
  }

  // Guessing from the model id was always wrong — the catalog reports this.
  function modelSupportsThinking(model) {
    if (!model) return false
    return Boolean(
      (Array.isArray(model.supportedEfforts) && model.supportedEfforts.length) ||
      model.supportsReasoning ||
      model.reasoningMandatory
    )
  }

  // Метка глубины — одна функция на все места: «Выкл» и в пилюле, и в подсказке
  // обязан быть «Off», а не переводиться в пяти местах по-разному.
  const effortLabel = stop => t(EFFORT_LABELS[stop] || stop || '')

  const EFFORT_LABELS = {
    off: 'Выкл',
    xhigh: 'X-High',
    max: 'Max',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    minimal: 'Minimal',
    none: 'None'
  }

  // Ступени ползунка — от мелкого к глубокому. Только те, что модель принимает:
  // всё остальное OpenRouter отклоняет с ошибкой 400.
  const EFFORT_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

  function effortStops(model) {
    const efforts = Array.isArray(model?.supportedEfforts) ? model.supportedEfforts : []
    if (!efforts.length) return []
    const known = efforts.filter(effort => EFFORT_ORDER.includes(effort))
      .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
    // Мышление не выключается: самая тихая ступень — Low. «Выкл», None и
    // Minimal не предлагаются; если у модели ничего выше нет, остаётся то, что она принимает.
    const stops = known.filter(effort => !['off', 'none', 'minimal'].includes(effort))
    return stops.length ? stops : known
  }

  // Какую ступень поставить: выбранную человеком, если модель её принимает;
  // выключенное мышление — нулевой ступенью модели, если «Выкл» у неё нет;
  // иначе самую глубокую из настоящих.
  function pickEffort(stops, wanted) {
    if (stops.includes(wanted)) return wanted
    // Сохранённое «Выкл» / None / Minimal прежних версий становится Low: выключить мышление больше нельзя.
    if (['off', 'none', 'minimal'].includes(wanted) && stops.includes('low')) return 'low'
    if (wanted === 'off' && stops.includes('none')) return 'none'
    return [...stops].reverse().find(stop => stop !== 'off' && stop !== 'none') || stops[stops.length - 1]
  }

  function renderEffortChips() {
    const stops = effortStops(selectedModel)
    const mandatory = Boolean(selectedModel?.reasoningMandatory)
    const slider = el.effortSlider

    if (el.effortUnsupportedHint) el.effortUnsupportedHint.hidden = stops.length > 0
    if (el.effortSliderValue) el.effortSliderValue.hidden = !stops.length
    $('effortSliderWrap')?.toggleAttribute('hidden', !stops.length)

    if (!stops.length) {
      if (slider) slider.dataset.stops = ''
      currentThinkingEffort = mandatory ? 'max' : 'off'
      if (el.modalThinkingToggle) el.modalThinkingToggle.checked = currentThinkingEffort !== 'off'
      updateModelEffortPill()
      return
    }

    // Выключенное мышление раньше не переживало перерисовку: «off» не было среди
    // фишек модели, и выбор человека молча заменялся самой глубокой ступенью —
    // после каждого перезапуска мышление снова оказывалось включённым.
    currentThinkingEffort = pickEffort(stops, preferredThinkingEffort || currentThinkingEffort)

    if (slider) {
      slider.max = String(stops.length - 1)
      slider.value = String(stops.indexOf(currentThinkingEffort))
      slider.disabled = Boolean(fastMode)
      slider.dataset.stops = stops.join(',')
      paintEffortSlider(stops)
    }
    if (el.effortSliderStops) {
      el.effortSliderStops.innerHTML = stops
        .map(stop => `<span class="effort-range-stop" data-effort="${escapeHtml(stop)}">${escapeHtml(effortLabel(stop))}</span>`)
        .join('')
    }
    if (el.modalThinkingToggle) el.modalThinkingToggle.checked = currentThinkingEffort !== 'off'
    updateModelEffortPill()
  }

  // Подпись и заливка дорожки. Заливка — чтобы было видно, насколько глубоко,
  // не читая подпись.
  function paintEffortSlider(stops) {
    const slider = el.effortSlider
    if (!slider) return
    const index = Number(slider.value) || 0
    const stop = stops[index]
    const label = fastMode ? t('авто') : effortLabel(stop)
    if (el.effortSliderValue) el.effortSliderValue.textContent = label
    slider.setAttribute('aria-valuetext', label)
    const pct = stops.length > 1 ? Math.round((index / (stops.length - 1)) * 100) : 100
    slider.style.setProperty('--fill', `${pct}%`)
    el.effortSliderStops?.querySelectorAll('.effort-range-stop').forEach((node, i) => {
      node.classList.toggle('active', i === index)
    })
  }

  function updateModelEffortPill() {
    if (el.pillModelName && selectedModel) {
      el.pillModelName.textContent = cleanModelName(selectedModel.name)
    }
    // A different model means a different window, so the same conversation
    // fills it to a different degree.
    renderContextRing()
    const supports = modelSupportsThinking(selectedModel)
    const isThinkingOn = el.modalThinkingToggle ? el.modalThinkingToggle.checked : true

    if (el.pillEffortName) {
      if (fastMode) {
        el.pillEffortName.textContent = 'Fast'
        el.pillEffortName.dataset.tooltip = t('Экономный профиль Agent: low, для рискованных задач и Design — high. Модель не меняется.')
        el.pillEffortName?.removeAttribute?.('title')
        el.pillEffortName.style.display = 'inline-block'
      } else if (supports && isThinkingOn && currentThinkingEffort !== 'off') {
        // «Minimal» on its own beside a model name is a word with no subject.
        // The label comes from the catalogue's own map — capitalising the raw
        // key turned «xhigh» into «Xhigh» — and the tooltip says what is being
        // measured and where to change it.
        el.pillEffortName.textContent = effortLabel(currentThinkingEffort)
        // Четыре столбика у пилюли: глубина видна без слова
        const level = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 }[currentThinkingEffort] || 0
        if ($('effortPillBtn')) $('effortPillBtn').dataset.level = String(level)
        el.pillEffortName.dataset.tooltip =
          t('Глубина рассуждений модели: %s. Меняется в каталоге моделей.', effortLabel(currentThinkingEffort))
        el.pillEffortName?.removeAttribute?.('title')
        el.pillEffortName.style.display = 'inline-block'
      } else {
        el.pillEffortName.style.display = 'none'
        el.pillEffortName.textContent = ''
        delete el.pillEffortName.dataset.tooltip
        el.pillEffortName?.removeAttribute?.('title')
      }
    }

    // The Design composer shows the same model and the same depth, so it is
    // refreshed from the same place. Choosing an effort updated only the chat
    // pill, and the one in Design went on showing whatever it had when the view
    // was last opened — clicking Max there left «High» on screen.
    renderDesignModelPill()
    renderFastControls()
    modelPopoverInstance?.syncEffort()
  }

  // Learned at runtime: some models advertise tool support and then return an
  // empty stream when tools are attached. Ox Alpha is one of them today.
  let toolCapability = {}

  async function refreshToolCapability() {
    if (!window.electronAPI?.getToolCapability) return
    try {
      toolCapability = (await window.electronAPI.getToolCapability()) || {}
    } catch {
      toolCapability = {}
    }
    updateToolWarning()
  }

  function modelCanUseTools(model) {
    return toolCapability[model?.id]?.works !== false
  }

  // Agent mode silently degrades to plain chat on such a model, so say it out
  // loud where the model is chosen.
  function updateToolWarning() {
    const pill = el.modelEffortPillBtn
    if (!pill || !selectedModel) return
    const broken = !modelCanUseTools(selectedModel)
    pill.classList.toggle('no-tools', broken)
    pill.dataset.tooltip = broken
      ? `${cleanModelName(selectedModel.name)} не умеет вызывать инструменты — файлы и MCP в агент-режиме работать не будут. Каталог моделей (${shortcutOf('models')})`
      : `Модель (${shortcutOf('models')})`
    pill?.removeAttribute?.('title')
  }

  function setModel(model) {
    // Выбранная недоступная модель гарантированно роняет каждый ход с ошибкой
    // 404. Лучше сказать это сразу, у каталога, чем в ответе на первом сообщении.
    if (model?.unavailable) {
      showToast(t('%s сейчас недоступна в OpenRouter — выберите другую модель.', cleanModelName(model.name)), true)
      return
    }
    if (fastMode && !model?.isFree && !model?.id?.endsWith(':free') && model?.id !== 'z-ai/glm-5.3-flash') {
      showToast('Для Fast выберите бесплатную модель или GLM 5.3 Flash. Либо выключите Fast.', true)
      return
    }
    selectedModel = model

    // Choosing it by hand overrides whatever the app concluded about it: the
    // mark came from one empty answer, which is as often the provider as the
    // model, and without this there was no way to take it back.
    if (model?.id && toolCapability[model.id]?.works === false) {
      window.electronAPI?.clearToolCapability?.(model.id)
        .then(() => refreshToolCapability())
        .catch(() => {})
    }
    renderEffortChips()
    updateModelEffortPill()
    updateToolWarning()

    try {
      window.electronAPI?.setSettings?.({ defaultModel: model.id })
    } catch {}

    closeModal(el.modelModal)
    renderModelCards()
    showToast(`Выбрана модель: ${cleanModelName(model.name)}`)
  }

  function setEffort(effort) {
    currentThinkingEffort = effort
    preferredThinkingEffort = effort
    // Выбор переживает перезапуск. Без этой строки он жил до закрытия окна, а
    // на следующем запуске подставлялся самый глубокий режим, какой поддержала
    // модель, — и выглядело это как то, что приложение само поменяло настройку.
    try { window.electronAPI?.setSettings?.({ thinkingEffort: effort }) } catch {}
    const stops = effortStops(selectedModel)
    if (el.effortSlider && stops.includes(effort)) {
      el.effortSlider.value = String(stops.indexOf(effort))
      paintEffortSlider(stops)
    }
    if (el.modalThinkingToggle) el.modalThinkingToggle.checked = effort !== 'off'
    // Всплывающее «Нагрузка мышления: MAX» на каждый шаг ползунка было лишним:
    // значение и так написано рядом с ним.
    updateModelEffortPill()
  }

  function renderModelCards() {
    el.modalModelList.innerHTML = ''
    const query = el.modelFilterInput.value.trim().toLowerCase()

    let filtered = modelCatalog.filter(m => {
      if (activeCategory === 'free' && (!m.isFree || m.unavailable)) return false
      if (activeCategory === 'anthropic' && m.category !== 'anthropic') return false
      if (activeCategory === 'openai' && m.category !== 'openai') return false
      if (activeCategory === 'google' && m.category !== 'google') return false
      if (activeCategory === 'deepseek' && m.category !== 'deepseek') return false
      if (activeCategory === 'meta' && m.category !== 'meta') return false
      if (activeCategory === 'coding' && m.category !== 'coding') return false
      return true
    })

    if (query) {
      filtered = filtered.filter(m =>
        m.name.toLowerCase().includes(query) ||
        m.id.toLowerCase().includes(query) ||
        (m.provider && m.provider.toLowerCase().includes(query)) ||
        (m.description && m.description.toLowerCase().includes(query))
      )
    }

    el.modelCountBadge.textContent = countWord(filtered.length, 'модель', 'модели', 'моделей')

    if (!filtered.length) {
      const emptyDiv = document.createElement('div')
      emptyDiv.style.textAlign = 'center'
      emptyDiv.style.padding = '30px 20px'
      emptyDiv.style.color = 'var(--text-dim)'
      emptyDiv.textContent = 'Модели не найдены'
      el.modalModelList.appendChild(emptyDiv)
      return
    }

    filtered.forEach(model => {
      const card = document.createElement('button')
      card.type = 'button'
      const selected = model.id === selectedModel.id
      card.className = `model-row-card${selected ? ' selected' : ''}${model.unavailable ? ' unavailable' : ''}`
      const badgeCls = getBadgeClass(model.provider)
      // Описание — на английском и на две строки — стояло в каждой карточке, и
      // список из 445 моделей читался как стена текста. В строке остаётся имя,
      // поставщик, контекст и цена; описание — в подсказке и под выбранной.
      card.dataset.tooltip = model.description ? String(model.description).slice(0, 400) : model.id
      card?.removeAttribute?.('title')
      card.innerHTML = `
        <div class="model-meta-left">
          <div class="model-row-title-bar">
            <span class="model-row-name">${escapeHtml(cleanModelName(model.name))}</span>
            <span class="provider-tag ${badgeCls}">${escapeHtml(model.provider || 'AI')}</span>
          </div>
          ${selected && model.description ? `<p class="model-desc-text">${escapeHtml(model.description)}</p>` : ''}
        </div>
        <div class="model-meta-right">
          ${model.contextLength ? `<span class="pill-context">${formatContext(model.contextLength)}</span>` : ''}
          ${model.unavailable
            ? `<span class="pill-price unavailable" data-tooltip="${escapeHtml(t(model.unavailableReason || 'OpenRouter больше не отдаёт эту модель'))}">${escapeHtml(t('недоступна'))}</span>`
            : `<span class="pill-price ${model.isFree ? 'free' : 'paid'}">${model.isFree ? 'Free' : formatPrice(model.promptPrice)}</span>`}
        </div>
      `
      card.addEventListener('click', () => setModel(model))
      el.modalModelList.appendChild(card)
    })
  }

  async function loadModelsCatalog(force = false) {
    if (!window.electronAPI?.fetchModels) return
    try {
      el.modelCountBadge.textContent = 'Загрузка…'
      const models = await window.electronAPI.fetchModels({ force })
      const settings = await window.electronAPI.getSettings?.()
      if (Array.isArray(models) && !models.length && settings?.adapterProvider) {
        // Пустой ответ пути из реестра — это «каталога нет», а не «не успел
        // OpenRouter»: прежний список под чужой путь подставлять нельзя.
        modelCatalog = []
        modelCatalogMap = new Map()
      }
      if (Array.isArray(models) && models.length > 0) {
        modelCatalog = models
        modelCatalogMap = new Map(models.map(m => [m.id, m]))
        const savedId = settings?.defaultModel
        if (settings?.customModel) {
          // На пути из реестра (свой endpoint, OpenAI, Anthropic, Gemini, Ollama)
          // шапка не имеет права называть модель OpenRouter: отвечает не она, и
          // сохранённый `defaultModel` относится к другому пути.
          const match = findCatalogModel(settings.customModel)
          selectedModel = match && match.id === settings.customModel ? match
            : { id: settings.customModel, name: cleanModelName(settings.customModel) }
        } else if (savedId) {
          const match = findCatalogModel(savedId)
          if (match) selectedModel = match
        }
        // Сохранённая глубина восстанавливается до отрисовки фишек: renderEffortChips
        // подгоняет её под возможности модели, и если к этому моменту значение
        // ещё стартовое, подгонка затрёт выбор человека.
        if (typeof settings?.thinkingEffort === 'string' && settings.thinkingEffort) {
          currentThinkingEffort = settings.thinkingEffort
          preferredThinkingEffort = settings.thinkingEffort
        }
        if (el.pillModelName) el.pillModelName.textContent = cleanModelName(selectedModel.name)
        populateModelDropdowns()
        renderEffortChips()
        updateToolWarning()
      }
    } catch (err) {
      console.warn('Failed to load models:', err)
    } finally {
      renderModelCards()
    }
  }

  function buildModelSelectOptionsHtml(selectedId = '') {
    const groups = {
      'free': { label: 'Бесплатные модели', items: [] },
      'anthropic': { label: 'Anthropic', items: [] },
      'openai': { label: 'OpenAI', items: [] },
      'deepseek': { label: 'DeepSeek', items: [] },
      'google': { label: 'Google', items: [] },
      'meta': { label: 'Meta', items: [] },
      'coding': { label: 'Специализированные для кода', items: [] },
      'other': { label: 'Другие модели', items: [] }
    }

    modelCatalog.forEach(m => {
      const cat = m.category || 'other'
      if (groups[cat]) {
        groups[cat].items.push(m)
      } else {
        groups['other'].items.push(m)
      }
    })

    let html = ''
    for (const [key, grp] of Object.entries(groups)) {
      if (grp.items.length > 0) {
        html += `<optgroup label="${escapeHtml(grp.label)}">`
        grp.items.forEach(m => {
          const isSel = m.id === selectedId ? ' selected' : ''
          const priceTag = m.isFree ? ' [Free]' : ''
          html += `<option value="${escapeHtml(m.id)}"${isSel}>${escapeHtml(cleanModelName(m.name))}${priceTag} (${escapeHtml(m.provider || 'AI')})</option>`
        })
        html += `</optgroup>`
      }
    }
    return html
  }

  function populateModelDropdowns() {
    if (!el.newKeyModelSelect) return
    el.newKeyModelSelect.innerHTML = buildModelSelectOptionsHtml(selectedModel ? selectedModel.id : '')
  }

  // Плагины (OS-5): раздел строит plugins-page.js — список, права и журнал.
  let pluginsPage = null
  function pluginsPageOf() {
    if (pluginsPage || !window.OnlyonePluginsPage || !el.pluginsView) return pluginsPage
    pluginsPage = OnlyonePluginsPage.create({
      host: el.pluginsView,
      api: window.electronAPI,
      toast: (text, isError) => showToast(text, isError),
      confirm: (message, label) => askConfirm(message, label)
    })
    return pluginsPage
  }
  function refreshPlugins() { pluginsPageOf()?.refresh() }

  // Скиллы: раздел строит skills-page.js — список, страница скилла и «Новый скилл».
  // Здесь только данные и то, что модулю нужно от окна.
  let skillsPage = null
  let skillsError = ''
  let skillsLoaded = false
  function skillsPageOf() {
    if (skillsPage || !window.OnlyoneSkillsPage || !el.skillsView) return skillsPage
    skillsPage = OnlyoneSkillsPage.create({
      host: el.skillsView,
      getSkills: () => skillsList,
      refresh: () => refreshSkills(),
      lastError: () => skillsError,
      projectName: () => workspaceState?.path ? folderLeaf(workspaceState.path) : '',
      modelId: () => selectedModel?.id || '',
      chatTitle: id => conversations.find(c => c.id === id)?.title || '',
      relTime: ts => formatRelativeTime(ts),
      lang: () => uiLang,
      toast: (text, isError, options) => showToast(text, isError, options || {}),
      confirm: (message, label) => askConfirm(message, label),
      menu: (button, items) => OnlyoneMk.popMenu(button, items),
      cleanError: error => cleanErrorText(error) || String(error?.message || error)
    })
    return skillsPage
  }
  async function refreshSkills() {
    if (!window.electronAPI?.getSkills) return
    const view = skillsPageOf()
    if (!skillsLoaded) view?.setState('loading')
    try {
      skillsList = await window.electronAPI.getSkills()
      skillsError = ''
      skillsLoaded = true
      view?.setState('content')
    } catch (e) {
      skillsError = cleanErrorText(e) || String(e?.message || e)
      view?.setState('error')
    }
  }

  // Workspace
  function folderLeaf(path) {
    return String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
  }

  async function saveWorkspace(next, done) {
    try {
      workspaceState = await window.electronAPI.setWorkspace(next)
      await refreshWorkspace()
      if (done) showToast(done)
    } catch (err) {
      showToast(cleanErrorText(err) || 'Не удалось изменить папки', true)
    }
  }

  // A second folder is a common case: sources in one place, notes or a design
  // system in another. The agent addresses each by its folder name.
  // A folder can also hang off one conversation or off a project. The global
  // list follows the user everywhere; these follow the work. One chat can span a
  // backend and a frontend without every other chat inheriting them.
  function chatFoldersOf(chat) {
    return Array.isArray(chat?.folders) ? chat.folders : []
  }

  // Папка, в которой работает чат: папка проекта, папка этого чата или общая.
  function chatPlaceFolder(chat) {
    const project = chat?.projectId ? projects.find(p => p.id === chat.projectId) : null
    const projectFolders = project && Array.isArray(project.folders) ? project.folders : []
    return project?.workspacePath || projectFolders[0] || chatFoldersOf(chat)[0] || globalFolders()[0] || ''
  }

  // Шапка и главный экран называют место работы — папку; ветки git нет нигде.
  // Пилюля папки переехала из строки ввода в шапку; меню папок — то же.
  function paintChatPlace(chat) {
    const folder = chatPlaceFolder(chat)
    const leaf = folder ? folderLeaf(folder) : ''
    if (el.workspaceLabel) el.workspaceLabel.textContent = leaf || t('Добавить папку')
    if (el.workspaceBtn) {
      el.workspaceBtn.hidden = !leaf
      el.workspaceBtn.dataset.tooltip = folder || t('Папки нет — агент работает без файловых инструментов.')
    }
    // Правила проекта — только у чата в проекте: у остальных править нечего
    const instr = $('instrBtn')
    if (instr) instr.hidden = !(chat?.projectId && projects.some(p => p.id === chat.projectId))
    // Заголовок главного экрана — то же место
    paintGreeting()
  }

  async function addChatFolder(pane) {
    const chat = chatOf(pane)
    if (!chat) return
    const picked = await window.electronAPI.selectWorkspace()
    if (!picked?.path) return
    if (chatFoldersOf(chat).includes(picked.path)) return showToast('Эта папка уже подключена к чату')
    chat.folders = [...chatFoldersOf(chat), picked.path]
    saveConversations()
    showToast(`Папка добавлена в чат: ${folderLeaf(picked.path)}`)
  }

  function removeChatFolder(pane, folder) {
    const chat = chatOf(pane)
    if (!chat) return
    chat.folders = chatFoldersOf(chat).filter(f => f !== folder)
    saveConversations()
    showToast('Папка отключена от чата')
  }

  async function addProjectFolder(project) {
    if (!project) return
    const picked = await window.electronAPI.selectWorkspace()
    if (!picked?.path) return
    const folders = Array.isArray(project.folders) ? project.folders : []
    if (folders.includes(picked.path)) return showToast('Эта папка уже подключена к проекту')
    project.folders = [...folders, picked.path]
    saveProjects()
    showToast(`Папка добавлена в проект: ${folderLeaf(picked.path)}`)
  }

  function removeProjectFolder(project, folder) {
    if (!project) return
    project.folders = (project.folders || []).filter(f => f !== folder)
    saveProjects()
    showToast('Папка отключена от проекта')
  }

  // Папки всех чатов — один равноправный список: без «основной»,
  // которую можно только сменить, и без отдельного «работать без папки» —
  // убрали последнюю, и агент работает без файлов. Хранится по-старому: первая
  // в workspace.path, остальные в extraPaths, — главный процесс и прежние
  // версии читают его как раньше. В первой по умолчанию запускаются команды.
  function globalFolders(state = workspaceState) {
    return [...new Set([state?.path, ...(state?.extraPaths || [])].filter(Boolean))]
  }

  function withGlobalFolders(list) {
    const [first = '', ...rest] = [...new Set(list.filter(Boolean))]
    return { ...workspaceState, path: first, extraPaths: rest }
  }

  async function addGlobalFolder() {
    try {
      const picked = await window.electronAPI.selectWorkspace()
      if (!picked?.path) return
      const list = globalFolders()
      if (list.includes(picked.path)) return showToast('Эта папка уже подключена')
      await saveWorkspace(withGlobalFolders([...list, picked.path]),
        `Папка «${folderLeaf(picked.path)}» подключена ко всем чатам`)
    } catch (err) {
      showToast(cleanErrorText(err) || 'Не удалось добавить папку', true)
    }
  }

  async function removeGlobalFolder(folder) {
    if (!await askConfirm(`Отключить папку «${folderLeaf(folder)}» от всех чатов?`, 'Отключить')) return
    await saveWorkspace(withGlobalFolders(globalFolders().filter(item => item !== folder)),
      `Папка «${folderLeaf(folder)}» отключена`)
  }

  async function refreshWorkspace() {
    if (!window.electronAPI?.getWorkspace) return
    try {
      workspaceState = await window.electronAPI.getWorkspace()
      const pathVal = globalFolders()[0] || ''
      renderPermissionMode()

      // Whether a workspace is set decides whether the agent has file tools at
      // all, so it belongs in the composer, not only buried in settings.
      if (el.workspaceLabel) {
        // Windows paths are separated by backslashes, and this split looked only
        // for forward ones — so `.pop()` returned the whole path and the pill
        // read «D:\work\project…» instead of the folder's name. The
        // full path still lives in the button's tooltip and in the titlebar.
        const leaf = pathVal ? pathVal.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : ''
        // The compact control names the place. Counts made `proX` read as
        // `proX +1`, while the full folder set already lives in its menu and
        // tooltip where there is room to explain it.
        el.workspaceLabel.textContent = leaf || t('Добавить папку')
      }
      if (el.workspaceBtn) {
        // Пока папки нет, кнопке нечего показывать: добавляют папку через «+».
        el.workspaceBtn.hidden = !pathVal
        el.workspaceBtn.classList.toggle('is-set', Boolean(pathVal))
        el.workspaceBtn.dataset.tooltip = pathVal
          ? pathVal
          : 'Папки нет — агент работает без файловых инструментов. Нажмите, чтобы выбрать.'
        el.workspaceBtn?.removeAttribute?.('title')
      }
      // Шапка называет папку именно этого чата (проекта, чата или общую)
      if (panes[0]) paintChatPlace(chatOf(panes[0]))
    } catch (e) {
      console.error(e)
    }
  }

  // MCP Connectors
  async function refreshMcp() {
    if (!window.electronAPI?.getMcpServers) return
    try {
      mcpState = await window.electronAPI.getMcpServers()
      const servers = mcpState.servers || []
      const connectedCount = servers.filter(s => s.status === 'connected').length

      setNavCount(el.mcpBadge, connectedCount)

      renderMcpList(servers)
    } catch (e) {
      console.error(e)
    }
  }

  // MCP: строка сервера — имя, «Удалённый/Локальный, адрес» или
  // причина ошибки, пилюля статуса, переключатель и раскрытие с инструментами и
  // действиями. Раскрытые строки переживают перерисовку по событию статуса.
  const mcpOpenRows = new Set()
  // Причина по-человечески; сырой текст ошибки — под «Подробностями» в раскрытии
  function mcpReason(server) {
    const raw = String(server.error || '')
    const missing = raw.match(/spawn (\S+) ENOENT/i)
    if (missing) return t('Команды %s нет на этом компьютере', missing[1])
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(raw)) return t('Адрес не отвечает')
    if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(raw)) return t('Сервер не принял ключ')
    return t('Не запускается')
  }

  function mcpRowHtml(server) {
    const K = window.OnlyoneMk
    const on = server.status === 'connected' || server.status === 'connecting'
    const bad = server.status === 'error'
    const open = mcpOpenRows.has(server.id)
    const launch = [server.command].concat(server.args || []).filter(Boolean).join(' ')
    const where = server.type === 'http' ? String(server.url || '').replace(/^https?:\/\//, '') : launch
    const pill = server.status === 'connected' ? `<span class="stat-pill ok">${escapeHtml(t('Подключён'))}</span>`
      : server.status === 'connecting' ? `<span class="stat-pill">${escapeHtml(t('Подключаю…'))}</span>`
      : bad ? `<span class="stat-pill bad">${escapeHtml(t('Не запускается'))}</span>` : ''
    const id = escapeHtml(server.id)
    const acts = `<div class="mc-acts">${K.L(t(bad ? 'Повторить' : 'Перезапустить'), { attrs: ` data-mx="retry" data-id="${id}"`, dis: !bad && !on })}` +
      `${K.L(t('Изменить'), { attrs: ` data-mx="edit" data-id="${id}"` })}${K.L(t('Удалить'), { danger: true, attrs: ` data-mx="del" data-id="${id}"` })}</div>`
    const names = Array.isArray(server.tools) ? server.tools : []
    const n = Number(server.toolCount) || names.length
    const more = bad
      ? `<pre class="fail-tech">${escapeHtml(String(server.error || ''))}</pre>${acts}`
      : `<p class="mc-tools">${n
          ? `<b>${escapeHtml(t(K.plural(n, '%s инструмент', '%s инструмента', '%s инструментов'), n))}:</b> ${escapeHtml(names.slice(0, 8).join(', '))}${n > Math.min(8, names.length) ? escapeHtml(t(' и ещё %s', n - Math.min(8, names.length))) : ''}`
          : escapeHtml(t(on ? 'Инструменты появятся, когда сервер подключится.' : 'Сервер выключен: агент не видит его инструменты.'))}</p>${acts}`
    return `<div class="mc${open ? ' open' : ''}" data-on="${on}" data-mc="${id}"><div class="mc-top"><div class="mc-main"><div class="mc-name">${escapeHtml(server.name)}</div>` +
      `<div class="mc-d${bad ? ' bad' : ''}">${escapeHtml(bad ? mcpReason(server) : `${t(server.type === 'http' ? 'Удалённый' : 'Локальный')}, ${where}`)}</div></div>` +
      `<div class="mc-side">${pill}<button class="switch" type="button" role="switch" aria-checked="${on}" aria-label="${escapeHtml(server.name)}" data-mx="sw" data-id="${id}"${server.status === 'connecting' ? ' disabled' : ''}></button>` +
      `<button class="ibtn mc-chev" type="button" data-mx="exp" data-id="${id}" aria-expanded="${open}" aria-controls="mc-${id}" aria-label="${escapeHtml(t('Подробнее: %s', server.name))}" data-tooltip="${escapeHtml(t(open ? 'Свернуть' : 'Инструменты и действия'))}">${K.ico('chevron')}</button></div></div>` +
      `<div class="mc-more" id="mc-${id}"${open ? '' : ' inert'}><div class="mc-in">${more}</div></div></div>`
  }

  function renderMcpList(servers) {
    const host = el.mcpServerList
    if (!host) return
    const K = window.OnlyoneMk
    $('addMcpServerBtn')?.toggleAttribute('hidden', !servers.length)
    if (!servers.length) {
      host.innerHTML = K.stateBlock({
        title: t('Серверов пока нет'),
        body: escapeHtml(t('MCP-сервер даёт агенту новые инструменты. Подойдёт готовый конфиг от Claude Desktop или Claude Code — вставьте его целиком.')),
        acts: K.B(t('Добавить сервер'), { kind: 'primary', icon: 'plus', attrs: ' data-mx="new"' })
      })
      return
    }
    // Фокус держится на той же кнопке той же строки после перерисовки
    const focused = document.activeElement?.closest?.('#mcpServerList [data-mx]')
    const keep = focused ? [focused.dataset.mx, focused.dataset.id] : null
    host.innerHTML = servers.map(mcpRowHtml).join('')
    if (keep) host.querySelector(`[data-mx="${keep[0]}"][data-id="${CSS.escape(keep[1] || '')}"]`)?.focus({ preventScroll: true })
  }

  async function mcpAct(button) {
    const action = button.dataset.mx
    if (action === 'new') return el.addMcpServerBtn?.click()
    const server = (mcpState?.servers || []).find(s => s.id === button.dataset.id)
    if (!server) return
    try {
      if (action === 'exp') {
        const row = button.closest('.mc'), open = !mcpOpenRows.has(server.id)
        open ? mcpOpenRows.add(server.id) : mcpOpenRows.delete(server.id)
        row.classList.toggle('open', open)
        row.querySelector('.mc-more').toggleAttribute('inert', !open)
        button.setAttribute('aria-expanded', String(open))
        button.dataset.tooltip = t(open ? 'Свернуть' : 'Инструменты и действия')
        return
      }
      if (action === 'sw') {
        const on = window.OnlyoneMk.flipSw(button)
        if (on) {
          await window.electronAPI.connectMcpServer(server.id)
          showToast(t('«%s» включён', server.name))
        } else {
          await window.electronAPI.disconnectMcpServer(server.id)
          showToast(t('«%s» выключен: агент не видит его инструменты', server.name), false, {
            undo: async () => { await window.electronAPI.connectMcpServer(server.id); refreshMcp() }
          })
        }
        return refreshMcp()
      }
      if (action === 'retry') {
        if (server.status === 'connected') await window.electronAPI.disconnectMcpServer(server.id)
        await window.electronAPI.connectMcpServer(server.id)
        return refreshMcp()
      }
      if (action === 'edit') return openMcpEditor(server)
      if (action === 'del') {
        if (!(await askConfirm(t('Удалить сервер %s? Агент потеряет его инструменты. Настройки сервера удалятся: вернуть его можно, только добавив заново.', server.name), t('Удалить')))) return
        await window.electronAPI.removeMcpServer(server.id)
        mcpOpenRows.delete(server.id)
        refreshMcp()
        showToast(t('Сервер %s удалён', server.name))
      }
    } catch (err) {
      showToast(cleanErrorText(err) || t('Ошибка подключения'), true)
      refreshMcp()
    }
  }

  // Строки «ИМЯ=значение» и «Заголовок: значение»; JSON по-прежнему принимается
  const kvText = (map, sep) => Object.entries(map || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n')
  function kvParse(text, sep) {
    const src = String(text || '').trim()
    if (!src) return null
    if (src.startsWith('{')) return JSON.parse(src)
    const out = {}
    for (const line of src.split('\n').map(s => s.trim()).filter(Boolean)) {
      const at = line.indexOf(sep)
      if (at <= 0) throw new Error(line)
      out[line.slice(0, at).trim()] = line.slice(at + sep.length).trim()
    }
    return out
  }

  function setMcpTransport(type) {
    mcpTransportType = type === 'http' ? 'http' : 'stdio'
    if (el.mcpStdioFields) el.mcpStdioFields.hidden = mcpTransportType !== 'stdio'
    if (el.mcpHttpFields) el.mcpHttpFields.hidden = mcpTransportType !== 'http'
    document.querySelectorAll('#addMcpForm .transport-tab').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === mcpTransportType)))
  }

  // Одно окно на «Добавить» и «Изменить»: у правки нет поля готового конфига
  function openMcpEditor(server = null) {
    el.addMcpForm?.reset()
    window.OnlyoneMk.fieldErrors($('addMcpForm'), [])
    editingMcpId = server ? server.id : null
    setMcpFormNote('')
    $('mcpModalTitle').textContent = server ? t('Сервер %s', server.name) : t('Добавить сервер')
    $('mcpSubmitBtn').textContent = t(server ? 'Сохранить' : 'Добавить')
    $('mcpJsonBox').hidden = true
    $('mcpJsonToggle').hidden = Boolean(server)
    setMcpTransport(server?.type || 'stdio')
    if (server) {
      el.mcpNameInput.value = server.name
      el.mcpCommandInput.value = server.command || ''
      el.mcpArgsInput.value = (server.args || []).join('\n')
      el.mcpUrlInput.value = server.url || ''
      // Секреты из главного процесса не уходят: пустое поле — оставить прежние
      if (server.hasHeaders || server.hasEnvironment) setMcpFormNote(t('Секреты сохранены и не показываются. Оставьте поле пустым — останутся прежними, или впишите новые, чтобы заменить.'))
    }
    openModal(el.addMcpModal)
    requestAnimationFrame(() => el.mcpNameInput?.focus())
  }

  // Multi-Key OpenRouter Pool & Model Bindings
  async function refreshKeysPool() {
    if (!window.electronAPI?.getOpenRouterKeys) return
    try {
      keysPool = await window.electronAPI.getOpenRouterKeys()
      renderKeysPool(keysPool)
    } catch (e) {
      console.error('Failed to get keys pool:', e)
    }
  }

  // Свой OpenAI-совместимый endpoint. Ключа здесь нет и быть не
  // может: главный процесс отдаёт маску последних символов, а пустое поле ключа
  // при сохранении означает «не трогать», а не «стереть».
  async function refreshCustomProvider() {
    if (!window.electronAPI?.getCustomProvider) return
    try {
      renderCustomProvider(await window.electronAPI.getCustomProvider())
    } catch (e) {
      console.error('Failed to get custom provider:', e)
    }
  }

  function customProviderNote(view) {
    const onScreen = providerOnScreen || view?.activeProvider || view?.builtinId || ''
    if (!onScreen) return ''
    if (onScreen === view?.builtinId) {
      const count = (view?.items || []).length
      return count
        ? t('OpenRouter — путь по умолчанию, ключи в пуле ниже. Своих подключений: %s, ход на них не идёт.', count)
        : t('OpenRouter — путь по умолчанию, ключи в пуле ниже')
    }
    const entry = (view?.providers || []).find(item => item.id === onScreen)
    const account = shownAccount(view)
    // Название пути — из реестра и по-русски: подпись обязана переводиться и на
    // английском экране, иначе вкладка сама нарушает правило 2.8б, п.6.
    const pathTitle = t(entry?.title || onScreen)
    const title = account?.name && (onScreen === view?.customId || onScreen === 'openai-compatible')
      ? `${pathTitle} (${account.name})`
      : pathTitle
    const isLocal = account?.local ? t('— адрес в локальной или частной сети') : ''
    const parts = [account?.baseUrl, account?.model, isLocal].filter(Boolean)
    const note = parts.length ? parts.join(' ') : (account?.baseUrl ? t('путь настроен') : t('путь не настроен'))
    if (view?.activeProvider === onScreen) {
      return t('Ход идёт на «%s»: %s', title, note)
    }
    return t('Готов к ходу на «%s»: %s', title, note)
  }

  // Какое подключение сейчас на экране. Пока путь OpenRouter активен, выбор
  // только правит запись; на своём пути выбор ещё и переключает ход.
  function editedProvider(view) {
    const items = view?.items || []
    const editing = items.find(item => item.id === customProviderEditingId)
    return editing || items.find(item => item.id === view?.activeId) || items[0] || null
  }

  // Какой путь из каталога показывают поля: именованный — свою учётную запись,
  // встроенный OpenRouter и «свой совместимый» — выбранные подключения своего
  // пути. У OpenRouter своих полей в этом блоке нет, но без видимого списка
  // подключений их нельзя было бы заполнить до переключения пути.
  function namedPathOnScreen(view) {
    if (!view) return null
    const onScreen = providerOnScreen || view.activeProvider || view.builtinId
    if (onScreen === view.builtinId || onScreen === view.customId) return null
    return view.providers?.find(item => item.id === onScreen) ? onScreen : null
  }

  // Что на экране: учётная запись пути, выбранного в списке провайдеров. У
  // «своего совместимого endpoint'а» подключений несколько — для него показан
  // выбранный профиль.
  function shownAccount(view) {
    if (!view) return null
    const onScreen = providerOnScreen || view.activeProvider || view.builtinId
    const named = namedPathOnScreen(view)
    if (named) return (view.accounts || []).find(item => item.provider === named) || null
    return editedProvider(view)
  }

  // Список своих подключений (2.8б, п.4): строка — имя, короткий адрес, чип
  // состояния и меню «⋯» с тремя пунктами. Прежний `<select>` прятал половину
  // экрана: при OpenRouter он висел с пометкой «не используются», а показать,
  // какое подключение ходящее, был не способен.
  function renderCustomConnections(view) {
    const list = $('customConnectionsList')
    if (!list) return
    const items = view?.items || []
    // Имя подключения пишет человек, адрес приходит с чужого сервера: строки
    // собираются узлами, чтобы набранное не превратилось в разметку.
    list.textContent = ''
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'key-list-empty'
      empty.textContent = t('Своих подключений ещё нет.')
      list.appendChild(empty)
      return
    }
    for (const item of items) list.appendChild(connectionRow(item, view))
  }

  function connectionRow(item, view) {
    const row = document.createElement('div')
    row.className = `conn-row${item.id === customProviderEditingId ? ' is-edited' : ''}`
    row.dataset.connectionId = String(item.id || '')

    const head = document.createElement('div')
    head.className = 'key-head'

    // Нажатие на имя переключает ход — тем же вызовом, что прежний список
    // выбора: без этой рукоятки выбор между двумя подключениями пропал бы.
    const main = document.createElement('button')
    main.type = 'button'
    main.className = 'conn-main'
    main.dataset.action = 'choose'
    main.setAttribute('data-tooltip', t('Вести ходы через это подключение'))
    const id = document.createElement('span')
    id.className = 'key-id'
    const name = document.createElement('span')
    name.className = 'key-name'
    name.textContent = item.name || t('Без имени')
    const address = document.createElement('span')
    address.className = 'conn-addr'
    address.textContent = shortAddress(item.baseUrl)
    id.append(name, address)
    main.append(id)
    if (item.id === view?.activeId && view?.activeProvider === view?.customId) {
      const here = document.createElement('span')
      here.className = 'conn-flag'
      here.textContent = t('ход идёт здесь')
      main.appendChild(here)
    }

    const state = document.createElement('span')
    state.className = 'conn-state'
    const stateText = providerPathStateText(item)
    state.textContent = stateText
    state.hidden = !stateText

    const wrap = document.createElement('div')
    wrap.className = 'conn-menu-wrap'
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'conn-more'
    more.dataset.action = 'menu'
    more.setAttribute('aria-expanded', 'false')
    more.setAttribute('aria-label', t('Действия подключения'))
    more.textContent = '⋯'
    const menu = document.createElement('div')
    menu.className = 'conn-menu'
    menu.hidden = true
    for (const one of [['edit', t('Изменить'), ''], ['check', t('Проверить'), ''], ['remove', t('Удалить'), ' danger']]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `conn-menu-item${one[2]}`
      button.dataset.action = one[0]
      button.textContent = one[1]
      menu.appendChild(button)
    }
    wrap.append(more, menu)

    const spacer = document.createElement('span')
    spacer.className = 'key-spacer'
    head.append(main, spacer, state, wrap)
    row.appendChild(head)
    return row
  }

  // Адрес в строке короткий: полное значение живёт в поле формы, а списку
  // достаточно узнать путь глазами — `https://` и `/v1` на этой ширине ели
  // бы имя.
  function shortAddress(value) {
    const text = String(value || '')
    if (!text) return t('адрес не задан')
    return text.replace(/^https?:\/\//, '').replace(/\/+$/, '').slice(0, 46)
  }

  function closeConnectionMenus(except) {
    for (const menu of document.querySelectorAll('.conn-menu')) {
      if (menu !== except) menu.hidden = true
    }
  }

  // Причина в чипе короткая: чип — состояние, а не журнал. Длинную фразу
  // главного процесса («не удалось связаться с эндпоинтом (ECONNREFUSED)…»)
  // человек читает в строке ответа, а в строке списка ей место до обрезания:
  // без обрезания чип съедал имя подключения и ложился на соседние элементы.
  function shortReason(value, limit = 46) {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text
  }

  // Чип состояния пути (п.3): три вида, которые назвал владелец, и честное
  // «не проверен» между ними — сказать «подключено» там, где эндпоинт ни разу
  // не отвечал, значило бы соврать.
  function providerPathStateText(account) {
    if (!account) return ''
    if (account.addressOk === false && account.baseUrl) {
      return t('Ошибка: %s', shortReason(account.addressReason || t('адрес не читается')))
    }
    const check = account.lastCheck
    if (check && check.ok === false) return t('Ошибка: %s', shortReason(check.reason || t('эндпоинт не ответил')))
    if (!account.hasKey && !account.providerOptional) return t('Нет ключа')
    if (check && check.ok) return t('Подключено')
    return account.configured ? t('Не проверен') : ''
  }

  // Имена путей приходят из реестра главным процессом; в окне не держим ни
  // 'custom', ни 'openai-compatible' — иначе второй провайдер разъедется с ним.
  function isCustomPath(view) {
    return Boolean(view?.activeProvider) && view.activeProvider === view.customId
  }

  function renderProviderOptions(view) {
    const select = $('providerSelect')
    if (!select || !Array.isArray(view?.providers) || !view.providers.length) return
    // На экране — выбранный путь, а не обязательно действующий: отказ
    // переключения не должен возвращать список к прежнему значению, человек
    // только что назвал другой провайдер и хочет его настроить.
    const wanted = view.providers.some(item => item.id === providerOnScreen) ? providerOnScreen : view.activeProvider
    // Пути разложены по группам (provider-groups.js): агрегаторы и хостинги, разработчики моделей, свой адрес.
    window.OnlyoneProviderGroups.fill(select, view.providers, t, document)
    select.value = view.providers.some(item => item.id === wanted) ? wanted : view.activeProvider
    providerOnScreen = select.value
  }

  function customProviderKeyState(view) {
    if (view?.ending === 'не читается') {
      // Запись прежней поставки не знала, чем упакована: честнее сказать
      // «неизвестно», чем объявить её защищённой или потерянной.
      return view.keyEnc === 'unknown'
        ? t('Ключ перенесён из прежней версии, способ защиты неизвестен — пересохраните его')
        : t('Ключ не открылся этой учётной записью — задайте заново')
    }
    if (!view?.hasKey) {
      // Локальному Ollama ключ не нужен: требовать его подписью — обзывать
      // правильно подключённое место незаполненным.
      return view?.providerOptional ? t('Ключ не задан — этому пути он и не нужен') : t('Ключ не задан')
    }
    // Состояние ключа, а не его символы: поле с конвертом секрета окну не
    // показывается (этого держит аудит), а способ упаковки — `keyEnc` — тот же
    // самый признак, которым главный процесс отвечает за защиту.
    if (view.keyEnc === 'safeStorage') return t('Ключ защищён системой Windows')
    // Открытая форма шифрования возможна только там, где нет safeStorage; для
    // перенесённых записей способ неизвестен — врать про «лежит открыто» нельзя.
    return view.keyEnc === 'unknown'
      ? t('Ключ перенесён из прежней версии, способ защиты неизвестен — пересохраните его')
      : t('Ключ лежит открыто — шифрование недоступно')
  }

  function renderCustomProvider(view) {
    customProviderView = view || null
    const shown = shownAccount(view)
    if (shown) customProviderEditingId = shown.id
    renderProviderOptions(view)
    const select = $('providerSelect')
    if (select && view?.activeProvider && !providerOnScreen) select.value = view.activeProvider
    const onScreen = providerOnScreen || view?.activeProvider || view?.builtinId
    const isCustomOnScreen = onScreen === view?.customId
    const isBuiltinOnScreen = onScreen === view?.builtinId
    // Что видно на экране решает ТОЛЬКО выбранный путь (п.2-п.4): при OpenRouter
    // остаётся пул ключей, на своём пути — список подключений и их поля, у
    // провайдера из каталога — его учётная запись. Прежняя смесь показывала
    // всё сразу с пометкой «не используются».
    const connectionsGroup = $('customConnectionsGroup')
    if (connectionsGroup) connectionsGroup.hidden = !isCustomOnScreen
    const keysGroup = $('openrouterKeysGroup')
    if (keysGroup) keysGroup.hidden = !isBuiltinOnScreen
    const fieldsGroup = $('providerFieldsGroup')
    if (fieldsGroup) fieldsGroup.hidden = isBuiltinOnScreen
    renderCustomConnections(view)
    const title = $('providerFieldsTitle')
    if (title) {
      const entry = (view?.providers || []).find(item => item.id === onScreen)
      title.textContent = isCustomOnScreen
        ? (shown?.name || t('Своё подключение'))
        : t(entry?.title || namedPathOnScreen(view) || onScreen)
    }
    const note = $('providerPathNote')
    if (note) note.textContent = customProviderNote(view)
    // Какой аккаунт рисовался в прошлый раз: по нему видно, что человек перешёл
    // на другой путь, и черновик прошлого пути не имеет права остаться в полях.
    const switched = providerShownAccountId !== (shown?.id || '')
    providerShownAccountId = shown?.id || ''
    const keyInput = $('customKeyInput')
    // Ключ не переезжает: набрал секрет для одного пути, выбрал другой —
    // введённое стирается, иначе «Сохранить» записало бы чужой секрет и он ушёл
    // бы на чужой адрес.
    if (keyInput && switched) keyInput.value = ''
    // Пока человек правит любое поле группы, значения не перезаписываются:
    // иначе рендер из соседнего обработчика вернул бы к сохранённому то, что
    // уже набрано и ещё не записано. Но набранное относится к ТОМУ пути, на
    // котором его набрали: при смене показываемой учётной записи черновик
    // обязан уступить место её собственным значениям.
    const fields = $('customProviderFields')
    const editing = fields && document.activeElement && fields.contains(document.activeElement) && !switched
    const nameRow = $('customProviderNameRow')
    if (nameRow) nameRow.hidden = !isCustomOnScreen
    if (!editing) {
      const nameInput = $('customProviderNameInput')
      if (nameInput) {
        nameInput.value = shown?.name || ''
        // Подсказка в поле — тоже подпись: `applyTranslations` правит текстовые
        // узлы, а атрибуты остаются русскими, если их не перевести здесь.
        nameInput.placeholder = t('Название подключения')
      }
      const address = $('customBaseUrlInput')
      if (address) {
        address.value = shown?.baseUrl || ''
        address.placeholder = shown?.defaultBaseUrl || t('Адрес')
      }
      const model = $('customModelInput')
      if (model) {
        model.value = shown?.model || ''
        model.placeholder = t('Модель')
      }
      // Список моделей — только этого пути: чужой каталог в подсказке выглядит
      // как «у сервера есть такая модель», хотя её там нет.
      fillCustomModelList(shown?.models)
      if (keyInput) keyInput.placeholder = shown?.keyPlaceholder || t('API-ключ')
    }
    const state = $('customProviderKeyState')
    if (state) state.textContent = customProviderKeyState(shown)
    // Подсказка глаза — видима при наведении, а `applyTranslations` правит
    // только текстовые узлы: атрибут окно переводит само.
    const eye = $('toggleCustomKeyVisibility')
    if (eye) {
      const revealed = keyInput && keyInput.type === 'text'
      eye.setAttribute('data-tooltip', revealed ? t('Скрыть ключ') : t('Показать ключ'))
      eye.setAttribute('aria-label', eye.getAttribute('data-tooltip'))
    }
    const chip = $('providerPathState')
    if (chip) {
      const text = providerPathStateText(shown)
      // Отметка беды берётся из признака, а не из слова: на английском экране
      // чип говорит «Error: …», и проверка по русскому префиксу молчала бы.
      const failing = Boolean(shown) &&
        ((shown.addressOk === false && shown.baseUrl) || (shown.lastCheck && shown.lastCheck.ok === false))
      chip.textContent = text
      chip.hidden = !text
      chip.classList.toggle('warn', failing)
    }
    const modelHint = $('customModelHint')
    if (modelHint) {
      const count = (shown?.models || []).length
      modelHint.textContent = count
        ? t('подсказка — %s моделей этого пути', count)
        : t('можно вписать руками')
    }
    const tools = $('customToolsCheck')
    if (tools) tools.checked = shown?.capabilities?.tools !== false
    const hint = $('customToolsHint')
    if (hint) {
      const rejectedTools = shown?.capabilities?.tools === false
      hint.textContent = rejectedTools
        ? t('Выключено: этот сервер отказал запросу с инструментами')
        : t('Снимите, если сервер отвечает отказом на вызов инструмента')
    }
    const details = $('customProviderUnsupported')
    const notes = $('customProviderUnsupportedNotes')
    if (details && notes) {
      const entry = (view?.providers || []).find(item => item.id === onScreen)
      const rawNotes = (entry && entry.notes && entry.notes.length) ? entry.notes : (view?.unsupported || [])
      const translatedNotes = rawNotes.map(n => t(n))
      const textNotes = translatedNotes.length ? t('Этот путь не даёт: %s', translatedNotes.join('; ')) : ''
      notes.textContent = textNotes
      details.hidden = !textNotes
      // Раскрытие закрывается только при СМЕНИЕ показываемого пути: чужие
      // ограничения на экране висеть не должны, а своё человек мог раскрыть
      // прочитать — закрывать его на каждой перерисовке нельзя.
      if (switched) details.open = false
    }
  }

  function fillCustomModelList(models) {
    const list = $('customModelList')
    if (!list) return
    // Список приходит с чужого сервера — поэтому узлами, а не innerHTML.
    list.textContent = ''
    for (const item of models || []) {
      const option = document.createElement('option')
      option.value = String(item?.id || '')
      list.appendChild(option)
    }
  }

  function renderKeysPool(keys) {
    keysPool = keys
    el.keysPoolList.innerHTML = ''

    const summary = $('keysPoolSummary')
    if (summary) {
      const active = keys.filter(k => k.enabled).length
      summary.textContent = keys.length
        ? t('%s из %s', active, keys.length)
        : t('пусто')
      summary.classList.toggle('warn', active === 0)
    }

    if (!keys.length) {
      // Единственная строка на странице стояла по центру, пока подсказка, поле
      // и ссылка — по левому краю; глазу приходилось возвращаться.
      const emptyDiv = document.createElement('div')
      emptyDiv.className = 'key-list-empty'
      emptyDiv.textContent = t('Ключей нет — добавьте первый, иначе агентам не на чем работать.')
      el.keysPoolList.appendChild(emptyDiv)
      return
    }

    // Только ключи: имя, состояние, включение и удаление.
    // Роли и модели на ключ сняты — роли отменены давно, а модель выбирается в
    // строке ввода.
    keys.forEach(k => {
      const row = document.createElement('div')
      row.className = `key-row${k.enabled ? '' : ' is-off'}`
      // Окончания ключа в окне больше нет: `ending` несёт только слово беды
      // («ошибка», «не читается»), и для здорового ключа оно пустое.
      const showEnding = Boolean(k.ending) && !String(k.name || '').includes(String(k.ending))
      row.innerHTML = `
        <div class="key-head">
          <svg class="key-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 16.5 10.5"/></svg>
          <span class="key-id">
            <span class="key-name">${escapeHtml(k.name)}</span>
            ${showEnding ? `<span class="key-ending">${escapeHtml(t(k.ending))}</span>` : ''}
          </span>
          ${k.dead ? `<span class="key-health dead" data-tooltip="${escapeHtml(k.deadReason || '')}">${escapeHtml(t('не работает'))}</span>` : (k.cooldown ? `<span class="key-health cooldown" data-tooltip="${escapeHtml(k.cooldownReason || '')} — ${escapeHtml(t('нажмите для сброса'))}">${escapeHtml(t('отдыхает'))} (${k.cooldownRemainingSec}${escapeHtml(t('с'))})</span>` : '')}
          <span class="key-spacer"></span>
          <label class="toggle-switch" data-tooltip="${escapeHtml(t(k.enabled ? 'Ключ включён' : 'Ключ выключен'))}">
            <input type="checkbox" ${k.enabled ? 'checked' : ''} class="key-toggle-input" aria-label="${escapeHtml(t('Ключ включён'))}" />
            <span class="slider"></span>
          </label>
          <button class="key-delete-btn" data-tooltip="${escapeHtml(t('Удалить ключ'))}" aria-label="${escapeHtml(t('Удалить ключ'))}">
            <svg fill="none" class="icon small" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>
          </button>
        </div>
      `

      const cdBadge = row.querySelector('.key-health.cooldown')
      if (cdBadge) {
        cdBadge.style.cursor = 'pointer'
        cdBadge.addEventListener('click', async () => {
          if (window.electronAPI?.resetOpenRouterKeyCooldown) {
            const updated = await window.electronAPI.resetOpenRouterKeyCooldown(k.id)
            renderKeysPool(updated)
            showToast(t('Ключ «%s» возвращён в строй', k.name))
          }
        })
      }

      row.querySelector('.key-toggle-input').addEventListener('change', async e => {
        const enabled = e.target.checked
        const updated = await window.electronAPI.toggleOpenRouterKey({ id: k.id, enabled })
        renderKeysPool(updated)
        showToast(enabled ? t('Ключ «%s» включён', k.name) : t('Ключ «%s» отключён', k.name))
      })

      row.querySelector('.key-delete-btn').addEventListener('click', async () => {
        if (await askConfirm(t('Удалить ключ «%s»?', k.name))) {
          const updated = await window.electronAPI.removeOpenRouterKey(k.id)
          renderKeysPool(updated)
          showToast(t('Ключ «%s» удалён', k.name))
        }
      })

      el.keysPoolList.appendChild(row)
    })
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  const ATTACH_KIND_LABEL = {
    image: 'изображение',
    pdf: 'PDF',
    text: 'текст',
    video: 'видео',
    binary: 'файл',
    missing: 'не найден'
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0
    if (!n) return ''
    if (n < 1024) return `${n} Б`
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`
    return `${(n / 1024 / 1024).toFixed(1)} МБ`
  }

  function addAttachments(pane, items) {
    let added = 0
    for (const item of items || []) {
      if (!item?.path) continue
      if (pane.attachments.some(a => a.path === item.path)) continue
      pane.attachments.push(item)
      added++
    }
    if (added) renderAttachments(pane)
    return added
  }

  function removeAttachment(pane, path) {
    pane.attachments = pane.attachments.filter(a => a.path !== path)
    renderAttachments(pane)
  }

  function clearAttachments(pane) {
    pane.attachments = []
    renderAttachments(pane)
  }

  // A picture shown as the word "paste-1787.png" tells you nothing about which
  // picture. The bytes cannot be read here — the content policy allows only self
  // and data: URIs — so the main process hands over a downscaled JPEG.
  const thumbCache = new Map()

  async function fillThumbnail(chip, path) {
    const slot = chip.querySelector('.attachment-thumb')
    if (!slot || !path) return

    const paint = thumb => {
      if (thumb?.data) slot.style.backgroundImage = `url("data:${thumb.mime};base64,${thumb.data}")`
    }

    if (thumbCache.has(path)) return paint(thumbCache.get(path))

    try {
      const thumb = await window.electronAPI?.attachmentThumbnail?.(path)
      thumbCache.set(path, thumb || null)
      paint(thumb)
    } catch {
      thumbCache.set(path, null)
    }
  }

  // Sent messages are rebuilt wholesale, so their thumbnails are filled after.
  function fillSentThumbnails(root) {
    for (const chip of root.querySelectorAll('.attachment-chip[data-thumb], .attachment-tile[data-thumb]')) {
      const path = chip.dataset.thumb
      if (path) fillThumbnail(chip, path)
    }
  }

  // Уточнение, ждущее конца хода, показывается над строкой ввода. Без этого оно
  // просто исчезало бы из поля: человек не знал бы, принято оно или потеряно.
  function renderQueuedNotice(pane) {
    const strip = pane.dom.attachStrip
    if (!strip) return
    const existing = strip.querySelector('.queued-note')
    if (!pane.queuedMessage) {
      existing?.remove()
      if (!strip.children.length) strip.hidden = true
      return
    }
    strip.hidden = false
    const note = existing || document.createElement('div')
    note.className = 'attachment-chip queued-note'
    note.innerHTML = `
      <span class="attachment-name"></span><button type="button" class="btn-force-send" aria-label="Прервать текущий шаг и отправить сразу" data-tooltip="Прервать текущий шаг и отправить сразу">⚡ Сейчас</button>
      <button type="button" class="attachment-remove" aria-label="Отменить уточнение"><svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>`
    note.querySelector('.attachment-name').textContent =
      'После ответа: ' + pane.queuedMessage.replace(/\s+/g, ' ').slice(0, 60); const fBtn = note.querySelector('.btn-force-send'); if (fBtn) fBtn.onclick = () => { const id = pane.requestId || pane.liveTurnsByChat?.get(pane.chatId)?.requestId; if (id && pane.queuedMessage) { window.electronAPI.steerAgent?.({ requestId: id, text: pane.queuedMessage, force: true }); showToast(t('Прерываю шаг — передаю указание')) } }
    note.querySelector('.attachment-remove').onclick = () => {
      pane.queuedMessage = ''
      if (pane.chatId) pane.queuedByChat?.delete(pane.chatId)
      renderQueuedNotice(pane)
    }
    if (!existing) strip.prepend(note)
  }

  function renderAttachments(pane) {
    const strip = pane.dom.attachStrip
    if (!strip) return

    strip.innerHTML = ''
    // Полосу делит с вложениями уточнение, ждущее конца хода: перерисовка
    // вложений не должна его стирать. Снимок «только для хода» (modelOnly) в строке ввода не рисуется: человек не прикладывал его.
    const visible = pane.attachments.filter(item => !item.modelOnly)
    strip.hidden = visible.length === 0 && !pane.queuedMessage
    if (!visible.length) { renderQueuedNotice(pane); return }

    for (const item of visible) {
      // Картинка и вставленный текст — плиткой, остальные файлы — полосой с именем (paste-tiles.js).
      if (OnlyonePasteTiles.isTile(item)) {
        const tile = OnlyonePasteTiles.buildTile(document, item, { t, onRemove: () => removeAttachment(pane, item.path) })
        if (item.kind === 'image') fillThumbnail(tile, item.path)
        strip.appendChild(tile)
        continue
      }
      const chip = document.createElement('div')
      chip.className = `attachment-chip kind-${item.kind}${item.error ? ' has-error' : ''}`
      chip.dataset.tooltip = item.error ? `${item.path} — ${item.error}` : item.path
      chip?.removeAttribute?.('title')

      const meta = [t(ATTACH_KIND_LABEL[item.kind] || item.kind), formatBytes(item.size)]
        .filter(Boolean)
        .join(' · ')

      chip.innerHTML = `
        ${item.kind === 'image' ? '<span class="attachment-thumb"></span>' : ''}
        <span class="attachment-name">${escapeHtml(item.name)}</span>
        <span class="attachment-meta">${escapeHtml(item.error || meta)}</span>
        <button type="button" class="attachment-remove" aria-label="Убрать вложение">
          <svg fill="none" class="icon small" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>
        </button>
      `
      if (item.kind === 'image') fillThumbnail(chip, item.path)

      chip.querySelector('.attachment-remove').addEventListener('click', () => removeAttachment(pane, item.path))
      strip.appendChild(chip)
    }
    renderQueuedNotice(pane)
  }

  async function pickAttachments(pane = activePane || panes[0]) {
    if (!window.electronAPI?.pickAttachments) return
    try {
      const picked = await window.electronAPI.pickAttachments()
      const added = addAttachments(pane, picked)
      if (added) showToast(added === 1 ? 'Файл прикреплён' : `Прикреплено файлов: ${added}`)
    } catch (err) {
      showToast(err?.message || 'Не удалось прикрепить файл', true)
    }
  }

  // Paths named in the message are attached automatically, but shown as chips so
  // it is never a surprise what got sent.
  async function attachPathsFromText(pane, text) {
    if (!window.electronAPI?.scanMessagePaths) return
    try {
      const found = await window.electronAPI.scanMessagePaths(text)
      const added = addAttachments(pane, found)
      if (added) showToast(added === 1 ? 'Найден файл по пути' : `Найдено файлов по пути: ${added}`)
    } catch {
      /* a path that resolves to nothing is not an error worth reporting */
    }
  }

  function setupMarkEvents() {
    document.addEventListener('click', e => {
      const button = e.target.closest?.('.mark-btn')
      if (button) pokeMark(button)
    })

    document.addEventListener('dblclick', e => {
      const button = e.target.closest?.('.mark-btn')
      if (button) pokeMark(button)
    })

    // mouseenter/leave do not bubble, so delegate through mouseover/mouseout.
    document.addEventListener('mouseover', e => {
      const button = e.target.closest?.('.mark-btn')
      if (button && !button.contains(e.relatedTarget)) markEnter(button)
    })

    document.addEventListener('mouseout', e => {
      const button = e.target.closest?.('.mark-btn')
      if (button && !button.contains(e.relatedTarget)) markLeave(button)
    })
  }

  function setupAttachmentEvents() {
    for (const pane of panes) setupPaneDrop(pane)
  }

  function setupPaneDrop(pane) {
    const card = pane.dom.card
    if (!card) return

    const stopAll = e => { e.preventDefault(); e.stopPropagation() }

    card.addEventListener('dragover', e => {
      stopAll(e)
      card.classList.add('drop-target')
    })
    card.addEventListener('dragleave', e => {
      if (card.contains(e.relatedTarget)) return
      card.classList.remove('drop-target')
    })
    card.addEventListener('drop', async e => {
      stopAll(e)
      card.classList.remove('drop-target')

      // Electron exposes the real filesystem path on dropped files.
      const paths = [...(e.dataTransfer?.files || [])]
        .map(f => window.electronAPI?.getPathForFile?.(f) || f.path)
        .filter(Boolean)
      if (!paths.length) return

      try {
        const described = await window.electronAPI.describeAttachments(paths)
        const added = addAttachments(pane, described)
        if (added) showToast(added === 1 ? 'Файл прикреплён' : `Прикреплено файлов: ${added}`)
      } catch (err) {
        showToast(err?.message || 'Не удалось прикрепить файл', true)
      }
    })
  }

  // Shows what is actually encrypted on disk rather than asserting it in prose.
  async function refreshStorageStatus() {
    if (!window.electronAPI?.getStorageStatus || !el.storageRows) return
    try {
      const status = await window.electronAPI.getStorageStatus()
      const available = Boolean(status?.encryptionAvailable)

      if (el.storageBadge) {
        el.storageBadge.textContent = available ? "шифруется" : "без шифрования"
        el.storageBadge.classList.toggle("warn", !available)
      }

      // Ключи своих подключений шифруются тем же шифром, но отметка о способе
      // упаковки у каждой записи своя: одно base64-обёрнутое ключом ломает
      // общую строку «зашифровано», поэтому оно называется отдельно.
      const customKeys = status?.encrypted?.customProviders || {}
      const rows = [
        ["Ключи API", available],
        ...(customKeys.count
          ? [[`Свои подключения (${customKeys.count})`, Boolean(customKeys.encrypted)]]
          : []),
        ["История переписки", Boolean(status?.encrypted?.conversations)],
        ["Скиллы", Boolean(status?.encrypted?.skills)],
        ["Настройки MCP", Boolean(status?.encrypted?.mcpServers)]
      ]

      el.storageRows.innerHTML = rows.map(([name, ok]) => `
        <div class="mode-row">
          <span class="storage-dot${ok ? "" : " off"}"></span>
          <span class="mode-name">${escapeHtml(name)}</span>
          <span class="mode-desc">${ok ? "зашифровано" : "пока нет данных"}</span>
        </div>
      `).join("")
    } catch (err) {
      console.warn("Не удалось прочитать статус хранилища:", err)
    }
  }

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  // A project groups conversations and carries its own workspace folder. That
  // second part is the useful one for a code tool: opening a project points the
  // agent at the right directory instead of leaving it on whatever was set last.

  let projects = []
  let activeProjectId = null

  async function loadProjects() {
    if (!window.electronAPI?.getProjects) return
    try {
      const saved = await window.electronAPI.getProjects()
      projects = Array.isArray(saved) ? saved : []
    } catch (err) {
      console.error('Не удалось загрузить проекты:', err)
      projects = []
    }
  }

  function saveProjects() {
    window.electronAPI?.setProjects?.(projects).catch(err =>
      console.error('Не удалось сохранить проекты:', err)
    )
  }

  function currentProject() {
    return projects.find(p => p.id === activeProjectId) || null
  }

  // Projects used to have their own list in the sidebar, above a separate chat
  // history. That was two lists for one thing, plus an «Все диалоги» row that
  // duplicated the projects page. Now a project is a folder in the tree, and
  // this name survives only because a dozen call sites use it.
  function renderProjects() {
    // The count lives in the nav, so it has to be right whenever projects change
    // — not only while the projects page happens to be open.
    const navBadge = $('projectsBadge')
    setNavCount(navBadge, projects.length)

    renderChatHistory()
    if (el.projectsView?.classList.contains('active')) refreshProjectsPage()
  }

  async function openProject(id) {
    activeProjectId = id
    renderProjects()
    renderChatHistory()

    // Switching project switches the folder the agent may touch.
    const project = currentProject()
    if (project?.workspacePath && project.workspacePath !== workspaceState.path) {
      workspaceState.path = project.workspacePath
      try {
        await window.electronAPI.setWorkspace(workspaceState)
        await refreshWorkspace()
      } catch (err) {
        showToast(err?.message || 'Не удалось открыть папку проекта', true)
      }
    }
  }

  async function createProject() {
    switchTab('projects')
    projectsPageOf()?.newProject()
  }

  async function deleteProject(id, name) {
    const inProject = conversations.filter(c => c.projectId === id).length
    const question = inProject
      ? `Удалить проект «${name}»? ${inProject} диалог(ов) останутся, но перестанут быть в проекте.`
      : `Удалить проект «${name}»?`
    if (!(await askConfirm(question))) return

    projects = projects.filter(p => p.id !== id)
    // Conversations outlive their project: losing the grouping must not lose
    // the history.
    conversations.forEach(c => { if (c.projectId === id) c.projectId = null })
    saveProjects()
    saveConversations()

    if (activeProjectId === id) activeProjectId = null
    renderProjects()
    renderChatHistory()
    showToast(`Проект «${name}» удалён`)
  }

  // ---------------------------------------------------------------------------
  // Split view
  // ---------------------------------------------------------------------------
  // A second pane for reading another conversation while writing in this one.
  // Read-only on purpose: two live composers would mean two of every piece of
  // streaming state, and that is a much larger change than the value warrants.

  let splitChatId = null
  // Боковая панель, свёрнутая ради двух чатов, разворачивается обратно, когда
  // второй чат закрыли. Но только если свернули её мы: свёрнутую руками не трогаем.
  let sidebarCollapsedBySplit = false

  // Какая из двух панелей сейчас принимает выбор из боковой панели и горячие
  // клавиши. Раньше это нигде не было видно, и чат из списка слева открывался
  // «не там».
  function markActivePane() {
    const split = document.body.classList.contains('split-open')
    $('chatView')?.classList.toggle('pane-active', split && activePane === panes[0])
    el.splitPane?.classList.toggle('pane-active', split && activePane === panes[1])
  }

  // Вторая панель окна закрывается — вместе с ней уходит и её работа с экрана:
  // панель задач осталась бы висеть, показывая чат, которого больше не видно.
  function toggleSplitView(open) {
    const pane = el.splitPane
    if (!pane) return
    const next = open ?? pane.hidden
    if (next && document.body.classList.contains('task-center-open')) switchTab('chats')
    pane.hidden = !next
    if (el.splitResizer) el.splitResizer.hidden = !next
    document.body.classList.toggle('split-open', next)
    el.splitViewBtn?.classList.toggle('active', next)
    if (next) {
      // Два чата рядом с полной боковой панелью получали по трети окна каждый.
      if (!document.body.classList.contains('sidebar-narrow')) {
        applySidebarWidth(true)
        sidebarCollapsedBySplit = true
      }
      // Панель работы открыта с прошлого хода — при двух чатах она отнимала у
      // них ещё треть окна. Закрываем; кнопка в заголовке вернёт её, и тогда
      // место под неё освободится, а не будет отнято у правого чата.
      const owner = panelPane()
      if (owner?.tasksOpen) toggleTasksPanel(owner, false)
      applySplitWidth(loadSplitWidth())
      // Ширина считается от ширины окна без боковой панели, а та сворачивается
      // с анимацией: первый замер берёт её прежнюю ширину. Второй — после.
      setTimeout(() => { if (!el.splitPane.hidden) applySplitWidth(loadSplitWidth()) }, 280)
      renderSplitPane()
    } else if (sidebarCollapsedBySplit) {
      applySidebarWidth(false)
      sidebarCollapsedBySplit = false
    }
    markActivePane()
    // Закрыли вторую панель — её работа уходит с экрана вместе с ней: панель
    // задач оставалась висеть, показывая чат, которого больше не видно.
    if (!next && panes[0]) {
      setActivePane(panes[0])
      // Скрытая боковая панель больше не «держит» свой чат: иначе пустой «Новый
      // диалог», созданный при открытии сплита, висит в списке до конца сессии (Н7).
      if (panes[1]) panes[1].chatId = null
    }
    refreshTasksPanel()
  }

  // ---------------------------------------------------------------------------
  // Split divider
  // ---------------------------------------------------------------------------
  // The two chats are rarely wanted at a fixed ratio: reading one while writing
  // in the other needs a wide reader, comparing two answers needs them even.

  const SPLIT_WIDTH_KEY = '1code_split_width'
  const SPLIT_MIN = 320
  const SPLIT_MIN_MAIN = 420

  function loadSplitWidth() {
    const saved = Number(localStorage.getItem(SPLIT_WIDTH_KEY))
    return Number.isFinite(saved) && saved > 0 ? saved : null
  }

  function splitBounds() {
    const total = el.splitPane?.parentElement?.getBoundingClientRect().width || window.innerWidth
    const max = Math.max(SPLIT_MIN, total - SPLIT_MIN_MAIN)
    return { min: Math.min(SPLIT_MIN, max), max, total }
  }

  function applySplitWidth(px) {
    if (!el.splitPane) return
    const { min, max, total } = splitBounds()
    // По умолчанию поровну: два чата открывают, чтобы работать в обоих, а не
    // чтобы один подглядывал из щели в треть окна.
    const width = Math.round(Math.min(max, Math.max(min, px || total / 2)))
    // The stylesheet's percentage width and max-width would both fight this.
    el.splitPane.style.flex = `0 0 ${width}px`
    el.splitPane.style.width = `${width}px`
    el.splitPane.style.maxWidth = 'none'
    return width
  }

  function setupSplitResizer() {
    const bar = el.splitResizer
    if (!bar || !el.splitPane) return

    let dragging = false

    const widthFromPointer = clientX => {
      const parent = el.splitPane.parentElement.getBoundingClientRect()
      return parent.right - clientX
    }

    const onMove = e => {
      if (!dragging) return
      e.preventDefault()
      applySplitWidth(widthFromPointer(e.clientX))
    }

    const stop = () => {
      if (!dragging) return
      dragging = false
      document.body.classList.remove('resizing-split')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      localStorage.setItem(SPLIT_WIDTH_KEY, String(el.splitPane.getBoundingClientRect().width))
    }

    bar.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      dragging = true
      document.body.classList.add('resizing-split')
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', stop)
      e.preventDefault()
    })

    // Double-click evens them out — the ratio people want most often.
    bar.addEventListener('dblclick', () => {
      const parent = el.splitPane.parentElement.getBoundingClientRect()
      applySplitWidth(parent.width / 2)
      localStorage.setItem(SPLIT_WIDTH_KEY, String(el.splitPane.getBoundingClientRect().width))
    })

    // Keyboard, because a 6px drag target is not a reasonable only option.
    bar.addEventListener('keydown', e => {
      const step = e.shiftKey ? 64 : 16
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const now = el.splitPane.getBoundingClientRect().width
      applySplitWidth(e.key === 'ArrowLeft' ? now + step : now - step)
      localStorage.setItem(SPLIT_WIDTH_KEY, String(el.splitPane.getBoundingClientRect().width))
    })

    // A narrowed window must not leave the main chat as a sliver.
    window.addEventListener('resize', () => {
      if (!el.splitPane.hidden) applySplitWidth(el.splitPane.getBoundingClientRect().width)
    })
  }

  function renderSplitPane() {
    const pane = panes[1]
    if (!pane) return

    let others = conversations.filter(c => c.id !== panes[0]?.chatId)

    // Opening the split with a single conversation used to hand back a dead
    // panel — composer inert, nothing to show. A second chat is the entire
    // point of the view, so make one instead of showing nothing.
    if (!others.length) {
      const fresh = createNewChat(pane, t('Новый диалог'))
      splitChatId = fresh.id
      others = [fresh]
    }

    if (!splitChatId || !others.some(c => c.id === splitChatId)) {
      splitChatId = others[0]?.id || null
    }

    // There is no chooser here: chats are picked in the sidebar on the left,
    // and the header just names what this pane is showing.
    if (el.splitChatLabel) {
      const chat = conversations.find(c => c.id === splitChatId)
      el.splitChatLabel.textContent = chat?.title || t('Второй чат')
      el.splitChatLabel.dataset.tooltip = chat?.title || ''
      el.splitChatLabel?.removeAttribute?.('title')
    }

    if (splitChatId && pane.chatId !== splitChatId) selectChat(pane, splitChatId)
    else renderMessages(pane)
  }

  // ---------------------------------------------------------------------------
  // Settings sections
  // ---------------------------------------------------------------------------
  // Six long sections in one scroll meant hunting for the language selector past
  // the whole key pool. They are pages now, picked from a list on the left.

  let settingsTab = 'keys'

  function showSettingsTab(key) {
    const panels = [...document.querySelectorAll('[data-settings-panel]')]
    if (!panels.length) return
    const known = panels.some(p => p.dataset.settingsPanel === key)
    settingsTab = known ? key : panels[0].dataset.settingsPanel

    for (const panel of panels) {
      panel.hidden = panel.dataset.settingsPanel !== settingsTab
    }
    for (const tab of document.querySelectorAll('[data-settings-tab]')) {
      const active = tab.dataset.settingsTab === settingsTab
      tab.classList.toggle('active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
      // Клавиатура ходит по списку разделов, а не по каждой кнопке подряд.
      tab.tabIndex = active ? 0 : -1
      // Название раздела живёт в шапке окна: на самой странице оно было третьим
      // повтором одного и того же слова и съедало строку.
      if (active) {
        const title = $('settingsTitle')
        if (title) title.textContent = tab.dataset.settingsTitle || tab.textContent.trim() || t('Настройки')
      }
    }
    // Прокручивается вся страница настроек, а не тело: новая вкладка открывается сверху
    for (const box of document.querySelectorAll('.settings-body, #settingsModal .modal-settings')) box.scrollTop = 0
    // Пока вкладка была скрыта, высота «О себе» мерилась как ноль
    if (settingsTab === 'personal') fitAbout()
    // Состояние ffmpeg могло измениться, пока окно было закрыто: поставили сами.
    if (settingsTab === 'agent') videoSettings?.refresh()
  }

  // ---------------------------------------------------------------------------
  // Личное
  // ---------------------------------------------------------------------------
  // Имя, рассказ о себе и тон живут в главном процессе: они уходят в системную
  // часть каждого запроса. Тема, акцент и плотность — тоже там, чтобы всё
  // личное лежало в одном месте и переживало переустановку вместе с настройками.

  const ACCENTS = [
    { id: '', name: 'Как было', value: '#e08c62' },
    { id: '#d8a05a', name: 'Песок', value: '#d8a05a' },
    { id: '#8fb79e', name: 'Шалфей', value: '#8fb79e' },
    { id: '#8aa6c8', name: 'Сталь', value: '#8aa6c8' },
    { id: '#b49ad4', name: 'Ирис', value: '#b49ad4' },
    { id: '#c4786e', name: 'Кирпич', value: '#c4786e' }
  ]

  let personal = { name: '', about: '', role: '', focus: [], tone: 'default', theme: 'dark', accent: '',
    density: 'comfortable', codeScheme: 'default' }

  // Кто человек и на чём упор (вступительный экран и Персонализация). Уходит
  // модели в раздел «О пользователе»; подписи для модели — в главном процессе.
  const PERSONAL_ROLES = [
    ['developer', 'Developer / Engineer'], ['designer', 'Designer'], ['product', 'Product Manager'], ['analyst', 'Analyst / Researcher'],
    ['marketing', 'Marketer / Content Creator'], ['founder', 'Founder / Business Owner'], ['manager', 'Team Lead'],
    ['consultant', 'Consultant / Freelancer'], ['operations', 'Operations / Project Manager'], ['educator', 'Educator / Mentor'],
    ['student', 'Student'], ['other', 'Other']
  ]
  const PERSONAL_FOCUS = [
    ['code', 'Код'], ['design', 'Дизайн и интерфейсы'], ['research', 'Исследования и анализ'],
    ['writing', 'Тексты'], ['automation', 'Автоматизация и workflow'], ['learning', 'Обучение']
  ]

  // --- Вид вкладки «Персонализация» -------------------------------------------
  // Переключатели и карточки темы рисуются поверх скрытых <select>: списки
  // остаются источником значения, их слушают сохранение и проверки, а человек
  // видит кнопки. Нажатие ставит значение списку и шлёт change — дальше всё
  // идёт прежним путём.
  const THEME_CARDS = [['dark', 'Тёмная'], ['light', 'Светлая'], ['system', 'Как в системе']]

  function paintSegments() {
    for (const host of document.querySelectorAll('.seg[data-seg-for]')) {
      const select = $(host.dataset.segFor)
      if (!select) continue
      host.innerHTML = [...select.options].map(option =>
        `<button type="button" role="radio" data-value="${escapeHtml(option.value)}" aria-checked="${option.value === select.value}">${escapeHtml(t(option.textContent.trim()))}</button>`).join('')
    }
    const cards = $('themeCards')
    const theme = $('personalTheme')?.value || 'dark'
    if (cards) {
      cards.innerHTML = THEME_CARDS.map(([id, label]) => `
        <button type="button" class="theme-card theme-card--${id}" role="radio" data-theme-card="${id}" aria-checked="${id === theme}">
          <span class="theme-preview" aria-hidden="true"><span class="tp-side"></span><span class="tp-main"><span class="tp-line"></span><span class="tp-line tp-short"></span><span class="tp-input"></span></span></span>
          <span class="theme-card-label">${escapeHtml(t(label))}</span>
        </button>`).join('')
    }
  }

  // Профиль: буква имени, имя и итог знакомства одной строкой.
  function paintProfile() {
    const name = String(personal.name || '').trim()
    const avatar = $('profileAvatar')
    // Без имени — силуэт, как у пункта «Персонализация» в меню настроек.
    if (avatar) avatar.innerHTML = name ? escapeHtml(name[0].toUpperCase())
      : '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>'
    const about = $('personalAbout')
    const count = $('personalAboutCount')
    if (about && count) count.textContent = `${about.value.length} / 2000`
  }

  // «О себе» растёт вместе с текстом: пустое — две строки, без уголка, за
  // который его можно было растянуть в пустую простыню.
  function fitAbout() {
    const about = $('personalAbout')
    if (!about) return
    // Скрытое поле меряется нулём: высоту оставляем стилям, перемерим при показе вкладки
    if (!about.getClientRects().length) { about.style.height = ''; return }
    about.style.height = 'auto'
    about.style.height = Math.min(about.scrollHeight + 2, 320) + 'px'
  }

  function paintPersonalLook() {
    paintSegments()
    paintProfile()
    fitAbout()
  }

  // Внешность применяется к корню документа: дальше всё решают токены, и ни
  // одно правило в стилях не знает, какая сейчас тема.
  function applyAppearance() {
    const root = document.documentElement
    const dark = personal.theme === 'dark' ||
      (personal.theme === 'system' && !window.matchMedia('(prefers-color-scheme: light)').matches)
    root.dataset.theme = dark ? 'dark' : 'light'
    root.dataset.density = personal.density === 'compact' ? 'compact' : 'comfortable'
    if (personal.accent) root.style.setProperty('--accent-user', personal.accent)
    else root.style.removeProperty('--accent-user')
    root.dataset.accent = personal.accent ? 'custom' : ''
    // Подсветка кода — отдельная ось от темы: у каждой схемы свои значения и для
    // тёмного, и для светлого, поэтому переключение темы её не сбрасывает.
    root.dataset.code = personal.codeScheme === 'default' ? '' : personal.codeScheme
  }

  // Приветствие пустого чата: по времени суток и по имени из
  // Персонализации. Без имени — те же фразы без обращения. Две фразы на каждое
  // время суток, чтобы экран не был одинаковым изо дня в день.
  const GREETINGS = {
    ru: {
      morning: ['Доброе утро{, name}', 'С чего начнём утро{, name}?'],
      day: ['Добрый день{, name}', 'Над чем работаем{, name}?'],
      evening: ['Добрый вечер{, name}', 'Что делаем сегодня вечером{, name}?'],
      night: ['Доброй ночи{, name}', 'Ночная смена{, name}?']
    },
    en: {
      morning: ['Good morning{, name}', 'Where shall we start{, name}?'],
      day: ['Good afternoon{, name}', 'What are we working on{, name}?'],
      evening: ['Good evening{, name}', 'What’s on tonight{, name}?'],
      night: ['Good night{, name}', 'Night shift{, name}?']
    }
  }
  let greetingPick = 0

  function greetingText(date = new Date()) {
    const hour = date.getHours()
    const part = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'day' : hour >= 18 && hour < 23 ? 'evening' : 'night'
    const list = (GREETINGS[uiLang] || GREETINGS.ru)[part]
    const name = String(personal?.name || '').trim().slice(0, 40)
    return list[greetingPick % list.length].replace('{, name}', name ? `, ${name}` : '')
  }

  function paintGreeting(fresh = false) {
    let text
    // До разбора этого места при запуске константы ещё не объявлены; тогда
    // приветствие просто останется из разметки до загрузки Персонализации.
    try {
      if (fresh) greetingPick = Math.floor(Math.random() * 2)
      text = greetingText()
    } catch { return }
    const brandPath = $('appGlyph')?.querySelector('path')
    if (brandPath) for (const spark of document.querySelectorAll('.hero-spark')) {
      if (!spark.firstElementChild) spark.appendChild(brandPath.cloneNode(true))
    }
    // Главный экран называет место работы — проект или папку;
    // приветствие остаётся, пока места нет.
    let place = ''
    try {
      const chat = panes[0] ? chatOf(panes[0]) : null
      const project = chat?.projectId ? projects.find(p => p.id === chat.projectId) : null
      place = project?.name || folderLeaf(chatPlaceFolder(chat)) || ''
    } catch { place = '' }
    if (place) text = place
    for (const title of document.querySelectorAll('.welcome-hero .hero-greeting')) {
      if (title.textContent !== text) title.textContent = text
    }
  }

  async function loadPersonal() {
    try { personal = { ...personal, ...(await window.electronAPI?.getPersonal?.() || {}) } } catch {}
    applyAppearance()
    if ($('personalName')) $('personalName').value = personal.name || ''
    if ($('personalAbout')) $('personalAbout').value = personal.about || ''
    if ($('personalTheme')) $('personalTheme').value = personal.theme || 'dark'
    if ($('personalCode')) $('personalCode').value = personal.codeScheme || 'default'
    paintPersonalLook()
    paintGreeting()
  }

  let personalSaveTimer = null
  let personalSaveRevision = 0
  let personalSaveQueue = Promise.resolve()
  function savePersonal(patch, { now = false } = {}) {
    personal = { ...personal, ...patch }
    const snapshot = { ...personal }
    const revision = ++personalSaveRevision
    applyAppearance()
    clearTimeout(personalSaveTimer)
    const send = () => {
      personalSaveTimer = null
      personalSaveQueue = personalSaveQueue.then(async () => {
        try {
          const saved = await window.electronAPI.setPersonal(snapshot)
          if (revision === personalSaveRevision) personal = { ...personal, ...saved }
        } catch (error) {
          showToast(cleanErrorText(error), true)
        }
      })
      return personalSaveQueue
    }
    // Текст сохраняется не на каждую букву: иначе запись на диск идёт по разу
    // на нажатие клавиши. Выбор из списка — сразу.
    if (now) send()
    else personalSaveTimer = setTimeout(send, 600)
  }

  function setupPersonal() {
    $('personalName')?.addEventListener('input', event => {
      savePersonal({ name: event.target.value })
      paintGreeting()
      paintProfile()
    })
    $('personalAbout')?.addEventListener('input', event => {
      savePersonal({ about: event.target.value })
      fitAbout()
      paintProfile()
    })
    $('personalTheme')?.addEventListener('change', event => { savePersonal({ theme: event.target.value }, { now: true }); paintSegments() })
    // Язык меняет свой обработчик; переключатель только перерисовывается.
    $('languageSelect')?.addEventListener('change', () => setTimeout(paintPersonalLook, 0))
    // Переключатели и карточки темы — обёртки над скрытыми списками.
    $('settingsModal')?.addEventListener('click', event => {
      const option = event.target.closest('.settings-section .seg [data-value]')
      const card = event.target.closest('[data-theme-card]')
      const select = option ? $(option.closest('.seg').dataset.segFor) : card ? $('personalTheme') : null
      if (!select) return
      const value = option ? option.dataset.value : card.dataset.themeCard
      if (select.value === value) return
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    $('personalCode')?.addEventListener('change', event => savePersonal({ codeScheme: event.target.value }, { now: true }))
    // «Как в системе» должно следовать за системой, а не за моментом запуска.
    window.matchMedia('(prefers-color-scheme: light)')
      .addEventListener('change', () => { if (personal.theme === 'system') applyAppearance() })
  }

  function setupSettingsTabs() {
    const tabs = [...document.querySelectorAll('[data-settings-tab]')]
    if (!tabs.length) return

    tabs.forEach(tab => {
      tab.addEventListener('click', () => showSettingsTab(tab.dataset.settingsTab))
      tab.addEventListener('keydown', e => {
        const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
        if (!dir) return
        e.preventDefault()
        // Скрытые вкладки (пока убранный «Телефон») стрелками не обходятся
        const shown = tabs.filter(item => !item.hidden)
        const next = shown[(shown.indexOf(tab) + dir + shown.length) % shown.length]
        next.focus()
        showSettingsTab(next.dataset.settingsTab)
      })
    })

    showSettingsTab(settingsTab)
  }

  // ---------------------------------------------------------------------------
  // Updates
  // ---------------------------------------------------------------------------
  // Reinstalling by hand after every build is what this replaces.

  const UPDATE_LABELS = {
    idle: 'Проверка не запускалась',
    checking: 'Проверяю…',
    current: 'Установлена последняя версия',
    available: 'Доступна новая версия',
    downloading: 'Скачиваю…',
    ready: 'Обновление готово к установке',
    error: 'Не удалось проверить'
  }

  function renderUpdateState(state = {}) {
    const status = state.status || 'idle'
    const statusEl = $('updateStatusText')
    const badge = $('updateVersionBadge')
    const bar = $('updateProgressBar')
    const wrap = $('updateProgressWrap')
    const notes = $('updateNotes')
    const actions = $('updateActions')
    const downloadBtn = $('downloadUpdateBtn')
    const installBtn = $('installUpdateBtn')
    const checkBtn = $('checkUpdateBtn')
    if (!statusEl) return

    // «v1.0.9» рядом со строкой состояния читалось как версия, которую нашли.
    if (badge && state.currentVersion) badge.textContent = t('сейчас %s', state.currentVersion)

    let text = t(UPDATE_LABELS[status] || UPDATE_LABELS.idle)
    if (status === 'available' && state.version) text = t('Доступна версия %s', state.version)
    if (status === 'downloading') text = t('Скачиваю… %s%', state.percent || 0)
    if (status === 'ready' && state.version) text = t('Версия %s готова к установке', state.version)
    if (status === 'error') text = state.error || t(UPDATE_LABELS.error)

    statusEl.textContent = text
    statusEl.classList.toggle('is-error', status === 'error')
    statusEl.classList.toggle('is-good', status === 'current' || status === 'ready')

    if (wrap) wrap.hidden = status !== 'downloading'
    if (bar) bar.style.width = (state.percent || 0) + '%'

    if (notes) {
      const hasNotes = Boolean(state.notes) && (status === 'available' || status === 'ready')
      notes.hidden = !hasNotes
      notes.textContent = hasNotes ? state.notes : ''
    }

    paintUpdatePill(state)

    if (downloadBtn) downloadBtn.hidden = status !== 'available'
    if (installBtn) installBtn.hidden = status !== 'ready'
    if (actions) actions.hidden = downloadBtn?.hidden !== false && installBtn?.hidden !== false
    if (checkBtn) checkBtn.disabled = status === 'checking' || status === 'downloading'
  }

  // Плашка показывается только когда обновление уже лежит на диске: до этого
  // человеку нечего решать, а «идёт загрузка» в углу — шум.
  function paintUpdatePill(state = {}) {
    const pill = $('updateReadyPill')
    if (!pill) return
    const ready = state.status === 'ready'
    pill.hidden = !ready
    if (!ready) return
    const text = $('updateReadyPillText')
    if (text) text.textContent = state.version ? t('Обновить до') + ' ' + state.version : t('Обновление готово')
    pill.dataset.tooltip = t('Приложение перезапустится и обновится без вопросов. Можно не нажимать: обновление встанет при выходе.')
    pill?.removeAttribute?.('title')
  }

  async function installUpdateNow() {
    // Лишний вопрос — тот самый «ок, далее, завершить», от которого уходим.
    // Спрашиваем только когда есть что потерять: идёт ответ модели.
    if (panes.some(pane => pane.generating || pane.preparing)) {
      if (!await askConfirm(t('Идёт ответ модели. Прервать его и обновиться?'), t('Обновить'))) return
    }
    try {
      await window.electronAPI.installUpdate()
    } catch (err) {
      showToast(err?.message || t('Не удалось установить обновление'), true)
    }
  }

  async function refreshUpdateState() {
    const state = await window.electronAPI?.getUpdateState?.()
    if (!state) return
    if ($('updateAutoCheck')) $('updateAutoCheck').checked = state.autoCheck !== false
    renderUpdateState(state)
  }

  function setupUpdates() {
    window.electronAPI?.onUpdateState?.(state => renderUpdateState(state))

    $('checkUpdateBtn')?.addEventListener('click', async () => {
      try {
        await window.electronAPI.checkForUpdate()
      } catch (err) {
        showToast(err?.message || 'Не удалось проверить обновления', true)
      }
    })

    $('downloadUpdateBtn')?.addEventListener('click', async () => {
      try {
        await window.electronAPI.downloadUpdate()
      } catch (err) {
        showToast(err?.message || 'Не удалось скачать обновление', true)
      }
    })

    $('installUpdateBtn')?.addEventListener('click', installUpdateNow)
    $('updateReadyPill')?.addEventListener('click', installUpdateNow)

    $('updateAutoCheck')?.addEventListener('change', async e => {
      try {
        const wanted = e.target.checked
        const saved = await window.electronAPI.setUpdateSettings({ autoCheck: wanted })
        e.target.checked = Boolean(saved.autoCheck)
        if (wanted && !saved.autoCheck) showToast(t('Автоматическое обновление пока недоступно'), true)
      } catch (err) {
        showToast(err?.message || 'Не удалось сохранить настройку', true)
      }
    })

    refreshUpdateState()
  }

  // ---------------------------------------------------------------------------
  // Context ring
  // ---------------------------------------------------------------------------
  // How full the model's context is, and nothing else — no plan, no quota, no
  // spend. The number that matters is how much room is left before the oldest
  // part of the conversation starts falling out.

  const CTX_RING_CIRCUMFERENCE = 2 * Math.PI * 7.5
  // Whichever pane the ring is currently speaking for.
  let ringPane = null

  // Real usage is only known after a turn. Before that, four characters per
  // token is the usual rough conversion for mixed Russian and code, and it is
  // honest enough for a gauge.
  function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4)
  }

  function contextLimit() {
    const record = findCatalogModel(selectedModel?.id)
    return Number(record?.contextLength || record?.context_length || selectedModel?.contextLength || 0) || 0
  }

  function contextUsed(pane) {
    // What is typed but not yet sent counts too, so an empty conversation is
    // not an early exit — that skipped the composer entirely.
    const typed = estimateTokens(pane.dom.textarea?.value)
    const chat = chatOf(pane)
    if (!chat || !chat.messages.length) return typed

    // Turn totals sum every tool-loop request and are NOT context occupancy.
    // Use only a separately recorded context measurement; old histories fall
    // back to estimating the transcript that is actually sent to the model.
    let base = 0
    let countedFrom = 0
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const msg = chat.messages[i]
      if (msg.role === 'assistant' && Number(msg.contextTokens) > 0) {
        base = Number(msg.contextTokens)
        countedFrom = i + 1
        break
      }
    }

    let extra = 0
    for (let i = countedFrom; i < chat.messages.length; i++) {
      const msg = chat.messages[i]
      extra += estimateTokens(msg.prompt || msg.content)
    }

    // Nothing measured yet: estimate the whole conversation.
    if (!base) {
      const mapped = chat.messages.map(msg => ({ role: msg.role, content: msg.prompt || msg.content }))
      // Сжатая середина в счёт не входит: кольцо обязано показывать то, что
      // реально лёгло в окно, а не весь архив.
      const sent = compressionView().applyCompression(mapped, chat.compression)
      extra = sent.reduce((sum, msg) => sum + estimateTokens(msg.content), 0)
    }

    // Пока ход идёт, отвечающего сообщения в истории ещё нет — оно сохраняется
    // в конце. Кольцо считалось только по сохранённому и потому всю работу
    // стояло на месте, хотя окно в этот момент как раз и заполняется. Живое
    // измерение приходит с каждым шагом; берём большее из двух.
    const live = Number(pane.contextTokens || 0)
    return Math.max(base + extra, live) + typed
  }

  // Сжатие длинного разговора: здесь только раскладка, сводку пишет
  // модель в главном процессе. Язык окна и фильтр разметки передаются наружу,
  // чтобы модуль можно было проверить и без окна.
  let compressionInstance = null
  // Модуль подключён в index.html до app.js — за этим следят test-app-split и
  // test-suite-hygiene. Песочницы соседних наборов вырезают из app.js куски и
  // своего файла не видят, поэтому для них здесь честный обход: история уходит
  // целиком, без сжатия, а не падает на пустом месте.
  const COMPRESSION_BYPASS = {
    applyCompression: history => history,
    isCompressionFresh: () => false,
    lineHtml: () => ''
  }
  function compressionView() {
    if (!compressionInstance) {
      if (typeof createConversationCompression !== 'function') return COMPRESSION_BYPASS
      compressionInstance = createConversationCompression({ t, escapeHtml })
    }
    return compressionInstance
  }

  function renderContextRing(pane = ringPane || activePane || panes[0]) {
    ringPane = pane
    const arc = $('contextRingArc')
    const button = $('contextRingBtn')
    if (!arc || !button || !pane) return

    const limit = contextLimit()
    const used = contextUsed(pane)
    const share = limit > 0 ? Math.min(1, used / limit) : 0
    const percent = Math.round(share * 100)
    // Строки «папка · модель · контекст» над полем ввода больше нет:
    // расход виден только кольцом у поля ввода, поэтому оно на месте всегда, и в пустом чате тоже.
    button.hidden = false
    const hasKey = Array.isArray(keysPool) && keysPool.length > 0 && keysPool.some(k => k.enabled !== false && !k.dead)
    button.classList.toggle('nokey', !hasKey)

    arc.style.strokeDasharray = String(CTX_RING_CIRCUMFERENCE)
    arc.style.strokeDashoffset = String(CTX_RING_CIRCUMFERENCE * (1 - share))

    // Colour only once it is worth reacting to; a permanently coloured gauge
    // stops meaning anything.
    button.classList.toggle('warn', share >= 0.75 && share < 0.9)
    button.classList.toggle('full', share >= 0.9)

    // Цифры рядом с кольцом убраны: доля видна по самому кольцу, а точные
    // числа — в панели, которая открывается нажатием. Процент у строки ввода
    // был четвёртой подписью подряд и читался как шум.
    const readout = $('contextRingValue')
    if (readout) readout.textContent = limit > 0 ? `${percent}%` : '—'

    const plain = value => formatTokens(value).replace(/\s*токенов$/, '')
    // Подсказка кольца — одна короткая строка и не более: «Контекст 861,1k / 1M (86%)».
    const short = value => {
      const n = Number(value) || 0
      if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
      return String(n)
    }
    button.dataset.tooltip = limit > 0
      ? `${t('Контекст')} ${short(used)} / ${short(limit)} (${percent}%)`
      : t('Размер контекста неизвестен')
    if (!hasKey) button.dataset.tooltip = t('Нет ключа: добавьте ключ в Настройках → Провайдеры и ключи')
    button?.removeAttribute?.('title')

    // The panel is the readable version — filled in even while closed so it is
    // correct the instant it opens.
    const value = $('contextPanelValue')
    const fill = $('contextPanelFill')
    const left = $('contextPanelLeft')

    if (value) value.textContent = limit > 0 ? `${percent}%` : '—'
    if (fill) {
      fill.style.width = `${Math.round(share * 100)}%`
      fill.classList.toggle('warn', share >= 0.75 && share < 0.9)
      fill.classList.toggle('full', share >= 0.9)
    }
    if (left) {
      left.textContent = limit > 0
        ? t('занято %s из %s', plain(used), plain(limit))
        : t('размер окна неизвестен')
    }
  }

  function toggleContextPanel(open) {
    const panel = $('contextPanel')
    const button = $('contextRingBtn')
    if (!panel || !button) return
    const next = open ?? panel.hidden
    if (next) renderContextRing()
    panel.hidden = !next
    button.classList.toggle('open', next)
    button.setAttribute('aria-expanded', next ? 'true' : 'false')

    if (next) {
      const close = e => {
        if (panel.contains(e.target) || button.contains(e.target)) return
        toggleContextPanel(false)
      }
      const key = e => { if (e.key === 'Escape') toggleContextPanel(false) }
      panel.__close = close
      panel.__key = key
      document.addEventListener('pointerdown', close, true)
      document.addEventListener('keydown', key, true)
    } else {
      if (panel.__close) document.removeEventListener('pointerdown', panel.__close, true)
      if (panel.__key) document.removeEventListener('keydown', panel.__key, true)
      panel.__close = null
      panel.__key = null
    }
  }

  // Ctrl+V with a screenshot on the clipboard: there is no file to point at, so
  // the bytes are handed to the main process, which writes one and describes it
  // like any other attachment.
  // Имя файла в строке «Прочитал / Изменил» открывает его в панели превью
  function setupRailOpen() {
    document.addEventListener('click', async event => {
      const open = event.target.closest?.('.rail-open')
      if (!open) return
      // Кнопка лежит внутри summary: без этого нажатие ещё и сворачивало бы строку
      event.preventDefault()
      event.stopPropagation()
      try {
        const result = await window.electronAPI.openFilePreview({ path: open.dataset.path, chatId: (activePane || panes[0])?.chatId || '' })
        if (result?.ok) showArtifact(result.artifact)
        else showToast(t(result?.error || 'Не удалось открыть файл'), true)
      } catch (err) { showToast(cleanErrorText(err), true) }
    })
  }

  function setupImagePaste() {
    for (const pane of panes) {
      pane.dom.textarea?.addEventListener('paste', async e => {
        const items = [...(e.clipboardData?.items || [])]
        const images = items.filter(item => item.type?.startsWith('image/'))
        const text = images.length ? '' : (e.clipboardData?.getData('text/plain') || '')
        const longText = OnlyonePasteTiles.isLongPaste(text)
        if (!images.length && !longText) return

        // Only swallow the event once there is definitely an image or a long text; otherwise
        // pasting short text would stop working.
        e.preventDefault()
        setActivePane(pane)

        // Длинный текст не высыпается в поле: он ложится плиткой над ним, файлом-вложением (paste-tiles.js).
        if (longText) {
          try { addAttachments(pane, [await window.electronAPI.savePastedText(text)]) }
          catch (err) { showToast(cleanErrorText(err) || t('Не удалось вставить текст'), true) }
          return
        }

        for (const item of images.slice(0, 4)) {
          const file = item.getAsFile()
          if (!file) continue
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result || ''))
              reader.onerror = () => reject(new Error('Не удалось прочитать картинку из буфера.'))
              reader.readAsDataURL(file)
            })
            const described = await window.electronAPI.savePastedImage(dataUrl)
            addAttachments(pane, [described])
          } catch (err) {
            showToast(cleanErrorText(err) || 'Не удалось вставить картинку', true)
          }
        }
      })
    }
  }

  // Настройки → Видео (9.8): ffmpeg и кнопка установки — video-settings.js.
  let videoSettings = null
  let budgetSettings = null
  // Настройки → Агент: пределы бюджета задачи. Пустое поле — «без предела»,
  // ноль запрещён. Значения проверяет главный процесс.
  function setupBudgetSettings() {
    if (!document.getElementById('budgetRequests')) return null
    const map = { requests: 'budgetRequests', tokens: 'budgetTokens', deadlineMinutes: 'budgetDeadline' }
    const message = document.getElementById('budgetSettingsMessage')
    const setMessage = (text, error) => {
      if (!message) return
      message.textContent = text
      message.className = 'feedback-msg' + (error ? ' error' : ' success')
    }
    async function load() {
      try {
        const result = await window.electronAPI?.getBudgetSettings?.()
        if (!result?.ok) return
        for (const [key, id] of Object.entries(map)) {
          const field = $(id)
          if (field) field.value = result.settings[key] === null ? '' : String(result.settings[key])
        }
      } catch { setMessage(t('Не удалось прочитать пределы'), true) }
    }
    async function save() {
      const read = id => { const value = $(id)?.value.trim() || ''; return value === '' ? null : Number(value) }
      try {
        const result = await window.electronAPI?.setBudgetSettings?.({
          requests: read('budgetRequests'), tokens: read('budgetTokens'), deadlineMinutes: read('budgetDeadline')
        })
        if (result?.ok) {
          for (const [key, id] of Object.entries(map)) {
            const field = $(id)
            if (field) field.value = result.settings[key] === null ? '' : String(result.settings[key])
          }
          setMessage(t('Пределы сохранены. Действуют на новую задачу.'), false)
          return
        }
        const first = result?.errors?.[0]
        setMessage(t('Проверьте пределы: поле %s', first?.field || ''), true)
      } catch { setMessage(t('Не удалось сохранить пределы'), true) }
    }
    document.getElementById('budgetSettingsSave')?.addEventListener('click', () => { void save() })
    load()
    return { load }
  }
  function setupVideoTools() {
    videoSettings = OnlyoneVideoSettings.create({ $, t, electronAPI, showToast, cleanErrorText })
    videoSettings.bind()
  }

  // Удалённое управление с телефона: мост к чатам окна и раздел настроек.
  let remoteWiring = null
  const toggleRemoteForChat = () => remoteWiring?.toggle(currentChat() || chatOf(panes[0]))
  function setupRemoteControl() {
    remoteWiring = window.OnlyoneRemoteWiring?.setup({
      electronAPI: window.electronAPI, t, $, document, escapeHtml, showToast, askConfirm, saveConversations, renderChatHistory, renderChatHeader,
      conversations: () => conversations, panes: () => panes, send: handleSendMessage, select: selectChat, modelCatalog: () => modelCatalog,
      selectedModel: () => selectedModel, effort: () => currentThinkingEffort, effortStops, setModel, setEffort, browserPanel: () => browserPanelHandle,
      planItems: pane => workPanel().unifiedPlanItems(pane)
    })
    remoteBridge = remoteWiring && remoteWiring.bridge
  }
  function setupMemorySetting() {
    const toggle = $('memoryToggle')
    if (!toggle) return

    window.electronAPI?.getMemorySetting?.()
      .then(enabled => { toggle.checked = enabled === true })
      .catch(() => {})

    toggle.addEventListener('change', async () => {
      try {
        await window.electronAPI.setMemorySetting(toggle.checked)
        showToast(toggle.checked ? 'Память включена' : 'Память выключена')
      } catch (err) {
        toggle.checked = !toggle.checked
        showToast(cleanErrorText(err) || 'Не удалось сохранить настройку', true)
      }
    })
  }

  // Снимок «только для хода» кладёт в строку ввода следилка за вкладкой; оконная проверка делает то же напрямую.
  if (!window.__modelOnlyAttach) window.__modelOnlyAttach = item => addAttachments(panes[0], [{ ...item, modelOnly: true }])
  // Exposed only so the smoke run can render a sample without sending a message.
  if (!window.__renderMd) window.__renderMd = md => renderMarkdownHtml(md)
  // Lets the UI test drive the task register with a made-up pane.
  // Крючок для дымового теста идёт тем же путём, что и кнопка: отдельная
  // перерисовка после закрытия шла уже без владения и брала чужую панель чата.
  // Крючок для дымового теста повторяет живой путь: панель открывают для того
  // чата, на который смотрят, поэтому тестовая панель на время становится открытой.
  let smokePane = null
  if (!window.__tasks) window.__tasks = (pane, open) => {
    if (open) { if (!smokePane) smokePane = activePane; activePane = pane }
    toggleTasksPanel(pane, open)
    if (!open && smokePane) { activePane = smokePane; smokePane = null; renderTasksHeaderButton() }
  }
  // Lets the UI test drive block painting with a pane it builds itself.
  if (!window.__paintBlocks) window.__paintBlocks = pane => paintBlocks(pane)
  // Lets the UI test draw a stored answer and check how a long run of steps folds.
  if (!window.__blocksInto) window.__blocksInto = (host, blocks) => blocksHtmlInto(host, blocks)
  // Lets the UI test check that an old chat's mode is read as a live one.
  if (!window.__testAdd) window.__testAdd = item => addAttachments(panes[0], [item])
  // Lets the project test plant a neighbouring chat. History written straight
  // into the store leaves this window holding its old list, and its next save
  // wipes what was planted — the same merge the app does on any outside change.
  // Lets the test put the open chat into a project the way the chat menu does.
  // Setting projectId on a stored copy raced the window's own unsaved chat, so
  // the turn sometimes went out with no project at all and no project tools.
  if (!window.__joinProject) window.__joinProject = projectId => {
    const chat = conversations.find(c => c.id === panes[0]?.chatId)
    if (chat) moveChatToProject(chat, projectId)
    return chat?.projectId || ''
  }
  // Lets the test choose a model the way a person does — clicking a card —
  // instead of writing the setting behind the window, which the running window
  // never sees and so never applies to the turn it is about to send.
  if (!window.__pickModel) window.__pickModel = id => {
    const match = findCatalogModel(id)
    if (match) setModel(match)
    return selectedModel?.id || ''
  }
  if (!window.__reloadChats) window.__reloadChats = async () => {
    const local = conversations
    await loadConversations()
    conversations = mergeConversations(local, conversations)
    renderChatHistory()
    return conversations.length
  }

  function setupContextRing() {
    renderContextRing()
    // The typed-but-unsent text counts too, so the ring answers before sending.
    // Typing in a pane is enough to mean "show me this one" — gating on
    // activePane left the ring frozen whenever focus was elsewhere.
    for (const pane of panes) {
      pane.dom.textarea?.addEventListener('input', () => renderContextRing(pane))
      pane.dom.textarea?.addEventListener('focus', () => renderContextRing(pane))
    }
    $('contextRingBtn')?.addEventListener('click', () => toggleContextPanel())
  }

  // ---------------------------------------------------------------------------
  // Projects page
  // ---------------------------------------------------------------------------
  // A project used to be a folder in the sidebar and nothing more. It is the
  // place where everything an agent should know before it starts belongs:
  // what the project is, how to work in it, which files and which MCP servers
  // are its knowledge base. All of that rides into every chat of the project.

  function chatsOfProject(id) {
    return conversations.filter(c => c.projectId === id)
  }

  const PLAN_STATUS = { todo: 'ждёт', doing: 'в работе', done: 'готово', blocked: 'блок' }

  function normalizePlanSteps(value) {
    return (Array.isArray(value) ? value : [])
      .filter(s => s && typeof s === 'object' && !Array.isArray(s))
      .map(s => ({ ...s, status: typeof s.status === 'string' && Object.hasOwn(PLAN_STATUS, s.status) ? s.status : 'todo',
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [] }))
  }

  // Проекты: список слева, подробности справа, «Новый проект» — форма на месте
  // подробностей. Раздел строит projects-page.js; здесь — данные и то, что ему нужно от окна.
  let projectsPage = null
  function projectsPageOf() {
    if (projectsPage || !window.OnlyoneProjectsPage || !el.projectsView) return projectsPage
    projectsPage = OnlyoneProjectsPage.create({
      host: el.projectsView,
      getProjects: () => projects,
      save: () => saveProjects(),
      changed: () => renderChatHistory(),
      chatsOf: id => chatsOfProject(id),
      normalizePlan: value => normalizePlanSteps(value),
      relTime: ts => formatRelativeTime(ts),
      mcpServers: () => mcpState.servers || [],
      pickFolder: () => window.electronAPI.selectWorkspace(),
      pickFiles: () => window.electronAPI.pickAttachments(),
      newChat: id => { switchTab('chats'); createNewChat(activePane || panes[0], t('Новый диалог'), id) },
      openChat: id => { selectChat(activePane || panes[0], id); switchTab('chats') },
      remove: (id, name) => deleteProject(id, name),
      ask: (message, initial, ok) => askText(message, initial, ok),
      menu: (button, items) => OnlyoneMk.popMenu(button, items),
      toast: (text, isError, options) => showToast(text, isError, options || {}),
      openRules: (project, back) => openProjectRules(project, back),
      addMcp: preset => openAddMcp(preset),
      cleanError: error => cleanErrorText(error) || String(error?.message || error)
    })
    return projectsPage
  }
  function openProjectEditor(id) { projectsPageOf()?.open(id) }
  function refreshProjectsPage() { projectsPageOf()?.render() }

  // Шторка правил: инструкции проекта, которые агент читает в начале каждого чата проекта
  function openProjectRules(project, back) {
    if (!project || !window.OnlyoneRulesDrawer) return
    OnlyoneRulesDrawer.open({
      key: project.id, host: document.querySelector('.main-content'), back,
      title: t('Правила проекта'), where: project.name, label: t('Инструкции проекта %s', project.name),
      text: project.instructions || '',
      onSave: async text => { project.instructions = text; saveProjects(); refreshProjectsPage() },
      toast: (text, isError, options) => showToast(text, isError, options || {})
    })
  }

  // «Добавить сервер» MCP из другого раздела; github — с готовым адресом GitHub MCP
  function openAddMcp(preset) {
    switchTab('connectors')
    el.addMcpServerBtn?.click()
    if (preset !== 'github') return
    document.querySelector('.transport-tab[data-type="http"]')?.click()
    if (el.mcpNameInput) el.mcpNameInput.value = 'GitHub'
    if (el.mcpUrlInput) el.mcpUrlInput.value = 'https://api.githubcopilot.com/mcp/'
  }

  // Pointing the agent at 1code's own source. Deliberately behind a command and
  // a confirmation: a bad edit here does not break a project, it breaks the
  // window the user is typing in. That has happened twice already.
  async function toggleSelfDevelopment() {
    try {
      let state = await window.electronAPI.getSelfDev()

      if (state.active) {
        await window.electronAPI.toggleSelfDev(false)
        await refreshWorkspace()
        showToast('Режим доработки onlyone выключен')
        return
      }

      if (!state.path) {
        const picked = await window.electronAPI.setSelfDevPath('')
        if (!picked?.path) return
        state = picked
      }

      const agreed = await askConfirm(
        `Направить агента на исходники onlyone?

${state.path}

` +
        'Он сможет править код этого приложения. Каждая запись будет спрашивать подтверждение. ' +
        'Разрешение на правки не означает разрешения публиковать, перезапускать приложение или менять историю и ключи. ' +
        'После исправлений нужны тесты. Установленная версия изменится только после отдельно разрешённой сборки и обновления.',
        'Включить'
      )
      if (!agreed) return

      await window.electronAPI.toggleSelfDev(true)
      await refreshWorkspace()
      showToast('Агент работает над исходниками onlyone. Подтверждайте каждую правку.')
    } catch (err) {
      showToast(cleanErrorText(err) || 'Не удалось переключить режим', true)
    }
  }

  function setupProjectsPage() {
    // An agent that rewrites the plan mid-turn should be visible immediately,
    // not on the next time the page is opened.
    // An agent that files a note into a neighbouring chat should show up in the
    // sidebar right away, not after a restart.
    window.electronAPI?.onConversationsChanged?.(async () => {
      // Reloading wholesale threw away anything this window had added since the
      // last save — including the message the user had just sent, because the
      // main process wrote its own, older copy of the history. Merge instead.
      const local = conversations
      await loadConversations()
      conversations = mergeConversations(local, conversations)
      await saveConversations()

      renderChatHistory()
      for (const pane of panes) if (!pane.generating) renderMessages(pane)
      if (el.projectsView?.classList.contains('active')) refreshProjectsPage()
    })

    window.electronAPI?.onProjectsChanged?.(async data => {
      await loadProjects()
      renderProjects()
      const touched = projects.find(p => p.id === data?.projectId)
      const steps = Array.isArray(touched?.plan) ? touched.plan : []

      // The plan belongs in the conversation it was built for. A popup over
      // the page put it somewhere the work was not, and it vanished with the
      // next click; in the turn it stays as a record of what was decided.
      const working = panes.find(p => p.generating && p.assistantEl &&
        (data?.requestId ? p.requestId === data.requestId : chatOf(p)?.projectId === data?.projectId))
      if (steps.length && working) {
        const asText = JSON.stringify(steps)
        const existing = (working.blocks || []).find(b => b.kind === "plan" &&
          String(b.title || "").startsWith("План"))
        if (existing) {
          existing.text = asText
          working.paintedBlocks = []
          paintBlocks(working)
        } else {
          pushBlock(working, "plan", asText, "", `План · ${touched.name || "проект"}`)
          paintBlocks(working)
        }
      } else if (touched) {
        showPlanPopup(touched)
      }
      if (el.projectsView?.classList.contains('active')) refreshProjectsPage()
      return
    })

  }

  // Modals

  function openModal(modal) {
    if (modal) modal.style.display = 'flex'
    if (modal === el.settingsModal) showSettingsTab(settingsTab)
  }
  function closeModal(modal) {
    if (modal) modal.style.display = 'none'
  }

  // Своя однострочная форма вместо window.prompt: Electron его не поддерживает —
  // вызов ничего не показывает и сразу возвращает null. Из-за этого «Замечание»
  // к элементу исчезало без следа, а выглядело как «нажал и ничего не случилось».
  function askText(message, initial = '', okLabel = 'Готово') {
    const modal = $('promptModal')
    const input = $('promptInput')
    const okBtn = $('promptOkBtn')
    const cancelBtn = $('promptCancelBtn')
    if (!modal || !input || !okBtn || !cancelBtn) return Promise.resolve(null)

    $('promptMessage').textContent = t(message)
    okBtn.textContent = t(okLabel)
    input.value = initial || ''
    openModal(modal)
    setTimeout(() => { input.focus(); input.select() }, 0)

    return new Promise(resolve => {
      const finish = value => {
        okBtn.removeEventListener('click', onOk)
        cancelBtn.removeEventListener('click', onCancel)
        modal.removeEventListener('click', onBackdrop)
        document.removeEventListener('keydown', onKey, true)
        closeModal(modal)
        resolve(value)
      }
      const onOk = () => finish(input.value)
      const onCancel = () => finish(null)
      const onBackdrop = e => { if (e.target === modal) finish(null) }
      const onKey = e => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(null) }
        if (e.key === 'Enter') { e.stopPropagation(); if (e.isComposing || e.keyCode === 229) return; finish(input.value) }
      }
      okBtn.addEventListener('click', onOk)
      cancelBtn.addEventListener('click', onCancel)
      modal.addEventListener('click', onBackdrop)
      document.addEventListener('keydown', onKey, true)
    })
  }

  // Подтверждение — и для модулей окна (панель «Задачи»: «Завершить все»)
  window.__askConfirm = (message, label) => askConfirm(message, label)
  function askConfirm(message, confirmLabel = 'Удалить') {
    const modal = $('confirmModal')
    const messageEl = $('confirmMessage')
    const okBtn = $('confirmOkBtn')
    const cancelBtn = $('confirmCancelBtn')
    if (!modal || !okBtn || !cancelBtn) return Promise.resolve(false)

    messageEl.textContent = t(message)
    okBtn.textContent = t(confirmLabel)
    // Фокус на «Отмена» — случайный Enter не удаляет; Tab ходит по кругу; фокус возвращается
    const back = document.activeElement
    openModal(modal)
    cancelBtn.focus()

    return new Promise(resolve => {
      const finish = value => {
        if (back?.isConnected) back.focus({ preventScroll: true })
        okBtn.removeEventListener('click', onOk)
        cancelBtn.removeEventListener('click', onCancel)
        modal.removeEventListener('click', onBackdrop)
        document.removeEventListener('keydown', onKey, true)
        closeModal(modal)
        resolve(value)
      }
      const onOk = () => finish(true)
      const onCancel = () => finish(false)
      const onBackdrop = e => { if (e.target === modal) finish(false) }
      const onKey = e => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(false) }
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(document.activeElement === okBtn) }
        if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === okBtn ? cancelBtn : okBtn).focus() }
      }

      okBtn.addEventListener('click', onOk)
      cancelBtn.addEventListener('click', onCancel)
      modal.addEventListener('click', onBackdrop)
      document.addEventListener('keydown', onKey, true)
    })
  }

  // What the agent may do without asking — the one control in the composer that
  // changes the outcome of a turn, so it is the one the pill carries. It used to
  // hold prompt presets (Solo, Lead, Council and the rest); there is one way of
  // working now, and the setting that actually matters was buried in Settings.
  // These three lists were already here, describing the same four modes, and
  // nothing read them.
  const PERMISSION_MODES = ['plan', 'manual', 'acceptEdits', 'auto']

  const PERMISSION_LABELS = {
    plan: 'Plan',
    manual: 'Manual',
    auto: 'Auto',
    acceptEdits: 'Accept Edits'
  }

  const PERMISSION_HINTS = {
    plan: 'Только чтение: агент ничего не изменит, а предложит план',
    manual: 'Спрашивать перед каждым изменением',
    auto: 'Без вопросов; удаление — всегда с вопросом',
    acceptEdits: 'Запись без вопросов; удаление и MCP всё равно спрашиваются'
  }

  const permissionMode = () =>
    PERMISSION_MODES.includes(workspaceState.permission) ? workspaceState.permission : 'manual'

  function renderPermissionMode() {
    const mode = permissionMode()
    if (el.permModeLabel) el.permModeLabel.textContent = PERMISSION_LABELS[mode]
    if (el.permModeBtn) {
      el.permModeBtn.dataset.tooltip = `${t(PERMISSION_LABELS[mode])} · ${t(PERMISSION_HINTS[mode])}`
      el.permModeBtn?.removeAttribute?.('title')
      el.permModeBtn.dataset.mode = mode
    }
    if (el.workspacePermissionSelect) el.workspacePermissionSelect.value = mode
  }

  // A list, not a cycle: clicking through four states to reach the one you want
  // means three wrong states along the way, and one of them lets the agent write.
  // Список рисует тот же модуль, что и команды: над пилюлей, имя в
  // строке, описание — подсказкой справа. Классы строки и имени прежние, их
  // читает прогон окна (`design-renderer` считает детей и ищет .perm-item-name).
  function renderPermissionMenu() {
    const menu = el.permModeMenu
    if (!menu) return
    menu.hidden = false
    composerMenu().open({
      anchor: el.permModeBtn,
      host: menu,
      items: PERMISSION_MODES.map(mode => ({
        id: mode, name: PERMISSION_LABELS[mode], hint: PERMISSION_HINTS[mode]
      })),
      selected: PERMISSION_MODES.indexOf(permissionMode()),
      ariaLabel: t('Режим разрешений'),
      itemClass: 'perm-item',
      nameClass: 'perm-item-name',
      onPick: item => selectPermissionMode(item && item.id)
    })
  }

  function togglePermissionMenu(open) {
    const menu = el.permModeMenu
    if (!menu) return
    const next = open ?? menu.hidden
    if (next) renderPermissionMenu()
    else composerMenu().close()
    menu.hidden = !next
    el.permModeBtn?.setAttribute('aria-expanded', next ? 'true' : 'false')
  }

  async function selectPermissionMode(id) {
    togglePermissionMenu(false)
    if (!PERMISSION_MODES.includes(id)) return
    workspaceState.permission = id
    renderPermissionMode()
    // The main process is what enforces this, so it has to hear about it.
    await window.electronAPI.setWorkspace(workspaceState)
  }

  // Event Listeners
  function setupEventListeners() {
    el.permModeBtn?.addEventListener('click', event => {
      event.stopPropagation()
      togglePermissionMenu()
    })
    // Clicking anywhere else puts it away, the way every other popover here does.
    document.addEventListener('click', event => {
      if (el.permModeMenu?.hidden) return
      if (el.permModeMenu?.contains(event.target) || el.permModeBtn?.contains(event.target)) return
      togglePermissionMenu(false)
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !el.permModeMenu?.hidden) togglePermissionMenu(false)
    })

    // Window Controls
    $('winMinBtn')?.addEventListener('click', () => window.electronAPI?.minimizeWindow?.())
    $('winMaxBtn')?.addEventListener('click', () => window.electronAPI?.maximizeWindow?.())
    $('winCloseBtn')?.addEventListener('click', () => window.electronAPI?.closeWindow?.())

    // The maximise button kept showing "maximise" while the window already was.
    const applyWindowState = maximized => {
      const btn = $('winMaxBtn')
      if (!btn) return
      const label = maximized ? 'Свернуть в окно' : 'Развернуть'
      btn.dataset.tooltip = label
      btn.setAttribute('aria-label', label)
      btn?.removeAttribute?.('title')
    }
    window.electronAPI?.onWindowState?.(state => applyWindowState(state?.maximized))
    window.electronAPI?.isMaximized?.().then(applyWindowState).catch(() => {})

    // Navigation Tabs
    el.navChats?.addEventListener('click', () => switchTab('chats'))
    el.navTasks?.addEventListener('click', () => {
      if (ultraShellInstance?.tasksClicked?.()) return
      if (isUltraPreset()) {
        toggleUltraTasks()
        return
      }
      if (document.body.classList.contains('task-center-open')) return switchTab('chats')
      toggleTasksPanel(panelPane())
    })
    document.addEventListener('open-task-center', () => switchTab('tasks'))
    $('taskCenterCloseBtn')?.addEventListener('click', () => {
      if (isUltraPreset()) {
        setUltraTasks(false)
        el.navTasks?.focus()
        return
      }
      switchTab('chats')
      el.navTasks?.focus()
    })
    el.navProjects?.addEventListener('click', () => switchTab('projects'))
    el.navSkills?.addEventListener('click', () => switchTab('skills'))
    el.navConnectors?.addEventListener('click', () => switchTab('connectors'))
    el.navPlugins?.addEventListener('click', () => switchTab('plugins'))

    // New Chat
    el.newChatBtn?.addEventListener('click', () => {
      switchTab('chats')
      createNewChat(panes[0])
    })
    el.clearChatBtn?.addEventListener('click', () => clearActiveChat(activePane || panes[0]))
    // Масштаб страницы браузера — в «Ещё» у адреса (макет): кнопки масштаба остаются, но не на виду
    $('browserMore')?.addEventListener('click', e => {
      e.stopPropagation()
      const level = $('browserZoomLevel')?.textContent || '100%'
      OnlyoneMk.popMenu(e.currentTarget, [
        [t('Увеличить масштаб'), () => $('browserZoomIn')?.click(), { d: level }],
        [t('Уменьшить масштаб'), () => $('browserZoomOut')?.click()],
        [t('Масштаб 100%'), () => $('browserZoomLevel')?.click()]
      ])
    })
    // Правила проекта — шторка с инструкциями проекта этого чата; второе нажатие закрывает
    $('instrBtn')?.addEventListener('click', e => {
      if (window.OnlyoneRulesDrawer?.isOpen()) { OnlyoneRulesDrawer.close(); return }
      const chat = chatOf(activePane || panes[0])
      openProjectRules(projects.find(p => p.id === chat?.projectId), e.currentTarget)
    })

    // History Search
    el.splitViewBtn?.addEventListener('click', () => toggleSplitView())
    $('splitCloseBtn')?.addEventListener('click', () => toggleSplitView(false))

    // Выбор диалога для второй панели прямо из её шапки.
    $('splitChatLabel')?.addEventListener('click', event => {
      const side = panes[1]
      if (!side) return
      const box = event.currentTarget.getBoundingClientRect()
      // Текущий диалог из списка убран (1.14, часть 4): он написан на самой
      // кнопке, а строкой в меню только повторяет то, что человек уже видит.
      const recent = [...conversations]
        .filter(chat => (chat.messages?.length || chat.id === side.chatId) && chat.id !== side.chatId)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 14)
      openContextMenu(box.left, box.bottom + 4, [
        { label: t('Новый диалог'), onPick: () => $('splitNewChatBtn')?.click() },
        { separator: true },
        ...recent.map(chat => ({
          label: chat.title || t('Диалог'),
          hint: chat.id === panes[0]?.chatId ? t('слева') : '',
          onPick: () => {
            setActivePane(side)
            selectChat(side, chat.id)
            renderSplitPane()
          }
        }))
      ])
    })

    // Поменять чаты местами. Посреди хода нельзя: поток продолжил бы писать в
    // панель, которой у этого чата уже нет.
    $('splitSwapBtn')?.addEventListener('click', () => {
      const [left, right] = panes
      if (!left || !right || !left.chatId || !right.chatId) return
      if (left.generating || right.generating || left.preparing || right.preparing) {
        showToast(t('Дождитесь окончания ответа, потом меняйте местами'), true)
        return
      }
      selectChat(right, left.chatId)
      renderSplitPane()
      renderChatHistory()
    })

    $('splitNewChatBtn')?.addEventListener('click', () => {
      const pane = panes[1]
      if (!pane) return
      const chat = createNewChat(pane, t('Новый диалог'))
      splitChatId = chat.id
      renderSplitPane()
      renderChatHistory()
    })
    // Clicking anywhere in the side pane aims the sidebar at it, so picking a
    // chat on the left puts it here rather than replacing the main one.
    el.splitPane?.addEventListener('pointerdown', () => {
      if (panes[1]) setActivePane(panes[1])
    }, true)
    el.splitPane?.addEventListener('focusin', () => {
      if (panes[1]) setActivePane(panes[1])
    })

    // Модель и глубина — блоки у кнопок (model-popover.js); окна-каталога нет, весь список листается в блоке.
    modelPopoverInstance = OnlyoneModelPopover.create({
      $, t, escapeHtml, document, formatPrice, getCatalog: () => modelCatalog, getSelected: () => selectedModel,
      setModel, effortStops: () => effortStops(selectedModel), effortLabel, getEffort: () => currentThinkingEffort,
      setEffort, isFast: () => fastMode, fastAllowed, setFast: next => setFastMode(next)
    })
    modelPopoverInstance.wire()

    // Ползунок мышления. Подпись меняется, пока его тянут; сама глубина
    // сохраняется, когда отпустили, — иначе каждое движение писало бы настройки.
    el.effortSlider?.addEventListener('input', () => paintEffortSlider(effortStops(selectedModel)))
    el.effortSlider?.addEventListener('change', () => {
      const stops = effortStops(selectedModel)
      const next = stops[Number(el.effortSlider.value) || 0]
      if (next) setEffort(next)
    })

    el.modalThinkingToggle?.addEventListener('change', e => {
      if (selectedModel?.reasoningMandatory) {
        e.target.checked = true
        showToast('Эта модель всегда рассуждает — отключить нельзя')
        return
      }
      if (e.target.checked) {
        const efforts = selectedModel?.supportedEfforts || []
        setEffort(efforts.includes('max') ? 'max' : (efforts[0] || 'high'))
        showToast('Рассуждения включены')
      } else {
        setEffort('off')
        showToast('Рассуждения отключены')
      }
    })

    // Categories Filter Tabs
    document.querySelectorAll('.tab-chip').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab-chip').forEach(t => t.classList.remove('active'))
        tab.classList.add('active')
        activeCategory = tab.dataset.category
        renderModelCards()
      })
    })

    el.modelFilterInput?.addEventListener('input', renderModelCards)
    el.refreshModelsBtn?.addEventListener('click', () => loadModelsCatalog(true))

    // Composer & Slash Command Trigger
    el.composerTextarea?.addEventListener('input', e => {
      autoResizeTextarea(panes[0])
      const val = e.target.value
      if (OnlyoneSlashCommands.wantsMenu(val)) {
        updateSlashMenu(val)
      } else {
        closeSlashMenu()
      }
    })

    el.composerTextarea?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) { e.preventDefault(); return }
      // ↑↓ и Escape держит composer-menu.js; окну осталось вставить выбранное
      // по Enter/Tab и не дать форме отправить сообщение вместо этого (3.10).
      if (composerMenu().isOpen()) {
        if (e.key === 'Enter' || e.key === 'Tab') {
          const picked = composerMenu().accept()
          if (picked) {
            e.preventDefault()
            executeSlashCommand(SLASH_COMMANDS.find(c => c.cmd === picked.id))
            return
          }
        }
        if (e.key === 'Escape') { closeSlashMenu(); return }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        panes[0]?.dom.form?.requestSubmit()
      }
    })

    for (const pane of panes) wireComposer(pane)

    // Settings Modal
    el.openSettingsBtn?.addEventListener('click', () => {
      openModal(el.settingsModal)
      refreshKeysPool()
      refreshCustomProvider()
      refreshStorageStatus()
    })
    // A plain click opens the list of folders. It used to go straight to the
    // system picker, and everything else — extra folders, folders for this chat,
    // folders for the project — was reachable only by right-clicking a button
    // that gave no sign of it. A feature nobody can find is not a feature.
    el.workspaceBtn?.addEventListener('click', e => {
      // Always the menu, even with nothing chosen yet: one button with two
      // different reactions is a button you have to learn twice. With no folder
      // the menu's first item is the picker, so it costs one extra click and
      // shows what else is possible.
      const box = el.workspaceBtn.getBoundingClientRect()
      openFolderMenu(box.left, box.top)
      e.stopPropagation()
    })

    el.workspaceBtn?.addEventListener('contextmenu', e => {
      e.preventDefault()
      const box = el.workspaceBtn.getBoundingClientRect()
      openFolderMenu(box.left, box.top)
    })

    // Оболочка Ultra зовёт это меню со своей строки выбора папки (функция ниже
    // поднимается вместе с блоком; присваивание стоит выше среза test-folder-menu).
    ultraOpenFolderMenu = openFolderMenu

    // Built as data so the contents can be checked without opening a window.
    // What this menu offers is the whole multi-folder feature: hidden behind a
    // right-click, it may as well not have existed.
    // Три уровня одной логикой: все чаты, этот чат, проект. У
    // каждого — «добавить» и его папки; нажатие на папку отключает её.
    function folderMenuItems({ folders = [], chatFolders = [], project = null }) {
      // Один список без заголовков: папки с пометкой, на что они
      // действуют, и ниже три способа добавить. Нажатие на папку отключает её.
      const items = []
      for (const folder of folders) items.push({ label: folderLeaf(folder), hint: 'все чаты', action: 'drop-global', folder })
      for (const folder of chatFolders) items.push({ label: folderLeaf(folder), hint: 'этот чат', action: 'drop-chat', folder })
      const projectFolders = project && Array.isArray(project.folders) ? project.folders : []
      for (const folder of projectFolders) items.push({ label: folderLeaf(folder), hint: 'проект', action: 'drop-project', folder })
      if (items.length) items.push({ separator: true })
      items.push({ label: 'Добавить папку…', action: 'add-global' }, { label: 'Только для этого чата…', action: 'add-chat' })
      if (project) items.push({ label: 'Для проекта…', hint: project.name || '', action: 'add-project' })
      return items
    }

    function openFolderMenu(x, y) {
      const pane = activePane || panes[0]
      const chat = chatOf(pane)
      const project = chat?.projectId ? projects.find(pr => pr.id === chat.projectId) : null

      const items = folderMenuItems({
        folders: globalFolders(),
        chatFolders: chatFoldersOf(chat),
        project
      })

      const run = {
        'add-global': () => addGlobalFolder(),
        'drop-global': item => removeGlobalFolder(item.folder),
        'add-chat': () => addChatFolder(pane),
        'drop-chat': item => removeChatFolder(pane, item.folder),
        'add-project': () => addProjectFolder(project),
        'drop-project': item => removeProjectFolder(project, item.folder)
      }

      openContextMenu(x, y, items.map(item => item.action
        ? { ...item, hint: item.action.startsWith('drop') ? t(item.hint) : item.hint, onPick: () => run[item.action](item) }
        : item))
    }

    el.languageSelect?.addEventListener('change', e => {
      setLanguage(e.target.value)
    })
    el.workspacePermissionSelect?.addEventListener('change', async e => {
      workspaceState.permission = e.target.value
      renderPermissionMode()
      await window.electronAPI.setWorkspace(workspaceState)
    })

    el.toggleNewKeyVisibility?.addEventListener('click', () => {
      const isPass = el.newKeyValueInput.type === 'password'
      el.newKeyValueInput.type = isPass ? 'text' : 'password'
    })

    el.btnAddApiKey?.addEventListener('click', async () => {
      const keyVal = el.newKeyValueInput.value.trim()

      if (!keyVal) {
        el.apiKeyMessage.textContent = 'Вставьте ваш ключ API (sk-or-v1-…).'
        el.apiKeyMessage.className = 'feedback-msg error'
        return
      }
      el.btnAddApiKey.disabled = true
      el.apiKeyMessage.textContent = 'Проверка и подключение к OpenRouter…'
      el.apiKeyMessage.className = 'feedback-msg'

      try {
        const updated = await window.electronAPI.addOpenRouterKey({
          key: keyVal
        })
        el.newKeyValueInput.value = ''
        el.apiKeyMessage.textContent = 'Ключ сохранён'
        el.apiKeyMessage.className = 'feedback-msg success'
        renderKeysPool(updated)
        await loadModelsCatalog(true)
        showToast('API-ключ сохранён и готов к работе!')
      } catch (err) {
        el.apiKeyMessage.textContent = cleanErrorText(err) || 'Ошибка проверки ключа.'
        el.apiKeyMessage.className = 'feedback-msg error'
      } finally {
        el.btnAddApiKey.disabled = false
      }
    })

    // Путь к модели и свой OpenAI-совместимый endpoint.
    $('toggleCustomKeyVisibility')?.addEventListener('click', () => {
      const input = $('customKeyInput')
      if (input) input.type = input.type === 'password' ? 'text' : 'password'
    })

    // То, что набрано в полях, — про подключение, которое на экране. Ключ
    // передаётся только когда его вписали: пустое поле не значит «стереть».
    const customProviderPatch = withKey => {
      // Имя подключения спрашивают только у своих совместимых endpoints: у пути
      // из каталога учётная запись одна, и имя ей даёт провайдер.
      const named = namedPathOnScreen(customProviderView)
      const patch = {
        name: named ? '' : ($('customProviderNameInput')?.value.trim() || ''),
        baseUrl: $('customBaseUrlInput')?.value.trim() || '',
        model: $('customModelInput')?.value.trim() || '',
        capabilities: { tools: $('customToolsCheck')?.checked !== false }
      }
      // Именованный путь из каталога: правка идёт в его учётной записи, и окно
      // называет путь, а не угадывает id.
      if (named) patch.provider = named
      if (customProviderEditingId && !named) patch.id = customProviderEditingId
      const key = $('customKeyInput')?.value.trim() || ''
      if (withKey && key) patch.key = key
      return patch
    }

    const providerMessage = (text, kind) => {
      const message = $('customProviderMessage')
      if (!message) return
      // Причины отказа приходят из главного процесса русскими словами: здесь они
      // проходят через словарь, и точные совпадения переводятся. Формы с
      // подстановкой («Путь „X“ не настроен: …») остаются русскими, пока
      // главный процесс не получит язык окна — это пункт 2.6б.
      message.textContent = t(text || '')
      message.className = 'feedback-msg' + (kind ? ` ${kind}` : '')
    }

    $('providerSelect')?.addEventListener('change', async event => {
      const wanted = event.target.value
      // Поля следуют за выбором сразу: если путь ещё не настроен и переключение
      // откажет, человеку нужно чем-то его настроить.
      providerOnScreen = wanted
      customProviderEditingId = ''
      providerMessage(t('Переключение пути…'))
      let result = null
      try {
        result = await window.electronAPI.setActiveProvider(wanted)
        if (result?.ok) await loadModelsCatalog(true)
      } catch (err) {
        result = { ok: false, reason: cleanErrorText(err) || t('Не переключено.') }
      }
      if (!result?.ok) {
        // Выбор не должен остаться вразрез с тем, куда ходы пойдут на самом деле.
        await refreshCustomProvider()
        providerMessage(result?.reason || t('Не переключено.'), 'error')
        return
      }
      renderCustomProvider(result.provider)
      const active = (result.provider?.items || []).find(item => item.id === result.activeId)
      providerMessage(result.provider?.activeProvider === result.provider?.customId
        ? t('Ход идёт на подключение «%s»', active?.name || '')
        : t('Ходы идут на %s', result.provider?.providers?.find(p => p.id === result.activeProvider)?.title || 'OpenRouter'), 'success')
    })

    // Строка своего подключения: имя переключает ход, «⋯» открывает меню.
    // Прежний список выбора делал то же самое одним движением, но строке
    // есть что показать — ходящее подключение и готовность — а список молчал.
    $('customConnectionsList')?.addEventListener('click', async event => {
      const button = event.target.closest('button[data-action]')
      const row = event.target.closest('.conn-row')
      if (!button || !row) return
      const menu = row.querySelector('.conn-menu')
      const action = button.dataset.action
      if (action === 'menu') {
        const open = Boolean(menu && menu.hidden)
        closeConnectionMenus(open ? menu : null)
        if (menu) menu.hidden = !open
        button.setAttribute('aria-expanded', open ? 'true' : 'false')
        return
      }
      closeConnectionMenus(null)
      const id = row.dataset.connectionId
      if (!id) return
      if (action === 'choose') await chooseConnection(id)
      if (action === 'edit') await editConnection(id)
      if (action === 'check') { await editConnection(id); await runProviderCheck() }
      if (action === 'remove') {
        const name = (customProviderView?.items || []).find(item => item.id === id)?.name || ''
        if (await askConfirm(t('Удалить подключение «%s»?', name))) await removeConnection(id)
      }
    })

    // Меню закрывается и по нажатию вне строки: висящий список пунктов не
    // должен переезжать на другой экран вместе с раскрытой строкой.
    document.addEventListener('click', event => {
      if (!event.target.closest('.conn-menu-wrap')) closeConnectionMenus(null)
    })

    async function chooseConnection(id) {
      customProviderEditingId = id
      const view = customProviderView
      if (!isCustomPath(view)) {
        await refreshCustomProvider()
        providerMessage(t('Выбрано для правки. Путь пока OpenRouter — ход идёт не на него.'), '')
        return
      }
      providerMessage(t('Выбор подключения…'))
      let result = null
      try {
        result = await window.electronAPI.chooseCustomProvider(id)
        if (result?.ok) await loadModelsCatalog(true)
      } catch (err) {
        result = { ok: false, reason: cleanErrorText(err) || t('Не выбрано.') }
      }
      if (!result?.ok) {
        providerMessage(result?.reason || t('Не выбрано.'), 'error')
        await refreshCustomProvider()
        return
      }
      customProviderEditingId = result.provider?.activeId || id
      renderCustomProvider(result.provider)
      providerMessage(t('Ход идёт на «%s»', result.name || ''), 'success')
    }

    // «Изменить» из меню: поля показываются под списком, ход при этом
    // переключается только явным нажатием на имя строки.
    async function editConnection(id) {
      customProviderEditingId = id
      await refreshCustomProvider()
      const fields = $('providerFieldsGroup')
      if (fields && !fields.hidden) fields.scrollIntoView({ block: 'nearest' })
    }

    $('btnNewConnection')?.addEventListener('click', async () => {
      providerMessage(t('Новое подключение…'))
      try {
        const taken = (customProviderView?.items || []).length
        const name = $('customProviderNameInput')?.value.trim() || t('Подключение %s', taken + 1)
        const result = await window.electronAPI.addCustomProvider({ name })
        if (!result?.ok) {
          providerMessage(result?.reason || t('Не создано.'), 'error')
          return
        }
        customProviderEditingId = result.id
        renderCustomProvider(result.provider)
        const keyInput = $('customKeyInput')
        if (keyInput) keyInput.value = ''
        providerMessage(t('Подключение создано — заполните адрес, модель и ключ'), 'success')
      } catch (err) {
        providerMessage(cleanErrorText(err) || t('Ошибка создания подключения.'), 'error')
      }
    })

    async function removeConnection(id) {
      if (!id) return
      providerMessage(t('Удаление…'))
      try {
        const result = await window.electronAPI.removeCustomProvider(id)
        if (!result?.ok) {
          providerMessage(result?.reason || t('Не удалено.'), 'error')
          return
        }
        customProviderEditingId = result.provider?.activeId || ''
        renderCustomProvider(result.provider)
        await loadModelsCatalog(true)
        // Успешное действие не красится ошибкой: предупреждение уже в тексте.
        providerMessage(result.note || t('Подключение удалено'), 'success')
      } catch (err) {
        providerMessage(cleanErrorText(err) || t('Ошибка удаления.'), 'error')
      }
    }

    $('btnSaveCustomProvider')?.addEventListener('click', async () => {
      const button = $('btnSaveCustomProvider')
      if (button) button.disabled = true
      providerMessage(t('Сохранение…'))
      try {
        const result = await window.electronAPI.setCustomProvider(customProviderPatch(true))
        if (!result?.ok) {
          providerMessage(result?.reason || t('Не сохранено.'), 'error')
          renderCustomProvider(result?.provider)
          return
        }
        customProviderEditingId = result.id || customProviderEditingId
        const keyInput = $('customKeyInput')
        if (keyInput) keyInput.value = ''
        renderCustomProvider(result.provider)
        providerMessage(t('Сохранено'), 'success')
      } catch (err) {
        providerMessage(cleanErrorText(err) || t('Ошибка сохранения.'), 'error')
      } finally {
        if (button) button.disabled = false
      }
      loadModelsCatalog(true).catch(e => console.error('Catalog refresh error:', e))
    })

    // Проверка пути — одна рукоять для кнопки группы и для пункта «Проверить»
    // в меню строки: второй копии этого шага в окне быть не должно.
    async function runProviderCheck() {
      const button = $('btnCheckCustomProvider')
      if (button) button.disabled = true
      providerMessage(t('Проверка соединения…'))
      try {
        // Сначала записываем то, что в полях: иначе «проверить» мерил бы старый
        // адрес, а зелёный свет относился бы не к тому, что набрал человек.
        const saved = await window.electronAPI.setCustomProvider(customProviderPatch(true))
        if (!saved?.ok) {
          providerMessage(saved?.reason || t('Сначала сохраните адрес и модель.'), 'error')
          renderCustomProvider(saved?.provider)
          return
        }
        const result = await window.electronAPI.checkCustomProvider({
          id: customProviderEditingId || undefined,
          provider: customProviderPatch(false).provider
        })
        fillCustomModelList(result?.models)
        renderCustomProvider(result?.provider)
        if (result?.ok) {
          providerMessage(t('Эндпоинт отвечает, моделей в каталоге: %s', (result.models || []).length) +
            (result.local ? t(' (адрес локальный)') : ''), 'success')
        } else {
          providerMessage(result?.reason || t('Эндпоинт не ответил списком моделей.'), 'error')
        }
      } catch (err) {
        providerMessage(cleanErrorText(err) || t('Ошибка проверки эндпоинта.'), 'error')
      } finally {
        if (button) button.disabled = false
      }
    }

    $('btnCheckCustomProvider')?.addEventListener('click', () => runProviderCheck())

    // MCP Add Server Modal
    el.addMcpServerBtn?.addEventListener('click', () => openMcpEditor(null))
    el.mcpServerList?.addEventListener('click', event => {
      const button = event.target.closest('[data-mx]')
      if (button && !button.disabled) void mcpAct(button)
    })
    document.querySelectorAll('#addMcpForm .transport-tab').forEach(tab => {
      tab.addEventListener('click', () => setMcpTransport(tab.dataset.type))
    })
    // Готовый конфиг — по ссылке: поле открывается над формой, фокус в него
    el.addMcpForm?.addEventListener('input', event => {
      const field = event.target
      if (!field?.id || field.getAttribute('aria-invalid') !== 'true') return
      field.removeAttribute('aria-invalid')
      const err = $(field.id + 'Err')
      if (err) err.textContent = ''
    })
    $('mcpJsonToggle')?.addEventListener('click', () => {
      $('mcpJsonBox').hidden = false
      $('mcpJsonToggle').hidden = true
      el.mcpJsonInput?.focus()
    })

    el.mcpJsonInput?.addEventListener('input', () => {
      const text = el.mcpJsonInput.value.trim()
      if (!text) return setMcpFormNote('')

      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return setMcpFormNote('Пока не похоже на валидный JSON — допишите.')
      }

      // Accept the wrapper, a bare map of servers, or a single server object.
      const servers = parsed.mcpServers || parsed.servers ||
        (parsed.url || parsed.command ? { [parsed.name || 'server']: parsed } : parsed)
      const names = Object.keys(servers || {})
      if (!names.length) return setMcpFormNote('В конфиге нет ни одного сервера.', true)

      const key = names[0]
      const cfg = servers[key] || {}
      const type = cfg.type === 'http' || cfg.url ? 'http' : 'stdio'

      el.mcpNameInput.value = cfg.name || key
      window.OnlyoneMk.fieldErrors($('addMcpForm'), [])
      setMcpTransport(type)

      if (type === 'http') {
        el.mcpUrlInput.value = cfg.url || ''
        el.mcpHeadersInput.value = kvText(cfg.headers, ': ')
      } else {
        el.mcpCommandInput.value = cfg.command || ''
        el.mcpArgsInput.value = (cfg.args || []).join('\n')
        el.mcpEnvInput.value = kvText(cfg.env, '=')
      }

      const placeholder = JSON.stringify(cfg.headers || cfg.env || {})
      const unfilled = /ТВОЙ_ТОКЕН|YOUR_TOKEN|<[^>]+>|\.\.\.|…|Bearer\s*"/i.test(placeholder)
      setMcpFormNote(
        names.length > 1
          ? `Взят первый сервер «${key}». Остальные ${names.length - 1} добавьте отдельно.`
          : unfilled
            ? 'В конфиге стоит заглушка вместо токена — замените её на настоящий.'
            : `Конфиг разобран: «${el.mcpNameInput.value}».`
      )
    })

    el.addMcpForm?.addEventListener('submit', async e => {
      e.preventDefault()
      setMcpFormNote('')
      const name = el.mcpNameInput.value.trim()
      const errs = []
      if (!name) errs.push(['mcpNameInput', t('Назовите сервер: так он будет виден в списке')])
      else if ((mcpState?.servers || []).some(s => s.id !== editingMcpId && String(s.name).toLowerCase() === name.toLowerCase())) errs.push(['mcpNameInput', t('Сервер «%s» уже есть', name)])
      if (mcpTransportType === 'stdio' && !el.mcpCommandInput.value.trim()) errs.push(['mcpCommandInput', t('Нужна команда, которой сервер запускается')])
      if (mcpTransportType === 'http' && !/^https?:\/\/\S+/.test(el.mcpUrlInput.value.trim())) errs.push(['mcpUrlInput', t('Адрес начинается с https://')])
      const kv = (input, sep, id, hint) => { try { return kvParse(input.value, sep) } catch { errs.push([id, hint]); return null } }
      const env = mcpTransportType === 'stdio' ? kv(el.mcpEnvInput, '=', 'mcpEnvInput', t('По строке: ИМЯ=значение')) : null
      const headers = mcpTransportType === 'http' ? kv(el.mcpHeadersInput, ':', 'mcpHeadersInput', t('По строке: Заголовок: значение')) : null
      if (!window.OnlyoneMk.fieldErrors($('addMcpForm'), errs)) return

      try {
        const config = {
          name,
          type: mcpTransportType
        }

        if (mcpTransportType === 'stdio') {
          config.command = el.mcpCommandInput.value.trim()
          config.args = el.mcpArgsInput.value.split('\n').map(s => s.trim()).filter(Boolean)
          if (env) config.env = env
        } else {
          config.url = el.mcpUrlInput.value.trim()
          if (headers) config.headers = headers
        }

        if (editingMcpId) {
          config.id = editingMcpId
          config.keepSecrets = true
        }

        const before = (mcpState?.servers || []).find(s => s.id === editingMcpId)
        const saved = await window.electronAPI.addMcpServer(config)
        const wasEditing = Boolean(editingMcpId)
        editingMcpId = null
        closeModal(el.addMcpModal)
        // Новый сервер сразу подключается; изменённый, если работал, перезапускается с новыми настройками
        const entry = (saved?.servers || []).find(s => wasEditing ? s.id === config.id : s.name === config.name)
        const restart = entry && (!wasEditing || before?.status === 'connected')
        showToast(t(wasEditing ? (restart ? 'Сервер «%s» сохранён: перезапускаю' : 'Сервер «%s» сохранён') : 'Сервер «%s» добавлен: подключаю', config.name))
        refreshMcp()
        if (restart) {
          try {
            if (wasEditing) await window.electronAPI.disconnectMcpServer(entry.id)
            await window.electronAPI.connectMcpServer(entry.id)
          } catch { /* причина видна в строке сервера: статус «Не запускается» и текст ошибки */ }
          refreshMcp()
        }
      } catch (err) {
        setMcpFormNote(cleanErrorText(err) || 'Ошибка сохранения сервера.', true)
      }
    })

    // Modal Close Buttons (✕)
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
        const targetId = btn.dataset.close
        const targetModal = $(targetId)
        if (targetModal) closeModal(targetModal)
      })
    })

    // Click outside modal card on backdrop
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', e => {
        if (e.target === backdrop) closeModal(backdrop)
      })
    })

    // Global Keydown (Escape & Shortcuts)
    // Запись сочетания — раньше всех: нажатие не должно дойти ни до поля, ни до
    // других сочетаний. Остальное — как было, всплытием.
    window.addEventListener('keydown', e => { captureShortcut(e) }, true)
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (isUltraPreset() && ultraTasksOpen) {
          setUltraTasks(false)
        }
        document.querySelectorAll('.modal-backdrop').forEach(m => closeModal(m))
        closeSlashMenu()
        togglePermissionMenu(false)
      }
      const combo = comboOf(e)
      const action = combo && SHORTCUT_ACTIONS.find(item => shortcutOf(item.id) === combo)
      if (action) {
        e.preventDefault()
        action.run()
      }
    })
  }

  // Subscribe to Electron IPC events
  // Fast доступен не всякой модели: платная сюда не попадает.
  function fastAllowed(model = selectedModel) {
    return Boolean(model?.isFree || model?.id?.endsWith(':free') || model?.id === 'z-ai/glm-5.3-flash')
  }

  // Молния рядом с моделью, галочка в каталоге и сам режим — одно и то же
  // состояние. Рисуется из одного места, чтобы они не разошлись.
  function renderFastControls() {
    const allowed = fastAllowed()
    for (const id of ['fastModeBtn', 'designFastBtn']) {
      const button = $(id)
      if (!button) continue
      button.setAttribute('aria-pressed', fastMode ? 'true' : 'false')
      button.disabled = !allowed && !fastMode
      button.dataset.tooltip = !allowed
        ? 'Fast доступен для бесплатных моделей и GLM 5.3 Flash'
        : fastMode
          ? 'Fast включён — быстрее и экономнее. Нажмите, чтобы выключить'
          : 'Fast — быстрее и экономнее'
      button?.removeAttribute?.('title')
    }
    const toggle = $('fastModeToggle')
    if (toggle) toggle.checked = fastMode
    modelPopoverInstance?.renderFast()
    // Пока включён Fast, глубину выбирает он сам, и ползунок это показывает.
    if (el.effortSlider) { el.effortSlider.disabled = Boolean(fastMode); paintEffortSlider(effortStops(selectedModel)) }
  }

  function setFastMode(next, { announce = true } = {}) {
    if (next && !fastAllowed()) {
      showToast('Fast доступен для бесплатных моделей и GLM 5.3 Flash. Выберите другую модель.', true)
      renderFastControls()
      return false
    }
    fastMode = Boolean(next)
    if (fastMode) {
      for (const chatId of [...nextSuggestionJobsByChat.keys()]) cancelNextSuggestion(chatId)
    }
    try { localStorage.setItem('1code.fast-mode', String(fastMode)) } catch {}
    for (const pane of panes) renderSuggestion(pane)
    renderFastControls()
    updateModelEffortPill()
    renderDesignModelPill()
    if (announce) showToast(fastMode ? 'Fast-режим включён' : 'Fast-режим выключен')
    return true
  }
  function setupIpcListeners() {
    if (!window.electronAPI) return
    for (const id of ['fastModeBtn', 'designFastBtn']) {
      $(id)?.addEventListener('click', () => setFastMode(!fastMode))
    }
    const fastToggle = $('fastModeToggle')
    if (fastToggle) {
      fastToggle.checked = fastMode
      fastToggle.addEventListener('change', () => {
        // Галочка в каталоге осталась и ведёт себя так же — просто теперь это
        // не единственный способ до неё добраться.
        if (!setFastMode(fastToggle.checked)) fastToggle.checked = fastMode
      })
    }
    renderFastControls()

    window.electronAPI.onMessageChunk(chunk => {
      const pane = paneForRequest(chunk?.requestId)
      if (!pane) return
      const deltaText = chunk?.choices?.[0]?.delta?.content || ''
      if (!deltaText) return
      if (isHelperChunk(chunk)) { feedLane(pane, pane, chunk, 'text', deltaText); return }

      pane.streamQueue = (pane.streamQueue || '') + deltaText

      if (pane.assistantEl) {
        // Панель писала «ожидаю ответ модели» и тогда, когда ответ уже шёл минуту.
        // Ждут до первого символа; дальше это уже не ожидание, а работа.
        noteAgentDoing(pane, chunk, t('Пишет ответ'))

        // Первый символ ответа — отдельное событие, и знак его отмечает. До него
        // модель думала; после — пишет, и это разные вещи.
        if (!pane.answerStarted || pane.markPhase !== 'answering') {
          pane.answerStarted = true
          markState(pane, 'answering')
        }
        startSmoothStreamAnimation(pane)
      } else {
        pane.contentBuffer = pane.streamQueue
      }
    })

    window.electronAPI.onMessageReasoningChunk(chunk => {
      const pane = paneForRequest(chunk?.requestId)
      if (!pane) return
      if (!chunk?.text) return
      if (isHelperChunk(chunk)) { feedLane(pane, pane, chunk, 'thinking', chunk.text); return }

      const agent = chunk.agentName || ''
      pane.reasoningSegments = pane.reasoningSegments || []
      const last = pane.reasoningSegments[pane.reasoningSegments.length - 1]
      if (!last || last.agent !== agent) {
        pane.reasoningSegments.push({ agent, text: chunk.text })
      } else {
        last.text += chunk.text
      }
      pushThinking(pane, chunk.text, agent)
      pane.reasoningBuffer = reasoningSegmentsToText(pane)

      if (pane.assistantEl) {
        noteAgentDoing(pane, chunk, thinkingHeadline(chunk.full || chunk.text) || t('Думает'))
        if (!pane.answerStarted) markState(pane, 'thinking')
        updateLiveAssistantUI(pane)
      }
    })

    window.electronAPI.onAgentStageStart(stage => {
      const pane = paneForRequest(stage?.requestId)
      if (!pane) return

      // Other participants may still be running concurrently.
      const task = agentTaskState(pane, (stage.stage || 1) - 1, stage.agentName)
      // Имя приходит вместе с поручением и до раздачи работы — просто «Агент 2».
      // Когда ведущий назвал часть, имя меняется, и строка обязана это принять.
      if (stage.agentName) task.name = stage.agentName
      task.model = stage.modelName || ''
      task.taskTitle = stage.taskTitle || ''
      // У ведущего поручения нет — задача его целиком. Без заголовка его строка
      // показывала мимолётное занятие, и чем он занят вообще, прочесть было
      // негде. Заголовком становится сама просьба.
      task.assignment = stage.assignment || (((stage.stage || 1) - 1) === 0 ? lastAskOf(pane) : '')
      task.what = t('Разбирается в задаче')
      task.since = Date.now()
      task.outcome = ''
      task.done = false
      renderAgentTasks(pane)
      // Плашка «Агент 1 (GLM 5.3 Flash)» вклинивалась прямо в ленту перед
      // ответом и повторяла то, что и так стоит в подписи под ним. Кто сейчас
      // работает и над чем — это состояние, а не событие: его место в панели
      // работы, где оно живёт и обновляется, а не в тексте разговора.
    })

    // Fires once per agent, not once per turn. Ending the generating state here
    // unlocked the composer after the first stage of a pipeline while later stages
    // were still writing — the turn is finished by handleSendMessage instead.
    window.electronAPI.onMessageComplete(response => {
      const pane = paneForRequest(response?.requestId)
      if (!pane) return
      pane.totalTokens = OnlyoneTokenTally.complete(pane.tokenTally ||= OnlyoneTokenTally.fresh(), response?.agentIndex ?? 0, response?.totalTokens)
      completeAgentTask(pane, response)
      renderAgentTasks(pane)
      // Расход по каждому агенту отдельно. Общее число по ходу было и раньше,
      // но по нему нельзя было понять, кто именно потратил.
      {
        const spent = Number(response?.totalTokens || 0)
        if (spent) {
          const task = agentTaskState(pane, response?.agentIndex ?? 0, response?.agentName)
          task.tokens = (task.tokens || 0) + spent
        }
      }
      // Spend accumulates across agents; occupancy does not. The largest prompt
      // any one agent sent is what the window has to hold.
      if (Number(response?.contextTokens) > 0) pane.contextTokens = Number(response.contextTokens)
      if (response?.answeredModel && (response.agentIndex ?? 0) === 0) pane.actualModelId = response.answeredModel
      updateLiveMeta(pane)

      if (isHelperChunk(response)) {
        settleLane(pane, pane, response)
        renderAgentTasks(pane)
        if (pane.assistantEl) { paintBlocks(pane); scrollToBottom(pane) }
        return
      }

      // Carries the finished agent's complete reasoning. Replace that agent's
      // segment rather than appending, or the panel shows it twice.
      if (response?.reasoning) {
        const agent = response.agentName || ''
        const existing = pane.reasoningSegments.find(s => s.agent === agent)
        if (existing) existing.text = response.reasoning
        else pane.reasoningSegments.push({ agent, text: response.reasoning })

        // The blocks were built from the stream as it arrived, so the thought is
        // already there. It is only added here when nothing streamed — a step
        // answered without streaming, such as the closing summary. Adding it
        // unconditionally would show the whole thought a second time.
        const drawn = (pane.blocks || [])
          .filter(b => b.kind === 'thinking' && b.agent === agent)
          .map(b => b.text)
          .join('')
        if (!drawn.trim()) pushBlock(pane, 'thinking', response.reasoning, agent)

        pane.reasoningBuffer = reasoningSegmentsToText(pane)
        updateLiveAssistantUI(pane)
      }
    })

    
    window.electronAPI.onAgentFileChange(change => {
      const pane = paneForRequest(change?.requestId)
      if (!pane) return
      pane.fileChanges = pane.fileChanges || []
      pane.fileChanges.push(change)
      const liveTurn = pane.liveTurnsByChat?.get(pane.chatId)
      if (liveTurn && liveTurn !== pane) {
        liveTurn.fileChanges = liveTurn.fileChanges || []
        liveTurn.fileChanges.push(change)
      }
      markState(pane, 'tooling')
    })

    // Tool activity collapses into one line the way Claude Code does it: a
    // running count you can open, instead of a status that overwrites itself and
    // leaves no trace of what the agent actually did.
    window.electronAPI.onAgentToolLog(entry => {
      // Each call is its own row in the turn, headlined by what it did.
      {
        const p = paneForRequest(entry?.requestId)
        // Строку «ещё пишется» ставит только ведущий: у помощника свой коридор
        // в панели работы, и в общую ленту он выходит готовым итогом.
        if (p && entry?.pending && !isHelperChunk(entry)) {
          // Вызов ещё только пишется потоком: строка появляется сразу, а итог
          // допишется в неё же. Без этого минуту до артефакта в ленте ничего не
          // двигается, и ход выглядит зависшим.
          const task = agentTaskState(p, entry?.agentIndex ?? 0, entry?.agentName)
          // Заголовок шлёт главный процесс по-русски: он из `TOOL_VERBS`, и
          // перевод по дереву его не догонит — строка появляется и гаснет
          // быстрее следующего прохода.
          task.what = t(String(entry.headline || entry.tool || ''))
          task.done = false
          renderAgentTasks(p)
          markState(p, 'tooling')
          // Слова, сказанные ДО вызова, встают в ленту раньше его строки: текст рисуется с
          // задержкой, и без этого весь сказанный за ход оседал одним куском после всех вызовов.
          p.smoothCursor = (p.streamQueue || '').length; p.contentBuffer = p.streamQueue || ''; syncTextBlock(p)
          pushBlock(p, 'tool', '…', entry?.agentName || '', t(entry.headline || ''),
            { verb: t(entry.headline || entry.tool), target: '', meta: '…', tone: 'pending', tool: entry.tool })
          const block = p.blocks?.[p.blocks.length - 1]
          if (block && entry.callId) block.callId = entry.callId
          paintBlocks(p)
        } else if (p && isHelperChunk(entry)) {
          laneTool(p, p, entry)
          markState(p, 'tooling')
        } else if (p) {
          const task = agentTaskState(p, entry?.agentIndex ?? 0, entry?.agentName)
          task.what = toolHeadline(entry)
          task.tools += 1
          task.done = false
          renderAgentTasks(p)
          markState(p, 'tooling')
          const args = entry?.args ? JSON.stringify(entry.args, null, 2) : (entry?.detail || '')
          // Имя агента ставилось пустым, и строки вызовов оставались без метки:
          // «Показать» в панели работы вести к ним не могло, потому что вести
          // было не к чему.
          const started = entry.callId ? (p.blocks || []).findLastIndex(item =>
            item.kind === 'tool' && item.callId === entry.callId) : -1
          const text = String(args || entry?.tool || '')
          if (started >= 0) {
            // Итог ложится в ту же строку: блок собирается заново так же, как
            // его собирает pushBlock, — второй строки не появляется.
            p.blocks.splice(started, 1, { kind: 'tool', agent: entry?.agentName || '',
              text, title: toolHeadline(entry), parts: toolParts(entry), at: p.blocks[started].at })
          } else {
            pushBlock(p, 'tool', text, entry?.agentName || '',
              toolHeadline(entry), toolParts(entry))
          }
          paintBlocks(p)
        }
      }
      const pane = paneForRequest(entry?.requestId)
      if (pane) scrollToBottom(pane)
    })

    // Чек-лист хода рисуется тем же блоком, что и план проекта: список с
    // прогрессом уже есть, и второй способ показать то же самое был бы лишним
    // кодом ради одинаковой картинки. Блок один на ход и обновляется на месте —
    // иначе каждое обновление списка добавляло бы в ленту ещё одну его копию.
    window.electronAPI.onAgentPlan?.(plan => {
      const pane = paneForRequest(plan?.requestId)
      if (!pane) return
      const items = Array.isArray(plan?.items) ? plan.items : []
      if (!items.length) return

      // Список у каждого агента свой: в команде общий означал бы, что второй
      // помощник затирает работу первого прямо на глазах.
      //
      // В ленте план стоял отдельным блоком и на каждом обновлении дёргал всю
      // переписку. Живому списку место сбоку, рядом с работой, которую он
      // описывает; в историю хода он попадает один раз и уже готовым.
      const agent = plan?.agentName || ''
      pane.planByAgent = pane.planByAgent || new Map()
      pane.planByAgent.set(agent, items)
      // Чей список — по номеру агента, а не по имени: имя в карточке меняется,
      // когда ведущий называет часть, и «Агент 2» перестаёт совпадать с
      // «Агент 2 (Проверка вёрстки)».
      pane.planOwner = pane.planOwner || new Map()
      pane.planOwner.set(agent, Number(plan?.agentIndex ?? 0))

      // План значит многошаговую работу, и смотреть на неё надо, пока она идёт.
      // Панель открывается сама — но только если её не закрыли руками: закрыл
      // человек, значит не хочет, и открывать заново было бы навязчиво.
      if (!pane.tasksOpen && !pane.tasksDismissed && panelWelcomeHere()) toggleTasksPanel(pane, true)
      else renderAgentTasks(pane)
    })

    // Замер занятости окна с каждого шага, а не только по завершении хода.
    // Кольцо считало по сохранённой переписке, а отвечающее сообщение
    // сохраняется последним — поэтому всю работу оно стояло на нуле.
    // Доска команды. Раньше о том, кто что взял и где встало, можно было узнать
    // только из итогового отчёта — то есть после того, как всё уже кончилось.
    window.electronAPI.onAgentBoard?.(board => {
      const pane = paneForRequest(board?.requestId)
      if (!pane) return
      pane.board = { items: board?.items || [], messages: board?.messages || [] }
      if (!pane.tasksOpen && !pane.tasksDismissed && panelWelcomeHere()) toggleTasksPanel(pane, true)
      else renderAgentTasks(pane)
    })

    window.electronAPI.onAgentProgress?.(data => {
      const pane = paneForRequest(data?.requestId)
      if (!pane) return
      if (data?.totalTokens !== undefined) pane.totalTokens = OnlyoneTokenTally.progress(pane.tokenTally ||= OnlyoneTokenTally.fresh(), data.agentIndex ?? 0, data.totalTokens); const measured = Number(data?.contextTokens || 0)
      if (!measured) { updateLiveMeta(pane); return }
      pane.contextTokens = measured
      updateLiveMeta(pane)
      renderContextRing(pane)
    })

    window.electronAPI.onAgentEvent(event => {
      const pane = paneForRequest(event?.requestId)
      if (!pane) return
      {
        const task = agentTaskState(pane, event?.agentIndex ?? 0, event?.agentName)
        // Начало шага не занятие, а отметка: она обновляет счётчик и не трогает
        // строку о том, что агент делает. Единственный случай, когда сказать
        // действительно нечего, — самый первый шаг.
        if (event?.phase === 'step') {
          task.step = Number(event.step) || 0
          task.stepLimit = Number(event.limit) || 0
          if (!task.what || task.what === 'готовится') task.what = t('Думает над задачей')
        } else if (event?.message) {
          // Главный процесс говорит по-русски: он не знает, какой язык у окна.
          // Перевод ставится здесь — на границе, где сообщение становится
          // строкой в ленте.
          task.what = t(String(event.message))
        }
        // A turn blocked on a question is not a turn that has stopped, and the
        // two looked identical — the app waits up to half an hour for a click
        // it never says it is waiting for.
        const wasWaiting = Boolean(task.waiting)
        if (event?.awaitingApproval === true) task.waiting = true
        if (event?.awaitingApproval === false) task.waiting = false
        renderAgentTasks(pane)
        // «ждёт вас» у чата в боковой панели
        if (wasWaiting !== Boolean(task.waiting)) renderChatHistory()

        // The question must not be behind a closed panel or off the bottom of
        // the feed: an unnoticed card is a frozen application.
        if (event?.awaitingApproval === true) {
          toggleTasksPanel(pane, true)
          requestAnimationFrame(() => {
            document.querySelector('.approval-card')
              ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          })
        }
      }

    })

    // The approval card is the one moment the user is asked to take
    // responsibility, so it is built to be read: what kind of change, which
    // file, how much of it moves, and the diff itself folded away until wanted.
    // Вопрос с вариантами. Ход стоит и ждёт человека, поэтому карточка обязана
    // быть заметной и отвечаться одним нажатием: вопрос, который надо искать
    // глазами, ничем не лучше зависшего приложения.
    window.electronAPI.onAgentQuestion?.(request => {
      if (request?.closed) {
        const pending = questionCards.get(request.id)
        if (pending) {
          pending.card.querySelectorAll('button, input').forEach(node => { node.disabled = true })
          questionCards.delete(request.id)
        }
        return
      }
      const isDesign = designRun?.requestId === request?.requestId
      const pane = isDesign ? { dom: { list: $('designMessages') } } : paneForRequest(request?.requestId)
      if (!pane?.dom?.list) return

      const card = document.createElement('div')
      card.className = 'ask-card'
      const options = Array.isArray(request?.options) ? request.options : []

      const swatch = colors => (Array.isArray(colors) && colors.length)
        ? `<span class="ask-swatch">${colors.map(c =>
            `<i style="background:${escapeHtml(String(c))}"></i>`).join('')}</span>`
        : ''

      // Набросок приходит от модели, поэтому в разметку он попадает только как
      // цельный svg и только без скриптов и внешних ссылок: всё остальное
      // отбрасывается вместе с вариантом, а не чинится на месте.
      const sketch = svg => {
        const text = String(svg || '').trim()
        if (!/^<svg[\s>]/i.test(text) || !/<\/svg>\s*$/i.test(text)) return ''
        if (/<script|javascript:|<foreignObject|xlink:href|href\s*=|<image/i.test(text)) return ''
        // An image document cannot execute SVG event handlers or access this page.
        return `<span class="ask-sketch"><img alt="Набросок варианта" style="max-width:100%;max-height:180px" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}"></span>`
      }

      card.innerHTML = `
        ${request?.asker ? `<div class="ask-asker">${escapeHtml(String(request.asker))}</div>` : ''}
        <div class="ask-question">${escapeHtml(String(request?.question || ''))}</div>
        ${request?.note ? `<div class="ask-note">${escapeHtml(String(request.note))}</div>` : ''}
        <div class="ask-options">
          ${options.map((option, index) => `
            <button type="button" class="ask-option" data-index="${index}">
              ${sketch(option.svg)}
              ${swatch(option.colors)}
              <span class="ask-option-text">
                <span class="ask-option-label">${escapeHtml(String(option.label || ''))}</span>
                ${option.detail ? `<span class="ask-option-detail">${escapeHtml(String(option.detail))}</span>` : ''}
              </span>
            </button>`).join('')}
        </div>
        <form class="ask-own">
          <input type="text" class="ask-own-input" placeholder="Или своими словами">
          <button type="submit" class="ask-own-send">Ответить</button>
        </form>`

      const detached = !isDesign && isDetachedTurn(pane)
      if (!detached) pane.dom.list.appendChild(card)
      questionCards.set(request.id, { card, designId: isDesign ? designRun.design.id : null,
        chatId: isDesign ? null : pane.chatId })
      if (isDesign) card.scrollIntoView({ block: 'nearest' })
      else if (!detached) scrollToBottom(pane, true)

      let answered = false
      const reply = async text => {
        if (answered) return
        answered = true
        card.querySelectorAll('button, input').forEach(node => { node.disabled = true })
        const said = document.createElement('div')
        said.className = 'ask-answered'
        said.textContent = `Ответ: ${text}`
        try {
          await window.electronAPI.resolveAgentQuestion({ id: request.id, answer: text })
          card.classList.add('answered')
          card.appendChild(said)
        } catch (error) {
          answered = false
          card.querySelectorAll('button, input').forEach(node => { node.disabled = false })
          showToast(cleanErrorText(error), true)
        }
      }

      for (const button of card.querySelectorAll('.ask-option')) {
        button.addEventListener('click', () => {
          const option = options[Number(button.dataset.index)] || {}
          reply([option.label, option.detail].filter(Boolean).join(' — '))
        })
      }
      card.querySelector('.ask-own')?.addEventListener('submit', event => {
        event.preventDefault()
        const field = card.querySelector('.ask-own-input')
        const text = String(field?.value || '').trim()
        if (text) reply(text)
      })
      card.querySelector('.ask-own-input')?.focus()
    })
    // Предложение связанного чата приходит из хода, но ничего не создаёт:
    // человек нажимает «создать» или «отклонить». Запись ложится в опись на
    // родителе сразу, чтобы карточка пережила перезапуск; карточка живёт в
    // ленте и возвращается после перерисовки, как карточка вопроса.
    window.electronAPI.onForkProposal?.(payload => {
      const pane = paneForRequest(payload?.requestId)
      if (!pane?.dom?.list) return
      const source = conversations.find(chat => chat.id === (pane.chatId || pane.liveChatId))
      if (!source) return
      let proposal
      try {
        proposal = OnlyoneForkProposal.normalize(payload?.proposal, {
          parentChatId: source.id,
          messages: source.messages
        })
      } catch { return }
      const known = OnlyoneForkProposalStore.status(source, proposal.operationId)
      if (known === 'accepted' || known === 'rejected') return
      if (OnlyoneForkProposal.findChild(conversations, proposal.operationId, source.id) ||
          OnlyoneForkProposal.isDismissed(source, proposal.operationId)) return
      const key = source.id + ':' + proposal.operationId
      if (forkProposalCards.has(key)) return
      const stored = OnlyoneForkProposalStore.put(source, proposal)
      if (stored.ok) {
        saveConversations()
        flushConversations().then(saved => {
          if (!saved) showToast(t('Не удалось сохранить предложение.'), true)
        })
      } else if (stored.reason === 'invalid-shape' || stored.reason === 'unknown-version') {
        proposalLedgerWarned.add(source.id)
        showToast(t('Предложения этого чата не читаются: запись повреждена.'), true)
      }
      // В чужой ленте карточке не место: опись уже сохранена, карточка
      // вернётся из неё при переключении на свой чат.
      if (isDetachedTurn(pane)) return
      const card = OnlyoneForkProposal.mountCard(pane.dom.list, proposal, {
        t,
        parentTitle: source.title || t('Новый диалог'),
        status: 'pending',
        problem: stored.ok ? null : { code: 'unreadable', text: t('Предложения этого чата не читаются: запись повреждена.') },
        ...forkProposalHandlers(source, pane)
      })
      forkProposalCards.set(key, { chatId: source.id, card })
      refreshForkProposalSummary(pane)
      scrollToBottom(pane, true)
    })

    window.electronAPI.onAgentApproval(request => {
      if (designRun?.requestId === request?.requestId) {
        askConfirm(`${request.summary || 'Запрос разрешения'}\n\n${request.details || ''}`)
          .then(approved => window.electronAPI.resolveAgentApproval({ id: request.id, approved }))
          .catch(err => showToast(cleanErrorText(err), true))
        return
      }
      const pane = paneForRequest(request?.requestId)
      if (!pane) return
      const summary = request.summary || 'Запрос разрешения'
      const kind =
        /удал/i.test(summary) ? 'delete'
        : /перезап/i.test(summary) ? 'write'
        : /создать файл/i.test(summary) ? 'create'
        : /папк/i.test(summary) ? 'folder'
        : /mcp/i.test(summary) ? 'external'
        : /^читать |локальный адрес/i.test(summary) ? 'web'
        : 'write'

      const ICONS = {
        create: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6M9 15h6"/>',
        write: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/>',
        delete: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
        folder: '<path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-7.6a1 1 0 0 1-.8-.4l-1.2-1.6a1 1 0 0 0-.8-.4H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1z"/>',
        external: '<rect width="16" height="12" x="4" y="6" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4"/>',
        web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'
      }

      // "path\n120 байт · +5 / -2 строк" — split so each part can be styled.
      const detailLines = String(request.details || '').split('\n')
      const target = detailLines[0] || ''
      const meta = detailLines.slice(1).join(' · ')

      const card = document.createElement('div')
      card.className = `approval-card kind-${kind}`
      card.dataset.approvalId = request.id
      card.innerHTML = `
        <div class="approval-head">
          <span class="approval-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>
          </span>
          <div class="approval-headings" data-tooltip="${escapeHtml(String(request.details || '').slice(0, 400))}">
            <div class="approval-action">${escapeHtml(t(summary))}</div>
            ${target ? `<div class="approval-target">${escapeHtml(target)}</div>` : ''}
          </div>
          ${meta ? `<div class="approval-meta">${escapeHtml(meta)}</div>` : ''}
        </div>

        ${request.diff ? `
          <button type="button" class="approval-toggle">
            <svg fill="none" class="icon small approval-caret" viewBox="0 0 16 16"><path d="M6 3.2L10.8 8 6 12.8"/></svg>
            <span>${escapeHtml(t('Показать изменения'))}</span>
          </button>
          <pre class="approval-diff" hidden><code>${renderDiffLines(request.diff)}</code></pre>
        ` : ''}

        <div class="approval-actions">
          <button class="approval-deny" type="button">${escapeHtml(t('Отклонить'))}</button>
          <button class="approval-allow" type="button">${escapeHtml(t('Разрешить'))}</button>
        </div>
      `

      const toggle = card.querySelector('.approval-toggle')
      toggle?.addEventListener('click', () => {
        const diff = card.querySelector('.approval-diff')
        diff.hidden = !diff.hidden
        card.classList.toggle('diff-open', !diff.hidden)
        toggle.querySelector('span').textContent = t(diff.hidden ? 'Показать изменения' : 'Скрыть изменения')
        scrollToBottom(pane)
      })

      const allowBtn = card.querySelector('.approval-allow')
      const denyBtn = card.querySelector('.approval-deny')

      const respond = async approved => {
        allowBtn.disabled = true
        denyBtn.disabled = true
        try {
          await window.electronAPI.resolveAgentApproval({ id: request.id, approved })
          // Ответ дан — карточке больше нечего делать в ленте: она исчезает.
          approvalCards.delete(request.id)
          card.remove()
        } catch (err) {
          allowBtn.disabled = false
          denyBtn.disabled = false
          showToast(err?.message || 'Ошибка', true)
        }
      }

      allowBtn.addEventListener('click', () => respond(true))
      denyBtn.addEventListener('click', () => respond(false))

      approvalCards.set(request.id, { card, chatId: pane.chatId })
      if (!isDetachedTurn(pane)) {
        pane.dom.list.appendChild(card)
        scrollToBottom(pane)
      }
    })

    // Ожидание снято: часть прервана по сроку или ход остановлен. Кнопки
    // убираются, карточка остаётся в ленте как след того, что вопрос был.
    window.electronAPI.onAgentApprovalDone?.(done => {
      approvalCards.delete(done?.id)
      const card = document.querySelector(`.approval-card[data-approval-id="${CSS.escape(String(done?.id || ''))}"]`)
      if (!card || card.classList.contains('resolved-allow') || card.classList.contains('resolved-deny')) return
      card.remove()
    })

    window.electronAPI.onMcpStatus(status => {
      mcpState = status
      refreshMcp()
    })

    window.electronAPI.onSkillsUpdate(skills => {
      skillsList = skills
      refreshSkills()
    })
  }

  // Init
  // Each setup step is isolated. Previously they ran as one sequence, so a single
  // throw part-way through left every later listener unregistered — the window
  // rendered but nothing at all responded to a click, including the close button.
  // One broken feature should cost that feature, not the whole interface.
  function safely(label, fn) {
    try {
      fn()
    } catch (err) {
      console.error(`Не удалось настроить «${label}»:`, err)
    }
  }

  async function init() {
    // Panes first: everything else binds to their elements.
    // Ни одна форма здесь не отправляется браузером: всё отправляет код. А вот
    // подключается этот код в конце длинной асинхронной инициализации — после
    // чтения настроек, диалогов, проектов и дизайнов. До тех пор Enter в поле
    // ввода вызывал настоящую отправку формы, то есть попытку увести страницу.
    // Спасала только политика безопасности, и единственным следом происшествия
    // была её ругань в консоли: нажатие пропадало молча. Запрет вешается здесь,
    // синхронно, и не зависит ни от какой загрузки.
    document.addEventListener('submit', event => event.preventDefault(), true)

    buildPanes()
    safely('разделитель чатов', setupSplitResizer)
    safely('боковая панель', setupSidebarToggle)
    safely('горячие клавиши', setupShortcuts)
    safely('разделитель дизайна', setupDesignResizer)
    safely('personal', setupPersonal)
    loadPersonal()
    safely('разделы настроек', setupSettingsTabs)
    safely('обновления', setupUpdates)
    safely('кольцо контекста', setupContextRing)
    safely('вставка картинок', setupImagePaste)
    safely('файл из ленты в превью', setupRailOpen)
    safely('память', setupMemorySetting)
    safely('видео', setupVideoTools)
    safely('бюджет', () => { budgetSettings = setupBudgetSettings() })
    safely('удалённое управление', setupRemoteControl)
    safely('страница проектов', setupProjectsPage)
    safely('заголовок чата', setupChatHeader)
    safely('подсказки', setupSuggestions)
    safely('цитирование', setupQuoting)
    safely('обработчики интерфейса', setupEventListeners)
    safely('события главного процесса', setupIpcListeners)
    safely('вложения', setupAttachmentEvents)
    safely('знак агента', setupMarkEvents)
    for (const pane of panes) safely('прокрутка', () => setupScrollTracking(pane))
    safely('ui-config', setupUiConfig)

    // Без моста к главному процессу (preload не отработал) окно не прочитает ни
    // настроек, ни переписки. В обычном браузере моста нет и быть не должно.
    if (!window.electronAPI && /Electron/.test(navigator.userAgent) &&
      recoverFromMissingData('нет моста к главному процессу')) return
    // Главный процесс может и не ответить: тогда запуск висел бы на первом же
    // await, и окно так и стояло бы пустым.
    const bootWatch = setTimeout(() => recoverFromMissingData(`данные не пришли за ${BOOT_DATA_WAIT_MS / 1000} с`), BOOT_DATA_WAIT_MS)

    try {
      // Наблюдатель ставится до первого перевода: разделы дорисовываются и после
      // загрузки, и перевод обязан догонять их, а не сниматься один раз.
      watchTranslations()
      const settings = await window.electronAPI?.getSettings?.()
      if (settings?.language === 'en') await setLanguage('en', { persist: false })
    } catch {}

    renderEffortChips()
    renderModelCards()

    await refreshToolCapability()
    await loadProjects()
    const historyLoaded = await loadConversations()
    clearTimeout(bootWatch)
    if (historyLoaded) noteBootRecovered()
    else if (recoverFromMissingData('чтение переписки не удалось')) return
    renderProjects()
    if (conversations.length > 0) {
      selectChat(panes[0], conversations[0].id)
    } else {
      createNewChat(panes[0])
    }

    for (const pane of panes) autoResizeTextarea(pane)
    refreshKeysPool()
    refreshCustomProvider()
    refreshWorkspace()
    refreshMcp()
    refreshSkills()
    await loadDesigns()
    setupDesignEvents()
    updateDesignBadge()
    renderDesignModelPill()
    loadModelsCatalog()
    watchLongTasks()
    // Списки с data-segmented показаны переключателями — свой список им не нужен.
    document.querySelectorAll('select.field-select:not([data-segmented])').forEach(enhanceSelect)
    await showInterruptedRuns()
    // Метка центра задач нужна с самого начала: прерванные ходы становятся
    // известны только что, а раздел человек ещё не открывал.
    safely('метка центра задач', () => taskCenter().refresh())
    // Мост для вступительного экрана (onboarding.js): перевод, личное и ключи
    // он берёт отсюда, а не держит свои копии.
    window.onlyoneApp = Object.freeze({
      t,
      greeting: () => greetingText(),
      personal: () => ({ ...personal }),
      accents: ACCENTS,
      roles: PERSONAL_ROLES,
      focus: PERSONAL_FOCUS,
      savePersonal: patch => {
        savePersonal(patch, { now: true })
        if ('name' in patch && $('personalName')) $('personalName').value = personal.name || ''
        if ('theme' in patch || 'role' in patch || 'focus' in patch) paintPersonalLook()
        if ('theme' in patch && $('personalTheme')) $('personalTheme').value = personal.theme || 'dark'
        paintGreeting()
      },
      lang: () => uiLang,
      // Тем же путём, что переключатель в Персонализации: язык запоминается и
      // переводит всё окно.
      setLanguage: lang => {
        if (!el.languageSelect) return
        el.languageSelect.value = lang
        el.languageSelect.dispatchEvent(new Event('change', { bubbles: true }))
      },
      keysCount: () => keysPool.length,
      // Пустой «Новый диалог» приложение заводит само — это ещё не работа.
      chatsCount: () => conversations.filter(chat => chat.messages?.length).length,
      refreshKeys: () => refreshKeysPool(),
      getUiConfig: () => currentUiConfig,
      applyUiConfig: cfg => applyUiConfig(cfg),
      renderProposal: (pane, prop) => {
        const p = pane || activePane || panes[0]
        const chat = chatOf(p)
        if (chat) {
          // Чат ищется заново по id: историю могли перечитать, ссылке не верим.
          const target = conversations.find(c => c.id === chat.id) || chat
          target.messages.push({
            role: 'assistant',
            content: '',
            uiProposal: {
              id: prop?.id || 'prop-' + Date.now(),
              label: prop?.label || t('Изменение интерфейса'),
              patch: prop?.patch || {},
              state: prop?.state || 'pending'
            }
          })
          renderMessages(p)
        }
      }
    })
    window.onlyoneOnboarding?.init()

    // Окно живёт задолго до этой строки: разметка на месте, часть обработчиков
    // уже подключена, а часть — ещё нет. Снаружи эти два состояния неотличимы,
    // и проверки угадывали момент готовности паузой в миллисекундах — отсюда и
    // падения раз в несколько прогонов. Признак ставится последним действием
    // инициализации и означает ровно одно: подключено всё.
    document.documentElement.dataset.appReady = '1'
  }

  // ---------------------------------------------------------------------------
  // Design
  // ---------------------------------------------------------------------------
  // A design is a conversation whose output is a set of Design Components rather
  // than an answer. The model writes them with the dc_* tools; the preview is the
  // same files rendered live, so what the user judges is the deliverable itself
  // and not a screenshot of it.

  // The formats. Each one only seeds the first message and the preview canvas —
  // nothing here constrains what the model may build afterwards.
  const DESIGN_STARTERS = [
    { id: 'blank',     name: 'С чистого листа', hint: 'Ничего не задано заранее', w: 1440, h: 900 },
    { id: 'mobile',    name: 'Мобильное приложение', hint: 'Экраны под телефон', w: 390, h: 844 },
    { id: 'slides',    name: 'Слайды', hint: 'Презентация 16:9', w: 1280, h: 720 },
    { id: 'document',  name: 'Документ', hint: 'Страница под чтение', w: 816, h: 1056 },
    { id: 'wireframe', name: 'Вайрфрейм', hint: 'Структура без отделки', w: 1440, h: 900 },
    { id: 'animation', name: 'Анимация', hint: 'Движение и переходы', w: 1200, h: 800 },
    { id: 'ui',        name: 'UI-макеты', hint: 'Экраны интерфейса', w: 1440, h: 900 },
    { id: 'resume',    name: 'Резюме', hint: 'Одна страница A4', w: 816, h: 1056 },
    { id: 'research',  name: 'Исследование', hint: 'Разбор с выкладками', w: 1000, h: 1400 },
    { id: 'email',     name: 'HTML-письмо', hint: 'Узкая колонка письма', w: 640, h: 900 },
    { id: 'palette',   name: 'Цвет и шрифт', hint: 'Палитра и пары гарнитур', w: 1200, h: 800 },
    { id: 'diagram',   name: 'Схема', hint: 'Связи и потоки', w: 1400, h: 900 },
    { id: 'flier',     name: 'Флаер', hint: 'Печатный лист A5', w: 583, h: 827 }
  ]

  const STARTER_ICON = {
    blank:     '<rect x="3" y="3" width="18" height="18" rx="2"/>',
    mobile:    '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10.5 19h3"/>',
    slides:    '<rect x="2.5" y="5" width="19" height="12" rx="1.6"/><path d="M9 20h6"/>',
    document:  '<path d="M6 2.5h8l4 4v15H6z"/><path d="M14 2.5v4h4"/>',
    wireframe: '<rect x="2.5" y="3.5" width="19" height="17" rx="1.6"/><path d="M2.5 9h19M9 9v11.5"/>',
    animation: '<circle cx="7" cy="12" r="3.5"/><path d="M13 8.5h8M13 12h6M13 15.5h8"/>',
    ui:        '<rect x="2.5" y="3.5" width="19" height="17" rx="1.6"/><path d="M2.5 8h19"/><path d="M6 12h6M6 15.5h9"/>',
    resume:    '<path d="M5 2.5h14v19H5z"/><circle cx="12" cy="8.5" r="2.4"/><path d="M8 16.5c.8-2 7.2-2 8 0"/>',
    research:  '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
    email:     '<rect x="2.5" y="5" width="19" height="14" rx="1.8"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
    palette:   '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.7 1.6-1.5 0-1.6 1-2 2.2-2H18a3.5 3.5 0 0 0 3.5-3.5C21.5 7.6 17.2 3 12 3z"/><circle cx="7.5" cy="11" r="1.1"/><circle cx="11" cy="7.5" r="1.1"/><circle cx="15.5" cy="9" r="1.1"/>',
    diagram:   '<rect x="2.5" y="3.5" width="7" height="5" rx="1.2"/><rect x="14.5" y="3.5" width="7" height="5" rx="1.2"/><rect x="8.5" y="15.5" width="7" height="5" rx="1.2"/><path d="M6 8.5v3h12v-3M12 11.5v4"/>',
    flier:     '<rect x="5" y="2.5" width="14" height="19" rx="1.4"/><path d="M8 7h8M8 11h8M8 15h5"/>'
  }

  let designs = []
  let activeDesign = null          // the open design's object, or null in the gallery
  let designComponents = []        // file names in the open design
  let designActiveComponent = ''   // which one the preview shows
  let designBusy = false
  let designRun = null
  // Какие правки из чата окно приняло и ещё не закрыло: requestId → id макета
  // Ход Дизайна кончился — по этому списку главный процесс
  // переводит карточку в «готово» с номером версии.
  const designEditTurns = new Map()
  const designTaskPanes = new Map()
  const questionCards = new Map()
  // Разрешения detached-хода ждут в этой карте и возвращаются в свою ленту
  // при переключении, как карточки вопроса.
  const approvalCards = new Map()
  // Предложения связанного чата — по одной карточке на операцию и чат. Лента
  // перерисовывается целиком, поэтому узел возвращается так же, как вопрос
  // ask_user: карточка не часть сообщения и без возврата исчезала бы.
  const forkProposalCards = new Map()
  // Опись предложений не читается: предупреждаем один раз на чат за сеанс.
  const proposalLedgerWarned = new Set()
  // Ходы, оборванные закрытием или падением приложения: одна карточка на чат
  // и одна на макет.
  const resumeCards = new Map()
  const designResumeCards = new Map()

  // Карточка стоит в своей ленте — в чате или в макете — и говорит, что успело
  // сделаться и что надо проверить. «Продолжить» отправляет модели опись из
  // главного процесса, а не просьбу повторить: команда, оборванная на середине,
  // не выполнится вслепую второй раз. Ленту и действие продолжения задаёт тот,
  // кто карточку заводит, — дальше они ведут себя одинаково.
  function interruptedRunCard(run, targetId, { cards, submit }) {
    const card = document.createElement('div')
    card.className = 'approval-card kind-resume'
    card.dataset.runId = run.runId
    // Одна строка: что случилось, о чём была просьба, два действия. Счётчики
    // «сделано / проверить» владелец убрал — опись всё равно уходит модели.
    const lines = run.unknown.map(item =>
      `<span>${escapeHtml(`${item.tool}${item.target ? ': ' + item.target : ''}`)}</span>`).join('')
    card.innerHTML = `
      <div class="approval-head">
        <span class="approval-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
        </span>
        <div class="approval-headings">
          <div class="approval-action">${escapeHtml(t('Работа прервалась: приложение закрылось'))}</div>
          ${run.ask ? `<div class="resume-ask">${escapeHtml(run.ask)}</div>` : ''}
        </div>
        <div class="resume-buttons">
          <button class="approval-deny" type="button">${escapeHtml(t('Скрыть'))}</button>
          <button class="approval-allow" type="button">${escapeHtml(t('Продолжить'))}</button>
        </div>
      </div>
      ${lines ? `
        <button type="button" class="approval-toggle">
          <svg fill="none" class="icon small approval-caret" viewBox="0 0 16 16"><path d="M6 3.2L10.8 8 6 12.8"/></svg>
          <span>${escapeHtml(t('Показать действия'))}</span>
        </button>
        <pre class="approval-diff" hidden><code>${lines}</code></pre>
      ` : ''}
    `
    const toggle = card.querySelector('.approval-toggle')
    toggle?.addEventListener('click', () => {
      const list = card.querySelector('.approval-diff')
      list.hidden = !list.hidden
      card.classList.toggle('diff-open', !list.hidden)
      toggle.querySelector('span').textContent = t(list.hidden ? 'Показать действия' : 'Скрыть действия')
    })
    const hide = () => {
      cards.delete(targetId)
      card.remove()
    }
    const close = () => {
      hide()
      window.electronAPI.dismissInterruptedRun?.(run.runId)
    }
    card.querySelector('.approval-deny').addEventListener('click', close)
    card.querySelector('.approval-allow').addEventListener('click', () => {
      // Контрольную точку снимает главный процесс: он читает из неё остаток
      // бюджета цикла тем же ходом, что продолжает. Удалить её окном раньше —
      // значит начать продолжение с полным комплектом попыток.
      if (!submit(run.prompt, run.runId)) return
      hide()
    })
    return card
  }

  async function showInterruptedRuns() {
    let runs = []
    try {
      runs = await window.electronAPI?.interruptedRuns?.() || []
    } catch {
      return
    }
    for (const run of runs) {
      // Ход Дизайна относится к своему макету: в чате его показывать негде, а
      // в галерее он только мешал бы — карточка ждёт, пока макет откроют.
      if (run.designId) {
        if (!designs.some(item => item.id === run.designId)) {
          window.electronAPI.dismissInterruptedRun?.(run.runId)
          continue
        }
        if (designResumeCards.has(run.runId) || designQueue.get(run.designId)?.resumeRunId === run.runId) continue
        const card = interruptedRunCard(run, run.runId, {
          cards: designResumeCards,
          submit: (prompt, runId) => {
            if (activeDesign?.id !== run.designId) return false
            // Макет занят новым ходом — опись встаёт в очередь, как и любое
            // сообщение, а не теряется из-за того, что кнопка сейчас занята.
            if (designBusy) {
              if (!queueDesignMessage(run.designId, {
                text: t('Продолжить прерванную работу'), hidden: prompt, resumeRunId: runId
              })) {
                showToast(t('В этом макете уже есть сообщение в очереди'), true)
                return false
              }
              // Видимой остаётся просьба «продолжить», опись и id хода едут с ней.
              return true
            }
            sendDesignMessage(t('Продолжить прерванную работу'), { hidden: prompt, resumeRunId: runId })
            return true
          }
        })
        card.dataset.designId = run.designId
        designResumeCards.set(run.runId, card)
        continue
      }
      // Повреждённая запись прерванного хода (Н9): чата нет, но работа была.
      // Файл не удаляем и не молчим — исход неизвестен, работа не «с нуля».
      if (!run.chatId) {
        showToast(t('Запись прерванной работы повреждена — неизвестно, что успело сделаться.'), true)
        continue
      }
      const chat = run.chatId && conversations.find(item => item.id === run.chatId)
      // Чат удалён или в нём уже есть карточка поновее (главный процесс отдаёт
      // свежие первыми) — показывать негде.
      if (!chat || resumeCards.has(chat.id)) {
        window.electronAPI.dismissInterruptedRun?.(run.runId)
        continue
      }
      resumeCards.set(chat.id, interruptedRunCard(run, chat.id, {
        cards: resumeCards,
        submit: (prompt, runId) => {
          const pane = panes.find(item => item.chatId === chat.id)
          if (!pane || pane.generating) return false
          handleSendMessage(pane, t('Продолжить прерванную работу'), { hidden: prompt, resumeRunId: runId })
          return true
        }
      }))
    }
    for (const pane of panes) if (resumeCards.has(pane.chatId)) renderMessages(pane)
    if (activeDesign && [...designResumeCards.values()].some(card => card.dataset.designId === activeDesign.id)) renderDesignMessages()
  }
  let commentPicking = false
  let elementPicking = false
  let selectedDesignElement = null

  const designStarter = id => DESIGN_STARTERS.find(s => s.id === id) || DESIGN_STARTERS[0]

  async function loadDesigns() {
    if (!window.electronAPI?.getDesigns) { designs = []; return }
    try {
      const stored = await window.electronAPI.getDesigns()
      designs = Array.isArray(stored) ? stored : []
    } catch (err) {
      console.error('Не удалось загрузить дизайны:', err)
      designs = []
    }
  }

  function saveDesigns() {
    if (!window.electronAPI?.setDesigns) return
    window.electronAPI.setDesigns(designs).catch(err =>
      console.error('Не удалось сохранить дизайны:', err))
  }

  function updateDesignBadge() {
    setNavCount(el.designBadge, designs.length)
  }

  // --- gallery ---------------------------------------------------------------

  // Галерея — модуль design-gallery.js: строка «что нарисовать», полка форматов,
  // «Ваши дизайны» с превью. Здесь только проводка.
  // Удаление карточки в галерее и из рабочего места одним путём
  async function deleteDesignById(id) {
    const design = designs.find(d => d.id === id)
    if (!design) return
    if (designRun?.design.id === id) {
      showToast('Сначала остановите выполнение дизайна.', true)
      return
    }
    const name = design.name || 'Без названия'
    if (!(await askConfirm(`Удалить дизайн «${name}» вместе с макетами?`))) return
    await window.electronAPI?.designDelete?.(id)
    designs = designs.filter(d => d.id !== id)
    saveDesigns()
    if (activeDesign?.id === id) closeDesign()
    else refreshDesignPage()
    showToast(`Дизайн «${name}» удалён`)
  }
  let designGalleryInstance = null
  function designGallery() {
    if (!designGalleryInstance) designGalleryInstance = window.OnlyoneDesignGallery.create({
      formats: () => DESIGN_STARTERS,
      designs: () => designs,
      liveId: () => designRun?.design?.id || '',
      open: id => openDesign(id),
      start: (format, text) => createDesign(format, text),
      relTime: at => formatRelativeTime(at),
      remove: id => deleteDesignById(id)
    })
    return designGalleryInstance
  }

  function renderDesignStarters() {
    const host = $('designGallery')
    if (host && !host.querySelector('#dsNewForm')) designGallery().render(host)
  }

  function renderDesignList() {
    designGallery().cards()
  }

  function refreshDesignPage() {
    updateDesignBadge()
    if (activeDesign) return
    renderDesignStarters()
    renderDesignList()
    $('designGallery')?.removeAttribute('hidden')
    $('designWorkspace')?.setAttribute('hidden', '')
  }

  async function createDesign(starterId, text = '') {
    const starter = designStarter(starterId)
    const brief = String(text || '').trim()
    const design = {
      // The id is also a folder name, so it stays in the alphabet the store allows.
      id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: brief ? (brief.length > 40 ? brief.slice(0, 39) + '…' : brief) : starter.id === 'blank' ? 'Новый дизайн' : starter.name,
      titleGenerated: false,
      starter: starter.id,
      messages: [],
      comments: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    designs.unshift(design)
    saveDesigns()
    await openDesign(design.id)
    if (brief && activeDesign?.id === design.id) await sendDesignMessage(brief)
  }

  // --- one design ------------------------------------------------------------

  // Какое сообщение держит окно открытым. Главный процесс не
  // подглядывает в окно: он знает про открытый макет ровно то, что окно само
  // скажет, — и от этого зависит, пойдёт ли правка из чата ходом Дизайна сейчас
  // или встанет в ожидание. `null` — «ушли с макета».
  function reportDesignFocus(designId) {
    if (!window.electronAPI?.designFocus) return
    // Строка или `null`: ушли с макета — главный процесс обязан это узнать,
    // иначе правка уйдёт в окно, которое её уже не покажет.
    const layout = String(designId || '') || null
    window.electronAPI.designFocus(layout)
  }

  async function openDesign(id) {
    designActiveComponent = ''
    designManualComponent = false
    activeDesign = designs.find(d => d.id === id) || null
    if (!activeDesign) return
    reportDesignFocus(activeDesign.id)
    // Do not leave another design's refs or preview actionable during loading.
    designRefs = []
    designPendingRefs = []
    designComponents = []
    setCommentPicking(false)
    renderDesignRefs()
    renderDesignTabs()
    renderDesignPreview()
    switchTab('design')
    $('designGallery')?.setAttribute('hidden', '')
    $('designWorkspace')?.removeAttribute('hidden')
    const title = $('designTitle')
    if (title) title.textContent = activeDesign.name || 'Без названия'
    paintDesignCanvasLabel()
    renderDesignMessages()
    renderDesignQueue()
    renderDesignComments()
    syncDesignRunControls()
    refreshTasksPanel()
    await refreshDesignRefs()
    await refreshDesignComponents()
    $('designComposerTextarea')?.focus()
    startQueuedDesignIfReady()
  }

  function closeDesign() {
    activeDesign = null
    // Макета перед окном больше нет: сказать об этом главному процессу, иначе
    // отложенная правка ушла бы в рабочее место, которое уже закрыто.
    reportDesignFocus(null)
    refreshTasksPanel()
    if (designRun) designRun.assistantEl = null
    designComponents = []
    designActiveComponent = ''
    setCommentPicking(false)
    refreshDesignPage()
  }

  let designManualComponent = false
  async function refreshDesignComponents() {
    if (!activeDesign) return
    const designId = activeDesign.id
    try {
      const res = await window.electronAPI?.designComponents?.(designId)
      if (activeDesign?.id !== designId) return
      designComponents = res?.ok ? res.components : []
      if (!designManualComponent && designComponents.includes(res?.entry)) designActiveComponent = res.entry
    } catch {
      if (activeDesign?.id !== designId) return
      designComponents = []
    }
    if (!designComponents.includes(designActiveComponent)) {
      designActiveComponent = designComponents[0] || ''
    }
    renderDesignTabs()
    renderDesignPreview()
  }

  function paintDesignCanvasLabel() {
    if (!activeDesign) return
    const f = designStarter(activeDesign.starter)
    const size = $('designCanvasSize')
    if (size) size.textContent = `${t(f.name)}, ${f.w} × ${f.h}`
    const box = $('designComposerTextarea')
    if (box) box.placeholder = t(designComponents.length ? 'Что поменять в макете?' : 'Что спроектировать?')
  }

  function renderDesignTabs() {
    const host = $('designComponentTabs')
    if (!host) return
    host.innerHTML = ''
    host.hidden = designComponents.length < 2
    paintDesignCanvasLabel()
    for (const name of designComponents) {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = `design-tab${name === designActiveComponent ? ' active' : ''}`
      tab.setAttribute('aria-pressed', String(name === designActiveComponent))
      tab.textContent = name.replace(/\.dc\.html$/, '')
      tab.addEventListener('click', () => {
        designManualComponent = true
        designActiveComponent = name
        renderDesignTabs()
        renderDesignPreview()
      })
      host.appendChild(tab)
    }
  }

  // Превью само вписывает макет в доступное место; выбор устройств не нужен.
  let previewNatural = 0
  let previewNaturalHeight = 0
  const designPreviewLayouts = new Map()
  const DESIGN_PREVIEW_LAYOUT_LIMIT = 80

  function designPreviewLayoutKey() {
    if (!activeDesign?.id || !designActiveComponent) return ''
    return `${encodeURIComponent(String(activeDesign.id))}/${encodeURIComponent(String(designActiveComponent))}`
  }

  function rememberDesignPreviewLayout(frame, scale, responsive = false) {
    const key = designPreviewLayoutKey()
    if (!key || !frame || (!previewNatural && !responsive)) return
    designPreviewLayouts.delete(key)
    designPreviewLayouts.set(key, {
      responsive,
      naturalWidth: previewNatural,
      naturalHeight: previewNaturalHeight,
      width: frame.style.width,
      height: frame.style.height,
      boxSizing: frame.style.boxSizing,
      zoom: frame.style.zoom,
      scale
    })
    while (designPreviewLayouts.size > DESIGN_PREVIEW_LAYOUT_LIMIT) {
      designPreviewLayouts.delete(designPreviewLayouts.keys().next().value)
    }
  }

  function restoreDesignPreviewLayout(frame) {
    const key = designPreviewLayoutKey()
    const layout = key && designPreviewLayouts.get(key)
    if (!layout || !frame) return false
    designPreviewLayouts.delete(key)
    designPreviewLayouts.set(key, layout)
    previewNatural = layout.naturalWidth
    previewNaturalHeight = layout.naturalHeight
    if (layout.responsive) {
      clearDesignPreviewGeometry(frame, frame.parentElement)
      return true
    }
    frame.style.width = layout.width
    frame.style.height = layout.height
    frame.style.boxSizing = layout.boxSizing
    frame.style.zoom = layout.zoom
    frame.style.transform = ''
    frame.parentElement?.style.setProperty('--preview-scale', String(layout.scale))
    if (frame.parentElement) frame.parentElement.style.overflow = 'hidden'
    return true
  }

  function syncDesignViewportControls() {
    // Подсказка у превью — наша, глобальная (`data-tooltip`): нативный `title`
    // Windows рисует своё серое окно вразрез с остальным интерфейсом.
    const frame = $('designPreviewFrame')
    if (frame) {
      frame.setAttribute('aria-label', t('Превью дизайна'))
      frame.setAttribute('data-tooltip', t('Превью дизайна'))
    }
  }

  // Кадр докладывает не только размер содержимого, но и свою настоящую область.
  // Если содержимое в эту область помещается, независимой ширины у страницы нет:
  // число описывает колонку в эту секунду, и замораживать его нельзя — по замеру
  // кадр получил 270 px в сцене 428 px, а внутри страницы появилась
  // горизонтальная прокрутка, которую пересидеть ресайзом уже нечем. Тогда окно
  // снимает с кадра все явные размеры, и дальше он живёт на CSS 100% на 100%.
  function clearDesignPreviewGeometry(frame, stage) {
    if (!frame) return
    for (const property of ['width', 'height', 'boxSizing', 'position', 'left', 'top',
      'margin', 'transformOrigin', 'transform', 'zoom']) {
      frame.style[property] = ''
    }
    if (stage) stage.style.overflow = ''
  }

  function applyDesignPreviewSize(data) {
    const width = Number(data.width) || 0
    if (!Number.isFinite(width) || width < 200 || width > 20000) return
    const frame = $('designPreviewFrame')
    const stage = frame?.parentElement
    const viewport = Number(data.viewportWidth) || 0
    if (viewport > 0 && width <= viewport + 1) {
      previewNatural = 0
      previewNaturalHeight = 0
      clearDesignPreviewGeometry(frame, stage)
      rememberDesignPreviewLayout(frame, 1, true)
      return
    }
    previewNatural = width
    const height = Number(data.previewHeight)
    previewNaturalHeight = Number.isFinite(height) && height >= 100 && height <= 20000 ? height : 0
    fitDesignPreview()
  }

  function fitDesignPreview() {
    const frame = $('designPreviewFrame')
    const stage = frame?.parentElement
    const width = previewNatural
    const height = previewNaturalHeight
    if (!frame || !stage || !width) return

    const room = stage.clientWidth - 36
    if (room <= 0) return
    const roomHeight = Math.max(1, stage.clientHeight - 36)
    const scale = Math.min(1, room / width, height ? roomHeight / height : 1)

    frame.style.width = width + 'px'
    frame.style.height = (height || roomHeight / scale) + 'px'
    frame.style.boxSizing = 'content-box'
    frame.style.position = ''
    frame.style.left = ''
    frame.style.top = ''
    frame.style.margin = ''
    frame.style.transformOrigin = ''
    frame.style.transform = ''
    frame.style.zoom = scale < 1 ? String(scale) : ''
    stage.style.setProperty('--preview-scale', String(scale))
    stage.style.overflow = 'hidden'
    rememberDesignPreviewLayout(frame, scale)
  }

  function renderDesignPreview() {
    const frame = $('designPreviewFrame')
    const empty = $('designPreviewEmpty')
    const label = $('designPreviewName')
    if (!frame) return
    setElementPicking(false)

    if (!activeDesign || !designActiveComponent) {
      frame.setAttribute('hidden', '')
      frame.removeAttribute('src')
      empty?.removeAttribute('hidden')
      if (label) label.textContent = ''
      syncDesignViewportControls()
      return
    }
    empty?.setAttribute('hidden', '')
    frame.removeAttribute('hidden')
    if (label) label.textContent = designActiveComponent
    if (!restoreDesignPreviewLayout(frame)) {
      previewNatural = 0
      previewNaturalHeight = 0
    }
    const url = 'onecode-design://' + activeDesign.id + '/' +
      encodeURIComponent(designActiveComponent) + '?v=' + Date.now()
    syncDesignViewportControls()
    fitDesignPreview()
    frame.setAttribute('src', url)
  }

  // Клавиши превью. Кадр живёт в sandbox без allow-same-origin: окно не заглянет
  // в него, а его нажатия не доплывут до окна сами — движок внутри кадра сам
  // присылает ровно четыре сигнала, и ровно четыре действия им соответствуют.
  // Всё остальное — печать в макете, и реагировать на неё окном нельзя.

  // Печатают в поле — значит Backspace и Delete стирают символ, а не элемент.
  function designPreviewTyping(event) {
    const node = event.target
    if (!node || !node.tagName) return false
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) return true
    return node.isContentEditable === true
  }

  function designPreviewModalOpen() {
    if (document.querySelector('dialog[open]')) return true
    return [...document.querySelectorAll('.modal-backdrop')]
      .some(modal => modal.style.display === 'flex')
  }

  async function undoDesignPreviewComponent() {
    if (!activeDesign || !designActiveComponent || !window.electronAPI?.designRestoreVersion ||
      !window.electronAPI?.designVersions) return
    const listed = await window.electronAPI.designVersions(activeDesign.id, designActiveComponent)
    const versions = listed && listed.ok ? listed.versions || [] : []
    if (!versions.length) {
      showToast(t('Возвращать нечего: этот компонент ещё не правился'))
      return
    }
    // Откатывается последняя из сохранённых — то, что было непосредственно перед
    // тем, что человек видит на экране.
    const restored = await window.electronAPI.designRestoreVersion(activeDesign.id, designActiveComponent,
      versions[versions.length - 1].id)
    if (!restored || !restored.ok) {
      showToast(String((restored && restored.error) || t('Откат не удался')), true)
      return
    }
    renderDesignPreview()
    showToast(t('Вернул прежнее состояние компонента'))
  }

  async function handleDesignPreviewKey(event) {
    const key = String(event.key || '')
    // Сочетание узнаётся по месту клавиши, а не по символу: на русской раскладке
    // Ctrl+Z приходит как «з».
    const undoCombo = (event.ctrlKey || event.metaKey) && !event.altKey &&
      (key.length === 1 && /z|з/i.test(key) || event.code === 'KeyZ')
    if (key !== 'Delete' && key !== 'Backspace' && key !== 'Escape' && !undoCombo) return false
    // Выбор элемента относится к разделу Design: в чате эти клавиши не имеют
    // права трогать макет, даже если выбор ещё не снялся.
    if (!$('designView')?.classList.contains('active')) return false
    // Открытый диалог — раньше клавиш: Escape в подтверждении отменяет
    // подтверждение, а не выбор. Поэтому слушатель и висит на захвате, пока
    // глобальный обработчик окна ещё не закрыл модалку.
    if (designPreviewModalOpen()) return false
    if (designPreviewTyping(event)) return false
    if (key === 'Escape') {
      if (!elementPicking && !commentPicking && !selectedDesignElement) return false
      setElementPicking(false)
      setCommentPicking(false)
      return true
    }
    if (key === 'Delete' || key === 'Backspace') {
      if (!selectedDesignElement) return false
      void removeSelectedDesignElement()
      return true
    }
    // Откат снимает выбор: узел, по которому он был сделан, после возврата
    // прежних байтов может уже не существовать.
    setElementPicking(false)
    await undoDesignPreviewComponent()
    return true
  }
  

  // --- review comments -------------------------------------------------------

  function setCommentPicking(on) {
    commentPicking = !!on
    if (commentPicking) setElementPicking(false)
    // The frame is sandboxed and cross-origin, so the picker is asked for by
    // message rather than reached into.
    $('designPreviewFrame')?.contentWindow?.postMessage(
      { type: 'onecode-design-pick', on: commentPicking, purpose: 'comment' }, '*')
  }

  function paintDesignElementSelection() {
    const button = $('designSelectElementBtn')
    const remove = $('designRemoveElementBtn')
    const label = $('designSelectedElementName')
    if (button) {
      button.setAttribute('aria-pressed', elementPicking ? 'true' : 'false')
      const text = button.querySelector('span')
      if (text) text.textContent = t(elementPicking ? 'Выберите элемент…' : 'Выбрать элемент')
      button.disabled = !activeDesign || !designActiveComponent || designBusy
    }
    const strip = $('designPickedStrip')
    if (strip) strip.hidden = !selectedDesignElement
    if (label) {
      label.textContent = selectedDesignElement?.element || ''
      label.setAttribute('aria-label', selectedDesignElement?.element || '')
    }
    if (remove) remove.disabled = !selectedDesignElement || designBusy
  }

  function setElementPicking(on, { keepSelection = false, preserveFrame = false } = {}) {
    elementPicking = Boolean(on)
    if (elementPicking) commentPicking = false
    if (!keepSelection) {
      selectedDesignElement = null
      $('designPreviewFrame')?.contentWindow?.postMessage({ type: 'onecode-design-clear-selection' }, '*')
    }
    if (!preserveFrame) {
      $('designPreviewFrame')?.contentWindow?.postMessage(
        { type: 'onecode-design-pick', on: elementPicking, purpose: 'remove' }, '*')
    }
    paintDesignElementSelection()
  }

  async function removeSelectedDesignElement() {
    const selected = selectedDesignElement
    const design = activeDesign
    if (!selected || !design) return
    if (designBusy) return showToast('Сначала остановите текущую работу Дизайна', true)
    if (selected.designId !== design.id || selected.component !== designActiveComponent) {
      setElementPicking(false)
      return showToast('Выбранный элемент уже не в открытом макете', true)
    }
    if (!(await askConfirm('Удалить выбранный элемент из макета?'))) return
    if (activeDesign?.id !== design.id || designActiveComponent !== selected.component || designBusy) return

    const visible = 'Удали выбранный элемент из макета. Остальное оставь без изменений.'
    const instruction = [
      'Это точечное удаление одного элемента, выбранного человеком в живом превью Design.',
      `Открытый компонент: ${selected.component}.`,
      `Описание элемента по DOM: ${selected.element}.`,
      'Прочитай именно этот компонент через dc_read. Удали только выбранный элемент и его собственный контент, не перестраивай соседей, не меняй тексты, стили, размеры и другие компоненты.',
      'Сделай адресную правку через dc_html_str_replace. Если элемент невозможно однозначно найти в исходнике (например, он создан логикой во время выполнения), ничего не меняй и объясни причину.',
      'После правки проверь только изменённый компонент через dc_check.'
    ].join('\n')
    setElementPicking(false)
    await sendDesignMessage(visible, { hidden: instruction })
  }

  function renderDesignComments() {
    const host = $('designComments')
    if (!host) return
    const list = activeDesign?.comments || []
    host.innerHTML = ''
    if (!list.length) { host.setAttribute('hidden', ''); return }
    host.removeAttribute('hidden')
    for (const comment of list) {
      const row = document.createElement('div')
      row.className = `design-comment${comment.resolved ? ' resolved' : ''}`
      row.innerHTML = `
        <div class="design-comment-body">
          <span class="design-comment-el">${escapeHtml(comment.element || comment.component || '')}</span>
          <span class="design-comment-text">${escapeHtml(comment.text || '')}</span>
        </div>
        <button type="button" class="design-comment-drop" data-tooltip="Убрать замечание" aria-label="Убрать замечание">
          <svg fill="none" class="icon" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>
        </button>
      `
      row.querySelector('.design-comment-drop').addEventListener('click', () => {
        activeDesign.comments = (activeDesign.comments || []).filter(c => c.anchor !== comment.anchor)
        saveDesigns()
        renderDesignComments()
      })
      host.appendChild(row)
    }
  }

  // Кадр доложил свой настоящий размер — вписываем его в колонку. Различать
  // «независимая ширина» и «ширина текущей колонки» умеет `applyDesignPreviewSize`,
  // здесь только граница: сообщение обязан прислать именно этот кадр.
  window.addEventListener('message', event => {
    const data = event.data
    if (!data || data.type !== 'onecode-design-size') return
    if (event.source !== $('designPreviewFrame')?.contentWindow) return
    applyDesignPreviewSize(data)
  })

  window.addEventListener('message', event => {
    const data = event.data
    const frame = $('designPreviewFrame')
    if (!data || data.type !== 'onecode-design-element-selected' || !activeDesign ||
        event.source !== frame?.contentWindow || !elementPicking) return
    const element = String(data.element || '').trim().slice(0, 240)
    if (!element) return setElementPicking(false)
    elementPicking = false
    selectedDesignElement = {
      designId: activeDesign.id,
      component: designActiveComponent,
      element,
      tplId: String(data.tplId || '').slice(0, 12)
    }
    paintDesignElementSelection()
    $('designComposerTextarea')?.focus()
  })

  // Клавиша, нажатая внутри кадра: единственный способ её увидеть — сообщение от
  // нашего движка превью. Чужое окно (в том числе `source: null`) не имеет права
  // ни удалить элемент, ни снять выбор, ни откатить макет.
  window.addEventListener('message', event => {
    const data = event.data
    if (!data || data.type !== 'onecode-design-key') return
    if (event.source !== $('designPreviewFrame')?.contentWindow) return
    void handleDesignPreviewKey({
      key: String(data.key || ''),
      code: String(data.code || ''),
      ctrlKey: Boolean(data.ctrlKey),
      metaKey: Boolean(data.metaKey)
    })
  })

  // Колонка меняет ширину, когда двигают разделитель или сворачивают сайдбар:
  // масштаб обязан идти за ней, иначе вписанный один раз макет снова вылезает.
  if (typeof ResizeObserver === 'function') {
    const stage = document.querySelector('.design-preview-stage')
    if (stage) new ResizeObserver(() => fitDesignPreview()).observe(stage)
  }

  // A click inside the preview arrives here, naming the element it landed on.
  window.addEventListener('message', async event => {
    const data = event.data
    if (!data || data.type !== 'onecode-design-comment' || !activeDesign ||
        event.source !== $('designPreviewFrame')?.contentWindow || !commentPicking) return
    setCommentPicking(false)
    const design = activeDesign
    const text = await askText('Что поправить в этом элементе?', '', 'Добавить замечание')
    // Дизайн могли закрыть или сменить, пока окно было открыто.
    if (!text || !text.trim() || activeDesign?.id !== design.id) return
    activeDesign.comments = activeDesign.comments || []
    activeDesign.comments.push({
      anchor: 'c' + Date.now().toString(36),
      component: designActiveComponent,
      element: String(data.element || '').slice(0, 160),
      text: text.trim(),
      resolved: false,
      createdAt: Date.now()
    })
    activeDesign.updatedAt = Date.now()
    saveDesigns()
    renderDesignComments()
  })

  // --- the conversation ------------------------------------------------------

  // Design shares the ordinary chat's chronological, collapsible blocks.
  // Keep live nodes so streaming does not reset expanded tool details.
  function designMessageEl(msg) {
    const item = document.createElement('div')
    item.className = `msg-item ${msg.role}`
    if (msg.role !== 'assistant') {
      const content = document.createElement('div')
      content.className = 'msg-content'
      content.textContent = msg.content || ''
      item.appendChild(content)
      if (msg.about) {
        const about = document.createElement('div')
        about.className = 'bubble-note'
        about.textContent = t('про: %s', msg.about)
        item.appendChild(about)
      }
      // Приложенные файлы остаются при том сообщении, с которым их отправили, —
      // как в обычном чате. Раньше они висели над строкой ввода до конца жизни
      // дизайна: было не понять, к чему они относятся и что уже отправлено.
      if (Array.isArray(msg.refs) && msg.refs.length) item.appendChild(designRefStripEl(msg.refs))
      return { item }
    }
    const blocks = Array.isArray(msg.blocks) && msg.blocks.length ? msg.blocks : [
      ...(msg.reasoning ? [{ kind: 'thinking', text: msg.reasoning }] : []),
      ...(msg.content ? [{ kind: 'text', text: msg.content }] : [])
    ]
    blocksHtmlInto(item, blocks)
    item.insertAdjacentHTML('beforeend', `<div class="msg-footer"><div class="msg-meta">
      ${PIXEL_CAT_SVG}<span class="cli-model">${escapeHtml(msg.modelName || 'Агент 1')}</span>
      <span class="cli-dot">·</span><span class="cli-duration">${formatDuration(msg.duration || 0)}</span>
      <span class="cli-tokens">${formatTokens(msg.tokens)}</span>
    </div></div>`)
    bindCopyButtons(item)
    return { item }
  }

  function renderDesignMessages(forceBottom = true) {
    const host = $('designMessages')
    if (!host) return
    const feed = $('designFeed')
    const previousTop = feed?.scrollTop || 0
    const pinned = !feed || feed.scrollHeight - previousTop - feed.clientHeight < 120
    host.innerHTML = ''
    if (designRun) designRun.assistantEl = null
    // Старые дизайны могли сохранить строки-активности отдельными сообщениями;
    // они больше не нужны — теперь статус живёт в строке под ответом.
    const msgs = (activeDesign?.messages || []).filter(m => !m.activity)
    msgs.forEach((msg, i) => {
      const built = designMessageEl(msg)
      const isLive = designRun && designRun.design.id === activeDesign?.id &&
        msg === designRun.placeholder
      if (isLive) {
        designRun.assistantEl = built.item
        designRun.paintedBlocks = []
        paintBlocks(designRun)
      }
      host.appendChild(built.item)
    })
    if (feed) feed.scrollTop = previousTop
    for (const pending of questionCards.values()) {
      if (pending.designId === activeDesign?.id) host.appendChild(pending.card)
    }
    // Карточки прерванных ходов остаются в ленте и во время новой работы,
    // чтобы продолжение можно было поставить в очередь.
    for (const resume of designResumeCards.values()) {
      if (resume.dataset.designId === activeDesign?.id) host.appendChild(resume)
    }
    if (forceBottom || pinned) scrollDesignToBottom(true)
  }

  // Не скроллит, если пользователь сам ушёл вверх читать — иначе лента дёргалась
  // бы под ним на каждый кадр потока.
  function scrollDesignToBottom(force = false) {
    const feed = $('designFeed')
    if (!feed) return
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120
    if (force || nearBottom) feed.scrollTop = feed.scrollHeight
  }

  // Поток мог прислать десятки чанков за кадр. Все они копятся в буфере
  // сообщения, а перерисовка — одна на кадр: это и убирает лаг, из-за которого
  // всё дёргалось.
  let designPaintPending = false
  function scheduleDesignPaint() {
    if (designPaintPending) return
    designPaintPending = true
    requestAnimationFrame(() => {
      designPaintPending = false
      const dom = designRun?.assistantEl
      const msg = designRun?.placeholder
      if (!dom || !msg || activeDesign?.id !== designRun.design.id) return
      const feed = $('designFeed')
      const pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120
      paintBlocks(designRun)
      bindCopyButtons(dom)
      const duration = dom.querySelector('.cli-duration')
      if (duration) duration.textContent = formatDuration((Date.now() - designRun.startedAt) / 1000)
      const tokens = dom.querySelector('.cli-tokens')
      if (tokens) tokens.textContent = formatTokens(msg.tokens)
      if (pinned) scrollDesignToBottom(true)
    })
  }

  // «TypeError: terminated» — это оборванное соединение из недр HTTP-клиента, и
  // как объяснение оно не годится: пользователь видит слово из чужого стека и не
  // понимает ни что случилось, ни что делать.
  function describeTurnFailure(err) {
    const raw = cleanErrorText(err)
    if (/terminated|socket hang up|ECONNRESET|aborted/i.test(raw)) {
      return 'Соединение с моделью оборвалось. Уже полученный текст сохранён. Причина обрыва не установлена: возможны сбой сети, таймаут или ошибка провайдера. Попробуйте повторить запрос; при повторении проверьте соединение или выберите другую модель.'
    }
    if (/rate.?limit|429/i.test(raw)) {
      return 'Провайдер временно ограничил запросы к этой модели. Подождите минуту или выберите другую.'
    }
    if (/context|too many tokens|maximum context/i.test(raw)) {
      return 'Переписка не помещается в окно модели. Начните новый дизайн или возьмите модель с большим контекстом.'
    }
    return raw || t('Не удалось получить ответ.')
  }

  // Статус хода — одна живая строка под ответом, а не поток сообщений в ленте.
  function recordDesignActivity(message) {
    if (!message || !designRun) return
    designRun.status = String(message).replace(/^1code\s*[·:—-]?\s*/i, '')
    if (activeDesign?.id !== designRun.design.id) return
    // Раньше здесь жила строка над полем ввода. Она повторяла панель работы и
    // налезала на строку ввода; состояние теперь показывает только панель.
  }

  function syncDesignRunControls() {
    const current = designRun?.design.id === activeDesign?.id && Boolean(designRun)
    // Кнопку отправки на ходу не блокируем: набранное уходит следующим ходом,
    // а пустая кнопка становится «стоп».
    $('designSendBtn').disabled = false
    paintDesignSendButton(current)
  }

  // Референсы — то, что пользователь принёс как образец: фото, архив, бриф.
  // Живут рядом с дизайном, поэтому макет может сослаться на картинку по имени.
  // Все файлы дизайна — их модель может ставить в макет по имени в любой момент.
  let designRefs = []
  // И отдельно те, что приложены к сообщению, которое пользователь сейчас пишет.
  // Уходят вместе с ним и исчезают из строки ввода, как вложение в чате.
  let designPendingRefs = []

  const formatRefSize = bytes => bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`

  // Список дизайнов отсортирован по времени последней работы. Приложенный или
  // убранный файл — такая же работа, как комментарий или сообщение: без этой
  // пометки дизайн, в который только что перетащили макет, оставался внизу
  // списка, будто его не трогали.
  function touchDesignById(id) {
    const design = designs.find(d => d.id === id)
    if (!design) return
    design.updatedAt = Date.now()
    saveDesigns()
    renderDesignList()
  }

  async function refreshDesignRefs() {
    if (!activeDesign) { designRefs = []; renderDesignRefs(); return }
    const id = activeDesign.id
    try {
      const res = await window.electronAPI?.designRefs?.(id)
      if (activeDesign?.id !== id) return
      designRefs = res?.ok ? res.refs : []
    } catch {
      if (activeDesign?.id !== id) return
      designRefs = []
    }
    renderDesignRefs()
  }

  // Адрес приложенного файла в схеме превью. Имя может содержать подпапки
  // (распакованный архив) и кириллицу, поэтому кодируется по сегментам.
  function refUrl(name) {
    const path = String(name).split('/').map(encodeURIComponent).join('/')
    return `onecode-design://${activeDesign.id}/refs/${path}`
  }

  // Плашка одного приложенного файла. Одна и та же в двух местах: над строкой
  // ввода, пока файл не отправлен, и при сообщении, с которым он ушёл, — чтобы
  // одно и то же выглядело одинаково.
  function designRefChipEl(ref, onDrop) {
    const chip = document.createElement('div')
    // Картинка — маленькое окошко превью; остальное — плашка с иконкой.
    chip.className = 'design-ref' + (ref.kind === 'image' ? ' design-ref--image' : '')
    chip.dataset.tooltip = `${ref.name} · ${formatRefSize(ref.size)} · в макете: refs/${ref.name}`
    chip?.removeAttribute?.('title')

    const face = ref.kind === 'image'
      ? `<img class="design-ref-thumb" src="${refUrl(ref.name)}" alt="" draggable="false">`
      : `<span class="design-ref-icon"><svg fill="none" class="icon" viewBox="0 0 16 16">${
          ref.kind === 'archive'
            ? '<path d="M4 2.6h8v10.8H4z"/><path d="M8 2.6v1.4M8 5v1.4M8 7.4v1.4"/>'
            : '<path d="M4 2.6h5l3 3v7.8H4z"/><path d="M9 2.6v3h3"/>'
        }</svg></span>`

    chip.innerHTML = `
      ${face}
      ${ref.kind === 'image' ? '' : `<span class="design-ref-name">${escapeHtml(ref.name.split('/').pop())}</span>`}
      ${onDrop ? `<button type="button" class="design-ref-drop" data-tooltip="Убрать" aria-label="Убрать файл">
        <svg fill="none" class="icon" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>
      </button>` : ''}
    `
    if (onDrop) chip.querySelector('.design-ref-drop').addEventListener('click', () => onDrop(ref))
    return chip
  }

  // Полоса плашек при отправленном сообщении: только показать, убирать нечего —
  // файл уже ушёл модели и, возможно, уже стоит в макете.
  function designRefStripEl(refs) {
    const strip = document.createElement('div')
    strip.className = 'design-ref-strip sent'
    for (const ref of refs) strip.appendChild(designRefChipEl(ref, null))
    return strip
  }

  // Над строкой ввода — только то, что ещё не отправлено. Раньше здесь висели
  // все файлы дизайна разом: после первого же сообщения было не понять, что из
  // этого уходит с новым вопросом, а что приложено месяц назад.
  function renderDesignRefs() {
    const strip = $('designRefStrip')
    if (!strip) return
    strip.innerHTML = ''
    if (!designPendingRefs.length) { strip.setAttribute('hidden', ''); return }
    strip.removeAttribute('hidden')
    for (const ref of designPendingRefs) {
      strip.appendChild(designRefChipEl(ref, async dropped => {
        if (!activeDesign) return
        // Файл ещё не отправлен и ни в одном макете не использован, поэтому
        // убирается насовсем, а не только с глаз.
        const res = await window.electronAPI?.designRemoveRef?.(activeDesign.id, dropped.name)
        if (res && res.ok === false) return showToast(res.error || 'Не удалось убрать файл', true)
        designPendingRefs = designPendingRefs.filter(r => r.name !== dropped.name)
        renderDesignRefs()
        touchDesignById(activeDesign.id)
        await refreshDesignRefs()
      }))
    }
  }

  // Ставит приложенные файлы в очередь к сообщению, которое пишется сейчас.
  // Повтор по имени не плодит плашки: один и тот же файл, приложенный дважды,
  // хранилище кладёт под новым именем, а вот повторный показ уже стоящего в
  // очереди — просто мусор в строке ввода.
  function queuePendingRefs(refs) {
    for (const ref of refs || []) {
      if (!ref?.name || designPendingRefs.some(r => r.name === ref.name)) continue
      designPendingRefs.push(ref)
    }
    renderDesignRefs()
  }

  // `paths` пустой — открывается системный диалог; заполненный приходит от
  // перетаскивания.
  async function addDesignRefs(paths) {
    if (!activeDesign) return
    const res = await window.electronAPI?.designAddRefs?.(activeDesign.id, paths || [])
    if (!res?.ok) return showToast(res?.error || 'Не удалось приложить файлы', true)
    if (res.canceled) return
    if (res.refs?.length) {
      queuePendingRefs(res.refs)
      touchDesignById(activeDesign.id)
    }
    await refreshDesignRefs()
    // Битый архив не отменяет остальные приложенные файлы, но и молчать о нём
    // нельзя: пользователь думает, что приложил всё.
    if (res.failures?.length) showToast(res.failures[0], true)
    else if (res.refs?.length) {
      showToast(res.refs.length === 1
        ? `Приложен ${res.refs[0].name}`
        : `Приложено файлов: ${res.refs.length}`)
    }
  }

  // Вставка из буфера: скриншот по Ctrl+V, скопированный файл из проводника,
  // картинка со страницы. Кнопка и перетаскивание работают с путями, а здесь
  // пути нет вовсе — есть только содержимое.
  async function pasteDesignRefs(clipboard) {
    if (!activeDesign || !clipboard) return false
    const designId = activeDesign.id
    const files = [...(clipboard.items || [])]
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean)
    if (!files.length) return false

    let added = 0
    for (const file of files.slice(0, 8)) {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result || ''))
          reader.onerror = () => reject(new Error('Не удалось прочитать файл из буфера.'))
          reader.readAsDataURL(file)
        })
        const res = await window.electronAPI?.designPasteRef?.(designId, dataUrl, file.name || '')
        if (!res?.ok) throw new Error(res?.error || 'Не удалось вставить файл')
        // Очередь пополняется только пока открыт тот же дизайн: пользователь мог
        // уйти в другой, пока файл читался, и плашка уехала бы не туда.
        if (activeDesign?.id === designId) queuePendingRefs(res.refs)
        added += res.refs?.length || 0
      } catch (err) {
        showToast(cleanErrorText(err) || 'Не удалось вставить файл', true)
      }
    }
    if (added) {
      touchDesignById(designId)
      await refreshDesignRefs()
      showToast(added === 1 ? 'Приложено к сообщению' : `Приложено к сообщению файлов: ${added}`)
    }
    return added > 0
  }

  function renderDesignModelPill() {
    const name = $('designModelName')
    const modelName = cleanModelName(selectedModel?.name) || selectedModel?.id || '—'
    if (name) name.textContent = modelName
    const effort = $('designEffortName')
    // Fast показывает горящая молния рядом, второй пометки в кнопке модели нет; глубина — только когда Fast выключен.
    const showEffort = !fastMode && currentThinkingEffort && currentThinkingEffort !== 'off'
    if (effort) {
      effort.textContent = showEffort ? effortLabel(currentThinkingEffort) : ''
      effort.style.display = showEffort ? 'inline-flex' : 'none'
    }
    const pill = $('designModelBtn')
    if (pill) pill.dataset.tooltip = fastMode ? t('%s · Fast', modelName) : (showEffort ? `${modelName} · ${effortLabel(currentThinkingEffort)}` : modelName)
  }

  const namingDesigns = new WeakSet()
  async function nameDesign(design, userText, assistantText, model) {
    if (!Object.hasOwn(design, 'titleGenerated') && design.name !== 'Новый дизайн') return
    if (design.titleGenerated || design.titleManual || namingDesigns.has(design) || !window.electronAPI?.generateChatTitle) return
    const oldName = design.name
    namingDesigns.add(design)
    try {
      const { title } = await window.electronAPI.generateChatTitle({ userText, assistantText, model })
      if (!title || !designs.includes(design) || design.titleManual || design.name !== oldName) return
      design.name = String(title).trim().slice(0, 100)
      design.titleGenerated = true
      saveDesigns()
      if (activeDesign?.id === design.id) $('designTitle').textContent = design.name
    } catch (error) {
      console.warn('Не удалось назвать дизайн:', error)
    } finally { namingDesigns.delete(design) }
  }

  function designReferenceNames(attached, messages) {
    const refs = attached.length ? attached :
      [...messages].reverse().find(m => m.role === 'user' && m.refs?.length)?.refs || []
    return refs.map(ref => ref.name)
  }

  async function sendDesignMessage(text, { hidden = '', resumeRunId = '', about = '' } = {}) {
    if (!activeDesign || designBusy) return
    const prompt = String(text || '').trim()
    if (!prompt) return
    const design = activeDesign
    const model = { ...selectedModel }
    const effort = currentThinkingEffort
    const turnFastMode = fastMode

    designBusy = true
    paintDesignElementSelection()
    const send = $('designSendBtn')
    paintDesignSendButton(true)

    // Файлы уходят с этим сообщением и остаются при нём. Строка ввода очищается
    // здесь же: держать их над вводом после отправки — значит показывать, будто
    // они всё ещё ждут своей очереди.
    const attached = designPendingRefs.slice()
    designPendingRefs = []
    renderDesignRefs()

    activeDesign.messages.push({ role: 'user', content: prompt, timestamp: Date.now(),
      ...(hidden ? { prompt: String(hidden) } : {}),
      ...(about ? { about: String(about).slice(0, 240) } : {}),
      ...(attached.length ? { refs: attached } : {}) })
    activeDesign.updatedAt = Date.now()
    renderDesignMessages()
    saveDesigns()

    const placeholder = { role: 'assistant', content: '', reasoning: '', blocks: [], modelName: model.name || model.id, modelId: model.id, tokens: 0, timestamp: Date.now() }
    activeDesign.messages.push(placeholder)
    renderDesignMessages()

    const requestId = `design_${activeDesign.id}_${Date.now()}`
    designRun = { requestId, design, placeholder, assistantEl: null, blocks: placeholder.blocks,
      paintedBlocks: [], reasoningSegments: [], generating: true, stickToBottom: true, startedAt: Date.now() }
    const running = designRun
    const taskPane = { designId: design.id, generating: true, agentTasks: new Map(),
      planByAgent: new Map(), tasksOpen: Boolean(designTaskPanes.get(design.id)?.tasksOpen), tasksCollapsed: false }
    const previousTasks = designTaskPanes.get(design.id)
    clearInterval(previousTasks?.agentTaskTimer)
    designTaskPanes.set(design.id, taskPane)
    running.taskPane = taskPane
    agentTaskState(taskPane, 0, 'Агент 1').model = cleanModelName(model.name) || model.id
    renderAgentTasks(taskPane)
    const ticker = setInterval(() => scheduleDesignPaint(), 1000)
    renderDesignMessages()
    recordDesignActivity('Агент 1 · думает над задачей…')
    try {
      const response = await window.electronAPI.sendMessage({
        model: model.id,
        messages: design.messages
          .filter(m => m.content && !m.activity)
          .map(m => ({ role: m.role, content: m.prompt || m.content })),
        requestId,
        // Продолжение оборванного хода Дизайна: остаток бюджета цикла заберёт
        // главный процесс, он же и снимет контрольную точку.
        ...(resumeRunId ? { resumeRunId } : {}),
        reasoningEffort: effort,
        speedMode: turnFastMode ? 'fast' : 'standard',
        // Команда — по просьбе (слова «работайте вместе», /agent), а не на каждое сообщение Дизайна.
        // What makes this a design turn: the design system prompt and the dc_*
        // tools instead of the workspace ones.
        designId: design.id,
        designName: design.name,
        // A follow-up revision keeps the latest visual brief, not every old upload.
        designRefNames: designReferenceNames(attached, design.messages),
        designComments: (design.comments || []).filter(c => !c.resolved),
        params: { useTools: true }
      })
      placeholder.configurationRunId = response?.execution?.runId
      placeholder.runConfigurations = response?.execution?.configurations
      placeholder.droppedConfigurations = response?.execution?.droppedConfigurations
      placeholder.content = response?.content || placeholder.content || (response?.aborted ? 'Остановлено. Уже созданные компоненты сохранены.' : t('Ответ не получен.'))
      placeholder.aborted = Boolean(response?.aborted)
      if (response?.answeredModel) {
        placeholder.modelId = response.answeredModel
        placeholder.modelName = findCatalogModel(response.answeredModel)?.name || response.answeredModel
      }
      if (Array.isArray(response?.designComments)) design.comments = response.designComments
      if (response?.ok !== false && !response?.aborted) void nameDesign(design, prompt, placeholder.content, model.id)
    } catch (err) {
      // Всё, что модель успела написать до обрыва, остаётся на экране: раньше
      // текст ответа затирался строкой ошибки, и половина работы исчезала
      // вместе с объяснением, почему.
      const written = (placeholder.content || '').trim()
      const reason = describeTurnFailure(err)
      placeholder.content = written ? `${written}\n\n---\n\n${reason}` : reason
    } finally {
      clearInterval(ticker)
      taskPane.generating = false
      settleAgentTasks(taskPane)
      clearInterval(taskPane.agentTaskTimer)
      taskPane.agentTaskTimer = null
      const dTasks = Array.from(taskPane.agentTasks.values())
      if (dTasks.length && !taskPane.tasksFinishedDuration) {
        const earliest = dTasks.reduce((first, t) => Math.min(first, t.since || Date.now()), Date.now())
        taskPane.tasksFinishedDuration = Math.max(1, Math.round((Date.now() - earliest) / 1000))
      }
      renderAgentTasks(taskPane)
      placeholder.blocks = blocksForStorage(running, placeholder.content)
      placeholder.duration = (Date.now() - running.startedAt) / 1000
      placeholder.agentRun = agentRunRecord(taskPane, { ask: prompt, seconds: placeholder.duration })
      designBusy = false
      paintDesignElementSelection()
      designRun = null
      if (send) send.disabled = false
      paintDesignSendButton(false)
      design.updatedAt = Date.now()
      if (activeDesign?.id === design.id) renderDesignMessages(false)
      saveDesigns()
      if (activeDesign?.id === design.id) await refreshDesignComponents()
      // Принятая правка из чата закрывается только когда макету больше нечего
      // делать: с очередью напереди отчёт ушёл бы раньше, чем очередь дойдёт до
      // принятой правки.
      if (!designQueue.has(design.id)) await reportDesignEditResults(design.id)
      startQueuedDesignIfReady()
    }
  }

  // Правка из чата: главный процесс её не делает — он отдаёт
  // её окну, а окно исполняет ТЕМ ЖЕ ходом Дизайна, которым правку просит
  // человек в разделе. Отсюда и новая версия того же макета, а не второй макет.
  // Событие приходит по макету, который окно назвало открытым, но проверка ниже
  // не формальность: за время между `design-focus` и событием человек мог уйти.
  function applyDesignChatEdit(payload) {
    const edit = payload && typeof payload === 'object' ? payload : {}
    const designId = String(edit.designId || '')
    if (!designId) return
    if (activeDesign?.id !== designId) {
      // Мы уже не на этом макете: сказать главному процессу правду о фокусе,
      // чтобы следующая правка не ушла в закрытое рабочее место.
      reportDesignFocus(activeDesign?.id || null)
      return
    }
    const instruction = String(edit.instruction || '').trim()
    if (!instruction) return
    const requestId = String(edit.requestId || '')
    if (designBusy) {
      // Ход этого макета уже идёт: правка встаёт в его очередь и пойдёт новым
      // ходом, как только прежний закончится. Влететь поверх — значит смешать
      // две правки в одну версию.
      if (requestId) designEditTurns.set(requestId, designId)
      queueDesignMessage(designId, { text: instruction })
      return
    }
    // С этого момента правку делает этот ход: он и отчитается о её конце
    // (4.2 остаток). Без отчёта карточка в чате осталась бы в работе навсегда.
    if (requestId) designEditTurns.set(requestId, designId)
    void sendDesignMessage(instruction)
  }

  // Отчёт о конце принятых правок: главному процессу сказано, какой requestId
  // больше не делается, и он закрывает карточку со словами «готово». Номер
  // версии окно называет тот, что видит в своём реестре; не увидело — главный
  // процесс возьмёт свой.
  async function reportDesignEditResults(designId) {
    const ids = [...designEditTurns.entries()].filter(([, id]) => id === designId)
    if (!ids.length) return
    const entry = designs.find(item => item && item.id === designId) || {}
    const version = Number(entry.version)
    for (const [requestId] of ids) {
      designEditTurns.delete(requestId)
      try {
        await window.electronAPI.designEditResult({
          requestId, designId, version: Number.isFinite(version) ? version : null
        })
      } catch { /* отчёт не ушёл: карточка останется в работе — честнее, чем выдуманная версия */ }
    }
  }

  function setupDesignEvents() {
    const handoffDesign = anchor => {
      const design = activeDesign
      if (!design) return
      if (designRun?.design.id === design.id) return showToast('Дождитесь завершения дизайна или остановите генерацию', true)
      const transfer = async (chatId, projectId = null) => {
        try {
          const pane = activePane || panes[0]
          if (pane.generating || pane.preparing) return showToast('Выбранная панель занята генерацией', true)
          const result = await window.electronAPI.designHandoff(design.id)
          if (!result?.ok) throw new Error(result?.error || 'Не удалось передать дизайн')
          const chat = chatId ? conversations.find(c => c.id === chatId) : createNewChat(pane, `Дизайн: ${design.name}`, projectId)
          if (!chat) throw new Error('Диалог больше не существует')
          chat.folders = [...new Set([...chatFoldersOf(chat), result.folder])]
          saveConversations()
          selectChat(pane, chat.id)
          addAttachments(pane, result.attachments)
          const brief = `Используй дизайн «${design.name}» для реализации. Основная страница: ${result.entry}.\nИсходники и движок (отдельная копия): ${result.folder}\nКомпоненты: ${result.components.join(', ')}.\nСначала изучи исходники, затем перенеси дизайн в проект с сохранением композиции и поведения.`
          pane.dom.textarea.value = [pane.dom.textarea.value.trim(), brief].filter(Boolean).join('\n\n')
          pane.dom.textarea.dispatchEvent(new Event('input', { bubbles: true }))
          pane.dom.textarea.focus()
          showToast('Исходники приложены. Дополните задачу и отправьте сообщение.')
        } catch (error) { showToast(cleanErrorText(error), true) }
      }
      const at = anchor.getBoundingClientRect()
      openContextMenu(at.left, at.bottom + 4, [
        { label: 'Новый диалог', onPick: () => transfer(null) },
        ...projects.map(p => ({ label: `В проект: ${p.name}`, onPick: () => transfer(null, p.id) })),
        { separator: true },
        ...conversations.filter(c => c.messages.length).map(c => ({ label: c.title || 'Диалог', onPick: () => transfer(c.id) }))
      ])
    }
    window.electronAPI.onMessageChunk(chunk => {
      if (designRun?.requestId !== chunk?.requestId) return
      const text = chunk?.choices?.[0]?.delta?.content || chunk?.text || ''
      if (!text) return
      if (isHelperChunk(chunk)) {
        feedLane(designRun, designRun.taskPane, chunk, 'text', text)
        return
      }
      designRun.placeholder.content += text
      noteAgentDoing(designRun.taskPane, chunk, 'Пишет ответ')
      pushBlock(designRun, 'text', text, chunk.agentName || '')
      if (activeDesign?.id === designRun.design.id) scheduleDesignPaint()
    })
    window.electronAPI.onMessageReasoningChunk(chunk => {
      if (designRun?.requestId !== chunk?.requestId) return
      const text = chunk?.text || ''
      if (!text) return
      if (isHelperChunk(chunk)) {
        feedLane(designRun, designRun.taskPane, chunk, 'thinking', text)
        return
      }
      const agent = chunk.agentName || ''
      const last = designRun.reasoningSegments.at(-1)
      noteAgentDoing(designRun.taskPane, chunk, 'Обрабатывает задачу')
      if (last?.agent === agent) last.text += text
      else designRun.reasoningSegments.push({ agent, text })
      designRun.placeholder.reasoning = reasoningSegmentsToText(designRun)
      pushBlock(designRun, 'thinking', text, agent)
      if (activeDesign?.id === designRun.design.id) scheduleDesignPaint()
    })
    window.electronAPI.onAgentStageStart?.(stage => {
      if (designRun?.requestId !== stage?.requestId) return
      const title = stage.taskTitle || stage.assignment || 'работает…'
      const pane = designRun.taskPane
      // A stage start is not completion of the other parallel agents.
      const task = agentTaskState(pane, (stage.stage || 1) - 1, `Агент ${stage.stage || 1}`)
      task.model = stage.modelName || ''
      task.taskTitle = title
      task.assignment = stage.assignment || ''
      task.done = title === 'Ожидает назначения'
      task.outcome = task.done ? 'not-started' : ''
      task.what = title
      renderAgentTasks(pane)
      recordDesignActivity(`${stage.agentName} · ${title}`)
    })
    window.electronAPI.onAgentPlan?.(plan => {
      if (designRun?.requestId !== plan?.requestId) return
      designRun.taskPane.planByAgent.set(plan.agentName || '', Array.isArray(plan.items) ? plan.items : [])
      designRun.taskPane.planOwner = designRun.taskPane.planOwner || new Map()
      designRun.taskPane.planOwner.set(plan.agentName || '', Number(plan.agentIndex ?? 0))
      renderAgentTasks(designRun.taskPane)
    })
    window.electronAPI.onAgentBoard?.(board => {
      if (designRun?.requestId !== board?.requestId) return
      designRun.taskPane.board = { items: board.items || [], messages: board.messages || [] }
      renderAgentTasks(designRun.taskPane)
    })
    window.electronAPI.onAgentEvent(event => {
      if (designRun?.requestId !== event?.requestId) return
      recordDesignActivity(t(event.message || 'Агент · работает…'))
    })
    window.electronAPI.onAgentToolLog(event => {
      if (designRun?.requestId !== event?.requestId) return
      // О ещё не дописанном вызове сказано одной строкой в панели работы: в
      // ленте Дизайна строка вызова появляется вместе с итогом.
      if (event?.pending) {
        const task = agentTaskState(designRun.taskPane, event.agentIndex ?? 0)
        task.what = String(event.headline || event.tool || '')
        renderAgentTasks(designRun.taskPane)
        return
      }
      if (isHelperChunk(event)) {
        laneTool(designRun, designRun.taskPane, event)
        recordDesignActivity(`${event.agentName ? event.agentName + ' · ' : ''}${event.ok ? 'Выполнено' : 'Ошибка'}: ${event.tool}`)
        if (event.ok && ['dc_write', 'dc_html_str_replace', 'dc_js_str_replace', 'dc_set_props', 'dc_set_entry', 'dc_delete'].includes(event.tool) && activeDesign?.id === designRun.design.id) refreshDesignComponents()
        return
      }
      const task = agentTaskState(designRun.taskPane, event.agentIndex ?? 0)
      task.tools++
      task.what = `${event.ok ? 'Выполнено' : 'Ошибка'}: ${event.tool}`
      renderAgentTasks(designRun.taskPane)
      const detail = event.args ? JSON.stringify(event.args, null, 2) : event.detail || event.tool
      pushBlock(designRun, 'tool', String(detail), event.agentName || '', toolHeadline(event), toolParts(event))
      if (activeDesign?.id === designRun.design.id) scheduleDesignPaint()
      const agentPrefix = event.agentName ? `${event.agentName} · ` : ''
      recordDesignActivity(`${agentPrefix}${event.ok ? 'Выполнено' : 'Ошибка'}: ${event.tool}`)
      if (event.ok && ['dc_write', 'dc_html_str_replace', 'dc_js_str_replace', 'dc_set_props', 'dc_set_entry', 'dc_delete'].includes(event.tool) && activeDesign?.id === designRun.design.id) refreshDesignComponents()
    })
    window.electronAPI.onMessageComplete(response => {
      if (designRun?.requestId !== response?.requestId) return
      designRun.placeholder.tokens += Number(response.totalTokens || 0)
      completeAgentTask(designRun.taskPane, response)
      renderAgentTasks(designRun.taskPane)
      if (isHelperChunk(response)) {
        settleLane(designRun, designRun.taskPane, response)
        renderAgentTasks(designRun.taskPane)
        scheduleDesignPaint()
        return
      }
      const agent = response.agentName || ''
      if (response.reasoning && !designRun.blocks.some(b => b.kind === 'thinking' && b.agent === agent)) {
        pushBlock(designRun, 'thinking', response.reasoning, agent)
        designRun.reasoningSegments.push({ agent, text: response.reasoning })
        designRun.placeholder.reasoning = reasoningSegmentsToText(designRun)
      }
      scheduleDesignPaint()
    })
    el.navDesign?.addEventListener('click', () => switchTab('design'))
    $('designBackBtn')?.addEventListener('click', closeDesign)

    $('designTitle')?.addEventListener('click', async () => {
      if (!activeDesign) return
      const design = activeDesign
      const next = await askText('Название дизайна', activeDesign.name || '', 'Переименовать')
      if (next === null || activeDesign?.id !== design.id) return
      activeDesign.name = next.trim() || activeDesign.name
      activeDesign.titleManual = true
      activeDesign.updatedAt = Date.now()
      saveDesigns()
      $('designTitle').textContent = activeDesign.name
    })

    const deleteDesign = () => (activeDesign ? deleteDesignById(activeDesign.id) : undefined)
    $('designMoreBtn')?.addEventListener('click', () => {
      const more = $('designMoreBtn')
      window.OnlyoneMk.popMenu(more, [
        [t('В чат / проект'), () => handoffDesign(more), { d: t('Исходники — в диалог') }],
        [t('Удалить дизайн'), () => deleteDesign(), { danger: true }]
      ])
    })

    $('designAttachBtn')?.addEventListener('click', () => addDesignRefs())

    // Ctrl+V прямо в поле ввода. Событие перехватывается только когда в буфере
    // действительно есть файл — иначе обычная вставка текста перестала бы
    // работать.
    $('designComposerTextarea')?.addEventListener('paste', async event => {
      if (!activeDesign) return
      const hasFile = [...(event.clipboardData?.items || [])].some(item => item.kind === 'file')
      if (!hasFile) return
      event.preventDefault()
      await pasteDesignRefs(event.clipboardData)
    })

    // Перетаскивание на рабочую область. Electron отдаёт настоящий путь файла,
    // поэтому копирование делает главный процесс, а не переливание байтов через
    // окно.
    const workspace = $('designWorkspace')
    if (workspace) {
      const stop = event => { event.preventDefault(); event.stopPropagation() }
      workspace.addEventListener('dragover', event => {
        stop(event)
        if (activeDesign) workspace.classList.add('is-dropping')
      })
      workspace.addEventListener('dragleave', event => {
        if (event.target === workspace) workspace.classList.remove('is-dropping')
      })
      workspace.addEventListener('drop', async event => {
        stop(event)
        workspace.classList.remove('is-dropping')
        if (!activeDesign) return
        const paths = [...(event.dataTransfer?.files || [])]
          .map(file => window.electronAPI?.filePath?.(file) || file.path)
          .filter(Boolean)
        if (!paths.length) return showToast('Не удалось определить путь к файлу', true)
        await addDesignRefs(paths)
      })
    }

    $('designSelectElementBtn')?.addEventListener('click', () => setElementPicking(!elementPicking))
    // Фаза захвата нужна не для скорости, а для порядка: глобальный обработчик
    // окна закрывает модалки всплытием, и к моменту всплытия «открыт ли
    // диалог» уже не узнать — а Escape в диалоге отмены должен касаться диалога.
    window.addEventListener('keydown', event => { void handleDesignPreviewKey(event) }, true)
    $('designRemoveElementBtn')?.addEventListener('click', () => void removeSelectedDesignElement())
    $('designUnpickBtn')?.addEventListener('click', () => { setElementPicking(false); $('designComposerTextarea')?.focus() })
    // The .dc.html files are the deliverable: they open in any browser and go
    // back to the Design section unchanged, so there is always a way to them.
    $('designRevealBtn')?.addEventListener('click', async () => {
      if (!activeDesign) return
      const res = await window.electronAPI?.designReveal?.(activeDesign.id)
      if (res && res.ok === false) showToast(res.error || 'Не удалось открыть папку', true)
    })
    $('designModelBtn')?.addEventListener('click', () => modelPopoverInstance?.openModels($('designModelBtn')))

    const form = $('designComposerForm')
    const textarea = $('designComposerTextarea')
    textarea?.addEventListener('input', () => {
      autoResizeTextarea({ dom: { textarea } })
      // Пустая кнопка останавливает ход; набранный текст отправится в очередь.
      paintDesignSendButton(Boolean(designRun))
    })
    window.addEventListener('resize', () => autoResizeTextarea({ dom: { textarea } }))
    form?.addEventListener('submit', event => {
      event.preventDefault()
      // Черновик не очищается при остановке текущего хода.
      if ($('designSendBtn')?.dataset.stop === '1') {
        stopDesignRun()
        return
      }
      if (!textarea.value.trim()) return
      const value = textarea.value
      // Идёт ход — сообщение ждёт очереди. Молчать в ответ на нажатие нельзя, а
      // отправлять поверх работающего хода — тем более.
      if (designBusy) {
        const id = activeDesign?.id
        if (!id) return
        if (!queueDesignMessage(id, { text: value })) {
          showToast(t('В этом макете уже есть сообщение в очереди'), true)
          return
        }
        textarea.value = ''
        autoResizeTextarea({ dom: { textarea } })
        paintDesignSendButton(Boolean(designRun))
        return
      }
      textarea.value = ''
      autoResizeTextarea({ dom: { textarea } })
      paintDesignSendButton(true)
      const picked = selectedDesignElement?.designId === activeDesign?.id && selectedDesignElement?.component === designActiveComponent ? selectedDesignElement : null
      if (!picked) { sendDesignMessage(value); return }
      setElementPicking(false)
      sendDesignMessage(value, { about: picked.element, hidden: [
        value.trim(),
        '',
        `Это про элемент, выбранный человеком в живом превью Design: ${picked.element}.`,
        `Открытый компонент: ${picked.component}. Правь этот элемент; остальное меняй, только если об этом сказано.`
      ].join('\n') })
    })
    textarea?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        // Пояснения «дождитесь завершения» больше нет: сообщение встаёт в
        // очередь, как в чате, и уходит следующим ходом.
        form.requestSubmit()
      }
    })
    // The pill has to follow a model chosen in the shared modal.
    $('designPreviewFrame')?.addEventListener('load', () => {
      setCommentPicking(commentPicking)
      if (elementPicking) setElementPicking(true, { keepSelection: true })
    })
    // Правка из чата: канал main → renderer, единственный
    // путь, которым главный процесс отдаёт правку окну. Подписка здесь, а не в
    // модуле карточки: исполняет её ход Дизайна, а он живёт в окне.
    window.electronAPI?.onDesignChatEdit?.(payload => applyDesignChatEdit(payload))
  }

  // ─── Артефакты чата ──────────────────────────────────────────
  // Панель вынесена своим модулем: `artifact-panel.js`. Здесь только
  // проводка — общие виджеты окна и вызовы из ленты чата.
  let artifactPanelInstance = null
  // Место чату рядом с браузером/превью и панелью «Работа» держит work-panel.js (см. ensureChatRoom).
  function ensureChatRoom(...args) { return workPanel().ensureChatRoom(...args) }
  function releaseChatRoom(...args) { return workPanel().releaseChatRoom(...args) }
  function forgetSidebarNarrowing(...args) { return workPanel().forgetSidebarNarrowing(...args) }
  window.addEventListener('resize', () => ensureChatRoom())

  function artifactPanel() {
    if (!artifactPanelInstance) {
      artifactPanelInstance = OnlyoneArtifactPanel.create({
        $, t, escapeHtml, enhanceSelect, openContextMenu, askConfirm, electronAPI, document,
        onSpace: open => { if (open) ensureChatRoom(); else releaseChatRoom() },
        // Ряд кнопок — ряда открытого диалога: панель спрашивает его
        // геттером, сама она состояние окна не читает.
        getChatId: () => activePane?.chatId || panes[0]?.chatId || ''
      })
      artifactPanelInstance.bind()
    }
    return artifactPanelInstance
  }
  function showArtifact(artifact, version) { return artifactPanel().showArtifact(artifact, version) }
  function refreshArtifactChips(chatId) { return artifactPanel().refreshArtifactChips(chatId) }
  function closeArtifactPanel() { return artifactPanel().closeArtifactPanel() }
  artifactPanel()
  // Обычный браузер в той же панели (режим «Браузер»): вкладки, адрес, localhost — browser-panel.js.
  browserPanelHandle = OnlyoneBrowserPanel.mount({ $, t, document, electronAPI, model: OnlyoneBrowserModel, host: artifactPanel(), openMenu: openContextMenu,
    // Слежение за вкладкой (watch_page): пробуждение уходит в тот чат, где слежение начато, как набранный текст
    // (идущий ход ставит его в очередь); снимок страницы прикладывается, если модель принимает картинки.
    chatIdOfRequest: requestId => paneForRequest(requestId)?.chatId || '',
    sendToChatWithFiles: (text, opts) => {
      if (opts && opts.chatId && panes[0].chatId !== opts.chatId && conversations.some(chat => chat.id === opts.chatId)) selectChat(panes[0], opts.chatId)
      // Снимок страницы идёт модели прямо в ход мысли (modelOnly), а не вложением в строке ввода: человек его не прикладывал.
      if (opts && opts.attachments && opts.attachments.length) addAttachments(panes[0], opts.attachments.map(item => ({ ...item, modelOnly: true })))
      sendFromUltra(text)
    },
    acceptsImages: () => (selectedModel?.inputModalities || ['text']).includes('image'), canWake: () => Boolean(workspaceState.path) && keysPool.some(k => k.enabled !== false && !k.dead) })

  // Карточка задачи Дизайна: макет собирает движок Дизайна по
  // просьбе из чата, а в ленте живёт статус сборки, живой кадр и переход в
  // раздел. Проводка здесь — одна, сам экран у своим модулем.
  let designTaskCardsInstance = null
  function designTaskCards() {
    if (!designTaskCardsInstance) {
      designTaskCardsInstance = OnlyoneDesignTaskCard.create({
        $, t, escapeHtml, document, electronAPI,
        // Список макетов окно держит у себя в памяти, а проект создал главный
        // процесс: без перечитания «Открыть в Дизайне» не нашло бы его.
        openDesign: async id => {
          if (!designs.some(item => item.id === id)) await loadDesigns()
          return openDesign(id)
        },
        getChatId: () => activePane?.chatId || panes[0]?.chatId || ''
      })
      designTaskCardsInstance.bind()
    }
    return designTaskCardsInstance
  }
  function redrawDesignTaskCards(...args) { return designTaskCards().redrawTaskCards(...args) }
  designTaskCards()

  // Живой вид страницы агента: карточка в панели «Работа», которую
  // рисуют события главного процесса. Подписку на канал модуль берёт на себя и
  // отдаёт её вместе с `dispose()`. «Остановить» закрывает скрытую страницу того
  // же хода — ход при этом продолжается, просто перестает кликать.
  let agentBrowserViewInstance = null
  function agentBrowserView() {
    if (!agentBrowserViewInstance) {
      agentBrowserViewInstance = OnlyoneAgentBrowserView.create({
        $, t, escapeHtml, document,
        // Мост передаётся именем, а не всем объектом: вид обязан отписаться по
        // той же ручке, и `test-audit` иначе не находит потребителя канала.
        electronAPI: {
          onAgentBrowserEvent: handler => electronAPI.onAgentBrowserEvent(handler)
        },
        host: $('tasksPanel'),
        // Панель «Работа» перестраивает своё содержимое целиком: вид следит за
        // своим хозяином и возвращает карточку, иначе живого кадра не видно
        // после окончания хода.
        MutationObserver,
        stop: () => electronAPI.stopAgentBrowser((activePane || panes[0] || {}).requestId || null)
      })
    }
    return agentBrowserViewInstance
  }
  agentBrowserView()

  // ─── Центр задач ──────────────────────────────────────────────
  // Индекс и экран живут в `task-center.js`. Здесь только то, чего модуль по
  // праву не знает: где лежат истории и макеты, как открыть чат и как уйти в
  // конкретный ответ.

  // Прерванный ход открывается своим чатом или макетом: карточка «Работа
  // прервалась» с кнопкой продолжения уже стоит в его ленте, и вторым местом
  // её заводить нечем. Отказ объясняется словами — молча не сделанное нажатие
  // читается как поломка интерфейса.
  function scrollToTaskMessage(pane, at) {
    const target = pane?.dom?.list?.querySelector(`.msg-item[data-at="${CSS.escape(String(at))}"]`)
    if (!target) return false
    target.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    target.classList.add('flash')
    setTimeout(() => target.classList.remove('flash'), 1400)
    return true
  }

  function openTaskFromCenter(item) {
    if (!item || !item.ownerId) return false
    if (item.surface === 'design') {
      if (!designs.some(design => design.id === item.ownerId)) {
        showToast(t('Этот макет уже удалён'), true)
        return false
      }
      switchTab('design')
      openDesign(item.ownerId)
      return true
    }
    const chat = conversations.find(row => row.id === item.ownerId)
    if (!chat) {
      showToast(t('Этот диалог уже удалён'), true)
      return false
    }
    if (!document.body.classList.contains('task-center-open')) switchTab('chats')
    const pane = activePane || panes[0]
    selectChat(pane, chat.id)
    // Лента перестраивается не в этом же кадре после выбора диалога, поэтому
    // ответ ждут, а не ищут один раз: иначе переход «не нашёл» свой же ответ.
    if (item.messageAt) {
      let tries = 0
      const look = () => {
        if (scrollToTaskMessage(pane, item.messageAt)) return
        // Лента большого диалога достраивается не одним кадром, поэтому ответ
        // ждут секунду, а не один переход: отказ — только когда узла нет и после.
        if (++tries > 10) { showToast(t('Ответ не найден в этой ленте'), true); return }
        setTimeout(look, 100)
      }
      setTimeout(look, 0)
    }
    return true
  }

  let taskCenterInstance = null
  // ─── Расписания: ход по сроку ──────────────────────────────────────
  // Планировщик будит окно каналом `schedule-request-turn` и ждёт итога по
  // `schedule-turn-result`. Ход идёт через тот же `handleSendMessage`, что и
  // сообщение человека: те же инструменты, та же история, тот же провайдер
  // в прогоне. Платного вызова из главного процесса здесь не бывает.
  //
  // Просьба не приезжает в теле события: она читается отдельно и только
  // сейчас. В списке и в пушах её никогда нет — иначе ключ, который человек
  // вставил в текст, уехал бы в окно вместе с состоянием.
  window.__scheduleWired = (window.__scheduleWired || 0) + 1
  electronAPI.onScheduleTurn?.(body => { runScheduledTurn(body) })
  // Снятие хода пришло из Центра задач: планировщик расписаний просит окно
  // остановить именно этот `runId`.
  electronAPI.onScheduleEvent?.(body => {
    if (body && body.type === 'schedule-stop') stopScheduledTurn(body.runId)
  })

  // Живые ходы расписания: `runId` → pane, где он идёт, и множество снятых.
  // Без реестра пауза не нашла бы, что останавливать, и сказала бы «сняли»,
  // оставив чат писать дальше — а человек видел бы обе правды сразу.
  const scheduleRuns = new Map()
  const scheduleStops = new Set()

  async function stopScheduledTurn(runId) {
    const key = String(runId || '')
    const pane = scheduleRuns.get(key)
    if (!pane) return false
    scheduleStops.add(key)
    // `requestId` появляется внутри хода: если снятие пришло до него,
    // звать отмену нечем — и нельзя звать её вслепую: пустой идентификатор
    // главный процесс трактует как «дефолтный» ход, а это чужая работа.
    if (!pane.requestId) return true
    try { await electronAPI.abortMessage(pane.requestId) } catch { /* ход уже кончился сам */ }
    return true
  }

  async function runScheduledTurn(body) {
    const runId = String((body && body.runId) || '')
    const report = (ok, error) => electronAPI.reportScheduleResult?.({
      // Диагностика уходит главному процессу и живёт в `lastError` записи: на
      // экране расписаний её нет, поэтому здесь она не переводится.
      runId, ok: Boolean(ok), ...(ok ? {} : { error: String(error || 'ход расписания не удался') })
    })
    if (!runId) return
    const pane = activePane || panes[0]
    if (!pane) return report(false, 'нет чата, куда принять ход')
    // Занятый ход не прерываем: планировщик подождёт и получит срок следующий
    // раз, а человек не потеряет то, что уже пишется.
    // То же условие, по которому окно ставит сообщение в очередь: если
    // что-то идёт или готовится, — расписание не должно вставать в очередь
    // человек: оно честно отказывает и ждёт следующего срока.
    if (pane.generating || pane.preparing) return report(false, 'в окне уже идёт ход')
    let got = null
    try {
      got = await electronAPI.getSchedulePrompt(body.id)
    } catch (error) {
      return report(false, String((error && error.message) || error))
    }
    const prompt = String((got && got.prompt) || '')
    if (!got || got.ok === false || !prompt.trim()) {
      return report(false, (got && got.error) || 'просьбу расписания не прочитать')
    }
    const chatId = body.chatId || null
    if (chatId) {
      if (!conversations.some(one => one.id === chatId)) return report(false, 'чата этого расписания больше нет')
      selectChat(pane, chatId)
    } else {
      // Без названного чата расписание заводит новый и подписывает его своим
      // именем: иначе несколько сроков сваливаются в один диалог, и человек
      // не разберёт, где какой запуск.
      createNewChat(pane, String(body.name || t('Новый диалог')))
    }
    try {
      // Ход расписания участвует в гонке снятия: окно знает о нём
      // только из этого реестра.
      scheduleRuns.set(runId, pane)
      await handleSendMessage(pane, prompt, {})
      // Снятый ход — не «выполнено»: человек просил остановить, и
      // вторая правда в ленте была бы хуже молчания.
      // Страж выше закрывает обычный случай; этот — страховка от гонки:
      // если текст всё же лёг в очередь окна, хода не было, и сказать об
      // этом честнее, чем записать «выполнено» за принятый в очередь запрос.
      if (pane.queuedMessage && String(pane.queuedMessage).includes(prompt)) {
        report(false, 'окно занято: просьба встала в очередь, а не в ход')
        return
      }
      if (scheduleStops.has(runId)) report(false, 'ход снят из Центра задач')
      else report(true)
    } catch (error) {
      report(false, String((error && error.message) || error))
    } finally {
      scheduleRuns.delete(runId)
      scheduleStops.delete(runId)
    }
  }

  function taskCenter() {
    if (!taskCenterInstance) {
      taskCenterInstance = OnlyoneTaskCenter.create({
        document, t, escapeHtml,
        readInterrupted: async () => (await electronAPI.interruptedRuns?.()) || [],
        // Очередь фоновых работ: карточки планировщика рядом с
        // ходами чатов; действия идут тем же мостом, что и список.
        readTasks: async () => (await electronAPI.getTasks?.())?.tasks || [],
        runTaskAction: async (name, id) => {
          // Вызовы названы явно: проверка врезки и `test-audit` ищут, кто
          // пользуется мостом, а не догадываются по строке map-а.
          const call = { pause: () => electronAPI.pauseTask(id), resume: () => electronAPI.resumeTask(id),
            cancel: () => electronAPI.cancelTask(id), restart: () => electronAPI.restartTask(id) }[name]
          if (typeof call !== 'function') return { ok: false }
          try {
            const got = await call()
            // Отказ планировщика человек видит словами, а не молчаливым
            // «ничего не произошло»: карточка после него обновится сама.
            if (got && got.ok === false) showToast(String(got.error || t('Планировщик отказал')), true)
            return got
          } catch (error) {
            return { ok: false, error: String((error && error.message) || error) }
          }
        },
        getChats: () => conversations, getDesigns: () => designs,
        getPanes: () => panes, getDesignPanes: () => designTaskPanes,
        openTask: openTaskFromCenter,
        // Соседние бейджи тоже показывают счёт, а не уведомление: ноль
        // остаётся видимым, иначе метка мигает.
        setBadge: count => { if (isUltraPreset() && el.taskCenterBadge) el.taskCenterBadge.textContent = String(count) }
      })
      // Активный ход выдаёт события пачками: список перерисовывается не чаще,
      // чем раз в 400 мс и только пока открыт, а метка раздела — всегда.
      const bump = () => { taskCenterInstance.rebuildSoon(); taskCenterInstance.syncBadge() }
      electronAPI.onAgentEvent?.(bump)
      electronAPI.onMessageComplete?.(bump)
      electronAPI.onConversationsChanged?.(bump)
      // Состояния очереди приходят троттлированными из главного процесса: на
      // них раздел ПЕРЕЧИТЫВАЕТ список планировщика (событие несёт только
      // сдвинувшиеся карточки), а не перерисовывает прежний снимок.
      electronAPI.onTaskEvent?.(() => { taskCenterInstance.queueChanged(); taskCenterInstance.syncBadge() })
    }

    return taskCenterInstance
  }

  const modsClient = window.OnlyoneMods?.create({ api: window.electronAPI, t, getPane: () => activePane || panes[0], chatOf, closeSettings: () => closeModal(el.settingsModal) })
  init().catch(err => console.error('Инициализация не удалась:', err))
})()
