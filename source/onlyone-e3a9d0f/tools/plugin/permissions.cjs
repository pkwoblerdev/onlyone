'use strict'
// Capability checks for plugin grants. Default is deny.
const path = require('node:path')
const { CAPABILITIES } = require('./manifest.cjs')

let workspaceRoot = null

function setWorkspace(dir) {
  workspaceRoot = dir ? path.resolve(dir) : null
}

function normalize(grants) {
  return (Array.isArray(grants) ? grants : [])
    .map((grant) => (typeof grant === 'string' ? { cap: grant } : grant))
    .filter((grant) => grant && typeof grant.cap === 'string')
}

// Only the apiVersion 1 capability set can ever be granted; there is no
// chats/profile/secrets capability at all.
function createGrants(record) {
  const caps = record && Array.isArray(record.capabilities) ? record.capabilities : []
  return caps.filter((cap) => CAPABILITIES.includes(cap))
}

const deny = (reason) => ({ ok: false, reason })

function insideWorkspace(target) {
  if (!workspaceRoot) return false
  const resolved = path.resolve(workspaceRoot, target)
  const root = workspaceRoot.toLowerCase()
  const wanted = resolved.toLowerCase()
  return wanted === root || wanted.startsWith(root + path.sep.toLowerCase())
}

function checkCapability(grants, cap, arg) {
  if (typeof cap !== 'string' || !CAPABILITIES.includes(cap)) return deny(`unknown capability: ${cap}`)
  const list = normalize(grants).filter((grant) => grant.cap === cap)
  if (list.length === 0) return deny(`no grant for ${cap}`)

  if (cap === 'exec') {
    const cmd = typeof arg === 'string' ? arg : arg && arg.cmd
    if (!cmd) return deny('exec: cmd is required')
    return list.some((grant) => grant.cmd === cmd) ? { ok: true } : deny(`exec: "${cmd}" not granted`)
  }
  if (cap === 'net') {
    const host = typeof arg === 'string' ? arg : arg && arg.host
    if (!host) return deny('net: host is required')
    const wanted = String(host).toLowerCase()
    const allowed = list.some((grant) => Array.isArray(grant.hosts) &&
      (grant.hosts.includes('*') || grant.hosts.some((entry) => String(entry).toLowerCase() === wanted)))
    return allowed ? { ok: true } : deny(`net: "${host}" not allowed`)
  }
  if (cap === 'fs.read') {
    const target = typeof arg === 'string' ? arg : arg && arg.path
    if (!target) return deny('fs.read: path is required')
    if (!workspaceRoot) return deny('fs.read: workspace not set')
    return insideWorkspace(target) ? { ok: true } : deny(`fs.read: "${target}" outside workspace`)
  }
  return { ok: true }
}

module.exports = { createGrants, checkCapability, setWorkspace }
