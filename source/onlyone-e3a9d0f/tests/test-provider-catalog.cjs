// Каталог путей к модели: ПРОВОДКА в главном процессе (план, каталог 25.09).
//
// Сами адаптеры проверены отдельно (`tests/test-provider-openai-stub.cjs`,
// `tests/test-provider-anthropic-stub.cjs`). Здесь меряется то, что решает только
// `main.js`: состав реестра и его сверка со словарными именами настройки, где
// лежит учётная запись именованного пути, куда уходит запрос, чей каталог
// считается живым, как гасятся возможности у одного пути, не задевая соседний, и
// что именно видит renderer. Участки главного процесса вырезаются из настоящего
// файла и вызываются против HTTP-заглушки на 127.0.0.1: ни настоящих ключей, ни
// запросов наружу, ни платной модели.
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
  '// Statuses worth trying on a different key', 'секция каталога путей')
const REQUEST = cut('async function openRouterRequest(', '\nfunction requestHeaders(', 'openRouterRequest')
const MODEL = cut('function modelExists(modelId) {', '// One mode: the agent.', 'судьба модели')
const IPC = cut('// --- Свои OpenAI-совместимые подключения (план, 2.8)',
  '// ---------------------------------------------------------------------------\n// Updates', 'IPC путей')

// ---------------------------------------------------------------------------
// Секреты: только латиница (заголовок не переносит кириллицу) и только фейковые
// ---------------------------------------------------------------------------
const KEY_OPENAI = 'sk-TEST-openai-1a2b3c'
const KEY_ANTHROPIC = 'sk-ant-TEST-4d5e6f'
const KEY_GEMINI = 'sk-TEST-gemini-7a8b9c'
const KEY_COMPAT = 'sk-TEST-compat-0d1e2f'
// Хвост короткого ключа не должен встречаться в данных каталога: порт LM Studio по умолчанию — 1234, и прежний «sk-1234»
// давал ложное срабатывание «хвост ключа уехал наружу».
const SHORT_KEY = 'sk-7q9z'
const SECRETS = [KEY_OPENAI, KEY_ANTHROPIC, KEY_GEMINI, KEY_COMPAT, SHORT_KEY]

const b64 = text => Buffer.from(text, 'utf8').toString('base64')

// Агрегаторы и хостинги (07.10.2026): адреса сверены с документацией сервисов, а не выдуманы. Любая правка адреса здесь —
// только после новой сверки: неверный адрес ломает человеку подключение молча (404 на каждый ход).
const GATEWAYS = {
  together: 'https://api.together.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  huggingface: 'https://router.huggingface.co/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  'vercel-ai-gateway': 'https://ai-gateway.vercel.sh/v1',
  requesty: 'https://router.requesty.ai/v1',
  nebius: 'https://api.tokenfactory.nebius.com/v1',
  chutes: 'https://llm.chutes.ai/v1',
  siliconflow: 'https://api.siliconflow.com/v1'
}
const NAMED = ['anthropic', 'gemini', 'ollama', 'openai', 'opencode-zen', 'lmstudio', ...Object.keys(GATEWAYS)].sort()

// Ни значения ключа, ни его оболочки: база64 — тоже секрет, просто
// неудобочитаемый. С 25.09 сюда же входит хвост: прежняя маска `…abcd`
// выдавала четыре символа ключа, и они вольно гуляли по окну и настройкам.
function assertNoSecrets(value, where) {
  const dump = JSON.stringify(value) || ''
  for (const secret of SECRETS) {
    assert.ok(!dump.includes(secret), `${where}: ключ уехал наружу открытым: ${secret.slice(0, 8)}…`)
    assert.ok(!dump.includes(b64(`ENC:${secret}`)), `${where}: ключ уехал наружу в конверте safeStorage`)
    assert.ok(!dump.includes(b64(secret)), `${where}: ключ уехал наружу голой base64-обёрткой`)
    assert.ok(!dump.includes(secret.slice(-4)), `${where}: наружу уехал хвост ключа ${secret.slice(0, 6)}…`)
  }
}

// ---------------------------------------------------------------------------
// Подставное окружение: настройки на Map, шифр-конверт, журнал, ipc
// ---------------------------------------------------------------------------
function makeEnv(seed = {}, { available = true } = {}) {
  const settings = new Map(Object.entries(seed))
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
  return { settings, store, safeStorage, logs: [], handlers: new Map() }
}

const storedList = env => env.settings.get('customProviders') || []
const storedRecord = (env, id) => storedList(env).find(item => item.id === id) || null

// Запись «как на диске»: в обход IPC, чтобы проверить чтение прежних форм.
// `keyEnc: null` — поля отметки нет вовсе (так оставила прежняя поставка).
function seedAccount(env, { provider = '', id, baseUrl, model = '', key = '', keyEnc, name = '', capabilities = null }) {
  const record = {
    id: id || providers.accountId(provider),
    name: name || (provider ? (providers.providerById(provider)?.title || provider) : 'Подключение'),
    baseUrl, model,
    keyEncrypted: key ? b64(`ENC:${key}`) : '',
    keyEnc: keyEnc || (key ? 'safeStorage' : 'unknown'),
    capabilities: { streaming: true, tools: true, catalog: true, ...(capabilities || {}) },
    createdAt: 1, updatedAt: 1
  }
  if (keyEnc === null) delete record.keyEnc
  // Поле `provider` у прежних поставок отсутствовало вовсе — важна именно
  // отсутствующая запись, а не пустая строка.
  if (provider) record.provider = provider
  else delete record.provider
  env.settings.set('customProviders',
    [...storedList(env).filter(item => item.id !== record.id), record])
  return record
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
    '  openRouterRequest, customProviderRequest, namedAccount, activeAccount, activeProviderId,',
    '  isAdapterProvider, isCustomProvider, providerDescriptor, accountTitle, accountNeedsKey,',
    '  providerAccountFor, accountIsCurrent, customProviderProfiles, readCustomProvider, readCustomProviders,',
    '  saveCustomProvider, chooseCustomProvider, removeCustomProvider, addCustomProvider, customProviderTeam,',
    '  publicCustomProviderView, getPublicCustomProvider, fetchCustomProviderModels, applyProviderCatalog,',
    '  customProviderKeyStatus, customProviderUnsupportedNotes, customKeyValue, maskSecret, modelExists,',
    '  modelCanCallTools, customProviderChosen, storeAccountRecord, CUSTOM_PROVIDER_VALUES, BUILTIN_PROVIDER_VALUES,',
    '  modelCacheRef: () => modelCache,',
    '  handlers',
    '}'
  ].join('\n')
  // Тело собирается в async-функцию: верхнеуровневого await в вырезке нет, но
  // соседние харнесы (`test-provider-custom-wiring`) ждут именно обещание.
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
    () => [{ id: 'k1', keyEncrypted: b64('ENC:or-key'), enabled: true }],
    `${stub.origin}/openrouter-api`,
    apiKey => ({ Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://1code.app', 'X-Title': 'onlyone' }),
    () => {}, () => {}, (raw, status) => `OpenRouter ${status}`,
    // Маска на границе записи настроек (`lastCheck.reason`) — настоящая,
    // из общего модуля: подменять её заглушкой значит перестать проверять маску.
    (text, secret) => require('../src/main/providers/secret-mask').maskSecretText(text, secret),
    // Язык окна: перевод тот же словарь, что читает renderer.
    require('../src/main/ui-text.cjs').tr,
    () => false, () => false, () => null, [], 'openrouter/some-model',
    { handle: (name, fn) => env.handlers.set(name, fn) },
    env.handlers
  )
}

// ---------------------------------------------------------------------------
// Заглушка: пять «разных серверов» на одном порту, по префиксу пути.
// `oa`/`gm`/`ol`/`cm` — открытый диалект, `an` — нативный Messages API.
// ---------------------------------------------------------------------------
const SIDES = {
  oa: { model: 'модель-openai-основная', extra: ['модель-openai-запас'] },
  an: { model: 'модель-anthropic-основная', extra: ['модель-anthropic-запас'] },
  gm: { model: 'модель-gemini-основная', extra: ['модель-gemini-запас'] },
  ol: { model: 'модель-ollama-основная', extra: ['модель-ollama-вторая'] },
  cm: { model: 'модель-совместимая-основная', extra: ['модель-совместимая-запас'] }
}

function openAiSse(text) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n'
  ].join('')
}

// Поток Anthropic: у каждого события пара `event:` + `data:`, как у настоящего
// сервера — разбор не должен держаться на догадке о форме.
function anthropicSse(text) {
  const first = text.slice(0, Math.ceil(text.length / 2))
  const second = text.slice(Math.ceil(text.length / 2))
  const frames = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant',
      model: SIDES.an.model, content: [], usage: { input_tokens: 11, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: first } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: second } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }]
  ]
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function route(url) {
  if (url.startsWith('/openrouter-api')) return { side: 'or', tail: url.slice('/openrouter-api'.length) }
  const found = /^\/([a-z]{2})(\/.*)$/.exec(url)
  return found ? { side: found[1], tail: found[2] } : { side: null, tail: url }
}

function startStub() {
  const seen = []
  const state = {
    // Сторона, которая отказывает запросу с инструментами: одна на прогон,
    // чтобы отказ гасил возможности ровно у неё, а не у соседа.
    toolsRefuse: null
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('error', () => {})
    res.on('error', () => {})
    req.on('end', () => {
      let body = null
      try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
      const { side, tail } = route(req.url)
      seen.push({ url: req.url, method: req.method, headers: req.headers, body, side, tail })
      try {
        const info = SIDES[side] || { model: 'модель-openrouter', extra: ['запас-openrouter'] }
        if (side === null) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'нет такой стороны' } }))
          return
        }
        if (tail.endsWith('/models')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: info.model, name: info.model, display_name: info.model }]
            .concat(info.extra.map(id => ({ id, name: id, display_name: id }))) }))
          return
        }
        if (state.toolsRefuse === side && body && body.tools && body.tools.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }))
          return
        }
        if (tail.endsWith('/messages')) {
          // Нативный диалект Anthropic: ответ собирается им, а не openai-кадрами.
          if (body && body.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.end(anthropicSse('Привет из Anthropic'))
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: info.model,
              content: [{ type: 'text', text: 'Привет из Anthropic' }], stop_reason: 'end_turn',
              usage: { input_tokens: 3, output_tokens: 5 } }))
          }
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(openAiSse(`ОТВЕТ-${String(side).toUpperCase()}`))
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end('{}')
      }
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({
      server, seen, state,
      origin: `http://127.0.0.1:${server.address().port}`,
      base: side => `http://127.0.0.1:${server.address().port}/${side}/v1`
    })
  }))
}

// Разбор открытого потока: ровно тот же, что делает главный цикл.
function readStream(text) {
  let content = ''
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
    if (choice.finish_reason) finish = choice.finish_reason
  }
  return { content, done, finish }
}

function withDeadline(promise, ms = 8000) {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`зависание: нет результата за ${ms} мс`)), ms) })
  ])
}

let checks = 0
const failures = []
async function check(name, fn) {
  try {
    await withDeadline(fn())
    checks++
    console.log('ok', name)
  } catch (error) {
    failures.push(name)
    console.error('ПРОВАЛ', name, '—', String(error && error.message || error))
  }
}

async function runChecks() {
  const stub = await startStub()

  // Каждый сценарий — свои настройки и своя песочница: учётные записи именованных
  // путей синтезируются из каталога, и общий стейдж показал бы не проводку, а
  // порядок проверок.
  async function scenario({ seed = {}, available = true } = {}) {
    const env = makeEnv(seed, { available })
    const api = await build(env, stub)
    return {
      env, api,
      invoke: (channel, payload) => withDeadline(api.handlers.get(channel)(null, payload)),
      hits: from => stub.seen.slice(from || 0),
      since: () => stub.seen.length
    }
  }

  // --- 1. Реестр и имена настройки -------------------------------------------
  await check('реестр: все пути на месте, встроенный один и это OpenRouter', async () => {
    const known = providers.knownProviders()
    assert.deepEqual(known.map(item => item.id).sort(),
      [...NAMED, 'openai-compatible', 'openrouter'].sort())
    assert.equal(known.find(item => item.id === providers.DEFAULT_PROVIDER_ID).builtin, true)
    assert.deepEqual(known.filter(item => item.builtin).map(item => item.id), ['openrouter'],
      'помимо OpenRouter появился ещё один встроенный путь — пул ключей не для него одного')
    for (const item of known.filter(entry => entry.id !== 'openrouter')) {
      assert.equal(item.builtin, false, `${item.id}: помечен встроенным`)
    }
    assert.equal(known.find(item => item.id === 'anthropic').dialect, 'anthropic')
    for (const id of NAMED.filter(name => name !== 'anthropic').concat('openai-compatible')) {
      assert.equal(known.find(item => item.id === id).dialect, 'openai', `${id}: не тот диалект`)
    }
    // Агрегаторы: адрес сверен, ключ обязателен, группа названа, возможности открытого диалекта.
    for (const [id, url] of Object.entries(GATEWAYS)) {
      const entry = known.find(item => item.id === id)
      assert.equal(entry.defaultBaseUrl, url, `${id}: адрес не тот, что в документации`)
      assert.equal(entry.kind, 'gateway', `${id}: не в группе агрегаторов`)
      assert.equal(entry.keyOptional, false, `${id}: ключ объявлен необязательным`)
      assert.ok(entry.keyPlaceholder && entry.notes.length >= 2, `${id}: нет подсказки о ключе или заметок о пути`)
      assert.equal(entry.capabilities.tools, true)
      assert.equal(openAiCompatible.validateBaseUrl(url).ok, true, `${id}: адрес не проходит проверку`)
    }
    assert.equal(known.find(item => item.id === 'lmstudio').defaultBaseUrl, 'http://127.0.0.1:1234/v1')
    assert.equal(known.find(item => item.id === 'lmstudio').keyOptional, true, 'у локального LM Studio ключа нет')
    assert.equal(known.find(item => item.id === 'lmstudio').kind, 'local')
    assert.equal(known.find(item => item.id === 'openai').kind, 'vendor')
    assert.equal(known.find(item => item.id === 'openrouter').kind, 'gateway')
    assert.equal(known.find(item => item.id === 'openai-compatible').kind, 'custom')
    assert.equal(providers.adapterFor('groq', { baseUrl: stub.base('cm') }).title, 'Groq', 'отказ Groq подписан чужим именем')
    assert.equal(providers.adapterFor('huggingface', { baseUrl: stub.base('cm') }).providerId, 'huggingface')
    const ollama = known.find(item => item.id === 'ollama')
    assert.equal(ollama.keyOptional, true, 'Ollama требует ключ, которого у локального сервера нет')
    assert.equal(ollama.defaultBaseUrl, 'http://127.0.0.1:11434/v1')
    assert.equal(known.find(item => item.id === 'anthropic').defaultBaseUrl, 'https://api.anthropic.com/v1')
    // Адаптер собирается только через реестр, и имя пути он получает от него же.
    assert.equal(providers.adapterFor('ollama', { baseUrl: stub.base('ol') }).title, 'Ollama')
    assert.equal(providers.adapterFor('gemini', { baseUrl: stub.base('gm') }).providerId, 'gemini')
    assert.throws(() => providers.adapterFor('openrouter', {}), /нет адаптера|не зарегистрирован/,
      'для встроенного пути адаптер всё-таки появился')
  })

  await check('словарные имена в main.js покрывают реестр без разъезда', async () => {
    const { api } = await scenario()
    const named = providers.knownProviders().filter(item => !item.builtin).map(item => item.id).sort()
    // Алиасы первой поставки (`custom`) допустимы, но обязаны разбираться в тот
    // же путь реестра, а не в несуществующий.
    const aliases = api.CUSTOM_PROVIDER_VALUES.filter(value => providers.activeProviderId(value) !== value)
    assert.deepEqual(aliases, ['custom'], `в настройках остались имена, которых нет в реестре: ${aliases}`)
    for (const alias of aliases) {
      const resolved = providers.providerById(providers.activeProviderId(alias))
      assert.ok(resolved && !resolved.builtin, `алиас «${alias}» ведёт не в путь из реестра`)
    }
    assert.deepEqual(api.CUSTOM_PROVIDER_VALUES.filter(value => providers.activeProviderId(value) === value).sort(), named,
      `список main.js и реестр разъехались: main.js=${JSON.stringify(api.CUSTOM_PROVIDER_VALUES)}, реестр=${JSON.stringify(named)}`)
    assert.ok(api.BUILTIN_PROVIDER_VALUES.includes(''), 'пустое значение настройки не считается встроенным')
    assert.ok(api.BUILTIN_PROVIDER_VALUES.includes(providers.DEFAULT_PROVIDER_ID),
      'имя встроенного пути пропало из словаря: окно судило бы о нём как о своём эндпоинте')
    for (const id of named) {
      assert.equal(api.BUILTIN_PROVIDER_VALUES.includes(id), false, `имя «${id}» записано и в свои, и в встроенные`)
    }
  })

  await check('id учётной записи и обратное имя пути', async () => {
    assert.equal(providers.accountId('openai'), 'acc-openai')
    assert.equal(providers.providerOfAccountId('acc-gemini'), 'gemini')
    assert.equal(providers.providerOfAccountId('p-1a2b'), '', 'профиль своего пути прочитался учётной записью провайдера')
    assert.equal(providers.isNamed('openai'), true)
    assert.equal(providers.isNamed('openai-compatible'), false, 'свой совместимый endpoint посчитался именованным путём')
    assert.equal(providers.isNamed('openrouter'), false)
    for (const id of ['openai', 'anthropic', 'gemini', 'ollama']) {
      assert.equal(providers.providerOfAccountId(providers.accountId(id)), id, `${id}: id учётки не обратим`)
    }
  })

  // --- 2. Учётная запись именованного пути -----------------------------------
  await check('учётка без записи на диске синтезируется из каталога и ничего не пишет', async () => {
    const { env, api } = await scenario()
    const account = api.namedAccount('ollama')
    assert.equal(account.id, 'acc-ollama')
    assert.equal(account.baseUrl, 'http://127.0.0.1:11434/v1', 'адрес по умолчанию не взят из каталога')
    assert.equal(account.providerTitle, 'Ollama')
    assert.equal(account.keyOptional, true)
    assert.equal(account.capabilities.tools, true)
    assert.equal(env.settings.has('customProviders'), false,
      'синтез учётки молча завёл запись в настройках')
    assert.equal(env.settings.has('activeProvider'), false, 'чтение каталога изменило активный путь')
    assert.equal(api.namedAccount('openrouter'), null, 'у встроенного пути появилась учётная запись')
    assert.equal(api.namedAccount('openai-compatible'), null, 'свой совместимый endpoint посчитался именованным')
  })

  await check('адрес человека перекрывает адрес по умолчанию', async () => {
    const { env, api } = await scenario()
    seedAccount(env, { provider: 'openai', baseUrl: stub.base('oa'), model: SIDES.oa.model, key: KEY_OPENAI })
    const account = api.namedAccount('openai')
    assert.equal(account.baseUrl, stub.base('oa'), 'записанный адрес не перекрыл каталог')
    assert.equal(account.model, SIDES.oa.model)
    assert.equal(api.activeAccount(), null, 'путь ещё не выбран, а учётка уже активна')
  })

  await check('запись без поля provider — прежний свой совместимый endpoint', async () => {
    const { env, api } = await scenario({ seed: { activeProvider: openAiCompatible.PROVIDER_ID } })
    seedAccount(env, { id: 'default', baseUrl: stub.base('cm'), model: SIDES.cm.model, key: KEY_COMPAT,
      keyEnc: null, name: 'Домашний endpoint' })
    const record = api.readCustomProvider('default')
    assert.equal(record.provider, openAiCompatible.PROVIDER_ID, 'прежний профиль потерял свой путь')
    assert.equal(record.keyEnc, 'unknown', 'запись без отметки упаковки стала называться зашифрованной')
    assert.equal(record.name, 'Домашний endpoint', 'имя, данное человеком, затёрто')
    assert.equal(api.customKeyValue(record), KEY_COMPAT, 'ключ прежней поставки не разобрался')
    assert.deepEqual(api.customProviderProfiles().map(item => item.id), ['default'],
      'прежний профиль выпал из списка своих подключений')
    assert.equal(api.customProviderChosen(), true)
    assert.equal(api.storeAccountRecord(storedList(env)).id, 'default',
      'хранилище-словарь не нашёл прежний профиль')
    // Заголовок активного пути приходит из реестра, а не из догадки окна.
    assert.equal(api.accountTitle(api.activeAccount()), 'Свой OpenAI-совместимый endpoint')
  })

  await check('items — только свои подключения, accounts — все именованные пути', async () => {
    const { env, api } = await scenario()
    seedAccount(env, { provider: 'openai', baseUrl: stub.base('oa'), model: SIDES.oa.model, key: KEY_OPENAI })
    seedAccount(env, { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model })
    seedAccount(env, { id: 'p-cm-one', baseUrl: stub.base('cm'), model: SIDES.cm.model, key: KEY_COMPAT, name: 'Мой endpoint' })
    const view = api.getPublicCustomProvider()
    assert.deepEqual(view.items.map(item => item.id), ['p-cm-one'], 'учётки провайдеров уехали в список подключений')
    assert.deepEqual(api.customProviderProfiles().map(item => item.id), ['p-cm-one'])
    assert.deepEqual(view.accounts.map(item => item.id).sort(), NAMED.map(id => `acc-${id}`).sort())
    assert.deepEqual(view.accounts.map(item => item.provider).sort(), NAMED)
    assert.equal(view.accounts.find(item => item.id === 'acc-ollama').providerTitle, 'Ollama')
    assert.equal(view.accounts.find(item => item.id === 'acc-openai').configured, true)
    // Каталог путей окно читает из вьюхи, а не знает имён на глаз.
    assert.equal(view.providers.length, NAMED.length + 2)
    assert.ok(view.providers.every(item => ['gateway', 'vendor', 'local', 'custom'].includes(item.kind)), 'у пути нет группы для списка')
    assert.equal(view.builtinId, 'openrouter')
    assert.equal(view.customId, openAiCompatible.PROVIDER_ID)
    assert.ok(view.providers.every(item => 'keyOptional' in item && 'defaultBaseUrl' in item && 'dialect' in item))
    assertNoSecrets(view, 'get-custom-provider')
  })

  await check('учётку провайдера нельзя выбрать или удалить как подключение', async () => {
    const { env, api } = await scenario()
    seedAccount(env, { provider: 'openai', baseUrl: stub.base('oa'), model: SIDES.oa.model, key: KEY_OPENAI })
    const chosen = api.chooseCustomProvider('acc-openai')
    assert.equal(chosen.ok, false, 'учётка именованного пути выбралась подключением')
    const removed = api.removeCustomProvider('acc-openai')
    assert.equal(removed.ok, false, 'учётку провайдера удалили')
    assert.match(removed.reason, /очищ|полями/i, `удаление не объяснило очистку: ${removed.reason}`)
    assert.ok(storedRecord(env, 'acc-openai'), 'отказ стер запись с диска')
    assert.equal(storedRecord(env, 'acc-openai').model, SIDES.oa.model, 'отказ поправил модель учётки')
  })

  // --- 3. Маршрут запроса ---------------------------------------------------
  await check('активный openai: ход идёт на адрес учётки, модель подменяется, журнал пишет', async () => {
    const { env, api, since, hits } = await scenario()
    seedAccount(env, { provider: 'openai', baseUrl: stub.base('oa'), model: SIDES.oa.model, key: KEY_OPENAI })
    env.settings.set('activeProvider', 'openai')
    assert.equal(api.isAdapterProvider(), true)
    const before = since()
    const response = await api.openRouterRequest('/chat/completions',
      { body: { model: 'openrouter/чужая-модель', messages: [{ role: 'user', content: 'привет' }] } })
    const stream = readStream(await response.text())
    assert.equal(stream.content, 'ОТВЕТ-OA', 'поток именованного пути не собрался')
    assert.equal(stream.done, true)
    const walk = hits(before)
    const sent = walk.filter(item => item.tail.endsWith('/chat/completions'))
    assert.equal(sent.length, 1, `на адрес учётки ушло не одно обращение: ${JSON.stringify(walk.map(i => i.url))}`)
    assert.equal(sent[0].url, '/oa/v1/chat/completions')
    assert.equal(sent[0].headers.authorization, `Bearer ${KEY_OPENAI}`)
    assert.equal(sent[0].headers['http-referer'], undefined, 'на чужой сервер уехал OpenRouter-заголовок')
    assert.ok(!walk.some(item => item.side === 'or'), 'тихо ушёл запрос на OpenRouter')
    assert.equal(sent[0].body.model, SIDES.oa.model, 'заявленная модель не подставлена')
    assert.ok(env.logs.some(line => line.includes(`custom provider model openrouter/чужая-модель → ${SIDES.oa.model}`)),
      `подмена модели не записана в журнал: ${JSON.stringify(env.logs.slice(-4))}`)
  })

  await check('активный anthropic: POST /v1/messages с x-api-key, ответ — открытым диалектом', async () => {
    const { env, api, since, hits } = await scenario()
    seedAccount(env, { provider: 'anthropic', baseUrl: stub.base('an'), model: SIDES.an.model, key: KEY_ANTHROPIC })
    env.settings.set('activeProvider', 'anthropic')
    const before = since()
    const response = await api.openRouterRequest('/chat/completions',
      { body: { model: SIDES.an.model, messages: [{ role: 'user', content: 'привет' }], stream: true } })
    const stream = readStream(await response.text())
    const walk = hits(before)
    assert.deepEqual(walk.map(item => item.url), ['/an/v1/messages'], `ушёл не нативный вызов: ${JSON.stringify(walk.map(i => i.url))}`)
    const sent = walk[0]
    assert.equal(sent.method, 'POST')
    assert.equal(sent.headers['x-api-key'], KEY_ANTHROPIC, 'ключ Anthropic не лёг в свой заголовок')
    assert.equal(sent.headers['anthropic-version'], '2023-06-01')
    assert.equal(sent.headers.authorization, undefined, 'вместо x-api-key уехал Bearer')
    assert.equal(sent.headers['http-referer'], undefined)
    // Перевод туда и обратно: тело нативное, а разбор — тот же openai-поток.
    assert.ok(Array.isArray(sent.body.messages) && sent.body.messages.length, 'сообщения не переведены')
    assert.equal(sent.body.model, SIDES.an.model)
    assert.equal(stream.content, 'Привет из Anthropic', 'поток Anthropic не собрался как openai')
    assert.equal(stream.done, true, 'признака конца потока нет')
  })

  await check('Ollama без ключа открыт, а openai/anthropic/gemini без ключа — громкий отказ с именем пути', async () => {
    const bare = await scenario()
    seedAccount(bare.env, { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model })
    bare.env.settings.set('activeProvider', 'ollama')
    const before = bare.since()
    const response = await bare.api.openRouterRequest('/chat/completions',
      { body: { model: SIDES.ol.model, messages: [{ role: 'user', content: 'привет' }] } })
    assert.equal(readStream(await response.text()).content, 'ОТВЕТ-OL', 'без ключа запрос Ollama не прошёл')
    const sent = bare.hits(before)[0]
    assert.equal(sent.headers.authorization, undefined, 'пустой ключ уехал в Authorization')
    assert.equal(bare.api.accountNeedsKey(bare.api.namedAccount('ollama')), false,
      'для Ollama ключ всё ещё обязателен')

    for (const [id, side, title] of [['openai', 'oa', 'OpenAI'], ['anthropic', 'an', 'Anthropic'], ['gemini', 'gm', 'Google Gemini']]) {
      const one = await scenario()
      seedAccount(one.env, { provider: id, baseUrl: stub.base(side), model: SIDES[side].model })
      one.env.settings.set('activeProvider', id)
      assert.equal(one.api.accountNeedsKey(one.api.namedAccount(id)), true, `${title}: ключ объявлен необязательным`)
      const mark = one.since()
      let message = ''
      try {
        await one.api.openRouterRequest('/chat/completions',
          { body: { model: SIDES[side].model, messages: [{ role: 'user', content: 'привет' }] } })
      } catch (error) { message = error.message }
      assert.match(message, /ключ/i, `${title}: отказ не про ключ — ${message}`)
      assert.ok(message.includes(title), `отказ не называет имя пути «${title}»: ${message}`)
      assert.doesNotMatch(message, /Свой OpenAI-совместимый/, `отказ подписан общим именем: ${message}`)
      assert.equal(one.hits(mark).length, 0, `${title}: без ключа запрос всё-таки ушёл`)
    }
  })

  // --- 4. Переключение пути -------------------------------------------------
  await check('set-active-provider без модели отказывает и называет, чего не хватает', async () => {
    const { env, invoke } = await scenario()
    const saved = await invoke('set-custom-provider', { provider: 'anthropic', baseUrl: stub.base('an'), key: KEY_ANTHROPIC })
    assert.equal(saved.ok, true, `учётка не сохранилась: ${saved.reason}`)
    assert.equal(saved.id, 'acc-anthropic', 'учётка сохранена под своим id')
    const result = await invoke('set-active-provider', 'anthropic')
    assert.equal(result.ok, false, 'переключение на путь без модели прошло')
    assert.match(result.reason, /Anthropic/, `в отказе нет имени пути: ${result.reason}`)
    assert.match(result.reason, /модел/, `в отказе не названо, чего не хватает: ${result.reason}`)
    assert.doesNotMatch(result.reason, /ключ/, 'не хватало модели, а отказ требует ключ')
    assert.equal(env.settings.has('activeProvider'), false, 'отказ всё-таки сменил путь')

    const withModel = await invoke('set-custom-provider', { provider: 'anthropic', model: SIDES.an.model })
    assert.equal(withModel.ok, true, withModel.reason)
    const switched = await invoke('set-active-provider', 'anthropic')
    assert.equal(switched.ok, true, `переключение не прошло: ${switched.reason}`)
    assert.equal(switched.activeProvider, 'anthropic')
    assert.equal(env.settings.get('activeProvider'), 'anthropic')
    assert.equal(switched.defaultModel, SIDES.an.model, 'окно получил не модель учётки')
    assert.equal(switched.provider.active.id, 'acc-anthropic')
  })

  await check('каталоги не путаются: список чужого пути не подменяет живой', async () => {
    const { env, api } = await scenario()
    seedAccount(env, { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model })
    seedAccount(env, { provider: 'openai', baseUrl: stub.base('oa'), model: SIDES.oa.model, key: KEY_OPENAI })
    env.settings.set('activeProvider', 'ollama')
    const own = await api.fetchCustomProviderModels({ provider: 'ollama', force: true })
    assert.deepEqual(own.map(item => item.id), [SIDES.ol.model, 'модель-ollama-вторая'])
    const live = api.modelCacheRef()
    assert.equal(live.profileId, 'acc-ollama')
    assert.equal(live.provider, 'ollama')

    const other = await api.fetchCustomProviderModels({ id: 'acc-openai' })
    assert.deepEqual(other.map(item => item.id), [SIDES.oa.model, 'модель-openai-запас'],
      'список чужого пути не прочитался')
    assert.equal(api.modelCacheRef(), live, 'живой каталог подменён списком другой учётки')
    assert.deepEqual(api.modelCacheRef().models.map(item => item.id), own.map(item => item.id))
    assert.equal(api.modelExists(SIDES.oa.model), false, 'модель чужого пути прошла на активном')
    const caches = env.settings.get('customModelCaches')
    assert.deepEqual(Object.keys(caches).sort(), ['acc-ollama', 'acc-openai'])
    assert.equal(caches['acc-openai'].provider, 'openai')
  })

  await check('applyProviderCatalog для ollama берёт каталог acc-ollama', async () => {
    const { env, api } = await scenario({ seed: {
      activeProvider: 'ollama',
      openrouterModelCache: { updatedAt: 9, models: [{ id: 'openrouter/что-то', supportedEfforts: [] }] },
      customModelCaches: {
        'acc-ollama': { updatedAt: 5, provider: 'ollama', models: [{ id: SIDES.ol.model, name: SIDES.ol.model }] },
        'acc-openai': { updatedAt: 6, provider: 'openai', models: [{ id: SIDES.oa.model, name: SIDES.oa.model }] }
      }
    } })
    seedAccount(env, { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model })
    api.applyProviderCatalog()
    const live = api.modelCacheRef()
    assert.equal(live.provider, 'ollama', `активный каталог не у того пути: ${live.provider}`)
    assert.deepEqual(live.models.map(item => item.id), [SIDES.ol.model])
    assert.equal(api.modelExists(SIDES.ol.model), true)
    assert.equal(api.modelExists(SIDES.oa.model), false, 'каталог acc-openai встал живым')
    assert.equal(api.modelExists('openrouter/что-то'), false, 'список OpenRouter решил о моделях своего пути')
  })

  // --- 5. Команда, возможности, статусы ------------------------------------
  await check('команда именованного пути: один агент на модели учётки, tools из возможностей учётки', async () => {
    const { env, api } = await scenario()
    seedAccount(env, { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model })
    env.settings.set('activeProvider', 'ollama')
    const slots = api.customProviderTeam({ model: 'openrouter/чужая-модель' })
    assert.equal(slots.length, 1, 'на именованном пути завелась команда из нескольких агентов')
    assert.equal(slots[0].role, 'lead')
    assert.equal(slots[0].modelId, SIDES.ol.model, 'взята не заявленная учёткой модель')
    assert.equal(slots[0].keyId, 'acc-ollama')
    assert.equal(slots[0].supportsTools, true, 'свежая учётка каталога сразу объявила tools погашенной')
    api.saveCustomProvider({ id: 'acc-ollama', capabilities: { tools: false } })
    assert.equal(api.customProviderTeam({ model: SIDES.ol.model })[0].supportsTools, false,
      'погашенная возможность не вернулась каталогом')
    env.settings.set('activeProvider', 'openrouter')
    assert.equal(api.customProviderTeam({ model: 'x' }), null, 'обёртка подменила команду на встроенном пути')
  })

  await check('отказ сервера по инструментам гасит tools только у ответившего пути', async () => {
    const { env, api } = await scenario()
    seedAccount(env, { provider: 'openai', baseUrl: stub.base('oa'), model: SIDES.oa.model, key: KEY_OPENAI })
    seedAccount(env, { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model })
    env.settings.set('activeProvider', 'openai')
    stub.state.toolsRefuse = 'oa'
    await assert.rejects(() => api.openRouterRequest('/chat/completions',
      { body: { model: SIDES.oa.model, messages: [{ role: 'user', content: 'привет' }], tools: [{ type: 'function' }] } }),
      /tools are not supported|OpenAI/i)
    stub.state.toolsRefuse = null
    assert.equal(api.namedAccount('openai').capabilities.tools, false, 'возможность не погасилась у ответившего')
    assert.equal(api.namedAccount('ollama').capabilities.tools, true, 'чужой отказ погасил инструменты соседнего пути')
    assert.equal(storedRecord(env, 'acc-ollama')?.capabilities.tools, true, 'отказ уехал на диск соседней записи')
    // Соседний путь остаётся рабочим: проверка его учётки не наследует отказ.
    env.settings.set('activeProvider', 'ollama')
    api.applyProviderCatalog()
    assert.equal(api.modelCanCallTools(SIDES.ol.model), true, 'активный Ollama считает инструменты мёртвыми')
    const neighbour = await api.fetchCustomProviderModels({ provider: 'ollama', force: true })
    assert.ok(neighbour.every(item => item.supportsTools === true), 'каталог соседнего пути обещает отказ')
    assert.equal(storedRecord(env, 'acc-openai').capabilities.tools, false,
      'отказ ответившего пути вернулся на диск после проверки соседа')
  })

  await check('customProviderUnsupportedNotes: свои строки пути плюс честные две про OpenRouter', async () => {
    const { env, api } = await scenario()
    seedAccount(env, { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model })
    seedAccount(env, { provider: 'anthropic', baseUrl: stub.base('an'), model: SIDES.an.model, key: KEY_ANTHROPIC })
    seedAccount(env, { id: 'p-cm', baseUrl: stub.base('cm'), model: SIDES.cm.model, key: KEY_COMPAT })

    env.settings.set('activeProvider', 'ollama')
    const ollamaNotes = api.customProviderUnsupportedNotes()
    assert.equal(ollamaNotes.filter(line => /только OpenRouter/.test(line)).length, 2,
      `строк про OpenRouter не две: ${JSON.stringify(ollamaNotes)}`)
    assert.ok(ollamaNotes.some(line => /локальный сервер/.test(line)), 'свои строки Ollama не показаны')
    assert.doesNotMatch(JSON.stringify(ollamaNotes), /зависят от эндпоинта/, 'Ollama описан как свой endpoint')

    env.settings.set('activeProvider', 'anthropic')
    const anthropicNotes = api.customProviderUnsupportedNotes()
    assert.ok(anthropicNotes.some(line => /v1\/messages|x-api-key/.test(line)), 'нативный вызов Anthropic не назван')
    assert.doesNotMatch(JSON.stringify(anthropicNotes), /зависят от эндпоинта/, 'Anthropic с нативным thinking описан догадкой')

    env.store.set('activeCustomProvider', 'p-cm')
    env.settings.set('activeProvider', openAiCompatible.PROVIDER_ID)
    const ownNotes = api.customProviderUnsupportedNotes()
    assert.equal(ownNotes.length, 3, `для своего пути строк не три: ${JSON.stringify(ownNotes)}`)
    assert.match(ownNotes[2], /reasoning/, 'прежняя строка про ступени рассуждений пропала')
  })

  await check('наружу не уходит ни ключ, ни его base64 — обход всех каналов', async () => {
    const { env, invoke } = await scenario()
    seedAccount(env, { provider: 'openai', baseUrl: stub.base('oa'), model: SIDES.oa.model, key: KEY_OPENAI })
    seedAccount(env, { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model })
    const responses = []
    responses.push(await invoke('get-custom-provider'))
    responses.push(await invoke('set-custom-provider',
      { provider: 'gemini', baseUrl: stub.base('gm'), model: SIDES.gm.model, key: KEY_GEMINI }))
    responses.push(await invoke('set-custom-provider', { baseUrl: stub.base('cm'), model: SIDES.cm.model, key: KEY_COMPAT }))
    responses.push(await invoke('set-custom-provider', { baseUrl: 'https://login:paSSw0rd@evil.example/v1' }))
    responses.push(await invoke('add-custom-provider', { name: 'Черновик' }))
    responses.push(await invoke('check-custom-provider', { provider: 'ollama' }))
    responses.push(await invoke('choose-custom-provider', 'acc-openai'))
    responses.push(await invoke('set-active-provider', 'openai'))
    responses.push(await invoke('set-active-provider', 'openrouter'))
    responses.push(await invoke('remove-custom-provider', 'acc-gemini'))
    const dump = JSON.stringify(responses)
    assertNoSecrets(responses, 'ответы каналов')
    assert.ok(!/"keyEncrypted"\s*:\s*"/.test(dump), 'blob ключа уехал в renderer строкой')
    assert.ok(!/"key"\s*:/.test(dump), 'открытый ключ вернулся в ответе канала')
    assert.ok(!dump.includes('paSSw0rd'), 'адрес с паролем вернулся в ответе')
    assert.ok(storedRecord(env, 'acc-openai').keyEncrypted, 'ключ пропал с диска — проверка была бы пустой')
  })

  await check('check-custom-provider: живой Ollama даёт модели, битый адрес — отказ валидации', async () => {
    const { env, invoke, since, hits } = await scenario()
    seedAccount(env, { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model })
    const before = since()
    const result = await invoke('check-custom-provider', { provider: 'ollama' })
    assert.equal(result.ok, true, `живой путь не прошёл проверку: ${result.reason}`)
    assert.equal(result.id, 'acc-ollama')
    assert.equal(result.providerId, 'ollama')
    assert.equal(result.local, true, 'локальный сервер не назван локальным')
    assert.deepEqual(result.models.map(item => item.id), [SIDES.ol.model, 'модель-ollama-вторая'])
    assert.match(result.reason, /модел/, 'причина не объясняет успех')
    assert.ok(hits(before).length && hits(before).every(item => item.tail.endsWith('/models') && item.side === 'ol'),
      `проверка ходила не только за списком моделей: ${JSON.stringify(hits(before).map(i => i.url))}`)
    assert.ok(storedRecord(env, 'acc-ollama').lastCheck.ok, 'вердикт не лёг на диск')

    const broken = await scenario()
    seedAccount(broken.env, { provider: 'ollama', baseUrl: 'ftp://127.0.0.1:11434/v1', model: SIDES.ol.model })
    const mark = broken.since()
    const bad = await broken.invoke('check-custom-provider', { provider: 'ollama' })
    assert.equal(bad.ok, false, 'битый адрес прошёл проверку')
    assert.match(bad.reason, /протокол|адрес/, `причина не про адрес: ${bad.reason}`)
    assert.equal(broken.hits(mark).length, 0, 'на неподходящий адрес всё-таки ушёл запрос')
  })

  await check('маска не выдаёт из ключа ничего: ни хвоста, ни начала, ни длины', async () => {
    const { env, api } = await scenario()
    // Правило с 25.09.2026 (блок «безопасность подключения»): окно получает
    // только состояние. Прежний `…abcd` был частью секрета и уезжал в DOM, в
    // подсказку и в диалог удаления, а для короткого ключа — весь ключ.
    assert.equal(api.maskSecret(KEY_COMPAT), '')
    assert.equal(api.maskSecret(SHORT_KEY), '')
    assert.equal(api.maskSecret(''), '')
    seedAccount(env, { provider: 'openai', baseUrl: stub.base('oa'), model: SIDES.oa.model, key: KEY_OPENAI })
    seedAccount(env, { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model, key: SHORT_KEY })
    const accounts = api.getPublicCustomProvider().accounts
    const long = accounts.find(item => item.id === 'acc-openai')
    assert.equal(long.ending, '', `из длинного ключа уехало «${long.ending}»`)
    const short = accounts.find(item => item.id === 'acc-ollama')
    assert.equal(short.ending, '', `маска короткого ключа показала «${short.ending}»`)
    const dump = JSON.stringify([long, short])
    assert.ok(!dump.includes(SHORT_KEY), 'короткий ключ уехал в вьюху')
    assert.ok(!dump.includes(SHORT_KEY.slice(-4)), 'хвост короткого ключа уехал в вьюху')
    assert.ok(!dump.includes(KEY_OPENAI.slice(-4)), 'хвост длинного ключа уехал в вьюху')
    assert.equal(long.hasKey, true, 'без хвоста окно перестало видеть, что ключ есть')
    assert.equal(short.hasKey, true, 'короткий ключ без хвоста стал «ключа нет»')
    // Ключ, который не открылся этой учётной записью Windows, виден человеку.
    env.settings.set('customProviders', [...storedList(env),
      { id: 'acc-gemini', provider: 'gemini', name: 'Google Gemini', baseUrl: stub.base('gm'),
        model: SIDES.gm.model, keyEncrypted: b64('не-наш-конверт'), keyEnc: 'safeStorage' }])
    const gone = api.publicCustomProviderView(api.namedAccount('gemini'))
    assert.equal(gone.hasKey, false)
    assert.equal(gone.ending, 'не читается', 'невскрываемый ключ молча стал «ключа нет»')
  })

  await check('ключ упаковывается шифром, а без шифра честно называется открытым', async () => {
    const { env, api, invoke } = await scenario()
    const saved = await invoke('set-custom-provider',
      { provider: 'openai', baseUrl: stub.base('oa'), model: SIDES.oa.model, key: KEY_OPENAI })
    assert.equal(saved.ok, true, saved.reason)
    const record = storedRecord(env, 'acc-openai')
    assert.equal(record.keyEnc, 'safeStorage', 'способ упаковки не отмечен')
    assert.notEqual(record.keyEncrypted, b64(KEY_OPENAI), 'ключ лёг открытой base64 при доступном safeStorage')
    assert.ok(Buffer.from(record.keyEncrypted, 'base64').toString('utf8').startsWith('ENC:'),
      'safeStorage не применялся')
    const view = api.publicCustomProviderView(api.namedAccount('openai'))
    assert.equal(view.keyEncrypted, true, 'защита не подтверждена при доступном шифре')
    assert.equal(view.hasKey, true)
    assertNoSecrets(view, 'вьюха с зашифрованным ключом')

    const plain = await scenario({ available: false })
    const savedPlain = await plain.invoke('set-custom-provider',
      { provider: 'ollama', baseUrl: stub.base('ol'), model: SIDES.ol.model, key: SHORT_KEY })
    assert.equal(savedPlain.ok, true, savedPlain.reason)
    const plainRecord = storedRecord(plain.env, 'acc-ollama')
    assert.equal(plainRecord.keyEnc, 'plain', 'открытая base64 названа шифром')
    assert.equal(plainRecord.keyEncrypted, b64(SHORT_KEY))
    const plainView = plain.api.publicCustomProviderView(plain.api.namedAccount('ollama'))
    assert.equal(plainView.hasKey, true, 'ключ пропал из вида там, где нет шифра')
    assert.equal(plainView.keyEncrypted, false, 'вьюха назвала шифрованием открытую base64')
    assert.equal(plainView.ending, '', 'там, где шифра нет, из ключа показано что-то кроме состояния')
    assertNoSecrets([savedPlain, savedPlain.provider], 'ответ сохранения без шифра')
    assert.equal(plain.api.customProviderKeyStatus().encrypted, false,
      'статус хранилища обещает шифрование там, где его нет')
  })

  await check('правка модели одной учётки не задевает соседнюю', async () => {
    const { env, invoke } = await scenario()
    await invoke('set-custom-provider', { provider: 'openai', baseUrl: stub.base('oa'), model: SIDES.oa.model, key: KEY_OPENAI })
    await invoke('set-custom-provider', { provider: 'gemini', baseUrl: stub.base('gm'), model: SIDES.gm.model, key: KEY_GEMINI })
    const before = storedRecord(env, 'acc-openai')
    const edited = await invoke('set-custom-provider', { provider: 'gemini', model: 'модель-gemini-новая' })
    assert.equal(edited.ok, true, edited.reason)
    assert.equal(edited.id, 'acc-gemini')
    const after = storedRecord(env, 'acc-openai')
    assert.equal(after.model, before.model, 'правка gemini изменила модель openai')
    assert.equal(after.baseUrl, before.baseUrl, 'правка gemini изменила адрес openai')
    assert.equal(after.keyEncrypted, before.keyEncrypted, 'правка gemini тронула ключ openai')
    assert.equal(storedRecord(env, 'acc-gemini').model, 'модель-gemini-новая')
    assert.equal(storedList(env).length, 2, 'правка завела лишнюю запись')
  })

  await check('окно присылает имя пути из view.providers — каждое имя вне встроенного пути принимается', async () => {
    // Выпадающий список окна строится из `view.providers`, и в нём лежат все пути
    // реестра, кроме встроенного, включая `openai-compatible`: окно возвращает то
    // же имя в `patch.provider`. Отказывать такому имени — значит ломать
    // сохранение подключения, которое человек только что выбрал.
    const { env, invoke } = await scenario()
    const view = await invoke('get-custom-provider')
    const names = view.providers.filter(item => !item.builtin).map(item => item.id)
    assert.deepEqual(names.sort(), [...NAMED, 'openai-compatible'].sort())
    // Остальные пути (агрегаторы, LM Studio) говорят на открытом диалекте — стороны `cm` заглушки хватает.
    const sides = { openai: 'oa', anthropic: 'an', gemini: 'gm', ollama: 'ol', 'opencode-zen': 'cm', 'openai-compatible': 'cm' }
    for (const name of names) if (!sides[name]) sides[name] = 'cm'
    for (const name of names) {
      const saved = await invoke('set-custom-provider',
        { provider: name, baseUrl: stub.base(sides[name]), model: `модель-${name}` })
      assert.equal(saved.ok, true, `сохранение пути «${name}» отказало: ${saved.reason}`)
      const record = storedRecord(env, saved.id)
      assert.equal(record.provider, name, `имя пути «${name}» не дошло до настроек: ${record.provider}`)
      if (providers.isNamed(name)) {
        assert.equal(saved.id, providers.accountId(name), `${name}: учётка не под своим id`)
      } else {
        assert.ok(!String(saved.id).startsWith('acc-'), `${name}: совместимое подключение стало учёткой провайдера`)
      }
    }

    // Встроенный путь учётной записью не становится ни при каком раскладе:
    // имя отбрасывается, а запись живёт среди своих подключений.
    const builtin = await invoke('set-custom-provider',
      { provider: providers.DEFAULT_PROVIDER_ID, baseUrl: stub.base('cm'), model: 'модель-черновик' })
    assert.equal(storedRecord(env, builtin.id).provider, openAiCompatible.PROVIDER_ID,
      'в настройках появился встроенный путь')
    // Имени, которого нет даже в реестре, окно не получает: оно не заведёт
    // несуществующую учётку и не уедет в настройки.
    const ghost = await invoke('set-custom-provider', { provider: 'qwen-cloud', baseUrl: stub.base('cm'), model: 'x' })
    assert.equal(storedRecord(env, ghost.id).provider, openAiCompatible.PROVIDER_ID,
      'несуществующий путь записан как учётная запись каталога')
    assert.equal(storedList(env).filter(item => String(item.id).startsWith('acc-') && item.provider === 'qwen-cloud').length, 0)
  })

  // --- 6. Встроенный путь остаётся встроенным -------------------------------
  await check('пока выбран OpenRouter, ни одна учётка каталога не тронута', async () => {
    const { env, api, since, hits } = await scenario()
    for (const [id, side, key] of [['openai', 'oa', KEY_OPENAI], ['anthropic', 'an', KEY_ANTHROPIC], ['gemini', 'gm', KEY_GEMINI], ['ollama', 'ol', '']]) {
      seedAccount(env, { provider: id, baseUrl: stub.base(side), model: SIDES[side].model, key })
    }
    seedAccount(env, { id: 'p-cm', baseUrl: stub.base('cm'), model: SIDES.cm.model, key: KEY_COMPAT })
    const before = since()
    assert.equal(api.isAdapterProvider(), false)
    assert.equal(api.activeAccount(), null)
    assert.equal(api.customProviderTeam({ model: 'openrouter/x' }), null)
    const response = await api.openRouterRequest('/chat/completions',
      { body: { model: 'openrouter/x', messages: [{ role: 'user', content: 'привет' }] } })
    assert.equal(readStream(await response.text()).content, 'ОТВЕТ-OR')
    const walk = hits(before)
    assert.deepEqual([...new Set(walk.map(item => item.side))], ['or'],
      `пока выбран встроенный путь, запросы ушли не только на него: ${JSON.stringify(walk.map(i => i.url))}`)
    assert.equal(walk[0].url, '/openrouter-api/chat/completions')
    assert.equal(walk[0].headers['http-referer'], 'https://1code.app', 'со встроенного пути сняли свой заголовок')
    assert.equal(walk[0].headers.authorization, 'Bearer or-key',
      'встроенный путь пошёл не по пулу ключей OpenRouter')
    assert.equal(api.getPublicCustomProvider().activeProvider, 'openrouter')
  })

  // --- 7. Роутинг канала окна ------------------------------------------------
  await check('fetch-models роутится по признаку адаптерного пути, а не только «своего совместимого»', async () => {
    const line = main.slice(main.indexOf("ipcMain.handle('fetch-models'"),
      main.indexOf('// --- Свои OpenAI-совместимые подключения'))
    assert.ok(line.length > 0, 'канал fetch-models не найден')
    assert.match(line, /isAdapterProvider\(\)\s*\?\s*fetchCustomProviderModels/,
      `канал роутится по isCustomProvider(): на именованном пути список моделей просит у OpenRouter и подменяет живой каталог. Строка: ${line.replace(/\s+/g, ' ').trim()}`)
    assert.doesNotMatch(line, /isCustomProvider\(\)\s*\?\s*fetchCustomProviderModels/,
      'прежний признак остался рядом с новым')
  })

  await new Promise(resolve => stub.server.close(resolve))

  if (failures.length) console.error(`\nпровалено проверок: ${failures.length} из ${checks + failures.length}`)
  console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
  process.exit(failures.length ? 1 : 0)
}

runChecks().catch(error => { console.error('харнесс упал: ' + error.stack); process.exit(2) })
