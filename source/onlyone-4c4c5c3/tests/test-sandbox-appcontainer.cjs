'use strict'
// OS-1: AppContainer boundary — a child process cannot read files outside the granted
// workspace and cannot open TCP. `net: on` must put the internetClient capability into the
// child token (checked by reading the token itself; the live TCP check needs a loopback
// exemption and is not faked). The SID ACEs added for a run must be gone afterwards.
// When the OS cannot do it, the test prints the explicit reason and exits 0 as SKIP:
// a skipped capability is never reported as passed.
//
// Note on SIDs: the documented internetClient SID S-1-15-2-1 is the group form and
// CreateProcess rejects it with ERROR_INVALID_PARAMETER (87); the helper derives the
// capability SID from the name (S-1-15-3-1) as the Microsoft sample does.
const assert = require('node:assert/strict')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const appcontainer = require('../tools/sandbox/win-appcontainer.cjs')

const cliPath = path.join(__dirname, '..', 'tools', 'sandbox', 'win-appcontainer.cjs')
const tmpRoots = []

let passed = 0
let failed = 0
const skipped = []

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

function skip(name, reason) {
  skipped.push({ check: name, reason })
  console.log(`SKIP   ${name}: ${reason}`)
}

function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

function readScript(target) {
  return [
    "const fs = require('node:fs')",
    'try {',
    `  const text = fs.readFileSync(${JSON.stringify(target)}, 'utf8')`,
    "  console.log('READ ' + text)",
    '} catch (error) {',
    "  console.log('DENIED ' + (error.code || error.message))",
    '}'
  ].join('\n')
}

function tcpScript(port) {
  return [
    "const net = require('node:net')",
    `const socket = net.connect(${Number(port)}, '127.0.0.1')`,
    "socket.on('connect', () => { console.log('CONNECTED'); socket.destroy(); process.exit(0) })",
    "socket.on('error', (error) => { console.log('DENIED ' + (error.code || error.message)); process.exit(0) })",
    "setTimeout(() => { console.log('HANG'); process.exit(0) }, 5000)"
  ].join('\n')
}

function listen() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy())
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function connectOnce(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', reject)
  })
}

function cli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', timeout: 60000 })
  const lines = String(result.stdout).trim().split('\n')
  return { status: result.status, json: JSON.parse(lines[lines.length - 1] || '{}'), stderr: String(result.stderr) }
}

function aclText(dir) {
  const result = spawnSync('icacls.exe', [dir], { encoding: 'utf8' })
  return String(result.stdout || '') + String(result.stderr || '')
}

function aclHasSid(dir, sid) {
  return aclText(dir).includes(sid)
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return predicate()
}

function elevated() {
  return spawnSync('net', ['session'], { windowsHide: true }).status === 0
}

// Async child so the test can change the workspace while a container is still running.
function captureChildRun(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('exit', (code) => resolve({ code, output }))
  })
}

// Runs a snippet in a child because the platform override is read at require time.
function childRun(env) {
  const script = [
    `const appcontainer = require(${JSON.stringify(path.join(__dirname, '..', 'tools', 'sandbox', 'win-appcontainer.cjs'))})`,
    'const out = {}',
    'out.available = appcontainer.available()',
    "try { out.run = { code: appcontainer.run({ cmd: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 30000 }).code } } catch (error) { out.run = { message: error.message, code: error.code } }",
    "try { appcontainer.spawn({ cmd: process.execPath, args: ['-e', 'process.exit(0)'] }); out.spawn = 'no-throw' } catch (error) { out.spawn = { message: error.message, code: error.code } }",
    'console.log(JSON.stringify(out))'
  ].join('\n')
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...env }
  })
  const lines = String(result.stdout).trim().split('\n')
  return JSON.parse(lines[lines.length - 1] || '{}')
}

// Checks that do not need the boundary itself: the request is structural, the guard is
// the same code path the host would take on a non-Windows platform.
async function guardChecks() {
  await check('net on просит internetClient, net off — ничего (структурно)', () => {
    assert.deepEqual(appcontainer.capabilitiesFor('on'), ['internetClient'])
    assert.deepEqual(appcontainer.capabilitiesFor('off'), [])
    assert.deepEqual(appcontainer.capabilitiesFor(undefined), [])
    assert.throws(() => appcontainer.capabilitiesFor('yes'), /net must be "off" or "on"/)
  })

  await check('ONLYONE_SANDBOX_PLATFORM=linux под NODE_ENV=test: ровно тот же отказ, что на не-Windows', () => {
    const out = childRun({ NODE_ENV: 'test', ONLYONE_SANDBOX_PLATFORM: 'linux' })
    assert.deepEqual(out.available, { available: false, reason: 'not Windows: AppContainer is a Windows feature' })
    const refusal = { message: 'AppContainer unavailable: not Windows: AppContainer is a Windows feature', code: 'SANDBOX_UNAVAILABLE' }
    assert.deepEqual(out.run, refusal)
    assert.deepEqual(out.spawn, refusal)
  })

  await check('подмена платформы вне тестов игнорируется', () => {
    const out = childRun({ NODE_ENV: 'production', ONLYONE_SANDBOX_PLATFORM: 'linux' })
    if (appcontainer.available().available) {
      assert.deepEqual(out.run, { code: 0 }, 'override must not apply outside NODE_ENV=test')
    } else {
      assert.notEqual(out.available?.reason, 'not Windows: AppContainer is a Windows feature', 'override must not apply outside NODE_ENV=test')
    }
  })
}

async function runAvailable(stage) {
  const workspace = makeTmp('onlyone-ac-workspace-')
  const outside = makeTmp('onlyone-ac-outside-')
  const allowed = path.join(workspace, 'allowed.txt')
  const secret = path.join(outside, 'secret.txt')
  const marker = 'TOP-SECRET-' + Date.now()
  fs.writeFileSync(allowed, 'workspace-file')
  fs.writeFileSync(secret, marker)

  await check('дочерний процесс читает файл внутри выданного workspace', () => {
    const r = appcontainer.run({ cmd: process.execPath, args: ['-e', readScript(allowed)], cwd: workspace, workspace, timeoutMs: 30000 })
    assert.equal(r.code, 0, 'child failed: ' + r.stderr)
    assert.match(r.stdout, /READ workspace-file/)
  })

  await check('дочерний процесс не читает файл вне workspace', () => {
    const r = appcontainer.run({ cmd: process.execPath, args: ['-e', readScript(secret)], cwd: workspace, workspace, timeoutMs: 30000 })
    assert.equal(r.code, 0, 'child failed: ' + r.stderr)
    assert.match(r.stdout, /DENIED/)
    assert.ok(!r.stdout.includes(marker), 'secret leaked to the child: ' + r.stdout)
  })

  const server = await listen()
  const port = server.address().port
  try {
    await check('порт 127.0.0.1 действительно открыт для хоста', async () => {
      assert.equal(await connectOnce(port), true)
    })

    await check('TCP на открытый порт из AppContainer отвергается (сеть выключена по умолчанию)', () => {
      const r = appcontainer.run({ cmd: process.execPath, args: ['-e', tcpScript(port)], cwd: workspace, workspace, timeoutMs: 30000 })
      assert.equal(r.code, 0, 'child failed: ' + r.stderr)
      assert.ok(!/CONNECTED/.test(r.stdout), 'child reached TCP: ' + r.stdout)
      assert.match(r.stdout, /DENIED/)
    })

    await check('--net off: CLI тоже отказывает в TCP', () => {
      const r = cli(['--net', 'off', '--workspace', workspace, '--', process.execPath, '-e', tcpScript(port)])
      assert.equal(r.status, 0, 'cli failed: ' + r.stderr + r.json.error)
      assert.ok(!/CONNECTED/.test(String(r.json.stdout)), 'child reached TCP: ' + r.json.stdout)
      assert.match(String(r.json.stdout), /DENIED/)
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // Skipped, not passed: the capability is proven by the token below, the wire is not.
  skip(
    'net on: живое TCP-соединение из AppContainer',
    'AppContainer-loopback заблокирован Windows Firewall, а CheckNetIsolation LoopbackExempt -a -n=onlyone.sandbox.net требует прав администратора (сейчас ' +
      (elevated() ? 'процесс elevated, но внешняя сеть для теста недоступна' : 'процесс не elevated') +
      '); исключение не выдаётся, поэтому живой коннект не проверяется и не выдаётся за проверенный'
  )

  await check('net off: capability в токене дочернего процесса отсутствует', () => {
    const r = appcontainer.run({ cmd: process.execPath, args: ['-e', 'process.exit(0)'], cwd: workspace, workspace, timeoutMs: 30000 })
    assert.equal(r.code, 0, 'child failed: ' + r.stderr)
    assert.deepEqual(r.capabilities, [])
    assert.deepEqual(r.capabilitySids, [])
    assert.deepEqual(r.capabilitiesInToken, [], 'net off token must carry no capability: ' + r.capabilitiesInToken)
    assert.equal(r.cleanup, 'ok', 'cleanup failed: ' + r.cleanupError)
  })

  await check('net on: internetClient реально лежит в токене дочернего процесса', () => {
    const r = appcontainer.run({ cmd: process.execPath, args: ['-e', 'process.exit(0)'], cwd: workspace, workspace, net: 'on', timeoutMs: 30000 })
    assert.equal(r.code, 0, 'child failed: ' + r.stderr)
    assert.deepEqual(r.capabilities, ['internetClient'])
    assert.equal(r.capabilitySids.length, 1)
    assert.match(r.capabilitySids[0], /^S-1-15-3-\d+$/, 'capability SID must be the derived form: ' + r.capabilitySids[0])
    assert.deepEqual(r.capabilitiesInToken, r.capabilitySids, 'token does not carry the requested capability')
    assert.equal(r.cleanup, 'ok', 'cleanup failed: ' + r.cleanupError)
    console.log('       net on capability SID: ' + r.capabilitySids[0] + ' (container ' + r.sid + ')')
  })

  await check('--net on принимается CLI и возвращает capability', () => {
    const r = cli(['--net', 'on', '--workspace', workspace, '--', process.execPath, '-e', 'process.exit(0)'])
    assert.equal(r.status, 0, 'cli failed: ' + r.stderr + ' ' + r.json.error)
    assert.deepEqual(r.json.capabilities, ['internetClient'])
    assert.deepEqual(r.json.capabilitiesInToken, r.json.capabilitySids)
    assert.equal(r.json.cleanup, 'ok', 'cleanup after --net on: ' + r.json.cleanupError)
  })

  await check('ACE: до прогона SID нет, после прогона SID снят, cleanup ok', () => {
    const dir = makeTmp('onlyone-ac-acl-')
    assert.equal(aclHasSid(dir, stage), false, 'fresh directory already carries the container SID')
    const r = appcontainer.run({ cmd: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dir, workspace: dir, timeoutMs: 30000 })
    assert.equal(r.code, 0, 'child failed: ' + r.stderr)
    assert.equal(r.cleanup, 'ok', 'cleanup failed: ' + r.cleanupError)
    assert.equal(aclHasSid(dir, stage), false, 'container SID left on the workspace ACL: ' + aclText(dir))
  })

  await check('ACE ставится на время прогона и снимается после потокового прогона', async () => {
    const dir = makeTmp('onlyone-ac-acl-stream-')
    const child = appcontainer.spawn({ cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 3000)'], cwd: dir, workspace: dir })
    const exited = new Promise((resolve) => child.once('exit', resolve))
    const appeared = await waitFor(() => aclHasSid(dir, stage), 8000)
    assert.equal(appeared, true, 'the container SID never appeared on the workspace ACL')
    await exited
    const gone = await waitFor(() => !aclHasSid(dir, stage), 8000)
    assert.equal(gone, true, 'container SID left after the stream ended: ' + aclText(dir))
  })

  await check('сбой очистки ACE приходит в результате как cleanup failed, а не теряется', async () => {
    const dir = makeTmp('onlyone-ac-acl-fail-')
    const modulePath = path.join(__dirname, '..', 'tools', 'sandbox', 'win-appcontainer.cjs')
    const script = [
      `const ac = require(${JSON.stringify(modulePath)})`,
      'try {',
      `  const r = ac.run({ cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 6000)'], cwd: ${JSON.stringify(os.tmpdir())}, workspace: ${JSON.stringify(dir)}, timeoutMs: 30000 })`,
      '  console.log(JSON.stringify({ code: r.code, cleanup: r.cleanup, cleanupError: r.cleanupError }))',
      '} catch (error) {',
      "  console.log(JSON.stringify({ threw: error.message }))",
      '}'
    ].join('\n')
    const running = captureChildRun(script)
    // Deleting the directory only after the ACE is in place is the one deterministic way
    // to make icacls /remove:g fail without admin rights.
    const granted = await waitFor(() => aclHasSid(dir, stage), 20000)
    fs.rmSync(dir, { recursive: true, force: true })
    assert.equal(granted, true, 'the test could not observe the grant before removing the directory')
    const child = await running
    const line = child.output.trim().split('\n').pop()
    let result
    try {
      result = JSON.parse(line || '{}')
    } catch {
      assert.fail('child produced no JSON: ' + child.output)
    }
    assert.equal(result.cleanup, 'failed', 'cleanup failure was swallowed: ' + child.output)
    assert.ok(String(result.cleanupError || '').length > 0, 'cleanup:failed without a reason')
  })

  await check('лимиты Job Object продолжают действовать: таймаут убивает процесс', () => {
    const r = appcontainer.run({ cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], cwd: workspace, workspace, timeoutMs: 1500 })
    assert.equal(r.killed, true)
    assert.equal(r.reason, 'timeout')
    assert.equal(r.cleanup, 'ok', 'cleanup after a killed run: ' + r.cleanupError)
  })

  await check('лимиты Job Object продолжают действовать: лимит памяти убивает процесс', () => {
    const r = appcontainer.run({
      cmd: process.execPath,
      args: ['-e', 'const a = []; while (true) a.push(Buffer.alloc(4 * 1024 * 1024))'],
      cwd: workspace,
      workspace,
      timeoutMs: 30000,
      maxMemoryBytes: 160 * 1024 * 1024
    })
    assert.notEqual(r.code, 0, 'allocation loop must not exit cleanly: ' + r.code)
  })

  await check('каталог вне workspace остаётся закрытым и после прогонов', () => {
    const r = appcontainer.run({ cmd: process.execPath, args: ['-e', readScript(secret)], cwd: workspace, workspace, timeoutMs: 30000 })
    assert.match(r.stdout, /DENIED/)
    assert.ok(!r.stdout.includes(marker))
  })

  if (stage) console.log('AppContainer: ' + stage)
}

async function main() {
  await guardChecks()
  const info = appcontainer.available()
  if (!info.available) {
    await check('недоступность названа явной причиной, а не пустым отказом', () => {
      assert.equal(typeof info.reason, 'string')
      assert.ok(info.reason.length >= 10, 'reason must be explicit: ' + JSON.stringify(info.reason))
    })
    skip('проверки AppContainer (файлы, сеть, capability, ACE)', 'AppContainer недоступен: ' + info.reason)
    return
  }
  await runAvailable(info.sid)
}

main()
  .catch((error) => {
    failed++
    console.error(error)
  })
  .finally(() => {
    for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true })
    const summary = { ok: failed === 0, checks: passed + failed, failed, skipped }
    console.log(JSON.stringify(summary))
    process.exit(failed > 0 ? 1 : 0)
  })
