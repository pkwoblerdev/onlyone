'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { validateSnapshot } = require('./desk-model.cjs')

// Two kinds of failure, kept apart: damage (bytes this profile can never read)
// and unavailability (try again later). Only damage may be archived and reset.
const damaged = () => Object.assign(Error('Desk layout is damaged'), { code: 'desk-store-damaged' })
const unavailable = () => Object.assign(Error('Desk encryption unavailable'), { code: 'desk-encryption-unavailable' })

function createDeskStore ({ dir, protect, unprotect }) {
  const file = chatId => {
    if (typeof chatId !== 'string' || !chatId || chatId.length > 200 || /[\u0000-\u001f]/.test(chatId) || ['__proto__', 'constructor', 'prototype'].includes(chatId)) throw Error('Invalid chat')
    return path.join(dir, createHash('sha256').update(chatId).digest('hex') + '.json')
  }
  function load (chatId) {
    const target = file(chatId)
    let bytes
    try {
      if (fs.statSync(target).size > 1024 * 1024) throw damaged()
      bytes = fs.readFileSync(target, 'utf8')
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    let envelope
    try { envelope = JSON.parse(bytes) } catch { throw damaged() }
    if (!envelope || envelope.enc !== 'safeStorage' || typeof envelope.data !== 'string' || Object.prototype.hasOwnProperty.call(envelope, '__proto__')) throw damaged()
    if (!unprotect) throw unavailable()
    let text
    try { text = unprotect(envelope.data) } catch (error) { if (error?.code === 'desk-encryption-unavailable') throw error; throw damaged() }
    let value
    try { value = JSON.parse(text) } catch { throw damaged() }
    if (value?.chatId !== chatId || Object.prototype.hasOwnProperty.call(value, '__proto__')) throw damaged()
    try { return validateSnapshot(value.snapshot) } catch { throw damaged() }
  }
  // A byte copy beside the original, named by its content: the same damaged file
  // is archived once however often the Desk is opened, and the original is the
  // copy — nothing is overwritten.
  function archive (chatId) {
    const target = file(chatId)
    const bytes = fs.readFileSync(target)
    const aside = path.join(dir, path.basename(target, '.json') + '.damaged-' + createHash('sha256').update(bytes).digest('hex').slice(0, 12) + '.json')
    try { fs.writeFileSync(aside, bytes, { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST' || !fs.readFileSync(aside).equals(bytes)) throw error }
    fs.unlinkSync(target)
    return path.basename(aside)
  }
  function save (chatId, snapshot) {
    const target = file(chatId)
    const value = validateSnapshot(snapshot)
    if (!protect) throw unavailable()
    const data = protect(JSON.stringify({ chatId, snapshot: value }))
    if (typeof data !== 'string' || !data) throw Error('Desk encryption failed')
    const bytes = JSON.stringify({ enc: 'safeStorage', data })
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw Error('Desk file exceeds limit')
    fs.mkdirSync(dir, { recursive: true })
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, target)
    } finally {
      try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return Object.freeze({ load, save, archive })
}
module.exports = { createDeskStore }
