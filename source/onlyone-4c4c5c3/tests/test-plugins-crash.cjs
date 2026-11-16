'use strict'
// test-plugins-crash.cjs: падение воркера карантинит хост и следующие вызовы не идут.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startHost } = require('../tools/plugin/host.cjs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-crash-'))

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

function makePlugin(name, workerLines) {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: name, version: '1.0.0', apiVersion: 1, entry: 'worker.cjs', capabilities: []
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'worker.cjs'), workerLines.join('\n') + '\n')
  return dir
}

const diesAtStart = () => makePlugin('dies-at-start', [
  "'use strict'",
  'process.exit(3)'
])

const diesOnBoom = () => makePlugin('dies-on-boom', [
  "'use strict'",
  "const readline = require('node:readline')",
  "const rl = readline.createInterface({ input: process.stdin })",
  "rl.on('line', (line) => {",
  '  const request = JSON.parse(line)',
  "  if (request.method === 'boom') process.exit(7)",
  "  process.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + '\\n')",
  '})'
])

async function main() {
  await check('воркер, падающий при старте, карантинится и вызовы отвергаются', async () => {
    const host = startHost({ pluginDir: diesAtStart(), timeoutMs: 3000 })
    const exit = await host.exited
    assert.equal(exit.code, 3)
    assert.equal(host.quarantined, true)
    await assert.rejects(host.call('ping', {}), /quarantined/)
    host.killSwitch()
  })

  await check('падение во время вызова отклоняет ожидающий вызов', async () => {
    const host = startHost({ pluginDir: diesOnBoom(), timeoutMs: 3000 })
    try {
      assert.deepEqual(await host.ping(), { ok: true })
      await assert.rejects(host.call('boom', {}), /exited/)
      assert.equal(host.quarantined, true)
      await assert.rejects(host.call('ping', {}), /quarantined/)
    } finally {
      host.killSwitch()
      await host.exited
    }
  })

  await check('карантин не снимается вызовом ping', async () => {
    const host = startHost({ pluginDir: diesAtStart(), timeoutMs: 3000 })
    await host.exited
    for (let i = 0; i < 2; i++) {
      await assert.rejects(host.ping(), /quarantined/)
      assert.equal(host.quarantined, true)
    }
    host.killSwitch()
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
