'use strict'
// break-4 Н6: unsealTask в ветке успеха (expected расшифровался) выбрасывал шифр
// критерия, если критерий зашифрован другим ключом: open(criterion)→null →
// criterion='' и criterionSealed не сохранялся. Текст проверки терялся навсегда
// при смене ключа профиля. После правки шифр критерия сохраняется (criterionSealed)
// и возвращается, когда ключ подходит — симметрично expectedSealed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createCheckpointStore } = require('../src/main/run-checkpoints')

const SEALED = 'enc:v1:'
const b64 = s => Buffer.from(s, 'utf8').toString('base64')
const unb64 = s => Buffer.from(s, 'base64').toString('utf8')
// Пара protect/unprotect с base64-телом (как DPAPI safeStorage): ключ k читает
// только своё тело, чужое возвращает '' → unseal отдаёт null («не прочиталось»).
const key = k => ({
  protect: t => b64(k + ':' + t),
  unprotect: body => { const s = unb64(body); return s.startsWith(k + ':') ? s.slice(k.length + 1) : '' }
})
const K1 = key('K1')
const K2 = key('K2')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-criterion-loss-'))
const id = n => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`
const req = (over = {}) => ({
  id: 'r.e1', required: true, dependsOn: null, origin: 'plan', agentIndex: 0,
  state: 'in_progress', history: [], createdAt: 1, updatedAt: 1, ...over
})
const checkpoint = (runId, requirement) => ({
  schemaVersion: 1, runId, requestId: '', chatId: null, designId: null, surface: 'chat',
  ask: SEALED + K1.protect('просьба'), mod: null, startedAt: 1, updatedAt: 2, context: null, cycle: null,
  actions: [], droppedActions: 0,
  task: { requirements: [requirement], evidence: [], inputs: {}, budget: null }
})
const write = (runId, requirement) => fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify(checkpoint(runId, requirement)))
const readReq = (runId, k) => createCheckpointStore({ dir, protect: k.protect, unprotect: k.unprotect }).interrupted()
  .find(item => item.runId === runId).task.requirements[0]

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

// Н6: expected читается текущим ключом, критерий — чужой шифр. Шифр критерия обязан сохраниться.
check('Н6: шифр критерия не выбрасывается, когда expected прочитался', () => {
  const runId = id(1)
  const foreignCriterion = SEALED + b64('K2:КРИТЕРИЙ')
  write(runId, req({ expected: SEALED + K1.protect('ОЖИДАНИЕ'), criterion: foreignCriterion }))
  const r = readReq(runId, K1)
  assert.equal(r.expected, 'ОЖИДАНИЕ', 'expected должен прочитаться')
  assert.equal(r.criterionSealed, foreignCriterion, 'шифр критерия выброшен — текст проверки не восстановить')
  fs.rmSync(path.join(dir, `${runId}.json`), { force: true })
})

// Возврат ключа: сохранённый шифр критерия читается, когда ключ подходит.
check('Н6: сохранённый шифр критерия возвращается при подходящем ключе', () => {
  const runId = id(2)
  const foreignCriterion = SEALED + b64('K2:КРИТЕРИЙ')
  write(runId, req({ expected: SEALED + K1.protect('ОЖИДАНИЕ'), criterion: foreignCriterion }))
  const preserved = readReq(runId, K1).criterionSealed
  assert.ok(preserved, 'нечего возвращать — шифр не сохранён')
  // Кладём сохранённый шифр в запись unreadable-формы и читаем ключом K2.
  const back = id(3)
  write(back, req({
    expected: 'Текст требования не прочитан: не подошёл ключ профиля', criterion: '',
    state: 'stale', unreadable: true,
    expectedSealed: SEALED + K2.protect('ОЖИДАНИЕ'), criterionSealed: preserved
  }))
  const r = readReq(back, K2)
  assert.equal(r.criterion, 'КРИТЕРИЙ', 'критерий не восстановился из сохранённого шифра')
  assert.equal(r.expected, 'ОЖИДАНИЕ')
  fs.rmSync(path.join(dir, `${runId}.json`), { force: true })
  fs.rmSync(path.join(dir, `${back}.json`), { force: true })
})

// Отрицательный контроль: читаемый критерий не получает флаг unreadable и лишний шифр.
check('контроль: читаемый критерий читается без unreadable', () => {
  const runId = id(4)
  write(runId, req({ expected: SEALED + K1.protect('ОЖИДАНИЕ'), criterion: SEALED + K1.protect('КРИТЕРИЙ') }))
  const r = readReq(runId, K1)
  assert.equal(r.expected, 'ОЖИДАНИЕ')
  assert.equal(r.criterion, 'КРИТЕРИЙ')
  assert.notEqual(r.unreadable, true, 'читаемое требование помечено нечитаемым')
  assert.equal(r.criterionSealed, undefined, 'лишний шифр у читаемого критерия')
  fs.rmSync(path.join(dir, `${runId}.json`), { force: true })
})

// Контроль: пустой критерий (его нет) — не «непрочитанный», флаг не ставится.
check('контроль: пустой критерий не помечается нечитаемым', () => {
  const runId = id(5)
  write(runId, req({ expected: SEALED + K1.protect('ОЖИДАНИЕ'), criterion: '' }))
  const r = readReq(runId, K1)
  assert.equal(r.criterion, '')
  assert.notEqual(r.unreadable, true, 'пустой критерий помечен нечитаемым')
  fs.rmSync(path.join(dir, `${runId}.json`), { force: true })
})

fs.rmSync(dir, { recursive: true, force: true })
if (failed) process.exit(1)
console.log('ok test-checkpoint-criterion-loss')