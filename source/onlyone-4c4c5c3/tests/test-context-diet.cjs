// Расход токенов в ходе агента (В3-2): старые результаты инструментов не едут в каждом запросе.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const diet = require('../src/main/context-diet.cjs')

let failed = 0
function check(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) }
}

// Ход «проанализируй папку»: двадцать чтений по ~30 000 знаков, каждое — отдельный шаг.
function analysisTurn(steps) {
  const messages = [{ role: 'system', content: 'с'.repeat(6000) }, { role: 'user', content: 'проанализируй папку' }]
  const sent = []
  for (let i = 0; i < steps; i++) {
    sent.push(messages.slice())
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}.js` }) } }] })
    messages.push({ role: 'tool', tool_call_id: 'c' + i, content: JSON.stringify({ success: true, content: 'x'.repeat(30000) }) })
  }
  return sent
}

check('двадцать чтений: вход за ход падает больше чем втрое (и > 70% на 20 чтениях)', () => {
  const requests = analysisTurn(20)
  const full = requests.reduce((sum, m) => sum + diet.estimateTokens(m), 0)
  const lean = requests.reduce((sum, m) => sum + diet.estimateTokens(diet.pruneOldToolResults(m)), 0)
  const dropPct = (full - lean) / full * 100
  console.log(`   без свёртки ≈ ${full} токенов входа, со свёрткой ≈ ${lean} (${Math.round(dropPct)}% меньше)`)
  assert.ok(lean * 3 < full, `${lean} против ${full}`)

  // 20 чтений дают падение объёма более чем на 70% (фактически > 80%)
  const messagesWith20 = [{ role: 'system', content: 'с'.repeat(6000) }, { role: 'user', content: 'проанализируй папку' }]
  for (let i = 0; i < 20; i++) {
    messagesWith20.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}.js` }) } }] })
    messagesWith20.push({ role: 'tool', tool_call_id: 'c' + i, content: JSON.stringify({ success: true, content: 'x'.repeat(30000) }) })
  }
  const f20 = diet.estimateTokens(messagesWith20)
  const l20 = diet.estimateTokens(diet.pruneOldToolResults(messagesWith20))
  const drop20 = (f20 - l20) / f20 * 100
  assert.ok(drop20 > 70, `ожидалось > 70% экономии, получили ${drop20.toFixed(1)}%`)
})

check('последние три результата остаются целыми, старые — заглушка с началом', () => {
  const messages = analysisTurn(8).pop()
  const out = diet.pruneOldToolResults(messages)
  const tools = out.filter(m => m.role === 'tool')
  assert.equal(tools.length, 7)
  assert.ok(tools.slice(-3).every(m => m.content.length > 20000), 'свежие результаты обрезаны')
  assert.ok(tools.slice(0, -3).every(m => m.content.length < 2000), 'старые не свёрнуты')
  const stub = JSON.parse(tools[0].content)
  assert.equal(stub.pruned, true)
  assert.match(stub.note, /start_line/)
})

check('заглушка называет инструмент, цель и размер: модель знает, что перечитать', () => {
  const messages = analysisTurn(8).pop()
  const stub = JSON.parse(diet.pruneOldToolResults(messages).filter(m => m.role === 'tool')[0].content)
  assert.equal(stub.tool, 'read_file')
  assert.equal(stub.target, 'src/f0.js')
  assert.equal(stub.chars, JSON.stringify({ success: true, content: 'x'.repeat(30000) }).length)
  assert.ok(stub.head.length <= 400)
})

check('константы диеты: защитное окно 8000 токенов, порог свёртки 2000 токенов', () => {
  assert.equal(diet.PROTECT_TOKENS, 8000)
  assert.equal(diet.MIN_SAVING_TOKENS, 2000)
  assert.equal(diet.KEEP_RECENT_RESULTS, 3)
})

check('защитное окно считается в токенах: небольшие чтения до 8000 токенов остаются целыми', () => {
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
  for (let i = 0; i < 5; i++) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{"path":"f' + i + '"}' } }] })
    messages.push({ role: 'tool', tool_call_id: 'c' + i, content: 'y'.repeat(5000) })
  }
  // 5 чтений по 5000 знаков = 25000 знаков / 3.5 ≈ 7142 токенов <= 8000 токенов
  assert.equal(diet.pruneOldToolResults(messages), messages, 'чтения в пределах 8000 токенов — это окно, а не груз')
})

check('свёртка идёт, когда освободится >= 2000 токенов: 1 старое чтение в 30к знаков сворачивается, малое нет', () => {
  const messages = analysisTurn(5).pop()
  const out = diet.pruneOldToolResults(messages)
  const stubs = out.filter(m => m.role === 'tool' && /"pruned":true/.test(m.content)).length
  assert.equal(stubs, 1, '1 старое чтение по ~8,5 тыс. токенов освобождает >= 2000 токенов и сворачивается')

  // Старое чтение с экономией < 2000 токенов (например, 4000 знаков ≈ 1100 токенов) -> не сворачивается
  const smallOld = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'old', type: 'function', function: { name: 'read_file', arguments: '{"path":"old.js"}' } }] },
    { role: 'tool', tool_call_id: 'old', content: 'x'.repeat(4000) }
  ]
  for (let i = 0; i < 3; i++) {
    smallOld.push({ role: 'assistant', content: '', tool_calls: [{ id: 'r' + i, type: 'function', function: { name: 'read_file', arguments: '{"path":"f' + i + '"}' } }] })
    smallOld.push({ role: 'tool', tool_call_id: 'r' + i, content: 'x'.repeat(30000) })
  }
  assert.equal(diet.pruneOldToolResults(smallOld), smallOld, 'экономия < 2000 токенов недостаточна для свёртки')
})

check('свежий результат цел, даже когда он один больше защитного окна', () => {
  const messages = analysisTurn(6).pop()
  messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'big', type: 'function', function: { name: 'read_file', arguments: '{"path":"big.js"}' } }] })
  messages.push({ role: 'tool', tool_call_id: 'big', content: 'z'.repeat(120000) })
  const out = diet.pruneOldToolResults(messages)
  assert.equal(out[out.length - 1].content.length, 120000)
})

check('уже свёрнутое не меняется от шага к шагу: префикс запроса стабилен для кэша провайдера', () => {
  const requests = analysisTurn(12)
  const first = diet.pruneOldToolResults(requests[10])
  const next = diet.pruneOldToolResults(requests[11])
  const overlap = first.findIndex(m => m.role === 'tool' && !/"pruned":true/.test(m.content))
  assert.ok(overlap > 0)
  assert.equal(JSON.stringify(first.slice(0, overlap)), JSON.stringify(next.slice(0, overlap)))
})

check('исходная переписка не меняется', () => {
  const messages = analysisTurn(8).pop()
  const before = JSON.stringify(messages)
  diet.pruneOldToolResults(messages)
  assert.equal(JSON.stringify(messages), before)
})

check('связка вызов—результат цела: id и роли на месте', () => {
  const messages = analysisTurn(8).pop()
  const out = diet.pruneOldToolResults(messages)
  assert.equal(out.length, messages.length)
  out.forEach((m, i) => { assert.equal(m.role, messages[i].role); assert.equal(m.tool_call_id, messages[i].tool_call_id) })
})

check('длинные аргументы старых вызовов сворачиваются, короткие — нет', () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'y'.repeat(5000) }) } }] },
    { role: 'tool', tool_call_id: 'w', content: '{"success":true}' }
  ]
  for (let i = 0; i < 3; i++) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'r' + i, type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] })
    messages.push({ role: 'tool', tool_call_id: 'r' + i, content: '{"success":true}' })
  }
  const out = diet.pruneOldToolResults(messages, { minSavingTokens: 0 })
  const args = JSON.parse(out[1].tool_calls[0].function.arguments)
  assert.equal(args.path, 'a.txt')
  assert.match(args.content, /свёрнуто: 5000/)
  assert.equal(out[3].tool_calls[0].function.arguments, '{"path":"x"}')
})

check('кэш: метки для моделей Anthropic и Claude без префикса anthropic/', () => {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]

  const anthropic = diet.withPromptCache(messages, 'anthropic/claude-3-5-sonnet')
  assert.equal(anthropic[0].content[0].cache_control.type, 'ephemeral')
  assert.equal(anthropic[1].content[0].cache_control.type, 'ephemeral')

  const claudeBare = diet.withPromptCache(messages, 'claude-3-5-haiku')
  assert.equal(claudeBare[0].content[0].cache_control.type, 'ephemeral')
  assert.equal(claudeBare[1].content[0].cache_control.type, 'ephemeral')

  assert.equal(diet.withPromptCache(messages, 'openai/gpt-4o'), messages)
  assert.equal(diet.withPromptCache(messages, 'openai/gpt-6'), messages)
  assert.equal(messages[0].content, 'sys', 'исходное сообщение не тронуто')
})

check('подключено: провайдеру уходит копия, а не сама переписка', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
  assert.match(main, /messages: messagesForRequest\(messages, model\)/)
  assert.match(main, /require\('\.\/context-diet\.cjs'\)/)
})

if (failed) process.exit(1)
console.log('\nРасход токенов: проверки пройдены')
