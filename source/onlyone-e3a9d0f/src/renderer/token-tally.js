/* Счёт токенов хода в окне.
 * Главный процесс сообщает о расходе дважды: `agent-progress` после каждого шага несёт НАКОПЛЕННЫЙ итог текущего
 * прогона агента, а `message-complete` в конце прогона — тот же итог ещё раз. Окно раньше записывало первое и
 * прибавляло второе — один агент на 10 000 токенов показывался как 20 000, а в команде прогресс второго агента
 * затирал расход первого. Здесь счёт по агентам: `live` — идущий прогон, `done` — законченные; итог — их сумма.
 * Состояние — обычный объект: его сохраняют вместе с живым ходом при переключении диалога. */
(function (root) {
  'use strict'

  const num = value => Math.max(0, Number(value) || 0)
  const fresh = () => ({ done: {}, live: {} })

  function total (state) {
    let sum = 0
    for (const value of Object.values(state.done)) sum += value
    for (const value of Object.values(state.live)) sum += value
    return sum
  }

  // Накопленный итог прогона. Если он меньше прежнего — начался новый прогон, а прежний кончился без
  // `message-complete` (обрыв): его расход переносится в законченные, а не теряется.
  function progress (state, agentIndex, cumulative) {
    const key = String(agentIndex ?? 0)
    const now = num(cumulative)
    const before = state.live[key] || 0
    if (now < before) state.done[key] = (state.done[key] || 0) + before
    state.live[key] = now
    return total(state)
  }

  // Конец прогона: его итог переходит в законченные, идущий прогон этого агента закрывается.
  function complete (state, agentIndex, runTotal) {
    const key = String(agentIndex ?? 0)
    const spent = Math.max(num(runTotal), state.live[key] || 0)
    delete state.live[key]
    if (spent) state.done[key] = (state.done[key] || 0) + spent
    return total(state)
  }

  const api = { fresh, progress, complete, total }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneTokenTally = api
})(typeof window !== 'undefined' ? window : globalThis)
