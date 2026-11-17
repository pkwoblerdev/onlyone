'use strict'
// test-plugins-net.cjs: сетевое право — только хост из allowlist; сам хост-процесс сеть не проверяет (OS-1).
const assert = require('node:assert/strict')
const path = require('node:path')
const { checkCapability } = require('../tools/plugin/permissions.cjs')
const { startHost } = require('../tools/plugin/host.cjs')

const demoDir = path.join(__dirname, 'fixtures', 'plugins', 'demo')

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
  await check('net-право не даёт доступа к чужому хосту', () => {
    const grants = [{ cap: 'net', hosts: ['api.example.com'] }]
    assert.deepEqual(checkCapability(grants, 'net', { cap: 'net', host: 'api.example.com' }), { ok: true })
    assert.equal(checkCapability(grants, 'net', { cap: 'net', host: 'telemetry.example.net' }).ok, false)
  })

  await check('без net-права любой хост отвергается', () => {
    assert.equal(checkCapability([], 'net', { cap: 'net', host: '127.0.0.1' }).ok, false)
    assert.equal(checkCapability(['storage'], 'net', { cap: 'net', host: '127.0.0.1' }).ok, false)
  })

  await check('net-право требует host в запросе', () => {
    assert.equal(checkCapability([{ cap: 'net', hosts: ['*'] }], 'net', {}).ok, false)
    assert.equal(checkCapability([{ cap: 'net', hosts: ['*'] }], 'net', { cap: 'net' }).ok, false)
  })

  await check('хост не проверяет сеть сам: без grants ping работает, проверка — в permissions', async () => {
    const host = startHost({ pluginDir: demoDir, grants: [], timeoutMs: 3000 })
    try {
      assert.deepEqual(await host.ping(), { ok: true })
      assert.equal(checkCapability(host.grants, 'net', { cap: 'net', host: 'example.com' }).ok, false)
    } finally {
      host.killSwitch()
      await host.exited
    }
  })
}

main()
  .catch((error) => {
    failed++
    console.error(error)
  })
  .finally(() => {
    console.log(JSON.stringify({ ok: failed === 0, checks: passed + failed, failed }))
    process.exit(failed > 0 ? 1 : 0)
  })
