'use strict'
const { validateSnapshot } = require('./desk-model.cjs')
const { exportTemplate, parseTemplate, MAX_BYTES, FORMAT: TEMPLATE_FORMAT } = require('./desk-transfer.cjs')
const FORMAT = 'onlyone-desk-package'
const own = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && !Object.prototype.hasOwnProperty.call(value, '__proto__') && Object.keys(value).every(key => fields.includes(key))
function dependencies (content) {
  const result = new Set()
  for (const match of content.matchAll(/(?:\b(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^)'"\s]+))/gi)) {
    const value = match[1] || match[2]
    if (!value.startsWith('data:') && !value.startsWith('#')) result.add(value.slice(0, 1000))
    if (result.size > 100) throw Error('Too many dependencies')
  }
  return [...result]
}
async function exportPackage (snapshot, resolve) {
  const value = JSON.parse(exportTemplate(snapshot))
  value.format = FORMAT
  for (let index = 0; index < snapshot.blocks.length; index++) {
    const block = snapshot.blocks[index]
    if (!['artifact', 'output'].includes(block.kind) || block.resourceRef.startsWith('desk-pending:')) continue
    const resource = block.portable || await resolve(block)
    if (!resource || !['page', 'text'].includes(resource.type) || typeof resource.content !== 'string') throw Error('Unsupported package resource')
    value.blocks[index].portable = { type: resource.type, content: resource.content, active: false,
      dependencies: resource.type === 'page' ? dependencies(resource.content) : [] }
  }
  const text = JSON.stringify(value, null, 2)
  parsePackage(text)
  return text
}
function parsePackage (text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw Error('Invalid package size')
  const value = JSON.parse(text)
  if (!own(value, ['format', 'version', 'title', 'blocks']) || value.format !== FORMAT || !Array.isArray(value.blocks)) throw Error('Invalid package')
  const layout = { ...value, format: 'onlyone-desk-template', blocks: value.blocks.map(block => {
    if (!own(block, ['kind', 'title', 'rect', 'url', 'portable'])) throw Error('Invalid package block')
    const { portable, ...rest } = block
    return rest
  }) }
  // Reuse the current template's strict geometry and resource validation.
  layout.format = TEMPLATE_FORMAT
  parseTemplate(JSON.stringify(layout))
  const snapshot = { schemaVersion: 1, id: 'package', title: value.title, revision: 0,
    blocks: value.blocks.map((block, index) => ({ id: String(index), kind: block.kind, title: block.title, rect: block.rect,
      resourceRef: block.portable ? 'desk-package:' + block.portable.type : 'desk-pending:' + block.kind, revision: 1,
      ...(block.portable ? { portable: block.portable } : {}) })) }
  validateSnapshot(snapshot)
  for (const block of value.blocks) if (block.portable && (block.portable.active !== false ||
      JSON.stringify(block.portable.dependencies) !== JSON.stringify(block.portable.type === 'page' ? dependencies(block.portable.content) : []))) throw Error('Invalid package resource')
  return value
}
function fitBlocks (blocks, viewport) {
  if (!viewport || !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) || viewport.width < 280 || viewport.height < 200 || viewport.width > 20000 || viewport.height > 20000) return structuredClone(blocks)
  return blocks.map(block => {
    const width = Math.min(block.rect.width, viewport.width), height = Math.min(block.rect.height, viewport.height)
    return { ...structuredClone(block), rect: { ...block.rect, width, height,
      x: Math.max(0, Math.min(block.rect.x, viewport.width - width)), y: Math.max(0, Math.min(block.rect.y, viewport.height - height)) } }
  })
}
function legacyTemplate (source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_BYTES) throw Error('Invalid legacy workspace')
  const unpacked = require('./workspace-crate').unpack(source)
  if (!unpacked.ok) throw Error('Invalid legacy workspace')
  const value = { format: TEMPLATE_FORMAT, version: 1, title: unpacked.workspace.name.slice(0, 200),
    blocks: unpacked.workspace.blocks.map((block, index) => ({
      kind: block.role === 'browser' ? 'browser' : 'output', title: block.title.slice(0, 200),
      rect: { x: Math.round(block.x), y: Math.round(block.y), width: Math.max(280, Math.round(block.w)), height: Math.max(200, Math.round(block.h)), z: index }
    })) }
  return parseTemplate(JSON.stringify(value))
}
module.exports = { exportPackage, parsePackage, fitBlocks, legacyTemplate }
