'use strict'
// test-plugins-permissions.cjs: по умолчанию запрещено; exec по команде, net по списку хостов, fs.read внутри workspace.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createGrants, checkCapability, setWorkspace } = require('../tools/plugin/permissions.cjs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-perms-'))
const workspace = path.join(tmpRoot, 'workspace')
fs.mkdirSync(workspace, { recursive: true })

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

async function main() {
  setWorkspace(workspace)

  await check('без прав отказ по умолчанию', () => {
    assert.equal(checkCapability([], 'storage').ok, false)
    assert.equal(checkCapability(undefined, 'fs.read', 'a.js').ok, false)
  })

  await check('createGrants выдаёт только известные возможности', () => {
    const grants = createGrants({ capabilities: ['fs.read', 'chats', 'profile', 'secrets', 'storage', 'agent.tools'] })
    assert.deepEqual(grants, ['fs.read', 'storage', 'agent.tools'])
  })

  await check('storage разрешён только с правом', () => {
    assert.equal(checkCapability(['storage'], 'storage').ok, true)
    assert.equal(checkCapability([{ cap: 'storage' }], 'storage').ok, true)
  })

  await check('неизвестная возможность не выдаётся даже при праве', () => {
    assert.equal(checkCapability([{ cap: 'chats' }], 'chats').ok, false)
    assert.equal(checkCapability(['secrets'], 'secrets').ok, false)
  })

  await check('exec разрешён только для выданной команды', () => {
    const grants = [{ cap: 'exec', cmd: 'git' }]
    assert.equal(checkCapability(grants, 'exec', { cap: 'exec', cmd: 'git' }).ok, true)
    assert.equal(checkCapability(grants, 'exec', { cap: 'exec', cmd: 'powershell' }).ok, false)
    assert.equal(checkCapability(grants, 'exec', { cap: 'exec', cmd: 'git push' }).ok, false, 'a prefix of a granted command must not pass')
    assert.equal(checkCapability(grants, 'exec', { cap: 'exec', cmd: 'git config --global' }).ok, false)
    assert.equal(checkCapability(grants, 'exec', { cap: 'exec' }).ok, false)
    assert.equal(checkCapability([], 'exec', { cap: 'exec', cmd: 'git' }).ok, false)
  })

  await check('net разрешён только для хоста из списка', () => {
    const grants = [{ cap: 'net', hosts: ['api.example.com'] }]
    assert.equal(checkCapability(grants, 'net', { cap: 'net', host: 'api.example.com' }).ok, true)
    assert.equal(checkCapability(grants, 'net', { cap: 'net', host: 'API.EXAMPLE.COM' }).ok, true)
    assert.equal(checkCapability(grants, 'net', { cap: 'net', host: 'evil.example.net' }).ok, false)
    assert.equal(checkCapability(grants, 'net', { cap: 'net', host: 'example.com' }).ok, false)
    assert.equal(checkCapability([], 'net', { cap: 'net', host: 'api.example.com' }).ok, false)
  })

  await check('wildcard net-права разрешает любой хост', () => {
    assert.equal(checkCapability([{ cap: 'net', hosts: ['*'] }], 'net', { cap: 'net', host: 'anything.test' }).ok, true)
  })

  await check('fs.read внутри workspace разрешён', () => {
    const grants = ['fs.read']
    assert.equal(checkCapability(grants, 'fs.read', { cap: 'fs.read', path: 'app.js' }).ok, true)
    assert.equal(checkCapability(grants, 'fs.read', { cap: 'fs.read', path: path.join('src', 'main.js') }).ok, true)
    assert.equal(checkCapability(grants, 'fs.read', path.join(workspace, 'x.js')).ok, true)
  })

  await check('fs.read вне workspace отвергается', () => {
    const grants = ['fs.read']
    assert.equal(checkCapability(grants, 'fs.read', { cap: 'fs.read', path: '..\\secret.txt' }).ok, false)
    assert.equal(checkCapability(grants, 'fs.read', { cap: 'fs.read', path: path.join(tmpRoot, 'outside.txt') }).ok, false)
    assert.equal(checkCapability(grants, 'fs.read', { cap: 'fs.read', path: workspace + '-evil\\x.js' }).ok, false)
  })

  await check('fs.read без заданного workspace отвергается', () => {
    setWorkspace(null)
    assert.equal(checkCapability(['fs.read'], 'fs.read', 'app.js').ok, false)
    setWorkspace(workspace)
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
