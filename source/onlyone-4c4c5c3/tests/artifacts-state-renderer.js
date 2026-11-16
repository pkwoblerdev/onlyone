// Одно состояние панели артефактов на прогон: окно снимается в конце проверки,
// поэтому состояний нужно столько же запусков (план, 3.2; снимки — доказательство
// того, что человек действительно видит, а не только что код отработал).
(async () => {
  const decode = b64 => {
    try {
      const bin = atob(b64)
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  }
  const arg = decode('__ONECODE_ARG__')
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 8000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(80) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })

  if (!await until(() => $('artifactPanel') && $('artifactChips'))) {
    return { ok: false, checks: [{ name: 'интерфейс загрузился', pass: false }] }
  }
  await wait(500)

  // Ряд кнопок принадлежит открытому диалогу (Н79): артефакты прогона лежат под
  // `arg.chatId`, поэтому состояние собирается только на открытом его диалоге.
  // Открывается строкой истории — тем же путём, каким это делает человек (порядок
  // списка окно пересобирает по свежести, «первый в списке» не постоянен;
  // образец — `artifact-chips-renderer.js`).
  let opened = false
  for (let attempt = 0; attempt < 8 && !opened; attempt++) {
    document.querySelector(`#chatHistoryList [data-chat-id="${arg.chatId}"] .history-item-title`)?.click()
    opened = await until(() => $('messagesList')?.dataset?.chatId === arg.chatId, 4000)
    if (!opened) await wait(250)
  }
  note('открыт диалог прогона (клик по строке истории)', opened,
    `открыт «${$('messagesList')?.dataset?.chatId || '?'}»`)
  if (!opened) return { ok: false, checks }

  // Ряд наполняется событием об артефакте: без него кнопки открыть нечего.
  await electronAPI.saveArtifactVersion({ id: arg.page, content: '<h1>Пальмы</h1>' })
  if (!await until(() => document.querySelector('#artifactChips .artifact-chip'), 6000)) {
    note('ряд артефактов наполнен', false,
      `открыт «${$('messagesList')?.dataset?.chatId || '?'}», кнопок: ` +
      document.querySelectorAll('#artifactChips .artifact-chip').length)
    return { ok: false, checks }
  }
  // Показ, который вызвало это событие, обязан завершиться ДО клика по своей
  // кнопке: страница грузится в iframe дольше, чем код читается, и её поздний
  // показ перекрывал состояние — панель оставалась на kind='page'.
  await until(() => $('artifactPanel').dataset.kind === 'page' && $('artifactLoading').hidden, 8000)

  if (arg.mode === 'error' || arg.mode === 'text') {
    // Кнопка берётся свежей, нажатие повторяется: ряд перестраивается целиком
    // (`innerHTML = ''` и новые кнопки), и узел мог быть заменён между поиском
    // и кликом.
    let clicked = false
    for (let attempt = 0; attempt < 12 && !clicked; attempt++) {
      document.querySelector('#artifactChips .artifact-chip[data-id="' + arg.id + '"]')?.click()
      await wait(120)
      clicked = !$('artifactPanel').hidden && (!arg.kind || $('artifactPanel').dataset.kind === arg.kind)
    }
  } else {
    await electronAPI.saveArtifactVersion({ id: arg.id, content: arg.content })
  }
  // Панель считается собранной, когда на ней тот артефакт, ради которого
  // состояние и собирается: ряд наполняется событием об артефакте, и без этого
  // условия проверка успевала работать по предыдущему показанному.
  const settled = await until(() => !$('artifactPanel').hidden && $('artifactLoading').hidden &&
    ($('artifactNotice').hidden || arg.mode === 'error') &&
    (!arg.kind || $('artifactPanel').dataset.kind === arg.kind), 8000)
  note('состояние ' + arg.mode + ' собрано', settled, $('artifactPanel').dataset.kind)
  if (arg.mode === 'edit') {
    // Дальше проверять бессмысленно: править будем не тот артефакт.
    if (!settled) {
      note('правка открыта', false, 'панель не показала нужный артефакт')
      return { ok: false, checks }
    }
    const errors = []
    window.addEventListener('error', event => errors.push(`${event.message} @${event.filename}:${event.lineno}`))
    const shownAt = () => !$('artifactEditor').hidden
    const started = Date.now()
    $('artifactEdit').click()
    // Правка открывается не мгновенно: под ней запрос версии через протокол
    // артефактов, и у самой панели на такой запрос 8 с. Бюджет проверки — тот
    // же срок плюс секунда: дольше незачем, панель бы уже отказала словами.
    let ever = shownAt()
    while (Date.now() - started < 9000) { ever = ever || shownAt(); if (shownAt()) break; await wait(30) }
    const after = Date.now() - started
    await wait(400)
    // Открылась и пропала — значит, правку затёрло поздним перерисованием
    // панели, и человек потерял бы набранный текст.
    note('правка открыта', shownAt(),
      `открылась за ${after} мс, пропала после: ${ever && !shownAt()}, ` +
      `ошибки: ${errors.join(' | ') || 'нет'}, «${$('artifactNotice').textContent.trim()}»`)
  }
  if (arg.mode === 'menu') {
    $('artifactMore').click()
    note('меню «Ещё» открыто', await until(() => document.querySelector('.ctx-menu'), 4000))
  }
  if (arg.mode === 'expanded') {
    $('artifactExpand').click()
    await wait(300)
    note('панель развёрнута', $('chatView').classList.contains('artifact-expanded'))
  }
  await wait(400)
  return { ok: checks.every(item => item.pass), checks }
})()
