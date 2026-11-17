'use strict'

// Защита от зацикливания, написанная кодом.
//
// Правило «неудавшийся вызов не повторяй» живёт в промпте давно, и слабые модели его не держат: ход крутится на одном и
// том же вызове с тем же результатом, пока не упрётся в предел шагов, а на бесплатных моделях лимит считается в запросах.
// У opencode для этого есть doom_loop: три одинаковых вызова подряд — и агента останавливают. Здесь то же, но мягче:
// третий и четвёртый повтор не исполняются, а возвращают модели короткое объяснение, пятый останавливает ход.
//
// Повтором считается вызов с теми же аргументами И тем же результатом: файл, перечитанный после правки, или тест,
// прогнанный после исправления, дают другой результат и счёт сбрасывают. Любой другой вызов между повторами — тоже.

const crypto = require('node:crypto')

// Инструменты хода, которые повторяют законно: чек-лист и доска меняются «тем же» вызовом, вопрос человеку ждёт ответа.
const EXEMPT = new Set(['task_plan', 'board_update', 'board_read', 'agent_message', 'ask_user', 'ask_decision', 'assign_work',
  'watch_page', 'stop_watching'])

// В результате команды лежит время выполнения: оно разное от запуска к запуску и прятало бы настоящий повтор.
const NOISE_KEY = /(^|_)(ms|time|duration|elapsed|took|at|timestamp)$|Ms$|Time$/

function stable (value, seen = new Set()) {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '"[Circular]"'
    seen.add(value)
    if (Array.isArray(value)) return '[' + value.map(v => stable(v, seen)).join(',') + ']'
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key], seen)).join(',') + '}'
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  return JSON.stringify(value === undefined ? null : value)
}

function digest (result) {
  try {
    const text = JSON.stringify(result, (key, value) => {
      if (typeof value === 'bigint') return value.toString()
      return (key && NOISE_KEY.test(key) ? undefined : value)
    }) || ''
    return crypto.createHash('md5').update(text).digest('hex')
  } catch {
    return crypto.createHash('md5').update(stable(result)).digest('hex')
  }
}

function createLoopGuard ({ warnAt = 3, stopAt = 5 } = {}) {
  let state = { key: '', digest: '', count: 0 }

  return {
    // До вызова: пускать, возражать или останавливать ход. Заблокированный вызов не исполняется, но в счёт идёт.
    check (name, args) {
      if (EXEMPT.has(name)) return { action: 'run' }
      const key = name + ' ' + stable(args || {})
      if (state.key !== key || state.count < warnAt - 1) return { action: 'run' }
      state.count++
      const times = state.count
      if (times >= stopAt) {
        return {
          action: 'stop',
          times,
          message: `Этот вызов (${name}) повторился ${times} раз подряд с тем же результатом.`
        }
      }
      return {
        action: 'block',
        times,
        message: `Этот вызов уже выполнен ${times - 1} раза подряд с тем же результатом — повторять его бесполезно, он не выполнен. ` +
          'Смени подход: другой инструмент или другие аргументы, либо назови человеку, что мешает.'
      }
    },

    // После исполненного вызова.
    record (name, args, result) {
      if (EXEMPT.has(name)) return
      const key = name + ' ' + stable(args || {})
      const hash = digest(result)
      if (state.key === key && state.digest === hash) state.count++
      else state = { key, digest: hash, count: 1 }
    }
  }
}

module.exports = { createLoopGuard }
