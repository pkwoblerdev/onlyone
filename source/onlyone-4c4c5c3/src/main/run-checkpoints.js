'use strict'

// Контрольные точки хода на диске (план, этап 6, блок 2). Контекст хода
// (agent-run-context.js) живёт в памяти и умирает вместе с процессом; здесь —
// то, что переживает падение и закрытие приложения посреди работы.
//
// Правило одно: повторять ход вслепую нельзя. Команда, выполненная до падения,
// но не успевшая записать результат, при повторе выполнится второй раз. Поэтому
// каждое действие с последствиями записывается ДО запуска («начато») и после
// («сделано» / «не удалось»). Всё, что после перезапуска осталось «начатым»,
// считается действием с неизвестным результатом: его надо проверить, а не
// повторять.
//
// Файл хода удаляется, когда ход закончился сам или его остановил человек:
// продолжать там нечего. Остаётся он только когда процесс умер посреди хода —
// ровно тот случай, ради которого всё и пишется.

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { cleanCycle, CHECK_LABELS, LIMITS } = require('./agent-cycle')
const { createTaskState, cleanTaskState } = require('./task-state.cjs')
const { isVerificationCommand } = require('./verification.cjs')

const SCHEMA_VERSION = 1
const RUN_ID = /^[0-9a-f-]{8,64}$/i
const MAX_ACTIONS = 200

// Контрольная точка лежит в userData открытым файлом: её пишет любой процесс,
// ей не нужен ключ safeStorage. Всё, что в неё попадает, переживёт падение в
// читаемом виде. Тело вызова на диск не пишется (см. TARGET_FIELDS), но цель
// действия и просьба человека — пишутся, а в них залезают токены. Поэтому
// секретные места затираются до записи, а после чтения ещё раз: файл мог быть
// записан прежней версией программы.
//
// Имя секрета — по-английски и по-русски: просьба в onlyone пишется по-русски,
// и «пароль: …» встречается чаще, чем «password=…». Любое число уточнений через
// «_» или «-» перед самим словом (x-access-key, access_token, private_key), но
// сравнение по всему имени: «keynote», «keyword» и «token_count» остаются собой,
// иначе опись перестала бы объяснять действие. Один источник на два использования:
// сравнение имени параметра в URL и поиск «имя значение» в тексте.
// Русские меткиknowны были только в именительном падеже, и ключ оставался в
// тексте просьбы целым: «зайди паролем X», «от пароля X», «ключи X и Y»
// (находка аудита 01.11 — 7 из 20 форм). Перебираем падежи списком: шаблон
// вида «парол[а-яё]*» съедал бы и «парольная политика», и любое следующее слово
// русской прозы.
const SECRET_NAME = String.raw`(?:[a-z0-9]+[_-])*(?:key|token|secret|password|passwd|pwd|signature|auth|jwt|cookie|authorization|apikey|credentials?|токен(?:|а|у|ом|е|ы|ов|ам|ами|ах)|ключ(?:|а|у|ом|е|и|ей|ам|ами|ах)|секрет(?:|а|у|ом|е|ы|ов|ам|ами|ах)|парол(?:ь|я|ю|ем|е|и|ей|ям|ями|ях))`
const SECRET_QUERY_KEYS = new RegExp(`^${SECRET_NAME}$`, 'i')

// Живой ключ почти всегда узнаётся по форме: провайдерский префикс, JWT,
// заголовок Bearer или длинная base64 без пробелов. Правил сознательно четыре,
// не двадцать: ложное срабатывание портит опись, по которой человек решает,
// что продолжать, — это дороже пропущенного редкого формата.
const SHAPE_PREFIX = /\b(?:sk|ghp|gho|ghu|ghs|glpat|aiza|hf|npm|yt3r|xai|AKIA|xox[baprs]|sec_live|sec_test|sbp_)[A-Za-z0-9_-]{6,}\b/gi
const SHAPE_JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g
const SHAPE_HEADER = /\b(Bearer|Basic)([ \t]*:?[ \t]+)[A-Za-z0-9._~+/=-]{6,}/gi
const SHAPE_BLOB = /\b[A-Za-z0-9_-]{32,}\b/g
// Короткий ключ: провайдерский префикс и всего четыре знака после него. «Слепая»
// base64-форма начинается с 32 знаков, энтропия — с 16, и живой ключ в двенадцать
// знаков в ответе сервера оставался целым. Цифра в остатке обязательна: без неё
// под правило попадали бы слова («sk-learn», «xoxo-guys»), а человек терял бы
// смысл объяснения, по которому решает, что продолжать.
const SHAPE_SHORT = /\b(?:sk-|AIza|xox[abposr]-|gh[pousr]_|github_pat_|glpat-|hf_|npm_|xai-|sec_(?:live|test)_|sbp_)[A-Za-z0-9_-]{4,}\b/gi
// JWT короче обычного (два сегмента вместо трёх) узнаётся по началу `eyJ` —
// это base64 от `{"`, и в обычном слове такого начала не бывает.
const SHAPE_JWT_SHORT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]{2,})?\b/g
// PEM-блок: единственный многословный секрет, который узнаётся без риска задеть
// обычную фразу. Остальной длинный текст закрывает не форма, а шифрование поля.
const SHAPE_PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g
const SHAPE_ENTROPY_CANDIDATE = /\b[A-Za-z0-9_-]{16,31}\b/g

function shannonEntropy(str) {
  const map = {}
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    map[c] = (map[c] || 0) + 1
  }
  let ent = 0
  const len = str.length
  for (const count of Object.values(map)) {
    const p = count / len
    ent -= p * Math.log2(p)
  }
  return ent
}

function isHighEntropySecret(token) {
  if (token.length < 16 || token.length > 31) return false
  if (/^[0-9a-fA-F]{16,31}$/.test(token)) {
    return shannonEntropy(token) >= 3.0
  }
  if (/^[A-Za-z0-9]{16,31}$/.test(token)) {
    const hasDigit = /[0-9]/.test(token)
    const hasUpper = /[A-Z]/.test(token)
    const hasLower = /[a-z]/.test(token)
    if (hasDigit && hasUpper && hasLower) {
      return shannonEntropy(token) >= 3.2
    }
  }
  return false
}

// Значение не включает «/», «@», «:» и обратную косую черту: иначе «https://…»
// проходило бы значением одного ключа, и вся query-строка исчезала бы из
// проверки (именно так первая версия и промахивалась). Кавычки — и обычные, и
// «ёлочки» — тоже вне значения: их оставляет на месте, а под маску идёт то,
// что внутри.
const VALUE = /[^\s,;&|"'<>@:/\\«»“”‘’`]+/

function redactByShape(text) {
  return String(text || '')
    .replace(SHAPE_PEM, '***')
    .replace(SHAPE_PREFIX, '***')
    .replace(SHAPE_JWT, '***')
    .replace(SHAPE_JWT_SHORT, '***')
    .replace(SHAPE_SHORT, hit => (/[0-9]/.test(hit) ? '***' : hit))
    .replace(SHAPE_HEADER, '$1$2***')
    .replace(SHAPE_BLOB, '***')
}

function maskUrl(whole) {
  let url
  try { url = new URL(whole) } catch { return redactByShape(whole) }
  if (url.username || url.password) { url.username = '***'; url.password = '' }
  let hit = false
  for (const [name] of Array.from(url.searchParams.keys())) {
    if (SECRET_QUERY_KEYS.test(name)) { url.searchParams.set(name, '***'); hit = true }
  }
  // Секрет может стоять в пути, а не в query: «/token/abc123def456». Имя
  // раздела при этом обязано быть секретным именем («/keys/intro»,
  // «/token/refresh» остаются), а значение — машинной формы и не короче
  // восьми символов: иначе живой путь документации превратился бы в маску.
  const parts = url.pathname.split('/')
  for (let i = 1; i < parts.length; i++) {
    if (!SECRET_QUERY_KEYS.test(parts[i - 1])) continue
    if (parts[i].length < 8 || !machineLike(parts[i])) continue
    parts[i] = '***'
    url.pathname = parts.join('/')
    hit = true
  }
  const rebuilt = url.toString()
  return hit || whole.includes('@') ? rebuilt : redactByShape(whole)
}

// «имя: значение», «имя=значение», «имя — значение» и «имя значение» —
// по-английски и по-русски. Маскируется только значение по lookbehind: прежний
// вариант матчил «имя + значение» целиком и, когда имя оказывалось обычным
// словом («Мой токен …»), съедал секретное имя как чужое значение — до проверки
// имени не доходило. Граница имени — свой класс, а не \b: в JavaScript \b
// считает «словом» только латиницу, цифру и подчёркивание, и на «токен» или
// «ключ» не срабатывает.
//
// Значение при этом узнаётся по ФОРМЕ, а не по соседству с секретным именем.
// Соседство не различает «токен sk-or-v1-9f8e» и «токен можно проверить»: во
// втором случае под маску шло обычное слово, а человек терял смысл описи, по
// которой он решает, что продолжать. В первом — наоборот: в «токен это
// abc123XYZ» маска съедала «это», а ключ оставался на месте.
//
// Секретное значение — то, в чём есть цифра, дефис или подчёркивание (так
// живут API-ключи, hex и base64), либо смешанный регистр («aB3c»), либо
// строчное латинское слово, стоящее сразу после «:», «=» или тире: там, где
// разделитель уже объявил «дальше значение» («password=huntertwo»). Всё
// остальное — слово: «токен можно», «ключ FROM», «пароль: нет», «Bearer».
// Слово, набранное ОДНИМИ заглавными, машиной не считается: так пишут SQL,
// статусы и аббревиатуры, а ключей такого вида не бывает — в них есть цифра.
//
// Между именем и значением стоит до двух обычных слов-связок: «токен это
// abc123», «ключ от провайдера: abc123». Больше — уже не подпись значения, и
// там правило не ищет: иначе «ключ это значение равно 5» теряло бы пятёрку.
//
// Осознанный остаток (форма совпадает с обычной речью, отличить нельзя):
// строчный латинский пароль без разделителя («токен qwerty»), кириллический
// пароль после «:» («пароль: Кузнечик»), и число сразу после имени
// («ключ 2.5 МБ» — под маску попадает «2.5», потому что шестизначный код тоже
// число).
const NAME_SEP = new RegExp('(?:^|[^0-9A-Za-z_])(' + SECRET_NAME + ')' +
  '([ \\t]*["\'«“`]?[ \\t]*[:=][ \\t]*["\'«“`]?[ \\t]*|[ \\t]+[-—–][ \\t]+|[ \\t]*[—–][ \\t]*|[ \\t]+)', 'gi')
const TOKEN = new RegExp(VALUE.source, 'y')
// Знаки, которых не бывает в обычном слове.
const MACHINE_MARK = /[0-9_-]/
const UPPER = /[A-Z]/
const LOWER = /[a-z]/
const CYRILLIC = /[\u0400-\u04FF]/
// Слово об отсутствии секрета: «ключ: нет» — не секрет.
const ABSENT_VALUE = /^(?:none|null|empty|unknown|missing|not|na|n|no|-+|не|нет|пусто|отсутствует)$/i
// Слово схемы оставляем: под маской должен угадываться характер секрета, иначе
// «Authorization: *** ***» читаемо не лучше, чем совсем без описи.
const SCHEME_VALUE = /^(?:Bearer|Basic|Token|Дайджест)$/i
// Метка формата говорит, ЧЕМ записано значение, и сама значением не является:
// «секрет base64 dGVzd…», «токен JWT eyJ…».
const FORMAT_LABEL = /^(?:base64|base64url|base-?58|hex|jwt|sha\d+|md5|api|apikey|url|формат|значение)$/i
// Перед значением может стоять кавычка (и пробел вокруг неё) — так выглядят
// JSON, YAML и человеческая цитата: «{"token": "abc123"}», «токен: "abc123"».
// Кавычки в значение не входят, поэтому смотрим сквозь них.
const BEFORE_VALUE = /^[ \t"'«“”‘’`]{0,3}/

function tokenAt(text, at) {
  const start = at + BEFORE_VALUE.exec(text.slice(at))[0].length
  TOKEN.lastIndex = start
  const hit = TOKEN.exec(text)
  return hit && hit[0] ? { word: hit[0], start, end: start + hit[0].length } : null
}

function machineLike(word) {
  if (MACHINE_MARK.test(word)) return true
  return UPPER.test(word) && LOWER.test(word)
}

// `afterSeparator` — разделитель, объявивший значение («:», «=», тире), а не
// просто пробел: после явного разделителя строчное латинское слово считается
// значением, после пробела — остаётся словом. Слова об отсутствии и слова схемы
// отсекает вызывающий цикл: они останавливают разбор, а не маскируются.
function secretValue(word, afterSeparator) {
  if (!word) return false
  if (machineLike(word)) return true
  if (CYRILLIC.test(word)) return false
  return Boolean(afterSeparator)
}

function redactByAssignment(text) {
  const source = String(text || '')
  const cuts = []
  NAME_SEP.lastIndex = 0
  let hit
  while ((hit = NAME_SEP.exec(source))) {
    let at = hit.index + hit[0].length
    if (cuts.length && at < cuts[cuts.length - 1].end) continue
    let afterSeparator = !/^[ \t]+$/.test(hit[2])
    // Четыре шага: само значение, до двух слов-связок перед ним, и ещё шаг на
    // случай «токен JWT abc123», где перед ключом стоят и метка, и связка.
    for (let step = 0; step < 4; step++) {
      const token = tokenAt(source, at)
      if (!token) break
      // Слово об отсутствии — конец подписи: после него идёт обычный текст.
      if (ABSENT_VALUE.test(token.word)) break
      // Слово схемы и метка формата значением не являются, но и не конец
      // подписи: за ними как раз стоит ключ («auth token AbCdEf123456»,
      // «секрет base64 dGVzd…», «токен JWT eyJ…» — раньше и метка съедалась, и
      // ключ оставался).
      const label = SCHEME_VALUE.test(token.word) || FORMAT_LABEL.test(token.word)
      const rest = source.slice(token.end)
      // Слово, за которым сразу «:» или «=», — часть подписи, а не текст:
      // «ключ от провайдера: abc123», «пароль от базы: Qwerty123!». Проверка
      // стоит ДО остальных: короткое слово подписи («базы») — не значение, но и
      // не повод прекращать разбор.
      const colon = /^[ \t]*["'«“`]?[ \t]*[=:]/.exec(rest)
      if (!label && !colon) {
        // Голые цифры без букв считаются значением только стоя вплотную к
        // разделителю: «ключ: 123456» — код, «ключ ring holds 3» — счёт.
        // То же после связки: «The key is UTF-8 encoded» — это проза, а
        // «токен это abc123XYZ» — ключ. Живой секрет короче восьми символов
        // после связки не встречается, а слова вроде UTF-8 и X11 — короче.
        if (step && (token.word.length < 8 || !/[A-Za-zА-Яа-я]/.test(token.word))) break
        if (secretValue(token.word, afterSeparator)) {
          cuts.push(token)
          // Перечисление через запятую — список значений, а не проза:
          // «ключи: abc123, def456». Без запятой дальше идёт текст, и там мы
          // останавливаемся («токен abc123 и ещё что-то»).
          let last = token.end
          for (;;) {
            const list = /^[ \t]*,[ \t]*/.exec(source.slice(last))
            if (!list) break
            const next = tokenAt(source, last + list[0].length)
            if (!next || ABSENT_VALUE.test(next.word) || SCHEME_VALUE.test(next.word) ||
              !machineLike(next.word)) break
            cuts.push(next)
            last = next.end
          }
          break
        }
      }
      if (colon) {
        at = token.end + colon[0].length
        afterSeparator = true
        continue
      }
      const gap = /^[ \t]+/.exec(rest)
      if (!gap) break
      at = token.end + gap[0].length
    }
  }
  let out = source
  for (const cut of cuts.reverse()) out = out.slice(0, cut.start) + '***' + out.slice(cut.end)
  return out
}

function redactByEntropy(text) {
  return String(text || '').replace(SHAPE_ENTROPY_CANDIDATE, token => (isHighEntropySecret(token) ? '***' : token))
}

function redactSecrets(text) {
  let value = String(text || '')
  value = value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, maskUrl)
  value = value.replace(/\b([\w.\u0430-\u044F-]{2,}):([^\s@/:]{3,})@/g, '$1:***@')
  value = redactByShape(value)
  value = redactByAssignment(value)
  return redactByEntropy(value)
}

// Инструменты без последствий: их не записываем, повтор ничего не испортит.
// Список совпадает с тем, что разрешено части «только на чтение»
// (agent-quality.js), плюс служебные инструменты хода.
const READ_ONLY_TOOLS = new Set(['read_guide', 'task_plan', 'ask_user', 'propose_linked_chat', 'board_update', 'agent_message',
  'board_read', 'assign_work', 'read_file', 'list_files', 'search_files', 'find_symbol', 'list_skills', 'use_skill',
  'skill_file', 'fetch_url', 'list_mcp_servers', 'artifacts_list', 'ffmpeg_info', 'project_chats', 'project_chat',
  'project_file', 'project_plan_get', 'dc_read', 'dc_list', 'dc_comments', 'dc_check', 'dc_refs', 'dc_read_ref'])

// Из аргументов в файл попадает только то, по чему человек и модель узнают
// действие. Содержимое файлов, тексты и прочее тело вызова не пишется.
// `source`/`destination` — у move_path: одного источника мало, чтобы понять,
// куда файл делся.
const TARGET_FIELDS = ['path', 'source', 'destination', 'command', 'name', 'url', 'id', 'title']

function hasSideEffects(tool) {
  return !READ_ONLY_TOOLS.has(String(tool || ''))
}

function describeTarget(args) {
  if (!args || typeof args !== 'object') return ''
  const pick = (key, limit = 200) => {
    const value = args[key]
    return typeof value === 'string' && value.trim() ? clip(redactSecrets(value), limit) : ''
  }
  const source = pick('source', 100)
  const destination = pick('destination', 100)
  if (source && destination) return clip(`${source} → ${destination}`, 200)
  for (const key of TARGET_FIELDS) {
    const value = pick(key)
    if (value) return value
  }
  // Полей инструмента опись не знает: пустая цель склеила бы разные вызовы в
  // одну и чужое действие закрыло бы неизвестный исход. Хеш различает вызовы,
  // не раскрывая аргументов.
  return `args:${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 12)}`
}

// Просьба человека — единственное место, где без открытого текста не обойтись:
// по ней карточка «Работа прервалась» объясняет, что продолжать. От того и
// прячем секретные места (redactSecrets). Полное шифрование возможно только
// там, где есть safeStorage, то есть в главном процессе: ему передаётся
// парой protect/unprotect, и при наличии пары поле пишется уже шифром с
// пометкой, а не текстом. Файлы прежних версий пометки не имеют — они
// читаются как есть и ещё раз вычищаются.
const SEALED = 'enc:v1:'
// Тело настоящего шифра — всегда base64: у safeStorage это base64 от DPAPI.
// Отпущенный код ставил метку и тогда, когда шифр вернул вход как есть, и под
// меткой остался открытый текст — с пробелами, кириллицей, знаками, которых в
// base64 не бывает. По этому признаку запись отпущенного кода и отличается от
// чужого ключа: второе остаётся нечитаемым, а первое обязано прочитаться.
const CIPHER_BODY = /^[A-Za-z0-9+/]+={0,2}$/
// Расшифрованное обязано быть текстом: расшифровка «не того» тела отдаёт
// подстановки и управляющие байты, а не просьбу человека.
const PRINTABLE = /^[^\uFFFD\u0000-\u0008\u000E-\u001F]*$/

// Открытый текст, оставшийся под меткой шифра (запись отпущенного кода), или ''.
function plainUnderSeal(stored) {
  const value = String(stored || '')
  if (!value.startsWith(SEALED)) return ''
  const body = value.slice(SEALED.length)
  return body && !CIPHER_BODY.test(body) ? body : ''
}

// Тексты задачи (требования и доказательства) отпущенный код оставлял открытыми
// под той же меткой. Возвращает задачу с перепечатанными полями — или null,
// если перепечатывать нечего. Запечатанное не трогается: повторный `seal`
// принял бы шифр за текст и зашифровал его второй раз.
function resealPlainTask(task, seal) {
  if (!task || typeof task !== 'object') return null
  let changed = false
  const fix = value => {
    const plain = plainUnderSeal(value)
    if (!plain) return value
    changed = true
    return seal(plain)
  }
  const map = (list, fields) => (Array.isArray(list) ? list.map(item => {
    if (!item || typeof item !== 'object') return item
    const out = { ...item }
    for (const field of fields) if (typeof out[field] === 'string') out[field] = fix(out[field])
    return out
  }) : list)
  const next = {
    ...task,
    requirements: map(task.requirements, ['expected', 'criterion']),
    evidence: map(task.evidence, ['coverage', 'limits'])
  }
  return changed ? next : null
}

function makeSealer({ protect = null, unprotect = null } = {}) {
  return {
    seal(text) {
      const plain = redactSecrets(text)
      if (typeof protect !== 'function') return plain
      try {
        const wrapped = protect(plain)
        // Обвязка главного процесса при недоступном шифре отдаёт вход как есть:
        // такая запись не должна получать метку `enc:v1:` — вернётся шифр, и
        // метка прочиталась бы как непостижимый шифр, а просьба потерялась
        // (sec-аудит 01.11, Н1). Открытый текст остаётся открытым: без метки он
        // читается и мигрирует при следующем запуске с работающим шифром.
        return typeof wrapped === 'string' && wrapped && wrapped !== plain ? SEALED + wrapped : plain
      } catch {
        return plain // шифр недоступен — просим вычистить, а не уронить ход
      }
    },
    unseal(stored) {
      const value = String(stored || '')
      if (!value.startsWith(SEALED)) return redactSecrets(value)
      const body = value.slice(SEALED.length)
      // Сначала расшифровка: своя пара protect/unprotect отдаёт текст. Мусор от
      // «расшифровки» открытого текста (запись отпущенного кода) текстом не
      // считается и уходит в ветку ниже.
      if (typeof unprotect === 'function') {
        try {
          const text = unprotect(body)
          if (typeof text === 'string' && text && PRINTABLE.test(text)) return redactSecrets(text)
        } catch { /* ниже: может быть, шифра тут и не было */ }
      }
      // Не расшифровалось, а под меткой открытый текст — читаем его как текст:
      // отпущенный код ставил метку и над результатом «шифр недоступен».
      // Остаток: открытый текст, случайно состоящий из одних base64-знаков,
      // остаётся нечитаемым — отличить его от чужого шифра нечем.
      const plain = plainUnderSeal(value)
      if (plain) return redactSecrets(plain)
      // null — «зашифровано, но не прочиталось»: пустая строка значила бы, что
      // поля не было, и требование исчезало бы молча вместе с просьбой.
      return null
    }
  }
}

function clip(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? value.slice(0, limit) + '…' : value
}

// Привязка к моду переживает перезапуск только как публичные идентификаторы.
// Одноразовый токен предпросмотра и текст навыка сюда не попадают, а ревизия и
// отпечаток состояния нужны, чтобы continuation заново проверил действие.
function cleanMod(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const mod = {}
  for (const key of ['modId', 'panelId', 'buttonId', 'chatId']) {
    if (typeof value[key] === 'string' && value[key]) mod[key] = clip(value[key], 200)
  }
  if (value.suggestion === true) mod.suggestion = true
  if (Number.isSafeInteger(value.revision) && value.revision >= 0) mod.revision = value.revision
  if (typeof value.statusHash === 'string' && value.statusHash) mod.statusHash = clip(value.statusHash, 200)
  return mod.modId && mod.panelId ? mod : null
}

// The durable journal may include only the accounting contract's allow-listed
// fields. Never trust an object that came back from disk after a crash: it can
// be old, truncated, or edited by another local process.
function cleanRunContext(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schemaVersion !== 1) return null
  const phases = new Set(['plan', 'execute', 'verify', 'rework', 'finalize'])
  const outcomes = new Set(['completed', 'failed', 'cancelled', 'incomplete', 'running'])
  const journal = Array.isArray(snapshot.journal) ? snapshot.journal.slice(-256).map(entry => {
    const item = { sequence: Number(entry?.sequence) || 0, at: Number(entry?.at) || 0,
      type: clip(entry?.type, 40) }
    if (Number.isInteger(entry?.agentIndex)) item.agentIndex = entry.agentIndex
    if (typeof entry?.model === 'string') item.model = clip(entry.model, 120)
    if (Number.isFinite(entry?.tokens) && entry.tokens >= 0) item.tokens = entry.tokens
    if (typeof entry?.outcome === 'string') item.outcome = clip(entry.outcome, 32)
    if (phases.has(entry?.phase)) item.phase = entry.phase
    if (Number.isInteger(entry?.round) && entry.round > 0) item.round = entry.round
    if (typeof entry?.kind === 'string') item.kind = clip(entry.kind, 64)
    return item
  }) : []
  const usage = snapshot.usage && typeof snapshot.usage === 'object' ? snapshot.usage : {}
  const state = outcomes.has(snapshot.state) ? snapshot.state : 'running'
  return {
    schemaVersion: 1,
    state,
    surface: ['chat', 'design'].includes(snapshot.surface) ? snapshot.surface : 'chat',
    startedAt: Number(snapshot.startedAt) || 0,
    deadlineAt: Number(snapshot.deadlineAt) || 0,
    endedAt: Number(snapshot.endedAt) || null,
    currentPhase: phases.has(snapshot.currentPhase) ? snapshot.currentPhase : null,
    usage: {
      totalTokens: Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0 ? usage.totalTokens : 0,
      reports: Number.isInteger(usage.reports) && usage.reports >= 0 ? usage.reports : 0
    },
    journal,
    ...require('./agent-run-context').cleanObservations(snapshot),
    ...(Array.isArray(snapshot.configurations) ? {
      configurations: require('./agent-run-context').cleanConfigurations(snapshot.configurations),
      droppedConfigurations: Number.isSafeInteger(snapshot.droppedConfigurations) && snapshot.droppedConfigurations >= 0 ? snapshot.droppedConfigurations : 0
    } : {}),
    droppedEvents: Number.isInteger(snapshot.droppedEvents) && snapshot.droppedEvents >= 0 ? snapshot.droppedEvents : 0
  }
}

// Состояние задачи (task-state.cjs) лежит в том же файле. Тексты требований и
// покрытие доказательств — это слова модели и человека, поэтому уходят шифром
// так же, как просьба; остальное — идентификаторы, состояния и числа.
function sealTask(task, seal) {
  if (!task) return null
  return {
    ...task,
    requirements: task.requirements.map(item => ({ ...item, expected: seal(item.expected), criterion: seal(item.criterion) })),
    evidence: task.evidence.map(item => ({ ...item, coverage: seal(item.coverage), limits: seal(item.limits) }))
  }
}

// Текст требования, который не расшифровался, не выбрасывается: требование
// остаётся в остатке с заглушкой, а исходный шифр — рядом (expectedSealed).
// Вернётся ключ профиля — вернётся и текст; до тех пор задача не «уже сделана».
const LOST_TEXT = 'Текст требования не прочитан: не подошёл ключ профиля'
const LOST_ASK = 'Текст просьбы не прочитан: не подошёл ключ профиля'

function unsealTask(task, unseal) {
  if (!task || typeof task !== 'object') return null
  const open = value => typeof value === 'string' && value ? unseal(value) : ''
  const sealed = value => typeof value === 'string' && value.startsWith(SEALED)
  return {
    ...task,
    requirements: (Array.isArray(task.requirements) ? task.requirements : []).map(item => {
      const original = sealed(item?.expectedSealed) ? item.expectedSealed : item?.expected
      const expected = open(original)
      if (expected !== null) {
        const { expectedSealed, criterionSealed, unreadable, ...rest } = item || {}
        // Симметрия с expected: unreadable-ветка обнулила item.criterion и
        // прятала шифр в criterionSealed — без этой сверки текст критерия
        // терялся навсегда (новый main Н1).
        const originalCriterion = sealed(item?.criterionSealed) ? item.criterionSealed : item?.criterion
        const criterion = open(originalCriterion)
        if (criterion !== null) return { ...rest, expected, criterion }
        // Критерий зашифрован другим ключом: шифр сохраняем, как expectedSealed,
        // иначе текст проверки теряется навсегда при смене ключа профиля (Н6).
        return {
          ...rest, expected, criterion: '', state: 'stale', unreadable: true,
          ...(sealed(originalCriterion) ? { criterionSealed: originalCriterion } : {})
        }
      }
      const criterion = sealed(item?.criterionSealed) ? item.criterionSealed : item?.criterion
      return {
        ...item, expected: LOST_TEXT, criterion: '', state: 'stale', unreadable: true,
        ...(sealed(original) ? { expectedSealed: original } : {}),
        ...(sealed(criterion) ? { criterionSealed: criterion } : {})
      }
    }),
    evidence: (Array.isArray(task.evidence) ? task.evidence : []).map(item => ({ ...item, coverage: open(item?.coverage) || '', limits: open(item?.limits) || '' }))
  }
}

function createCheckpointStore({ dir, now = Date.now, protect = null, unprotect = null } = {}) {
  if (!dir) throw new TypeError('Нужна папка для контрольных точек')
  const { seal, unseal } = makeSealer({ protect, unprotect })
  const fileOf = runId => path.join(dir, `${runId}.json`)

  // Запись через временный файл и переименование: падение посреди записи
  // оставляет прежнюю целую версию, а не обрезанный JSON.
  function writeAtomic(runId, data) {
    fs.mkdirSync(dir, { recursive: true })
    const target = fileOf(runId)
    const temp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(data))
    // Windows: сканер или чтение соседа на миг занимает целевой файл, и
    // переименование падает с EPERM/EBUSY. Короткие повторы вместо потери отметки.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temp, target); break } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) {
          try { fs.rmSync(temp, { force: true }) } catch { /* временный файл */ }
          throw error
        }
        const until = Date.now() + 5 * (attempt + 1)
        while (Date.now() < until) { /* ждём без таймера: запись синхронная */ }
      }
    }
  }

  function start({ runId, requestId = '', chatId = null, designId = null, surface = 'chat', ask = '', carried = null, mod = null, carriedTask = null, budgetLimits = null, budgetDeadlineAt = undefined } = {}) {
    if (!RUN_ID.test(String(runId || ''))) throw new TypeError('Неверный идентификатор хода')
    // Продолжение после падения наследует список подтверждённых действий: без
    // этого второй перезапуск знал бы только о втором ходе, а всё, что было
    // сделано до первого, снова выглядело бы нетронутым. Действия с неизвестным
    // результатом наследуются такими же — их по-прежнему надо проверять.
    const inherited = (Array.isArray(carried) ? carried : []).filter(item => item &&
      ['done', 'failed', 'denied', 'unknown', 'started'].includes(item.status)).slice(0, MAX_ACTIONS)
    const data = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      requestId: String(requestId || ''),
      chatId: chatId ? String(chatId) : null,
      // Ход Дизайна живёт в своём разделе, и карточка продолжения нужна там же:
      // без designId окну не понять, к какому дизайну вернулся прерванный ход.
      designId: designId ? String(designId) : null,
      surface,
      ask: seal(clip(ask, 600)),
      // Продолжение обязано помнить, какой мод подготовил задачу: без этого
      // выбранный навык и повторная проверка теряются после перезапуска.
      mod: cleanMod(mod),
      startedAt: now(),
      updatedAt: now(),
      context: null,
      // Бюджет общего цикла (agent-cycle.js): сколько продлений и проверок судьёй
      // этот ход уже истратил. Нужен, чтобы «продолжить» после падения шло на
      // остатке, а не с ещё одним полным комплектом попыток.
      cycle: null,
      actions: inherited.map((item, index) => ({
        seq: index + 1,
        tool: String(item.tool || '').slice(0, 80),
        target: clip(redactSecrets(item.target), 200),
        agentIndex: Number.isInteger(item.agentIndex) ? item.agentIndex : 0,
        // Неизвестный исход наследуется «начатым»: при следующем падении он
        // снова станет действием, которое надо проверить, а не сделанным.
        status: item.status === 'done' ? 'done' : item.status === 'unknown' || item.status === 'started' ? 'started' : 'failed',
        at: Number(item.at) || 0,
        carried: true
      })),
      droppedActions: 0
    }
    // Состояние задачи наследуется целиком: требования, доказательства и
    // действия с неизвестным исходом (их сверяют, а не повторяют).
    const task = createTaskState({ restored: carriedTask, idPrefix: String(runId).slice(0, 8), budgetLimits, budgetDeadlineAt })
    let closed = false
    let sequence = data.actions.length
    // Дошёл ли файл до диска. Нужно тем, кто собирается на основании этой записи
    // уничтожить прежнюю: снять старую, не сумев сохранить новую, — значит
    // потерять память о ходе, а не приобрести её.
    let saved = false
    const save = () => {
      if (closed) return false
      data.updatedAt = now()
      try {
        writeAtomic(runId, { ...data, task: sealTask(task.snapshot(), seal) })
        saved = true
      } catch {
        saved = false
        // Диск недоступен — ход идёт дальше: контрольная точка помогает
        // продолжить после падения, но не должна сама ронять работу.
        return false
      }
      return true
    }
    save()

    // Возвращает отметку действия или null, если инструмент без последствий.
    // `durable` — дошла ли отметка «начато» до диска. Побочное действие без неё
    // начинать нельзя: записанное в памяти при падении процесса исчезает, и
    // продолжение не узнает, что команду уже выполняли.
    function begin(tool, args, agentIndex = 0) {
      if (closed || !hasSideEffects(tool)) return null
      const action = {
        seq: ++sequence,
        tool: String(tool).slice(0, 80),
        target: describeTarget(args),
        agentIndex: Number.isInteger(agentIndex) ? agentIndex : 0,
        status: 'started',
        at: now()
      }
      const verification = tool === 'run_command' && isVerificationCommand(args?.command)
      const taskAction = task.beginAction({ tool, target: action.target, agentIndex: action.agentIndex, verification })
      data.actions.push(action)
      if (data.actions.length > MAX_ACTIONS) {
        data.actions.shift()
        data.droppedActions++
      }
      const durable = save()
      if (!durable) {
        // Отметка не на диске — убираем её из списка: иначе «начатое» действие
        // всплывёт в описи, которой нет.
        const at = data.actions.indexOf(action)
        if (at >= 0) data.actions.splice(at, 1)
        sequence = Math.max(0, sequence - 1)
        task.discardAction(taskAction.id)
      }
      return {
        durable,
        actionId: taskAction.id,
        // exitCode и unconfirmed — из результата инструмента: зелёная проверка
        // становится доказательством, любое другое действие меняет входы
        // (подтверждения перепроверяются), остановка без подтверждения — неизвестный исход.
        end(outcome, { exitCode = null, unconfirmed = false } = {}) {
          if (action.status !== 'started') return
          action.status = outcome === 'failed' ? 'failed' : outcome === 'denied' ? 'denied' : 'done'
          task.endAction(taskAction.id, action.status, { unconfirmed })
          if (action.status === 'done' && !unconfirmed) {
            if (verification && Number.isInteger(exitCode)) {
              task.addEvidence({ source: 'command', verdict: exitCode === 0 ? 'pass' : 'fail', actionId: taskAction.id,
                coverage: `${action.target} → код ${exitCode}` })
            } else if (!verification) task.bumpInput('workspace', `${action.tool}`)
          } else if (action.status === 'failed' && !verification) task.bumpInput('workspace', `${action.tool} не удалось`)
          save()
        }
      }
    }

    function updateContext(snapshot) {
      if (closed) return false
      const context = cleanRunContext(snapshot)
      if (!context) return false
      data.context = context
      save()
      return true
    }

    // Тот же принцип, что у контекста: с диска приходит недоверенный объект,
    // поэтому он не записывается как есть, а пересобирается cleanCycle.
    function updateCycle(snapshot) {
      if (closed) return false
      data.cycle = cleanCycle(snapshot)
      save()
      return true
    }

    // Чек-лист модели заводит требования; «сделано» модели — «проверяется».
    function syncPlan(items, agentIndex = 0) {
      if (closed) return false
      task.syncPlan((Array.isArray(items) ? items : []).map(item => ({ ...item,
        title: redactSecrets(item?.title), detail: redactSecrets(item?.detail) })), agentIndex)
      save()
      return true
    }

    function addEvidence(input) {
      if (closed) return null
      const item = task.addEvidence(input)
      save()
      return item
    }

    // Общий бюджет задачи (АГ-8, И-2): тот же объект у ведущего и помощников.
    // Резерв обязан дойти до диска до запроса: иначе падение процесса потеряет
    // его, и продолжение получит свободный остаток. Не дошёл — резерв снимается.
    function reserveBudget(input) {
      if (closed || !task.budget) return { ok: false, error: 'no_budget' }
      const result = task.budget.reserve(input)
      if (!result.ok || result.duplicate) return result
      if (!save()) {
        task.budget.rollback({ id: input.id })
        return { ok: false, error: 'not_durable', durable: false }
      }
      return { ...result, durable: true }
    }

    function settleBudget(input) {
      if (closed || !task.budget) return { ok: false, error: 'no_budget' }
      const result = task.budget.settle(input)
      if (result.ok || result.released) {
        const durable = save()
        return { ...result, durable }
      }
      return result
    }

    function releaseBudget(input) {
      if (closed || !task.budget) return { ok: false, error: 'no_budget' }
      const result = task.budget.release(input)
      if (result.ok) {
        const durable = save()
        return { ...result, durable }
      }
      return result
    }

    function correctBudget(input) {
      if (closed || !task.budget) return { ok: false, error: 'no_budget' }
      const result = task.budget.correct(input)
      if (result.ok) {
        const durable = save()
        return { ...result, durable }
      }
      return result
    }

    function budget() {
      return task.budget ? task.budget.snapshot() : null
    }

    // До побочного действия: повтор действия с неизвестным исходом сначала
    // предупреждается. Чтение и прочие безопасные инструменты не задерживаются.
    function admit(tool, args, agentIndex = 0) {
      if (closed || !hasSideEffects(tool)) return { allowed: true }
      // Цикл A → B → A считается по журналу действий своего исполнителя: часть
      // помощника не приписывается ведущему.
      const verdict = task.admit({ tool, target: describeTarget(args), agentIndex })
      if (!verdict.allowed) save()
      return verdict
    }

    // Модель посмотрела на цель — исход действия с неизвестным результатом сверен.
    // Индекс смотрящего доходит до состояния: чужое чтение не сверяет чужой исход.
    function observe(args, agentIndex = null) {
      if (closed) return 0
      const count = task.observe(describeTarget(args), agentIndex)
      if (count) save()
      return count
    }

    function close() {
      if (closed) return
      closed = true
      try { fs.rmSync(fileOf(runId), { force: true }) } catch { /* останется до «скрыть» */ }
    }

    return Object.freeze({ runId, begin, admit, observe, syncPlan, addEvidence, updateContext, updateCycle, close,
      reserveBudget, settleBudget, releaseBudget, correctBudget, budget,
      task: () => task,
      saved: () => saved && !closed,
      snapshot: () => JSON.parse(JSON.stringify({ ...data, task: task.snapshot() })) })
  }

  // Ходы, оборванные падением или закрытием приложения. Вызывается при запуске,
  // пока новых ходов ещё нет: любой найденный файл — чужой прошлый процесс.
  function interrupted() {
    let names = []
    try { names = fs.readdirSync(dir) } catch { return [] }
    const runs = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const runId = name.slice(0, -5)
      if (!RUN_ID.test(runId)) continue
      let data
      try {
        data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      } catch {
        // Файл повреждён извне (антивирус, сбой диска, соседний процесс): молча
        // выбросить его — значит скрыть прерванную работу и разрешить продолжению
        // повторить побочные действия вслепую. Запись видна в списке с признаком
        // порчи, пока человек её не снимет (Н9).
        runs.push({
          runId, chatId: null, designId: null, surface: 'chat',
          ask: LOST_ASK, askUnreadable: true, corrupt: true,
          startedAt: 0, updatedAt: 0, context: null, cycle: null, mod: null,
          task: null, done: [], failed: [], unknown: [], droppedActions: 0
        })
        continue
      }
      if (data?.schemaVersion !== SCHEMA_VERSION || data.runId !== runId) continue
      // Незнакомый статус — тоже неизвестный исход, а не «действия не было».
      // Файл мог остаться с версии, где статусов больше (или быть правленым
      // соседним процессом), и молча выбросить такое действие значило бы
      // разрешить продолжению повторить его вслепую.
      const known = new Set(['done', 'failed', 'denied'])
      const actions = (Array.isArray(data.actions) ? data.actions : []).map(item => ({
        tool: redactSecrets(String(item.tool || '')).slice(0, 80),
        target: redactSecrets(String(item.target || '')),
        status: item.status === 'started' ? 'unknown' : known.has(item.status) ? item.status : 'unknown'
      }))
      // Просьба, которую отпущенный код оставил без шифра: либо без метки, либо
      // с меткой `enc:v1:` над открытым текстом. При живом шифре перепечатываем
      // её на чтении; без шифра только читаем — файл не трогаем, чтобы не
      // затереть то, что открыть нечем.
      const plainAsk = plainUnderSeal(data.ask) ||
        (typeof data.ask === 'string' && !data.ask.startsWith(SEALED) ? data.ask : '')
      const task = resealPlainTask(data.task, seal)
      if (typeof protect === 'function' && (plainAsk || task)) {
        try {
          const migratedData = {
            ...data,
            ...(plainAsk ? { ask: seal(plainAsk) } : {}),
            ...(task ? { task } : {})
          }
          writeAtomic(runId, migratedData)
        } catch { /* migration best effort */ }
      }
      // null — зашифровано чужим ключом: это не пустая просьба, и карточка
      // должна сказать об этом, а не сделать вид, что просить было нечего.
      const ask = unseal(data.ask)
      runs.push({
        runId,
        chatId: data.chatId || null,
        designId: data.designId || null,
        surface: data.surface || 'chat',
        ask: ask === null ? LOST_ASK : ask,
        askUnreadable: ask === null,
        startedAt: Number(data.startedAt) || 0,
        updatedAt: Number(data.updatedAt) || 0,
        context: cleanRunContext(data.context),
        cycle: cleanCycle(data.cycle),
        mod: cleanMod(data.mod),
        task: cleanTaskState(unsealTask(data.task, unseal)),
        done: actions.filter(item => item.status === 'done'),
        failed: actions.filter(item => item.status === 'failed' || item.status === 'denied'),
        unknown: actions.filter(item => item.status === 'unknown'),
        droppedActions: Number(data.droppedActions) || 0
      })
    }
    return runs.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function dismiss(runId) {
    if (!RUN_ID.test(String(runId || ''))) return false
    try {
      fs.rmSync(fileOf(runId), { force: true })
      return true
    } catch {
      return false
    }
  }

  return Object.freeze({ start, interrupted, dismiss })
}

// Текст, которым человек продолжает оборванный ход. Модель получает не
// «повтори», а опись: что уже сделано, что не удалось и что надо сначала
// проверить.
function continuationPrompt(run, { wholeJob = null } = {}) {
  const line = item => `- ${item.tool}${item.target ? `: ${item.target}` : ''}`
  const parts = ['Продолжи работу, прерванную закрытием приложения.']
  if (run.askUnreadable) {
    parts.push('Исходная просьба не прочитана: не подошёл ключ профиля. Уточни её у человека, ' +
      'если перечисленного ниже не хватает; ничего не считай сделанным только по этой описи.')
  } else if (run.ask) parts.push(`Исходная просьба: «${run.ask}»`)
  if (run.done.length) parts.push('Уже сделано — не повторяй:\n' + run.done.map(line).join('\n'))
  if (run.unknown.length) {
    parts.push('Результат неизвестен — приложение закрылось во время этих действий. Сначала проверь, ' +
      'выполнились ли они (прочитай файл, посмотри состояние), и только потом решай, повторять ли:\n' +
      run.unknown.map(line).join('\n'))
  }
  if (run.failed.length) parts.push('Не удалось или отклонено:\n' + run.failed.map(line).join('\n'))
  const tokens = Number(run.context?.usage?.totalTokens) || 0
  if (tokens > 0) parts.push(`До закрытия предыдущий процесс учёл ${tokens} использованных токенов; не считай эту работу новой с нуля.`)
  const phase = run.context?.currentPhase
  if (phase) parts.push(`Последний сохранённый этап: ${phase}.`)
  // Бюджет общего цикла продолжается с остатка: попыток приёмки заново не
  // появляется, иначе «продолжить» после каждого падения удваивало бы цену хода.
  const cycle = run.cycle
  if (cycle) {
    // Остаток — от предела в LIMITS, а не от limit в файле. Файл переживает
    // версии программы и может быть поправлен соседним процессом; ровно так же
    // делает createCycle при восстановлении, чтобы опись и исполнение не
    // разошлись. wholeJob — единственный вход, который выбирает предел: его
    // передаёт вызывающий по тексту просьбы, а не запись на диске.
    const asWholeJob = wholeJob === true || (wholeJob === null && cycle.wholeJob === true)
    const limitOf = kind => (kind === 'reworks' ? (asWholeJob ? LIMITS.reworksWholeJob : LIMITS.reworks) : Number(LIMITS[kind]) || 0)
    const left = kind => {
      const limit = limitOf(kind)
      const used = Math.max(0, Math.min(Number(cycle.spent?.[kind]?.used) || 0, limit))
      return Math.max(0, limit - used)
    }
    const failed = (cycle.checks || []).filter(item => item.verdict === 'fail')
    const lines = [
      `Осталось попыток на этом ходе: доработка ${left('reworks')}, независимых проверок ${left('judge')}, кругов переделки ${left('rounds')}.`
    ]
    if (failed.length) {
      lines.push('Проверки, которые предыдущий процесс не сдал:\n' +
        failed.map(item => `- ${CHECK_LABELS[item.source] || item.source}: ${item.gaps.join('; ') || 'без пояснения'}`).join('\n'))
    }
    lines.push('Не трать попытки на то, что уже подтверждено списком выше; начни с непройденного.')
    parts.push(lines.join('\n'))
  }
  // Состояние задачи: что подтверждено приложением, что устарело и что ждёт.
  if (run.task?.requirements?.length) {
    const lost = run.task.requirements.filter(item => item.unreadable).length
    if (lost) {
      parts.push(`Состояние задачи прочитано не полностью: у ${lost} требований нет текста (не подошёл ключ профиля). ` +
        'Они остаются в остатке — проверь их заново, считать их сделанными нечем.')
    }
    const word = { not_started: 'не начато', in_progress: 'выполняется', verifying: 'проверяется (подтверждения ещё нет)',
      confirmed: 'подтверждено', stale: 'устарело — перепроверить', blocked: 'заблокировано', cancelled: 'отменено' }
    parts.push('Требования задачи:\n' + run.task.requirements.map(item =>
      `- [${word[item.state] || item.state}] ${item.expected}${item.criterion ? ` — проверка: ${item.criterion}` : ''}`).join('\n') +
      '\nПодтверждённое не переделывай без причины; «устарело» — перепроверь после изменений, «проверяется» — докажи проверкой.')
  }
  // Общий бюджет задачи (АГ-8, И-2): продолжение тратит остаток того же
  // бюджета, а не получает новый комплект. Неизвестный расход назван, а не ноль;
  // длительность запросов и общий срок показаны раздельно.
  const budget = run.task?.budget
  if (budget) {
    const limit = dim => budget.limits?.[dim] == null ? 'без предела' : String(budget.limits[dim])
    const unknown = budget.unknownUsage > 0 ? `, ${budget.unknownUsage} с неизвестным расходом` : ''
    const deadline = budget.deadlineAt == null ? 'без общего срока' : `до ${budget.deadlineAt}`
    parts.push(`Общий бюджет задачи: запросов ${budget.used.requests} из ${limit('requests')}, ` +
      `токенов ${budget.used.tokens} из ${limit('tokens')}${unknown}; время запросов ${budget.used.ms} мс; ` +
      `общий срок ${deadline}. Продолжение тратит этот же остаток.`)
  }
  if (run.task?.budgetCorrupt) {
    parts.push('Состояние бюджета задачи повреждено — продолжение не начнёт новый бюджет без явного решения.')
  }
  if (run.droppedActions) parts.push(`Ещё ${run.droppedActions} ранних действий в опись не вошли.`)
  return parts.join('\n\n')
}

module.exports = { createCheckpointStore, continuationPrompt, hasSideEffects, describeTarget, cleanRunContext, redactSecrets, READ_ONLY_TOOLS }
