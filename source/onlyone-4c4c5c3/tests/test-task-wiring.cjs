'use strict'
// Проверка врезки Центра задач (план, 3.4): планировщик может быть зелёным сам
// по себе и при этом неexistовать в приложении. Здесь то, что отличает «модуль
// написан» от «модуль подключён»: каналы навешаны, очередь поднята и погашена
// вместе с окном, журнал лежит в своём каталоге своим файлом.
// Набор читает исходники как текст — без Electron, без сети.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
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

check('главный процесс поднимает очередь задач на своём файле в профиле', () => {
  const main = read('src', 'main', 'main.js')
  assert.ok(main.includes(`require('./task-manager')`), 'main.js не требует ./task-manager')
  assert.ok(main.includes(`require('./task-view')`), 'main.js не требует ./task-view')
  assert.match(main, /createScheduleStore\(\{[\s\S]{0,220}?userData[\s\S]{0,120}?tasks[\s\S]{0,80}?file:\s*'tasks\.json'/,
    'журнал задач не на отдельном файле в профиле — он либо уедет в чужой каталог, либо станет `schedules.json`')
  assert.match(main, /redact:\s*text\s*=>\s*redactSecrets/,
    'текст задачи идёт в файл без общей зачистки')
})

check('окно получает состояния очереди одним каналом и общим путём пуша', () => {
  const main = read('src', 'main', 'main.js')
  assert.match(main, /function sendTaskState\(body\)[\s\S]{0,260}broadcastToWindows\('task-event'[\s\S]{0,120}taskView\.eventBody/,
    'состояния очереди не уходят в окно каналом task-event из главной сборки')
  assert.match(main, /sendTaskState\)|send:\s*sendTaskState/, 'планировщик некому отправить состояние')
  // У пуша от планировщика IPC-события нет: говорит не окно. Первый аргумент
  // `sendToWindow` — именно событие, и `test-window-send-all` красит подставу
  // вида `{ sender: … }`, поэтому здесь общий путь со всеми остальными пушами.
  assert.equal(/sendToWindow\(\s*\{/.test(main), false,
    'в sendToWindow подставлено событие: пуш без IPC-события идёт broadcastToWindows')
  const view = read('src', 'main', 'task-view.js')
  assert.equal(/webContents\s*\.\s*send|event\.sender\.send/.test(view), false,
    'форма ответа шлёт в окно в обход охранителя — на мёртвом адресате это падает')
})

check('каналы навешаны, очередь запускается и гасится при выходе', () => {
  const main = read('src', 'main', 'main.js')
  for (const channel of ['task-list', 'task-pause', 'task-resume', 'task-cancel', 'task-restart'])
    assert.ok(main.includes(`ipcMain.handle('${channel}'`),
      `канал ${channel} не навешан в главном процессе — проверка врезки и аудит читают его здесь`)
  assert.match(main, /registerTaskChannels\(\)/, 'каналы очереди никто не навешивает при старте')
  assert.match(main, /taskManager\.start\(\)/, 'очередь не поднимается при старте приложения')
  const quit = /app\.on\('before-quit'[\s\S]{0,500}/.exec(main)
  assert.ok(quit, 'обработчика выхода нет')
  assert.match(quit[0], /taskManager\.stop\(\)/,
    'при выходе процессы и таймеры очереди остаются: приложение не сможет уснуть и допишет в журнал что попало')
})

check('хранилище пишет тот файл, который ему назвали, а копию битого — по тому же основанию', () => {
  const { createScheduleStore } = require(path.join(root, 'src', 'main', 'schedule-store'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-task-wiring-'))
  try {
    const store = createScheduleStore({ dir, file: 'tasks.json' })
    store.save([{ id: 'a', title: 'первая' }])
    assert.deepEqual(fs.readdirSync(dir), ['tasks.json'],
      `в каталогеJournal лежит ${JSON.stringify(fs.readdirSync(dir))} — имя файла не послушалось опции`)
    fs.writeFileSync(path.join(dir, 'tasks.json'), '{"records":[{"id":"x",', 'utf8')
    assert.equal(store.load().corrupt, true, 'битый журнал задач назван целым')
    store.save([{ id: 'b', title: 'вторая' }])
    const kept = fs.readdirSync(dir).filter(name => /^tasks\.corrupt-/.test(name))
    assert.equal(kept.length, 1, `копия битого журнала называется не по файлу: ${JSON.stringify(fs.readdirSync(dir))}`)
    assert.deepEqual(store.list().map(one => one.id), ['b'], 'новая запись не леглась')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('ни планировщик, ни прослойка не тянут Electron и не смотрят на часы машины', () => {
  for (const file of ['task-manager.js', 'task-view.js']) {
    const source = read('src', 'main', file)
    assert.equal(source.includes(`require('electron')`), false, `${file}: Electron должен приходить параметрами`)
    assert.equal(source.includes('Date.now()'), false, `${file}: часы машины внутри модуля — тест не сдвинет время`)
  }
})

check('мост и экран говорят одними и теми же именами', () => {
  const preload = read('src', 'preload', 'preload.js')
  const app = read('src', 'renderer', 'app.js')
  for (const [method, channel] of [['getTasks', 'task-list'], ['pauseTask', 'task-pause'],
    ['resumeTask', 'task-resume'], ['cancelTask', 'task-cancel'], ['restartTask', 'task-restart']]) {
    assert.match(preload, new RegExp(`${method}:\\s*[^\\n]*invoke\\('${channel}'`),
      `в мосте нет метода ${method}() на канале ${channel}`)
    // Мост, которым никто не пользуется, — красный `test-audit`: экран обязан
    // звать каждый метод, а не только быть готовым когда-нибудь позвать.
    assert.ok(app.includes(`electronAPI.${method}`), 'экран не зовёт electronAPI.' + method)
  }
  assert.match(preload, /onTaskEvent:[^\n]*'task-event'/, 'окно не подписано на состояния очереди')
  assert.match(app, /readTasks:[\s\S]{0,200}getTasks/, 'раздел не получает задачи через мост')
  assert.match(app, /runTaskAction:[\s\S]{0,260}(pauseTask|resumeTask)/, 'действия карточки очереди никуда не уходят')
  assert.match(app, /onTaskEvent\s*[\?&.]|onTaskEvent\(/, 'событий очереди экран не слушает — список стоял бы до перезапуска')
  // Мало слушать канал: событие несёт только сдвинувшиеся карточки, поэтому
  // обработчик обязан перечитать планировщик. Перерисовка прежнего снимка
  // выглядела бы живой, а карточка замерла бы до перезапуска окна.
  assert.match(app, /onTaskEvent[\s\S]{0,220}queueChanged/,
    'событие очереди не перечитывает список задач — экран показал бы прежний снимок')
  const center = read('src', 'renderer', 'task-center.js')
  assert.match(center, /function queueChanged/, 'в разделе нет обработчика события очереди')
})

check('классы карточки очереди описаны в стилях', () => {
  const css = read('src', 'renderer', 'task-center.css')
  for (const name of ['task-center-row', 'task-center-actions', 'task-center-action',
    'task-center-progress', 'task-center-progress-fill', 'task-center-error'])
    assert.ok(css.includes(`.${name}`), `класс .${name} не описан в task-center.css — карточка соберётся без вида`)
})

check('команда инструмента становится задачей очереди, не переставая исполняться runner-ом', () => {
  const main = read('src', 'main', 'main.js')
  const at = main.indexOf('async function runWorkspaceCommand')
  assert.ok(at >= 0, 'в главном процессе нет `runWorkspaceCommand` — проверять нечего')
  const body = main.slice(at, main.indexOf('\nasync function ', at + 10))
  assert.match(body, /taskManager\.add\(\{[\s\S]{0,400}handle:\s*\{/,
    'команда не присоединяется к очереди: Центру задач показать нечего')
  assert.match(body, /kill\(\)\s*\{[^}]*abort/, 'у карточки нет пути снять команду: кнопка паузы была бы декорацией')
  // Два запуска — главная опасность этого шва: исполнитель остаётся один.
  assert.equal((body.match(/commandRunner\.run\(/g) || []).length, 1,
    'в одном исполнении команды два вызова runner-а — возможен двойной запуск')
  // Якорь чужого набора (`test-run-command-stop-wiring`) вырезает исполнение по
  // обёртке вокруг `commandRunner.run` — шов обязан оставить один вызов.
  assert.match(body, /\bresult = await commandRunner\.run\(/,
    'исполнение ушло из якорной строки: чужая проверка остановки команды отвалится')
  assert.match(body, /reviewSectionsService\(\)\.beginCommand\(/, 'снимок команды для участков обзора пропал')
  assert.match(body, /queueReport\.close\(/, 'исход команды не сообщается планировщику: карточка осталась бы «в работе»')
  // Очередь не имеет права ломать инструмент: отказ принять работу не отменяет
  // исполнение.
  assert.match(body, /queued\.ok === false[\s\S]{0,160}latency\.write/,
    'отказ очереди проигнорирован молча: человек не узнает, почему карточки нет')
})

console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
