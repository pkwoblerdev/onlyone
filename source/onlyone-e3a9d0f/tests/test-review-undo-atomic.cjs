'use strict'
// Откат не должен усекать файл при обрыве записи (ENOSPC, питание, падение)
// и должен позволять повторную попытку. Запись идёт во временный файл рядом с
// целью, поэтому до успешного rename прежние байты остаются на диске.
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { create } = require('../src/main/review-sections.cjs')

const hash = value => crypto.createHash('sha256').update(value).digest('hex')

;(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'onlyone-review-atomic-'))
  try {
    const ws = path.join(base, 'ws')
    const undo = path.join(base, 'undo')
    await fsp.mkdir(ws, { recursive: true })
    const inside = file => path.resolve(String(file)).startsWith(path.resolve(ws) + path.sep)

    let fail = true
    // Эмулируем настоящий writeFile('w'): открыть с усечением, записать часть
    // и упасть. С атомарной записью это происходит с временным файлом.
    const failing = new Proxy(fsp, {
      get (target, property) {
        if (property !== 'writeFile') return target[property]
        return async (file, data, encoding) => {
          if (fail && inside(file)) {
            await fsp.writeFile(file, String(data).slice(0, 4), encoding)
            const error = new Error('ENOSPC: no space left on device, write')
            error.code = 'ENOSPC'
            throw error
          }
          return fsp.writeFile(file, data, encoding)
        }
      }
    })
    const service = (fileSystem = fsp) => create({
      fs: fileSystem,
      rootOf: requestId => path.join(undo, requestId),
      resolveFile: value => path.resolve(value),
      display: value => path.relative(base, value),
      locked: async (_root, run) => run(),
      decodeBackup: value => value,
      active: () => false
    })
    const putManifest = async (requestId, entries) => {
      const root = path.join(undo, requestId)
      await fsp.mkdir(root, { recursive: true })
      await fsp.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ requestId, at: Date.now(), entries }))
      return root
    }
    const readManifest = async requestId => JSON.parse(await fsp.readFile(path.join(undo, requestId, 'manifest.json'), 'utf8'))

    // --- целый файл: сбой записи не трогает содержимое, повтор проходит -----
    const file = path.join(ws, 'notes.md')
    await fsp.writeFile(file, 'version 2 (agent)')
    const root = await putManifest('turn-atomic', [
      { file, action: 'updated', backup: 'aaaaaaaaaaaaaaaa.bak', before: hash('version 1 (before the agent)'), wrote: hash('version 2 (agent)') }
    ])
    await fsp.writeFile(path.join(root, 'aaaaaaaaaaaaaaaa.bak'), 'version 1 (before the agent)')

    const first = await service(failing).undo({ requestId: 'turn-atomic', sectionIds: [`file:${hash(file)}`] })
    assert.equal(first.ok, true)
    assert.equal(first.failed.length, 1)
    assert.match(first.failed[0], /места/)
    assert.equal(await fsp.readFile(file, 'utf8'), 'version 2 (agent)', 'a failed rollback leaves the file untouched')
    assert.deepEqual(await fsp.readdir(ws), ['notes.md'], 'the temporary file is cleaned up')
    assert.equal((await readManifest('turn-atomic')).entries[0].undone, undefined, 'the entry stays rollbackable')

    fail = false
    const second = await service().undo({ requestId: 'turn-atomic', sectionIds: [`file:${hash(file)}`] })
    assert.equal(second.ok, true)
    assert.deepEqual(second.failed, [])
    assert.equal(await fsp.readFile(file, 'utf8'), 'version 1 (before the agent)', 'the retry completes the rollback')
    assert.equal(second.snapshotKept, false)

    // --- участок: тот же обрыв записи, поздние строки не теряются -----------
    const frag = path.join(ws, 'frag.txt')
    await fsp.writeFile(frag, 'a\nB\nC')
    const fragRoot = await putManifest('turn-atomic-frag', [
      { file: frag, action: 'updated', backup: 'bbbbbbbbbbbbbbbb.bak', before: hash('a\nb\nc'), wrote: hash('a\nB\nc') },
      { file: frag, action: 'updated', backup: 'cccccccccccccccc.bak', before: hash('a\nB\nc'), wrote: hash('a\nB\nC') }
    ])
    await fsp.writeFile(path.join(fragRoot, 'bbbbbbbbbbbbbbbb.bak'), 'a\nb\nc')
    await fsp.writeFile(path.join(fragRoot, 'cccccccccccccccc.bak'), 'a\nB\nc')

    fail = true
    const fragFail = await service(failing).undo({ requestId: 'turn-atomic-frag', sectionIds: [`frag:${hash(frag)}:0`] })
    assert.equal(fragFail.ok, true)
    assert.equal(fragFail.failed.length, 1)
    assert.equal(await fsp.readFile(frag, 'utf8'), 'a\nB\nC', 'the fragment write leaves the file untouched too')
    assert.deepEqual((await fsp.readdir(ws)).sort(), ['frag.txt', 'notes.md'], 'no temporary files remain')

    fail = false
    const fragRetry = await service().undo({ requestId: 'turn-atomic-frag', sectionIds: [`frag:${hash(frag)}:0`] })
    assert.deepEqual(fragRetry.failed, [])
    assert.equal(await fsp.readFile(frag, 'utf8'), 'a\nb\nC', 'the later edit is preserved on retry')

    console.log('PASS review undo atomic: failed writes leave the file intact and a retry finishes the rollback')
  } finally {
    assert(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fsp.rm(base, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
