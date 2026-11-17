'use strict'
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto')
const { create } = require('../src/main/change-review.cjs')
;(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onlyone-review-test-'))
  const hash = s => crypto.createHash('sha256').update(s).digest('hex')
  try {
    const root = path.join(dir, 'undo', 'turn'); await fs.mkdir(root, { recursive: true })
    const file = path.join(dir, 'a.txt'); await fs.writeFile(file, 'v2')
    const first = { file, action: 'updated', backup: 'aaaaaaaaaaaaaaaa.bak', wrote: hash('v1') }
    const last = { ...first, backup: 'bbbbbbbbbbbbbbbb.bak', wrote: hash('v2') }
    await fs.writeFile(path.join(root, first.backup), 'original'); await fs.writeFile(path.join(root, last.backup), 'v1')
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ entries: [first, last] }))
    let busy = false, locked = 0
    const service = create({ fs, rootOf: id => path.join(dir, 'undo', id),
      resolveFile: async value => { assert(value.startsWith(dir + path.sep)); return value }, display: value => path.relative(dir, value),
      locked: async (_root, fn) => { locked++; return fn() }, decodeBackup: value => value, active: () => busy })
    assert.equal((await service.read({ requestIds: ['../escape'] })).code, 'invalid')
    const list = await service.read({ requestIds: ['turn'] })
    assert.equal(list.ok, true); assert.equal(list.files.length, 1)
    assert.equal(list.files[0].status, 'ready'); assert.equal(list.files[0].edits, 2)
    assert.equal(JSON.stringify(list).includes('original'), false, 'list does not expose file contents')
    let detail = await service.preview({ requestId: 'turn', fileId: hash(file) })
    assert.equal(detail.before, 'original'); assert.equal(detail.after, 'v2')
    assert.equal(detail.status, 'ready')
    await fs.writeFile(file, 'human work')
    assert.equal((await service.read({ requestIds: ['turn'] })).files[0].status, 'conflict')
    detail = await service.preview({ requestId: 'turn', fileId: hash(file) })
    assert.equal(detail.after, 'human work'); assert.equal(detail.status, 'conflict')
    busy = true; assert.equal((await service.read({ requestIds: ['turn'] })).files[0].status, 'busy'); busy = false
    assert.equal((await service.preview({ requestId: 'turn', fileId: hash('missing') })).code, 'missing')
    await fs.writeFile(path.join(root, first.backup), 'a'.repeat(70000))
    detail = await service.preview({ requestId: 'turn', fileId: hash(file) })
    assert.equal(detail.before.length, 64000); assert.equal(detail.truncated, true)
    first.before = hash('original')
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ entries: [first, last] }))
    assert.equal((await service.preview({ requestId: 'turn', fileId: hash(file) })).status, 'unavailable', 'corrupted snapshot cannot be offered for rollback')
    await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x61]))
    assert.equal((await service.read({ requestIds: ['turn'] })).files[0].status, 'unavailable', 'invalid UTF-8 cannot pass a text fingerprint check')
    const source = await fs.readFile(path.join(__dirname, '../src/main/main.js'), 'utf8')
    const begin = source.indexOf('function changeReviewService() {'), end = source.indexOf('function undoRoot(', begin)
    assert(begin > 0 && end > begin)
    const handlers = {}, wc = { mainFrame: {} }
    new Function('ipcMain', 'mainWindow', source.slice(begin, end))({ handle: (name, fn) => { handlers[name] = fn } }, { isDestroyed: () => false, webContents: wc })
    for (const event of [{ sender: {}, senderFrame: wc.mainFrame }, { sender: wc, senderFrame: {} }]) {
      assert.equal(handlers['review-agent-changes'](event, {}).code, 'forbidden')
      assert.equal(handlers['preview-agent-change'](event, {}).code, 'forbidden')
    }
    assert.ok(locked >= 5)
    console.log('PASS session change review: strict ids, grouping, original/latest version, conflict, active turn, bounded preview and no contents in listing')
  } finally { assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dir, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
