// Runs inside the renderer via ONECODE_SMOKE. Регрессии аудита 07.10.2026: вёрстка, которая
// наезжала, обрезалась без «…» или пропадала. Каждая проверка названа тем, что человек видит.
(async () => {
  const $ = id => document.getElementById(id)
  const checks = []
  const note = (name, pass, detail, skipped) => checks.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail), skipped: !!skipped })
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 8000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(80) }
    return false
  }
  const thrown = []
  window.addEventListener('error', e => thrown.push(String(e.message || e.error)))
  window.addEventListener('unhandledrejection', e => thrown.push('promise: ' + String(e.reason)))
  const rect = el => el && el.getBoundingClientRect()
  const shown = el => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' }
  const overlap = (a, b) => a && b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
  const hasCyr = s => /[А-Яа-яЁё]/.test(String(s || ''))
  const step = async (name, fn) => { try { await fn() } catch (e) { note(name + ' — шаг упал', false, String(e && e.message || e)) } }
  const resize = async (w, h) => { window.resizeTo(w, h); await until(() => Math.abs(innerWidth - w) < 40, 4000); await wait(500) }
  const runDone = () => !$('sendBtn').classList.contains('is-stop')
  const send = async text => { const b = $('composerTextarea'); b.value = text; b.dispatchEvent(new Event('input', { bubbles: true })); $('composerForm').requestSubmit() }
  const stopRun = async () => { if (!runDone()) { $('sendBtn').click(); await until(runDone, 15000) } }

  const booted = await until(() => $('messagesList') && $('composerTextarea') && $('splitViewBtn'))
  note('интерфейс загрузился', booted)
  if (!booted) return { ok: false, checks }
  await wait(1500)

  // ── 1. Проект: путь папки — подпись в строке списка, а не поле ввода ───────────
  await step('проект', async () => {
    $('navProjects').click(); await wait(500); $('newProjectBtn').click(); await wait(800)
    const f = $('projectFolderField')
    f.textContent = 'C:\\очень\\длинный\\путь\\к\\рабочей\\папке\\проекта\\который\\не\\помещается\\в\\строку\\карточки'
    await wait(100)
    const cs = getComputedStyle(f)
    note('путь папки проекта — подпись, а не рамка поля', cs.borderTopWidth === '0px' && cs.backgroundColor === 'rgba(0, 0, 0, 0)',
      `border ${cs.borderTopWidth}, фон ${cs.backgroundColor}`)
    note('длинный путь режется многоточием, а не обрубком', cs.textOverflow === 'ellipsis' && !/flex/.test(cs.display) && f.scrollWidth > f.clientWidth,
      `display ${cs.display}, ${f.scrollWidth}>${f.clientWidth}`)
    await resize(880, 600)
    note('при 880 px путь не налезает на «Сменить»', !overlap(rect(f), rect($('projectPickFolderBtn'))),
      JSON.stringify([rect(f).right, rect($('projectPickFolderBtn')).left].map(Math.round)))
    await resize(1240, 800)
    $('navChats').click(); await wait(500)
  })

  // ── 2. Панель «Работа» скрыта настройкой: места под неё не резервируется ──────
  await step('скрытая панель', async () => {
    document.documentElement.style.setProperty('--work-panel-display', 'none')
    $('newChatBtn').click(); await wait(400)
    await send('/agent ' + 'проверь потоковый ход '.repeat(6))
    await until(() => $('tasksPanel'), 20000)
    await wait(800)
    const mc = document.querySelector('.main-content')
    note('скрытая панель не оставляет мёртвую полосу справа', !document.body.classList.contains('tasks-open') && getComputedStyle(mc).marginRight === '0px',
      `tasks-open=${document.body.classList.contains('tasks-open')}, margin-right ${getComputedStyle(mc).marginRight}`)
    await until(runDone, 40000)
    document.documentElement.style.removeProperty('--work-panel-display')
  })

  // ── 3. Ход с панелью: фокус, тост, разметка ответа ────────────────────────────
  await step('ход с панелью', async () => {
    $('newChatBtn').click(); await wait(400)
    await send('/agent ' + 'проверь потоковый ход '.repeat(6))
    // Панель «Задачи» по макету 20.10 — шторка: открывается кнопкой в шапке
    if (!$('tasksPanel')) $('navTasks')?.click()
    await until(() => document.querySelector('#tasksPanel [data-tx="tab"]') && shown($('tasksPanel')), 20000)
    await wait(600)
    const mc = document.querySelector('.main-content')
    note('открытая панель по-прежнему отводит под себя место', document.body.classList.contains('tasks-open') && parseFloat(getComputedStyle(mc).marginRight) > 200,
      getComputedStyle(mc).marginRight)
    // фокус на кнопке панели переживает перерисовку панели во время хода
    const fold = document.querySelector('#tasksPanel [data-tx="tab"]')
    fold.focus()
    let kept = 0, total = 0
    for (let i = 0; i < 14; i++) {
      await wait(110); total++
      if (document.activeElement && document.activeElement.classList && document.activeElement.dataset?.tx === 'tab') kept++
    }
    note('фокус на кнопке панели не слетает при перерисовке во время хода', kept >= total - 1, `${kept} из ${total}`)
    await until(runDone, 40000)
    await wait(800)

    // разметка ответа
    const msg = [...document.querySelectorAll('#messagesList .msg-item.assistant .msg-content')].pop()
    const text = msg ? msg.innerHTML : ''
    note('ответ с картинкой по ссылке пришёл', Boolean(msg) && /Картинка по ссылке/.test(msg.textContent), msg ? msg.textContent.slice(0, 80) : 'нет ответа')
    const imgs = msg ? [...msg.querySelectorAll('img')] : []
    note('внешняя картинка не рисуется битой иконкой', imgs.every(i => !/^https?:/i.test(i.getAttribute('src') || '')), `img: ${imgs.length}`)
    note('вместо картинки остаётся ссылка с подписью', Boolean(msg) && [...msg.querySelectorAll('a')].some(a => /схема/.test(a.textContent)), 'ссылок: ' + (msg ? msg.querySelectorAll('a').length : 0))
    const boxes = msg ? [...msg.querySelectorAll('.md-check')] : []
    note('у пунктов «- [ ]» и «- [x]» есть отметки', boxes.length === 2 && boxes.filter(b => b.classList.contains('is-checked')).length === 1,
      `отметок ${boxes.length}, отмеченных ${boxes.filter(b => b.classList.contains('is-checked')).length}`)

    // шапка и тост
    const title = $('chatHeaderTitle')
    const tcs = getComputedStyle(title)
    note('название чата режется многоточием (блок, а не flex)', !/flex/.test(tcs.display) && tcs.textOverflow === 'ellipsis', `display ${tcs.display}`)
    const copy = [...document.querySelectorAll('#messagesList .msg-item.assistant [data-act="copy"]')].pop()
    if (copy) {
      copy.click(); await wait(400)
      const toast = document.querySelector('.toast-box.show')
      const panel = $('tasksPanel')
      note('тост виден', Boolean(toast), toast ? toast.textContent : 'нет тоста')
      note('тост не лежит поверх панели «Работа»', Boolean(toast) && shown(panel) && !overlap(rect(toast), rect(panel)),
        toast && panel ? JSON.stringify([rect(toast), rect(panel)].map(r => [r.left, r.right].map(Math.round))) : '')
    } else note('кнопка копирования есть', false)
  })

  // ── 4. Браузер рядом с панелью «Работа»: чату остаётся место ─────────────────
  await step('браузер и панель', async () => {
    const feedW = () => Math.round(rect($('chatFeed')).width)
    $('openBrowserBtn').click(); await wait(900)
    // Ширина ленты меряется после того, как панели осели: под нагрузкой общего прогона анимация идёт дольше 900 мс.
    await until(() => feedW() >= 340, 4000)
    note('чат с браузером и панелью не уже 340 px (1240)', feedW() >= 340, 'лента ' + feedW() + ' px')
    note('панели не лежат друг на друге (1240)', !overlap(rect($('tasksPanel')), rect($('artifactPanel'))) || !shown($('tasksPanel')), '')
    const comp = document.querySelector('.composer-container')
    note('поле ввода целиком левее браузера (1240)', rect(comp).right <= rect($('artifactPanel')).left + 1, JSON.stringify([rect(comp).right, rect($('artifactPanel')).left].map(Math.round)))
    await resize(880, 600)
    note('чат с браузером и панелью не уже 340 px (880)', feedW() >= 340, 'лента ' + feedW() + ' px')
    note('поле ввода целиком левее браузера (880)', rect(comp).right <= rect($('artifactPanel')).left + 1, JSON.stringify([rect(comp).right, rect($('artifactPanel')).left].map(Math.round)))
    $('openBrowserBtn').click(); await wait(600)
    // строка действий последнего ответа не прячется под полем ввода
    const feed = $('chatFeed'); feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' }); await wait(500)
    const last = [...document.querySelectorAll('#messagesList .msg-item.assistant [data-act="copy"]')].pop()
    note('строка действий ответа не под полем ввода (880)', Boolean(last) && rect(last).bottom <= rect(comp).top + 1,
      last ? `низ кнопок ${Math.round(rect(last).bottom)}, верх поля ${Math.round(rect(comp).top)}` : 'нет кнопок')
    const h = $('chatHeaderTitle')
    note('название чата при 880 не налезает на соседние кнопки', !overlap(rect(h), rect(document.querySelector('.chat-header-actions'))), '')
    // Ход при 880 px: подсказка следующего запроса вырастает до двух строк уже ПОСЛЕ ответа.
    // Лента сжимается, и строка действий ответа не должна уйти за её нижний край.
    $('newChatBtn').click(); await wait(400)
    await send('/agent ' + 'проверь потоковый ход '.repeat(6))
    await until(() => !runDone(), 15000)
    await until(runDone, 60000)
    await wait(3000)
    const copyNow = [...document.querySelectorAll('#messagesList .msg-item.assistant [data-act="copy"]')].pop()
    const compNow = document.querySelector('.composer-container')
    note('строка действий ответа не за краем ленты после роста поля ввода (880)', Boolean(copyNow) && rect(copyNow).bottom <= rect(compNow).top + 1,
      copyNow ? `низ кнопок ${Math.round(rect(copyNow).bottom)}, верх поля ${Math.round(rect(compNow).top)}, placeholder ${$('composerTextarea').placeholder.length} зн.` : 'нет кнопок')
    await resize(1240, 800)
  })

  // ── 5. Английский: русские куски в подписях ───────────────────────────────────
  await step('английский', async () => {
    const sel = $('languageSelect'); sel.value = 'en'; sel.dispatchEvent(new Event('change', { bubbles: true })); await wait(1000)
    $('sidebarToggle').click(); await wait(400)
    const lab = $('sidebarToggle').getAttribute('aria-label') + ' | ' + $('sidebarToggle').getAttribute('data-tooltip')
    note('подпись кнопки боковой панели по-английски после сворачивания', !hasCyr(lab), lab)
    $('sidebarToggle').click(); await wait(400)
    const lab2 = $('sidebarToggle').getAttribute('aria-label') + ' | ' + $('sidebarToggle').getAttribute('data-tooltip')
    note('подпись кнопки боковой панели по-английски после разворачивания', !hasCyr(lab2), lab2)
    $('modelModal').style.display = 'flex'; await wait(900)
    const badge = $('modelCountBadge').textContent
    note('счётчик моделей по-английски', !hasCyr(badge), badge)
    const unav = [...document.querySelectorAll('#modelModal .pill-price.unavailable')]
    note('метка «недоступна» по-английски', unav.every(p => !hasCyr(p.textContent) && !hasCyr(p.getAttribute('data-tooltip'))),
      unav.length ? unav[0].textContent + ' | ' + unav[0].getAttribute('data-tooltip') : 'недоступных моделей нет', !unav.length)
    $('modelModal').style.display = 'none'
    $('contextRingBtn').click(); await wait(500)
    const left = $('contextPanelLeft').textContent
    note('остаток контекста по-английски', !hasCyr(left), left)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(200)
    sel.value = 'ru'; sel.dispatchEvent(new Event('change', { bubbles: true })); await wait(800)
  })

  // ── 6. Ultra: заголовок чата не лежит на кнопках Workspace ───────────────────
  await step('ultra', async () => {
    $('openSettingsBtn').click(); await wait(500)
    document.querySelector('[data-settings-tab="appearance"]').click(); await wait(500)
    const card = [...document.querySelectorAll('#panel-appearance label, #panel-appearance [role="radio"], #panel-appearance button, #panel-appearance div')]
      .find(c => /onlyone Ultra/.test(c.textContent || '') && (c.textContent || '').length < 200)
    if (!card) { note('карточка Ultra найдена', false); return }
    card.click(); await wait(1200)
    document.querySelectorAll('.modal-backdrop').forEach(m => { m.style.display = 'none' }); await wait(1200)
    const ns = [...document.querySelectorAll('button')].find(b => /Новая сессия/.test(b.textContent || '')); if (ns) ns.click(); await wait(900)
    const ta = [...document.querySelectorAll('textarea')].find(shown)
    ta.focus(); ta.value = '/agent проверь потоковый ход'; ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await wait(300); if (ta.form && runDone()) ta.form.requestSubmit()
    await until(() => document.querySelector('.ultra.is-chat') && $('tasksPanel'), 20000)
    await wait(1500)
    const t = $('chatHeaderTitle'); const ws = [...document.querySelectorAll('.ub-ws')]
    note('Ultra: кнопки Workspace есть', ws.length === 2, ws.length)
    note('Ultra: заголовок чата не лежит на кнопках Workspace', ws.every(b => !overlap(rect(t), rect(b))) && rect(t).left >= Math.max(...ws.map(b => rect(b).right)) - 1,
      JSON.stringify([rect(t).left, ...ws.map(b => rect(b).right)].map(Math.round)))
    const mc = document.querySelector('.main-content')
    note('Ultra: экран не сдвинут пустой полосой справа', getComputedStyle(mc).marginRight === '0px' && Math.round(rect(mc).right) === innerWidth,
      `margin-right ${getComputedStyle(mc).marginRight}, правый край ${Math.round(rect(mc).right)} из ${innerWidth}`)
    await until(runDone, 40000)
  })

  note('в консоли окна не было необработанных ошибок', thrown.length === 0, thrown.slice(0, 3).join(' | '))
  const failed = checks.filter(c => !c.pass && !c.skipped)
  return { ok: failed.length === 0, checks }
})()
