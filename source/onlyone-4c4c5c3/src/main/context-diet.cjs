// Расход токенов в ходе агента (волна 3, В3-2; переработано 07.10.2026).
//
// Каждый шаг цикла отправляет модели ВСЮ переписку заново. Прочитанный файл (до 40 000
// знаков) остаётся в ней до конца хода и оплачивается на каждом следующем шаге: двадцать
// чтений за три минуты — это сотни тысяч входных токенов на «просто анализ папки».
//
// Здесь две меры, обе только над КОПИЕЙ, которая уходит провайдеру. Сама переписка, лента и
// сохранённые сообщения не меняются:
//   1. pruneOldToolResults — старые результаты инструментов сворачиваются в короткую заглушку,
//      а длинные аргументы старых вызовов (полный текст записанного файла) — в пометку «свёрнуто».
//      Как у opencode: свежее остаётся целым в ЗАЩИТНОМ ОКНЕ, считаемом в токенах, а не «три
//      последних» (десять небольших чтений окну не мешают), и свёртка идёт только когда она
//      освобождает заметный объём. Раньше режем сразу после третьего результата, и модель, у
//      которой окно на сотни тысяч токенов свободно, перечитывала файл — а на бесплатных моделях
//      лишний запрос дороже лишних токенов. Редкая пакетная свёртка заодно не дёргает префикс
//      запроса на каждом шаге, который провайдер держит в своём кэше.
//   2. withPromptCache — для моделей Anthropic через OpenRouter ставятся метки кэша на
//      системное сообщение и на последнюю реплику: повторно отправляемый префикс
//      оплачивается как чтение из кэша, а не как новый вход. Остальные провайдеры кэшируют
//      сами, для них переписка не меняется.

// Не меньше стольких последних результатов остаются целыми, каким бы большим ни был каждый.
const KEEP_RECENT_RESULTS = 3
// Результаты в пределах этого объёма (с конца) тоже остаются целыми.
const PROTECT_TOKENS = 8000
// Свёртка начинается, только если освободит не меньше стольких токенов.
const MIN_SAVING_TOKENS = 2000
const OLD_RESULT_CHARS = 1200
const OLD_ARGUMENT_CHARS = 600
const HEAD_CHARS = 400
const CHARS_PER_TOKEN = 3.5

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('')
  return ''
}

// Что читал или запускал вызов: из его же аргументов. Заглушке нужно сказать, ЧТО свёрнуто.
function callTargets(list) {
  const targets = new Map()
  for (const message of list) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      if (!call) continue
      let args = {}
      const rawArgs = call?.function?.arguments
      if (typeof rawArgs === 'object' && rawArgs !== null) {
        args = rawArgs
      } else if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs || '{}') } catch { /* обрезанные аргументы — цели нет */ }
      }
      const target = String(args?.path || args?.command || args?.query || args?.url || args?.name || args?.source || '').slice(0, 120)
      targets.set(call?.id, { tool: String(call?.function?.name || ''), target })
    }
  }
  return targets
}

const REREAD = {
  read_file: 'Нужен снова — прочитай нужный участок: read_file со start_line и end_line.',
  search_files: 'Нужен снова — повтори search_files с более узким query, path или glob.',
  run_command: 'Нужен вывод снова — повтори команду.',
  fetch_url: 'Нужна страница снова — повтори fetch_url с offset на нужную часть.'
}

// Заглушка остаётся разбираемым JSON: часть провайдеров проверяет это у ответов инструментов.
function stubResult(original, info) {
  return JSON.stringify({
    pruned: true,
    tool: info?.tool || undefined,
    target: info?.target || undefined,
    chars: original.length,
    note: `Старый результат свёрнут, чтобы не тратить токены. ${REREAD[info?.tool] || 'Нужен снова — повтори вызов, лучше адресно.'}`,
    head: original.slice(0, HEAD_CHARS)
  })
}

function stubArguments(raw) {
  let parsed
  try { parsed = JSON.parse(raw) } catch { return raw.slice(0, OLD_ARGUMENT_CHARS) }
  if (!parsed || typeof parsed !== 'object') return raw
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value.length > OLD_ARGUMENT_CHARS) {
      parsed[key] = `[свёрнуто: ${value.length} знаков]`
    }
  }
  return JSON.stringify(parsed)
}

function pruneOldToolResults(messages, options = {}) {
  const keep = Math.max(0, Number.isInteger(options.keepRecent) ? options.keepRecent : KEEP_RECENT_RESULTS)
  const protect = Number.isFinite(options.protectTokens) ? options.protectTokens : PROTECT_TOKENS
  const minSaving = Number.isFinite(options.minSavingTokens) ? options.minSavingTokens : MIN_SAVING_TOKENS
  const list = Array.isArray(messages) ? messages : []

  const toolIndexes = []
  list.forEach((message, index) => { if (message && message.role === 'tool') toolIndexes.push(index) })
  if (toolIndexes.length <= keep) return list

  // Граница защиты: сначала «не меньше N последних», потом всё, что умещается в окно по токенам.
  let cutoff = keep > 0 ? toolIndexes[toolIndexes.length - keep] : (toolIndexes.length ? toolIndexes[toolIndexes.length - 1] + 1 : 0)
  let window = 0
  for (let i = toolIndexes.length - 1; i >= 0; i--) {
    window += textOf(list[toolIndexes[i]].content).length / CHARS_PER_TOKEN
    if (window > protect) break
    cutoff = Math.min(cutoff, toolIndexes[i])
  }

  const targets = callTargets(list)
  let saved = 0
  const out = list.map((message, index) => {
    if (index >= cutoff || !message) return message
    if (message.role === 'tool') {
      const text = textOf(message.content)
      if (text.length > OLD_RESULT_CHARS) {
        const stub = stubResult(text, targets.get(message.tool_call_id))
        saved += text.length - stub.length
        return { ...message, content: stub }
      }
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      let any = false
      const calls = message.tool_calls.map(call => {
        const raw = call && call.function && call.function.arguments
        if (typeof raw !== 'string' || raw.length <= OLD_ARGUMENT_CHARS) return call
        any = true
        const slim = stubArguments(raw)
        saved += raw.length - slim.length
        return { ...call, function: { ...call.function, arguments: slim } }
      })
      if (any) return { ...message, tool_calls: calls }
    }
    return message
  })
  // Мало что освободится — переписка уходит как есть: меняться префиксу запроса не за чем.
  return saved / CHARS_PER_TOKEN >= minSaving ? out : list
}

function marked(message) {
  const text = textOf(message.content)
  if (!text) return message
  return { ...message, content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }
}

function withPromptCache(messages, model) {
  const list = Array.isArray(messages) ? messages : []
  if (!/^(anthropic\/|.*claude)/i.test(String(model || '')) || list.length < 2) return list
  const out = list.slice()
  if (out[0] && out[0].role === 'system') out[0] = marked(out[0])
  const last = out.length - 1
  if (last > 0 && out[last] && typeof out[last].content === 'string') out[last] = marked(out[last])
  return out
}

// Что уйдёт провайдеру на этом шаге.
function requestMessages(messages, model) {
  return withPromptCache(pruneOldToolResults(messages), model)
}

// Грубая оценка входа, для журнала расхода: символы / 3,5 для кириллицы и кода.
function estimateTokens(messages) {
  let chars = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    chars += textOf(message.content).length
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    for (const call of toolCalls) {
      const raw = call?.function?.arguments
      chars += typeof raw === 'string' ? raw.length : String(raw || '').length
    }
  }
  return Math.round(chars / CHARS_PER_TOKEN)
}

module.exports = {
  KEEP_RECENT_RESULTS, PROTECT_TOKENS, MIN_SAVING_TOKENS, OLD_RESULT_CHARS,
  pruneOldToolResults, withPromptCache, requestMessages, estimateTokens
}
