// Every other test here is structural or stubbed. This one is the opposite: a
// real request to the real model with the real tool schema, to answer the only
// question the others cannot — does the agent loop actually cause a tool call?
//
// Ox Alpha taught this the hard way. Its catalogue entry advertised `tools`,
// every structural check passed, and with tools attached it returned an empty
// stream. Nothing short of asking the model would have caught that.
//
// Needs a key: set ONECODE_LIVE_KEY. Skipped without one, so `npm test` stays
// offline-friendly.

const KEY = process.env.ONECODE_LIVE_KEY
const MODEL = process.env.ONECODE_LIVE_MODEL || 'z-ai/glm-5.2:free'
const URL = 'https://openrouter.ai/api/v1/chat/completions'

if (!KEY) {
  console.log(JSON.stringify({ ok: true, skipped: 'нет ONECODE_LIVE_KEY — живой прогон пропущен' }))
  process.exit(0)
}

// The same shape the app sends: one file tool, described the same way.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Прочитать файл из рабочей папки.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Относительный путь к файлу.' } },
        required: ['path']
      }
    }
  }
]

async function ask(body) {
  const response = await fetch(URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://1code.local',
      'X-Title': '1code'
    },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  if (!response.ok) return { status: response.status, error: text.slice(0, 200) }
  return { status: 200, json: JSON.parse(text) }
}

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

async function main() {
  // 1. The model answers at all.
  // The budget has to cover thinking as well as the answer. At 40 tokens a
  // reasoning model spends the lot on reasoning and returns empty content —
  // which looks exactly like the failure this test exists to catch, and is not.
  const plain = await ask({
    model: MODEL,
    messages: [{ role: 'user', content: 'Ответь одним словом: готов' }],
    max_tokens: 600
  })
  check('модель отвечает', plain.status === 200, plain.error)
  if (plain.status !== 200) {
    console.log(JSON.stringify({ ok: false, failed }))
    process.exit(1)
  }

  const plainMessage = plain.json.choices?.[0]?.message || {}
  const plainText = plainMessage.content || ''
  const plainThought = plainMessage.reasoning || ''
  check('ответ не пустой', plainText.trim().length > 0,
    plainThought.trim()
      ? 'текста нет, но рассуждение есть — модель не уложилась в бюджет: ' + JSON.stringify(plainThought.slice(0, 80))
      : JSON.stringify(plainText))

  // 2. The decisive one: with tools attached, does it call one instead of
  //    describing what it would do? This is exactly where Ox Alpha died.
  const withTools = await ask({
    model: MODEL,
    messages: [
      { role: 'system', content: 'У тебя есть инструменты. Ты не описываешь действия — ты их выполняешь.' },
      { role: 'user', content: 'Прочитай файл README.md в рабочей папке.' }
    ],
    tools: TOOLS,
    tool_choice: 'auto',
    max_tokens: 800
  })
  check('с инструментами приходит ответ', withTools.status === 200, withTools.error)

  if (withTools.status === 200) {
    const message = withTools.json.choices?.[0]?.message || {}
    const calls = message.tool_calls || []

    check('поток не пустой при инструментах',
      Boolean((message.content || '').trim()) || calls.length > 0,
      'ни текста, ни вызовов — ровно симптом Ox Alpha')

    check('модель вызвала инструмент', calls.length > 0,
      'вместо вызова пришло: ' + JSON.stringify((message.content || '').slice(0, 120)))

    if (calls.length) {
      const call = calls[0]
      check('вызван именно read_file', call.function?.name === 'read_file', call.function?.name)
      let args = {}
      try { args = JSON.parse(call.function?.arguments || '{}') } catch {}
      check('аргументы разбираются как JSON', typeof args === 'object' && args !== null)
      check('в аргументах есть путь', typeof args.path === 'string' && args.path.length > 0,
        JSON.stringify(args))
    }

    check('счётчик токенов пришёл', Number(withTools.json.usage?.total_tokens) > 0,
      JSON.stringify(withTools.json.usage))
  }

  // 3. The fallback chain the app relies on: OpenRouter caps `models` at three,
  //    and a fourth is a 400. Worth knowing if that ever changes.
  const chain = await ask({
    model: MODEL,
    models: [MODEL, 'nvidia/nemotron-3-ultra-550b-a55b:free', 'cohere/north-mini-code:free'],
    messages: [{ role: 'user', content: 'скажи: ок' }],
    max_tokens: 20
  })
  check('цепочка из трёх моделей принимается', chain.status === 200, chain.error)

  console.log(JSON.stringify({ ok: failed === 0, failed, model: MODEL }))
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error('живой прогон упал:', error?.message || error)
  process.exit(1)
})
