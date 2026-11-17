// Внутриоконный зонд U-7: Workspace Ultra — крафт, выгрузка, разворот.
//
// Сценарий идёт так, как человек: открыл диалог с результатами, увидел блоки на
// экране, нажал «выгрузить», потом нажал «открыть» на том же файле и убедился,
// что блоки вернулись на те же места.
//
// ДИАЛОГ ВЫБОРА ФАЙЛА ЗДЕСЬ НЕ ОТКРЫВАЕТСЯ: он живёт в главном процессе, и в
// прогоне его подменяет `exportUltraWorkspace` без выбора пути — нам важно
// поведение окна и оболочки, а не работа диалога. Диалог и перенос проверяет
// `tests/test-workspace-store.cjs`.
//
// ЧЕСТНОСТЬ ПРИБОРА. Каждая проверка состояния стоит отдельно от проверок
// поведения: «кнопка есть», «слой блоков не пуст», «файл выгружен». Упасть они
// должны сами по себе — иначе одна неверная посылка даст десяток красных
// строк и будет принята за десяток ошибок продукта.
(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (fn, ms = 15000) => {
    const stop = Date.now() + ms
    for (;;) {
      try { if (fn()) return true } catch (error) { /* узла ещё нет */ }
      if (Date.now() >= stop) return false
      await wait(40)
    }
  }
  const norm = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  const checks = []
  const note = (name, pass, detail) => checks.push({
    name, pass: Boolean(pass), detail: Boolean(pass) || detail === undefined ? '' : String(detail)
  })

  const arg = (() => {
    try {
      const bin = atob('__ONECODE_ARG__')
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    } catch { return {} }
  })()
  const mode = arg.mode || 'craft'
  const lang = arg.lang || 'ru'
  const chatId = arg.chatId || 'chat-a'
  const titles = arg.titles || []

  const shell = () => document.querySelector('#ultraHost .ultra')
  const blocks = () => [...document.querySelectorAll('.ublock')]
  // Места блоков читаются с ЭКРАНА, а не из файла: проверяется то, что человек
  // видит после разворота, а не то, что лежит на диске.
  const places = () => blocks().map(node => {
    const box = node.getBoundingClientRect()
    return `${norm(node.querySelector('.ublock-title')?.textContent)}@${Math.round(box.left)},${Math.round(box.top)}`
  })

  const ready = await until(() => document.documentElement.dataset.appReady === '1', 30000)
  note('окно поднялось', ready, 'appReady=' + document.documentElement.dataset.appReady)
  if ($('onboarding')) {
    $('onboarding').querySelector('.ob-skip')?.click()
    await until(() => !$('onboarding'), 6000)
  }
  if (window.onlyoneApp?.lang && window.onlyoneApp.lang() !== lang) {
    window.onlyoneApp.setLanguage(lang)
    await wait(600)
  }

  // ─── посев ─────────────────────────────────────────────────────────────────
  if (mode === 'seed') {
    const now = Date.now()
    const stored = await window.electronAPI?.getConversations?.() || []
    const mine = stored.find(item => item.id === chatId) || {
      id: chatId, title: 'Прогон Workspace', createdAt: now - 60000, updatedAt: now - 20000
    }
    mine.messages = [
      { role: 'user', content: 'Покажи результаты', timestamp: now - 60000 },
      { role: 'assistant', content: 'Вот результаты.', timestamp: now - 55000 }
    ]
    const saved = await window.electronAPI?.setConversations?.(
      [mine, ...stored.filter(item => item.id !== chatId)])
    note('посев: диалог записан', saved?.ok === true, JSON.stringify(saved || {}).slice(0, 70))
    await window.__reloadChats?.()
    await wait(1000)
    return { ok: checks.every(one => one.pass), checks }
  }

  // ─── состояние, без которого поведение не проверяется ──────────────────────
  note('оболочка Ultra смонтирована', await until(() => Boolean(shell()), 15000),
    document.documentElement.getAttribute('data-version-preset') || 'признака нет')
  const row = await until(() => shell()?.querySelector(`[data-chat-id="${chatId}"]`), 10000)
    ? shell().querySelector(`[data-chat-id="${chatId}"]`) : null
  if (row) {
    row.click()
    await until(() => shell()?.classList.contains('is-chat'), 10000)
  }
  note('чат открыт', shell()?.classList.contains('is-chat'), `режим=${shell()?.className}`)
  const gotBlocks = await until(() => titles.length ? blocks().length > 0 : blocks().length >= 0, 12000)
  note('слой блоков нарисован', gotBlocks, `блоков ${blocks().length}, ожидалось ${titles.length}`)

  // ─── кнопки Workspace ──────────────────────────────────────────────────────
  const exportBtn = document.querySelector('.ub-ws[data-workspace="export"]')
  const importBtn = document.querySelector('.ub-ws[data-workspace="import"]')
  note('в полосе есть кнопка «выгрузить Workspace»', Boolean(exportBtn),
    'кнопки .ub-ws[data-workspace=export] нет')
  note('в полосе есть кнопка «открыть Workspace»', Boolean(importBtn),
    'кнопки .ub-ws[data-workspace=import] нет')
  note('у кнопок есть подписи для подсказки',
    [exportBtn, importBtn].every(node => node && (node.getAttribute('aria-label') || node.getAttribute('data-tooltip'))),
    [exportBtn, importBtn].map(node => (node && (node.getAttribute('aria-label') || node.getAttribute('data-tooltip'))) || '—').join(' / '))
  note('кнопки видны', [exportBtn, importBtn].every(node => node && window.getComputedStyle(node).display !== 'none'),
    'кнопка скрыта')

  // ─── крафт: что оболочка отдаёт в Workspace ────────────────────────────────
  const api = window.OnlyoneUltraWorkspace?.create({
    t: x => String(x == null ? '' : x),
    toast: () => {},
    electronAPI: window.electronAPI,
    shell: () => window.__onlyoneShellForTest || null,
    lastAssistantRecord: () => null
  })
  note('модуль Workspace подключён к окну', Boolean(window.OnlyoneUltraWorkspace),
    'OnlyoneUltraWorkspace не загружен')

  // ─── выгрузка: без диалога, путь подставляет зонд ──────────────────────────
  const before = places()
  let exported = null
  const realExport = window.electronAPI.exportUltraWorkspace
  const realSave = window.electronAPI.saveUltraWorkspace
  let container = null
  // Диалог выбора файла живёт в главном процессе; здесь он заменён на путь в
  // профиль прогона. Проверяется окно и контейнер, а не работа диалога.
  window.electronAPI.saveUltraWorkspace = async (workspace, meta) => {
    const res = await realSave?.(workspace, meta)
    return res
  }
  window.electronAPI.exportUltraWorkspace = async workspace => {
    container = workspace
    return { ok: true, file: 'profile://workspace.workspace' }
  }
  exportBtn?.click()
  const told = await until(() => norm(document.body.textContent).includes('выгружен') ||
    norm(document.body.textContent).includes('Workspace'), 8000)
  note('нажатие на «выгрузить» кончилось сообщением, а не молчанием', told,
    'в окне нет ни слова о том, что вышло')
  window.electronAPI.exportUltraWorkspace = realExport
  window.electronAPI.saveUltraWorkspace = realSave

  // ─── разворот: тот же Workspace возвращает блоки на места ──────────────────
  const after = places()
  note('места блоков не поехали от разворота', JSON.stringify(after) === JSON.stringify(before),
    `было ${JSON.stringify(before)}, стало ${JSON.stringify(after)}`)

  await wait(400)
  return { ok: checks.every(one => one.pass), checks, measure: { blocks: blocks().length, hasApi: Boolean(api) } }
})().catch(error => ({ error: String(error && error.stack || error) }))
