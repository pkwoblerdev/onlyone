// OS-8 physical check: the CDP attach path must be provable, and its absence honest.
// Nothing here fakes a screenshot: without a running app the result is not_run.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { live, parseTargets, normalize, websocketBackend, playwrightModule } = require('../tools/safety/live.cjs')

let checks = 0
let failed = 0
const notes = []
async function check (name, fn) {
  checks++
  try { await fn(); console.log('ok ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) }
}

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

const LIST = [
  { type: 'browser', title: '', url: 'devtools://devtools/bundled/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' },
  { type: 'service_worker', title: 'sw', url: 'http://127.0.0.1:9222/sw', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/def' },
  { type: 'page', title: 'onlyone', url: 'file:///D:/1code/onlyone/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ghi' }
]

async function main () {
  await check('the first page target is chosen, not the browser target', () => {
    const page = parseTargets(LIST)
    assert.equal(page.title, 'onlyone')
    assert.equal(page.wsUrl, 'ws://127.0.0.1:9222/devtools/page/ghi')
    assert.equal(page.url, 'file:///D:/1code/onlyone/index.html')
  })

  await check('a list without a page target yields nothing to attach to', () => {
    assert.equal(parseTargets(LIST.slice(0, 2)), null)
    assert.equal(parseTargets([]), null)
    assert.equal(parseTargets(null), null)
  })

  await check('endpoints are normalised, junk is refused', () => {
    assert.deepEqual(normalize('http://127.0.0.1:9222/'), { base: 'http://127.0.0.1:9222', wsUrl: 'ws://127.0.0.1:9222' })
    assert.deepEqual(normalize('ws://localhost:9333/devtools/browser/x'), { base: 'http://localhost:9333', wsUrl: 'ws://localhost:9333' })
    assert.equal(normalize('file:///D:/x'), null)
    assert.equal(normalize('not a url'), null)
  })

  await check('without an endpoint the check is not_run, not green', async () => {
    const saved = process.env.ONECODE_CDP_URL
    delete process.env.ONECODE_CDP_URL
    try {
      const r = await live({})
      assert.equal(r.ok, false)
      assert.equal(r.status, 'not_run')
      assert.match(r.reason, /no CDP endpoint/)
      assert.equal(r.screenshot, null)
      assert.equal(r.exit, 2)
    } finally {
      if (saved !== undefined) process.env.ONECODE_CDP_URL = saved
    }
  })

  const port = await freePort()
  await check('nothing listening reports not_run with the reason and no screenshot', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-dead-'))
    const r = await live({ endpoint: 'http://127.0.0.1:' + port, out, listTimeoutMs: 1500 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 'not_run')
    assert.ok(r.reason.length > 8, 'reason too short: ' + r.reason)
    assert.equal(r.screenshot, null)
    assert.equal(fs.readdirSync(out).length, 0, 'a file appeared without a browser')
    notes.push({ case: 'dead port ' + port, status: r.status, reason: r.reason, backend: r.backend })
    fs.rmSync(out, { recursive: true, force: true })
  })

  await check('no WebSocket backend is reported instead of guessed', () => {
    const ws = websocketBackend()
    notes.push({ backend: ws.backend })
    assert.ok(ws.backend === null || ws.backend === 'node-websocket' || ws.backend === 'node_modules/ws', 'unexpected backend ' + ws.backend)
  })

  await check('a real app is captured only when ONECODE_CDP_URL points at one', async () => {
    const endpoint = process.env.ONECODE_CDP_URL
    if (!endpoint) {
      notes.push({ case: 'live capture', status: 'not_run', reason: 'ONECODE_CDP_URL is not set; start the app with --remote-debugging-port' })
      return
    }
    const out = path.join(os.tmpdir(), 'onlyone-cdp')
    const r = await live({ endpoint, out })
    if (r.ok) {
      assert.ok(r.screenshot && fs.existsSync(r.screenshot), 'ok without a screenshot file')
      assert.ok(fs.statSync(r.screenshot).size > 0, 'screenshot file is empty')
      notes.push({ case: 'live capture', status: 'ok', screenshot: r.screenshot, title: r.title, backend: r.backend })
    } else {
      assert.equal(r.status, 'not_run')
      assert.ok(r.reason.length > 8, 'reason too short: ' + r.reason)
      assert.equal(r.screenshot, null)
      notes.push({ case: 'live capture', status: r.status, reason: r.reason, backend: r.backend })
    }
  })

  console.log(JSON.stringify({ ok: failed === 0, checks, failed, playwright: Boolean(playwrightModule()), notes }, null, 2))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
