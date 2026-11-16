'use strict'
// test-plugins-timeout.cjs: молчащий воркер убивается по таймауту, stderr ограничен.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startHost } = require('../tools/plugin/host.cjs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-timeout-'))

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

const silent = () => makePlugin('silent', [
  "'use strict'",
  'setInterval(() => {}, 1000)'
])

const noisy = () => makePlugin('noisy', [
  "'use strict'",
  "process.stderr.write('x'.repeat(5000))",
  'setInterval(() => {}, 1000)'
])

async function main() {
  await check('таймаут убивает воркер и возвращает ошибку', async () => {
    const host = startHost({ pluginDir: silent(), timeoutMs: 300 })
    try {
      await assert.rejects(host.ping(), /timeout/)
      assert.equal(host.quarantined, true)
      const exit = await host.exited
      assert.ok(exit.code !== null || exit.signal !== null, 'процесс должен завершиться')
      await assert.rejects(host.call('ping', {}), /quarantined/)
    } finally {
      host.killSwitch()
      await host.exited
    }
  })

  await check('stderr собирается, но не больше maxOutputBytes', async () => {
    const host = startHost({ pluginDir: noisy(), timeoutMs: 300, maxOutputBytes: 1000 })
    try {
      await assert.rejects(host.ping(), /timeout/)
      await host.exited
      assert.equal(host.stderr().length, 1000)
      assert.match(host.stderr(), /^x+$/)
    } finally {
      host.killSwitch()
      await host.exited
    }
  })

  await check('медленный, но отвечающий воркер не считается таймаутом', async () => {
    const dir = makePlugin('slow', [
      "'use strict'",
      "const readline = require('node:readline')",
      "const rl = readline.createInterface({ input: process.stdin })",
      "rl.on('line', (line) => {",
      '  const request = JSON.parse(line)',
      '  setTimeout(() => {',
      "    process.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + '\\n')",
      '  }, 100)',
      '})'
    ])
    const host = startHost({ pluginDir: dir, timeoutMs: 3000 })
    try {
      assert.deepEqual(await host.ping(), { ok: true })
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
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    console.log(JSON.stringify({ ok: failed === 0, checks: passed + failed, failed }))
    process.exit(failed > 0 ? 1 : 0)
  })
