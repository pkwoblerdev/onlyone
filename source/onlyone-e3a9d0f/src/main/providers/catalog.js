'use strict'

// Описания путей к модели: как провайдер называется, куда стучаться, какой ключ
// нужен и что этот путь честно умеет.
//
// Адреса и формы взяты из документации провайдеров и повторяются адресными
// прогонами на локальной заглушке (`tests/test-provider-anthropic-stub.cjs`,
// `tests/test-provider-catalog.cjs`). Всё, что не подтверждено документацией и
// заглушкой, здесь не заявлено: ступени размышлений уходят только на Anthropic,
// цепочка запасных моделей и плагины остаются у OpenRouter.
//
// OpenRouter в этом списке нет нарочно: его путь — в `main.js`, со своим пулом
// ключей, ротацией по лимитам и разбором ответа.

const openaiCompatible = require('./openai-compatible')
const anthropicMessages = require('./anthropic-messages')

// Один адрес на весь пункт: у именованного провайдера одна учётная запись, и
// живёт она в том же списке, что свои подключения. Имя подходит под фильтр
// id (`^[A-Za-z0-9_-]{1,40}$`) и не воюет с точками electron-store.
const ACCOUNT_PREFIX = 'acc-'

const OPENAI_DIALECT_CAPABILITIES = { streaming: true, tools: true, catalog: true, reasoning: false, fallbackChain: false }

// Агрегатор или хостинг на открытом диалекте: всё, что у них общего, записано здесь, а в списке остаются только отличия.
function gateway({ id, title, baseUrl, keyPlaceholder, notes }) {
  return {
    id, title, kind: 'gateway', dialect: 'openai', defaultBaseUrl: baseUrl, keyOptional: false, keyPlaceholder,
    capabilities: { ...OPENAI_DIALECT_CAPABILITIES },
    notes: [...notes, 'ступени размышлений на этот адрес не передаются; цепочка запасных моделей и плагины — только у OpenRouter']
  }
}

const PROVIDERS = [
  {
    id: 'openai',
    title: 'OpenAI',
    dialect: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyOptional: false,
    keyPlaceholder: 'API-ключ OpenAI (sk-…)',
    capabilities: { ...OPENAI_DIALECT_CAPABILITIES },
    notes: [
      'список моделей — `/v1/models` самого OpenAI',
      'ступени размышлений (`reasoning`) на этот путь не передаются',
      'цепочка запасных моделей и плагины — только у OpenRouter'
    ]
  },
  {
    id: anthropicMessages.PROVIDER_ID,
    title: anthropicMessages.PROVIDER_TITLE,
    dialect: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    keyOptional: false,
    keyPlaceholder: 'API-ключ Anthropic (sk-ant-…)',
    capabilities: { streaming: true, tools: true, catalog: true, reasoning: false, fallbackChain: false },
    notes: [
      'вызов идёт нативным `POST /v1/messages` с `x-api-key` и `anthropic-version`',
      'список моделей — `/v1/models` самого Anthropic',
      'размышления сервер умеет, но список моделей пути ступеней не объявляет — в ход они не попадают'
    ]
  },
  {
    id: 'gemini',
    title: 'Google Gemini',
    dialect: 'openai',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyOptional: false,
    keyPlaceholder: 'API-ключ Google (AI Studio)',
    capabilities: { ...OPENAI_DIALECT_CAPABILITIES },
    notes: [
      'адрес — совместимый слой Google `v1beta/openai`, а не нативный `generateContent`',
      'список моделей — `/models` того же слоя',
      'ступени размышлений на этот адрес не передаются'
    ]
  },
  {
    id: 'opencode-zen',
    title: 'OpenCode Zen',
    dialect: 'openai',
    defaultBaseUrl: 'https://opencode.ai/zen/v1',
    keyOptional: false,
    keyPlaceholder: 'API-ключ OpenCode Zen',
    capabilities: { ...OPENAI_DIALECT_CAPABILITIES },
    notes: [
      'этот путь использует Chat Completions; модели, доступные только через Responses, Messages или Gemini API, им не запускаются',
      'список моделей запрашивается у OpenCode Zen'
    ]
  },
  {
    id: 'ollama',
    title: 'Ollama',
    dialect: 'openai',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    keyOptional: true,
    keyPlaceholder: 'Ключ локального сервера не нужен',
    capabilities: { ...OPENAI_DIALECT_CAPABILITIES, catalog: true },
    notes: [
      'локальный сервер: ключ не требуется и игнорируется (для ollama.com — нужен)',
      'список моделей — то, что реально загружено (`/v1/models`)',
      'вызовы инструментов зависят от модели: сервер ответит отказом — возможность погасится'
    ]
  },
  // Агрегаторы и хостинги открытых моделей: один ключ — много моделей разных авторов, как у OpenRouter. Адреса сверены с
  // документацией сервисов 07.10.2026. Все говорят на открытом диалекте chat/completions, поэтому отдельного адаптера нет:
  // отличаются адрес, форма ключа и то, какие модели умеют инструменты. Последнее выясняется на деле — отказ сервера по
  // инструментам гасит возможность у этого пути (см. describeToolsRejection), а список моделей человек может вписать руками.
  // Не добавлены нарочно: GitHub Models (по документации закрыт с 30.07.2026), Cloudflare Workers AI и Azure OpenAI (адрес
  // зависит от аккаунта или ресурса — для них есть «свой OpenAI-совместимый endpoint»).
  gateway({
    id: 'together', title: 'Together AI', baseUrl: 'https://api.together.ai/v1', keyPlaceholder: 'API-ключ Together AI',
    notes: ['открытые модели разных авторов на одном ключе', 'список моделей — `/v1/models` Together; если он не откроется, впишите модель руками']
  }),
  gateway({
    id: 'groq', title: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyPlaceholder: 'API-ключ Groq (gsk_…)',
    notes: ['очень быстрый вывод; адрес — совместимый слой `/openai/v1`', 'часть параметров OpenAI Groq не принимает (logprobs, logit_bias, n больше 1) — приложение их не шлёт']
  }),
  gateway({
    id: 'fireworks', title: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', keyPlaceholder: 'API-ключ Fireworks AI',
    notes: ['модели называются длинными путями вида `accounts/fireworks/models/…`', 'если список моделей не откроется, впишите модель руками']
  }),
  gateway({
    id: 'deepinfra', title: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', keyPlaceholder: 'API-ключ DeepInfra',
    notes: ['адрес — совместимый слой `/v1/openai`', 'вызовы инструментов зависят от модели: сервер ответит отказом — возможность погасится']
  }),
  gateway({
    id: 'huggingface', title: 'Hugging Face Inference Providers', baseUrl: 'https://router.huggingface.co/v1', keyPlaceholder: 'Токен Hugging Face (hf_…) с правом вызывать Inference Providers',
    notes: ['маршрутизатор Hugging Face к хостингам Together, Groq, Cerebras и другим: один токен', 'к имени модели можно дописать политику: `:fastest`, `:cheapest` или `:groq` (имя хостинга)', 'список моделей — `/v1/models` маршрутизатора']
  }),
  gateway({
    id: 'cerebras', title: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyPlaceholder: 'API-ключ Cerebras',
    notes: ['очень быстрый вывод на своих чипах', 'набор моделей небольшой: если список не откроется, впишите модель руками']
  }),
  gateway({
    id: 'sambanova', title: 'SambaNova Cloud', baseUrl: 'https://api.sambanova.ai/v1', keyPlaceholder: 'API-ключ SambaNova Cloud',
    notes: ['температура у SambaNova — от 0 до 1, а не до 2, как у OpenAI', 'вызовы инструментов зависят от модели']
  }),
  gateway({
    id: 'nvidia', title: 'NVIDIA NIM (build.nvidia.com)', baseUrl: 'https://integrate.api.nvidia.com/v1', keyPlaceholder: 'API-ключ NVIDIA (nvapi-…)',
    notes: ['модели, размещённые NVIDIA', 'вызовы инструментов зависят от модели: сервер ответит отказом — возможность погасится']
  }),
  gateway({
    id: 'vercel-ai-gateway', title: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1', keyPlaceholder: 'API-ключ AI Gateway',
    notes: ['шлюз Vercel к моделям разных компаний; имена вида `автор/модель`', 'список моделей — `GET /v1/models` шлюза']
  }),
  gateway({
    id: 'requesty', title: 'Requesty', baseUrl: 'https://router.requesty.ai/v1', keyPlaceholder: 'API-ключ Requesty',
    notes: ['маршрутизатор к моделям разных компаний; имена вида `автор/модель`', 'если список моделей не откроется, впишите модель руками']
  }),
  gateway({
    id: 'nebius', title: 'Nebius Token Factory', baseUrl: 'https://api.tokenfactory.nebius.com/v1', keyPlaceholder: 'API-ключ Nebius Token Factory',
    notes: ['открытые модели на инфраструктуре Nebius', 'потоковый ответ и вызовы функций поддерживаются, но зависят от модели']
  }),
  gateway({
    id: 'chutes', title: 'Chutes', baseUrl: 'https://llm.chutes.ai/v1', keyPlaceholder: 'API-ключ Chutes (cpk_…)',
    notes: ['открытые модели на децентрализованной сети; список моделей с ценами — `GET /v1/models`']
  }),
  gateway({
    id: 'siliconflow', title: 'SiliconFlow', baseUrl: 'https://api.siliconflow.com/v1', keyPlaceholder: 'API-ключ SiliconFlow',
    notes: ['международный адрес `.com`; если ваш аккаунт заведён на `.cn`, впишите `https://api.siliconflow.cn/v1` в поле «Адрес»']
  }),
  {
    id: 'lmstudio',
    title: 'LM Studio',
    kind: 'local',
    dialect: 'openai',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    keyOptional: true,
    keyPlaceholder: 'Ключ локального сервера не нужен',
    capabilities: { ...OPENAI_DIALECT_CAPABILITIES },
    notes: [
      'локальный сервер LM Studio: включите «Local Server» в программе; ключ не требуется',
      'список моделей — то, что загружено в LM Studio (`/v1/models`)',
      'вызовы инструментов зависят от модели: сервер ответит отказом — возможность погасится'
    ]
  }
]

// Для кого группа в списке: `gateway` — агрегаторы и хостинги (один ключ, много авторов, как OpenRouter), `vendor` —
// сами разработчики моделей, `local` — сервер на этой машине. Окно рисует по этому признаку подзаголовки списка.
const KIND = { openai: 'vendor', anthropic: 'vendor', gemini: 'vendor', 'opencode-zen': 'gateway', ollama: 'local' }
for (const entry of PROVIDERS) entry.kind = entry.kind || KIND[entry.id] || 'vendor'

function descriptor(id) {
  const key = String(id || '')
  return PROVIDERS.find(entry => entry.id === key) || null
}

function isNamed(id) {
  return Boolean(descriptor(id))
}

function accountId(id) {
  return `${ACCOUNT_PREFIX}${String(id || '')}`
}

function providerOfAccountId(id) {
  const text = String(id || '')
  return text.startsWith(ACCOUNT_PREFIX) ? text.slice(ACCOUNT_PREFIX.length) : ''
}

module.exports = {
  PROVIDERS,
  ACCOUNT_PREFIX,
  descriptor,
  isNamed,
  accountId,
  providerOfAccountId,
  adapters: { openai: openaiCompatible, anthropic: anthropicMessages }
}
