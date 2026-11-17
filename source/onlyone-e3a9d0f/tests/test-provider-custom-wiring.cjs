// Проводка второго пути к модели в главном процессе (план, 2.8).
//
// Адаптер `src/main/providers/openai-compatible.js` имеет свои проверки (см.
// tests/test-provider-openai-stub.cjs). Здесь проверяется то, что решает только
// `main.js`: куда уходит запрос, что лежит в настройках, что видит renderer, как
// гасятся возможности и о чём говорит журнал. Участки главного процесса
// вырезаются из настоящего файла и вызываются против HTTP-заглушки на
// 127.0.0.1: ни настоящих ключей, ни запросов наружу, ни платной модели.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(process.env.ONECODE_MAIN_UNDER_TEST ||
  path.join(root, 'src', 'main', 'main.js'), 'utf8')
const providers = require('../src/main/providers')
const openAiCompatible = require('../src/main/providers/openai-compatible')

function cut(from, to, label) {
  const start = main.indexOf(from)
  assert.ok(start >= 0, `якорь не найден: ${label} (начало)`)
  const end = main.indexOf(to, start)
  assert.ok(end >= 0, `якорь не найден: ${label} (конец)`)
  return main.slice(start, end)
}

const ENCRYPT = cut('function requireWindowsEncryption() {',
  '// ---------------------------------------------------------------------------\n// Encrypted storage',
  'шифрование ключа')
const PROVIDER = cut('function activeProviderId() {',
  '// Statuses worth trying on a different key', 'секция своего endpoint')
const REQUEST = cut('async function openRouterRequest(', '\nfunction requestHeaders(', 'openRouterRequest')
const MODEL = cut('function modelExists(modelId) {', '// One mode: the agent.', 'судьба модели')
const IPC = cut("// --- Свои OpenAI-совместимые подключения (план, 2.8)",
  '// ---------------------------------------------------------------------------\n// Updates', 'IPC своего endpoint')

// Ключ только из латиницы: заголовок Authorization не переносит кириллицу, и
// проверка утонула бы в ByteString вместо того, чтобы мерить проводку.
const firstCustomProvider = env => (env.settings.get('customProviders') || [])[0] || null

const SECRET = 'sk-TEST-sekret-9f3c1a7b'
const SHORT_SECRET = '1234'

// ---------------------------------------------------------------------------
// Подставное окружение: настройки, шифр, журнал, ipc
// ---------------------------------------------------------------------------
function makeEnv({ available = true } = {}) {
  const settings = new Map()
  const store = {
    get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
    set: (key, value) => { settings.set(key, value) },
    delete: key => { settings.delete(key) },
    has: key => settings.has(key)
  }
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: text => Buffer.from(`ENC:${text}`, 'utf8'),
    decryptString: buffer => {
      const text = Buffer.from(buffer).toString('utf8')
      if (!text.startsWith('ENC:')) throw new Error('не наш конверт')
      return text.slice(4)
    }
  }
  const logs = []
  const handlers = new Map()
  const marked = { deadKeys: [], unavailableModels: [] }
  return { settings, store, safeStorage, logs, handlers, marked }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function build(env, stub) {
  const body = [
    'let currentKeyIndex = 0',
    "let modelCache = { updatedAt: 0, models: [] }",
    ENCRYPT,
    PROVIDER,
    REQUEST,
    MODEL,
    IPC,
    'return {',
    '  openRouterRequest, customProviderRequest, readCustomProvider, saveCustomProvider,',
    '  getPublicCustomProvider, fetchCustomProviderModels, applyProviderCatalog, customProviderTeam,',
    '  activeProviderId, isCustomProvider, modelExists, modelCanCallTools, maskSecret,',
    '  modelCacheRef: () => modelCache, setModelCache: value => { modelCache = value },',
    '  handlers',
    '}'
  ].join('\n')
  return new AsyncFunction(
    'store', 'safeStorage', 'providers', 'openAiCompatible', 'CUSTOM_PROVIDER_ID', 'latency',
    'testProviderResponse', 'normalizeOutgoingMessages', 'getEnabledKeys', 'OPENROUTER_URL',
    'requestHeaders', 'markKeyDead', 'markModelUnavailable', 'describeOpenRouterError', 'maskKeyInText', 'tr',
    'modelUnavailable', 'toolsKnownBroken', 'findModelRecord', 'PRESET_MODELS', 'DEFAULT_MODEL',
    'ipcMain', 'handlers',
    body
  )(
    env.store, env.safeStorage, providers, openAiCompatible, openAiCompatible.PROVIDER_ID,
    { write: text => env.logs.push(String(text)) },
    async () => null,
    messages => messages,
    () => [{ id: 'k1', keyEncrypted: Buffer.from('ENC:or-key', 'utf8').toString('base64'), enabled: true }],
    `${stub.origin}/openrouter-api`,
    apiKey => ({ Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://1code.app', 'X-Title': 'onlyone' }),
    id => env.marked.deadKeys.push(id),
    id => env.marked.unavailableModels.push(id),
    (raw, status) => `OpenRouter ${status}`,
    // Маска границы записи настроек — настоящая, из общего модуля.
    (text, secret) => require('../src/main/providers/secret-mask').maskSecretText(text, secret),
    // Язык окна: перевод тот же словарь, что читает renderer.
    require('../src/main/ui-text.cjs').tr,
    () => false,
    () => false,
    id => (env.catalogRecords || []).find(item => item.id === id) || null,
    [], 'openrouter/some-model',
    { handle: (name, fn) => env.handlers.set(name, fn) },
    env.handlers
  )
}

// ---------------------------------------------------------------------------
// Заглушка эндпоинта: тот же сервер играет и OpenRouter, и свой адрес
// ---------------------------------------------------------------------------
function sse(frames) {
  return frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function startStub() {
  const seen = []
  const state = {
    models: { data: [{ id: 'моя-модель', name: 'Моя модель' }, { id: 'вторая-модель' }] },
    completion: () => sse([
      { choices: [{ delta: { content: 'Первая ' } }] },
      { choices: [{ delta: { content: 'часть ответа' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 21 } }
    ]),
    status: 200,
    body: ''
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      let parsed = null
      try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = raw }
      seen.push({ url: req.url, method: req.method, headers: req.headers, body: parsed, raw })
      if (req.url.endsWith('/models')) {
        res.writeHead(state.modelsStatus || 200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(state.models))
        return
      }
      if (state.status !== 200) {
        res.writeHead(state.status, { 'Content-Type': 'application/json' })
        res.end(state.body)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(state.completion())
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, seen, state, origin: `http://127.0.0.1:${server.address().port}` })
  }))
}

// ---------------------------------------------------------------------------
// Проверки
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

// Проверка, что поток пришёл именно openai-диалектом: кадры раскладываются так
// же, как их раскладывает главный цикл, — и текст, и дельты инструментов.
function readStream(text) {
  let content = ''
  let args = ''
  let done = false
  let finish = null
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') { done = true; continue }
    const frame = JSON.parse(payload)
    const choice = frame.choices?.[0]
    if (!choice) continue
    content += choice.delta?.content || ''
    for (const call of choice.delta?.tool_calls || []) args += call.function?.arguments || ''
    if (choice.finish_reason) finish = choice.finish_reason
  }
  return { content, args, done, finish }
}

async function runChecks() {
  const stub = await startStub()
  const base = `${stub.origin}/v1`
  const invoke = async (api, channel, payload) => api.handlers.get(channel)(null, payload)

  // Общий случай: ничего не настроено — как было до пункта 2.8.
  {
    const env = makeEnv()
    const api = await build(env, stub)
    await check('пустые настройки оставляют путь OpenRouter (существующие профили не ломаются)', async () => {
      assert.equal(env.settings.has('activeProvider'), false, 'настройка провайдера появилась сама собой')
      assert.equal(api.activeProviderId(), providers.DEFAULT_PROVIDER_ID)
      assert.equal(api.isCustomProvider(), false)
      assert.equal(api.getPublicCustomProvider().configured, false)
      assert.equal(api.getPublicCustomProvider().activeProvider, 'openrouter')
    })

    await check('прежний путь живёт: запрос идёт на OPENROUTER_URL со своими заголовками', async () => {
      const response = await api.openRouterRequest('/chat/completions',
        { body: { model: 'm', messages: [{ role: 'user', content: 'привет' }] } })
      const stream = readStream(await response.text())
      assert.equal(stream.content, 'Первая часть ответа', 'поток прежнего пути не собрался')
      assert.equal(stream.done, true, 'признака конца потока нет')
      const hit = stub.seen.find(item => item.url.startsWith('/openrouter-api'))
      assert.ok(hit, 'запрос не ушёл на адрес OpenRouter')
      assert.equal(hit.headers.referer || hit.headers['http-referer'], 'https://1code.app',
        'с прежнего пути сняли заголовок, которого там не было')
      assert.equal(stub.seen.filter(item => item.url.startsWith('/v1')).length, 0,
        'пока выбран OpenRouter, свой адрес трогать нельзя')
    })
  }

  // Настройка своего пути и то, что видит renderer.
  const env = makeEnv()
  const api = await build(env, stub)
  await check('сохранение: ключ шифруется, адрес и модель лежат открыто, точки в имени ключа нет', async () => {
    const result = await invoke(api, 'set-custom-provider',
      { baseUrl: base, model: 'моя-модель', key: SECRET, capabilities: { tools: true } })
    assert.equal(result.ok, true, `не сохранено: ${result.reason}`)
    const stored = firstCustomProvider(env)
    assert.equal(stored.baseUrl, base)
    assert.equal(stored.model, 'моя-модель')
    assert.ok(stored.keyEncrypted && stored.keyEncrypted !== SECRET, 'ключ лёг в настройки как есть')
    assert.ok(Buffer.from(stored.keyEncrypted, 'base64').toString('utf8').startsWith('ENC:'), 'шифр не применялся')
    const dump = JSON.stringify([...env.settings.keys()])
    assert.ok(!dump.includes('.'), `имя ключа настроек с точкой (dot-prop): ${dump}`)
    assert.ok(!JSON.stringify(firstCustomProvider(env)).includes(SECRET),
      'открытый ключ уехал в файл настроек')
  })

  await check('renderer получает маску, а не ключ', async () => {
    const view = await invoke(api, 'get-custom-provider')
    assert.equal(view.baseUrl, base)
    assert.equal(view.model, 'моя-модель')
    assert.equal(view.ending, '', 'окно получило производное от ключа')
    assert.equal(view.hasKey, true, 'без хвоста окно перестало видеть, что ключ есть')
    assert.equal(view.keyEncrypted, true, 'при доступном safeStorage не сказано, что ключ шифруется')
    assert.ok(!JSON.stringify(view).includes(SECRET), 'открытый ключ уехал в renderer')
    assert.ok(Array.isArray(view.providers) && view.providers.length >= 2, 'списка путей нет')
    assert.ok(view.unsupported.length >= 2, 'не сказано, чего этот путь не даёт')
  })

  await check('из короткого ключа не показывается ничего — прежняя маска выдавала его весь', async () => {
    assert.equal(api.maskSecret(SHORT_SECRET), '')
    assert.ok(!api.maskSecret(SHORT_SECRET).includes('1234'), 'маска выдала весь ключ')
    assert.ok(!api.maskSecret(SECRET).includes(SECRET.slice(-4)), 'маска выдала хвост длинного ключа')
  })

  await check('переключение на нездоровый путь отказывает и ничего не меняет', async () => {
    const broken = makeEnv()
    const brokenApi = await build(broken, stub)
    const result = await invoke(brokenApi, 'set-active-provider', openAiCompatible.PROVIDER_ID)
    assert.equal(result.ok, false, 'переключение на пустую настройку прошло')
    assert.match(result.reason, /не настроен|ещё нет/i)
    assert.equal(broken.settings.has('activeProvider'), false, 'настройка всё-таки изменилась')
  })

  await check('адрес с логином и паролем не сохраняется', async () => {
    const result = await invoke(api, 'set-custom-provider', { baseUrl: 'https://login:paSSw0rd@evil.example/v1' })
    assert.equal(result.ok, false)
    assert.match(result.reason, /ключ|парол/i)
    assert.equal(firstCustomProvider(env).baseUrl, base, 'испорченный адрес перезаписал хороший')
    assert.ok(!JSON.stringify(firstCustomProvider(env)).includes('paSSw0rd'))
  })

  await check('переключение удаётся, и ход идёт на свой адрес, а не на OpenRouter', async () => {
    const before = stub.seen.length
    const result = await invoke(api, 'set-active-provider', openAiCompatible.PROVIDER_ID)
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.activeProvider, openAiCompatible.PROVIDER_ID)
    assert.equal(api.isCustomProvider(), true)
    const response = await api.openRouterRequest('/chat/completions',
      { body: { model: 'openrouter/чужая-модель', messages: [{ role: 'user', content: 'привет' }] } })
    const own = readStream(await response.text())
    assert.equal(own.content, 'Первая часть ответа', 'поток своего пути не собрался')
    assert.equal(own.done, true, 'со своего пути [DONE] не виден')
    // Переключение само по себе успело спросить каталог — считается именно ход.
    const hits = stub.seen.slice(before).filter(item => item.url === '/v1/chat/completions')
    assert.equal(hits.length, 1, 'на свой адрес ушло не одно обращение хода')
    assert.equal(hits[0].url, '/v1/chat/completions')
    assert.ok(!stub.seen.slice(before).some(item => item.url.startsWith('/openrouter-api')),
      'ушёл и тихий запрос на OpenRouter')
    assert.equal(hits[0].headers['http-referer'], undefined, 'на чужой сервер уехал OpenRouter-заголовок')
    assert.equal(hits[0].headers.authorization, `Bearer ${SECRET}`)
    // Модель одна — та, что заявлена для эндпоинта: OpenRouter-идентификатор он не знает.
    assert.equal(hits[0].body.model, 'моя-модель', 'заявленная модель не проставлена')
  })

  await check('OpenRouter-специфика не уезжает на чужой сервер, а названа в журнале', async () => {
    const before = stub.seen.length
    await api.openRouterRequest('/chat/completions', {
      body: {
        model: 'моя-модель', messages: [{ role: 'user', content: 'текст' }], stream: true,
        models: ['запасная'], plugins: [{ id: 'file-parser' }], reasoning: { effort: 'max' },
        tools: [{ type: 'function', function: { name: 'read_file' } }]
      }
    })
    const hit = stub.seen.slice(before).find(item => item.url === '/v1/chat/completions')
    for (const field of ['models', 'plugins', 'reasoning']) {
      assert.equal(hit.body[field], undefined, `поле ${field} доехало до чужого сервера`)
    }
    assert.ok(Array.isArray(hit.body.tools), 'инструменты пропали из тела')
    const line = env.logs.filter(text => text.includes('dropped')).pop() || ''
    assert.match(line, /models/, 'в журнале не названо, что убрали из тела')
    assert.match(line, /plugins/)
    assert.match(line, /reasoning/)
    assert.ok(!line.includes(SECRET), 'ключ уехал в журнал')
  })

  await check('вызов инструмента доходит до эндпоинта дельтами', async () => {
    const source = stub.state.completion
    stub.state.completion = () => sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ])
    const response = await api.openRouterRequest('/chat/completions',
      { body: { model: 'моя-модель', messages: [], tools: [{ type: 'function' }] } })
    const stream = readStream(await response.text())
    stub.state.completion = source
    assert.equal(stream.done, true, 'признака конца потока нет')
    assert.equal(stream.finish, 'tool_calls', 'финиш вызова инструмента не дошёл')
    // Дельты аргументов склеиваются в ровно тот JSON, что собирает главный цикл.
    assert.equal(stream.args, '{"path":"a.txt"}', 'дельты аргументов не склеились')
  })

  await check('отказ по инструментам гасит возможность явно, и цикл это видит', async () => {
    const status = stub.state.status
    const errorBody = stub.state.body
    stub.state.status = 400
    stub.state.body = JSON.stringify({ error: { message: 'tools are not supported by this model' } })
    await assert.rejects(() => api.openRouterRequest('/chat/completions',
      { body: { model: 'моя-модель', messages: [], tools: [{ type: 'function' }] } }),
      /tools are not supported|Свой OpenAI/i)
    stub.state.status = status
    stub.state.body = errorBody
    const stored = api.readCustomProvider()
    assert.equal(stored.capabilities.tools, false, 'возможность не погасилась после отказа')
    assert.match(stored.lastCheck.reason, /инструмент/i, 'человек не видит причины')
    assert.equal(api.modelCanCallTools('моя-модель'), false,
      'агентный цикл всё ещё считает, что инструменты доступны')
    assert.ok(!JSON.stringify(stored).includes(SECRET), 'ключ уехал в сохранённую запись')
  })

  await check('401 называется отказом ключа, и секрет не попадает в текст', async () => {
    const status = stub.state.status
    const errorBody = stub.state.body
    stub.state.status = 401
    stub.state.body = JSON.stringify({ error: { message: `bad key ${SECRET}` } })
    let message = ''
    try {
      await api.openRouterRequest('/chat/completions', { body: { model: 'моя-модель', messages: [] } })
    } catch (error) { message = error.message }
    stub.state.status = status
    stub.state.body = errorBody
    assert.match(message, /код 401/i, `отказ не назван: ${message}`)
    assert.ok(!message.includes(SECRET), 'текст ошибки повторил ключ')
    assert.match(api.readCustomProvider().lastCheck.reason, /ключ/i)
    // Граница записи: в настройки и в окно едет причина, а не серверная цитата.
    // `keyEncrypted` здесь не сверяется — это конверт, а не текст.
    const storedReason = api.readCustomProvider().lastCheck.reason
    for (const piece of [SECRET.slice(0, 6), SECRET.slice(-4), SECRET.slice(-8), SECRET.slice(4)]) {
      assert.ok(!storedReason.includes(piece), `в сохранённую причину уехало «${piece}»: ${storedReason}`)
      assert.ok(!message.includes(piece), `в текст отказа уехало «${piece}»: ${message}`)
    }
    assert.ok(!env.logs.some(line => line.includes(SECRET.slice(-4))), 'хвост ключа уехал в журнал')
  })

  await check('без ключа запрос не уходит и на OpenRouter не откатывается', async () => {
    const bare = makeEnv()
    const bareApi = await build(bare, stub)
    await invoke(bareApi, 'set-custom-provider', { baseUrl: base, model: 'моя-модель' })
    await invoke(bareApi, 'set-active-provider', openAiCompatible.PROVIDER_ID).catch(() => {})
    bare.store.set('activeProvider', openAiCompatible.PROVIDER_ID)
    const before = stub.seen.length
    await assert.rejects(() => bareApi.openRouterRequest('/chat/completions',
      { body: { model: 'моя-модель', messages: [] } }), /ключ/i)
    assert.equal(stub.seen.length, before, 'без ключа всё-таки ушёл запрос')
  })

  await check('каталог своего эндпоинта судит о моделях, а не OpenRouter-список', async () => {
    const models = await api.fetchCustomProviderModels({ force: true })
    assert.deepEqual(models.map(m => m.id), ['моя-модель', 'вторая-модель'])
    assert.equal(api.modelExists('моя-модель'), true)
    assert.equal(api.modelExists('anthropic/claude-с-ушами'), false,
      'модель OpenRouter прошла как существующая на своём эндпоинте')
    const stored = (env.settings.get('customModelCaches') || {})[env.settings.get('activeCustomProvider')]
    assert.equal(stored.provider, openAiCompatible.PROVIDER_ID)
    assert.ok(models.every(m => m.supportsTools === false),
      'после отказа по инструментам каталог всё ещё обещает инструменты')
    const hit = stub.seen.filter(item => item.url === '/v1/models').pop()
    assert.equal(hit.headers['http-referer'], undefined, 'за списком моделей уехал OpenRouter-заголовок')
  })

  await check('эндпоинт без внятного каталога не выдумывает список', async () => {
    const source = stub.state.models
    stub.state.models = { objects: ['не список'] }
    const models = await api.fetchCustomProviderModels({ force: true })
    stub.state.models = source
    assert.ok(Array.isArray(models))
    assert.match(api.readCustomProvider().lastCheck.reason, /списк|каталог|модел/i,
      'не сказано, что каталога нет')
  })

  await check('обратное переключение возвращает каталог OpenRouter', async () => {
    env.store.set('openrouterModelCache', { updatedAt: 1, models: [{ id: 'openrouter/one', supportedEfforts: [] }] })
    const result = await invoke(api, 'set-active-provider', 'openrouter')
    assert.equal(result.ok, true)
    assert.equal(api.modelExists('openrouter/one'), true)
    assert.equal(api.modelExists('моя-модель'), false, 'свой каталог остался активным')
  })

  await check('сбой шифрования виден человеку, а не превращается в «ключа нет»', async () => {
    const plain = makeEnv({ available: false })
    const plainApi = await build(plain, stub)
    await invoke(plainApi, 'set-custom-provider', { baseUrl: base, model: 'моя-модель', key: SECRET })
    const view = await invoke(plainApi, 'get-custom-provider')
    assert.equal(view.hasKey, true, 'ключ пропал из вида')
    assert.equal(view.keyEncrypted, false, 'шифрование названо доступным, хотя его нет')
    assert.equal(view.ending, '', 'там, где шифра нет, из ключа показано что-то кроме состояния')
    assert.ok(!JSON.stringify(view).includes(SECRET), 'без шифрования ключ ушёл в renderer открыто')
  })

  await check('свой путь не требует пула OpenRouter: команда — один агент на модели эндпоинта', async () => {
    // Предыдущая проверка вернула путь на OpenRouter — включаем свой заново.
    const switched = await invoke(api, 'set-active-provider', openAiCompatible.PROVIDER_ID)
    assert.equal(switched.ok, true, `не переключилось: ${switched.reason}`)
    const catalog = await api.fetchCustomProviderModels({ force: true })
    assert.equal(catalog.length, 2, `каталог эндпоинта не прочитан: ${JSON.stringify(catalog.map(m => m.id))}`
      + ` | проверка: ${JSON.stringify(api.readCustomProvider().lastCheck)}`)
    const slots = api.customProviderTeam({ model: 'openrouter/чужая-модель' })
    assert.equal(slots.length, 1, 'на своём эндпоинте завелась команда из нескольких агентов')
    assert.equal(slots[0].role, 'lead')
    assert.equal(slots[0].modelId, 'моя-модель', 'взята не заявленная модель')
    assert.equal(slots[0].supportsTools, false,
      'возможность не унаследована от погашенного отказа')
    // Выбор из списка самого эндпоинта остаётся выбором человека.
    assert.equal(api.customProviderTeam({ model: 'вторая-модель' })[0].modelId, 'вторая-модель')
    env.store.set('activeProvider', 'openrouter')
    assert.equal(api.customProviderTeam({ model: 'x' }), null, 'обёртка подменила команду на пути OpenRouter')
    env.store.set('activeProvider', openAiCompatible.PROVIDER_ID)
  })

  await check('чужие вырезы не ломаются: resolveAgentSlots не знает про хранилище', () => {
    const slots = main.slice(main.indexOf('function resolveAgentSlots(payload)'),
      main.indexOf('// Tools are worth attaching'))
    assert.ok(!/\bstore\s*\./.test(slots),
      'в resolveAgentSlots появился store — харнесс test-model-choice его не подставляет')
    assert.ok(/customProviderTeam\(payload\)[\s\S]{0,40}\|\|\s*\n?\s*resolveAgentSlots\(payload\)/.test(main),
      'свой путь больше не подставляется перед resolveAgentSlots')
    assert.ok(main.includes('typeof customProviderTeam ==='),
      'обёртка вызывается без проверки: чужие песочницы (`test-agent-universal`) упадут на ней')
  })

  await check('статус хранилища говорит про фактический шифр, а не про доступный сейчас', () => {
    const status = main.slice(main.indexOf("ipcMain.handle('get-storage-status'"),
      main.indexOf("// Attachment IPCs"))
    assert.match(status, /customProviders: customProviderKeyStatus\(\)/,
      'статус больше не считает ключи подключений отдельным полем')
    const helper = main.slice(main.indexOf('function customProviderKeyStatus()'), main.indexOf('// Коротко о состоянии эндпоинта'))
    assert.match(helper, /keyEnc === 'safeStorage'/, 'защита меряется не по способу упаковки')
    assert.match(helper, /every\(/, 'одного base64-обёрнутого ключа хватает, чтобы сказать «зашифровано»')
    assert.ok(!/customProvider: Boolean\(readCustomProvider\(\)\?\.keyEncrypted\)/.test(status),
      'статус снова смотрит только на наличие значения')
  })

  await new Promise(resolve => stub.server.close(resolve))

  if (failures.length) console.error(`\nпровалено проверок: ${failures.length} из ${checks + failures.length}`)
  console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
  process.exit(failures.length ? 1 : 0)
}

runChecks().catch(error => { console.error('харнесс упал: ' + error.stack); process.exit(2) })
