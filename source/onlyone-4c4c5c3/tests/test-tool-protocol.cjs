// Ответ инструмента — единственное, что модель узнаёт о последствиях действия.
// Здесь проверяется, что он не может соврать тремя способами, которые
// встречались вживую: превратиться в не-строку и уронить весь запрос, выдать
// ошибку за успех и вынести окно контекста целым файлом.
//
// Модуль настоящий, а не срисованный регулярками с исходника: он чистый, его
// можно вызвать и посмотреть, что он на самом деле делает.
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const {
  isFailure, normalizeToolResult, cancelledResult,
  encodeToolResult, parseToolArguments, describeTruncatedArguments,
  RESULT_FRAME, frameResult, readFramedResult
} = require('../src/main/tool-protocol.cjs')

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- ошибка и успех различаются явно -----------------------------------------

check('пустой результат — не успех', isFailure(undefined) && isFailure(null))
check('success: false — провал', isFailure({ success: false }))
check('success: true перевешивает поле error', !isFailure({ success: true, error: '' }))
check('ошибка без признака успеха считается ошибкой', isFailure({ error: 'нет такого файла' }))
check('отказ пользователя — не успех', isFailure({ denied: true, message: 'отклонено' }))
check('остановка — не успех', isFailure({ aborted: true }))
check('обычный результат — успех', !isFailure({ success: true, path: 'a.js' }))

// Это и есть та подмена, из-за которой инструмент, молча вернувший ничего,
// попадал в журнал действий как сделанная работа.
check('молчание инструмента становится явной ошибкой',
  normalizeToolResult(undefined, 'write_file').success === false)
check('в ошибке названо, какой инструмент промолчал',
  /write_file/.test(normalizeToolResult(undefined, 'write_file').error))
check('готовый признак успеха не переписывается',
  normalizeToolResult({ success: true, error: 'предупреждение' }).success === true)
check('строка от инструмента становится результатом',
  normalizeToolResult('готово').success === true && normalizeToolResult('готово').result === 'готово')

// --- отмена оставляет след ----------------------------------------------------

const cancelled = cancelledResult('run_command')
check('отменённый вызов — провал, а не успех', cancelled.success === false)
check('отменённый вызов помечен отменой', cancelled.cancelled === true)
check('модели сказано, что ничего не изменилось', /ничего не изменилось/i.test(cancelled.error))

// --- ответ всегда остаётся корректным JSON ------------------------------------

const alwaysParses = (value, options) => {
  const text = encodeToolResult(value, options)
  if (typeof text !== 'string') return false
  try { JSON.parse(text); return true } catch { return false }
}

check('undefined не превращается в не-строку', alwaysParses(undefined))
check('null разбирается обратно', alwaysParses(null))
check('число разбирается обратно', alwaysParses(42))

const circular = { success: true, name: 'цикл' }
circular.self = circular
check('циклическая ссылка не бросает исключение', alwaysParses(circular))
check('циклическая ссылка становится ошибкой',
  JSON.parse(encodeToolResult(circular)).success === false)

check('BigInt не роняет ход', alwaysParses({ success: true, size: BigInt(5) }))

// --- предел длины соблюдается, и об обрезке сказано ---------------------------

const huge = { success: true, path: 'src/main/main.js', content: 'а'.repeat(300000) }
const encoded = encodeToolResult(huge, { budget: 5000 })
check('длинный ответ укладывается в предел', encoded.length <= 5000, String(encoded.length))
check('обрезанный ответ остаётся JSON', (() => { try { JSON.parse(encoded); return true } catch { return false } })())

const back = JSON.parse(encoded)
check('обрезка не выдаётся за целый ответ', back.truncated === true)
check('сказано, сколько знаков потеряно', Number(back.omitted) > 0)
check('модели предложено читать частями', /частями|порциями|адресно/i.test(String(back.note)))
check('признак успеха переживает обрезку', back.success === true)
check('путь не режется вместе с содержимым', back.path === 'src/main/main.js')

// Кириллица в JSON занимает по шесть знаков на букву при экранировании — предел
// считается по закодированной длине, иначе промах кратный, а не на проценты.
const cyrillic = encodeToolResult({ success: true, text: 'ё'.repeat(50000) }, { budget: 4000 })
check('кириллица не выносит предел', cyrillic.length <= 4000, String(cyrillic.length))

// Несколько длинных полей: режется самое большое, а не первое попавшееся.
const twoFields = JSON.parse(encodeToolResult(
  { success: true, small: 'б'.repeat(200), big: 'в'.repeat(80000) }, { budget: 3000 }))
check('короткое поле уцелело', twoFields.small.length === 200, String(twoFields.small?.length))
check('длинное поле обрезано', twoFields.big.length < 80000)

// Вложенные строки тоже считаются: результат MCP приходит списком частей.
const nested = encodeToolResult(
  { success: true, result: { parts: ['г'.repeat(60000), 'д'.repeat(60000)] } }, { budget: 4000 })
check('вложенные строки тоже режутся', nested.length <= 4000, String(nested.length))
check('вложенный ответ остаётся JSON', (() => { try { JSON.parse(nested); return true } catch { return false } })())

const small = encodeToolResult({ success: true, path: 'a.js' })
check('короткий ответ не трогают', JSON.parse(small).truncated === undefined)

// --- аргументы вызова: пусто, обрезано и не объект — разные вещи ---------------

check('вызов без аргументов законен', parseToolArguments('').ok && parseToolArguments(undefined).ok)
check('пустые аргументы дают пустой объект',
  JSON.stringify(parseToolArguments('').args) === '{}')
check('нормальные аргументы проходят',
  parseToolArguments('{"path":"a.js"}').args.path === 'a.js')

const cut = parseToolArguments('{"path":"src/app.js","content":"начало текста')
check('обрезанные аргументы не выдаются за пустые', cut.ok === false)
check('обрезка названа обрезкой', cut.reason === 'truncated')
check('названо поле, на котором оборвалось', cut.field === 'content', cut.field)
check('в сообщении есть, сколько дошло', /\d+ знаков/.test(cut.message))
check('модели сказано, что делать', /по частям|диапазоном/i.test(cut.message))

const wrongShape = parseToolArguments('[1,2,3]')
check('массив вместо объекта — не аргументы', wrongShape.ok === false && wrongShape.reason === 'shape')
check('строка вместо объекта — не аргументы', parseToolArguments('"привет"').ok === false)

check('поле определяется и без обрезки значения',
  describeTruncatedArguments('{"path":"a.js","code":') === 'code',
  describeTruncatedArguments('{"path":"a.js","code":'))
check('вложенный объект не путает счёт полей',
  describeTruncatedArguments('{"opts":{"deep":"x"},"content":"нача') === 'content',
  describeTruncatedArguments('{"opts":{"deep":"x"},"content":"нача'))

// --- цикл вызовов пользуется всем этим ----------------------------------------

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

check('цикл разбирает аргументы через протокол', /parseToolArguments\(call\.function\?\.arguments\)/.test(main))
check('голого JSON.parse аргументов больше нет',
  !/JSON\.parse\(call\.function\?\.arguments \|\| '\{\}'\)/.test(main))
check('результат приводится к явному признаку успеха', /normalizeToolResult\(rawResult, toolName\)/.test(main))
// Снимок макета уходит в переписку картинкой отдельной репликой, а сама
// data-строка из ответа инструмента вырезается: два мегабайта base64 в тексте
// результата съели бы окно и ничего бы не показали.
check('ответ уходит через кодировщик', /content: encodeToolResult\(/.test(main))
check('снимок не едет текстом в ответе инструмента',
  /(?:shotUrl|shotUrl \|\| sheetUrl) \? \{ \.\.\.result, dataUrl: undefined(?:, sheetDataUrl: undefined)? \} : result/.test(main))
check('снимок показывается картинкой',
  /type: 'image_url', image_url: \{ url: shotUrl \}/.test(main))
check('модели без зрения говорят прямо',
  /не принимает изображения, поэтому снимок ты не увидела/.test(main))
check('голого stringify результата больше нет', !/content: JSON\.stringify\(result\)/.test(main))

// Отмена посреди цепочки вызовов раньше просто выходила из цикла, и в переписке
// оставался вызов без ответа. Такую переписку провайдер отвергает целиком:
// следующий запрос падал не на отмене, а на формате.
const loop = main.slice(main.indexOf('for (const call of stepResult.toolCalls)'),
  main.indexOf('if (payload.canAssign && assignmentsByRequest'))
check('отмена проверяется до запуска инструмента',
  loop.indexOf('signal?.aborted') < loop.indexOf('const result'))
check('отменённый вызов всё равно получает ответ',
  /cancelledResult\(toolName\)/.test(loop))
check('отмена больше не рвёт цепочку вызовов',
  !/if \(signal\?\.aborted\) break/.test(loop))

// --- рамка ответа ------------------------------------------------------------
// Свой инструмент пишет в тот же stdout, что и раннер, и проба 27.09 это
// воспроизвела: инструмент успевал выдать `{"ok":true,"result":"ФОРГА"}` раньше
// настоящего ответа, и главный процесс разбирал подделку. Отличить одно от
// другого можно только по рамке, которую знает раннер.
const FRAME = '<<<ONLYONE-RESULT>>>'
// Пока рамки в протоколе нет, каждая проверка обязана краснеть по существу, а не
// падать на `is not a function` и не проходить впустую на заглушке.
const hasFraming = typeof frameResult === 'function' && typeof readFramedResult === 'function'
const frame = hasFraming ? frameResult : () => ''
const readFrame = hasFraming ? readFramedResult : () => undefined
check('рамка ответа зафиксирована в протоколе', hasFraming && RESULT_FRAME === FRAME, String(RESULT_FRAME))
const framedLine = frame({ ok: true, result: { a: 1 } })
check('ответ раннера начинается с рамки и идёт одной строкой',
  hasFraming && framedLine.startsWith(FRAME) && framedLine.split('\n').filter(Boolean).length === 1,
  framedLine.slice(0, 60))
check('обрамлённый ответ читается обратно',
  hasFraming && JSON.stringify(readFrame(framedLine)) === JSON.stringify({ ok: true, result: { a: 1 } }))
check('подделанный ответ без рамки не принимается',
  hasFraming && readFrame('{"ok":true,"result":"ФОРГА"}\n') === null)
check('из вывода берётся последний обрамлённый ответ',
  hasFraming && JSON.stringify(readFrame(framedLine + frame({ ok: false, error: 'второй' })))
    === JSON.stringify({ ok: false, error: 'второй' }))
check('текст инструмента до рамки не мешает разбору',
  hasFraming && readFrame('обычная строка лога\n' + framedLine)?.ok === true)
check('битая рамка не роняет разбор', hasFraming && readFrame(FRAME + '{не json') === null)
check('ответ со строкой внутри строки остаётся одним рядом',
  hasFraming && readFrame(frame({ ok: true, result: 'первая\nвторая' }))?.result === 'первая\nвторая')

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
