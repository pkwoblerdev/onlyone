// Regression contract for a fresh profile: packaged + auto-check enabled is
// enough to start the silent check. An unset custom URL must leave the updater
// free to use electron-builder's embedded app-update.yml configuration.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')
const config = fs.readFileSync(path.join(root, 'electron-builder.config.cjs'), 'utf8')

function startupContract(source) {
  const start = source.indexOf('// Тихая проверка через несколько секунд после старта')
  if (start < 0) return { outerGuard: '', body: '' }
  const finish = source.indexOf("app.on('activate'", start)
  const block = source.slice(start, finish < 0 ? source.length : finish)
  const guard = block.match(/if\s*\(([\s\S]*?)\)\s*\{\s*const look/)
  const look = block.match(/const look\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\n\s*setTimeout/)
  const lookBody = look?.[1] || ''
  return { outerGuard: guard?.[1] || '', lookBody, body: block }
}

const contract = startupContract(main)
const checks = [
  ['release has no default updater feed', () => {
    assert.match(config, /publish:\s*process\.env\.ONECODE_FEED_URL\s*\?/)
  }],
  ['startup check remains gated by the disabled auto-update policy', () => {
    assert.match(contract.outerGuard, /app\.isPackaged/)
    assert.match(contract.outerGuard, /autoUpdateEnabled\(\)/)
    assert.doesNotMatch(contract.outerGuard, /updateFeedUrl\s*\(/,
      'an empty saved custom feed must not block the embedded updater feed')
    assert.doesNotMatch(contract.lookBody, /updateFeedUrl\s*\(/,
      'the delayed check must not require a saved custom feed either')
  }],
  ['the scheduled callback checks through electron-updater', () => {
    assert.match(contract.body, /getAutoUpdater\(\)\.checkForUpdates\(\)/)
  }],
  ['disabling automatic updates prevents the delayed check', () => {
    assert.match(contract.body, /if\s*\(\s*!autoUpdateEnabled\(\)/)
  }]
]

let failed = 0
for (const [name, run] of checks) {
  try { run(); console.log(`  ok  ${name}`) } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

console.log(JSON.stringify({ ok: failed === 0, checks: checks.length, failed }))
process.exitCode = failed ? 1 : 0
