'use strict'

// Каналы расписаний и исполнитель (план, этап 3.5). Модуль не знает ни об
// Electron, ни о диске: планировщик, ядро и доставку в окно приносят
// параметрами — так же, как `createScheduleRunner` получает часы и таймеры.
//
// Правило, из которого вырос файл: окно видит состояние, но не содержание.
// Просьба расписания живёт в файле и уходит в чат только как ход; в список,
// в события и в снимок она не попадает — там были бы ключи, которые человек
// вставляет в текст просьбы. Окно читает её один раз — в момент хода.

const MAX_RECORDS = 50
const TURN_TIMEOUT_MS = 10 * 60 * 1000

function createScheduleIpc(options = {}) {
  const runner = options.runner
  const model = options.model
  // Куда и по каким каналам уходит — решает главный процесс: он объявляет
  // каналы, и `test-audit` сверяет их с вызовами окна по `main.js`. Модуль
  // знает только «что»: состояние пушем и просьбу — ходом.
  const push = typeof options.push === 'function' ? options.push : () => false
  const turn = typeof options.turn === 'function' ? options.turn : () => false
  // Слова о следующем запуске показывает человек, поэтому их переводит главный
  // процесс (`ui-text.cjs`): без переводчика остаётся исходный русский.
  const say = typeof options.say === 'function' ? options.say : (template, ...args) => {
    let next = 0
    return String(template).replace(/%s/g, () => (next < args.length ? String(args[next++]) : '%s'))
  }
  const log = typeof options.log === 'function' ? options.log : () => {}
  // Зачистка одна на весь главный процесс (`redactSecrets`): просьба уходит в
  // форму правки текстом, и текст этот человек мог написать с ключом внутри.
  const redact = typeof options.redact === 'function' ? options.redact : (text => String(text == null ? '' : text))
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout
  const now = typeof options.now === 'function' ? options.now : Date.now
  const timeoutMs = Number(options.turnTimeoutMs) || TURN_TIMEOUT_MS

  // Ход отдан окну и ждёт итога. Без этого обещание планировщика висело бы
  // вечно, а расписание — считаться занятым до перезапуска.
  const waiting = new Map()

  function pushEvent(body) {
    const { prompt, action, history, ...safe } = body || {}
    return push({ type: 'schedule-event', at: now(), ...safe })
  }

  function settleTurn(runId, ok, error) {
    const waiter = waiting.get(String(runId || ''))
    if (!waiter) return false
    waiting.delete(String(runId))
    clearTimer(waiter.timer)
    waiter.resolve({ ok: Boolean(ok), runId: String(runId), ...(ok ? {} : { error: String(error || 'ход расписания не удался') }) })
    return true
  }

  function fail(runId, error) {
    return Promise.resolve({ ok: false, runId, error })
  }

  function execute(record, scheduledAt, meta = {}) {
    const runId = String(meta.runId || `${record?.id}-${scheduledAt}`)
    const action = (record && record.action) || {}
    if (action.type === 'note') return Promise.resolve({ ok: true, runId, note: true })
    if (action.type !== 'agent-turn') return fail(runId, 'этот вид действия ещё не подключён')
    // Просьба уходит окну, а не главному процессу: ход в чат живёт там же, где
    // ход человека, — те же инструменты, та же история, тот же тестовый
    // провайдер в прогоне. Платного вызова отсюда не бывает.
    const sent = turn({
      runId, id: record.id, name: String(record.name || record.id || ''),
      chatId: action.chatId || null, scheduledAt, manual: Boolean(meta.manual)
    })
    if (!sent) return fail(runId, 'окно закрыто — ход расписания некому отдать')
    return new Promise(resolve => {
      const timer = setTimer(() => {
        waiting.delete(runId)
        resolve({ ok: false, runId, error: 'окно не ответило за время ожидания хода' })
      }, timeoutMs)
      waiting.set(runId, { resolve, timer })
    })
  }

  function nextWords() {
    const at = now()
    const map = {}
    for (const view of runner.snapshot().records) {
      // Ядро считает слово о следующем запуске по полному тексту записи: вьюха
      // для него невалидна, и человек увидел бы «расписание настроено неверно»
      // там, где всё в порядке. Переводчик — тот, что у главного процесса:
      // экран показывает эти слова человеку, и на английском окне они обязаны
      // быть английскими.
      const full = runner.record ? runner.record(view.id) : null
      map[view.id] = model.describeNext(full || view, at, say)
    }
    return map
  }

  // Тела каналов живут здесь, а навешивает их главный процесс: `test-audit`
  // сверяет вызовы окна с обработчиками по `main.js`, как и в очереди задач 3.4.
  const channels = {
    'get-schedules': async () => {
      const state = runner.snapshot()
      return { ok: true, ...state, nextText: nextWords() }
    },

    'set-schedule': async (_event, record) => {
      const validation = model.validateSchedule(record)
      if (!validation.ok) return { ok: false, errors: validation.errors }
      const known = runner.snapshot().records.some(item => item.id === record.id)
      if (!known && runner.snapshot().records.length >= MAX_RECORDS) {
        return { ok: false, error: `расписаний уже ${MAX_RECORDS} — удалите лишнее` }
      }
      const added = runner.add(record)
      if (!added.ok) return added
      return { ok: true, record: runner.snapshot().records.find(item => item.id === record.id) || null }
    },

    'delete-schedule': async (_event, id) => ({ ok: runner.remove(id) }),

    'set-schedule-enabled': async (_event, payload) => {
      const id = payload && payload.id
      const enabled = !(payload && payload.enabled === false)
      const view = enabled ? runner.resume(id) : runner.pause(id)
      return { ok: Boolean(view), enabled, record: view }
    },

    // «Выполнить сейчас» не ждёт окончания хода: он может идти минуты. Окно
    // получает ответ о принятии, а итог придёт событием по тому же runId.
    'run-schedule-now': async (_event, id) => {
      const record = runner.snapshot().records.find(item => item.id === id)
      if (!record) return { ok: false, error: 'расписания нет' }
      if (record.running) return { ok: false, error: 'прошлый ход ещё не закончился' }
      const job = runner.runNow(id)
      // Ответ не ждёт хода: он может идти минуты. `runId` — тот, под которым
      // планировщик уже ведёт этот запуск; по нему окно сопоставит итог.
      const runId = runner.runningOf ? runner.runningOf(id) : (job && job.runId ? job.runId : null)
      Promise.resolve(job).catch(error => log(`ход расписания ${id} оборвался: ${String((error && error.message) || error)}`))
      return { ok: true, runId: runId || null }
    },

    // Текст просьбы живёт в файле и нужен ровно двум местам — форме правки и
    // окну в момент хода. В список, в события и в снимок он не попадает.
    'get-schedule-prompt': async (_event, id) => {
      const record = runner.record ? runner.record(id) : null
      if (!record || !record.action) return { ok: false, error: 'расписания нет' }
      return { ok: true, id, prompt: redact(String(record.action.prompt || '')) }
    }
  }

  // Итог хода от окна. Канал односторонний (`send`, не `invoke`): ответ ждать
  // некому, ждёт планировщик через `settleTurn`.
  function onTurnResult(_event, body) {
    settleTurn(body && body.runId, body && body.ok !== false, body && body.error)
  }

  function start() {
    runner.start()
    return true
  }

  function stop() {
    for (const runId of [...waiting.keys()]) settleTurn(runId, false, 'расписание остановлено')
    runner.stop()
  }

  return { channels, onTurnResult, start, stop, execute, pushEvent, settleTurn }
}

module.exports = { createScheduleIpc, MAX_RECORDS }
