'use strict'

// Реестр сетевых путей к модели. Запись — дескриптор: как путь называется, что
// умеет и как собрать адаптер.
//
// `builtin: true` — знак вызывающему, что сеть обрабатывает НЕ реестр: у
// встроенного OpenRouter свой пул ключей, своя ротация и свой разбор ответа, и
// живут они в main.js. Адаптера для него здесь нет нарочно.
//
// Именованные пути (OpenAI, Anthropic, Gemini, Ollama) приходят из `catalog.js`
// и собираются по `dialect`: окно читает из реестра адрес по умолчанию, форму
// ключа и возможности — своих догадок об API у него нет.

const openaiCompatible = require('./openai-compatible')
const catalog = require('./catalog')

const DEFAULT_PROVIDER_ID = 'openrouter'

const registry = new Map()

// Повторяющийся id перезаписывает дескриптор, а не бросает: настройки могут
// принести тот же id после перезапуска.
function register(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') throw new Error('Реестр провайдеров: дескриптор не передан.')
  const id = String(descriptor.id || '').trim()
  if (!id) throw new Error('Реестр провайдеров: у дескриптора нет id.')
  registry.set(id, {
    id,
    title: String(descriptor.title || id),
    builtin: Boolean(descriptor.builtin),
    kind: descriptor.kind ? String(descriptor.kind) : '',
    dialect: descriptor.dialect ? String(descriptor.dialect) : '',
    defaultBaseUrl: String(descriptor.defaultBaseUrl || ''),
    keyOptional: Boolean(descriptor.keyOptional),
    keyPlaceholder: String(descriptor.keyPlaceholder || ''),
    notes: Array.isArray(descriptor.notes) ? descriptor.notes.map(note => String(note)) : [],
    capabilities: descriptor.capabilities && typeof descriptor.capabilities === 'object'
      ? { ...descriptor.capabilities }
      : null,
    create: typeof descriptor.create === 'function' ? descriptor.create : null
  })
}

// Неизвестный id — null, а не исключение: значение пришло из настроек, где
// мог остаться id от удалённого пути.
function providerById(id) {
  const key = String(id || '').trim()
  if (!key) return null
  return registry.get(key) || null
}

function knownProviders() {
  return [...registry.values()].map(entry => ({
    id: entry.id,
    title: entry.title,
    builtin: Boolean(entry.builtin),
    kind: entry.kind,
    dialect: entry.dialect,
    defaultBaseUrl: entry.defaultBaseUrl,
    keyOptional: entry.keyOptional,
    keyPlaceholder: entry.keyPlaceholder,
    notes: [...entry.notes],
    capabilities: entry.capabilities ? { ...entry.capabilities } : null
  }))
}

// Адаптер по дескриптору. `title` и `providerId` передаются, а не берутся из
// модуля: отказ OpenAI не должен подписываться «Свой OpenAI-совместимый
// endpoint» — человек читает имя того сервера, который ему ответил.
function adapterFor(id, config = {}) {
  const entry = providerById(id)
  if (!entry) throw new Error(`Реестр провайдеров: путь «${id}» не зарегистрирован.`)
  const filled = { title: entry.title, providerId: entry.id, keyOptional: entry.keyOptional, ...config }
  if (entry.create) return entry.create(filled)
  const adapter = catalog.adapters[entry.dialect]
  if (!adapter) throw new Error(`Реестр провайдеров: у пути «${entry.id}» нет адаптера.`)
  return adapter.create(filled)
}

// Значение настройки: неизвестное, пустое и мусорное — встроенный путь.
// Источник истины по именам — реестр; короткое 'custom' принято ради того, что
// уже успело лечь в настройки первой сборки пункта 2.8.
function activeProviderId(stored) {
  const key = String(stored || '').trim()
  if (!key) return DEFAULT_PROVIDER_ID
  if (key === 'custom') return openaiCompatible.PROVIDER_ID
  return registry.has(key) ? key : DEFAULT_PROVIDER_ID
}

register({
  id: DEFAULT_PROVIDER_ID,
  title: 'OpenRouter',
  kind: 'gateway',
  builtin: true,
  capabilities: null,
  create: null
})

for (const entry of catalog.PROVIDERS) register(entry)

register({
  id: openaiCompatible.PROVIDER_ID,
  title: openaiCompatible.PROVIDER_TITLE,
  kind: 'custom',
  builtin: false,
  dialect: 'openai',
  // Те же возможности, что заявляет адаптер по умолчанию; держится здесь
  // открытой строкой, чтобы вызывающий видел их до создания адаптера.
  capabilities: { streaming: true, tools: true, catalog: true, reasoning: false, fallbackChain: false },
  create: config => openaiCompatible.create(config)
})

// Именованный путь (не встроенный и не «свой совместимый»): у него одна
// именованная учётная запись с адресом по умолчанию из каталога.
function isNamed(id) {
  const entry = providerById(id)
  return Boolean(entry) && !entry.builtin && catalog.isNamed(entry.id)
}

module.exports = {
  DEFAULT_PROVIDER_ID,
  register,
  providerById,
  knownProviders,
  adapterFor,
  activeProviderId,
  accountId: catalog.accountId,
  providerOfAccountId: catalog.providerOfAccountId,
  isNamed,
  validateBaseUrl: openaiCompatible.validateBaseUrl
}
