// A packaged app may have no custom feed saved. In that case the manual
// "Check for updates" action must let electron-updater read app-update.yml.
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const start = source.indexOf("ipcMain.handle('check-for-update'")
const end = source.indexOf("ipcMain.handle('download-update'", start)
const handler = start < 0 || end < 0 ? '' : source.slice(start, end)
const checkCall = handler.indexOf('getAutoUpdater().checkForUpdates()')
const preflight = checkCall < 0 ? handler : handler.slice(0, checkCall)

const checks = [
  ['manual update handler exists', () => {
    if (!handler) throw new Error('check-for-update IPC handler was not found')
  }],
  ['unpackaged app remains blocked', () => {
    if (!/if\s*\(\s*!app\.isPackaged\s*\)/.test(preflight)) {
      throw new Error('manual checks must still require a packaged app')
    }
  }],
  ['manual update requires an explicitly configured feed', () => {
    if (!/if\s*\(\s*!updateFeedUrl\s*\(\s*\)\s*\)/.test(preflight)) {
      throw new Error('handler must reject an empty or untrusted feed')
    }
    if (checkCall < 0) throw new Error('handler never reaches checkForUpdates()')
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
