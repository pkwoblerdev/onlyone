'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { create, reverseFragment } = require('../src/main/review-sections.cjs')

const hash = value => crypto.createHash('sha256').update(value).digest('hex')

;(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'onlyone-review-sections-'))
  const workspace = path.join(base, 'ws')
  const undo = path.join(base, 'undo')
  await fs.mkdir(workspace, { recursive: true })

  const resolveFile = async value => {
    const resolved = path.resolve(value)
    assert(resolved.startsWith(workspace + path.sep), 'path escapes the workspace')
    return resolved
  }
  const service = (fileSystem = fs, isActive = () => false) => create({
    fs: fileSystem,
    rootOf: requestId => path.join(undo, requestId),
    resolveFile,
    display: value => path.relative(base, value),
    locked: async (_root, run) => run(),
    decodeBackup: value => value,
    encodeBackup: value => value,
    redact: value => String(value).replace(/SECRET[0-9A-Za-z]*/g, '***'),
    active: isActive
  })
  const api = service()
  const fileOf = name => path.join(workspace, name)
  const readManifest = async requestId => JSON.parse(await fs.readFile(path.join(undo, requestId, 'manifest.json'), 'utf8'))

  async function putManifest (requestId, entries, commands) {
    const root = path.join(undo, requestId)
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ requestId, at: Date.now(), entries, ...(commands ? { commands } : {}) }))
    return root
  }

  try {
    // --- Команда: снимок до/после, создание, изменение и удаление файлов ----
    await fs.writeFile(fileOf('one.txt'), 'before')
    await fs.writeFile(fileOf('gone.txt'), 'gone')
    const command = await api.beginCommand({ requestId: 'turn-cmd', command: 'node build.js --token SECRET123', roots: [workspace], cwd: workspace })
    assert.match(command.id, /^c_[a-f0-9]{12}$/)
    await fs.writeFile(fileOf('one.txt'), 'after')
    await fs.writeFile(fileOf('two.txt'), 'new')
    await fs.rm(fileOf('gone.txt'))
    const recorded = await command.finish({ status: 'done' })
    assert.equal(recorded.ok, true)
    assert.equal(recorded.snapshot, true)
    assert.equal(recorded.files, 3)
    const commandManifest = await readManifest('turn-cmd')
    assert.equal(commandManifest.entries.length, 0, 'command changes do not enter the file undo journal')
    assert.equal(commandManifest.commands.length, 1)
    assert.equal(commandManifest.commands[0].command.includes('SECRET123'), false)

    let list = await api.read({ requestIds: ['turn-cmd'] })
    assert.equal(list.ok, true)
    const commandSection = list.sections.find(section => section.kind === 'command')
    assert(commandSection, 'executed command is listed')
    assert.equal(commandSection.status, 'ready')
    assert.equal(commandSection.command.includes('SECRET123'), false, 'command text is redacted')
    assert(commandSection.command.includes('***'))
    assert.equal(list.sections.some(section => section.kind === 'file'), false, 'command files are grouped under the command')
    assert.equal(JSON.stringify(list).includes('before'), false, 'list does not expose file contents')

    const commandDetail = await api.preview({ requestId: 'turn-cmd', sectionId: commandSection.sectionId })
    assert.equal(commandDetail.ok, true)
    assert.equal(commandDetail.kind, 'command')
    assert.equal(commandDetail.files.length, 3)
    assert(commandDetail.files.some(file => file.action === 'created' && file.file.endsWith('two.txt')))
    assert(commandDetail.files.some(file => file.action === 'deleted' && file.file.endsWith('gone.txt')))

    let undone = await api.undo({ requestId: 'turn-cmd', sectionIds: [commandSection.sectionId] })
    assert.equal(undone.ok, true)
    assert.equal(await fs.readFile(fileOf('one.txt'), 'utf8'), 'before')
    assert.equal(await fs.readFile(fileOf('gone.txt'), 'utf8'), 'gone')
    await assert.rejects(fs.access(fileOf('two.txt')), 'created file was removed')
    assert.equal(undone.snapshotKept, false)
    assert.equal(undone.sections[0].status, 'done')

    // --- Команда без изменений остаётся в списке ----------------------------
    const idle = await api.beginCommand({ requestId: 'turn-idle', command: 'git status', roots: [workspace] })
    assert.equal((await idle.finish({ status: 'done' })).ok, true)
    list = await api.read({ requestIds: ['turn-idle'] })
    const idleSection = list.sections.find(section => section.kind === 'command')
    assert(idleSection)
    assert.equal(idleSection.status, 'empty')
    undone = await api.undo({ requestId: 'turn-idle', sectionIds: [idleSection.sectionId] })
    assert.equal(undone.ok, true)
    assert.equal(undone.sections[0].status, 'done')
    assert.equal(undone.snapshotKept, false)

    // --- Фрагмент: откат одной правки сохраняет более позднюю ----------------
    const fragmentFile = fileOf('frag.txt')
    await fs.writeFile(fragmentFile, 'a\nb\nc')
    const first = { file: fragmentFile, action: 'updated', backup: '1111111111111111.bak', before: hash('a\nb\nc'), wrote: hash('a\nB\nc') }
    const second = { file: fragmentFile, action: 'updated', backup: '2222222222222222.bak', before: hash('a\nB\nc'), wrote: hash('a\nB\nC') }
    let root = await putManifest('turn-frag', [first, second])
    await fs.writeFile(path.join(root, first.backup), 'a\nb\nc')
    await fs.writeFile(path.join(root, second.backup), 'a\nB\nc')
    await fs.writeFile(fragmentFile, 'a\nB\nC')

    list = await api.read({ requestIds: ['turn-frag'] })
    const fileSection = list.sections.find(section => section.kind === 'file')
    assert(fileSection)
    assert.equal(fileSection.edits, 2)
    assert.equal(fileSection.fragments, 2)
    assert.equal(fileSection.status, 'ready')
    const fileDetail = await api.preview({ requestId: 'turn-frag', sectionId: fileSection.sectionId })
    assert.equal(fileDetail.ok, true)
    assert.equal(fileDetail.fragments.length, 2)
    assert.equal(fileDetail.fragments[0].before, 'a\nb\nc')
    assert.equal(fileDetail.fragments[0].after, 'a\nB\nc')
    assert.equal(fileDetail.fragments[1].status, 'ready')

    undone = await api.undo({ requestId: 'turn-frag', sectionIds: [fileDetail.fragments[0].id] })
    assert.equal(undone.ok, true)
    assert.equal(undone.sections[0].status, 'done')
    assert.equal(await fs.readFile(fragmentFile, 'utf8'), 'a\nb\nC', 'the later edit is preserved')
    const afterFragment = await api.preview({ requestId: 'turn-frag', sectionId: fileDetail.fragments[0].id })
    assert.equal(afterFragment.status, 'done', 'the same fragment is not offered twice')

    // --- Конфликт фрагмента: чужая правка не затирается ----------------------
    root = await putManifest('turn-frag-conflict', [first, second])
    await fs.writeFile(path.join(root, first.backup), 'a\nb\nc')
    await fs.writeFile(path.join(root, second.backup), 'a\nB\nc')
    await fs.writeFile(fragmentFile, 'a\nX\nC')
    undone = await api.undo({ requestId: 'turn-frag-conflict', sectionIds: [`frag:${hash(fragmentFile)}:0`] })
    assert.equal(undone.ok, true)
    assert.equal(undone.sections[0].status, 'conflict')
    assert.equal(await fs.readFile(fragmentFile, 'utf8'), 'a\nX\nC')
    assert.equal(undone.conflicts.length, 1)

    // --- Выборочный откат файла не трогает остальные ------------------------
    const a = fileOf('a.txt'), b = fileOf('b.txt')
    await fs.writeFile(a, 'v2'); await fs.writeFile(b, 'B2')
    root = await putManifest('turn-files', [
      { file: a, action: 'updated', backup: 'aaaaaaaaaaaaaaaa.bak', before: hash('v1'), wrote: hash('v2') },
      { file: b, action: 'updated', backup: 'bbbbbbbbbbbbbbbb.bak', before: hash('B1'), wrote: hash('B2') }
    ])
    await fs.writeFile(path.join(root, 'aaaaaaaaaaaaaaaa.bak'), 'v1')
    await fs.writeFile(path.join(root, 'bbbbbbbbbbbbbbbb.bak'), 'B1')
    undone = await api.undo({ requestId: 'turn-files', sectionIds: [`file:${hash(b)}`] })
    assert.equal(undone.ok, true)
    assert.equal(await fs.readFile(b, 'utf8'), 'B1')
    assert.equal(await fs.readFile(a, 'utf8'), 'v2')
    assert.equal(undone.snapshotKept, true, 'the other file keeps its snapshot')
    list = await api.read({ requestIds: ['turn-files'] })
    assert.equal(list.sections.length, 1)
    assert.equal(list.sections[0].status, 'ready')

    // --- Поздняя правка: файл не перезаписывается ---------------------------
    const late = fileOf('late.txt')
    await fs.writeFile(late, 'human work')
    root = await putManifest('turn-late', [{ file: late, action: 'updated', backup: 'cccccccccccccccc.bak', before: hash('old'), wrote: hash('agent') }])
    await fs.writeFile(path.join(root, 'cccccccccccccccc.bak'), 'old')
    list = await api.read({ requestIds: ['turn-late'] })
    assert.equal(list.sections[0].status, 'conflict')
    undone = await api.undo({ requestId: 'turn-late', sectionIds: [`file:${hash(late)}`] })
    assert.equal(undone.conflicts.length, 1)
    assert.equal(await fs.readFile(late, 'utf8'), 'human work')

    // --- Повреждённый снимок: отказ с понятной причиной, файл не тронут ------
    const damaged = fileOf('damaged.txt')
    await fs.writeFile(damaged, 'new')
    root = await putManifest('turn-damaged', [{ file: damaged, action: 'updated', backup: 'ffffffffffffffff.bak', before: hash('expected'), wrote: hash('new') }])
    await fs.writeFile(path.join(root, 'ffffffffffffffff.bak'), 'tampered')
    undone = await api.undo({ requestId: 'turn-damaged', sectionIds: [`file:${hash(damaged)}`] })
    assert.equal(undone.failed.length, 1)
    assert(undone.failed[0].includes('Снимок повреждён'), 'damaged snapshot is explained')
    assert.equal(await fs.readFile(damaged, 'utf8'), 'new')

    // --- Отказ записи: один файл не записался, другой откатился -------------
    const deny = fileOf('deny.txt'), keep = fileOf('keep.txt')
    await fs.writeFile(deny, 'D2'); await fs.writeFile(keep, 'K2')
    root = await putManifest('turn-deny', [
      { file: deny, action: 'updated', backup: 'dddddddddddddddd.bak', before: hash('D1'), wrote: hash('D2') },
      { file: keep, action: 'updated', backup: 'eeeeeeeeeeeeeeee.bak', before: hash('K1'), wrote: hash('K2') }
    ])
    await fs.writeFile(path.join(root, 'dddddddddddddddd.bak'), 'D1')
    await fs.writeFile(path.join(root, 'eeeeeeeeeeeeeeee.bak'), 'K1')
    const failing = new Proxy(fs, {
      get (target, property) {
        if (property === 'writeFile') {
          return async (file, data, encoding) => {
            // Атомарная запись идёт во временный файл «.deny.txt.<hex>.tmp»,
            // поэтому отказ относится к любому пути с именем этого файла.
            if (String(file).includes('deny.txt')) {
              const error = new Error('EACCES')
              error.code = 'EACCES'
              throw error
            }
            return fs.writeFile(file, data, encoding)
          }
        }
        return target[property]
      }
    })
    undone = await service(failing).undo({ requestId: 'turn-deny', sectionIds: [`file:${hash(deny)}`, `file:${hash(keep)}`] })
    assert.equal(undone.ok, true)
    assert.equal(undone.failed.length, 1)
    assert(undone.failed[0].includes('Нет прав на запись'), 'write refusal is explained')
    assert.equal(await fs.readFile(deny, 'utf8'), 'D2')
    assert.equal(await fs.readFile(keep, 'utf8'), 'K1')
    assert.equal(undone.snapshotKept, true)
    const manifest = await readManifest('turn-deny')
    assert.equal(manifest.entries.find(entry => entry.file === deny).undone, undefined)
    assert.equal(manifest.entries.find(entry => entry.file === keep).undone, true)

    // --- Команда: конфликт одного файла, остальные откатываются --------------
    await fs.writeFile(fileOf('c1.txt'), '1')
    await fs.writeFile(fileOf('c2.txt'), '2')
    const partial = await api.beginCommand({ requestId: 'turn-partial', command: 'build', roots: [workspace] })
    await fs.writeFile(fileOf('c1.txt'), '1x')
    await fs.writeFile(fileOf('c2.txt'), '2x')
    assert.equal((await partial.finish({ status: 'done' })).ok, true)
    await fs.writeFile(fileOf('c2.txt'), 'human')
    list = await api.read({ requestIds: ['turn-partial'] })
    const partialSection = list.sections.find(section => section.kind === 'command')
    assert.equal(partialSection.status, 'partial')
    undone = await api.undo({ requestId: 'turn-partial', sectionIds: [partialSection.sectionId] })
    assert.equal(undone.ok, true)
    assert.equal(await fs.readFile(fileOf('c1.txt'), 'utf8'), '1')
    assert.equal(await fs.readFile(fileOf('c2.txt'), 'utf8'), 'human')
    assert.equal(undone.conflicts.length, 1)
    assert.equal(undone.snapshotKept, true)
    list = await api.read({ requestIds: ['turn-partial'] })
    const afterPartial = list.sections.find(section => section.kind === 'command')
    assert.equal(afterPartial.status, 'partial')
    assert.equal(afterPartial.files.find(file => file.file.endsWith('c1.txt')).status, 'done')
    assert.equal(afterPartial.files.find(file => file.file.endsWith('c2.txt')).status, 'conflict')

    // --- Занятый ход и мусорные идентификаторы ------------------------------
    const busy = service(fs, () => true)
    assert.equal((await busy.read({ requestIds: ['turn-frag-conflict'] })).sections[0].status, 'busy')
    assert.equal((await busy.undo({ requestId: 'turn-frag-conflict', sectionIds: [`file:${hash(fragmentFile)}`] })).code, 'busy')
    assert.equal((await api.read({ requestIds: ['../escape'] })).code, 'invalid')
    assert.equal((await api.undo({ requestId: 'turn-files', sectionIds: ['nonsense'] })).code, 'invalid')
    assert.equal((await api.preview({ requestId: 'turn-files', sectionId: 'file:' + 'f'.repeat(64) })).code, 'missing')

    // --- Обратное применение участка: вставка, удаление, неоднозначность ----
    assert.equal(reverseFragment('a\nX\nb', 'a\nb', 'a\nX\nb').text, 'a\nb')
    assert.equal(reverseFragment('a\nb', 'a\nb', 'a\nX\nb').text, 'a\nb')
    assert.equal(reverseFragment('a\nX\na\nX', 'a', 'X').ok, false, 'ambiguous fragment is refused')

    console.log('PASS review sections: command changes, selective file/fragment rollback, later edits, conflicts, write refusal and retained snapshots')
  } finally {
    assert(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fs.rm(base, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
