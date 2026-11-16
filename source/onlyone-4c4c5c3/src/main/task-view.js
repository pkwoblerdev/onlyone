'use strict'

// Прослойка Центра задач между планировщиком и окном (план, этап 3.4). Здесь
// только форма: карточка планировщика превращается в то, что экран имеет право
// показать, и наоборот — намерение экрана становится вызовом планировщику.
//
// Почему это не в `task-manager.js`: планировщик знает очередь и процессы, а
// про каналы и про то, что видит человек, он знать не должен. И почему не в
// `main.js`: главный процесс обязан оставаться сборкой проводов, а матрицу
// разрешённых действий somebody должен видеть одним взглядом, с проверкой.
//
// Три правила.
//   1. Командная строка задачи в интерфейс не едет: в ней человек роняет токен,
//      а экрану довольно заголовка, срока и итога.
//   2. Кнопка там, где действие не отказывает: `canPause`/`canResume`/
//      `canCancel`/`canRestart` считаются из состояния.
//   3. Тексты зачищаются той же формой, что в остальном приложении
//      (`redactSecrets`) — заголовок и вывод процесса пишет не только человек.

const PAUSABLE = new Set(['queued', 'running'])
const RESUMABLE = new Set(['paused', 'interrupted'])
const CANCELLABLE = new Set(['queued', 'running', 'paused', 'interrupted'])
const RESTARTABLE = new Set(['done', 'error', 'paused', 'interrupted'])
const PRIORITIES = ['high', 'normal', 'low']
// Консоль панели «Задачи» показывает вывод процесса целиком — столько же строк, сколько хранит планировщик
const LOG_LIMIT = 200
const TEXT_LIMIT = 400

function createTaskView(options = {}) {
  const manager = options.manager
  const scrub = typeof options.scrub === 'function'
    ? text => String(options.scrub(text == null ? '' : String(text)) || '')
    : text => String(text == null ? '' : text)
  const now = typeof options.now === 'function' ? options.now : Date.now

  function text(value, limit = TEXT_LIMIT) {
    return scrub(value).slice(0, limit)
  }

  function progressOf(task) {
    const raw = Number(task.progress)
    if (task.progress === null || task.progress === undefined || task.progress === '' || !Number.isFinite(raw)) return null
    return Math.min(1, Math.max(0, raw))
  }

  function viewOf(task) {
    if (!task || typeof task !== 'object') return null
    const state = String(task.state || 'queued')
    return {
      id: String(task.id || ''),
      title: text(task.title),
      kind: String(task.kind || 'shell'),
      chatId: task.chatId ? String(task.chatId) : null,
      priority: PRIORITIES.includes(task.priority) ? task.priority : 'normal',
      state,
      progress: progressOf(task),
      startedAt: Number.isFinite(task.startedAt) ? task.startedAt : null,
      finishedAt: Number.isFinite(task.finishedAt) ? task.finishedAt : null,
      error: text(task.error),
      attempts: Number(task.attempts) || 0,
      log: (Array.isArray(task.log) ? task.log : []).slice(-LOG_LIMIT).map(line => text(line)),
      canPause: PAUSABLE.has(state),
      // Присоединённую работу (план, 3.4б) поднял производитель: снять её
      // можно, а вернуть в исполнение — нет, процесса больше никто не держит.
      // Кнопка, которая всегда отказывает, хуже отсутствующей.
      canResume: RESUMABLE.has(state) && !task.attached,
      canCancel: CANCELLABLE.has(state),
      canRestart: RESTARTABLE.has(state) && !task.attached
    }
  }

  function list() {
    const tasks = (Array.isArray(manager.list()) ? manager.list() : []).map(viewOf).filter(Boolean)
    return { ok: true, tasks, at: now() }
  }

  // Экран шлёт намерение словами, а не именем метода планировщика: имена кнопок
  // и имена функций не обязаны совпадать.
  function action(name, body) {
    const id = body && typeof body === 'object' ? String(body.id || '') : ''
    if (!id) return Promise.resolve({ ok: false, error: 'нужен id задачи' })
    const call = { pause: 'pause', resume: 'resume', cancel: 'cancel', restart: 'restart', remove: 'remove' }[String(name || '')]
    if (!call || typeof manager[call] !== 'function') return Promise.resolve({ ok: false, error: 'такого действия нет' })
    // Вызов обёрнут в обещание: планировщик может бросить и синхронно (нет
    // процесса, окно закрыто), а наружу из канала отказ уходить не должен.
    return Promise.resolve()
      .then(() => manager[call](id))
      .then(answer => {
        if (answer === undefined || answer === null || answer === true) return { ok: true }
        if (answer === false) return { ok: false, error: 'планировщик отказал' }
        return typeof answer === 'object' ? answer : { ok: true }
      })
      .catch(error => ({ ok: false, error: String((error && error.message) || error) }))
  }

  // Тело события окна: те же вьюхи, без командной строки и без лишнего.
  function eventBody(payload) {
    const tasks = (Array.isArray(payload && payload.tasks) ? payload.tasks : []).map(viewOf).filter(Boolean)
    return { type: 'task-state', at: (payload && payload.at) || now(), tasks }
  }

  return { viewOf, list, action, eventBody }
}

module.exports = { createTaskView, PAUSABLE, RESUMABLE, CANCELLABLE, RESTARTABLE }
