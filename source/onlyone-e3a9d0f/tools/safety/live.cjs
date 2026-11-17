'use strict'

// Physical check: attach to a running Electron/Chromium over CDP and take one real
// screenshot. Nothing is faked here — no endpoint, no browser toolkit and no
// picture means status is not_run with a reason, never ok.
//
// Two ways in:
//   live({ endpoint })              — attach to an app someone else started;
//   launchAndCapture({ appDir })    — start this checkout ourselves, shoot the first
//                                     window and kill exactly the tree we spawned.
// The second path is what OS-8 needs: an attach proves a browser answers, a launch
// proves the onlyone window of this worktree paints under a throwaway profile.
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const TIMEOUT_MS = 15000

function endpointOf (args, env) {
  const at = args.indexOf('--url')
  if (at >= 0 && args[at + 1]) return args[at + 1]
  return env.ONECODE_CDP_URL || null
}

function normalize (endpoint) {
  let url
  try { url = new URL(endpoint) } catch { return null }
  const http = { 'http:': 'http:', 'https:': 'https:', 'ws:': 'http:', 'wss:': 'https:' }[url.protocol]
  if (!http) return null
  return { base: http + '//' + url.host, wsUrl: (http === 'https:' ? 'wss://' : 'ws://') + url.host }
}

function parseTargets (list) {
  if (!Array.isArray(list)) return null
  const page = list.find(t => t && t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
  if (!page) return null
  return { title: page.title || '', url: page.url || '', wsUrl: page.webSocketDebuggerUrl }
}

function websocketBackend () {
  if (typeof WebSocket === 'function') return { Ctor: WebSocket, backend: 'node-websocket' }
  try { return { Ctor: require('ws'), backend: 'node_modules/ws' } } catch { return { Ctor: null, backend: null } }
}

function playwrightModule () {
  try { return require('playwright') } catch {}
  try { return require('playwright-core') } catch {}
  return null
}

async function listTargets (base, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(base + '/json/list', { signal: controller.signal })
    if (!response.ok) return { ok: false, reason: `CDP /json/list answered HTTP ${response.status}` }
    return { ok: true, list: await response.json() }
  } catch (error) {
    const cause = error && error.name === 'AbortError'
      ? 'timeout'
      : (error && error.cause && (error.cause.code || error.cause.message)) || (error && error.message) || String(error)
    return { ok: false, reason: `CDP endpoint not reachable: ${cause}` }
  } finally {
    clearTimeout(timer)
  }
}

function cdpRequest (Ctor, wsUrl, method, params = {}, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = new Ctor(wsUrl)
    const id = Math.floor(Math.random() * 1e9) + 1
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch {}
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error(`CDP ${method} timeout`)), timeoutMs)
    const onMessage = raw => {
      let message
      try { message = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) } catch { return }
      if (message.id !== id) return
      if (message.error) finish(reject, new Error(message.error.message || 'CDP error'))
      else finish(resolve, message.result)
    }
    const onOpen = () => socket.send(JSON.stringify({ id, method, params }))
    if (typeof socket.on === 'function') {
      socket.on('open', onOpen)
      socket.on('message', onMessage)
      socket.on('error', error => finish(reject, error))
    } else {
      socket.addEventListener('open', onOpen)
      socket.addEventListener('message', event => onMessage(event.data))
      socket.addEventListener('error', () => finish(reject, new Error('websocket error')))
    }
  })
}

async function shotWithPlaywright (browser, file) {
  const contexts = browser.contexts()
  const context = contexts[0] || await browser.newContext()
  const pages = context.pages()
  const page = pages[0] || await context.newPage()
  await page.screenshot({ path: file })
  return page.title()
}

async function live (options = {}) {
  const endpoint = options.endpoint || process.env.ONECODE_CDP_URL || null
  const base = { ok: false, title: null, screenshot: null, exit: 2 }
  if (!endpoint) return { ...base, status: 'not_run', reason: 'no CDP endpoint: set ONECODE_CDP_URL or pass --url' }
  const target = normalize(endpoint)
  if (!target) return { ...base, status: 'not_run', reason: 'bad CDP endpoint: ' + endpoint }

  const out = path.resolve(options.out || path.join(os.tmpdir(), 'onlyone-cdp'))
  const file = path.join(out, 'cdp-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png')

  const playwright = options.playwright === undefined ? playwrightModule() : options.playwright
  if (playwright && !options.raw) {
    let browser
    try {
      browser = await playwright.chromium.connectOverCDP(target.base)
      fs.mkdirSync(out, { recursive: true })
      const title = await shotWithPlaywright(browser, file)
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) return { ...base, status: 'not_run', reason: 'playwright wrote no image', backend: 'playwright' }
      return { ok: true, status: 'ok', title, screenshot: file, backend: 'playwright', exit: 0 }
    } catch (error) {
      return { ...base, status: 'not_run', reason: 'playwright failed: ' + error.message, backend: 'playwright' }
    } finally {
      if (browser) { try { await browser.close() } catch {} }
    }
  }

  const ws = websocketBackend()
  if (!ws.Ctor) return { ...base, status: 'not_run', reason: 'playwright/ws absent', backend: null }

  const listed = await listTargets(target.base, options.listTimeoutMs || 3000)
  if (!listed.ok) return { ...base, status: 'not_run', reason: listed.reason, backend: ws.backend }
  const page = parseTargets(listed.list)
  if (!page) return { ...base, status: 'not_run', reason: 'no page target at ' + target.base, backend: ws.backend }

  try {
    const shot = await cdpRequest(ws.Ctor, page.wsUrl, 'Page.captureScreenshot', { format: 'png' }, options.timeoutMs || TIMEOUT_MS)
    if (!shot || !shot.data) return { ...base, status: 'not_run', reason: 'CDP returned no image', backend: ws.backend, title: page.title }
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    if (fs.statSync(file).size === 0) return { ...base, status: 'not_run', reason: 'screenshot file is empty', backend: ws.backend }
    return { ok: true, status: 'ok', title: page.title, screenshot: file, backend: ws.backend, exit: 0 }
  } catch (error) {
    return { ...base, status: 'not_run', reason: 'screenshot failed: ' + error.message, backend: ws.backend }
  }
}

// --- launch mode (OS-8) ------------------------------------------------------
// Attaching to a window somebody else started is not proof that THIS build paints
// one. So we start it: node_modules/.bin/electron.cmd . with a free debugging port
// and a fresh temporary profile, shoot the first page target, then kill the tree.
//
// Killing is scoped to the pid we spawned (`taskkill /PID <own pid> /T /F`), never a
// sweep by image name: the owner's running onlyone must survive a failed run. After
// the kill we check two independent things — the debugging port stopped answering
// and no electron.exe carries our unique profile path in its command line.

const LAUNCH_TIMEOUT_MS = 60000
const TITLE_TIMEOUT_MS = 20000
const KILL_TIMEOUT_MS = 15000
const SETTLE_MS = 1500

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function electronShim (appDir) {
  return path.join(appDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
}

// cmd.exe splits on spaces; the worktree or the temp profile may contain one.
function quoteArg (value) {
  const text = String(value)
  return /[\s"]/.test(text) ? '"' + text.replace(/"/g, '') + '"' : text
}

function runTool (file, args, timeoutMs = 15000) {
  return new Promise(resolve => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? error.message : null })
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', error: error.message })
    }
  })
}

// Pids of electron processes whose command line contains our unique marker (the
// mkdtemp profile). Filtered by marker, so a neighbour's onlyone never matches.
async function processesWithMarker (marker) {
  if (!marker) return { ok: false, pids: [], reason: 'no marker' }
  if (process.platform === 'win32') {
    const safe = String(marker).replace(/'/g, "''")
    const script = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*"
      + safe + "*' } | Select-Object -ExpandProperty ProcessId"
    const run = await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    if (!run.ok) return { ok: false, pids: [], reason: 'powershell: ' + (run.error || run.stderr || '').trim().slice(0, 300) }
    const pids = run.stdout.split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0)
    return { ok: true, pids, reason: null }
  }
  const run = await runTool('ps', ['-A', '-o', 'pid=,args='])
  if (!run.ok) return { ok: false, pids: [], reason: 'ps: ' + (run.error || '').trim().slice(0, 300) }
  const pids = run.stdout.split('\n')
    .filter(line => line.includes(marker))
    .map(line => Number(line.trim().split(/\s+/)[0]))
    .filter(n => Number.isInteger(n) && n > 0)
  return { ok: true, pids, reason: null }
}

function killTree (pid) {
  return new Promise(resolve => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve({ ok: false, method: 'none', detail: 'no pid' })
    if (process.platform === 'win32') {
      // /T — the whole tree under OUR pid (cmd.exe -> node cli.js -> electron + helpers).
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: KILL_TIMEOUT_MS }, (error, stdout, stderr) => {
        // Windows prints the confirmation in the OEM codepage, which turns to junk
        // in JSON; the exit status is the fact worth keeping.
        const detail = error ? String(stderr || stdout || error.message).trim() : 'ok'
        resolve({ ok: !error, method: 'taskkill /PID ' + pid + ' /T /F', detail })
      })
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
      resolve({ ok: true, method: 'kill -' + pid, detail: '' })
    } catch (error) {
      resolve({ ok: false, method: 'kill -' + pid, detail: error.message })
    }
  })
}

function waitExit (child, timeoutMs) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
}

// One poll, two uses: wait for the first page target, then wait for its title.
async function pollTarget (endpoint, timeoutMs, accept, probe = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  let lastReason = 'no page target at ' + endpoint
  while (Date.now() < deadline) {
    const gone = probe.exited && probe.exited()
    if (gone) {
      const tail = String((probe.stderr && probe.stderr()) || '').trim().slice(-800)
      return { ok: false, exited: true, reason: 'app exited before a window appeared (code ' + gone.code + '): ' + (tail || 'no stderr') }
    }
    const listed = await listTargets(endpoint, 1500)
    if (listed.ok) {
      const page = parseTargets(listed.list)
      if (page) {
        last = page
        if (accept(page)) return { ok: true, page }
      } else {
        lastReason = 'no page target at ' + endpoint
      }
    } else {
      lastReason = listed.reason
    }
    await sleep(400)
  }
  return { ok: false, page: last, reason: lastReason }
}

async function waitEndpointClosed (endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const listed = await listTargets(endpoint, 1000)
    if (!listed.ok) return true
    await sleep(200)
  }
  return false
}

async function waitNoLeftovers (marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = { ok: false, pids: [], reason: 'not checked' }
  while (Date.now() < deadline) {
    last = await processesWithMarker(marker)
    if (!last.ok || last.pids.length === 0) return last
    await sleep(400)
  }
  return processesWithMarker(marker)
}

async function cleanupLaunch (child, endpoint, marker, killTimeoutMs) {
  const started = Date.now()
  const pid = child && Number.isInteger(child.pid) ? child.pid : null
  const kill = await killTree(pid)
  const exited = child ? await waitExit(child, killTimeoutMs) : true
  const endpointClosed = await waitEndpointClosed(endpoint, 5000)
  // Chromium helpers can outlive the main process by a moment, and the CIM list is
  // a snapshot: wait for it to drain rather than call a slow shutdown a leak.
  let left = await waitNoLeftovers(marker, 10000)
  const extraKills = []
  if (left.ok && left.pids.length) {
    // Still alive after the tree kill, but every one of them carries OUR unique
    // profile path, so finishing them stays scoped to this launch and cannot touch
    // a neighbour's onlyone window.
    for (const extra of left.pids) {
      const second = await killTree(extra)
      extraKills.push({ pid: extra, ok: second.ok })
    }
    left = await waitNoLeftovers(marker, 5000)
  }
  return {
    pid,
    killed: kill.ok,
    method: kill.method,
    detail: kill.detail,
    exited,
    endpointClosed,
    extraKills,
    leftoverCheck: left.ok ? 'powershell Win32_Process by profile' : (left.reason || 'unknown'),
    leftoverPids: left.pids,
    treeGone: exited && left.ok && left.pids.length === 0,
    ms: Date.now() - started
  }
}

async function launchAndCapture (options = {}) {
  const appDir = path.resolve(options.appDir || path.join(__dirname, '..', '..'))
  const base = {
    ok: false,
    status: 'not_run',
    title: null,
    url: null,
    screenshot: null,
    pid: null,
    backend: 'node-websocket',
    exit: 2,
    appDir
  }
  if (!fs.existsSync(path.join(appDir, 'package.json'))) {
    return { ...base, reason: 'not an app dir (no package.json): ' + appDir }
  }
  const shim = options.shim || electronShim(appDir)
  if (!fs.existsSync(shim)) return { ...base, reason: 'electron shim not found (npm install missing?): ' + shim }

  const websocket = websocketBackend()
  if (!websocket.Ctor) return { ...base, reason: 'playwright/ws absent', backend: null }

  // Playwright would close the browser it attaches to; in launch mode we always
  // talk raw CDP so cleanup is ours alone.

  const port = options.port || await freePort()
  const endpoint = 'http://127.0.0.1:' + port
  // Temporary profile: never the owner's %APPDATA%\onlyone, so a run cannot read
  // or write real history, keys or settings.
  const profile = options.profile || fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-live-'))
  const out = path.resolve(options.out || path.join(os.tmpdir(), 'onlyone-live'))
  const launchTimeoutMs = options.launchTimeoutMs || LAUNCH_TIMEOUT_MS
  const titleTimeoutMs = options.titleTimeoutMs || TITLE_TIMEOUT_MS
  const appArgs = ['.', '--no-sandbox', '--disable-gpu-sandbox', '--remote-debugging-port=' + port, '--user-data-dir=' + profile]
  const env = { ...process.env, ...(options.env || {}) }
  delete env.ELECTRON_RUN_AS_NODE

  let child = null
  let stdout = ''
  let stderr = ''
  let exited = null
  let result = null

  // The capture body returns freely; the outer function owns the kill, so every
  // exit path — success, honest not_run or a thrown error — passes through finally.
  const capture = async () => {
    const probe = { exited: () => exited, stderr: () => stderr }
    const appeared = await pollTarget(endpoint, launchTimeoutMs, () => true, probe)
    if (!appeared.ok) {
      return {
        ...base,
        pid: child.pid || null,
        port,
        profile,
        reason: appeared.reason,
        stderr: stderr.trim().slice(-4000),
        stdout: stdout.trim().slice(-2000)
      }
    }

    // The title is the cheap proof that the renderer loaded, not an empty shell.
    const titled = await pollTarget(endpoint, titleTimeoutMs, page => page.title.trim() !== '' && (!options.expectedTitle || options.expectedTitle.test(page.title)), probe)
    const page = titled.page || appeared.page

    const file = path.join(out, 'onlyone-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png')
    let shot = null
    let shotError = null
    try {
      // A short settle so the first paint is on screen: a white boot frame would
      // pass a size check while proving nothing.
      await sleep(options.settleMs === undefined ? SETTLE_MS : options.settleMs)
      shot = await cdpRequest(websocket.Ctor, page.wsUrl, 'Page.captureScreenshot', { format: 'png' }, options.timeoutMs || TIMEOUT_MS)
    } catch (error) {
      shotError = error.message
    }
    fs.mkdirSync(out, { recursive: true })
    if (!shot || !shot.data) {
      return {
        ...base,
        title: page.title,
        url: page.url,
        pid: child.pid || null,
        port,
        profile,
        reason: 'CDP returned no image' + (shotError ? ': ' + shotError : ''),
        stderr: stderr.trim().slice(-4000)
      }
    }
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    const size = fs.statSync(file).size
    if (!size) {
      return { ...base, title: page.title, url: page.url, pid: child.pid || null, port, profile, reason: 'screenshot file is empty', stderr: stderr.trim().slice(-4000) }
    }
    // A picture without a title is kept as evidence but is not a pass: the window
    // may be a blank shell, and OS-8 asks for the real onlyone window.
    const titleOk = page.title.trim() !== ''
    return {
      ok: titleOk,
      status: titleOk ? 'ok' : 'not_run',
      reason: titleOk ? null : 'page target never got a title at ' + endpoint + ' (screenshot kept as evidence)',
      title: page.title,
      url: page.url,
      screenshot: file,
      bytes: size,
      pid: child.pid || null,
      port,
      profile,
      backend: websocket.backend,
      exit: titleOk ? 0 : 2,
      stderr: stderr.trim().slice(-4000),
      stdout: stdout.trim().slice(-2000)
    }
  }

  try {
    if (process.platform === 'win32') {
      // .cmd cannot be spawned without a shell; one pre-quoted command string keeps
      // Node from concatenating unquoted args (and from warning about it).
      child = spawn([shim, ...appArgs].map(quoteArg).join(' '), {
        cwd: appDir, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      })
    } else {
      child = spawn(shim, appArgs, {
        cwd: appDir, env, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe']
      })
    }
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-8000) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000) })
    child.on('exit', (code, signal) => { exited = { code, signal } })
    child.on('error', error => { stderr = (stderr + '\nspawn error: ' + error.message).slice(-8000) })
    result = await capture()
  } catch (error) {
    result = {
      ...base,
      pid: child && child.pid ? child.pid : null,
      port,
      profile,
      reason: 'launch failed: ' + error.message,
      stderr: (stderr + '\n' + error.message).trim().slice(-4000)
    }
  } finally {
    const cleanup = await cleanupLaunch(child, endpoint, profile, options.killTimeoutMs || KILL_TIMEOUT_MS)
    result = { ...(result || { ...base, reason: 'launch produced no result' }), cleanup }
    // A green run leaves no profile behind (the owner's temp dir must not grow by a
    // Chromium profile per run); a red one keeps it as evidence. The screenshot and
    // the cleanup report are printed either way.
    if (result.ok && options.keepProfile !== true) {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
        result.cleanup.profileRemoved = !fs.existsSync(profile)
      } catch (error) {
        result.cleanup.profileRemoved = false
        result.cleanup.profileNote = error.message
      }
    }
  }
  return result
}

module.exports = { live, launchAndCapture, processesWithMarker, killTree, parseTargets, normalize, endpointOf, websocketBackend, playwrightModule }

if (require.main === module) {
  const args = process.argv.slice(2)
  const outAt = args.indexOf('--out')
  const out = outAt >= 0 ? args[outAt + 1] : undefined
  const launchAt = args.indexOf('--launch')
  const appDir = launchAt >= 0 ? args[launchAt + 1] : undefined
  const run = appDir
    ? launchAndCapture({ appDir, out })
    : live({ endpoint: endpointOf(args, process.env), out })
  run.then(result => {
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.ok ? 0 : 2
  }).catch(error => {
    console.log(JSON.stringify({ ok: false, status: 'not_run', reason: error.message, title: null, screenshot: null, exit: 2 }, null, 2))
    process.exitCode = 2
  })
}
