'use strict'

// Расписание как производитель Центра задач.
//
// Модуль делает ровно одну вещь: оборачивает исполнение расписания карточкой
// очереди. Исполнение ему приносят параметром — как `createScheduleRunner`
// получает часы, а `createScheduleIpc` — доставку в окно. Так карточка
// проверяется без Electron и без окна, а главный процесс остаётся сборкой
// проводов.
//
// Почему карточка вообще нужна у расписания. Просьба, которая приходит по
// сроку, выглядит для человека как чужое сообщение в его же чате: он не нажимал
// «отправить» и не видит, кто и когда это делает. Центр задач — то же самое
// окно, где человек уже следит за командами агентов, и та же кнопка
// снятия.
//
// Три правила, из которых вырос файл.
//   1. Работа присоединённая: слот очереди она не занимает и второй процесс не
//      порождает — планировщик только следит за состоянием.
//   2. Пауза снимает ИМЕННО тот ход, который исполнитель ведёт под этим `runId`.
//      Без этого карточка встанет «на паузе», а чат продолжит писать.
//   3. В карточку не едет ни текст просьбы, ни поля действия: в них человек
//      роняет ключ модели, а заголовок карточки попадает в журнал и в окно.

const KIND = 'schedule'
const TITLE_LIMIT = 90

function createScheduleQueue(options = {}) {
  const manager = options.manager
  const execute = typeof options.execute === 'function' ? options.execute : () => Promise.resolve({ ok: false, error: 'исполнителя расписаний не подключили' })
  const stopRun = typeof options.stopRun === 'function' ? options.stopRun : () => false
  const titleOf = typeof options.title === 'function' ? options.title : record => `Расписание: ${record && record.name ? record.name : (record && record.id) || ''}`
  const log = typeof options.log === 'function' ? options.log : () => {}

  function text(value) {
    return String(value == null ? '' : value)
  }

  // Исход хода в форму очереди: «ошибкой» считается и явный отказ, и текст
  // причины без `ok: false`, и брошенное исключение. Молчаливый успех здесь
  // хуже честного отказа: карточка сказала бы «выполнено» о ходе, которого не было.
  function outcomeOf(answer) {
    if (!answer || typeof answer !== 'object') return { ok: false, error: 'исполнитель не принёс исход' }
    const error = text(answer.error)
    if (answer.ok === false || error) return { ok: false, error: error || text(answer.message) || 'ход расписания не удался' }
    return { ok: true, error: '' }
  }

  function run(record, scheduledAt, meta = {}) {
    const runId = text(meta && meta.runId) || `${text(record && record.id)}-${text(scheduledAt)}`
    const report = {}
    let settled = false

    // Рукоятка говорит с планировщиком на языке дочернего процесса: `on()` для
    // итога и `kill()` для снятия. Планировщик регистрирует слушателей сам,
    // поэтому здесь только сохраняем то, что он принёс.
    const handle = {
      on(name, callback) {
        if (name !== 'close' && name !== 'error') return false
        report[name] = callback
        return true
      },
      // Ответ `true` значит, что просьба снять ход ушла в окно. Отказ — тоже
      // правда: окно могло закрыться, и врать про снятие планировщику нельзя.
      kill() {
        return stopRun(runId) === true
      }
    }

    function finish(outcome) {
      // Итог сообщается один раз: после паузы или после позднего отчёта окна
      // второе сообщение переписало бы состояние карточки на противоположное.
      if (settled) return
      settled = true
      if (outcome.ok) {
        if (typeof report.close === 'function') report.close(0)
        return
      }
      if (typeof report.error === 'function') report.error(new Error(outcome.error || 'ход расписания не удался'))
      else if (typeof report.close === 'function') report.close(1)
    }

    let accepted = null
    try {
      accepted = manager && typeof manager.add === 'function' ? manager.add({
        title: text(titleOf(record)).slice(0, TITLE_LIMIT),
        kind: KIND,
        // Чат называет только само расписание: без этого карточка обещала бы
        // чат, которого расписание не выбирало («в новый чат»).
        chatId: (record && record.action && record.action.chatId) || null,
        scheduleId: text(record && record.id),
        handle
      }) : null
    } catch (error) {
      accepted = { ok: false, error: text(error && error.message) || 'планировщик очереди не ответил' }
    }
    // Очередь — наблюдатель. Если она не приняла работу, расписание исполняется
    // всё равно: человек поставил срок приложению, а не очереди.
    if (!accepted || accepted.ok === false) {
      log(`очередь не приняла расписание: ${text(accepted && accepted.error) || 'неизвестная причина'}`)
    }

    let answer
    try {
      answer = execute(record, scheduledAt, { ...meta, runId })
    } catch (error) {
      const outcome = { ok: false, error: text(error && error.message) || 'исполнитель оборвался' }
      finish(outcome)
      return Promise.resolve(outcome)
    }

    return Promise.resolve(answer)
      .then(value => outcomeOf(value), error => ({ ok: false, error: text(error && error.message) || 'ход расписания оборвался' }))
      .then(outcome => {
        finish(outcome)
        return outcome
      })
  }

  return { run, KIND }
}

module.exports = { createScheduleQueue, KIND }
