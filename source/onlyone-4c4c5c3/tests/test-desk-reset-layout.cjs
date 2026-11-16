'use strict'
// Н6: битый или чужой файл раскладки делал Desk неоткрываемым навсегда —
// open() отвечал storage-unavailable, сброса в интерфейсе не было.
// Порча — это байты, которые этот профиль уже не прочитает: рядом остаётся
// копия, Desk открывается пустым. Недоступное шифрование — не порча: файл не
// трогается, open() честно говорит storage-unavailable.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createDeskStore } = require('../src/main/desk-store.cjs')
const { createDeskService } = require('../src/main/desk-service.cjs')

function service (storage) {
  class Window {
    constructor (options) { this.options = options; this.events = {}; this.webContents = { id: 1, mainFrame: {}, send () {}, on () {}, setWindowOpenHandler () {}, isDestroyed: () => false } }
    once () {}
    on () {}
    loadFile () { return Promise.resolve() }
    isDestroyed () { return false }
    show () {}
    focus () {}
    isMinimized () { return false }
  }
  return createDeskService({ BrowserWindow: Window, ipcMain: { handle () {} }, isMainWindow: () => true, focusMain () {},
    settings: () => ({}), storage, resolveResource: async () => ({ type: 'text', text: '' }) })
}

const key = text => Buffer.from(text, 'utf8').toString('base64')
const unkey = body => Buffer.from(body, 'base64').toString('utf8')
const fileOf = (dir, chatId) => path.join(dir, createHash('sha256').update(chatId).digest('hex') + '.json')
const damaged = dir => fs.readdirSync(dir).filter(name => name.includes('.damaged-'))

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-desk-reset-'))
  try {
    // 1. Обрезанный JSON: Desk этого чата открывается пустым, файл сохранён рядом.
    fs.writeFileSync(fileOf(dir, 'chat-1'), '{"enc":"safeStorage","data":"AAAA')
    const store = createDeskStore({ dir, protect: key, unprotect: unkey })
    const first = await service(store).open('chat-1')
    assert.equal(first.ok, true, 'a truncated layout no longer locks the Desk')
    assert.equal(first.recovered, true, 'the window is told the layout was reset')
    assert.equal(first.snapshot.blocks.length, 0)
    assert.equal(fs.existsSync(fileOf(dir, 'chat-1')), false, 'the damaged file is moved aside, not overwritten')
    assert.equal(damaged(dir).length, 1)
    assert.equal(fs.readFileSync(path.join(dir, damaged(dir)[0]), 'utf8'), '{"enc":"safeStorage","data":"AAAA')
    const second = await service(store).open('chat-1')
    assert.equal(second.ok, true)
    assert.equal(second.recovered, false, 'the reset is reported once')

    // 2. Чужой ключ: конверт цел, расшифровать нечем — это тоже порча.
    fs.writeFileSync(fileOf(dir, 'chat-2'), JSON.stringify({ enc: 'safeStorage', data: 'AAAA' }))
    const foreign = createDeskStore({ dir, protect: key, unprotect: () => { throw Error('decrypt failed') } })
    const reopened = await service(foreign).open('chat-2')
    assert.equal(reopened.ok, true, 'a foreign key no longer locks the Desk')
    assert.equal(reopened.recovered, true)
    assert.ok(damaged(dir).length >= 2)

    // 3. Чужой чат в конверте — порча.
    fs.writeFileSync(fileOf(dir, 'chat-3'), JSON.stringify({ enc: 'safeStorage', data: key(JSON.stringify({ chatId: 'other', snapshot: { blocks: [] } })) }))
    assert.equal((await service(store).open('chat-3')).recovered, true)

    // 4. Шифрование недоступно — не порча: файл не трогается, копий не прибавляется.
    const envelopes = damaged(dir).length
    fs.writeFileSync(fileOf(dir, 'chat-4'), JSON.stringify({ enc: 'safeStorage', data: 'AAAA' }))
    const offline = createDeskStore({ dir, protect: key, unprotect: () => { throw Object.assign(Error('later'), { code: 'desk-encryption-unavailable' }) } })
    assert.equal((await service(offline).open('chat-4')).code, 'storage-unavailable')
    const noKey = createDeskStore({ dir })
    assert.equal((await service(noKey).open('chat-4')).code, 'storage-unavailable')
    assert.equal(fs.readFileSync(fileOf(dir, 'chat-4'), 'utf8'), JSON.stringify({ enc: 'safeStorage', data: 'AAAA' }))
    assert.equal(damaged(dir).length, envelopes, 'a temporarily unavailable key archives nothing')
  } finally {
    assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log('PASS desk reset: a damaged or foreign layout is archived and reopened empty; an unavailable key stays untouched')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
