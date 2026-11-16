// Н79 в настоящем окне: ряд кнопок артефакта принадлежит открытому диалогу.
//
// Три режима одним файлом (посев диалогов, фоновое событие, рост ряда):
//  - 'setup' — записывает в историю два диалога с фиксированными id (открытый и
//    фоновый) штатным путём окна: setConversations + __reloadChats + сохранение
//    через __joinProject, тем же приёмом, что сосед `run-task-center-ui.cjs`.
//  - 'bg' — артефакт правится в ФОНОВОМ диалоге; ряд открытого обязан остаться
//    прежним. Это красное звено Н79 (событие подменяет ряд под чат события).
//  - 'open' — артефакт появляется в ОТКРЫТОМ диалоге (его записывает на диск
//    прогон-водитель, пока окно открыто); ряд обязан вырасти. Обратная сторона
//    запрета: «не подменять» не означает «никогда не обновлять».
//
// Кадр снимается окном по завершении прогона, поэтому запуск заканчивается ровно
// тем состоянием, которое проверяет: после фонового события / после роста ряда.
(async () => {
  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms = 12000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch { /* состояние ещё не собрано */ }
      await wait(60)
    }
    return false
  }

  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })

  const OPEN_ID = arg.openId
  const BG_ID = arg.bgId
  if (!OPEN_ID || !BG_ID) return { ok: false, checks: [{ name: 'прогон не получил id диалогов', pass: false }] }

  const chipIds = () => [...document.querySelectorAll('#artifactChips .artifact-chip')].map(chip => chip.dataset.id || '')
  const chipTitles = () => [...document.querySelectorAll('#artifactChips .artifact-chip')].map(chip => chip.textContent.trim())

  if (!await until(() => $('artifactChips') && window.electronAPI)) {
    return { ok: false, checks: [{ name: 'интерфейс загрузился', pass: false }] }
  }

  // --- посев: два диалога, оба с ходом, иначе пустой сотрёт dropEmptyChats ----
  if (arg.mode === 'setup') {
    const now = Date.now()
    const chats = [
      {
        id: OPEN_ID, title: 'Открытый диалог прогона', projectId: null,
        createdAt: now - 60000, updatedAt: now - 20000,
        messages: [
          { role: 'user', content: 'Заведя ряд артефактов', timestamp: now - 60000 },
          { role: 'assistant', content: 'Ряд заведён.', timestamp: now - 55000 }
        ]
      },
      {
        id: BG_ID, title: 'Фоновый диалог прогона', projectId: null,
        createdAt: now - 50000, updatedAt: now - 30000,
        messages: [
          { role: 'user', content: 'Работай в фоне', timestamp: now - 50000 },
          { role: 'assistant', content: 'Работаю.', timestamp: now - 45000 }
        ]
      }
    ]
    let saved = null
    try { saved = await window.electronAPI.setConversations(chats) } catch (error) { saved = { ok: false, error: String(error) } }
    note('диалоги записаны в историю', saved?.ok === true, JSON.stringify(saved || {}).slice(0, 120))
    // Окно при выходе пишет свой список, а не тот, что лег на диск руками:
    // без перечитывания и штатного сохранения посев между запусками пропал бы.
    let reloaded = -1
    try { reloaded = await window.__reloadChats() } catch (error) { note('история перечитана', false, String(error)) }
    note('история перечитана: посев плюс чат старта', reloaded >= 3, `диалогов: ${reloaded}`)
    try { window.__joinProject?.(null) } catch (error) { note('сохранение окна не вызвано', false, String(error)) }
    await wait(1500)
    let stored = []
    try { stored = await window.electronAPI.getConversations() || [] } catch { /* ниже заметит */ }
    const ids = (stored || []).map(chat => chat.id)
    note('посев пережил выход окна: оба id в списке', ids.includes(OPEN_ID) && ids.includes(BG_ID), ids.join(','))
    return { ok: checks.every(item => item.pass), checks }
  }

  // --- прогоны проверок --------------------------------------------------------

  // Открытый диалог выбирается штатным путём окна — кликом по строке истории:
  // порядок списка окно пересобирает по свежести, и «первый в списке» между
  // запусками не постоянен (замер: в одном прогоне стартовал с открытым
  // «n79-bg-chip»). Ряд обязан перестроиться под клик: это и есть правильный
  // путь `selectChat → refreshArtifactChips(чат окна)`.
  const rowIds = () => [...document.querySelectorAll('#chatHistoryList [data-chat-id]')].map(row => row.dataset.chatId)
  note('в списке два диалога прогона', await until(
    () => rowIds().includes(OPEN_ID) && rowIds().includes(BG_ID), 15000), rowIds().join(','))

  const openRow = () => document.querySelector(`#chatHistoryList [data-chat-id="${OPEN_ID}"] .history-item-title`)
  let openedRight = false
  for (let attempt = 0; attempt < 8 && !openedRight; attempt++) {
    openRow()?.click()
    openedRight = await until(() => $('messagesList')?.dataset?.chatId === OPEN_ID, 4000)
    if (!openedRight) await wait(250)
  }
  note('открыт диалог прогона (клик по строке истории)', openedRight,
    `открыт «${$('messagesList')?.dataset?.chatId || '?'}»`)

  // Ряд открытого диалога наполняется выбором чата (selectChat →
  // refreshArtifactChips): подсечённые на диске артефакты открытого видны.
  const baseFilled = await until(() => (arg.ids || []).every(id => chipIds().includes(id)), 20000)
  note('ряд открытого диалога наполнен его артефактами', baseFilled, `кнопки: ${chipTitles().join(' | ')}`)
  if (!baseFilled) return { ok: false, checks }

  if (arg.mode === 'bg') {
    const before = chipIds()
    // Правка в ФОНОВОМ диалоге: событие приходит с chatId фонового — ряд
    // открытого обязан остаться прежним.
    let res = null
    try { res = await window.electronAPI.saveArtifactVersion({ id: arg.b1, content: 'фон: версия прогона' }) } catch (error) { res = { ok: false, error: String(error) } }
    note('правка фонового артефакта сохранена', res?.ok === true, JSON.stringify(res || {}).slice(0, 120))
    // Событие идёт каналом; даём ему дойти и «устояться»: при дефекте ряд
    // подменяется сразу, ждать «признака прихода» в исправленном коде нечего.
    await wait(3000)
    const after = chipIds()
    note('Н79: фоновое событие не добавило в ряд чужую кнопку', !after.includes(arg.b1),
      `после события: ${chipTitles().join(' | ')}`)
    note('Н79: ряд открытого диалога не перестроился под фоновый',
      after.length === before.length && [...before].sort().join(',') === [...after].sort().join(','),
      `было ${before.join(',')} → стало ${after.join(',')}`)
    return { ok: checks.every(item => item.pass), checks }
  }

  if (arg.mode === 'open') {
    // Событие по ОТКРЫТОМУ диалогу обязан перечитывать ряд. Новый артефакт
    // открытого чата ложит на диск прогон-водитель, пока окно открыто; до
    // появления кнопки ряд проверяется повторными событиями по своему же чату —
    // тем путём, каким обновляют его сообщения пользователя.
    let grew = false
    const beforeCount = chipIds().length
    const started = Date.now()
    let attempt = 0
    while (!grew && Date.now() - started < 40000) {
      attempt++
      try { await window.electronAPI.saveArtifactVersion({ id: arg.ids[0], content: 'открытый: перечитывание ряда ' + attempt }) } catch { /* диск терпит */ }
      grew = await until(() => chipTitles().includes('Сводка прогона'), 1000)
      if (!grew) await wait(600)
    }
    note('Н79: событие открытого диалога перечитывает ряд — кнопка нового артефакта появилась',
      grew, `кнопок было ${beforeCount}, стало ${chipIds().length}, попыток ${attempt}`)
    note('Н79: фоновая кнопка в ряд открытого так и не приехала', !chipIds().includes(arg.b1),
      chipTitles().join(' | '))
    return { ok: checks.every(item => item.pass), checks }
  }

  return { ok: false, checks: [{ name: 'неизвестный режим прогона: ' + arg.mode, pass: false }] }
})()
