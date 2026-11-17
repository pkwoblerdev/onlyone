// Кадр галереи версий и меню выгрузки (план, 1.4).
//
// Проверки живёт другой скрипт и заканчивается отказом выгрузки; этот собирает
// то состояние, которое надо смотреть глазами: список версий с видом, временем и
// размером, открытая версия и меню форматов поверх него. Окно само делает снимок
// в конце прогона, поэтому состояние обязано пережить возврат скрипта.
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
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: String(detail ?? '') })

  if (!await until(() => $('artifactPanel') && $('artifactChips'))) {
    return { ok: false, checks: [{ name: 'интерфейс загрузился', pass: false }] }
  }
  if (!arg.page) return { ok: false, checks: [{ name: 'артефакт подсеян в прогон', pass: false }] }

  // Ряд кнопок принадлежит открытому диалогу (Н79): кадр собирается на диалоге
  // прогона, и открывается он строкой истории — тем же путём, каким это делает
  // человек. Клик повторяется, потому что порядок списка окно пересобирает по
  // свежести (образец — `artifact-chips-renderer.js`).
  let opened = false
  for (let attempt = 0; attempt < 8 && !opened; attempt++) {
    document.querySelector(`#chatHistoryList [data-chat-id="${arg.chatId}"] .history-item-title`)?.click()
    opened = await until(() => $('messagesList')?.dataset?.chatId === arg.chatId, 4000)
    if (!opened) await wait(250)
  }
  note('открыт диалог прогона (клик по строке истории)', opened,
    `открыт «${$('messagesList')?.dataset?.chatId || '?'}»`)
  if (!opened) return { ok: false, checks }

  // Ряд кнопок наполняется событием об артефакте — тем же, каким это делает
  // программа: без него открыть галерею нечем.
  await window.electronAPI.saveArtifactVersion({ id: arg.page, content: '<h1>Кадр</h1>' })
  const chip = () => document.querySelector(`#artifactChips .artifact-chip[data-id="${arg.page}"]`)
  await until(() => Boolean(chip()))
  chip()?.click()
  const rows = () => [...document.querySelectorAll('#artifactVersions .artifact-version-row')]
  const galleryShown = await until(() => rows().length >= 3 &&
    $('artifactPanel').hidden === false && $('artifactVersions').hidden === false)
  note('галерея открыта', galleryShown, `строк ${rows().length}`)
  const marked = rows().filter(row => row.getAttribute('aria-current') === 'true')
  note('открытая версия помечена в галерее', marked.length === 1,
    marked.map(row => row.dataset.version).join(','))
  // Кадр пустого превью («Открываем…») не доказывает, что галерея живёт рядом с
  // содержимым: ждём, пока показ закончится.
  const loaded = await until(() => $('artifactLoading')?.hidden === true, 8000)
  note('содержимое версии открыто, а не в состоянии загрузки', loaded,
    `загрузка: ${$('artifactLoading')?.hidden === true ? 'нет' : 'да'}`)

  $('artifactMore')?.click()
  const items = () => [...document.querySelectorAll('.ctx-menu .ctx-item')]
  const moreShown = await until(() => items().some(item => item.textContent.trim() === 'Выгрузить артефакт'))
  note('меню «Ещё» открыто', moreShown, items().map(item => item.textContent.trim()).join(' | '))
  items().find(item => item.textContent.trim() === 'Выгрузить артефакт')?.click()
  const formatsShown = await until(() => items().length >= 2)
  note('список форматов открыт', formatsShown, items().map(item => item.textContent.trim()).join(' | '))
  // Меню обязано пережить конец прогона: снимок окно делает после возврата
  // скрипта, и закрывшееся меню дало бы кадр без того, что проверяется.
  await wait(400)
  note('меню форматов всё ещё на экране', Boolean(document.querySelector('.ctx-menu')),
    items().map(item => item.textContent.trim()).join(' | '))

  return { ok: checks.every(item => item.pass), checks }
})()
