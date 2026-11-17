// Скилл как папка, а не как одно поле с текстом.
//
// У Claude и ChatGPT скилл — это каталог: `SKILL.md` с заголовком и указаниями,
// рядом `references/` с подробностями, `data/` с таблицами, `scripts/` с
// вспомогательным кодом. Такой скилл нельзя вставить в однострочное поле: в нём
// главное не текст, а то, что инструкции ссылаются на соседние файлы и читают
// их по мере надобности.
//
// Модуль умеет ровно три вещи: разобрать SKILL.md, положить папку к себе и
// отдавать из неё файлы по одному — с проверкой, что путь не ведёт наружу.
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

// Разумные пределы. Скилл — это инструкция, а не архив с данными: пакет на
// сотни мегабайт лёг бы в память целиком при первом же просмотре.
const MAX_FILES = 300
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_PACK_BYTES = 40 * 1024 * 1024
const ENTRY = 'SKILL.md'

// Папки, которые приносит система контроля версий и окружение. Пользы от них
// скиллу нет, а размер и число файлов они раздувают.
const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', '__pycache__', '.venv', '.idea', '.vscode'])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])

// Заголовок SKILL.md — YAML между двумя строками «---». Полноценный YAML здесь
// не нужен и вреден: лишняя зависимость ради трёх полей. Разбираются простые
// «ключ: значение» и свёрнутые блоки (`>-`, `|`), как их пишут в скиллах.
function parseSkillMd(source) {
  const text = String(source || '').replace(/\r\n/g, '\n')
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return { meta: {}, body: text.trim() }

  const meta = {}
  const lines = match[1].split('\n')
  let key = null
  let folded = []

  const flush = () => {
    if (key) meta[key] = folded.join(' ').replace(/\s+/g, ' ').trim()
    key = null
    folded = []
  }

  for (const line of lines) {
    const head = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (head) {
      flush()
      const value = head[2].trim()
      if (value === '>-' || value === '>' || value === '|' || value === '|-' || value === '') {
        key = head[1]
        folded = []
      } else {
        meta[head[1]] = value.replace(/^["']|["']$/g, '')
      }
      continue
    }
    if (key && /^\s+\S/.test(line)) folded.push(line.trim())
  }
  flush()

  return { meta, body: text.slice(match[0].length).trim() }
}

// Обход папки скилла. Возвращает относительные пути — по ним потом и читаем,
// чтобы наружу не вышел ни один запрос.
function collectFiles(root, current = root, found = []) {
  if (found.length >= MAX_FILES) return found
  let entries = []
  try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return found }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length >= MAX_FILES) break
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(root, path.join(current, entry.name), found)
      continue
    }
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue
    const full = path.join(current, entry.name)
    let size = 0
    try { size = fs.statSync(full).size } catch { continue }
    found.push({ path: path.relative(root, full).split(path.sep).join('/'), bytes: size })
  }
  return found
}

// Путь внутри пакета. Всё, что ведёт наружу — «..», абсолютный путь, диск, —
// отвергается: файлы скилла читает модель, и её выбор пути не доказательство.
function resolveInside(dir, relative) {
  const clean = String(relative || '').split('\\').join('/').replace(/^\/+/, '')
  if (!clean) throw new Error('Пустой путь внутри скилла.')
  const target = path.resolve(dir, clean)
  const root = path.resolve(dir)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Путь ведёт за пределы скилла.')
  }
  return target
}

function slugFor(name, taken = []) {
  const base = String(name || 'skill').toLowerCase()
    .replace(/[^a-z0-9а-яё-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill'
  let slug = base
  let n = 2
  while (taken.includes(slug)) slug = `${base}-${n++}`
  return slug
}

// Чтение папки как скилла: что в ней, годится ли она и что из неё выйдет.
// Ничего не копирует — на это есть importPack.
function inspectPack(sourceDir) {
  const entry = path.join(sourceDir, ENTRY)
  if (!fs.existsSync(entry)) {
    throw new Error(`В папке нет ${ENTRY}. Это не скилл в формате Claude.`)
  }
  const { meta, body } = parseSkillMd(fs.readFileSync(entry, 'utf8'))
  const name = String(meta.name || path.basename(sourceDir)).slice(0, 80)
  const description = String(meta.description || '').slice(0, 1000)
  if (!body.trim()) throw new Error(`${ENTRY} без инструкций: читать нечего.`)

  const files = collectFiles(sourceDir)
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
  if (bytes > MAX_PACK_BYTES) {
    throw new Error(`Скилл весит ${Math.round(bytes / 1048576)} МБ — это больше похоже на архив данных, чем на инструкцию.`)
  }
  return { name, description, body, meta, files, bytes }
}

async function copyTree(from, to) {
  await fsp.mkdir(to, { recursive: true })
  const entries = await fsp.readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await copyTree(path.join(from, entry.name), path.join(to, entry.name))
      continue
    }
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue
    await fsp.copyFile(path.join(from, entry.name), path.join(to, entry.name))
  }
}

// Копия пакета к себе. Скилл, оставленный по чужому пути, однажды исчезнет
// вместе с папкой, из которой его взяли, — и у человека молча пропадёт то, чем
// он пользуется каждый день.
async function importPack(sourceDir, packsRoot, takenSlugs = [], { description } = {}) {
  const info = inspectPack(sourceDir)
  const slug = slugFor(info.name, takenSlugs)
  const target = path.join(packsRoot, slug)
  await fsp.rm(target, { recursive: true, force: true })
  await copyTree(sourceDir, target)
  if (description) {
    const entry = path.join(target, ENTRY)
    const text = await fsp.readFile(entry, 'utf8')
    await fsp.writeFile(entry, require('./skill-sources').withDescription(text, description))
    Object.assign(info, inspectPack(target))
  }
  return { ...info, slug, dir: target }
}

function readPackFile(dir, relative) {
  const target = resolveInside(dir, relative)
  const stat = fs.statSync(target)
  if (!stat.isFile()) throw new Error('Это не файл.')
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`Файл больше ${Math.round(MAX_FILE_BYTES / 1024)} КБ — он не для чтения целиком.`)
  }
  const raw = fs.readFileSync(target)
  // Двоичное содержимое в переписку не идёт: модель получит мусор, а человек —
  // нечитаемую простыню. Картинки и архивы остаются на диске.
  if (raw.includes(0)) throw new Error('Двоичный файл: читать нечего.')
  return raw.toString('utf8')
}

module.exports = {
  ENTRY,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_PACK_BYTES,
  parseSkillMd,
  collectFiles,
  resolveInside,
  slugFor,
  inspectPack,
  importPack,
  readPackFile
}
