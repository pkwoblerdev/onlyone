'use strict'
// Файлы второй рабочей папки должны быть видны в обзоре и откатываться.
// Охрана путей и связка resolveFile берутся из настоящего main.js, сервис —
// настоящий review-sections.cjs; каталоги временные.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { AsyncLocalStorage } = require('node:async_hooks')
const { create } = require('../src/main/review-sections.cjs')
const changeReview = require('../src/main/change-review.cjs')

const hash = value => crypto.createHash('sha256').update(value).digest('hex')

const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')

function guardFor (workspace) {
  const start = mainSource.indexOf('function isInside(root, target) {')
  const end = mainSource.indexOf('async function listFiles(')
  assert(start >= 0 && end > start, 'workspace guards found in main.js')
  const build = new Function('fs', 'workspace', 'assertWorkspaceConfigured',
    'resolve', 'relative', 'isAbsolute', 'dirname', 'parse', 'basename', 'join', 'AsyncLocalStorage',
    mainSource.slice(start, end) + '\nreturn { assertSafeWorkspacePath, assertWorkspaceTargetFile, relativeDisplay }')
  return build(fsp, workspace, () => {}, path.resolve, path.relative, path.isAbsolute,
    path.dirname, path.parse, path.basename, path.join, AsyncLocalStorage)
}

// Берём настоящую связку resolveFile из main.js, а не её копию в тесте:
// иначе тест перестанет замечать, что приложение резолвит путь по-старому.
function resolverFrom (serviceName, guard, workspace) {
  const start = mainSource.indexOf(`function ${serviceName}(`)
  assert(start >= 0, `${serviceName} found in main.js`)
  const end = mainSource.indexOf('\n}', start)
  const match = /resolveFile: (file => [^\n]+?), display:/.exec(mainSource.slice(start, end))
  assert(match, `${serviceName}: resolveFile wiring found`)
  // Путь из журнала проверяется напрямую: через отображаемое имя два разных
  // файла одной рабочей папки и папки-метки сливаются в одно имя.
  assert.match(match[1], /assertWorkspaceTargetFile\(file\)/, `${serviceName}: resolves the recorded path directly`)
  return new Function('assertWorkspaceTargetFile',
    `return (${match[1]})`)(guard.assertWorkspaceTargetFile)
}

;(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'onlyone-review-extra-'))
  try {
    const ws = path.join(base, 'ws')
    const extra = path.join(base, 'extra')
    const undo = path.join(base, 'undo')
    await fsp.mkdir(path.join(extra, 'sub'), { recursive: true })
    await fsp.mkdir(ws, { recursive: true })

    const workspace = { path: ws, extraPaths: [extra], permission: 'acceptEdits' }
    const guard = guardFor(workspace)
    const display = value => guard.relativeDisplay(value)
    const resolveSections = resolverFrom('reviewSectionsService', guard, workspace)
    const resolveChange = resolverFrom('changeReviewService', guard, workspace)
    const service = (fileSystem = fsp) => create({
      fs: fileSystem,
      rootOf: requestId => path.join(undo, requestId),
      resolveFile: resolveSections,
      display,
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

    // --- файл во второй папке: список, предпросмотр, откат -------------------
    const file = path.join(extra, 'sub', 'report.md')
    await fsp.writeFile(file, 'version 2 from agent')
    const root = await putManifest('turn-extra', [
      { file, action: 'updated', backup: 'aaaaaaaaaaaaaaaa.bak', before: hash('version 1'), wrote: hash('version 2 from agent') }
    ])
    await fsp.writeFile(path.join(root, 'aaaaaaaaaaaaaaaa.bak'), 'version 1')
    assert.equal(display(file), 'extra/sub/report.md', 'the extra folder is shown by its label')

    const api = service()
    const list = await api.read({ requestIds: ['turn-extra'] })
    assert.equal(list.ok, true)
    const section = list.sections.find(item => item.kind === 'file')
    assert(section, 'the file from the second folder is listed')
    assert.equal(section.file, 'extra/sub/report.md')
    assert.equal(section.status, 'ready', 'the file is offered for rollback')

    const detail = await api.preview({ requestId: 'turn-extra', sectionId: section.sectionId })
    assert.equal(detail.ok, true)
    assert.equal(detail.file, 'extra/sub/report.md')
    assert.equal(detail.before, 'version 1')
    assert.equal(detail.after, 'version 2 from agent')

    const undone = await api.undo({ requestId: 'turn-extra', sectionIds: [section.sectionId] })
    assert.equal(undone.ok, true)
    assert.deepEqual(undone.failed, [])
    assert.deepEqual(undone.restored, ['extra/sub/report.md'])
    assert.equal(await fsp.readFile(file, 'utf8'), 'version 1')

    // --- обзор до подтверждения (change-review) видит ту же папку ----------
    await fsp.writeFile(file, 'version 2 from agent')
    const again = await putManifest('turn-extra-2', [
      { file, action: 'updated', backup: 'cccccccccccccccc.bak', before: hash('version 1'), wrote: hash('version 2 from agent') }
    ])
    await fsp.writeFile(path.join(again, 'cccccccccccccccc.bak'), 'version 1')
    const change = changeReview.create({
      fs: fsp,
      rootOf: requestId => path.join(undo, requestId),
      resolveFile: resolveChange,
      display,
      locked: async (_root, run) => run(),
      decodeBackup: value => value,
      active: () => false
    })
    const changes = await change.read({ requestIds: ['turn-extra-2'] })
    assert.equal(changes.ok, true)
    const row = changes.files.find(item => item.fileId === hash(file))
    assert(row, 'change review lists the file from the second folder')
    assert.equal(row.file, 'extra/sub/report.md')
    assert.equal(row.status, 'ready')
    const changeDetail = await change.preview({ requestId: 'turn-extra-2', fileId: hash(file) })
    assert.equal(changeDetail.ok, true)
    assert.equal(changeDetail.before, 'version 1')
    assert.equal(changeDetail.after, 'version 2 from agent')

    // --- файл вне всех папок: отказ называет причину, а не молчит -----------
    const outside = path.join(base, 'outside.txt')
    await fsp.writeFile(outside, 'outside')
    await putManifest('turn-outside', [
      { file: outside, action: 'updated', backup: 'bbbbbbbbbbbbbbbb.bak', before: hash('old'), wrote: hash('outside') }
    ])
    const refused = await api.undo({ requestId: 'turn-outside', sectionIds: [`file:${hash(outside)}`] })
    assert.equal(refused.ok, true)
    assert.equal(refused.failed.length, 1, 'the refusal is reported, not swallowed')
    assert.match(refused.failed[0], /Доступ запрещён/)
    assert.equal(refused.sections[0].status, 'failed')
    assert.match(refused.sections[0].reason, /Доступ запрещён/)
    assert.equal(await fsp.readFile(outside, 'utf8'), 'outside')

    // --- имя файла в главной паровке совпадает с меткой второй папки --------
    // Журнал хранит абсолютный путь, а связка resolveFile гоняла его через
    // отображаемое имя и обратно. «team/a.txt» внутри главной папки и вторая
    // папка с именем «team» дают одно и то же имя — откат писал в чужой файл.
    const clash = path.join(base, 'clash')
    const main2 = path.join(clash, 'proj')
    const extra2 = path.join(clash, 'team')
    await fsp.mkdir(path.join(main2, 'team'), { recursive: true })
    await fsp.mkdir(extra2, { recursive: true })
    const workspace2 = { path: main2, extraPaths: [extra2], permission: 'acceptEdits' }
    const guard2 = guardFor(workspace2)
    const display2 = value => guard2.relativeDisplay(value)
    const resolve2 = resolverFrom('reviewSectionsService', guard2, workspace2)
    const undo2 = path.join(clash, 'undo')
    const service2 = create({
      fs: fsp,
      rootOf: requestId => path.join(undo2, requestId),
      resolveFile: resolve2,
      display: display2,
      locked: async (_root, run) => run(),
      decodeBackup: value => value,
      active: () => false
    })
    const inMain = path.join(main2, 'team', 'notes.txt')
    const inExtra = path.join(extra2, 'notes.txt')
    await fsp.writeFile(inMain, 'version 2 from agent')
    await fsp.writeFile(inExtra, 'someone else’s file')
    const root2 = path.join(undo2, 'turn-clash')
    await fsp.mkdir(root2, { recursive: true })
    await fsp.writeFile(path.join(root2, 'manifest.json'), JSON.stringify({
      requestId: 'turn-clash', at: Date.now(),
      entries: [{ file: inMain, action: 'updated', backup: 'dddddddddddddddd.bak',
        before: hash('version 1'), wrote: hash('version 2 from agent') }]
    }))
    await fsp.writeFile(path.join(root2, 'dddddddddddddddd.bak'), 'version 1')

    const shown = value => String(value).split(String.fromCharCode(92)).join('/')
    assert.equal(shown(display2(inMain)), 'proj/team/notes.txt',
      'главная папка берёт свою метку, когда голое имя спорит со второй папкой')
    assert.equal(shown(display2(path.join(main2, 'plain.txt'))), 'plain.txt',
      'обычный файл главной папки остаётся без метки')
    const clashList = await service2.read({ requestIds: ['turn-clash'] })
    const clashSection = clashList.sections.find(item => item.kind === 'file')
    assert(clashSection, 'файл главной папки с таким же именем виден в обзоре')
    assert.equal(clashSection.status, 'ready', 'предлагается откат именно этого файла, а не conflict')

    const clashUndo = await service2.undo({ requestId: 'turn-clash', sectionIds: [clashSection.sectionId] })
    assert.deepEqual(clashUndo.failed, [], 'откат не падает: ' + JSON.stringify(clashUndo.failed))
    assert.equal(shown(clashUndo.restored.join('/')), 'proj/team/notes.txt')
    assert.equal(await fsp.readFile(inMain, 'utf8'), 'version 1', 'вернулся файл главной папки')
    assert.equal(await fsp.readFile(inExtra, 'utf8'), 'someone else’s file',
      'файл второй рабочей папки с тем же именем не тронут')

    // --- прерванный откат удаления: файл уже вернулся, участок не в залётных -
    // Сбой записи журнала после успешной записи файла оставляет
    // { action: 'deleted', undoStarted: true, undone: false }. Предыдущая
    // ветка «узнать уже-выполненный откат» исключала deleted, и участок
    // навсегда отвечал «conflict», хотя файл на месте и совпадает со снимком.
    const redoRoot = path.join(undo, 'turn-deleted')
    const deletedFile = path.join(ws, 'restore-me.txt')
    await putManifest('turn-deleted', [
      { file: deletedFile, action: 'deleted', undoStarted: true, undone: false,
        backup: 'eeeeeeeeeeeeeeee.bak', before: hash('as it was'), wrote: hash('') }]
    )
    await fsp.writeFile(path.join(redoRoot, 'eeeeeeeeeeeeeeee.bak'), 'as it was')
    await fsp.writeFile(deletedFile, 'as it was')
    const redone = await api.undo({ requestId: 'turn-deleted', sectionIds: [`file:${hash(deletedFile)}`] })
    assert.deepEqual(redone.failed, [], 'повтор не падает: ' + JSON.stringify(redone.failed))
    assert.equal(redone.sections[0].status, 'done',
      'уже восстановленный файл не в залёте: ' + JSON.stringify(redone.sections[0]))
    assert.equal(await fsp.readFile(deletedFile, 'utf8'), 'as it was')

    // И наоборот: файл восстановили ЧУЖИМ содержимым — это по-прежнему конфликт.
    const otherRoot = path.join(undo, 'turn-deleted-other')
    const otherFile = path.join(ws, 'other-hand.txt')
    await putManifest('turn-deleted-other', [
      { file: otherFile, action: 'deleted', undoStarted: true, undone: false,
        backup: 'ffffffffffffffff.bak', before: hash('as it was'), wrote: hash('') }]
    )
    await fsp.writeFile(path.join(otherRoot, 'ffffffffffffffff.bak'), 'as it was')
    await fsp.writeFile(otherFile, 'someone else wrote this')
    const conflicted = await api.undo({ requestId: 'turn-deleted-other', sectionIds: [`file:${hash(otherFile)}`] })
    assert.equal(conflicted.sections[0].status, 'conflict', 'чужая работа не затирается')
    assert.equal(await fsp.readFile(otherFile, 'utf8'), 'someone else wrote this')

    // --- имя из списка читается обратно тем же файлом ----------------------
    // list_files и результаты инструментов показывают путь именем; агент этим
    // именем и обращается. Если имя неоднозначно, read_file откроет файл другой
    // рабочей папки — значит отображение и разрешение обязаны быть обратны.
    const roundTrip = async (value, what) => {
      const name = shown(display2(value))
      const back = await guard2.assertSafeWorkspacePath(name)
      assert.equal(path.resolve(back), path.resolve(value),
        `${what}: имя ${JSON.stringify(name)} разрешается в ${back}`)
    }
    await roundTrip(inMain, 'файл главной папки против метки второй')
    await roundTrip(inExtra, 'файл второй папки')
    await roundTrip(path.join(main2, 'plain.txt'), 'обычный файл главной папки')
    await roundTrip(main2, 'сама главная папка')
    await roundTrip(extra2, 'сама вторая папка')

    console.log('PASS review extra root: listed, previewed and rolled back by folder label; outside paths still refused with a reason; same-named folders rolled back to the right file; interrupted delete-rollback finishes; display names resolve back to the same file')
  } finally {
    assert(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fsp.rm(base, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
