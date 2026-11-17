'use strict'

// Планировщик фоновых задач (план, этап 3.4 «Центр задач»). Очередь, предел
// одновременных, приоритеты, состояния и журнал — в главном процессе; окно
// получает только карточки и умеет ими управлять.
//
// Три правила, из которых вырос модуль.
//
// 1. Список переживает перезапуск, но НЕ переживает его удвоенным. Дорогое
//    («running») на диск ложится до ответа процесса: процесс, убитый вместе с
//    приложением, оставляет задачу «прерванной», а не «в работе», и сама она не
//    стартует — это решает человек.
// 2. Слот берётся один раз. Ответ процесса (двойной `close`, `error` следом за
//    `exit`) обрабатывается ровно один раз, иначе освободившийся слот
//    достаётся двум задачам.
// 3. В окно и на диск уходит зачищенное. `redactSecrets` — та же форма, что у
//    контрольных точек: в заголовок и в вывод процесса человек вставляет токены.
//
// Ни Electron, ни сети внутри: часы, таймеры, `spawn` и канал в окно приходят
// параметрами — иначе «падение дочернего процесса» пришлось бы проверять
// настоящим процессом.

const { tr } = require('./ui-text.cjs')
const { redactSecrets } = require('./run-checkpoints')

const PRIORITIES = ['high', 'normal', 'low']
const STATES = ['queued', 'running', 'paused', 'error', 'done', 'interrupted']
const DEFAULT_MAX_PARALLEL = 3
const DEFAULT_QUEUE_LIMIT = 100
const DEFAULT_HEARTBEAT_MS = 250
const LOG_LIMIT = 200
const TEXT_LIMIT = 400

function createTaskManager(options = {}) {
  const store = options.store
  const now = typeof options.now === 'function' ? options.now : Date.now
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout
  const spawn = typeof options.spawn === 'function' ? options.spawn : require('child_process').spawn
  const send = typeof options.send === 'function' ? options.send : () => false
  const maxParallel = Math.max(1, Number(options.maxParallel) || DEFAULT_MAX_PARALLEL)
  const queueLimit = Math.max(1, Number(options.queueLimit) || DEFAULT_QUEUE_LIMIT)
  const heartbeatMs = Math.max(1, Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS)

  let tasks = []
  const processes = new Map()
  // Отложенный запуск (консоль панели «Задачи»): производитель отдаёт функцию, которая поднимет процесс,
  // когда очередь даст место. Функция живёт только в памяти — на диск уходит карточка без неё
  const launchers = new Map()
  const waiters = new Set()
  let heartbeat = null
  let dirty = false
  let changed = new Set()
  let started = false
  let seq = 0

  const clean = text => String(redactSecrets(text == null ? '' : String(text)) || '').slice(0, TEXT_LIMIT)
  const rank = priority => {
    const at = PRIORITIES.indexOf(priority)
    return at < 0 ? 1 : at
  }
  const find = id => tasks.find(card => card && card.id === id) || null
  const card = task => ({ ...task, log: Array.isArray(task.log) ? task.log.slice() : [] })
  const list = () => tasks.map(card)

  function messageOf(error) {
    return clean((error && error.message) || error || 'процесс не ответил')
  }

  function note(card, line) {
    const text = clean(line)
    if (!text.trim()) return
    card.log = [...(Array.isArray(card.log) ? card.log : []), text].slice(-LOG_LIMIT)
    touch(card)
  }

  function touch(task) {
    dirty = true
    if (task && task.id) changed.add(task.id)
  }

  // Что перешло в новое состояние — то записано: «переживает перезапуск»
  // означает диск после перехода, а не после ближайшего удара таймера. Журнал
  // строк сам по себе файл не трогает, иначе прогон процесса писал бы его на
  // каждую строку вывода.
  function persist() {
    if (!store || typeof store.save !== 'function') return
    try {
      store.save(tasks.map(one => ({ ...one, title: clean(one.title), error: clean(one.error) })))
    } catch { /* диск есть диск: следующая удачная запись догонит */ }
  }

  // Окно и диск видят изменения раз в `heartbeatMs`, но ПОСЛЕДНЕЕ состояние
  // обязано доехать: карточка не имеет права замереть на полуслове.
  function beat() {
    heartbeat = null
    if (!started) return
    if (dirty) {
      const ids = changed
      dirty = false
      changed = new Set()
      const snapshot = list().filter(one => ids.has(one.id))
      try {
        send({ type: 'task-state', at: now(), tasks: snapshot.length ? snapshot : list() })
      } catch { /* окно закрыто — планировщик от этого не встаёт */ }
      if (store && typeof store.save === 'function') {
        try { store.save(tasks.map(one => ({ ...one, title: clean(one.title), error: clean(one.error) }))) } catch { /* диск есть диск */ }
      }
    }
    heartbeat = setTimer(beat, heartbeatMs)
  }

  function settleProcess(card, child) {
    if (processes.get(card.id) !== child) return null
    processes.delete(card.id)
    if (heartbeat === null && started) heartbeat = setTimer(beat, heartbeatMs)
    return child
  }

  function finishProcess(card, child, code) {
    const mine = settleProcess(card, child)
    if (!mine) return
    if (card.state !== 'running') return
    if (code === 0) {
      card.state = 'done'
      card.error = ''
      card.finishedAt = now()
      card.progress = null
    } else {
      card.state = 'error'
      card.error = `процесс завершился с кодом ${code}`
      card.finishedAt = now()
      note(card, `завершён с кодом ${code}`)
    }
    touch(card)
    persist()
    tickSchedule()
    releaseWaiters()
  }

  function failProcess(card, child, reason) {
    // A synchronous launch failure has no registered child to settle.
    if (child) {
      const mine = settleProcess(card, child)
      if (!mine) return
    }
    card.state = 'error'
    card.error = reason || 'процесс не поднялся'
    card.finishedAt = now()
    note(card, `ошибка процесса: ${card.error}`)
    touch(card)
    persist()
    tickSchedule()
    releaseWaiters()
  }

  function stopProcess(task, state) {
    const child = processes.get(task.id)
    if (child) {
      processes.delete(task.id)
      try { child.kill() } catch { /* процесс уже умер сам */ }
    }
    task.state = state
    task.finishedAt = now()
    touch(task)
    persist()
  }

  function launch(task, handle) {
    task.attempts = Number(task.attempts || 0) + 1
    task.state = 'running'
    task.startedAt = now()
    task.finishedAt = null
    task.error = ''
    task.progress = null
    note(task, `попытка №${task.attempts}`)
    const command = Array.isArray(task.command) ? task.command[0] : task.command
    const args = Array.isArray(task.command) ? task.command.slice(1) : (Array.isArray(task.args) ? task.args : [])
    let child = handle
    if (!child && launchers.has(task.id)) {
      try { child = launchers.get(task.id)() } catch (error) { failProcess(task, null, messageOf(error)); return }
    }
    if (!child) {
      try {
        child = spawn(command == null ? '' : String(command), args, { cwd: task.cwd || undefined, windowsHide: true })
      } catch (error) {
        failProcess(task, null, messageOf(error))
        return
      }
    }
    // Рукоятка производителя обязана говорить с планировщиком на том же языке,
    // что дочерний процесс: `on('close')` и `kill()`. Без этого карточка
    // осталась бы «в работе» навсегда, и человек ждал бы итога, которого нет.
    if (!child || typeof child.on !== 'function') {
      failProcess(task, null, 'процесс не был создан')
      return
    }
    processes.set(task.id, child)
    const lines = chunk => { for (const line of String(chunk).split(/\r?\n/)) note(task, line) }
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', lines)
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', lines)
    child.on('error', error => failProcess(task, child, messageOf(error)))
    child.on('close', (code, signal) => finishProcess(task, child, signal ? signal : code))
    touch(task)
    // «Взято в работу» лежит на диске до ответа процесса: это и есть тот след,
    // по которому после убийства приложения задача станет «прерванной».
    persist()
  }

  function pickNext() {
    let best = null
    for (const task of tasks) {
      if (!task || task.state !== 'queued') continue
      if (!best || rank(task.priority) < rank(best.priority)) best = task
    }
    return best
  }

  // Присоединённая работа слота не занимает: её уже исполняет кто-то другой, и
  // отбирать у него процесс планировщик не собирается. Если считать её слотом,
  // четвёртый агент совета встал бы в очередь к трём командам — ход завис бы из-за
  // экрана, который по замыслу только показывает.
  const busySlots = () => tasks.filter(one => one && one.state === 'running' && !one.attached).length

  function tickSchedule() {
    if (!started) return
    while (busySlots() < maxParallel) {
      const next = pickNext()
      if (!next) break
      launch(next)
    }
  }

  function refuse(reason) {
    return { ok: false, error: reason }
  }

  function add(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('задача должна быть объектом с заголовком')
    const title = String(input.title || '').trim()
    if (!title) return refuse('задаче нужно имя — иначе её не найти в списке')
    if (tasks.length >= queueLimit) return refuse(`очередь полна: предел ${queueLimit} задач — удалите завершённые`)
    const id = input.id == null || input.id === '' ? `task_${now().toString(36)}_${++seq}` : String(input.id)
    if (find(id)) return refuse(`задача с таким id уже есть: ${id}`)
    // Присоединение (план, 3.4б): работу поднял производитель — `run_command`,
    // расписание. Планировщик тогда не исполняет, а следит:
    // состояние, журнал, карточка в окне и кнопки. Рукоятка — минимальный
    // разговор: `on('close'|'error')` и `kill()`.
    const handle = input.handle
    if (handle !== undefined && handle !== null) {
      if (typeof handle.on !== 'function' || typeof handle.kill !== 'function') {
        return refuse('присоединяемой работе нужны on() и kill() — иначе планировщик не узнает об итоге')
      }
      if (!started) return refuse('планировщик не запущен: присоединять работу некому')
    }
    const task = {
      id,
      title: clean(title),
      kind: String(input.kind || 'shell'),
      priority: PRIORITIES.includes(input.priority) ? input.priority : 'normal',
      state: 'queued',
      progress: null,
      startedAt: null,
      finishedAt: null,
      error: '',
      attempts: 0,
      log: [],
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      chatId: input.chatId,
      scheduleId: input.scheduleId,
      attached: Boolean(handle)
    }
    if (typeof input.launch === 'function') launchers.set(id, input.launch)
    tasks.push(task)
    touch(task)
    if (handle) {
      // Исполнение уже идёт — ждать слота нельзя, и порождать второй процесс
      // тем более. `launch` сам положит «в работе» на диск.
      launch(task, handle)
      return { ok: true, id, task: card(task) }
    }
    persist()
    tickSchedule()
    return { ok: true, id, task: card(task) }
  }

  function change(id, move) {
    const task = find(typeof id === 'string' ? id : '')
    if (!task) return refuse('задачи нет в списке')
    const answer = move(task)
    persist()
    if (!started) { touch(task); return answer }
    tickSchedule()
    return answer
  }

  const pause = id => change(id, task => {
    if (task.state === 'running') stopProcess(task, 'paused')
    else if (task.state === 'queued') { task.state = 'paused'; touch(task) }
    else return refuse(`задачу в состоянии «${task.state}» на паузу не ставят`)
    return { ok: true, state: task.state }
  })

  // Присоединённую работу поднимает производитель: у планировщика нет ни её
  // процесса, ни права запускать чужую команду второй раз (подтверждение
  // человек давал тому запуску, а не этому). Поэтому возврат в исполнение —
  // отказ, а не тихий запуск вслепую.
  const notMine = task => (task.attached
    ? refuse('эту работу подняло приложение, а не очередь — вернуть её в исполнение может только тот, кто поднял') : null)

  const resume = id => change(id, task => {
    const refusal = notMine(task)
    if (refusal) return refusal
    if (task.state !== 'paused' && task.state !== 'interrupted') return refuse(`возобновлять нечего: задача в состоянии «${task.state}»`)
    task.state = 'queued'
    touch(task)
    return { ok: true, state: task.state }
  })

  const cancel = id => change(id, task => {
    if (task.state === 'done' || task.state === 'error') return refuse(`задача уже завершена («${task.state}»)`)
    stopProcess(task, 'done')
    return { ok: true, state: task.state }
  })

  const restart = id => change(id, task => {
    if (task.state === 'running' || task.state === 'queued') return refuse(tr('задача уже исполняется или ожидает запуска'))
    const refusal = notMine(task)
    if (refusal) return refusal
    task.state = 'queued'
    task.error = ''
    task.progress = null
    touch(task)
    return { ok: true, state: task.state }
  })

  function get(id) {
    const task = find(typeof id === 'string' ? id : '')
    return task ? card(task) : null
  }

  function start() {
    started = true
    let stored = []
    try {
      stored = store && typeof store.list === 'function' ? store.list() : []
    } catch { stored = [] }
    tasks = (Array.isArray(stored) ? stored : []).map(one => {
      const task = { ...one, log: Array.isArray(one.log) ? one.log : [] }
      // «running» на диске — это обещание, которое процесс не успел выполнить.
      if (task.state === 'running') { task.state = 'interrupted'; task.error = task.error || 'приложение закрылось во время работы' }
      if (task.kind === 'process' && (task.state === 'queued' || task.state === 'paused')) { task.state = 'interrupted'; task.error = task.error || 'приложение закрылось, пока процесс ждал очереди' }
      if (!PRIORITIES.includes(task.priority)) task.priority = 'normal'
      if (!STATES.includes(task.state)) task.state = 'queued'
      return task
    })
    if (heartbeat === null) heartbeat = setTimer(beat, heartbeatMs)
    tickSchedule()
    return list()
  }

  function stop() {
    started = false
    if (heartbeat !== null) { clearTimer(heartbeat); heartbeat = null }
    for (const child of processes.values()) { try { child.kill() } catch { /* уже мёртв */ } }
    processes.clear()
    for (const task of tasks) {
      if (task.state === 'running') {
        task.state = 'interrupted'
        // Причина та же, что при чтении диска: карточка без слова «почему»
        // выглядит так, будто работу сняли, а не что приложение закрылось.
        task.error = task.error || 'приложение закрылось во время работы'
      }
    }
    if (store && typeof store.save === 'function') {
      try { store.save(tasks) } catch { /* диск есть диск */ }
    }
    dirty = false
    changed.clear()
    releaseWaiters()
  }

  function releaseWaiters() {
    if (processes.size) return
    for (const resolve of [...waiters]) { waiters.delete(resolve); resolve(list()) }
  }

  function drain() {
    if (!processes.size) return Promise.resolve(list())
    return new Promise(resolve => waiters.add(resolve))
  }

  // Доля выполненного для карточки в окне: производитель (рендер ролика) сообщает её
  // сам, планировщик её не выводит. Только у работающей задачи и только числом.
  function setProgress(id, ratio) {
    const task = find(id)
    if (!task || task.state !== 'running') return false
    const value = Number(ratio)
    if (!Number.isFinite(value)) return false
    task.progress = Math.min(Math.max(value, 0), 1)
    touch(task)
    return true
  }

  // «Убрать» из консоли: только завершённое — идущий процесс сначала завершают
  function remove(id) {
    const task = find(typeof id === 'string' ? id : '')
    if (!task) return refuse('задачи нет в списке')
    if (task.state === 'running') return refuse('процесс ещё идёт — сначала завершите его')
    tasks = tasks.filter(one => one !== task)
    launchers.delete(task.id)
    dirty = true
    try { send({ type: 'task-removed', at: now(), id: task.id, tasks: list() }) } catch { /* окно закрыто */ }
    persist()
    return { ok: true }
  }

  // Вывод, который производитель отдаёт целиком в конце (команда агента): в журнал построчно
  function appendLog(id, text) {
    const task = find(typeof id === 'string' ? id : '')
    if (!task) return false
    for (const line of String(text || '').split(/\r?\n/)) note(task, line)
    return true
  }

  return { add, list, get, pause, resume, cancel, restart, start, stop, drain, setProgress, remove, appendLog }
}

module.exports = { createTaskManager, PRIORITIES, STATES, DEFAULT_MAX_PARALLEL, DEFAULT_QUEUE_LIMIT, DEFAULT_HEARTBEAT_MS }
