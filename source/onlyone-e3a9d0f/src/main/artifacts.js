'use strict'

// Артефакты чата (план, 3.2): то, что модель создала, — страница, картинка,
// таблица, график, код, дифф. Хранится отдельно от диалога и отдельно от раздела
// «Дизайн»: артефакт живёт в чате, а макет — в своём разделе.
//
// Версии — отдельные файлы, а не поля в JSON. Превью открывается ссылкой на
// конкретную версию, поэтому «модель прислала новую» не переписывает то, что
// человек уже видит, и старую версию можно открыть сравнением.

const { tr } = require('./ui-text.cjs')
const fssync = require('fs')
const fs = require('fs/promises')
const path = require('path')
const { randomUUID } = require('crypto')

const KINDS = new Set(['page', 'image', 'table', 'chart', 'code', 'diff', 'video'])
const MAX_VERSIONS = 20
const MAX_CONTENT_CHARS = 4_000_000
// Ролик (9.8) — не текст: он приходит файлом, который агент отрендерил в рабочей
// папке, и ложится в папку артефакта копией. Предел щедрый — ролики тяжёлые, —
// но он есть: копия в четыре гигабайта на системном диске вместо «слишком
// большой» — уже сбой, а не работа.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov'])
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024

// Как версию положить на диск и по какому пути её потом отдавать.
const FILENAME = {
  page: 'index.html',
  image: 'image',
  table: 'table.csv',
  chart: 'chart.json',
  code: 'source',
  diff: 'diff.patch',
  video: 'video.mp4'
}

function safeId(value) {
  const id = String(value || '')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Недопустимый идентификатор артефакта.')
  return id
}

// Имя файла версии — только имя внутри папки артефакта. `meta.json` лежит на
// диске и мог прийти откуда угодно (чужая папка, ручная правка, сбой), а по
// этому имени читается содержимое: путь с `..` отдал бы наружу любой файл.
const VERSION_FILE = /^[0-9]{1,9}-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/

function cleanMeta(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const kind = KINDS.has(raw.kind) ? raw.kind : null
  if (!kind) return null
  const seen = new Set()
  const versions = (Array.isArray(raw.versions) ? raw.versions : []).filter(item => {
    const n = Number(item?.n)
    const file = String(item?.file || '')
    if (!Number.isInteger(n) || n < 1 || seen.has(n)) return false
    if (!VERSION_FILE.test(file) || path.basename(file) !== file) return false
    seen.add(n)
    return true
  }).map(item => ({
    n: Number(item.n),
    at: Number(item.at) || 0,
    file: String(item.file),
    chars: Number(item.chars) || 0
  })).sort((a, b) => a.n - b.n)
  if (!versions.length) return null
  const current = versions.some(item => item.n === Number(raw.current)) ? Number(raw.current) : versions[versions.length - 1].n
  return {
    ...raw,
    id: safeId(id),
    kind,
    versions,
    current,
    chatId: String(raw.chatId || ''),
    title: String(raw.title || 'Без названия').slice(0, 120),
    fileName: String(raw.fileName || '').slice(0, 200),
    createdAt: Number(raw.createdAt) || versions[0].at || 0,
    updatedAt: Number(raw.updatedAt) || versions[versions.length - 1].at || 0,
    archived: Boolean(raw.archived)
  }
}

function create({ dir, onEvent = () => {}, protect, unprotect, maxFileBytes = MAX_VIDEO_BYTES }) {
  const folderOf = id => path.join(dir, safeId(id))
  const metaOf = id => path.join(folderOf(id), 'meta.json')

  // Лексической очистки имени мало: внутри папки артефакта может лежать
  // junction или symlink, и тогда путь «внутри» уходит наружу. Граница —
  // канонический путь самой папки, а не папки родителя файла.
  const realRoot = id => {
    try { return fssync.realpathSync(folderOf(id)) } catch { return null }
  }
  const insideRoot = (root, target) => {
    if (!root || !target) return false
    const rel = path.relative(root, target)
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
  }
  // Канонический путь существующего файла, или null, если он вылезает за корень.
  const realInside = (id, target) => {
    const folder = realRoot(id)
    let real
    try { real = fssync.realpathSync(target) } catch { return null }
    // Проверка «файл внутри своей папки» сама по себе не закрывает случай,
    // когда junction-ом является папка самого артефакта: тогда её realpath —
    // внешняя папка, и файл «внутри» неё на деле снаружи хранилища.
    let store
    try { store = fssync.realpathSync(dir) } catch { return null }
    return insideRoot(store, folder) && insideRoot(folder, real) ? real : null
  }

  // Артефакт принадлежит одному диалогу. IPC приходит из окна, где открыт
  // конкретный чат, но id в запросе — строка, и без проверки один чат правил
  // бы артефакт другого.
  function owns(meta, chatId) {
    if (chatId === null || chatId === undefined) return meta
    if (String(meta.chatId || '') !== String(chatId)) {
      throw new Error('Артефакт относится к другому диалогу.')
    }
    return meta
  }
  // Один ход на артефакт: `update` читает meta, добавляет версию и пишет meta
  // обратно. Без очереди два одновременных сохранения (модель дописывает,
  // человек правит) берут один и тот же номер и второй затирает первый файл.
  const queues = new Map()

  function serialize(id, task) {
    const key = safeId(id)
    const previous = queues.get(key) || Promise.resolve()
    const next = previous.then(task, task)
    queues.set(key, next)
    next.then(() => {
      if (queues.get(key) === next) queues.delete(key)
    }, () => {
      if (queues.get(key) === next) queues.delete(key)
    })
    return next
  }

  // Список артефактов зовётся при каждом переключении чата, а расшифровка меты (DPAPI) занимает главный процесс на сотни
  // миллисекунд. Мета не менялась, пока совпадают время и размер файла, — тогда читать и расшифровывать заново незачем.
  const metaCache = new Map()

  async function readMeta(id) {
    try {
      let stamp = null
      try {
        const stat = await fs.stat(metaOf(id))
        stamp = `${stat.mtimeMs}:${stat.size}`
        const hit = metaCache.get(id)
        if (hit && hit.stamp === stamp) return structuredClone(hit.meta)
      } catch { /* нет файла — ниже обычный путь и обычная ошибка */ }
      const raw = await fs.readFile(metaOf(id), 'utf8')
      let parsed = JSON.parse(raw)
      let needsMigration = false
      if (parsed && parsed.enc === 'safeStorage' && typeof parsed.data === 'string') {
        if (typeof unprotect === 'function') {
          try {
            parsed = JSON.parse(unprotect(parsed.data))
          } catch (decryptErr) {
            try {
              const aside = `${metaOf(id)}.corrupt-key-${Date.now()}`
              await fs.writeFile(aside, raw, 'utf8')
            } catch {}
            throw decryptErr
          }
        }
      } else if (typeof protect === 'function') {
        needsMigration = true
      }
      const meta = cleanMeta(parsed, id)
      if (needsMigration && meta && typeof protect === 'function') {
        try {
          await writeMeta(meta)
        } catch { /* best effort migration */ }
      } else if (meta && stamp) {
        metaCache.set(id, { stamp, meta: structuredClone(meta) })
      }
      return meta
    } catch (error) {
      if (error.code !== 'ENOENT') onEvent('meta-unreadable', { id, error: String(error.message || error) })
      return null
    }
  }

  // Windows не отпускает цель переименования мгновенно: антивирус и поисковый
  // индекс держат `meta.json` сотни миллисекунд, и первая попытка отдаёт EPERM.
  // Данные при этом целы — прежняя мета на месте, — поэтому короткое терпение
  // дешевле, чем «версия не сохранилась» на ровном месте. Ошибку «нет места на
  // диске» повторять нечем, она уходит наружу сразу.
  const META_LOCK_PAUSES = [0, 60, 180, 400]
  const LOCKED_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

  async function writeMeta(meta) {
    metaCache.delete(meta.id)
    const folder = folderOf(meta.id)
    await fs.mkdir(folder, { recursive: true })
    const target = metaOf(meta.id)
    try {
      const existing = await fs.readFile(target, 'utf8')
      let parsed = null
      try { parsed = JSON.parse(existing) } catch {}
      if (parsed && parsed.enc === 'safeStorage' && typeof parsed.data === 'string') {
        let ok = false
        if (typeof unprotect === 'function') {
          try { unprotect(parsed.data); ok = true } catch {}
        }
        if (!ok) {
          const aside = `${target}.corrupt-key-${Date.now()}`
          await fs.writeFile(aside, existing, 'utf8')
        }
      }
    } catch {}
    const tmp = `${target}.${randomUUID()}.tmp`
    let textToWrite
    if (typeof protect === 'function') {
      textToWrite = JSON.stringify({ enc: 'safeStorage', data: protect(JSON.stringify(meta)) }, null, 2)
    } else {
      textToWrite = JSON.stringify(meta, null, 2)
    }
    await fs.writeFile(tmp, textToWrite)
    let last = null
    for (const pause of META_LOCK_PAUSES) {
      if (pause) await new Promise(resolve => setTimeout(resolve, pause))
      try {
        await fs.rename(tmp, target)
        return
      } catch (error) {
        last = error
        if (!LOCKED_CODES.has(error.code)) break
      }
    }
    // На отказе временной файл оставлять нечем: он переживает версию и лезет в
    // «показать папку артефакта».
    try { await fs.unlink(tmp) } catch { /* оболочка уже чужая — не потерянные данные */ }
    throw last
  }

  // Файл версии кладётся в тот же каталог: протокол отдает его прямо оттуда, и
  // копия артефакта остаётся обычной папкой с файлами, а не чем-то внутренним.
  // `wx` — не «перезаписать, если есть»: перезапись чужой версии и есть потеря.
  async function putVersion(meta, version, content) {
    const name = `${version}-${FILENAME[meta.kind]}`
    const target = path.join(folderOf(meta.id), name)
    let textToWrite
    if (typeof protect === 'function') {
      textToWrite = JSON.stringify({ enc: 'safeStorage', data: protect(String(content)) })
    } else {
      textToWrite = String(content)
    }
    try {
      await fs.writeFile(target, textToWrite, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`Версия ${version} уже есть на диске — артефакт не перезаписан.`)
      }
      throw error
    }
    return name
  }

  async function add({ chatId = '', title = '', kind = 'page', content = '', fileName = '' }) {
    if (!KINDS.has(kind)) throw new Error(`Неизвестный вид артефакта: ${kind}`)
    if (kind === 'video') throw new Error('Видео принимается только файлом (addFile): текстом ролик не передать.')
    const text = String(content ?? '')
    if (!text.trim()) throw new Error('Артефакт без содержимого не создаётся.')
    if (text.length > MAX_CONTENT_CHARS) throw new Error(`Слишком большой артефакт: ${text.length} знаков, предел ${MAX_CONTENT_CHARS}.`)

    const id = randomUUID().replace(/-/g, '').slice(0, 16)
    const now = Date.now()
    // Папка раньше содержимого: первая версия пишется в неё, и в том же порядке
    // её потом отдаёт протокол превью.
    await fs.mkdir(folderOf(id), { recursive: true })
    const meta = {
      id,
      chatId: String(chatId || ''),
      title: String(title || 'Без названия').slice(0, 120),
      kind,
      fileName: String(fileName || '').slice(0, 200),
      createdAt: now,
      updatedAt: now,
      current: 1,
      versions: [{ n: 1, at: now, file: await putVersion({ id, kind }, 1, text), chars: text.length }]
    }
    await writeMeta(meta)
    onEvent('added', { id, kind, chars: text.length })
    return meta
  }

  // Old/crashed transactions may have an uncommitted version on disk. Never overwrite it.
  async function nextVersion(meta) {
    let next = (meta.current || 0) + 1
    for (const name of await fs.readdir(folderOf(meta.id))) {
      const match = /^([1-9]\d*)-/.exec(name)
      if (match && Number.isSafeInteger(Number(match[1]))) next = Math.max(next, Number(match[1]) + 1)
    }
    if (!Number.isSafeInteger(next)) throw new Error(tr('Некорректный номер версии артефакта.'))
    return next
  }

  function update(id, content, { title = '', chatId = null } = {}) {
    return serialize(id, async () => {
      const meta = await readMeta(id)
      if (!meta) throw new Error('Артефакт не найден: возможно, его удалили вместе с диалогом.')
      owns(meta, chatId)
      const text = String(content ?? '')
      if (!text.trim()) throw new Error('Пустая версия артефакта не записывается: старая осталась на месте.')
      if (text.length > MAX_CONTENT_CHARS) throw new Error(`Слишком большая версия: ${text.length} знаков.`)

      if (meta.kind === 'video') throw new Error('Новая версия видео — файл (updateFile), не текст.')
      const n = await nextVersion(meta)
      const version = { n, at: Date.now(), file: await putVersion(meta, n, text), chars: text.length }
      return commitVersion(meta, version, title)
    })
  }

  // Общий хвост «новая версия»: добавить в список, срезать лишние, записать мету.
  async function commitVersion(meta, version, title) {
    const all = [...(meta.versions || []), version]
    const kept = all.slice(-MAX_VERSIONS)
    meta.versions = kept
    meta.current = version.n
    meta.updatedAt = version.at
    if (title) meta.title = String(title).slice(0, 120)
    try {
      await writeMeta(meta)
    } catch (error) {
      // This version was exclusively created by this transaction; permit a safe retry.
      try { await fs.rm(path.join(folderOf(meta.id), version.file), { force: true }) } catch {}
      throw error
    }
    // Only prune history after its replacement metadata is durable.
    for (const dropped of all.slice(0, all.length - kept.length)) {
      try { await fs.rm(path.join(folderOf(meta.id), dropped.file), { force: true }) } catch {}
    }
    onEvent('updated', { id: meta.id, n: version.n, chars: version.chars })
    return meta
  }

  // Ролик приходит путём к готовому файлу. Всё, что можно проверить, проверяется
  // ДО копирования: пустой файл, чужое расширение, размер сверх предела.
  async function inspectVideo(sourcePath) {
    const given = String(sourcePath || '').trim()
    if (!given) throw new Error('Не назван путь к файлу ролика.')
    const source = path.resolve(given)
    let info
    try { info = await fs.stat(source) } catch { throw new Error(`Файл ролика не найден: ${given}`) }
    if (!info.isFile()) throw new Error('По этому пути не файл — ролик ищется файлом, а не папкой.')
    const ext = path.extname(source).toLowerCase()
    if (!VIDEO_EXTENSIONS.has(ext)) throw new Error(`Видео принимается в форматах mp4, webm, mov; получено «${ext || 'без расширения'}».`)
    if (info.size === 0) throw new Error('Файл ролика пуст — рендер, скорее всего, оборвался.')
    if (info.size > maxFileBytes) throw new Error(`Слишком большой ролик: ${info.size} байт, предел ${maxFileBytes}.`)
    return { source, ext, bytes: info.size }
  }

  // `COPYFILE_EXCL` — то же «не перезаписывать», что и `wx` у текстовых версий.
  async function putVideoVersion(meta, version, source, ext) {
    const name = `${version}-video${ext}`
    try {
      await fs.copyFile(source, path.join(folderOf(meta.id), name), fssync.constants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Версия ${version} уже есть на диске — артефакт не перезаписан.`)
      throw error
    }
    return name
  }

  async function addFile({ chatId = '', title = '', kind = 'video', sourcePath = '', fileName = '' }) {
    if (kind !== 'video') throw new Error('Файлом принимается только видео; остальные виды — текстом через add.')
    const { source, ext, bytes } = await inspectVideo(sourcePath)
    const id = randomUUID().replace(/-/g, '').slice(0, 16)
    const now = Date.now()
    await fs.mkdir(folderOf(id), { recursive: true })
    let file
    try {
      file = await putVideoVersion({ id }, 1, source, ext)
    } catch (error) {
      // Своя, только что заведённая и пустая папка: убрать её — не потеря.
      try { await fs.rmdir(folderOf(id)) } catch { /* осталась — не беда */ }
      throw error
    }
    const meta = {
      id,
      chatId: String(chatId || ''),
      title: String(title || 'Без названия').slice(0, 120),
      kind,
      fileName: String(fileName || '').slice(0, 200),
      createdAt: now,
      updatedAt: now,
      current: 1,
      versions: [{ n: 1, at: now, file, chars: bytes }]
    }
    await writeMeta(meta)
    onEvent('added', { id, kind, chars: bytes })
    return meta
  }

  function updateFile(id, sourcePath, { title = '', chatId = null } = {}) {
    return serialize(id, async () => {
      const meta = await readMeta(id)
      if (!meta) throw new Error('Артефакт не найден: возможно, его удалили вместе с диалогом.')
      owns(meta, chatId)
      if (meta.kind !== 'video') throw new Error('Файлом обновляется только видео; текстовые виды — через update.')
      const { source, ext, bytes } = await inspectVideo(sourcePath)
      const n = await nextVersion(meta)
      const version = { n, at: Date.now(), file: await putVideoVersion(meta, n, source, ext), chars: bytes }
      return commitVersion(meta, version, title)
    })
  }

  function rename(id, title, { chatId = null } = {}) {
    return serialize(id, async () => {
      const meta = await readMeta(id)
      if (!meta) return null
      owns(meta, chatId)
      meta.title = String(title || meta.title || '').slice(0, 120)
      meta.updatedAt = Date.now()
      await writeMeta(meta)
      return meta
    })
  }

  async function versionText(id, n, { chatId = null } = {}) {
    const meta = await readMeta(id)
    if (!meta) throw new Error('Артефакт не найден.')
    owns(meta, chatId)
    const wanted = meta.versions.find(item => item.n === Number(n || meta.current))
    if (!wanted) throw new Error(`Версии ${n} у этого артефакта нет.`)
    // Ролик текстом не читается: его отдаёт протокол потоком, а память не резиновая.
    if (meta.kind === 'video') return ''
    const target = path.join(folderOf(id), wanted.file)
    if (!realInside(id, target)) throw new Error('Файл версии лежит вне папки артефакта.')
    const raw = await fs.readFile(target, 'utf8')
    let text = raw
    let parsed
    try { parsed = JSON.parse(raw) } catch { /* legacy text */ }
    const encrypted = parsed && parsed.enc === 'safeStorage'
    if (encrypted) {
      if (typeof unprotect !== 'function' || typeof parsed.data !== 'string') throw new Error(tr('Расшифровка артефакта недоступна.'))
      text = unprotect(parsed.data)
    }
    const needsMigration = !encrypted && typeof protect === 'function'
    if (needsMigration && typeof protect === 'function') {
      try {
        const envelope = JSON.stringify({ enc: 'safeStorage', data: protect(text) })
        await fs.writeFile(target, envelope, 'utf8')
      } catch { /* best effort migration */ }
    }
    return text
  }

  async function list({ chatId = '', includeArchived = false } = {}) {
    let names = []
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    const items = []
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue
      const meta = await readMeta(name)
      if (!meta || meta.archived && !includeArchived) continue
      if (chatId && meta.chatId !== String(chatId)) continue
      items.push(meta)
    }
    return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  // Не «удалить папку», а убрать из списка: содержимое остаётся на диске до
  // очистки, потому что артефакт человек мог сохранить себе как работу.
  function archive(id, { chatId = null } = {}) {
    return serialize(id, async () => {
      const meta = await readMeta(id)
      if (!meta) return false
      owns(meta, chatId)
      meta.archived = true
      meta.updatedAt = Date.now()
      await writeMeta(meta)
      onEvent('archived', { id: meta.id })
      return true
    })
  }

  // Раздельно: «файла нет» и «файл есть, но он снаружи» — разные ответы.
  // Протокол на второе обязан ответить 403, а не притворяться пустотой:
  // по 404 человек ищет пропавший файл, а не понимает, что его не пустили.
  function resolveServed(id, name) {
    const folder = folderOf(id)
    const target = path.resolve(folder, String(name || '').replace(/^\/+/, ''))
    if (target !== folder && !target.startsWith(folder + path.sep)) return { refused: 'outside' }
    if (!fssync.existsSync(target)) return null
    // Тот же случай, что и с `versions[].file`: имя чищено, но по пути может
    // лежать junction, и тогда протокол отдаёт наружу.
    return realInside(id, target) ? { file: target } : { refused: 'outside' }
  }

  function servedFile(id, name) {
    const found = resolveServed(id, name)
    return found && found.file ? found.file : null
  }

  return { add, addFile, update, updateFile, rename, list, readMeta, versionText, archive, servedFile, resolveServed, folderOf, rootDir: () => dir, KINDS }
}

module.exports = { create, KINDS, MAX_VERSIONS, MAX_VIDEO_BYTES, VIDEO_EXTENSIONS, FILENAME }
