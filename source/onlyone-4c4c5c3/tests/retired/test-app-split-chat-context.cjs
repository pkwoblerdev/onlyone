// Keep the chat context component enrolled in the split-app ownership checks.
// This intentionally guards the MODULES inventory, not production wiring.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const testSource = fs.readFileSync(path.join(__dirname, 'test-app-split.cjs'), 'utf8')

function moduleInventoryHasChatContext(source) {
  const start = source.indexOf('const MODULES = [')
  if (start < 0) return false
  const end = source.indexOf('\n]\n', start)
  if (end < 0) return false
  const inventory = source.slice(start, end)
  return /\bfile:\s*['"]chat-context\.js['"]/.test(inventory)
}

let failed = 0
function check(name, condition, detail) {
  if (condition) console.log(`  ok  ${name}`)
  else { failed++; console.error(`ПРОВАЛ [${name}]: ${detail}`) }
}

check('chat-context.js is registered in MODULES', moduleInventoryHasChatContext(testSource),
  'tests/test-app-split.cjs must register chat-context.js in MODULES')

// Mutation check: removing the real inventory item must be detected.
const withoutRegistration = testSource.replace(
  /\{\s*file:\s*['"]chat-context\.js['"][\s\S]*?\n  \},?/g, '')
check('mutation fixture removes the entry and is detected',
  moduleInventoryHasChatContext(testSource) &&
  withoutRegistration !== testSource &&
  !moduleInventoryHasChatContext(withoutRegistration),
  'removing the chat-context MODULES entry was not detected')

console.log(JSON.stringify({ ok: failed === 0, checks: 2, failed }))
process.exitCode = failed ? 1 : 0
