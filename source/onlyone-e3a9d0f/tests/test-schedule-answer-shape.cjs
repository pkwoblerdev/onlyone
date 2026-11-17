'use strict'

// break-4 Н16 (подпункт 1): ответ исполнителя undefined/null/false/'ошибка'/0
// записывался как ok:true — «молчаливый успех», который комментарий модуля
// прямо запрещает. В собранной проводке недостижимо (scheduleIpc.execute всегда
// возвращает объект) — дефект контракта модуля; честный отказ обязателен.
// Подпункт 2 (вид command) НЕ чинится: контракт модели намеренно принимает
// command (приёмочный test-schedule-model «command с командой»), исполнитель
// ещё не подключён — стадинг функции, отказ на валидации сломал бы приёмку.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const model = require('../src/main/schedule-model.js')
const { createScheduleRunner } = require('../src/main/schedule-runner.js')
const { createScheduleStore } = require('../src/main/schedule-store.js')
const { createScheduleQueue } = require('../src/main/schedule-queue.js')

let fails = 0
const check = (name, fn) => {
  try { fn(); console.log('ok   ' + name) } catch (error) { fails++; console.log('FAIL ' + name + ' :: ' + error.message) }
}
const record = { id: 's1', name: 'проверка', timeZone: 'Europe/Berlin', enabled: true, kind: 'daily', daily: { time: '07:30' }, action: { type: 'note', text: 'x' } }
const BAD = [undefined, null, false, 'ошибка', 0]

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-answer-'))
const runnerWith = execute => {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'))
  const store = createScheduleStore({ dir, now: () => 1 })
  const runner = createScheduleRunner({ store, model, now: () => 1000, setTimeout: () => 0, clearTimeout: () => {}, execute })
  runner.start()
  runner.add({ ...record })
  return runner
}

async function main() {
  // 1. Раннер: не-объектный ответ — честный отказ, а не успех.
  for (const answer of BAD) {
    const runner = runnerWith(() => answer)
    await runner.runNow('s1')
    const entry = runner.record('s1').history[0]
    check(`Н16 runner: answer ${JSON.stringify(answer)} is a failure`, () => {
      assert.equal(entry.ok, false, 'молчаливый успех: ' + JSON.stringify(entry))
      assert.ok(entry.error, 'отказ без причины')
    })
  }

  // 2. Очередь: не-объектный ответ — честный отказ.
  for (const answer of BAD) {
    const queue = createScheduleQueue({ execute: () => answer })
    const outcome = await queue.run({ ...record }, 1000)
    check(`Н16 queue: answer ${JSON.stringify(answer)} is a failure`, () => {
      assert.equal(outcome.ok, false, 'молчаливый успех: ' + JSON.stringify(outcome))
      assert.ok(outcome.error, 'отказ без причины')
    })
  }

  // Отрицательные контроли: прежний контракт объектов сохранён.
  const okRunner = runnerWith(() => ({ ok: true }))
  await okRunner.runNow('s1')
  check('NEG runner: object ok:true stays success', () => {
    assert.equal(okRunner.record('s1').history[0].ok, true)
  })
  const failRunner = runnerWith(() => ({ error: 'диск отказал' }))
  await failRunner.runNow('s1')
  check('NEG runner: error text without ok:false stays failure', () => {
    const entry = failRunner.record('s1').history[0]
    assert.equal(entry.ok, false)
    assert.equal(entry.error, 'диск отказал')
  })
  const okQueue = createScheduleQueue({ execute: () => ({ ok: true }) })
  const okOutcome = await okQueue.run({ ...record }, 1000)
  check('NEG queue: object ok:true stays success', () => {
    assert.equal(okOutcome.ok, true, 'объектный успех сломан')
  })
  const throwQueue = createScheduleQueue({ execute: () => { throw new Error('оборот') } })
  const throwOutcome = await throwQueue.run({ ...record }, 1000)
  check('NEG queue: thrown error stays failure', () => {
    assert.equal(throwOutcome.ok, false)
    assert.equal(throwOutcome.error, 'оборот')
  })

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(fails ? `\nFAILS=${fails}` : '\nALL OK')
  process.exit(fails ? 1 : 0)
}
main().catch(error => { console.error(error); process.exit(1) })