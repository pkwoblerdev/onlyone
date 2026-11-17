/* Блоки агентной ленты.
 * Ответ — это не «сначала всё размышление, потом весь текст»: модель думает,
 * говорит, зовёт инструмент, думает над ответом и говорит ещё. Ход хранится
 * списком блоков и рисуется в том же порядке, а подряд идущие куски одного
 * рода сливаются, чтобы поток токенов не плодил карточки.
 * 
 * Отдельный файл потому, что это способ рисования ответа, а не окно целиком:
 * лента, отправка и панель работы обращаются к блокам как к своему алфавиту,
 * и пока он лежал в `app.js`, его правки задевали всё вокруг.
 * Знакомство с окном — проводкой: разметка, тексты и чужие маленькие хелперы.
 */
(function (root) {
  'use strict'

  // Что нужно от окна, приходит проводкой при первом обращении: к этому
  // моменту `app.js` уже объявил всё, что передаёт.
  let $, el, t, escapeHtml, renderMarkdownHtml, bindCopyButtons, formatDuration, normalizePlanSteps, PLAN_STATUS, schedulePaint, agentTaskState, countWord, renderAgentTasks, getUiLang, formatTokens

  // GFM-чек-лист («- [ ]», «- [x]») приходит как <input type=checkbox>, а `input` санитайзер вырезает целиком, поэтому
  // сделанный и несделанный пункты выглядели одинаково. До чистки заменяем поле безобидным span с классом.
  function markTaskBoxes(doc, root) {
    root.querySelectorAll('input[type="checkbox"]').forEach(box => {
      const mark = doc.createElement('span')
      mark.className = box.hasAttribute('checked') ? 'md-check is-checked' : 'md-check'
      const word = doc.createElement('span')
      word.className = 'visually-hidden'
      word.textContent = t(box.hasAttribute('checked') ? 'Пункт выполнен' : 'Пункт не выполнен')
      mark.appendChild(word)
      box.replaceWith(mark)
    })
  }

  // CSP окна не пускает внешние картинки (`img-src` без https): <img> рисовался битой иконкой с подписью. Вместо него
  // остаётся ссылка с подписью картинки — её можно открыть в браузере, а окно ничего не загружает само.
  function linkifyImages(doc, root) {
    root.querySelectorAll('img').forEach(img => {
      const src = (img.getAttribute('src') || '').trim()
      if (!/^https?:/i.test(src)) { img.remove(); return }
      const link = doc.createElement('a')
      link.href = src
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.className = 'md-image-link'
      let host = src
      try { host = new URL(src).hostname } catch { /* оставляем адрес как есть */ }
      link.textContent = (img.getAttribute('alt') || '').trim() || host
      link.setAttribute('data-tooltip', src)
      img.replaceWith(link)
    })
  }

  // Лента изменилась по высоте — сжалась (подсказка выросла в две строки, открылась панель) или выросло содержимое
  // (по концу хода потоковый ответ заменяется итоговой разметкой, длиннее на целую пачку строк): тот, кто был внизу,
  // остаётся внизу. Иначе конец ответа и строка с его кнопками оказывались за нижним краем ленты, и до них надо
  // было долистывать руками. Читающий выше (`isPinned()` ложно) не трогается.
  function followFeed(feed, isPinned) {
    if (!feed || typeof ResizeObserver !== 'function') return
    let seen = ''
    const follow = () => {
      const key = feed.clientHeight + ':' + feed.scrollHeight
      if (key === seen) return
      seen = key
      if (isPinned() && feed.scrollHeight - feed.scrollTop - feed.clientHeight > 1) {
        feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' })
      }
    }
    const watcher = new ResizeObserver(follow)
    watcher.observe(feed)
    if (feed.firstElementChild) watcher.observe(feed.firstElementChild)
  }

  function create(deps) {
    ;({ $, el, t, escapeHtml, renderMarkdownHtml, bindCopyButtons, formatDuration, normalizePlanSteps, PLAN_STATUS, schedulePaint, agentTaskState, countWord, renderAgentTasks, getUiLang, formatTokens } = deps)
    // Чистые помощники ленты (`toolParts`, `toolHeadline`) вызываются и без
    // окна — в тестах, где проводки нет. Без переводчика строка остаётся
    // русным источником, и это правильный исход для такого вызова.
    if (typeof t !== 'function') t = text => text
    return Object.freeze({
      markTaskBoxes,
      linkifyImages,
      followFeed,
      toolParts,
      splitStoredTitle,
      toolHeadline,
      thinkingHeadline,
      thoughtBreak,
      closeLastThought,
      openThoughtLength,
      pushThinking,
      isHelperChunk,
      laneOf,
      lanePreview,
      looksLikeCode,
      feedLane,
      laneTool,
      settleLane,
      pushBlock,
      blocksForStorage,
      blockElement,
      paintBlocks,
      blockRevision,
      blocksHtmlInto,
      workRunFacts,
      workRunElement,
      thoughtElement,
      // Эти части живут в этом модуле, потому что и лента, и перерисовка
      // ответа берут их отсюда. `app.js` пользуется ими, а не своими копиями.
      thoughtRuns,
      thoughtSummary,
      thoughtClass,
      thoughtLiveTitle,
      thoughtLayout,
      thoughtStats,
      formatElapsed,
      fileChangeRowHtml,
      fileChangesBlockHtml,
      updateLiveAssistantUI
    })
  }

  // Thinking arrives token by token. Rebuilding the whole block and jumping the
  // feed to the bottom on every one of those made the text twitch and yanked the
  // view down as fast as the model could type. Now the block is only ever
  // appended to, and the redraw is paced.

  // ---------------------------------------------------------------------------
  // Message blocks
  // ---------------------------------------------------------------------------
  // An answer is not "all the thinking, then all the text". A model thinks, says
  // something, calls a tool, thinks again about what came back, and says more.
  // Piling every thought into one block above the answer threw that order away,
  // and with it the only thing that made a long turn readable: what led to what.
  //
  // So the turn is kept as an ordered list of blocks and drawn in that order.
  // Consecutive pieces of the same kind merge, so a stream of tokens does not
  // become a stream of boxes.

  // The headline of a thought: its first real sentence. Models open with
  // "Хорошо," and "Let me" often enough that those are skipped.
  // What a tool call actually did, phrased the way a person would say it.
  // Derived from the call itself, so it is never a plausible-sounding guess.
  // The same step, split into the three columns the row is laid out in: what was
  // done, what it was done to, and the number it produced. One string could only
  // ever be left-aligned prose; these can be a verb in dim ink, a path in light,
  // and a count against the right edge.
  //
  // `tone` picks the dot: a step that failed is red, one that changed something
  // on disk is green, and merely looking at something is grey. Reading is the
  // common case and it is the one that should not draw the eye.
  const TOOL_SECRET_NAMES = new Set([
    'key', 'token', 'secret', 'password', 'passwd', 'pwd', 'signature', 'auth',
    'authorization', 'cookie', 'credential', 'jwt', 'токен', 'ключ', 'секрет', 'пароль'
  ])
  const TOOL_SECRET_ASSIGNMENT = /(["']?(?:[a-z0-9]+[_-])*(?:api[-_.]?key|access[-_.]?token|client[-_.]?secret|private[-_.]?key|refresh[-_.]?token|authorization|cookie|credential|signature|password|passwd|pwd|secret|token|key|токен|ключ|секрет|пароль)["']?\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;&"'<>]+))/gi
  const TOOL_SECRET_QUERY = /([?&](?:[a-z0-9]+[_-])*(?:api[-_.]?key|access[-_.]?token|client[-_.]?secret|private[-_.]?key|refresh[-_.]?token|authorization|cookie|credential|signature|password|passwd|pwd|secret|token|key|токен|ключ|секрет|пароль)=)[^&#\s"'<>]*/gi
  const TOOL_BEARER = /\b(Bearer|Basic)([\t ]+)[A-Za-z0-9._~+/-]{6,}={0,2}/gi
  const TOOL_JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g
  const TOOL_PREFIX_SECRET = /\b(?:sk|ghp|gho|ghu|ghs|glpat|aiza|hf|npm|xai|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi
  // Tool summaries sometimes contain only a credential value, with no JSON
  // field name left to guide redaction. Catch explicitly-labelled opaque
  // tokens, but not ordinary prose or paths such as `src/secrets.js`.
  const TOOL_NAMED_SECRET = /\b[A-Z0-9]{2,}(?:[_-][A-Z0-9]{2,})*[_-](?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD|CREDENTIAL)[_-][A-Za-z0-9_-]{8,}\b/g
  const TOOL_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g

  function isSecretArgumentName(name) {
    const words = String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase().split(/[^a-z0-9\u0430-\u044f]+/).filter(Boolean)
    return words.some(word => TOOL_SECRET_NAMES.has(word)) ||
      /(?:^|_)(?:api|access|client|private|refresh|signing|session|encryption)_(?:key|token|secret)(?:_|$)/.test(
        String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())
  }

  function redactToolString(input) {
    return String(input == null ? '' : input)
      .replace(TOOL_PRIVATE_KEY, '***')
      .replace(TOOL_BEARER, '$1$2***')
      .replace(TOOL_JWT, '***')
      .replace(TOOL_PREFIX_SECRET, '***')
      .replace(TOOL_NAMED_SECRET, '***')
      .replace(TOOL_SECRET_QUERY, '$1***')
      .replace(TOOL_SECRET_ASSIGNMENT, (whole, prefix, doubleQuoted, singleQuoted, bare) => {
        const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : ''
        const value = doubleQuoted ?? singleQuoted ?? bare ?? ''
        // Empty values and the scheme name are not secrets; retaining them
        // keeps an ordinary explanation readable without exposing credentials.
        if (!value || /^(?:bearer|basic|token|digest)$/i.test(value)) return whole
        return prefix + quote + '***' + quote
      })
  }

  function redactToolValue(value, key = '') {
    if (isSecretArgumentName(key) && typeof value === 'string' && value) return '***'
    if (Array.isArray(value)) return value.map(item => redactToolValue(item))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactToolValue(item, name)]))
    }
    return typeof value === 'string' ? redactToolString(value) : value
  }

  function redactToolText(input) {
    const text = String(input == null ? '' : input)
    try {
      return JSON.stringify(redactToolValue(JSON.parse(text)), null, 2)
    } catch {
      return redactToolString(text)
    }
  }

  function safeToolParts(parts) {
    if (!parts || typeof parts !== 'object') return parts
    return {
      ...parts,
      target: redactToolText(parts.target),
      detail: redactToolText(parts.detail),
      items: Array.isArray(parts.items)
        ? parts.items.map(item => ({ ...item, detail: redactToolText(item?.detail) }))
        : parts.items
    }
  }

  // Значок шага по инструменту (макет onlyone 2.0: у каждой строки хода свой значок —
  // файл, терминал, страница, изображение). Линия 1.5, поле 16, как у значков боковой панели.
  // Для остальных инструментов остаётся прежняя точка на рельсе.
  const STEP_ICONS = {
    file: '<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>',
    edit: '<path d="M3 13l.6-2.8 7.2-7.2 2.2 2.2-7.2 7.2z"/><path d="M9.6 4.2l2.2 2.2"/>',
    terminal: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.6l2 1.4-2 1.4M8.6 9.8h2.4"/>',
    globe: '<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c1.5 1.6 2.2 3.5 2.2 5.6S9.5 12 8 13.6C6.5 12 5.8 10.1 5.8 8S6.5 4 8 2.4z"/>',
    folder: '<path d="M2.3 5.1c0-.9.7-1.6 1.6-1.6h2l1.4 1.8h5c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H3.9c-.9 0-1.6-.7-1.6-1.6z"/>',
    search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="M10.4 10.4l3.1 3.1"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2.4 11.4l3.3-3.3 2.4 2.4 1.7-1.7 3.8 3.8"/><path d="M10.6 6.1h.01"/>'
  }

  function stepIconKind(tool) {
    const name = String(tool || '')
    if (name === 'run_command' || name.startsWith('own_')) return 'terminal'
    if (name === 'read_file' || name === 'skill_file' || name === 'project_file' || name === 'dc_read' || name === 'dc_read_ref') return 'file'
    if (['write_file', 'edit_file', 'dc_write', 'dc_html_str_replace', 'dc_js_str_replace', 'dc_set_props', 'define_tool'].includes(name)) return 'edit'
    if (name === 'fetch_url' || name.startsWith('browse_')) return 'globe'
    if (name === 'list_files' || name === 'dc_list' || name === 'create_directory' || name === 'move_path') return 'folder'
    if (name === 'search_files') return 'search'
    if (name === 'dc_refs' || name === 'show_artifact' || name === 'update_artifact' || name === 'show_video' || name === 'browse_screenshot' || name === 'page_snapshot') return 'image'
    return ''
  }

  function stepIconHtml(tool) {
    const kind = stepIconKind(tool)
    if (!kind) return '<span class="rail-dot" aria-hidden="true"></span>'
    return `<span class="rail-dot rail-ico" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none">${STEP_ICONS[kind]}</svg></span>`
  }

  // Миниатюра снимка в строке шага: только картинка из data: умеренного размера. Остальное — не миниатюра, а мусор в диалоге.
  function shotThumb(value) {
    const text = String(value || '')
    return text.length <= 120000 && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(text) ? text : ''
  }

  function toolParts(entry) {
    const tool = String(entry?.tool || '')
    const detail = redactToolText(String(entry?.detail || '').trim())
    const target = detail.length > 52 ? '…' + detail.slice(-52) : detail
    const failed = entry?.ok === false

    const wrote = ['write_file', 'edit_file', 'create_directory', 'delete_path', 'move_path', 'define_tool', 'dc_write', 'dc_html_str_replace', 'dc_js_str_replace', 'dc_set_props', 'dc_set_entry', 'dc_delete']
    const tone = failed ? 'err' : (wrote.includes(tool) || tool.startsWith('own_') ? 'ok' : 'read')

    const VERBS = {
      dc_write: 'Записал макет', dc_read: 'Прочитал макет', dc_list: 'Посмотрел макеты',
      dc_html_str_replace: 'Изменил вёрстку', dc_js_str_replace: 'Изменил логику',
      dc_set_props: 'Настроил макет', dc_set_entry: 'Выбрал основной экран',
      dc_delete: 'Удалил макет', dc_check: 'Проверил макет',
      dc_refs: 'Посмотрел референсы', dc_read_ref: 'Прочитал референс',
      read_file: 'Прочитал',
      list_files: 'Посмотрел',
      fetch_url: 'Прочитал страницу',
      skill_file: 'Прочитал файл скилла',
      write_file: 'Записал',
      edit_file: 'Изменил',
      create_directory: 'Создал папку',
      delete_path: 'Удалил',
      move_path: 'Переместил',
      define_tool: 'Написал инструмент',
      ask_decision: 'Спросил помощника по решениям',
      project_chats: 'Посмотрел диалоги проекта',
      project_chat: 'Прочитал соседний диалог',
      project_note: 'Записал в диалог',
      task_plan: 'Обновил чек-лист',
      project_plan_set: 'Построил план',
      project_plan_get: 'Сверился с планом',
      project_file: 'Прочитал из базы знаний',
      project_topic_set: 'Записал тему диалога',
      run_command: 'Выполнил', search_files: 'Искал',
      show_artifact: 'Показал', update_artifact: 'Обновил', show_video: 'Показал ролик',
      artifacts_list: 'Посмотрел, что показано',
      browse_screenshot: 'Снял кадр страницы',
      page_snapshot: 'Снимок страницы'
    }

    let verb = t(VERBS[tool] || '')
    let shown = target
    // `own_run_cmd` is how the tool is addressed, not what it is called. The row
    // has already said «Запустил»; the prefix only makes the name longer.
    if (tool.startsWith('own_')) { verb = t('Запустил'); shown = tool.slice(4) }
    else if (tool.startsWith('mcp_')) { verb = 'MCP'; shown = target || tool }
    else if (!verb) { verb = tool; shown = target }
    // Корень рабочей папки — не «.»: одинокая точка в строке читалась как сбой вёрстки
    if (tool === 'list_files' && (!shown || shown === '.' || shown === './')) shown = t('рабочую папку')
    if (failed) verb = t('Не выполнено')

    let meta = ''
    if (entry?.added != null || entry?.removed != null) {
      meta = `+${entry.added || 0} −${entry.removed || 0}`
    }
    // `tool` rides along as the grouping key, `detail` as what one call in a
    // group actually did — the row shows the tool, the sublist shows the calls.
    return { verb, target: shown, meta, tone, tool, detail: target, path: detail, action: String(entry?.action || ''), thumb: shotThumb(entry?.thumb) }
  }

  // Chats saved before the row had columns carry only the sentence. Splitting it
  // at the first space gets the verb off the front, which is most of the effect;
  // the alternative is re-rendering old turns as one grey line.
  function splitStoredTitle(title) {
    const line = String(title || '').trim()
    const at = line.indexOf(' ')
    if (at < 0) return { verb: line, target: '', meta: '', tone: 'read' }
    return { verb: line.slice(0, at), target: line.slice(at + 1), meta: '', tone: 'read' }
  }

  function toolHeadline(entry) {
    const tool = String(entry?.tool || '')
    const detail = redactToolText(String(entry?.detail || '').trim())
    const short = detail.length > 52 ? '…' + detail.slice(-52) : detail

    // Путь «.» — это корень рабочей папки. В строке он выглядел как одинокая
    // точка: «Посмотрел .» не сообщает ничего и читается как сбой вёрстки.
    const where = short === '.' || short === './' ? 'рабочую папку' : short
    if (entry?.ok === false) return `${t('Не выполнено')}: ${tool}${where ? ' · ' + where : ''}`
    if (tool === 'read_file') return where ? `Прочитал ${where}` : 'Прочитал файл'
    if (tool === 'list_files') return where ? `Посмотрел ${where}` : 'Посмотрел файлы'
    if (tool === 'fetch_url') return short ? `Прочитал страницу ${short}` : 'Прочитал страницу'
    if (tool === 'edit_file') {
      const diff = entry.added || entry.removed
        ? `  +${entry.added || 0} −${entry.removed || 0}`
        : ''
      return (short ? `Изменил ${short}` : 'Изменил файл') + diff
    }
    if (tool === 'write_file') {
      const diff = entry.added || entry.removed
        ? `  +${entry.added || 0} −${entry.removed || 0}`
        : ''
      return (short ? `Записал ${short}` : 'Записал файл') + diff
    }
    if (tool === 'create_directory') return short ? `Создал папку ${short}` : 'Создал папку'
    if (tool === 'delete_path') return short ? `Удалил ${short}` : 'Удалил'
    if (tool === 'move_path') return short ? `Переместил ${short}` : 'Переместил'
    if (tool === 'define_tool') return short ? `Написал себе инструмент ${short}` : 'Написал себе инструмент'
    if (tool === 'run_command') return short ? `Выполнил команду: ${short}` : 'Выполнил команду'
    if (tool === 'search_files') return short ? `Искал: ${short}` : 'Искал по файлам'
    if (tool.startsWith('own_')) return `Свой инструмент: ${tool.slice(4)}`
    if (tool.startsWith('mcp_')) return short ? `MCP: ${short}` : 'Обратился к MCP'
    if (tool === 'project_chats') return 'Посмотрел диалоги проекта'
    if (tool === 'project_chat') return 'Прочитал соседний диалог'
    if (tool === 'project_note') return short ? `Записал в диалог «${short}»` : 'Записал в диалог проекта'
    if (tool === 'task_plan') return 'Обновил чек-лист задачи'
    if (tool === 'project_plan_set') return 'Построил план проекта'
    if (tool === 'project_plan_get') return 'Сверился с планом'
    if (tool === 'project_file') return short ? `Прочитал «${short}» из базы знаний` : 'Прочитал файл базы знаний'
    if (tool === 'project_topic_set') return 'Записал тему диалога'
    if (tool === 'browse_screenshot') return 'Снял кадр страницы'
    if (tool === 'page_snapshot') return 'Снимок страницы'
    if (tool === 'show_artifact') return short ? `Показал в панели: ${short}` : 'Показал в панели'
    if (tool === 'update_artifact') return short ? `Обновил в панели: ${short}` : 'Обновил в панели'
    if (tool === 'show_video') return short ? `Показал ролик: ${short}` : 'Показал ролик'
    if (tool === 'artifacts_list') return 'Посмотрел, что уже показано'
    return short ? `${tool}: ${short}` : tool
  }

  function thinkingHeadline(text) {
    // Если модель сама назвала мысль — «**Проверяю разделение.**» или «## Итог», —
    // это и есть заголовок. Придумывать свой поверх готового значит потерять то,
    // ради чего его писали.
    const titled = /^\s*(?:#{1,4}\s+(.+?)\s*$|\*\*([^*\n]{3,60})\*\*)/m.exec(String(text || ''))
    if (titled) {
      const own = String(titled[1] || titled[2] || '').replace(/\s+/g, ' ').trim().replace(/[:.]+$/, '')
      if (own.length > 2) return own.length > 84 ? own.slice(0, 84).replace(/\s+\S*$/, '') + '…' : own
    }

    const cleaned = String(text || '')
      .replace(/^\s*(хорошо|ладно|итак|окей|ok|okay|alright|let me|давай)[,.!\s—-]*/i, '')
      .trim()

    const first = cleaned.split(/(?<=[.!?])\s|\n/).find(part => part.trim().length > 3)
    const line = (first || cleaned).replace(/\s+/g, ' ').trim()
    // Пустая мысль — не повод что-то написать. Раньше здесь возвращалось
    // «Ожидаю ответ модели…», и эта строка вставала поверх настоящего занятия
    // агента при каждом куске размышления без внятного первого предложения.
    if (!line) return ''
    // This is text actually provided by the model, not an invented activity.
    // Preserve its language; translating it via another request adds latency.
    return line.length > 84 ? line.slice(0, 84).replace(/\s+\S*$/, '') + '…' : line
  }

  // Мышление приходит одним потоком, и весь ход оно слипалось в один блок:
  // простыня на весь ответ, внутри которой приходится копаться, чтобы понять,
  // что модель вообще делала. Мысль делится там, где её делит сама модель —
  // пустой строкой и заголовком, — а заголовок каждого куска берётся из его
  // первого предложения, так что список читается как оглавление хода.
  const THOUGHT_MIN = 260
  const THOUGHT_MAX = 1500
  // Заголовок, написанный самой моделью, — сильный сигнал: порог для него ниже,
  // иначе размеченная мысль всё равно слипалась бы в простыню.
  const THOUGHT_MIN_TITLED = 120

  const HEADING_AT_START = /^\s*(?:#{1,4}\s+\S|\*\*[^*\n]{3,60}\*\*)/
  const HEADING_AHEAD = /\n(?=\s*(?:#{1,4}\s+\S|\*\*[^*\n]{3,60}\*\*))/

  // Где разрезать входящий кусок. Ноль значит «резать пока не нужно».
  function thoughtBreak(text, already) {
    const blank = text.search(/\n\s*\n/)
    if (blank > 0 && already + blank >= THOUGHT_MIN) return blank

    // Модели размышления любят начинать новую мысль заголовком: «**Проверяю…**»
    // или «## Разбор». Это тот же разрыв, только без пустой строки.
    const heading = text.search(HEADING_AHEAD)
    if (heading > 0 && already + heading >= THOUGHT_MIN_TITLED) return heading

    // Ничего похожего на границу, а блок уже длиннее допустимого: режем по
    // ближайшему концу предложения, чтобы не рвать фразу посередине.
    if (already + text.length > THOUGHT_MAX) {
      const from = Math.max(0, THOUGHT_MAX - already)
      const tail = text.slice(from)
      const stop = tail.search(/[.!?…]\s/)
      if (stop >= 0) return from + stop + 1
    }
    return 0
  }

  function closeLastThought(pane, agent) {
    const blocks = pane.blocks || []
    const last = blocks.findLast(block => block.agent === agent)
    if (last && last.kind === 'thinking' && last.agent === agent) last.closed = true
  }

  function openThoughtLength(pane, agent) {
    const blocks = pane.blocks || []
    const last = blocks.findLast(block => block.agent === agent)
    return last && last.kind === 'thinking' && last.agent === agent && !last.closed
      ? last.text.length : 0
  }

  function pushThinking(pane, text, agent) {
    let rest = String(text || '')
    let guard = 0
    while (rest && guard++ < 24) {
      const already = openThoughtLength(pane, agent)

      // Кусок начинается с заголовка, а предыдущая мысль уже не крошка — значит
      // это новая мысль, и заголовок принадлежит ей, а не хвосту предыдущей.
      // Раньше граница искалась только внутри куска, и заголовок, пришедший
      // ровно первым символом, границей не считался вовсе.
      if (already >= THOUGHT_MIN_TITLED && HEADING_AT_START.test(rest)) {
        closeLastThought(pane, agent)
        pushBlock(pane, 'thinking', rest, agent)
        return
      }

      const cut = thoughtBreak(rest, already)
      if (cut <= 0) { pushBlock(pane, 'thinking', rest, agent); return }

      pushBlock(pane, 'thinking', rest.slice(0, cut), agent)
      closeLastThought(pane, agent)
      rest = rest.slice(cut).replace(/^\s+/, '')
    }
    if (rest) pushBlock(pane, 'thinking', rest, agent)
  }

  // ---------------------------------------------------------------------------
  // Дорожки агентов
  // ---------------------------------------------------------------------------
  // У каждого агента своя дорожка. Лента хода — дорожка ведущего; помощники,
  // пока работают, в ленту не пишут вовсе: их мысли и текст живут в их карточке
  // в панели работы, а в ленту их итог ложится одной свёрнутой строкой, когда
  // они закончили.
  //
  // Раньше дорожка была одна на всех. Агенты, работающие одновременно, писали в
  // один буфер по очереди по нескольку символов, и в ленте выходило «Подтверждено.
  // Ранный. Он Windows State версии. Нам отсутствует» — слова разных моделей
  // вперемешку. Мысли рвались ещё мельче: блок сливается только с блоком того же
  // агента, и при чередовании каждый кусок открывал новый блок в одно слово.

  function isHelperChunk(chunk) {
    return Number(chunk?.agentIndex ?? 0) > 0
  }

  function laneOf(owner, chunk) {
    owner.lanes = owner.lanes || new Map()
    const index = Number(chunk?.agentIndex ?? 0)
    let lane = owner.lanes.get(index)
    if (!lane) {
      lane = { index, name: '', text: '', thinking: '', tools: [], since: Date.now(), shownAt: 0 }
      owner.lanes.set(index, lane)
    }
    if (chunk?.agentName) lane.name = chunk.agentName
    return lane
  }

  // Последние слова дорожки — чтобы в карточке было видно, что агент делает, а не
  // только что он «пишет ответ». Одна строка, без переносов.
  function lanePreview(text) {
    const flat = String(text || '').replace(/[#*`>_]+/g, '').replace(/\s+/g, ' ').trim()
    const line = flat.length <= 140 ? flat : (() => {
      const tail = flat.slice(-140)
      const cut = tail.indexOf(' ')
      return '…' + (cut > 0 && cut < 40 ? tail.slice(cut + 1) : tail)
    })()
    // Модель, читая файл, пересказывает его куски в рассуждении, и в строке
    // «чем занят агент» оказывался обрывок чужого кода вида
    // «' ok ' : 'ПРОВАЛ') + ' ' + c.name + (c.detail ?». Прочесть его нельзя,
    // а место он занимает. Отличаем по плотности символов, которых в обычной
    // фразе почти не бывает.
    return looksLikeCode(line) ? '' : line
  }

  function looksLikeCode(line) {
    const text = String(line || '')
    if (text.length < 24) return false
    const symbols = (text.match(/[{}()[\];=<>|&+*/\\]/g) || []).length
    const letters = (text.match(/[\p{L}]/gu) || []).length
    return symbols >= 6 && symbols > letters / 6
  }

  // Кусок потока помощника. В ленту не попадает; карточка обновляется не чаще
  // раза в полсекунды — перерисовывать панель на каждый токен незачем.
  function feedLane(owner, taskPane, chunk, kind, text) {
    const lane = laneOf(owner, chunk)
    if (kind === 'thinking') lane.thinking += text
    else lane.text += text
    const task = agentTaskState(taskPane, lane.index, chunk?.agentName)
    const now = Date.now()
    if (now - lane.shownAt < 500) return
    lane.shownAt = now
    task.done = false
    task.what = kind === 'thinking' ? t('Думает') : t('Пишет отчёт')
    task.preview = lanePreview(kind === 'thinking' ? lane.thinking : lane.text)
    renderAgentTasks(taskPane)
  }

  function laneTool(owner, taskPane, entry) {
    const lane = laneOf(owner, entry)
    lane.tools.push({ headline: toolHeadline(entry), tone: entry?.ok === false ? 'err' : 'ok' })
    const task = agentTaskState(taskPane, lane.index, entry?.agentName)
    task.what = toolHeadline(entry)
    task.tools += 1
    task.done = false
    renderAgentTasks(taskPane)
  }

  // Помощник закончил: его работа ложится в ленту одной свёрнутой строкой. Текст
  // берётся из итога хода, а не из накопленного потока: итог — это то, что агент
  // сдал, поток мог оборваться на продолжении.
  function settleLane(owner, taskPane, response) {
    const lane = laneOf(owner, response)
    const task = agentTaskState(taskPane, lane.index, response?.agentName)
    const report = String(response?.content || lane.text || '').trim()
    const thinking = String(response?.reasoning || lane.thinking || '').trim()
    const outcome = response?.aborted ? 'interrupted'
      : response?.incomplete ? 'incomplete'
      : response?.ok === false ? 'failed'
      : report ? 'done' : 'empty'
    task.preview = ''
    pushBlock(owner, 'agent', report, lane.name || task.name || `Агент ${lane.index + 1}`,
      task.taskTitle || '', {
        outcome,
        model: task.model || '',
        seconds: Math.max(1, Math.round((Date.now() - (task.since || lane.since)) / 1000)),
        tokens: Number(response?.totalTokens || 0),
        thinking: thinking.length > 6000 ? '…' + thinking.slice(-6000) : thinking,
        tools: lane.tools.slice(-60)
      })
    owner.lanes.delete(lane.index)
  }

  function pushBlock(pane, kind, text, agent = '', title = '', parts = null) {
    if (!text && kind !== 'agent') return
    if (kind === 'tool') {
      text = redactToolText(text)
      title = redactToolText(title)
      parts = safeToolParts(parts)
    }
    pane.blocks = pane.blocks || []

    const last = pane.blocks[pane.blocks.length - 1]

    // Twelve calls to the same tool in a row are one thing the agent did, not
    // twelve. Left as separate rows they were a wall of «Свой инструмент:
    // run_cmd» that pushed the answer off the screen. They collapse into one
    // row with a count, and the individual calls live inside it.
    //
    // A failure never joins a group: it is the one call anybody is looking for,
    // and hiding it behind a count is how it gets missed.
    // Строка ещё не дописанного вызова и упавший вызов не сливаются в счётчик:
    // первая вот-вот станет другим вызовом, второй — то, что ищут глазами.
    const stands = parts => parts.tone !== 'err' && parts.tone !== 'pending'
    if (kind === 'tool' && parts && stands(parts) &&
        last && last.kind === 'tool' && last.agent === agent &&
        last.parts && last.parts.tool === parts.tool && stands(last.parts)) {
      last.items = last.items || [{ detail: last.parts.detail, meta: last.parts.meta, action: last.parts.action }]
      last.items.push({ detail: parts.detail, meta: parts.meta, action: parts.action })
      // The group's own meta stops being one call's numbers once there are two.
      last.parts = { ...last.parts, meta: '' }
      return
    }

    // Two separate actions are two rows; two pieces of one thought are one.
    // A plan is neither: its text is a whole JSON document, and appending a
    // second one to it produces something that parses as nothing.
    const merges = kind !== 'tool' && kind !== 'plan' && kind !== 'agent'
    // Parallel streams interleave at token boundaries. Only this agent's own
    // last block determines continuity; another agent must not split its words.
    // A tool/plan/text transition of the same agent remains a real boundary.
    // Слова без имени — слова ведущего, а его вызовы подписаны именем агента («Агент 1»): по
    // метке они «чужие», и findLast перепрыгивал через них, склеивая всё сказанное за ход в
    // один кусок над всеми вызовами. Вызов или чек-лист замыкает слова ведущего всегда.
    let previous = null
    if (merges) {
      for (let i = pane.blocks.length - 1; i >= 0; i--) {
        const block = pane.blocks[i]
        if (block.agent === agent) { previous = block; break }
        if (agent === '' && (block.kind === 'tool' || block.kind === 'plan')) break
      }
    } else previous = last
    if (merges && previous && previous.kind === kind && !previous.closed) {
      previous.text += text
      return
    }
    pane.blocks.push({ kind, agent, text, title, parts, at: Date.now() })
  }

  // A stored message is drawn from its blocks and its `content` is never read,
  // so an answer that is not among the blocks is invisible — which is how long
  // agent turns lost their answers while the thinking and the tool rows stayed.
  // Whatever the turn concluded goes in, once.
  function blocksForStorage(pane, answer) {
    const blocks = (pane.blocks || []).map(b => ({
      kind: b.kind, agent: b.agent,
      text: b.kind === 'tool' ? redactToolText(b.text) : b.text,
      title: b.title ? (b.kind === 'tool' ? redactToolText(b.title) : b.title) : undefined,
      parts: b.parts ? (b.kind === 'tool' ? safeToolParts(b.parts) : b.parts) : undefined,
      items: b.items ? (b.kind === 'tool' ? safeToolParts({ items: b.items }).items : b.items) : undefined
    }))

    const text = String(answer || '').trim()
    if (!text) return blocks

    const drawn = blocks.filter(b => b.kind === 'text').map(b => b.text).join('')
    if (drawn.includes(text)) return blocks
    if (drawn.trim() && text.startsWith(drawn)) {
      blocks.push({ kind: 'text', agent: '', text: text.slice(drawn.length) })
      return blocks
    }

    blocks.push({ kind: 'text', agent: '', text })
    return blocks
  }

  function blockElement(block, isLive) {
    // Saved chats from older builds may still contain raw tool arguments. Scrub
    // at paint time too, so history is safe before the next save/migration.
    if (block.kind === 'tool') {
      block = {
        ...block,
        text: redactToolText(block.text),
        title: block.title ? redactToolText(block.title) : block.title,
        parts: safeToolParts(block.parts),
        items: Array.isArray(block.items)
          ? block.items.map(item => ({ ...item, detail: redactToolText(item?.detail) }))
          : block.items
      }
    }
    if (block.kind === 'plan') {
      let steps = []
      try { steps = JSON.parse(block.text) } catch { steps = [] }
      steps = normalizePlanSteps(steps)

      const box = document.createElement("div")
      box.className = "plan-inline"

      const byId = new Map(steps.map(step => [step.id, step]))
      const rows = steps.map(step => {
        const needs = (Array.isArray(step.dependsOn) ? step.dependsOn : []).map(id => byId.get(id)?.title).filter(Boolean)
        return `
          <div class="plan-node status-${Object.hasOwn(PLAN_STATUS, step.status) ? escapeHtml(step.status) : 'todo'}">
            <div class="plan-dot"></div>
            <div class="plan-body">
              <div class="plan-title">${escapeHtml(step.title || "Шаг")}</div>
              ${step.detail ? `<div class="plan-detail">${escapeHtml(step.detail)}</div>` : ""}
              ${needs.length ? `<div class="plan-needs">после: ${escapeHtml(needs.join(", "))}</div>` : ""}
            </div>
            <span class="plan-status">${escapeHtml(PLAN_STATUS[step.status] || PLAN_STATUS.todo)}</span>
          </div>`
      }).join("")

      // «2 / 5» and a bar, not «5 шагов». How many are left is the question a
      // plan is read to answer; how many there are in total was never it.
      const done = steps.filter(step => step.status === "done").length
      const pct = steps.length ? Math.round((done / steps.length) * 100) : 0
      box.innerHTML = `
        <div class="plan-inline-head">
          <span class="plan-inline-title">${escapeHtml(block.title || "План")}</span>
          <span class="plan-inline-count">${done} / ${steps.length}</span>
          <span class="plan-progress"><span class="plan-progress-fill" style="width:${pct}%"></span></span>
        </div>
        <div class="plan-inline-body">${rows}</div>`
      return box
    }

    if (block.kind === 'agent') {
      // Одна строка на агента: кто, какая часть, чем кончилось и сколько заняло.
      // Раскрывается в его отчёт; ход мысли и действия — ещё глубже, потому что
      // нужны они редко, а занимали бы экран всегда.
      const parts = block.parts || {}
      const OUTCOME = { done: 'готово', interrupted: 'прервано', incomplete: 'не закончено',
        failed: 'ошибка', empty: 'без отчёта' }
      const box = document.createElement('details')
      box.className = `agent-report rail-step outcome-${Object.hasOwn(OUTCOME, parts.outcome) ? parts.outcome : 'done'}`

      const head = document.createElement('summary')
      head.className = 'agent-report-head'
      head.innerHTML = `
        <svg class="think-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
        <span class="agent-report-name"></span>
        <span class="agent-report-title"></span>
        <span class="agent-report-meta"></span>`
      head.querySelector('.agent-report-name').textContent = block.agent || 'Агент'
      head.querySelector('.agent-report-title').textContent = block.title || ''
      // Справа от имени агента — только время. «готово · 3 действ.» стояло в
      // каждой строке и не говорило ничего: то, что агент сдал работу, и так
      // видно по строке. Слово остаётся там, где оно меняет смысл, — когда
      // работа не удалась.
      const meta = []
      if (parts.outcome && parts.outcome !== 'done') meta.push(OUTCOME[parts.outcome] || parts.outcome)
      if (parts.seconds) meta.push(formatDuration(parts.seconds))
      head.querySelector('.agent-report-meta').textContent = meta.join(' · ')
      box.appendChild(head)

      const body = document.createElement('div')
      body.className = 'agent-report-body'
      if (block.text) {
        const report = document.createElement('div')
        report.className = 'msg-content agent-report-text'
        report.innerHTML = renderMarkdownHtml(block.text)
        body.appendChild(report)
      } else {
        const empty = document.createElement('div')
        empty.className = 'agent-report-empty'
        empty.textContent = t('Агент закончил, не написав отчёта.')
        body.appendChild(empty)
      }
      if (parts.thinking || (Array.isArray(parts.tools) && parts.tools.length)) {
        const more = document.createElement('details')
        more.className = 'agent-report-more'
        const label = document.createElement('summary')
        label.textContent = t('Ход работы')
        more.appendChild(label)
        if (Array.isArray(parts.tools) && parts.tools.length) {
          const list = document.createElement('ul')
          list.className = 'agent-report-tools'
          for (const tool of parts.tools) {
            const item = document.createElement('li')
            item.className = tool.tone === 'err' ? 'err' : ''
            item.textContent = tool.headline || ''
            list.appendChild(item)
          }
          more.appendChild(list)
        }
        if (parts.thinking) {
          const thought = document.createElement('div')
          thought.className = 'think-body agent-report-thinking'
          thought.textContent = parts.thinking
          more.appendChild(thought)
        }
        body.appendChild(more)
      }
      box.appendChild(body)
      return box
    }

    if (block.kind === 'thinking') {
      const box = document.createElement('details')
      // A thought is a step too, so it sits on the same rail. No role label: the
      // «АГЕНТ» caps badge said which of one agents was speaking, and the brief
      // rules out caps labels in the chat outright.
      box.className = `think rail-step tone-read think-row${isLive ? ' live' : ''}`

      const head = document.createElement('summary')
      head.className = 'think-head rail-line rail-line-think'
      head.innerHTML = `
        <svg class="think-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
        <span class="think-label"></span>`
      head.querySelector('.think-label').textContent = thinkingHeadline(block.text)

      const body = document.createElement('div')
      body.className = 'think-body'
      body.textContent = block.text

      box.appendChild(head)
      box.appendChild(body)
      return box
    }

    if (block.kind === 'tool') {
      const box = document.createElement('details')
      // A step on the rail. Still a <details>, so clicking still opens the raw
      // arguments — only the closed row is laid out as three columns instead of
      // one line behind a chevron.
      const parts = block.parts || splitStoredTitle(block.title || block.text)
      box.className = `think tool rail-step tone-${['read', 'ok', 'err'].includes(parts.tone) ? parts.tone : 'read'}${isLive ? ' live' : ''}`

      const head = document.createElement('summary')
      head.className = 'think-head rail-line'
      head.innerHTML = `
        ${stepIconHtml(parts.tool)}
        <span class="rail-verb"></span>
        <span class="rail-target"></span>
        <span class="rail-meta"></span>`
      head.querySelector('.rail-verb').textContent = parts.verb || ''
      head.querySelector('.rail-target').textContent = parts.target || ''
      // Файл читали или меняли — его имя открывает файл в превью (обработчик на документе, app.js)
      if (parts.path && parts.tone !== 'err' && ['read_file', 'write_file', 'edit_file'].includes(parts.tool)) {
        const open = document.createElement('button')
        open.type = 'button'
        open.className = 'rail-open'
        open.dataset.path = parts.path
        open.setAttribute('data-tooltip', t('Открыть в превью'))
        open.textContent = parts.target || ''
        head.querySelector('.rail-target').replaceChildren(open)
      }

      // A run of identical calls collapsed into one row: the count says how
      // many, and opening it lists them.
      const grouped = Array.isArray(block.items) && block.items.length > 1
      if (grouped) {
        const chip = document.createElement('span')
        chip.className = 'rail-count'
        chip.textContent = '×' + block.items.length
        head.querySelector('.rail-target').after(chip)
      }

      const metaEl = head.querySelector('.rail-meta')
      if (parts.meta) {
        // «+184» reads as a gain and «−0» as nothing lost; colouring only the
        // first is what makes the pair scannable.
        const [add, del] = String(parts.meta).split(/\s+/)
        metaEl.innerHTML = `<span class="rail-add"></span><span class="rail-del"></span>`
        metaEl.querySelector('.rail-add').textContent = add || ''
        metaEl.querySelector('.rail-del').textContent = del || ''
      }

      // Снимок страницы, который агент снял или получил: уменьшенная копия под строкой шага, а не внутри раскрытия — иначе
      // «посмотрел на страницу» оставалось бы словами, и человек не видел, на что именно.
      if (parts.thumb) {
        const row = document.createElement('span')
        row.className = 'rail-shot-row'
        const img = document.createElement('img')
        img.className = 'rail-shot'
        img.alt = t('Снимок страницы')
        img.src = parts.thumb
        row.appendChild(img)
        head.appendChild(row)
        box.classList.add('has-shot')
      }

      const body = document.createElement('div')
      if (grouped) {
        body.className = 'rail-group'
        for (const item of block.items) {
          const line = document.createElement('div')
          line.className = 'rail-subline'
          const target = document.createElement('span')
          target.className = 'rail-target'
          target.textContent = item.detail || ''
          const meta = document.createElement('span')
          meta.className = 'rail-meta'
          meta.textContent = item.meta || ''
          line.appendChild(target)
          line.appendChild(meta)
          body.appendChild(line)
        }
      } else {
        body.className = 'think-body rail-out'
        body.textContent = block.text
      }

      box.appendChild(head)
      // Раскрывать нечего, если внутри пусто, стоит одна точка или ровно то же,
      // что уже написано в строке. Пустой прямоугольник хуже его отсутствия:
      // человек нажимает и получает ничего.
      const inside = String(block.text || '').trim()
      const worthOpening = grouped ||
        (inside.length > 1 && inside !== '.' && inside !== (parts.target || '').trim())
      if (worthOpening) box.appendChild(body)
      else box.classList.add('rail-step--flat')
      return box
    }

    const box = document.createElement('div')
    box.className = 'msg-content'
    box.innerHTML = renderMarkdownHtml(block.text)
    return box
  }

  // Incremental: only the block that grew is touched. Rebuilding the lot on
  // every token is what made the text twitch.
  function paintBlocks(pane) {
    const host = pane.assistantEl
    if (!host) return

    let holder = host.querySelector('.msg-blocks')
    if (!holder) {
      holder = document.createElement('div')
      holder.className = 'msg-blocks'
      // Strictly a direct child, or insertBefore throws: the signature now lives
      // inside `.msg-footer`, so a plain querySelector finds a grandchild and
      // the whole turn stops rendering.
      // Сводка изменений тоже стоит перед подписью, и появиться она может
      // раньше первого слова ответа. Тогда якорем становится она: текст должен
      // лечь над списком файлов, а не под ним.
      const anchor = host.querySelector(':scope > .agent-file-changes, :scope > .msg-footer, :scope > .msg-meta')
      host.insertBefore(holder, anchor || null)
      pane.paintedBlocks = []
    }

    const blocks = pane.blocks || []
    const painted = pane.paintedBlocks || []

    // An empty record with nodes still on screen means someone asked for a
    // rebuild. Without clearing first, every block was appended a second time
    // and the trim at the end then dropped the new nodes instead of the old.
    if (!painted.length && holder.children.length) holder.replaceChildren()

    // Живая лента раньше красила каждый шаг ОТДЕЛЬНЫМ узлом, и ход мысли
    // шёл кашей из строк: «посмотрел», «посмотрел», «видеоанализ», «лист».
    // Сворачивание было только при перерисовке ответа, то есть ровно тогда,
    // когда человек уже смотрит на готовый результат. Теперь раскладка
    // «мысль — слот» одна и та же для живой ленты и для переписки.
    //
    // ПОЧЕМУ ЧЕРЕЗ СЛОТЫ, А НЕ ПЕРЕНАБОР УЗЛОВ. Отрисовка идёт по индексам
    // блоков и дописывает только изменившееся; если вставить готовую мысль
    // одним узлом, индексы всех следующих блоков сдвинутся, и вместо точечной
    // дописки ход перерисовался бы целиком на каждом вызове инструмента.
    // Слот — это место в раскладке: сколько слотов, столько и узлов у ленты.
    const { slots, slotOf } = thoughtLayout(blocks)
    const shape = slots.map(one => (one.kind === 'run' ? `r${one.from}-${one.to}` : `o${one.from}`)).join(',') + (pane.generating ? '|g' : '')
    if (shape !== pane.paintedShape) {
      // Раскладка поменялась: мысль замкнулась или распахнулась. Узлы слотов
      // пересоздаются, и всё, что внутри них, красится заново — это происходит
      // на границе мысли, то есть редко, а не на каждом вызове.
      holder.replaceChildren()
      painted.length = 0
      pane.paintedShape = shape
      for (const slot of slots) {
        if (slot.kind !== 'run') continue
        const run = slot.indices.map(index => blocks[index])
        // Живой — последний ход, пока идёт ответ: он раскрыт, с временем и заголовком
        // «что делаю». Законченный свёрнут до итога одной фразой.
        const isLast = slot === lastRunSlot(slots)
        // Живой — только блок, которым ход заканчивается сейчас: если после него уже есть слова,
        // этот блок закончен, и он свёрнут до итога.
        const lastStep = blocks[slot.to]
        const stillRunning = Boolean(lastStep && lastStep.kind === 'tool' && lastStep.parts && lastStep.parts.tone === 'pending')
        const live = Boolean(pane.generating) && isLast && (slot.to === blocks.length - 1 || stillRunning)
        // Свёрнутый человеком живой ход остаётся свёрнутым при пересборке на следующем шаге.
        const startedAt = run[0] && run[0].at
        holder.appendChild(thoughtElement(run, {
          open: live && pane.runClosedFor !== startedAt,
          live,
          onToggle: open => { pane.runClosedFor = open ? null : startedAt }
        }))
      }
    }

    // Узел слота в разметке: у мысли это она сама, у одиночного блока — сам блок.
    // Пустых слотов в разметке нет, поэтому индекс узла слота и индекс слота
    // совпадают: слоты мыслей созданы выше, остальные заполняются по мере
    // отрисовки, а вставка идёт перед первым ещё не занятым слотом.
    const nodeOfSlot = index => holder.children[index] || null
    const insertIntoSlot = (index, node) => {
      const before = holder.children[index] || null
      holder.insertBefore(node, before)
    }

    blocks.forEach((block, i) => {
      const drawn = painted[i]
      // Текст и размышление сравниваются по длине: она же нужна, чтобы дописать
      // только хвост.
      //
      // Остальные блоки — по размерам того, что в них меняется. Раньше здесь
      // сериализовался весь блок, и это происходило для каждого блока на каждый
      // чанк потока: в длинном ходе с десятками вызовов инструментов работа
      // росла квадратично к длине ответа. Считать по содержимому, а не по
      // счётчику изменений, важно: счётчик потребовал бы, чтобы каждое
      // изменение блока шло через pushBlock, и прямая правка молча перестала бы
      // перерисовываться.
      const revision = block.kind === 'text' || block.kind === 'thinking'
        ? block.text.length
        : blockRevision(block)

      // Узел шага внутри свёрнутой мысли не трогаем: пока мысль идёт, её тело
      // строится при раскрытии (`thoughtElement`), и красить узлы в закрытой
      // мысли незачем — они появятся целиком и сразу.
      if (slotOf[i] !== undefined && slots[slotOf[i]]?.kind === 'run') {
        painted[i] = revision
        return
      }

      if (drawn === undefined) {
        {
          // Имя агента переносится на сам узел: панель работы по нему находит,
          // куда прокрутить. Без этого «Показать» не к чему было привязать.
          const node = blockElement(block, true)
          if (block.agent) node.dataset.agent = block.agent
          insertIntoSlot(slotOf[i] === undefined ? holder.children.length : slotOf[i], node)
        }
        painted[i] = revision
        return
      }
      if (drawn === revision) return

      // Узел блока лежит не в `holder.children[i]`, а по раскладке слотов.
      // Шаги мысли сюда не доходят — они вышли выше, — значит здесь только
      // одиночные блоки, и узел блока это ровно узел его слота.
      const node = slotOf[i] === undefined ? null : nodeOfSlot(slotOf[i])
      if (!node) return

      if (block.kind === 'thinking') {
        // Plain text, so new characters are appended to the node that already
        // holds them — no reparse, no reflow of anything above.
        const body = node.querySelector('.think-body')
        if (body) {
          if (block.text.length < drawn) body.textContent = block.text
          else body.appendChild(document.createTextNode(block.text.slice(drawn)))
        }
        // The headline follows the thought until the thought settles.
        const label = node.querySelector('.think-label')
        if (label) label.textContent = thinkingHeadline(block.text)
      } else if (block.kind === 'text') {
        // Reparsing markdown reflows everything below it. While the reader has
        // scrolled away, that work is invisible and expensive, and writing
        // scrollTop afterwards fought their own scrolling — which is what made
        // the feed feel stuck. Leave it alone: `overflow-anchor` keeps the
        // position on its own, and the block catches up when they come back.
        if (pane.generating && !pane.stickToBottom) {
          pane.deferredPaint = true
          return
        }

        node.innerHTML = renderMarkdownHtml(block.text)
        bindCopyButtons(node)
      } else {
        const replacement = blockElement(block, true)
        if (node.open) replacement.open = true
        holder.replaceChild(replacement, node)
      }
      painted[i] = revision
    })

    // Заголовок живого хода следует за последним шагом без перестройки узлов.
    if (pane.generating) {
      const lastRun = lastRunSlot(slots)
      if (lastRun) {
        const runNode = holder.children[slots.indexOf(lastRun)]
        if (runNode && typeof runNode.syncLive === 'function') {
          const liveTokens = (pane.totalTokens || 0) + Math.round((pane.smoothCursor || 0) / 4)
          runNode.syncLive(lastRun.indices.map(index => blocks[index]), liveTokens)
        }
      }
    }

    // Only the last block is still happening; everything before it has settled.
    const alive = pane.generating ? blocks.length - 1 : -1
    ;[...holder.children].forEach((node, i) => {
      const index = slotOf[i] === undefined ? i : slotOf[i]
      node.classList?.toggle('live', index === alive)
    })

    // Слот — это ровно один узел ленты: лишние узлы после перестройки раскладки
    // убраны, недостающие добавлены при отрисовке выше.
    while (holder.children.length > slots.length) holder.lastElementChild.remove()
    pane.paintedBlocks = painted
  }

  // Дешёвая подпись блока: меняется вместе с тем, что видно на экране, и не
  // требует обходить весь объект.
  function blockRevision(block) {
    const parts = block.parts || {}
    return String(block.text || '').length + ':' +
      (block.items ? block.items.length : 0) + ':' +
      String(parts.meta || '').length + ':' +
      String(parts.detail || '').length + ':' +
      String(parts.tone || '').length + ':' +
      String(block.title || '').length
  }

  // В законченном ответе серия шагов — мысли и действия подряд — сворачивается
  // в одну строку «Ход работы»: главное в ответе — текст, а ход нужен, когда
  // хочется проверить, что агент делал. Строка говорит, сколько было действий
  // и мыслей, что изменилось и что не удалось; шаги строятся только по нажатию.
  // Это же держит скорость: в самом большом чате владельца 11 779 шагов
  // (73 тысячи элементов), и открытие строил их все — почти секунда.
  // Текст ответа, отчёты помощников и чек-листы не сворачиваются никогда.
  const STEP_RUN_COLLAPSE = 3
  const isStepBlock = block => block.kind === 'tool' || block.kind === 'thinking'

  // ─── ход мысли собирается в «мысли» ───────────────────────────────────────
  // «Ход мысли — кашей из строк: посмотрел, посмотрел,
  // видеоанализ, мелочи, лист — всё это должно собираться в одну “мысль”».
  //
  // ПРАВИЛО, КОТОРОЕ ДАЁТ СМЫСЛ. Мысль — это серия шагов ПОДРЯД, между которыми
  // не прозвучало видимое слово ассистента. Всё, что человек читает как «ход
  // мысли», в него и попадает; новая мысль начинается там, где человек видит
  // границу. Границ три, и все три видны глазом:
  //   — слово ассистента между шагами (оно уже есть в списке блоков);
  //   — смена агента в команде: другой агент — другой ход мысли;
  //   — нешаговый блок (текст, отчёт, чек-лист) — тоже граница.
  //
  // ПОЧЕМУ ЧИСТАЯ ФУНКЦИЯ, А НЕ РАЗМЕТКА. Разметку мысли рисует `paintBlocks`
  // и `blocksHtmlInto` — два вызова на один и тот же список блоков. Если бы
  // разбивка жила в разметке, они рано или поздно разошлись бы, и лента
  // показала бы не ту группировку, что переписка. Одна функция на оба пути.
  function thoughtRuns(blocks) {
    const runs = []
    let current = null
    const list = Array.isArray(blocks) ? blocks : []
    for (let i = 0; i < list.length; i++) {
      const block = list[i]
      if (!isStepBlock(block)) {
        // Слова ассистента, чек-лист и отчёт замыкают блок: после них шаги — уже СЛЕДУЮЩИЙ
        // блок. Лента идёт по порядку: блок шагов → промежуточный результат → блок шагов →
        // … → итог, а не один блок на весь запрос.
        current = null
        continue
      }
      const agent = block.agent || ''
      // Новый агент — новая мысль, даже если шаги идут подряд: в команде это
      // разные люди за одним столом.
      if (!current || current.agent !== agent) {
        current = { from: i, to: i, agent, indices: [i] }
        runs.push(current)
        continue
      }
      current.to = i
      current.indices.push(i)
    }
    return runs
  }

  // Класс действия — по смыслу глагола, а не по его первой букве. Словарь
  // задаёт ОСМЫСЛ: «Читаю», «Читаю компонент» и «Читаю страницу в браузере» —
  // одно дело, и в итоге они считаются вместе («прочитал 6 файлов»), а не
  // тремя отдельными строками. Порядок классов в итоге — по первому появлению,
  // чтобы мысль читалась в том порядке, в каком шла работа.
  const THOUGHT_CLASSES = [
    ['read', /^(Читаю|Смотрю|Открываю|Просматриваю)/],
    ['search', /^(Ищу|Ищу в|Грею|Проверяю, есть ли)/],
    ['parse', /^(Разбираю|Анализирую|Собираю свой инструмент|Проверяю превью|Скачиваю)/],
    ['write', /^(Пишу|Создаю|Обновляю|Собираю компонент|Собираю ролик|Снимаю страницу|Удаляю|Перемещаю|Ставлю)/],
    ['run', /^(Выполняю|Запускаю|Кликаю|Ввожу)/],
    ['plan', /^(Веду чек-лист|Строю порядок|Распределяю|Спрашиваю|Применяю скилл)/],
    ['show', /^(Показываю)/]
  ]
  const UNKNOWN_CLASS = 'прочее'

  function thoughtClass(verb) {
    const text = String(verb == null ? '' : verb).trim()
    if (!text) return UNKNOWN_CLASS
    for (const [name, re] of THOUGHT_CLASSES) {
      if (re.test(text)) return name
    }
    return UNKNOWN_CLASS
  }

  // Глаголы по смыслу в родительном падеже — итог читается как фраза:
  // «прочитал 6 файлов», а не «Читаю × 6».
  const CLASS_PAST = {
    read: ['прочитал', 'файл', 'файла', 'файлов'],
    search: ['нашёл', 'раз', 'раза', 'раз'],
    parse: ['разобрал', 'штуку', 'штуки', 'штук'],
    write: ['записал', 'файл', 'файла', 'файлов'],
    run: ['запустил', 'раз', 'раза', 'раз'],
    plan: ['составил план:', 'шаг', 'шага', 'шагов'],
    show: ['показал', 'результат', 'результата', 'результатов'],
    [UNKNOWN_CLASS]: ['сделал', 'шаг', 'шага', 'шагов']
  }

  // ─── Ход работы одним блоком ─────────────────────────────────────────────────
  // Весь ход агента — ОДИН большой блок. Пока он идёт,
  // заголовок говорит, что делается сейчас («Выполняю команду · 9м 57с»), а когда кончился —
  // одной фразой подводит итог: «Выполнено 25 команд (1 с ошибкой), создано 5 файлов,
  // изменён файл и ещё 2 действия +392 −3». Шаги и слова ассистента лежат внутри.

  const isEnglish = () => typeof getUiLang === 'function' && getUiLang() === 'en'

  // Вид шага по инструменту: команды, созданные и изменённые файлы, прочитанные файлы, прочее.
  function stepKindOf(parts, action) {
    const tool = String((parts && parts.tool) || '')
    if (tool === 'run_command' || tool.startsWith('own_')) return 'command'
    if (tool === 'edit_file') return 'edited'
    if (tool === 'write_file') return (action || (parts && parts.action)) === 'created' ? 'created' : 'edited'
    if (tool === 'dc_html_str_replace' || tool === 'dc_js_str_replace') return 'edited'
    if (tool === 'read_file') return 'read'
    // Страницы и слежение называются в итоге хода своими словами, а не «одним действием».
    if (tool === 'browse_page') return 'opened'
    if (tool === 'fetch_url') return 'fetched'
    if (tool === 'browse_click' || tool === 'browse_input') return 'clicked'
    if (tool === 'browse_screenshot') return 'shot'
    if (tool === 'watch_page') return 'watching'
    if (tool === 'stop_watching') return 'unwatched'
    return 'other'
  }

  function thoughtStats(run) {
    const stats = { command: 0, created: 0, edited: 0, read: 0, opened: 0, fetched: 0, clicked: 0, shot: 0, watching: 0, unwatched: 0, other: 0, failedCommand: 0, failedOther: 0, thoughts: 0, notes: 0 }
    for (const block of (Array.isArray(run) ? run : (run && run.blocks) || []).filter(Boolean)) {
      if (block.kind === 'thinking') { stats.thoughts++; continue }
      if (block.kind !== 'tool') { if (block.kind === 'text') stats.notes++; continue }
      const parts = block.parts || {}
      const failed = parts.tone === 'err'
      const items = Array.isArray(block.items) && block.items.length > 1 ? block.items : [{ action: parts.action }]
      for (const item of items) {
        const kind = stepKindOf(parts, item && item.action)
        // Неудавшийся вызов в «сделанное» не входит и называется один раз; команды считаются все, с пометкой об ошибке.
        if (failed && kind !== 'command') { stats.failedOther++; continue }
        stats[kind]++
        if (failed) stats.failedCommand++
      }
    }
    return stats
  }

  // «1 с ошибкой», «2 с ошибками», «21 с ошибкой» — по правилам русского числа.
  const failedWord = n => (n % 10 === 1 && n % 100 !== 11 ? 'с ошибкой' : 'с ошибками')

  function thoughtSummary(run) {
    const list = (Array.isArray(run) ? run : (run && run.blocks) || []).filter(Boolean)
    if (!list.length) return ''
    const s = thoughtStats(list)
    const en = isEnglish()
    const plural = (n, one, few, many) => countWord(n, one, few, many)
    const items = []
    if (s.command) {
      const failed = s.failedCommand
        ? (en ? ` (${s.failedCommand} failed)` : ` (${s.failedCommand} ${failedWord(s.failedCommand)})`)
        : ''
      items.push((en
        ? (s.command === 1 ? 'ran a command' : `ran ${s.command} commands`)
        : (s.command === 1 ? 'выполнена команда' : `выполнено ${plural(s.command, 'команда', 'команды', 'команд')}`)) + failed)
    }
    const files = (n, enOne, ruOne, ruVerb, enVerb) => en
      ? (n === 1 ? `${enVerb} ${enOne}` : `${enVerb} ${n} files`)
      : (n === 1 ? `${ruOne} файл` : `${ruVerb} ${plural(n, 'файл', 'файла', 'файлов')}`)
    if (s.created) items.push(files(s.created, 'a file', 'создан', 'создано', 'created'))
    if (s.edited) items.push(files(s.edited, 'a file', 'изменён', 'изменено', 'edited'))
    if (s.read) items.push(files(s.read, 'a file', 'прочитан', 'прочитано', 'read'))
    // Работа с браузером: открытые страницы, действия на них, снимки, слежение.
    const pages = (n, enOne, enMany, ruOne, ruVerb, ruWord) => en
      ? (n === 1 ? enOne : enMany.replace('%n', n))
      : (n === 1 ? ruOne : `${ruVerb} ${plural(n, ruWord[0], ruWord[1], ruWord[2])}`)
    if (s.opened) items.push(pages(s.opened, 'opened a page', 'opened %n pages', 'открыта страница', 'открыто', ['страница', 'страницы', 'страниц']))
    if (s.fetched) items.push(pages(s.fetched, 'read a page', 'read %n pages', 'прочитана страница', 'прочитано', ['страница', 'страницы', 'страниц']))
    if (s.clicked) items.push(en
      ? (s.clicked === 1 ? 'made an action on the page' : `made ${s.clicked} actions on the page`)
      : (s.clicked === 1 ? 'выполнено действие на странице' : `выполнено ${plural(s.clicked, 'действие', 'действия', 'действий')} на странице`))
    if (s.shot) items.push(pages(s.shot, 'took a page snapshot', 'took %n page snapshots', 'снят кадр страницы', 'снято', ['кадр страницы', 'кадра страницы', 'кадров страницы']))
    if (s.watching) items.push(pages(s.watching, 'started watching a page', 'started %n page watches', 'запущено слежение за страницей', 'запущено', ['слежение', 'слежения', 'слежений']))
    if (s.unwatched) items.push(en ? 'stopped watching' : 'снято слежение')
    if (s.failedOther) items.push(en ? `${s.failedOther} failed` : `не выполнено: ${s.failedOther}`)

    let out
    if (!items.length && !s.other) {
      return s.thoughts || s.notes ? t('Ход мысли') : ''
    }
    if (!items.length) {
      out = en ? `Performed ${s.other} ${s.other === 1 ? 'action' : 'actions'}` : `Выполнено ${plural(s.other, 'действие', 'действия', 'действий')}`
    } else {
      const more = s.other
        ? (en ? `${s.other} more ${s.other === 1 ? 'action' : 'actions'}` : `ещё ${plural(s.other, 'действие', 'действия', 'действий')}`)
        : ''
      if (more) {
        // «…, изменён файл и ещё 2 действия» — «ещё N» всегда последнее звено.
        out = en
          ? items.join(', ') + (items.length > 1 ? ', and ' : ' and ') + more
          : items.join(', ') + ' и ' + more
      } else if (items.length === 1) {
        out = items[0]
      } else {
        const last = items[items.length - 1]
        out = en
          ? (items.length === 2 ? items[0] + ' and ' + last : items.slice(0, -1).join(', ') + ', and ' + last)
          : items.slice(0, -1).join(', ') + ' и ' + last
      }
    }
    return out.charAt(0).toUpperCase() + out.slice(1)
  }

  // Что агент делает ПРЯМО СЕЙЧАС: глагол вызова, который ещё идёт, иначе — думает.
  function thoughtLiveTitle(run) {
    const list = Array.isArray(run) ? run : []
    const last = list[list.length - 1]
    if (last && last.kind === 'tool' && last.parts && last.parts.tone === 'pending') {
      return String(last.parts.verb || '').trim() || t('Работаю')
    }
    return t('Думаю')
  }

  // Время хода: «57с», «9м 57с», «1ч 2м».
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const sec = total % 60
    const u = isEnglish() ? { h: 'h', m: 'm', s: 's' } : { h: 'ч', m: 'м', s: 'с' }
    if (h) return `${h}${u.h} ${m}${u.m}`
    if (m) return `${m}${u.m} ${sec}${u.s}`
    return `${sec}${u.s}`
  }

  // ─── «Изменения в файлах» — один блок в конце хода ────────────────────────
  // «Огромный блок посередине хода. Он должен
  // появляться только в конце ответа, а не посреди хода мысли».
  //
  // Пока ход идёт, файловые правки видны строками хода и счётчиком, а этот
  // блок рисуется ОДИН РАЗ — после последнего слова ответа, свёрнутым до
  // заголовка. Остановленный ход тоже даёт блок, с пометкой: молча назвать
  // чужую остановку своей нельзя.
  //
  // Порядок классов слов — как в словаре: `added` перед `removed`, и обе
  // пары проходят через `t()`, иначе английский заголовок остался бы русским.
  function fileChangeRowHtml(change) {
    const action = change && change.action === 'created' ? 'created' : 'updated'
    const mark = action === 'created' ? '+' : '~'
    const name = String((change && (change.file || change.path)) || '')
    let stat
    const added = Number(change && change.added) || 0
    const removed = Number(change && change.removed) || 0
    if (!added && !removed) {
      stat = `<span class="none">${escapeHtml(t('без изменений'))}</span>`
    } else {
      const parts = []
      if (added) parts.push(`<span class="added">+${added}</span>`)
      if (removed) parts.push(`<span class="removed">−${removed}</span>`)
      stat = parts.join(' ')
    }
    return `
      <div class="file-change-row ${action}">
        <div class="file-change-name">
          <span class="file-change-mark">${mark}</span>
          <span>${escapeHtml(name)}</span>
        </div>
        <div class="file-change-stat">${stat}</div>
      </div>`
  }

  function fileChangesBlockHtml(changes, options) {
    const list = Array.isArray(changes) ? changes.filter(one => one && (one.file || one.path)) : []
    // Пустого блока быть не должно: блок без содержимого — шум в ленте, и
    // по нему нельзя понять, менялось ли что-то вообще.
    if (!list.length) return ''
    const opts = options || {}
    const files = new Set(list.map(one => String(one.file || one.path))).size
    const title = escapeHtml(t('Изменено %s', countWord(files, 'файл', 'файла', 'файлов')))
    const stopped = opts.stopped
      ? `<span class="file-changes-stopped">${escapeHtml(t('ход остановлен'))}</span>`
      : ''
    return `
      <details class="agent-file-changes">
        <summary class="file-changes-title">
          <svg class="think-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
          <span>${title}</span>${stopped}
        </summary>
        <div class="file-changes-body">${list.map(fileChangeRowHtml).join('')}</div>
      </details>`
  }


  function blocksHtmlInto(host, blocks) {
    const opts = (arguments && arguments[2]) || {}
    const holder = document.createElement('div')
    holder.className = 'msg-blocks'
    const place = (block, before = null) => {
      const node = blockElement(block, false)
      if (block.agent) node.dataset.agent = block.agent
      holder.insertBefore(node, before)
    }
    // Та же раскладка, что у живой ленты: один ход — один блок с итогом одной фразой.
    const { slots } = thoughtLayout(blocks)
    for (const slot of slots) {
      if (slot.kind === 'run') holder.appendChild(thoughtElement(slot.indices.map(index => blocks[index]), { open: false, tokens: opts.tokens }))
      else place(blocks[slot.from])
    }
    host.appendChild(holder)
  }

  // Сводка серии: сколько действий и мыслей, итог правок, число неудач.
  function workRunFacts(run) {
    let tools = 0, thoughts = 0, failed = 0, added = 0, removed = 0, tokens = 0
    for (const block of run) {
      if (block.kind === 'thinking') { thoughts++; continue }
      if (block.kind === 'text') continue
      const parts = block.parts || {}
      const count = Array.isArray(block.items) && block.items.length > 1 ? block.items.length : 1
      tools += count
      if (parts.tone === 'err') failed++
      const [add, del] = String(parts.meta || '').split(/\s+/)
      added += Number(String(add || '').replace(/[^\d]/g, '')) || 0
      removed += Number(String(del || '').replace(/[^\d]/g, '')) || 0
      if (block.tokens) tokens += Number(block.tokens) || 0
    }
    return { tools, thoughts, failed, added, removed, tokens }
  }

  function workRunElement(run) {
    const facts = workRunFacts(run)
    const box = document.createElement('details')
    box.className = 'work-run'
    const head = document.createElement('summary')
    head.className = 'work-run-head'
    const counts = [
      facts.tools ? countWord(facts.tools, 'действие', 'действия', 'действий') : '',
      facts.thoughts ? countWord(facts.thoughts, 'мысль', 'мысли', 'мыслей') : ''
    ].filter(Boolean).join(' · ')
    head.innerHTML = `
      <svg class="think-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      <span class="work-run-title">${escapeHtml(t('Ход работы'))}</span>
      <span class="work-run-facts">${escapeHtml(counts)}</span>
      ${facts.failed ? `<span class="work-run-failed">${escapeHtml(t('не выполнено'))}: ${facts.failed}</span>` : ''}
      ${facts.added || facts.removed ? `<span class="work-run-diff"><span class="rail-add">+${facts.added}</span><span class="rail-del">−${facts.removed}</span></span>` : ''}`
    box.appendChild(head)
    // Шаги строятся при первом раскрытии: закрытая серия стоит одной строкой.
    box.addEventListener('toggle', () => {
      if (!box.open || box.querySelector('.work-run-body')) return
      const body = document.createElement('div')
      body.className = 'work-run-body'
      for (const block of run) {
        const node = blockElement(block, false)
        if (block.agent) node.dataset.agent = block.agent
        body.appendChild(node)
      }
      box.appendChild(body)
    })
    return box
  }

  function formatTokensCount(n) {
    if (typeof formatTokens === 'function') {
      const res = formatTokens(n)
      if (res) return res
    }
    const count = Number(n) || 0
    if (count <= 0) return ''
    if (count < 1000) return String(count)
    return `${(count / 1000).toFixed(1)}k`
  }

  // ─── мысль как строка с итогом, а не как очередь строк ─────────────────────
  // Раньше серия шагов в готовом ответе сворачивалась в безличное «Ход работы» с
  // числами («12 действий, 3 мысли»). Нужно иначе: строка
  // должна говорить, ЧТО сделано, по-человечески — «прочитал 6 файлов, записал
  // 2 файла». Число действий ничего не объясняет; смысл по глаголам объясняет всё.
  //
  // Класс `work-run` на узле остаётся: на нём завязаны стили и часть проверок.
  // Меняется содержимое заголовка, а не класс.
  function thoughtElement(run, options) {
    const opts = options || {}
    const box = document.createElement('details')
    box.className = 'work-run thought-group' + (opts.live ? ' is-live' : '')
    // Пока ход идёт, он раскрыт: видно, что агент делает сейчас. Законченный свёрнут.
    box.open = Boolean(opts.open)
    const head = document.createElement('summary')
    head.className = 'work-run-head thought-head'
    const facts = workRunFacts(run)
    const diffHtml = facts.added || facts.removed
      ? `<span class="work-run-diff"><span class="rail-add">+${facts.added}</span><span class="rail-del">−${facts.removed}</span></span>` : ''
    const started = Number(run[0] && run[0].at) || Date.now()
    if (opts.live) {
      // Живой заголовок: что делается прямо сейчас и сколько идёт ход. Время тикает само,
      // перерисовка ленты для этого не нужна.
      head.innerHTML = `
        <svg class="think-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
        <svg fill="none" class="icon task-spin thought-spinner" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4A5.6 5.6 0 1 0 13.6 8"/></svg>
        <span class="work-run-title thought-title">${escapeHtml(thoughtLiveTitle(run))}</span>
        <span class="thought-elapsed">${escapeHtml(formatElapsed(Date.now() - started))}</span>
        <span class="thought-tokens"></span>
        ${diffHtml}`
      let displayedTokens = 0
      let targetTokens = 0
      const updateTokensUI = () => {
        if (targetTokens > displayedTokens) {
          const diff = targetTokens - displayedTokens
          displayedTokens += Math.max(1, Math.ceil(diff / 4))
        }
        const tokEl = box.querySelector('.thought-tokens')
        if (tokEl) tokEl.textContent = displayedTokens > 0 ? `${formatTokensCount(displayedTokens)} ${t('ток.')}` : ''
      }
      const timer = setInterval(() => {
        if (!box.isConnected) { clearInterval(timer); return }
        const el = box.querySelector('.thought-elapsed')
        if (el) el.textContent = formatElapsed(Date.now() - started)
        updateTokensUI()
      }, 100)
      if (typeof timer.unref === 'function') timer.unref()
      box.syncLive = (current, liveTokens) => {
        if (liveTokens != null) {
          targetTokens = Math.max(targetTokens, Number(liveTokens) || 0)
          updateTokensUI()
        }
        const title = box.querySelector('.thought-title')
        if (title) title.textContent = thoughtLiveTitle(current)
        const f = workRunFacts(current)
        const old = box.querySelector('.work-run-diff')
        const next = f.added || f.removed
          ? `<span class="rail-add">+${f.added}</span><span class="rail-del">−${f.removed}</span>` : ''
        if (old) { if (next) old.innerHTML = next; else old.remove() }
        else if (next) { const span = document.createElement('span'); span.className = 'work-run-diff'; span.innerHTML = next; head.appendChild(span) }
        // Строки внутри раскрытого хода живые: вызов закончился, команда упала, слова
        // дописались — тело пересобирается по подписи блоков, а не ждёт следующего шага.
        const body = box.querySelector('.work-run-body')
        const sig = current.map(blockRevision).join('|')
        if (body && sig !== bodySig) {
          bodySig = sig
          box.replaceChild(buildBody(current), body)
        }
      }
    } else {
      const tokenCount = facts.tokens || opts.tokens || 0
      const tokHtml = tokenCount ? `<span class="thought-tokens">${escapeHtml(formatTokensCount(tokenCount))} ${escapeHtml(t('ток.'))}</span>` : ''
      head.innerHTML = `
        <svg class="think-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
        <span class="work-run-title thought-title">${escapeHtml(thoughtSummary(run) || t('Ход работы'))}</span>
        ${tokHtml}
        ${diffHtml}`
    }
    box.appendChild(head)
    // Шаги строятся при первом раскрытии: закрытый ход стоит одной строкой, и в самом
    // большом чате владельца это разница между секундой и ничем. Слова ассистента между
    // шагами лежат в теле тихими строками.
    let bodySig = run.map(blockRevision).join('|')
    const buildBody = list => {
      const body = document.createElement('div')
      body.className = 'work-run-body'
      for (const block of list) {
        const node = blockElement(block, false)
        if (block.agent) node.dataset.agent = block.agent
        if (block.kind === 'text') node.classList.add('work-run-note')
        body.appendChild(node)
      }
      return body
    }
    const fill = () => { box.appendChild(buildBody(run)) }
    box.addEventListener('toggle', () => {
      if (opts.live && typeof opts.onToggle === 'function') opts.onToggle(box.open)
      if (!box.open || box.querySelector('.work-run-body')) return
      fill()
    })
    // Раскрытый ход (живой) строится сразу, а не по событию toggle: событие приходит
    // только после вставки в страницу, и первый кадр оставался бы пустым.
    if (box.open) fill()
    return box
  }

  // Раскладка блоков по слотам: один слот — либо одиночный блок, либо целая
  // мысль. Живая лента красит по индексам блоков, и без этого соответствия
  // сворачивание мысли сдвинуло бы все узлы и перерисовало ход целиком.
  //
  // Порог тот же, что и при перерисовке ответа: мысль из одного-двух шагов —
  // это не мысль, а сами шаги, и сворачивать их в строку с итогом незачем. Человек
  // видел бы больше обёртки, чем работы.
  // Последний слот-ход раскладки (живым может быть только он).
  function lastRunSlot(slots) {
    for (let i = slots.length - 1; i >= 0; i--) if (slots[i].kind === 'run') return slots[i]
    return null
  }

  function thoughtLayout(blocks) {
    const list = Array.isArray(blocks) ? blocks : []
    const slots = []
    const slotOf = new Array(list.length).fill(0)
    const runs = thoughtRuns(list)
    const pushOne = index => {
      slots.push({ kind: 'one', from: index, to: index })
      slotOf[index] = slots.length - 1
    }
    // Ход из трёх шагов и больше — один слот на все его шаги, даже если между ними лежат слова
    // ассистента. Слова из середины хода показываются ПОД блоком, в порядке появления: блок
    // един, а сказанное остаётся сказанным рядом с ним.
    const runOf = new Map()
    for (const run of runs) {
      // Ход с вызовом инструмента — блок с первого же шага (образец: «Выполняю команду · 9м 57с»
      // виден с начала, а не после третьего вызова). Одни размышления без вызовов сворачиваются,
      // как раньше, только от трёх: иначе у каждого ответа появлялась бы своя обёртка.
      const hasTool = run.indices.some(index => list[index].kind === 'tool')
      if (!hasTool && run.indices.length < STEP_RUN_COLLAPSE) continue
      for (const index of run.indices) runOf.set(index, run)
    }
    const deferred = []
    let active = null
    for (let i = 0; i < list.length; i++) {
      const run = runOf.get(i)
      if (run) {
        if (run.slot === undefined) {
          slots.push({ kind: 'run', from: run.from, to: run.to, indices: run.indices })
          run.slot = slots.length - 1
        }
        slotOf[i] = run.slot
        active = run
        if (i === run.to) {
          for (const index of deferred) pushOne(index)
          deferred.length = 0
          active = null
        }
        continue
      }
      if (active && i < active.to) { deferred.push(i); continue }
      pushOne(i)
    }
    return { slots, slotOf }
  }

  // Blocks are the only thing drawn. Reasoning used to be painted twice — once
  // as a wall of italics by a second painter, now deleted, and once as rows by
  // `paintBlocks` — because every chunk is filed in both places. The reader saw
  // the same thought twice while it streamed, and only the rows survived the
  // end of the turn, which looked like the text being "converted" at the finish.
  // The segments are still kept: they are what gets stored as the message's
  // reasoning. They are just not a second thing on screen.
  function updateLiveAssistantUI(pane) {
    if (!pane.assistantEl || !pane.reasoningSegments.length) return
    schedulePaint(pane)
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneMessageBlocks = api
})(typeof window === 'object' ? window : globalThis)
