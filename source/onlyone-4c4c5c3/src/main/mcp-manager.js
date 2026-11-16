// The SDK reports a failure as "Streamable HTTP error: Error POSTing to
// endpoint: {json}" — a stack trace wearing a message. What the user needs to
// know is which of a handful of things went wrong and what to do about it.
const { createHash } = require('node:crypto')
const { maskSecretText } = require('./providers/secret-mask')

function describeMcpError(error, config) {
  const raw = String(error?.message || error || '')

  // Servers put the real reason in a JSON body; pull it out of the wrapper.
  let detail = ''
  const json = raw.match(/\{[\s\S]*\}/)
  if (json) {
    try {
      const parsed = JSON.parse(json[0])
      detail = String(parsed.error?.message || parsed.error || parsed.message || '')
    } catch {}
  }

  const text = (detail || raw).toLowerCase()
  // Маска ДО выдачи в каждой ветке: токен живёт и в адресе (?token=…), и в
  // команде (--api-key=…), а не только в заголовке (break-5b Н17).
  const secret = Object.entries(config?.headers || {}).find(([k]) => /^authorization$/i.test(k))?.[1]
  const safe = value => maskSecretText(String(value), String(secret || '')).slice(0, 400)
  const hasAuth = Boolean(config?.headers && Object.keys(config.headers).some(k => /^authorization$/i.test(k)))
  const emptyBearer = Boolean(
    config?.headers &&
    Object.entries(config.headers).some(([k, v]) => /^authorization$/i.test(k) && !String(v).replace(/^bearer\s*/i, '').trim())
  )

  if (/401|unauthorized|token|oauth|sign in|forbidden|403/.test(text)) {
    if (emptyBearer) return 'Сервер требует токен, а в заголовке Authorization после «Bearer » пусто. Нажмите «Изменить» и вставьте токен.'
    if (!hasAuth) return 'Сервер требует авторизацию. Нажмите «Изменить» и добавьте заголовок: {"Authorization": "Bearer ваш_токен"}.'
    return 'Сервер отклонил токен. Проверьте, что он не истёк и скопирован целиком.'
  }
  if (/404|not found/.test(text)) return safe(`По адресу ${config?.url || 'этому'} нет MCP-эндпоинта. Проверьте путь — обычно он оканчивается на /mcp.`)
  if (/enotfound|getaddrinfo|dns/.test(text)) return 'Адрес не резолвится. Проверьте домен.'
  if (/econnrefused|fetch failed|network|socket/.test(text)) return 'Сервер недоступен — нет сети или он не отвечает.'
  if (/certificate|self-signed|ssl|tls/.test(text)) return 'Проблема с сертификатом HTTPS у сервера.'
  if (/enoent|spawn/.test(text)) return safe(`Не удалось запустить «${config?.command || 'команду'}». Проверьте, что она установлена и доступна в PATH.`)
  if (/timeout|timed out/.test(text)) return 'Сервер не ответил вовремя.'

  // Н3 аудита sec-net 2026-11-01: сервер вправе эхом вернуть отправленный ему
  // Authorization, и этот текст уезжает в карточку, а каналом mcp-status — во все
  // окна. Как у провайдеров модели (`providers/*`): маска ДО выдачи, длина ограничена.
  return safe(detail || raw || 'Не удалось подключить MCP-сервер.')
}

// Some hop between here and a remote server reaps an idle stream at around a
// hundred seconds, so the ping has to land well inside that window.
const MCP_KEEPALIVE_MS = 45000
const MCP_RETRY_STEPS = [2000, 5000, 15000, 30000, 60000]
// How long a tool call will sit and wait for a reconnect before giving up.
const MCP_CALL_WAIT_MS = 20000

class McpManager {
  constructor({ onStatus } = {}) {
    this.onStatus = onStatus || (() => {})
    this.configs = new Map()
    this.sessions = new Map()
    this.toolMap = new Map()
    // Servers being stopped deliberately; a reconnect must not fight that.
    this.retiring = new Set()
  }

  setConfigs(configs = []) {
    this.configs = new Map(configs.map(config => [config.id, config]))
  }

  publicServers() {
    return [...this.configs.values()].map(config => {
      const session = this.sessions.get(config.id)
      return {
        id: config.id,
        name: config.name,
        type: config.type,
        command: config.type === 'stdio' ? config.command : undefined,
        // Arguments are not secret and the edit form needs them back.
        args: config.type === 'stdio' ? (config.args || []) : undefined,
        url: config.type === 'http' ? config.url : undefined,
        status: session?.status || 'disconnected',
        error: session?.error || null,
        toolCount: session?.tools?.length || 0,
        tools: (session?.tools || []).map(tool => String(tool?.name || '')).filter(Boolean).slice(0, 40),
        hasEnvironment: Boolean(config.env && Object.keys(config.env).length),
        hasHeaders: Boolean(config.headers && Object.keys(config.headers).length)
      }
    })
  }

  // A Streamable HTTP session dies quietly: the server-sent stream is idle, some
  // hop between here and the server drops it around a hundred seconds, and the
  // transport reports a close. The session itself is usually still fine — POSTs
  // would work — but the connection was being marked dead and the user had to
  // press connect again every couple of minutes.
  //
  // Two things keep it alive. A ping well under that idle window means the
  // connection is never idle long enough to be reaped, and an unexpected close
  // schedules a reconnect instead of giving up. Only an explicit disconnect
  // stops the retries.

  async connect(serverId, { manual = true } = {}) {
    const config = this.configs.get(serverId)
    if (!config) throw new Error('MCP-сервер не найден.')
    if (this.sessions.get(serverId)?.status === 'connected') return this.publicServers().find(server => server.id === serverId)

    const previous = this.sessions.get(serverId)
    const attempt = manual ? 0 : (previous?.attempt || 0)
    await this.disconnect(serverId, { silent: true })
    if (manual) this.retiring.delete(serverId)

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    let transport
    if (config.type === 'stdio') {
      const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      // Ребёнок не наследует окружение главного процесса целиком: там могут быть
      // секреты. Только безопасный список SDK плюс явно заданный env сервера.
      transport = new StdioClientTransport({ command: config.command, args: config.args || [], env: { ...getDefaultEnvironment(), ...(config.env || {}) } })
    } else if (config.type === 'http') {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      // Транспорт SDK сам переподключает закрытый GET-поток и берёт паузу из
      // поля `retry:` сервера дословно. Сервер, который просит `retry: 0`,
      // превращал это в шторм в обход MCP_RETRY_STEPS (Н22). Отдаём каждый
      // повтор сюда: onerror у живого соединения вызывает scheduleReconnect, а
      // лестница пауз живёт только там.
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers || {} },
        reconnectionOptions: { maxRetries: 0 }
      })
    } else {
      throw new Error('Поддерживаются только stdio и Streamable HTTP MCP-серверы.')
    }

    const session = {
      status: 'connecting', client: null, transport, tools: [], error: null,
      attempt, keepalive: null, retry: null
    }
    this.sessions.set(serverId, session)
    this.emit(serverId)

    try {
      const client = new Client({ name: 'onlyone', version: '0.6.0' }, { capabilities: {} })

      transport.onerror = error => {
        const active = this.sessions.get(serverId)
        if (!active || active !== session) return
        // An error on a live session is a dropped stream, not a dead server.
        if (active.status === 'connected') {
          // Причина переподключения идёт в тот же канал статуса — её тоже судит
          // describeMcpError (маска секрета из эхо-ответа, ограничение длины).
          this.scheduleReconnect(serverId, describeMcpError(error, config))
          return
        }
        active.status = 'error'
        active.error = describeMcpError(error, config)
        this.emit(serverId)
      }

      transport.onclose = () => {
        const active = this.sessions.get(serverId)
        if (!active || active !== session) return
        if (active.status === 'error' || this.retiring.has(serverId)) return
        this.scheduleReconnect(serverId, 'сервер закрыл поток')
      }

      await client.connect(transport)
      const response = await client.listTools()
      session.client = client
      session.tools = Array.isArray(response?.tools) ? response.tools : []
      session.status = 'connected'
      session.error = null
      session.attempt = 0
      this.startKeepalive(serverId)
      this.rebuildToolMap()
      this.emit(serverId)
      return this.publicServers().find(server => server.id === serverId)
    } catch (error) {
      session.status = 'error'
      session.error = describeMcpError(error, config)
      this.emit(serverId)
      try { await transport.close?.() } catch {}
      // A manual press deserves an immediate answer; a background retry should
      // keep trying rather than surface a toast nobody asked for.
      if (!manual) this.scheduleReconnect(serverId, session.error)
      else throw new Error(session.error)
    }
  }

  startKeepalive(serverId) {
    const session = this.sessions.get(serverId)
    if (!session || session.keepalive) return
    session.keepalive = setInterval(async () => {
      const active = this.sessions.get(serverId)
      if (!active?.client || active.status !== 'connected') return
      try {
        await active.client.ping()
      } catch (error) {
        if (session.keepalive) { clearInterval(session.keepalive); session.keepalive = null }
        this.scheduleReconnect(serverId, 'сервер не ответил на проверку связи')
      }
    }, MCP_KEEPALIVE_MS)
    session.keepalive.unref?.()
  }

  scheduleReconnect(serverId, reason) {
    const session = this.sessions.get(serverId)
    if (!session || session.retry || this.retiring.has(serverId)) return

    if (session.keepalive) { clearInterval(session.keepalive); session.keepalive = null }

    session.status = 'reconnecting'
    session.error = reason ? `Переподключаюсь: ${reason}` : 'Переподключаюсь…'
    session.attempt = (session.attempt || 0) + 1
    this.rebuildToolMap()
    this.emit(serverId)

    const wait = MCP_RETRY_STEPS[Math.min(session.attempt - 1, MCP_RETRY_STEPS.length - 1)]
    session.retry = setTimeout(() => {
      const active = this.sessions.get(serverId)
      if (active) active.retry = null
      if (this.retiring.has(serverId)) return
      this.connect(serverId, { manual: false }).catch(() => {})
    }, wait)
    session.retry.unref?.()
  }

  // `silent` is the internal teardown a reconnect does before dialling again;
  // without it every retry would announce a disconnect the user never asked for.
  async disconnect(serverId, { silent = false } = {}) {
    if (!silent) this.retiring.add(serverId)
    const session = this.sessions.get(serverId)
    if (!session) {
      if (!silent) this.retiring.delete(serverId)
      return
    }
    if (session.keepalive) clearInterval(session.keepalive)
    if (session.retry) clearTimeout(session.retry)
    this.sessions.delete(serverId)
    this.rebuildToolMap()
    try { await session.client?.close?.() } catch {}
    try { await session.transport?.close?.() } catch {}
    if (!silent) {
      this.retiring.delete(serverId)
      this.emit(serverId)
    }
  }

  async remove(serverId) {
    await this.disconnect(serverId)
    this.configs.delete(serverId)
    this.emit(serverId)
  }

  async disconnectAll() {
    for (const id of [...this.sessions.keys()]) await this.disconnect(id)
  }

  rebuildToolMap() {
    this.toolMap.clear()
    for (const [serverId, session] of this.sessions) {
      // Tools stay listed through a reconnect. Dropping them mid-turn changes
      // the toolset the model was given and makes a two-second blip look like
      // the server vanished.
      if (session.status !== 'connected' && session.status !== 'reconnecting') continue
      for (const tool of session.tools) {
        const safeServer = serverId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 10)
        const safeTool = String(tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 42)
        // Truncation/sanitising must not silently route a call to another
        // server or tool with the same prefix.
        const suffix = '_' + createHash('sha256').update(JSON.stringify([serverId, tool.name])).digest('hex').slice(0, 12)
        const functionName = `mcp_${safeServer}_${safeTool}`.slice(0, 64 - suffix.length) + suffix
        this.toolMap.set(functionName, { serverId, toolName: tool.name, tool })
      }
    }
  }

  openRouterTools() {
    return [...this.toolMap.entries()].map(([name, value]) => ({
      type: 'function',
      function: {
        name,
        description: `[MCP: ${this.configs.get(value.serverId)?.name || value.serverId}] ${value.tool.description || value.tool.name}`.slice(0, 900),
        parameters: value.tool.inputSchema || { type: 'object', properties: {} }
      }
    }))
  }

  async callOpenRouterTool(functionName, args, { signal } = {}) {
    signal?.throwIfAborted()
    const mapped = this.toolMap.get(functionName)
    if (!mapped) throw new Error('MCP-инструмент больше не подключён.')

    // Wait out a reconnect rather than failing the step. A dropped stream is
    // usually back within seconds, and the agent should not have to notice.
    const deadline = Date.now() + MCP_CALL_WAIT_MS
    let session = this.sessions.get(mapped.serverId)
    while (session && ['reconnecting', 'connecting'].includes(session.status) && Date.now() < deadline) {
      signal?.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 250))
      session = this.sessions.get(mapped.serverId)
    }

    signal?.throwIfAborted()
    if (!session?.client || session.status !== 'connected') {
      throw new Error(['reconnecting', 'connecting'].includes(session?.status)
        ? 'MCP-сервер переподключается — попробуйте этот шаг ещё раз.'
        : 'MCP-сервер не подключён.')
    }

    return session.client.callTool({ name: mapped.toolName, arguments: args || {} }, undefined, { signal })
  }

  emit(serverId) {
    this.rebuildToolMap()
    this.onStatus({ serverId, servers: this.publicServers(), connectedTools: this.openRouterTools().length })
  }
}

module.exports = { McpManager, MCP_RETRY_STEPS }
