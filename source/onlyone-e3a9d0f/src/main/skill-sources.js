// Откуда берётся скилл (макет 21.10, «Новый скилл»): файл, который надо превратить в
// инструкцию, папка или .zip, которые надо проверить до импорта, и папка .onlyone/skills
// проекта — скиллы, которые лежат рядом с кодом и едут с git.
//
// Зависимостей нет: .zip и .docx разбираются здесь же (zip — это центральный каталог и
// deflate, docx — zip с word/document.xml). PDF своими силами не разобрать честно, поэтому
// для него модуль только говорит «нужна модель», а читает его главный процесс через модель.
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { parseSkillMd, collectFiles, slugFor, ENTRY, MAX_FILES, MAX_PACK_BYTES } = require('./skill-packs')
const { tr } = require('./ui-text.cjs')

const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const KINDS = { '.md': 'md', '.markdown': 'md', '.txt': 'txt', '.docx': 'docx', '.pdf': 'pdf' }

// ── zip: центральный каталог в конце файла, данные — store (0) или deflate (8) ──
function readZip(buf) {
  if (buf.length > MAX_PACK_BYTES) throw new Error(tr('Архив больше 40 МБ: это не похоже на скилл.'))
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new Error(tr('Это не .zip: нет оглавления архива.'))
  const count = buf.readUInt16LE(end + 10)
  if (count > MAX_FILES) throw new Error(tr('В архиве слишком много файлов: предел %s.', MAX_FILES))
  let at = buf.readUInt32LE(end + 16)
  const out = []
  let total = 0
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(tr('Архив повреждён: оглавление не сходится.'))
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10)
    const packed = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28)
    const expanded = buf.readUInt32LE(at + 24)
    if (expanded > MAX_SOURCE_BYTES || expanded > MAX_PACK_BYTES - total) throw new Error(tr('Распакованный архив превышает допустимый размер.'))
    const extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42)
    const name = buf.slice(at + 46, at + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1').split('\\').join('/')
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    if (buf.readUInt32LE(local) !== 0x04034b50 || start + packed > buf.length || (flags & 1)) throw new Error(tr('Архив повреждён или защищён паролем.'))
    const raw = buf.slice(start, start + packed)
    let data
    if (method === 0) data = raw
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(MAX_SOURCE_BYTES, MAX_PACK_BYTES - total) })
    else throw new Error(tr('Архив сжат способом %s: такой onlyone не открывает. Пересохраните .zip обычным сжатием.', method))
    if (data.length !== expanded) throw new Error(tr('Размер распакованного файла не совпадает с оглавлением архива.'))
    total += data.length
    out.push({ name, data })
  }
  return out
}

// ── docx → Markdown: заголовки, абзацы, списки; таблица — строками «ячейка, ячейка» ──
const xmlText = s => s.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
function docxToMarkdown(buf) {
  const doc = readZip(buf).find(e => e.name === 'word/document.xml')
  if (!doc) throw new Error(tr('В .docx нет текста документа (word/document.xml).'))
  const xml = doc.data.toString('utf8')
  const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || [, xml])[1]
  const lines = []
  let headings = 0, items = 0, tables = 0
  // По очереди: таблица целиком или абзац
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g
  let m
  while ((m = re.exec(body))) {
    const block = m[0]
    if (block.startsWith('<w:tbl>')) {
      tables++
      for (const row of block.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []) {
        const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(c => xmlText(c).trim()).filter(Boolean)
        if (cells.length) lines.push('- ' + cells.join(', '))
      }
      lines.push('')
      continue
    }
    const text = xmlText(block).trim()
    if (!text) { lines.push(''); continue }
    const style = (block.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || ''
    const level = /^(?:Heading|Заголовок|heading)\s*(\d)/i.exec(style.replace(/(\D)(\d)$/, '$1 $2'))
    if (level || /^Title$/i.test(style)) { headings++; lines.push('', '#'.repeat(Math.min(3, Number(level?.[1] || 1))) + ' ' + text, '') }
    else if (/<w:numPr>/.test(block) || /List/i.test(style)) { items++; lines.push('- ' + text) }
    else lines.push(text, '')
  }
  const md = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { md, headings, items, tables }
}

// Название и «когда брать» из Markdown без шапки: первый заголовок или строка, первый абзац
function guessMeta(md) {
  const blocks = md.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  const head = blocks[0] || ''
  const name = head.replace(/^#+\s*/, '').split('\n')[0].trim().slice(0, 80)
  const para = blocks.slice(1).find(b => !/^(#|- |\* |\d+\. )/.test(b)) || ''
  return { name, description: para.replace(/\s+/g, ' ').slice(0, 300), titleWasHeading: /^#/.test(head), hadPara: Boolean(para) }
}

// Файл → инструкция скилла. found — что куда легло (как в макете «Что распознано»)
async function fileToSkill(file) {
  const ext = path.extname(file).toLowerCase(), kind = KINDS[ext]
  if (!kind) throw new Error(tr('Подойдёт .md, .txt, .pdf или .docx: такой файл onlyone в инструкцию не превращает.'))
  const stat = fs.statSync(file)
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(tr('Файл больше 20 МБ: для инструкции это слишком много.'))
  const base = { kind, file: path.basename(file), bytes: stat.size }
  if (kind === 'pdf') return { ...base, needsModel: true }
  let md, stats = null
  if (kind === 'docx') { stats = docxToMarkdown(fs.readFileSync(file)); md = stats.md }
  else md = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')
  const found = []
  const parsed = parseSkillMd(md)
  let name = parsed.meta.name || '', description = parsed.meta.description || '', body = parsed.body
  if (name || description) found.push({ s: 'ok', b: tr('Шапка SKILL.md'), t: tr('название и описание взяты из неё') })
  const guess = guessMeta(body)
  if (!name) { name = guess.name; if (name) found.push({ s: 'ok', b: guess.titleWasHeading ? tr('Заголовок «%s»', name) : tr('Первая строка «%s»', name), t: tr('стал названием') }) }
  if (!description) {
    description = guess.description
    found.push(description ? { s: 'ok', b: tr('Первый абзац'), t: tr('стал описанием «когда брать»') } : { s: 'warn', b: tr('Описания нет'), t: tr('допишите «когда брать», иначе агент не поймёт, когда его брать') })
  }
  // Строки таблицы в .docx тоже стали пунктами, но шагами они не были: шаги считаем по спискам документа
  const list = stats ? stats.items : (body.match(/^(?:- |\* |\d+\. )/gm) || []).length
  const many = list % 10 === 1 && list % 100 !== 11 ? '%s пункт списка' : list % 10 >= 2 && list % 10 <= 4 && (list % 100 < 12 || list % 100 > 14) ? '%s пункта списка' : '%s пунктов списка'
  if (list) found.push({ s: 'ok', b: tr(many, list), t: tr('стали шагами') })
  if (stats?.tables) found.push({ s: 'warn', b: stats.tables > 1 ? tr('Таблицы (%s)', stats.tables) : tr('Таблица'), t: tr('стала списком: проверьте порядок') })
  if (!body.trim()) throw new Error(tr('В файле нет текста: превращать в инструкцию нечего.'))
  return { ...base, name, description, body, found }
}

// ── Проверка готового скилла до импорта ──
// Пункты: ok — найдено, bad — без этого агент скилл не увидит, info — стоит знать
function checkPackDir(dir) {
  const packFiles = collectFiles(dir)
  if (packFiles.reduce((n, f) => n + f.bytes, 0) > MAX_PACK_BYTES) throw new Error(tr('Папка скилла превышает допустимый размер.'))
  const items = []
  const entry = path.join(dir, ENTRY)
  if (!fs.existsSync(entry)) {
    items.push({ s: 'bad', b: tr('Нет %s', ENTRY), t: tr('в папке должен лежать SKILL.md с шапкой name и description') })
    return { dir, items, ready: false, name: path.basename(dir), description: '' }
  }
  if (fs.statSync(entry).size > MAX_SOURCE_BYTES) throw new Error(tr('Файл больше 20 МБ: для инструкции это слишком много.'))
  const text = fs.readFileSync(entry, 'utf8').replace(/\r\n/g, '\n')
  const { meta, body } = parseSkillMd(text)
  items.push({ s: 'ok', b: ENTRY, t: tr('найден') })
  const head = text.match(/^---\n([\s\S]*?)\n---/)
  const closing = head ? head[0].split('\n').length : 1
  if (meta.name) items.push({ s: 'ok', b: 'name:', t: meta.name })
  else items.push({ s: 'bad', b: tr('Агент не увидит этот скилл.'), t: tr('В шапке нет поля name, строка %s', closing), field: 'name', line: closing })
  if (meta.description) items.push({ s: 'ok', b: 'description:', t: meta.description })
  else items.push({ s: 'bad', b: tr('Агент не увидит этот скилл.'), t: tr('В шапке нет поля description, строка %s', closing), field: 'description', line: closing })
  if (!body.trim()) items.push({ s: 'bad', b: tr('Инструкций нет'), t: tr('после шапки пусто: агенту нечего делать') })
  const files = collectFiles(dir).map(f => f.path)
  const scripts = files.filter(f => /\.(ps1|sh|bat|cmd|js|cjs|mjs|py)$/i.test(f))
  for (const s of scripts.slice(0, 5)) items.push({ s: 'info', b: s, t: tr('агент запустит только с вашего согласия') })
  const other = files.filter(f => f !== ENTRY && !scripts.includes(f))
  if (other.length) items.push({ s: 'ok', b: tr(other.length === 1 ? '%s файл справки' : other.length < 5 ? '%s файла справки' : '%s файлов справки', other.length), t: other.slice(0, 3).join(', ') + (other.length > 3 ? '…' : '') })
  return { dir, items, files, ready: !items.some(x => x.s === 'bad'), name: meta.name || path.basename(dir), description: meta.description || '' }
}

// Папка или .zip. Архив распаковывается во временную папку; в ней ищется папка со SKILL.md
async function checkPackPath(p) {
  const stat = fs.statSync(p)
  if (stat.isDirectory()) return { ...checkPackDir(p), source: p, kind: 'dir' }
  if (path.extname(p).toLowerCase() !== '.zip') throw new Error(tr('Нужна папка скилла или .zip с ней.'))
  if (stat.size > MAX_SOURCE_BYTES * 2) throw new Error(tr('Архив больше 40 МБ: это не похоже на скилл.'))
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-skill-zip-'))
  const cleanup = () => fs.rmSync(target, { recursive: true, force: true })
  try {
  for (const { name, data } of readZip(fs.readFileSync(p))) {
    const clean = name.replace(/^\/+/, '')
    const out = path.resolve(target, clean)
    if (!out.startsWith(path.resolve(target) + path.sep)) continue
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, data)
  }
  // SKILL.md в корне архива или в единственной папке верхнего уровня
  let dir = target
  if (!fs.existsSync(path.join(dir, ENTRY))) {
    const subs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory())
    const hit = subs.find(e => fs.existsSync(path.join(dir, e.name, ENTRY)))
    if (hit) dir = path.join(dir, hit.name)
  }
  return { ...checkPackDir(dir), source: p, kind: 'zip', files: collectFiles(dir).map(f => f.path), cleanup }
  } catch (error) { cleanup(); throw error }
}

// Дописать поле в шапку: перед закрывающей чертой; без шапки — завести её
function withField(text, field, value) {
  const src = String(text || '').replace(/\r\n/g, '\n')
  const line = `${field}: ${String(value).replace(/\s+/g, ' ').trim()}`
  const m = src.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return `---\n${line}\n---\n\n${src}`
  return src.slice(0, m[0].length - 4) + `\n${line}\n---` + src.slice(m[0].length)
}
const withDescription = (text, d) => withField(text, 'description', d)

const skillMd = ({ name, description, body }) => `---\nname: ${String(name).trim()}\ndescription: ${String(description || '').replace(/\s+/g, ' ').trim()}\n---\n\n${String(body || '').trim()}\n`

// ── Скиллы проекта: <папка>/.onlyone/skills — подпапки со SKILL.md и одиночные .md ──
const projectRoot = ws => path.join(ws, '.onlyone', 'skills')
function projectSkillId(ws, slug) {
  let canonical = fs.realpathSync(ws)
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  return 'proj_' + require('crypto').createHash('sha256').update(canonical).digest('hex').slice(0, 16) + '_' + slug
}
function projectSkills(ws, offIds = []) {
  if (!ws) return []
  const root = projectRoot(ws)
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    let file, dir, slug, files
    if (e.isDirectory() && fs.existsSync(path.join(root, e.name, ENTRY))) { dir = path.join(root, e.name); file = path.join(dir, ENTRY); slug = e.name; files = collectFiles(dir).map(f => f.path) }
    else if (e.isFile() && /\.md$/i.test(e.name)) { dir = root; file = path.join(root, e.name); slug = e.name.replace(/\.md$/i, ''); files = [e.name] }
    else continue
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const { meta, body } = parseSkillMd(text)
    const id = projectSkillId(ws, slug)
    const head = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)
    const line = head ? head[0].split('\n').length : 1
    const error = !meta.description ? tr('В шапке нет поля description, строка %s', line) : !meta.name ? tr('В шапке нет поля name, строка %s', line) : ''
    const rel = path.relative(ws, e.isDirectory() ? dir : file).split(path.sep).join('/') + (e.isDirectory() ? '/' : '')
    let updatedAt = 0
    try { updatedAt = fs.statSync(file).mtimeMs } catch {}
    out.push({
      id, name: meta.name || slug, updatedAt, description: meta.description || '', systemPrompt: body, category: 'project',
      enabled: !error && !offIds.includes(id), error,
      pack: { slug, dir, files, entry: path.basename(file) },
      project: { root: ws, rel }
    })
  }
  return out
}
function writeProjectSkill(ws, skill) {
  const root = projectRoot(ws)
  fs.mkdirSync(root, { recursive: true })
  const taken = fs.readdirSync(root)
  const slug = slugFor(skill.name, taken.map(n => n.replace(/\.md$/i, '')))
  const dir = path.join(root, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, ENTRY), skillMd(skill))
  return dir
}

module.exports = { readZip, docxToMarkdown, fileToSkill, checkPackDir, checkPackPath, withField, withDescription, skillMd, projectSkills, projectSkillId, writeProjectSkill, projectRoot, KINDS }
