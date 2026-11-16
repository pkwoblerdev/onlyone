// Недоступные модели и мёртвые ключи.
//
// Живой прогон агентов начался с того, что ведущая модель MiniMax M3 (free)
// ответила 404 «unavailable for free»: OpenRouter убрал её из бесплатных, а
// приложение подмешивало встроенный список моделей в каталог и считало её живой.
// Там же нашлись ключ, которого OpenRouter не знает (401 «User not found»), и
// модели, открытые только избранным приложениям (403). Здесь проверяется, что всё
// это запоминается и больше не попадает ни в команду, ни в выбор помощников.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const CR = String.fromCharCode(13)
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8').split(CR).join('')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const cut = (from, to) => {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a)
  assert(a >= 0 && b > a, 'не найдено: ' + from)
  return main.slice(a, b)
}

// Настоящие функции с подставным хранилищем и каталогом.
function sandbox({ catalog = [], keys = [] } = {}) {
  const data = new Map()
  const store = { get: (k, d) => (data.has(k) ? data.get(k) : d), set: (k, v) => data.set(k, v) }
  const env = { modelCache: { models: catalog } }
  // Маска секретов — общий модуль `providers/secret-mask`; отметки о здоровье
  // вызывают её из себя, поэтому песочнице она нужна, как и `store`.
  const api = new Function('store', 'env', 'loadOpenRouterKeys', 'toolsKnownBroken', 'maskSecretText', `
    ${cut('const MODEL_UNAVAILABLE_TTL_MS', 'function markToolsBroken(modelId)')}
    const modelCacheRef = env
    ${cut('function modelExists(modelId)', 'function modelCanCallTools(modelId)')
      .split('modelCache?.models').join('modelCacheRef.modelCache?.models')
      .split('modelCache.models').join('modelCacheRef.modelCache.models')}
    ${cut('function getEnabledKeys()', 'function getOpenRouterKey()')}
    const findModelRecord = id => env.modelCache.models.find(model => model.id === id)
    ${cut('function modelCanCallTools(modelId)', '\n}\n') + '\n}'}
    ${cut('const AUTO_CODER_MODELS = [', '// A model that is not in the fetched catalogue')}
    const DEFAULT_MODEL = 'z-ai/glm-5.3-flash'
    const isFreeModel = id => Boolean(id && id.endsWith(':free'))
    ${cut('function buildTeamRoster(keyCount)', '// Tools are worth attaching')}
    return { modelUnavailable, markModelUnavailable, keyDead, markKeyDead, clearKeyHealth, modelExists, getEnabledKeys, autoPickToolModel, buildModelChain, resolveAgentSlots, store }
  `)(store, env, () => keys, () => false, require('../src/main/providers/secret-mask').maskSecretText)
  return api
}

// --- модели ------------------------------------------------------------------------

check('встроенная модель, которой нет в живом каталоге, не существует', () => {
  const api = sandbox({ catalog: [{ id: 'cohere/north-mini-code:free' }, { id: 'minimax/minimax-m3:free', unavailable: true }] })
  assert.equal(api.modelExists('cohere/north-mini-code:free'), true)
  assert.equal(api.modelExists('minimax/minimax-m3:free'), false)
  assert.equal(api.modelExists('stealth/ox-alpha'), false)
})

check('до загрузки каталога модель не отвергается', () => {
  const api = sandbox({ catalog: [] })
  assert.equal(api.modelExists('anything/at-all'), true)
})

check('модель, ответившая «недоступна», выпадает, а через срок возвращается', () => {
  const api = sandbox({ catalog: [{ id: 'poolside/laguna-s-2.1:free' }] })
  api.markModelUnavailable('poolside/laguna-s-2.1:free', '404 unavailable for free')
  assert.equal(api.modelExists('poolside/laguna-s-2.1:free'), false)
  const map = api.store.get('modelHealth', {})
  map['poolside/laguna-s-2.1:free'].at = Date.now() - 13 * 60 * 60 * 1000
  api.store.set('modelHealth', map)
  assert.equal(api.modelExists('poolside/laguna-s-2.1:free'), true)
})

check('подбор помощника пропускает недоступную модель', () => {
  const api = sandbox({ catalog: [{ id: 'a:free' }, { id: 'b:free' }] })
  api.markModelUnavailable('a:free', 'gone')
  assert.equal(api.autoPickToolModel(['a:free', 'b:free']), 'b:free')
})

check('подбор не возвращает модель, если все кандидаты недоступны', () => {
  const api = sandbox({ catalog: [{ id: 'a:free' }, { id: 'b:free' }] })
  api.markModelUnavailable('a:free', 'gone')
  api.markModelUnavailable('b:free', 'gone')
  assert.equal(api.autoPickToolModel(['a:free', 'b:free']), null)
  assert.equal(api.autoPickToolModel([]), null)
})

check('подбор исключает модель без поддержки инструментов', () => {
  const api = sandbox({ catalog: [{ id: 'a:free', supportsTools: false }, { id: 'b:free', supportsTools: true }] })
  assert.equal(api.autoPickToolModel(['a:free', 'b:free']), 'b:free')
})

check('нет доступных помощников — ведущий сохраняется без пустых слотов и платной подмены', () => {
  const lead = 'z-ai/glm-5.3-flash'
  const api = sandbox({ catalog: [{ id: lead, supportsTools: true }], keys: [
    { id: 'lead', modelId: lead }, { id: 'helper', modelId: 'gone:free' }
  ] })
  const slots = api.resolveAgentSlots({ model: lead })
  assert.equal(slots.length, 1)
  assert.equal(slots[0].modelId, lead)
  assert.equal(slots[0].role, 'lead')
})

check('текстовые резервы исключают отсутствующие и заблокированные модели', () => {
  const primary = 'z-ai/glm-5.3-flash'
  const blocked = 'dots-studio/dots-3-note-preview:free'
  const healthy = 'nvidia/nemotron-3-super-120b-a12b:free'
  const api = sandbox({ catalog: [{ id: primary }, { id: blocked }, { id: healthy }] })
  api.markModelUnavailable(blocked, 'gone')
  assert.deepEqual(api.buildModelChain(primary), [primary, healthy])
  assert.deepEqual(api.buildModelChain(healthy), [healthy])
})

check('выброшенный слот не оставляет дыры в номерах команды', () => {
  const lead = 'z-ai/glm-5.3-flash'
  const own = 'nex-agi/own-pick:free'
  // Второму ключу привязана модель без вызова инструментов, а бесплатных моделей
  // из пулов в каталоге нет — его слот выпадает. Третий ключ привязан к своей
  // модели и остаётся. Номера у оставшихся обязаны идти подряд: иначе ведущему
  // скажут «помощник один», он поручит работу Агенту 2, а живого Агента 2 нет.
  const api = sandbox({
    catalog: [{ id: lead, supportsTools: true }, { id: own, supportsTools: true }, { id: 'paid/no-tools', supportsTools: false }],
    keys: [{ id: 'k1', modelId: lead }, { id: 'k2', modelId: 'paid/no-tools' }, { id: 'k3', modelId: own }]
  })
  const slots = api.resolveAgentSlots({ model: lead })
  assert.deepEqual(slots.map(slot => slot.name), ['Агент 1', 'Агент 2'])
  assert.deepEqual(slots.map(slot => slot.index), [0, 1])
  assert.equal(slots[1].modelId, own)
})

// План, 2.4: модель, выбранную человеком для ключа, не подменяем — даже платную.
check('помощник на ключе с выбранной платной моделью её и получает', () => {
  const lead = 'z-ai/glm-5.3-flash'
  const paid = 'anthropic/some-paid-model'
  const api = sandbox({
    catalog: [{ id: lead, supportsTools: true }, { id: paid, supportsTools: true }],
    keys: [{ id: 'k1', modelId: lead }, { id: 'k2', modelId: paid }]
  })
  const slots = api.resolveAgentSlots({ model: lead })
  assert.deepEqual(slots.map(slot => slot.modelId), [lead, paid])
  assert.equal(slots[1].autoPicked, false)
})

check('основной ключ идёт первым и получает место ведущего', () => {
  const api = sandbox({ keys: [{ id: 'k1', enabled: true }, { id: 'k2', enabled: true, primary: true }] })
  assert.deepEqual(api.getEnabledKeys().map(k => k.id), ['k2', 'k1'])
})

// --- ключи --------------------------------------------------------------------------

const keys = [{ id: 'k1', enabled: true }, { id: 'k2', enabled: true }, { id: 'k3', enabled: true }]

check('мёртвый ключ не занимает место в команде', () => {
  const api = sandbox({ keys })
  api.markKeyDead('k3', 'User not found')
  assert.deepEqual(api.getEnabledKeys().map(k => k.id), ['k1', 'k2'])
})

check('если мертвы все, пробуются все — отметка могла устареть', () => {
  const api = sandbox({ keys })
  for (const k of keys) api.markKeyDead(k.id, 'User not found')
  assert.equal(api.getEnabledKeys().length, 3)
})

check('изменённый ключ проверяется заново', () => {
  const api = sandbox({ keys })
  api.markKeyDead('k2', 'User not found')
  api.clearKeyHealth('k2')
  assert.equal(api.keyDead('k2'), false)
})

// --- откуда берутся отметки ------------------------------------------------------------

check('401 «User not found» помечает ключ по сырому ответу, но без ключа', () => {
  assert.match(main, /response\.status === 401 && \/user not found\|no auth credentials/)
  assert.match(main, /markKeyDead\(keyObj\.id, maskKeyInText\(raw, apiKey\)\)/)
})
check('404 «unavailable for free» и 403 «agentic harnesses» помечают модель', () => {
  assert.match(main, /response\.status === 404 && \/unavailable for free\|no endpoints found/)
  assert.match(main, /response\.status === 403 && \/only available on agentic harnesses\//)
})
check('каталог помечает встроенные модели, которых нет у OpenRouter', () => {
  assert.match(main, /unavailable: true, unavailableReason: 'нет в каталоге OpenRouter'/)
})
check('в пулах помощников нет исчезнувших и безынструментальных моделей', () => {
  const pools = cut('const AUTO_CODER_MODELS = [', 'function autoPickToolModel')
  assert.doesNotMatch(pools, /'minimax\/minimax-m3:free'/)
  assert.doesNotMatch(pools, /'z-ai\/glm-5\.2:free'/)
})
check('одиночный провал не выдумывает команду', () => {
  assert.match(main, /stages\.some\(entry => entry\.name !== lead\.name\) \? ', и другие агенты команды тоже ничего не сдали' : ''/)
})
check('в настройках видно, что ключ не работает', () => {
  assert.match(main, /dead: keyDead\(k\.id\),/)
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')
  assert.match(app, /key-health dead/)
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
