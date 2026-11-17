'use strict'

// Выход из приложения — единственный момент, когда несохранённую историю ещё
// можно дописать синхронно: после выхода фоновую запись никто не дождётся.
// Если дописать не удалось, молча выходить нельзя — человек потеряет диалоги и
// не заметит. Поэтому решение «выйти всё равно» всегда остаётся за человеком.

// ask возвращает true, когда человек согласился выйти без сохранения.
function create({ save, ask, onProblem = () => {}, quit }) {
  let leaveNow = false
  return function onBeforeQuit(event) {
    // Вторая попытка после согласия: больше не спрашиваем и не мешаем выйти.
    if (leaveNow) return
    try {
      save()
      return
    } catch (error) {
      onProblem(error)
      event.preventDefault()
      leaveNow = Boolean(ask(error))
      quit()
    }
  }
}

module.exports = { create }
