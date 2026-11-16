'use strict'
// Расписание как производитель Центра задач (план, 3.4б;
// 30.09 12:00). Тесты ДО КОДА: модуля `src/main/schedule-queue.js` ещё нет,
// набор красный.
//
// Что здесь проверяется и почему именно это:
//   · карточка заводится на срабатывании и не занимает слот очереди: работа
//     присоединённая — её исполняет окно, а не планировщик;
//   · пауза и отмена из очереди снимают именно тот ход, который исполнитель
//     ведёт под этим `runId`, — иначе карточка встанет «на паузе», а чат продолжит
//     писать;
//   · исход хода закрывает карточку кодом; отказ исполнителя и брошенное
//     исключение не могут выглядеть как «выполнено»;
//   · очередь — наблюдатель: если она не приняла работу, расписание всё равно
//     срабатывает, а причина остаётся в журнале;
//   · текст просьбы в карточку не едет никогда: в заголовке только имя
//     расписания, в теле — никаких полей действия (там человек мог написать ключ).
//
// Планировщик подставлен так же, как настоящий `task-manager.launch`: слушателей
// `close` и `error` регистрирует он сам, а производитель потом зовёт их. Поэтому
// видно, ОДИН раз ли сообщён итог и каким кодом.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const file = path.join(root, 'src', 'main', 'schedule-queue.js')

const queue = []
function check(name, fn) { queue.push({ name, fn }) }

let createScheduleQueue = null
let loadError = ''
try {
  createScheduleQueue = require(file).createScheduleQueue
} catch (error) {
  loadError = String(error && error.message).split('\n')[0]
}

const SECRET = 'sk-TEST-9'
const record = (over = {}) => ({
  id: 'sch_morning',
  name: 'Утренний разбор',
  kind: 'daily',
  daily: { time: '07:30' },
  timeZone: 'Europe/Berlin',
  action: { type: 'agent-turn', prompt: `разобрать отчёт, ключ ${SECRET}`, chatId: 'chat_7' },
  ...over
})

function harness(options = {}) {
  const added = []
  const log = []
  const stopped = []
  const calls = []
  const accept = options.accept !== false
  const manager = {
    add(input) {
      added.push(input)
      if (!accept) return { ok: false, error: options.refuseReason || 'очередь полна: предел 40 задач' }
      input.__closes = []
      input.handle.on('close', code => input.__closes.push({ code: Number(code) || 0 }))
      input.handle.on('error', error => input.__closes.push({ code: 1, error: String((error && error.message) || error) }))
      return { ok: true, id: 'task_1', task: { id: 'task_1', state: 'running' } }
    }
  }
  const execute = options.execute || (async (rec, at, meta) => { calls.push([rec.id, at, meta]); return { ok: true, runId: meta.runId } })
  const queueModule = createScheduleQueue({
    manager,
    execute,
    stopRun: runId => { stopped.push(runId); return true },
    title: rec => `Расписание: ${rec.name}`,
    log: text => log.push(String(text))
  })
  return {
    added, log, stopped, calls,
    run: (rec, at, meta) => Promise.resolve(queueModule.run(rec, at, meta || { runId: `${rec.id}-${at}`, manual: false })),
    // Несколько оборотов микросеточки: итог приходит по обещанию исполнителя.
    settle: async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)) }
  }
}

if (!createScheduleQueue) {
  check(`модуль ${path.relative(root, file)} существует и экспортирует createScheduleQueue`, () => {
    assert.ok(fs.existsSync(file), `файла нет (${loadError}) — тесты написаны до кода`)
    assert.equal(typeof createScheduleQueue, 'function', `экспорт не функция (${loadError})`)
  })
} else {
  check('срабатывание заводит карточку: род, id расписания, названный чат и заголовок без текста просьбы', async () => {
    const { added, run, settle } = harness()
    run(record(), 1000, { runId: 'r1', manual: false })
    await settle()
    assert.equal(added.length, 1, `карточек заведено ${added.length}`)
    const task = added[0]
    assert.equal(task.kind, 'schedule', `род карточки «${task.kind}» — экран не отличит расписание от команды`)
    assert.equal(task.scheduleId, 'sch_morning', 'карточка не ссылается на расписание')
    assert.equal(task.chatId, 'chat_7', 'названный чат в карточку не попал')
    assert.equal(task.title, 'Расписание: Утренний разбор', `заголовок не тот: ${task.title}`)
    const dump = JSON.stringify({ ...task, handle: null, __closes: null })
    assert.ok(!dump.includes(SECRET) && !dump.includes('разобрать отчёт'), `в карточку уехал текст просьбы: ${dump.slice(0, 200)}`)
    assert.equal(task.command, undefined, 'у карточки расписания не может быть командной строки')
    assert.equal(typeof task.handle.on, 'function', 'планировщик не узнает об итоге: у рукоятки нет on()')
    assert.equal(typeof task.handle.kill, 'function', 'пауза не сможет снять ход: у рукоятки нет kill()')
  })

  check('расписание «в новый чат» не приписывает карточке чужой чат', async () => {
    const { added, run, settle } = harness()
    run(record({ action: { type: 'agent-turn', prompt: 'x' } }), 1000, { runId: 'r-new' })
    await settle()
    const chatId = added[0].chatId
    assert.ok(chatId === null || chatId === undefined, `карточка обещает чат, которого расписание не выбирало: ${JSON.stringify(chatId)}`)
  })

  check('пауза из очереди снимает ход с тем же runId, который ведёт исполнитель', async () => {
    const { added, stopped, run, settle } = harness({ execute: () => new Promise(() => {}) })
    run(record(), 2000, { runId: 'r-pause' })
    await settle()
    assert.ok(added[0], 'карточки нет — снимать нечего')
    const answer = added[0].handle.kill()
    assert.deepEqual(stopped, ['r-pause'], `окну сказали снять не тот ход: ${JSON.stringify(stopped)}`)
    assert.equal(answer, true, `пауза ответила «не сняла» (${JSON.stringify(answer)}), а карточка всё равно встанет на паузу`)
  })

  check('успешный ход закрывает карточку нулевым кодом', async () => {
    const { added, run, settle } = harness({ execute: async (rec, at, meta) => ({ ok: true, runId: meta.runId }) })
    await run(record(), 3000, { runId: 'r-ok' })
    await settle()
    assert.deepEqual(added[0].__closes, [{ code: 0 }], `итог сообщён так: ${JSON.stringify(added[0].__closes)}`)
  })

  check('отказ исполнителя — ненулевой код и причина в карточке', async () => {
    const { added, run, settle } = harness({ execute: async (rec, at, meta) => ({ ok: false, error: 'окно закрыто — ход расписания некому отдать', runId: meta.runId }) })
    await run(record(), 3000, { runId: 'r-bad' })
    await settle()
    const closes = added[0].__closes
    assert.equal(closes.length, 1, `итог сообщён ${closes.length} раз(а)`)
    assert.notEqual(closes[0].code, 0, 'отказ закрыт нулём — карточка сказала бы «выполнено»')
    assert.match(String(closes[0].error || ''), /окно закрыто/, `карточка осталась без причины: ${JSON.stringify(closes[0])}`)
  })

  check('бросок исполнителя — ошибка карточки, а не «выполнено»', async () => {
    const { added, run, settle } = harness({ execute: () => { throw new Error('исполнитель упал') } })
    await run(record(), 4000, { runId: 'r-throw' })
    await settle()
    const closes = added[0].__closes
    assert.equal(closes.length, 1, `итог сообщён ${closes.length} раз(а) — карточка мигнула бы состоянием`)
    assert.notEqual(closes[0].code, 0, `бросок закрыт нулём: ${JSON.stringify(closes[0])}`)
    assert.match(String(closes[0].error || ''), /исполнитель упал/, 'причина броска не дошла до карточки')
  })

  check('очередь не приняла работу: расписание всё равно исполняется, причина в журнале', async () => {
    const { log, calls, run, settle } = harness({ accept: false, refuseReason: 'очередь полна: предел 40 задач' })
    const answer = await run(record(), 5000, { runId: 'r-full' })
    await settle()
    assert.equal(calls.length, 1, 'исполнитель не вызван — отказ очереди отменил запуск')
    assert.equal(answer.ok, true, `ход не дошёл: ${JSON.stringify(answer)}`)
    assert.ok(log.some(one => /очередь полна/.test(one)), `отказ очереди не записан в журнал: ${JSON.stringify(log)}`)
  })

  check('поздняя пауза после итога не перекрывает состояние карточки', async () => {
    const { added, run, settle } = harness({ execute: async (rec, at, meta) => ({ ok: true, runId: meta.runId }) })
    await run(record(), 6000, { runId: 'r-late' })
    await settle()
    added[0].handle.kill()
    await settle()
    assert.equal(added[0].__closes.length, 1,
      `после поздней паузы итогов ${added[0].__closes.length} — «выполнено» переписалось бы «ошибкой»`)
  })

  check('ход без карточки не оставляет необработанного отчёта', async () => {
    // Если очередь отказала, слушателей никто не зарегистрировал, и сообщать
    // итог некому: модуль обязан дождаться хода и вернуть его как есть.
    const { run } = harness({ accept: false })
    const answer = await run(record(), 6500, { runId: 'r-nocard' })
    assert.equal(answer.ok, true, `отказ очереди утёк в ошибку исполнителя: ${JSON.stringify(answer)}`)
  })

  check('модуль не знает ни об Electron, ни о диске: только переданные части', () => {
    const source = fs.readFileSync(file, 'utf8')
    for (const forbidden of ["require('electron')", 'BrowserWindow', 'ipcMain', 'safeStorage', "require('fs')", 'require("fs")']) {
      assert.ok(!source.includes(forbidden), `модуль тянет ${forbidden} — его нельзя будет проверить без окна`)
    }
  })
}

runQueue()

async function runQueue() {
  let checks = 0
  let failed = 0
  for (const item of queue) {
    checks++
    try {
      await item.fn()
      console.log('ok', item.name)
    } catch (error) {
      failed++
      console.error(`ПРОВАЛ [${item.name}]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 300)}`)
    }
  }
  console.log(`Проверок: ${checks}, отказов: ${failed}`)
  console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
  process.exitCode = failed ? 1 : 0
}
