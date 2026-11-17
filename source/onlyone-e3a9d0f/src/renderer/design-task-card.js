/* Карточка задачи Дизайна в ленте чата (план, этап 4 «Чат + Дизайн»).
 *
 * Модель зовёт инструмент `design_task`, главный процесс собирает макет
 * настоящими `dc_*` и на каждом шаге шлёт в окно прогресс. Здесь из этого
 * прогресса растёт одна карточка: «идёт работа» — живой кадр-превью готового
 * макета — отказ с причиной; и кнопка «Открыть в Дизайне», чтобы превью не было
 * тупиком.
 *
 * Отдельный файл потому, что у карточки своё состояние и своя судьба после
 * перерисовки ленты. Правило «один taskId — один и тот же узел» можно держать
 * только там, где сам узел и хранится: поиск по ленте даёт вторую карточку
 * ровно тогда, когда первая уже нарисована, а это самый частый случай — ход
 * идёт, лента перерисовывается, события продолжают приходить.
 *
 * Чего здесь сознательно нет:
 *  - подписки на `message` и любого чтения из кадра. Кадр открыт без
 *    `allow-same-origin` не для красоты: макет — текст модели, и окно не имеет
 *    права в него заглядывать; подписалась бы — получала бы сообщения чужой
 *    страницы как свои;
 *  - обращения к каналу main → renderer иначе как через `deps.electronAPI`:
 *    узловой прогон подменяет именно `deps`, и глобальный адрес превратил бы
 *    проверку в бумагу;
 *  - нативных подсказок: в проекте подпись носится в `data-tooltip`
 *    (`tests/test-tooltips.cjs`), системный всплывающий текст поверху не появляется.
 */
(function (root) {
  'use strict'

  const RUNNING = 'running'
  const READY = 'ready'
  const FAILED = 'failed'
  // Правка макета из чата (план, 4.2 шаг 2): её делает не главный процесс, а
  // ход Дизайна того же макета — и только когда макет открыт в окне. Два новых
  // состояния карточки ровно об этом: `turn-edit` — правку уже ведёт ход
  // Дизайна, `waiting` — она ждёт, пока окно откроет макет. Молчать под одним
  // из них значит врать: сборка нового макета и отложенная правка выглядят для
  // человека по-разному.
  const TURN_EDIT = 'turn-edit'
  const WAITING = 'waiting'
  const KNOWN_STATUSES = [RUNNING, READY, FAILED, TURN_EDIT, WAITING]

  // Лента по умолчанию — основная. В окне их три (`messagesList`,
  // `splitMessagesList`, `designMessages`), и кому из них принадлежит задача,
  // решает ведущий: он знает, какой ход сейчас рисует.
  const MAIN_FEED = 'messagesList'

  // Бриф в карточке — напоминание о просьбе, а не пересказ: движок задачи
  // принимает до двадцати тысяч знаков, и разворачивать из них в ленте
  // простыню никто не просил.
  const BRIEF_CHARS = 400

  function create(deps) {
    const { $, t, escapeHtml, electronAPI, document, openDesign } = deps

    // taskId → карточка. Ключ именно taskId: он приходит в каждом событии
    // прогресса и в результате инструмента, поэтому по нему правка версии
    // находит прежний узел, а не заводит второй.
    const cards = new Map()
    let unsubscribe = null
    let bound = false

    const text = value => (value == null ? '' : String(value))
    const trimmed = value => text(value).trim()

    // Знаки, а не байты: слайс по index режет русское слово на середине, и в
    // ленте остаётся обрывок вместо окончания.
    function clip(value, limit) {
      const chars = Array.from(trimmed(value))
      return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit).join('').trimEnd()}…`
    }

    function normalize(payload) {
      const source = payload && typeof payload === 'object' ? payload : {}
      const status = trimmed(source.status).toLowerCase()
      const version = Number(source.version)
      return {
        chatId: trimmed(source.chatId),
        taskId: trimmed(source.taskId),
        designId: trimmed(source.designId),
        component: trimmed(source.component),
        version: Number.isFinite(version) && version > 0 ? version : null,
        // Незнакомый статус — обычная работа, а не что-то из списка ниже:
        // карточка не имеет права показать «готово» или «ждёт» на слове, которого
        // модуль не знает.
        status: KNOWN_STATUSES.includes(status) ? status : RUNNING,
        error: trimmed(source.error),
        message: trimmed(source.message),
        stage: trimmed(source.stage),
        brief: trimmed(source.brief)
      }
    }

    // --- к какой ленте относится событие -------------------------------------
    //
    // Способов узнать текущий диалог три, и окно вправе дать любой: getter,
    // готовое значение или метка на самой ленте. Порядок — от живого getterа:
    // карточка обязана реагировать на переключение диалога, а не помнить тот,
    // что был открыт при создании модуля.
    function currentChatId() {
      if (typeof deps.getChatId === 'function') {
        try {
          const value = trimmed(deps.getChatId())
          if (value) return value
        } catch { /* getter из окна мог оказаться временным — пробуем дальше */ }
      }
      const given = trimmed(deps.currentChatId)
      if (given) return given
      // Последний способ — метка на самой ленте: её вешает харнесс узлового
      // прогона, и окно может повесить так же, не передавая в модуль ничего.
      const list = mainFeed()
      const mark = list && typeof list.getAttribute === 'function' ? list.getAttribute('data-chat-id') : ''
      return trimmed(mark)
    }

    function mainFeed() {
      const explicit = deps.feed
      if (explicit && explicit.nodeType === 1) return explicit
      if (typeof deps.getFeed === 'function') {
        const node = deps.getFeed()
        if (node && node.nodeType === 1) return node
      }
      const found = typeof $ === 'function' ? $(MAIN_FEED) : null
      return found && found.nodeType === 1 ? found : document.body
    }

    // Лента разговора по его метке. Ищутся только ленты с классом
    // `messages-list`, а не любой узел с `data-chat-id`: строки бокового списка
    // диалогов помечены своей перепиской точно так же, и карточка, уехавшая в
    // строку сайдбара, исчезла бы из вида без единой ошибки.
    function feedByChatId(chatId) {
      if (!chatId || typeof document.querySelectorAll !== 'function') return null
      for (const node of document.querySelectorAll('.messages-list[data-chat-id]')) {
        if (trimmed(node.getAttribute('data-chat-id')) === chatId) return node
      }
      return null
    }

    // Своё ли событие. Не зная, какой диалог открыт, чужим его назвать нельзя:
    // отказ молча спрятал бы все карточки, и выглядит это как сломанный канал.
    function owns(event) {
      const current = currentChatId()
      return !current || !event.chatId || event.chatId === current
    }

    function feedFor(event) {
      if (owns(event)) return feedByChatId(event.chatId || currentChatId()) || mainFeed()
      // Чужая переписка: либо её собственная лента по эту же стену окна, либо
      // ничего. Нарисовать чужой макет в текущем диалоге — значит соврать
      // человеку, что это его работа.
      return feedByChatId(event.chatId)
    }

    // --- тексты состояний ------------------------------------------------------
    //
    // Отказ называется отказом словами, а не только текстом ошибки: карточка,
    // у которой просто пропало превью, читается как «всё хорошо, только пусто»,
    // и человек узнаёт о провале позже, чем мог бы.

    function statusLine(event) {
      if (event.status === FAILED) return t('Не удалось выполнить задачу Дизайна')
      if (event.status === READY) {
        return event.designId ? t('Макет готов') : t('Готово, но макет в задаче не назван')
      }
      // Правка из чата (план, 4.2 шаг 2): её делает не главный процесс, а ход
      // Дизайна того же макета. Сборка нового макета и правка существующего —
      // разные работы, и подписаны должны быть разными словами: под «идёт
      // работа, ждём макет» человек ждал бы новый макет там, где правится
      // прежний.
      if (event.status === TURN_EDIT) return t('Правка идёт ходом Дизайна')
      // Обещание то же, что у главного процесса, и словами, и смыслом: правка
      // не начата, а не потеряна — она дождётся, когда окно откроет макет.
      if (event.status === WAITING) return t('Правка ждёт — откроется при следующем запуске')
      return t('Дизайн: идёт работа, ждём макет')
    }

    // Что говорит движок задачи (`stage`/`message`) — отдельной строкой и только
    // в работе: на готовом и на отказе человек смотрит результат, а не лог. У
    // двух новых состояний строка нужна: она объясняет, ЧЕГО именно ждёт правка
    // и какой ход её делает.
    function stageLine(event) {
      if (event.status !== RUNNING && event.status !== TURN_EDIT && event.status !== WAITING) return ''
      return event.message || event.stage || ''
    }

    function errorLine(event) {
      if (event.status !== FAILED) return ''
      // Причина показывается текстом рантайма целиком: пересказ своими словами
      // спрятал бы то, что именно не прошло.
      return event.error || event.message || t('Причина не названа')
    }

    function versionLine(event) {
      return event.version == null ? '' : t('версия %s', event.version)
    }

    // Адрес кадра — той же формы, что у большого превью раздела «Дизайн»
    // (`renderDesignPreview`): `onecode-design://<макет>/<файл>`. Идентификатор
    // макета не кодируется — это имя папки, и схема для стандартного протокола
    // ждёт его дословно. Имя компонента, наоборот, текст из темы, модель пишет
    // его и по-русски, — поэтому `encodeURIComponent`.
    function frameSrc(event) {
      const component = encodeURIComponent(event.component)
      // «Свежим» параметром идёт номер версии, а не `Date.now()`: время
      // менялось бы на каждом событии прогресса и обрывало загрузку превью
      // посреди работы, а версия у новой правки обязана расти.
      const stamp = event.version == null ? String(Date.now()) : String(event.version)
      return `onecode-design://${event.designId}/${component}?v=${stamp}`
    }

    // --- карточка --------------------------------------------------------------

    // Служебный текст карточки — через `textContent`: метки и причины пишет
    // модуль, размечать их нечему.
    function putText(node, value) {
      if (!node) return
      const next = value == null ? '' : String(value)
      if (node.textContent !== next) node.textContent = next
    }

    // Текст модели входит в ленту единственным путём — `escapeHtml` + innerHTML.
    // Записать его `textContent` было бы строже, но тогда экранирование
    // осталось бы декорацией: снять его стало бы нечем проверить, а оно и есть
    // та граница, после которой `<img src=x onerror=…>` из брифа перестаёт быть
    // просьбой человека и становится узлом в его окне.
    function putModelText(record, field, node, value) {
      if (!node || record.shown[field] === value) return
      record.shown[field] = value
      node.innerHTML = escapeHtml(value)
    }

    function putHidden(node, hidden) {
      if (!node) return
      if (node.hidden !== hidden) node.hidden = hidden
    }

    function buildCard(event) {
      const card = document.createElement('div')
      // База — `.approval-card`: та же ширина, тень и отступы, что у прочих
      // карточек ленты. Свой слой оформления означал бы две ленты, расходящиеся
      // на глаз.
      card.className = 'approval-card kind-design-task'
      card.dataset.taskId = event.taskId
      card.innerHTML = `
        <div class="approval-head design-task-head">
          <span class="approval-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M3 3h18v18H3z"/><path d="M3 9h18M9 9v12"/></svg>
          </span>
          <div class="approval-headings design-task-headings">
            <div class="approval-action design-task-status" aria-live="polite"></div>
            <div class="design-task-brief"></div>
            <div class="design-task-stage" hidden></div>
            <div class="design-task-error" hidden></div>
          </div>
          <div class="approval-meta design-task-version" hidden></div>
        </div>
        <div class="design-task-preview" hidden></div>
        <div class="approval-actions design-task-actions" hidden>
          <span class="approval-verdict design-task-verdict"></span>
          <button class="approval-allow design-task-open" type="button"
            aria-label="${escapeHtml(t('Открыть этот макет в разделе «Дизайн»'))}"
            data-tooltip="${escapeHtml(t('Перейти к макету и править его средствами Дизайна'))}">${escapeHtml(t('Открыть в Дизайне'))}</button>
        </div>`
      return {
        card,
        statusEl: card.querySelector('.design-task-status'),
        briefEl: card.querySelector('.design-task-brief'),
        stageEl: card.querySelector('.design-task-stage'),
        errorEl: card.querySelector('.design-task-error'),
        versionEl: card.querySelector('.design-task-version'),
        previewEl: card.querySelector('.design-task-preview'),
        actionsEl: card.querySelector('.design-task-actions'),
        verdictEl: card.querySelector('.design-task-verdict'),
        openEl: card.querySelector('.design-task-open'),
        frame: null,
        shownSrc: '',
        // Второй кадр: грузит новую версию, спрятавшись, пока не дойдёт до
        // своего `load`. Пока он есть, на экране стоит `frame` — прежний,
        // загруженный (Н96).
        pending: null,
        pendingSrc: '',
        shown: { brief: '', stage: '', error: '', verdict: '' },
        designId: '',
        lastEvent: null,
        feed: null,
        rev: 0
      }
    }

    // Кадр появляется только у готового макета и уходит из DOM на всех прочих
    // состояниях: пустой прямоугольник неотличим от сломанного превью. Спрятанным
    // кадр стоит ровно одно время — пока грузит новую версию; как только он
    // докачался, он показывается, а прежний снимается, и лишнего узла, который
    // грузил бы отброшенную страницу молча, в ленте не остаётся.
    //
    // Н96 (аудит 28.09, решение владельца от 29.09). Прежняя сборка на `ready`
    // снимала живой `<iframe>` и тут же вставляла новый с новым адресом, — и до
    // того, как новый документ догрузился, человек (и снимок прогона) видел миг
    // пустого прямоугольника. Теперь правил две:
    //  - версия не сменилась — превью не перезапускается: узел, его адрес и
    //    число созданных кадров остаются как были;
    //  - сменилась — новая версия грузится ВТОРЫМ узлом, спрятанным, а прежний
    //    остаётся единственным показанным; подмена происходит по событию `load`
    //    нового узла, и только в нём: старый кадр снимается в том же цикле, что
    //    и показывается новый, поэтому пустого места между ними не бывает.
    // Пока `load` не пришёл (медленный кадр) или пришёл `error`, на экране стоит
    // прежнее загруженное превью — хуже задержавшаяся старая версия, чем миг
    // пустоты. Подписка на `load` висит на КАЖДОМ кадре, в том числе на первом:
    // без неё прогон не вправе считать документ загруженным (`artifact-panel.js`
    // делает так же). Содержимое кадра при этом не читается — событие говорит
    // только «докачалось», и `message` модуль по-прежнему не слушает.
    function newFrame(src, onLoad) {
      const frame = document.createElement('iframe')
      frame.className = 'design-task-frame'
      // Ровно `allow-scripts` — как у большого кадра (`index.html:728`).
      // `allow-same-origin` вернул бы макет, сочинённый моделью, в origin окна:
      // доступ к ленте, к хранилищу и ко всему, что в нём лежит.
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('aria-label', t('Превью макета из переписки'))
      if (typeof onLoad === 'function') frame.addEventListener('load', onLoad, { once: true })
      frame.setAttribute('src', src)
      return frame
    }

    // «Спрятан» — признаками, которые видит и человек, и оба прогона:
    // `visibility:hidden` и `opacity:0` вписываются в `style`, а не в свой класс
    // (свой класс харнесс узлового прогона не увидит: ему нужны `hidden`,
    // `display:none`, `visibility:hidden` или `opacity:0`). `display:none` и
    // атрибут `hidden` здесь сознательно не берём: они снимают кадр с отрисовки,
    // а докачиваться обязан именно он. Места второй кадр не занимает: у превью
    // фиксированная высота и `overflow:hidden` (`.design-task-preview`), поэтому
    // скрытый кадр лежит под сгибом своего контейнера и ленту не двигает.
    function markFrameHidden(frame, isHidden) {
      if (!frame || !frame.style) return
      frame.style.visibility = isHidden ? 'hidden' : ''
      frame.style.opacity = isHidden ? '0' : ''
    }

    // Подмена по загрузке. Порядок ровно такой, чтобы на экране не было ни
    // одного мига без превью: новый кадр показывается и прежний снимается двумя
    // действиями одного и того же цикла — отрисовка между ними не успевает
    // вставать.
    function onFrameLoaded(record, frame, src) {
      // Смена версии могла прийти, пока этот кадр грузился: он устарел, и
      // показывать его смысла нет — за него отвечает уже другой узел.
      if (record.pending !== frame) return
      const previous = record.frame
      record.pending = null
      record.pendingSrc = ''
      markFrameHidden(frame, false)
      record.frame = frame
      record.shownSrc = src
      if (previous) previous.remove()
    }

    function dropPending(record) {
      if (!record.pending) return
      const stale = record.pending
      record.pending = null
      record.pendingSrc = ''
      stale.remove()
    }

    function showFrame(record, event) {
      const preview = record.previewEl
      // Ни макета, ни файла: показывать нечего, и адрес с пустым именем файла
      // протокол не разберёт. Карточка остаётся текстовой — честнее пустого
      // кадра, за которым не стоит страница. Убираются оба узла, включая тот,
      // что ещё грузился: спрятанный кадр остался бы грузить выброшенную
      // страницу молча.
      const src = event.status === READY && event.designId && event.component ? frameSrc(event) : ''
      if (!src) {
        dropPending(record)
        if (record.frame) record.frame.remove()
        record.frame = null
        record.shownSrc = ''
        putHidden(preview, true)
        return
      }
      putHidden(preview, false)
      if (!record.frame) {
        // На экране пусто: прятать новый кадр не от чего, и держать его скрытым
        // значило бы показать пустое место вместо прежнего превью. Первый кадр
        // встаёт показанным сразу, а подписка на `load` нужна ему затем, чтобы
        // прогон умел мерить загруженность документа по тому же признаку, по
        // которому она мерится у подмены.
        const frame = newFrame(src, () => onFrameLoaded(record, frame, src))
        record.frame = frame
        record.shownSrc = src
        preview.appendChild(frame)
        return
      }
      // Та же версия, что уже на экране, или та, что уже грузится: ничего не
      // трогается. Именно здесь прежний код обрывал живую загрузку, пересылая
      // адрес поверх стоящего узла, — отсюда и миг из Н96.
      if (record.shownSrc === src || record.pendingSrc === src) return
      // Смена версии: прежний кадр остаётся единственным показанным, новая
      // версия грузится вторым, спрятанным узлом, и подменит его по своему
      // `load`. Прежний недогруженный второй кадр (если версия пришла раньше,
      // чем он докачался) снят: он грузит уже отвергнутую страницу.
      dropPending(record)
      const frame = newFrame(src, () => onFrameLoaded(record, frame, src))
      record.pending = frame
      record.pendingSrc = src
      markFrameHidden(frame, true)
      preview.appendChild(frame)
    }

    function paint(record, event) {
      // Что написано модулем — метка состояния и номер версии — идёт обычным
      // текстом. Всё чужое — бриф, слова движка, причина отказа, имя файла —
      // только экранированным: один признак для всего, что пришло не отсюда.
      putText(record.statusEl, statusLine(event))
      // Ожидание читается не только текстом: приглушённая подпись нужна затем,
      // чтобы «ждёт» и «идёт работа» различались одним взглядом на ленту, а не
      // чтением строки.
      record.statusEl?.classList.toggle('design-task-waiting', event.status === WAITING)
      // Бриф приходит с первым же событием, а правка версии его не несёт:
      // пустая строка здесь означает «не сказали», а не «стёрлось».
      if (event.brief) putModelText(record, 'brief', record.briefEl, clip(event.brief, BRIEF_CHARS))
      const stage = stageLine(event)
      putModelText(record, 'stage', record.stageEl, stage)
      putHidden(record.stageEl, !stage)
      const reason = errorLine(event)
      putModelText(record, 'error', record.errorEl, reason)
      putHidden(record.errorEl, !reason)
      const version = versionLine(event)
      putText(record.versionEl, version)
      putHidden(record.versionEl, !version)
      record.designId = event.designId
      showFrame(record, event)
      // Имя файла, который написал движок, — рядом с кнопкой: «макет готов» без
      // того, что именно готово, отправляет в раздел гадать.
      const verdict = event.status === READY && event.component ? event.component : ''
      putModelText(record, 'verdict', record.verdictEl, verdict)
      // Переход имеет смысл только над тем, что уже можно открыть: `design_id`
      // движок знает с первой секунды (проект заводится до записи страницы), но
      // до готовности кликнуть некуда — рабочее место открылось бы пустым.
      const openable = event.status === READY && Boolean(event.designId)
      putHidden(record.actionsEl, !openable)
      if (record.openEl) record.openEl.disabled = !openable
    }

    // Возврат в ленту. Перерисовка сообщений сносит содержимое ленты целиком,
    // и карточка обязана вернуться тем же узлом: новый узел отбрасывает скролл
    // и фокус, а живой кадр загружался бы заново на каждую перерисовку. Отсюда
    // и проверка `parentNode` — переставлять зря стоит столько же, сколько
    // выбрасывать.
    function ensureInFeed(record, feed) {
      if (record.card.parentNode !== feed) feed.appendChild(record.card)
    }

    function upsert(event, feed) {
      let record = cards.get(event.taskId)
      if (!record) {
        record = buildCard(event)
        cards.set(event.taskId, record)
        // `openEl` тут есть всегда: шаблон статический. Проверка — не для
        // окна, а для того, чтобы модуль в принципе не умел падать посреди
        // отрисовки: он вызывается из callback'а канала, и исключение здесь
        // стоило бы потерянного хода, а не стек-трейса.
        record.openEl?.addEventListener('click', click => {
          if (click && typeof click.preventDefault === 'function') click.preventDefault()
          const designId = record.designId
          if (!designId || typeof openDesign !== 'function') return
          const opened = openDesign(designId)
          // Открытие макета — обещание окна; его отказ не должен оставлять
          // непойманный промис в консоли.
          if (opened && typeof opened.catch === 'function') opened.catch(() => {})
        })
      }
      record.lastEvent = event
      record.feed = feed
      paint(record, event)
      ensureInFeed(record, feed)
      // Подпись обновления ставится после того, как карточка перестроена и
      // вернулась в ленту: она означает «показано», а не «намереваемся».
      record.rev += 1
      record.card.dataset.cardRev = String(record.rev)
      return record.card
    }

    // Возврат карточек после перерисовки ленты: `renderMessages` сносит
    // содержимое списка целиком, а просить ведущего хранить копию каждого
    // события значит напрашиваться на то, что копия разойдётся с оригиналом.
    // Раз узел помнит своё событие и свою ленту, он может вернуться сам.
    function redrawTaskCards() {
      let back = 0
      for (const record of cards.values()) {
        const event = record.lastEvent
        if (!event) continue
        // Лента запоминается (в разделённом окне их две), но только пока
        // событие остаётся своим: после переключения диалога чужую карточку
        // возвращать некуда.
        if (!owns(event)) continue
        upsert(event, record.feed || feedFor(event))
        back += 1
      }
      return back
    }

    function renderTaskCard(payload, feed) {
      const event = normalize(payload)
      // Задача без имени нечем обновлять: правка версии ищет карточку по
      // taskId, а без него остался бы узел, который ни к чему не привязан.
      if (!event.taskId) return null
      const target = feed && feed.nodeType === 1 ? feed : feedFor(event)
      if (!target) return null
      return upsert(event, target)
    }

    function updateTaskCard(payload) {
      // Тот же путь, что у отрисовки: событие могло прийти раньше, чем ведущий
      // позвал карточку впервые, и падать с «обновлять нечего» означало терять
      // прогресс задачи.
      return renderTaskCard(payload)
    }

    function onDesignTaskEvent(payload) {
      return renderTaskCard(payload)
    }

    function clearTaskCards() {
      for (const record of cards.values()) record.card.remove()
      cards.clear()
    }

    // Подписка на канал — отдельным шагом, а не внутри `create()`: окно создаёт
    // модуль один раз, но делает это тогда, когда диалог уже известен.
    function bind() {
      if (bound) return unsubscribe
      if (!electronAPI || typeof electronAPI.onDesignTaskEvent !== 'function') return null
      bound = true
      unsubscribe = electronAPI.onDesignTaskEvent(payload => onDesignTaskEvent(payload))
      return unsubscribe
    }

    function dispose() {
      if (typeof unsubscribe === 'function') unsubscribe()
      unsubscribe = null
      bound = false
      clearTaskCards()
    }

    return Object.freeze({
      renderTaskCard, updateTaskCard, onDesignTaskEvent, clearTaskCards,
      redrawTaskCards,
      designTaskCard: taskId => {
        const record = cards.get(text(taskId))
        return record ? record.card : null
      },
      bind, dispose
    })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneDesignTaskCard = api
})(typeof window === 'object' ? window : globalThis)
