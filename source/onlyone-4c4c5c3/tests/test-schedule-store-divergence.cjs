'use strict'
// break-4 Н15: add/pause/resume звали store.upsert напрямую, минуя write(), который
// глотает отказ хранилища и пишет storeError. При отказе диска исключение улетало
// в окно (schedule-ipc без try/catch), а storeError оставался пустым. После правки
// три команды идут через write() (persistRecord): отказ не падает наружу и виден
// в снимке. Отрицательный контроль: с целым диском команды работают, storeError пуст.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const storeMod = require('../src/main/schedule-store')
const runnerMod = require('../src/main/schedule-runner')
const model = require('../src/main/schedule-model')

const dirs = []
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-sched-div-')); dirs.push(d); return d }
const clock = () => { let t = Date.parse('2026-04-01T04:00:00.000Z'); return { now: () => t, setTimeout: () => 1, clearTimeout: () => {} } }
const hourly = (over = {}) => ({
  id: 'sch_1', name: 'Утренний разбор', enabled: true, timeZone: 'Europe/Berlin',
  kind: 'interval', interval: { everyMinutes: 60, from: Date.parse('2026-04-01T04:00:00.000Z') },
  action: { type: 'note', text: 'заметка' }, ...over
})

// Раннер с отказом диска на upsert; чтение (load/list) работает, чтобы start прошёл.
function brokenRunner() {
  const dir = tmpDir(); const c = clock()
  const good = storeMod.createScheduleStore({ dir, now: c.now })
  good.upsert(hourly())
  const broken = Object.assign(Object.create(null), good, {
    upsert: () => { throw new Error('диск отказал') },
    appendHistory: () => { throw new Error('диск отказал') }
  })
  const runner = runnerMod.createScheduleRunner({
    store: broken, model, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    publish: () => {}, execute: () => ({ ok: true })
  })
  runner.start()
  return { runner, dir }
}
function goodRunner() {
  const dir = tmpDir(); const c = clock()
  const store = storeMod.createScheduleStore({ dir, now: c.now })
  const runner = runnerMod.createScheduleRunner({
    store, model, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    publish: () => {}, execute: () => ({ ok: true })
  })
  runner.start()
  return { runner, store, dir }
}

let failed = 0
const check = (name, fn) => { try { fn(); console.log('ok', name) } catch (e) { failed++; console.error('ПРОВАЛ', name, '-', e.message) } }

check('Н15: pause при отказе диска не бросает и пишет storeError', () => {
  const { runner } = brokenRunner()
  assert.doesNotThrow(() => runner.pause('sch_1'), 'pause бросил отказ диска наружу')
  assert.match(String(runner.snapshot().storeError), /диск отказал/, 'storeError пуст — отказ не виден окну')
})
check('Н15: resume при отказе диска не бросает и пишет storeError', () => {
  const { runner } = brokenRunner()
  assert.doesNotThrow(() => runner.resume('sch_1'), 'resume бросил отказ диска наружу')
  assert.match(String(runner.snapshot().storeError), /диск отказал/, 'storeError пуст — отказ не виден окну')
})
check('Н15: add при отказе диска не бросает и пишет storeError', () => {
  const { runner } = brokenRunner()
  assert.doesNotThrow(() => runner.add(hourly({ id: 'sch_2', name: 'Вечерний' })), 'add бросил отказ диска наружу')
  assert.match(String(runner.snapshot().storeError), /диск отказал/, 'storeError пуст — отказ не виден окну')
})

// Отрицательный контроль: целый диск — команды работают, storeError пуст.
check('контроль: целый диск — pause/resume/add работают, storeError пуст', () => {
  const { runner, store } = goodRunner()
  runner.add(hourly())
  assert.equal(runner.snapshot().storeError, '', 'storeError не пуст на целом диске')
  runner.pause('sch_1')
  assert.equal(store.list().find(r => r.id === 'sch_1').enabled, false, 'pause не дошёл до диска')
  runner.resume('sch_1')
  assert.equal(store.list().find(r => r.id === 'sch_1').enabled, true, 'resume не дошёл до диска')
  assert.equal(runner.snapshot().storeError, '', 'storeError не пуст после успешных команд')
})

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
if (failed) process.exit(1)
console.log('ok test-schedule-store-divergence')