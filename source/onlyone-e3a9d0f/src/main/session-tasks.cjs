'use strict'

// Незакрытое с прошлых сообщений диалога. Чек-листы и доска живут один ход и умирают вместе с ним, а человек пишет
// следующее сообщение и ждёт, что агент помнит, что осталось. Переносится только незакрытое, на диск (переживает
// перезапуск), коротко и с пометкой, что это записи самого агента: перед тем как на них опереться, их надо проверить.
const { tr } = require('./ui-text.cjs')
const fs = require('node:fs')
const path = require('node:path')

const MAX_ITEMS = 10
const MAX_BLOCK = 900
const MAX_CHATS = 60
const TITLE_MAX = 120
const NOTE_MAX = 80

const STATUS_WORD = { todo: 'не начато', open: 'не начато', doing: 'в работе', blocked: 'заблокировано', disputed: 'оспорено' }

const clip = (text, max) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max)

// plans — списки task_plan всех агентов хода; board — пункты доски команды. Закрытое (done) не переносится.
function collectOpen({ plans = [], board = [] } = {}) {
  const out = []
  for (const plan of Array.isArray(plans) ? plans : []) {
    for (const item of Array.isArray(plan) ? plan : []) {
      if (!item || item.status === 'done' || !clip(item.title, 1)) continue
      out.push({ title: clip(item.title, TITLE_MAX), status: item.status || 'todo', owner: '', note: clip(item.detail, NOTE_MAX) })
    }
  }
  for (const item of Array.isArray(board) ? board : []) {
    if (!item || item.status === 'done') continue
    const title = clip(item.title || item.task, TITLE_MAX)
    if (!title) continue
    out.push({ title, status: item.status || 'open', owner: clip(item.agent, 40), note: clip(item.note, NOTE_MAX) })
  }
  return out.slice(0, MAX_ITEMS)
}

function renderCarryover(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS)
  if (!list.length) return ''
  const head = '\n\n## Не закрыто с прошлых сообщений этого диалога\n\n' +
    'Записи самого агента с прошлого хода, а не проверенный факт: перед тем как опереться, проверь, что осталось верным. Закрытое сюда не попадает.\n'
  const lines = []
  let size = head.length
  for (const item of list) {
    const word = STATUS_WORD[item.status] || item.status || 'не начато'
    const line = `- [${word}] ${item.title}${item.owner ? ` (${item.owner})` : ''}${item.note ? ` — ${item.note}` : ''}`
    if (size + line.length + 1 > MAX_BLOCK) break
    lines.push(line)
    size += line.length + 1
  }
  return lines.length ? head + lines.join('\n') : ''
}

// Файл: { "<chatId>": { at, items: [...] } }. Старые диалоги вытесняются по времени записи.
function createSessionTaskStore(file, { protect, unprotect, onError = () => {}, fs: disk = fs } = {}) {
  const report = error => { try { onError(error) } catch {} }

  function renameWithRetrySync(src, dst, maxAttempts = 6) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        disk.renameSync(src, dst)
        return
      } catch (error) {
        const code = error && error.code
        const isLocked = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        if (!isLocked || attempt === maxAttempts) throw error
        const delayMs = attempt * 15
        const start = Date.now()
        while (Date.now() - start < delayMs) { /* sync wait on lock */ }
      }
    }
  }

  function read() {
    let raw
    try {
      raw = disk.readFileSync(file, 'utf8')
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
    } catch (error) {
      if (error.code === 'ENOENT') return { data: {} }
      report(error)
      return { data: {}, blocked: true }
    }
    let parsed
    try { parsed = JSON.parse(raw) } catch { return { data: {}, corrupt: true } }
    if (parsed?.enc === 'safeStorage') {
      try {
        if (!unprotect || typeof parsed.data !== 'string') throw new Error(tr('Расшифровка незакрытых задач недоступна.'))
        parsed = JSON.parse(unprotect(parsed.data))
      } catch (error) {
        report(error)
        try {
          const target = file + '.corrupt-key-' + require('node:crypto').randomUUID()
          disk.writeFileSync(target, raw, 'utf8')
        } catch {}
        return { data: {}, blocked: true }
      }
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && protect) {
      write(parsed)
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { data: parsed } : { data: {}, corrupt: true }
  }
  function write(data) {
    const tmp = `${file}.${require('node:crypto').randomUUID()}.tmp`
    try {
      const text = JSON.stringify(data)
      const content = protect ? JSON.stringify({ enc: 'safeStorage', data: protect(text) }) : text
      disk.mkdirSync(path.dirname(file), { recursive: true })
      disk.writeFileSync(tmp, content)
      renameWithRetrySync(tmp, file)
      return true
    } catch (error) {
      try { disk.rmSync(tmp, { force: true }) } catch {}
      report(error)
      return false
    }
  }
  return {
    get(chatId) {
      const entry = read().data[String(chatId || '')]
      return entry && Array.isArray(entry.items) ? entry.items : []
    },
    set(chatId, items) {
      const key = String(chatId || '')
      if (!key) return
      const found = read()
      if (found.blocked) return false
      if (found.corrupt) {
        // Never replace unreadable history unless its original bytes are preserved.
        try {
          const target = `${file}.corrupt-${Date.now()}-${require('node:crypto').randomUUID().slice(0, 8)}`
          if (protect) {
            const payload = JSON.stringify({ enc: 'safeStorage', data: protect(disk.readFileSync(file).toString('base64')), b64: true })
            disk.writeFileSync(target, payload, { flag: 'wx' })
          } else disk.copyFileSync(file, target)
        }
        catch (error) { report(error); return false }
      }
      const data = found.data
      const list = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS)
      if (list.length) data[key] = { at: Date.now(), seq: Object.keys(data).length, items: list }
      else delete data[key]
      const keys = Object.keys(data)
      if (keys.length > MAX_CHATS) {
        keys.sort((a, b) => (data[a].at - data[b].at) || (data[a].seq - data[b].seq))
        for (const old of keys.slice(0, keys.length - MAX_CHATS)) delete data[old]
      }
      return write(data)
    }
  }
}

module.exports = { MAX_ITEMS, MAX_BLOCK, collectOpen, renderCarryover, createSessionTaskStore }
