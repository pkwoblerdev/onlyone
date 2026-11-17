// JSON.parse silently keeps the last value for duplicate object keys. Inspect
// the raw scripts object first so a duplicate npm command cannot go unnoticed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function scriptsObjectBody(raw) {
  const match = /"scripts"\s*:\s*\{/.exec(raw)
  if (!match) throw new Error('package.json has no scripts object')
  const open = raw.indexOf('{', match.index)
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = open; i < raw.length; i++) {
    const ch = raw[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return raw.slice(open + 1, i)
  }
  throw new Error('unterminated scripts object')
}

function duplicateScriptKeys(raw) {
  const body = scriptsObjectBody(raw)
  const seen = new Set()
  const duplicates = new Set()
  let i = 0
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++
    if (i >= body.length) break
    if (body[i] !== '"') throw new Error(`expected a JSON key in scripts at offset ${i}`)
    const keyStart = i++
    let escaped = false
    while (i < body.length) {
      const ch = body[i++]
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') break
    }
    const key = JSON.parse(body.slice(keyStart, i))
    while (/\s/.test(body[i] || '')) i++
    if (body[i++] !== ':') throw new Error(`expected ':' after scripts key ${key}`)
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)

    // Skip this value as JSON, respecting quotes and nested arrays/objects.
    let nested = 0
    let inString = false
    escaped = false
    while (i < body.length) {
      const ch = body[i]
      if (inString) {
        i++
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; i++; continue }
      if (ch === '{' || ch === '[') { nested++; i++; continue }
      if (ch === '}' || ch === ']') { nested--; i++; continue }
      if (ch === ',' && nested === 0) break
      i++
    }
    if (body[i] === ',') i++
  }
  return [...duplicates]
}

const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
assert.deepEqual(duplicateScriptKeys(raw), [], 'package.json scripts must not contain duplicate keys')

const duplicateFixture = '{"scripts":{"test":"first","test":"second"},"dependencies":{"test":"valid outside scripts"}}'
assert.deepEqual(duplicateScriptKeys(duplicateFixture), ['test'],
  'duplicate-key fixture must be caught while keys outside scripts stay out of scope')

console.log(JSON.stringify({ ok: true, checks: 2, failed: 0 }))
