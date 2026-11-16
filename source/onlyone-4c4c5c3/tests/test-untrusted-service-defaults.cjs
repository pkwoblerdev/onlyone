const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
const buildConfig = require('../electron-builder.config.cjs')
for (const from of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'LICENSES']) {
  assert.ok(buildConfig.extraResources.some(item => item.from === from), `${from} must accompany packaged builds`)
}
const start = source.indexOf('function updateFeedUrl() {')
const end = source.indexOf('function sendUpdateState(', start)
assert.ok(start >= 0 && end > start, 'update policy is missing')
const data = new Map()
const store = { get: key => data.get(key) }
const policy = new Function('store', 'UPDATE_FEED_KEY', 'UPDATE_AUTO_KEY', source.slice(start, end) + '\nreturn { updateFeedUrl, autoUpdateEnabled }')(store, 'feed', 'auto')
assert.equal(policy.updateFeedUrl(), '')
assert.equal(policy.autoUpdateEnabled(), false, 'fresh profile must not check updates')
data.set('auto', true)
assert.equal(policy.autoUpdateEnabled(), false, 'no configured feed must not enable network')
data.set('feed', 'https://pkwobler.best/1code/')
assert.equal(policy.updateFeedUrl(), '', 'unowned legacy feed must not be used')
assert.equal(policy.autoUpdateEnabled(), false)
data.set('feed', 'https://SUB.PKWOBLER.BEST./1code/')
assert.equal(policy.updateFeedUrl(), '', 'legacy subdomain and trailing dot must be rejected')
data.set('feed', 'https://pkwobler.dev/onlyone/')
assert.equal(policy.updateFeedUrl(), '', 'unverified 1.3.37 default must not be used')
data.set('feed', 'https://user:password@updates.example.com/')
assert.equal(policy.updateFeedUrl(), '', 'embedded credentials must be rejected')
data.set('feed', 'http://example.com/updates/')
assert.equal(policy.updateFeedUrl(), '', 'insecure saved URL must not be used')
data.set('feed', 'https://updates.example.com/')
assert.equal(policy.updateFeedUrl(), 'https://updates.example.com/')
assert.equal(policy.autoUpdateEnabled(), false, 'automatic updates remain disabled until a trusted release channel exists')
data.set('auto', false)
assert.equal(policy.autoUpdateEnabled(), false)
const line = source.split(/\r?\n/).find(s => s.startsWith('const REMOTE_RELAY_URL ='))
assert.ok(line, 'relay configuration missing')
const relay = new Function('app', 'process', line + '\nreturn REMOTE_RELAY_URL')
assert.equal(relay({ isPackaged: true }, { env: { ONECODE_RELAY_URL: 'wss://example.com' } }), '')
assert.equal(relay({ isPackaged: false }, { env: { ONECODE_RELAY_URL: 'wss://example.com' } }), 'wss://example.com')
;(async () => {
  const { createRemoteControl } = require('../src/main/remote-control')
  let writes = 0, sockets = 0
  const original = { enabled: true, devices: [{ id: 'saved', name: 'phone', key: '00'.repeat(32) }] }
  const core = createRemoteControl({ relayUrl: '', store: { read: () => original, write: () => { writes++ } }, WebSocketImpl: class { constructor() { sockets++ } } })
  await core.start()
  assert.equal(sockets, 0, 'saved pairing must not connect without relay')
  assert.equal(writes, 0, 'saved pairing must not be deleted')
  assert.equal(core.state().enabled, false)
  await assert.rejects(() => core.setEnabled(true), /сервер не настроен/i)
  await assert.rejects(() => core.beginPairing(), /сервер не настроен/i)
  const vm = require('node:vm')
  let connections = 0
  const context = { URL, OnlyoneRemote: { fromHex: () => [] }, OnlyoneLink: { DeviceLink: class { constructor() { connections++ } } } }
  context.window = context
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'mobile/www/js/remote.js'), 'utf8'), context)
  const phone = context.OnlyoneRemoteClient.create({ store: { get: async () => ({ deviceKey: '00', relay: 'wss://pkwobler.best/1code/relay' }) } })
  await phone.load()
  phone.connect()
  assert.equal(connections, 0, 'phone must not reconnect to legacy unowned server')
  await assert.rejects(() => phone.pair({ relay: 'wss://pkwobler.best/1code/relay' }), /сервер|relay/i)
  await assert.rejects(() => phone.pair({ relay: 'wss://sub.pkwobler.best./relay' }), /сервер|relay/i)
  await assert.rejects(() => phone.pair({ relay: 'wss://pkwobler.dev/onlyone/relay' }), /сервер|relay/i)
  const settings = require('../src/renderer/remote-settings')
  const controls = new Map()
  for (const id of ['remoteEnabled', 'remoteBody', 'remotePairBtn', 'remotePairBox', 'remoteCode', 'remoteQr', 'remoteCountdown', 'remotePending', 'remoteCancelPair', 'remoteDevices', 'remoteNoDevices', 'remoteRevokeAll', 'remoteAudit', 'remoteAuditBox']) {
    controls.set(id, { handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn }, appendChild() {} })
  }
  const messages = []
  const originalInterval = globalThis.setInterval
  globalThis.setInterval = () => ({ unref() {} })
  try {
    const initial = { enabled: false, pairing: null, devices: [], audit: [] }
    const ui = settings.create({ $: id => controls.get(id), t: x => x, document: {}, escapeHtml: x => x, showToast: msg => messages.push(msg), electronAPI: {
      remoteState: async () => initial, remoteSetEnabled: async () => { throw Error('unavailable') }, onRemoteState() {}
    } })
    ui.setup()
    await Promise.resolve()
    controls.get('remoteEnabled').checked = true
    await controls.get('remoteEnabled').handlers.change()
    assert.equal(controls.get('remoteEnabled').checked, false)
    assert.match(messages[0], /сервер не настроен/i)
  } finally { globalThis.setInterval = originalInterval }
  console.log(JSON.stringify({ ok: true }))
})().catch(error => { console.error(error); process.exitCode = 1 })
