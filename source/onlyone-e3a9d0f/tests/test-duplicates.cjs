// Duplicates and the problems that hide inside them.
//
// The whole-file sweep in `test-audit.cjs` checks that things exist and connect.
// This one checks that nothing exists twice, because a duplicate is quiet in a
// way a missing piece is not: the second definition simply wins, the first stops
// running, and everything still loads.
//
// Every check here comes from something that actually happened in this codebase:
// a handler pasted from its neighbour and left with the neighbour's variable
// name, a call written twice in a row, a repainter registered from two places.
//
// The bar is deliberately high. A check that cannot tell a defect from ordinary
// code trains you to ignore checks — that lesson cost eighteen false «dead
// functions» in an earlier sweep.
const fs = require('fs')
const path = require('path')

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

const main = read('src/main/main.js')
const app = read('src/renderer/app.js')
const preload = read('src/preload/preload.js')
const html = read('src/renderer/index.html')
const css = read('src/renderer/index.css')

let failed = 0
const problems = []
const check = (name, ok, detail) => {
  if (!ok) {
    failed++
    problems.push(detail ? `${name}: ${detail}` : name)
    console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`)
  }
}

const twice = list => {
  const seen = new Map()
  const dups = []
  for (const item of list) {
    const n = (seen.get(item) || 0) + 1
    seen.set(item, n)
    if (n === 2) dups.push(item)
  }
  return dups
}

// --- two definitions, one name -----------------------------------------------
// The later one wins silently. Everything loads, and the first is simply never
// the one that runs.
for (const [label, src] of [['главном процессе', main], ['окне', app]]) {
  const names = [...src.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)]
    .map(m => m[1])
  const dups = twice(names)
  check(`в ${label} нет одноимённых функций`, dups.length === 0, dups.join(', '))
}

// --- two handlers, one channel -----------------------------------------------
// Electron keeps the last registration and warns nowhere the user can see it.
const channels = [...main.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)].map(m => m[1])
check('каналы IPC зарегистрированы по одному разу', twice(channels).length === 0,
  twice(channels).join(', '))

// --- two keys, one bridge ----------------------------------------------------
const bridgeStart = preload.indexOf('contextBridge.exposeInMainWorld')
const bridgeKeys = [...preload.slice(bridgeStart).matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)]
  .map(m => m[1])
check('в мосте нет повторяющихся имён', twice(bridgeKeys).length === 0,
  twice(bridgeKeys).join(', '))

// --- two elements, one id ----------------------------------------------------
// getElementById returns the first; the second is unreachable for the rest of
// the app's life and nothing says so.
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1])
check('в разметке нет повторяющихся id', twice(ids).length === 0, twice(ids).join(', '))

// --- the same line, twice in a row -------------------------------------------
// This is the shape a bad paste leaves. It found a real one before: two
// `updateLiveMeta(pane)` in a row, next to a handler that had kept its
// neighbour's variable name and threw on every completed answer.
for (const [label, src] of [['главном процессе', main], ['окне', app], ['мосте', preload]]) {
  const lines = src.split('\n').map(l => l.trim())
  const repeats = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    // Only statements that do something, and only ones long enough that the
    // repeat cannot be a coincidence of formatting.
    if (line.length < 12 || line !== lines[i - 1]) continue
    if (!/^[\w$.]+\([^)]*\)[;,]?$/.test(line)) continue
    repeats.push(`строка ${i + 1}: ${line}`)
  }
  check(`в ${label} нет строки, повторённой дважды подряд`, repeats.length === 0,
    repeats.join(' | '))
}

// --- the same key, twice in one object ---------------------------------------
// The second wins, so the first is dead configuration that reads as live.
//
// Keys are collected per object, tracked by brace depth, because a tool schema
// legitimately carries `type` at four different levels and comparing them all
// in one bag reports every schema in the file.
function duplicateObjectKeys(src, label) {
  const found = []
  // One frame per brace. Object frames collect keys; block frames stay null so
  // that depth still lines up but nothing inside them is read as a key.
  const frames = []
  let line = 1
  let i = 0

  // Consumes up to and including `end`, counting the lines it passes.
  const skipTo = end => {
    while (i < src.length) {
      if (src.startsWith(end, i)) {
        if (end === '\n') line++
        i += end.length
        return
      }
      if (src[i] === '\n') line++
      if (src[i] === '\\') i++
      i++
    }
  }

  // What kind of brace this is, decided by what stands before it.
  const opensObject = at => {
    let k = at - 1
    while (k >= 0 && /\s/.test(src[k])) k--
    if (k < 0) return false
    if ('=([,:'.includes(src[k])) return true
    return /\breturn$/.test(src.slice(Math.max(0, k - 6), k + 1))
  }

  // The last character that means anything: whitespace and comments skipped.
  let last = ''

  while (i < src.length) {
    const c = src[i]

    if (c === '\n') { line++; i++; continue }
    if (c === '/' && src[i + 1] === '/') { skipTo('\n'); continue }
    if (c === '/' && src[i + 1] === '*') { i += 2; skipTo('*/'); continue }
    if (c === "'" || c === '"' || c === '\u0060') { i++; skipTo(c); continue }

    if (c === '{') {
      frames.push(opensObject(i) ? { keys: new Map() } : null)
      last = '{'
      i++
      continue
    }
    if (c === '}') {
      frames.pop()
      last = '}'
      i++
      continue
    }

    const frame = frames[frames.length - 1]
    // A key stands right after the opening brace or a comma. Without that rule
    // the colon of a ternary spread over two lines reads as a key:
    //
    //   parameters: ok
    //     ? manifest.parameters
    //     : { type: 'object' }
    //
    // — and `parameters` is reported as a duplicate of itself. Every finding
    // this check produced before the rule was added had exactly that shape.
    if (frame && /[A-Za-z_$]/.test(c) && (last === '{' || last === ',')) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i, i + 80))
      if (m) {
        const name = m[1]
        if (frame.keys.has(name)) {
          found.push(`${label}, строка ${line}: ${name} — уже был в строке ${frame.keys.get(name)}`)
        } else {
          frame.keys.set(name, line)
        }
        last = ':'
        i += m[0].length
        continue
      }
    }

    if (!/\s/.test(c)) last = c
    i++
  }

  return found
}

const objectKeyDupes = [
  ...duplicateObjectKeys(main, 'главный процесс'),
  ...duplicateObjectKeys(app, 'окно'),
  ...duplicateObjectKeys(preload, 'мост')
]
check('в объектах нет повторяющихся полей', objectKeyDupes.length === 0,
  objectKeyDupes.join(' | '))

// --- unreachable code ---------------------------------------------------------
// A statement after an unconditional return never runs. It is usually the tail
// of an edit that moved the return up.
for (const [label, src] of [['главном процессе', main], ['окне', app]]) {
  const lines = src.split('\n')
  const dead = []
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].trim()
    const here = lines[i].trim()
    if (!/^return\b.*[^,{([]$/.test(prev)) continue
    if (!here || here.startsWith('}') || here.startsWith('//')) continue
    // Same indentation means the same block; deeper means a new one started.
    const prevIndent = lines[i - 1].search(/\S/)
    const hereIndent = lines[i].search(/\S/)
    if (hereIndent !== prevIndent) continue
    dead.push(`${label}, строка ${i + 1}: ${here.slice(0, 60)}`)
  }
  check(`в ${label} нет кода после return`, dead.length === 0, dead.join(' | '))
}

// --- the same selector, twice with the same body ------------------------------
// Two identical rules mean one edit landed in the wrong copy, and the screen
// keeps showing the other.
//
// @keyframes are cut out first: every animation has its own `to` and `from`,
// and they are different rules that merely share a name.
const cssBody = css
  .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

const rules = [...cssBody.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => ({
    selector: m[1].trim().replace(/\s+/g, ' '),
    body: m[2].trim().replace(/\s+/g, ' ')
  }))
  .filter(r => r.body.length > 0 && r.selector && !r.selector.startsWith('@'))

const ruleKeys = rules.map(r => `${r.selector} { ${r.body} }`)
const dupRules = twice(ruleKeys)
check('в стилях нет полностью совпадающих правил', dupRules.length === 0,
  dupRules.map(r => r.slice(0, 90)).join(' | '))

// --- a listener attached from two places --------------------------------------
// Both fire. For a send button that means the message goes twice.
const listeners = [...app.matchAll(/\$\('([A-Za-z_$][\w$]*)'\)\??\.addEventListener\(\s*'(\w+)'/g)]
  .map(m => `${m[1]}.${m[2]}`)
check('на один элемент не вешают два одинаковых обработчика',
  twice(listeners).length === 0, twice(listeners).join(', '))

// --- two translations, one phrase (Н90) --------------------------------------
// In the i18n dictionary, duplicate keys mean dead translations and merge collisions.
const i18nSrc = read('src/renderer/i18n.js')
const i18nKeyMatches = [...i18nSrc.matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm)]
  .map(m => m[1] || m[2] || m[3])
const i18nDupes = twice(i18nKeyMatches)
check('в словаре i18n нет повторяющихся ключей (Н90)', i18nDupes.length === 0,
  i18nDupes.join(', '))

console.log(JSON.stringify({ ok: failed === 0, failed, problems }))
process.exit(failed ? 1 : 0)

