// Design Components on disk.
//
// A design is a folder under the user's data directory holding one or more
// `Name.dc.html` files plus the runtime that renders them. The file format is
// the handoff's own, so anything written here opens in a plain browser and can
// be handed back to Design unchanged:
//
//   <!DOCTYPE html> … <script src="./dc-runtime.js"></script> …
//   <x-dc>  template  </x-dc>
//   <script type="text/x-dc" data-dc-script data-props="…"> logic class </script>
//
// The three authored pieces are stored as one file rather than three, because
// the file is the deliverable: the user can copy it out and it works.
const { tr } = require('../ui-text.cjs')
const { promises: fs, existsSync, constants } = require('fs')
const { join, basename, dirname, resolve, relative, sep } = require('path')
const { randomUUID } = require('crypto')

const RUNTIME = 'dc-runtime.js'
// Shared by store instances: protect the complete read/modify/write transaction.
const mutations = new Map()
async function withMutation(file, operation) {
  const absolute = resolve(file)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const previous = mutations.get(key) || Promise.resolve()
  const pending = previous.catch(() => {}).then(operation)
  mutations.set(key, pending)
  try { return await pending } finally {
    if (mutations.get(key) === pending) mutations.delete(key)
  }
}

async function atomicWrite(file, bytes) {
  const staged = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(staged, bytes, { flag: 'wx' })
    await renameInto(staged, file)
  } finally {
    await fs.unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

// Windows не отпускает цель переименования мгновенно: антивирус и поисковый
// индекс держат файл сотни миллисекунд, и первая попытка отдаёт EPERM. Данные
// при этом целы — прежняя версия на месте, — поэтому короткое терпение
// дешевле, чем «макет не сохранился» на ровном месте. Ошибку «нет места на
// диске» повторять нечем: она уходит наружу сразу, как и в `artifacts.js`.
const LOCK_PAUSES = [0, 60, 180, 400]
const LOCKED_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function renameInto(staged, target) {
  let last = null
  for (const pause of LOCK_PAUSES) {
    if (pause) await new Promise(resolve => setTimeout(resolve, pause))
    try {
      await fs.rename(staged, target)
      return
    } catch (error) {
      last = error
      if (!LOCKED_CODES.has(error.code)) break
    }
  }
  throw last
}

// Where the runtime is copied from. Kept beside the renderer so one copy ships.
const runtimeSource = join(__dirname, '..', '..', 'renderer', RUNTIME)

const escapeAttr = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const unescapeAttr = value => String(value)
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')

// A name that cannot climb out of its folder or collide with the runtime.
function safeComponentName(path) {
  const name = basename(String(path || '').replace(/\\/g, '/')).trim()
  if (!name || name === '.' || name === '..') throw new Error('Пустое имя компонента.')
  if (name === RUNTIME) throw new Error(`Имя ${RUNTIME} занято средой выполнения.`)
  if (/[<>:"|?*\x00-\x1f]/.test(name)) throw new Error(`Недопустимые символы в имени «${name}».`)
  return name.endsWith('.dc.html') ? name : `${name.replace(/\.html?$/i, '')}.dc.html`
}

// Versions of a component's bytes, kept inside the design folder.
//
// `.dc.html` is the deliverable, not a cache: a person may have written it by
// hand or carried it out of Design, and a targeted edit in the live
// preview overwrites exactly those bytes. Without the previous state one wrong
// replacement is not undoable at all, so the store keeps what was there before
// it wrote. Versions live in a dot-folder rather than beside the components
// because `list()` treats every `*.dc.html` in the design folder as a tab.
const VERSIONS = '.versions'
// A design is edited by hundreds of replacements per session, so versions must
// stop somewhere; keeping only one would make a chain of edits unundoable.
const VERSION_CAP = 20
// Ids sort oldest-first by their own text and are checked before they are ever
// joined onto a path — a version id arrives from the window, where a model wrote
// the page it shows.
const VERSION_ID = /^[0-9]{14}-[0-9a-z]{4,16}$/

// `safeComponentName` takes the basename, so a path handed in by a caller would
// silently collapse onto a real component. These two guards keep an argument
// that claims to name one thing from carrying a directory with it.
function bareComponent(path) {
  const raw = String(path || '')
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes(':')) {
    throw new Error('Компонент задаётся именем без пути.')
  }
  return safeComponentName(raw)
}

function bareVersionId(id) {
  const value = String(id || '')
  if (!VERSION_ID.test(value)) throw new Error('Некорректный идентификатор версии.')
  return value
}

// Закрывающий тег внутри логики закрывает тег скрипта, где бы он ни стоял —
// хоть внутри строки. Браузеры решают это одинаково: слэш экранируют. Для
// JavaScript «<\/script>» и «</script>» — одна и та же строка, поэтому смысл
// логики не меняется, а компонент перестаёт обрезаться на первой же такой
// строке. При чтении экранирование снимается.
const CLOSING_SCRIPT = /<\/(script)/gi
const ESCAPED_SCRIPT = /<\\\/(script)/gi
const hideClosingScript = code => String(code || '').replace(CLOSING_SCRIPT, '<\\/$1')
const showClosingScript = code => String(code || '').replace(ESCAPED_SCRIPT, '</$1')

function assemble({ template = '', logic = '', props = '' }) {
  const propsAttr = props && props.trim() && props.trim() !== '{}'
    ? ` data-props="${escapeAttr(props.trim())}"`
    : ''
  const script = logic && logic.trim()
    ? `<script type="text/x-dc" data-dc-script${propsAttr}>\n${hideClosingScript(logic.trim())}\n</script>\n`
    : (propsAttr ? `<script type="text/x-dc" data-dc-script${propsAttr}></script>\n` : '')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="./${RUNTIME}"></script>
</head>
<body>
<x-dc>
${template.trim()}
</x-dc>
${script}</body>
</html>
`
}

// Pulls the three authored pieces back out of a file, so an edit can be applied
// to one of them without disturbing the others.
function parse(source) {
  const text = String(source || '')
  const open = text.indexOf('<x-dc>')
  const close = text.lastIndexOf('</x-dc>')
  const template = open >= 0 && close > open
    ? text.slice(open + '<x-dc>'.length, close).trim()
    : ''

  const scriptMatch = text.match(/<script type="text\/x-dc" data-dc-script([^>]*)>([\s\S]*?)<\/script>/)
  const logic = scriptMatch ? showClosingScript(scriptMatch[2].trim()) : ''

  let props = ''
  const propsMatch = (scriptMatch?.[1] || '').match(/data-props="([^"]*)"/)
  if (propsMatch) props = unescapeAttr(propsMatch[1])

  return { template, logic, props }
}

// Референсы лежат в отдельной папке внутри дизайна: их отдаёт та же схема
// onecode-design://, поэтому макет может ссылаться на приложенную картинку как
// на обычный файл рядом с собой — `refs/logo.png`.
const REFS = 'refs'

// Расширения, которые имеет смысл показывать модели как текст. Всё остальное
// (картинки, шрифты, бинарники) она может только положить в макет по имени.
const TEXTUAL = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.yml', '.yaml',
  '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.svg', '.xml', '.ini', '.toml', '.log'])

const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico'])

// Имя внутри refs/: подпапки разрешены, потому что распакованный архив — это
// дерево, но выйти за пределы refs/ нельзя ничем.
// Windows отказывает в пути длиннее ~260 символов, и отказ приходит как
// «ENOENT: no such file or directory» с полным путём — по этой строке нельзя
// понять ни что случилось, ни что делать. Имя из архива или из буфера вполне
// может быть таким, поэтому длина ограничивается здесь, а не выясняется у
// файловой системы.
const MAX_SEGMENT = 96
const MAX_REF_PATH = 200

function shortenSegment(part) {
  if (part.length <= MAX_SEGMENT) return part
  const dot = part.lastIndexOf('.')
  const ext = dot > 0 && part.length - dot <= 12 ? part.slice(dot) : ''
  return part.slice(0, MAX_SEGMENT - ext.length) + ext
}

// Хвост обрезанного текста: незавершённая пара суррогатов или битый конец
// последовательности UTF-8. Отдать их модели — значит показать «мусор» там,
// где честно сказать про границу.
function trimPartialTail(text) {
  let out = String(text || '')
  while (out.length && (out.endsWith('\uFFFD') || /[\uD800-\uDBFF]$/.test(out))) out = out.slice(0, -1)
  return out
}

function safeRefName(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/')
    .map(part => part.trim())
    .filter(part => part && part !== '.' && part !== '..')
    .map(part => part.replace(/[<>:"|?*\u0000-\u001f]/g, '_'))
    .map(shortenSegment)
  if (!parts.length) throw new Error('Пустое имя файла.')
  const joined = parts.join('/')
  if (joined.length > MAX_REF_PATH) {
    throw new Error(`Слишком длинный путь внутри архива: «${joined.slice(0, 60)}…». Распакуйте его и приложите нужные файлы.`)
  }
  return joined
}

class DesignStore {
  constructor(root, options = {}) {
    this.root = root
    this.options = options
    this.protect = typeof options.protect === 'function' ? options.protect : null
    this.unprotect = typeof options.unprotect === 'function' ? options.unprotect : null
    this.pendingEnsure = new Map()
    this.versionSeq = 0
  }

  folder(designId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(designId || ''))) {
      throw new Error('Некорректный идентификатор дизайна.')
    }
    return join(this.root, designId)
  }

  async ensure(designId) {
    const key = this.folder(designId)
    if (this.pendingEnsure.has(key)) return this.pendingEnsure.get(key)
    const pending = this.installRuntime(designId)
    this.pendingEnsure.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.pendingEnsure.get(key) === pending) this.pendingEnsure.delete(key)
    }
  }

  async installRuntime(designId) {
    const dir = this.folder(designId)
    await fs.mkdir(dir, { recursive: true })
    // The runtime is copied in, not linked: a design folder the user zips up and
    // sends to someone else has to render on its own.
    const assets = [[runtimeSource, RUNTIME], ...['react.production.min.js', 'react-dom.production.min.js', 'react-LICENSE.txt', 'react-dom-LICENSE.txt']
      .map(asset => [join(dirname(runtimeSource), 'vendor', asset), asset])]
    for (const [source, name] of assets) {
      const target = join(dir, name)
      const bytes = await fs.readFile(source)
      const installed = await fs.readFile(target).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (installed?.equals(bytes)) continue
      // Never truncate a script while the preview is fetching it. Readers see
      // the complete old version or the complete new one, including on reopen.
      const staged = join(dir, `.${name}.${randomUUID()}.tmp`)
      try {
        await fs.writeFile(staged, bytes, { flag: 'wx' })
        await renameInto(staged, target)
      } finally {
        await fs.unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
    }
    return dir
  }

  async list(designId) {
    const dir = this.folder(designId)
    if (!existsSync(dir)) return []
    await this.ensure(designId)
    const names = await fs.readdir(dir)
    return names.filter(n => n.endsWith('.dc.html')).sort()
  }

  async read(designId, path) {
    const name = safeComponentName(path)
    const file = join(this.folder(designId), name)
    if (!existsSync(file)) throw new Error(`Компонент «${name}» не найден.`)
    const raw = await fs.readFile(file, 'utf8')
    let source = raw
    let parsed
    try { parsed = JSON.parse(raw) } catch { /* legacy component */ }
    const encrypted = parsed && parsed.enc === 'safeStorage'
    if (encrypted) {
      if (!this.unprotect || typeof parsed.data !== 'string') throw new Error(tr('Расшифровка макета недоступна.'))
      source = this.unprotect(parsed.data)
    }
    const needsMigration = !encrypted && Boolean(this.protect)
    if (needsMigration && this.protect) {
      try {
        const payload = JSON.stringify({ enc: 'safeStorage', data: this.protect(source) })
        await atomicWrite(file, payload)
      } catch { /* best effort migration */ }
    }
    return { name, ...parse(source) }
  }

  async setEntry(designId, path) {
    const name = safeComponentName(path)
    await this.read(designId, name)
    await fs.writeFile(join(this.folder(designId), 'entry.json'), JSON.stringify({ name }), 'utf8')
    return { name }
  }

  async getEntry(designId) {
    const dir = this.folder(designId)
    try {
      const { name } = JSON.parse(await fs.readFile(join(dir, 'entry.json'), 'utf8'))
      if (name === safeComponentName(name) && existsSync(join(dir, name))) return name
    } catch { /* Older designs have no entry manifest. */ }
    const files = existsSync(dir) ? await fs.readdir(dir) : []
    return files.filter(n => n.endsWith('.dc.html')).sort().find(n => /index|landing|home|page|главн/i.test(n)) || ''
  }

  async write(designId, path, pieces) {
    return withMutation(join(this.folder(designId), safeComponentName(path)),
      () => this.writeUnlocked(designId, path, pieces))
  }

  async writeUnlocked(designId, path, pieces) {
    const name = safeComponentName(path)
    const dir = await this.ensure(designId)
    await this.keepVersion(designId, name)
    const content = assemble(pieces)
    let payload = content
    if (this.protect) {
      payload = JSON.stringify({ enc: 'safeStorage', data: this.protect(content) })
    }
    await atomicWrite(join(dir, name), payload)
    return { name }
  }

  // What is about to be overwritten is saved first, so a caller that refuses to
  // write (text not found, ambiguous match) never leaves behind a version of a
  // state that did not exist. Callers hold the mutation lock for this file.
  async keepVersion(designId, name) {
    const dir = join(this.folder(designId), VERSIONS, name)
    let previous
    try {
      previous = await fs.readFile(join(this.folder(designId), name))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    await fs.mkdir(dir, { recursive: true })
    const id = `${String(Date.now()).padStart(14, '0')}-` +
      `${(this.versionSeq = (this.versionSeq + 1) % 46656).toString(36).padStart(4, '0')}` +
      `${randomUUID().replace(/-/g, '').slice(0, 4)}`
    let bytesToWrite = previous
    if (this.protect) {
      try {
        const parsed = JSON.parse(previous.toString('utf8'))
        if (!parsed || parsed.enc !== 'safeStorage') {
          bytesToWrite = Buffer.from(JSON.stringify({ enc: 'safeStorage', data: this.protect(previous.toString('utf8')) }), 'utf8')
        }
      } catch {
        bytesToWrite = Buffer.from(JSON.stringify({ enc: 'safeStorage', data: this.protect(previous.toString('utf8')) }), 'utf8')
      }
    }
    // `wx`: two versions written in the same millisecond must not eat each other.
    await fs.writeFile(join(dir, `${id}.html`), bytesToWrite, { flag: 'wx' })
    const kept = (await fs.readdir(dir))
      .filter(entry => VERSION_ID.test(entry.replace(/\.html$/i, '')))
      .sort()
    for (const entry of kept.slice(0, Math.max(0, kept.length - VERSION_CAP))) {
      await fs.rm(join(dir, entry), { force: true })
    }
    return id
  }

  async listVersions(designId, path) {
    const name = bareComponent(path)
    const dir = join(this.folder(designId), VERSIONS, name)
    let entries
    try {
      entries = await fs.readdir(dir)
    } catch (error) {
      // A component nobody has edited yet has no versions — that is not an
      // error, and Ctrl+Z on a fresh design has to be able to ask.
      if (error.code === 'ENOENT') return []
      throw error
    }
    return entries
      .filter(entry => /\.html$/i.test(entry) && VERSION_ID.test(entry.replace(/\.html$/i, '')))
      .map(entry => ({ id: entry.replace(/\.html$/i, ''), file: entry }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async restoreVersion(designId, path, version) {
    const name = bareComponent(path)
    const id = bareVersionId(version)
    const dir = join(this.folder(designId), VERSIONS, name)
    const source = join(dir, `${id}.html`)
    // The id is validated, and then resolved anyway: a name that survives the
    // first check must still be shown to live inside this design's own folder.
    const root = resolve(this.folder(designId)) + sep
    if (!resolve(source).startsWith(root)) {
      throw new Error('Версия лежит вне этого дизайна.')
    }
    let bytes
    try {
      bytes = await fs.readFile(source)
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Версия «${id}» этого компонента не найдена.`)
      throw error
    }
    if (this.protect) {
      try {
        const parsed = JSON.parse(bytes.toString('utf8'))
        if (!parsed || parsed.enc !== 'safeStorage') {
          bytes = Buffer.from(JSON.stringify({ enc: 'safeStorage', data: this.protect(bytes.toString('utf8')) }), 'utf8')
        }
      } catch {
        bytes = Buffer.from(JSON.stringify({ enc: 'safeStorage', data: this.protect(bytes.toString('utf8')) }), 'utf8')
      }
    }
    return withMutation(join(this.folder(designId), name), async () => {
      // Restoring is itself a destructive write: what it replaces is kept, so a
      // step back stays cancellable by a step forward.
      await this.keepVersion(designId, name)
      await atomicWrite(join(this.folder(designId), name), bytes)
      return { name, restored: id }
    })
  }

  // One exact, unique run of text. Ambiguity is refused rather than guessed at:
  // silently editing the first of three matches is how a design loses a section
  // nobody asked to change.
  async replace(designId, path, part, oldStr, newStr) {
    return withMutation(join(this.folder(designId), safeComponentName(path)), async () => {
      const current = await this.read(designId, path)
      const before = current[part] || ''
      if (!oldStr) throw new Error('Пустая строка для замены.')
      const count = before.split(oldStr).length - 1
      if (count === 0) throw new Error(`Текст не найден в ${part === 'template' ? 'разметке' : 'логике'}.`)
      if (count > 1) throw new Error(`Текст встречается ${count} раза — уточните фрагмент, чтобы он был единственным.`)
      const next = { ...current, [part]: before.split(oldStr).join(newStr) }
      await this.writeUnlocked(designId, path, next)
      return { name: current.name, replaced: 1 }
    })
  }

  async setProps(designId, path, props) {
    return withMutation(join(this.folder(designId), safeComponentName(path)), async () => {
      const current = await this.read(designId, path)
      await this.writeUnlocked(designId, path, { ...current, props })
      return { name: current.name }
    })
  }

  async remove(designId, path) {
    const name = safeComponentName(path)
    const file = join(this.folder(designId), name)
    await withMutation(file, () => Promise.all([
      fs.rm(file, { force: true }),
      // History of a component nobody can open any more is not a safety net, it
      // is the person's work left behind in the profile.
      fs.rm(join(this.folder(designId), VERSIONS, name), { recursive: true, force: true })
    ]))
    return { name }
  }

  refsFolder(designId) {
    return join(this.folder(designId), REFS)
  }

  // Каноническая граница папки refs. Лексически имя уже вычищено
  // (`safeRefName`), но внутри папки может лежать junction или symlink на
  // чужой каталог — тогда `join(refs, 'portal/secret.txt')` уводит наружу, и
  // чтение отдаёт чужой файл, а запись пишет в чужую папку. Проверяется
  // самый глубокий существующий элемент пути: если его реальный путь не внутри
  // refs, операция запрещена.
  async refInside(designId, name, { mustExist = false } = {}) {
    const dir = this.refsFolder(designId)
    let root = null
    try {
      root = await fs.realpath(dir)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (mustExist) throw new Error(`Папки референсов нет.`)
      return { root: null, target: null }
    }
    const storeRoot = await fs.realpath(this.root)
    const designRoot = await fs.realpath(this.folder(designId))
    if (!designRoot.startsWith(storeRoot + sep) || !root.startsWith(designRoot + sep)) {
      throw new Error(tr('Папка референсов выводит за пределы макета.'))
    }
    if (name == null) return { root, target: null }
    const parts = safeRefName(name).split('/')
    const target = join(root, ...parts)
    let probe = target
    for (;;) {
      let real = null
      try {
        real = await fs.realpath(probe)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        const parent = dirname(probe)
        if (parent === probe) break
        probe = parent
        continue
      }
      const inside = real === root || real.startsWith(root + sep)
      if (!inside) throw new Error(`«${parts.join('/')}» выводит за пределы папки референсов этого макета.`)
      break
    }
    if (mustExist) {
      try { await fs.stat(target) } catch { throw new Error(`Референс «${parts.join('/')}» не найден.`) }
    }
    return { root, target }
  }

  // Кладёт файл в refs/. Возвращает имя, под которым он лёг: одинаковые имена не
  // затирают друг друга, потому что референс — это то, что пользователь принёс,
  // и потерять его молча нельзя.
  async addRef(designId, sourcePath, suggestedName) {
    await this.ensure(designId)
    const dir = this.refsFolder(designId)
    await fs.mkdir(dir, { recursive: true })
    const wanted = safeRefName(suggestedName || basename(sourcePath))
    const rawBuf = await fs.readFile(sourcePath)
    let payload = rawBuf
    if (this.protect) {
      payload = JSON.stringify({
        enc: 'safeStorage',
        data: this.protect(rawBuf.toString('base64')),
        b64: true
      })
    }
    for (let attempt = 0; attempt < 1000; attempt++) {
      const name = await this.freeRefName(dir, wanted)
      const { target } = await this.refInside(designId, name)
      await fs.mkdir(dirname(target), { recursive: true })
      try {
        await fs.writeFile(target, payload, { flag: 'wx' })
      } catch (error) {
        if (error.code === 'EEXIST') continue
        throw error
      }
      return { name, size: rawBuf.length, kind: refKind(name) }
    }
    throw new Error('Слишком много одновременных загрузок с одинаковым именем.')
  }

  async writeRef(designId, name, bytes) {
    await this.ensure(designId)
    const dir = this.refsFolder(designId)
    await fs.mkdir(dir, { recursive: true })
    const safe = safeRefName(name)
    const rawBuf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    let payload = rawBuf
    if (this.protect) {
      payload = JSON.stringify({
        enc: 'safeStorage',
        data: this.protect(rawBuf.toString('base64')),
        b64: true
      })
    }
    for (let attempt = 0; attempt < 1000; attempt++) {
      const stored = await this.freeRefName(dir, safe)
      const { target } = await this.refInside(designId, stored)
      await fs.mkdir(dirname(target), { recursive: true })
      let handle = null
      try {
        handle = await fs.open(target, 'wx')
        await handle.writeFile(payload)
        await handle.close()
        handle = null
        return { name: stored, size: rawBuf.length, kind: refKind(stored) }
      } catch (error) {
        if (handle) await handle.close().catch(() => {})
        if (error && error.code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error('Слишком много файлов с одинаковым именем.')
  }

  async freeRefName(dir, wanted) {
    if (!existsSync(join(dir, wanted))) return wanted
    const dot = wanted.lastIndexOf('.')
    const stem = dot > 0 ? wanted.slice(0, dot) : wanted
    const ext = dot > 0 ? wanted.slice(dot) : ''
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem} (${i})${ext}`
      if (!existsSync(join(dir, candidate))) return candidate
    }
    throw new Error('Слишком много файлов с одинаковым именем.')
  }

  async listRefs(designId) {
    const dir = this.refsFolder(designId)
    if (!existsSync(dir)) return []
    // Список обходит канонический корень: запись, реальный путь которой ушёл
    // наружу (junction внутри refs), в него не попадает — иначе модель
    // увидела бы чужие файлы как свои референсы.
    const { root } = await this.refInside(designId)
    const out = []
    const walk = async (rel) => {
      const here = rel ? join(root, rel) : root
      for (const entry of await fs.readdir(here, { withFileTypes: true })) {
        const next = rel ? `${rel}/${entry.name}` : entry.name
        const target = join(root, next)
        const real = await fs.realpath(target).catch(() => null)
        if (!real || (real !== root && !real.startsWith(root + sep))) continue
        if (entry.isDirectory()) { await walk(next); continue }
        const info = await fs.stat(target)
        out.push({ name: next, size: info.size, kind: refKind(next) })
      }
    }
    await walk('')
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async readRef(designId, name, limit = 200000) {
    const safe = safeRefName(name)
    // Граница проверяется до чтения: `portal/secret.txt`, где `portal` —
    // junction на чужую папку, лексически выглядит безобидно.
    const { target: file } = await this.refInside(designId, safe, { mustExist: true })
    if (refKind(safe) !== 'text') {
      throw new Error(`«${safe}» — не текстовый файл. Сослаться на него в макете можно как refs/${safe}, прочитать содержимым нельзя.`)
    }
    const rawBuf = await fs.readFile(file)
    let text = ''
    let totalBytes = rawBuf.length
    let parsed
    try { parsed = JSON.parse(rawBuf.toString('utf8')) } catch { /* legacy reference */ }
    const encrypted = parsed && parsed.enc === 'safeStorage'
    if (encrypted) {
      if (!this.unprotect || typeof parsed.data !== 'string') throw new Error(tr('Расшифровка референса недоступна.'))
      const decrypted = this.unprotect(parsed.data)
      const buf = parsed.b64 ? Buffer.from(decrypted, 'base64') : Buffer.from(decrypted, 'utf8')
      text = buf.toString('utf8')
      totalBytes = buf.length
    } else text = rawBuf.toString('utf8')
    const needsMigration = !encrypted && Boolean(this.protect)

    if (needsMigration && this.protect) {
      try {
        const payload = JSON.stringify({
          enc: 'safeStorage',
          data: this.protect(rawBuf.toString('base64')),
          b64: true
        })
        await fs.writeFile(file, payload)
      } catch { /* best effort migration */ }
    }

    const shown = trimPartialTail(text.slice(0, limit))
    return {
      name: safe,
      text: shown,
      truncated: shown.length < text.length,
      bytes: totalBytes,
      toString() { return shown }
    }
  }

  async removeRef(designId, name) {
    const safe = safeRefName(name)
    const { target: file } = await this.refInside(designId, safe)
    if (existsSync(file)) {
      // `recursive: true` от папки refs снимает всё дерево: имя `sub` — это
      // каталог, а не файл, и за него человек просил убрать один референс.
      const info = await fs.stat(file)
      if (info.isDirectory()) throw new Error(`«${safe}» — папка, а не файл. Уберите референсы из неё по одному.`)
      await fs.rm(file, { force: true })
    }
    return { name: safe }
  }

  // Выгрузка (Н83): сохранение экспортированных файлов (.png, .pdf) в папке дизайна
  // с безопасным шифрованием safeStorage при его наличии.
  async writeExport(designId, name, bytes) {
    await this.ensure(designId)
    const dir = this.folder(designId)
    const safe = basename(String(name || '').replace(/\\/g, '/')).trim()
    if (!safe || safe === '.' || safe === '..') throw new Error('Некорректное имя файла выгрузки.')
    const rawBuf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    let payload = rawBuf
    if (this.protect) {
      payload = Buffer.from(JSON.stringify({
        enc: 'safeStorage',
        data: this.protect(rawBuf.toString('base64')),
        b64: true
      }), 'utf8')
    }
    const file = join(dir, safe)
    await atomicWrite(file, payload)
    return { file, bytes: rawBuf.length }
  }

  async readExport(designId, name) {
    const safe = basename(String(name || '').replace(/\\/g, '/')).trim()
    const file = join(this.folder(designId), safe)
    const bytes = await fs.readFile(file)
    if (this.unprotect) {
      try {
        const parsed = JSON.parse(bytes.toString('utf8'))
        if (parsed && parsed.enc === 'safeStorage' && parsed.data) {
          const decrypted = this.unprotect(parsed.data)
          return parsed.b64 ? Buffer.from(decrypted, 'base64') : Buffer.from(decrypted, 'utf8')
        }
      } catch {}
    }
    return bytes
  }

  async removeDesign(designId) {
    const dir = this.folder(designId)
    if (existsSync(dir)) await fs.rm(dir, { recursive: true, force: true })
  }
}

function refKind(name) {
  const dot = String(name).lastIndexOf('.')
  const ext = dot > 0 ? String(name).slice(dot).toLowerCase() : ''
  if (IMAGES.has(ext)) return 'image'
  if (TEXTUAL.has(ext)) return 'text'
  if (ext === '.zip') return 'archive'
  return 'binary'
}

module.exports = { DesignStore, assemble, parse, safeComponentName, safeRefName, refKind, RUNTIME, REFS, MAX_SEGMENT, MAX_REF_PATH }
