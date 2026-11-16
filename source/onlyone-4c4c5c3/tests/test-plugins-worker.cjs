'use strict'
// test-plugins-worker.cjs: методы ping/selftest/scan, кадры протокола и ошибки мусорных строк.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createParser, encodeFrame, MAX_FRAME } = require('../tools/plugin/protocol.cjs')
const { startHost } = require('../tools/plugin/host.cjs')

const demoDir = path.join(__dirname, 'fixtures', 'plugins', 'demo')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-worker-'))

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

function makeJunkPlugin() {
  const dir = path.join(tmpRoot, 'junk')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: 'junk', version: '1.0.0', apiVersion: 1, entry: 'worker.cjs', capabilities: []
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'worker.cjs'), [
    "'use strict'",
    "process.stdout.write('this is not json\\n')",
    'process.stdin.resume()',
    ''
  ].join('\n'))
  return dir
}

async function main() {
  await check('encodeFrame пишет одну строку JSON', () => {
    assert.equal(encodeFrame({ id: 1, method: 'ping', params: {} }), '{"id":1,"method":"ping","params":{}}\n')
  })

  await check('парсер пропускает пустые строки и отдаёт объекты', () => {
    const messages = []
    const errors = []
    const parser = createParser({ onMessage: (m) => messages.push(m), onError: (e) => errors.push(e) })
    parser.push('\n{"id":1,"result":{}}\n\n')
    assert.deepEqual(messages, [{ id: 1, result: {} }])
    assert.equal(errors.length, 0)
  })

  await check('мусорная строка — ошибка протокола, следующая строка разбирается', () => {
    const messages = []
    const errors = []
    const parser = createParser({ onMessage: (m) => messages.push(m), onError: (e) => errors.push(e) })
    parser.push('not json\n{"id":2,"result":"ok"}\n')
    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /invalid JSON/)
    assert.deepEqual(messages, [{ id: 2, result: 'ok' }])
  })

  await check('кадр больше 1 МиБ отвергается', () => {
    const errors = []
    const parser = createParser({ onMessage: () => {}, onError: (e) => errors.push(e) })
    parser.push('x'.repeat(MAX_FRAME + 1))
    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /frame too large/)
  })

  await check('демо-воркер отвечает на ping, selftest и scan', async () => {
    const host = startHost({ pluginDir: demoDir, timeoutMs: 3000 })
    try {
      assert.deepEqual(await host.ping(), { ok: true })
      assert.deepEqual(await host.selftest(), { ok: true })
      const scan = await host.call('scan', {})
      assert.deepEqual(scan, {
        findings: [
          { id: 'demo-1', severity: 'low', title: 'Demo finding', evidence: { file: 'app.js', line: 1 } }
        ]
      })
    } finally {
      host.killSwitch()
      await host.exited
    }
  })

  await check('ошибка воркера доходит как отклонённый вызов', async () => {
    const host = startHost({ pluginDir: demoDir, timeoutMs: 3000 })
    try {
      await assert.rejects(host.call('nope', {}), /unknown method/)
      assert.deepEqual(await host.ping(), { ok: true }, 'после ошибки воркер жив')
    } finally {
      host.killSwitch()
      await host.exited
    }
  })

  await check('мусорная строка от воркера карантинит хост', async () => {
    const host = startHost({ pluginDir: makeJunkPlugin(), timeoutMs: 3000 })
    try {
      await assert.rejects(host.call('ping', {}), /invalid JSON|quarantined/)
      assert.equal(host.quarantined, true)
      await assert.rejects(host.call('ping', {}), /quarantined/)
    } finally {
      host.killSwitch()
      await host.exited
    }
  })

  await check('хост не стартует на битом манифесте и без файла entry', () => {
    const missing = path.join(tmpRoot, 'missing-entry')
    fs.mkdirSync(missing, { recursive: true })
    fs.writeFileSync(path.join(missing, 'plugin.json'), JSON.stringify({
      id: 'missing-entry', version: '1.0.0', apiVersion: 1, entry: 'worker.cjs', capabilities: []
    }, null, 2) + '\n')
    assert.throws(() => startHost({ pluginDir: missing }), /entry not found/)

    const invalid = path.join(tmpRoot, 'invalid')
    fs.mkdirSync(invalid, { recursive: true })
    fs.writeFileSync(path.join(invalid, 'plugin.json'), JSON.stringify({
      id: 'Invalid', version: '1.0.0', apiVersion: 1, entry: 'worker.cjs', capabilities: []
    }, null, 2) + '\n')
    assert.throws(() => startHost({ pluginDir: invalid }), /bad id/)
  })

  await check('killSwitch останавливает воркер и дальнейшие вызовы', async () => {
    const host = startHost({ pluginDir: demoDir, timeoutMs: 3000 })
    assert.deepEqual(await host.ping(), { ok: true })
    assert.deepEqual(host.killSwitch(), { stopped: true })
    await host.exited
    await assert.rejects(host.call('ping', {}), /stopped/)
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
