'use strict'
// Н3 (Mods): обвязка safeStorage в main.js бросала Error без кода, и стор считал
// «шифрование недоступно» повреждением файла: архив вместо сохранения. Стор уже
// различает эти случаи по `code`; проверяется, что обвязка его ставит — код
// берётся из main.js как есть, а не переписан в тесте.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const line = main.split('\n').find(text => text.includes('Mods encryption unavailable') && text.includes('safeStorageAvailable'))
assert.ok(line, 'the mods safeStorage guard is gone from main.js')
const PROTECT = line.slice(line.indexOf('protect: ') + 'protect: '.length, line.indexOf(', unprotect:', line.indexOf('protect: ')))
const protect = new Function('safeStorageAvailable', 'protectStore', `return (${PROTECT})`)(() => false, () => 'sealed')
let error = null
try { protect('state') } catch (failure) { error = failure }
assert.ok(error, 'an unavailable key must throw')
assert.equal(error.code, 'mods-encryption-unavailable', 'the store cannot tell unavailable from damaged without the code')
const working = new Function('safeStorageAvailable', 'protectStore', `return (${PROTECT})`)(() => true, text => 'sealed:' + text)
assert.equal(working('state'), 'sealed:state', 'protect still seals when the key is available')

// Тот же класс для «уроков» (sec-аудит 01.11, Н5): обвязка бросала Error без кода,
// и mods-store считал временный сбой DPAPI повреждением файла. Стор общий с модами.
const os = require('node:os')
function lessonsGuard (needle, argName, deps) {
  const text = main.split('\n').find(line => line.includes('Lessons encryption unavailable') && line.includes(needle))
  assert.ok(text, `the lessons ${argName} guard is gone from main.js`)
  // Хвост строки — `} })`: последний `}` не тот. Скобки считаем по количеству.
  const start = text.indexOf(`${argName} =>`)
  assert.ok(start >= 0, `lessons ${argName}: arrow not found`)
  let depth = 0
  let end = -1
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) { end = i + 1; break }
  }
  assert.ok(end > 0, `lessons ${argName}: arrow body not closed`)
  const arrow = text.slice(start, end)
  return new Function(...Object.keys(deps), `return (${arrow})`)(...Object.values(deps))
}
const lessonsProtect = lessonsGuard('return protectStore', 'text',
  { safeStorageAvailable: () => false, protectStore: () => 'sealed' })
const lessonsUnprotect = lessonsGuard('return unprotectStore', 'body',
  { safeStorageAvailable: () => false, unprotectStore: () => 'plain' })
for (const [name, fn] of [['protect', lessonsProtect], ['unprotect', lessonsUnprotect]]) {
  let failure = null
  try { fn('данные') } catch (error) { failure = error }
  assert.ok(failure, `lessons ${name}: an unavailable key must throw`)
  assert.equal(failure.code, 'mods-encryption-unavailable',
    `lessons ${name}: the store cannot tell unavailable from damage without the code`)
}
// Настоящий стор: валидный конверт + недоступный шифр => «недоступно», не «повреждено».
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-lessons-code-'))
const file = path.join(tmp, 'lessons.json')
fs.writeFileSync(file, JSON.stringify({ enc: 'safeStorage', data: 'шифр' }))
const store = require('../src/main/mods-store.cjs').createStore({ file, protect: lessonsProtect, unprotect: lessonsUnprotect })
let loadError = null
try { store.load() } catch (error) { loadError = error }
assert.ok(loadError, 'lessons store read a valid envelope as if nothing happened')
assert.equal(loadError.code, 'mods-encryption-unavailable',
  'the store classified a temporary cipher outage as damage: ' + loadError.code)
fs.rmSync(tmp, { recursive: true, force: true })
console.log('PASS mods encryption code: an unavailable key reaches the store as unavailable, not as damage')
