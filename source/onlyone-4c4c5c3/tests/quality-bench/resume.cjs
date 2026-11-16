// Продолжение прерванного хода внутри окна: берём карточку из настоящего
// хранилища контрольных точек и отправляем её текст с resumeRunId.
(async () => {
  const arg = (() => {
    try {
      const bin = atob('__ONECODE_ARG__')
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch (broken) { return {} }
  })()
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch { /* окно строится */ } await wait(50) }
    return false
  }
  if (!await until(() => window.electronAPI && typeof window.electronAPI.sendMessage === 'function', 40000)) {
    return { ok: false, error: 'мост send-message не поднялся за 40 с' }
  }
  const runs = typeof window.electronAPI.interruptedRuns === 'function'
    ? await window.electronAPI.interruptedRuns() : []
  const run = (Array.isArray(runs) ? runs : []).find(item => item.chatId === String(arg.chatId || 'bench')) ||
    (Array.isArray(runs) ? runs[0] : null)
  if (!run) return { ok: false, error: 'нет прерванного хода для продолжения', runs: 0 }
  const spoken = []
  const chunks = []
  const tools = []
  const seen = typeof window.electronAPI.onAgentEvent === 'function'
    ? window.electronAPI.onAgentEvent(one => { if (one && one.message) spoken.push(String(one.message)) }) : null
  const offChunks = typeof window.electronAPI.onMessageChunk === 'function'
    ? window.electronAPI.onMessageChunk(one => { const text = one?.choices?.[0]?.delta?.content; if (text) chunks.push(String(text)) }) : null
  const off = typeof window.electronAPI.onAgentToolLog === 'function'
    ? window.electronAPI.onAgentToolLog(one => tools.push({ tool: String(one?.tool || ''), ok: Boolean(one?.ok) }))
    : null
  let response = null, failure = ''
  try {
    response = await window.electronAPI.sendMessage({
      requestId: 'bench-resume-' + Date.now().toString(16),
      chatId: String(arg.chatId || 'bench'),
      params: { useTools: true },
      model: String(arg.model || ''),
      messages: [{ role: 'user', content: String(run.prompt || 'Продолжи прерванную работу.') }],
      resumeRunId: run.runId
    })
  } catch (error) { failure = String(error && error.message || error) }
  if (typeof off === 'function') { try { off() } catch { /* уже снята */ } }
  if (typeof offChunks === 'function') { try { offChunks() } catch { /* уже снята */ } }
  if (typeof seen === 'function') { try { seen() } catch { /* уже снята */ } }
  return {
    ok: failure ? false : Boolean(response && response.ok !== false),
    content: String(response && response.content || ''),
    runId: run.runId,
    prompt: String(run.prompt || ''),
    runs: Array.isArray(runs) ? runs.length : 0,
    usage: (response && response.usage) || null,
    spoken,
    spokenText: chunks.join(''),
    tools,
    error: failure || String(response && response.error || '')
  }
})()
