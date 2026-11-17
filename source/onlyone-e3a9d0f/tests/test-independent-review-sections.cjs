'use strict'

// Независимая сквозная проверка участков обзора (не дубль test-review-sections.cjs).
//
// Проверяется то, что видит человек и что остаётся на диске:
//   - выполненная команда появляется отдельным участком и откатывается целиком;
//   - выборочный откат файла не трогает остальные файлы;
//   - откат одного фрагмента сохраняет более позднюю правку того же файла;
//   - поздняя правка даёт conflict и НЕ затирается;
//   - отказ записи (EACCES) виден в результате, а остальные выбранные участки
//     всё равно откатываются.
//
// Модуль берётся из src/main/review-sections.cjs. Для отрицательного контроля
// путь можно подменить копией:
//   ONECODE_INDEPENDENT_REVIEW=<путь к копии review-sections.cjs>
// Тогда мутация «убрать сверку отпечатка» обязана покраснить проверку.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const reviewPath = process.env.ONECODE_INDEPENDENT_REVIEW ||
  path.join(__dirname, '..', 'src', 'main', 'review-sections.cjs')
const { create, reverseFragment } = require(reviewPath)

const hash = value => crypto.createHash('sha256').update(value).digest('hex')

let failed = 0
async function check (name, fn) {
  try {
    await fn()
    console.log('ok', name)
  } catch (error) {
    failed++
    console.error('ПРОВАЛ', name, '—', error.message)
  }
}

;(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'onlyone-independent-review-'))
  const workspace = path.join(base, 'ws')
  const undo = path.join(base, 'undo')
  await fs.mkdir(workspace, { recursive: true })

  const resolveFile = async value => {
    const resolved = path.resolve(value)
    assert.ok(resolved.startsWith(workspace + path.sep), 'путь вышел за рабочую папку')
    return resolved
  }
  const service = (fileSystem = fs) => create({
    fs: fileSystem,
    rootOf: requestId => path.join(undo, requestId),
    resolveFile,
    display: value => path.relative(base, value),
    locked: async (_root, run) => run(),
    decodeBackup: value => value,
    encodeBackup: value => value,
    redact: value => String(value).replace(/SECRET[0-9A-Za-z]*/g, '***'),
    active: () => false
  })
  const api = service()
  const fileOf = name => path.join(workspace, name)
  const putManifest = async (requestId, entries, commands) => {
    const root = path.join(undo, requestId)
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ requestId, at: Date.now(), entries, ...(commands ? { commands } : {}) }))
    return root
  }

  try {
    // ── 1. Команда: участок, предпросмотр, полный откат ──────────────────────
    await check('команда видна участком и откатывается целиком', async () => {
      await fs.writeFile(fileOf('cmd-updated.txt'), 'before')
      await fs.writeFile(fileOf('cmd-gone.txt'), 'gone')
      const command = await api.beginCommand({
        requestId: 'command-turn',
        command: 'node build.js --token SECRET123456',
        roots: [workspace], cwd: workspace
      })
      assert.match(command.id, /^c_[a-f0-9]{12}$/)
      await fs.writeFile(fileOf('cmd-updated.txt'), 'after')
      await fs.writeFile(fileOf('cmd-created.txt'), 'new')
      await fs.rm(fileOf('cmd-gone.txt'))
      const recorded = await command.finish({ status: 'done' })
      assert.equal(recorded.ok, true)
      assert.equal(recorded.snapshot, true)
      assert.equal(recorded.files, 3)

      const list = await api.read({ requestIds: ['command-turn'] })
      assert.equal(list.ok, true)
      const commandSection = list.sections.find(section => section.kind === 'command')
      assert.ok(commandSection, 'выполненная команда не появилась в участках')
      assert.equal(commandSection.status, 'ready')
      assert.ok(commandSection.command.includes('***'), 'секрет в тексте команды не скрыт')
      assert.equal(list.sections.some(section => section.kind === 'file'), false,
        'файлы команды показаны дважды: и командой, и отдельными файлами')

      const detail = await api.preview({ requestId: 'command-turn', sectionId: commandSection.sectionId })
      assert.equal(detail.ok, true)
      assert.equal(detail.kind, 'command')
      assert.equal(detail.files.length, 3)

      const undone = await api.undo({ requestId: 'command-turn', sectionIds: [commandSection.sectionId] })
      assert.equal(undone.ok, true)
      assert.equal(await fs.readFile(fileOf('cmd-updated.txt'), 'utf8'), 'before')
      assert.equal(await fs.readFile(fileOf('cmd-gone.txt'), 'utf8'), 'gone')
      await assert.rejects(fs.access(fileOf('cmd-created.txt')), 'созданный командой файл не удалён')
      assert.equal(undone.sections[0].status, 'done')
    })

    // ── 2. Отказ записи одного файла не отменяет остальные ──────────────────
    await check('отказ записи виден, остальные изменения целы', async () => {
      await fs.writeFile(fileOf('blocked.txt'), 'blocked-after')
      await fs.writeFile(fileOf('ok.txt'), 'ok-after')
      const root = await putManifest('command-partial', [], [{
        id: 'c_aaaaaaaaaaaa', requestId: 'command-partial', command: 'build', status: 'done',
        at: Date.now(), snapshot: true,
        files: [
          { file: fileOf('blocked.txt'), action: 'updated', backup: 'bbbbbbbbbbbbbbbb.bak', before: hash('blocked-before'), wrote: hash('blocked-after') },
          { file: fileOf('ok.txt'), action: 'updated', backup: '0123456789abcdef.bak', before: hash('ok-before'), wrote: hash('ok-after') }
        ]
      }])
      await fs.writeFile(path.join(root, 'bbbbbbbbbbbbbbbb.bak'), 'blocked-before')
      await fs.writeFile(path.join(root, '0123456789abcdef.bak'), 'ok-before')

      const failingFs = {
        stat: fs.stat,
        readFile: fs.readFile,
        readdir: fs.readdir,
        mkdir: fs.mkdir,
        rename: fs.rename,
        rm: fs.rm,
        writeFile: async (target, ...rest) => {
          // Запись атомарная: отказ ловит временный файл «.blocked.txt.<hex>.tmp».
          if (path.basename(path.resolve(target)).includes('blocked.txt')) {
            const error = new Error('access denied')
            error.code = 'EACCES'
            throw error
          }
          return fs.writeFile(target, ...rest)
        }
      }
      const partial = await service(failingFs).undo({
        requestId: 'command-partial', sectionIds: ['cmd:c_aaaaaaaaaaaa']
      })
      assert.equal(partial.ok, true)
      assert.equal(partial.failed.length, 1, 'отказ записи не показан человеку')
      assert.match(partial.failed[0], /blocked\.txt/)
      assert.equal(await fs.readFile(fileOf('blocked.txt'), 'utf8'), 'blocked-after', 'незаписанный файл изменён')
      assert.equal(await fs.readFile(fileOf('ok.txt'), 'utf8'), 'ok-before', 'остальные файлы не откатились')
      assert.ok(['failed', 'partial'].includes(partial.sections[0].status),
        'участок не назвал отказ: ' + partial.sections[0].status)
    })

    // ── 3. Выборочный откат файла и поздняя правка ───────────────────────────
    await check('файл откатывается выборочно; поздняя правка даёт conflict', async () => {
      const a = fileOf('a.txt'), b = fileOf('b.txt')
      await fs.writeFile(a, 'a-v2')
      await fs.writeFile(b, 'b-later')
      const root = await putManifest('files-turn', [
        { file: a, action: 'updated', backup: 'aaaaaaaaaaaaaaaa.bak', before: hash('a-v1'), wrote: hash('a-v2') },
        { file: b, action: 'updated', backup: 'bbbbbbbbbbbbbbbb.bak', before: hash('b-v1'), wrote: hash('b-v2') }
      ])
      await fs.writeFile(path.join(root, 'aaaaaaaaaaaaaaaa.bak'), 'a-v1')
      await fs.writeFile(path.join(root, 'bbbbbbbbbbbbbbbb.bak'), 'b-v1')

      const onlyA = await api.undo({ requestId: 'files-turn', sectionIds: [`file:${hash(a)}`] })
      assert.equal(onlyA.ok, true)
      assert.equal(await fs.readFile(a, 'utf8'), 'a-v1', 'выбранный файл не вернулся')
      assert.equal(await fs.readFile(b, 'utf8'), 'b-later', 'соседний файл тронут без выбора')

      const late = await api.undo({ requestId: 'files-turn', sectionIds: [`file:${hash(b)}`] })
      assert.equal(late.ok, true)
      assert.equal(late.sections[0].status, 'conflict', 'поздняя правка не названа конфликтом')
      assert.equal(await fs.readFile(b, 'utf8'), 'b-later', 'поздняя правка затёрта')
    })

    // ── 4. Фрагмент: только выбранная правка, поздняя сохраняется ────────────
    await check('фрагмент откатывается выборочно; чужая правка не затирается', async () => {
      const fragFile = fileOf('frag.txt')
      await fs.writeFile(fragFile, 'one\nb\nc')
      const first = { file: fragFile, action: 'updated', backup: '1111111111111111.bak', before: hash('one\nb\nC'), wrote: hash('one\nB\nC') }
      const second = { file: fragFile, action: 'updated', backup: '2222222222222222.bak', before: hash('one\nB\nC'), wrote: hash('one\nB\nc') }
      let root = await putManifest('frag-turn', [first, second])
      await fs.writeFile(path.join(root, first.backup), 'one\nb\nC')
      await fs.writeFile(path.join(root, second.backup), 'one\nB\nC')
      // Результат обеих правок уже на диске: третья строка в верхнем регистре.
      await fs.writeFile(fragFile, 'one\nB\nc')

      const fileDetail = await api.preview({ requestId: 'frag-turn', sectionId: `file:${hash(fragFile)}` })
      assert.equal(fileDetail.ok, true)
      assert.equal(fileDetail.fragments.length, 2)

      const fragUndo = await api.undo({ requestId: 'frag-turn', sectionIds: [fileDetail.fragments[0].id] })
      assert.equal(fragUndo.ok, true)
      assert.equal(fragUndo.sections[0].status, 'done')
      assert.equal(await fs.readFile(fragFile, 'utf8'), 'one\nb\nc', 'откат фрагмента стёр более позднюю правку')

      // Поздняя правка внутри участка: возвращать его нельзя, файл не трогаем.
      await fs.writeFile(fragFile, 'one\nX\nc')
      root = await putManifest('frag-conflict', [first, second])
      await fs.writeFile(path.join(root, first.backup), 'one\nb\nC')
      await fs.writeFile(path.join(root, second.backup), 'one\nB\nC')
      const fragConflict = await api.undo({ requestId: 'frag-conflict', sectionIds: [`frag:${hash(fragFile)}:0`] })
      assert.equal(fragConflict.ok, true)
      assert.equal(fragConflict.sections[0].status, 'conflict')
      assert.equal(await fs.readFile(fragFile, 'utf8'), 'one\nX\nc', 'конфликтный фрагмент затёр позднюю правку')
    })

    // ── 5. Обратное применение фрагмента — чистая функция ────────────────────
    await check('reverseFragment: возвращает только точное вхождение', async () => {
      const before = 'a\nb\nc'
      const after = 'a\nB\nc'
      assert.deepEqual(reverseFragment('a\nB\nc', before, after), { ok: true, text: before })
      const twice = reverseFragment('a\nB\nc\na\nB\nc', before, after)
      assert.equal(twice.ok, false, 'неоднозначное вхождение принято')
      const changed = reverseFragment('a\nX\nc', before, after)
      assert.equal(changed.ok, false, 'изменённый участок принят')
    })
  } finally {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {})
  }

  if (failed) {
    console.error(`\nПровалено проверок: ${failed}`)
    process.exit(1)
  }
  console.log('\nНезависимые участки обзора: проверки пройдены')
})().catch(error => {
  console.error('харнесс упал: ' + (error && error.stack || error))
  process.exit(2)
})
