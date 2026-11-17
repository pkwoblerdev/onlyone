'use strict'

// Участки обзора изменений: файл, отдельная правка (фрагмент) и выполненная
// команда. История одна — тот же manifest.json и те же .bak в
// userData/undo/<requestId>, что у общего обзора. Модуль только читает их и
// возвращает в тот же журнал, второй копии истории не появляется.
//
// Команду нельзя откатить по одному факту её выполнения: перед запуском
// снимается ограниченный снимок рабочих папок, после — сравнивается. Изменённые
// текстовые файлы становятся обычными записями manifest с commandId, поэтому их
// видит и общий откат файла; двоичные и слишком большие файлы честно помечаются
// «снимка нет» и не откатываются.
//
// Откат всегда сверяет отпечаток результата с текущим файлом. Более поздняя
// работа не затирается: участок пропускается с понятной причиной, остальные
// выбранные участки откатываются. Фрагмент возвращается только если его
// результат ещё однозначно находится в файле; иначе — конфликт, файл не тронут.

const path = require('node:path')
const { createHash, randomBytes } = require('node:crypto')

const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
const SHA = /^[a-f0-9]{64}$/
const BACKUP = /^[a-f0-9]{16}\.bak$/
const hash = value => createHash('sha256').update(value).digest('hex')

const MAX_MANIFEST = 4 * 1024 * 1024
const MAX_ENTRIES = 10000
const MAX_COMMANDS = 1024
const MAX_FILE = 2 * 1024 * 1024
const MAX_PREVIEW = 64000
const MAX_SECTIONS = 256
const MAX_SELECTION = 64
const MAX_COMMAND_FILES = 512
const CAPTURE = Object.freeze({ files: 8000, bytes: 64 * 1024 * 1024, file: 512 * 1024, depth: 16 })
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'coverage'])

function describeFailure (error) {
  const code = error?.code
  const message = String(error?.message || '')
  if (code === 'EACCES' || code === 'EPERM') return 'Нет прав на запись: файл защищён или открыт другой программой.'
  if (code === 'EBUSY') return 'Файл занят другой программой.'
  if (code === 'ENOSPC') return 'На диске не хватает места.'
  if (code === 'EROFS') return 'Папка доступна только для чтения.'
  if (code === 'ENOENT') return 'Файл или его папка исчезли во время отката.'
  if (['corrupted backup', 'unreadable backup', 'invalid backup', 'large backup'].includes(message)) return 'Снимок повреждён или не читается — файл не изменён.'
  if (message === 'fingerprint') return 'В снимке нет отпечатка результата — выборочный откат недоступен.'
  if (message === 'unreadable file') return 'Файл не читается как текст — откат отменён.'
  // Охрана путей уже говорит по-русски и по делу; не подменять её общим текстом.
  if (/^(Доступ запрещён|Символическая ссылка|Рабочая папка|Сначала выберите)/.test(message)) return message
  return 'Не удалось записать файл.'
}

function clip (text) {
  return String(text).slice(0, MAX_PREVIEW)
}

// Текст читается байтами и декодируется без потери BOM: отпечаток должен
// совпадать с тем, что считает snapshotBeforeWrite в main.js.
function decode (bytes) {
  if (bytes.includes(0)) return null
  try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return null }
  return bytes.toString('utf8')
}

function parseSection (value) {
  let match
  if ((match = /^file:([a-f0-9]{64})$/.exec(String(value)))) return { kind: 'file', fileId: match[1] }
  if ((match = /^frag:([a-f0-9]{64}):(\d{1,6})$/.exec(String(value)))) return { kind: 'frag', fileId: match[1], index: Number(match[2]) }
  if ((match = /^cmd:([a-zA-Z0-9_-]{1,64})$/.exec(String(value)))) return { kind: 'cmd', commandId: match[1] }
  return null
}

function sectionIdOf (item) {
  return item.kind === 'file' ? `file:${item.fileId}`
    : item.kind === 'frag' ? `frag:${item.fileId}:${item.index}`
      : `cmd:${item.commandId}`
}

// Один средний участок: общий префикс и суффикс не трогаются, всё между ними —
// то, что изменила одна запись. Если более поздняя правка попала внутрь этого
// участка, он не найдётся и откат честно остановится.
function middle (beforeText, afterText) {
  const before = String(beforeText).split('\n')
  const after = String(afterText).split('\n')
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length - 1
  let endAfter = after.length - 1
  while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) {
    endBefore--
    endAfter--
  }
  return {
    before: before.slice(start, endBefore + 1),
    after: after.slice(start, endAfter + 1),
    prefix: before.slice(0, start),
    suffix: before.slice(endBefore + 1)
  }
}

function lineStats (beforeText, afterText) {
  if (typeof beforeText !== 'string') return { added: String(afterText || '').split('\n').length, removed: 0 }
  if (typeof afterText !== 'string') return { added: 0, removed: beforeText.split('\n').length }
  const part = middle(beforeText, afterText)
  return { added: part.after.length, removed: part.before.length }
}

function findSequence (lines, sequence) {
  const hits = []
  if (!sequence.length || sequence.length > lines.length) return hits
  // KMP по строкам: однородный файл (логи, CSV) больше не даёт O(n·m).
  const fail = new Array(sequence.length).fill(0)
  for (let i = 1, k = 0; i < sequence.length; i++) {
    while (k && sequence[i] !== sequence[k]) k = fail[k - 1]
    if (sequence[i] === sequence[k]) k++
    fail[i] = k
  }
  for (let i = 0, k = 0; i < lines.length; i++) {
    while (k && lines[i] !== sequence[k]) k = fail[k - 1]
    if (lines[i] === sequence[k]) k++
    if (k === sequence.length) {
      hits.push(i - sequence.length + 1)
      k = fail[k - 1]
    }
  }
  return hits
}

// Обратное применение одной правки к текущему тексту. Возвращает новый текст
// или причину, по которой участок нельзя вернуть без потери чужих строк.
function reverseFragment (currentText, beforeText, afterText) {
  const current = String(currentText)
  if (current === beforeText) return { ok: true, text: current, already: true }
  const part = middle(beforeText, afterText)
  const lines = current.split('\n')
  if (part.after.length) {
    const hits = findSequence(lines, part.after)
    if (hits.length !== 1) {
      return { ok: false, reason: hits.length
        ? 'Участок встречается в файле несколько раз — непонятно, какой возвращать.'
        : 'Более поздние правки изменили этот участок. Файл не тронут.' }
    }
    const at = hits[0]
    return { ok: true, text: [...lines.slice(0, at), ...part.before, ...lines.slice(at + part.after.length)].join('\n') }
  }
  // Чистая вставка: у after нет строк, место ищется по соседям.
  const beforeAnchor = part.prefix.slice(-3)
  const afterAnchor = part.suffix.slice(0, 3)
  if (!beforeAnchor.length && !afterAnchor.length) {
    if (current !== '') return { ok: false, reason: 'Файл больше не пуст — вставку нельзя вернуть однозначно.' }
    return { ok: true, text: part.before.join('\n') }
  }
  const hits = findSequence(lines, [...beforeAnchor, ...afterAnchor])
  if (hits.length !== 1) {
    return { ok: false, reason: 'Соседние строки изменились — вставку нельзя вернуть без потери правок.' }
  }
  const at = hits[0] + beforeAnchor.length
  return { ok: true, text: [...lines.slice(0, at), ...part.before, ...lines.slice(at)].join('\n') }
}

function create ({ fs, rootOf, resolveFile, display, locked, decodeBackup, encodeBackup = value => value, redact = value => value, active = () => false }) {
  async function loadManifest (root) {
    const file = path.join(root, 'manifest.json')
    const stat = await fs.stat(file)
    if (stat.size > MAX_MANIFEST) throw new Error('large manifest')
    const data = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!Array.isArray(data?.entries) || data.entries.length > MAX_ENTRIES) throw new Error('invalid manifest')
    if (data.commands !== undefined && (!Array.isArray(data.commands) || data.commands.length > MAX_COMMANDS)) throw new Error('invalid commands')
    return data
  }

  async function saveManifest (root, manifest) {
    const temporary = path.join(root, `${randomBytes(8).toString('hex')}.tmp`)
    try {
      await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8')
      await fs.rename(temporary, path.join(root, 'manifest.json'))
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }

  // Запись рядом с целью и rename: обрыв (ENOSPC, питание, падение) не усекает
  // файл, и mkdir возвращает каталог, удалённый командой.
  async function writeTarget (target, text) {
    const directory = path.dirname(target)
    await fs.mkdir(directory, { recursive: true })
    const temporary = path.join(directory, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await fs.writeFile(temporary, text, 'utf8')
      await fs.rename(temporary, target)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }

  async function textAt (target) {
    try {
      const stat = await fs.stat(target)
      if (!stat.isFile() || stat.size > MAX_FILE) return { status: 'unavailable' }
      const bytes = await fs.readFile(target)
      if (bytes.length > MAX_FILE) return { status: 'unavailable' }
      const text = decode(bytes)
      return text === null ? { status: 'unavailable' } : { status: 'ok', text }
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'missing' }
      return { status: 'unavailable' }
    }
  }

  async function readBackup (root, entry) {
    if (!BACKUP.test(entry.backup || '')) throw new Error('invalid backup')
    const file = path.join(root, entry.backup)
    const stat = await fs.stat(file)
    if (stat.size > MAX_FILE * 2) throw new Error('large backup')
    const previous = decodeBackup(await fs.readFile(file, 'utf8'))
    if (typeof previous !== 'string') throw new Error('unreadable backup')
    if (entry.before !== undefined && (!SHA.test(entry.before) || hash(previous) !== entry.before)) throw new Error('corrupted backup')
    return previous
  }

  async function currentText (target) {
    const current = await textAt(target)
    if (current.status === 'unavailable') throw new Error('unreadable file')
    return current.status === 'missing' ? null : current.text
  }

  async function fileSection (requestId, file, entries) {
    const result = { sectionId: `file:${hash(file)}`, kind: 'file', requestId, fileId: hash(file), file: '', edits: entries.length, fragments: entries.length, status: 'unavailable', at: Number(entries.at(-1)?.at) || 0 }
    try {
      const target = await resolveFile(file)
      result.file = display(target)
      if (active(requestId)) { result.status = 'busy'; return result }
      if (entries.some(entry => !['created', 'updated'].includes(entry.action) || !SHA.test(entry.wrote || ''))) return result
      const last = entries.at(-1)
      const current = await textAt(target)
      if (current.status === 'ok') result.status = hash(current.text) === last.wrote ? 'ready' : 'conflict'
      else if (current.status === 'missing') result.status = last.action === 'created' ? 'ready' : 'conflict'
    } catch { /* путь вне рабочей папки или снимок не читается */ }
    return result
  }

  async function commandFileState (requestId, file, entries) {
    const last = entries.at(-1)
    const result = { file: '', fileId: hash(file), action: last?.action || 'updated', status: 'unavailable' }
    try {
      const target = await resolveFile(file)
      result.file = display(target)
      if (last?.undone) { result.status = 'done'; return result }
      if (active(requestId)) { result.status = 'busy'; return result }
      const current = await textAt(target)
      if (last?.action === 'deleted') {
        result.status = current.status === 'missing' ? 'ready' : current.status === 'ok' ? 'conflict' : 'unavailable'
        return result
      }
      if (last?.action === 'created') {
        if (current.status === 'missing') result.status = 'ready'
        else if (current.status === 'ok' && SHA.test(last.wrote || '')) result.status = hash(current.text) === last.wrote ? 'ready' : 'conflict'
        return result
      }
      if (last?.action !== 'updated' || !SHA.test(last.wrote || '')) return result
      if (current.status === 'ok') result.status = hash(current.text) === last.wrote ? 'ready' : 'conflict'
      else if (current.status === 'missing') result.status = 'conflict'
    } catch { /* см. fileSection */ }
    return result
  }

  function combinedStatus (statuses) {
    if (!statuses.length) return 'empty'
    if (statuses.includes('busy')) return 'busy'
    const active = statuses.filter(status => status !== 'done')
    if (!active.length) return 'done'
    if (active.every(status => status === 'ready')) return active.length === statuses.length ? 'ready' : 'partial'
    if (active.includes('ready')) return 'partial'
    if (active.every(status => status === 'conflict')) return active.length === statuses.length ? 'conflict' : 'partial'
    return 'unavailable'
  }

  async function commandSection (requestId, command) {
    const files = (Array.isArray(command.files) ? command.files : []).filter(file => file && typeof file.file === 'string')
    const result = { sectionId: `cmd:${command.id}`, kind: 'command', requestId, commandId: command.id,
      command: String(command.command || '').slice(0, 2000), commandStatus: String(command.status || 'done'),
      fileCount: files.length, status: 'unavailable', files: [], at: Number(command.at) || 0, reason: command.reason }
    if (command.snapshot !== true) { result.status = active(requestId) ? 'busy' : 'unavailable'; return result }
    if (active(requestId)) { result.status = 'busy'; return result }
    if (!files.length) { result.status = command.undone ? 'done' : 'empty'; return result }
    for (const file of files) {
      if (result.files.length === MAX_SECTIONS) break
      result.files.push(await commandFileState(requestId, file.file, [file]))
    }
    result.status = command.undone ? 'done' : combinedStatus(result.files.map(file => file.status))
    return result
  }

  async function read (input) {
    if (!Array.isArray(input?.requestIds) || input.requestIds.length > 64 || !input.requestIds.every(id)) return { ok: false, code: 'invalid' }
    const sections = [], missing = []
    let truncated = false
    for (const requestId of [...new Set(input.requestIds)]) {
      const root = rootOf(requestId)
      if (!root) { missing.push(requestId); continue }
      try {
        await locked(root, async () => {
          const manifest = await loadManifest(root)
          const commandIds = new Set((manifest.commands || []).filter(command => command && id(command.id)).map(command => command.id))
          const groups = new Map()
          for (const entry of manifest.entries) {
            if (!entry || entry.undone || typeof entry.file !== 'string') continue
            // Изменения команды показываются отдельным участком. Если запись о
            // самой команде потерялась, файл не исчезает из обзора.
            if (entry.commandId && commandIds.has(entry.commandId)) continue
            if (!groups.has(entry.file)) groups.set(entry.file, [])
            groups.get(entry.file).push(entry)
          }
          // Команды идут первыми: если участков больше предела, показать
          // выполненную команду важнее, чем ещё один файл.
          for (const command of manifest.commands || []) {
            if (sections.length === MAX_SECTIONS) { truncated = true; break }
            if (!command || !id(command.id) || command.requestId !== requestId) continue
            sections.push(await commandSection(requestId, command))
          }
          for (const [file, entries] of groups) {
            if (sections.length === MAX_SECTIONS) { truncated = true; break }
            sections.push(await fileSection(requestId, file, entries))
          }
        })
      } catch { missing.push(requestId) }
    }
    sections.sort((a, b) => (b.at - a.at) || a.sectionId.localeCompare(b.sectionId))
    return { ok: true, sections, missing, truncated }
  }

  async function afterText (root, manifest, index, target) {
    const entry = manifest.entries[index]
    const next = manifest.entries.slice(index + 1).find(item => item && !item.undone && item.file === entry.file)
    if (next) {
      if (next.action === 'updated' || next.action === 'deleted') return await readBackup(root, next)
      return null
    }
    const current = await textAt(target)
    if (current.status === 'ok' && SHA.test(entry.wrote || '') && hash(current.text) === entry.wrote) return current.text
    return null
  }

  async function fragmentInfo (root, manifest, index, target, fileId) {
    const entry = manifest.entries[index]
    const result = { id: `frag:${fileId}:${index}`, index, action: entry.action, status: 'unavailable', before: null, after: null, truncated: false }
    if ((entry.fragmentsUndone || []).includes(index)) { result.status = 'done'; return result }
    try {
      if (entry.action === 'created' || entry.action === 'deleted') {
        const current = await textAt(target)
        result.after = current.status === 'ok' ? clip(current.text) : null
        if (entry.action === 'deleted') {
          try { result.before = clip(await readBackup(root, entry)) } catch { result.status = 'unavailable'; return result }
          result.status = current.status === 'missing' ? 'ready' : 'conflict'
        } else {
          result.status = current.status === 'missing' ? 'ready'
            : current.status === 'ok' && SHA.test(entry.wrote || '') && hash(current.text) === entry.wrote ? 'ready' : 'conflict'
        }
        return result
      }
      if (entry.action !== 'updated') return result
      const before = await readBackup(root, entry)
      const after = await afterText(root, manifest, index, target)
      result.before = clip(before)
      result.after = after === null ? null : clip(after)
      result.truncated = before.length > MAX_PREVIEW || (after?.length || 0) > MAX_PREVIEW
      result.status = after === null ? 'conflict' : 'ready'
    } catch { result.status = 'unavailable' }
    return result
  }

  async function preview (input) {
    const section = parseSection(input?.sectionId)
    if (!id(input?.requestId) || !section) return { ok: false, code: 'invalid' }
    const root = rootOf(input.requestId)
    if (!root) return { ok: false, code: 'missing' }
    try {
      return await locked(root, async () => {
        const manifest = await loadManifest(root)
        if (section.kind === 'cmd') {
          const command = (manifest.commands || []).find(item => item && item.id === section.commandId && item.requestId === input.requestId)
          if (!command) return { ok: false, code: 'missing' }
          const groups = (Array.isArray(command.files) ? command.files : []).filter(file => file && typeof file.file === 'string')
          const files = []
          let truncated = false
          for (const file of groups) {
            if (files.length === MAX_SECTIONS) { truncated = true; break }
            const state = await commandFileState(input.requestId, file.file, [file])
            let target = null
            try { target = await resolveFile(file.file) } catch {}
            const before = file.action === 'updated' || file.action === 'deleted'
              ? await readBackup(root, file).catch(() => null) : null
            const current = target ? await textAt(target) : { status: 'missing' }
            files.push({ ...state, before: before === null ? null : clip(before),
              after: current.status === 'ok' ? clip(current.text) : null,
              truncated: (before?.length || 0) > MAX_PREVIEW || (current.text?.length || 0) > MAX_PREVIEW })
          }
          return { ok: true, sectionId: `cmd:${command.id}`, kind: 'command', command: String(command.command || '').slice(0, 2000),
            commandStatus: command.status, status: active(input.requestId) ? 'busy' : command.undone ? 'done' : command.snapshot === true ? combinedStatus(files.map(file => file.status)) : 'unavailable',
            reason: command.reason, files, truncated }
        }

        const commandIds = new Set((manifest.commands || []).filter(command => command && id(command.id)).map(command => command.id))
        const indexes = []
        for (let index = 0; index < manifest.entries.length; index++) {
          const entry = manifest.entries[index]
          if (entry && !entry.undone && typeof entry.file === 'string' && !(entry.commandId && commandIds.has(entry.commandId)) && hash(entry.file) === section.fileId) indexes.push(index)
        }
        if (!indexes.length) return { ok: false, code: 'missing' }
        const file = manifest.entries[indexes[0]].file
        const target = await resolveFile(file)
        const shown = display(target)
        if (section.kind === 'frag') {
          if (!indexes.includes(section.index)) return { ok: false, code: 'missing' }
          const fragment = await fragmentInfo(root, manifest, section.index, target, section.fileId)
          return { ok: true, sectionId: sectionIdOf(section), kind: 'fragment', file: shown, ...fragment }
        }
        const entries = indexes.map(index => manifest.entries[index])
        const first = entries[0]
        const before = first.action === 'updated' ? await readBackup(root, first).catch(() => null) : null
        const current = await textAt(target)
        const fragments = []
        let truncated = false
        for (const index of indexes) {
          if (fragments.length === MAX_SECTIONS) { truncated = true; break }
          const fragment = await fragmentInfo(root, manifest, index, target, section.fileId)
          if (fragment.truncated) truncated = true
          fragments.push(fragment)
        }
        const state = await fileSection(input.requestId, file, entries)
        return { ok: true, sectionId: `file:${section.fileId}`, kind: 'file', file: shown, status: state.status,
          edits: entries.length, before: before === null ? null : clip(before),
          after: current.status === 'ok' ? clip(current.text) : null, fragments, truncated }
      })
    } catch { return { ok: false, code: 'unavailable' } }
  }

  function addPlanned (files, item, fragment) {
    const file = item.entry.file
    if (!files.has(file)) files.set(file, new Map())
    const existing = files.get(file).get(item.index)
    if (existing) existing.fragment = existing.fragment && fragment
    else files.get(file).set(item.index, { ...item, fragment })
  }

  function buildPlan (manifest, parsed) {
    const files = new Map()
    const commands = new Set()
    const sectionEntries = new Map()
    let matched = false
    for (const section of parsed) {
      const sectionId = sectionIdOf(section)
      if (section.kind === 'file') {
        const entries = []
        manifest.entries.forEach((entry, index) => {
          if (entry && !entry.undone && typeof entry.file === 'string' && hash(entry.file) === section.fileId) {
            const item = { index: `e:${index}`, order: index, manifestIndex: index, entry }
            entries.push(item); addPlanned(files, item, false)
          }
        })
        sectionEntries.set(sectionId, entries)
        if (entries.length) matched = true
      } else if (section.kind === 'frag') {
        const entry = manifest.entries[section.index]
        if (!entry || entry.undone || typeof entry.file !== 'string' || hash(entry.file) !== section.fileId) {
          sectionEntries.set(sectionId, [])
          continue
        }
        const item = { index: `e:${section.index}`, order: section.index, manifestIndex: section.index, entry }
        sectionEntries.set(sectionId, [item])
        addPlanned(files, item, true)
        matched = true
      } else {
        const command = (manifest.commands || []).find(item => item && item.id === section.commandId && item.requestId === manifest.requestId)
        if (!command || command.undone || command.snapshot !== true) { sectionEntries.set(sectionId, []); continue }
        const entries = []
        ;(Array.isArray(command.files) ? command.files : []).forEach((file, index) => {
          if (!file || typeof file.file !== 'string' || !['created', 'updated', 'deleted'].includes(file.action)) return
          const item = { index: `c:${command.id}:${index}`, order: Number(command.at) || 0, entry: file }
          entries.push(item); addPlanned(files, item, false)
        })
        sectionEntries.set(sectionId, entries)
        commands.add(command.id)
        matched = true
      }
    }
    return matched ? { files, commands, sectionEntries } : null
  }

  function setOutcome (outcomes, index, status, reason) {
    const previous = outcomes.get(index)
    if (previous && (previous.status === 'failed' || previous.status === 'done')) return
    outcomes.set(index, { status, reason })
  }

  async function undoWholeEntry (root, manifest, item, target, context) {
    const entry = item.entry
    try {
      if (!['created', 'updated', 'deleted'].includes(entry.action)) throw new Error('unknown action')
      let previous = null
      if (entry.action !== 'created') previous = await readBackup(root, entry)
      if (entry.action !== 'created' && entry.action !== 'deleted' && !SHA.test(entry.wrote || '')) throw new Error('fingerprint')
      const current = await currentText(target)

      // Откат уже случился, а журнал дописать не успели: цель совпадает со
      // снимком — значит это мы её вернули, а не появилась чужая работа.
      // Ветка была и для удалённых файлов: сбой после writeTarget оставлял
      // участок в «conflict» навсегда.
      if (entry.undoStarted && current === previous) {
        entry.undone = true
        await saveManifest(root, manifest)
        setOutcome(context.outcomes, item.index, 'done')
        return 'done'
      }

      if (entry.action === 'deleted') {
        if (current !== null) {
          context.conflicts.push(display(target))
          setOutcome(context.outcomes, item.index, 'conflict', 'Файл появился снова после команды — более поздняя работа не тронута.')
          return 'conflict'
        }
      } else if (entry.wrote) {
        const changedAfter = entry.action === 'created'
          ? current !== null && hash(current) !== entry.wrote
          : current === null || hash(current) !== entry.wrote
        if (changedAfter) {
          context.conflicts.push(display(target))
          setOutcome(context.outcomes, item.index, 'conflict', 'Файл изменён после этой правки — более поздняя работа не тронута.')
          return 'conflict'
        }
      } else {
        throw new Error('fingerprint')
      }

      entry.undoStarted = true
      await saveManifest(root, manifest)

      const checked = await resolveFile(entry.file)
      if (checked !== target || await currentText(target) !== current) {
        context.conflicts.push(display(target))
        setOutcome(context.outcomes, item.index, 'conflict', 'Файл изменился во время отката — запись отменена.')
        return 'conflict'
      }

      if (entry.action === 'created') {
        await fs.rm(target, { force: true })
        context.removed.push(display(target))
      } else {
        await writeTarget(target, previous)
        context.restored.push(display(target))
      }
      entry.undone = true
      await saveManifest(root, manifest)
      setOutcome(context.outcomes, item.index, 'done')
      return 'done'
    } catch (error) {
      context.failed.push(`${display(target)}: ${describeFailure(error)}`)
      setOutcome(context.outcomes, item.index, 'failed', describeFailure(error))
      return 'failed'
    }
  }

  async function undoFragment (root, manifest, item, target, context) {
    const entry = item.entry
    const index = item.manifestIndex
    const key = item.index
    if ((entry.fragmentsUndone || []).includes(index)) {
      setOutcome(context.outcomes, key, 'done')
      return 'done'
    }
    if (entry.action !== 'updated') return await undoWholeEntry(root, manifest, item, target, context)
    try {
      const before = await readBackup(root, entry)
      const after = await afterText(root, manifest, index, target)
      if (after === null) {
        setOutcome(context.outcomes, key, 'conflict', 'Более поздние правки изменили файл — участок нельзя выделить. Файл не тронут.')
        context.conflicts.push(display(target))
        return 'conflict'
      }
      const current = await currentText(target)
      if (current === null) {
        setOutcome(context.outcomes, key, 'conflict', 'Файл удалён после этой правки.')
        context.conflicts.push(display(target))
        return 'conflict'
      }
      const patch = reverseFragment(current, before, after)
      if (!patch.ok) {
        setOutcome(context.outcomes, key, 'conflict', patch.reason)
        context.conflicts.push(display(target))
        return 'conflict'
      }
      if (patch.text !== current) {
        const checked = await resolveFile(entry.file)
        if (checked !== target || await currentText(target) !== current) {
          setOutcome(context.outcomes, key, 'conflict', 'Файл изменился во время отката — запись отменена.')
          context.conflicts.push(display(target))
          return 'conflict'
        }
        await writeTarget(target, patch.text)
        context.restored.push(display(target))
      }
      entry.fragmentsUndone = [...(entry.fragmentsUndone || []), index]
      await saveManifest(root, manifest)
      setOutcome(context.outcomes, key, 'done')
      return 'done'
    } catch (error) {
      context.failed.push(`${display(target)}: ${describeFailure(error)}`)
      setOutcome(context.outcomes, key, 'failed', describeFailure(error))
      return 'failed'
    }
  }

  async function undoFileSet (root, manifest, file, planned, context) {
    let target
    try {
      target = await resolveFile(file)
    } catch (error) {
      for (const item of planned) setOutcome(context.outcomes, item.index, 'failed', describeFailure(error))
      context.failed.push(`${display(file)}: ${describeFailure(error)}`)
      return
    }
    const ordered = [...planned].sort((a, b) => (b.order || 0) - (a.order || 0))
    for (const item of ordered) {
      if (item.entry.undone && !item.fragment) { setOutcome(context.outcomes, item.index, 'done'); continue }
      const result = item.fragment
        ? await undoFragment(root, manifest, item, target, context)
        : await undoWholeEntry(root, manifest, item, target, context)
      // После неудачи или конфликта более старые записи этого файла не трогаем:
      // иначе поверх чужой работы ляжет ещё более старое содержимое.
      if (!item.fragment && (result === 'failed' || result === 'conflict')) break
    }
  }

  function sectionResults (plan, outcomes) {
    const results = []
    for (const [sectionId, entries] of plan.sectionEntries) {
      if (!entries.length) {
        results.push({ sectionId, status: plan.commands.has(sectionId.slice(4)) ? 'done' : 'missing' })
        continue
      }
      const states = entries.map(item => outcomes.get(item.index)?.status || 'skipped')
      const status = states.every(value => value === 'done') ? 'done'
        : states.includes('failed') ? 'failed'
          : states.includes('conflict') ? 'conflict'
            : states.includes('done') ? 'partial' : 'skipped'
      const reason = entries.map(item => outcomes.get(item.index)?.reason).find(Boolean)
      results.push({ sectionId, status, ...(reason ? { reason } : {}) })
    }
    return results
  }

  async function undo (input) {
    if (!id(input?.requestId) || !Array.isArray(input.sectionIds) || input.sectionIds.length < 1 || input.sectionIds.length > MAX_SELECTION) return { ok: false, code: 'invalid' }
    const parsed = input.sectionIds.map(parseSection)
    if (parsed.some(item => !item)) return { ok: false, code: 'invalid' }
    const root = rootOf(input.requestId)
    if (!root) return { ok: false, code: 'missing' }
    if (active(input.requestId)) return { ok: false, code: 'busy' }
    try {
      return await locked(root, async () => {
        const manifest = await loadManifest(root)
        manifest.requestId = manifest.requestId || input.requestId
        if (active(input.requestId)) return { ok: false, code: 'busy' }
        const plan = buildPlan(manifest, parsed)
        if (!plan) return { ok: false, code: 'missing' }
        const context = { restored: [], removed: [], failed: [], conflicts: [], outcomes: new Map() }
        for (const [file, planned] of plan.files) await undoFileSet(root, manifest, file, [...planned.values()], context)

        for (const command of manifest.commands || []) {
          if (!command || !plan.commands.has(command.id)) continue
          const files = Array.isArray(command.files) ? command.files : []
          if (!files.length || files.every((_file, index) => context.outcomes.get(`c:${command.id}:${index}`)?.status === 'done')) command.undone = true
        }
        try {
          await saveManifest(root, manifest)
        } catch (error) {
          // Сами файлы уже возвращены; не выдаём это за полный успех.
          context.failed.push(`Журнал снимков: ${describeFailure(error)}`)
        }
        const snapshotKept = manifest.entries.some(entry => !entry.undone) || (manifest.commands || []).some(command => !command.undone)
        if (!snapshotKept) await fs.rm(root, { recursive: true, force: true }).catch(() => {})
        return { ok: true, restored: [...new Set(context.restored)], removed: [...new Set(context.removed)],
          failed: context.failed, conflicts: [...new Set(context.conflicts)],
          sections: sectionResults(plan, context.outcomes), snapshotKept }
      })
    } catch (error) {
      return { ok: false, code: error?.code === 'ENOENT' ? 'missing' : 'unavailable', reason: describeFailure(error) }
    }
  }

  // -------------------------------------------------------------------------
  // Запись изменений команды
  // -------------------------------------------------------------------------

  async function captureTree (roots) {
    const files = new Map()
    let total = 0
    let capped = false
    async function walk (dir, depth) {
      if (capped || depth > CAPTURE.depth) return
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (capped) return
        const full = path.join(dir, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        let stat
        try { stat = await fs.stat(full) } catch { continue }
        if (stat.size > CAPTURE.file) {
          files.set(full, { size: stat.size, mtimeMs: stat.mtimeMs, hash: null, text: null, skipped: 'large' })
          continue
        }
        if (files.size >= CAPTURE.files || total + stat.size > CAPTURE.bytes) { capped = true; return }
        let bytes
        try { bytes = await fs.readFile(full) } catch { continue }
        const text = decode(bytes)
        if (text === null) {
          files.set(full, { size: stat.size, mtimeMs: stat.mtimeMs, hash: null, text: null, skipped: 'binary' })
          continue
        }
        files.set(full, { size: stat.size, mtimeMs: stat.mtimeMs, hash: hash(text), text })
        total += stat.size
      }
    }
    for (const root of roots) await walk(root, 0)
    return { files, capped }
  }

  function inert (reason) {
    return { id: null, finish: async () => ({ ok: false, reason }) }
  }

  async function beginCommand (input) {
    const requestId = input?.requestId
    if (!id(requestId)) return inert('Некорректный идентификатор хода — снимок команды не создан.')
    const roots = Array.isArray(input?.roots) ? input.roots.filter(value => typeof value === 'string' && path.isAbsolute(value)).slice(0, 8) : []
    if (!roots.length) return inert('Рабочие папки не найдены — снимок команды не создан.')
    let baseline
    try { baseline = await captureTree(roots) } catch { return inert('Не удалось снять снимок рабочих папок перед командой.') }
    const commandId = `c_${randomBytes(6).toString('hex')}`
    const commandText = String(input?.command || '').slice(0, 2000)
    const cwd = typeof input?.cwd === 'string' ? input.cwd : ''
    let closed = false

    async function finish (outcome = {}) {
      if (closed) return { ok: false, reason: 'Снимок команды уже закрыт.' }
      closed = true
      const status = ['done', 'failed', 'aborted', 'skipped'].includes(outcome?.status) ? outcome.status : 'done'
      if (baseline.capped) return { ok: false, reason: 'Рабочая папка слишком велика для снимка команды — изменения команды не сохранены.' }
      let after
      try { after = await captureTree(roots) } catch { return { ok: false, reason: 'Не удалось сравнить рабочую папку после команды.' } }
      if (after.capped) return { ok: false, reason: 'Рабочая папка слишком велика для снимка команды — изменения команды не сохранены.' }
      try {
        const root = rootOf(requestId)
        if (!root) return { ok: false, reason: 'Нет папки снимков для этого хода.' }
        return await locked(root, async () => {
          await fs.mkdir(root, { recursive: true })
          let manifest
          try { manifest = await loadManifest(root) } catch (error) {
            if (error.code !== 'ENOENT') throw error
            manifest = { requestId, at: Date.now(), entries: [] }
          }
          if (!Array.isArray(manifest.entries)) manifest.entries = []
          if (!Array.isArray(manifest.commands)) manifest.commands = []
          const changed = []
          const unavailable = []
          const paths = new Set([...baseline.files.keys(), ...after.files.keys()])
          for (const file of paths) {
            const before = baseline.files.get(file)
            const next = after.files.get(file)
            if (before && next && before.hash && next.hash && before.hash === next.hash) continue
            if (before && next && !before.hash && !next.hash && before.size === next.size && before.mtimeMs === next.mtimeMs) continue
            const previousText = before?.text
            const nextText = next?.text
            if (typeof previousText !== 'string' && before) { unavailable.push({ file, label: display(file), reason: 'Файл был двоичным или слишком большим до команды.' }); continue }
            if (typeof nextText !== 'string' && next) { unavailable.push({ file, label: display(file), reason: 'Файл стал двоичным или слишком большим после команды.' }); continue }
            const action = !previousText ? (nextText ? 'created' : null) : nextText ? 'updated' : 'deleted'
            if (!action) continue
            changed.push({ file, action, previousText, nextText })
            if (changed.length > MAX_COMMAND_FILES) break
          }
          const files = []
          for (const item of changed) {
            const common = { file: item.file, label: display(item.file), action: item.action,
              ...lineStats(item.previousText, item.nextText) }
            if (item.action === 'created') {
              files.push({ ...common, wrote: hash(item.nextText) })
            } else {
              const name = `${randomBytes(8).toString('hex')}.bak`
              const encoded = encodeBackup(item.previousText)
              if (typeof encoded !== 'string') throw new Error('backup encoder')
              await fs.writeFile(path.join(root, name), encoded, 'utf8')
              files.push({ ...common, backup: name, before: hash(item.previousText),
                ...(item.action === 'updated' ? { wrote: hash(item.nextText) } : {}) })
            }
          }
          const record = { id: commandId, requestId, command: String(redact(commandText)).slice(0, 2000),
            cwd: cwd ? String(display(cwd)) : '', status, at: Date.now(), snapshot: changed.length > 0 || unavailable.length === 0,
            files: files.slice(0, MAX_COMMAND_FILES),
            unavailable: unavailable.slice(0, MAX_COMMAND_FILES),
            ...(unavailable.length ? { reason: 'Часть файлов не сохранена: двоичные или слишком большие.' } : {}) }
          manifest.commands.push(record)
          if (manifest.commands.length > MAX_COMMANDS) manifest.commands.splice(0, manifest.commands.length - MAX_COMMANDS)
          await saveManifest(root, manifest)
          return { ok: true, commandId, files: record.files.length, changedFiles: record.files,
            unavailable: record.unavailable.length, snapshot: record.snapshot }
        })
      } catch (error) {
        return { ok: false, reason: describeFailure(error) }
      }
    }
    return { id: commandId, finish }
  }

  return { read, preview, undo, beginCommand }
}

module.exports = { create, reverseFragment, middle, parseSection, findSequence }
