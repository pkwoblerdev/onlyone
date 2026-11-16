'use strict'

// Хранилище расписаний (план, этап 3.5). Отделено от рантайма по той же
// причине, по какой отделён `run-checkpoints.js`: список должен переживать
// закрытие и падение процесса, и делать это надо одним файлом, который
// пишется атомарно.
//
// Здесь нет Electron: каталог, часы, зачистку секретов и даже доступ к диску
// приносят параметрами. Тест подставляет отказ записи и смотрит, что прежний
// файл остался целым, — с настоящим `fs.renameSync` этого не проверить.
//
// Четыре честных ответа о файле вместо одного «пусто»: файла нет (первый
// запуск), файл целой, файл битый, файл нечитаемый (каталог вместо файла,
// права, I/O). Два последних различает человек, и оба обязаны пережить
// последующую запись.

const { tr } = require('./ui-text.cjs')
const { ACTION_TEXT_LIMIT } = require('./schedule-model.js')
const path = require('node:path')

const FILE = 'schedules.json'
const SCHEMA_VERSION = 1
// История на расписание. Ограничение не косметическое: файл перечитывается
// целиком, а расписаний у человека может быть несколько десятков.
const MAX_HISTORY = 20
const TEXT_LIMIT = 240

function createScheduleStore(options = {}) {
  const dir = String(options.dir || '')
  const now = typeof options.now === 'function' ? options.now : Date.now
  const redact = typeof options.redact === 'function' ? options.redact : text => String(text == null ? '' : text)
  const protect = typeof options.protect === 'function' ? options.protect : null
  const unprotect = typeof options.unprotect === 'function' ? options.unprotect : null
  // Единый шов доступа к диску: `writeFile` и `rename` по умолчанию берутся из
  // него же, поэтому подмена всего `fs` работает как подмена обеих сторон.
  const disk = options.fs && typeof options.fs === 'object' ? options.fs : require('node:fs')
  const writeFile = typeof options.writeFile === 'function' ? options.writeFile : disk.writeFileSync
  const rename = typeof options.rename === 'function' ? options.rename : disk.renameSync
  // Имя файла — не деталь хранилища: тем же механизмом атомарной записи
  // пользуется журнал задач, и держать его в файле `schedules.json` было бы
  // враньём человеку, который придёт разбирать каталог руками.
  // Имя файла — не деталь хранилища: тем же механизмом атомарной записи
  // пользуется журнал задач, и держать его в файле `schedules.json` было бы
  // враньём человеку, который придёт разбирать каталог руками. Копия битого
  // файла называется по тому же основанию.
  const fileName = String(options.file || FILE)
  const corruptPrefix = `${fileName.replace(/\.json$/, '')}.corrupt-`
  const file = dir ? path.join(dir, fileName) : ''

  // Что лежит в файле: `absent` — файл отсутствует, `parsed` — разобран и имеет
  // форму списка, `broken`/`unreadable` — правду о порче, а не молчаливую пустоту.
  function inspect() {
    if (!file) return { kind: 'absent' }
    let text
    try {
      text = disk.readFileSync(file, 'utf8')
    } catch (error) {
      // Отсутствие файла — это первый запуск приложения. Всё остальное
      // (каталог вместо файла, отказ прав, I/O) человек обязан увидеть как
      // испорченное: «не смогли прочитать» ≠ «там ничего не было».
      if (error && error.code === 'ENOENT') return { kind: 'absent' }
      return { kind: 'unreadable' }
    }
    let parsed
    try { parsed = JSON.parse(text) } catch { return { kind: 'broken', text } }
    let isEncrypted = false
    if (parsed && parsed.enc === 'safeStorage' && typeof parsed.data === 'string') {
      isEncrypted = true
      if (unprotect) {
        try {
          parsed = JSON.parse(unprotect(parsed.data))
        } catch {
          return { kind: 'locked', text }
        }
      } else {
        return { kind: 'locked', text }
      }
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.records) ? parsed.records : null
    if (!list) return { kind: 'broken', text }
    return { kind: 'parsed', list, text, isEncrypted }
  }

  function usable(item) {
    return !!(item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && item.id)
  }

  // Второй рубеж доходит и до действия: ключ модели в тексте просьбы или в env
  // не должен уйти в файл дословно (break-4 Н13). Предел длины — модельный, не
  // шапочный: обрыв легальной команды ломает её. Карта памятки держит и циклы,
  // и общие ссылки — второй вхождение объекта не остаётся сырым.
  function scrubAction(value, seen = new Map()) {
    if (typeof value === 'string') return redact(value).slice(0, ACTION_TEXT_LIMIT)
    if (!value || typeof value !== 'object') return value
    if (seen.has(value)) return seen.get(value)
    if (Array.isArray(value)) {
      const out = []
      seen.set(value, out)
      for (const item of value) out.push(scrubAction(item, seen))
      return out
    }
    const out = {}
    seen.set(value, out)
    for (const [key, item] of Object.entries(value)) out[key] = scrubAction(item, seen)
    return out
  }

  function sanitize(entry) {
    const clean = { ...entry }
    // `name` — не только украшение: он уезжает в окно и в журнал событий, а
    // назвать расписание человек может чем угодно, включая свежий ключ.
    for (const field of ['name', 'lastError', 'error', 'text', 'prompt', 'command']) {
      if (typeof clean[field] === 'string') clean[field] = redact(clean[field]).slice(0, TEXT_LIMIT)
    }
    // Командная строка задачи лежит в журнале двояко: либо `command` одной
    // строкой, либо `command` + массив `args`. Зачистить только строку — значит
    // оставить ключ рядом с закрашенным: аргументы читаются тем же файлом.
    // Длину здесь не режут: аргумент — не подпись, его обрыв ломает команду.
    for (const field of ['command', 'args']) {
      if (Array.isArray(clean[field])) {
        clean[field] = clean[field].map(item => (typeof item === 'string' ? String(redact(item)) : item))
      }
    }
    if (clean.action && typeof clean.action === 'object') clean.action = scrubAction(clean.action)
    if (Array.isArray(clean.history)) {
      clean.history = clean.history.slice(0, MAX_HISTORY).map(item => ({
        ...item,
        ...(typeof item?.error === 'string' ? { error: redact(item.error).slice(0, TEXT_LIMIT) } : {})
      }))
    }
    return clean
  }

  function load() {
    const found = inspect()
    if (found.kind === 'absent') return { records: [], corrupt: false }
    if (found.kind !== 'parsed') return { records: [], corrupt: true }
    // Отдельно битые записи внутри целого файла: испорченная одним релизом
    // строка не имеет права уносить за собой весь список.
    const good = found.list.filter(usable)
    if (!found.isEncrypted && protect) {
      try {
        writeRecords(good)
      } catch { /* best effort migration */ }
    }
    return { records: good.map(sanitize), corrupt: good.length !== found.list.length }
  }

  function list() {
    return load().records
  }

  // Битый файл переживает последующую запись копией — тот же принцип, что архив
  // испорченных настроек (Н37). Разобрать руками всегда лучше, чем потерять.
  function archiveCorrupt() {
    const found = inspect()
    if (found.kind === 'parsed' || found.kind === 'absent') return
    if (found.kind === 'locked' || typeof found.text !== 'string') throw new Error(tr('Хранилище недоступно: прежние данные сохранены.'))
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    let target = path.join(dir, `${corruptPrefix}${stamp}.json`)
    for (let i = 1; disk.existsSync(target); i++) {
      target = path.join(dir, `${corruptPrefix}${stamp}-${i}.json`)
    }
    if (protect) {
      disk.writeFileSync(target, JSON.stringify({ enc: 'safeStorage', data: protect(disk.readFileSync(file).toString('base64')), b64: true }), { flag: 'wx' })
    } else disk.copyFileSync(file, target)
  }

  // Временный файл + `rename`: получатель всегда видит либо прежний список,
  // либо новый, но никогда — половину.
  function writeRecords(records) {
    if (!file) return
    const payload = { schemaVersion: SCHEMA_VERSION, savedAt: now(), records: records.map(sanitize) }
    const tmp = path.join(dir, `${fileName}.${process.pid}.tmp`)
    disk.mkdirSync(dir, { recursive: true })
    archiveCorrupt()
    try {
      let content
      if (protect) {
        content = JSON.stringify({ enc: 'safeStorage', data: protect(JSON.stringify(payload)) }, null, 2)
      } else {
        content = JSON.stringify(payload, null, 2)
      }
      writeFile(tmp, content)
      rename(tmp, file)
    } catch (error) {
      // Прежний файл не тронут — человек продолжает работать со старым
      // списком. Отказ обязан дойти до вызывающего: молчаливый проигрыш
      // означал бы «расписание сохранено», которого нет.
      try { disk.rmSync(tmp, { force: true }) } catch {}
      throw error
    }
    // На случай, когда `rename` отработал, но временный файл всё ещё виден
    // (сетевой диск), убираем его явно: тест проверяет отсутствие остатков.
    try { if (disk.existsSync(tmp)) disk.rmSync(tmp, { force: true }) } catch {}
  }

  function save(records) {
    writeRecords(Array.isArray(records) ? records : [])
    return true
  }

  function upsert(record) {
    if (!record || typeof record.id !== 'string' || !record.id) return false
    const records = list()
    const index = records.findIndex(item => item.id === record.id)
    const clean = { updatedAt: now(), ...record }
    if (index >= 0) {
      // Историю правят два шва — `appendHistory` и `settleHistory`. `upsert`
      // несёт состояние расписания (сроки, пауза, ошибка) и не имеет права
      // затыкать журнал тем, что рантайм держит в памяти.
      records[index] = { ...records[index], ...sanitize(clean), history: records[index].history }
    } else records.push(sanitize(clean))
    writeRecords(records)
    return true
  }

  function remove(id) {
    const records = list()
    const kept = records.filter(item => item.id !== id)
    if (kept.length === records.length) return false
    writeRecords(kept)
    return true
  }

  function appendHistory(id, entry) {
    const records = list()
    const item = records.find(record => record && record.id === id)
    if (!item) return false
    const clean = sanitize({ at: now(), ...entry })
    item.history = [clean, ...(Array.isArray(item.history) ? item.history : [])]
    writeRecords(records)
    return true
  }

  // Исход запуска правит ТУ ЖЕ запись истории, что была заведена словом
  // «начато», а не добавляет вторую. Иначе процесс, умерший внутри исполнения,
  // оставил бы «начато» без ответа, а вернувшийся — «начато» второй раз.
  function settleHistory(id, runId, patch) {
    const records = list()
    const item = records.find(record => record && record.id === id)
    const history = Array.isArray(item && item.history) ? item.history : []
    const index = history.findIndex(entry => entry && entry.runId === runId)
    if (index < 0) return false
    history[index] = { ...history[index], ...sanitize({ ...patch }) }
    item.history = history
    writeRecords(records)
    return true
  }

  return { load, list, save, upsert, remove, appendHistory, settleHistory, file, MAX_HISTORY }
}

module.exports = { createScheduleStore, FILE, SCHEMA_VERSION, MAX_HISTORY }
