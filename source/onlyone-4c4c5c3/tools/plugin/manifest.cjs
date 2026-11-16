'use strict'
// Plugin manifest (apiVersion 1): validation and tree hash over plugin files.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const CAPABILITIES = ['fs.read', 'exec', 'net', 'storage', 'events', 'ui.panel', 'agent.tools']
const MANIFEST_KEYS = new Set(['id', 'version', 'apiVersion', 'entry', 'capabilities', 'selftest', 'ui', 'signature'])
const ID_RE = /^[a-z][a-z0-9-]{1,40}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest: not an object')
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.has(key)) throw new Error(`manifest: unknown key "${key}"`)
  }
  for (const key of ['id', 'version', 'apiVersion', 'entry', 'capabilities']) {
    if (manifest[key] === undefined) throw new Error(`manifest: missing "${key}"`)
  }
  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) throw new Error('manifest: bad id')
  if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) throw new Error('manifest: bad version')
  if (manifest.apiVersion !== 1) throw new Error('manifest: unsupported apiVersion')

  if (typeof manifest.entry !== 'string' || !manifest.entry) throw new Error('manifest: bad entry')
  const entry = manifest.entry.replace(/\\/g, '/')
  if (path.isAbsolute(manifest.entry) || /^[a-zA-Z]:/.test(entry) || entry.startsWith('/')) {
    throw new Error('manifest: entry must be relative')
  }
  if (entry.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('manifest: entry escapes plugin dir')
  }
  if (!/\.(js|cjs)$/.test(entry)) throw new Error('manifest: entry must be .js or .cjs')

  if (!Array.isArray(manifest.capabilities)) throw new Error('manifest: capabilities must be an array')
  for (const cap of manifest.capabilities) {
    if (typeof cap !== 'string' || !CAPABILITIES.includes(cap)) throw new Error(`manifest: unknown capability "${cap}"`)
  }
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) throw new Error('manifest: duplicate capability')

  if (manifest.selftest !== undefined) {
    if (!manifest.selftest || typeof manifest.selftest !== 'object' || Array.isArray(manifest.selftest)) throw new Error('manifest: bad selftest')
    if (typeof manifest.selftest.method !== 'string' || !manifest.selftest.method) throw new Error('manifest: bad selftest method')
    for (const key of Object.keys(manifest.selftest)) {
      if (key !== 'method') throw new Error(`manifest: unknown selftest key "${key}"`)
    }
  }
  if (manifest.ui !== undefined) {
    if (!manifest.ui || typeof manifest.ui !== 'object' || Array.isArray(manifest.ui)) throw new Error('manifest: bad ui')
    if (typeof manifest.ui.title !== 'string' || !manifest.ui.title) throw new Error('manifest: bad ui title')
    for (const key of Object.keys(manifest.ui)) {
      if (key !== 'title') throw new Error(`manifest: unknown ui key "${key}"`)
    }
  }
  if (manifest.signature !== undefined) {
    if (typeof manifest.signature !== 'string' || !SIGNATURE_RE.test(manifest.signature)) throw new Error('manifest: bad signature')
    if (Buffer.from(manifest.signature, 'base64').length !== 64) throw new Error('manifest: bad signature length')
  }
  return manifest
}

function loadManifest(pluginDir) {
  let raw
  try {
    raw = fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')
  } catch (error) {
    throw new Error(`manifest: cannot read plugin.json (${error.code || error.message})`)
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    throw new Error('manifest: invalid JSON')
  }
  return validateManifest(manifest)
}

function listFiles(root, dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listFiles(root, full, out)
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'))
  }
  return out
}

// sha256 over sorted "<relativePath>\0<sha256(file)>\n" lines; plugin.json and
// signature.json are metadata and stay out of the tree hash.
function treeHash(pluginDir) {
  const hash = crypto.createHash('sha256')
  for (const rel of listFiles(pluginDir, pluginDir, []).sort()) {
    if (rel === 'plugin.json' || rel === 'signature.json') continue
    const fileDigest = crypto.createHash('sha256').update(fs.readFileSync(path.join(pluginDir, rel))).digest('hex')
    hash.update(`${rel}\0${fileDigest}\n`)
  }
  return hash.digest('hex')
}

module.exports = { CAPABILITIES, validateManifest, loadManifest, treeHash }
