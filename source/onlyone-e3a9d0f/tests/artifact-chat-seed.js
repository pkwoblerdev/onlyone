// Посев диалога прогона: штатным путём окна заводит в истории диалог, под
// который прогоны `run-artifacts-ui.cjs` и `run-artifact-gallery-ui.cjs`
// подсечили артефакты на диск, и открывает его кликом по строке истории.
//
// Зачем это нужно: ряд кнопок артефакта принадлежит открытому диалогу (Н79), а
// подъём окна открывает свой, свежий. Артефакты при этом лежат под чужим id, и
// ряд открытого диалога пуст — проверки состояний панели краснеют на «ряд
// артефактов наполнен» по причине, к состояниям не относящейся.
//
// Пишется каналом окна, а не файлом в профиле: историю главный процесс держит
// зашифрованной, и запись мимо канала разошлась бы со списком, который окно
// сохраняет само (тот же приём, что у `artifact-chips-renderer.js`).
//
// Сам этот прогон ничего про панель не проверяет — только что диалог открыт и
// ряд под него наполнился: это предпосылка соседних прогонов, а не их смысл.
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

  const CHAT_ID = arg.chatId
  if (!CHAT_ID) return { ok: false, checks: [{ name: 'прогон не получил id диалога', pass: false }] }
  if (!await until(() => $('artifactChips') && window.electronAPI)) {
    return { ok: false, checks: [{ name: 'интерфейс загрузился', pass: false }] }
  }

  const rowIds = () => [...document.querySelectorAll('#chatHistoryList [data-chat-id]')].map(row => row.dataset.chatId)
  const chipIds = () => [...document.querySelectorAll('#artifactChips .artifact-chip')].map(chip => chip.dataset.id || '')

  // Пустой диалог окно стирает при первом же выборе (dropEmptyChats), поэтому в
  // историю кладётся ход с сообщением.
  const now = Date.now()
  const seedChat = () => ({
    id: CHAT_ID, title: 'Диалог прогона артефактов', projectId: null,
    createdAt: now - 60000, updatedAt: now - 20000,
    messages: [
      { role: 'user', content: 'Покажи артефакты', timestamp: now - 60000 },
      { role: 'assistant', content: 'Вот артефакты.', timestamp: now - 55000 }
    ]
  })

  // Список пишется целиком: прочие диалоги с ходом остаются на месте. Посев
  // повторяется, потому что история пишется с дебаунсом и собственная запись
  // старта (createNewChat) могла лечь поверх посева и стереть его.
  let seeded = false
  for (let attempt = 0; attempt < 3 && !seeded; attempt++) {
    let stored = []
    try { stored = await window.electronAPI.getConversations() || [] } catch { stored = [] }
    const others = stored.filter(item => item.id !== CHAT_ID && (item.messages || []).length)
    try { await window.electronAPI.setConversations([seedChat(), ...others]) } catch { /* перечитывание ниже */ }
    try { await window.__reloadChats() } catch { /* список останется прежним */ }
    seeded = await until(() => rowIds().includes(CHAT_ID), 6000)
    if (!seeded) await wait(600)
  }
  note('диалог прогона в списке истории', seeded, rowIds().join(','))
  if (!seeded) return { ok: false, checks }

  // Открытие — кликом по строке истории: он и перестраивает ряд
  // (selectChat → refreshArtifactChips). Клик повторяется: «первый в списке»
  // между прогонами не постоянен, а без открытого диалога ряда нет.
  let opened = false
  for (let attempt = 0; attempt < 8 && !opened; attempt++) {
    document.querySelector(`#chatHistoryList [data-chat-id="${CHAT_ID}"] .history-item-title`)?.click()
    opened = await until(() => $('messagesList')?.dataset?.chatId === CHAT_ID, 4000)
    if (!opened) await wait(250)
  }
  note('диалог прогона открыт кликом', opened, `открыт «${$('messagesList')?.dataset?.chatId || '?'}»`)

  // Ряд под открытый диалог обязан наполниться подсечёнными артефактами — с
  // этого начинаются состояния панели.
  const need = arg.artifactIds || []
  note('ряд открытого диалога наполнен его артефактами',
    need.length > 0 && await until(() => need.every(id => chipIds().includes(id)), 20000),
    `кнопок: ${chipIds().length}, нужно: ${need.length}`)

  // Сохранение списка самим окном: при выходе стоит app.exit(), который не
  // дожидается отложенной записи, поэтому окно просит сохранить сейчас и дебаунс
  // отрабатывает внутри прогона.
  try { window.__joinProject?.(null) } catch (error) { note('сохранение окна не вызвано', false, String(error)) }
  await wait(1500)
  let onDisk = []
  try { onDisk = await window.electronAPI.getConversations() || [] } catch { /* провал виден ниже */ }
  note('посев записан окном на диск', onDisk.some(item => item.id === CHAT_ID),
    onDisk.map(item => item.id).join(','))

  return { ok: checks.every(item => item.pass), checks }
})()
