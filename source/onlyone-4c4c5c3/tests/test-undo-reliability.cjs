const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '1code-undo-test-'))
  const workspace = { path: root }
  const source = await fs.readFile(path.join(__dirname, '../src/main/main.js'), 'utf8')
  const code = source.slice(source.indexOf('function undoRoot('), source.indexOf('// Self-development', source.indexOf('function undoRoot(')))
  let undo
  let fail = () => false
  let duringCheckpoint = null
  const mockFs = { ...fs, writeFile: async (file, ...args) => {
    if (fail(file, args[0])) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' })
    if (duringCheckpoint && file.endsWith('.tmp') && String(args[0]).includes('"undoStarted": true')) {
      const action = duringCheckpoint; duringCheckpoint = null; await action()
    }
    return fs.writeFile(file, ...args)
  } }
  // С шифрованием на диске блок отката зовёт safeStorageAvailable/protectStore/
  // unprotectStore; здесь хранилища нет — как на машине без safeStorage.
  const snapshot = new Function('fs', 'crypto', 'join', 'relative', 'app', 'ipcMain', 'workspace', 'assertSafeWorkspacePath', 'relativeDisplay',
    'safeStorageAvailable', 'protectStore', 'unprotectStore',
    code + '\nreturn snapshotBeforeWrite')(
      mockFs, crypto, path.join, path.relative, { getPath: () => root }, { handle: (_, fn) => { undo = fn } }, workspace,
      async p => { const target = path.resolve(root, p); assert.ok(target.startsWith(root + path.sep)); return target }, p => path.relative(root, p),
      () => false, text => text, text => text)
  try {
    const a = path.join(root, 'a.txt'), b = path.join(root, 'b.txt')
    await fs.writeFile(a, 'old-a')
    fail = file => file.endsWith('.bak')
    await assert.rejects(snapshot('fail-backup', a, true, 'old-a', 'new-a'), /ENOSPC/)
    assert.equal(await fs.readFile(a, 'utf8'), 'old-a')
    fail = file => file.endsWith('.tmp')
    await assert.rejects(snapshot('fail-journal', a, true, 'old-a', 'new-a'), /ENOSPC/)
    await assert.rejects(snapshot('', a, true, 'old-a', 'new-a'), /идентификатора/)
    fail = () => false
    await fs.mkdir(path.join(root, 'undo/corrupt'), { recursive: true })
    await fs.writeFile(path.join(root, 'undo/corrupt/manifest.json'), '{bad')
    await assert.rejects(snapshot('corrupt', a, true, 'old-a', 'new-a'))
    await snapshot('partial', b, true, 'old-b', 'new-b')
    await snapshot('partial', a, true, 'old-a', 'new-a')
    await fs.writeFile(a, 'new-a'); await fs.writeFile(b, 'new-b')
    fail = file => file === b
    const first = await undo(null, 'partial')
    assert.deepEqual(first.restored, ['a.txt']); assert.equal(first.failed.length, 1)
    fail = () => false
    const second = await undo(null, 'partial')
    assert.deepEqual(second.restored, ['b.txt']); assert.deepEqual(second.conflicts, [])
    assert.equal(second.snapshotKept, false)
    assert.equal(await fs.readFile(a, 'utf8'), 'old-a')
    // Crash between restored bytes and checkpoint must also be retryable.
    await snapshot('checkpoint', a, true, 'old-a', 'new-a'); await fs.writeFile(a, 'new-a')
    fail = (file, content) => file.endsWith('.tmp') && content.includes('"undone": true')
    assert.equal((await undo(null, 'checkpoint')).failed.length, 1)
    fail = () => false
    assert.equal((await undo(null, 'checkpoint')).snapshotKept, false)
    // A later user edit must never be overwritten by retry/recovery.
    await snapshot('conflict', a, true, 'old-a', 'new-a'); await fs.writeFile(a, 'user-edit')
    assert.deepEqual((await undo(null, 'conflict')).conflicts, ['a.txt'])
    assert.equal(await fs.readFile(a, 'utf8'), 'user-edit')
    // Serial manifest updates cannot lose concurrent snapshot entries.
    await Promise.all(Array.from({ length: 12 }, (_, i) => snapshot('concurrent', path.join(root, `new-${i}`), false, '', 'new')))
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'undo/concurrent/manifest.json'), 'utf8')).entries.length, 12)
    // Two updates of one file roll back in reverse order.
    await snapshot('twice', a, true, 'original', 'v1'); await snapshot('twice', a, true, 'v1', 'v2')
    await fs.writeFile(a, 'v2')
    assert.equal((await undo(null, 'twice')).snapshotKept, false)
    assert.equal(await fs.readFile(a, 'utf8'), 'original')
    await snapshot('twice-conflict', a, true, 'original', 'v1')
    await snapshot('twice-conflict', a, true, 'v1', 'v2')
    await fs.writeFile(a, 'v1') // Later user edit happens to equal an intermediate revision.
    assert.deepEqual((await undo(null, 'twice-conflict')).conflicts, ['a.txt'])
    assert.equal(await fs.readFile(a, 'utf8'), 'v1', 'do not undo older entries after a newer conflict')
    const created = path.join(root, 'created.txt')
    await snapshot('created-retry', created, false, '', 'new')
    await fs.writeFile(created, 'new')
    fail = (file, content) => file.endsWith('.tmp') && content.includes('"undone": true')
    assert.equal((await undo(null, 'created-retry')).failed.length, 1)
    fail = () => false
    assert.equal((await undo(null, 'created-retry')).snapshotKept, false)
    await assert.rejects(fs.access(created), { code: 'ENOENT' })
    // Session review can undo one file, keeping the other file's backup usable.
    await snapshot('selected', a, true, 'first-a', 'second-a')
    await snapshot('selected', b, true, 'first-b', 'second-b')
    await fs.writeFile(a, 'second-a'); await fs.writeFile(b, 'second-b')
    const selected = await undo(null, 'selected', { fileId: crypto.createHash('sha256').update(a).digest('hex') })
    assert.deepEqual(selected.restored, ['a.txt'])
    assert.equal(await fs.readFile(b, 'utf8'), 'second-b')
    assert.equal(selected.snapshotKept, true)
    assert.equal((await undo(null, 'selected')).snapshotKept, false)
    assert.equal(await fs.readFile(b, 'utf8'), 'first-b')
    // An encrypted backup must not become replacement file text when its key is unavailable.
    await snapshot('encrypted-unavailable', a, true, 'old-a', 'new-a'); await fs.writeFile(a, 'new-a')
    const encryptedManifest = JSON.parse(await fs.readFile(path.join(root, 'undo/encrypted-unavailable/manifest.json'), 'utf8'))
    await fs.writeFile(path.join(root, 'undo/encrypted-unavailable', encryptedManifest.entries[0].backup), JSON.stringify({ enc: 'safeStorage', data: 'unavailable' }))
    assert.equal((await undo(null, 'encrypted-unavailable')).failed.length, 1)
    assert.equal(await fs.readFile(a, 'utf8'), 'new-a', 'never replace user content with ciphertext')
    await snapshot('checkpoint-race', a, true, 'old-a', 'new-a'); await fs.writeFile(a, 'new-a')
    duringCheckpoint = () => fs.writeFile(a, 'manual-during-checkpoint')
    assert.deepEqual((await undo(null, 'checkpoint-race')).conflicts, ['a.txt'])
    assert.equal(await fs.readFile(a, 'utf8'), 'manual-during-checkpoint')
    await snapshot('backup-corruption', a, true, 'old-a', 'new-a'); await fs.writeFile(a, 'new-a')
    const corruptManifest = JSON.parse(await fs.readFile(path.join(root, 'undo/backup-corruption/manifest.json'), 'utf8'))
    await fs.writeFile(path.join(root, 'undo/backup-corruption', corruptManifest.entries[0].backup), 'damaged backup')
    assert.equal((await undo(null, 'backup-corruption')).failed.length, 1)
    assert.equal(await fs.readFile(a, 'utf8'), 'new-a', 'corrupted backup cannot replace the current file')
    // Sec-аудит 01.11, Н6: снимок при недоступном шифре остаётся открытым, но
    // честно помеченным как открытый — без ложной метки шифра и читаемый в обе стороны.
    const CODEC = source.slice(source.indexOf('function decodeUndoBackup('), source.indexOf('async function readUndoCurrent(')) +
      '\nreturn { encodeUndoBackup, decodeUndoBackup }'
    const codec = new Function('safeStorageAvailable', 'protectStore', 'unprotectStore', CODEC)(
      () => false, text => 'шифр:' + text, text => text)
    assert.doesNotMatch(codec.encodeUndoBackup('содержимое файла'), /"enc"\s*:\s*"safeStorage"/, 'открытые байты подписаны как шифр')
    assert.equal(JSON.parse(codec.encodeUndoBackup('содержимое файла')).enc, 'plain', 'открытое не помечено честно')
    assert.equal(codec.decodeUndoBackup(codec.encodeUndoBackup('содержимое файла')), 'содержимое файла')
    // Прежний открытый снимок (голые байты на диске) читается, как читался.
    assert.equal(codec.decodeUndoBackup('старый текст'), 'старый текст')
    // JSON-файл, случайно похожий на конверт, не съедается plain-веткой.
    const lookalike = JSON.stringify({ enc: 'plain', data: 'не base64!!!' })
    assert.equal(codec.decodeUndoBackup(lookalike), lookalike)
    // Со снятым гейтом безопасности на снимок (шифр вернулся) новые снимки шифруются и читаются.
    const vault = new Map()
    const codecOn = new Function('safeStorageAvailable', 'protectStore', 'unprotectStore', CODEC)(
      () => true,
      text => { const tag = `c-${vault.size + 1}`; vault.set(tag, text); return tag },
      tag => { if (!vault.has(tag)) throw new Error('no key'); return vault.get(tag) })
    assert.equal(JSON.parse(codecOn.encodeUndoBackup('x')).enc, 'safeStorage')
    assert.equal(codecOn.decodeUndoBackup(codecOn.encodeUndoBackup('x')), 'x')
    // И на диске при недоступном шифре — тот же честный plain-конверт, а не голые байты.
    await snapshot('plain-envelope', a, true, 'тайна-а', 'new-a'); await fs.writeFile(a, 'new-a')
    const plainManifest = JSON.parse(await fs.readFile(path.join(root, 'undo/plain-envelope/manifest.json'), 'utf8'))
    const plainBytes = await fs.readFile(path.join(root, 'undo/plain-envelope', plainManifest.entries[0].backup), 'utf8')
    assert.equal(JSON.parse(plainBytes).enc, 'plain', 'снимок на диске не помечен как открытый')
    assert.equal(plainBytes.includes('тайна-а'), false, 'содержимое лежит в открытом виде без всякой обёртки')
    assert.equal((await undo(null, 'plain-envelope')).restored.length, 1, 'plain-снимок не откатился')
    assert.equal(await fs.readFile(a, 'utf8'), 'тайна-а')
    console.log('Undo reliability: passed (failed backups, corrupt journal, partial retry, checkpoint crash, conflicts, concurrency)')
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + '1code-undo-test-'))
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
