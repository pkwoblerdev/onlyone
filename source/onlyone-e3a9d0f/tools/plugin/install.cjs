'use strict'
// Plugin installs: verify the manifest (and signature), copy into the profile,
// and record the tree hash. Install never enables a plugin.
// Trust comes from the profile trust store (trust.cjs): when it holds keys, an
// unsigned or wrongly signed plugin is refused; an empty store installs unsigned
// plugins with signed:false and a warning, never as silently trusted.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { loadManifest, treeHash } = require('./manifest.cjs')
const trust = require('./trust.cjs')

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const SIGNATURE_NAME = 'signature.json'

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeRecord(file, record) {
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
}

function recordPath(profileDir, id) {
  return path.join(profileDir, 'plugins', id, 'record.json')
}

function versionDir(profileDir, id, version) {
  return path.join(profileDir, 'plugins', id, version)
}

function relativeDir(profileDir, dir) {
  return path.relative(profileDir, dir).split(path.sep).join('/')
}

function getRecord(profileDir, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('plugin: bad id')
  const record = readRecord(recordPath(profileDir, id))
  if (!record) throw new Error(`plugin: not installed: ${id}`)
  return record
}

function verifyWithKey(hash, signature, publicKey) {
  let key
  try {
    key = crypto.createPublicKey(publicKey)
  } catch {
    throw new Error('signature: bad public key')
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('signature: bad public key')
  const verdict = trust.verifySignature(hash, signature, [{ publicKey }])
  if (!verdict.ok) throw new Error('signature: bad signature')
}

// signature.json is written by tools/plugin/sign.cjs; older plugins carry the
// same base64 in plugin.json. A broken signature.json is an error, never "unsigned".
function loadSignature(pluginDir, manifest) {
  let raw
  try {
    raw = fs.readFileSync(path.join(pluginDir, SIGNATURE_NAME), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return manifest.signature
    throw new Error('signature: cannot read signature.json (' + (error.code || error.message) + ')')
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('signature: invalid signature.json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('signature: invalid signature.json')
  if (parsed.algorithm !== 'ed25519') throw new Error('signature: signature.json must be ed25519')
  if (typeof parsed.signature !== 'string' || !parsed.signature) throw new Error('signature: invalid signature.json')
  return parsed.signature
}

// Install, approve and rollback all go through this: when the profile trusts keys,
// an installed tree must still carry a signature from one of them.
// Returns the signer fingerprint, or null when the store has no keys.
function verifyInstalled(profileDir, dir, hash, manifest, signature) {
  const keys = trust.loadKeys(profileDir)
  if (keys.length === 0) return null
  const sig = signature === undefined ? loadSignature(dir, manifest) : signature
  if (sig === undefined) throw new Error('signature: the profile trusts keys, so an unsigned plugin is refused')
  const verdict = trust.verifySignature(hash, sig, keys)
  if (!verdict.ok) throw new Error('signature: bad signature (' + verdict.reason + ')')
  return verdict.fingerprint
}

function installPlugin(pluginDir, options = {}) {
  const { profileDir, publicKey } = options
  if (!profileDir) throw new Error('install: profileDir is required')
  const manifest = loadManifest(pluginDir)
  const hash = treeHash(pluginDir)
  const signature = loadSignature(pluginDir, manifest)

  const keys = trust.loadKeys(profileDir)
  let signed = false
  let signer
  let warning
  if (keys.length > 0) {
    // The profile trusts keys: only a signature from one of them is accepted.
    if (signature === undefined) throw new Error('signature: the profile trusts keys, so an unsigned plugin is refused')
    const verdict = trust.verifySignature(hash, signature, keys)
    if (!verdict.ok) throw new Error('signature: bad signature (' + verdict.reason + ')')
    signed = true
    signer = verdict.fingerprint
  } else if (signature !== undefined) {
    // No trusted keys: a caller-supplied key can be checked, but it is not trust.
    if (publicKey) verifyWithKey(hash, signature, publicKey)
    warning = publicKey
      ? 'not trusted: the key came from the caller, not from the profile trust store'
      : 'not trusted: no key in the profile trust store vouches for this plugin'
  } else {
    warning = 'no trusted key in the profile: the plugin is unsigned'
  }

  const idDir = path.join(profileDir, 'plugins', manifest.id)
  const target = versionDir(profileDir, manifest.id, manifest.version)
  fs.mkdirSync(idDir, { recursive: true })
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(pluginDir, target, { recursive: true })
  if (treeHash(target) !== hash) throw new Error('install: hash mismatch after copy')

  const file = recordPath(profileDir, manifest.id)
  const previous = readRecord(file)
  let grants = []
  let disabled = true
  let pendingGrants
  if (previous) {
    grants = Array.isArray(previous.grants) ? previous.grants : []
    if (manifest.capabilities.every((cap) => grants.includes(cap))) {
      disabled = previous.disabled === false ? false : true
    } else {
      // Wider capabilities than the currently granted set: stay (or become) disabled.
      pendingGrants = manifest.capabilities.slice()
    }
  }
  const record = {
    id: manifest.id,
    version: manifest.version,
    dir: relativeDir(profileDir, target),
    hash,
    grants,
    disabled,
    signed
  }
  if (signer) record.signer = signer
  if (warning) record.warning = warning
  if (pendingGrants) record.pendingGrants = pendingGrants
  writeRecord(file, record)
  const result = { id: record.id, version: record.version, dir: target, hash, grants: grants.slice(), disabled, signed }
  if (signer) result.signer = signer
  if (warning) result.warning = warning
  if (pendingGrants) result.pendingGrants = pendingGrants.slice()
  return result
}

function listPlugins(profileDir) {
  const root = path.join(profileDir, 'plugins')
  if (!fs.existsSync(root)) return []
  const records = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const record = readRecord(recordPath(profileDir, entry.name))
    if (record) records.push(record)
  }
  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function disablePlugin(profileDir, id) {
  const record = getRecord(profileDir, id)
  record.disabled = true
  writeRecord(recordPath(profileDir, id), record)
  return record
}

function approvePlugin(profileDir, id) {
  const record = getRecord(profileDir, id)
  const dir = path.join(profileDir, record.dir)
  const manifest = loadManifest(dir)
  const hash = treeHash(dir)
  if (hash !== record.hash) throw new Error('approve: hash mismatch')
  const signer = verifyInstalled(profileDir, dir, hash, manifest)
  record.grants = manifest.capabilities.slice()
  record.disabled = false
  record.signed = signer !== null
  if (signer) record.signer = signer
  else delete record.signer
  delete record.pendingGrants
  writeRecord(recordPath(profileDir, id), record)
  return record
}

function rollbackPlugin(profileDir, id, version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error('rollback: bad version')
  const record = getRecord(profileDir, id)
  const dir = versionDir(profileDir, id, version)
  if (!fs.existsSync(dir)) throw new Error(`rollback: version not installed: ${version}`)
  const manifest = loadManifest(dir)
  if (manifest.id !== id) throw new Error('rollback: id mismatch')
  const hash = treeHash(dir)
  const signer = verifyInstalled(profileDir, dir, hash, manifest)
  record.version = version
  record.dir = relativeDir(profileDir, dir)
  record.hash = hash
  record.signed = signer !== null
  if (signer) record.signer = signer
  else delete record.signer
  if (!manifest.capabilities.every((cap) => record.grants.includes(cap))) {
    record.disabled = true
    record.pendingGrants = manifest.capabilities.slice()
  }
  writeRecord(recordPath(profileDir, id), record)
  return record
}

function removePlugin(profileDir, id) {
  getRecord(profileDir, id)
  fs.rmSync(path.join(profileDir, 'plugins', id), { recursive: true, force: true })
  return { id, removed: true }
}

module.exports = { installPlugin, listPlugins, disablePlugin, approvePlugin, rollbackPlugin, removePlugin }
