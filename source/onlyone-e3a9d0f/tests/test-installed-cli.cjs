'use strict'
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createJob, readJob, cleanup } = require('../src/cli/session.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-test-'))
try {
  const source = path.join(dir, 'source'), folder = path.join(dir, 'проект & test'); fs.mkdirSync(source); fs.mkdirSync(folder)
  const settings = Buffer.from(JSON.stringify({ workspace: { path: 'original', permission: 'auto' }, openrouterKeys: [] }))
  fs.writeFileSync(path.join(source, '1code-settings.json'), settings)
  fs.writeFileSync(path.join(source, 'Local State'), 'encrypted-profile-key-fixture')
  fs.writeFileSync(path.join(source, 'private-history.json'), 'DO NOT COPY')
  const job = createJob({ sourceProfile: source, folder, request: 'Прочитай "a&b"', allowWrite: false })
  try {
    const loaded = readJob(job.dir)
    assert.equal(loaded.request, 'Прочитай "a&b"'); assert.equal(loaded.allowWrite, false)
    assert.equal(loaded.folder, folder)
    assert.deepEqual(fs.readFileSync(path.join(source, '1code-settings.json')), settings, 'desktop profile stays byte-identical')
    assert.equal(fs.existsSync(path.join(job.dir, 'profile', 'private-history.json')), false)
    assert.equal(fs.readFileSync(path.join(job.dir, 'profile', 'Local State'), 'utf8'), 'encrypted-profile-key-fixture')
    fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify({ ...loaded, script: 'arbitrary.js' }))
    assert.throws(() => readJob(job.dir), /invalid/)
  } finally { cleanup(job.dir) }
  assert.equal(fs.existsSync(job.dir), false)
  assert.throws(() => cleanup(dir), /owned/)
  fs.writeFileSync(path.join(source, '1code-settings.json'), '{bad')
  assert.throws(() => createJob({ sourceProfile: source, folder, request: 'x', allowWrite: true }), /settings/)
  assert.equal(fs.readFileSync(path.join(source, '1code-settings.json'), 'utf8'), '{bad')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
const root = path.join(__dirname, '..')
const installer = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
assert.match(installer, /!macro customInstall\b/, 'installer registers the command')
assert.match(installer, /!macro customUnInstall\b/, 'uninstaller removes its command path')
assert.match(installer, /customPageAfterChangeDir/, 'PATH registration is an explicit installation choice')
assert.match(installer, /\$\{isUpdated\}/, 'updates must preserve PATH until replacement succeeds')
const entry = path.join(root, 'src/cli/onlyone.cjs')
for (const flag of ['--help', '--version']) {
  const run = require('node:child_process').spawnSync(process.execPath, [entry, flag], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, flag === '--help' ? /onlyone run/ : /\d+\.\d+\.\d+/)
}
console.log('PASS installed CLI: isolated settings, typed job, no arbitrary scripts, cleanup and help/version')

const bootstrap = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
const pinned = []
require('node:vm').runInNewContext(bootstrap.slice(0, bootstrap.indexOf("app.setName('onlyone')")), {
  require: name => {
    if (name === 'electron') return { app: {
      commandLine: { hasSwitch: flag => flag === 'onlyone-cli', getSwitchValue: () => path.join(os.tmpdir(), 'onlyone-cli-fixture') },
      setPath: (key, value) => pinned.push([key, value]),
      getPath: () => { throw Error('CLI must not access/migrate the desktop profile') }
    } }
    if (name === '../cli/session.cjs') return { readJob: () => ({ request: 'fixture' }) }
    if (name === 'path') return path
    throw Error('unexpected bootstrap dependency')
  }
})
assert.deepEqual(pinned, [['userData', path.join(os.tmpdir(), 'onlyone-cli-fixture', 'profile')]])
console.log('PASS CLI bootstrap pins its own profile and never migrates desktop data')
