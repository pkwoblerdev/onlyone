// (в странице директиву не ставим: файл исполняется как выражение)
// src/cli/turn-renderer.cjs — ОДИН ход ядра по просьбе из командной строки
// (план, 7.5). Файл исполняется внутри окна: `main.js` читает его и отдаёт
// `executeJavaScript`, когда `ONECODE_SMOKE` указывает сюда, а `ONECODE_ARG`
// несёт просьбу.
//
// Почему через мост окна, а не своей копией цикла: ход из CLI обязан быть ТЕМ
// ЖЕ ходом, что делает человек в чате, — те же права, те же инструменты, та же
// отчётность. Второй исполнитель означал бы второй набор правил.
//
// Права хода CLI выставляет ДО запуска: режим `plan` (без `--allow-write`) ядро
// знает и само отказывает пишущим инструментам — CLI не решает, что такое
// запись.

(async () => {
  const arg = (() => {
    try {
      const bin = atob('__ONECODE_ARG__')
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch (broken) { return {} }
  })()

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch (noise) { /* окно ещё строится */ }
      await wait(50)
    }
    return false
  }

  if (!await until(() => window.electronAPI && typeof window.electronAPI.sendMessage === 'function', 40000)) {
    return { ok: false, error: 'окно приложения не поднялось: моста send-message нет через 40 с' }
  }

  const requestId = `cli-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`
  const spoken = []
  const calls = []
  const subs = []
  let approvalDenied = false
  if (arg.nonInteractive) {
    subs.push(window.electronAPI.onAgentApproval(one => {
      approvalDenied = true
      window.electronAPI.resolveAgentApproval({ id: one.id, approved: false }).catch(() => {})
    }))
    subs.push(window.electronAPI.onAgentQuestion(() => {
      window.electronAPI.abortMessage(requestId).catch(() => {})
    }))
  }
  if (typeof window.electronAPI.onAgentEvent === 'function') {
    subs.push(window.electronAPI.onAgentEvent(one => spoken.push(String(one && one.message || ''))))
  }
  // История вызовов — единственный наружный знак отказа по правам: ядро ставит
  // `denied` на результате инструмента (`planModeRefusal`), а в ответе хода
  // этого поля нет. Без строки вызовов CLI судил бы о правах по формулировке
  // модели — то есть терял бы код 3, стоит модели про отказ промолчать.
  if (typeof window.electronAPI.onAgentToolLog === 'function') {
    subs.push(window.electronAPI.onAgentToolLog(one => calls.push({
      tool: String((one && one.tool) || ''),
      ok: Boolean(one && one.ok),
      pending: Boolean(one && one.pending)
    })))
  }

  let response = null
  let failure = ''
  try {
    response = await window.electronAPI.sendMessage({
      requestId,
      chatId: arg.chatId || 'cli',
      // `collaborative` здесь нет НАМЕРЕННО: этот флаг значит «человек прямо
      // попросил команду», и с ним ядро раздаёт работу помощникам. Обычное
      // сообщение чата его не ставит (src/renderer/app.js:3866) — ход из CLI
      // обязан выглядеть для ядра так же, иначе CLI проверяет не тот путь.
      messages: [{ role: 'user', content: String(arg.request || '') }]
    })
  } catch (error) {
    failure = String((error && error.message) || error)
  }
  for (const off of subs) {
    if (typeof off === 'function') { try { off() } catch (gone) { /* подписка уже снята окном */ } }
  }

  const text = String((response && response.content) || '')
  const spokenError = String(response && response.error || '') || failure
    // Если ответ ядро не принесло, причина остаётся в событиях хода: там она
    // названа человеку («работа ведущего не состоялась — …»).
    || spoken.find(message => /не состоялась|ошибк|отклон|\b4\d\d\b|\b5\d\d\b/.test(message)) || ''
  return {
    ok: failure ? false : Boolean(response && response.ok !== false),
    denied: approvalDenied,
    content: text,
    aborted: Boolean(response && response.aborted),
    tools: calls,
    error: spokenError
  }
})()
