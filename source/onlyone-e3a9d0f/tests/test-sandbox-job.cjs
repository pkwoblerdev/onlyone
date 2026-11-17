// OS-1: Job Object limits. Files and network are not restricted here (ADR-0001).
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const { run } = require('../tools/sandbox/win-job.cjs')

const jobPath = path.join(__dirname, '..', 'tools', 'sandbox', 'win-job.cjs')

let checks = 0
let failed = 0
function check (name, fn) {
  checks++
  try { fn(); console.log('ok ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) }
}

// Runs a snippet in a child because the platform override is read at require time.
function childRun (env) {
  const script = [
    `const job = require(${JSON.stringify(jobPath)})`,
    'const out = {}',
    "try { out.run = { code: job.run({ cmd: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 15000 }).code } } catch (error) { out.run = { message: error.message, code: error.code } }",
    "try { job.spawn({ cmd: process.execPath, args: ['-e', 'process.exit(0)'] }); out.spawn = 'no-throw' } catch (error) { out.spawn = { message: error.message, code: error.code } }",
    'console.log(JSON.stringify(out))'
  ].join('\n')
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } })
  const lines = String(result.stdout).trim().split('\n')
  return JSON.parse(lines[lines.length - 1] || '{}')
}

check('runs a normal process and returns its output and exit code', () => {
  const r = run({ cmd: process.execPath, args: ['-e', 'console.log("ok")'], timeoutMs: 15000 })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /ok/)
  assert.equal(r.killed, false)
})

check('keeps the working directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-job-'))
  const r = run({ cmd: process.execPath, args: ['-e', 'console.log(process.cwd())'], cwd: dir, timeoutMs: 15000 })
  assert.equal(path.resolve(r.stdout.trim()), path.resolve(dir))
  fs.rmSync(dir, { recursive: true, force: true })
})

check('memory limit stops an allocation loop', () => {
  const r = run({
    cmd: process.execPath,
    args: ['-e', 'const a=[];while(true)a.push(Buffer.alloc(1024*1024))'],
    timeoutMs: 20000,
    maxMemoryBytes: 128 * 1024 * 1024
  })
  assert.notEqual(r.code, 0, 'child must not exit cleanly: ' + r.code)
})

check('process limit stops a fork loop', () => {
  const r = run({
    cmd: process.execPath,
    args: ['-e', 'const{spawn}=require("child_process");for(let i=0;i<6;i++)spawn(process.execPath,["-e","setTimeout(()=>{},3000)"]);setTimeout(()=>{},4000)'],
    timeoutMs: 15000,
    maxProcesses: 3
  })
  assert.notEqual(r.code, 0, 'extra processes must be refused')
})

check('timeout kills the process and says why', () => {
  const r = run({ cmd: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'], timeoutMs: 1200 })
  assert.equal(r.killed, true)
  assert.equal(r.reason, 'timeout')
})

check('ONLYONE_SANDBOX_PLATFORM=linux under NODE_ENV=test refuses with the exact Windows-only error', () => {
  const out = childRun({ NODE_ENV: 'test', ONLYONE_SANDBOX_PLATFORM: 'linux' })
  const refusal = { message: 'Job Object is Windows-only', code: 'SANDBOX_UNAVAILABLE' }
  assert.deepEqual(out.run, refusal)
  assert.deepEqual(out.spawn, refusal)
})

check('the platform override is ignored outside tests', () => {
  const out = childRun({ NODE_ENV: 'production', ONLYONE_SANDBOX_PLATFORM: 'linux' })
  assert.deepEqual(out.run, { code: 0 }, 'override must not apply outside NODE_ENV=test')
})

console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
