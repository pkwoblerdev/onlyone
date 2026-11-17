/* Свои чаты на телефоне: провайдер с совместимым с OpenAI интерфейсом (OpenRouter по умолчанию). Ключ лежит
   на телефоне в зашифрованном хранилище и уходит только на адрес этого провайдера. */
(function (root) {
  'use strict'

  const OPENROUTER = 'https://openrouter.ai/api/v1'

  function cleanBase(url) { return String(url || OPENROUTER).trim().replace(/\/+$/, '') }

  function errorText(status, body) {
    let detail = ''
    try { const parsed = JSON.parse(body); detail = (parsed.error && (parsed.error.message || parsed.error)) || '' } catch { detail = String(body || '').slice(0, 160) }
    if (status === 401 || status === 403) return { code: 'key', text: 'Ключ не принят (' + status + '). Проверьте, что он скопирован целиком' }
    if (status === 402) return { code: 'money', text: 'Провайдер просит пополнить баланс (402)' }
    if (status === 404) return { code: 'model', text: 'Модель не найдена (404)' + (detail ? ': ' + detail : '') }
    if (status === 429) return { code: 'rate', text: 'Слишком много запросов (429): подождите немного' }
    return { code: 'http', text: 'Провайдер ответил ' + status + (detail ? ': ' + String(detail).slice(0, 160) : '') }
  }

  // Потоковый ответ: onDelta(кусок, всё) на каждый кусок; возвращает итоговый текст. signal — остановка.
  async function stream(options) {
    const { provider, model, messages, signal, onDelta, fetchImpl } = options
    const doFetch = fetchImpl || root.fetch.bind(root)
    const response = await doFetch(cleanBase(provider.baseUrl) + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + provider.key, 'x-title': 'onlyone' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal
    })
    if (!response.ok) {
      const info = errorText(response.status, await response.text().catch(() => ''))
      const error = new Error(info.text)
      error.code = info.code
      throw error
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return full
        let chunk
        try { chunk = JSON.parse(data) } catch { continue }
        if (chunk.error) { const error = new Error(String(chunk.error.message || 'ошибка провайдера')); error.code = 'http'; throw error }
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta
        const piece = delta && delta.content
        if (piece) { full += piece; onDelta(piece, full) }
      }
    }
    return full
  }

  async function listModels(provider, fetchImpl) {
    const doFetch = fetchImpl || root.fetch.bind(root)
    const response = await doFetch(cleanBase(provider.baseUrl) + '/models', { headers: provider.key ? { authorization: 'Bearer ' + provider.key } : {} })
    if (!response.ok) throw new Error('Список моделей не получен (' + response.status + ')')
    const body = await response.json()
    return (body.data || []).map(item => ({ id: item.id, name: item.name || item.id })).slice(0, 600)
  }

  const api = { stream, listModels, cleanBase, OPENROUTER, errorText }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneProvider = api
})(typeof window !== 'undefined' ? window : globalThis)
