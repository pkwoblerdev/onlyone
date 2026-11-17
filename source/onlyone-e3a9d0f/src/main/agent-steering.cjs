'use strict'

// Указания пользователя во время хода. Ключ — requestId; в командном ходе его делят ведущий и помощники,
// поэтому очередь считает, сколько агентов её держат, и исчезает вместе с последним.
function createSteering() {
  const boxes = new Map() // requestId -> { items: [{ text, force }], holders: number }
  const steps = new Map() // requestId -> Set<AbortController> шагов, идущих сейчас

  function open(requestId) {
    if (!requestId) return
    const box = boxes.get(requestId)
    if (box) box.holders++
    else boxes.set(requestId, { items: [], holders: 1 })
  }

  function close(requestId) {
    const box = boxes.get(requestId)
    if (!box) return
    if (--box.holders <= 0) {
      boxes.delete(requestId)
      steps.delete(requestId)
    }
  }

  function post({ requestId, text, force } = {}) {
    const box = requestId && boxes.get(requestId)
    const clean = String(text || '').trim()
    if (!box || !clean) return false
    box.items.push({ text: clean, force: Boolean(force) })
    if (force) for (const ctrl of steps.get(requestId) || []) ctrl.abort('forced_by_user')
    return true
  }

  function drain(requestId) {
    const box = boxes.get(requestId)
    return box ? box.items.splice(0) : []
  }

  // Возвращает функцию, которой шаг снимает себя; повторный вызов безвреден.
  function beginStep(requestId, controller) {
    if (!requestId) return () => {}
    let set = steps.get(requestId)
    if (!set) steps.set(requestId, set = new Set())
    set.add(controller)
    return () => { set.delete(controller) }
  }

  return { open, close, post, drain, beginStep }
}

module.exports = { createSteering }
