'use strict'
// Юниты каналов расписаний и исполнителя (план, этап 3.5): что отвечает окно
// главному процессу и что возвращается окну. Модуль проверяется с подставными
// `ipcMain`, планировщиком и окном — без Electron, без сети, без платных
// вызовов и без реальных ожиданий (таймер срока ответа тоже внедряется).
const assert = require('node:assert/strict')
const path = require('node:path')

let ipcMod = null
let ipcLoadError = null
try {
  ipcMod = require('../src/main/schedule-ipc')
} catch (error) {
  ipcLoadError = String(error.message).split('\n')[0]
}
const model = require('../src/main/schedule-model')

const queue = []
function check(name, fn) { queue.push({ name, fn }) }

async function runQueue() {
  let checks = 0
  let failed = 0
  for (const item of queue) {
    checks++
    if (!ipcMod) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: src/main/schedule-ipc.js отсутствует (${ipcLoadError}) — тесты написаны до кода`)
      continue
    }
    try {
      await item.fn()
      console.log('ok', item.name)
    } catch (error) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: ${String(error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 300)}`)
    }
  }
  console.log(`Проверок: ${checks}, отказов: ${failed}`)
  console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
  process.exitCode = failed ? 1 : 0
}

const SECRET = 'sk-QoderTest-9f8e7d6c4b3a'
const DAY = 24 * 3600 * 1000

function daily(over = {}) {
  return {
    id: 'sch_a', name: 'Утренний разбор', enabled: true, timeZone: 'Europe/Berlin',
    kind: 'daily', daily: { time: '07:30' }, misfire: 'skip',
    action: { type: 'agent-turn', prompt: `разобрать ночное, ключ ${SECRET}` },
    nextRunAt: Date.parse('2026-01-01T05:30:00.000Z'), ...over
  }
}

// Планировщик здесь подставной: каналы обязывают его только к конкретным
// вызовам, и видно должно быть, что именно он сделал.
function fakeRunner(records = [daily()], clockNow = Date.parse('2026-01-01T00:00:00.000Z')) {
  const calls = []
  const running = new Map()
  const live = records.slice()
  const api = {
    calls,
    snapshot: () => ({
      records: live.map(record => ({
        id: record.id, name: record.name, kind: record.kind, timeZone: record.timeZone,
        enabled: record.enabled !== false, running: false, nextRunAt: record.nextRunAt,
        lastRunAt: record.lastRunAt || null, lastError: record.lastError || ''
      })),
      invalid: [], corrupt: false, storeError: ''
    }),
    add: record => { calls.push(['add', record.id]); live.push(record); return { ok: true } },
    remove: id => { calls.push(['remove', id]); return live.some(record => record.id === id) },
    pause: id => { calls.push(['pause', id]); const one = live.find(record => record.id === id); if (!one) return null; return { id, enabled: false } },
    resume: id => { calls.push(['resume', id]); const one = live.find(record => record.id === id); if (!one) return null; return { id, enabled: true } },
    runNow: id => { calls.push(['runNow', id]); running.set(id, `run-${id}`); return Promise.resolve({ ok: true, runId: `run-${id}` }) },
    record: id => records.find(record => record.id === id) || null,
    runningOf: id => running.get(id) || null,
    start: () => { calls.push(['start']) },
    stop: () => { calls.push(['stop']) }
  }
  void clockNow
  return api
}

function harness(records, { window = true, timers = null, say = null } = {}) {
  const sent = []
  const clock = timers || { armed: [], now: Date.parse('2026-01-01T00:00:00.000Z') }
  const runner = fakeRunner(records)
  // Куда и по каким каналам уходит окно — решает главный процесс (там каналы
  // и навешаны), поэтому сюда приходит доставка, а не `ipcMain`.
  const deliver = (channel, body) => { sent.push([channel, body]); return window }
  const api = ipcMod.createScheduleIpc({
    runner,
    model,
    push: body => deliver('schedule-event', body),
    turn: body => deliver('schedule-request-turn', body),
    redact: text => String(text).split(SECRET).join('***'),
    say: say || undefined,
    log: () => {},
    now: () => clock.now,
    setTimeout: (fn, ms) => { clock.armed.push({ fn, at: clock.now + ms }); return clock.armed.length - 1 },
    clearTimeout: id => { if (clock.armed[id]) clock.armed[id].fn = null }
  })
  const call = (channel, payload) => {
    const handler = api.channels[channel]
    assert.equal(typeof handler, 'function', `канал ${channel} не навешан: тело не отдаётся`)
    return handler({ sender: {} }, payload)
  }
  // Отчёт окна о ходе: в приложении это канал `schedule-turn-result`.
  const result = body => api.onTurnResult({ sender: {} }, body)
  return { api, call, sent, clock, runner, result }
}

// 1. Каналы есть и отвечают внятной формой.
check('модуль отдаёт шесть тел каналов и итог хода', () => {
  const { api } = harness()
  for (const channel of ['get-schedules', 'set-schedule', 'delete-schedule', 'run-schedule-now', 'set-schedule-enabled', 'get-schedule-prompt'])
    assert.equal(typeof api.channels[channel], 'function', `тела канала ${channel} нет`)
  assert.equal(typeof api.onTurnResult, 'function', 'модуль не принимает итог хода')
})

check('get-schedules отдаёт состояние, срок словами и не отдаёт содержание', async () => {
  const { call } = harness()
  const got = await call('get-schedules')
  assert.equal(got.ok, true, `канал ответил ${JSON.stringify(got).slice(0, 120)}`)
  assert.equal(got.records.length, 1, 'записей в ответе нет')
  assert.match(String(got.nextText.sch_a), /07:30/, `слова о следующем запуске не те: ${JSON.stringify(got.nextText)}`)
  const dump = JSON.stringify(got)
  assert.ok(!dump.includes(SECRET), 'в ответ окна уехал ключ из текста просьбы')
  assert.equal(/"prompt"|"action"|"history"/.test(dump), false, `окну показали содержание записи: ${dump.slice(0, 200)}`)
  for (const field of ['corrupt', 'invalid', 'storeError'])
    assert.ok(field in got, `в ответе нет поля ${field} — экран не узнает о беде с файлом`)
})

// 2. Отказы.
check('невалидная запись не доходит до планировщика, а причины видно', async () => {
  const { call, runner } = harness()
  const got = await call('set-schedule', { id: 'sch_b', kind: 'нет-такого', timeZone: 'Mars/Olympus' })
  assert.equal(got.ok, false, 'невалидное расписание принято')
  assert.ok(Array.isArray(got.errors) && got.errors.length, `причин нет: ${JSON.stringify(got)}`)
  assert.ok(!runner.calls.some(one => one[0] === 'add'), 'планировщику всё-таки отдали битую запись')
})

check('51-е расписание — честный отказ, а правка существующего проходит', async () => {
  const many = Array.from({ length: 50 }, (_, i) => daily({ id: `sch_${i}` }))
  const { call, api } = harness(many)
  const added = await call('set-schedule', daily({ id: 'sch_new' }))
  assert.equal(added.ok, false, '51-я запись принята — предела нет')
  assert.match(String(added.error), /50|предел|лишн/, `причина нечеловеческая: ${JSON.stringify(added)}`)
  const edited = await call('set-schedule', daily({ id: 'sch_0', name: 'Правка' }))
  assert.equal(edited.ok, true, 'правка существующего расписания заблокирована тем же пределом')
  void api
})

check('просьба известная и неизвестная: delete, пауза, возобновление', async () => {
  const { call } = harness()
  assert.deepEqual(await call('delete-schedule', 'sch_a'), { ok: true }, 'удаление не сообщило успех')
  assert.deepEqual(await call('delete-schedule', 'нет-такого'), { ok: false }, 'чужой id притворился удалённым')
  const off = await call('set-schedule-enabled', { id: 'sch_a', enabled: false })
  assert.equal(off.ok, true, 'пауза существующего id не прошла')
  assert.equal(off.enabled, false, 'в ответе нет нового состояния')
  const ghost = await call('set-schedule-enabled', { id: 'нет-такого', enabled: true })
  assert.equal(ghost.ok, false, 'возобновление несуществующего id удалось')
})

check('run-schedule-now отвечает сразу и не врёт про итог хода', async () => {
  const { call } = harness()
  const started = Date.now()
  const got = await call('run-schedule-now', 'sch_a')
  assert.ok(Date.now() - started < 50, 'канал ждал окончания хода — экран бы завис')
  assert.equal(got.ok, true, `запуск не принят: ${JSON.stringify(got)}`)
  assert.ok(got.runId, 'в ответе нет runId: окно не сопоставит итог с нажатием')
  assert.equal('undefined' in got, false)
  const ghost = await call('run-schedule-now', 'нет-такого')
  assert.equal(ghost.ok, false, 'запуск несуществующего расписания удался')
})

// 3. Исполнитель: окно есть — обещание, окна нет — сразу отказ.
check('исполнитель отдаёт просьбу окну без секретов и ждёт итога', async () => {
  const { api, sent, clock } = harness()
  let settled = null
  const job = api.execute(daily(), 1234, { runId: 'r1' }).then(value => { settled = value })
  await Promise.resolve()
  assert.equal(settled, null, 'исполнитель разрешился до ответа окна — ход могли не увидеть')
  const turn = sent.find(one => one[0] === 'schedule-request-turn')
  assert.ok(turn, `окну не отдали канал хода; отправлено: ${JSON.stringify(sent.map(one => one[0]))}`)
  assert.equal(turn[1].runId, 'r1', 'в указании нет runId: окно нечем будет ответить')
  assert.equal(turn[1].scheduledAt, 1234, 'число слота до исполнителя не дошло')
  assert.ok(!JSON.stringify(turn[1]).includes(SECRET), 'просьба с ключом уехала в окно текстом')
  api.settleTurn('r1', true)
  await job
  assert.equal(settled.ok, true, `исход окна не дошёл: ${JSON.stringify(settled)}`)
  void clock
})

check('при закрытом окне исполнитель отказывает сразу, без висящего обещания', async () => {
  const { api } = harness(undefined, { window: false })
  const got = await api.execute(daily(), 1234, { runId: 'r2' })
  assert.equal(got.ok, false, 'ход без окна притворился запущенным')
  assert.match(String(got.error), /окн/, `причина не говорит про окно: ${JSON.stringify(got)}`)
})

check('срок ожидания ответа окна не бесконечен, а stop() гасит висящие', async () => {
  const { api, clock } = harness()
  const waited = api.execute(daily(), 1, { runId: 'r3' })
  const stopped = api.execute(daily({ id: 'sch_b' }), 1, { runId: 'r4' })
  await Promise.resolve()
  assert.equal(clock.armed.length, 2, `таймеров срока не видно: ${clock.armed.length}`)
  api.stop()
  const [a, b] = await Promise.all([waited, stopped])
  assert.equal(a.ok, false, 'остановка отдалась успехом')
  assert.match(String(a.error), /останов/, `причина не «расписание остановлено»: ${JSON.stringify(a)}`)
  assert.equal(b.ok, false, 'второе обещание осталось висеть после stop()')
})

check('повторный отчёт того же хода игнорируется, чужого — не бросает', async () => {
  const { api, result } = harness()
  const seen = []
  api.execute(daily(), 1, { runId: 'r5' }).then(value => seen.push(value))
  await Promise.resolve()
  result({ runId: 'r5', ok: true })
  result({ runId: 'r5', ok: false, error: 'второй отчёт' })
  result({ runId: 'не-тот', ok: true })
  result(null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(seen.length, 1, `ход закрылся ${seen.length} раз(а) — повторный отчёт принят`)
  assert.equal(seen[0].ok, true, `итог перебит поздним отчётом: ${JSON.stringify(seen[0])}`)
})

// 4. Перевод слова о сроке: экран показывает его человеку.
check('слово о следующем запуске идёт через переводчик главного процесса', async () => {
  const seen = []
  const { call } = harness(undefined, { say: (template, ...args) => { seen.push([template, args]); return 'EN ' + template } })
  const got = await call('get-schedules')
  assert.ok(seen.length, 'переводчик не вызывался: на английском окне срок остался русским')
  assert.match(Object.values(got.nextText)[0], /^EN /, 'слова о сроке не прошли через переводчик')
})

// 5. Просьба — только форме правки.
check('get-schedule-prompt отдаёт текст только по адресному запросу и зачищенный', async () => {
  const { call } = harness([daily()])
  const got = await call('get-schedule-prompt', 'sch_a')
  assert.equal(got.ok, true, `форма правки не получила текст: ${JSON.stringify(got)}`)
  assert.match(String(got.prompt), /разобрать ночное/, 'текста просьбы нет')
  assert.ok(!String(got.prompt).includes(SECRET), 'ключ из просьбы уехал в форму открытым')
  const ghost = await call('get-schedule-prompt', 'нет-такого')
  assert.equal(ghost.ok, false, 'просьба несуществующего расписания нашлась')
})

console.log(`Набор каналов расписаний; модуль: ${ipcMod ? 'есть' : `нет (${ipcLoadError})`}`)
runQueue()
