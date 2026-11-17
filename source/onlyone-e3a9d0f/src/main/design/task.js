'use strict'

// Задача Дизайна из чата: бриф из обычной переписки превращается в настоящий
// макет средствами движка `dc_*` (план, этап 4).
//
// Модуль чистый — как `src/main/artifact-export.js`: ни файловой системы, ни
// процессов, ни сети, ни Electron, ни одного `require`. Всё, чем он владеет, —
// четыре внедрённые зависимости. Это не стиль, а граница прав: писать в дизайн
// может только движок `dc_*`. Обходной путь через `fs` или через `store.write`
// дал бы агенту из чата действия, которых никто не подтверждал, — удаление
// компонента, запись в чужую папку, правку мимо истории версий. Поэтому
// хранилище здесь участвует как читалка (список, входная страница, история
// версий), а писателем остаётся движок.
//
// Второй смысл модуля — порядок «записать → проверить → сказать „готово“».
// Результат уходит в карточку чата, и `ready` обязан означать, что среда
// посмотрела на отрисованную страницу: иначе человек получит «готово» на битом
// макете и узнает об этом позже, чем мог бы.
//
// Третий — привязка к разговору. Идентификатор дизайна приходит из переписки,
// где его могла написать модель, поэтому право на правку проверяется по реестру
// (в нём лежит `chatId`), а не по памяти окна: после перезапуска память окна
// пустая, а чужой проект — никуда не делся.

// Пределы входа. Модель может принести пустую строку, объект вместо текста и
// бриф на двести тысяч знаков. Всё это отсекается до единого вызова движка:
// отказ после начала работы оставил бы в папке половину макета, а в реестре —
// карточку, по которой нечего открывать.
const MAX_BRIEF_CHARS = 20000
const MAX_TOPIC_CHARS = 120
const MAX_INSTRUCTION_CHARS = 4000

// Границы текстов, которые впечатываются в страницу. Каркас режет их сам
// (заголовок 40, назначение 200, обещание 120); здесь они повторены намеренно,
// чтобы задача не оставляла в макете слово, обрезанное на середине.
const MAX_TITLE_CHARS = 40
const MAX_HEADLINE_CHARS = 110
const MAX_PURPOSE_CHARS = 180
const MAX_REQUEST_CHARS = 400
const MAX_STORED_BRIEF_CHARS = 200
const SECTION_LIMIT = 6
const COMPONENT_NAME_LIMIT = 40

// Тот же алфавит, что у `DesignStore.folder`: идентификатор дизайна — имя папки.
const DESIGN_ID = /^[A-Za-z0-9_-]{1,64}$/
const TASK_ID_LIMIT = 64

// Имя страницы, если из темы не вытаскивается ничего пригодного.
const FALLBACK_PAGE = 'Home'

// Слово просьбы в заголовок страницы не переезжает: в брифе это обращение к
// агенту, а в макете — обещание продукта. Перечисление после двоеточия — план
// страницы, а не обещание, поэтому заголовок берётся из начала фразы.
const ASK_WORD = /^(нужен|нужна|нужно|нужны|требуется|надо|хочу|хочется|сделай|создай|сверстай|собери|разработай|давай|пожалуйста)\b[\s,]*/i

const clip = (value, limit) => {
  const chars = Array.from(String(value ?? '').trim())
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('').trimEnd()
}

// Сравнение тем: «Лендинг доставки цветов» и «лендинг — доставки цветов!» — это
// один проект, поэтому регистра и знаков препинания здесь не существует.
const normalized = value => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

// Якорь секции: буквы и цифры через дефис — в то же превращает id сам каркас.
const anchorOf = value => String(value ?? '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, MAX_TITLE_CHARS)

// Имя компонента видит человек в списке вкладок, поэтому оно из темы, а не из
// брифа и не случайное: правка обязана попасть ровно в тот же файл. Точки
// заменяются дефисом: «..» в имени означал бы переход вверх по дереву, а движок
// принимает только имя без пути.
const componentBase = topic => clip(String(topic ?? '')
  .replace(/[^\p{L}\p{N}_-]+/gu, '-')
  .replace(/-{2,}/g, '-')
  .replace(/^[-_]+|[-_.]+$/g, ''), COMPONENT_NAME_LIMIT) || FALLBACK_PAGE

const fileOf = name => /\.dc\.html$/i.test(name) ? name : `${name}.dc.html`

function randomTail (length) {
  let out = ''
  while (out.length < length) out += Math.random().toString(36).slice(2)
  return out.slice(0, length)
}

// Заголовок страницы — имя работы, а не дословная просьба: человек пишет
// «собери сайт с пальмами», а крупным кеглем на сайте должно стоять «Сайт с
// пальмами». Слово просьбы снимается и из темы, если модель принесла её так.
function headlineOf (topic) {
  const raw = String(topic || '').trim()
  let text = raw
  for (let step = 0; step < 4; step++) {
    const next = text.replace(ASK_WORD, '').trim()
    if (next === text) break
    text = next
  }
  text = text || raw
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

// Секции берутся из перечисления в брифе: «форма заказа, блок отзывов и часы
// работы» — это план страницы, и каркас обязан собрать его, а не заготовки
// «о проекте / тарифы / faq». Если перечисления нет, остаётся одна фраза; пустой
// список каркас заполняет своими разделами по умолчанию.
function planSections (brief) {
  const text = String(brief)
  const tail = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text
  const out = []
  const seen = new Set()
  for (const phrase of tail.split(/[,;\n]|\s+и\s+/i)) {
    const title = clip(phrase, MAX_TITLE_CHARS)
    const key = normalized(title)
    if (key.length < 3 || seen.has(key)) continue
    seen.add(key)
    out.push({ id: anchorOf(title), title })
    if (out.length >= SECTION_LIMIT) break
  }
  return out
}

function planPage (state) {
  return {
    name: componentBase(state.topic),
    title: clip(state.topic, MAX_TITLE_CHARS),
    purpose: clip(state.brief, MAX_PURPOSE_CHARS),
    headline: clip(headlineOf(state.topic), MAX_HEADLINE_CHARS),
    sections: planSections(state.brief)
  }
}

// Блок правки. Движок задачи — не модель и намерение не читает, поэтому честнее
// поставить просьбу в макет видимой заготовкой, чем отчитаться «сделано» над
// прежними байтами. Номер версии в тексте и в id обязателен: без него две
// одинаковые просьбы дали бы файл байт в байт, и «правка» осталась бы на бумаге.
function requestBlock (state) {
  const anchor = `pravka-${state.version}`
  const text = clip(state.request, MAX_REQUEST_CHARS)
  return [
    `<section id="${anchor}" aria-labelledby="${anchor}-heading"`,
    ` style="max-width:1120px;margin:0 auto;padding:48px 24px;box-sizing:border-box;color:inherit">`,
    `  <h2 id="${anchor}-heading" style="margin:0 0 8px;font-size:24px;line-height:1.2;font-weight:600">Правка ${state.version}</h2>`,
    `  <p style="margin:0;max-width:60ch;line-height:1.55">${escapeHtml(text)}</p>`,
    `</section>`
  ].join('\n')
}

// Правка достраивает страницу, а не пересобирает её: пересборка стёрла бы то,
// что человек успел сделать в окне Дизайна между просьбами.
//
// Вставка идёт внутрь тонированной обёртки страницы (перед подвалом), а не в
// самый конец файла: блок вне обёртки наследует фон холста, и тёмный текст на
// тёмном холсте человек не увидит — правка прошла бы проверку и пропала бы на
// глазу.
function mergeRequest (template, state) {
  const current = String(template ?? '')
  const block = requestBlock(state)
  const at = current.indexOf('<footer')
  if (at >= 0) return `${current.slice(0, at)}${block}\n${current.slice(at)}`
  return `${current.trimEnd()}\n${block}`
}

// Подстановка идёт в разметку, поэтому текст экранируется: бриф пишет модель, и
// «<img src=x onerror=…>» внутри имени не имеет права стать узлом.
function escapeText (value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Чем именно каркас заполняет свои заготовки: именем работы и первой строкой
// просьбы, а не «Название / Начать». Неизвестный токен получает то же имя работы:
// пустая кнопка хуже кнопки с не самым точным словом.
const PLACEHOLDER_VALUES = {
  brand: state => state.topic,
  action: () => 'Начать',
  about: state => clip(state.brief, MAX_PURPOSE_CHARS),
  year: () => String(new Date().getFullYear())
}

function fillPlaceholders (html, state) {
  return String(html).replace(/(\{\{|\$\{)\s*([\w.$-]+)\s*(\}\}|\})/g, (whole, open, key) => {
    const known = PLACEHOLDER_VALUES[String(key).toLowerCase()]
    const value = String(known ? known(state) : state.topic || '').trim()
    return value ? escapeText(value) : whole
  })
}

function propsFilled (state, raw) {
  let parsed = null
  try { parsed = raw ? JSON.parse(String(raw)) : null } catch { parsed = null }
  const base = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const values = {}
  for (const key of Object.keys(PLACEHOLDER_VALUES)) {
    values[key] = String(PLACEHOLDER_VALUES[key](state) || '').trim()
  }
  return JSON.stringify({ ...base, ...values })
}

function createDesignTask (deps = {}) {
  const { store, designs, runTool, notify } = deps

  // Окно могло закрыться в середине работы: прогресс — удобство, а не часть
  // результата, и отказ доставки события не имеет права переворачивать задачу.
  function say (event) {
    try {
      if (typeof notify === 'function') notify(event)
    } catch { /* слушатель отказал — задача всё равно должна вернуться */ }
  }

  const reason = error => String(error?.message || error || '').trim() || 'неизвестная причина'

  // Движок отказывает и словами (`{ success: false }`), и исключением. И то, и
  // другое превращается в текст отказа целиком: в карточке человек должен
  // прочитать то, что сказал рантайм, а не «что-то пошло не так».
  async function callTool (state, name, args) {
    let result
    try {
      result = await runTool(name, args, {
        designId: state.designId,
        id: state.designId,
        chatId: state.chatId,
        taskId: state.taskId,
        source: 'design-task'
      })
    } catch (error) {
      return { error: reason(error) }
    }
    if (!result || typeof result !== 'object') return { error: `Движок вернул не результат в ${name}.` }
    if (result.denied === true || result.success === false) {
      return { error: String(result.error || result.message || `Инструмент ${name} не выполнен.`) }
    }
    // Отсутствие `passed` провалом не считается: его нет у инструментов, которые
    // только измеряют. А явное «false» — это уже доказанный слом.
    if (name === 'dc_check' && result.passed === false) {
      return { error: `Проверка отрисованной страницы не пройдена: ${problemsOf(result)}` }
    }
    return { result }
  }

  function problemsOf (check) {
    const out = []
    const list = Array.isArray(check.problems) ? check.problems : []
    if (list.length) out.push(list.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('; '))
    if (Array.isArray(check.brokenLinks) && check.brokenLinks.length) {
      out.push(`ссылок в никуда: ${check.brokenLinks.join(', ')}`)
    }
    for (const screen of Array.isArray(check.screens) ? check.screens : []) {
      const bits = []
      if (!screen.rendered) bits.push('страница не отрисована')
      if (screen.horizontalOverflow) bits.push('горизонтальное переполнение')
      if (screen.brokenImages) bits.push(`битых картинок: ${screen.brokenImages}`)
      if (screen.pendingImages) bits.push(`не дошли картинок: ${screen.pendingImages}`)
      if (screen.unnamedControls) bits.push(`кнопок без имени: ${screen.unnamedControls}`)
      for (const line of Array.isArray(screen.errors) ? screen.errors : []) bits.push(line)
      if (bits.length) out.push(`ширина ${screen.width}: ${bits.join(', ')}`)
    }
    return out.length ? out.join(' | ') : 'среда проверки ничего не объяснила.'
  }

  function configured () {
    if (typeof runTool !== 'function') return 'Задача Дизайна не получила движок dc_* — писать в дизайн нечем.'
    if (!designs || typeof designs.list !== 'function' || typeof designs.add !== 'function' || typeof designs.update !== 'function') {
      return 'Задача Дизайна не получила реестр дизайнов — право на правку проверить нечем.'
    }
    if (!store || typeof store.list !== 'function' || typeof store.getEntry !== 'function') {
      return 'Задача Дизайна не получила хранилище дизайнов — состояние проекта не прочитать.'
    }
    return null
  }

  // Проверка входа: только типы и размеры. Про движок и про реестр здесь ничего
  // не известно намеренно: всё отвергнутое на этом шаге не создаёт ни папки
  // дизайна, ни записи в реестре.
  function validate (input, state) {
    if (typeof input.brief !== 'string' || !input.brief.trim()) {
      return 'Бриф пустой: задача обязана текстом описывать, какой макет нужен.'
    }
    if (input.brief.length > MAX_BRIEF_CHARS) {
      return `Бриф длиннее предела задачи: ${input.brief.length} знаков, максимум ${MAX_BRIEF_CHARS} — сократите описание.`
    }
    if (typeof input.topic !== 'string' || !input.topic.trim()) {
      return 'Тема пустая: она называет проект, по которому следующая правка находит этот же дизайн.'
    }
    if (input.topic.length > MAX_TOPIC_CHARS) {
      return `Тема длиннее предела: ${input.topic.length} знаков, максимум ${MAX_TOPIC_CHARS}.`
    }
    if (!state.chatId) {
      return 'Задача не привязана к разговору: без chatId дизайн некому защищать при следующей правке.'
    }
    const given = input.instruction
    if (given !== undefined && given !== null && typeof given !== 'string') {
      return 'Инструкция правки должна быть текстом.'
    }
    const instruction = typeof given === 'string' ? given.trim() : ''
    if (instruction.length > MAX_INSTRUCTION_CHARS) {
      return `Инструкция правки длиннее предела: ${instruction.length} знаков, максимум ${MAX_INSTRUCTION_CHARS}.`
    }
    if (input.designId !== undefined && input.designId !== null && input.designId !== '') {
      if (typeof input.designId !== 'string' || !DESIGN_ID.test(input.designId)) {
        return 'Идентификатор дизайна должен быть именем папки: буквы, цифры, «-» и «_», не длиннее 64 знаков.'
      }
      state.designId = input.designId
    }
    state.brief = input.brief.trim()
    state.topic = input.topic.trim()
    state.request = instruction || state.brief
    return null
  }

  // Реестр в продукте асинхронный, а в проверке — синхронный: `await` работает с
  // обеими формами, так что угадывать способ доступа нечем.
  async function readRegistry () {
    try {
      const entries = await designs.list()
      if (!Array.isArray(entries)) {
        return { error: 'Реестр дизайнов вернул не список — кому принадлежит проект, не понять.' }
      }
      return { entries }
    } catch (error) {
      // Реестр — единственный свидетель того, что дизайн принадлежит этому
      // разговору. Не сумев его прочитать, права на правку отдавать нельзя.
      return { error: `Реестр дизайнов не читается: ${reason(error)}` }
    }
  }

  // Новый дизайн или тот же проект. «Тот же» — это тот же дизайн этого
  // разговора: правка чужого была бы записью в чужую работу, а дизайн без
  // владельца в чате защищать некому.
  function findDesign (state, entries) {
    if (state.designId) {
      const found = entries.find(item => item && item.id === state.designId)
      if (!found) return { error: `Дизайна «${state.designId}» нет в реестре — править нечего.` }
      const owner = typeof found.chatId === 'string' ? found.chatId.trim() : ''
      if (!owner) {
        return { error: `Дизайн «${state.designId}» не привязан к разговору, а значит правку из чата никто не просил.` }
      }
      if (owner !== state.chatId) {
        return { error: `Дизайн «${state.designId}» ведёт другой разговор — правка из этого не разрешена.` }
      }
      return { entry: found }
    }
    // Идентификатор в переписке мог потеряться. Та же тема в том же разговоре —
    // тот же проект: второй дизайн на вторую просьбу означал бы две половинки
    // макета вместо одной версии.
    const topic = normalized(state.topic)
    const same = entries.find(item => item
      && typeof item.chatId === 'string' && item.chatId.trim() === state.chatId
      && normalized(item.name) === topic)
    return { entry: same || null }
  }

  // Компонент правки берётся из реестра; если старая запись его не хранит —
  // у хранилища-читалки. Пишет при этом всё равно движок.
  async function resolveComponent (state, entry) {
    const stored = typeof entry.component === 'string' ? entry.component.trim() : ''
    if (stored) return stored
    try {
      const page = await store.getEntry(state.designId)
      if (page) return page
      const files = await store.list(state.designId)
      return files.length ? files[0] : ''
    } catch {
      return ''
    }
  }

  async function nextVersion (state, entry) {
    const stored = Number(entry.version)
    if (Number.isFinite(stored) && stored > 0) return stored + 1
    // Записи, созданные до задачи из чата, счётчик не хранят: остаётся история
    // версий на диске. Она ограничена двадцатью, поэтому счётчик в реестре
    // точнее — но и этот честнее выдуманной единицы.
    try {
      return (await store.listVersions(state.designId, state.component)).length + 1
    } catch {
      return 1
    }
  }

  // Сборка страницы. Каркас — единственный инструмент, который делает из плана
  // целый сайт с согласованной палитрой, навигацией и адаптивом; сочинять стили
  // здесь значило бы второй раз изобретать `scaffold.js`.
  async function scaffoldPage (state) {
    const page = planPage(state)
    const made = await callTool(state, 'dc_scaffold', { kind: 'site', pages: [page] })
    if (made.error) return made
    const written = made.result.entry
      || (Array.isArray(made.result.written) && made.result.written[0])
      || (Array.isArray(made.result.components) && made.result.components[0])
      || fileOf(page.name)
    return { component: written }
  }

  // Правка: прочитать, достроить, записать тем же именем. Чтение обязательно —
  // `dc_write` заменяет файл целиком, и без прочитанных props и логики страница
  // потеряла бы и подстановки вида, и то, что в ней появилось после задачи.
  async function revisePage (state) {
    const path = state.component
    const found = await callTool(state, 'dc_read', { path })
    if (found.error) return found
    const wrote = await callTool(state, 'dc_write', {
      path,
      b_dc_html: mergeRequest(found.result.b_dc_html, state),
      c_dc_js: String(found.result.c_dc_js ?? ''),
      d_props_json: String(found.result.d_props_json ?? '')
    })
    if (wrote.error) return wrote
    return { component: wrote.result.path || path }
  }

  // Каркас отдаёт скелет: в шаблоне живут подстановки `{{ brand }}`,
  // `{{ action }}`, `{{ about }}`, `{{ year }}`, и наполняются они только тем, что
  // кто-то положил в свойства. Задача из чата обязана отдать законченную
  // страницу: без этого человек получает макет с пустой шапкой и безымянной
  // кнопкой, а runtime-проверка честно считает такие ссылки «кнопками без
  // имени» и отказывает. Значения берутся из самой просьбы — имя работы и её
  // первая строка, а не заглушки «Название».
  async function resolvePlaceholders (state) {
    const found = await callTool(state, 'dc_read', { path: state.component })
    if (found.error) return found
    const template = String(found.result.b_dc_html ?? '')
    if (!/(\{\{|\$\{)\s*[\w.$-]+\s*(\}\}|\})/.test(template)) return { ok: true }
    const wrote = await callTool(state, 'dc_write', {
      path: state.component,
      b_dc_html: fillPlaceholders(template, state),
      c_dc_js: String(found.result.c_dc_js ?? ''),
      d_props_json: propsFilled(state, found.result.d_props_json)
    })
    if (wrote.error) return wrote
    return { ok: true }
  }

  function recordOf (state, isNew) {
    const record = {
      id: state.designId,
      chatId: state.chatId,
      fromChat: true,
      component: state.component,
      version: state.version,
      designTask: {
        taskId: state.taskId,
        brief: clip(state.brief, MAX_STORED_BRIEF_CHARS),
        lastRequest: clip(state.request, MAX_REQUEST_CHARS),
        at: Date.now()
      },
      updatedAt: Date.now()
    }
    // Имя проекта — дело окна: человек мог переименовать дизайн сам, и правка из
    // чата не имеет права это имя затирать. Задаёт его только создание.
    if (isNew) record.name = state.topic
    return record
  }

  // Реестр пишется последним: запись без написанного компонента была бы битой
  // карточкой, по которой человек кликает и попадает в пустой раздел.
  async function writeRecord (state, isNew) {
    const record = recordOf(state, isNew)
    try {
      if (isNew) await designs.add(record)
      else if (!await designs.update(record)) {
        return { error: 'Запись дизайна в реестре не найдена — привязка к разговору не записана.' }
      }
    } catch (error) {
      return { error: `Реестр дизайнов не принял запись: ${reason(error)}` }
    }
    return { ok: true }
  }

  async function perform (state) {
    const target = findDesign(state, state.entries)
    if (target.error) return finish(state, { ok: false, status: 'failed', error: target.error })
    const entry = target.entry
    const isNew = !entry

    if (isNew) {
      state.designId = newDesignId(state.entries)
      if (!state.designId) {
        return finish(state, { ok: false, status: 'failed', error: 'Не удалось подобрать идентификатор дизайна — слишком много совпадений.' })
      }
      state.version = 1
    } else {
      state.designId = entry.id
      state.component = await resolveComponent(state, entry)
      state.version = await nextVersion(state, entry)
    }

    progress(state, 'принята', isNew
      ? `Новый дизайн «${state.topic}» из переписки.`
      : `Правка ${state.version} дизайна «${state.topic}».`)

    // Новый дизайн собирается каркасом ровно один раз на страницу: второй проход
    // по тому же имени снял бы версию с работы, которую человек ещё не видел.
    // Правка же читает страницу и достраивает её, не пересобирая.
    const built = state.component ? await revisePage(state) : await scaffoldPage(state)
    if (built.error) return finish(state, { ok: false, status: 'failed', error: built.error })
    state.component = built.component

    // Каркас — скелет: подстановки в нём обязаны превратиться в слова до того,
    // как страницу показывать человеку и проверять.
    const filled = await resolvePlaceholders(state)
    if (filled.error) return finish(state, { ok: false, status: 'failed', error: filled.error })

    progress(state, 'проверка', `Проверяю отрисованную страницу: ${state.component}.`)
    const verified = await callTool(state, 'dc_check', { path: state.component })
    if (verified.error) return finish(state, { ok: false, status: 'failed', error: verified.error })

    const stored = await writeRecord(state, isNew)
    if (stored.error) return finish(state, { ok: false, status: 'failed', error: stored.error })

    return finish(state, {
      ok: true,
      status: 'ready',
      revision: !isNew,
      taskId: state.taskId,
      designId: state.designId,
      component: state.component,
      version: state.version
    })
  }

  function newDesignId (entries) {
    const taken = new Set(entries.map(item => String(item?.id || '')))
    for (let attempt = 0; attempt < 8; attempt++) {
      // Та же форма, что у окна: идентификатор становится именем папки.
      const id = `d${Date.now().toString(36)}${randomTail(6)}`
      if (DESIGN_ID.test(id) && !taken.has(id)) return id
    }
    return ''
  }

  function progress (state, stage, message) {
    say({
      status: 'running',
      stage,
      message,
      taskId: state.taskId,
      designId: state.designId || null,
      chatId: state.chatId || null,
      component: state.component || null,
      version: state.version || null
    })
  }

  // Финал: событие и результат обязаны нести один и тот же статус, иначе карточка
  // в окне дорисует «готово» под отказом — или наоборот.
  function finish (state, result) {
    // Честное слово о правке: местный исполнитель намерение не читает — он
    // записывает просьбу в макет видимым блоком. Назвать это «макет готов»
    // значит отчитаться о несделанном: блок ещё надо выполнить — моделью в
    // разделе «Дизайн» или рукой человека.
    const done = result.revision
      ? `Правка ${result.version} записана в макет видимым блоком — её ещё надо выполнить: ${result.component}.`
      : `Макет собран и проверен: ${result.component}.`
    const event = {
      status: result.status,
      stage: 'финал',
      message: result.ok ? done : result.error,
      taskId: state.taskId,
      designId: result.designId || state.designId || null,
      chatId: state.chatId || null,
      component: result.component || state.component || null,
      version: Number.isFinite(result.version) ? result.version : (state.version || null)
    }
    if (!result.ok) event.error = result.error
    say(event)
    return result
  }

  async function run (input = {}) {
    const source = input && typeof input === 'object' ? input : {}
    const state = {
      taskId: typeof source.taskId === 'string' && source.taskId.trim()
        ? source.taskId.trim().slice(0, TASK_ID_LIMIT)
        : `task-${Date.now().toString(36)}-${randomTail(4)}`,
      chatId: typeof source.chatId === 'string' ? source.chatId.trim() : '',
      designId: '',
      component: '',
      version: 0,
      brief: '',
      topic: '',
      request: '',
      entries: []
    }
    try {
      const broken = configured()
      if (broken) return finish(state, { ok: false, status: 'failed', error: broken })
      const invalid = validate(source, state)
      if (invalid) return finish(state, { ok: false, status: 'failed', error: invalid })
      const registry = await readRegistry()
      if (registry.error) return finish(state, { ok: false, status: 'failed', error: registry.error })
      state.entries = registry.entries
      return await perform(state)
    } catch (error) {
      // Исключение наружу — это карточка, зависшая в «идёт работа», и чат без
      // ответа: задача обещает возвращать отказ при любых входных данных.
      return finish(state, { ok: false, status: 'failed', error: reason(error) })
    }
  }

  return { run }
}

module.exports = { createDesignTask }
