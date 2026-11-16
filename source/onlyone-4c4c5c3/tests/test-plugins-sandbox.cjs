'use strict'
// OS-4: плагинный хост через OS-1. sandbox:true запускает воркер через tools/sandbox
// (AppContainer, когда доступен, иначе Job Object), sandbox:false — старый путь.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startHost } = require('../tools/plugin/host.cjs')
const appcontainer = require('../tools/sandbox/win-appcontainer.cjs')

const demoDir = path.join(__dirname, 'fixtures', 'plugins', 'demo')
const cliPath = path.join(__dirname, '..', 'tools', 'plugin', 'cli.cjs')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-sandbox-'))

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

const rpcPrelude = [
  "'use strict'",
  "const readline = require('node:readline')",
  "const rl = readline.createInterface({ input: process.stdin })",
  "rl.on('line', (line) => {",
  '  const request = JSON.parse(line)',
  "  const reply = (result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')",
  '  if (request.method === "ping") reply({ ok: true })',
  '  else if (request.method === "hog") { const a = []; while (true) a.push(Buffer.alloc(4 * 1024 * 1024)) }',
  "  else if (request.method === \"silent\") { /* never answers */ }",
  '  else reply({ ok: true })',
  '})'
]

async function main() {
  await check('по умолчанию sandbox выключен и хост это не скрывает', async () => {
    const host = startHost({ pluginDir: demoDir, timeoutMs: 3000 })
    try {
      assert.equal(host.sandboxed, false)
      assert.deepEqual(await host.ping(), { ok: true })
    } finally {
      host.killSwitch()
      await host.exited
    }
  })

  await check('sandbox:true проводит воркер через tools/sandbox и отвечает ping/selftest/scan', async () => {
    const host = startHost({ pluginDir: demoDir, timeoutMs: 20000, sandbox: true })
    console.log('       механизм: ' + host.sandboxed + (host.sandboxReason ? ' (' + host.sandboxReason + ')' : ''))
    try {
      assert.ok(host.sandboxed === 'appcontainer' || host.sandboxed === 'job', 'sandboxed must name the mechanism: ' + host.sandboxed)
      assert.deepEqual(await host.ping(), { ok: true })
      assert.deepEqual(await host.selftest(), { ok: true })
      const scan = await host.call('scan', {})
      assert.equal(scan.findings.length, 1)
      assert.equal(scan.findings[0].id, 'demo-1')
    } finally {
      host.killSwitch()
      await host.exited
    }
  })

  await check('воркер в песочнице не получает USERPROFILE, APPDATA и TOKEN', async () => {
    const dir = makePlugin('env-probe', [
      "'use strict'",
      "const readline = require('node:readline')",
      "const rl = readline.createInterface({ input: process.stdin })",
      "rl.on('line', (line) => {",
      '  const request = JSON.parse(line)',
      "  process.stdout.write(JSON.stringify({ id: request.id, result: { env: process.env } }) + '\\n')",
      '})'
    ])
    const saved = process.env.TOKEN
    process.env.TOKEN = 'secret-token'
    const host = startHost({ pluginDir: dir, timeoutMs: 20000, sandbox: true })
    try {
      const { env } = await host.ping()
      assert.ok(!env.USERPROFILE, 'USERPROFILE не должен доходить до воркера')
      assert.notEqual(env.USERPROFILE, process.env.USERPROFILE)
      assert.ok(!('APPDATA' in env), 'APPDATA не должен доходить до воркера')
      assert.ok(!('TOKEN' in env), 'TOKEN не должен доходить до воркера')
      // Windows требует LOCALAPPDATA для старта AppContainer и подменяет её на
      // каталог профиля контейнера: путь пользователя воркеру не виден.
      if (host.sandboxed === 'appcontainer') {
        assert.match(String(env.LOCALAPPDATA), /Packages[\\/]+onlyone\.sandbox/i)
      } else {
        assert.ok(!env.LOCALAPPDATA, 'LOCALAPPDATA не должен доходить до воркера')
      }
    } finally {
      if (saved === undefined) delete process.env.TOKEN
      else process.env.TOKEN = saved
      host.killSwitch()
      await host.exited
    }
  })

  await check('воркер сверх лимита памяти убивается', async () => {
    const dir = makePlugin('memory-hog', rpcPrelude)
    const host = startHost({
      pluginDir: dir,
      timeoutMs: 20000,
      sandbox: true,
      maxMemoryBytes: 192 * 1024 * 1024
    })
    try {
      assert.deepEqual(await host.ping(), { ok: true })
      await assert.rejects(host.call('hog', {}), /exited|quarantined|timeout/)
      assert.equal(host.quarantined, true)
      const exit = await host.exited
      assert.ok(exit.code !== 0, 'worker must not exit cleanly under the memory limit: ' + JSON.stringify(exit))
    } finally {
      host.killSwitch()
      await host.exited
    }
  })

  await check('воркер сверх таймаута убивается, хост карантинится', async () => {
    const dir = makePlugin('silent-worker', rpcPrelude)
    const host = startHost({ pluginDir: dir, timeoutMs: 800, sandbox: true })
    try {
      await assert.rejects(host.call('silent', {}), /timeout/)
      assert.equal(host.quarantined, true)
      await host.exited
    } finally {
      host.killSwitch()
      await host.exited
    }
  })

  await check('код выхода воркера доходит через оболочку песочницы', async () => {
    const dir = makePlugin('exits-early', ["'use strict'", 'process.exit(3)'])
    const host = startHost({ pluginDir: dir, timeoutMs: 5000, sandbox: true })
    const exit = await host.exited
    assert.equal(exit.code, 3)
    assert.equal(host.quarantined, true)
    host.killSwitch()
  })

  await check('killSwitch останавливает песочницу и дальнейшие вызовы', async () => {
    const host = startHost({ pluginDir: demoDir, timeoutMs: 20000, sandbox: true })
    assert.deepEqual(await host.ping(), { ok: true })
    assert.deepEqual(host.killSwitch(), { stopped: true })
    await host.exited
    await assert.rejects(host.call('ping', {}), /stopped/)
  })

  await check('CLI --sandbox вынужденно идёт через Job Object и отвечает ping', () => {
    const res = spawnSync(process.execPath, [cliPath, 'host', demoDir, '--sandbox', '--timeout', '20000'], {
      encoding: 'utf8',
      env: { ...process.env, ONLYONE_SANDBOX_JOBS_ONLY: '1' }
    })
    const lines = String(res.stdout).trim().split('\n')
    const json = JSON.parse(lines[lines.length - 1] || '{}')
    assert.equal(res.status, 0, 'cli failed: ' + res.stdout + res.stderr)
    assert.equal(json.ok, true)
    assert.equal(json.sandboxed, 'job')
    assert.match(String(json.sandboxReason), /ONLYONE_SANDBOX_JOBS_ONLY/)
    assert.deepEqual(json.ping, { ok: true })
    assert.deepEqual(json.selftest, { ok: true })
  })

  await check('причина выбора механизма названа, если AppContainer недоступен', () => {
    const info = appcontainer.available()
    assert.equal(typeof info.available, 'boolean')
    if (!info.available) assert.ok(String(info.reason).length > 10, 'reason: ' + info.reason)
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
