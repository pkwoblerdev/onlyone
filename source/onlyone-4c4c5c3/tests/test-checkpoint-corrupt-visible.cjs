'use strict'
// break-4 Н9: обрезанный/повреждённый файл контрольной точки молча исчезал из
// списка прерванных ходов (catch { continue }) — карточки «работа прервалась» нет,
// продолжение повторяет побочные действия вслепую. После правки повреждённый файл
// виден как запись с признаком порчи (corrupt), а renderer предупреждает человека
// и НЕ удаляет файл (чат-less ходы раньше авто-удалялись).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createCheckpointStore } = require('../src/main/run-checkpoints')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-cp-corrupt-'))
const id = n => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`
let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

check('Н9: обрезанный файл хода виден как повреждённая прерванная работа', () => {
  fs.writeFileSync(path.join(dir, `${id(1)}.json`), '{"schemaVersion":1,"runId":')  // обрезан
  const found = createCheckpointStore({ dir }).interrupted()
  assert.equal(found.length, 1, 'повреждённый ход исчез из списка')
  assert.equal(found[0].runId, id(1))
  assert.equal(found[0].corrupt, true)
  assert.equal(found[0].askUnreadable, true)
  assert.deepEqual(found[0].unknown, [], 'действия неизвестны, а не «ничего не было»')
  fs.rmSync(path.join(dir, `${id(1)}.json`), { force: true })
})

check('Н9: чужой runId, .tmp и не-ход по-прежнему пропускаются', () => {
  fs.writeFileSync(path.join(dir, 'не-ход.json'), '{}')
  fs.writeFileSync(path.join(dir, `${id(2)}.json.123.tmp`), '{}')
  fs.writeFileSync(path.join(dir, `${id(3)}.json`), JSON.stringify({ schemaVersion: 1, runId: id(9), actions: [] }))
  assert.deepEqual(createCheckpointStore({ dir }).interrupted(), [])
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true })
})

// Renderer: ветка повреждённой записи предупреждает и не удаляет файл (стиль
// существующих regex-проверок test-design-queue-resume).
check('Н9: renderer предупреждает о повреждённой записи и не удаляет её', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n')
  const from = src.indexOf('  async function showInterruptedRuns() {')
  const to = src.indexOf('  let commentPicking = false')
  assert.ok(from > 0 && to > from, 'showInterruptedRuns не найдена')
  const body = src.slice(from, to)
  const branch = body.indexOf('if (!run.chatId) {')
  assert.ok(branch > 0, 'нет ветки повреждённой записи без чата')
  const segment = body.slice(branch, body.indexOf('const chat = run.chatId'))
  assert.match(segment, /showToast\(t\(/, 'повреждённая запись не предупреждает человека')
  assert.match(segment, /continue/, 'ветка не пропускает авто-удаление')
  assert.doesNotMatch(segment, /dismissInterruptedRun/, 'повреждённый файл авто-удаляется')
})

check('повреждённый ход нельзя продолжить как новый', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  const start = main.indexOf('    const resumed = payload.resumeRunId')
  const end = main.indexOf('    // The UI test fakes', start)
  assert.ok(start > 0 && end > start)
  const resolve = new Function('payload', 'interruptedRunList', 'tr', main.slice(start, end) + '\nreturn resumed')
  const payload = { resumeRunId: id(1) }
  assert.throws(() => resolve(payload, () => [{ runId: id(1), corrupt: true }], x => x), /Прерванный ход не найден/)
  assert.throws(() => resolve(payload, () => [], x => x), /Прерванный ход не найден/)
  const valid = { runId: id(1), corrupt: false }
  assert.equal(resolve(payload, () => [valid], x => x), valid)
})

fs.rmSync(dir, { recursive: true, force: true })
if (failed) process.exit(1)
console.log('ok test-checkpoint-corrupt-visible')