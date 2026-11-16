'use strict'
// Откат команды, удалившей каталог (rm -rf build, сборка, чистящая dist/),
// обязан восстановить и папки: запись агента создаёт родителя, откат — тоже.
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { create } = require('../src/main/review-sections.cjs')

;(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'onlyone-review-dirs-'))
  try {
    const ws = path.join(base, 'ws')
    const undo = path.join(base, 'undo')
    await fsp.mkdir(path.join(ws, 'build', 'assets'), { recursive: true })
    await fsp.writeFile(path.join(ws, 'build', 'app.js'), 'console.log(1)\n')
    await fsp.writeFile(path.join(ws, 'build', 'assets', 'logo.bin.txt'), 'pixels\n')
    await fsp.writeFile(path.join(ws, 'keep.txt'), 'keep\n')

    const api = create({
      fs: fsp,
      rootOf: requestId => path.join(undo, requestId),
      resolveFile: value => path.resolve(value),
      display: value => path.relative(base, value),
      locked: async (_root, run) => run(),
      decodeBackup: value => value,
      encodeBackup: value => value,
      active: () => false
    })

    const command = await api.beginCommand({ requestId: 'turn-rmdir', command: 'rm -rf build', roots: [ws], cwd: ws })
    await fsp.rm(path.join(ws, 'build'), { recursive: true, force: true })
    const recorded = await command.finish({ status: 'done' })
    assert.equal(recorded.ok, true)
    assert.equal(recorded.files, 2)

    const list = await api.read({ requestIds: ['turn-rmdir'] })
    const section = list.sections.find(item => item.kind === 'command')
    assert(section)
    assert.equal(section.status, 'ready', 'the deleted folder is offered for rollback')

    const undone = await api.undo({ requestId: 'turn-rmdir', sectionIds: [section.sectionId] })
    assert.equal(undone.ok, true)
    assert.deepEqual(undone.failed, [], 'no file fails because its folder is gone')
    assert.equal(undone.sections[0].status, 'done')
    assert.equal(await fsp.readFile(path.join(ws, 'build', 'app.js'), 'utf8'), 'console.log(1)\n')
    assert.equal(await fsp.readFile(path.join(ws, 'build', 'assets', 'logo.bin.txt'), 'utf8'), 'pixels\n')
    assert.equal(undone.snapshotKept, false)

    console.log('PASS review undo dirs: a command that deleted a folder is rolled back with its folders')
  } finally {
    assert(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fsp.rm(base, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
