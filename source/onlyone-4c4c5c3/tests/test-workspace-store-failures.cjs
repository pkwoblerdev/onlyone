// break-5 Н10: seal() проверял наличие protect, а не результат — без кольца
// ключей на диск писался {"enc":"safeStorage","data":null} и содержимое терялось.
// break-5 Н11: load() принимал любую ошибку чтения за «первый запуск» —
// EBUSY/EACCES/EISDIR отдавали пустой Workspace поверх настоящего.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createWorkspaceStore } = require('../src/main/workspace-store')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const MINE = {
  name: 'Студия йоги',
  agents: ['Ведущий'],
  tools: ['write_file'],
  files: ['main.js'],
  context: 'Правка лендинга',
  blocks: [{ title: 'Лендинг', role: 'artifact', x: 10, y: 20, w: 360, h: 480, zone: 'left' }],
  scenarios: [{ title: 'Правка лендинга', blocks: ['Лендинг'] }]
}
const cipher = value => 'enc:' + Buffer.from(String(value), 'utf8').toString('base64')
const plain = value => Buffer.from(String(value).replace(/^enc:/, ''), 'base64').toString('utf8')
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), name))
const dirs = []
const dir = name => { const d = tmp(name); dirs.push(d); return d }

// --- Н10: protect есть, но возвращает null (нет кольца ключей) ---
check('protect вернул null — содержимое сохраняется открытым, а не data:null', () => {
  const d = dir('onecode-ws-null-')
  const s = createWorkspaceStore({ dir: d, fs, protect: () => null, unprotect: null })
  const saved = s.save(MINE)
  assert.equal(saved.ok, true, saved.reason)
  const raw = fs.readFileSync(path.join(d, 'workspace.json'), 'utf8')
  assert.ok(!raw.includes('"data":null'), 'на диске конверт с null: ' + raw.slice(0, 80))
  const got = s.load()
  assert.equal(got.ok, true, 'содержимое потеряно: ' + got.reason)
  assert.equal(got.workspace.context, 'Правка лендинга')
  assert.equal(got.workspace.blocks.length, 1)
})
check('контроль: рабочий protect по-прежнему пишет конверт и читается обратно', () => {
  const d = dir('onecode-ws-cipher-')
  const s = createWorkspaceStore({ dir: d, fs, protect: cipher, unprotect: plain })
  assert.equal(s.save(MINE).ok, true)
  const raw = fs.readFileSync(path.join(d, 'workspace.json'), 'utf8')
  assert.match(raw, /"enc":"safeStorage"/, 'конверт пропал')
  assert.ok(!raw.includes('Правка лендинга'), 'содержимое лежит открытым при рабочем шифре')
  const got = s.load()
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.workspace.context, 'Правка лендинга')
})
check('контроль: без protect вовсе — открытый текст (как и обещано)', () => {
  const d = dir('onecode-ws-plain-')
  const s = createWorkspaceStore({ dir: d, fs })
  assert.equal(s.save(MINE).ok, true)
  const got = s.load()
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.workspace.name, 'Студия йоги')
})

// --- Н11: ошибки чтения, которые не «первый запуск» ---
check('ENOENT — первый запуск, пусто (контроль, верно и было)', () => {
  const s = createWorkspaceStore({ dir: dir('onecode-ws-missing-'), fs })
  const got = s.load()
  assert.equal(got.ok, true)
  assert.equal(got.fresh, true)
})
check('EISDIR (workspace.json — каталог) не выдаётся за первый запуск', () => {
  const d = dir('onecode-ws-isdir-')
  fs.mkdirSync(path.join(d, 'workspace.json'))
  const s = createWorkspaceStore({ dir: d, fs })
  const got = s.load()
  assert.equal(got.ok, false, 'каталог выдан за первый запуск: ' + JSON.stringify(got).slice(0, 120))
  assert.match(got.reason, /EISDIR/, 'код ошибки не назван: ' + got.reason)
})
for (const code of ['EBUSY', 'EACCES', 'EPERM', 'EMFILE', 'EIO']) {
  check(`${code} не выдаётся за первый запуск и не даёт окну пустой контейнер`, () => {
    const d = dir('onecode-ws-err-')
    // Настоящий профиль на диске, который окно потом сохранило бы поверх.
    const real = createWorkspaceStore({ dir: d, fs })
    assert.equal(real.save(MINE).ok, true)
    const before = fs.readFileSync(path.join(d, 'workspace.json'), 'utf8')
    const failingFs = { ...fs, readFileSync: () => { const e = new Error(code + ': locked'); e.code = code; throw e } }
    const s = createWorkspaceStore({ dir: d, fs: failingFs })
    const got = s.load()
    assert.equal(got.ok, false, `${code} выдан за первый запуск`)
    assert.match(got.reason, new RegExp(code), 'код ошибки не назван: ' + got.reason)
    assert.equal(fs.readFileSync(path.join(d, 'workspace.json'), 'utf8'), before, 'файл тронут')
  })
}
check('контроль: настоящий профиль читается нормально', () => {
  const d = dir('onecode-ws-ok-')
  const s = createWorkspaceStore({ dir: d, fs })
  assert.equal(s.save(MINE).ok, true)
  const got = s.load()
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.workspace.blocks.length, 1)
  assert.ok(!got.fresh)
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }