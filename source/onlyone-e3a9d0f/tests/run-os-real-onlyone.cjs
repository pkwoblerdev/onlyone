// OS-8 physical check: a screenshot of the real onlyone window, not headless Chrome.
// The app is launched from THIS checkout through node_modules/.bin/electron.cmd under a
// temporary profile and a free CDP port; the PNG has to be a real file bigger than 10 KB
// with a page title, and the process tree we spawned has to be gone afterwards.
// If Electron cannot start, the run prints the exact stderr and exits 2 (not_run) —
// a missing window is a reported gap, never a green run and never a faked picture.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { launchAndCapture, processesWithMarker } = require('../tools/safety/live.cjs')

const MIN_PNG_BYTES = 10 * 1024
const APP_DIR = path.resolve(__dirname, '..')

let checks = 0
let failed = 0
const notes = []
async function check (name, fn) {
  checks++
  try { await fn(); console.log('ok ' + name) } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message) }
}

function pngHeader (file) {
  const handle = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(8)
    fs.readSync(handle, head, 0, 8, 0)
    return head
  } finally { fs.closeSync(handle) }
}

async function main () {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'os-real-onlyone-'))
  console.log('EVIDENCE DIR: ' + out)
  const r = await launchAndCapture({ appDir: APP_DIR, out, expectedTitle: /onlyone/i })

  // The whole result is printed before any assertion: when the launch fails the
  // stderr tail is the only thing that explains why, and it must not be swallowed.
  console.log('LAUNCH RESULT: ' + JSON.stringify({
    ok: r.ok,
    status: r.status,
    title: r.title,
    url: r.url,
    screenshot: r.screenshot,
    pid: r.pid,
    port: r.port,
    profile: r.profile,
    reason: r.reason,
    cleanup: r.cleanup,
    stderr: (r.stderr || '').trim().slice(-3000)
  }, null, 2))

  if (!r.ok) {
    notes.push({ case: 'launch', status: r.status || 'not_run', reason: r.reason, stderr: (r.stderr || '').trim().slice(-3000), cleanup: r.cleanup })
    console.log(JSON.stringify({ ok: false, status: r.status || 'not_run', checks, failed, notes }, null, 2))
    process.exitCode = 2
    return
  }

  await check('a PNG was written to the evidence dir', () => {
    assert.ok(r.screenshot, 'no screenshot path')
    assert.ok(fs.existsSync(r.screenshot), 'file does not exist: ' + r.screenshot)
    assert.ok(r.screenshot.toLowerCase().endsWith('.png'), 'not a .png path: ' + r.screenshot)
  })

  await check('the PNG is larger than 10 KB', () => {
    const size = fs.statSync(r.screenshot).size
    notes.push({ screenshot: r.screenshot, bytes: size })
    assert.ok(size > MIN_PNG_BYTES, 'PNG is ' + size + ' bytes, expected > ' + MIN_PNG_BYTES)
  })

  await check('the file really is a PNG', () => {
    assert.deepEqual([...pngHeader(r.screenshot)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  await check('the captured page has a title', () => {
    assert.ok(typeof r.title === 'string' && r.title.trim().length > 0, 'title is empty')
    notes.push({ title: r.title })
  })

  await check('the title belongs to onlyone', () => {
    assert.match(r.title, /onlyone/i)
  })

  await check('the page is the real renderer of this checkout', () => {
    const expected = pathToFileURL(path.join(APP_DIR, 'src', 'renderer', 'index.html')).href.toLowerCase()
    assert.equal(String(r.url).toLowerCase(), expected, 'window came from somewhere else: ' + r.url)
    assert.ok(!/^https?:/.test(r.url), 'expected a file:// window, got ' + r.url)
  })

  await check('the pid of the launched tree is reported', () => {
    assert.ok(Number.isInteger(r.pid) && r.pid > 0, 'bad pid: ' + r.pid)
  })

  await check('cleanup killed the spawned tree and nothing of it is left', () => {
    const c = r.cleanup || {}
    assert.ok(c.killed, 'kill was not confirmed: ' + JSON.stringify(c))
    assert.equal(c.exited, true, 'process did not exit after the kill')
    assert.equal(c.endpointClosed, true, 'the debugging port still answers after the kill')
    assert.equal(c.treeGone, true, 'electron processes with our profile survived: ' + JSON.stringify(c.leftoverPids))
  })

  await check('independently after cleanup: no electron process carries our profile', async () => {
    const left = await processesWithMarker(r.profile)
    assert.ok(left.ok, 'could not check for leftovers: ' + left.reason)
    assert.deepEqual(left.pids, [], 'leftover electron pids: ' + left.pids.join(', '))
  })

  await check('the run used a temporary profile, not the user profile', () => {
    const tmp = os.tmpdir().toLowerCase().replace(/[\\/]+$/, '')
    const profile = String(r.profile).toLowerCase()
    assert.ok(profile.startsWith(tmp), 'profile is not under the temp dir: ' + profile)
    assert.ok(!profile.includes('appdata\\roaming'), 'profile is the real user profile: ' + profile)
    assert.equal(r.cleanup.profileRemoved, true, 'temporary profile was not removed after a green run')
  })

  notes.push({ case: 'cleanup', pid: r.pid, cleanup: r.cleanup })

  // The other half of an honest check: an app that dies at startup must be reported
  // as not_run with its stderr, and must not leave a picture behind. A stub shim
  // stands in for "Electron could not start" (missing display, sandbox error).
  await check('a startup failure is not_run with stderr and no picture', async () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'os-fake-app-'))
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'os-fake-out-'))
    try {
      fs.writeFileSync(path.join(fake, 'package.json'), '{"name":"fake","version":"0.0.0"}')
      const bin = path.join(fake, 'node_modules', '.bin')
      fs.mkdirSync(bin, { recursive: true })
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(bin, 'electron.cmd'), '@echo off\r\necho Electron failed to start: sandbox error 0x8000000 1>&2\r\nexit /b 1\r\n')
      } else {
        const shim = path.join(bin, 'electron')
        fs.writeFileSync(shim, '#!/bin/sh\necho "Electron failed to start: sandbox error" >&2\nexit 1\n')
        fs.chmodSync(shim, 0o755)
      }
      const dead = await launchAndCapture({ appDir: fake, out, launchTimeoutMs: 8000 })
      assert.equal(dead.ok, false)
      assert.equal(dead.status, 'not_run')
      assert.match(String(dead.reason) + ' ' + String(dead.stderr || ''), /exited before a window|sandbox error/)
      assert.equal(dead.screenshot, null, 'a screenshot path was reported without a window')
      assert.deepEqual(fs.readdirSync(out), [], 'a picture was written without a window')
      notes.push({ case: 'startup failure', status: dead.status, reason: dead.reason, stderr: String(dead.stderr || '').trim() })
    } finally {
      fs.rmSync(fake, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
      fs.rmSync(out, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
    }
  })

  console.log(JSON.stringify({ ok: failed === 0, checks, failed, notes }, null, 2))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
