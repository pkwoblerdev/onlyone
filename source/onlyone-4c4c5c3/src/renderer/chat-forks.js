(function (root) {
  'use strict'
  function snapshot (chat, end = chat?.messages?.length - 1) {
    if (!chat?.id || !Array.isArray(chat.messages) || !Number.isInteger(end) || end < 0 || end >= chat.messages.length) throw Error('invalid-boundary')
    const source = chat.messages.slice(0, end + 1)
    const messages = []
    let omitted = false
    for (const message of source) {
      if (!['user', 'assistant'].includes(message?.role)) { omitted = true; continue }
      const content = typeof message.content === 'string' ? message.content
        : Array.isArray(message.content) ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : ''
      if (typeof message.content !== 'string' || message.attachments?.length || message.blocks?.length || message.tool_calls?.length) omitted = true
      if (content.trim()) messages.push({ role: message.role, content, ...(Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}) })
    }
    if (!messages.length) throw Error('empty-context')
    return { parentChatId: chat.id, end, messages, omitted, revision: JSON.stringify(source) }
  }
  function child (source, preview, title, id, now = Date.now()) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 200 || typeof id !== 'string' || !id || id === source.id) throw Error('invalid-chat')
    if (source.id !== preview.parentChatId || snapshot(source, preview.end).revision !== preview.revision) throw Error('source-changed')
    return { id, title: title.trim(), projectId: source.projectId || null, createdAt: now, updatedAt: now,
      messages: preview.messages.map(message => ({ ...message })),
      fork: { version: 1, kind: 'text-snapshot', parentChatId: source.id, sourceMessageIndex: preview.end, createdAt: now } }
  }
  const api = Object.freeze({ snapshot, child })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneChatForks = api
})(typeof window === 'object' ? window : globalThis)
