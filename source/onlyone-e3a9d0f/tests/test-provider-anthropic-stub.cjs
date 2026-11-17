// Уровень модуля-адаптера `src/main/providers/anthropic-messages.js` против
// локальной HTTP-заглушки, которая говорит нативным диалектом Anthropic
// (план, каталог провайдеров 25.09).
//
// Проверяется перевод в обе стороны: что реально уходит на `/v1/messages` и во
// что превращается ответ сервера. Никакого Electron'а, никаких сетей наружу,
// ключ фейковый и только латиницей.
'use strict'
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')

const PROVIDER_PATH = process.env.ONECODE_ANTHROPIC_UNDER_TEST
  ? path.resolve(process.env.ONECODE_ANTHROPIC_UNDER_TEST)
  : path.join(__dirname, '..', 'src', 'main', 'providers', 'anthropic-messages.js')
const anthropic = require(PROVIDER_PATH)
const registry = require('../src/main/providers')

const KEY = 'sk-ant-TEST-9f3c1a7b2e4d'

// Поток Anthropic: у каждого кадра пара `event:` + `data:`, как это делает
// настоящий сервер — разбор не должен держаться на догадке о форме.
function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function messageStart(model = 'claude-тест-1') {
  return ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant',
    model, content: [], usage: { input_tokens: 11, output_tokens: 0 } } }]
}

function startStub() {
  const seen = []
  const state = {
    status: 200,
    errorBody: '',
    completion: () => sse([
      messageStart(),
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Привет ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'из потока' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
      ['message_stop', { type: 'message_stop' }]
    ]),
    jsonBody: () => JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-тест-1',
      content: [{ type: 'text', text: 'обычный ответ' }], stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 5 } }),
    modelsStatus: 200,
    models: () => JSON.stringify({ data: [{ type: 'model', id: 'claude-тест-1', display_name: 'Тестовая модель',
      capabilities: { tools: true } }], has_more: false })
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('error', () => {})
    res.on('error', () => {})
    req.on('end', () => {
      let body = null
      try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
      seen.push({ url: req.url, method: req.method, headers: req.headers, body, raw })
      try {
        if (req.url.endsWith('/models')) {
          res.writeHead(state.modelsStatus, { 'Content-Type': 'application/json' })
          res.end(state.models())
          return
        }
        if (state.status !== 200) {
          res.writeHead(state.status, { 'Content-Type': 'application/json' })
          res.end(state.errorBody)
          return
        }
        if (body && body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end(state.completion())
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(state.jsonBody())
      } catch {
        // клиент уже отошёл
      }
    })
  })
  server.on('clientError', () => {})
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, seen, state, origin: `http://127.0.0.1:${server.address().port}` })
  }))
}

// Разбор потока ровно так, как его делает цикл агента: только строки `data: `,
// [DONE] как конец, дельты инструментов склеиваются по index.
function parseSse(text) {
  let content = ''
  let reasoning = ''
  let done = false
  let finish = null
  let usage = null
  let model = null
  const frames = []
  const calls = new Map()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') { done = true; continue }
    const frame = JSON.parse(payload)
    frames.push(frame)
    if (frame.usage) usage = frame.usage
    if (frame.model) model = frame.model
    const choice = frame.choices?.[0]
    if (!choice) continue
    content += choice.delta?.content || ''
    reasoning += choice.delta?.reasoning || ''
    for (const call of choice.delta?.tool_calls || []) {
      const prev = calls.get(call.index) || { id: '', name: '', args: '' }
      calls.set(call.index, {
        id: prev.id || call.id || '',
        name: prev.name + (call.function?.name || ''),
        args: prev.args + (call.function?.arguments || '')
      })
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  return { content, reasoning, done, finish, usage, model, frames, calls: [...calls.values()] }
}

function withDeadline(promise, ms = 5000) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`зависание: нет результата за ${ms} мс`)), ms) })
  ])
}

let checks = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    checks++
    console.log('ok', name)
  } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', String(error && error.message || error))
  }
}

async function runChecks() {
  const stub = await startStub()
  const base = `${stub.origin}/v1`
  const adapter = anthropic.create({ baseUrl: base, apiKey: KEY, model: 'claude-тест-1' })
  const last = () => stub.seen[stub.seen.length - 1]

  // --- 1. Проводка запроса --------------------------------------------------
  await check('POST уходит на /v1/messages, а не на openai-путь', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions',
      body: { model: 'claude-тест-1', messages: [{ role: 'user', content: 'привет' }] } }))
    assert.equal(last().url, '/v1/messages', `адрес ушёл на ${last().url}`)
    assert.equal(last().method, 'POST')
  })

  await check('заголовки Anthropic: x-api-key и anthropic-version, чужих заголовков нет', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions',
      body: { model: 'claude-тест-1', messages: [{ role: 'user', content: 'привет' }] } }))
    const headers = last().headers
    assert.equal(headers['x-api-key'], KEY)
    assert.equal(headers['anthropic-version'], '2023-06-01')
    assert.equal(headers.authorization, undefined, 'уехал чужой способ авторизации')
    for (const name of Object.keys(headers)) {
      assert.ok(!/referer|x-title|openrouter/i.test(name), `на Anthropic уехал заголовок «${name}»`)
    }
  })

  await check('системные сообщения собираются в поле system, а не в переписку', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1', messages: [
      { role: 'system', content: 'Правило первое.' },
      { role: 'developer', content: 'Правило второе.' },
      { role: 'user', content: 'привет' }
    ] } }))
    const body = last().body
    assert.equal(body.system, 'Правило первое.\n\nПравило второе.')
    assert.deepEqual(body.messages.map(m => m.role), ['user'])
  })

  await check('роль tool превращается в tool_result, вызов модели — в tool_use', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1', messages: [
      { role: 'user', content: 'посмотри файл' },
      { role: 'assistant', content: 'сейчас', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'содержимое' }
    ] } }))
    const messages = last().body.messages
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user'])
    const use = messages[1].content.find(block => block.type === 'tool_use')
    assert.equal(use.id, 'call_1')
    assert.equal(use.name, 'read_file')
    assert.deepEqual(use.input, { path: 'a.txt' })
    const result = messages[2].content.find(block => block.type === 'tool_result')
    assert.equal(result.tool_use_id, 'call_1')
    assert.equal(result.content, 'содержимое')
  })

  await check('два хода одного участника склеиваются: чередование ролей не ломается', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1', messages: [
      { role: 'user', content: 'раз' }, { role: 'user', content: 'два' },
      { role: 'assistant', content: 'ok', tool_calls: [
        { id: 'call_9', function: { name: 'run_command', arguments: '{}' } },
        { id: 'call_10', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: 'а' },
      { role: 'tool', tool_call_id: 'call_10', content: 'б' }
    ] } }))
    const messages = last().body.messages
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user'],
      `роли не чередуются: ${messages.map(m => m.role).join(',')}`)
    assert.equal(messages[0].content.length, 2)
    assert.deepEqual(messages[2].content.map(b => b.tool_use_id), ['call_9', 'call_10'])
  })

  await check('пустой вывод инструмента не сочиняется: уходит пробел, а не текст от адаптера', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1', messages: [
      { role: 'user', content: 'молчи' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'run_command', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '' }
    ] } }))
    const blocks = last().body.messages.flatMap(m => m.content)
    const result = blocks.find(block => block.type === 'tool_result')
    assert.equal(result.content, ' ')
  })

  await check('max_tokens всегда в теле: без него Messages API отказывает', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1', messages: [
      { role: 'user', content: 'привет' }] } }))
    assert.equal(last().body.max_tokens, anthropic.DEFAULT_MAX_TOKENS)
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      max_tokens: 999999, messages: [{ role: 'user', content: 'привет' }] } }))
    assert.ok(last().body.max_tokens <= 64000, 'поток потолка не собран')
  })

  await check('tools переводятся в input_schema, tool_choice — в форму Anthropic', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', messages: [{ role: 'user', content: 'привет' }],
      tools: [{ type: 'function', function: { name: 'run_command', description: 'выполнить',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
      tool_choice: { type: 'function', function: { name: 'run_command' } }
    } }))
    const tool = last().body.tools[0]
    assert.equal(tool.name, 'run_command')
    assert.equal(tool.input_schema.properties.cmd.type, 'string')
    assert.deepEqual(tool.tool, undefined)
    assert.deepEqual(last().body.tool_choice, { type: 'tool', name: 'run_command' })
  })

  await check('tool_choice по имени, которого нет в теле, не улетает отказом: уходит auto', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', messages: [{ role: 'user', content: 'привет' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
      tool_choice: { type: 'function', function: { name: 'нет-такого' } }
    } }))
    assert.deepEqual(last().body.tool_choice, { type: 'auto' })
  })

  await check('openai-only поля не уходят на сервер и называются вызывающему', async () => {
    const dropped = []
    const watcher = anthropic.create({ baseUrl: base, apiKey: KEY, model: 'claude-тест-1',
      onUnsupported: fields => dropped.push(...fields) })
    await withDeadline(watcher.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', messages: [{ role: 'user', content: 'привет' }],
      models: ['запасная'], plugins: ['file-parser'], response_format: { type: 'json_object' }, seed: 7
    } }))
    const body = last().body
    for (const field of ['models', 'plugins', 'response_format', 'seed']) {
      assert.ok(!(field in body), `поле «${field}» уехало на сервер`)
    }
    assert.ok(dropped.includes('models') && dropped.includes('plugins') && dropped.includes('seed'),
      `вызывающему не назвали: ${dropped.join(', ')}`)
  })

  await check('temperature за пределами диапазона прижимается, а не уходит отказом', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      temperature: 2, messages: [{ role: 'user', content: 'привет' }] } }))
    assert.equal(last().body.temperature, 1)
  })

  await check('просьба порассуждать становится thinking с бюджетом; температура при этом 1', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      temperature: 0.2, reasoning: { effort: 'high' },
      messages: [{ role: 'user', content: 'подумай' }] } }))
    const body = last().body
    assert.equal(body.thinking.type, 'enabled')
    assert.ok(body.thinking.budget_tokens >= 1024, 'бюджет меньше минимального для Anthropic')
    assert.ok(body.thinking.budget_tokens < body.max_tokens, 'бюджет съел весь ответ')
    assert.equal(body.temperature, 1)
  })

  await check('пустая переписка не превращается в запрос к модели', async () => {
    await assert.rejects(() => adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      messages: [] } }), /не нашёл ни одного сообщения/)
  })

  // --- 2. Поток в openai-вид ------------------------------------------------
  await check('поток: текст собирается дельтами, конец помечен [DONE] и finish_reason', async () => {
    const response = await withDeadline(adapter.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', stream: true, messages: [{ role: 'user', content: 'привет' }] } }))
    assert.equal(last().body.stream, true, 'просьба о потоке до сервера не дошла')
    const parsed = parseSse(await response.text())
    assert.equal(parsed.content, 'Привет из потока')
    assert.equal(parsed.done, true)
    assert.equal(parsed.finish, 'stop')
    assert.equal(parsed.model, 'claude-тест-1')
    assert.deepEqual(parsed.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })
    assert.ok(parsed.frames.every(frame => frame.object === 'chat.completion.chunk'),
      'кадры не похожи на openai-чани')
  })

  await check('поток: вызов инструмента приходит именем одним кадром и аргументами по частям', async () => {
    stub.state.completion = () => sse([
      messageStart(),
      ['content_block_start', { type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }],
      ['message_stop', { type: 'message_stop' }]
    ])
    const response = await withDeadline(adapter.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', stream: true, messages: [{ role: 'user', content: 'файл' }] } }))
    const parsed = parseSse(await response.text())
    assert.equal(parsed.calls.length, 1)
    assert.equal(parsed.calls[0].id, 'toolu_1')
    assert.equal(parsed.calls[0].name, 'read_file')
    assert.equal(parsed.calls[0].args, '{"path":"a.txt"}')
    assert.equal(parsed.finish, 'tool_calls', 'вызов инструмента не назван tool_calls')
    assert.equal(parsed.content, '', 'из аргументов не должен собираться текст ответа')
  })

  await check('размышления уходят отдельной дельтой, а не в текст ответа', async () => {
    stub.state.completion = () => sse([
      messageStart(),
      ['content_block_start', { type: 'content_block_start', index: 0,
        content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'рассуждаю… ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'итог' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
      ['message_stop', { type: 'message_stop' }]
    ])
    const response = await withDeadline(adapter.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', stream: true, messages: [{ role: 'user', content: 'думай' }] } }))
    const parsed = parseSse(await response.text())
    assert.equal(parsed.reasoning, 'рассуждаю… ')
    assert.equal(parsed.content, 'итог')
  })

  await check('середина потока с ошибкой сервера: объяснение приходит кадром и ход не выглядит пустым', async () => {
    stub.state.completion = () => sse([
      messageStart(),
      ['content_block_delta', { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'начало ' } }],
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]
    ])
    const response = await withDeadline(adapter.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', stream: true, messages: [{ role: 'user', content: 'привет' }] } }))
    const text = await response.text()
    const parsed = parseSse(text)
    assert.equal(parsed.content, 'начало ', 'досланный до отказа текст потерялся')
    const errorFrame = parsed.frames.find(frame => frame.error)
    assert.ok(errorFrame, 'кадра с ошибкой нет')
    assert.match(errorFrame.error.message, /overloaded_error — Overloaded/)
    assert.match(errorFrame.error.message, /^Anthropic:/, 'отказ подписан не именем провайдера')
    assert.equal(parsed.done, true, 'поток не закрыт маркером конца')
  })

  await check('каждому кадру — своя строка data: с пробелом: разбор цикла агента её ищет', async () => {
    // Предыдущие проверки подменяли поток своими сценариями — здесь нужен
    // базовый, иначе зелёный цвет мерил бы не форму кадров, а остаток прошлого.
    stub.state.completion = () => sse([
      messageStart(),
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'раз ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'два' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
      ['message_stop', { type: 'message_stop' }]
    ])
    const response = await withDeadline(adapter.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', stream: true, messages: [{ role: 'user', content: 'привет' }] } }))
    const text = await response.text()
    const dataLines = text.split('\n').filter(line => line.startsWith('data: '))
    assert.ok(dataLines.length >= 3, `кадров «data: » меньше трёх: ${dataLines.length}`)
    assert.ok(dataLines.at(-1).trim() === 'data: [DONE]', 'последний кадр не [DONE]')
    assert.ok(!/^event: /m.test(text), 'в openai-поток ушли события Anthropic')
  })

  // --- 3. Ответ без потока --------------------------------------------------
  await check('ответ без потока приходит в форме chat.completion с usage', async () => {
    const response = await withDeadline(adapter.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', messages: [{ role: 'user', content: 'привет' }] } }))
    const payload = await response.json()
    assert.equal(payload.object, 'chat.completion')
    assert.equal(payload.choices[0].message.content, 'обычный ответ')
    assert.equal(payload.choices[0].finish_reason, 'stop')
    assert.equal(payload.usage.total_tokens, 8)
  })

  await check('вызовы инструмента в безпотоковом ответе не теряются', async () => {
    stub.state.jsonBody = () => JSON.stringify({ id: 'msg_3', type: 'message', model: 'claude-тест-1',
      content: [{ type: 'tool_use', id: 'toolu_7', name: 'list_dir', input: { where: '.' } }],
      stop_reason: 'tool_use', usage: { input_tokens: 2, output_tokens: 3 } })
    const response = await withDeadline(adapter.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', messages: [{ role: 'user', content: 'покажи' }] } }))
    const payload = await response.json()
    const call = payload.choices[0].message.tool_calls[0]
    assert.equal(call.id, 'toolu_7')
    assert.equal(call.function.name, 'list_dir')
    assert.deepEqual(JSON.parse(call.function.arguments), { where: '.' })
    assert.equal(payload.choices[0].finish_reason, 'tool_calls')
  })

  // --- 4. Отказы и секрет ---------------------------------------------------
  await check('отказ сервера: одной строкой, с именем провайдера и кодом, без обрывков тела', async () => {
    stub.state.status = 400
    stub.state.errorBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
      message: 'max_tokens is too large: 200000' } })
    await assert.rejects(() => adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      messages: [{ role: 'user', content: 'привет' }] } }), error => {
      assert.match(error.message, /^Anthropic: invalid_request_error — max_tokens is too large/)
      assert.match(error.message, /код 400/)
      assert.ok(error.message.length <= 300, 'строка отказа длиннее 300 знаков')
      assert.equal(error.status, 400)
      return true
    })
  })

  await check('отказ 401 говорит про ключ, а не про сеть', async () => {
    stub.state.status = 401
    stub.state.errorBody = JSON.stringify({ type: 'error', error: { type: 'authentication_error',
      message: 'invalid x-api-key' } })
    await assert.rejects(() => adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      messages: [{ role: 'user', content: 'привет' }] } }), /Ключ не принят/)
  })

  await check('ни в одном тексте отказа не остаётся значения ключа', async () => {
    stub.state.status = 400
    stub.state.errorBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
      message: `ключ ${KEY} не проходит и authorization: Bearer ${KEY}` } })
    await assert.rejects(() => adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      messages: [{ role: 'user', content: 'привет' }] } }), error => {
      assert.ok(!error.message.includes(KEY), 'значение ключа уехало в текст')
      assert.match(error.message, /\[ключ\]/)
      assert.ok(!/sk-ant-/.test(error.message), 'маска не сняла префикс ключа')
      return true
    })
    stub.state.status = 200
    stub.state.errorBody = ''
  })

  await check('отказ по инструментам помечен: возможность гасит вызывающий, а не адаптер', async () => {
    stub.state.status = 400
    stub.state.errorBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
      message: 'tools is not supported for this model' } })
    await assert.rejects(() => adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
      messages: [{ role: 'user', content: 'привет' }] } }), error => {
      assert.equal(error.toolsRejected, true)
      return true
    })
    stub.state.status = 200
    stub.state.errorBody = ''
  })

  await check('без ключа запрос не уходит: отказ называет Anthropic, а не «свой эндпоинт»', async () => {
    const bare = anthropic.create({ baseUrl: base, model: 'claude-тест-1' })
    await assert.rejects(() => bare.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      messages: [{ role: 'user', content: 'привет' }] } }), /Anthropic: не задан API-ключ|Для Anthropic не задан API-ключ/)
    const probe = await withDeadline(bare.probe())
    assert.equal(probe.ok, false)
    assert.match(probe.reason, /ключ/i)
  })

  await check('кривой адрес отказывает до всякой сети и не выходит за заглушку', async () => {
    const broken = anthropic.create({ baseUrl: 'ftp://example.com/v1', apiKey: KEY, model: 'claude-тест-1' })
    await assert.rejects(() => broken.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      messages: [{ role: 'user', content: 'привет' }] } }), /протокол/)
    const before = stub.seen.length
    const probe = await withDeadline(broken.probe())
    assert.equal(probe.ok, false)
    assert.equal(stub.seen.length, before, 'запрос всё-таки ушёл')
  })

  // --- 5. Каталог моделей ---------------------------------------------------
  await check('probe читает /v1/models и приводит display_name к имени модели', async () => {
    const probe = await withDeadline(adapter.probe())
    assert.equal(probe.ok, true, probe.reason)
    assert.equal(last().url, '/v1/models')
    assert.equal(last().method, 'GET')
    assert.equal(last().body, null, 'GET за списком ушёл с телом')
    assert.deepEqual(probe.models, [{ id: 'claude-тест-1', title: 'Тестовая модель' }])
    assert.equal(last().headers['x-api-key'], KEY)
  })

  await check('probe на пустом или чужом ответе честно говорит «каталога нет»', async () => {
    stub.state.models = () => JSON.stringify({ data: [] })
    const empty = await withDeadline(adapter.probe())
    assert.equal(empty.ok, false)
    assert.match(empty.reason, /пустой список/)
    stub.state.models = () => '<html>прокси</html>'
    const html = await withDeadline(adapter.probe())
    assert.equal(html.ok, false)
    assert.match(html.reason, /не JSON/)
    stub.state.models = () => JSON.stringify({ data: [{ type: 'model', id: 'claude-тест-1' }] })
  })

  // --- 6. Реестр и форма пути ----------------------------------------------
  await check('реестр собирает адаптер по имени пути и передаёт своё заглавие', async () => {
    const built = registry.adapterFor('anthropic', { baseUrl: base, apiKey: KEY, model: 'claude-тест-1' })
    assert.equal(built.providerId, 'anthropic')
    assert.equal(built.title, 'Anthropic')
    const openai = registry.adapterFor('openai', { baseUrl: base, apiKey: KEY })
    assert.equal(openai.title, 'OpenAI', 'отказ OpenAI подпишут чужим именем')
    assert.equal(openai.providerId, 'openai')
  })

  await check('inspect не отдаёт ключ — только факт, что он есть', async () => {
    const view = adapter.inspect()
    assert.equal(view.keyPresent, true)
    assert.ok(!JSON.stringify(view).includes(KEY), 'ключ показался в описании пути')
    assert.equal(view.baseUrl, `${stub.origin}/v1/`)
  })

  // --- 7. Перевод вложений и оборванный поток -------------------------------
  await check('PDF уходит блоком document, а не исчезает молча', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1', messages: [
      { role: 'user', content: [
        { type: 'text', text: 'что в документе?' },
        { type: 'file', file: { filename: 'отчёт.pdf', file_data: 'data:application/pdf;base64,AAAA' } }
      ] }
    ] } }))
    const blocks = last().body.messages[0].content
    const document = blocks.find(block => block.type === 'document')
    assert.ok(document, 'блока document нет')
    assert.equal(document.source.media_type, 'application/pdf')
    assert.equal(document.source.data, 'AAAA')
    assert.equal(document.title, 'отчёт.pdf')
  })

  await check('вложение не-PDF не притворяется переданным: оно названо в dropped', async () => {
    const dropped = []
    const watcher = anthropic.create({ baseUrl: base, apiKey: KEY, model: 'claude-тест-1',
      onUnsupported: fields => dropped.push(...fields) })
    await withDeadline(watcher.request({ path: '/chat/completions', body: { model: 'claude-тест-1', messages: [
      { role: 'user', content: [
        { type: 'text', text: 'файл' },
        { type: 'file', file: { filename: 'архив.zip', file_data: 'data:application/zip;base64,AAAA' } }
      ] }
    ] } }))
    const blocks = last().body.messages[0].content
    assert.ok(!blocks.some(block => block.type === 'document'), 'не-PDF уехал документом')
    assert.ok(dropped.some(part => /файл не-PDF/.test(part)), `потеря не названа: ${dropped.join(', ')}`)
  })

  await check('ответ инструмента без предшествующего вызова снимается, а не ловит 400 на весь ход', async () => {
    const dropped = []
    const watcher = anthropic.create({ baseUrl: base, apiKey: KEY, model: 'claude-тест-1',
      onUnsupported: fields => dropped.push(...fields) })
    await withDeadline(watcher.request({ path: '/chat/completions', body: { model: 'claude-тест-1', messages: [
      { role: 'user', content: 'начнём' },
      { role: 'tool', tool_call_id: 'call_потерянный', content: 'вывод' }
    ] } }))
    const blocks = last().body.messages.flatMap(m => m.content)
    assert.ok(!blocks.some(block => block.type === 'tool_result'), 'висячий tool_result ушёл серверу')
    assert.ok(dropped.some(part => /без предшествующего вызова/.test(part)),
      `снятие не названо: ${dropped.join(', ')}`)
  })

  await check('вызов и ответ парами остаются: tool_use и его tool_result доезжают', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1', messages: [
      { role: 'user', content: 'файл' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'готово' }
    ] } }))
    const blocks = last().body.messages.flatMap(m => m.content)
    assert.ok(blocks.some(b => b.type === 'tool_use' && b.id === 'call_1'))
    assert.ok(blocks.some(b => b.type === 'tool_result' && b.tool_use_id === 'call_1'))
  })

  await check('маленький max_tokens не даёт бюджету размышлений съесть ответ', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      max_tokens: 1200, reasoning: { effort: 'high' },
      messages: [{ role: 'user', content: 'думай' }] } }))
    const body = last().body
    assert.equal(body.thinking, undefined, 'размышления ушли при месте в 176 токенов')
    const dropped = anthropic.translate({ model: 'm', max_tokens: 1200, reasoning: { effort: 'high' },
      messages: [{ role: 'user', content: 'думай' }] })
    assert.ok(dropped.dropped.some(note => /не остаётся места ответу/.test(note)),
      `снятие не названо: ${dropped.dropped.join(', ')}`)
  })

  await check('при обычном max_tokens бюджет меньше потолка и место ответу остаётся', async () => {
    await withDeadline(adapter.request({ path: '/chat/completions', body: { model: 'claude-тест-1',
      reasoning: { effort: 'high' }, messages: [{ role: 'user', content: 'думай' }] } }))
    const body = last().body
    assert.ok(body.thinking.budget_tokens <= body.max_tokens - 1024,
      `бюджет ${body.thinking.budget_tokens} против max_tokens ${body.max_tokens}`)
  })

  await check('обрыв потока без message_stop не выдаётся за готовый ответ', async () => {
    stub.state.completion = () => sse([
      messageStart(),
      ['content_block_delta', { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'половина ' } }]
    ])
    const response = await withDeadline(adapter.request({ path: '/chat/completions', body: {
      model: 'claude-тест-1', stream: true, messages: [{ role: 'user', content: 'привет' }] } }))
    await assert.rejects(() => response.text(), /поток оборвался до конца ответа/)
  })

  await check('слишком длинная строка SSE прерывает поток', async () => {
    const provider = anthropic.create({ baseUrl: 'https://example.test', apiKey: KEY, model: 'x',
      fetchImpl: async () => new Response('data: ' + 'x'.repeat(17 * 1024 * 1024), { status: 200 }) })
    const response = await provider.request({ path: '/chat/completions', body: { model: 'x', stream: true, messages: [{ role: 'user', content: 'x' }] } })
    await assert.rejects(() => response.text(), /слишком длинная строка/)
  })

  await check('слишком большой ответ об ошибке не читается целиком', async () => {
    let pulls = 0, cancelled = false
    const stream = new ReadableStream({ pull(c) { if (++pulls > 20) return c.close(); c.enqueue(new Uint8Array(1024 * 1024).fill(120)) }, cancel() { cancelled = true } })
    const provider = anthropic.create({ baseUrl: 'https://example.test', apiKey: KEY, model: 'x', fetchImpl: async () => new Response(stream, { status: 500 }) })
    await assert.rejects(() => provider.request({ path: '/chat/completions', body: { model: 'x', messages: [{ role: 'user', content: 'x' }] } }))
    assert.ok(cancelled && pulls < 20)
  })

  await check('длинный ключ виден целиком в эхе сервера — в тексте не остаётся ничего', async () => {
    const longKey = `sk-ant-${'a'.repeat(40)}-хвост-который-попадает-на-границу-обрезки`
    const echo = 'ошибка: ' + 'повтори '.repeat(40) + longKey + ' конец'
    const line = anthropic.describeError(echo, 400, 'm', longKey)
    assert.ok(!line.includes(longKey), 'значение ключа осталось в описании')
    assert.ok(!line.includes('a'.repeat(20)), 'половина ключа осталась в описании')
  })

  await check('возможности пути честные: размышления не заявлены, цепочка не заявлена', async () => {
    assert.equal(adapter.capabilities.reasoning, false, 'Anthropic объявляет ступени, которых запрос не просит')
    assert.equal(adapter.capabilities.fallbackChain, false)
    assert.equal(adapter.capabilities.streaming, true)
    assert.equal(adapter.capabilities.tools, true)
  })

  for (const name of ['translate', 'toOpenAiPayload', 'create', 'describeError', 'PROVIDER_ID',
    'ANTHROPIC_VERSION', 'DEFAULT_MAX_TOKENS']) {
    await check(`модуль отдаёт «${name}» наружу`, async () => {
      assert.ok(name in anthropic, `${name} не экспортирован`)
    })
  }

  await new Promise(resolve => stub.server.close(resolve))
  if (failures.length) console.error(`\nпровалено проверок: ${failures.length} из ${checks + failures.length}`)
  console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
  process.exit(failures.length ? 1 : 0)
}

runChecks().catch(error => {
  console.error('ПРОВАЛ харнесса:', error)
  process.exit(1)
})
