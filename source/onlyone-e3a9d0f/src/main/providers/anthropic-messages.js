'use strict'

// Anthropic говорит своим диалектом: `POST /v1/messages`, заголовок `x-api-key`
// плюс `anthropic-version`, роль системы живёт отдельным полем, инструменты
// называются `tool_use`/`tool_result`, а поток состоит из `content_block_delta`,
// а не из `choices[].delta`.
//
// Наружу адаптер отдаёт ровно тот openai-вид, который уже читает общий цикл
// агента (`data: {...}`, `choices[].delta.content`, `choices[].delta.tool_calls`,
// `finish_reason`, `data: [DONE]`), — подменяется форма провода, а не содержимое
// ответа: текст остаётся текстом, вызов — вызовом, отказ — отказом.
//
// Ключ приходит уже расширенным и уходит только в `x-api-key`; в текстах ошибок
// его не остаётся. `require('electron')` здесь нет нарочно: адаптер проверяется
// против локальной заглушки без главного процесса.

// Разбор адреса общий с openai-путём: http/https, локальные формы вида
// «127.0.0.1:11434/v1», отказ логину в URL.
const { validateBaseUrl } = require('./openai-compatible')
const { maskSecretText } = require('./secret-mask')

const PROVIDER_ID = 'anthropic'
const PROVIDER_TITLE = 'Anthropic'
const ANTHROPIC_VERSION = '2023-06-01'

// У Messages API нет значения по умолчанию для `max_tokens`, а без него запрос
// отвергается — прежняя поставка одного эндпоинта это уже показывала на других
// серверах. Число взято из того, что реально просят ходы приложения; если
// модель умеет больше, человек правит адрес и поле сам, а адаптер не выдумывает
// потолок за неё.
const DEFAULT_MAX_TOKENS = 8192
const MAX_TOKENS_CEILING = 64000
// Сколько токенов всегда остаётся самому ответу, когда включены размышления.
const ANSWER_ROOM_TOKENS = 1024

// Поля openai-тел, которых в Anthropic нет вообще. Молча пересылать их нельзя:
// сервер отвечает 400 без объяснения, и человек читал бы «эндпоинт отверг тело».
const DROPPED_FIELDS = ['n', 'seed', 'logprobs', 'top_logprobs', 'response_format',
  'presence_penalty', 'frequency_penalty', 'store', 'prediction', 'web_search_options',
  'audio', 'modalities', 'parallel_tool_calls']
// Только OpenRouter: цепочка запасных моделей и плагины разбора файлов.
const OPENROUTER_ONLY_FIELDS = ['models', 'plugins']

const ERROR_LINE_LIMIT = 300
const RAW_TEXT_LIMIT = 200
const PROBE_TIMEOUT_MS = 15000

const MISSING_KEY_REASON = 'Для Anthropic не задан API-ключ.'
const CANCELLED_REASON = 'Запрос отменён.'

const { fill } = require('../ui-text.cjs')

// Без переводчика строки остаются исходными — модуль обязано можно вызвать из
// теста, провайдера и миграции, где никакого языка окна нет. Подстановка при
// этом остаётся та же, что у tr(): иначе «%s» дошёл бы до человека текстом.
const asIs = (template, ...args) => fill(template, args)

const PATHS = { '/chat/completions': '/messages', '/models': '/models' }

// Стоимость считается по openai-именам полей, поэтому перевод.usage идёт в
// prompt_tokens/completion_tokens; кэш-токены Anthropic складываются в
// prompt_tokens — иначе итог выглядел бы меньше фактического.
const FINISH_REASONS = {
  end_turn: 'stop', stop_sequence: 'stop', refusal: 'stop', pause_turn: 'stop',
  max_tokens: 'length', tool_use: 'tool_calls'
}

// Бюджет размышлений по заявленной ступени. Меньше 1024 Anthropic не принимает,
// и всегда нужно место самому ответу — потолок проверяется вызывающим кодом.
const THINKING_BUDGET = { minimal: 1024, low: 1024, medium: 2048, high: 8192, xhigh: 8192, max: 8192 }

function oneLine(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
}

function clip(text, limit) {
  return oneLine(text).slice(0, limit)
}

function list(value) {
  return Array.isArray(value) ? value : []
}

// Секрет маскируется и в своём тексте, и в эхе сервера: Anthropic вправе
// вернуть фрагмент запроса в объяснении.
function scrub(text, apiKey) {
  // Одна маска на все пути: точное значение, окна самого ключа по токенам,
  // заголовки авторизации и общие формы секретов.
  return maskSecretText(text, apiKey)
}

function extractErrorText(rawText) {
  const text = String(rawText || '')
  if (!text.trim()) return ''
  try {
    const parsed = JSON.parse(text)
    const err = parsed?.error
    if (err && typeof err === 'object') {
      return oneLine([err.type, err.message].filter(Boolean).join(' — '))
    }
    if (typeof err === 'string') return err
    if (typeof parsed?.message === 'string') return parsed.message
    if (typeof parsed?.detail === 'string') return parsed.detail
  } catch {
    // не JSON — пойдёт сырой текст целиком: обрезать до маски — значит оставить
    // половину ключа, если он угодил ровно на границу.
  }
  return text
}

function errorHint(status, uiText = asIs) {
  if (status === 401) return uiText(' Ключ не принят: проверьте поле «API-ключ».')
  if (status === 403) return uiText(' Ключу не разрешён этот вызов.')
  if (status === 404) return uiText(' Anthropic не знает такой модели или пути — проверьте адрес и имя модели.')
  if (status === 429) return uiText(' Лимит запросов на стороне Anthropic.')
  if (status === 400) return uiText(' Тело запроса отвергнуто: чаще всего из-за имени модели, длины ответа или пустого сообщения.')
  return ''
}

function describeError(rawText, status, modelId, apiKey, title = PROVIDER_TITLE, uiText = asIs) {
  const code = Number(status) || 0
  const message = scrub(oneLine(extractErrorText(rawText)), apiKey).slice(0, RAW_TEXT_LIMIT)
  const detail = message || (code ? uiText('сервер не прислал внятного объяснения') : uiText('ответ не читается'))
  const where = modelId ? ` [${clip(modelId, 80)}]` : ''
  return clip(uiText('%s: %s (код %s)%s.', title, detail, code || uiText('нет'), where) + errorHint(code, uiText), ERROR_LINE_LIMIT)
}

// ---------------------------------------------------------------------------
// openai-тело -> Anthropic Messages
// ---------------------------------------------------------------------------

function plainText(content) {
  if (typeof content === 'string') return content
  return list(content)
    .filter(part => part?.type === 'text' || typeof part?.text === 'string')
    .map(part => String(part.text || ''))
    .join('')
}

function parseToolInput(raw) {
  const text = String(raw || '').trim()
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { value }
  } catch {
    // Оборванные аргументы — уже случай отказа, здесь важно не уронить сборку
    // тела: пустой вход сервер примет как вызов без аргументов.
    return {}
  }
}

// Картинка из openai-вида `image_url` в anthropic-`source`. Схема `data:` с
// base64 — то, что присылает приложение; внешний адрес Anthropic тоже умеет.
function imageBlock(url) {
  const src = String(url || '')
  const dataMatch = /^data:([^;,]+);base64,(.+)$/is.exec(src)
  if (dataMatch) {
    return { type: 'image', source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] } }
  }
  if (/^https?:\/\//i.test(src)) return { type: 'image', source: { type: 'url', url: src } }
  return null
}

// Вложение-файл: у Messages API свой блок `document`, и PDF он принимает
// открыто. Всё остальное (другие MIME) сюда не кладётся — чтобы не уходил
// молча, тип записывается в `skipped`.
function documentBlock(part) {
  const src = String(part?.file?.file_data || '')
  const match = /^data:([^;,]+);base64,(.+)$/is.exec(src)
  if (!match || match[1].toLowerCase() !== 'application/pdf') return null
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: match[2] },
    ...(part.file?.filename ? { title: String(part.file.filename).slice(0, 200) } : {}) }
}

function userBlocks(content, skipped) {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : []
  }
  const blocks = []
  for (const part of list(content)) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && String(part.text || '').trim()) blocks.push({ type: 'text', text: part.text })
    else if (part.type === 'image_url') {
      const image = imageBlock(part.image_url?.url)
      if (image) blocks.push(image)
      else if (skipped) skipped.add('изображение')
    } else if (part.type === 'file') {
      const document = documentBlock(part)
      if (document) blocks.push(document)
      else if (skipped) skipped.add('файл не-PDF')
    } else if (skipped && part.type) {
      skipped.add(String(part.type))
    }
  }
  return blocks
}

// Блоки одного хода модели: текст плюс вызовы инструментов. Anthropic не
// принимает пустой `text`, поэтому пустые куски не заводятся вовсе.
function assistantBlocks(message) {
  const blocks = []
  const text = plainText(message.content)
  if (text.trim()) blocks.push({ type: 'text', text })
  list(message.tool_calls).forEach((call, index) => {
    const name = String(call?.function?.name || '')
    if (!name) return
    blocks.push({
      type: 'tool_use',
      id: String(call?.id || `toolu_call_${index + 1}`),
      name,
      input: parseToolInput(call?.function?.arguments)
    })
  })
  return blocks
}

function toolResultBlock(message) {
  const text = plainText(message.content)
  return {
    type: 'tool_result',
    tool_use_id: String(message.tool_call_id || ''),
    // Пустой вывод команды — не выдумка: сервер требует непустого содержимого,
    // и вместо сочинения ответа туда идёт пробел.
    content: text || ' '
  }
}

function pushMessage(messages, role, blocks) {
  if (!blocks.length) return
  const last = messages[messages.length - 1]
  // Anthropic требует чередования ролей; два хода одного участника склеиваются в
  // одно сообщение с несколькими блоками, а не отбрасываются.
  if (last && last.role === role) {
    last.content = [...last.content, ...blocks]
    return
  }
  messages.push({ role, content: blocks })
}

function toAnthropicMessages(messages) {
  const out = []
  const system = []
  const skipped = new Set()
  // Вызов, на который никто не отвечал, и ответ на вызов, которого не было, —
  // оба означают 400 на весь ход. Поэтому `tool_result` допускается только с
  // id из уже переведённого `tool_use`.
  const issued = new Set()
  for (const message of list(messages)) {
    if (!message || typeof message !== 'object') continue
    const role = String(message.role || '')
    if (role === 'system' || role === 'developer') {
      const text = plainText(message.content)
      if (text.trim()) system.push(text)
      continue
    }
    if (role === 'tool') {
      const id = String(message.tool_call_id || '')
      if (!issued.has(id)) {
        skipped.add('результат инструмента без предшествующего вызова')
        continue
      }
      pushMessage(out, 'user', [toolResultBlock(message)])
      continue
    }
    if (role === 'assistant') {
      const blocks = assistantBlocks(message)
      blocks.forEach(block => { if (block.type === 'tool_use') issued.add(block.id) })
      pushMessage(out, 'assistant', blocks)
      continue
    }
    pushMessage(out, 'user', userBlocks(message.content, skipped))
  }
  return { messages: out, system: system.join('\n\n'), skipped: [...skipped] }
}

function toAnthropicTools(tools) {
  const out = []
  for (const tool of list(tools)) {
    const fn = tool?.function || tool
    const name = String(fn?.name || '')
    if (!name) continue
    const schema = fn?.parameters && typeof fn.parameters === 'object'
      ? fn.parameters : { type: 'object', properties: {} }
    out.push({ name, input_schema: schema, ...(fn?.description ? { description: String(fn.description) } : {}) })
  }
  return out
}

function toAnthropicToolChoice(choice, toolNames) {
  if (!choice || typeof choice === 'string') {
    if (choice === 'required') return { type: 'any' }
    if (choice === 'none') return { type: 'none' }
    return choice ? { type: 'auto' } : null
  }
  const name = String(choice?.function?.name || '')
  if (!name) return null
  // Модель обязывают вызвать конкретный инструмент только если он реально ушёл
  // в теле: иначе сервер ответил бы 400 на несуществующее имя.
  return toolNames.includes(name) ? { type: 'tool', name } : { type: 'auto' }
}

// Ступень размышлений -> бюджет `thinking`. Бюджет обязан быть меньше
// `max_tokens` и оставить место ответу: при бюджете впритык модель думает до
// единственного токена, а сервер на равные значения отвечает 400. Когда места
// нет, размышления снимаются — и это говорится вызывающему, а не молчится.
// Когда thinking включён, Anthropic отказывает на temperature != 1 и на
// top_p/top_k, поэтому они тоже снимаются.
function thinkingFrom(reasoning, maxTokens) {
  const asked = reasoning && typeof reasoning === 'object' ? reasoning : null
  if (!asked) return { thinking: null }
  const wants = asked.enabled === false ? false
    : (asked.enabled === true || Boolean(asked.effort))
  if (!wants) return { thinking: null }
  const effort = String(asked.effort || 'medium')
  if (effort === 'none' || effort === 'off') return { thinking: null }
  const room = maxTokens - ANSWER_ROOM_TOKENS
  if (room < 1024) {
    return { thinking: null,
      note: `размышления сняты: при max_tokens ${maxTokens} не остаётся места ответу` }
  }
  const wanted = THINKING_BUDGET[effort] || THINKING_BUDGET.medium
  return { thinking: { type: 'enabled', budget_tokens: Math.min(wanted, room) } }
}

function translate(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const dropped = []
  const translated = toAnthropicMessages(source.messages)
  const { messages, system } = translated
  dropped.push(...translated.skipped)

  let maxTokens = Number(source.max_tokens) || 0
  if (maxTokens <= 0) maxTokens = DEFAULT_MAX_TOKENS
  maxTokens = Math.min(maxTokens, MAX_TOKENS_CEILING)

  const out = {
    model: String(source.model || ''),
    max_tokens: maxTokens,
    messages
  }
  if (system) out.system = system
  if (typeof source.top_p === 'number') out.top_p = source.top_p
  if (typeof source.stop === 'string') out.stop_sequences = [source.stop]
  else if (Array.isArray(source.stop) && source.stop.length) out.stop_sequences = source.stop
  if (source.stream !== undefined) out.stream = Boolean(source.stream)

  const thought = thinkingFrom(source.reasoning, maxTokens)
  if (thought.note) dropped.push(thought.note)
  const thinking = thought.thinking
  if (thinking) {
    out.thinking = thinking
    if (source.temperature !== undefined) dropped.push('temperature (снимается при размышлениях)')
    if (source.top_p !== undefined) dropped.push('top_p (снимается при размышлениях)')
    out.temperature = 1
  } else if (typeof source.temperature === 'number') {
    // Диапазон Anthropic — 0..1; openai-привычная «2» сервер отверг бы молча для
    // нашего случая, поэтому просьба прижимается к границе, а не улетает в отказ.
    out.temperature = Math.min(1, Math.max(0, source.temperature))
  }

  const tools = toAnthropicTools(source.tools)
  if (tools.length) {
    const choice = toAnthropicToolChoice(source.tool_choice, tools.map(tool => tool.name))
    if (choice && choice.type !== 'none') {
      out.tools = tools
      out.tool_choice = choice
    } else if (source.tool_choice !== 'none') {
      out.tools = tools
    }
  } else if (source.tools) {
    dropped.push('tools (ни одного имени не прошло перевод)')
  }

  for (const field of [...DROPPED_FIELDS, ...OPENROUTER_ONLY_FIELDS]) {
    if (source[field] !== undefined) dropped.push(field)
  }
  return { body: out, dropped }
}

// ---------------------------------------------------------------------------
// Anthropic -> openai-вид
// ---------------------------------------------------------------------------

function textOfBlocks(content) {
  return list(content)
    .filter(block => block?.type === 'text' && block.text)
    .map(block => String(block.text))
    .join('')
}

function toolCallsOfBlocks(content) {
  return list(content)
    .filter(block => block?.type === 'tool_use' && block.name)
    .map((block, index) => ({
      id: String(block.id || `call_${index + 1}`),
      type: 'function',
      function: { name: String(block.name), arguments: JSON.stringify(block.input || {}) }
    }))
}

function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null
  return {
    prompt_tokens: (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) +
      (Number(usage.cache_creation_input_tokens) || 0),
    completion_tokens: Number(usage.output_tokens) || 0
  }
}

// Вход ответа объявлен только в `message_start`, выход — только в
// `message_delta`. Каждый следующий частичный кадр не имеет права стирать
// предыдущий нулём, иначе стоимость хода оказалась бы вдвое меньше настоящей.
function mergeUsage(known, part) {
  if (!part) return known || null
  if (!known) return part
  return {
    prompt_tokens: Math.max(Number(known.prompt_tokens) || 0, Number(part.prompt_tokens) || 0),
    completion_tokens: Math.max(Number(known.completion_tokens) || 0, Number(part.completion_tokens) || 0)
  }
}

function withTotal(usage) {
  if (!usage) return null
  const prompt = Number(usage.prompt_tokens) || 0
  const completion = Number(usage.completion_tokens) || 0
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

function toOpenAiPayload(payload, title) {
  const usage = withTotal(usageOf(payload?.usage))
  return {
    id: String(payload?.id || `msg-${Date.now()}`),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: String(payload?.model || ''),
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: textOfBlocks(payload?.content),
        ...(() => {
          const calls = toolCallsOfBlocks(payload?.content)
          return calls.length ? { tool_calls: calls } : {}
        })()
      },
      finish_reason: FINISH_REASONS[payload?.stop_reason] || 'stop',
      logprobs: null
    }],
    ...(usage ? { usage } : {}),
    provider: title
  }
}

// Поток Anthropic перекладывается в открытые кадры openai. Всё, что не имеет
// аналога (`ping`, `signature_delta`), просто не порождает кадра; событие
// `error` порождает кадр с `error` — цикл агента читает его и останавливает ход
// объяснением сервера, а не молча оборванным ответом.
function translateStream(sourceReader, controller, context) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let toolIndex = 0
  const toolSlots = new Map()
  const write = value => controller.enqueue(encoder.encode(value))
  const frame = delta => {
    const chunk = {
      id: context.id, object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000), model: context.model,
      choices: [{ index: 0, delta, finish_reason: null }]
    }
    write(`data: ${JSON.stringify(chunk)}\n\n`)
  }

  async function run() {
    for (;;) {
      const { done, value } = await sourceReader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      if (buffer.length > 16 * 1024 * 1024 || lines.some(line => line.length > 16 * 1024 * 1024)) {
        await sourceReader.cancel().catch(() => {})
        throw new Error('Anthropic: слишком длинная строка потока')
      }
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const json = trimmed.slice(5).trim()
        if (!json) continue
        let event
        try {
          event = JSON.parse(json)
        } catch {
          continue
        }
        handle(event)
      }
    }
    // Обрыв без `message_stop` — это недописанный ответ. Закрывать его маркером
    // [DONE] значило бы выдать усечённое за готовое; вместо этого поток гибнет,
    // и вызывающий видит оборванную передачу.
    if (!context.finished) {
      controller.error(new Error(clip(`${context.title}: поток оборвался до конца ответа`, ERROR_LINE_LIMIT)))
      return
    }
    write('data: [DONE]\n\n')
    controller.close()
  }

  function handle(event) {
    switch (event?.type) {
      case 'message_start': {
        context.id = String(event?.message?.id || context.id)
        context.model = String(event?.message?.model || context.model)
        // Входные токены объявлены только здесь, выходные — в `message_delta`:
        // если бы новый usage заменял старый, стоимость хода молча уменьшилась
        // бы ровно на половину.
        context.usage = mergeUsage(context.usage, usageOf(event?.message?.usage))
        frame({ role: 'assistant' })
        break
      }
      case 'content_block_start': {
        const block = event?.content_block
        if (block?.type !== 'tool_use') break
        const slot = toolIndex++
        toolSlots.set(Number(event.index ?? toolSlots.size), slot)
        frame({ tool_calls: [{ index: slot, id: String(block.id || `call_${slot + 1}`), type: 'function',
          function: { name: String(block.name || ''), arguments: '' } }] })
        break
      }
      case 'content_block_delta': {
        const delta = event?.delta
        if (delta?.type === 'text_delta' && delta.text) frame({ content: String(delta.text) })
        if (delta?.type === 'thinking_delta' && delta.thinking) frame({ reasoning: String(delta.thinking) })
        if (delta?.type === 'input_json_delta' && delta.partial_json) {
          const slot = toolSlots.get(Number(event.index ?? -1)) ?? toolSlots.size
          frame({ tool_calls: [{ index: slot, function: { arguments: String(delta.partial_json) } }] })
        }
        break
      }
      case 'message_delta': {
        context.usage = mergeUsage(context.usage, usageOf(event?.usage))
        const reason = FINISH_REASONS[event?.delta?.stop_reason] || null
        if (reason) context.finishReason = reason
        break
      }
      case 'error': {
        const detail = scrub(oneLine([event?.error?.type, event?.error?.message]
          .filter(Boolean).join(' — ')), context.apiKey).slice(0, RAW_TEXT_LIMIT)
        const chunk = { error: { message: clip(`${context.title}: ${detail || 'поток прерван ошибкой'}.`, ERROR_LINE_LIMIT),
          type: String(event?.error?.type || 'provider_error') } }
        write(`data: ${JSON.stringify(chunk)}\n\n`)
        write('data: [DONE]\n\n')
        throw new Error('stream-error')
      }
      case 'message_stop': {
        context.finished = true
        const chunk = {
          id: context.id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: context.model, choices: [{ index: 0, delta: {}, finish_reason: context.finishReason || 'stop' }],
          ...(context.usage ? { usage: withTotal(context.usage) } : {})
        }
        write(`data: ${JSON.stringify(chunk)}\n\n`)
        break
      }
      default:
        break
    }
  }

  return run()
}

function streamResponse(response, context) {
  const body = new ReadableStream({
    async start(controller) {
      try {
        await translateStream(response.body.getReader(), controller, context)
      } catch (error) {
        if (String(error?.message) === 'stream-error') {
          // Объяснение уже ушло кадром с `error`, и поток закрыт маркером
          // [DONE]: звать controller.error() значило бы добавить вторую смерть
          // поверх той, что человек уже видит.
          try { controller.close() } catch { /* закрыт */ }
          return
        }
        controller.error(error)
      }
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function readTextSafely(response) {
  try {
    if (!response.body?.getReader) return await response.text()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = '', bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      bytes += value.byteLength
      if (bytes > 16 * 1024 * 1024) {
        await reader.cancel().catch(() => {})
        return ''
      }
      text += decoder.decode(value, { stream: true })
    }
  } catch { return '' }
}

function create(config = {}) {
  const title = String(config.title || PROVIDER_TITLE)
  const baseUrlRaw = String(config.baseUrl ?? '').trim()
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  const model = String(config.model ?? '').trim()
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : globalThis.fetch
  const onUnsupported = typeof config.onUnsupported === 'function' ? config.onUnsupported : null

  // Язык человеческих строк передаёт вызывающий: адаптер описывает отказ
  // сервера, а в каком языке его показать — знает окно.
  const uiText = typeof config.uiText === 'function' ? config.uiText : asIs
  const checked = validateBaseUrl(baseUrlRaw, uiText)
  const baseUrl = checked.ok ? checked.url : baseUrlRaw
  const local = checked.ok ? Boolean(checked.local) : false

  const asked = config.capabilities && typeof config.capabilities === 'object' ? config.capabilities : {}
  const capabilities = Object.freeze({
    streaming: asked.streaming === undefined ? true : Boolean(asked.streaming),
    tools: asked.tools === undefined ? true : Boolean(asked.tools),
    catalog: asked.catalog === undefined ? true : Boolean(asked.catalog),
    // Перевод `reasoning` в `thinking` здесь есть, но заявлять возможность
    // нельзя: ступени берутся из списка моделей пути, а он их не объявляет —
    // значит, в запрос они не приходят. Честное «нет» лучше недостижимого «да».
    reasoning: false,
    fallbackChain: false
  })

  function urlFor(path) {
    if (!checked.ok) throw new Error(checked.reason)
    const mapped = PATHS[String(path || '')] || String(path || '')
    const suffix = mapped.replace(/^\/+/, '')
    const withoutTail = baseUrl.replace(/\/+$/, '')
    if (suffix && withoutTail.toLowerCase().endsWith(`/${suffix.toLowerCase()}`)) return withoutTail
    return `${withoutTail}/${suffix}`
  }

  function headers() {
    const out = { 'anthropic-version': ANTHROPIC_VERSION }
    if (apiKey) out['x-api-key'] = apiKey
    return out
  }

  function describeOwnError(rawText, status, modelId) {
    return describeError(rawText, status, modelId, apiKey, title, uiText)
  }

  function assertUsable() {
    if (!checked.ok) throw new Error(checked.reason)
    if (!apiKey) throw new Error(uiText(MISSING_KEY_REASON))
  }

  function notifyUnsupported(dropped) {
    if (!onUnsupported || !Array.isArray(dropped) || !dropped.length) return
    try {
      onUnsupported(dropped)
    } catch {
      // Предупреждение вспомогательное: запрос из-за него не отменяют.
    }
  }

  async function request({ path, method = 'POST', body, signal } = {}) {
    assertUsable()
    if (signal?.aborted) throw new Error(CANCELLED_REASON)
    const verb = String(method || 'POST').toUpperCase()

    let payload
    let translated = null
    if (verb === 'GET') {
      payload = undefined
    } else {
      translated = translate(body)
      notifyUnsupported(translated.dropped)
      if (translated.body && !translated.body.messages.length) {
        // Пустая переписка — это не запрос к модели, а потерянный ход: сервер
        // ответил бы 400, и человек ждал бы объяснения не про свою проблему.
        throw new Error(uiText('%s: перевод не нашёл ни одного сообщения — запрос к модели не отправлен.', title))
      }
      payload = JSON.stringify(translated.body)
    }

    const requestHeaders = headers()
    if (payload !== undefined) requestHeaders['content-type'] = 'application/json'

    let response
    try {
      response = await fetchImpl(urlFor(path), { method: verb, headers: requestHeaders, body: payload,
        signal, redirect: 'error' })
    } catch (error) {
      if (signal?.aborted) throw new Error(CANCELLED_REASON)
      const detail = scrub(String(error?.cause?.code || error?.cause?.message || error?.message || ''), apiKey)
      const failure = new Error(clip(uiText('%s: не удалось связаться с API%s.', title, detail ? ` (${detail})` : ''), ERROR_LINE_LIMIT))
      failure.cause = error?.cause || error
      failure.name = String(error?.name || 'Error')
      throw failure
    }

    if (!response || typeof response.ok !== 'boolean') throw new Error(uiText('%s: fetch вернул не ответ.', title))

    if (!response.ok) {
      const rawText = await readTextSafely(response)
      const status = Number(response.status) || 0
      const failure = new Error(describeOwnError(rawText, status, body?.model || model))
      failure.status = status
      // Сырое тело — не перечисляемое поле: `JSON.stringify(error)` или
      // логирование объекта наружу не должно печатать то, что сервер прислал
      // (там может быть эхо заголовка). Читают его только по имени поля.
      Object.defineProperty(failure, 'rawText', { value: rawText, enumerable: false, configurable: true })
      // Отказ именно по инструментам: у Anthropic это 400 с текстом про tools.
      failure.toolsRejected = status === 400 && /\btools?\b|tool_use/i.test(rawText) &&
        /not\s+support|unsupported|invalid|unexpected|unknown/i.test(rawText)
      throw failure
    }

    if (verb === 'GET') return response

    const context = { id: `msg-${Date.now()}`, model: String(body?.model || model || ''), title, apiKey,
      usage: null, finishReason: null, finished: false }
    if (translated?.body?.stream) return streamResponse(response, context)
    const raw = await readTextSafely(response)
    let payloadJson = null
    try {
      payloadJson = JSON.parse(raw)
    } catch {
      throw new Error(describeOwnError(raw, 200, body?.model || model))
    }
    return jsonResponse(toOpenAiPayload(payloadJson, title))
  }

  // Список моделей — честный ответ `/v1/models`; ничего не дописывается.
  async function probe(options = {}) {
    if (!checked.ok) return { ok: false, local: false, models: [], reason: checked.reason }
    if (!apiKey) return { ok: false, local, models: [], reason: uiText(MISSING_KEY_REASON) }
    let timer = null
    let probeSignal = options?.signal || null
    try {
      if (typeof AbortSignal.timeout === 'function') {
        timer = AbortSignal.timeout(PROBE_TIMEOUT_MS)
        probeSignal = probeSignal ? AbortSignal.any([probeSignal, timer]) : timer
      }
    } catch {
      probeSignal = options?.signal || null
    }
    let response
    try {
      response = await fetchImpl(urlFor('/models'), { method: 'GET', headers: headers(),
        signal: probeSignal, redirect: 'error' })
    } catch (error) {
      const timedOut = String(error?.name || '').includes('TimeoutError') ||
        String(error?.cause?.name || '').includes('TimeoutError')
      const detail = scrub(String(error?.cause?.code || error?.message || ''), apiKey)
      return { ok: false, local, models: [], reason: clip(uiText('%s: %s%s.', title,
        timedOut ? uiText('сервер не ответил за') : uiText('не удалось связаться'),
        detail ? ` (${detail})` : ''), ERROR_LINE_LIMIT) }
    } finally {
      if (timer && typeof timer.dispose === 'function') timer.dispose()
    }
    const raw = await readTextSafely(response)
    const status = Number(response.status) || 0
    if (!response.ok) return { ok: false, local, models: [], reason: describeOwnError(raw, status, model) }
    let payload = null
    try {
      payload = JSON.parse(raw)
    } catch {
      return { ok: false, local, models: [], reason: uiText('%s: /models ответил не JSON — списка моделей нет.', title) }
    }
    const seen = new Set()
    const models = []
    for (const item of list(payload?.data)) {
      const id = clip(item?.id ?? item?.name, 200)
      if (!id || seen.has(id)) continue
      seen.add(id)
      models.push({ id, title: clip(item?.display_name || item?.name || id, 200) })
    }
    if (!models.length) return { ok: false, local, models: [], reason: uiText('%s: сервер вернул пустой список моделей.', title) }
    return { ok: true, local, models, reason: '' }
  }

  function inspect() {
    return {
      baseUrl, model, local, capabilities: { ...capabilities },
      // Только был ли ключ; какой именно — наружу не выходит.
      keyPresent: Boolean(apiKey)
    }
  }

  return {
    providerId: String(config.providerId || PROVIDER_ID),
    title,
    capabilities,
    urlFor,
    translate,
    request,
    describeError: describeOwnError,
    probe,
    inspect
  }
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_TITLE,
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  describeError,
  translate,
  toOpenAiPayload,
  create
}
