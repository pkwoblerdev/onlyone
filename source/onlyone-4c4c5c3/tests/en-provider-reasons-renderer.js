// Оконная проверка Н89: на английском экране отказ пути по-английски.
//
// Скан по всем экранам ловит то, что видно в спокойном состоянии. Причины
// отказа пути появляются в трёх местах, и все три собирает главный процесс:
// путь из каталога без ключа, мёртвый адрес, пустой адрес при сохранении. Здесь
// каждое состояние вызывается настоящим кликом и мерится кириллицей во всей
// панели путей, а не в одной строке ответа.
/* global document, window */
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
  const until = async (fn, ms = 25000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch { /* ещё не досчитали */ }
      await wait(120)
    }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })

  const CYR = /[а-яёА-ЯЁ]/
  // Вкладка путей собрана заново (2.8б, Qoder-2): группа теперь
  // `#providerPathGroup`, а id полей (`customProviderMessage`, `providerSelect`,
  // `customKeyInput`) сохранены — на них держатся соседние прогоны.
  const group = () => $('providerPathGroup')
  // Панель целиком: текст, подписи и подсказки полей. Отказ садится в любое из
  // них, и выбирать глазами — не доказательство.
  const cyrInPanel = () => {
    const root = group()
    if (!root) return ['нет #providerPathGroup']
    const found = []
    const walk = document.createTreeWalker(root, 4 /* TEXT */)
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = String(node.nodeValue || '').replace(/\s+/g, ' ').trim()
      if (!text || !CYR.test(text)) continue
      const host = node.parentElement
      if (!host || host.closest('template, script, style')) continue
      let hidden = false
      for (let el = host; el && el !== document.documentElement; el = el.parentElement) {
        if (el.hidden || window.getComputedStyle(el).display === 'none') { hidden = true; break }
      }
      if (hidden) continue
      found.push(`текст «${text.slice(0, 70)}» в ${host.tagName.toLowerCase()}${host.id ? '#' + host.id : ''}`)
    }
    for (const el of root.querySelectorAll('[placeholder], [title], [aria-label]')) {
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        const value = String(el.getAttribute(attr) || '')
        if (CYR.test(value)) found.push(`${attr} «${value.slice(0, 70)}» у ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`)
      }
    }
    return found
  }
  const message = () => String($('customProviderMessage')?.textContent || '').replace(/\s+/g, ' ').trim()
  // Ответ панели — это строка, которая перестала быть «…» и отличается от
  // прежней: иначе проверка прочитала бы собственный прогресс-текст.
  const settleMessage = async previous => {
    const changed = await until(() => {
      const text = message()
      return Boolean(text) && text !== previous && !/…$|\.\.\.$/.test(text)
    })
    return { changed, text: message() }
  }
  const activePath = async () => (await window.electronAPI.getCustomProvider())?.activeProvider || ''

  const booted = await until(() => $('navChats') && window.__setLanguage)
  note('окно загрузилось', booted)
  if (!booted) return { ok: false, checks }

  await window.__setLanguage('en')
  await wait(700)
  const settings = await window.electronAPI.getSettings()
  note('язык дошёл до главного процесса',
    document.documentElement.lang === 'en' && settings?.language === 'en', String(settings?.language))

  $('openSettingsBtn')?.click()
  await wait(500)
  $('tab-keys')?.click()
  await wait(600)
  note('панель путей видна', Boolean(group()) && !group().hidden)
  const calm = cyrInPanel()
  note('в спокойном состоянии кириллицы в панели нет', calm.length === 0, calm.join(' | '))

  const before = await activePath()

  // --- 1. путь из каталога без ключа ----------------------------------------
  const select = $('providerSelect')
  const anthropic = [...(select?.options || [])].find(option => /anthropic/i.test(option.value))
  note('путь Anthropic есть в списке', Boolean(anthropic),
    [...(select?.options || [])].map(option => option.value).join(', '))
  if (anthropic) {
    select.value = anthropic.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    const answer = await settleMessage('')
    note('отказ не настроенного пути по-английски',
      /not configured|fill in|key/i.test(answer.text) && !CYR.test(answer.text), answer.text)
    note('ход тайно не переключился', (await activePath()) === before, `${before} → ${await activePath()}`)
    note('подсказка поля ключа по-английски',
      !CYR.test(String($('customKeyInput')?.placeholder || '')), $('customKeyInput')?.placeholder)
    const afterRefusal = cyrInPanel()
    note('панель после отказа без кириллицы', afterRefusal.length === 0, afterRefusal.join(' | '))
  }

  // --- 2. мёртвый адрес: отказ соединения -----------------------------------
  if (select) {
    const custom = [...(select.options || [])].find(option => option.value === 'openai-compatible')
    if (custom) {
      select.value = custom.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await settleMessage(message())
      await wait(500)
    }
  }
  $('customBaseUrlInput').value = `http://127.0.0.1:${arg.deadPort}/v1`
  $('customBaseUrlInput').dispatchEvent(new Event('input', { bubbles: true }))
  $('customModelInput').value = 'en-window-model'
  $('customKeyInput').value = 'sk-EXAMPLE76b63b64d'
  $('btnSaveCustomProvider')?.click()
  const saved = await settleMessage('')
  note('сохранение отвечено по-английски', !CYR.test(saved.text), saved.text)

  $('btnCheckCustomProvider')?.click()
  const checked = await settleMessage(saved.text)
  note('отказ мёртвого адреса по-английски',
    /ECONNREFUSED|refused|unreachable|code|answer|reads/i.test(checked.text) && !CYR.test(checked.text),
    checked.text)
  const afterDead = cyrInPanel()
  note('панель после отказа соединения без кириллицы', afterDead.length === 0, afterDead.join(' | '))

  // --- 3. пустой адрес при сохранении ---------------------------------------
  $('customBaseUrlInput').value = ''
  $('customBaseUrlInput').dispatchEvent(new Event('input', { bubbles: true }))
  $('btnSaveCustomProvider')?.click()
  const empty = await settleMessage(checked.text)
  note('пустой адрес назван по-английски',
    /empty|nothing to save|fill in/i.test(empty.text) && !CYR.test(empty.text), empty.text)

  try {
    if (typeof window.electronAPI?.takeScreenshot === 'function') await window.electronAPI.takeScreenshot()
  } catch { /* кадр — приложение, а не проверка */ }

  return { ok: checks.every(item => item.pass), checks }
})()
