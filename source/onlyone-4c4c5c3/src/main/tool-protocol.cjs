'use strict'

// Ответ инструмента — единственное, что модель узнаёт о последствиях своего
// действия. Пока он собирался прямо в цикле вызовов, у него было три способа
// соврать, и все три встречались вживую:
//
//   1. `JSON.stringify(undefined)` возвращает не строку, а undefined. Такой
//      ответ уходил в переписку полем content: undefined, и провайдер отвечал
//      отказом на весь запрос — то есть падал ход, а не один вызов.
//   2. Результат без поля success считался удачей. Инструмент, вернувший одну
//      строку ошибки, засчитывался как сделанная работа: и в журнале действий,
//      и в проверке завершённости, которая по этому журналу судит о делах.
//   3. Размер не ограничивался ничем. Чтение файла на два мегабайта целиком
//      ложилось в переписку, следующий запрос не влезал в окно, и ход
//      обрывался на ошибке про длину — вместо того чтобы прочитать кусок.
//
// Здесь всё это сведено в один слой: на входе — что угодно, на выходе — всегда
// корректный JSON с честным признаком успеха и известной длиной.

// Запас на один ответ инструмента. Не про экономию: за этой чертой ответ
// перестаёт помещаться в окно вместе с остальной перепиской, и обрезать его
// придётся всё равно — только уже вслепую и посреди хода.
const DEFAULT_RESULT_BUDGET = 40000

// Служебные поля результата, которые обрезать нельзя: по ним принимаются
// решения, и укороченное «Остановлено пол…» ничем не хуже целого, но
// укороченный признак успеха меняет смысл.
const KEEP_WHOLE = new Set(['success', 'denied', 'aborted', 'cancelled', 'path', 'tool', 'truncated', 'omitted', 'note'])

// Ошибка или удача — вопрос, на который у ответа должен быть явный ответ.
// Раньше его подменяли выражением `result?.success !== false`: и пустой ответ,
// и брошенное undefined проходили как успех.
function isFailure(value) {
  if (value === null || value === undefined) return true
  if (typeof value !== 'object') return false
  if (value.success === false) return true
  if (value.success === true) return false
  // Ни да ни нет. Тогда судим по содержимому: поле error значит ошибку.
  if (value.error) return true
  if (value.denied || value.aborted || value.cancelled) return true
  return false
}

// Приводит что угодно к результату с явным признаком успеха. Форма ответов
// самих инструментов не меняется — меняется только то, что цикл вызовов
// перестаёт угадывать её на глаз.
function normalizeToolResult(value, name = '') {
  const tool = String(name || '').slice(0, 60)

  if (value === undefined || value === null) {
    return {
      success: false,
      error: tool
        ? `Инструмент ${tool} завершился, не вернув результата. Действие не подтверждено — проверь состояние сам, прежде чем считать его сделанным.`
        : 'Инструмент завершился, не вернув результата. Действие не подтверждено.'
    }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return { success: true, result: value }
  }

  if (typeof value.success === 'boolean') return value
  return { ...value, success: !isFailure(value) }
}

// Результат для вызова, который не запускался, потому что ход остановили.
// Он обязан существовать: у каждого вызова в переписке должен быть ответ, иначе
// следующий запрос уходит с повисшим tool_calls и отвергается целиком.
function cancelledResult(name = '') {
  return {
    success: false,
    cancelled: true,
    error: `Вызов ${String(name || 'инструмента').slice(0, 60)} не запускался: ход остановлен пользователем. Ничего не изменилось.`
  }
}

// Длина строки в JSON-виде, с кавычками и экранированием. Резать по исходной
// длине нельзя: перевод строки занимает два знака, кавычка — два, кириллица
// остаётся одним, и промах в полтора раза здесь обычное дело.
function encodedLength(text) {
  return JSON.stringify(String(text)).length
}

// Обрезает строку так, чтобы её JSON-вид уложился в отведённое место. Двоичный
// поиск, потому что зависимость длины от числа знаков не линейна.
function fitString(text, budget) {
  const source = String(text)
  if (encodedLength(source) <= budget) return source
  let low = 0
  let high = source.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (encodedLength(source.slice(0, mid)) <= budget) low = mid
    else high = mid - 1
  }
  return source.slice(0, low)
}

// Собирает пары «путь к строковому полю → длина», от самой длинной к самой
// короткой. Резать надо то, что занимает место, а не то, что попалось первым.
function stringFields(value, prefix = [], out = [], seen = new Set()) {
  if (typeof value === 'string') {
    out.push({ path: prefix, length: value.length })
    return out
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return out
    seen.add(value)
    if (Array.isArray(value)) {
      value.forEach((item, index) => stringFields(item, [...prefix, index], out, seen))
      return out
    }
    for (const [key, item] of Object.entries(value)) {
      if (KEEP_WHOLE.has(key) && typeof item === 'string') continue
      stringFields(item, [...prefix, key], out, seen)
    }
  }
  return out
}

function readPath(root, path) {
  let node = root
  for (const key of path) node = node[key]
  return node
}

function writePath(root, path, value) {
  let node = root
  for (let i = 0; i < path.length - 1; i += 1) node = node[path[i]]
  node[path[path.length - 1]] = value
}

// Ответ инструмента в виде строки для переписки. Гарантий ровно две, и обе
// проверяются тестами: результат всегда разбирается обратно как JSON, и его
// длина всегда не больше запаса. Обрезанность не прячется — модель узнаёт о ней
// из самого ответа, а не по внезапно кончившемуся файлу.
function encodeToolResult(value, options = {}) {
  const budget = Number(options.budget) > 0 ? Number(options.budget) : DEFAULT_RESULT_BUDGET
  const normalized = normalizeToolResult(value, options.name)

  let text = safeStringify(normalized)
  if (text.length <= budget) return text

  // Копия: обрезать надо только то, что уходит модели. Сам результат ещё нужен
  // вызывающему коду целым — по нему считаются строки правок и признак успеха.
  let shrunk
  try {
    shrunk = JSON.parse(text)
  } catch {
    return safeStringify({
      success: normalized.success !== false,
      truncated: true,
      error: 'Результат не удалось передать целиком.'
    })
  }

  let omitted = 0
  // Пометка об обрезке — часть ответа и занимает место, поэтому она ставится
  // до подгонки, а не после. Иначе выходило так: строку урезали ровно под
  // предел, потом дописывали к ней объяснение, ответ снова не влезал — и от
  // него оставалась одна голая пометка без пути и без единой строки файла.
  const markTruncated = () => {
    if (!omitted) return
    shrunk.truncated = true
    shrunk.omitted = omitted
    shrunk.note = `Ответ длиннее допустимого, вырезано ${omitted} знаков. Это не весь результат: запрашивай нужную часть адресно — диапазоном строк, поиском, порциями.`
  }

  // Каждый заход режет самое длинное поле — то, что занимает место, а не то,
  // что попалось первым. Заходов немного: длина после каждого падает резко, и
  // сходится это за два-три круга.
  for (let pass = 0; pass < 8; pass += 1) {
    markTruncated()
    const current = safeStringify(shrunk)
    if (current.length <= budget) return current

    const field = stringFields(shrunk).sort((a, b) => b.length - a.length)[0]
    if (!field) break

    const original = String(readPath(shrunk, field.path))
    const allowance = Math.max(0, encodedLength(original) - (current.length - budget) - 24)
    const kept = fitString(original, allowance)
    if (kept.length === original.length) break
    omitted += original.length - kept.length
    writePath(shrunk, field.path, kept)
  }

  markTruncated()
  const out = safeStringify(shrunk)
  if (out.length <= budget) return out

  // Резать больше нечего, а места всё равно нет: столько занимают служебные
  // поля и сами имена ключей. Тогда от результата остаётся только его суть.
  return safeStringify({
    success: shrunk.success !== false,
    truncated: true,
    omitted: omitted || undefined,
    note: 'Результат слишком велик, чтобы передать его даже частями. Повтори вызов с более узкими границами.'
  })
}

// JSON.stringify умеет бросать — на циклической ссылке и на BigInt — и умеет
// возвращать не строку. И то и другое ниже по течению превращается в сломанный
// запрос, поэтому здесь оба случая кончаются честным ответом об ошибке.
function safeStringify(value) {
  try {
    const text = JSON.stringify(value)
    if (typeof text === 'string') return text
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: `Результат инструмента не удалось представить в JSON: ${String(error?.message || error).slice(0, 200)}`
    })
  }
  return JSON.stringify({ success: false, error: 'Результат инструмента не удалось представить в JSON.' })
}

// Где оборвались аргументы вызова. Модели полезно знать не то, что «пришло
// плохо», а какое поле не доехало: почти всегда это content или code, и ответ
// на это — не повторить то же самое, а резать запись на части.
function describeTruncatedArguments(raw) {
  const text = String(raw || '')
  let depth = 0
  let inString = false
  let escaped = false
  // Ключ верхнего уровня собирается только тогда, когда на него пришла очередь:
  // сразу после открывающей скобки и после каждой запятой. Значение при этом
  // может быть каким угодно, хоть объектом на пять уровней, — на счёт ключей
  // это не влияет, потому что запятые внутри него лежат на другой глубине.
  let awaitingKey = false
  let capturing = false
  let buffer = ''
  let lastKey = ''

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (inString) {
      if (escaped) { escaped = false; if (capturing) buffer += ch; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') {
        inString = false
        if (capturing) { lastKey = buffer; capturing = false }
        continue
      }
      if (capturing) buffer += ch
      continue
    }

    if (ch === '"') {
      inString = true
      if (depth === 1 && awaitingKey) { capturing = true; buffer = ''; awaitingKey = false }
      continue
    }
    if (ch === '{' || ch === '[') { depth += 1; if (depth === 1 && ch === '{') awaitingKey = true; continue }
    if (ch === '}' || ch === ']') { depth -= 1; continue }
    if (depth !== 1) continue
    if (ch === ':') { awaitingKey = false; continue }
    if (ch === ',') { awaitingKey = true; continue }
  }

  // Оборвалось на самом имени поля: называть предыдущее было бы враньём.
  if (capturing) return ''
  return lastKey.slice(0, 40)
}

// Аргументы вызова. Пустая строка — законный вызов без аргументов; всё
// остальное, что не разобралось, означает обрезанный вызов, а не пустой.
function parseToolArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, args: raw }
  if (Array.isArray(raw)) {
    return {
      ok: false,
      reason: 'shape',
      received: 0,
      field: '',
      message: 'Аргументы вызова пришли не объектом, поэтому инструмент не запускался. Передай аргументы объектом с именованными полями.'
    }
  }
  const text = typeof raw === 'string' ? raw : ''
  if (!text.trim()) return { ok: true, args: {} }

  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    const field = describeTruncatedArguments(text)
    return {
      ok: false,
      reason: 'truncated',
      received: text.length,
      field,
      message: `Аргументы вызова пришли обрезанными${field ? ` — оборвалось на поле «${field}»` : ''}, поэтому инструмент не запускался. ` +
        `Дошло ${text.length} знаков. Повтори вызов с более коротким аргументом: пиши файл по частям, читай диапазоном строк, не вкладывай большой текст в один вызов.`
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'shape',
      received: text.length,
      field: '',
      message: 'Аргументы вызова пришли не объектом, поэтому инструмент не запускался. Передай аргументы объектом с именованными полями.'
    }
  }

  return { ok: true, args: parsed }
}

// --- рамка ответа runner-а ------------------------------------------------------
// Свой инструмент исполняется в том же процессе, что и раннер, и пишет в тот же
// stdout. Пока родитель разбирал первый JSON в выводе, инструмент мог выдать
// `{"ok":true,"result":"..."}` раньше настоящего ответа и соврать о собственном
// успехе — проба 27.09.2026 воспроизвела это дословно. Рамка знает только
// раннер: что бы ни написал инструмент, ответом считается последняя строка,
// начатая этим знаком.
const RESULT_FRAME = '<<<ONLYONE-RESULT>>>'

// Одна строка, какой бы длины ни был ответ: переносы внутри текстов остаются
// экранированными JSON, иначе рамка перестанет быть признаком строки.
function frameResult (payload) {
  return `${RESULT_FRAME}${JSON.stringify(payload)}\n`
}

// Читает последний обрамлённый ответ; всего остального в выводе не существует.
// Битый JSON внутри рамки — отказ разбора, а не попытка угадать: угаданный
// успех хуже честной ошибки.
function readFramedResult (text) {
  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line.startsWith(RESULT_FRAME)) continue
    try {
      const parsed = JSON.parse(line.slice(RESULT_FRAME.length))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch { return null }
  }
  return null
}

module.exports = {
  DEFAULT_RESULT_BUDGET,
  isFailure,
  normalizeToolResult,
  cancelledResult,
  encodeToolResult,
  parseToolArguments,
  describeTruncatedArguments,
  RESULT_FRAME,
  frameResult,
  readFramedResult
}
