'use strict'
// Уборка временных профилей CLI: жёсткое завершение (taskkill /F, падение)
// оставляет onlyone-cli-*; при старте убираются только старые сессии с мёртвым
// родителем, живые и свежие не трогаются.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { cleanupStale } = require('../src/cli/session.cjs')

const tmp = os.tmpdir()
const made = []
const make = (name, parentPid, ageMs) => {
  const dir = path.join(tmp, name)
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ version: 1, parentPid, request: 'x', folder: tmp, allowWrite: false }))
  const at = new Date(Date.now() - ageMs)
  fs.utimesSync(dir, at, at)
  made.push(dir)
  return dir
}
const suffix = String(process.pid) + String(Date.now()).slice(-6)
const stale = make('onlyone-cli-t' + suffix + 'a', 999999, 2 * 60 * 60 * 1000)
const live = make('onlyone-cli-t' + suffix + 'b', process.pid, 2 * 60 * 60 * 1000)
const fresh = make('onlyone-cli-t' + suffix + 'c', 999999, 60 * 1000)

try {
  const result = cleanupStale({ ttlMs: 10 * 60 * 1000, alive: pid => pid === process.pid })
  assert.ok(result.removed >= 1, 'removes the old sessions with a dead parent')
  assert.equal(fs.existsSync(stale), false, 'stale session is gone')
  assert.equal(fs.existsSync(live), true, 'session with a live parent stays')
  assert.equal(fs.existsSync(fresh), true, 'fresh session stays even with a dead parent')
  console.log('PASS CLI session cleanup: stale dead-parent profiles removed, live and fresh kept')
} finally {
  for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
}
