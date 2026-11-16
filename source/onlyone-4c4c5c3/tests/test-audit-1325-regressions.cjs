'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const zlib = require('node:zlib')
const { EventEmitter } = require('node:events')
const artifacts = require('../src/main/artifacts')
const { DesignStore, assemble } = require('../src/main/design/store')
const { createScheduleStore } = require('../src/main/schedule-store')
const { createSessionTaskStore } = require('../src/main/session-tasks.cjs')
const { createTaskManager } = require('../src/main/task-manager')
const skillSources = require('../src/main/skill-sources')
const skillPacks = require('../src/main/skill-packs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-1325-regressions-'))
const temp = name => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d }
const protect = text => Buffer.from(text).toString('base64')
const unprotect = text => Buffer.from(text, 'base64').toString()
const crypto = { protect, unprotect }
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
let failed = 0, checks = 0
async function check(name, fn) {
  checks++
  try { await fn(); console.log('ok', name) } catch (e) { failed++; console.error('FAIL', name, e.stack) }
}
const manager = spawn => createTaskManager({ spawn, store: { list: () => [], save() {} }, maxParallel: 1,
  setTimeout: () => 1, clearTimeout() {}, now: () => 100 })
const record = id => ({ id, action: { type: 'agent-turn', prompt: 'PRIVATE-FIXTURE' } })
// Small valid ZIP structure; the reader's size policy must apply even if the central size lies.
function zip(data, declared = data.length) {
  const name = Buffer.from('SKILL.md'), packed = zlib.deflateRawSync(data)
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22)
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(name.length, 26)
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(name.length, 28)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + packed.length, 16)
  return Buffer.concat([local, name, packed, central, name, end])
}
async function failMeta(fn) {
  const original = fsp.rename
  fsp.rename = async (a, b) => {
    if (String(b).endsWith('meta.json')) throw Object.assign(Error('fixture disk full'), { code: 'ENOSPC' })
    return original(a, b)
  }
  try { await assert.rejects(fn, /fixture disk full/) } finally { fsp.rename = original }
}
;(async () => {
  await check('DBD01 failed metadata commit permits retry', async () => {
    const s = artifacts.create({ dir: temp('artifacts-retry') }), a = await s.add({ content: 'v1' })
    await failMeta(() => s.update(a.id, 'v2'))
    assert.equal((await s.update(a.id, 'retry')).current, 2)
    assert.equal(await s.versionText(a.id, 2), 'retry')
  })
  await check('DBD02 failed commit preserves previously committed history', async () => {
    const dir = temp('artifacts-prune'), s = artifacts.create({ dir }), a = await s.add({ content: 'v1' })
    for (let i = 2; i <= 20; i++) await s.update(a.id, 'v' + i)
    await failMeta(() => s.update(a.id, 'v21'))
    assert.equal((await s.readMeta(a.id)).current, 20)
    assert.equal(await s.versionText(a.id, 1), 'v1')
    await s.update(a.id, 'v21 retry')
    assert.equal(fs.existsSync(path.join(dir, a.id, '1-index.html')), false)
  })
  await check('DBD01 preexisting orphan never blocks saves or gets overwritten', async () => {
    const dir = temp('artifacts-existing-orphan'), s = artifacts.create({ dir }), a = await s.add({ content: 'v1' })
    const orphan = path.join(dir, a.id, '2-index.html'); fs.writeFileSync(orphan, 'old uncommitted content')
    assert.equal((await s.update(a.id, 'new committed content')).current, 3)
    assert.equal(fs.readFileSync(orphan, 'utf8'), 'old uncommitted content')
    assert.equal(await s.versionText(a.id, 3), 'new committed content')
  })
  for (const kind of ['design', 'ref', 'artifact']) await check('DBD03 crypto read failure preserves ' + kind, async () => {
    const dir = temp('crypto-' + kind)
    let fail = false
    const cipher = { protect, unprotect: value => { if (fail) throw Error('fixture decrypt unavailable'); return unprotect(value) } }
    let file, read
    if (kind === 'artifact') {
      const s = artifacts.create({ dir, ...cipher }), a = await s.add({ content: 'private artifact' })
      file = path.join(dir, a.id, '1-index.html')
      // Keep metadata decryption working to isolate the version-content path.
      const s2 = artifacts.create({ dir, protect, unprotect: value => {
        if (fail && value === protect('private artifact')) throw Error('fixture decrypt unavailable')
        return unprotect(value)
      } })
      read = () => s2.versionText(a.id, 1)
    } else {
      const s = new DesignStore(dir, cipher), folder = path.join(dir, 'd1')
      fs.mkdirSync(path.join(folder, 'refs'), { recursive: true })
      file = kind === 'design' ? path.join(folder, 'index.dc.html') : path.join(folder, 'refs', 'private.txt')
      const raw = kind === 'design' ? assemble({ template: '<p>private design</p>' }) : 'private ref'
      fs.writeFileSync(file, JSON.stringify({ enc: 'safeStorage', data: protect(raw) }))
      read = () => kind === 'design' ? s.read('d1', 'index.dc.html') : s.readRef('d1', 'private.txt')
    }
    const before = fs.readFileSync(file, 'utf8'); fail = true
    await assert.rejects(read, /fixture decrypt unavailable/)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    fail = false; await read()
  })
  await check('DBD04 archive failure preserves corrupt schedules', () => {
    const dir = temp('schedules-corrupt'), file = path.join(dir, 'schedules.json'), original = '{unreadable-private-data'
    fs.writeFileSync(file, original)
    const disk = Object.create(fs); disk.copyFileSync = () => { throw Error('archive denied') }
    assert.throws(() => createScheduleStore({ dir, fs: disk }).upsert(record('new')), /archive denied/)
    assert.equal(fs.readFileSync(file, 'utf8'), original)
  })
  await check('DBD04 key unavailable never replaces encrypted schedules', () => {
    const dir = temp('schedules-key'), s = createScheduleStore({ dir, ...crypto }); s.upsert(record('old'))
    const before = fs.readFileSync(s.file, 'utf8')
    assert.throws(() => createScheduleStore({ dir }).upsert(record('new')))
    assert.equal(fs.readFileSync(s.file, 'utf8'), before)
  })
  await check('DBD05 corrupt carryover archived before replacement', () => {
    const dir = temp('carryover-corrupt'), file = path.join(dir, 'session-tasks.json'), bad = '{private corrupt tasks'
    fs.writeFileSync(file, bad)
    const s = createSessionTaskStore(file); assert.deepEqual(s.get('old'), [])
    s.set('new', [{ title: 'new' }])
    assert.ok(fs.readdirSync(dir).some(n => n.includes('.corrupt-') && fs.readFileSync(path.join(dir, n), 'utf8') === bad))
  })
  await check('DBD06 carryover encrypts and migrates plaintext', () => {
    const file = path.join(temp('carryover-crypto'), 'session-tasks.json')
    fs.writeFileSync(file, JSON.stringify({ old: { items: [{ title: 'PRIVATE-OLD' }] } }))
    const s = createSessionTaskStore(file, crypto)
    assert.equal(s.get('old')[0].title, 'PRIVATE-OLD')
    assert.ok(!fs.readFileSync(file, 'utf8').includes('PRIVATE-OLD'))
    s.set('new', [{ title: 'PRIVATE-NEW' }]); assert.equal(s.get('new')[0].title, 'PRIVATE-NEW')
    const before = fs.readFileSync(file, 'utf8')
    createSessionTaskStore(file).set('third', [{ title: 'third' }])
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  })
  await check('DBD05 carryover archive failure preserves original bytes and reports error', () => {
    const file = path.join(temp('carryover-backup-denied'), 'session-tasks.json'), before = '{private broken tasks'
    fs.writeFileSync(file, before)
    const disk = Object.create(fs), errors = []
    disk.copyFileSync = () => { throw Error('fixture backup denied') }
    const s = createSessionTaskStore(file, { fs: disk, onError: e => errors.push(e.message) })
    assert.equal(s.set('new', [{ title: 'new' }]), false)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.deepEqual(errors, ['fixture backup denied'])
  })
  await check('DBD06 task/schedule/session production wiring encrypts fixture data', () => {
    const encrypt = text => 'encrypted:' + protect(text), decrypt = text => unprotect(text.slice(10))
    for (const storeName of ['taskStore', 'scheduleStore']) {
      const start = main.indexOf('const ' + storeName + ' = createScheduleStore({')
      const end = main.indexOf('\n})', start)
      const opts = new Function('createScheduleStore', 'join', 'app', 'redactSecrets', 'protectStore', 'unprotectStore',
        main.slice(start, end + 3) + '; return ' + storeName)(x => x, path.join,
        { getPath: () => temp('wiring-' + storeName) }, s => s, encrypt, decrypt)
      const s = createScheduleStore(opts); s.upsert(record('private'))
      assert.ok(!fs.readFileSync(s.file, 'utf8').includes('PRIVATE-FIXTURE'))
      assert.equal(s.list()[0].action.prompt, 'PRIVATE-FIXTURE')
    }
    const from = main.indexOf('let sessionTaskStore = null')
    const to = main.indexOf('\nfunction rememberOpenWork', from)
    const session = new Function('sessionTasksLib', 'join', 'app', 'protectStore', 'unprotectStore', 'redactSecrets',
      main.slice(from, to) + '; return sessionTasks()')({ createSessionTaskStore }, path.join,
      { getPath: () => temp('wiring-session') }, encrypt, decrypt, s => s)
    session.set('x', [{ title: 'PRIVATE-FIXTURE' }])
    const raw = fs.readFileSync(path.join(root, 'wiring-session', 'session-tasks.json'), 'utf8')
    assert.ok(!raw.includes('PRIVATE-FIXTURE')); assert.equal(session.get('x')[0].title, 'PRIVATE-FIXTURE')
  })
  await check('DBD06 corrupt backups preserve encrypted text and arbitrary bytes', () => {
    for (const type of ['schedule', 'carryover']) for (const [suffix, broken] of [
      ['text', Buffer.from('{PRIVATE-OLD-CONTENT')], ['bytes', Buffer.from([0x7b, 0xff, 0x80, 0, 0x7d])]
    ]) {
      const dir = temp('encrypted-backup-' + type + suffix), file = path.join(dir, type === 'schedule' ? 'schedules.json' : 'session-tasks.json')
      fs.writeFileSync(file, broken)
      if (type === 'schedule') createScheduleStore({ dir, ...crypto }).upsert(record('new'))
      else createSessionTaskStore(file, crypto).set('new', [{ title: 'new' }])
      const backup = fs.readdirSync(dir).find(n => n.includes('.corrupt-'))
      assert.ok(backup)
      const raw = fs.readFileSync(path.join(dir, backup), 'utf8')
      assert.ok(!raw.includes('PRIVATE-OLD-CONTENT'))
      const envelope = JSON.parse(raw), decoded = unprotect(envelope.data)
      assert.deepEqual(Buffer.from(decoded, envelope.b64 ? 'base64' : 'utf8'), broken)
    }
  })
  await check('DBD07 refs root junction cannot read/list/delete outside store', async () => {
    const dir = temp('refs-boundary'), outside = temp('outside'), s = new DesignStore(dir)
    fs.mkdirSync(path.join(dir, 'd1')); fs.writeFileSync(path.join(outside, 'secret.txt'), 'own fixture')
    fs.symlinkSync(outside, path.join(dir, 'd1', 'refs'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(() => s.readRef('d1', 'secret.txt'))
    await assert.rejects(() => s.listRefs('d1'))
    await assert.rejects(() => s.removeRef('d1', 'secret.txt'))
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'own fixture')
  })
  await check('TM01 sync spawn failure releases queue slot', () => {
    const m = manager(() => { throw Error('spawn denied') }); m.start()
    try { for (const id of ['first', 'second']) { m.add({ id, title: id, command: 'dummy' }); assert.equal(m.get(id).state, 'error') } }
    finally { m.stop() }
  })
  await check('TM02 null/signal close is not success', () => {
    const child = new EventEmitter(); child.kill = () => true
    const m = manager(() => child); m.start()
    try { m.add({ id: 'x', title: 'x', command: 'dummy' }); child.emit('close', null, 'SIGTERM'); assert.equal(m.get('x').state, 'error') }
    finally { m.stop() }
  })
  await check('TM03 running restart refuses duplicate process', () => {
    let children = 0
    const m = manager(() => { children++; const c = new EventEmitter(); c.kill = () => true; return c }); m.start()
    try { m.add({ id: 'x', title: 'x', command: 'dummy' }); assert.equal(m.restart('x').ok, false); assert.equal(children, 1) }
    finally { m.stop() }
  })
  await check('SK1 import handler preserves original SKILL.md', async () => {
    const dir = temp('skill-source'), dest = temp('skill-dest'), entry = path.join(dir, 'SKILL.md')
    const before = '---\nname: Fixture\n---\n\nRead fixture.'; fs.writeFileSync(entry, before)
    let saved = []; const handlers = {}
    const start = main.indexOf("ipcMain.handle('import-skill-pack'")
    const code = main.slice(start, main.indexOf('// Выбор источника', start))
    vm.runInNewContext(code, { require, skillSources, skillPacks, tr: s => s, ipcMain: { handle: (n, f) => { handlers[n] = f } },
      loadSkills: () => saved, saveSkills: value => { saved = value }, skillPacksRoot: () => dest, workspace: { path: '' } })
    await handlers['import-skill-pack'](null, { path: dir, description: 'Imported description' })
    assert.equal(fs.readFileSync(entry, 'utf8'), before); assert.equal(saved[0].description, 'Imported description')
  })
  await check('SK2 project toggles have distinct identities', () => {
    const a = temp('project-a'), b = temp('project-b'), skill = { name: 'Review', description: 'Review code', body: 'Review fixture' }
    skillSources.writeProjectSkill(a, skill); skillSources.writeProjectSkill(b, skill)
    const sa = skillSources.projectSkills(a)[0], sb = skillSources.projectSkills(b, [sa.id])[0]
    assert.notEqual(sa.id, sb.id); assert.equal(sb.enabled, true)
    assert.equal(skillSources.projectSkills(a, [sa.id])[0].enabled, false)
  })
  for (const lie of [false, true]) await check('SK3 ZIP expansion limited even with dishonest size=' + lie, () => {
    const data = Buffer.alloc(41 * 1024 * 1024, 120)
    assert.throws(() => skillSources.readZip(zip(data, lie ? 1 : data.length)))
  })
  await check('AC05 quoted continuation does not mark complete answer incomplete', () => {
    const expression = main.match(/const incomplete = (Boolean\(hitStepLimit[^\r\n]+)/)[1]
    const value = new Function('hitStepLimit', 'lastGaps', 'aggregateContent', 'continuationIncomplete = false', 'budgetRefusal = null', 'return ' + expression)(false, [], 'В документации: Отправьте «продолжай». Ответ завершён.')
    assert.equal(value, false)
    const evaluate = new Function('hitStepLimit', 'lastGaps', 'aggregateContent', 'continuationIncomplete = false', 'budgetRefusal = null', 'return ' + expression)
    assert.equal(evaluate(true, [], ''), true)
    assert.equal(evaluate(false, ['missing requirement'], ''), true)
  })
  await check('AC02 scaffold invalidates prior Design check', () => {
    const start = main.indexOf('function hasDeterministicProof('), end = main.indexOf('function ', start + 30)
    const { isVerificationCommand } = require('../src/main/verification.cjs')
    const proof = new Function('isVerificationCommand', main.slice(start, end) + '; return hasDeterministicProof')(isVerificationCommand)
    assert.equal(proof([{ tool: 'dc_write', ok: true }, { tool: 'dc_check', ok: true, passed: true }, { tool: 'dc_scaffold', ok: true }]), false)
  })
  await check('AC05 actual continuation exhaustion remains incomplete', () => {
    const expression = main.match(/const incomplete = (Boolean\(hitStepLimit[^\r\n]+)/)[1]
    for (const marker of ['// Out of continuations. The answer is still cut off', 'if (saysUnfinished(stepResult.content) && selfContinues >= selfContinueLimit']) {
      const from = main.indexOf(marker)
      const start = main.indexOf('const notice =', from), end = main.indexOf('\n      }', start)
      const flag = main.lastIndexOf('continuationIncomplete = true', start)
      const body = main.slice(flag > from - 160 ? flag : start, end)
      const evaluate = new Function('let aggregateContent = "", hitStepLimit = false, lastGaps = [], continuationIncomplete = false;' +
        'const emitContent = () => {}; const MAX_ANSWER_CONTINUATIONS = 2, selfContinueLimit = 2;' + body + '; return ' + expression)
      assert.equal(evaluate(), true, marker)
    }
  })
  await check('UI01 empty key pool error has EN translation', () => {
    const ui = require('../src/main/ui-text.cjs'); ui.setLanguageSource(() => 'en')
    try { for (const message of ["В пуле нет активных ключей OpenRouter. Откройте Настройки и добавьте ключ.","Некорректный номер версии артефакта.","Расшифровка артефакта недоступна.","Расшифровка макета недоступна.","Расшифровка референса недоступна.","Папка референсов выводит за пределы макета.","Хранилище недоступно: прежние данные сохранены.","Расшифровка незакрытых задач недоступна.","задача уже исполняется или ожидает запуска"]) assert.doesNotMatch(ui.tr(message), /[А-Яа-яЁё]/) }
    finally { ui.setLanguageSource(() => 'ru') }
  })
  await check('QA02 video harness retains JS errors and counts browser resize notices', () => {
    const source = fs.readFileSync(path.join(__dirname, 'run-video-ui.cjs'), 'utf8')
    const start = source.indexOf('  function recordWindowError(event) {')
    const end = source.indexOf("  window.addEventListener('error', recordWindowError)", start)
    assert.ok(start >= 0 && end > start)
    const errors = [], resizeNotices = []
    const record = new Function('errors', 'resizeNotices', 'location', source.slice(start, end) + '; return recordWindowError')(errors, resizeNotices, { href: 'file:///index.html' })
    const message = 'ResizeObserver loop completed with undelivered notifications.'
    record({ message, error: null, filename: '', lineno: 0, colno: 0 }); assert.equal(resizeNotices.length, 1)
    record({ message, error: new Error(message), filename: '' })
    record({ message, error: null, filename: 'app.js', lineno: 0, colno: 0 })
    record({ message: 'Unexpected runtime error', error: null, filename: '', lineno: 0, colno: 0 })
    record({ message, error: null, filename: 'file:///index.html', lineno: 3, colno: 1 })
    assert.equal(errors.length, 4)
    record({ message, error: null, filename: 'file:///index.html', lineno: 0, colno: 0 }); assert.equal(resizeNotices.length, 2)
  })
  console.log(`${checks - failed}/${checks} audit regressions passed`)
})().catch(e => { failed++; console.error(e) }).finally(() => {
  // Only remove the exact mkdtemp fixture we own; never project/profile paths.
  fs.rmSync(root, { recursive: true, force: true }); process.exitCode = failed ? 1 : 0
})
