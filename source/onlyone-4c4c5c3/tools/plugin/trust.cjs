'use strict'
// Per-profile trust store for plugin signing keys (trust.json in the profile).
// Only ed25519 keys are accepted. The store holds public keys; the private (owner)
// key is never created, read or printed by this tool.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const STORE_NAME = 'trust.json'

function storePath (profileDir) {
  if (!profileDir || typeof profileDir !== 'string') throw new Error('trust: profileDir is required')
  return path.join(profileDir, STORE_NAME)
}

// sha256 over the SPKI DER of the key; stable across PEM formatting differences.
function fingerprint (publicKey) {
  let key
  try {
    key = crypto.createPublicKey(publicKey)
  } catch {
    throw new Error('trust: bad public key')
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('trust: key must be ed25519')
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
}

// What a person reads and types: the first 16 hex of the fingerprint. The store
// keeps the full one; prefixes are resolved back to it before anything is removed.
function shortFingerprint (print) {
  if (typeof print !== 'string' || !print) throw new Error('trust: fingerprint is required')
  return print.slice(0, 16)
}

function readStore (profileDir) {
  let raw
  try {
    raw = fs.readFileSync(storePath(profileDir), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { keys: [] }
    throw new Error('trust: cannot read trust.json (' + (error.code || error.message) + ')')
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('trust: corrupt trust.json')
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.keys)) throw new Error('trust: corrupt trust.json')
  for (const entry of parsed.keys) {
    if (!entry || typeof entry.publicKey !== 'string') throw new Error('trust: corrupt trust.json')
    if (entry.fingerprint !== fingerprint(entry.publicKey)) throw new Error('trust: corrupt trust.json (fingerprint mismatch)')
  }
  return parsed
}

function writeStore (profileDir, store) {
  fs.mkdirSync(profileDir, { recursive: true })
  const file = storePath(profileDir)
  const temp = file + '.tmp'
  fs.writeFileSync(temp, JSON.stringify({ keys: store.keys }, null, 2) + '\n')
  fs.renameSync(temp, file)
}

function loadKeys (profileDir) {
  return readStore(profileDir).keys
    .map((entry) => ({ fingerprint: entry.fingerprint, publicKey: entry.publicKey }))
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))
}

function addKey (profileDir, publicKey) {
  const print = fingerprint(publicKey)
  const store = readStore(profileDir)
  const existing = store.keys.find((entry) => entry.fingerprint === print)
  if (existing) return { fingerprint: print, added: false }
  const key = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'pem' })
  store.keys.push({ fingerprint: print, publicKey: key })
  writeStore(profileDir, store)
  return { fingerprint: print, added: true }
}

// Accepts the full fingerprint, its 16-hex short form or any unique prefix.
// Unknown input comes back as is, so removeKey still says "unknown fingerprint".
function resolveFingerprint (profileDir, wanted) {
  if (typeof wanted !== 'string' || !wanted) throw new Error('trust: fingerprint is required')
  const matches = loadKeys(profileDir)
    .map((entry) => entry.fingerprint)
    .filter((print) => print === wanted || print.startsWith(wanted))
  if (matches.length > 1) throw new Error('trust: ambiguous fingerprint: ' + wanted)
  return matches.length === 1 ? matches[0] : wanted
}

function removeKey (profileDir, print) {
  if (typeof print !== 'string' || !print) throw new Error('trust: fingerprint is required')
  const store = readStore(profileDir)
  const before = store.keys.length
  store.keys = store.keys.filter((entry) => entry.fingerprint !== print)
  if (store.keys.length === before) throw new Error('trust: unknown fingerprint: ' + print)
  writeStore(profileDir, store)
  return { fingerprint: print, removed: true }
}

// { ok:true, fingerprint } when any key matches; { ok:false, reason } otherwise.
// The signature is ed25519 over the UTF-8 tree hash, base64 in signature.json
// (older plugins carry it in plugin.json; install accepts both).
function verifySignature (treeHash, signatureBase64, keys) {
  if (typeof treeHash !== 'string' || !treeHash) return { ok: false, reason: 'trust: tree hash is required' }
  if (typeof signatureBase64 !== 'string' || !signatureBase64) return { ok: false, reason: 'trust: signature is required' }
  const signature = Buffer.from(signatureBase64, 'base64')
  if (signature.length !== 64) return { ok: false, reason: 'trust: bad signature length' }
  for (const entry of Array.isArray(keys) ? keys : []) {
    if (!entry || typeof entry.publicKey !== 'string') continue
    let key
    try {
      key = crypto.createPublicKey(entry.publicKey)
    } catch {
      continue
    }
    try {
      if (crypto.verify(null, Buffer.from(treeHash, 'utf8'), key, signature)) {
        return { ok: true, fingerprint: entry.fingerprint || fingerprint(entry.publicKey) }
      }
    } catch {
      continue
    }
  }
  return { ok: false, reason: 'trust: no trusted key matches the signature' }
}

module.exports = { STORE_NAME, storePath, fingerprint, shortFingerprint, loadKeys, addKey, resolveFingerprint, removeKey, verifySignature }
