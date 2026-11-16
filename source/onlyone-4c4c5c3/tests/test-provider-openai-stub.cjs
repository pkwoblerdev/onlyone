// Уровень модуля-адаптера `src/main/providers/openai-compatible.js` против
// локальной HTTP-заглушки (план, 2.8).
//
// Проводка в main.js и маршруты запроса — у tests/test-provider-custom-wiring.cjs;
// здесь проверяется сам модуль: что реально уходит на адрес, как читается поток,
// что остаётся внутри при разборе адреса, ошибок и отмене. Никакого Electron'а,
// никаких сетей наружу; ключ только фейковый, латиницей — заголовок Authorization
// кириллицу не переносит.
//
// ONECODE_PROVIDER_UNDER_TEST — тот же приём, что у соседней проводки: так
// таблица честности (мутации) гоняет ЭТИ ЖЕ проверки против изменённого модуля,
// не трогая репозиторий.
'use strict'
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')

const PROVIDER_PATH = process.env.ONECODE_PROVIDER_UNDER_TEST
  ? path.resolve(process.env.ONECODE_PROVIDER_UNDER_TEST)
  : path.join(__dirname, '..', 'src', 'main', 'providers', 'openai-compatible.js')
const openAiCompatible = require(PROVIDER_PATH)
// Реестр берётся из репозитория всегда: мутации модуля не должны менять его поведение.
const registry = require('../src/main/providers')

// Фейковый секрет: только латиница и цифры — вставляется в Authorization.
const KEY = 'sk-TEST-9f3c1a7b2e4d'

// ---------------------------------------------------------------------------
// Заглушка эндпоинта: пишет в журнал каждое обращение { url, method, headers, body }
// ---------------------------------------------------------------------------
function sse(frames) {
  return frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function startStub() {
  const seen = []
  const state = {
    modelsStatus: 200,
    models: () => JSON.stringify({ data: [{ id: 'модель-альфа', name: 'Альфа' }, { id: 'модель-бета' }] }),
    completion: () => sse([
      { choices: [{ delta: { content: 'Привет ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'из потока' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 9 } }
    ]),
    status: 200,
    errorBody: '',
    errorContentType: 'application/json',
    slowMs: 0
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
      const finish = () => {
        try {
          if (req.url.endsWith('/models')) {
            res.writeHead(state.modelsStatus, { 'Content-Type': 'application/json' })
            res.end(state.models())
            return
          }
          if (state.status !== 200) {
            res.writeHead(state.status, { 'Content-Type': state.errorContentType })
            res.end(state.errorBody)
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end(state.completion())
        } catch {
          // клиент уже отошёл (отмена) — писать некому
        }
      }
      if (state.slowMs && req.url.includes('/slow')) setTimeout(finish, state.slowMs)
      else finish()
    })
  })
  server.on('clientError', () => {})
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, seen, state, origin: `http://127.0.0.1:${server.address().port}` })
  }))
}

// Порт заведомо мёртвого соединения: слушаем, запоминаем, освобождаем.
function deadBaseUrl() {
  return new Promise(resolve => {
    const tmp = http.createServer()
    tmp.listen(0, '127.0.0.1', () => {
      const port = tmp.address().port
      tmp.close(() => resolve(`http://127.0.0.1:${port}/v1`))
    })
  })
}

// Разбор потока так, как его делает вызывающий: кадры `data:`, хвост [DONE]
// отдельно, дельты инструментов склеиваются по index.
function parseSse(text) {
  let content = ''
  let done = false
  let finish = null
  const frames = []
  const calls = new Map()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') { done = true; continue }
    const frame = JSON.parse(payload)
    frames.push(frame)
    const choice = frame.choices?.[0]
    if (!choice) continue
    content += choice.delta?.content || ''
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
  return { content, done, finish, frames, calls }
}

// Страховка от зависания: проверка обязана вернуться, а не ждать вечно.
function withDeadline(promise, ms = 5000) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`зависание: нет результата за ${ms} мс`)), ms)
    })
  ])
}

// ---------------------------------------------------------------------------
// Харнесс: асинхронные проверки только через await — синхронный try/catch
// не поймал бы отклонённое обещание, и красная проверка записалась бы зелёной.
// ---------------------------------------------------------------------------
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
  const adapter = openAiCompatible.create({ baseUrl: base, apiKey: KEY, model: 'модель-альфа' })
  const dead = await deadBaseUrl()

  // --- 1. Поток -------------------------------------------------------------
  await check('request отдаёт настоящий Response: поток читается кадрами data: и конец [DONE] различим', async () => {
    const before = stub.seen.length
    const response = await adapter.request({
      path: '/chat/completions', method: 'POST',
      body: { model: 'модель-альфа', messages: [{ role: 'user', content: 'привет' }], stream: true }
    })
    assert.ok(response instanceof globalThis.Response, 'пришёл не настоящий Response')
    assert.equal(response.ok, true)
    const parsed = parseSse(await response.text())
    assert.equal(parsed.content, 'Привет из потока', 'дельты контента не собрались')
    assert.equal(parsed.done, true, '[DONE] не различим в потоке')
    assert.equal(parsed.frames.length, 3, 'кадров пришли не все')
    assert.equal(parsed.finish, 'stop')
    assert.equal(stub.seen.length, before + 1, 'обращений к серверу не ровно одно')
    assert.equal(stub.seen[before].url, '/v1/chat/completions')
    assert.equal(stub.seen[before].method, 'POST')
  })

  // --- 2. Tool calling ------------------------------------------------------
  await check('разорванные дельты tool_calls склеиваются по index в валидный JSON, finish_reason tool_calls виден', async () => {
    const source = stub.state.completion
    stub.state.completion = () => sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'list_files', arguments: '{}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ])
    try {
      const response = await adapter.request({
        path: '/chat/completions', body: { model: 'модель-альфа', messages: [], tools: [{ type: 'function' }] }
      })
      const parsed = parseSse(await response.text())
      assert.equal(parsed.done, true)
      assert.equal(parsed.finish, 'tool_calls', 'финиш вызова инструмента не дошёл')
      const zero = parsed.calls.get(0)
      assert.equal(zero.name, 'read_file', 'имя инструмента разорвалось не так')
      assert.deepEqual(JSON.parse(zero.args), { path: 'a.txt' }, 'дельты аргументов не склеились в валидный JSON')
      assert.deepEqual(JSON.parse(parsed.calls.get(1).args), {}, 'второй вызов по index подмешался к первому')
    } finally {
      stub.state.completion = source
    }
  })

  // --- 3. Заголовки ---------------------------------------------------------
  await check('на адрес эндпоинта уходит ровно Authorization: Bearer <ключ> и Content-Type у POST', async () => {
    const before = stub.seen.length
    await adapter.request({ path: '/chat/completions', body: { model: 'модель-альфа', messages: [] } })
    const hit = stub.seen[before]
    assert.equal(hit.headers.authorization, `Bearer ${KEY}`, 'ключа в заголовке нет или он не Bearer')
    assert.equal(hit.headers['content-type'], 'application/json', 'у POST без тела нет Content-Type')
  })

  await check('openrouter-специфика не уезжает на чужой сервер: ни HTTP-Referer, ни X-Title, ни чего-либо ещё', async () => {
    const before = stub.seen.length
    await adapter.request({ path: '/chat/completions', body: { model: 'модель-альфа', messages: [] } })
    const hits = stub.seen.slice(before)
    for (const hit of hits) {
      for (const name of Object.keys(hit.headers)) {
        assert.ok(!/referer|title|openrouter/i.test(name), `на чужой сервер уехал заголовок «${name}»`)
      }
    }
  })

  await check('GET за каталогом приходит на сервер без тела и без Content-Type', async () => {
    const before = stub.seen.length
    const result = await adapter.probe()
    assert.equal(result.ok, true, `каталог не прочитался: ${result.reason}`)
    const hit = stub.seen.slice(before).find(item => item.url === '/v1/models')
    assert.ok(hit, 'запроса /v1/models не было')
    assert.equal(hit.method, 'GET')
    assert.equal(hit.raw, '', 'GET ушёл с телом')
    assert.equal(hit.headers['content-type'], undefined, 'GET ушёл с Content-Type')
  })

  // --- 5. Адрес -------------------------------------------------------------
  await check('validateBaseUrl отвергает file: и data: — не http/https сюда не ходит', async () => {
    for (const raw of ['file:///C:/windows/system32', 'data:text/plain,hello', 'ftp://host/v1']) {
      const result = openAiCompatible.validateBaseUrl(raw)
      assert.equal(result.ok, false, `приняло адрес «${raw}»`)
    }
  })

  await check('validateBaseUrl отвергает адрес с login:password@ (секрет в URL) и не эхо-ит пароль в причине', async () => {
    const result = openAiCompatible.validateBaseUrl('https://login:paSSw0rd@host.example/v1')
    assert.equal(result.ok, false, 'адрес с паролем в URL принят')
    assert.match(result.reason, /ключ|парол/i, 'причина отказа не объясняет запрет секрета в URL')
    assert.ok(!JSON.stringify(result).includes('paSSw0rd'), 'причина повторила пароль из адреса')
  })

  await check('validateBaseUrl отвергает адрес без хоста, непонятный порт и пустой ввод', async () => {
    for (const raw of ['https:///v1', 'http://127.0.0.1:abc/v1', 'http://127.0.0.1:70000/v1', '', '   ', null, undefined]) {
      const result = openAiCompatible.validateBaseUrl(raw)
      assert.equal(result.ok, false, `принят заведомо плохой адрес «${String(raw)}»`)
      assert.ok(typeof result.reason === 'string' && result.reason.length > 0, 'отказ без человеческой причины')
    }
  })

  await check('validateBaseUrl принимает localhost, 127.*, ::1, 10.*, 192.168.*, 172.16–31.* и ставит local:true', async () => {
    const localAddresses = [
      'http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:8080/v1',
      'http://10.20.30.40:5000/v1', 'http://192.168.0.10:1234/v1',
      'http://172.16.0.1/v1', 'http://172.31.255.255/v1'
    ]
    for (const raw of localAddresses) {
      const result = openAiCompatible.validateBaseUrl(raw)
      assert.equal(result.ok, true, `локальный адрес отвергнут: ${raw} — ${result.reason}`)
      assert.equal(result.local, true, `адрес не помечен локальным: ${raw}`)
    }
  })

  await check('validateBaseUrl даёт local:false публичному адресу и соседним с приватными сетям (172.15, 172.32)', async () => {
    for (const raw of ['https://api.example.net/v1', 'http://172.15.0.1/v1', 'http://172.32.0.1/v1']) {
      const result = openAiCompatible.validateBaseUrl(raw)
      assert.equal(result.ok, true, `публичный адрес отвергнут: ${raw} — ${result.reason}`)
      assert.equal(result.local, false, `не локальный адрес помечен локальным: ${raw}`)
    }
  })

  await check('/v1 из адреса не выкидывается и не удваивается, если вписан полный путь до /chat/completions', async () => {
    const withV1 = openAiCompatible.validateBaseUrl('http://127.0.0.1:1234/v1')
    assert.equal(withV1.url, 'http://127.0.0.1:1234/v1/', 'путь /v1 потерялся из базы')
    assert.equal(adapter.urlFor('/chat/completions'), `${stub.origin}/v1/chat/completions`)
    assert.equal(adapter.urlFor('models'), `${stub.origin}/v1/models`, 'слэш в склейке путей сбился')
    const full = openAiCompatible.create({ baseUrl: `${stub.origin}/v1/chat/completions`, apiKey: KEY })
    assert.equal(full.urlFor('/chat/completions'), `${stub.origin}/v1/chat/completions`,
      'адрес удвоился: путь уже в базе, дописывать второй раз нельзя')
    const before = stub.seen.length
    await full.request({ path: '/chat/completions', body: { model: 'модель-альфа', messages: [] } })
    assert.equal(stub.seen[before].url, '/v1/chat/completions', 'реальный запрос ушёл на удвоенный путь')
  })

  // --- 6. Что не уезжает -----------------------------------------------------
  const OPENROUTER_BODY = {
    model: 'модель-альфа',
    messages: [{ role: 'user', content: 'текст' }],
    tools: [{ type: 'function', function: { name: 'read_file' } }],
    tool_choice: 'auto',
    stream: true,
    temperature: 0.2,
    max_tokens: 100,
    models: ['запасная-модель'],
    plugins: [{ id: 'file-parser' }],
    reasoning: { effort: 'max' }
  }

  await check('models/plugins/reasoning не доезжают до сервера, а prepare().dropped называет все три', async () => {
    const prepared = adapter.prepare(OPENROUTER_BODY)
    assert.deepEqual(prepared.dropped, ['models', 'plugins', 'reasoning'], 'dropped назвал не все три поля')
    for (const field of ['models', 'plugins', 'reasoning']) {
      assert.equal(prepared.body[field], undefined, `prepare оставил поле ${field} в теле`)
    }
    assert.deepEqual(adapter.prepare({ model: 'm', messages: [] }).dropped, [], 'выдумал removal там, где убирать нечего')
    const before = stub.seen.length
    await adapter.request({ path: '/chat/completions', body: OPENROUTER_BODY })
    const hit = stub.seen[before]
    for (const field of ['models', 'plugins', 'reasoning']) {
      assert.equal(hit.body[field], undefined, `поле ${field} всё-таки уехало на чужой сервер`)
    }
  })

  await check('onUnsupported позван до отправки запроса и называет все отброшенные поля', async () => {
    let seenAtCall = -1
    let calledWith = null
    const watcher = openAiCompatible.create({
      baseUrl: base, apiKey: KEY,
      onUnsupported: fields => { calledWith = fields; seenAtCall = stub.seen.length }
    })
    const before = stub.seen.length
    await watcher.request({ path: '/chat/completions', body: OPENROUTER_BODY })
    assert.ok(Array.isArray(calledWith), 'onUnsupported не позван вовсе')
    assert.deepEqual([...calledWith].sort(), ['models', 'plugins', 'reasoning'], 'предупреждение назвало не все поля')
    assert.equal(seenAtCall, before, 'onUnsupported позван уже после отправки — предупреждение опоздало')
    assert.equal(stub.seen.length, before + 1, 'после предупреждения запрос не ушёл')
  })

  await check('остальные поля (messages, tools, tool_choice, stream, temperature, max_tokens) уходят в тело как есть', async () => {
    const before = stub.seen.length
    await adapter.request({ path: '/chat/completions', body: OPENROUTER_BODY })
    const sent = stub.seen[before].body
    for (const field of ['messages', 'tools', 'tool_choice', 'stream', 'temperature', 'max_tokens', 'model']) {
      assert.deepEqual(sent[field], OPENROUTER_BODY[field], `поле ${field} исказилось в дороге`)
    }
  })

  // --- 7. Отказ по инструментам ----------------------------------------------
  await check('describeToolsRejection: 400/404/422 с текстом про неподдержку tools/function calling — true', async () => {
    assert.equal(openAiCompatible.describeToolsRejection(400,
      JSON.stringify({ error: { message: 'The model does not support tools' } })), true)
    assert.equal(openAiCompatible.describeToolsRejection(422,
      JSON.stringify({ error: { message: 'tools are not supported by this endpoint' } })), true)
    assert.equal(openAiCompatible.describeToolsRejection(404,
      'this server does not support function calling'), true)
  })

  await check('describeToolsRejection: «token budget» и эхо запроса со словом tools без отказа — false', async () => {
    assert.equal(openAiCompatible.describeToolsRejection(400,
      JSON.stringify({ error: { message: 'token budget exceeded for this request' } })), false,
    'ошибка про токены записана как отказ по инструментам — агент потерял бы tools зря')
    assert.equal(openAiCompatible.describeToolsRejection(400,
      'You sent {"model":"m","tools":[{"type":"function"}]} but the body could not be parsed'), false,
    'обычная ошибка тела с эхом tools названа отказом по инструментам')
    assert.equal(openAiCompatible.describeToolsRejection(429,
      JSON.stringify({ error: { message: 'tools are not supported' } })), false,
    'отказ по инструментам приделан к статусу вне 400/404/422')
  })

  // --- 8. Ошибки без секретов -------------------------------------------------
  const ERROR_CASES = [
    { raw: JSON.stringify({ error: { message: `bad api key: sk-TEST-zzz-0000` } }), status: 401 },
    { raw: JSON.stringify({ error: { message: 'model not found' } }), status: 404 },
    { raw: JSON.stringify({ error: { message: 'rate limit exceeded' } }), status: 429 },
    { raw: `<html><body>Internal Server Error, header was Authorization: Bearer sk-TEST-yyyy1111</body></html>`, status: 500 },
    { raw: JSON.stringify({ detail: 'upstream worker died' }), status: 502 },
    { raw: '', status: 500 },
    { raw: '<html>' + 'x'.repeat(4000) + '</html>', status: 500 }
  ]

  await check('describeError: одной строкой, не длиннее 300 знаков, с кодом состояния — на любой форме ответа', async () => {
    for (const item of ERROR_CASES) {
      const line = adapter.describeError(item.raw, item.status, 'модель-альфа')
      assert.ok(!line.includes('\n'), `описание вышло многострочным: ${line}`)
      assert.ok(line.length <= 300, `описание на ${line.length} знаков — длиннее 300`)
      assert.ok(line.includes(`код ${item.status}`), `нет кода состояния ${item.status}: ${line}`)
      assert.ok(line.length > 0, 'пустое описание')
    }
    const emptyBody = adapter.describeError('', 500, 'модель-альфа')
    assert.match(emptyBody, /объяснен|не читается|нет/i, 'пустое тело не объяснено по-человечески')
    assert.match(adapter.describeError('{"error":{"message":"nope"}}', 401, 'm'), /ключ/i,
      '401 не названа проблемой ключа')
  })

  await check('describeError: ни значения ключа, ни «Bearer <ключ>», ни sk-... ни в одном варианте ответа', async () => {
    for (const item of ERROR_CASES) {
      const line = adapter.describeError(item.raw, item.status, 'модель-альфа')
      assert.ok(!line.includes(KEY), 'описание повторило присланный ключ')
      assert.ok(!/\bsk-[A-Za-z0-9_-]{4,}/.test(line), `в описании остался открытый sk-токен: ${line}`)
      assert.ok(!/Bearer\s+[A-Za-z0-9]/i.test(line), `в описании остался Bearer с ключом: ${line}`)
    }
  })

  await check('сервер процитировал присланный ключ в тексте ошибки — в описании и в отказе request ключа нет', async () => {
    const status = stub.state.status
    const body = stub.state.errorBody
    stub.state.status = 401
    stub.state.errorBody = JSON.stringify({ error: { message: `ключ ${KEY} отклонён` } })
    try {
      const direct = adapter.describeError(stub.state.errorBody, 401, 'модель-альфа')
      assert.ok(!direct.includes(KEY), `процитированный ключ остался в описании: ${direct}`)
      let message = ''
      let thrown = null
      try {
        await adapter.request({ path: '/chat/completions', body: { model: 'модель-альфа', messages: [] } })
      } catch (error) { thrown = error; message = error.message }
      assert.ok(thrown, '401 не привёл к отказу')
      assert.ok(!message.includes(KEY), 'ошибка request повторила ключ')
      assert.match(message, /код 401/, 'отказ не назван статусом')
      assert.equal(thrown.status, 401)
      assert.equal(thrown.toolsRejected, false, '401 посчитана отказом по инструментам')
    } finally {
      stub.state.status = status
      stub.state.errorBody = body
    }
  })

  // --- 9. Отмена --------------------------------------------------------------
  await check('сигнал, снятый до вызова: request отказывает понятной отменой и не стучится на сервер', async () => {
    const controller = new AbortController()
    controller.abort()
    const before = stub.seen.length
    const err = await adapter.request({
      path: '/chat/completions', body: { model: 'модель-альфа', messages: [] }, signal: controller.signal
    }).then(() => null, error => error)
    assert.ok(err, 'запрос со снятым сигналом прошёл')
    assert.match(err.message, /отмен/i, `отзыв не назван отменой: ${err.message}`)
    assert.equal(stub.seen.length, before, 'запрос всё-таки ушёл на сервер')
  })

  await check('отмена во время ожидания ответа — ошибка отмены, а не зависание и не «не удалось связаться»', async () => {
    const slowMs = stub.state.slowMs
    stub.state.slowMs = 800
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 20)
      const err = await withDeadline(adapter.request({
        path: '/slow', body: { model: 'модель-альфа', messages: [] }, signal: controller.signal
      }).then(() => null, error => error))
      assert.ok(err, 'отменённый запрос завершился успехом')
      assert.match(err.message, /отмен/i, `отзыв описан непонятно: ${err.message}`)
      assert.ok(!/не удалось связаться/i.test(err.message),
        `отмена выдана за потерю соединения: ${err.message}`)
    } finally {
      stub.state.slowMs = slowMs
    }
  })

  await check('обрыв соединения: понятная строка, первоначина сохранена в cause, секретов нет', async () => {
    const lost = openAiCompatible.create({ baseUrl: dead, apiKey: KEY, model: 'модель-альфа' })
    const err = await withDeadline(lost.request({ path: '/chat/completions', body: { model: 'm', messages: [] } })
      .then(() => null, error => error))
    assert.ok(err, 'запрос на мёртвый порт не отказал')
    assert.match(err.message, /не удалось связаться/i, `сбой соединения не назван: ${err.message}`)
    assert.ok(err.cause, 'первоначина не сохранена в cause — главный процесс не различит обрыв')
    assert.match(`${err.cause.code || ''} ${err.cause.message || ''}`, /ECONN/i, 'cause растерян')
    assert.ok(!err.message.includes(KEY), 'ключ уехал в текст сетевой ошибки')
  })

  // --- 10. Без ключа ----------------------------------------------------------
  await check('без ключа request отказывает человеческой строкой про API-ключ и не делает ни одного обращения', async () => {
    const bare = openAiCompatible.create({ baseUrl: base, apiKey: '', model: 'модель-альфа' })
    const before = stub.seen.length
    const err = await bare.request({ path: '/chat/completions', body: { model: 'модель-альфа', messages: [] } })
      .then(() => null, error => error)
    assert.ok(err, 'запрос без ключа прошёл')
    assert.match(err.message, /API-ключ/i, `отказ не про ключ: ${err.message}`)
    assert.equal(stub.seen.length, before, 'без ключа на сервер всё-таки постучались')
  })

  await check('без ключа probe честно возвращает причину про ключ и не обращается к серверу', async () => {
    const bare = openAiCompatible.create({ baseUrl: base, apiKey: '' })
    const before = stub.seen.length
    const result = await bare.probe()
    assert.equal(result.ok, false)
    assert.match(result.reason, /API-ключ/i, `причина probe не про ключ: ${result.reason}`)
    assert.equal(stub.seen.length, before, 'probe без ключа сходил на сервер')
  })

  // --- 11. probe честно про каталог -------------------------------------------
  await check('probe читает и {data:[...]}, и простой массив — каталог не выдумывается', async () => {
    const first = await adapter.probe()
    assert.equal(first.ok, true, first.reason)
    assert.deepEqual(first.models.map(item => item.id), ['модель-альфа', 'модель-бета'])
    const source = stub.state.models
    stub.state.models = () => JSON.stringify(['модель-гамма', { id: 'модель-дельта' }])
    try {
      const second = await adapter.probe()
      assert.equal(second.ok, true, second.reason)
      assert.deepEqual(second.models.map(item => item.id), ['модель-гамма', 'модель-дельта'])
    } finally {
      stub.state.models = source
    }
  })

  await check('probe: HTML вместо JSON, пустой список, 500 и мёртвое соединение — ok:false с причиной, без исключения', async () => {
    const modelsSource = stub.state.models
    const statusSource = stub.state.modelsStatus
    try {
      stub.state.modelsStatus = 200
      stub.state.models = () => '<html>каталога тут нет</html>'
      const notJson = await adapter.probe()
      assert.equal(notJson.ok, false)
      assert.match(notJson.reason, /не JSON/i, `HTML не назван не-JSON: ${notJson.reason}`)
      stub.state.models = () => JSON.stringify({ data: [] })
      const empty = await adapter.probe()
      assert.equal(empty.ok, false)
      assert.match(empty.reason, /пуст/i, 'пустой список не назван пустым')
      stub.state.models = () => JSON.stringify({ error: { message: 'внутренняя ошибка' } })
      stub.state.modelsStatus = 500
      const failed = await adapter.probe()
      assert.equal(failed.ok, false)
      assert.match(failed.reason, /код 500/, '500 не названа статусом')
      const lost = openAiCompatible.create({ baseUrl: dead, apiKey: KEY })
      const dropped = await lost.probe()
      assert.equal(dropped.ok, false)
      assert.match(dropped.reason, /связаться/i, `обрыв не назван: ${dropped.reason}`)
      assert.ok(!JSON.stringify(dropped).includes(KEY), 'ключ уехал в причину probe')
    } finally {
      stub.state.models = modelsSource
      stub.state.modelsStatus = statusSource
    }
  })

  // --- 12. inspect -------------------------------------------------------------
  await check('inspect не выдаёт секрет: наружу только булево keyPresent, значения ключа нет нигде', async () => {
    const info = adapter.inspect()
    assert.equal(info.keyPresent, true)
    assert.equal('apiKey' in info, false, 'inspect вернул поле с ключом')
    assert.ok(!JSON.stringify(info).includes(KEY), 'inspect выдал ключ')
    const bare = openAiCompatible.create({ baseUrl: base, apiKey: '   ' })
    assert.equal(bare.inspect().keyPresent, false, 'пробелы посчитаны ключом')
  })

  // --- 13. Реестр ---------------------------------------------------------------
  await check('реестр: пустое и мусорное значение — встроенный openrouter; «custom» и «openai-compatible» — путь адаптера', async () => {
    assert.equal(registry.activeProviderId(undefined), 'openrouter')
    assert.equal(registry.activeProviderId(''), 'openrouter')
    assert.equal(registry.activeProviderId('  '), 'openrouter')
    assert.equal(registry.activeProviderId('нет-такого-пути'), 'openrouter')
    assert.equal(registry.activeProviderId('custom'), openAiCompatible.PROVIDER_ID)
    assert.equal(registry.activeProviderId(openAiCompatible.PROVIDER_ID), openAiCompatible.PROVIDER_ID)
  })

  await check('реестр: providerById(«custom») — null, алиас не притворяется отдельным путём', async () => {
    assert.equal(registry.providerById('custom'), null)
    assert.equal(registry.providerById(''), null)
    assert.equal(registry.providerById('какой-то мусор'), null)
    assert.ok(registry.providerById(openAiCompatible.PROVIDER_ID), 'адаптерный путь не найден в реестре')
  })

  await check('реестр: knownProviders — полный каталог путей, openrouter помечен встроенным', async () => {
    const known = registry.knownProviders()
    const ids = known.map(item => item.id).sort()
    // Каталог 25.09 (OpenAI, Anthropic, Gemini, OpenCode Zen, Ollama) добавляет пути к прежним
    // двум. Список сверяется целиком: «в реестре завелось что-то ещё» — это тоже
    // находка, а не зелёная проверка.
    // 07.10.2026 к ним добавлены агрегаторы и хостинги (Together, Groq, Hugging Face и другие) и LM Studio; их адреса и
    // группы проверяет test-provider-catalog, здесь важен состав целиком.
    assert.deepEqual(ids, ['anthropic', 'cerebras', 'chutes', 'deepinfra', 'fireworks', 'gemini', 'groq', 'huggingface', 'lmstudio',
      'nebius', 'nvidia', 'ollama', 'openai', 'openai-compatible', 'opencode-zen', 'openrouter', 'requesty', 'sambanova',
      'siliconflow', 'together', 'vercel-ai-gateway'],
      'состав реестра разошёлся с каталогом')
    assert.equal(new Set(ids).size, ids.length, 'в реестре повторился id')
    const byId = new Map(known.map(item => [item.id, item]))
    assert.equal(byId.get('openrouter').builtin, true, 'встроенный путь не помечен builtin')
    assert.equal(byId.get(openAiCompatible.PROVIDER_ID).builtin, false, 'адаптер притворяется встроенным')
  })

  await new Promise(resolve => stub.server.close(resolve))
  if (failures.length) console.error(`\nпровалено проверок: ${failures.length} из ${checks + failures.length}`)
  console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
  process.exit(failures.length ? 1 : 0)
}

runChecks().catch(error => { console.error('харнесс упал: ' + error.stack); process.exit(2) })
