'use strict'
// test-plugins-secrets.cjs: подпись ed25519 над хешем дерева и урезанное окружение рабочего процесса.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { treeHash } = require('../tools/plugin/manifest.cjs')
const install = require('../tools/plugin/install.cjs')
const { startHost, ENV_KEYS, BLANKED_ENV_KEYS } = require('../tools/plugin/host.cjs')

const demoDir = path.join(__dirname, 'fixtures', 'plugins', 'demo')
const base = JSON.parse(fs.readFileSync(path.join(demoDir, 'plugin.json'), 'utf8'))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-secrets-'))
const profileDir = path.join(tmpRoot, 'profile')
fs.mkdirSync(profileDir, { recursive: true })

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok     ${name}`)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

function throws(fn, pattern) {
  assert.throws(fn, pattern, 'ожидалась ошибка')
}

function makePlugin(name, extra) {
  const dir = path.join(tmpRoot, name)
  fs.cpSync(demoDir, dir, { recursive: true })
  if (extra) fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ ...base, ...extra }, null, 2) + '\n')
  return dir
}

function signPlugin(dir, privateKey) {
  const signature = crypto.sign(null, Buffer.from(treeHash(dir), 'utf8'), privateKey).toString('base64')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ ...manifest, signature }, null, 2) + '\n')
  return signature
}

async function main() {
  const aws = crypto.generateKeyPairSync('ed25519')
  const other = crypto.generateKeyPairSync('ed25519')
  const publicKey = aws.publicKey.export({ type: 'spki', format: 'pem' })
  const otherPublicKey = other.publicKey.export({ type: 'spki', format: 'pem' })

  await check('подписанный плагин ставится с верным ключом и остаётся выключенным', () => {
    const dir = makePlugin('signed')
    const hash = treeHash(dir)
    signPlugin(dir, aws.privateKey)
    const record = install.installPlugin(dir, { profileDir, publicKey })
    assert.equal(record.disabled, true)
    assert.equal(record.hash, hash)
  })

  await check('чужая подпись отвергается', () => {
    const dir = makePlugin('signed-wrong', { id: 'signed-wrong' })
    signPlugin(dir, aws.privateKey)
    throws(() => install.installPlugin(dir, { profileDir, publicKey: otherPublicKey }), /bad signature/)
  })

  await check('подмена файла после подписи отвергается', () => {
    const dir = makePlugin('signed-tampered', { id: 'signed-tampered' })
    signPlugin(dir, aws.privateKey)
    fs.appendFileSync(path.join(dir, 'worker.cjs'), '\n// tampered after signing\n')
    throws(() => install.installPlugin(dir, { profileDir, publicKey }), /bad signature/)
  })

  await check('подпись без publicKey не принимается за доверенную', () => {
    const dir = makePlugin('signed-nokey', { id: 'signed-nokey' })
    signPlugin(dir, aws.privateKey)
    // Empty trust store: install is allowed, but the signature is not trust.
    const record = install.installPlugin(dir, { profileDir })
    assert.equal(record.signed, false)
    assert.match(record.warning, /not trusted/i)
  })

  await check('рабочий процесс не получает USERPROFILE, APPDATA и TOKEN', async () => {
    const probe = path.join(tmpRoot, 'envprobe')
    fs.mkdirSync(probe, { recursive: true })
    fs.writeFileSync(path.join(probe, 'plugin.json'), JSON.stringify({
      id: 'envprobe', version: '1.0.0', apiVersion: 1, entry: 'worker.cjs', capabilities: []
    }, null, 2) + '\n')
    fs.writeFileSync(path.join(probe, 'worker.cjs'), [
      "'use strict'",
      "const readline = require('node:readline')",
      "const rl = readline.createInterface({ input: process.stdin })",
      "rl.on('line', (line) => {",
      '  const request = JSON.parse(line)',
      "  process.stdout.write(JSON.stringify({ id: request.id, result: { env: process.env, cwd: process.cwd() } }) + '\\n')",
      '})',
      ''
    ].join('\n'))

    const saved = {}
    for (const key of ['USERPROFILE', 'APPDATA', 'TOKEN']) saved[key] = process.env[key]
    process.env.USERPROFILE = saved.USERPROFILE || 'C:\\Users\\probe'
    process.env.APPDATA = saved.APPDATA || 'C:\\Users\\probe\\AppData\\Roaming'
    process.env.TOKEN = 'secret-token'

    const host = startHost({ pluginDir: probe, timeoutMs: 3000 })
    try {
      const result = await host.ping()
      // Windows добавляет профильные переменные в любой новый процесс; хост
      // обязан отдать их пустыми, иначе настоящее значение утекает воркеру.
      assert.equal(result.env.USERPROFILE, '', 'USERPROFILE не должен доходить до воркера')
      assert.ok(!('APPDATA' in result.env), 'APPDATA не должен доходить до воркера')
      assert.ok(!('TOKEN' in result.env), 'TOKEN не должен доходить до воркера')
      for (const key of BLANKED_ENV_KEYS) assert.equal(result.env[key], '', `${key} должен быть пустым`)
      const withValues = Object.keys(result.env).filter((key) => result.env[key] !== '')
      const expected = ENV_KEYS.filter((key) => process.env[key] !== undefined).sort()
      assert.deepEqual(withValues.sort(), expected, 'значения несут только PATH, SystemRoot, TEMP, TMP')
      assert.equal(path.resolve(result.cwd), path.resolve(probe))
    } finally {
      host.killSwitch()
      await host.exited
    }
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  await check('установленный подписанный плагин не хранит подпись в record.json', () => {
    const record = JSON.parse(fs.readFileSync(path.join(profileDir, 'plugins', 'demo', 'record.json'), 'utf8'))
    assert.equal(record.id, 'demo')
    assert.ok(!JSON.stringify(record).includes('signature'))
  })
}

main()
  .catch((error) => {
    failed++
    console.error(error)
  })
  .finally(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    console.log(JSON.stringify({ ok: failed === 0, checks: passed + failed, failed }))
    process.exit(failed > 0 ? 1 : 0)
  })
