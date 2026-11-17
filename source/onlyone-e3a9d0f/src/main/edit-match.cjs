'use strict'

// Точечная правка файла: «замени этот фрагмент на тот».
//
// Раньше у агента был только write_file — файл целиком. Ради одной строки модель присылала и оплачивала весь файл,
// упиралась в предел ответа и обрывала вызов на середине содержимого, а читающий диф человек видел правку целого файла.
// Здесь вся логика поиска, отдельно от файловой системы и окна, чтобы её можно было проверить без них.
//
// Порядок поиска — от строгого к мягкому, и каждый шаг применяется, только если нашёл фрагмент ровно в одном месте:
//   exact       — слово в слово (и с окончаниями строк файла, если файл с CRLF);
//   whitespace  — построчно, без хвостовых пробелов и \r;
//   indent      — построчно, без отступов; новый текст получает отступ файла.
// Неоднозначное совпадение никогда не заменяется «в первом попавшемся месте»: это правка не того кода.

function toCrlf (text) { return text.replace(/\r?\n/g, '\r\n') }
const stripCr = line => line.replace(/\r$/, '')

function lineAt (content, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++
  return line
}

function positionsOf (content, needle) {
  const found = []
  let from = 0
  while (from <= content.length - needle.length) {
    const at = content.indexOf(needle, from)
    if (at < 0) break
    found.push(at)
    from = at + needle.length
  }
  return found
}

function leadingSpace (line) { return (/^[ \t]*/.exec(line) || [''])[0] }

function applyExact (content, oldStr, newStr, replaceAll) {
  const variants = [[oldStr, newStr]]
  if (content.includes('\r\n') && oldStr.includes('\n') && !oldStr.includes('\r\n')) variants.push([toCrlf(oldStr), toCrlf(newStr)])
  for (const [needle, replacement] of variants) {
    const at = positionsOf(content, needle)
    if (!at.length) continue
    if (at.length > 1 && !replaceAll) {
      return { ok: false, reason: 'ambiguous', count: at.length, lines: at.slice(0, 8).map(index => lineAt(content, index)) }
    }
    let out = ''
    let last = 0
    for (const index of at) {
      out += content.slice(last, index) + replacement
      last = index + needle.length
    }
    out += content.slice(last)
    return { ok: true, content: out, replacements: at.length, how: 'exact', line: lineAt(content, at[0]) }
  }
  return null
}

function applyByLines (content, oldStr, newStr, strategy) {
  const fileLines = content.split('\n')
  let oldLines = oldStr.split(/\r?\n/)
  let newLines = newStr.split(/\r?\n/)
  // Фрагмент, оканчивающийся переводом строки, не требует от файла пустой строки после себя.
  if (oldLines.length > 1 && oldLines[oldLines.length - 1] === '') {
    oldLines = oldLines.slice(0, -1)
    if (newLines.length > 1 && newLines[newLines.length - 1] === '') newLines = newLines.slice(0, -1)
  }
  const norm = strategy === 'indent'
    ? line => stripCr(line).trim()
    : line => stripCr(line).replace(/[ \t]+$/, '')
  const wanted = oldLines.map(norm)
  const starts = []
  for (let i = 0; i + wanted.length <= fileLines.length; i++) {
    let same = true
    for (let j = 0; j < wanted.length; j++) {
      if (norm(fileLines[i + j]) !== wanted[j]) { same = false; break }
    }
    if (same) starts.push(i)
  }
  if (!starts.length) return null
  if (starts.length > 1) return { ok: false, reason: 'ambiguous', count: starts.length, lines: starts.slice(0, 8).map(i => i + 1) }

  const start = starts[0]
  const end = start + oldLines.length
  const region = fileLines.slice(start, end)

  // Строки, которые модель не меняла (одинаковы в «было» и «стало»), остаются как в файле: с их отступом и пробелами.
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (tail < oldLines.length - head && tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++

  const middle = newLines.slice(head, newLines.length - tail)
  const fileIndent = leadingSpace(region[0])
  const oldIndent = leadingSpace(oldLines[0])
  const reindent = line => {
    if (strategy !== 'indent' || !line.trim()) return line
    return line.startsWith(oldIndent) ? fileIndent + line.slice(oldIndent.length) : line
  }
  const crFirst = region[0].endsWith('\r')
  const crLast = region[region.length - 1].endsWith('\r')
  const rebuilt = middle.map((line, index) => {
    const last = index === middle.length - 1 && tail === 0
    return reindent(line) + ((last ? crLast : crFirst) ? '\r' : '')
  })

  const out = [
    ...fileLines.slice(0, start),
    ...region.slice(0, head),
    ...rebuilt,
    ...region.slice(region.length - tail),
    ...fileLines.slice(end)
  ]
  return { ok: true, content: out.join('\n'), replacements: 1, how: strategy, line: start + 1 }
}

function applyEdit (content, oldStr, newStr, { replaceAll = false } = {}) {
  content = String(content ?? '')
  oldStr = String(oldStr ?? '')
  newStr = String(newStr ?? '')
  if (!oldStr.length) return { ok: false, reason: 'empty' }
  if (oldStr === newStr) return { ok: false, reason: 'same' }

  const exact = applyExact(content, oldStr, newStr, replaceAll)
  if (exact) return exact

  for (const strategy of ['whitespace', 'indent']) {
    const found = applyByLines(content, oldStr, newStr, strategy)
    if (found) return found
  }
  return { ok: false, reason: 'missing' }
}

// Когда фрагмента нет, самое дорогое — перечитывать файл целиком. Ближайшая строка с номером и тремя строками вокруг
// позволяет повторить правку адресно.
function nearestHint (content, oldStr) {
  const first = String(oldStr || '').split(/\r?\n/).map(line => line.trim()).find(Boolean)
  if (!first) return null
  const lines = String(content || '').split('\n').map(stripCr)
  let index = lines.findIndex(line => line.trim() === first)
  if (index < 0) {
    const probe = first.slice(0, Math.min(first.length, 24))
    if (probe.length >= 6) index = lines.findIndex(line => line.includes(probe))
  }
  if (index < 0) return null
  const preview = lines.slice(index, index + 4).map((line, i) => `${index + 1 + i}: ${line}`).join('\n').slice(0, 500)
  return { line: index + 1, preview }
}

module.exports = { applyEdit, nearestHint }
