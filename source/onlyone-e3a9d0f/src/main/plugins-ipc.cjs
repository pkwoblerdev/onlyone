'use strict'
// OS-5: раздел «Плагины» — окно разговаривает с профилем только здесь.
//
// Установка и запись record.json — в tools/plugin/install.cjs, проверка манифеста
// и хеша дерева — в tools/plugin/manifest.cjs; этот модуль их не повторяет, а
// зовёт и добавляет то, чего у них нет: список для окна (статус, запрошенные и
// выданные права, установленные версии) и журнал действий.
//
// Журнал — JSONL рядом с каталогами плагинов (profile/plugins/journal.jsonl),
// только дописывание: одна строка — одно действие {time, action, plugin, version,
// result}. Чужие, оборванные и незнакомые строки пропускаются: журнал читают,
// чтобы человек увидел, что происходило, а не чтобы разбор падал.
const fs = require('node:fs')
const path = require('node:path')
const install = require('../../tools/plugin/install.cjs')
const { loadManifest, treeHash } = require('../../tools/plugin/manifest.cjs')

const JOURNAL = 'journal.jsonl'
const JOURNAL_LIMIT = 200
const JOURNAL_TAIL = 256 * 1024
const VERSION_RE = /^\d+\.\d+\.\d+$/

const pluginsRoot = profileDir => path.join(profileDir, 'plugins')

function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
}

function appendJournal(profileDir, now, action, plugin, version, result) {
  const file = path.join(pluginsRoot(profileDir), JOURNAL)
  const entry = {
    time: new Date(now()).toISOString(),
    action,
    plugin: cleanText(plugin, 64),
    version: cleanText(version, 32),
    result: cleanText(result, 40)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(entry) + '\n')
}

// Only the tail is read: a journal left running for a year is not a reason to
// load the whole file into memory. A cut first line simply fails JSON.parse.
function readTail(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - JOURNAL_TAIL)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return ''
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

// Newest first: the window shows the last thing that happened on top.
function readJournal(profileDir, limit = JOURNAL_LIMIT) {
  const rows = []
  for (const line of readTail(path.join(pluginsRoot(profileDir), JOURNAL)).split('\n')) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const action = cleanText(raw.action, 40)
    if (!action) continue
    rows.push({
      time: cleanText(raw.time, 40),
      action,
      plugin: cleanText(raw.plugin ?? raw.id, 64),
      version: cleanText(raw.version, 32),
      result: cleanText(raw.result ?? raw.ok, 40)
    })
  }
  return rows.slice(-limit).reverse()
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

function versionsOf(profileDir, id) {
  const dir = path.join(pluginsRoot(profileDir), id)
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter(entry => entry.isDirectory() && VERSION_RE.test(entry.name))
    .map(entry => entry.name)
    .filter(version => fs.existsSync(path.join(dir, version, 'plugin.json')))
    .sort(compareVersions)
}

// Status is decided from the files, not from the record alone: a plugin whose
// tree no longer matches the installed hash must not be run, whatever record.json
// says. Quarantine is the state the window shows in red.
function describe(profileDir, record) {
  const dir = path.resolve(profileDir, record.dir || '')
  const granted = Array.isArray(record.grants) ? record.grants.slice() : []
  let requested = []
  let status = ''
  let reason = ''
  try {
    const manifest = loadManifest(dir)
    requested = manifest.capabilities.slice()
    if (treeHash(dir) !== record.hash) {
      status = 'quarantined'
      reason = 'tampered'
    }
  } catch {
    status = 'quarantined'
    reason = 'missing'
  }
  if (!status) status = record.disabled ? 'disabled' : 'enabled'
  return {
    id: record.id,
    version: record.version,
    versions: versionsOf(profileDir, record.id),
    status,
    reason,
    requested,
    granted,
    pending: requested.filter(cap => !granted.includes(cap))
  }
}

function codeOf(error) {
  if (error && (error.code === 'approval-required' || error.code === 'profile-unavailable')) return error.code
  const message = String(error?.message || error || '')
  if (/bad id|bad version|invalid/i.test(message)) return 'invalid'
  if (/not installed|not found/i.test(message)) return 'missing'
  if (/hash mismatch|signature|manifest/i.test(message)) return 'quarantined'
  return 'action-failed'
}

function createPlugins({ profileDir, now = Date.now } = {}) {
  const dirOf = typeof profileDir === 'function' ? profileDir : () => profileDir
  function profile() {
    const dir = dirOf()
    if (!dir) throw Object.assign(new Error('plugins: profile is not ready'), { code: 'profile-unavailable' })
    return dir
  }

  function list() {
    const dir = profile()
    return {
      ok: true,
      plugins: install.listPlugins(dir).map(record => describe(dir, record)),
      journal: readJournal(dir)
    }
  }

  // Every action goes through one path so the journal cannot forget a step:
  // the result is written after the work, success or failure alike.
  function run(action, input, work) {
    const dir = profile()
    const id = typeof input?.id === 'string' ? input.id : ''
    const asked = typeof input?.version === 'string' ? input.version : ''
    try {
      const result = work(dir, id, asked)
      const version = typeof result?.version === 'string' ? result.version : asked
      appendJournal(dir, now, action, id, version, 'ok')
      return { ok: true, id, version }
    } catch (error) {
      const code = codeOf(error)
      appendJournal(dir, now, action, id, asked, code)
      return { ok: false, code }
    }
  }

  function recordOf(dir, id) {
    const record = install.listPlugins(dir).find(item => item.id === id)
    if (!record) throw new Error(`plugin: not installed: ${id}`)
    return record
  }

  return {
    list,
    approve: input => run('approve', input, (dir, id) => install.approvePlugin(dir, id)),
    disable: input => run('disable', input, (dir, id) => install.disablePlugin(dir, id)),
    // Включить обратно можно только то, что уже разрешено: новая версия с более
    // широкими правами проходит через «Разрешить», иначе согласие выдавалось бы
    // молча кнопкой «Подключить».
    enable: input => run('enable', input, (dir, id) => {
      const record = recordOf(dir, id)
      const manifest = loadManifest(path.resolve(dir, record.dir))
      const granted = Array.isArray(record.grants) ? record.grants : []
      if (!manifest.capabilities.every(cap => granted.includes(cap))) {
        throw Object.assign(new Error('plugins: approval required'), { code: 'approval-required' })
      }
      return install.approvePlugin(dir, id)
    }),
    rollback: input => run('rollback', input, (dir, id, version) => install.rollbackPlugin(dir, id, version)),
    // removePlugin возвращает только признак удаления; версию берём до него —
    // журнал должен помнить, что именно убрали.
    remove: input => run('remove', input, (dir, id) => {
      const record = recordOf(dir, id)
      return { ...install.removePlugin(dir, id), version: record.version }
    })
  }
}

// Только главное окно: плагины меняют права и файлы профиля, и ни панель
// браузера, ни удалённое управление этого не делают.
function register({ ipcMain, isMain, profileDir, now = Date.now }) {
  const plugins = createPlugins({ profileDir, now })
  const guarded = (name, fn) => ipcMain.handle(name, async (event, input) => {
    if (!isMain(event)) return { ok: false, code: 'forbidden' }
    try { return await fn(input && typeof input === 'object' ? input : {}) } catch { return { ok: false, code: 'storage-unavailable' } }
  })
  guarded('plugins:list', () => plugins.list())
  guarded('plugins:approve', input => plugins.approve(input))
  guarded('plugins:disable', input => plugins.disable(input))
  guarded('plugins:enable', input => plugins.enable(input))
  guarded('plugins:rollback', input => plugins.rollback(input))
  guarded('plugins:remove', input => plugins.remove(input))
  return plugins
}

module.exports = { createPlugins, register, readJournal, describe, JOURNAL }
