'use strict'
// Line-delimited JSON-RPC over stdio: one JSON object per line, max 1 MiB.
const MAX_FRAME = 1024 * 1024

function encodeFrame(message) {
  return JSON.stringify(message) + '\n'
}

function createParser({ onMessage, onError, maxBytes = MAX_FRAME }) {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        if (Buffer.byteLength(line) > maxBytes) {
          buffer = ''
          onError(new Error('protocol: frame too large'))
          return
        }
        let message
        try {
          message = JSON.parse(line)
        } catch {
          onError(new Error('protocol: invalid JSON line'))
          continue
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          onError(new Error('protocol: frame is not an object'))
          continue
        }
        onMessage(message)
      }
      if (Buffer.byteLength(buffer) > maxBytes) {
        buffer = ''
        onError(new Error('protocol: frame too large'))
      }
    }
  }
}

module.exports = { MAX_FRAME, encodeFrame, createParser }
