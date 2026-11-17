// Оконный прогон 2.6б: на английском в интерфейсе нет ни одной русской строки.
//
// Прежний `run-en-ui.cjs` смотрит несколько контроллов выборочно и потому
// пропускает то, что собирается кодом: заголовок окна настроек, шапку списка
// команд, причины падения из главного процесса. Здесь сканируется ВЕСЬ видимый
// текст и все переводимые атрибуты на каждом экране.
//
// Исключением могут быть только данные человека — и каждое исключение
// перечислено ниже с причиной. Пустой список найденного = проверка пройдена;
// непустой = это правится в коде, а не заносится в исключения.
/* global document, window, NodeFilter */
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
  const until = async (fn, ms = 15000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) {
      try { if (fn()) return true } catch { /* экран ещё не досчитал */ }
      await wait(80)
    }
    return false
  }

  const CYR = /[а-яёА-ЯЁ]/
  // Данные человека: единственный класс исключений. Пока профиль прогона —
  // временная папка с латинским именем, русских строк человека здесь нет; если
  // появится, правило обязано назвать, ЧЬИ это данные.
  const PERSON_DATA = [
    { at: /#workspaceChip$/, because: 'имя рабочей папки, выбранной человеком' }
  ]

  const found = []
  // «Видимый» здесь — не «в кадре», а «в раскрытом виде»: строка, уехавшая за
  // нижний край прокрутки, человек всё равно видит, прокрутив страницу.
  // `getClientRects()` у таких узлов непустой, и раньше они из проверки
  // выпадали — так из поля зрения пропадали названия встроенных процессов.
  const shown = el => {
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.hidden) return false
      const style = window.getComputedStyle ? window.getComputedStyle(node) : null
      if (!style) break
      if (style.display === 'none' || style.visibility === 'hidden') return false
    }
    return true
  }
  const pathOf = el => {
    const parts = []
    let node = el
    while (node && node !== document.body && parts.length < 4) {
      let label = String(node.tagName || '').toLowerCase()
      if (node.id) label += '#' + node.id
      else if (node.classList && node.classList.length) label += '.' + [...node.classList].slice(0, 2).join('.')
      parts.unshift(label)
      if (node.id) break
      node = node.parentElement
    }
    return parts.join('>')
  }
  const clean = text => String(text).replace(/\s+/g, ' ').trim()

  function scan (screen) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        const text = clean(node.nodeValue || '')
        if (text.length < 2 || !CYR.test(text)) return NodeFilter.FILTER_REJECT
        const el = node.parentElement
        if (!el || !shown(el) || el.closest('script,style,template')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    let node
    while ((node = walker.nextNode())) {
      found.push({ screen, text: clean(node.nodeValue).slice(0, 90), path: pathOf(node.parentElement) })
    }
    for (const attr of ['data-tooltip', 'aria-label', 'placeholder', 'title', 'alt']) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        const value = clean(el.getAttribute(attr) || '')
        if (!CYR.test(value) || !shown(el)) continue
        found.push({ screen, text: value.slice(0, 90), path: pathOf(el) + '@' + attr })
      }
    }
    const title = clean(document.title || '')
    if (CYR.test(title)) found.push({ screen, text: title.slice(0, 90), path: 'document.title' })
  }

  const checks = []
  const note = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail })
  // Общий экран (боковая панель, строка ввода) виден на всех разделах, поэтому
  // каждая строка называется один раз — иначе отчёт тонет в повторах и непонятно,
  // сколько правок на самом деле найдено.
  const reported = new Set()
  const unique = list => {
    const seen = new Set()
    return list.filter(item => {
      const key = item.text + '@@' + item.path
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const report = (screen) => {
    const rows = unique(found.filter(item => item.screen === screen &&
      !PERSON_DATA.some(rule => rule.at.test(item.path))))
      .filter(item => !reported.has(item.text + '@@' + item.path))
    for (const item of rows) reported.add(item.text + '@@' + item.path)
    note(`на экране «${screen}» новых русских строк нет`, rows.length === 0,
      rows.slice(0, 10).map(row => `${row.path} «${row.text}»`).join(' | '))
  }

  await until(() => document.documentElement.dataset.appReady === '1' || $('navChats'))
  await wait(500)

  // `shot-ru` — те же экраны для приёмки вида на РУССКОМ языке: там скан не
  // нужен (русский и есть источник), но язык обязан быть настоящим: профиль
  // прогона общий с английскими запусками, и без явного возврата он остался бы
  // английским.
  const wantRu = arg.mode === 'shot-ru'
  if (typeof window.__setLanguage === 'function') await window.__setLanguage(wantRu ? 'ru' : 'en')
  await wait(400)
  note(wantRu ? 'язык экрана русский' : 'язык переключён на английский',
    document.documentElement.lang === (wantRu ? 'ru' : 'en'), `lang=${document.documentElement.lang}`)

  if (arg.mode === 'shot' || arg.mode === 'shot-ru') {
    // Кадры для приёмки: тот же обход, но один экран и снимок на нём.
    const target = { chats: 'navChats', projects: 'navProjects', skills: 'navSkills',
      design: 'navDesign', connectors: 'navConnectors',
      tasks: 'navTasks' }[arg.nav]
    if (arg.nav === 'settings') {
      $('openSettingsBtn')?.click()
      await until(() => $('settingsModal') && !$('settingsModal').hidden, 6000)
      const tab = document.querySelector(`#settingsModal [data-settings-tab="${arg.tab || 'appearance'}"]`)
      tab?.click()
      await wait(500)
      if (!wantRu) { scan(`настройки/${arg.tab || 'appearance'}`); report(`настройки/${arg.tab || 'appearance'}`) }
    } else {
      $(target)?.click()
      await wait(700)
      if (!wantRu) { scan(arg.nav); report(arg.nav) }
    }
    note('кадр снят', true, arg.nav)
  } else if (arg.mode === 'onboarding') {
    const ob = () => $('onboarding')
    const step = () => ob()?.querySelector('.ob-step:not(.is-leaving)')?.dataset.step
    const next = () => ob()?.querySelector('.ob-next')?.click()
    await until(() => step())
    const seen = []
    for (let guard = 0; guard < 12; guard++) {
      const name = step()
      if (!name || seen.includes(name)) break
      seen.push(name)
      await wait(600)
      scan(`вступление/${name}`)
      report(`вступление/${name}`)
      // Заставка отвечает не сразу: кнопка появляется вместе с концом
      // появления, поэтому клик повторяется, пока шаг не сменился.
      for (let attempt = 0; attempt < 3 && step() === name; attempt++) {
        next()
        await until(() => step() !== name, 3000)
      }
    }
    note('шагов вступления пройдено больше одного', seen.length > 1, seen.join(','))
  } else {
    const screens = [
      ['navChats', 'чат'],
      ['navProjects', 'проекты'],
      ['navSkills', 'скиллы'],
      ['navDesign', 'дизайн'],
      ['navConnectors', 'подключения'],
      ['navTasks', 'задачи']
    ]

    // Список команд и выбор режима — их рисует код, и в них чаще всего
    // остаются русские шапки и подписи.
    const box = $('composerTextarea')
    if (box) {
      box.value = '/'
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await until(() => $('slashMenu') && $('slashMenu').style.display !== 'none', 4000)
      await wait(300)
      scan('список команд')
      report('список команд')
      box.value = ''
      box.dispatchEvent(new Event('input', { bubbles: true }))
      document.body.click()
      await wait(200)
    }
    $('permModeBtn')?.click()
    await until(() => $('permModeMenu') && !$('permModeMenu').hidden, 4000)
    await wait(300)
    scan('выбор режима')
    report('выбор режима')
    document.body.click()
    await wait(200)

    for (const [id, name] of screens) {
      $(id)?.click()
      await wait(450)
      scan(name)
      report(name)
    }

    $('openSettingsBtn')?.click()
    await until(() => $('settingsModal') && !$('settingsModal').hidden, 6000)
    await wait(400)
    for (const tab of document.querySelectorAll('#settingsModal [data-settings-tab]')) {
      tab.click()
      await wait(450)
      scan(`настройки/${tab.dataset.settingsTab}`)
      report(`настройки/${tab.dataset.settingsTab}`)
    }
  }

  const left = unique(found.filter(item => !PERSON_DATA.some(rule => rule.at.test(item.path))))
  note('всего русских строк интерфейса не найдено', left.length === 0,
    `найдено ${left.length}: ` + left.slice(0, 25).map(row => `[${row.screen}] ${row.path} «${row.text}»`).join(' ; '))

  return { ok: checks.every(item => item.pass), checks, data: { найдено: left.length, строки: left.slice(0, 200) } }
})()
