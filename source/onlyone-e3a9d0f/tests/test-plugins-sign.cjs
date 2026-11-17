'use strict'
// Плагины: подпись ed25519 и установка по цепочке доверия. Ключ владельца сюда не
// входит — тест делает свою пару node:crypto, подписывает копию фикстуры через
// tools/plugin/sign.cjs и ставит её в профиль с хранилищем доверия и без него.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { treeHash } = require('../tools/plugin/manifest.cjs')
const install = require('../tools/plugin/install.cjs')
const trust = require('../tools/plugin/trust.cjs')
const sign = require('../tools/plugin/sign.cjs')

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

function throws(fn, pattern) {
  assert.throws(fn, pattern, 'ожидалась ошибка')
}

function makeTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-sign-'))
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

function writeKey(name, key, type) {
  const file = path.join(makeTmp(), name + '.pem')
  fs.writeFileSync(file, key.export({ type, format: 'pem' }))
  return file
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function cli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
  const lines = String(result.stdout).trim().split('\n')
  return { status: result.status, json: JSON.parse(lines[lines.length - 1] || '{}') }
}

async function main() {
  const owner = crypto.generateKeyPairSync('ed25519')
  const stranger = crypto.generateKeyPairSync('ed25519')
  const ownerKey = writeKey('owner', owner.privateKey, 'pkcs8')
  const ownerPub = writeKey('owner-pub', owner.publicKey, 'spki')
  const ownerPem = fs.readFileSync(ownerPub, 'utf8')
  const ownerPrint = trust.fingerprint(ownerPem)

  await check('sign пишет signature.json: ed25519, отпечаток ключа, подпись над хешем дерева', () => {
    const dir = makePlugin('sign-ok')
    const result = sign.signPlugin(dir, ownerKey)
    const data = readJson(path.join(dir, 'signature.json'))
    assert.deepEqual(Object.keys(data).sort(), ['algorithm', 'keyFingerprint', 'signature'])
    assert.equal(data.algorithm, 'ed25519')
    assert.equal(data.keyFingerprint, ownerPrint)
    assert.equal(result.hash, treeHash(dir))
    const verdict = trust.verifySignature(treeHash(dir), data.signature, [{ publicKey: ownerPem }])
    assert.equal(verdict.ok, true)
    assert.equal(verdict.fingerprint, ownerPrint)
    assert.equal(treeHash(dir), result.hash, 'signature.json не входит в хеш дерева')
  })

  await check('sign отказывает не-ed25519 ключу и мусору вместо ключа', () => {
    const dir = makePlugin('sign-bad-key')
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rsaKey = writeKey('rsa', rsa.privateKey, 'pkcs8')
    throws(() => sign.signPlugin(dir, rsaKey), /ed25519/)
    const junk = path.join(makeTmp(), 'junk.pem')
    fs.writeFileSync(junk, 'not a key')
    throws(() => sign.signPlugin(dir, junk), /sign: bad private key/)
    assert.equal(fs.existsSync(path.join(dir, 'signature.json')), false)
  })

  await check('sign отказывает, когда plugin.json заявляет другой хеш', () => {
    const dir = makePlugin('sign-hash-mismatch')
    fs.writeFileSync(path.join(dir, 'plugin.json'),
      JSON.stringify({ ...base, id: 'sign-hash-mismatch', hash: '0'.repeat(64) }, null, 2) + '\n')
    throws(() => sign.signPlugin(dir, ownerKey), /plugin.json hash/)
    assert.equal(fs.existsSync(path.join(dir, 'signature.json')), false)
  })

  await check('sign отказывает подписи в plugin.json от другого ключа', () => {
    const dir = makePlugin('sign-legacy-stranger')
    const signature = crypto.sign(null, Buffer.from(treeHash(dir), 'utf8'), stranger.privateKey).toString('base64')
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ ...base, id: 'sign-legacy-stranger', signature }, null, 2) + '\n')
    throws(() => sign.signPlugin(dir, ownerKey), /plugin.json signature/)
  })

  await check('пустое хранилище: подписанный плагин ставится с signed:false и предупреждением', () => {
    const profileDir = makeProfile()
    const dir = makePlugin('signed-empty')
    sign.signPlugin(dir, ownerKey)
    const result = install.installPlugin(dir, { profileDir })
    assert.equal(result.signed, false)
    assert.match(result.warning, /not trusted/i)
    const record = readJson(path.join(profileDir, 'plugins', 'signed-empty', 'record.json'))
    assert.equal(record.signed, false)
    assert.equal(record.signer, undefined)
    assert.equal(record.hash, treeHash(dir))
  })

  await check('хранилище с ключом: подписанный плагин ставится с signed:true и отпечатком', () => {
    const profileDir = makeProfile()
    trust.addKey(profileDir, ownerPem)
    const dir = makePlugin('signed-trusted')
    sign.signPlugin(dir, ownerKey)
    const result = install.installPlugin(dir, { profileDir })
    assert.equal(result.signed, true)
    assert.equal(result.signer, ownerPrint)
    assert.equal(result.warning, undefined)
    const record = readJson(path.join(profileDir, 'plugins', 'signed-trusted', 'record.json'))
    assert.equal(record.signed, true)
    assert.equal(record.signer, ownerPrint)
  })

  await check('хранилище с ключом: подпись чужим ключом отвергается без копирования', () => {
    const profileDir = makeProfile()
    trust.addKey(profileDir, ownerPem)
    const dir = makePlugin('signed-wrong')
    sign.signPlugin(dir, writeKey('stranger', stranger.privateKey, 'pkcs8'))
    throws(() => install.installPlugin(dir, { profileDir }), /signature/)
    assert.equal(fs.existsSync(path.join(profileDir, 'plugins', 'signed-wrong')), false)
  })

  await check('хранилище с ключом: правка файла после подписи отвергается', () => {
    const profileDir = makeProfile()
    trust.addKey(profileDir, ownerPem)
    const dir = makePlugin('signed-tampered')
    sign.signPlugin(dir, ownerKey)
    fs.appendFileSync(path.join(dir, 'worker.cjs'), '\n// tampered\n')
    throws(() => install.installPlugin(dir, { profileDir }), /signature/)
  })

  await check('хранилище с ключом: неподписанный плагин отвергается', () => {
    const profileDir = makeProfile()
    trust.addKey(profileDir, ownerPem)
    throws(() => install.installPlugin(makePlugin('unsigned-refused'), { profileDir }), /unsigned/)
  })

  await check('битый signature.json не читается молча', () => {
    const profileDir = makeProfile()
    trust.addKey(profileDir, ownerPem)
    const dir = makePlugin('signed-broken-json')
    fs.writeFileSync(path.join(dir, 'signature.json'), '{ broken')
    throws(() => install.installPlugin(dir, { profileDir }), /signature/)
  })

  await check('trust remove возвращает установку неподписанного плагина', () => {
    const profileDir = makeProfile()
    const { fingerprint } = trust.addKey(profileDir, ownerPem)
    throws(() => install.installPlugin(makePlugin('after-remove'), { profileDir }), /unsigned/)
    trust.removeKey(profileDir, fingerprint)
    const result = install.installPlugin(makePlugin('after-remove'), { profileDir })
    assert.equal(result.signed, false)
    assert.match(result.warning, /unsigned/i)
  })

  await check('approve при появившемся ключе перепроверяет подпись', () => {
    const profileDir = makeProfile()
    const dir = makePlugin('approve-unsigned')
    install.installPlugin(dir, { profileDir })
    trust.addKey(profileDir, ownerPem)
    throws(() => install.approvePlugin(profileDir, 'approve-unsigned'), /unsigned/)
  })

  await check('rollback перепроверяет подпись установленной версии', () => {
    const profileDir = makeProfile()
    trust.addKey(profileDir, ownerPem)
    const first = makePlugin('signed-rollback')
    sign.signPlugin(first, ownerKey)
    install.installPlugin(first, { profileDir })
    const second = makePlugin('signed-rollback', { version: '1.0.1' })
    sign.signPlugin(second, ownerKey)
    install.installPlugin(second, { profileDir })
    const sigFile = path.join(profileDir, 'plugins', 'signed-rollback', '1.0.0', 'signature.json')
    const data = readJson(sigFile)
    data.signature = Buffer.alloc(64, 7).toString('base64')
    fs.writeFileSync(sigFile, JSON.stringify(data, null, 2) + '\n')
    throws(() => install.rollbackPlugin(profileDir, 'signed-rollback', '1.0.0'), /signature/)
    assert.equal(readJson(path.join(profileDir, 'plugins', 'signed-rollback', 'record.json')).version, '1.0.1')
  })

  await check('CLI sign/verify/trust add/list/install/remove — круг', () => {
    const profileDir = makeProfile()
    const dir = makePlugin('cli-round')
    const signed = cli(['sign', dir, '--key', ownerKey])
    assert.equal(signed.status, 0)
    assert.equal(signed.json.keyFingerprint, ownerPrint)

    const verified = cli(['verify', dir])
    assert.equal(verified.status, 0)
    assert.equal(verified.json.hash, treeHash(dir))

    const added = cli(['trust', 'add', ownerPub, '--profile', profileDir])
    assert.equal(added.status, 0)
    assert.equal(added.json.fingerprint, ownerPrint)
    assert.equal(added.json.short, ownerPrint.slice(0, 16))

    const listed = cli(['trust', 'list', '--profile', profileDir])
    assert.equal(listed.status, 0)
    assert.equal(listed.json.length, 1)
    assert.equal(listed.json[0].short, ownerPrint.slice(0, 16))

    const installed = cli(['install', dir, '--profile', profileDir])
    assert.equal(installed.status, 0)
    assert.equal(installed.json.signed, true)
    assert.equal(installed.json.signer, ownerPrint)

    const removed = cli(['trust', 'remove', ownerPrint.slice(0, 16), '--profile', profileDir])
    assert.equal(removed.status, 0)
    assert.equal(removed.json.fingerprint, ownerPrint)
    assert.deepEqual(cli(['trust', 'list', '--profile', profileDir]).json, [])
    assert.equal(cli(['install', dir, '--profile', profileDir]).json.signed, false)
  })

  await check('CLI sign без --key не выдумывает ключ владельца и говорит об этом прямо', () => {
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
