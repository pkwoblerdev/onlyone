// A single agent turn grew to 918 200 tokens across thirty-nine tool calls, and
// the model refused it:
//
//   400 This endpoint's maximum context length is 1310720 tokens.
//       However, you requested about 1635639 tokens
//
// OpenRouter then moved to the next model in the chain — which is what a person
// sees as «модель почему-то заменилась». Measured on the same model: 533k tokens
// answered in 27 seconds without complaint, so the ceiling is real and far away,
// and a long investigation walks into it on its own.
//
// `sanitizeMessages` trims what arrives from the window, but the agent loop
// appends to that array as it works and nothing trimmed that. The fix is not to
// cut the turn short: it writes down what it has found and continues from the
// note in a fresh request. Dropping old results stays as the fallback for when
// the summary itself fails.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const start = src.indexOf('function roughTokens(text) {')
const end = src.indexOf('// What the turn has established so far')
if (start < 0 || end < 0) throw new Error('функции подгонки под модель не найдены')

// eslint-disable-next-line no-new-func
// `requestedMaxTokens` lives beside applyModelParams: the budget and the request
// have to agree on how long an answer we ask for, and when they did not the
// budget reserved room for an answer nobody was going to request.
// ANSWER_TOKENS reads `app.isPackaged` — the end-to-end run may force the cap
// down to prove a cut-off answer gets picked up. A packaged app keeps it real.
const api = new Function('findModelRecord', 'app',
  src.slice(src.indexOf('const ANSWER_TOKENS'), src.indexOf('\nfunction applyModelParams')) +
  src.slice(start, end) +
  '\nreturn { roughTokens, messagesRoughTokens, modelBudget, fitsInModel, fitMessagesToModel, requestedMaxTokens }'
)(id => ({
  id,
  contextLength: id === 'small/model' ? 32000 : 1310720,
  maxCompletionTokens: 32768
}), { isPackaged: true })

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const turn = (results, size) => {
  const out = [
    { role: 'system', content: 'инструкция агента' },
    { role: 'user', content: 'разбери приложение' }
  ]
  for (let i = 0; i < results; i++) {
    out.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }]
    })
    out.push({ role: 'tool', tool_call_id: 'c' + i, content: 'x'.repeat(size) })
  }
  return out
}

// --- the budget --------------------------------------------------------------

const budget = api.modelBudget('z-ai/glm-5.3-flash')
check('бюджет меньше окна модели', budget < 1310720, String(budget))
check('в бюджете оставлено место под ответ',
  budget <= 1310720 - 32768, String(budget))
check('у маленькой модели бюджет меньше',
  api.modelBudget('small/model') < budget)
check('бюджет никогда не отрицательный',
  api.modelBudget('small/model') >= 8000, String(api.modelBudget('small/model')))

// --- when a turn stops fitting ----------------------------------------------

check('короткий ход помещается', api.fitsInModel(turn(2, 500), 'm', 32768))
check('ход из сорока чтений по 200 КБ — нет',
  !api.fitsInModel(turn(25, 200000), 'm', 32768))

// --- the fallback, when the summary itself fails -----------------------------

const huge = turn(25, 200000)
const before = api.messagesRoughTokens(huge)
const fitted = api.fitMessagesToModel(huge, 'm')
const after = api.messagesRoughTokens(fitted.messages)

check('подрезка уменьшает ход', after < before, `${before} -> ${after}`)
check('и доводит его до бюджета', after <= budget, String(after))
check('что-то действительно свёрнуто', fitted.dropped > 0, String(fitted.dropped))
check('свёрнуто не больше нужного', fitted.dropped < 25, String(fitted.dropped))

check('системная инструкция не тронута',
  fitted.messages[0].content === 'инструкция агента')
check('задача пользователя не тронута',
  fitted.messages[1].content === 'разбери приложение')

// The freshest work is what the model is acting on — it must survive.
const tail = fitted.messages.slice(-4)
check('свежие результаты целы',
  tail.some(m => m.role === 'tool' && m.content.length > 1000),
  tail.map(m => `${m.role}:${String(m.content).length}`).join(' '))

// A collapsed result still says it happened, and how big it was, so the model can
// tell the difference between "never read" and "read, contents dropped".
const collapsed = fitted.messages.find(m => m.role === 'tool' && /отброшен/.test(m.content || ''))
check('свёрнутый результат объясняет себя', Boolean(collapsed), 'не нашёлся')
check('и называет свой прежний размер',
  collapsed && /\d+ токенов/.test(collapsed.content), collapsed?.content)
check('идентификатор вызова сохраняется',
  collapsed && typeof collapsed.tool_call_id === 'string' && collapsed.tool_call_id,
  JSON.stringify(collapsed?.tool_call_id))

// Nothing to do on a turn that already fits.
const small = turn(2, 500)
check('помещающийся ход не трогают', api.fitMessagesToModel(small, 'm').dropped === 0)

// --- summarise and continue is the primary path ------------------------------

check('сводка запрашивается у той же модели',
  /async function summariseTurnSoFar\(messages, model, signal, preferredKeyId, observation = \{\}\)/.test(src))
check('сводке велено не выдумывать',
  /Ничего не выдумывай — только то, что действительно видел/.test(src))
check('в сводке просят имена файлов и строки',
  /с именами и строками/.test(src))
check('ход перезапускается с задачи и сводки',
  /messages\.length = 1[\s\S]{0,200}originalTask/.test(src))
check('модели сказано не начинать сначала',
  /Не начинай сначала и не перечитывай/.test(src))
check('подрезка остаётся запасным путём',
  /сводка не получилась — свернул/.test(src))
check('в окне видно, что ход перерос модель',
  /ход перерос модель — сворачиваю найденное и продолжаю с него/.test(src))

// --- сворачивание до предела, а не на пределе -------------------------------
// Every step re-sends the whole conversation, so a 64KB read at step five is paid
// for again at every step after it. That, not any single request, is where a
// turn's token count comes from: 918k was the sum over twenty-three steps, not
// one request of 918k. So the oldest results are folded once the turn passes half
// its budget, rather than waiting for the ceiling.
const halfway = api.fitMessagesToModel(turn(25, 200000), 'm', { target: 0.5 })
const full = api.fitMessagesToModel(turn(25, 200000), 'm', 32768)

check('до половины бюджета сворачивается больше',
  halfway.dropped > full.dropped, `${halfway.dropped} против ${full.dropped}`)
check('и результат действительно меньше половины',
  api.messagesRoughTokens(halfway.messages) <= budget / 2,
  String(api.messagesRoughTokens(halfway.messages)))
check('свежие результаты целы и при раннем сворачивании',
  halfway.messages.slice(-4).some(m => m.role === 'tool' && m.content.length > 1000))
check('системная инструкция цела и при раннем сворачивании',
  halfway.messages[0].content === 'инструкция агента')

check('раннее сворачивание включено в цикле',
  /messagesRoughTokens\(messages\) > modelBudget\(model\) \/ 2/.test(src))
check('пользователю объясняют, почему свернули',
  /они пересылались на каждом шаге/.test(src))

// --- сколько места остаётся под переписку -----------------------------------
// The budget reserves room for the answer by subtracting the output limit from
// the window. It used to subtract the model's *maximum possible* output — 460 800
// for the default model — while the app asks for 32 768. The result: a 512 000
// window gave a 25 600 budget, folding began at 12 800, and any real conversation
// restarted itself from a summary half-way through.
check('просим столько, сколько шлём, а не потолок модели',
  api.requestedMaxTokens({ maxCompletionTokens: 460800 }) === 32768,
  String(api.requestedMaxTokens({ maxCompletionTokens: 460800 })))
check('модель со скромным потолком не просит больше него',
  api.requestedMaxTokens({ maxCompletionTokens: 8000 }) === 8000)
check('модель без объявленного потолка всё равно получает лимит',
  api.requestedMaxTokens({}) === 32768,
  'иначе действует умолчание провайдера, а оно бывает в тысячу токенов')

// The number that matters: room left for the conversation itself.
const bigWindow = api.modelBudget('z-ai/glm-5.3-flash')
check('бюджет — почти всё окно, а не малая доля',
  bigWindow > 1310720 * 0.9, String(bigWindow))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
