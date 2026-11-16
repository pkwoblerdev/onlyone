'use strict'
// Н1 (Mods): «Продолжить» снимало прерванную запись до повторной проверки мода.
// Подсказка мода требует живого статуса, а статусы живут только в памяти
// процесса: после перезапуска prepare падает, и человек остаётся без карточки
// «Продолжить» — повторить нечего. Тест вырезает из main.js участок допуска
// хода (prepare → admitted → снятие прежней записи) и запускает его настоящим
// хранилищем контрольных точек; заглушка только у prepare.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createCheckpointStore } = require('../src/main/run-checkpoints')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

function slice (from, to) {
  const start = main.indexOf(from)
  const end = main.indexOf(to, start + from.length)
  assert.ok(start >= 0 && end > start, 'anchor gone from main.js: ' + from)
  return main.slice(start, end)
}

// Участок допуска: объявление admitted, проверка мода, admitted = true и снятие
// прежней записи — до сжатия истории и первого запроса к модели. `try` хода
// здесь закрывается синтетическим catch: берём кусок как есть, без копии.
const ADMISSION = slice('let admitted = false', 'if (Array.isArray(payload.messages) && payload.messages.length) {') +
  '} catch (error) { throw error }'

const RUN_ID = n => `bbbb0000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`
const MOD = { modId: 'onlyone.project-checks', panelId: 'checks', buttonId: 'diagnose', revision: 3, chatId: 'chat-1' }

function build (where, prepare) {
  const store = createCheckpointStore({ dir: path.join(where, 'runs') })
  const old = RUN_ID(1)
  store.start({ runId: old, requestId: 'r1', chatId: 'chat-1', ask: 'Проверь проект', mod: MOD })
  const list = [{ runId: old }]
  const checkpoint = store.start({ runId: RUN_ID(2), requestId: 'r2', chatId: 'chat-1', ask: 'Проверь проект' })
  const run = new Function('payload', 'resumed', 'checkpoint', 'require', 'modsBridge', 'tr', 'rememberSkillUse',
    'interruptedRunList', 'runCheckpoints',
    `${ADMISSION}; return { payload, admitted }`)
  const admission = payload => run(payload, { runId: old }, checkpoint, () => ({ prepare }), {}, text => text,
    () => {}, () => list, store)
  return { store, old, list, admission }
}

function scratch (name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-mods-resume-' + name + '-'))
}
const fileOf = (where, runId) => path.join(where, 'runs', runId + '.json')

let failures = 0
const test = (name, fn) => {
  try { fn(); console.log('ok', name) } catch (error) { failures++; console.error('FAIL', name, '-', error.message) }
}

test('dismiss happens after admission, not before the mod check', () => {
  const prepare = main.indexOf("require('./mods-run.cjs').prepare")
  const admitted = main.indexOf('admitted = true')
  const dismiss = main.indexOf('runCheckpoints.dismiss(resumed.runId)')
  assert.ok(prepare > 0 && admitted > prepare, 'prepare must run before admitted = true')
  assert.ok(dismiss > admitted, 'the interrupted record is dismissed before the mod is admitted')
  assert.equal(main.indexOf('runCheckpoints.dismiss(resumed.runId)'), main.lastIndexOf('runCheckpoints.dismiss(resumed.runId)'),
    'one dismissal site')
})

test('a refused mod leaves the interrupted run on disk and in the card list', () => {
  const where = scratch('refused')
  try {
    const { store, old, list, admission } = build(where, () => { throw Error('stale suggestion status') })
    assert.throws(() => admission({ chatId: 'chat-1', modAction: { ...MOD } }), /Действие мода недоступно/)
    assert.equal(fs.existsSync(fileOf(where, old)), true, 'the interrupted run was deleted by a refused resume')
    assert.deepEqual(list, [{ runId: old }], 'the card list lost the run that must stay')
    assert.equal(store.interrupted().some(item => item.runId === old), true, 'runs on disk lost the interrupted record')
  } finally { fs.rmSync(where, { recursive: true, force: true }) }
})

test('an admitted mod dismisses the interrupted run', () => {
  const where = scratch('admitted')
  try {
    const { store, old, list, admission } = build(where, payload => ({ payload, skillId: null }))
    const out = admission({ chatId: 'chat-1', modAction: { ...MOD } })
    assert.equal(out.admitted, true)
    assert.equal(fs.existsSync(fileOf(where, old)), false, 'the interrupted run was not dismissed')
    assert.deepEqual(list, [])
    assert.equal(store.interrupted().some(item => item.runId === old), false)
  } finally { fs.rmSync(where, { recursive: true, force: true }) }
})

test('a resume without a mod still dismisses after admission', () => {
  const where = scratch('plain')
  try {
    const { old, list, admission } = build(where, () => { throw Error('prepare must not run') })
    assert.equal(admission({ chatId: 'chat-1' }).admitted, true)
    assert.equal(fs.existsSync(fileOf(where, old)), false)
    assert.deepEqual(list, [])
  } finally { fs.rmSync(where, { recursive: true, force: true }) }
})

if (failures) process.exitCode = 1
else console.log('PASS mods resume order: a refused prepare keeps the interrupted run, an admitted one dismisses it')
