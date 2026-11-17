// Один ход стенда внутри окна: тот же мост send-message, что у человека.
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
  const spoken = []
  const chunks = []
  const tools = []
  const seen = typeof window.electronAPI.onAgentEvent === 'function'
    ? window.electronAPI.onAgentEvent(one => { if (one && one.message) spoken.push(String(one.message)) }) : null
  const offChunks = typeof window.electronAPI.onMessageChunk === 'function'
    ? window.electronAPI.onMessageChunk(one => { const text = one?.choices?.[0]?.delta?.content; if (text) chunks.push(String(text)) }) : null
  const off = typeof window.electronAPI.onAgentToolLog === 'function'
    ? window.electronAPI.onAgentToolLog(one => tools.push({ tool: String(one?.tool || ''), ok: Boolean(one?.ok), pending: Boolean(one?.pending) }))
    : null
  // «Человек» стенда: разрешает только адрес, названный задачей; всё остальное
  // отклоняет и записывает. Без перечня отклоняется любой спрос.
  const approveHosts = Array.isArray(arg.approve && arg.approve.hosts) ? arg.approve.hosts.map(String) : []
  const approvals = []
  const offApproval = typeof window.electronAPI.onAgentApproval === 'function'
    ? window.electronAPI.onAgentApproval(request => {
      let host = ''
      try { host = new URL(String(request && request.details || '').split('\n')[0]).host } catch { host = '' }
      const approved = Boolean(host) && approveHosts.includes(host)
      approvals.push({ summary: String(request && request.summary || '').slice(0, 160), approved })
      Promise.resolve(window.electronAPI.resolveAgentApproval({ id: request && request.id, approved })).catch(() => {})
    }) : null
  let response = null, failure = ''
  try {
    response = await window.electronAPI.sendMessage({
      requestId: 'bench-' + Date.now().toString(16),
      chatId: String(arg.chatId || 'bench'),
      projectId: arg.projectId ? String(arg.projectId) : null,
      params: { useTools: true },
      model: String(arg.model || ''),
      messages: [{ role: 'user', content: String(arg.request || '') }]
    })
  } catch (error) { failure = String(error && error.message || error) }
  if (typeof off === 'function') { try { off() } catch { /* уже снята */ } }
  if (typeof offApproval === 'function') { try { offApproval() } catch { /* уже снята */ } }
  if (typeof offChunks === 'function') { try { offChunks() } catch { /* уже снята */ } }
  if (typeof seen === 'function') { try { seen() } catch { /* уже снята */ } }
  return {
    ok: failure ? false : Boolean(response && response.ok !== false),
    content: String(response && response.content || ''),
    aborted: Boolean(response && response.aborted),
    usage: (response && response.usage) || null,
    spoken,
    spokenText: chunks.join(''),
    tools,
    approvals,
    error: failure || String(response && response.error || '')
  }
})()
