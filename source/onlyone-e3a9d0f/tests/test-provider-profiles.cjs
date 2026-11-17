// Несколько сохранённых подключений своего пути (план, 2.8, вторая поставка).
//
// Адаптер и один профиль уже покрыты `test-provider-custom-wiring.cjs` и
// `test-provider-openai-stub.cjs`. Здесь меряется то, что появилось вместе с
// списком: перенос прежнего ОДИНОЧНОГО подключения в массив без потери ключа,
// изоляция записей, каталогов, ключей и отказов по инструментам между
// профилями, и то, что ход идёт на адрес выбранного подключения, а не
// «первого попавшегося». Два эндпоинта играются одним сервером на 127.0.0.1
// разными префиксами пути: ни настоящих ключей, ни сети наружу.
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
  '// Statuses worth trying on a different key', 'секция своих подключений')
const REQUEST = cut('async function openRouterRequest(', '\nfunction requestHeaders(', 'openRouterRequest')
const MODEL = cut('function modelExists(modelId) {', '// One mode: the agent.', 'судьба модели')
const IPC = cut('// --- Свои OpenAI-совместимые подключения (план, 2.8)',
  '// ---------------------------------------------------------------------------\n// Updates', 'IPC подключений')

const KEY_A = 'sk-EXAMPLE315aed97276'
const KEY_B = 'sk-EXAMPLE8918c925e20'

// ---------------------------------------------------------------------------
// Подставное окружение
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


function build(env, stub) {
  const body = [
    'let currentKeyIndex = 0',
    'let modelCache = { updatedAt: 0, models: [] }',
    ENCRYPT,
    PROVIDER,
    REQUEST,
    MODEL,
    IPC,
    'return {',
    '  openRouterRequest, readCustomProvider, readCustomProviders, saveCustomProvider,',
    '  addCustomProvider, removeCustomProvider, chooseCustomProvider, activeCustomProviderId,',
    '  migrateCustomProviderOnce, getPublicCustomProvider, fetchCustomProviderModels,',
    '  applyProviderCatalog, customProviderTeam, modelCanCallTools, customProviderChosen,',
    '  customKeyValue, customProviderKeyStatus, activeProviderId, isCustomProvider, handlers',
    '}'
  ].join('\n')
  // Тело генерируется синхронно: верхнеуровневого await в вырезке нет,
  // а `async` превратил бы сборку в обещание и все `api.…` стали бы undefined.
  return new Function(
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
    apiKey => ({ Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://1code.app' }),
    () => {}, () => {}, (raw, status) => `OpenRouter ${status}`,
    // Маска границы записи настроек — настоящая, из общего модуля.
    (text, secret) => require('../src/main/providers/secret-mask').maskSecretText(text, secret),
    // Язык окна: перевод тот же словарь, что читает renderer.
    require('../src/main/ui-text.cjs').tr,
    () => false, () => false, () => null, [], 'openrouter/some-model',
    { handle: (name, fn) => env.handlers.set(name, fn) },
    env.handlers
  )
}

// ---------------------------------------------------------------------------
// Заглушка: два «разных» эндпоинта на одном сервере, по префиксу пути
// ---------------------------------------------------------------------------
function sse(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
    'data: [DONE]\n\n'
}

const SIDES = {
  a: { model: 'модель-А', answer: 'ОТВЕТ-А', key: KEY_A },
  b: { model: 'модель-Б', answer: 'ОТВЕТ-Б', key: KEY_B }
}

function startStub() {
  const seen = []
  const state = { toolsRefuse: null }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      let body = null
      try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
      const side = /^\/a\//.test(req.url) ? 'a' : /^\/b\//.test(req.url) ? 'b' : null
      seen.push({ url: req.url, side, headers: req.headers, body })
      if (!side) { res.writeHead(404).end('{}'); return }
      const profile = SIDES[side]
      if (state.toolsRefuse === side && body?.tools?.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'tools are not supported by this model' } }))
        return
      }
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: profile.model, name: profile.model }, { id: `дополнительная-${side}` }] }))
        return
      }
      const authed = req.headers.authorization === `Bearer ${profile.key}`
      if (!authed) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'wrong key' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sse(profile.answer))
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, seen, state, origin: `http://127.0.0.1:${server.address().port}` })))
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
const call = (api, channel, payload) => api.handlers.get(channel)(null, payload)

async function readStream(response) {
  let content = ''
  for (const line of (await response.text()).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') continue
    const frame = JSON.parse(payload)
    content += frame.choices?.[0]?.delta?.content || ''
  }
  return content
}

async function runChecks() {
  const stub = await startStub()
  const urlA = `${stub.origin}/a/v1`
  const urlB = `${stub.origin}/b/v1`

  // ---------------------------------------------------------------- миграция
  const legacyKey = Buffer.from('ENC:' + KEY_A, 'utf8').toString('base64')
  const legacy = {
    customProvider: {
      baseUrl: urlA, model: 'модель-А', keyEncrypted: legacyKey, keyEnc: 'safeStorage',
      capabilities: { streaming: true, tools: true, catalog: true }, updatedAt: 111,
      lastCheck: { at: 111, ok: true, reason: 'было' }
    },
    customModelCache: { updatedAt: 5, provider: openAiCompatible.PROVIDER_ID, models: [{ id: 'модель-А' }] },
    activeProvider: openAiCompatible.PROVIDER_ID
  }
  const migrated = makeEnv(legacy)
  const mapi = build(migrated, stub)

  await check('прежнее одиночное подключение переезжает в список, ключ не тронут', () => {
    assert.equal(mapi.migrateCustomProviderOnce(), true, 'миграция не сработала')
    const list = migrated.settings.get('customProviders')
    assert.equal(list.length, 1, JSON.stringify(list))
    assert.equal(list[0].id, 'default')
    assert.equal(list[0].name, 'Основное подключение')
    assert.equal(list[0].baseUrl, urlA)
    assert.equal(list[0].keyEncrypted, legacyKey, 'блоб ключа переписан — доступ к нему мог потеряться')
    assert.equal(list[0].keyEnc, 'safeStorage')
    assert.equal(migrated.settings.get('activeCustomProvider'), 'default')
    assert.equal(migrated.settings.has('customProvider'), false, 'старый ключ остался в настройках')
    assert.equal(migrated.settings.has('customModelCache'), false, 'старый каталог остался в настройках')
  })

  await check('каталог переезжает под id подключения', () => {
    const caches = migrated.settings.get('customModelCaches')
    assert.ok(caches?.default?.models?.length, JSON.stringify(caches))
    assert.equal(caches.default.models[0].id, 'модель-А')
  })

  await check('повторный запуск миграции ничего не дублирует и не ломает', () => {
    assert.equal(mapi.migrateCustomProviderOnce(), false, 'миграция запустилась второй раз')
    assert.equal(migrated.settings.get('customProviders').length, 1)
  })

  await check('мigrated-подключение работает: ход идёт на его адрес и своим ключом', async () => {
    const before = stub.seen.length
    const response = await mapi.openRouterRequest('/chat/completions',
      { body: { model: 'модель-А', messages: [{ role: 'user', content: 'привет' }] } })
    assert.equal(await readStream(response), 'ОТВЕТ-А')
    const hit = stub.seen.slice(before).find(item => item.url === '/a/v1/chat/completions')
    assert.ok(hit, 'ход не ушёл на адресмигрировавшего-подключения')
    assert.equal(hit.headers.authorization, `Bearer ${KEY_A}`)
  })

  await check('миграция не затирает уже готовый список и не заводит дубль того же адреса', () => {
    const env = makeEnv({
      customProviders: [{ id: 'x', name: 'Икc', baseUrl: urlB, model: 'модель-Б',
        keyEncrypted: 'ENCB', keyEnc: 'safeStorage' }],
      activeCustomProvider: 'x',
      customProvider: { baseUrl: urlA, model: 'модель-А', keyEncrypted: 'ENCA' }
    })
    const api = build(env, stub)
    assert.equal(api.migrateCustomProviderOnce(), true)
    const list = env.settings.get('customProviders')
    assert.deepEqual(list.map(item => item.id), ['x', 'default'], `список после переноса: ${JSON.stringify(list.map(i => i.id))}`)
    assert.equal(env.settings.get('activeCustomProvider'), 'x', 'выбранное подключение сменилось само')
    const again = makeEnv({
      customProviders: [{ id: 'd', baseUrl: urlA, model: 'модель-А', keyEncrypted: 'ENCA' }],
      customProvider: { baseUrl: urlA, model: 'модель-А', keyEncrypted: 'ENCB' }
    })
    const againApi = build(again, stub)
    assert.equal(againApi.migrateCustomProviderOnce(), true)
    // Двойник того же адреса и модели не должен остаться без секрета: если у
    // него своего нет, переносимый ключ переезжает в него.
    const twin = again.settings.get('customProviders')[0]
    assert.equal(twin.id, 'd', 'двойник завёл лишнюю запись вместо переноса')
    assert.equal(twin.keyEncrypted, 'ENCA', 'ключ двойника перезаписан')
    const keyless = makeEnv({
      customProviders: [{ id: 'x', baseUrl: urlA, model: 'модель-А', keyEncrypted: '' }],
      customProvider: { baseUrl: urlA, model: 'модель-А', keyEncrypted: 'ENCK' }
    })
    const keylessApi = build(keyless, stub)
    assert.equal(keylessApi.migrateCustomProviderOnce(), true)
    assert.equal(keyless.settings.get('customProviders')[0].keyEncrypted, 'ENCK',
      'у двойника без ключа секрет не переехал — он потерян')
    assert.equal(keylessApi.customKeyValue(keylessApi.readCustomProvider('x')), null)
  })

  await check('нераспознанная форма прежней настройки переживает запуск, а не удаляется', () => {
    for (const shape of ['строка', 42, [{ baseUrl: urlA }], { enc: 'safeStorage', data: 'Шифр' }]) {
      const envX = makeEnv({ customProvider: shape })
      const apiX = build(envX, stub)
      assert.equal(apiX.migrateCustomProviderOnce(), false,
        `миграция съела форму ${JSON.stringify(shape)}`)
      assert.deepEqual(envX.settings.get('customProvider'), shape,
        `нечитаемое удалено: ${JSON.stringify(shape)}`)
      assert.ok(envX.logs.some(line => /не распознана/.test(line)),
        'о отказе переноса молчат: ' + envX.logs.join(' | '))
    }
  })

  await check('повторный id не выбрасывает запись с ключом и чинится на диске', () => {
    const envX = makeEnv({
      customProviders: [
        { id: 'dup', name: 'Первый', baseUrl: urlA, model: 'модель-А', keyEncrypted: 'K1' },
        { id: 'dup', name: 'Второй', baseUrl: urlB, model: 'модель-Б', keyEncrypted: 'K2' }
      ]
    })
    const apiX = build(envX, stub)
    const list = apiX.readCustomProviders()
    assert.equal(list.length, 2, 'запись с чужим ключом выброшена как дубль')
    assert.equal(new Set(list.map(item => item.id)).size, 2, 'id остались одинаковыми')
    assert.deepEqual(list.map(item => item.keyEncrypted).sort(), ['K1', 'K2'])
    // Исправление должно дожить до диска: иначе id меняется при каждом чтении.
    assert.deepEqual((envX.settings.get('customProviders') || []).map(item => item.id).sort(),
      list.map(item => item.id).sort(), 'список на диске не починен')
    assert.deepEqual(apiX.readCustomProviders().map(item => item.id).sort(),
      list.map(item => item.id).sort(), 'id меняется при каждом чтении')
  })

  await check('без выбранного id ход берёт настроенное подключение, а не первое в списке', () => {
    const envX = makeEnv({
      customProviders: [
        { id: 'empty', name: 'Пустая', baseUrl: '', model: '', keyEncrypted: '' },
        { id: 'ready', name: 'Готовая', baseUrl: urlA, model: 'модель-А', keyEncrypted: 'ENC:' + KEY_A }
      ],
      activeProvider: openAiCompatible.PROVIDER_ID
    })
    const apiX = build(envX, stub)
    assert.equal(apiX.activeCustomProviderId(), 'ready',
      'ходом стало ненастроенное подключение первым в списке')
    assert.equal(apiX.readCustomProvider().model, 'модель-А')
    assert.equal(apiX.customProviderTeam({ model: '' })[0].modelId, 'модель-А',
      'команда унаследовала модель от пустой записи')
  })

  // ------------------------------------------------- два подключения рядом
  const env = makeEnv()
  const api = build(env, stub)

  await check('первое сохранение заводит подключение, второе — правит его, а не плодит', async () => {
    const first = await call(api, 'set-custom-provider',
      { name: 'Домашняя', baseUrl: urlA, model: 'модель-А', key: KEY_A })
    assert.equal(first.ok, true, first.reason)
    const second = await call(api, 'set-custom-provider', { name: 'Домашняя', baseUrl: urlA, model: 'модель-А' })
    assert.equal(second.ok, true, `правка без ключа отклонена: ${second.reason}`)
    const list = env.settings.get('customProviders')
    assert.equal(list.length, 1, `подключений стало ${list.length}`)
    assert.equal(list[0].id, first.id, 'правка создала второе подключение вместо правки первого')
    assert.equal(api.customKeyValue(list[0]), KEY_A, 'ключ пропал после второй правки без ключа')
  })

  await check('новое подключение не трогает соседнее и получает свой id', async () => {
    const added = await call(api, 'add-custom-provider', { name: 'Рабочая' })
    assert.equal(added.ok, true)
    assert.notEqual(added.id, env.settings.get('customProviders')[0].id)
    const saved = await call(api, 'set-custom-provider',
      { id: added.id, name: 'Рабочая', baseUrl: urlB, model: 'модель-Б', key: KEY_B })
    assert.equal(saved.ok, true, saved.reason)
    const list = env.settings.get('customProviders')
    assert.equal(list.length, 2)
    const home = list.find(item => item.name === 'Домашняя')
    const work = list.find(item => item.name === 'Рабочая')
    assert.equal(home.baseUrl, urlA, 'соседнему подключению поменяли адрес')
    assert.equal(home.model, 'модель-А', 'соседу поменяли модель')
    assert.equal(work.baseUrl, urlB)
    assert.ok(home.keyEncrypted && work.keyEncrypted && home.keyEncrypted !== work.keyEncrypted,
      'у двух подключений оказался один ключ на двоих')
    assert.equal(api.activeCustomProviderId(), list[0].id,
      'создание соседнего подключении само переключило ход')
  })

  await check('публичный список отдаёт по каждой записи её маску, открытого ключа нет', async () => {
    const view = await call(api, 'get-custom-provider')
    assert.equal(view.items.length, 2)
    const names = view.items.map(item => item.name).sort()
    assert.deepEqual(names, ['Домашняя', 'Рабочая'])
    const a = view.items.find(item => item.name === 'Домашняя')
    const b = view.items.find(item => item.name === 'Рабочая')
    // Маска не выдаёт из ключа ничего: ни хвоста, ни признака длины. Что ключ
    // есть и что он зашифрован — окно знает из отдельных полей.
    assert.equal(a.ending, '')
    assert.equal(b.ending, '')
    assert.equal(a.hasKey, true, 'без хвоста окно перестало видеть ключ')
    assert.equal(b.hasKey, true, 'без хвоста окно перестало видеть ключ')
    assert.equal(a.baseUrl, urlA)
    assert.equal(b.baseUrl, urlB)
    const dump = JSON.stringify(view)
    assert.ok(!dump.includes(KEY_A) && !dump.includes(KEY_B), 'открытый ключ уехал в renderer')
    assert.ok(![KEY_A, KEY_B].some(key => dump.includes(key.slice(-4))), 'в renderer уехал хвост ключа')
    assert.equal(view.activeId, a.id)
  })

  await check('путь включается только по явной команде и называет выбранное подключение', async () => {
    const switched = await call(api, 'set-active-provider', openAiCompatible.PROVIDER_ID)
    assert.equal(switched.ok, true, switched.reason)
    assert.equal(switched.activeProvider, openAiCompatible.PROVIDER_ID)
    assert.equal(switched.activeId, env.settings.get('customProviders')[0].id,
      'включение пути само выбрало не то подключение')
    assert.equal(api.activeCustomProviderId(), env.settings.get('customProviders')[0].id)
  })

  await check('ход идёт на адрес выбранного подключения и его ключом', async () => {
    const before = stub.seen.length
    const response = await api.openRouterRequest('/chat/completions',
      { body: { model: 'модель-А', messages: [] } })
    assert.equal(await readStream(response), 'ОТВЕТ-А')
    assert.equal(stub.seen.slice(before).filter(item => item.side === 'b').length, 0,
      'пока выбрана «Домашняя», соседний адрес трогать нельзя')
  })

  await check('выбор другого подключения меняет адрес, модель и каталог', async () => {
    const workId = env.settings.get('customProviders').find(item => item.name === 'Рабочая').id
    const chosen = await call(api, 'choose-custom-provider', workId)
    assert.equal(chosen.ok, true, chosen.reason)
    assert.equal(api.activeCustomProviderId(), workId)
    assert.equal(api.readCustomProvider().model, 'модель-Б')
    const before = stub.seen.length
    const response = await api.openRouterRequest('/chat/completions', { body: { model: 'модель-Б', messages: [] } })
    assert.equal(await readStream(response), 'ОТВЕТ-Б')
    assert.ok(stub.seen.slice(before).some(item => item.url === '/b/v1/chat/completions'))
    const catalog = await api.fetchCustomProviderModels({ force: true })
    assert.ok(catalog.some(item => item.id === 'модель-Б'), JSON.stringify(catalog.map(m => m.id)))
    assert.ok(!catalog.some(item => item.id === 'модель-А'), 'каталог первого подключения подмешался ко второму')
    const caches = env.settings.get('customModelCaches')
    assert.ok(caches[workId]?.models?.length, 'у выбранного нет своего каталога')
    const otherId = env.settings.get('customProviders').find(item => item.name === 'Домашняя').id
    assert.ok(!caches[otherId] || caches[otherId] !== caches[workId], 'один каталог на двоих')
  })

  await check('отказ по инструментам гасит возможность только у ответившего отказом', async () => {
    stub.state.toolsRefuse = 'b'
    await assert.rejects(() => api.openRouterRequest('/chat/completions',
      { body: { model: 'модель-Б', messages: [], tools: [{ type: 'function' }] } }), /tools are not supported/i)
    stub.state.toolsRefuse = null
    const list = env.settings.get('customProviders')
    const refused = list.find(item => item.name === 'Рабочая')
    const other = list.find(item => item.name === 'Домашняя')
    assert.equal(refused.capabilities.tools, false, 'отказ не погасился у ответившего')
    assert.equal(other.capabilities.tools, true, 'сосед унаследовал чужой отказ')
    assert.equal(api.modelCanCallTools('модель-Б'), false, 'цикл не видит погашенную возможность')
    const workId = refused.id
    const homeId = other.id
    await call(api, 'choose-custom-provider', homeId)
    assert.equal(api.modelCanCallTools('модель-А'), true,
      'после возврата к соседнему подключению инструменты остались выключенными')
    await call(api, 'choose-custom-provider', workId)
    assert.equal(api.modelCanCallTools('модель-Б'), false)
    await call(api, 'choose-custom-provider', homeId)
  })

  await check('команда своего пути берёт имя и модель выбранного подключения', async () => {
    const homeId = env.settings.get('customProviders').find(item => item.name === 'Домашняя').id
    await call(api, 'choose-custom-provider', homeId)
    const team = api.customProviderTeam({ model: 'openrouter/чужая' })
    assert.equal(team.length, 1)
    assert.equal(team[0].modelId, 'модель-А')
    assert.equal(team[0].keyName, 'Домашняя', 'команда не названа выбранным подключением')
    assert.equal(team[0].keyId, homeId)
  })

  await check('выбор ненастроенного подключения отказывает и ничего не меняет', async () => {
    const added = await call(api, 'add-custom-provider', { name: 'Пустая' })
    const before = api.activeCustomProviderId()
    const result = await call(api, 'choose-custom-provider', added.id)
    assert.equal(result.ok, false)
    assert.match(result.reason, /не настроено|адрес и модель/)
    assert.equal(api.activeCustomProviderId(), before, 'ход переключился на пустое подключение')
  })

  await check('плохой адрес не сохраняется ни в одно подключение', async () => {
    const before = JSON.stringify(env.settings.get('customProviders'))
    const result = await call(api, 'set-custom-provider', { baseUrl: 'https://user:pwd@evil.example/v1' })
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(env.settings.get('customProviders')), before, 'запись всё равно изменилась')
    assert.ok(!before.includes('pwd'))
  })

  await check('удаление соседнего не трогает выбранное; удаление последнего не подменяет путь молча', async () => {
    const list = env.settings.get('customProviders')
    const activeId = api.activeCustomProviderId()
    const otherId = list.find(item => item.id !== activeId && item.name === 'Рабочая').id
    const removed = await call(api, 'remove-custom-provider', otherId)
    assert.equal(removed.ok, true)
    assert.equal(api.activeCustomProviderId(), activeId, 'сменилось выбранное подключение')
    assert.match(removed.note, /удалено/i, removed.note)
    const caches = env.settings.get('customModelCaches')
    assert.equal(caches[otherId], undefined, 'каталог удалённого подключения остался в настройках')
    const last = await call(api, 'remove-custom-provider', activeId)
    assert.equal(last.ok, true)
    assert.equal(last.activeId, '', 'после удаления последнего осталось «выбранное»')
    // Путь остаётся тем, что выбрал человек: тихого возврата на OpenRouter нет,
    // а ход на пустом адресе отказывает внятно.
    assert.equal(api.activeProviderId(), openAiCompatible.PROVIDER_ID)
    await assert.rejects(() => api.openRouterRequest('/chat/completions',
      { body: { model: 'что-угодно', messages: [] } }), /адрес или модель не заданы/i)
    assert.match(last.note, /удалено|выберите/, last.note)
  })

  await check('чужое имя id не становится путём в настройках, а перенос без отметки честен', async () => {
    const env2 = makeEnv({
      customProvider: { baseUrl: urlA, model: 'модель-А', keyEncrypted: Buffer.from('ENC:' + KEY_A, 'utf8').toString('base64') },
      customProviders: [{ id: '../../etc/passwd', name: 'Дыра', baseUrl: urlA, model: 'модель-А', keyEncrypted: 'X' }]
    })
    const api2 = build(env2, stub)
    const list = api2.readCustomProviders()
    assert.ok(list.every(item => /^[A-Za-z0-9_-]{1,40}$/.test(item.id)),
      'id прошёл без фильтра: ' + list.map(item => item.id).join(', '))
    assert.ok(!JSON.stringify(Object.keys(env2.settings.get('customModelCaches') || {})).includes('.'))
    // Прежняя поставка не писала `keyEnc`: перенесённая запись не имеет права
    // называть себя зашифрованной.
    assert.equal(api2.migrateCustomProviderOnce(), true)
    const migrated = api2.readCustomProviders().find(item => item.keyEncrypted && item.baseUrl === urlA)
    assert.equal(migrated.keyEnc, 'unknown', 'у перенесённой записи угадан способ защиты')
    assert.equal(api2.customProviderKeyStatus().encrypted, false,
      'статус хранилища назвал перенесённый ключ защищённым')
    assert.equal(api2.getPublicCustomProvider().items.find(item => item.id === migrated.id).keyEncrypted, false,
      'окну сказано, что такой ключ защищён')
  })

  await check('пустой адрес не сохраняется как успех, а каталог без адреса не подменяется чужим', async () => {
    const before = JSON.stringify(env.settings.get('customProviders') || [])
    const saved = await call(api, 'set-custom-provider', { baseUrl: '   ', model: 'модель-К' })
    assert.equal(saved.ok, false, 'пустое сохранение прошло как успех')
    assert.match(saved.reason, /адрес/i, saved.reason)
    assert.equal(JSON.stringify(env.settings.get('customProviders') || []), before, 'запись всё равно изменилась')
    const added = await call(api, 'add-custom-provider', { name: 'Без адреса' })
    assert.deepEqual(await api.fetchCustomProviderModels({ id: added.id, force: true }), [],
      'подключению без адреса отдали каталог активного')
    // Проверка чужого подключения с отказом не должна показывать внутренность кода.
    stub.state.toolsRefuse = 'a'
    const checked = await call(api, 'check-custom-provider', { id: added.id })
    stub.state.toolsRefuse = null
    assert.ok(!/is not defined/.test(checked.reason || ''), 'в окно уехало имя функции: ' + checked.reason)
    assert.match(checked.reason || '', /адрес/i, checked.reason)
  })

  await check('одно ключ без шифра ломает общее «зашифровано» — по поведению, а не по тексту файла', () => {
    const envX = makeEnv({
      customProviders: [
        { id: 'good', baseUrl: urlA, model: 'модель-А', keyEncrypted: 'A', keyEnc: 'safeStorage' },
        { id: 'bad', baseUrl: urlB, model: 'модель-Б', keyEncrypted: 'B', keyEnc: 'plain' }
      ]
    })
    const apiX = build(envX, stub)
    const status = apiX.customProviderKeyStatus()
    assert.equal(status.count, 2)
    assert.equal(status.encrypted, false,
      'base64-обёрнутого ключа хватило, чтобы назвать всё зашифрованным')
    const view = apiX.getPublicCustomProvider()
    assert.equal(view.items.find(item => item.id === 'bad').keyEncrypted, false)
    assert.equal(view.items.find(item => item.id === 'good').keyEncrypted, true)
  })

  await check('правка без поля адреса не заводит подключение с пустым адресом', async () => {
    const envX = makeEnv()
    const apiX = build(envX, stub)
    const result = await call(apiX, 'set-custom-provider', { name: 'Без адреса', model: 'модель-А' })
    assert.equal(result.ok, false, 'пустой адрес прошёл как успех')
    assert.match(result.reason, /адрес/i, result.reason)
    assert.equal((envX.settings.get('customProviders') || []).length, 0,
      'запись всё равно создана: ' + JSON.stringify(envX.settings.get('customProviders')))
  })

  await check('в настройках нет имён с точкой и открытых ключей', () => {
    const dump = JSON.stringify([...env.settings.keys()])
    assert.ok(!dump.includes('.'), `имя ключа с точкой: ${dump}`)
    const values = JSON.stringify([...env.settings.values()])
    assert.ok(!values.includes(KEY_A) && !values.includes(KEY_B), 'открытый ключ лёг в настройки')
    assert.ok(!env.logs.some(line => line.includes(KEY_A) || line.includes(KEY_B)),
      'ключ уехал в журнал: ' + env.logs.filter(l => l.includes('sk-')).join(' | '))
    assert.ok(env.logs.some(line => line.includes('custom provider')),
      'в журнале не осталось и следа от переключений: ' + env.logs.join(' | '))
  })

  await new Promise(resolve => stub.server.close(resolve))
  if (failures.length) console.error(`\nпровалено проверок: ${failures.length} из ${checks + failures.length}`)
  console.log(failures.length ? `ПРОВАЛ: ${failures.join(' | ')}` : `проверок: ${checks}, провалов 0`)
  process.exit(failures.length ? 1 : 0)
}

runChecks().catch(error => { console.error('харнесс упал: ' + error.stack); process.exit(2) })
