'use strict'

const { randomUUID } = require('node:crypto')
const KINDS = new Set(['browser', 'artifact', 'process', 'external-app', 'output'])
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const LIMIT = 64
const REPLAYS = 256
const own = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && !Object.prototype.hasOwnProperty.call(value, '__proto__') && Object.keys(value).every(key => allowed.includes(key))
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)
const safeId = value => text(value, 200) && !RESERVED_IDS.has(value)
const actor = value => text(value, 200) && /^(human|agent):.+/.test(value)
function validPortable (value, kind) {
  return own(value, ['type', 'content', 'active', 'dependencies']) &&
    ((kind === 'artifact' && value.type === 'page') || (kind === 'output' && value.type === 'text')) &&
    typeof value.content === 'string' && value.content.length <= 200000 && typeof value.active === 'boolean' &&
    Array.isArray(value.dependencies) && value.dependencies.length <= 100 && value.dependencies.every(item => typeof item === 'string' && item.length <= 1000)
}

function validRect (rect) {
  return own(rect, ['x', 'y', 'width', 'height', 'z']) &&
    ['x', 'y', 'width', 'height', 'z'].every(key => Number.isSafeInteger(rect[key])) &&
    Math.abs(rect.x) <= 20000 && Math.abs(rect.y) <= 20000 &&
    rect.width >= 280 && rect.width <= 20000 && rect.height >= 200 && rect.height <= 20000 &&
    rect.z >= 0 && rect.z <= 1000000
}

function validateSnapshot (value) {
  const revision = n => Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER
  if (!own(value, ['schemaVersion', 'id', 'title', 'revision', 'blocks']) || value.schemaVersion !== 1 ||
      !safeId(value.id) || !text(value.title, 200) || !revision(value.revision) ||
      !Array.isArray(value.blocks) || value.blocks.length > LIMIT) throw new TypeError('Invalid Desk snapshot')
  const ids = new Set()
  for (const block of value.blocks) {
    if (!own(block, ['id', 'kind', 'title', 'resourceRef', 'rect', 'revision', 'portable']) || !safeId(block.id) || ids.has(block.id) ||
        !KINDS.has(block.kind) || !text(block.title, 200) || !text(block.resourceRef, 512) ||
        !validRect(block.rect) || !revision(block.revision) || block.revision < 1 ||
        (block.portable !== undefined && !validPortable(block.portable, block.kind))) throw new TypeError('Invalid Desk block')
    ids.add(block.id)
  }
  return structuredClone(value)
}

function createDeskModel ({ title, initial, persist, idFactory = randomUUID } = {}) {
  if (!initial && !text(title, 200)) throw new TypeError('Desk title is required')
  let state = initial ? validateSnapshot(initial) : { schemaVersion: 1, id: idFactory(), title, revision: 0, blocks: [] }
  const held = new Map()
  const completed = new Map()
  const snapshot = () => structuredClone(state)
  const fail = code => ({ ok: false, code, snapshot: snapshot() })

  function change (command, commit) {
    if (!own(command, ['operationId', 'expectedRevision', 'operations', 'actorId']) ||
        !safeId(command.operationId) || !actor(command.actorId) ||
        !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
        !Array.isArray(command.operations) || !command.operations.length || command.operations.length > LIMIT) return fail('invalid')
    let signature
    try { signature = JSON.stringify(command) } catch { return fail('invalid') }
    const previous = completed.get(command.operationId)
    if (previous) {
      if (previous.signature !== signature) return fail('operation-reused')
      return { ok: true, replayed: true, appliedRevision: previous.revision, snapshot: snapshot() }
    }
    if (command.expectedRevision !== state.revision) return fail('conflict')
    const next = snapshot()
    for (const op of command.operations) {
      if (!op || typeof op !== 'object') return fail('invalid')
      if (op.type === 'add') {
        const block = op.block
        if (!own(op, ['type', 'block']) || !own(block, ['kind', 'title', 'resourceRef', 'rect', 'portable']) ||
            !KINDS.has(block.kind) || !text(block.title, 200) || !text(block.resourceRef, 512) ||
            !validRect(block.rect) || next.blocks.length >= LIMIT ||
            (block.portable !== undefined && !validPortable(block.portable, block.kind))) return fail('invalid')
        next.blocks.push({ id: idFactory(), kind: block.kind, title: block.title, resourceRef: block.resourceRef, rect: { ...block.rect }, revision: 1 })
        if (block.portable) next.blocks[next.blocks.length - 1].portable = structuredClone(block.portable)
        continue
      }
      if (!safeId(op.id)) return fail('invalid')
      const index = next.blocks.findIndex(block => block.id === op.id)
      if (index < 0) return fail('invalid')
      if (held.has(op.id) && held.get(op.id) !== command.actorId) return fail('busy')
      if (op.type === 'remove' && own(op, ['type', 'id'])) next.blocks.splice(index, 1)
      else if (op.type === 'geometry' && own(op, ['type', 'id', 'rect']) && validRect(op.rect)) {
        next.blocks[index].rect = { ...op.rect }
        next.blocks[index].revision++
      } else if (op.type === 'resource' && own(op, ['type', 'id', 'resourceRef']) && text(op.resourceRef, 512)) {
        next.blocks[index].resourceRef = op.resourceRef
        delete next.blocks[index].portable
        next.blocks[index].revision++
      } else if (op.type === 'activate' && own(op, ['type', 'id']) && next.blocks[index].portable) {
        next.blocks[index].portable.active = true
        next.blocks[index].revision++
      } else return fail('invalid')
    }
    next.revision++
    if (!commit) return { ok: true, snapshot: next }
    try {
      validateSnapshot(next)
      if (persist) persist(structuredClone(next))
    } catch { return fail('storage-unavailable') }
    state = next
    for (const id of held.keys()) if (!state.blocks.some(block => block.id === id)) held.delete(id)
    completed.set(command.operationId, { signature, revision: state.revision })
    if (completed.size > REPLAYS) completed.delete(completed.keys().next().value)
    return { ok: true, appliedRevision: state.revision, snapshot: snapshot() }
  }

  function hold (id, owner) {
    if (!actor(owner) || !owner.startsWith('human:') || !state.blocks.some(block => block.id === id)) return fail('invalid')
    if (held.has(id) && held.get(id) !== owner) return fail('busy')
    held.set(id, owner)
    return { ok: true }
  }

  function releaseOwner (owner) {
    for (const [id, holder] of held) if (holder === owner) held.delete(id)
  }

  // shortcut: replay history lives for this process (last 256 successful edits); disk recovery belongs to the store.
  return Object.freeze({ snapshot, apply: command => change(command, true), preview: command => change(command, false), hold, releaseOwner })
}

module.exports = { createDeskModel, validateSnapshot }
