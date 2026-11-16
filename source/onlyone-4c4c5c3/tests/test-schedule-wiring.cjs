'use strict'
// Проверка врезки расписаний в главный процесс (план, 3.5): модуль может быть
// зелёным сам по себе и при этом ничего не делать в приложении. Здесь ровно то,
// что отличает «есть код» от «код подключён»: каналы навешаны, планировщик
// поднят и погашен вместе с окном, окно видит те же имена, что отдаёт preload.
// Набор читает исходники как текст — без Electron, без сети, без платных вызовов.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

let checks = 0
let failed = 0
function check(name, fn) {
  checks++
  try {
    fn()
    console.log('ok', name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${String(error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 300)}`)
  }
}

const CHANNELS = ['get-schedules', 'set-schedule', 'delete-schedule', 'run-schedule-now', 'set-schedule-enabled', 'get-schedule-prompt']

check('главный процесс поднимает планировщик на файле расписаний userData', () => {
  const main = read('src', 'main', 'main.js')
  for (const module_ of ['schedule-model', 'schedule-store', 'schedule-runner', 'schedule-ipc'])
    assert.ok(main.includes(`require('./${module_}')`), `main.js не требует require('./${module_}')`)
  assert.match(main, /createScheduleStore\(\{[\s\S]{0,200}?userData[\s\S]{0,120}?schedules/,
    'хранилище расписаний не на папке профиля — список уедет в неизвестный каталог')
  assert.match(main, /redact:\s*text\s*=>\s*redactSecrets/,
    'текст ошибки расписаний идёт в файл без общей зачистки: ключ модели переживёт перезапуск')
})

check('планировщик исполняет запись ходом и отвечает окну одним каналом', () => {
  const main = read('src', 'main', 'main.js')
  assert.match(main, /execute:\s*\(record,\s*scheduledAt,\s*meta\)\s*=>\s*scheduleIpc\.execute/,
    'исполнитель расписания не подключён: планировщик не сможет ничего сделать')
  assert.match(main, /publish:\s*body\s*=>\s*scheduleIpc\./,
    'события планировщика некому отправлять — экран будет опрашивать диск')
  // Куда уходит состояние и просьба — знает главный процесс: он и называет
  // каналы рядом с отправкой, иначе проверка моста не видит пульшей окну.
  assert.match(main, /push:\s*sendScheduleState/, 'состояние расписаний не доставляется окну')
  assert.match(main, /turn:\s*sendScheduleTurn/, 'просьба расписания не доставляется окну')
  // Слово о сроке показывает человек, поэтому его переводит главный процесс:
  // без `tr` английская вкладка осталась бы русской.
  assert.match(main, /say:\s*tr\b/, 'слова о следующем запуске никто не переводит')
  assert.match(main, /broadcastToWindows\(\s*'schedule-event'/,
    'состояние пушится мимо общего разсылателя окон: экран не увидит чужую правку')
  assert.match(main, /\.send\('schedule-request-turn'/, 'указание о ходе уходит невызывающим способом')
  const alive = /function scheduleWindowAlive\(\)\s*\{[\s\S]{0,400}?\}/.exec(main)
  assert.ok(alive, 'проверки живого окна перед отправкой нет: при закрытом окне исполнитель обязан отказать')
  assert.match(alive[0], /isDestroyed/, 'окно могло умереть между проверкой и отправкой — это не учтено')
  // Мало описать проверку: обе ветки доставки обязаны на неё опираться, иначе
  // отправка уйдёт в мёртвое окно и планировщик будет ждать её десять минут.
  const guards = main.match(/^\s*if \(!scheduleWindowAlive\(\)\) return false$/gm) || []
  assert.equal(guards.length, 2, `проверку окна используют ${guards.length} раз(а) вместо двух`)
})

check('каналы навешаны и планировщик гасится при выходе', () => {
  const main = read('src', 'main', 'main.js')
  const register = /function registerScheduleChannels\(\)\s*\{[\s\S]{0,1600}?\n\}/.exec(main)
  assert.ok(register, 'функции навешивания каналов расписаний нет')
  for (const channel of CHANNELS)
    assert.match(register[0], new RegExp(`^\\s+ipcMain\\.handle\\('${channel}',\\s*\\(event, body\\) => scheduleIpc\\.channels\\['${channel}'\\]`, 'm'),
      `канал ${channel} не навешан или навешан не на тело модуля`)
  assert.match(main, /^[\s]*ipcMain\.on\('schedule-turn-result'.*scheduleIpc\.onTurnResult/m,
    'отчёт окна о ходе расписания никто не слушает: планировщик ждал бы его до срока')
  assert.match(main, /^[\s]*registerScheduleChannels\(\)/m, 'каналы расписаний никто не навешивает')
  assert.match(main, /scheduleIpc\.start\(\)/, 'планировщик не запускается при старте приложения')
  const quit = /app\.on\('before-quit'[\s\S]{0,600}/.exec(main)
  assert.ok(quit, 'обработчика выхода нет')
  assert.match(quit[0], /scheduleIpc\.stop\(\)/,
    'при выходе таймеры планировщика остаются: ход мог бы начаться после закрытия окна')
  // Имена каналов живут в двух местах — здесь и в модуле. Расхождение значит,
  // что окно зовёт канал, за которым никто не стоит, и краснеет именно это.
  const { createScheduleIpc } = require(path.join(root, 'src', 'main', 'schedule-ipc'))
  const api = createScheduleIpc({ runner: {}, model: {} })
  assert.deepEqual(Object.keys(api.channels).sort(), [...CHANNELS].sort(),
    'тела каналов в модуле и имена в главном процессе разошлись')
})

check('preload отдаёт окну ровно те вызовы, ход и итог', () => {
  const preload = read('src', 'preload', 'preload.js')
  for (const [method, channel] of [
    ['getSchedules', 'get-schedules'], ['setSchedule', 'set-schedule'],
    ['deleteSchedule', 'delete-schedule'], ['runScheduleNow', 'run-schedule-now'],
    ['setScheduleEnabled', 'set-schedule-enabled'], ['getSchedulePrompt', 'get-schedule-prompt']]) {
    assert.match(preload, new RegExp(`${method}:[^\\n]*invoke\\('${channel}'`),
      `в preload нет метода ${method}() на канале ${channel}`)
  }
  assert.match(preload, /onScheduleEvent:[^\n]*'schedule-event'/, 'окно не подписано на события расписаний')
  assert.match(preload, /onScheduleTurn:[^\n]*'schedule-request-turn'/, 'окно не подписано на просьбу хода')
  assert.match(preload, /reportScheduleResult:[^\n]*send\('schedule-turn-result'/,
    'окну нечем докладывать итог хода: планировщик остался бы занятым')
  const body = /onScheduleEvent:[^\n]*/.exec(preload)[0]
  assert.ok(!/removeAllListeners|once\(/.test(body), 'подписка на события расписаний написана повторно')
})

check('срабатывание расписания заводит карточку в Центре задач и снимается по паузе', () => {
  const main = read('src', 'main', 'main.js')
  assert.match(main, /require\('\.\/schedule-queue'\)/, 'главный процесс не знает модуль карточки')
  assert.match(main, /^\s*execute: \(record, scheduledAt, meta\) => scheduleQueue\.run\(/m,
    'планировщик сроков вызывает ход мимо карточки — в Центре задач расписания не будет')
  assert.match(main, /^\s*manager: taskManager,/m, 'карточка расписания не подключена к планировщику очереди')
  assert.match(main, /^\s*execute: \(record, scheduledAt, meta\) => scheduleIpc\.execute\(/m,
    'карточка не оборачивает настоящий исполнитель: очередь показывала бы не тот ход')
  assert.match(main, /sendScheduleState\(\{ type: 'schedule-stop', runId \}\)/,
    'пауза из очереди не просит окно остановить ход — карточка встанет «на паузе» над пишущим чатом')
  assert.match(main, /scheduleIpc\.settleTurn\(runId, false,/,
    'после паузы расписание останется «идёт сейчас»: человек не сможет поставить его второй раз')
  assert.match(main, /title: record => tr\('Расписание: %s'/,
    'заголовок карточки не переводится: на английском окне очередь говорила бы по-русски')

  const app = read('src', 'renderer', 'app.js')
  assert.match(app, /^\s*if \(body && body\.type === 'schedule-stop'\)/m, 'окно не слушает просьбу снять ход')
  assert.match(app, /^\s*scheduleRuns\.set\(runId, pane\)/m, 'живой ход не записан: снимать нечего')
  assert.match(app, /^\s*if \(!pane\.requestId\) return true$/m,
    'отмена зовётся без идентификатора: пустой requestId главный процесс читает как «дефолтный» ход, а это чужая работа')
  assert.match(app, /^\s*try \{ await electronAPI\.abortMessage\(pane\.requestId\) \}/m,
    'снятие идёт не той же дорогой, что кнопка остановки хода')
  assert.match(app, /^\s*scheduleRuns\.delete\(runId\)/m,
    'запись о ходе остаётся после итога: следующий запуск снял бы уже завершённый ход')
  assert.match(app, /if \(scheduleStops\.has\(runId\)\) report\(false/, 'снятый ход был бы записан как «выполнено»')
})

check('окно принимает ход расписания тем же путём, что сообщение человека', () => {
  const app = read('src', 'renderer', 'app.js')
  assert.match(app, /^\s*electronAPI\.onScheduleTurn\?\.\(/m, 'окно не слушает просьбу расписания')
  const turn = /async function runScheduledTurn\(body\)\s*\{[\s\S]{0,3600}?\n  \}/.exec(app)
  assert.ok(turn, 'обработчика хода расписания нет')
  assert.match(turn[0], /^\s*got = await electronAPI\.getSchedulePrompt\(body\.id\)/m,
    'ход идёт без текста просьбы — или берёт его откуда-то кроме адреса')
  assert.match(turn[0], /^\s*await handleSendMessage\(pane, prompt/m,
    'ход расписания не идёт через тот же путь, что сообщение человека')
  assert.match(turn[0], /^\s*(else )?report\(true\)/m, 'итог успешного хода не возвращается планировщику')
  assert.match(turn[0], /electronAPI\.reportScheduleResult\?\.\(/, 'отчёта о ходе в главном процессе не будет')
  assert.match(turn[0], /^\s*if \(pane\.generating \|\| pane\.preparing\)/m,
    'окно смотрит только на генерацию: окно ставит сообщение в очередь по `preparing`, а расписание записало бы «выполнено» за ход, которого не было')
  assert.match(turn[0], /pane\.queuedMessage/,
    'нет страховки от гонки: просьба, вставшая в очередь, не должна считаться исполненной')
  assert.ok(!/showToast|confirm\(/.test(turn[0]), 'ход расписания спрашивает или спорит с человеком — его некому ответить')
})

check('ни каналы, ни события не отдают окну текст просьбы', () => {
  const { createScheduleIpc } = require(path.join(root, 'src', 'main', 'schedule-ipc'))
  const sent = []
  const runner = {
    snapshot: () => ({ records: [{ id: 'a', name: 'A', kind: 'daily', daily: { time: '07:30' }, timeZone: 'UTC', action: { type: 'agent-turn', prompt: 'секрет sk-TEST-9' }, nextRunAt: null }], invalid: [], corrupt: false, storeError: '' }),
    add: () => ({ ok: true }), remove: () => true, pause: () => ({ id: 'a' }), resume: () => ({ id: 'a' }),
    runNow: () => Promise.resolve({ ok: true, runId: 'r1' }), start: () => {}, stop: () => {}
  }
  const api = createScheduleIpc({
    runner, model: require(path.join(root, 'src', 'main', 'schedule-model')),
    push: body => sent.push(['schedule-event', body]),
    turn: body => sent.push(['schedule-request-turn', body]), log: () => {},
    // Часы подставные: настоящее `setTimeout` на десять минут держило бы
    // процесс живым после проверки, а набор читает исходники и обязан отдать
    // управление сразу.
    setTimeout: () => 0, clearTimeout: () => {}
  })
  const answer = api.channels['get-schedules']()
  // Форма ответа (обещание) — здесь; что в вьюхе нет `action`/`history` и
  // текста просьбы, закреплено проверкой «в publish и snapshot() нет полей,
  // похожих на секрет» в `tests/test-schedule-runtime.strict.cjs`.
  assert.ok(answer && typeof answer.then === 'function', 'канал get-schedules не отдаёт обещание')
  api.pushEvent({ type: 'schedule-run', id: 'a', name: 'A', prompt: 'секрет sk-TEST-9', action: { prompt: 'x' }, history: [{ ok: true }] })
  const body = JSON.stringify(sent[0][1])
  assert.ok(!/sk-TEST-9|"prompt"|"action"|"history"/.test(body), `в событие окна уехало содержание записи: ${body.slice(0, 200)}`)
  // Указание на ход тоже не несёт текста: окно зовёт адрес отдельно.
  const job = api.execute(runner.snapshot().records[0], 1, { runId: 'r9' })
  const order = JSON.stringify(sent[1][1])
  assert.ok(!/sk-TEST-9|"prompt"/.test(order), `просьба уехала окну в указании хода: ${order.slice(0, 200)}`)
  api.settleTurn('r9', true)
  return job
})

check('экран расписаний существует и загружается страницей', () => {
  assert.ok(fs.existsSync(path.join(root, 'src', 'renderer', 'schedules.js')),
    'src/renderer/schedules.js не найден — вкладку показывать нечем')
  const page = read('src', 'renderer', 'index.html')
  // С 05.10 вкладки «Расписания» в настройках нет (владелец о ней не просил): модуль и каналы остаются, экран не показывается.
  assert.ok(!page.includes('data-settings-tab="schedules"'), 'вкладка «Расписания» должна быть убрана из настроек')
  assert.ok(!page.includes('data-settings-panel="schedules"'), 'панель «Расписания» должна быть убрана из настроек')
  const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map(match => match[1])
  assert.ok(scripts.includes('schedules.js') && scripts.indexOf('schedules.js') < scripts.indexOf('app.js'),
    'schedules.js грузится после app.js — экран не успеет зарегистрироваться')
  // Слово о сроке приходит из главного процесса: смена языка обязана перечитать
  // экран, иначе английская вкладка останется на языке прежнего снимка.
  const app = read('src', 'renderer', 'app.js')
  assert.match(app, /^\s*if \(window\.OnlyoneSchedules\?\.mounted\?\.reload\)/m,
    'после смены языка экран расписаний никто не перечитывает')
})

console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
