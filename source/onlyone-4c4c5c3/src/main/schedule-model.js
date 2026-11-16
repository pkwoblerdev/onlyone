'use strict'

// Чистое ядро расписаний: отложенные и повторяющиеся задачи.
//
// Здесь нет ни Electron, ни диска, ни таймеров: только модель записи и арифметика
// часов. Такое разделение держится не для красоты — `nextAfter(record, nowMs)`
// обязана отвечать на вопрос «когда следующий запуск» по одному входному мгновению,
// иначе тесты смены дат, переходов зимнего/летнего времени и выхода из сна
// приходится писать через ожидание в реальном времени.
//
// Контракт и разбор возражений — в тестах модуля (`tests/test-schedule-model.cjs`).
// Мере́ние часов, на котором всё стоит, снято на Node этого окружения:
//   • «02:30 26.10.2025» в Берлине бывает дважды (00:30Z и 01:30Z) — время
//     неоднозначное;
//   • «02:30 29.03.2026» в Берлине нет ни в одном мгновении (01:00Z показывает
//     уже 03:00) — время несуществующее.
// Это два разных случая, и правило к ним разное: неоднозначное даёт ОДИН запуск
// на календарную дату (раннее из двух мгновений), несуществующее срабатывает в
// конце прыжка, а не пропускается молча.

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const KINDS = ['once', 'interval', 'daily', 'weekly', 'cron']
const MISFIRES = ['skip', 'run-once']
const ACTION_TYPES = ['agent-turn', 'command', 'note']
// Имена, которые становятся ключом карты или прототипом: `id` расписания
// попадает и в electron-store, и в индекс карты запусков. У подключений
// провайдера эта же ловушка уже была (`normalizeCustomProvider`).
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const ID_SHAPE = /^[A-Za-z0-9_-]{1,40}$/
const TIME_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/
// Смещение обязательно: без него «2026-04-01T07:30:00» читается то по UTC, то по
// локальному часовому поясу машины — и одно и то же расписание в разных окнах
// запускается в разное время.
const ONCE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
const EVERY_MIN = 1
const EVERY_MAX = 7 * 24 * 60
// Поиск по календарю ограничен: невозможная дата («30 февраля») должна честно
// вернуть null, а не съесть процесс. Окно обязано покрывать самый длинный законный
// разрыв cron — между 29 февраля через невисокосный век (2096→2104, 8 лет):
// с окном в 800 дней «29 февраля» умирало после високосного года, оставаясь
// «валидным» (break-4 Н12).
const MAX_DAYS = 3000
// Просьба/заметка/команда лежат в файле расписаний целиком, а файл перечитывается
// и перезаписывается на каждый шов журнала: без предела 50 расписаний по 200 КБ
// давали 20 МБ и 265 мс главного процесса на одну запись (break-4 Н14). Предел
// отвергает длину на проверке с понятной ошибкой, а не режет текст молча.
const ACTION_TEXT_LIMIT = 20000
// Секрет в записи расписания — это дыра: файл лежит в electron-store открытым
// текстом. Модель не принимает такие поля и не повторяет их значения в
// сообщениях (сообщение доходит до `lastError` и в журнал).
const SECRET_FIELDS = new Set(['key', 'token', 'apikey', 'api_key', 'secret', 'password',
  'passwd', 'pwd', 'authorization', 'authtoken', 'bearer', 'access_token'])

// Список допустимых поясов даёт сам движок: сверять регулярным выражением —
// значит принять «Europe/Berlinx». «UTC» в этом списке отсутствует (замер
// Node v24.21: 418 поясов, ни `UTC`, ни `Etc/UTC`), а поясом «UTC» пользуются,
// поэтому он добавлен явно.
const ZONES = new Set([...(typeof Intl?.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('timeZone') : []), 'UTC'])

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 }
]

// ---------------------------------------------------------------------------
// Часы пояса
// ---------------------------------------------------------------------------

const PARTS = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  minute: '2-digit', second: '2-digit', hour12: false }
const FORMATTERS = new Map()

function formatterFor(tz) {
  let dtf = FORMATTERS.get(tz)
  if (!dtf) {
    try { dtf = new Intl.DateTimeFormat('en-US', { ...PARTS, timeZone: tz }) }
    catch { dtf = null }
    FORMATTERS.set(tz, dtf)
  }
  return dtf
}

// Стенные часы пояса для абсолютного мгновения. `hourCycle: 'h23'` важен:
// без него `hour12: false` в части локалей отдаёт «24» вместо «00».
function wallParts(tz, ms) {
  const dtf = formatterFor(tz)
  if (!dtf) return null
  const at = {}
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') at[part.type] = part.value
  }
  const hour = Number(at.hour) % 24
  return { y: Number(at.year), mo: Number(at.month), d: Number(at.day),
    hh: hour, mi: Number(at.minute), ss: Number(at.second) }
}

function wallToEpoch(w) {
  return Date.UTC(w.y, w.mo - 1, w.d, w.hh, w.mi, w.ss)
}

// Смещение пояса в данном мгновении (мс, плюс — восток Гринвича).
function offsetAt(tz, ms) {
  const w = wallParts(tz, ms)
  return w ? wallToEpoch(w) - ms : 0
}

// Мгновение, соответствующее стенке `target` (дата и время, собранные как UTC)
// в поясе `tz`. Возвращает РАННЕЕ из мгновений, если стенка бывает дважды, и
// конец прыжка, если такой стенки нет.
function resolveWall(tz, target) {
  const offsets = new Set()
  for (const probe of [target - 12 * HOUR, target, target + 12 * HOUR]) offsets.add(offsetAt(tz, probe))
  const matches = []
  for (const off of offsets) {
    const ms = target - off
    const w = wallParts(tz, ms)
    if (w && wallToEpoch(w) === target) matches.push(ms)
  }
  if (matches.length) return Math.min(...matches)
  // Стенки нет: ищем момент, когда часы перепрыгнули через неё. Границы отсечки —
  // два кандидата, между которыми смещение различается. Шаг поиска — целая
  // секунда: переходы случаются на границе минуты, а дробные миллисекунды
  // сбивают сравнение смещения, потому что стена известна только до секунды.
  const sorted = [...offsets].sort((a, b) => a - b)
  let lo = target - sorted[sorted.length - 1]
  let hi = target - sorted[0]
  if (!(lo < hi)) return null
  const start = offsetAt(tz, lo)
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2 / 1000) * 1000
    if (mid <= lo || mid >= hi) break
    if (offsetAt(tz, mid) === start) lo = mid
    else hi = mid
  }
  return hi
}

function localDateOf(tz, ms) {
  const w = wallParts(tz, ms)
  return w ? { y: w.y, mo: w.mo, d: w.d } : null
}

// Следующий календарный день той же стены (31.01 → 01.02, 31.12 → 01.01).
function nextLocalDate(date) {
  const next = new Date(Date.UTC(date.y, date.mo - 1, date.d) + DAY)
  return { y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate() }
}

function weekdayOf(date) {
  return new Date(Date.UTC(date.y, date.mo - 1, date.d)).getUTCDay()
}

function parseTime(text) {
  const m = TIME_SHAPE.exec(String(text || ''))
  return m ? { hh: Number(m[1]), mi: Number(m[2]) } : null
}

// ---------------------------------------------------------------------------
// Разбор cron
// ---------------------------------------------------------------------------

// Поле: `*`, `a`, `a-b`, `*/s`, `a-b/s` и списки через запятую. День недели
// принимает 0-7, где 7 — то же воскресенье, что 0.
function parseCronField(field, text) {
  const values = new Set()
  for (const part of String(text).split(',')) {
    if (!part) return null
    const stepParts = part.split('/')
    if (!stepParts.length || stepParts.length > 2) return null
    if (stepParts.length === 2 && !/^\d+$/.test(stepParts[1])) return null
    const stride = stepParts.length === 2 ? Number(stepParts[1]) : 1
    if (stride < 1) return null
    const range = stepParts[0].trim()
    let from
    let to
    if (range === '*') {
      from = field.min
      to = field.max
    } else {
      const bounds = range.split('-')
      if (bounds.length > 2) return null
      if (!/^\d+$/.test(bounds[0])) return null
      from = Number(bounds[0])
      // Одиночное значение — это одно значение, а не «от него и до края поля»:
      // «0 0 * * 0» значит «в воскресенье», а не «во все дни недели».
      if (bounds.length === 2) {
        if (!/^\d+$/.test(bounds[1])) return null
        to = Number(bounds[1])
      } else to = from
    }
    if (from < field.min || to > field.max || to < from) return null
    for (let value = from; value <= to; value += stride) values.add(value)
  }
  if (!values.size) return null
  return [...values].sort((a, b) => a - b)
}

function parseCron(expression) {
  const text = String(expression == null ? '' : expression).trim()
  const parts = text.split(/\s+/)
  if (parts.length !== CRON_FIELDS.length) return null
  const parsed = {}
  for (let i = 0; i < CRON_FIELDS.length; i++) {
    const field = CRON_FIELDS[i]
    const values = parseCronField(field, parts[i])
    if (!values) return null
    parsed[field.name] = field.name === 'dayOfWeek'
      ? [...new Set(values.map(value => value === 7 ? 0 : value))].sort((a, b) => a - b)
      : values
  }
  return parsed
}

// Правило vixie cron: если ограничены и день месяца, и день недели, совпадением
// считается ЛЮБОЕ из них (интуитивно читается как «и», поэтому зафиксировано).
function cronDayMatches(parsed, date) {
  const domFull = parsed.dayOfMonth.length === 31
  const dowFull = parsed.dayOfWeek.length === 7
  const dom = parsed.dayOfMonth.includes(date.d)
  const dow = parsed.dayOfWeek.includes(weekdayOf(date))
  if (!domFull && !dowFull) return dom || dow
  if (!domFull) return dom
  if (!dowFull) return dow
  return true
}

// ---------------------------------------------------------------------------
// Проверка записи
// ---------------------------------------------------------------------------

function error(field, code, message) {
  return { field, code, message }
}

function validateSchedule(record) {
  const errors = []
  const add = (...args) => { errors.push(error(...args)) }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: [error('record', 'record_shape', 'Расписание должно быть объектом с полями вида, пояса и действия.')] }
  }
  // Пустая строка — это не «id не задан», а «id задан неверно»: имя будет
  // ключом карты запусков. Отсутствующее поле при этом правмерно: id даёт
  // хранилище, а не человек.
  const id = record.id
  if (id !== undefined && id !== null) {
    if (typeof id !== 'string' || !ID_SHAPE.test(id)) {
      add('id', 'id_shape', 'Имя записи должно быть 1-40 символов: латиница, цифры, «-» и «_», без точек.')
    } else if (RESERVED_IDS.has(id)) {
      add('id', 'id_reserved', 'Такое имя совпадает со служебным именем объекта и не может быть id записи.')
    }
  }
  if (record.name !== undefined && record.name !== null && typeof record.name !== 'string') {
    add('name', 'name_shape', 'Название расписания — текст, который выбрал человек.')
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    add('enabled', 'enabled_shape', 'Признак включения — да или нет.')
  }
  if (record.misfire !== undefined && !MISFIRES.includes(record.misfire)) {
    add('misfire', 'misfire_value', `Пропуск бывает только «${MISFIRES.join('» или «')}».`)
  }
  if (typeof record.timeZone !== 'string' || !ZONES.has(record.timeZone)) {
    add('timeZone', 'timezone_unknown', 'Часовой пояс должен быть известен системе (например, Europe/Berlin).')
  }
  if (!KINDS.includes(record.kind)) {
    add('kind', 'kind_value', 'Вид расписания должен быть одним из: ' + KINDS.join(', ') + '.')
  } else {
    validateKind(record, add)
  }
  validateAction(record.action, add)
  if (record.nextRunAt !== undefined && record.nextRunAt !== null && !Number.isFinite(record.nextRunAt)) {
    add('nextRunAt', 'next_at_shape', 'Время следующего запуска — число миллисекунд.')
  }
  if (record.lastRunAt !== undefined && record.lastRunAt !== null && !Number.isFinite(record.lastRunAt)) {
    add('lastRunAt', 'last_at_shape', 'Время последнего запуска — число миллисекунд.')
  }
  if (record.lastError !== undefined && record.lastError !== null && typeof record.lastError !== 'string') {
    add('lastError', 'last_error_shape', 'Причина отказа — текст.')
  }
  if (record.history !== undefined && !Array.isArray(record.history)) {
    add('history', 'history_shape', 'История запусков — список.')
  }
  return { ok: errors.length === 0, errors }
}

function validateKind(record, add) {
  switch (record.kind) {
    case 'once': {
      const at = record.once?.at
      if (typeof at !== 'string' || !ONCE_SHAPE.test(at) || !Number.isFinite(Date.parse(at))) {
        add('once.at', 'once_at_shape', 'Дата и время однократного запуска — ISO со смещением (например, 2026-04-01T07:30:00+02:00).')
      }
      break
    }
    case 'interval': {
      const every = record.interval?.everyMinutes
      if (!Number.isInteger(every) || every < EVERY_MIN || every > EVERY_MAX) {
        add('interval.everyMinutes', 'every_minutes_range', `Интервал — целое число минут от ${EVERY_MIN} до ${EVERY_MAX}.`)
      }
      const from = record.interval?.from
      // Отсчёт — целое число миллисекунд: огромное значение (например -1e300)
      // конечно, но схлопывает nextRunAt в 0 и крутит интервал без остановки (break-4 Н11).
      if (from !== undefined && from !== null && !Number.isSafeInteger(from)) {
        add('interval.from', 'interval_from_shape', 'Отсчёт интервала — целое число миллисекунд.')
      }
      break
    }
    case 'daily': {
      if (!parseTime(record.daily?.time)) {
        add('daily.time', 'time_shape', 'Время — часы и минуты в виде «07:30» (двузначные, от «00:00» до «23:59»).')
      }
      break
    }
    case 'weekly': {
      if (!parseTime(record.weekly?.time)) {
        add('weekly.time', 'time_shape', 'Время — часы и минуты в виде «07:30» (двузначные, от «00:00» до «23:59»).')
      }
      const days = record.weekly?.weekdays
      if (!Array.isArray(days) || !days.length) {
        add('weekly.weekdays', 'weekdays_empty', 'Нужен хотя бы один день недели: пустой список — не «каждый день».')
      } else if (days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
        add('weekly.weekdays', 'weekdays_range', 'Дни недели — целые числа от 0 (воскресенье) до 6.')
      }
      break
    }
    case 'cron': {
      if (!parseCron(record.cron?.expression)) {
        add('cron.expression', 'cron_bad', 'Расписание cron — пять полей: минуты, часы, день месяца, месяц, день недели.')
      }
      break
    }
    default: break
  }
}

function validateAction(action, add) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    add('action', 'action_shape', 'Расписание обязано говорить, что делать: заметка, ход агента или команда.')
    return
  }
  // Секретное поле ищется на любой глубине: `action.env.API_KEY` — та же дыра,
  // что корневой ключ (break-4 Н13). Обход итеративный с отметкой просмотренного:
  // циклический объект из окна не должен повесить главный процесс.
  const seen = new Set()
  const stack = [action]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    for (const [key, value] of Object.entries(node)) {
      if (SECRET_FIELDS.has(key.toLowerCase())) {
        add('action', 'action_secret_field', 'В расписании не может быть поля с секретом — файл настроек лежит открытым текстом.')
      }
      if (value && typeof value === 'object') stack.push(value)
    }
  }
  if (!ACTION_TYPES.includes(action.type)) {
    add('action.type', 'action_type_value', 'Действие бывает одного из трёх видов: ' + ACTION_TYPES.join(', ') + '.')
    return
  }
  if (action.type === 'agent-turn' && (typeof action.prompt !== 'string' || !action.prompt.trim())) {
    add('action.prompt', 'action_prompt_empty', 'Ходу агента нужен запрос — иначе запуск нечего выполнять.')
  }
  if (action.type === 'command' && (typeof action.command !== 'string' || !action.command.trim())) {
    add('action.command', 'action_command_empty', 'Команда не может быть пустой.')
  }
  if (action.type === 'note' && typeof action.text !== 'string') {
    add('action.text', 'action_text_shape', 'Заметка — это текст.')
  }
  for (const [field, value] of [['prompt', action.prompt], ['command', action.command], ['text', action.text]]) {
    if (typeof value === 'string' && value.length > ACTION_TEXT_LIMIT) {
      add(`action.${field}`, `action_${field}_long`,
        `Текст расписания — до ${ACTION_TEXT_LIMIT} знаков: файл расписаний читается целиком на каждый запуск, и длиннее окно замерзает.`)
    }
  }
}

// ---------------------------------------------------------------------------
// Следующий запуск
// ---------------------------------------------------------------------------

function nextInterval(record, nowMs) {
  const step = record.interval.everyMinutes * MINUTE
  const from = Number.isFinite(record.interval.from) ? record.interval.from
    : (Number.isFinite(record.createdAt) ? record.createdAt : nowMs)
  const lastRun = Number.isFinite(record.lastRunAt) ? record.lastRunAt : null
  const slots = Math.floor((nowMs - from) / step) + 1
  if (record.misfire === 'run-once') {
    // Догоняется ПОСЛЕДНИЙ пропущенный слот: самый ранний означал бы, что чистая
    // функция и дальше обязана выдавать пропуски, то есть ровно ту «очередь из
    // сорока догонов», которую контракт запрещает. Слот, который уже исполнен
    // (`lastRunAt`), не повторяется.
    const missed = from + Math.max(0, slots - 1) * step
    if (missed >= from && missed <= nowMs && (lastRun === null || missed > lastRun)) return missed
  }
  return from + Math.max(0, slots) * step
}

// Первый запуск календарного вида: идеём по локальным датам и берём первую
// стенку, которая ещё не прошла.
function nextCalendar(record, nowMs, times) {
  const tz = record.timeZone
  let date = localDateOf(tz, nowMs)
  if (!date) return null
  for (let day = 0; day <= MAX_DAYS; day++) {
    if (times.matches(date)) {
      for (const time of times.list) {
        const target = Date.UTC(date.y, date.mo - 1, date.d, time.hh, time.mi, 0)
        const at = resolveWall(tz, target)
        if (at !== null && at > nowMs) return at
      }
    }
    date = nextLocalDate(date)
  }
  return null
}

function nextAfter(record, nowMs) {
  if (!validateSchedule(record).ok) return null
  const now = Number.isFinite(nowMs) ? nowMs : NaN
  if (!Number.isFinite(now)) return null
  switch (record.kind) {
    case 'once': {
      const at = Date.parse(record.once.at)
      return at > now ? at : null
    }
    case 'interval': return nextInterval(record, now)
    case 'daily': return nextCalendar(record, now,
      { list: [parseTime(record.daily.time)], matches: () => true })
    case 'weekly': {
      const time = parseTime(record.weekly.time)
      const days = new Set(record.weekly.weekdays)
      return nextCalendar(record, now, { list: [time], matches: date => days.has(weekdayOf(date)) })
    }
    case 'cron': {
      const parsed = parseCron(record.cron.expression)
      const months = new Set(parsed.month)
      const list = []
      for (const hh of parsed.hour) for (const mi of parsed.minute) list.push({ hh, mi })
      return nextCalendar(record, now, {
        list,
        matches: date => months.has(date.mo) && cronDayMatches(parsed, date)
      })
    }
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Человекочитаемое описание
// ---------------------------------------------------------------------------

const WEEK_DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
const INVALID_TEXT = 'расписание настроено неверно'

function pad(value) { return String(value).padStart(2, '0') }

function formatWall(ms, tz) {
  const w = wallParts(tz, ms)
  if (!w) return null
  return `${pad(w.d)}.${pad(w.mo)}.${w.y} ${pad(w.hh)}:${pad(w.mi)}`
}

// Слова о следующем запуске видит человек, поэтому они переводятся: главный
// процесс приносит переводчик третьим параметром (см. `ui-text.cjs`), а без
// него текст остаётся русным — это исходный язык, и модуль по-прежнему не
// знает ни о словаре, ни о языке окна.
function describeNext(record, nowMs, say) {
  const t = typeof say === 'function' ? say : (template, ...args) => {
    let next = 0
    return String(template).replace(/%s/g, () => (next < args.length ? String(args[next++]) : '%s'))
  }
  const validation = validateSchedule(record)
  const at = validation.ok ? nextAfter(record, nowMs) : null
  if (!validation.ok || at === null) {
    if (validation.ok && at === null) {
      const tz = record.timeZone
      const now = Number.isFinite(nowMs) ? nowMs : 0
      const when = formatWall(now, tz)
      return when
        ? t('запуск уже прошёл (сейчас %s) — расписание больше не сработает', when)
        : t('запуск уже прошёл — расписание больше не сработает')
    }
    return t(INVALID_TEXT)
  }
  const tz = record.timeZone
  const when = formatWall(at, tz)
  const tail = when ? t('следующий — %s', when + ' (' + tz + ')') : t('следующий запуск не вычислен (%s)', tz)
  switch (record.kind) {
    case 'once': return t('однократно, %s', tail)
    case 'interval': return t('каждые %s мин, %s', record.interval.everyMinutes, tail)
    case 'daily': return t('ежедневно в %s, %s', record.daily.time, tail)
    case 'weekly': return t('по дням %s в %s, %s', record.weekly.weekdays.map(day => t(WEEK_DAYS[day])).join(', '), record.weekly.time, tail)
    case 'cron': return t('по расписанию «%s», %s', record.cron.expression, tail)
    default: return t(INVALID_TEXT)
  }
}

module.exports = { validateSchedule, parseCron, nextAfter, describeNext, KINDS, MISFIRES, ZONES, MAX_DAYS, ACTION_TEXT_LIMIT }
