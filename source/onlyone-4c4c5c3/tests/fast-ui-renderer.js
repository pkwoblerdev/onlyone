// Проверка Fast-режима в настоящем окне.
//
// Прежняя версия жила на фиксированных паузах (1200 мс до чтения, 200 мс после
// переключателя) и сравнивала `pillModelName` саму с собой. Это давало и ложный
// провал, и ложный успех: каталог моделей приходит из сети АСИНХРОННО и после
// `appReady` (окно ставит его в конце инициализации, `app.js:8440`, а замена
// выбранной модели — `app.js:4036`), поэтому имя в фишке легитимно меняется
// спустя секунды. Замер 24.09: старый зонд давал 1 провал из 7 и 6 «зелёных»,
// причём два чтения могли приходиться на одно и то же незавершённое состояние.
//
// Новый порядок: ждать ПОКОЯ имени (одно и то же значение несколько опросов
// подряд), затем включать Fast, снова дождаться покоя и сравнивать устойчивые
// значения. Так проверка ловит настоящую подмену модели и не падает от того,
// что каталог ещё едет.
(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const pill = () => $('pillModelName')?.textContent?.trim() || ''
  const ready = await (async () => {
    const stop = Date.now() + 20000
    while (Date.now() < stop) { if (document.documentElement.dataset.appReady === '1') return true; await wait(100) }
    return false
  })()

  // Значение считается установившимся, если не менялось восемь опросов подряд.
  // 800 мс покоя — не «таймаут побольше»: каталог или приходит, или не приходит
  // вовсе, и при 25 с ожидания проверка станет красной, а не зелёной.
  async function settleName (ms = 25000) {
    const stop = Date.now() + ms
    let last = pill()
    let stable = 0
    while (Date.now() < stop) {
      await wait(100)
      const now = pill()
      if (now && now === last) { if (++stable >= 8) return now } else { stable = 0; last = now }
    }
    return null
  }

  async function waitForCatalog (ms = 30000) {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      const label = $('modelCountBadge')?.textContent?.trim() || ''
      if (label && label !== 'Загрузка…') return true
      await wait(100)
    }
    return false
  }

  const catalogReady = await waitForCatalog()
  const before = await settleName()

  $('modelEffortPillBtn')?.click()
  const toggle = $('fastModeToggle')
  toggle.checked = true
  toggle.dispatchEvent(new Event('change', { bubbles: true }))
  const until = async (fn, ms) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(100) }
    return false
  }
  const applied = await until(() => $('pillEffortName')?.textContent?.trim() === 'Fast', 5000)
  const after = await settleName()

  const row = toggle.closest('.modal-effort-bar')
  const checks = [
    { name: 'окно инициализировано (appReady)', pass: ready },
    { name: 'каталог моделей завершил начальную загрузку', pass: catalogReady },
    { name: 'имя модели успело установиться до переключателя', pass: Boolean(before), detail: before || 'не дождалась' },
    { name: 'переключатель Fast применился', pass: applied, detail: $('pillEffortName')?.textContent },
    { name: 'имя модели установилось и после переключателя', pass: Boolean(after), detail: after || 'не дождалась' },
    { name: 'Модель при включении Fast не меняется', pass: Boolean(before) && before === after, detail: `${before} → ${after}` },
    { name: 'Настройка помещается в каталоге', pass: row.scrollWidth <= row.clientWidth + 1 },
    { name: 'Нет лишней кнопки в строке ввода', pass: !$('promptSuggestBtn') },
    { name: 'Fast включён', pass: toggle.checked && $('pillEffortName').textContent === 'Fast' }
  ]
  return { ok: checks.every(c => c.pass), checks }
})()
