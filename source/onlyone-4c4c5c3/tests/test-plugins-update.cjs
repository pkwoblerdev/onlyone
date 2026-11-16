'use strict'
// test-plugins-update.cjs: обновление версии с более широкими правами остаётся выключенным до approve.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const install = require('../tools/plugin/install.cjs')

const demoDir = path.join(__dirname, 'fixtures', 'plugins', 'demo')
const base = JSON.parse(fs.readFileSync(path.join(demoDir, 'plugin.json'), 'utf8'))
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-update-'))
  tmpRoots.push(root)
  return root
}

function makeVersion(version, capabilities) {
  const target = path.join(makeTmp(), 'plugin')
  fs.cpSync(demoDir, target, { recursive: true })
  fs.writeFileSync(path.join(target, 'plugin.json'), JSON.stringify({ ...base, version, capabilities }, null, 2) + '\n')
  return target
}

const profileDir = path.join(makeTmp(), 'profile')
fs.mkdirSync(profileDir, { recursive: true })

async function main() {
  await check('v1 ставится выключенной, approve выдаёт её права', () => {
    const v1 = makeVersion('1.0.0', ['fs.read', 'storage'])
    const record = install.installPlugin(v1, { profileDir })
    assert.equal(record.disabled, true)
    assert.deepEqual(record.grants, [])
    const approved = install.approvePlugin(profileDir, 'demo')
    assert.equal(approved.disabled, false)
    assert.deepEqual(approved.grants, ['fs.read', 'storage'])
  })

  await check('v2 с новыми правами остаётся выключенной и пишет pendingGrants', () => {
    const v2 = makeVersion('2.0.0', ['fs.read', 'storage', 'events'])
    const record = install.installPlugin(v2, { profileDir })
    assert.equal(record.disabled, true)
    assert.deepEqual(record.grants, ['fs.read', 'storage'], 'старые права сохраняются')
    assert.deepEqual(record.pendingGrants, ['fs.read', 'storage', 'events'])
    const stored = JSON.parse(fs.readFileSync(path.join(profileDir, 'plugins', 'demo', 'record.json'), 'utf8'))
    assert.deepEqual(stored.pendingGrants, ['fs.read', 'storage', 'events'])
    assert.equal(stored.version, '2.0.0')
  })

  await check('approve после обновления выдаёт новые права и снимает pendingGrants', () => {
    const record = install.approvePlugin(profileDir, 'demo')
    assert.equal(record.disabled, false)
    assert.deepEqual(record.grants, ['fs.read', 'storage', 'events'])
    assert.equal(record.pendingGrants, undefined)
  })

  await check('v3 с подмножеством прав сохраняет включённость', () => {
    const v3 = makeVersion('3.0.0', ['fs.read'])
    const record = install.installPlugin(v3, { profileDir })
    assert.equal(record.disabled, false)
    assert.deepEqual(record.grants, ['fs.read', 'storage', 'events'])
    assert.equal(record.pendingGrants, undefined)
  })

  await check('v4 с чужим правом снова выключает плагин', () => {
    const v4 = makeVersion('4.0.0', ['net'])
    const record = install.installPlugin(v4, { profileDir })
    assert.equal(record.disabled, true)
    assert.deepEqual(record.pendingGrants, ['net'])
  })

  await check('rollback на старую версию возвращает её каталог и хеш', () => {
    const record = install.rollbackPlugin(profileDir, 'demo', '1.0.0')
    assert.equal(record.version, '1.0.0')
    assert.ok(record.dir.endsWith('plugins/demo/1.0.0'))
    assert.equal(fs.existsSync(path.join(profileDir, record.dir, 'worker.cjs')), true)
    assert.equal(record.disabled, true, 'после v4 плагин был выключен и остаётся')
  })

  await check('список показывает одну запись на плагин', () => {
    const list = install.listPlugins(profileDir)
    assert.equal(list.length, 1)
    assert.equal(list[0].version, '1.0.0')
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
