'use strict'
const { maskSecretText } = require('./secret-mask')

// Свой OpenAI-совместимый endpoint: адрес + модель + API-ключ от человека.
// Ни Electron'а, ни хранилища здесь нет: ключ приходит аргументом уже
// расширенным и уходит только в заголовок Authorization.
//
// request возвращает НАСТОЯЩИЙ Response, поэтому разбор потока остаётся у
// вызывающего кода без изменений: диалект здесь ровно openai-совместимый —
// `data: {...}`, `choices[].delta.content`, `choices[].delta.tool_calls` и
// конец потока `data: [DONE]`.
//
// Секретов в текстах ошибок нет: описывается только ответ сервера, а не запрос.

const PROVIDER_ID = 'openai-compatible'
const PROVIDER_TITLE = 'Свой OpenAI-совместимый endpoint'

// Поля, которые понимает только OpenRouter: цепочка фолбэка, плагины и глубина
// размышлений. На чужом сервере они чаще дают 400, чем что-то полезное,
// поэтому уходят из тела, а их имена — в onUnsupported.
const OPENROUTER_ONLY_FIELDS = ['models', 'plugins', 'reasoning']

// Статусы, с которыми отказ можно объяснить неподдержкой инструментов.
const TOOLS_REJECTION_STATUS = new Set([400, 404, 422])

// Описания ошибок читают в ленте: длиннее 300 знаков строка уже не полезна.
const ERROR_LINE_LIMIT = 300
const RAW_TEXT_LIMIT = 200

// Срок ожидания списка моделей: свой, потому что каталог запрашивают из окна
// настроек, где хода с его отменой нет.
const PROBE_TIMEOUT_MS = 15000

const MISSING_KEY_REASON = 'Для своего эндпоинта не задан API-ключ.'
const CANCELLED_REASON = 'Запрос отменён.'

const { fill } = require('../ui-text.cjs')

// Без переводчика строки остаются исходными — модуль обязано можно вызвать из
// теста, провайдера и миграции, где никакого языка окна нет. Подстановка при
// этом остаётся та же, что у tr(): иначе «%s» дошёл бы до человека текстом.
const asIs = (template, ...args) => fill(template, args)

// Причина без ключа по имени пути: на «OpenAI» человек должен читать «OpenAI»,
// а не «свой эндпоинт» — иначе подпись под отказом относится не к тому серверу.
function missingKeyReason(title, uiText = asIs) {
  return title && title !== PROVIDER_TITLE ? uiText('%s: не задан API-ключ.', title) : uiText(MISSING_KEY_REASON)
}

// Адрес без протокола человек вводит постоянно — «127.0.0.1:11434/v1». Разбор
// URL прочёл бы это как протокол «127.0.0.1:», поэтому http дописывается до
// проверки и только до неё.
const SCHEMELESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|[a-z][a-z0-9.-]*)(?::\d+)?(?:[/?#]|$)/i
const LOCAL_DOMAIN = /\.(?:local|lan|internal)$/i

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function clip(text, limit) {
  return oneLine(text).slice(0, limit)
}

// Хост считается локальным, а не запрещённым: весь пункт и затевался ради
// эндпоинта на своей машине. Формы addresses вида *.local и IPv6 в скобках —
// тоже свои.
function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (LOCAL_DOMAIN.test(host)) return true
  if (host === '::1' || host === '0:0:0:0:0:0:1') return true
  if (/^::ffff:127\./.test(host)) return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  const private172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (private172) {
    const second = Number(private172[1])
    return second >= 16 && second <= 31
  }
  return false
}

// Только абсолютный http/https. Отказ — человеческой строкой, без echoes
// введённого адреса: в нём мог сидеть пароль (`https://u:p@host`).
function validateBaseUrl(raw, uiText = asIs) {
  let text = String(raw ?? '').trim()
  if (!text) return { ok: false, reason: uiText('Не задан адрес своего эндпоинта.') }
  if (!/^[a-z][a-z\d+\-.]*:\/\//i.test(text)) {
    if (!SCHEMELESS.test(text)) {
      return { ok: false, reason: uiText('Адрес должен начинаться с http:// или https:// — например http://127.0.0.1:11434/v1.') }
    }
    text = `http://${text}`
  }

  let parsed = null
  try {
    parsed = new URL(text)
  } catch {
    return { ok: false, reason: uiText('Адрес эндпоинта не читается как URL. Нужен вид http://127.0.0.1:11434/v1 или https://example.com/v1.') }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: uiText('По этому адресу протокол «%s», а свой эндпоинт подключается только по http или https.', parsed.protocol.replace(/:$/, '')) }
  }
  // Разбор URL проглатывает лишние слэши и превращает первый сегмент пути в хост:
  // «https:///v1» означал бы хост «v1». Пустая авторитетная часть — это адрес без
  // хоста, и уходить на такой запрос нельзя.
  if (/^[a-z][a-z\d+\-.]*:\/\/\/+[^/]/i.test(text) || !parsed.hostname) {
    return { ok: false, reason: uiText('В адресе эндпоинта нет хоста — например https://127.0.0.1:11434/v1.') }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: uiText('Адрес с логином и паролем не подходит: ключ нельзя прятать в URL — укажите его в отдельном поле «API-ключ».') }
  }
  // Конструктор URL уже отказывает на «:abc» и на выходе за 65535; проверка
  // осталась страховкой на случай, если адрес пришёл уже разобранным.
  if (parsed.port && !/^\d+$/.test(parsed.port)) return { ok: false, reason: uiText('В адресе эндпоинта непонятный порт.') }
  if (parsed.hostname.includes('%') && !parsed.hostname.startsWith('fe80')) {
    return { ok: false, reason: uiText('Имя хоста в адресе эндпоинта не читается.') }
  }

  // `/v1` из адреса не выкидывается и не дописывается: путь добавляется к нему
  // как есть. Запрос с хвостом отбрасывается — склеивать его с путём нельзя.
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/`
  return { ok: true, url: base, local: isLocalHost(parsed.hostname) }
}

function extractErrorText(rawText) {
  const text = String(rawText ?? '')
  if (!text.trim()) return ''
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      const err = parsed.error
      if (typeof err === 'string') return { fromJson: true, message: err }
      if (err && typeof err === 'object') {
        return { fromJson: true, message: oneLine([err.message, err.msg, err.type, err.code]
          .filter(part => part !== undefined && part !== null).map(part => String(part)).join(' — ')) }
      }
      for (const key of ['detail', 'message', 'error_description']) {
        if (typeof parsed[key] === 'string' && parsed[key].trim()) return { fromJson: true, message: parsed[key] }
      }
    }
  } catch {
    // не JSON — дальше пойдёт сырой текст
  }
  // Голый текст идёт сюда целиком: обрезать до маски — значит оставить половину
  // ключа, если он угодил ровно на границу (комментарий к `describeError`).
  return { fromJson: false, message: text }
}

// Открытый ключ маскируется всегда, свой — ещё и целиком: сервер вправе
// процитировать заголовок в ответе.
function scrub(text, apiKey) {
  // Одна маска на все пути: точное значение, окна самого ключа по токенам,
  // заголовки авторизации и общие формы секретов.
  return maskSecretText(text, apiKey)
}

// Отказ из-за инструментов: 400/404/422 с текстом, где упомянуты tool/tools/
// function_call/function calling. Слово «token» сюда не попадает — поиск по
// границе слова. Когда сервер просто выплюнул эхо запроса (в нём есть слово
// «tools» всегда), требуется ещё и признак отказа, иначе обычная ошибка тела
// молча лишила бы агента инструментов.
const TOOL_MENTION = /\btools?\b|tool[_\s-]*calls?|function[_\s-]*calls?|function[_\s-]*calling/i
const REFUSAL = /not\s+(?:a\s+)?support|unsupported|does\s*n.?t\s+support|don.?t\s+support|cannot\s+use|not\s+allowed|not\s+available|unavailable|invalid|unknown|unexpected|disabled|no\s+support|отсутству|не\s+поддерж|недоступн/i

function describeToolsRejection(status, rawText) {
  if (!TOOLS_REJECTION_STATUS.has(Number(status))) return false
  const parsed = extractErrorText(rawText)
  const message = String(parsed.message || '')
  if (!message) return false
  // И для JSON, и для голого текста нужен признак отказа: сервер мог просто
  // вернуть эхо нашего же тела, где слово tools есть всегда.
  return TOOL_MENTION.test(message) && REFUSAL.test(message)
}

function errorHint(status, uiText = asIs) {
  if (status === 401 || status === 403) return uiText(' Ключ отклонён или ему не разрешён этот вызов.')
  if (status === 404) return uiText(' Эндпоинт не знает такого пути или модели — проверьте адрес (обычно он заканчивается на /v1) и имя модели.')
  if (status === 429) return uiText(' Эндпоинт не успевает: лимит запросов на его стороне.')
  if (status === 422 || status === 400) return uiText(' Эндпоинт отверг тело запроса.')
  return ''
}

// Одной строкой, по-русски, без секретов: только статус и текст из ответа
// сервера. Формы `error.metadata.raw`/`provider_name` здесь нет нарочно — это
// выдумка OpenRouter, чужой сервер так не отвечает.
//
// Маска снимается ДО обрезки: сервер мог выставить ключ в начале 400-знакового
// эха, и после `slice` уцелевший кусок уже не совпадает с ключом целиком — то
// есть обрезка сама создавала утечку половины секрета.
function describeError(rawText, status, modelId, secret, title = PROVIDER_TITLE, uiText = asIs) {
  const code = Number(status) || 0
  const where = modelId ? ` [${clip(modelId, 80)}]` : ''
  const parsed = extractErrorText(rawText)
  const message = scrub(oneLine(parsed.message), secret).slice(0, RAW_TEXT_LIMIT)
  const detail = message
    ? message
    : (code ? uiText('эндпоинт не прислал внятного объяснения') : uiText('ответ не читается'))
  return clip(uiText('%s: %s (код %s)%s.', title, detail, code || uiText('нет'), where) + errorHint(code, uiText), ERROR_LINE_LIMIT)
}

function readTextSafely(response) {
  return Promise.resolve()
    .then(() => response.text())
    .catch(() => '')
}

function create(config = {}) {
  const baseUrlRaw = String(config.baseUrl ?? '').trim()
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  const model = String(config.model ?? '').trim()
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : globalThis.fetch
  const onUnsupported = typeof config.onUnsupported === 'function' ? config.onUnsupported : null
  // Имя пути приходит от реестра: один и тот же openai-диалект обслуживает
  // OpenAI, Gemini и Ollama, и подписывать их отказ «своим эндпоинтом» — значит
  // говорить человеку не про тот сервер, который ответил.
  const title = String(config.title || PROVIDER_TITLE)
  const providerId = String(config.providerId || PROVIDER_ID)
  const keyOptional = Boolean(config.keyOptional)
  // Ни одного решения по времени адаптер не принимает, поэтому часы здесь нет
  // нужды держать: `config.now` принимается по контракту и остаётся
  // вызывающему — например чтобы по нему решать, пора ли снова спросить каталог.

  // Язык человеческих строк передаёт вызывающий: адаптер описывает отказ чужого
  // сервера, а в каком языке его показать — знает окно.
  const uiText = typeof config.uiText === 'function' ? config.uiText : asIs
  const checked = validateBaseUrl(baseUrlRaw, uiText)
  const baseUrl = checked.ok ? checked.url : baseUrlRaw
  const local = checked.ok ? Boolean(checked.local) : false

  // Человек заявляет возможности сам; модуль не прикидывается. Размышления и
  // цепочку фолбэка адаптер не поддерживает — это константы.
  const asked = config.capabilities && typeof config.capabilities === 'object' ? config.capabilities : {}
  const capabilities = Object.freeze({
    streaming: asked.streaming === undefined ? true : Boolean(asked.streaming),
    tools: asked.tools === undefined ? true : Boolean(asked.tools),
    catalog: asked.catalog === undefined ? true : Boolean(asked.catalog),
    reasoning: false,
    fallbackChain: false
  })

  function urlFor(path) {
    if (!checked.ok) throw new Error(checked.reason)
    const suffix = String(path || '').replace(/^\/+/, '')
    const withoutTail = baseUrl.replace(/\/+$/, '')
    // Человек мог вписать полный адрес вызова — тогда путь уже в базе и
    // удваивать его не надо.
    if (suffix && withoutTail.toLowerCase().endsWith(`/${suffix.toLowerCase()}`)) return withoutTail
    return `${withoutTail}/${suffix}`
  }

  function prepare(body) {
    // `null` и `undefined` — это «запроса без тела нет», а не тело со значением.
    if (body == null) return { body: undefined, dropped: [] }
    if (typeof body !== 'object') return { body, dropped: [] }
    const out = {}
    const dropped = []
    for (const [name, value] of Object.entries(body)) {
      if (OPENROUTER_ONLY_FIELDS.includes(name)) dropped.push(name)
      else out[name] = value
    }
    return { body: out, dropped }
  }

  function notifyUnsupported(dropped) {
    if (!onUnsupported || !Array.isArray(dropped) || !dropped.length) return
    try {
      onUnsupported(dropped)
    } catch {
      // Предупреждение — вспомогательное: запрос из-за него не отменяют.
    }
  }

  // У локального Ollama ключа нет, и требовать его — значит отказать человеку,
  // который всё подключил правильно. `config.keyOptional` приходит из реестра.
  function headers() {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  }

  // Чужой сервер вправе процитировать наш заголовок в объяснении — поэтому своё
  // описание ошибки прогоняется ещё и через маску конкретного ключа.
  function describeOwnError(rawText, status, modelId) {
    return scrub(describeError(rawText, status, modelId, apiKey, title, uiText), apiKey)
  }

  function assertUsable() {
    if (!checked.ok) throw new Error(checked.reason)
    if (!apiKey && !keyOptional) throw new Error(missingKeyReason(title, uiText))
  }

  async function request({ path, method = 'POST', body, signal } = {}) {
    assertUsable()
    if (signal?.aborted) throw new Error(CANCELLED_REASON)

    const verb = String(method || 'POST').toUpperCase()
    // Тело передаётся только туда, где ему место: GET за списком идёт без
    // тела и без Content-Type.
    const prepared = verb === 'GET' ? { body: undefined, dropped: [] } : prepare(body)
    notifyUnsupported(prepared.dropped)

    const requestHeaders = headers()
    let payload
    if (prepared.body !== undefined) {
      payload = JSON.stringify(prepared.body)
      requestHeaders['Content-Type'] = 'application/json'
    }

    let response
    try {
      response = await fetchImpl(urlFor(path), { method: verb, headers: requestHeaders, body: payload, signal, redirect: 'error' })
    } catch (error) {
      if (signal?.aborted) throw new Error(CANCELLED_REASON)
      // Первопричину сохраняем: по коду из неё главный процесс узнаёт обрыв
      // потока и повторяет шаг, а не считает его отказом.
      const detail = scrub(String(error?.cause?.code || error?.cause?.message || error?.message || ''), apiKey)
      const failure = new Error(clip(uiText('%s: не удалось связаться с эндпоинтом%s.', title, detail ? ` (${detail})` : ''), ERROR_LINE_LIMIT))
      failure.cause = error?.cause || error
      failure.name = String(error?.name || 'Error')
      throw failure
    }

    if (!response || typeof response.ok !== 'boolean') {
      throw new Error(uiText('%s: fetch вернул не ответ.', title))
    }

    if (!response.ok) {
      const rawText = await readTextSafely(response)
      const status = Number(response.status) || 0
      const failure = new Error(describeOwnError(rawText, status, prepared.body?.model || model))
      failure.status = status
      // Сырое тело — не перечисляемое поле: `JSON.stringify(error)` или
      // логирование объекта наружу не должно печатать то, что сервер прислал
      // (там может быть эхо заголовка). Читают его только по имени поля.
      Object.defineProperty(failure, 'rawText', { value: rawText, enumerable: false, configurable: true })
      failure.toolsRejected = describeToolsRejection(status, rawText)
      throw failure
    }

    // Настоящий Response: поток читает и разбирает вызывающий.
    return response
  }

  function modelEntries(payload) {
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : null
    if (!list) return null
    const seen = new Set()
    const models = []
    for (const item of list) {
      const entry = item && typeof item === 'object' ? item : { id: item }
      const id = clip(entry.id ?? entry.model ?? entry.name, 200)
      if (!id || seen.has(id)) continue
      seen.add(id)
      models.push({ id, title: clip(entry.name || id, 200) })
    }
    return models
  }

  // Список моделей — честный ответ эндпоинта, а не догадка: не ответил
  // списком — так и пишет в причине.
  //
  // У проверки есть свой срок: без него эндпоинт, который принял соединение и
  // молчит, вешал бы окно настроек на неопределённое время — сигнал отменяет
  // только ход, а каталог человек ждёт и так.
  async function probe(options = {}) {
    if (!checked.ok) return { ok: false, local: false, models: [], reason: checked.reason }
    if (!apiKey && !keyOptional) return { ok: false, local, models: [], reason: missingKeyReason(title) }

    const callerSignal = options?.signal || null
    let probeSignal = callerSignal
    let timer = null
    try {
      if (typeof AbortSignal.timeout === 'function') {
        timer = AbortSignal.timeout(PROBE_TIMEOUT_MS)
        probeSignal = callerSignal ? AbortSignal.any([callerSignal, timer]) : timer
      }
    } catch {
      probeSignal = callerSignal
    }

    let response
    try {
      response = await fetchImpl(urlFor('/models'),
        { method: 'GET', headers: headers(), signal: probeSignal, redirect: 'error' })
    } catch (error) {
      const detail = scrub(String(error?.cause?.code || error?.message || ''), apiKey)
      const timedOut = String(error?.name || '').includes('TimeoutError') ||
        String(error?.cause?.name || '').includes('TimeoutError')
      return {
        ok: false, local, models: [],
        reason: clip(uiText('%s: %s%s.', title,
          timedOut ? uiText('эндпоинт не ответил за') : uiText('не удалось связаться с эндпоинтом'),
          detail ? ` (${detail})` : ''), ERROR_LINE_LIMIT)
      }
    } finally {
      if (timer && typeof timer.dispose === 'function') timer.dispose()
    }

    const rawText = await readTextSafely(response)
    const status = Number(response.status) || 0
    if (!response.ok) {
      return { ok: false, local, models: [], reason: describeOwnError(rawText, status, model) }
    }

    let payload = null
    try {
      payload = JSON.parse(rawText)
    } catch {
      return { ok: false, local, models: [], reason: uiText('%s: /models ответил не JSON — списка моделей нет, каталог недоступен.', title) }
    }
    const models = modelEntries(payload)
    if (!models) return { ok: false, local, models: [], reason: uiText('%s: эндпоинт ответил без списка моделей — каталог недоступен.', title) }
    if (!models.length) return { ok: false, local, models: [], reason: uiText('%s: эндпоинт вернул пустой список моделей.', title) }
    return { ok: true, local, models, reason: '' }
  }

  function inspect() {
    return {
      baseUrl,
      model,
      local,
      capabilities: { ...capabilities },
      // Только был ли ключ, а какой именно — наружу не выходит.
      keyPresent: Boolean(apiKey)
    }
  }

  return {
    providerId,
    title,
    capabilities,
    urlFor,
    prepare,
    request,
    describeError: describeOwnError,
    describeToolsRejection,
    probe,
    inspect
  }
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_TITLE,
  validateBaseUrl,
  describeToolsRejection,
  describeError,
  create
}
