'use strict'
// Плагины: цепочка доверия. ed25519-ключи в trust.json профиля; при непустом
// хранилище неподписанный плагин отвергается, пустое — ставит с signed:false.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { treeHash } = require('../tools/plugin/manifest.cjs')
const install = require('../tools/plugin/install.cjs')
const trust = require('../tools/plugin/trust.cjs')

const demoDir = path.join(__dirname, 'fixtures', 'plugins', 'demo')
const base = JSON.parse(fs.readFileSync(path.join(demoDir, 'plugin.json'), 'utf8'))
const cliPath = path.join(__dirname, '..', 'tools', 'plugin', 'cli.cjs')
const tmpRoots = []

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

function makeTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-trust-'))
  tmpRoots.push(root)
  return root
}

function makeProfile() {
  const dir = path.join(makeTmp(), 'profile')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function makePlugin(id, extra) {
  const dir = path.join(makeTmp(), 'plugin')
  fs.cpSync(demoDir, dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ ...base, id, ...extra }, null, 2) + '\n')
  return dir
}

function signPlugin(dir, privateKey) {
  const signature = crypto.sign(null, Buffer.from(treeHash(dir), 'utf8'), privateKey).toString('base64')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ ...manifest, signature }, null, 2) + '\n')
  return signature
}

function cli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
  const lines = String(result.stdout).trim().split('\n')
  return { status: result.status, json: JSON.parse(lines[lines.length - 1] || '{}') }
}

function readRecord(profileDir, id) {
  return JSON.parse(fs.readFileSync(path.join(profileDir, 'plugins', id, 'record.json'), 'utf8'))
}

async function main() {
  const owner = crypto.generateKeyPairSync('ed25519')
  const stranger = crypto.generateKeyPairSync('ed25519')
  const ownerPem = owner.publicKey.export({ type: 'spki', format: 'pem' })
  const strangerPem = stranger.publicKey.export({ type: 'spki', format: 'pem' })

  await check('пустое хранилище: loadKeys пуст, ключей нет', () => {
    assert.deepEqual(trust.loadKeys(makeProfile()), [])
  })

  await check('addKey кладёт ed25519-ключ и считает отпечаток по SPKI', () => {
    const profileDir = makeProfile()
    const added = trust.addKey(profileDir, ownerPem)
    const expected = crypto.createHash('sha256')
      .update(owner.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
    assert.equal(added.fingerprint, expected)
    assert.equal(added.added, true)
    const keys = trust.loadKeys(profileDir)
    assert.equal(keys.length, 1)
    assert.equal(keys[0].fingerprint, expected)
    assert.match(keys[0].publicKey, /BEGIN PUBLIC KEY/)
    assert.equal(trust.addKey(profileDir, ownerPem).added, false, 'повторный ключ не дублируется')
    assert.equal(trust.loadKeys(profileDir).length, 1)
  })

  await check('не-ed25519 ключ и мусор отвергаются', () => {
    const profileDir = makeProfile()
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' })
    assert.throws(() => trust.addKey(profileDir, rsa), /ed25519/)
    assert.throws(() => trust.addKey(profileDir, 'not a key'), /trust:/)
    assert.deepEqual(trust.loadKeys(profileDir), [])
  })

  await check('verifySignature принимает верную подпись над хешем дерева', () => {
    const keys = [{ publicKey: ownerPem }]
    const dir = makePlugin('verify-ok')
    const hash = treeHash(dir)
    const signature = crypto.sign(null, Buffer.from(hash, 'utf8'), owner.privateKey).toString('base64')
    const verdict = trust.verifySignature(hash, signature, keys)
    assert.equal(verdict.ok, true)
    assert.equal(verdict.fingerprint, trust.fingerprint(ownerPem))
  })

  await check('verifySignature отвергает чужую подпись, подменённый хеш и битую подпись', () => {
    const keys = [{ publicKey: ownerPem }]
    const hash = treeHash(demoDir)
    const signature = crypto.sign(null, Buffer.from(hash, 'utf8'), stranger.privateKey).toString('base64')
    assert.equal(trust.verifySignature(hash, signature, keys).ok, false, 'подпись чужим ключом')
    const own = crypto.sign(null, Buffer.from(hash, 'utf8'), owner.privateKey).toString('base64')
    assert.equal(trust.verifySignature(hash + 'x', own, keys).ok, false, 'другой хеш')
    const raw = Buffer.from(own, 'base64')
    raw[0] ^= 0xff
    assert.equal(trust.verifySignature(hash, raw.toString('base64'), keys).ok, false, 'битая подпись')
    assert.equal(trust.verifySignature(hash, 'short', keys).ok, false, 'короткая подпись')
    assert.equal(trust.verifySignature(hash, signature, []).ok, false, 'пустой список ключей')
  })

  await check('removeKey удаляет ключ, чужой отпечаток — ошибка', () => {
    const profileDir = makeProfile()
    const { fingerprint } = trust.addKey(profileDir, ownerPem)
    assert.deepEqual(trust.removeKey(profileDir, fingerprint), { fingerprint, removed: true })
    assert.deepEqual(trust.loadKeys(profileDir), [])
    assert.throws(() => trust.removeKey(profileDir, fingerprint), /unknown/)
  })

  await check('битый trust.json не читается молча', () => {
    const profileDir = makeProfile()
    fs.writeFileSync(path.join(profileDir, 'trust.json'), '{ broken')
    assert.throws(() => trust.loadKeys(profileDir), /corrupt/)
  })

  await check('пустое хранилище: неподписанный плагин ставится с signed:false и предупреждением', () => {
    const profileDir = makeProfile()
    const dir = makePlugin('unsigned-empty')
    const result = install.installPlugin(dir, { profileDir })
    assert.equal(result.signed, false)
    assert.match(result.warning, /unsigned|trust/i)
    const record = readRecord(profileDir, 'unsigned-empty')
    assert.equal(record.signed, false)
    assert.match(record.warning, /trust/i)
    assert.equal(record.disabled, true)
  })

  await check('непустое хранилище: неподписанный плагин отвергается без копирования', () => {
    const profileDir = makeProfile()
    trust.addKey(profileDir, ownerPem)
    const dir = makePlugin('unsigned-refused')
    assert.throws(() => install.installPlugin(dir, { profileDir }), /signature/)
    assert.equal(fs.existsSync(path.join(profileDir, 'plugins', 'unsigned-refused')), false)
  })

  await check('непустое хранилище: подпись верным ключом принимается, signed:true и отпечаток', () => {
    const profileDir = makeProfile()
    const { fingerprint } = trust.addKey(profileDir, ownerPem)
    const dir = makePlugin('signed-trusted')
    signPlugin(dir, owner.privateKey)
    const result = install.installPlugin(dir, { profileDir })
    assert.equal(result.signed, true)
    assert.equal(result.signer, fingerprint)
    assert.equal(result.warning, undefined)
    const record = readRecord(profileDir, 'signed-trusted')
    assert.equal(record.signed, true)
    assert.equal(record.signer, fingerprint)
  })

  await check('непустое хранилище: подпись ключом вне хранилища отвергается', () => {
    const profileDir = makeProfile()
    trust.addKey(profileDir, ownerPem)
    const dir = makePlugin('signed-stranger')
    signPlugin(dir, stranger.privateKey)
    assert.throws(() => install.installPlugin(dir, { profileDir }), /signature/)
  })

  await check('непустое хранилище: подмена файла после подписи отвергается', () => {
    const profileDir = makeProfile()
    trust.addKey(profileDir, ownerPem)
    const dir = makePlugin('signed-tampered')
    signPlugin(dir, owner.privateKey)
    fs.appendFileSync(path.join(dir, 'worker.cjs'), '\n// tampered\n')
    assert.throws(() => install.installPlugin(dir, { profileDir }), /signature/)
  })

  await check('хранилище с чужим ключом: своя подпись не принимается молча за доверенную', () => {
    const profileDir = makeProfile()
    trust.addKey(profileDir, strangerPem)
    const dir = makePlugin('signed-partial')
    signPlugin(dir, owner.privateKey)
    assert.throws(() => install.installPlugin(dir, { profileDir }), /signature/)
  })

  await check('CLI trust add/list/remove работают в профиле', () => {
    const profileDir = makeProfile()
    const keyFile = path.join(makeTmp(), 'owner.pem')
    fs.writeFileSync(keyFile, ownerPem)

    const added = cli(['trust', 'add', keyFile, '--profile', profileDir])
    assert.equal(added.status, 0)
    assert.equal(added.json.ok, true)
    assert.equal(added.json.added, true)
    assert.equal(added.json.fingerprint, trust.fingerprint(ownerPem))

    const listed = cli(['trust', 'list', '--profile', profileDir])
    assert.equal(listed.status, 0)
    assert.equal(listed.json.length, 1)
    assert.equal(listed.json[0].fingerprint, added.json.fingerprint)

    const removed = cli(['trust', 'remove', added.json.fingerprint, '--profile', profileDir])
    assert.equal(removed.status, 0)
    assert.equal(removed.json.removed, true)
    assert.deepEqual(cli(['trust', 'list', '--profile', profileDir]).json, [])
    assert.equal(cli(['trust', 'remove', added.json.fingerprint, '--profile', profileDir]).status, 1)
  })

  await check('CLI sign не выдумывает ключ владельца и требует --key', () => {
    const result = cli(['sign', demoDir])
    assert.equal(result.status, 1)
    assert.equal(result.json.ok, false)
    assert.match(result.json.error, /--key/)
    assert.match(result.json.error, /owner private key/)
  })
}

main()
  .catch((error) => {
    failed++
    console.error(error)
  })
  .finally(() => {
    for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true })
    console.log(JSON.stringify({ ok: failed === 0, checks: passed + failed, failed }))
    process.exit(failed > 0 ? 1 : 0)
  })
