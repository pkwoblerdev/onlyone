// «Provider returned error 400 bad request» in the middle of a turn, right after
// a custom tool and a file write. The turn died and the reader got a raw JSON
// blob instead of an answer.
//
// Measured against the provider directly, exactly one shape is refused:
//
//     400 messages.2.content: Invalid input
//
// — content that is an object instead of a string. Everything else was accepted:
// an empty tool id, mismatched ids, a tool_call left with no answer at all,
// binary bytes, control characters, a lone surrogate, a missing content field,
// null, and a 400 KB result. Only the wrong type is rejected.
//
// `sanitizeMessages` coerces content on the way in, but the agent loop appends to
// that array afterwards — tool results, assistant turns — and nothing checked
// those. So the check sits where the request leaves, because there are several
// message builders and one of them will be missed again.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const start = src.indexOf('function normalizeOutgoingMessages(messages) {')
const end = src.indexOf('async function openRouterRequest(')
if (start < 0 || end < 0) throw new Error('normalizeOutgoingMessages не найдена')

// eslint-disable-next-line no-new-func
const normalize = new Function(src.slice(start, end) + '\nreturn normalizeOutgoingMessages')()

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}
const one = message => normalize([message])[0]

// The shape that was killing turns.
const fromTool = one({ role: 'tool', tool_call_id: 'c1', content: { success: true, path: 'a.md' } })
check('объект превращается в строку', typeof fromTool.content === 'string', typeof fromTool.content)
check('содержимое объекта не теряется',
  fromTool.content.includes('a.md'), fromTool.content)
check('роль и идентификатор вызова на месте',
  fromTool.role === 'tool' && fromTool.tool_call_id === 'c1', JSON.stringify(fromTool))

// A tool that returned nothing at all.
check('undefined становится пустой строкой',
  one({ role: 'tool', content: undefined }).content === '')
check('null становится пустой строкой',
  one({ role: 'tool', content: null }).content === '')

// A multimodal turn is an array of parts and must survive untouched — flattening
// it would silently drop every attachment the user added.
const parts = [{ type: 'text', text: 'что на картинке' }, { type: 'image_url', image_url: { url: 'data:...' } }]
const multimodal = one({ role: 'user', content: parts })
check('массив частей проходит как есть', Array.isArray(multimodal.content))
check('части не переставлены и не потеряны',
  multimodal.content.length === 2 && multimodal.content[1].type === 'image_url',
  JSON.stringify(multimodal.content).slice(0, 80))

// Ordinary strings are returned unchanged, and by identity — no needless copying
// of a forty-message history on every request.
const plain = { role: 'user', content: 'привет' }
check('строка не трогается', one(plain) === plain)

// Numbers and other primitives still have to become text.
check('число становится строкой', one({ role: 'tool', content: 42 }).content === '42')

// tool_calls must survive: they are what the tool results answer.
const withCalls = one({
  role: 'assistant',
  content: { odd: true },
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
})
check('вызовы инструментов сохраняются',
  Array.isArray(withCalls.tool_calls) && withCalls.tool_calls[0].id === 'c1',
  JSON.stringify(withCalls.tool_calls))

// Rubbish in the list must not throw — this runs on every single request.
check('не падает на мусоре', Array.isArray(normalize([null, undefined, 'строка', 7])))
check('не падает на не-массиве', normalize(null) === null)

// A value JSON cannot serialise still has to come out as text rather than throw.
const circular = { name: 'петля' }
circular.self = circular
check('циклическая ссылка не роняет запрос',
  typeof one({ role: 'tool', content: circular }).content === 'string')

// And the guard has to be wired into the request itself, not left for callers.
check('проверка стоит в самом запросе',
  /async function openRouterRequest\([\s\S]{0,400}normalizeOutgoingMessages\(body\.messages\)/.test(src))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
