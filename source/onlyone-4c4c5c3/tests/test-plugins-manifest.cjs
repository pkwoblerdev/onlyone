'use strict'
// test-plugins-manifest.cjs: plugin.json schema (apiVersion 1) and tree hash rules.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CAPABILITIES, validateManifest, loadManifest, treeHash } = require('../tools/plugin/manifest.cjs')

const demoDir = path.join(__dirname, 'fixtures', 'plugins', 'demo')
const base = JSON.parse(fs.readFileSync(path.join(demoDir, 'plugin.json'), 'utf8'))
const tmpRoots = []

function makeTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-manifest-'))
  tmpRoots.push(root)
  return root
}

function makeCopy(extra) {
  const target = path.join(makeTmp(), 'plugin')
  fs.cpSync(demoDir, target, { recursive: true })
  if (extra) {
    fs.writeFileSync(path.join(target, 'plugin.json'), JSON.stringify({ ...base, ...extra }, null, 2) + '\n')
  }
  return target
}

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

async function main() {
  await check('демо-манифест проходит проверку', () => {
    const manifest = validateManifest({ ...base })
    assert.equal(manifest.id, 'demo')
    assert.equal(manifest.version, '1.0.0')
    assert.deepEqual(manifest.capabilities, ['fs.read', 'storage'])
  })

  await check('набор возможностей apiVersion 1 ровно тот, что заявлен', () => {
    assert.deepEqual(CAPABILITIES, ['fs.read', 'exec', 'net', 'storage', 'events', 'ui.panel', 'agent.tools'])
  })

  await check('плохой id отвергается', () => {
    throws(() => validateManifest({ ...base, id: 'Demo' }), /bad id/)
    throws(() => validateManifest({ ...base, id: 'a' }), /bad id/)
    throws(() => validateManifest({ ...base, id: 'demo_plugin' }), /bad id/)
    throws(() => validateManifest({ ...base, id: 'demo; rm -rf' }), /bad id/)
  })

  await check('плохая версия отвергается', () => {
    throws(() => validateManifest({ ...base, version: '1.0' }), /bad version/)
    throws(() => validateManifest({ ...base, version: '1.0.0-beta' }), /bad version/)
  })

  await check('чужой apiVersion отвергается', () => {
    throws(() => validateManifest({ ...base, apiVersion: 2 }), /apiVersion/)
  })

  await check('неизвестная возможность отвергается', () => {
    throws(() => validateManifest({ ...base, capabilities: ['fs.read', 'chats'] }), /unknown capability/)
    throws(() => validateManifest({ ...base, capabilities: ['secrets'] }), /unknown capability/)
  })

  await check('повтор возможности отвергается', () => {
    throws(() => validateManifest({ ...base, capabilities: ['storage', 'storage'] }), /duplicate capability/)
  })

  await check('неизвестный ключ верхнего уровня отвергается', () => {
    throws(() => validateManifest({ ...base, hooks: {} }), /unknown key/)
    throws(() => validateManifest({ ...base, main: 'worker.cjs' }), /unknown key/)
  })

  await check('выход за каталог плагина отвергается', () => {
    throws(() => validateManifest({ ...base, entry: '../evil.cjs' }), /escapes|relative/)
    throws(() => validateManifest({ ...base, entry: 'a/../../evil.js' }), /escapes/)
    throws(() => validateManifest({ ...base, entry: '..\\evil.cjs' }), /escapes/)
    throws(() => validateManifest({ ...base, entry: 'C:\\Windows\\evil.js' }), /relative/)
    throws(() => validateManifest({ ...base, entry: '/etc/evil.js' }), /relative/)
  })

  await check('entry не .js/.cjs отвергается', () => {
    throws(() => validateManifest({ ...base, entry: 'worker.exe' }), /\.js or \.cjs/)
    throws(() => validateManifest({ ...base, entry: 'worker' }), /\.js or \.cjs/)
  })

  await check('вложенный entry внутри плагина разрешён', () => {
    assert.equal(validateManifest({ ...base, entry: 'lib/worker.cjs' }).entry, 'lib/worker.cjs')
  })

  await check('битый selftest и ui отвергаются', () => {
    throws(() => validateManifest({ ...base, selftest: { call: 'x' } }), /selftest/)
    throws(() => validateManifest({ ...base, ui: { title: 7 } }), /ui title/)
    throws(() => validateManifest({ ...base, ui: { title: 'Demo', icon: 'x' } }), /unknown ui key/)
  })

  await check('loadManifest читает фикстуру и сообщает о пропаже', () => {
    assert.equal(loadManifest(demoDir).id, 'demo')
    throws(() => loadManifest(path.join(makeTmp(), 'absent')), /cannot read plugin.json/)
  })

  await check('хеш дерева — sha256 в hex', () => {
    assert.match(treeHash(demoDir), /^[a-f0-9]{64}$/)
  })

  await check('plugin.json и signature.json не входят в хеш', () => {
    const copy = makeCopy()
    const before = treeHash(copy)
    fs.writeFileSync(path.join(copy, 'plugin.json'), JSON.stringify({ ...base, ui: { title: 'Другое' } }, null, 2) + '\n')
    fs.writeFileSync(path.join(copy, 'signature.json'), '{}')
    assert.equal(treeHash(copy), before)
  })

  await check('изменение файла меняет хеш', () => {
    const copy = makeCopy()
    const before = treeHash(copy)
    fs.appendFileSync(path.join(copy, 'worker.cjs'), '\n// changed\n')
    assert.notEqual(treeHash(copy), before)
  })

  await check('хеш не зависит от порядка появления файлов', () => {
    const first = path.join(makeTmp(), 'a')
    const second = path.join(makeTmp(), 'b')
    fs.mkdirSync(path.join(first, 'lib'), { recursive: true })
    fs.mkdirSync(path.join(second, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(first, 'one.cjs'), '1')
    fs.writeFileSync(path.join(first, 'lib', 'two.js'), '2')
    fs.writeFileSync(path.join(second, 'lib', 'two.js'), '2')
    fs.writeFileSync(path.join(second, 'one.cjs'), '1')
    assert.equal(treeHash(first), treeHash(second))
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
