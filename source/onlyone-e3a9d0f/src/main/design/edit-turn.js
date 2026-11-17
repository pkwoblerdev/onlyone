// src/main/design/edit-turn.js — правка макета из чата идёт ХОДОМ ДИЗАЙНА и
// только когда макет открыт в окне (план, 4.2 шаг 2, решение владельца от 28.09:
// «правка из чата ходом Дизайна — только при открытом окне; пути из главного
// процесса мы не заводим; если окно закрыто или макет занят, карточка пишет
// „ждёт — откроется при следующем запуске“, и сама правка не стартует»).
//
// Главный процесс правку НЕ исполняет: ни `dc_write`, ни `revisePage`, ни
// `dc_create`. Он передаёт её тому же ходу Дизайна, которым человек правит макет
// в разделе, — второй исполнитель означал бы второй набор правил и правку,
// которой нет в ленте Дизайна. Передать есть кому только пока макет открыт в
// окне, а знает об этом одно окно: оно сообщает открытый макет каналом
// `design-focus`.
//
// Оба состояния — память главного процесса: ни файла, ни записей в реестр, ни
// блокировки макета. Обещание «откроется при следующем запуске» относится к
// этому запуску окна, а очередь хода через TaskManager — отдельный пункт плана.
//
// Модуль чистый, как `design/task.js`: ни Electron, ни файловой системы, ни
// хранилища дизайнов. Права ровно те, что дают внедрённые зависимости:
// `designs` — читать реестр, `send` — отдать событие окну. Состояние живёт в
// замыкании `createDesignEditTurn()`, а не в модуле: второй экземпляр обязан
// видеть свой профиль, а не общий на процесс список.

// Пределы входа — те же, что у движка задачи: две границы разошлись бы словами
// отказа, и модель получала бы разное на один и тот же текст.
const MAX_INSTRUCTION_CHARS = 4000
const MAX_BRIEF_CHARS = 20000
const MAX_TOPIC_CHARS = 120

// Идентификатор макета — имя папки (тот же алфавит, что у `DesignStore.folder`).
const DESIGN_ID = /^[A-Za-z0-9_-]{1,64}$/

// Потолок ожидания на один макет: правок из переписки может быть больше, чем
// окно успеет открыть макет, а расти в памяти бесконечно они не должны.
const HOLD_LIMIT = 8

// Почему правка не пошла. Оба случая — про одно и то же обещание, но слова
// разные нарочно: сказать «макет не открыт» про занятый макет значило бы
// соврать человеку и модели.
const WAIT_NOT_OPEN = 'Правка не стартовала: макет не открыт в окне, а правку из чата делает только ход ' +
  'Дизайна. Она ждёт — откроется при следующем запуске этого макета.'
const WAIT_BUSY = 'Правка не стартовала: ход этого макета уже идёт, править поверх него нельзя. ' +
  'Она ждёт — откроется при следующем запуске этого макета.'

function createDesignEditTurn (deps = {}) {
  const { designs, send } = deps

  // Что открыто в окне: id адресаата → { designId, sender }. Ключ по окну, а не
  // одно общее значение: событие правки принадлежит тому, кто о фокусе сказал.
  const focusBySender = new Map()
  // Что ждёт своего макета: designId → [правка, ...]
  const held = new Map()
  // Чей ход сейчас идёт: designId → Set(requestId)
  const running = new Map()
  // Какие правки ушли в ход Дизайна и ещё не отчитались: requestId → edit.
  // Без этой записи карточка остаётся в «идёт правка» навсегда: окно делает
  // правку своим ходом, а главному процессу о его конце раньше сказать было нечем.
  const pending = new Map()

  const clip = value => Array.from(String(value ?? '').trim()).slice(0, MAX_INSTRUCTION_CHARS).join('').trim()

  // Мёртвый адресат снимается здесь же: после закрытия окна его запись осталась
  // бы «открытым макетом» навсегда, и правка ушла бы в никуда вместо ожидания.
  function openLayout (designId) {
    if (!designId) return false
    for (const [key, item] of focusBySender) {
      if (item.sender?.isDestroyed?.()) { focusBySender.delete(key); continue }
      if (item.designId === designId) return true
    }
    return false
  }

  // Занятость считается по макету, а не по ходу: ответить надо именно «этот
  // макет сейчас занят», и неважно, чей ход его держит.
  function busyLayout (designId) {
    const turns = running.get(String(designId))
    return Boolean(turns && turns.size)
  }

  // Окно сказало, какой макет у него открыт. Пустая строка — «ушёл с макета».
  function focus (event, designId) {
    const senderId = event?.sender?.id
    const key = senderId == null ? 'window' : String(senderId)
    const layout = String(designId || '').trim()
    if (layout) focusBySender.set(key, { designId: layout, sender: event?.sender })
    else focusBySender.delete(key)
    return layout
  }

  function turnStart (designId, requestId) {
    if (!designId) return
    const key = String(designId)
    if (!running.has(key)) running.set(key, new Set())
    running.get(key).add(String(requestId))
  }

  function turnEnd (designId, requestId) {
    const turns = running.get(String(designId || ''))
    if (!turns) return
    turns.delete(String(requestId))
    if (!turns.size) running.delete(String(designId || ''))
  }

  // Нагрузка события «правка из чата в ход Дизайна» — одна на оба пути (сразу и
  // из ожидания): два места записали бы две разные формы, а окно понимает одну.
  function payloadOf (edit) {
    return {
      requestId: edit.requestId,
      chatId: edit.chatId,
      designId: edit.designId,
      component: edit.component,
      instruction: edit.instruction
    }
  }

  // Слова о начавшейся правке: тот же смысл, что карточка подписывает своим
  // состоянием, но одним предложением — его читает модель и человек в ленте.
  function turnWords (edit) {
    return `Ход Дизайна макета «${edit.component}» делает правку «${edit.instruction.slice(0, 160)}» ` +
      'и выпустит новую версию того же макета.'
  }

  // Что человек видит в ленте чата: `turn-edit` — правку делает ход Дизайна,
  // `waiting` — она ждёт, пока окно откроет макет. Номера версии здесь нет
  // нарочно: её выпустит окно, и назвать её заранее значило бы соврать.
  function say (event, edit, status, extra = {}) {
    if (typeof send !== 'function') return
    send(event, 'design-task-event', {
      requestId: edit.requestId,
      chatId: edit.chatId || null,
      taskId: edit.requestId,
      designId: edit.designId || null,
      component: edit.component || null,
      version: Number.isFinite(Number(extra.version)) ? Number(extra.version) : null,
      status,
      stage: extra.stage || (status === 'waiting' ? 'ожидание' : 'ход Дизайна'),
      message: extra.message || '',
      brief: edit.brief || '',
      topic: edit.topic || '',
      ...(extra.error ? { error: extra.error } : {})
    })
  }

  // Отложить правку до следующего открытия макета. Та же правка того же хода
  // повторно не кладётся: модель могла позвать инструмент дважды одним текстом,
  // а исполнить окно обязано один раз.
  function hold (edit) {
    const list = held.get(edit.designId) || []
    if (list.some(item => item.requestId === edit.requestId)) return
    list.push(edit)
    held.set(edit.designId, list.slice(-HOLD_LIMIT))
  }

  // Снять одну правку с ожидания и отдать её ходу Дизайна. Запись убирается из
  // памяти ДО отправки: иначе второе сообщение о том же фокусе повторило бы
  // правку, а обещано ей уйти ровно один раз.
  function release (event, designId) {
    if (!openLayout(designId) || busyLayout(designId)) return null
    const list = held.get(String(designId))
    if (!list || !list.length) return null
    const edit = list.shift()
    if (!list.length) held.delete(String(designId))
    if (typeof send === 'function') {
      send(event, 'design-chat-edit', payloadOf(edit))
      say(event, edit, 'turn-edit', { message: turnWords(edit) })
    }
    start(edit)
    return edit
  }

  // Правка ушла ходу Дизайна: заводим её в список не закрытых. Запись — память
  // главного процесса, как и остальное состояние модуля: ни файла, ни строки в
  // реестре.
  function start (edit) {
    if (!edit || !edit.requestId) return
    pending.set(String(edit.requestId), edit)
  }

  // Номер версии принадлежит реестру: ход Дизайна выпустил её там, а окно могло
  // её ещё не знать. Названное окном число берём только когда оно настоящее.
  async function versionOf (edit, reported) {
    const given = Number(reported)
    if (Number.isFinite(given) && given > 0) return given
    try {
      const entries = await designs.list()
      const entry = (Array.isArray(entries) ? entries : []).find(item => item && item.id === edit.designId)
      const stored = Number(entry && entry.version)
      return Number.isFinite(stored) && stored > 0 ? stored : null
    } catch (error) {
      return null
    }
  }

  // Окно сказало, что ход, принявший правку, кончился. Карточка обязана дойти до
  // «готово» с номером версии — иначе она висит в работе после конца работы.
  // Правка снимается ДО отправки: второй отчёт о том же id не имеет права
  // переставить карточку на другую версию.
  async function settle (event, payload = {}) {
    const requestId = String(payload.requestId || '')
    const edit = pending.get(requestId)
    if (!edit) return { ok: true, known: false }
    pending.delete(requestId)
    const version = await versionOf(edit, payload.version)
    const words = version == null
      ? `Ход Дизайна закончил правку макета «${edit.component}» — номер версии не назван.`
      : `Готово: макет «${edit.component}», версия ${version}.`
    say(event, edit, 'ready', { version, stage: 'готово', message: words })
    return { ok: true, known: true, version }
  }

  // Проверка входа и права на правку — до единого события окну: отказ тоже идёт
  // в карточку, и модель обязана прочитать то же, что человек. Правила те же,
  // что у движка задачи: чужой макет из этого разговора не правится.
  async function prepare (input) {
    const designId = String(input.designId || '').trim()
    const brief = String(input.brief ?? '').trim()
    const topic = String(input.topic ?? '').trim()
    const given = input.instruction
    const edit = {
      requestId: String(input.requestId || ''), chatId: input.chatId || '', designId,
      component: '', instruction: '', brief, topic
    }
    if (!DESIGN_ID.test(designId)) {
      return { edit, error: 'Идентификатор дизайна должен быть именем папки: буквы, цифры, «-» и «_», не длиннее 64 знаков.' }
    }
    if (given !== undefined && given !== null && typeof given !== 'string') {
      return { edit, error: 'Инструкция правки должна быть текстом.' }
    }
    edit.instruction = clip(given) || clip(brief)
    if (!edit.instruction) return { edit, error: 'Не сказано, что именно править в макете: инструкция пустая.' }
    if (!input.chatId) {
      return { edit, error: 'Правка не привязана к разговору: без chatId макет некому защищать от чужой правки.' }
    }
    if (brief.length > MAX_BRIEF_CHARS) {
      return { edit, error: `Бриф длиннее предела: ${brief.length} знаков, максимум ${MAX_BRIEF_CHARS} — сократите описание.` }
    }
    if (topic.length > MAX_TOPIC_CHARS) {
      return { edit, error: `Тема длиннее предела: ${topic.length} знаков, максимум ${MAX_TOPIC_CHARS}.` }
    }
    let entries
    try {
      entries = await designs.list()
    } catch (error) {
      // Реестр — единственный свидетель того, что макет принадлежит этому
      // разговору. Не сумев его прочитать, право на правку не отдают.
      return { edit, error: `Реестр дизайнов не читается: ${String(error?.message || error)}` }
    }
    if (!Array.isArray(entries)) return { edit, error: 'Реестр дизайнов вернул не список — кому принадлежит макет, не понять.' }
    const entry = entries.find(item => item && item.id === designId)
    if (!entry) return { edit, error: `Дизайна «${designId}» нет в реестре — править нечего.` }
    const owner = typeof entry.chatId === 'string' ? entry.chatId.trim() : ''
    if (!owner) {
      return { edit, error: `Дизайн «${designId}» не привязан к разговору, а значит правку из чата никто не просил.` }
    }
    if (owner !== input.chatId) {
      return { edit, error: `Дизайн «${designId}» ведёт другой разговор — правка из этого не разрешена.` }
    }
    // Имя страницы берётся из реестра: правка обязана попасть ровно в тот же
    // файл, а не в «первый попавшийся» — хранилище здесь не трогается вовсе.
    edit.component = typeof entry.component === 'string' ? entry.component.trim() : ''
    if (!edit.component) {
      return { edit, error: `В реестре нет имени страницы макета «${designId}» — окну нечего править.` }
    }
    return { edit }
  }

  return {
    openLayout, busyLayout, focus, turnStart, turnEnd, payloadOf, turnWords, say, hold, release, prepare,
    start, settle,
    // Сколько правок ждут этот макет: нужно ответу на `design-focus`, чтобы
    // окно и человек видели — обещание не забыто.
    waitingCount: designId => (held.get(String(designId || '')) || []).length,
    // Сколько правок ушли в ход Дизайна и ещё не отчитались.
    pendingCount: () => pending.size,
    words: { notOpen: WAIT_NOT_OPEN, busy: WAIT_BUSY }
  }
}

module.exports = { createDesignEditTurn, MAX_INSTRUCTION_CHARS, WAIT_NOT_OPEN, WAIT_BUSY }
