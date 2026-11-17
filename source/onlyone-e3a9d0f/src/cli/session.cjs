'use strict'
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const owned = new Set()
function regular (file, limit) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('invalid CLI settings file')
  return fs.readFileSync(file)
}
function createJob ({ sourceProfile, folder, request, allowWrite }) {
  const source = path.resolve(sourceProfile), settings = regular(path.join(source, '1code-settings.json'), 32 * 1024 * 1024)
  let parsed
  try { parsed = JSON.parse(settings.toString('utf8')) } catch { throw Error('invalid CLI settings JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('invalid CLI settings object')
  const localState = path.join(source, 'Local State')
  const key = fs.existsSync(localState) ? regular(localState, 8 * 1024 * 1024) : null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-cli-'))
  owned.add(path.resolve(dir))
  try {
    fs.mkdirSync(path.join(dir, 'profile'), { mode: 0o700 })
    fs.writeFileSync(path.join(dir, 'profile', '1code-settings.json'), settings, { flag: 'wx', mode: 0o600 })
    if (key) fs.writeFileSync(path.join(dir, 'profile', 'Local State'), key, { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ version: 1, request, folder: path.resolve(folder), allowWrite, parentPid: process.pid }), { flag: 'wx', mode: 0o600 })
    readJob(dir)
    return { dir }
  } catch (error) { cleanup(dir); throw error }
}
function readJob (input) {
  const dir = path.resolve(input)
  if (path.dirname(dir).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !/^onlyone-cli-[a-z0-9]+$/i.test(path.basename(dir))) throw Error('invalid CLI session directory')
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('invalid CLI session directory')
  let job
  try { job = JSON.parse(regular(path.join(dir, 'job.json'), 128 * 1024).toString('utf8')) } catch { throw Error('invalid CLI job') }
  if (!job || Object.keys(job).sort().join(',') !== 'allowWrite,folder,parentPid,request,version' || job.version !== 1 ||
      !Number.isSafeInteger(job.parentPid) || job.parentPid <= 0 ||
      typeof job.request !== 'string' || !job.request.trim() || job.request.length > 65536 ||
      typeof job.allowWrite !== 'boolean' || typeof job.folder !== 'string' || !path.isAbsolute(job.folder) || !fs.statSync(job.folder).isDirectory()) throw Error('invalid CLI job')
  const profile = fs.lstatSync(path.join(dir, 'profile'))
  if (!profile.isDirectory() || profile.isSymbolicLink()) throw Error('invalid CLI session profile')
  return job
}
function cleanup (dir) {
  const target = path.resolve(dir)
  if (!owned.has(target)) throw Error('CLI cleanup requires an owned session')
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw Error('CLI session was replaced')
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
  owned.delete(target)
}

function pidAlive (pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

// Жёсткое завершение (taskkill /F, падение) не даёт лаунчеру убрать свой
// временный профиль. Старые сессии с мёртвым родителем убираются при старте,
// а живые и свежие не трогаются; каталог сверяется по имени и типу.
function cleanupStale (options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 6 * 60 * 60 * 1000
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const alive = typeof options.alive === 'function' ? options.alive : pidAlive
  const tmp = os.tmpdir()
  let removed = 0
  for (const name of fs.readdirSync(tmp)) {
    if (!/^onlyone-cli-[a-z0-9]+$/i.test(name)) continue
    const dir = path.join(tmp, name)
    let stat
    try { stat = fs.lstatSync(dir) } catch { continue }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    if (now - stat.mtimeMs < ttlMs) continue
    let parentPid = 0
    try { parentPid = JSON.parse(regular(path.join(dir, 'job.json'), 128 * 1024).toString('utf8')).parentPid } catch {}
    if (Number.isSafeInteger(parentPid) && parentPid > 0 && alive(parentPid)) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
      removed++
    } catch {}
  }
  return { removed }
}

module.exports = { createJob, readJob, cleanup, cleanupStale }
