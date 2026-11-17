'use strict'

// Лёгкая карта символов проекта: функции, классы, константы, экспорты, IPC-каналы. Агент не знал структуры проекта и тратил
// 5–7 шагов на слепые search_files/list_files. Разбор построчный, по шаблонам, без настоящего AST: быстрее, не падает на
// чужом синтаксисе и не тянет зависимостей. Карта отдаётся по требованию (инструмент find_symbol), а не постоянным блоком в
// промпте: на моделях без кэша префикса постоянный блок платился бы на каждом шаге хода.
const fs = require('node:fs/promises')
const path = require('node:path')
const { SKIP_DIRS } = require('./workspace-search')

const EXT_LANG = {
  '.js': 'js', '.cjs': 'js', '.mjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js',
  '.py': 'py', '.go': 'go', '.rs': 'rs'
}
const MAX_FILES = 4000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 24 * 1024 * 1024
const MAX_LINE = 600

const NAME = '([A-Za-z_$][\\w$]*)'
const RULES = {
  js: [
    { kind: 'function', re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${NAME}\\s*\\(`) },
    { kind: 'class', re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${NAME}`) },
    { kind: 'function', re: new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${NAME}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|${NAME})\\s*=>`) },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=/ },
    { kind: 'type', re: new RegExp(`^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+${NAME}`) },
    { kind: 'ipc', re: /\bipcMain\.(?:handle|on|once)\(\s*['"`]([^'"`]+)['"`]/ }
  ],
  py: [
    { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ },
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ }
  ],
  go: [
    { kind: 'function', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/ },
    { kind: 'class', re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/ }
  ],
  rs: [
    { kind: 'function', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: 'class', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/ }
  ]
}

// Имена, которые файл отдаёт наружу: module.exports = { a, b }, exports.x = …, export { a, b }.
function exportedNames(text) {
  const names = new Set()
  for (const m of text.matchAll(/module\.exports\s*=\s*\{([^}]{0,1500})\}/g)) {
    for (const part of m[1].split(',')) { const n = part.split(':')[0].trim().replace(/^\.\.\./, ''); if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n) }
  }
  for (const m of text.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1])
  for (const m of text.matchAll(/\bexport\s*\{([^}]{0,1500})\}/g)) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/)[0]; if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n) }
  }
  return names
}

function symbolsOf(text, lang) {
  const out = []
  const exported = lang === 'js' ? exportedNames(text) : new Set()
  const rules = RULES[lang] || []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.length > MAX_LINE) continue
    for (const { kind, re } of rules) {
      const m = re.exec(line)
      if (!m) continue
      out.push({ name: m[1], kind, line: i + 1, exported: exported.has(m[1]) || /^\s*export\b/.test(line) })
      break
    }
  }
  return out
}

async function* walk(dir, signal) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (signal && signal.aborted) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) yield* walk(full, signal) }
    else if (entry.isFile() && EXT_LANG[path.extname(entry.name).toLowerCase()]) yield full
  }
}

async function buildIndex({ root, signal } = {}) {
  const started = Date.now()
  const index = { root, files: [], symbols: [], truncated: false, ms: 0 }
  let total = 0
  let seen = 0
  for await (const file of walk(root, signal)) {
    if (index.files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) { index.truncated = true; break }
    let buffer
    try {
      const stat = await fs.stat(file)
      if (stat.size > MAX_FILE_BYTES) continue
      buffer = await fs.readFile(file)
    } catch { continue }
    if (buffer.subarray(0, 2048).includes(0)) continue // двоичный файл
    total += buffer.length
    const rel = path.relative(root, file).split(path.sep).join('/')
    index.files.push(rel)
    const lang = EXT_LANG[path.extname(file).toLowerCase()]
    for (const symbol of symbolsOf(buffer.toString('utf8'), lang)) index.symbols.push({ ...symbol, file: rel, lower: symbol.name.toLowerCase() })
    if (++seen % 40 === 0) await new Promise(resolve => setImmediate(resolve)) // окно не должно замирать на большом проекте
  }
  index.ms = Date.now() - started
  return index
}

// Точное имя, затем начало, затем часть; регистр не важен; внутри ранга — по файлу и строке.
function findSymbols(index, query, { kind = '', limit = 30 } = {}) {
  const q = String(query == null ? '' : query).trim().toLowerCase()
  if (!q || !index) return []
  const ranked = []
  for (const symbol of index.symbols) {
    if (kind && symbol.kind !== kind) continue
    const at = symbol.lower === q ? 0 : symbol.lower.startsWith(q) ? 1 : symbol.lower.includes(q) ? 2 : -1
    if (at >= 0) ranked.push({ at, symbol })
  }
  ranked.sort((a, b) => (a.at - b.at) || (a.symbol.file < b.symbol.file ? -1 : a.symbol.file > b.symbol.file ? 1 : 0) || (a.symbol.line - b.symbol.line))
  return ranked.slice(0, Math.max(1, Math.min(Number(limit) || 30, 100)))
    .map(({ symbol }) => ({ name: symbol.name, kind: symbol.kind, file: symbol.file, line: symbol.line, exported: symbol.exported }))
}

// «файл: символы» — скелет проекта в пределах `maxChars` (1200 токенов ≈ 4000 знаков). Файлы с большим числом экспортов — первыми.
function skeleton(index, { maxChars = 4000, perFile = 8 } = {}) {
  if (!index) return ''
  const byFile = new Map()
  for (const symbol of index.symbols) {
    if (symbol.kind === 'const' && !symbol.exported) continue
    if (!byFile.has(symbol.file)) byFile.set(symbol.file, [])
    byFile.get(symbol.file).push(symbol)
  }
  const files = [...byFile.entries()].map(([file, list]) => ({ file, list, weight: list.filter(s => s.exported).length }))
    .sort((a, b) => (b.weight - a.weight) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const lines = []
  let size = 0
  for (const { file, list } of files) {
    const picked = [...list].sort((a, b) => (Number(b.exported) - Number(a.exported)) || (a.line - b.line)).slice(0, perFile)
    const line = `${file}: ` + picked.map(s => (s.kind === 'function' ? `${s.name}()` : s.kind === 'ipc' ? `ipc:${s.name}` : s.name)).join(', ')
    if (size + line.length + 1 > maxChars) break
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n').slice(0, maxChars)
}

// Кэш по корню: карта строится один раз на проект; правки файлов сбрасывают её, иначе номера строк врали бы.
const cache = new Map()
async function getIndex(root, signal) {
  const cached = cache.get(root)
  if (cached) return cached
  const built = await buildIndex({ root, signal })
  // Прерванный обход даёт неполный индекс — в кэш не кладём, иначе «символа нет»
  // на существующую функцию живёт до первой правки (Н18).
  if (!(signal && signal.aborted)) cache.set(root, built)
  return built
}
function invalidateAll() { cache.clear() }

module.exports = { buildIndex, findSymbols, skeleton, getIndex, invalidateAll }
