/* Вступление первого запуска (макет 25.10, audits/ui-2026-10-18/onboarding).
 *
 * Вступление идёт в главной колонке настоящего окна: слева настоящая боковая
 * панель, приглушённая и недоступная до конца. Вопрос всегда стоит там, где на
 * главном экране строка ввода, и выглядит как она. Ответ уходит вверх тихой
 * строкой «что — значение»; нажатие на строку возвращает к вопросу, поэтому
 * кнопки «Назад» нет. Версий во вступлении нет (слово владельца 25.10).
 *
 * Шаги: приветствие (один пример работы в ленте) → имя → занятие → упор →
 * модели → тема → готово. Конец — не отдельный экран: карточка вопроса
 * становится строкой ввода, боковая панель оживает, а первое слово, набранное
 * в ней, уходит в настоящую строку ввода главного экрана.
 *
 * Кто видит: новый человек — один раз, при первом запуске. Тот, кто работал в
 * onlyone до появления вступления (владелец), видит его после каждого
 * обновления, где вступление поменялось (REV).
 *
 * Движение: ответ уходит вверх, следующий вопрос встаёт на место строки ввода;
 * ничего не мигает и не крутится, кроме кольца «Проверяю…». Прозрачность и
 * сдвиги — WAAPI: конечное значение пишется в стиль сразу, начальное на время
 * задержки держит `fill: backwards` (иначе при смене текста мигает кадр).
 * При «уменьшить движение» всё меняется сразу.
 */
(function () {
  'use strict'

  // Канал сборки: stable — для всех, кроме владельца (без версий Pro и Ultra).
  const STABLE_CHANNEL = window.electronAPI?.channel === 'stable'
  document.documentElement.dataset.channel = STABLE_CHANNEL ? 'stable' : 'experimental'

  const DONE_KEY = 'onlyone.onboarded'
  const FOLLOW_KEY = 'onlyone.onboardingFollow'
  const REV_KEY = 'onlyone.onboardingRev'
  // Меняется, когда меняется само вступление: по нему тот, кто следит за
  // обновлениями вступления, видит его снова.
  const REV = '2026-10-25-intro'

  // Версии окна — только для Настроек → «Вид приложения»: во вступлении их нет.
  // Ultra там выбираемая карточка, Pro остаётся «скоро» и не выбирается.
  const EDITIONS = [
    { id: 'default', name: 'onlyone', tag: 'Default', ready: true,
      text: 'Привычное окно: боковая панель, чаты, проекты и скиллы.' },
    { id: 'pro', name: 'onlyone Pro', tag: 'Pro', ready: false,
      text: 'В каждом чате рабочее место: ход работы слева, задачи и превью справа.' },
    { id: 'ultra', name: 'onlyone Ultra', tag: 'Ultra', ready: true,
      text: 'Чистое окно и одна строка. Остальное агент собирает сам под задачу.' }
  ]

  const pickable = item => Boolean(item) && item.ready

  const EDITION_SKETCH = {
    default: '<rect x="1" y="1" width="46" height="30" rx="4"/><path d="M13 1v30"/><path d="M4 7h6M4 11h6M4 15h6"/><path d="M19 24h22"/>',
    pro: '<rect x="1" y="1" width="46" height="30" rx="4"/><path d="M11 1v30M37 1v30"/><path d="M15 24h18"/><path d="M40 7h4M40 11h4"/><path d="M4 7h4M4 11h4"/>',
    ultra: '<rect x="1" y="1" width="46" height="30" rx="4"/><rect x="12" y="17" width="24" height="6" rx="3"/><path d="M18 11h12"/><circle cx="5.5" cy="5.5" r="1.3"/>'
  }

  const MARK_PATH = document.getElementById('appGlyph')?.querySelector('path')?.getAttribute('d') || ''

  const app = () => window.onlyoneApp || {}
  const t = (text, ...args) => (app().t ? app().t(text, ...args) : text)
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const read = key => { try { return localStorage.getItem(key) } catch { return null } }
  const write = (key, value) => { try { localStorage.setItem(key, value) } catch {} }
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  // ─── Версия окна: один источник истины и один канал (план 7.1, 9.2) ─────────
  //
  // Версию выбирает ЗНАЧЕНИЕ `versionPreset` конфигурации интерфейса: оно же
  // решает, рисовать ли оболочку Ultra (app.js: `setUiConfig` → main
  // `uiConfig.save` → рассылка `ui-config-changed` → `applyUiConfig` →
  // `syncUltraShell`).
  //
  // Текущую конфигурацию карточки берут двумя штатными каналами, и оба ведут в
  // один профиль: `onlyoneApp.getUiConfig()` — синхронно, из уже применённой
  // конфигурации окна (первый рендер и случай, когда мост ещё не ответил),
  // `electronAPI.getUiConfig()` — из самого файла профиля, через мост.
  // Запись — только мостом и только ПОЛНЫМ конфигом: `ui-config.validate`
  // добивает отсутствующие поля не из профиля, а из DEFAULT_UI_CONFIG, поэтому
  // payload с одним полем обнулил бы ширины, шрифты и порядок панелей.
  let uiConfigKnown = null

  const asConfig = value => (value && typeof value === 'object' ? value : null)
  const liveConfig = () => asConfig(app().getUiConfig?.())

  async function readUiConfig() {
    try {
      const viaBridge = asConfig(await window.electronAPI?.getUiConfig?.())
      if (viaBridge) {
        uiConfigKnown = viaBridge
        return viaBridge
      }
    } catch (error) {
      console.warn('[onboarding] конфигурацию интерфейса не прочитать:', error?.message || error)
    }
    return liveConfig() || uiConfigKnown
  }

  // Список версий шире, чем значения, которые карточки вправе выставить:
  // «pro» в конфигурации — это обещанное «скоро», а не выбранная карточка.
  function versionOf(config) {
    const value = config && config.versionPreset
    return EDITIONS.some(item => item.id === value) ? value : 'default'
  }

  function edition() {
    return versionOf(liveConfig() || uiConfigKnown)
  }

  // Запись версии: ровно один вызов моста, полный конфиг, изменено одно поле.
  // Возвращает true, только если профиль принял запись, — выбранность карточек
  // после этого перечитывается из ответа, а не остаётся на слове «нажали».
  async function saveVersion(id) {
    const bridge = window.electronAPI
    if (!bridge?.setUiConfig) return false
    const base = await readUiConfig()
    if (!base) return false
    const payload = Object.assign({}, base, { versionPreset: id })
    try {
      const res = await bridge.setUiConfig(payload)
      if (!res || res.ok === false) {
        console.warn('[onboarding] версия не записана:', res?.error || 'мост не ответил')
        return false
      }
      uiConfigKnown = asConfig(res.config) || payload
      return true
    } catch (error) {
      console.warn('[onboarding] запись версии не дошла до профиля:', error?.message || error)
      return false
    }
  }

  function editionCardsHtml(selected) {
    return EDITIONS.map(item => {
      const open = pickable(item)
      const on = item.id === selected
      return `
      <button type="button" class="edition-card${on ? ' is-selected' : ''}${open ? '' : ' is-soon'}"
        role="radio" aria-checked="${on}" ${open ? '' : 'aria-disabled="true"'} data-edition="${item.id}">
        <svg class="edition-sketch" viewBox="0 0 48 32" aria-hidden="true">${EDITION_SKETCH[item.id]}</svg>
        <span class="edition-text">
          <span class="edition-name">${esc(item.name)}${open ? '' : ` <span class="edition-soon">${esc(t('скоро'))}</span>`}</span>
          <span class="edition-desc">${esc(t(item.text))}</span>
        </span>
        <span class="edition-radio" aria-hidden="true"></span>
      </button>`
    }).join('')
  }

  function markSelected(host, id) {
    host.querySelectorAll('[data-edition]').forEach(node => {
      const on = node.dataset.edition === id
      node.classList.toggle('is-selected', on)
      node.setAttribute('aria-checked', String(on))
    })
  }

  function bindEditionCards(host) {
    host.addEventListener('click', async event => {
      const card = event.target.closest('[data-edition]')
      if (!card) return
      const item = EDITIONS.find(entry => entry.id === card.dataset.edition)
      if (!pickable(item)) {
        // «Скоро» не молчит: короткий отказ сдвигом, и ничего не пишется.
        card.classList.remove('is-denied')
        void card.offsetWidth
        card.classList.add('is-denied')
        return
      }
      // Отклик сразу, но выбранность после этого сверяется с записью: если
      // профиль версии не принял, карточка обязана вернуться к тому, что есть.
      markSelected(host, item.id)
      const saved = await saveVersion(item.id)
      renderSettingsEditions(saved ? versionOf(uiConfigKnown) : edition())
    })
    host.addEventListener('keydown', event => {
      const dir = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
      if (!dir) return
      const cards = [...host.querySelectorAll('[data-edition]')]
      const at = cards.indexOf(document.activeElement)
      if (at < 0) return
      event.preventDefault()
      cards[(at + dir + cards.length) % cards.length].focus()
    })
  }

  // Группа «Версия» в Настройках: выбранность — из конфигурации. `selected`
  // передаёт её значение вызывающий, когда перерисовку породила сама запись или
  // рассылка и окно ещё не успело применить конфиг; без аргумента значение
  // читается из тех же каналов, что и при запуске.
  function renderSettingsEditions(selected) {
    const host = document.getElementById('editionChoices')
    if (host) {
      host.innerHTML = editionCardsHtml(selected == null ? edition() : selected)
      if (!host.dataset.bound) {
        bindEditionCards(host)
        host.dataset.bound = '1'
      }
    }
    const follow = document.getElementById('onboardingFollow')
    if (follow) follow.checked = read(FOLLOW_KEY) === '1'
  }

  // --- Вступление -------------------------------------------------------------

  const STEPS = ['hello', 'name', 'role', 'focus', 'key', 'theme', 'done']
  // Счётчик «N из 5» — только у вопросов.
  const ASK = ['name', 'role', 'focus', 'key', 'theme']
  const THEMES = [['dark', 'Тёмная'], ['light', 'Светлая'], ['system', 'Как в системе']]
  const EASE_OUT = 'cubic-bezier(.23, 1, .32, 1)'
  const EASE_IN = 'cubic-bezier(.4, 0, 1, 1)'

  const IC = {
    check: '<svg class="ob-i" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.6 8.4 2.8 2.8 6-6.2"/></svg>',
    pen: '<svg class="ob-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 3.2l2.2 2.2-7 7H3.6v-2.2z"/></svg>',
    chev: '<svg class="ob-i" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4.5 3.5 3.5L6 11.5"/></svg>',
    eye: '<svg class="ob-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/></svg>',
    ext: '<svg class="ob-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 11l6-6M6.2 5H11v4.8"/></svg>',
    warn: '<svg class="ob-i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M8 5v3.4M8 10.8v.1"/></svg>',
    plus: '<svg class="ob-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
    up: '<svg class="ob-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.8V3.2M4 7.2l4-4 4 4"/></svg>'
  }
  const MARK = cls => `<svg class="${cls}" viewBox="10.5 10.5 43 43" aria-hidden="true"><path fill-rule="evenodd" d="${MARK_PATH}"/></svg>`

  let root = null
  let st = null
  let returnFocus = null
  let busy = Promise.resolve()
  let demoRun = 0
  // Что погасили на время вступления: боковая панель и всё в главной колонке,
  // кроме самого вступления. Возвращается ровно то, что было живым.
  let dimmed = []

  const byId = id => root?.querySelector('#' + id) || null
  const personal = () => app().personal?.() || {}
  const providerInfo = () => st.providers.find(item => item.id === st.provider) || { id: st.provider, title: 'OpenRouter' }

  // Анимация одного узла. Прозрачность: конечное значение сразу в стиле,
  // начальное на задержку держит fill: backwards. Сдвиг и высота — те же
  // кадры WAAPI; высота на время хода обрезает содержимое.
  function anim(el, kf, o = {}) {
    if (!el || !el.animate || reducedMotion()) return Promise.resolve()
    const frames = {}
    if (kf.opacity) {
      el.style.opacity = String(kf.opacity[kf.opacity.length - 1])
      frames.opacity = kf.opacity.map(String)
    }
    if (kf.y) frames.transform = kf.y.map(n => `translateY(${n}px)`)
    if (kf.height) {
      frames.height = kf.height
      el.style.overflow = 'hidden'
    }
    const run = el.animate(frames, { duration: o.duration ?? 240, delay: o.delay ?? 0, easing: o.ease || EASE_OUT, fill: 'backwards' })
    const end = () => {
      if (kf.height) el.style.overflow = ''
      if (kf.opacity && kf.opacity[kf.opacity.length - 1] === 1) el.style.opacity = ''
    }
    return run.finished.then(end, end)
  }

  // Искорка в конце распускается: проявляется и вырастает с лёгким перелётом,
  // без вращения (искра не крутится — слово владельца 28.09).
  function bloom(mark) {
    if (!mark) return Promise.resolve()
    mark.style.opacity = ''
    if (!mark.animate || reducedMotion()) return Promise.resolve()
    return Promise.all([
      mark.animate({ opacity: ['0', '1'] }, { duration: 180, delay: 60, easing: EASE_OUT, fill: 'backwards' }).finished,
      mark.animate({ transform: ['scale(0.4)', 'scale(1.04)', 'scale(1)'], offset: [0, 0.65, 1] },
        { duration: 380, delay: 60, easing: EASE_OUT, fill: 'backwards' }).finished
    ]).catch(() => {})
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  // --- Пример работы ---
  // Одно сообщение, итог хода и ответ по словам — те же части, что в ленте
  // чата. Играет один раз; язык меняется — пример уже готов.
  const DEMO_ASK = 'Разбери отзывы за сентябрь и выдели главное'
  const DEMO_RUN = 'Прочитал 3 файла, создал отчёт.md'
  const DEMO_ANSWER = 'Главное — доставка: 38 % жалоб, почти все про опоздания. Подробности и что сделать — в отчёт.md.'

  function threadHtml() {
    return `<div class="ob-bubble">${esc(t(DEMO_ASK))}</div>
      <div class="ob-run-sum"><span>${esc(t(DEMO_RUN))}</span><span class="ob-dchip">+64</span>${IC.chev}</div>
      <div class="ob-answer" id="obDemoAnswer"></div>`
  }

  async function playDemo() {
    const run = ++demoRun
    const thread = byId('obThread')
    if (!thread) return
    thread.innerHTML = threadHtml()
    const answer = t(DEMO_ANSWER)
    const parts = [...thread.children]
    if (reducedMotion() || st.demoDone) {
      byId('obDemoAnswer').textContent = answer
      st.demoDone = true
      return
    }
    parts.forEach(part => { part.style.opacity = '0' })
    await sleep(500)
    for (const part of parts.slice(0, 2)) {
      if (run !== demoRun) return
      part.style.opacity = ''
      anim(part, { opacity: [0, 1], y: [6, 0] })
      await sleep(part.classList.contains('ob-bubble') ? 900 : 600)
    }
    if (run !== demoRun) return
    parts[2].style.opacity = ''
    const words = answer.split(' ')
    for (let i = 0; i < words.length; i++) {
      if (run !== demoRun || !byId('obDemoAnswer')) return
      byId('obDemoAnswer').textContent = words.slice(0, i + 1).join(' ')
      await sleep(55)
    }
    st.demoDone = true
  }

  // --- Экран ---

  function titleText(step = st.step) {
    if (step === 'hello') return t('Скажите, что нужно — onlyone сделает')
    if (step === 'done') return t('Приветствую в onlyone')
    const name = String(personal().name || '').trim()
    return name && STEPS.indexOf(step) > 1 ? t('Приятно познакомиться, %s', name) : t('Давайте познакомимся')
  }

  function keyConnected() {
    return st.key === 'ok' || (app().keysCount?.() || 0) > 0
  }

  function answersHtml() {
    const at = STEPS.indexOf(st.step)
    const before = name => STEPS.indexOf(name) < at
    const me = personal()
    const rows = []
    if (before('role')) {
      const role = (app().roles || []).find(([id]) => id === me.role)
      rows.push(['role', 'Занятие', role ? role[1] : '', !role])
    }
    if (before('focus')) {
      const focus = (app().focus || []).filter(([id]) => (me.focus || []).includes(id)).map(([, label]) => t(label))
      rows.push(['focus', 'Упор', focus.join(', '), !focus.length])
    }
    if (before('key')) {
      rows.push(['key', 'Модели', keyConnected() ? t('%s подключён', st.connected || providerInfo().title) : t('позже'), !keyConnected()])
    }
    if (before('theme')) {
      const theme = THEMES.find(([id]) => id === (me.theme || 'dark'))
      rows.push(['theme', 'Тема', t(theme ? theme[1] : 'Тёмная'), false])
    }
    return rows.map(([id, label, value, none]) => `
      <button type="button" class="ob-arow" data-edit="${id}">
        <span class="ob-arow-k">${esc(t(label))}</span><span class="ob-arow-v${none ? ' is-none' : ''}">${esc(value || '—')}</span>${IC.pen}
      </button>`).join('')
  }

  function bar(primary, quiet = '') {
    const n = ASK.indexOf(st.step)
    return `<div class="ob-card-bar">${n >= 0 ? `<span class="ob-count">${esc(t('%s из %s', n + 1, ASK.length))}</span>` : ''}<span class="ob-grow"></span>${quiet}${primary}</div>`
  }
  const nextBtn = (label, pri = true) => `<button type="button" class="ob-btn ob-next${pri ? ' is-pri' : ''}" data-go="next">${esc(t(label))}</button>`

  function keyCardHtml() {
    const info = providerInfo()
    const k = st.key
    const have = app().keysCount?.() || 0
    const typed = k === 'typed' || k === 'error'
    const canCheck = (typed || (info.keyOptional && k === 'empty')) && k !== 'checking'
    const status = k === 'checking'
      ? `<div class="ob-kstat" role="status"><span class="ob-spin" aria-hidden="true"></span>${esc(t('Проверяю подключение…'))}</div>`
      : k === 'ok' ? `<div class="ob-kstat is-ok" role="status">${IC.check}${esc(st.keyNote)}</div>`
      : k === 'error' ? `<div class="ob-kstat is-err" role="status" id="obKeyErr">${IC.warn}${esc(st.keyError)}</div>`
      : have && k === 'empty' ? `<div class="ob-kstat is-ok" role="status" id="obExistingKeys">${IC.check}${esc(t('Ключи уже добавлены'))}: ${have}</div>`
      : ''
    const check = k === 'ok' ? ''
      : `<button type="button" class="ob-btn${canCheck ? ' is-pri' : ''}" id="obKeyAdd" data-go="check"${canCheck ? '' : ' disabled'}>${esc(t('Проверить'))}</button>`
    // Одна залитая кнопка: пока есть что проверить, залита «Проверить».
    const primary = nextBtn(keyConnected() ? 'Дальше' : 'Позже', keyConnected() && !canCheck)
    const placeholder = info.keyPlaceholder || 'sk-or-v1-…'
    return `<p class="ob-q">${esc(t('Подключите модели'))} <span class="ob-q-note">${esc(t('Ключ шифруется и хранится на этом компьютере.'))}</span></p>
      <div class="ob-card-main">
        <div class="ob-key-row">
          <button type="button" class="ob-pill" id="obProvBtn" aria-haspopup="menu" aria-expanded="${st.menu}" aria-label="${esc(t('Провайдер'))}: ${esc(info.title)}">${esc(info.title)}</button>
          <span class="ob-fwrap"><label class="ob-sr" for="obKey">${esc(t('Ключ'))} ${esc(info.title)}</label><input class="ob-field" id="obKey" type="password" autocomplete="off" spellcheck="false"
            placeholder="${esc(placeholder)}" value="${esc(k === 'ok' ? '' : st.keyText)}"${k === 'checking' || k === 'ok' ? ' disabled' : ''}${k === 'error' ? ' aria-invalid="true" aria-describedby="obKeyErr"' : ''}>
            <button type="button" class="ob-eye" aria-label="${esc(t('Показать ключ'))}">${IC.eye}</button></span>
          ${check}
        </div>
        ${status}
        ${k === 'ok' || info.id !== 'openrouter' ? '' : `<div class="ob-key-help"><a class="ob-lnk link-external" href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">${esc(t('Где взять ключ — есть бесплатные модели'))}${IC.ext}</a></div>`}
      </div>
      ${bar(primary)}
      ${st.menu ? `<div class="ob-menu" role="menu" id="obProvMenu">${st.providers.map(item => `<button type="button" class="ob-mi" role="menuitemradio" aria-checked="${item.id === st.provider}" data-prov="${esc(item.id)}">${esc(item.title)}${item.id === st.provider ? IC.check : ''}</button>`).join('')}</div>` : ''}`
  }

  function cardHtml() {
    const s = st.step
    const me = personal()
    if (s === 'hello') return `<p class="ob-q">${esc(t('Сначала познакомимся — это минута.'))}</p>${bar(nextBtn('Начать'))}`
    if (s === 'name') {
      return `<label class="ob-q" for="obName">${esc(t('Как к вам обращаться?'))}</label>
        <div class="ob-card-main"><input class="ob-bare" id="obName" maxlength="60" autocomplete="off" spellcheck="false" placeholder="${esc(t('Имя'))}" value="${esc(me.name || '')}"></div>
        ${bar(nextBtn('Дальше'))}`
    }
    if (s === 'role') {
      // Роли всегда по-английски — так их называют и в работе.
      return `<p class="ob-q" id="obQRole">${esc(t('Чем занимаетесь?'))}</p>
        <div class="ob-card-main ob-chips" role="radiogroup" aria-labelledby="obQRole">${(app().roles || []).map(([id, label]) =>
          `<button type="button" class="ob-chip" role="radio" data-role="${id}" aria-checked="${me.role === id}">${esc(label)}</button>`).join('')}</div>
        ${bar(nextBtn('Дальше'))}`
    }
    if (s === 'focus') {
      const chosen = new Set(me.focus || [])
      return `<p class="ob-q" id="obQFocus">${esc(t('На чём упор?'))} <span class="ob-q-note">${esc(t('Можно несколько'))}</span></p>
        <div class="ob-card-main ob-chips" role="group" aria-labelledby="obQFocus">${(app().focus || []).map(([id, label]) =>
          `<button type="button" class="ob-chip" data-focus="${id}" aria-pressed="${chosen.has(id)}">${esc(t(label))}</button>`).join('')}</div>
        ${bar(nextBtn('Дальше'))}`
    }
    if (s === 'key') return keyCardHtml()
    if (s === 'theme') {
      const theme = me.theme || 'dark'
      return `<p class="ob-q" id="obQTheme">${esc(t('Какая тема удобнее?'))}</p>
        <div class="ob-card-main ob-tiles" role="radiogroup" aria-labelledby="obQTheme">${THEMES.map(([id, label]) =>
          `<button type="button" class="ob-tile" role="radio" data-theme-v="${id}" aria-checked="${theme === id}"><span class="ob-pv is-${id}"><span class="ob-pv-side"></span><span class="ob-pv-main"><i></i><i></i><i></i></span></span>${esc(t(label))}</button>`).join('')}</div>
        ${bar(nextBtn('Дальше'))}`
    }
    // Конец: карточка — уже строка ввода главного экрана. Подписи режима и
    // модели берутся из настоящей строки ввода, а не придумываются.
    const mode = document.getElementById('permModeLabel')?.textContent.trim() || 'Manual'
    const model = document.getElementById('pillModelName')?.textContent.trim() || ''
    const hint = t('Что сделать? Файл или ссылку можно просто вставить')
    return `<textarea class="ob-composer-text" id="obComposer" rows="1" aria-label="${esc(hint)}" placeholder="${esc(hint)}"></textarea>
      <div class="ob-card-bar"><button type="button" class="ob-cbtn" data-go="app" aria-label="${esc(t('Добавить к ходу'))}">${IC.plus}</button><span class="ob-cpill">${esc(mode)}</span><span class="ob-grow"></span>${model ? `<span class="ob-cpill">${esc(model)}</span>` : ''}<button type="button" class="ob-send" data-go="app" aria-label="${esc(t('Отправить'))}">${IC.up}</button></div>`
  }

  function summaryHtml() {
    return `${esc(t('Модель будет учитывать, кто вы и чем заняты. Поменять — в'))} <a class="ob-lnk" href="#" data-go="settings">${esc(t('Настройках'))}</a>.`
  }

  function paintStatic() {
    root.querySelector('.ob-skip').textContent = t('Пропустить')
    root.querySelectorAll('.ob-lang [data-lang]').forEach(button =>
      button.setAttribute('aria-checked', String(button.dataset.lang === (app().lang?.() || 'ru'))))
  }

  function paint() {
    const s = st.step
    root.classList.toggle('is-done', s === 'done')
    byId('obTitle').textContent = titleText()
    byId('obLead').hidden = s !== 'hello'
    byId('obLead').textContent = t('Код, дизайн, тексты, исследования. Модели работают на ваших ключах, а чаты остаются на этом компьютере.')
    byId('obThread').hidden = s !== 'hello'
    byId('obThread').setAttribute('aria-label', t('Пример работы'))
    byId('obAnswers').hidden = s === 'done'
    byId('obAnswers').innerHTML = s === 'done' ? '' : answersHtml()
    byId('obSummary').hidden = s !== 'done'
    byId('obSummary').innerHTML = s === 'done' ? summaryHtml() : ''
    byId('obCard').dataset.step = s
    byId('obCardIn').innerHTML = cardHtml()
    paintStatic()
    placeMenu()
  }

  function repaintCard() {
    byId('obCardIn').innerHTML = cardHtml()
    placeMenu()
  }

  function placeMenu() {
    const menu = byId('obProvMenu'), button = byId('obProvBtn')
    if (!menu || !button) return
    const count = menu.children.length
    menu.style.setProperty('--ob-cols', String(count > 16 ? 3 : count > 6 ? 2 : 1))
    const card = byId('obCard').getBoundingClientRect(), r = button.getBoundingClientRect()
    menu.style.left = (r.left - card.left) + 'px'
    // Вниз, если помещается; иначе над пилюлей — над карточкой места больше.
    const below = r.bottom + 4 + menu.offsetHeight <= window.innerHeight - 8
    menu.style.top = (below ? r.bottom - card.top + 4 : r.top - card.top - 4 - menu.offsetHeight) + 'px'
    anim(menu, { opacity: [0, 1], y: [-4, 0] }, { duration: 140 })
  }

  // Боковая панель приглушена и недоступна, пока идёт знакомство; в конце оживает.
  function setSidebarLive(live) {
    const side = document.querySelector('.sidebar')
    if (!side) return
    side.classList.toggle('ob-dim', !live)
    side.inert = !live
  }

  // --- Переход: ответ уходит вверх, вопрос встаёт на место строки ввода ---

  function go(next, { focus = true } = {}) {
    busy = busy.then(() => root && transition(next, focus)).catch(error => console.error('[onboarding] переход не удался', error))
    return busy
  }

  async function transition(next, focus) {
    if (next === st.step) { paint(); return }
    const card = byId('obCard'), cardIn = byId('obCardIn'), upper = byId('obUpper')
    // FIRST: где стоят знак, заголовок и строки.
    const first = new Map([...upper.children].filter(node => !node.hidden).map(node => [node, node.getBoundingClientRect().top]))
    const oldRows = new Map([...byId('obAnswers').children].map(row => [row.dataset.edit, row.getBoundingClientRect().top]))
    const h0 = card.offsetHeight
    const c0 = card.getBoundingClientRect().top
    const titleChanges = titleText(next) !== byId('obTitle').textContent
    // Заголовок с новым текстом уходит вместе с содержимым карточки, а не гаснет рывком.
    const leaving = [cardIn,
      ...(st.step === 'hello' ? [byId('obThread'), byId('obLead')] : []),
      ...(titleChanges ? [byId('obTitle')] : []),
      ...(next === 'done' ? [byId('obAnswers'), byId('obMark')] : [])]
    await Promise.all(leaving.map(node => anim(node, { opacity: [1, 0], y: [0, -4] }, { duration: 100, ease: EASE_IN })))
    if (!root) return
    if (!reducedMotion()) leaving.forEach(node => { node.style.opacity = '0' })
    st.step = next
    st.menu = false
    if (next !== 'hello') demoRun++
    paint()
    // Заголовок и искорка остаются погашенными до своего проявления: иначе
    // кадр с новым текстом мигнёт.
    leaving.forEach(node => { if (node.id !== 'obTitle' && node.id !== 'obMark') node.style.opacity = '' })
    if (!titleChanges) byId('obTitle').style.opacity = ''
    if (next !== 'done') byId('obMark').style.opacity = ''
    // LAST и обратно: всё, что осталось, едет со старого места на новое.
    const moves = []
    for (const node of [...upper.children].filter(n => !n.hidden)) {
      if (node.id === 'obAnswers' || (next === 'done' && node.id === 'obMark')) continue
      const was = first.get(node)
      if (was == null) { moves.push(anim(node, { opacity: [0, 1], y: [6, 0] }, { delay: 60 })); continue }
      const dy = was - node.getBoundingClientRect().top
      if (Math.abs(dy) > 0.5) moves.push(anim(node, { y: [dy, 0] }, { duration: 260 }))
    }
    for (const row of byId('obAnswers').children) {
      const was = oldRows.get(row.dataset.edit)
      if (was == null) moves.push(anim(row, { opacity: [0, 1], y: [6, 0] }, { delay: 20 }))
      else {
        const dy = was - row.getBoundingClientRect().top
        if (Math.abs(dy) > 0.5) moves.push(anim(row, { y: [dy, 0] }, { duration: 260 }))
      }
    }
    if (next === 'done') moves.push(bloom(byId('obMark')))
    if (titleChanges) moves.push(anim(byId('obTitle'), { opacity: [0, 1] }, { duration: 140, delay: next === 'done' ? 160 : 40 }))
    const h1 = card.offsetHeight
    const cdy = c0 - card.getBoundingClientRect().top
    const cardKf = {}
    if (h0 !== h1) cardKf.height = [h0 + 'px', h1 + 'px']
    if (Math.abs(cdy) > 0.5) cardKf.y = [cdy, 0]
    if (Object.keys(cardKf).length) moves.push(anim(card, cardKf))
    ;[...cardIn.querySelectorAll(':scope > *')].forEach((part, i) =>
      moves.push(anim(part, { opacity: [0, 1], y: [6, 0] }, { delay: 20 + i * 30 })))
    if (next === 'done') {
      setSidebarLive(true)
      moves.push(anim(document.querySelector('.sidebar'), { opacity: [0.45, 1] }, { delay: 100 }))
    } else setSidebarLive(false)
    byId('obLive').textContent = byId('obTitle').textContent
    if (focus) firstFocus()
    if (next === 'hello') playDemo()
    await Promise.all(moves)
  }

  function firstFocus() {
    const key = byId('obKey')
    const target = byId('obName') || (key && !key.disabled ? key : null) || byId('obComposer')
      || byId('obCardIn').querySelector('[aria-checked="true"], [aria-pressed="true"]')
      || byId('obCardIn').querySelector('.ob-chip, .ob-tile') || byId('obCardIn').querySelector('.ob-btn.is-pri')
      || byId('obCardIn').querySelector('.ob-next')
    target?.focus({ preventScroll: true })
  }

  function next() {
    const at = STEPS.indexOf(st.step)
    if (at < STEPS.length - 1) go(STEPS[at + 1])
  }

  // --- Ключ ---

  async function loadProviders() {
    try {
      const view = await window.electronAPI?.getCustomProvider?.()
      if (!root || !Array.isArray(view?.providers) || !view.providers.length) return
      st.providers = view.providers
      if (view.activeProvider && st.providers.some(item => item.id === view.activeProvider)) st.provider = view.activeProvider
      if (st.step === 'key' && st.key !== 'checking') repaintCard()
    } catch {}
  }

  function setProvider(id) {
    st.provider = id
    st.menu = false
    st.keyText = ''
    if (st.key !== 'ok') st.key = 'empty'
    repaintCard()
    byId('obProvBtn')?.focus()
  }

  async function checkKey() {
    const info = providerInfo()
    const key = st.keyText.trim()
    if (st.key === 'checking' || st.key === 'ok' || (!key && !info.keyOptional)) return
    const api = window.electronAPI
    st.key = 'checking'
    repaintCard()
    try {
      if (info.id === 'openrouter') {
        await api.addOpenRouterKey({ key })
        st.keyNote = t('Подключено')
      } else {
        const saved = await api.setCustomProvider({ provider: info.id, baseUrl: info.defaultBaseUrl, ...(key ? { key } : {}) })
        if (!saved?.ok) throw new Error(saved?.reason || t('Не удалось сохранить подключение'))
        const checked = await api.checkCustomProvider({ provider: info.id })
        if (!checked?.ok) throw new Error(checked?.reason || t('Не удалось получить список моделей'))
        const models = (checked.models || []).filter(item => item?.id)
        if (!models.length) throw new Error(t('У провайдера нет доступных моделей'))
        // Модель по умолчанию — первая из списка провайдера; сменить её можно
        // в строке ввода, как любую другую.
        const chosen = await api.setCustomProvider({ provider: info.id, model: models[0].id })
        if (!chosen?.ok) throw new Error(chosen?.reason || t('Не удалось выбрать модель'))
        const activated = await api.setActiveProvider(info.id)
        if (!activated?.ok) throw new Error(activated?.reason || t('Не удалось включить провайдера'))
        st.keyNote = t('Подключено. Модель по умолчанию — %s', models[0].name || models[0].id)
      }
      st.key = 'ok'
      st.keyText = ''
      st.connected = info.title
      await app().refreshKeys?.()
    } catch (error) {
      st.key = 'error'
      st.keyError = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    }
    if (!root || st.step !== 'key') return
    const card = byId('obCard')
    const h0 = card.offsetHeight
    repaintCard()
    anim(card, { height: [h0 + 'px', card.offsetHeight + 'px'] })
    anim(byId('obCardIn').querySelector('.ob-kstat'), { opacity: [0, 1], y: [4, 0] }, { duration: 200 })
    ;(st.key === 'ok' ? byId('obCardIn').querySelector('.ob-next') : byId('obKey'))?.focus()
  }

  // --- Тема и язык ---

  function setTheme(value) {
    const apply = () => {
      app().savePersonal?.({ theme: value })
      root?.querySelectorAll('[data-theme-v]').forEach(node => node.setAttribute('aria-checked', String(node.dataset.themeV === value)))
    }
    // Тема — перекрёстным растворением окна. Скрытое окно переход пропускает,
    // и тогда тема ставится сразу.
    if (!document.startViewTransition || reducedMotion() || document.visibilityState !== 'visible') { apply(); return }
    const fade = document.startViewTransition(apply)
    fade.updateCallbackDone.catch(apply)
    // Окно без отрисовки (свёрнутое, за другим) снимок не делает и держит
    // переход; выбор не ждёт кадра.
    setTimeout(() => { if (personal().theme !== value) fade.skipTransition() }, 150)
    // Пропущенный переход — не ошибка: тема уже стоит.
    fade.ready.catch(() => {})
    fade.finished.catch(() => {})
  }

  async function setLang(lang) {
    if (lang === app().lang?.()) return
    const swap = [byId('obUpper'), byId('obCardIn')]
    await Promise.all(swap.map(node => anim(node, { opacity: [1, 0] }, { duration: 80, ease: EASE_IN })))
    app().setLanguage?.(lang)
    if (!root) return
    const text = st.keyText
    paint()
    st.keyText = text
    if (st.step === 'hello') playDemo()
    swap.forEach(node => anim(node, { opacity: [0, 1] }, { duration: 140 }))
    firstFocus()
  }

  // --- Конец: первое слово уходит в настоящую строку ввода ---

  function handOff(text = '') {
    const box = document.getElementById('composerTextarea')
    finish()
    if (!box) return
    if (text) {
      box.value = text
      box.dispatchEvent(new Event('input', { bubbles: true }))
    }
    box.focus()
    box.setSelectionRange?.(box.value.length, box.value.length)
  }

  function openSettings() {
    finish()
    document.getElementById('openSettingsBtn')?.click()
    document.querySelector('#settingsModal [data-settings-tab="personal"]')?.click()
  }

  // --- События ---

  function onClick(event) {
    const target = event.target
    if (st.menu && !target.closest('#obProvMenu, #obProvBtn')) { st.menu = false; repaintCard() }
    const action = target.closest('[data-go]')
    if (action) {
      event.preventDefault()
      const goTo = action.dataset.go
      if (goTo === 'next') next()
      else if (goTo === 'check') checkKey()
      else if (goTo === 'app') handOff(byId('obComposer')?.value || '')
      else if (goTo === 'settings') openSettings()
      return
    }
    const role = target.closest('[data-role]')
    if (role) {
      // Повторное нажатие снимает выбор: вопрос не обязательный.
      const value = role.getAttribute('aria-checked') === 'true' ? '' : role.dataset.role
      root.querySelectorAll('[data-role]').forEach(node => node.setAttribute('aria-checked', String(node.dataset.role === value)))
      app().savePersonal?.({ role: value })
      return
    }
    const focus = target.closest('[data-focus]')
    if (focus) {
      focus.setAttribute('aria-pressed', String(focus.getAttribute('aria-pressed') !== 'true'))
      app().savePersonal?.({ focus: [...root.querySelectorAll('[data-focus][aria-pressed="true"]')].map(node => node.dataset.focus) })
      return
    }
    const edit = target.closest('[data-edit]')
    if (edit) { go(edit.dataset.edit); return }
    const tile = target.closest('[data-theme-v]')
    if (tile) { setTheme(tile.dataset.themeV); return }
    if (target.closest('#obProvBtn')) {
      st.menu = !st.menu
      repaintCard()
      if (st.menu) byId('obProvMenu')?.querySelector('[aria-checked="true"]')?.focus()
      return
    }
    const provider = target.closest('[data-prov]')
    if (provider) { setProvider(provider.dataset.prov); return }
    const eye = target.closest('.ob-eye')
    if (eye) {
      const field = byId('obKey')
      const shown = field.type === 'text'
      field.type = shown ? 'password' : 'text'
      eye.setAttribute('aria-label', t(shown ? 'Показать ключ' : 'Скрыть ключ'))
      return
    }
    const lang = target.closest('[data-lang]')
    if (lang) { setLang(lang.dataset.lang); return }
    if (target.closest('.ob-skip')) finish()
  }

  function onInput(event) {
    const target = event.target
    if (target.id === 'obName') app().savePersonal?.({ name: target.value.trim() })
    if (target.id === 'obKey') {
      st.keyText = target.value
      const was = st.key
      st.key = target.value.trim() ? 'typed' : 'empty'
      // Карточка перерисовывается, только когда меняется её вид: появилось
      // что проверять или ушла ошибка. Каретка остаётся на месте.
      if ((was === 'empty') !== (st.key === 'empty') || was === 'error') {
        const pos = target.selectionStart
        repaintCard()
        const field = byId('obKey')
        field.focus()
        field.setSelectionRange(pos, pos)
      }
    }
    if (target.id === 'obComposer' && target.value) handOff(target.value)
  }

  function onKey(event) {
    if (!root) return
    const target = event.target
    if (event.key === 'Escape') {
      // Esc ничего не пропускает: он только закрывает меню провайдера.
      if (st.menu) { st.menu = false; repaintCard(); byId('obProvBtn')?.focus() }
      if (root.contains(target)) event.stopPropagation()
      return
    }
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || !root.contains(target)) return
    if (target.id === 'obName') { event.preventDefault(); next() }
    else if (target.id === 'obKey') { event.preventDefault(); event.stopPropagation(); checkKey() }
    else if (target.id === 'obComposer') { event.preventDefault(); handOff(target.value) }
  }

  // Конец знакомства: боковая панель живая, клик по ней уводит в приложение.
  function onSidebarClick() {
    if (root && st.step === 'done') finish()
  }

  function open() {
    if (root) return
    returnFocus = document.activeElement
    st = { step: 'hello', demoDone: false, providers: [{ id: 'openrouter', title: 'OpenRouter' }], provider: 'openrouter',
      key: 'empty', keyText: '', keyNote: '', keyError: '', connected: '', menu: false }
    // Вступление встаёт в главную колонку окна; без неё (Ultra) — поверх окна
    // под строкой заголовка.
    const host = document.querySelector('.main-content')
    const inColumn = Boolean(host && host.offsetParent !== null)
    root = document.createElement('div')
    root.id = 'onboarding'
    root.className = 'ob' + (inColumn ? '' : ' is-fixed')
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'obTitle')
    if (!inColumn) root.style.top = (document.querySelector('.window-titlebar')?.offsetHeight || 0) + 'px'
    root.innerHTML = `
      <header class="ob-top">
        <div class="ob-seg ob-lang" role="radiogroup" aria-label="Язык / Language">
          <button type="button" role="radio" data-lang="ru">RU</button>
          <button type="button" role="radio" data-lang="en">EN</button>
        </div>
        <button type="button" class="ob-btn ob-skip"></button>
      </header>
      <div class="ob-stage">
        <div class="ob-upper" id="obUpper">
          ${MARK('ob-hero-mk').replace('<svg ', '<svg id="obMark" ')}
          <h1 class="ob-h1" id="obTitle"></h1>
          <p class="ob-lead" id="obLead"></p>
          <div class="ob-thread" id="obThread" role="group"></div>
          <div class="ob-answers" id="obAnswers"></div>
          <p class="ob-summary" id="obSummary" hidden></p>
        </div>
        <div class="ob-lower">
          <section class="ob-card ob-step" id="obCard"><div class="ob-card-in" id="obCardIn"></div></section>
        </div>
        <div></div>
      </div>
      <div class="ob-sr" aria-live="polite" id="obLive"></div>`
    // Всё, что под вступлением, гаснет для клавиатуры и экранного диктора.
    const behind = inColumn ? [...host.children] : [...document.body.children].filter(node => !node.classList.contains('window-titlebar'))
    dimmed = behind.filter(node => !node.inert)
    dimmed.forEach(node => { node.inert = true })
    ;(inColumn ? host : document.body).appendChild(root)
    setSidebarLive(false)
    root.addEventListener('click', onClick)
    root.addEventListener('input', onInput)
    document.addEventListener('keydown', onKey, true)
    document.querySelector('.sidebar')?.addEventListener('click', onSidebarClick, true)
    paint()
    playDemo()
    loadProviders()
    firstFocus()
    requestAnimationFrame(() => root?.classList.add('is-in'))
  }

  function finish() {
    write(DONE_KEY, '1')
    write(REV_KEY, REV)
    demoRun++
    if (!root) return
    const leaving = root
    root = null
    document.removeEventListener('keydown', onKey, true)
    document.querySelector('.sidebar')?.removeEventListener('click', onSidebarClick, true)
    dimmed.forEach(node => { node.inert = false })
    dimmed = []
    setSidebarLive(true)
    const done = () => leaving.remove()
    leaving.inert = true
    if (reducedMotion()) done()
    else {
      leaving.classList.add('is-out')
      leaving.addEventListener('transitionend', done, { once: true })
      setTimeout(done, 400)
    }
    renderSettingsEditions()
    const back = returnFocus && document.contains(returnFocus) && returnFocus !== document.body ? returnFocus : document.getElementById('composerTextarea')
    back?.focus()
  }

  // Кто и когда видит вступление — см. начало файла.
  function shouldOpen() {
    if (window.electronAPI?.automatedRun) return false
    const a = app()
    let follow = read(FOLLOW_KEY)
    if (follow === null) {
      // Первый запуск с этим правилом: профиль, где уже работали, — владельца и
      // тех, кто был до вступления; им показываем каждое новое вступление.
      const worked = (a.keysCount?.() || 0) || (a.chatsCount?.() || 0) || read(DONE_KEY)
      follow = worked ? '1' : '0'
      write(FOLLOW_KEY, follow)
    }
    if (follow === '1') return read(REV_KEY) !== REV
    return !read(DONE_KEY)
  }

  function init() {
    renderSettingsEditions()
    // Первый рендер мог случиться ДО того, как окно применило конфигурацию
    // (app.js читает её с моста асинхронно): карточки обязаны догнать профиль,
    // иначе Настройки показывали бы «onlyone», когда человек уже включил Ultra.
    void readUiConfig().then(() => renderSettingsEditions())
    // Версия меняется не только кликом по карточке — её пишет чат (7.2) и
    // «Сбросить вид». Рассылка `ui-config-changed` — тот же сигнал, что
    // перестраивает экран, значит им же сверяется и выбранность карточек.
    window.electronAPI?.onUiConfigChanged?.(config => {
      const cfg = asConfig(config)
      if (!cfg) return
      uiConfigKnown = cfg
      renderSettingsEditions(versionOf(cfg))
    })
    document.getElementById('showOnboardingBtn')?.addEventListener('click', () => {
      document.querySelector('#settingsModal [data-close="settingsModal"]')?.click()
      open()
    })
    document.getElementById('onboardingFollow')?.addEventListener('change', event => {
      write(FOLLOW_KEY, event.target.checked ? '1' : '0')
    })
    if (!shouldOpen()) return
    // Пустая история из-за потерянного ключа — не новый профиль: вступление
    // «сначала познакомимся» здесь соврало бы, а причину человеку уже называет
    // главный процесс (Н20). Спрашиваем до открытия, а не после.
    void historyUnreadable().then(unreadable => {
      if (unreadable) return
      if (read(FOLLOW_KEY) === '0' && !read(DONE_KEY) && systemLanguage() === 'en' && app().lang?.() !== 'en') app().setLanguage?.('en')
      open()
    })
  }

  // Отдаёт ли главный процесс целые, но не открывшиеся наборы (get-storage-status).
  async function historyUnreadable() {
    try {
      const status = await window.electronAPI?.getStorageStatus?.()
      const lost = Array.isArray(status?.unreadable) ? status.unreadable : []
      return lost.includes('conversations') || lost.includes('designs')
    } catch { return false }
  }

  function systemLanguage() {
    return /^(ru|uk|be|kk)\b/i.test(navigator.language || '') ? 'ru' : 'en'
  }

  window.onlyoneOnboarding = Object.freeze({ init, open, edition, renderSettingsEditions, EDITIONS, REV })
})()
