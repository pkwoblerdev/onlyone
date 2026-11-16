'use strict'
const path = require('node:path'), { createHash } = require('node:crypto')
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const MAX_BYTES = 2 * 1024 * 1024

function create ({ fs, rootOf, resolveFile, display, locked, decodeBackup, active }) {
  async function manifest (root) {
    if ((await fs.stat(path.join(root, 'manifest.json'))).size > MAX_BYTES) throw Error('large manifest')
    const data = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'))
    if (!Array.isArray(data?.entries) || data.entries.length > 4096) throw Error('invalid manifest')
    const files = new Map()
    for (const entry of data.entries) {
      if (!entry || entry.undone || typeof entry.file !== 'string') continue
      if (!files.has(entry.file)) files.set(entry.file, [])
      files.get(entry.file).push(entry)
    }
    return files
  }
  async function textFile (target) {
    try {
      if ((await fs.stat(target)).size > MAX_BYTES) throw Error('file too large')
      const bytes = await fs.readFile(target)
      if (bytes.length > MAX_BYTES || bytes.includes(0)) throw Error('unsupported file')
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  async function row (requestId, file, entries, includeContents = false) {
    const first = entries[0], last = entries.at(-1)
    const result = { requestId, fileId: digest(file), file: '', edits: entries.length, action: first.action, status: 'unavailable' }
    try {
      const target = await resolveFile(file)
      result.file = display(target)
      if (entries.some(entry => !['created', 'updated'].includes(entry.action)) || !/^[a-f0-9]{64}$/.test(last.wrote || '')) return result
      const current = await textFile(target)
      result.status = active(requestId) ? 'busy' :
        (current === null ? last.action === 'created' : digest(current) === last.wrote) ? 'ready' : 'conflict'
      if (includeContents) {
        let previous = null
        if (first.action === 'updated') {
          if (!/^[a-f0-9]{16}\.bak$/.test(first.backup || '')) throw Error('invalid backup')
          const root = rootOf(requestId), backup = path.join(root, first.backup)
          if ((await fs.stat(backup)).size > MAX_BYTES * 2) throw Error('large backup')
          previous = decodeBackup(await fs.readFile(backup, 'utf8'))
          if (typeof previous !== 'string') throw Error('unreadable backup')
          if (first.before !== undefined && (!/^[a-f0-9]{64}$/.test(first.before) || digest(previous) !== first.before)) throw Error('corrupted backup')
        }
        result.before = previous === null ? null : previous.slice(0, 64000)
        result.after = current === null ? null : current.slice(0, 64000)
        result.truncated = (previous?.length || 0) > 64000 || (current?.length || 0) > 64000
      }
    } catch { result.status = 'unavailable' }
    return result
  }
  async function read (input) {
    if (!Array.isArray(input?.requestIds) || input.requestIds.length > 64 || !input.requestIds.every(id)) return { ok: false, code: 'invalid' }
    const files = [], missing = []
    let truncated = false
    for (const requestId of [...new Set(input.requestIds)]) {
      try {
        const root = rootOf(requestId)
        await locked(root, async () => {
          for (const [file, entries] of await manifest(root)) {
            if (files.length === 256) { truncated = true; break }
            files.push(await row(requestId, file, entries))
          }
        })
      } catch { missing.push(requestId) }
    }
    return { ok: true, files, missing, truncated }
  }
  async function preview (input) {
    if (!id(input?.requestId) || !/^[a-f0-9]{64}$/.test(input?.fileId || '')) return { ok: false, code: 'invalid' }
    try {
      const root = rootOf(input.requestId)
      return await locked(root, async () => {
        for (const [file, entries] of await manifest(root)) {
          if (digest(file) !== input.fileId) continue
          return { ok: true, ...await row(input.requestId, file, entries, true) }
        }
        return { ok: false, code: 'missing' }
      })
    } catch { return { ok: false, code: 'unavailable' } }
  }
  return { read, preview }
}
module.exports = { create }
