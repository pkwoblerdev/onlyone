'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const start = source.indexOf('function updateFeedUrl() {')
const end = source.indexOf('function sendUpdateState(', start)
assert.ok(start >= 0 && end > start)
const data = new Map()
const store = { get: key => data.get(key), set: (key, value) => data.set(key, value) }
const env = { env: {} }
const policy = new Function('store', 'UPDATE_FEED_KEY', 'UPDATE_AUTO_KEY', 'process', source.slice(start, end) + '\nreturn { updateFeedUrl, autoUpdateEnabled }')(store, 'feed', 'auto', env)
const github = 'https://github.com/pkwoblerdev/onlyone/releases'
assert.equal(policy.updateFeedUrl(), github)
assert.equal(policy.autoUpdateEnabled(), true)
data.set('auto', false)
assert.equal(policy.autoUpdateEnabled(), false)
data.set('auto', true)
data.set('feed', 'https://pkwobler.best/1code/')
assert.equal(policy.updateFeedUrl(), github, 'legacy unowned server cannot remain the update source')
assert.equal(policy.autoUpdateEnabled(), true)
data.set('feed', 'https://updates.example.com/')
assert.equal(policy.updateFeedUrl(), 'https://updates.example.com/')
assert.equal(policy.autoUpdateEnabled(), false, 'custom feeds must not be installed automatically')
data.delete('feed')
env.env.PORTABLE_EXECUTABLE_FILE = 'portable.exe'
assert.equal(policy.autoUpdateEnabled(), false, 'portable builds must not run the installer updater')
const builder = require('../electron-builder.config.cjs')
assert.ok(builder.publish.some(p => p.provider === 'github' && p.owner === 'pkwoblerdev' && p.repo === 'onlyone'))
assert.doesNotMatch(builder.nsis.artifactName, /\s/, 'GitHub release uploads must preserve the installer name used in latest.yml')
assert.equal(builder.nsis.deleteAppDataOnUninstall, false, 'updates must retain the user profile')
assert.equal(builder.nsis.guid, '4EB839B2-2DAB-4DA7-9E3B-F2E884BBD9A1', 'installer identity must stay compatible')
const { tr, setLanguageSource } = require('../src/main/ui-text.cjs')
setLanguageSource(() => 'en')
assert.equal(tr('Автообновление доступно только в установленной версии. Скачайте новую portable-версию на странице выпусков.'), 'Automatic updates require the installed version. Download a new portable version from the releases page.')
const updaterStart = source.indexOf('function getAutoUpdater() {')
const updaterEnd = source.indexOf('function normalizeNotes(', updaterStart)
assert.ok(updaterStart >= 0 && updaterEnd > updaterStart)
const fake = { on() {}, setFeedURL(value) { this.feed = value } }
const active = { value: true }
const feed = { value: github }
const buildUpdater = new Function('require', 'autoUpdateEnabled', 'updateFeedUrl',
  'let updaterWired = false; ' + source.slice(updaterStart, updaterEnd) + '\nreturn getAutoUpdater')
const updater = buildUpdater(() => ({ autoUpdater: fake }), () => active.value, () => feed.value)
updater()
assert.deepEqual(fake.feed, { provider: 'github', owner: 'pkwoblerdev', repo: 'onlyone' })
assert.equal(fake.allowPrerelease, true)
assert.equal(fake.autoDownload, true)
assert.equal(fake.autoInstallOnAppQuit, true)
active.value = false
feed.value = 'https://updates.example.com/'
updater()
assert.deepEqual(fake.feed, { provider: 'generic', url: feed.value })
assert.equal(fake.autoDownload, false)
assert.equal(fake.autoInstallOnAppQuit, false)
const handlerStart = source.indexOf("ipcMain.handle('check-for-update'")
const handlerEnd = source.indexOf('// Импорт готового скилла', handlerStart)
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart)
const handlers = new Map()
const ipcMain = { handle: (name, handler) => handlers.set(name, handler) }
new Function('ipcMain', 'process', 'tr', source.slice(handlerStart, handlerEnd))(ipcMain, { env: { PORTABLE_EXECUTABLE_FILE: 'portable.exe' } }, tr)
const settingsStart = source.indexOf("ipcMain.handle('set-update-settings'")
assert.ok(settingsStart >= 0 && handlerStart > settingsStart)
new Function('ipcMain', 'store', 'UPDATE_FEED_KEY', 'UPDATE_AUTO_KEY', 'updateFeedUrl', 'autoUpdateEnabled', source.slice(settingsStart, handlerStart))(ipcMain, store, 'feed', 'auto', policy.updateFeedUrl, policy.autoUpdateEnabled)
;(async () => {
  for (const name of ['check-for-update', 'download-update', 'install-update']) {
    assert.ok(handlers.has(name), name)
    await assert.rejects(() => handlers.get(name)(), /Automatic updates require the installed version/)
  }
  delete env.env.PORTABLE_EXECUTABLE_FILE
  data.clear()
  const settings = handlers.get('set-update-settings')
  assert.equal((await settings({}, { autoCheck: false })).autoCheck, false)
  assert.equal((await settings({}, { autoCheck: true })).autoCheck, true)
  assert.equal((await settings({}, { feedUrl: 'https://updates.example.com/', autoCheck: true })).autoCheck, false)
  console.log('GitHub update policy: OK')
})().catch(error => { console.error(error); process.exitCode = 1 })
