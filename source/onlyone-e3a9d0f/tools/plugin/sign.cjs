'use strict'
// Sign a plugin directory with the owner's ed25519 private key. The key is read
// from a PEM file the owner passes in; this tool never creates, prints or stores
// it, and the private half stays offline.
//
// signature.json = { algorithm:'ed25519', keyFingerprint, signature }, where the
// signature is base64 ed25519 over the UTF-8 tree hash (manifest.cjs). The file is
// metadata: treeHash skips it, so signing does not change the hash it signs.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { loadManifest, treeHash } = require('./manifest.cjs')
const trust = require('./trust.cjs')

const SIG_NAME = 'signature.json'

function loadPrivateKey(keyFile) {
  let pem
  try {
    pem = fs.readFileSync(keyFile, 'utf8')
  } catch (error) {
    throw new Error('sign: cannot read --key file (' + (error.code || error.message) + ')')
  }
  let key
  try {
    key = crypto.createPrivateKey(pem)
  } catch {
    throw new Error('sign: bad private key')
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('sign: key must be ed25519')
  return key
}

function readManifestFile(pluginDir) {
  let raw
  try {
    raw = fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')
  } catch (error) {
    throw new Error('sign: cannot read plugin.json (' + (error.code || error.message) + ')')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('sign: invalid plugin.json')
  }
}

// Refuses to sign over a plugin.json that already claims something else: a `hash`
// field for another tree, or a legacy `signature` made for other content or by
// another key. Re-signing is fine only when the old claim still matches.
function checkExistingClaims(raw, hash, publicKey) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('sign: invalid plugin.json')
  if (raw.hash !== undefined && raw.hash !== hash) throw new Error('sign: plugin.json hash does not match the tree hash')
  if (raw.signature !== undefined) {
    const signature = Buffer.from(String(raw.signature), 'base64')
    let ok = false
    try {
      ok = signature.length === 64 && crypto.verify(null, Buffer.from(hash, 'utf8'), publicKey, signature)
    } catch {
      ok = false
    }
    if (!ok) throw new Error('sign: plugin.json signature does not match this tree and key')
  }
}

function signPlugin(pluginDir, keyFile) {
  if (!pluginDir || typeof pluginDir !== 'string') throw new Error('sign: plugin dir is required')
  if (!keyFile || typeof keyFile !== 'string') throw new Error('sign: --key <pem> is required (the owner private key stays offline)')
  const raw = readManifestFile(pluginDir)
  const hash = treeHash(pluginDir)
  const privateKey = loadPrivateKey(keyFile)
  const publicKey = crypto.createPublicKey(privateKey)
  checkExistingClaims(raw, hash, publicKey)
  const manifest = loadManifest(pluginDir)
  // fingerprint wants PEM/DER, not a KeyObject; the export carries the public half only.
  const keyFingerprint = trust.fingerprint(publicKey.export({ type: 'spki', format: 'pem' }))
  const signature = crypto.sign(null, Buffer.from(hash, 'utf8'), privateKey).toString('base64')
  fs.writeFileSync(path.join(pluginDir, SIG_NAME),
    JSON.stringify({ algorithm: 'ed25519', keyFingerprint, signature }, null, 2) + '\n')
  return { ok: true, id: manifest.id, version: manifest.version, hash, keyFingerprint, signature }
}

module.exports = { SIG_NAME, signPlugin }
