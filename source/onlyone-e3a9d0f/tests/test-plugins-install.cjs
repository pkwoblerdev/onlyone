'use strict'
// test-plugins-install.cjs: установка в профиль, запись record.json, approve/disable/rollback/remove.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { treeHash } = require('../tools/plugin/manifest.cjs')
const install = require('../tools/plugin/install.cjs')

const demoDir = path.join(__dirname, 'fixtures', 'plugins', 'demo')
const cliPath = path.join(__dirname, '..', 'tools', 'plugin', 'cli.cjs')
const base = JSON.parse(fs.readFileSync(path.join(demoDir, 'plugin.json'), 'utf8'))
const tmpRoots = []

function makeTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-install-'))
  tmpRoots.push(root)
  return root
}

function makePlugin(extra) {
  const target = path.join(makeTmp(), 'plugin')
  fs.cpSync(demoDir, target, { recursive: true })
  if (extra) {
    fs.writeFileSync(path.join(target, 'plugin.json'), JSON.stringify({ ...base, ...extra }, null, 2) + '\n')
  }
  return target
}

const profileDir = path.join(makeTmp(), 'profile')
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

function cli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
  const lines = String(result.stdout).trim().split('\n')
  return { status: result.status, json: JSON.parse(lines[lines.length - 1]) }
}

async function main() {
  let installed

  await check('install не включает плагин и пишет хеш дерева', () => {
    installed = install.installPlugin(demoDir, { profileDir })
    assert.equal(installed.id, 'demo')
    assert.equal(installed.version, '1.0.0')
    assert.equal(installed.disabled, true)
    assert.deepEqual(installed.grants, [])
    assert.equal(installed.hash, treeHash(demoDir))
    assert.ok(fs.existsSync(path.join(installed.dir, 'worker.cjs')))
  })

  await check('record.json лежит в profileDir/plugins/<id>/record.json', () => {
    const recordFile = path.join(profileDir, 'plugins', 'demo', 'record.json')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    assert.equal(record.id, 'demo')
    assert.equal(record.version, '1.0.0')
    assert.equal(record.disabled, true)
    assert.deepEqual(record.grants, [])
    assert.equal(record.hash, treeHash(demoDir))
  })

  await check('listPlugins показывает установленный плагин', () => {
    const list = install.listPlugins(profileDir)
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'demo')
    assert.equal(list[0].disabled, true)
  })

  await check('approve выдаёт запрошенные возможности и включает', () => {
    const record = install.approvePlugin(profileDir, 'demo')
    assert.equal(record.disabled, false)
    assert.deepEqual(record.grants, base.capabilities)
    assert.equal(install.listPlugins(profileDir)[0].disabled, false)
  })

  await check('повторная установка той же версии не сбрасывает согласие', () => {
    const again = install.installPlugin(demoDir, { profileDir })
    assert.equal(again.disabled, false)
    assert.deepEqual(again.grants, base.capabilities)
  })

  await check('подмена файла в установленном каталоге ловится approve', () => {
    const worker = path.join(profileDir, 'plugins', 'demo', '1.0.0', 'worker.cjs')
    fs.appendFileSync(worker, '\n// tampered\n')
    throws(() => install.approvePlugin(profileDir, 'demo'), /hash mismatch/)
    install.installPlugin(demoDir, { profileDir })
    assert.equal(install.approvePlugin(profileDir, 'demo').disabled, false)
  })

  await check('новая версия ставится отдельным каталогом, rollback возвращает старую', () => {
    const next = makePlugin({ version: '1.0.1' })
    install.installPlugin(next, { profileDir })
    assert.equal(install.listPlugins(profileDir)[0].version, '1.0.1')
    assert.ok(fs.existsSync(path.join(profileDir, 'plugins', 'demo', '1.0.0')))
    assert.ok(fs.existsSync(path.join(profileDir, 'plugins', 'demo', '1.0.1')))
    const rolled = install.rollbackPlugin(profileDir, 'demo', '1.0.0')
    assert.equal(rolled.version, '1.0.0')
    throws(() => install.rollbackPlugin(profileDir, 'demo', '9.9.9'), /not installed/)
    throws(() => install.rollbackPlugin(profileDir, 'demo', '../1.0.0'), /bad version/)
  })

  await check('disablePlugin выключает плагин', () => {
    const record = install.disablePlugin(profileDir, 'demo')
    assert.equal(record.disabled, true)
    throws(() => install.disablePlugin(profileDir, 'absent'), /not installed/)
  })

  await check('removePlugin удаляет каталог плагина', () => {
    assert.deepEqual(install.removePlugin(profileDir, 'demo'), { id: 'demo', removed: true })
    assert.equal(install.listPlugins(profileDir).length, 0)
    assert.ok(!fs.existsSync(path.join(profileDir, 'plugins', 'demo')))
  })

  await check('плохая схема отвергается до копирования', () => {
    const bad = makePlugin({ id: 'Bad' })
    throws(() => install.installPlugin(bad, { profileDir }), /bad id/)
    assert.equal(fs.existsSync(path.join(profileDir, 'plugins', 'Bad')), false, 'refused install must not copy files')
    assert.equal(install.listPlugins(profileDir).length, 0)
  })

  await check('выход за каталог в entry отвергается', () => {
    const bad = makePlugin({ entry: '../evil.cjs' })
    throws(() => install.installPlugin(bad, { profileDir }), /escapes|relative/)
  })

  await check('неизвестная возможность отвергается', () => {
    const bad = makePlugin({ capabilities: ['fs.read', 'chats'] })
    throws(() => install.installPlugin(bad, { profileDir }), /unknown capability/)
  })

  await check('без profileDir установка не идёт', () => {
    throws(() => install.installPlugin(demoDir, {}), /profileDir/)
  })

  await check('CLI verify печатает JSON и хеш', () => {
    const result = cli(['verify', demoDir])
    assert.equal(result.status, 0)
    assert.deepEqual(result.json, { ok: true, id: 'demo', version: '1.0.0', hash: treeHash(demoDir) })
  })

  await check('CLI install не включает плагин и кладёт его в список', () => {
    const cliProfile = path.join(makeTmp(), 'cli-profile')
    const installed = cli(['install', demoDir, '--profile', cliProfile])
    assert.equal(installed.status, 0)
    assert.equal(installed.json.disabled, true)
    assert.deepEqual(installed.json.grants, [])
    const listed = cli(['list', '--profile', cliProfile])
    assert.equal(listed.status, 0)
    assert.equal(listed.json.length, 1)
    assert.equal(listed.json[0].id, 'demo')
    assert.equal(cli(['approve', 'demo', '--profile', cliProfile]).json.disabled, false)
    assert.equal(cli(['disable', 'demo', '--profile', cliProfile]).json.disabled, true)
    const next = makePlugin({ version: '1.0.1' })
    assert.equal(cli(['install', next, '--profile', cliProfile]).json.version, '1.0.1')
    assert.equal(cli(['rollback', 'demo', '1.0.0', '--profile', cliProfile]).json.version, '1.0.0')
    assert.deepEqual(cli(['remove', 'demo', '--profile', cliProfile]).json, { id: 'demo', removed: true })
    assert.deepEqual(cli(['list', '--profile', cliProfile]).json, [])
  })

  await check('CLI сообщает об ошибке JSON-ом и кодом 1', () => {
    const result = cli(['nonsense'])
    assert.equal(result.status, 1)
    assert.equal(result.json.ok, false)
    assert.match(result.json.error, /unknown command/)
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
