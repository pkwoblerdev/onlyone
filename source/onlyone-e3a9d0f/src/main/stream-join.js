// A provider retry starts a new attempt, not a new SSE chunk. Preserve the
// boundary only there; ordinary chunks must stay byte-for-byte adjacent.
function joinStreamChunk(previous, chunk, afterRetry = false) {
  const next = String(chunk || '')
  if (!next || !afterRetry || !String(previous || '').trim()) return next
  const before = String(previous)
  if (/\n\s*\n$/.test(before) || /^\n\s*\n/.test(next)) return next
  return (before.endsWith('\n') || next.startsWith('\n') ? '\n' : '\n\n') + next
}

module.exports = { joinStreamChunk }
