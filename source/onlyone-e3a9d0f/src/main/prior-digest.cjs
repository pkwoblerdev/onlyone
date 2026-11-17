'use strict'

// Предыстория команды для помощника: что уже сделали остальные. Раньше сюда шли отчёты целиком (до 14 000 знаков на каждый
// плюс ответ ведущего), и каждый следующий этап платил за все предыдущие. Теперь это выжимка с потолком на всю историю;
// полный текст агента отдаёт `board_read` с полем `agent` — по адресному запросу, а не каждому и всякий раз.
const PRIOR_CAP = 1500
const PER_AGENT_MAX = 450
const MIN_PER_AGENT = 60
const FOOTER = '\n(Отчёты сокращены. Полный отчёт агента — board_read с agent: <номер>.)'

function squash(text) {
  return String(text == null ? '' : text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Голова (о чём) и хвост (чем кончилось) — в отчёте именно они несут факты; середина обычно пересказ хода.
function digestBody(text, max = PER_AGENT_MAX) {
  const clean = squash(text)
  if (clean.length <= max) return clean
  const room = Math.max(8, max - 3)
  const half = Math.floor(room / 2)
  const sentences = clean.split(/(?<=[.!?…])\s+/).filter(Boolean)
  if (sentences.length < 2) return clean.slice(0, half).trimEnd() + ' … ' + clean.slice(-(room - half)).trimStart()

  let head = ''
  for (const s of sentences) { if ((head + ' ' + s).trim().length > half) break; head = (head + ' ' + s).trim() }
  let tail = ''
  for (let i = sentences.length - 1; i >= 0; i--) { const next = (sentences[i] + ' ' + tail).trim(); if (next.length > room - head.length) break; tail = next }
  if (!head) head = clean.slice(0, half).trimEnd()
  if (!tail) tail = clean.slice(-Math.max(1, room - head.length)).trimStart()
  const out = head + ' … ' + tail
  return out.length <= max ? out : out.slice(0, max)
}

// Всё, что уже сказали ведущий и помощники, в пределах `cap` знаков. Пусто, если сказать нечего.
function buildPrior({ leadName = '', leadContent = '', entries = [], cap = PRIOR_CAP } = {}) {
  const parts = []
  if (squash(leadContent)) parts.push({ name: leadName || 'Агент 1', body: leadContent })
  for (const entry of entries || []) if (squash(entry && entry.body)) parts.push({ name: entry.name || 'Агент', body: entry.body })
  if (!parts.length) return ''
  const limitCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0
  if (limitCap <= 0) return ''

  const render = limit => {
    let truncated = false
    const lines = parts.map(part => {
      const clean = squash(part.body)
      const own = Math.max(MIN_PER_AGENT, limit - part.name.length - 2)
      const text = digestBody(clean, Math.min(PER_AGENT_MAX, own))
      if (text !== clean) truncated = true
      return `${part.name}: ${text}`
    })
    return { text: lines.join('\n') + (truncated ? FOOTER : ''), truncated }
  }

  let limit = Math.min(PER_AGENT_MAX + 40, Math.floor((limitCap - FOOTER.length) / parts.length))
  let out = render(limit)
  while (out.text.length > limitCap && limit > MIN_PER_AGENT) { limit = Math.max(MIN_PER_AGENT, Math.floor(limit * 0.9)); out = render(limit) }
  if (out.text.length <= limitCap) return out.text
  // Долю дальше уменьшать нельзя (MIN_PER_AGENT): убираем целые строки с конца, а не
  // режем посимвольно — футер с адресом board_read обязан дойти целиком (break-4 Н21).
  const bodyText = out.truncated ? out.text.slice(0, -FOOTER.length) : out.text
  const lines = bodyText.split('\n')
  while (lines.length && lines.join('\n').length + FOOTER.length > limitCap) lines.pop()
  return lines.length ? lines.join('\n') + FOOTER : FOOTER.slice(0, limitCap)
}

module.exports = { PRIOR_CAP, digestBody, buildPrior }
