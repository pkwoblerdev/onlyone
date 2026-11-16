// Хелпер оконных прогонов, читающий набор переписки в любом формате.
//
// Проверка на подставных профилях: v1 (один `conversations.json`), v2 (индекс и
// шард), архивы обоих. Если хелпер перестанет видеть раскладку, шесть оконных
// звеньев снова начнут зависеть от сырого формата истории — молча.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const history = require('./history-store.cjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-history-store-'))
const profile = name => { const dir = path.join(root, name); fs.mkdirSync(path.join(dir, 'data'), { recursive: true }); return dir }
const envelope = value => JSON.stringify({ enc: 'plain', data: Buffer.from(JSON.stringify(value)).toString('base64') })
const write = (dir, name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text) }

// --- v1 -----------------------------------------------------------------------
const v1 = profile('v1')
write(v1, 'data/conversations.json', envelope([{ id: 'a', title: 'Старый формат' }]))
write(v1, 'data/designs.json', envelope([]))
assert.equal(history.historyLayout(v1), 'v1')
assert.equal(history.historyPresent(v1), true)
assert.ok(history.historyBytes(v1) > 0)
assert.deepEqual(history.historyWhole(v1), { whole: true, why: '' })
assert.deepEqual(history.liveParts(v1).map(part => part.name), ['conversations.json'])
assert.equal(history.plaintextInData(v1, 'Старый формат'), null, 'текст под base64 не считается открытым')
const v1Digest = history.historyDigest(v1)
write(v1, 'data/designs.json', envelope([{ id: 'x' }]))
assert.equal(history.historyDigest(v1), v1Digest, 'чужая запись отпечаток истории не меняет')
assert.equal(history.plaintextInData(v1, 'enc'), 'conversations.json', 'открытый конверт виден')

// Архив v1: байты на месте под другим именем.
const v1Bytes = fs.readFileSync(path.join(v1, 'data', 'conversations.json'))
fs.renameSync(path.join(v1, 'data', 'conversations.json'), path.join(v1, 'data', 'conversations.json.key-lost-1'))
assert.equal(history.findBytes(v1, v1Bytes), 'conversations.json.key-lost-1')
assert.equal(history.historyLayout(v1), null, 'архив не делает набор живым')
assert.deepEqual(history.liveParts(v1).map(part => part.name), [], 'архив не считается живым набором')

// --- v2 -----------------------------------------------------------------------
const v2 = profile('v2')
const shard = envelope([{ id: 'a', title: 'Новый формат' }])
write(v2, 'data/conversations/index.json', envelope({ v: 2, entries: [{ id: 'a', d: 'abc' }] }))
write(v2, 'data/conversations/abc.json', shard)
assert.equal(history.historyLayout(v2), 'v2')
assert.deepEqual(history.liveParts(v2).map(part => part.name), ['conversations/abc.json', 'conversations/index.json'])
assert.deepEqual(history.historyWhole(v2), { whole: true, why: '' }, 'индекс и шард — конверты')
assert.equal(history.plaintextInData(v2, 'Новый формат'), null)
assert.ok(history.historyBytes(v2) >= shard.length)
const v2Digest = history.historyDigest(v2)
write(v2, 'data/conversations/def.json', envelope([{ id: 'b' }]))
assert.notEqual(history.historyDigest(v2), v2Digest, 'новый диалог меняет отпечаток набора')
assert.equal(history.findBytes(v2, Buffer.from(shard)), 'conversations/abc.json')

// Архив v2 — переименованный каталог целиком.
fs.mkdirSync(path.join(v2, 'data', 'conversations.key-lost-7'))
fs.renameSync(path.join(v2, 'data', 'conversations', 'abc.json'), path.join(v2, 'data', 'conversations.key-lost-7', 'abc.json'))
assert.equal(history.findBytes(v2, Buffer.from(shard)), 'conversations.key-lost-7/abc.json', 'архив читается рекурсивно')
assert.equal(history.liveParts(v2).some(part => part.name.includes('key-lost')), false)

// --- порча видна, а не выдаётся за целое --------------------------------------
const broken = profile('broken')
write(broken, 'data/conversations.json', '{"enc":"plain","data":"abc')
const whole = history.historyWhole(broken)
assert.equal(whole.whole, false)
assert.match(whole.why, /JSON/)
write(broken, 'data/conversations.json', envelope([{ id: 'a', title: 'достаточно длинное тело конверта' }]))
assert.equal(history.historyWhole(broken).whole, true, 'целый конверт снова цел')

// --- нет набора ---------------------------------------------------------------
const empty = profile('empty')
assert.equal(history.historyLayout(empty), null)
assert.equal(history.historyPresent(empty), false)
assert.equal(history.historyDigest(empty), null)
assert.deepEqual(history.historyWhole(empty), { whole: false, why: 'файлов набора нет' })

fs.rmSync(root, { recursive: true, force: true })
console.log('PASS: history store helper reads v1 and v2, archives, damage and absence')
