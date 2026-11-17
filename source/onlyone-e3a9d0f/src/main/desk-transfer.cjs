'use strict'
const { validateSnapshot } = require('./desk-model.cjs')
const FORMAT = 'onlyone-desk-template'
const MAX_BYTES = 256 * 1024
const PENDING = 'desk-pending:'
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && !Object.prototype.hasOwnProperty.call(value, '__proto__') && Object.keys(value).every(key => keys.includes(key))

function origin (value) {
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && url.origin.length <= 400) return url.origin
  } catch {}
  return null
}

function parseTemplate (text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw Error('Invalid Desk template size')
  const value = JSON.parse(text)
  if (!own(value, ['format', 'version', 'title', 'blocks']) || value.format !== FORMAT || value.version !== 1 || !Array.isArray(value.blocks) || value.blocks.length > 64) throw Error('Invalid Desk template')
  for (const block of value.blocks) {
    if (!own(block, ['kind', 'title', 'rect', 'url']) || (Object.hasOwn(block, 'url') &&
        (block.kind !== 'browser' || typeof block.url !== 'string' || origin(block.url) !== block.url))) throw Error('Invalid Desk template resource')
  }
  validateSnapshot({ schemaVersion: 1, id: 'template', title: value.title, revision: 0,
    blocks: value.blocks.map((block, index) => ({ id: String(index), kind: block.kind, title: block.title, rect: block.rect,
      resourceRef: pendingResource(block), revision: 1 })) })
  return value
}

function pendingResource (block) {
  return PENDING + block.kind + (block.kind === 'browser' && block.url ? ':' + block.url : '')
}

function exportTemplate (snapshot) {
  const checked = validateSnapshot(snapshot)
  const value = { format: FORMAT, version: 1, title: checked.title, blocks: checked.blocks.map(block => {
    const result = { kind: block.kind, title: block.title, rect: block.rect }
    if (block.kind === 'browser') {
      const hint = block.resourceRef.startsWith(PENDING + 'browser:') ? block.resourceRef.slice((PENDING + 'browser:').length) : block.resourceRef
      const url = origin(hint)
      // Only the site origin is portable: paths, query strings and credentials can contain private data.
      if (url) result.url = url
    }
    return result
  }) }
  const text = JSON.stringify(value, null, 2)
  parseTemplate(text)
  return text
}

module.exports = { exportTemplate, parseTemplate, pendingResource, PENDING, MAX_BYTES, FORMAT }
