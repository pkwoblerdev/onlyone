// Внутри окна через ONECODE_SMOKE (запуск — tests/run-look-ui.cjs). Сверяет устройство
// экранов с макетом audits/ui-2026-10-18/onlyone-mockup.html и снимает каждый экран
// в тёмной и светлой теме (document.title = 'SNAP:<путь>' — кадр снимает главный процесс).
(async () => {
  const ARG = JSON.parse('__ONECODE_ARG__' || '{}')
  const $ = id => document.getElementById(id)
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
  const checks = []
  const thrown = []
  window.addEventListener('error', e => thrown.push(String(e.message || e.error)))
  window.addEventListener('unhandledrejection', e => thrown.push('promise: ' + String(e.reason)))
  const note = (name, pass, detail) => checks.push({ name, pass: pass === true, detail: pass === true ? '' : JSON.stringify(detail === undefined ? pass : detail).slice(0, 400) })
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 8000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(100) } return false }
  const visible = el => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const c = getComputedStyle(el); return c.visibility !== 'hidden' && c.display !== 'none' && Number(c.opacity) > 0 }
  const rgb = c => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
  const lum = c => { const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(.*, 0\)|transparent/.test(c)) return c } return getComputedStyle(document.body).backgroundColor }
  const contrast = el => { const a = lum(getComputedStyle(el).color), b = lum(bgOf(el)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
  const click = el => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) }
  const press = (key, target = document.activeElement || document.body, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
  const type = (el, text) => { el.focus(); el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })) }
  const setTheme = theme => { document.documentElement.dataset.theme = theme }
  const want = name => !ARG.only || ARG.only.split(',').includes(name)
  // Кадр: тема в имени, затем ширина окна — как папки кадров макета
  const snap = async name => {
    if (!ARG.shots) return
    await wait(350)
    document.title = 'SNAP:' + ARG.shots + '/' + (document.documentElement.dataset.theme || 'dark') + '-' + ARG.width + '/' + name + '.png'
    await wait(450)
    document.title = 'onlyone'
  }
  const twoThemes = async (name, prepare) => {
    for (const theme of ['dark', 'light']) { setTheme(theme); if (prepare) await prepare(theme); await snap(name) }
    setTheme('dark')
  }
  // Сколько залитых кнопок видно в разделе: в макете одна на экран
  const filled = root => $$('.btn-primary, .btn.pri, .ui-button.primary', root).filter(visible).length

  try {
    const booted = await until(() => document.documentElement.dataset.appReady === '1', 30000)
    note('окно загрузилось', booted)
    if (!booted) return { ok: false, checks, thrown }
    // Вступление не переносится и в проверках не участвует
    if ($('onboarding') && !$('onboarding').hidden) { $('onboarding').querySelector('.ob-skip')?.click(); await wait(700) }

    // ── Каркас ──
    if (want('base')) {
      $('newChatBtn')?.click(); await wait(500)
      note('фон окна тёплый графит #1c1917', getComputedStyle(document.body).backgroundColor === 'rgb(28, 25, 23)' || getComputedStyle(document.querySelector('.app-container')).backgroundColor === 'rgb(28, 25, 23)', getComputedStyle(document.body).backgroundColor)
      const badges = ['projectsBadge', 'skillsBadge', 'designBadge', 'mcpBadge'].filter(id => visible($(id)))
      note('у разделов в боковой панели нет счётчиков', badges.length === 0, badges)
      note('аватара пользователя нет', !visible(document.querySelector('.sidebar-user-avatar')))
      const branch = ['chatHeaderBranch', 'heroBranch'].filter(id => $(id))
      note('ветки git нет нигде: ни в шапке, ни на главном экране', branch.length === 0, branch)
      note('на главном экране одна залитая кнопка или ни одной', filled($('chatView')) <= 1, filled($('chatView')))
      const dots = $$('.sidebar *, .chat-header *').filter(e => e.children.length === 0 && visible(e) && /·/.test(e.textContent)).map(e => e.textContent.trim())
      note('в боковой панели и шапке нет «·»', dots.length === 0, dots)
      await twoThemes('home')
    }
    // ── Скиллы: список, страница скилла, «Новый скилл» (макет 21.10) ──
    if (want('skills')) {
      const focusTrace = []
      document.addEventListener('focusin', e => { if (e.target.id === 'composerTextarea') focusTrace.push(new Error().stack.split(/\n/).slice(2, 7).join(' | ')) }, true)
      const api = window.electronAPI
      await api.importSkillPack({ path: ARG.pack })
      await api.addSkill({ id: 'skill_1760000000000', name: 'Тексты интерфейса', description: 'Заглавная только в начале фразы, без канцелярита, кавычки-ёлочки', systemPrompt: '# Тексты интерфейса\n\n- Заглавная только в начале фразы', enabled: false })
      $('navSkills').click()
      await until(() => document.querySelector('#skillsView .sk'), 6000)
      const view = $('skillsView')
      const groups = $$('#skillsView .grp').map(g => g.textContent)
      note('скиллы: заголовок, поиск и одна залитая «Новый скилл»', /Скиллы/.test(view.querySelector('.page-head h1')?.textContent) && Boolean(view.querySelector('.search .field')) && filled(view) === 1 && $('addSkillBtn')?.classList.contains('btn-primary'), { h1: view.querySelector('.page-head h1')?.textContent, filled: filled(view) })
      note('скиллы: группы «В проекте …» и «Ваши»', groups.some(g => /В проекте workspace/.test(g)) && groups.some(g => /^Ваши/.test(g)), groups)
      const bad = $$('#skillsView .sk.bad')
      note('скиллы: сломанный — значок, причина со строкой, «Открыть файл» вместо переключателя', bad.length === 1 && /description/.test(bad[0].textContent) && /строка 3/.test(bad[0].textContent) && !bad[0].querySelector('.switch') && Boolean(bad[0].querySelector('[data-x="skfile"]')), bad.map(b => b.textContent))
      note('скиллы: у строки только переключатель, подписи «ещё не брал» нет', $$('#skillsView .sk:not(.bad)').every(r => !r.querySelector('.sk-used') && r.querySelector('.switch[role="switch"]')))
      await twoThemes('skills')
      const flt = $$('#skillsView [data-x="skflt"]').find(b => b.dataset.v === 'project')
      flt?.click(); await wait(300)
      const shown = $$('#skillsView [data-g]').filter(g => !g.hidden).map(g => g.dataset.g)
      note('скиллы: фильтр «Проект» оставляет одну группу', Boolean(flt) && shown.length === 1 && shown[0] === 'project', shown)
      $$('#skillsView [data-x="skflt"]')[0].click(); await wait(200)
      const s = view.querySelector('[data-search]'); type(s, 'корзин'); await wait(200)
      note('скиллы: поиск находит по названию', $$('#skillsView .sk').filter(r => !r.hidden).length === 1)
      type(s, 'ничего такого нет'); await wait(200)
      note('скиллы: ничего не нашлось — отдельная фраза с запросом', !view.querySelector('.sk-none').hidden && /ничего такого нет/.test(view.querySelector('.sk-none').textContent))
      await twoThemes('skills-none')
      type(s, ''); await wait(200)

      // Страница скилла
      $$('#skillsView .sk-link').find(l => /Ревью перед коммитом/.test(l.textContent)).click(); await wait(500)
      const p = view.querySelector('.skp')
      note('скилл: страница, а не окно; «← Скиллы», имя заголовком', Boolean(p) && !document.querySelector('.modal-backdrop[style*="flex"]') && Boolean(p?.querySelector('[data-x="skback"]')) && /Ревью перед коммитом/.test(p?.querySelector('h1')?.textContent))
      const meta = p?.querySelector('.skp-meta')?.textContent || ''
      note('скилл: подпись без «·», переключатель и «Ещё»', !/·/.test(meta) && /Ваш/.test(meta) && Boolean(p?.querySelector('.skp-head .switch')) && Boolean(p?.querySelector('[data-x="skmore"]')), meta)
      const tabs = $$('#skillsView .skp-tab')
      note('скилл: вкладки «Обзор» и «Содержимое 3»', tabs.length === 2 && /Обзор/.test(tabs[0].textContent) && /Содержимое\s*3/.test(tabs[1].textContent) && tabs[0].getAttribute('aria-selected') === 'true', tabs.map(x => x.textContent))
      const panel = view.querySelector('#skp-panel').textContent
      note('скилл: обзор — когда брать, где лежит, автор, что даёт агенту со скриптом', ['Когда брать', 'Где лежит', 'Автор', 'Что даёт агенту', 'run-checks.ps1'].every(x => panel.includes(x)), panel.slice(0, 200))
      await twoThemes('skill-over')
      tabs[1].click(); await wait(400)
      const dirBtn = view.querySelector('[data-x="skdir"]')
      const before = $$('#skillsView .pk-file[data-f]').length
      dirBtn?.click(); await wait(250)
      const dir2 = view.querySelector('[data-x="skdir"]')
      note('скилл: дерево файлов, папка сворачивается, фокус на ней', Boolean(dir2) && dir2.getAttribute('aria-expanded') === 'false' && document.activeElement === dir2 && $$('#skillsView .pk-file[data-f]').length === before - 1, { before, after: $$('#skillsView .pk-file[data-f]').length })
      dir2?.click(); await wait(250)
      view.querySelector('.pk-file[data-f="reference.md"]').click(); await wait(400)
      note('скилл: файл открывается справа, путь сверху', /reference\.md/.test(view.querySelector('.pk-vhead').textContent) && view.querySelector('.pk-file[data-f="reference.md"]').getAttribute('aria-current') === 'true')
      view.querySelector('.pk-file[data-f="SKILL.md"]').click(); await wait(400)
      view.querySelector('[data-x="skview"][data-v="raw"]').click(); await wait(200)
      note('скилл: исходник SKILL.md — с шапкой', /^---\nname:/.test(view.querySelector('.pk-doc').textContent), view.querySelector('.pk-doc').textContent.slice(0, 40))
      await twoThemes('skill-files')
      view.querySelector('[data-x="skedit"]').click(); await wait(250)
      const ta = view.querySelector('textarea.pk-edit'), sv = view.querySelector('[data-x="sksave"]')
      const e1 = [document.activeElement === ta, sv?.disabled === true]
      ta.value += '\n- Новая строка'; ta.dispatchEvent(new Event('input', { bubbles: true })); await wait(100)
      e1.push(!view.querySelector('[data-x="sksave"]').disabled)
      await twoThemes('skill-edit')
      view.querySelector('[data-x="sksave"]').click(); await wait(700)
      e1.push(!view.querySelector('textarea.pk-edit'), /сохран/i.test($('toastNotification')?.textContent || ''), /Новая строка/.test(view.querySelector('.pk-doc')?.textContent || ''))
      note('скилл: «Изменить» — правка, «Сохранить» после изменения, «Вернуть»', e1.every(Boolean) && /Вернуть/.test($('toastNotification')?.textContent || ''), e1)
      view.querySelector('.skp-head .switch').click(); await wait(500)
      view.querySelector('[data-x="skback"]').click(); await wait(500)
      const row = $$('#skillsView .sk').find(r => /Ревью перед коммитом/.test(r.textContent))
      note('скилл: выключили в шапке — список помнит, фокус на имени', row?.dataset.on === 'false' && /Ревью перед коммитом/.test(document.activeElement?.textContent || ''), { on: row?.dataset.on, focus: document.activeElement?.textContent })
      $$('#skillsView .sk.bad [data-x="skfile"]')[0].click(); await wait(500)
      note('скилл проекта, сломанный: «Открыть файл» ведёт в содержимое, переключатель недоступен', view.querySelector('.skp-tab[data-v="files"]')?.getAttribute('aria-selected') === 'true' && view.querySelector('.skp-head .switch')?.disabled === true)
      view.querySelector('[data-x="sktab"][data-v="over"]').click(); await wait(300)
      note('скилл проекта: на обзоре — плашка с причиной', /Агент не видит этот скилл/.test(view.querySelector('.skp-err')?.textContent || ''))
      view.querySelector('[data-x="skback"]').click(); await wait(400)

      // Новый скилл
      $('addSkillBtn').click(); await wait(500)
      const n = view.querySelector('.skn'), ways = $$('#skillsView [data-x="snm"]')
      note('новый скилл: страница, четыре способа, окна нет', Boolean(n) && !$('addSkillModal') && ways.length === 4 && ways[0].getAttribute('aria-current') === 'true' && ['Из файла', 'С onlyone', 'Импорт', 'Вручную'].every((x, i) => ways[i]?.textContent.includes(x)), ways.map(w => w.textContent))
      note('новый скилл: зона — .md .txt .pdf .docx', /\.docx/.test(view.querySelector('.np-drop')?.textContent) && /\.pdf/.test(view.querySelector('.np-drop')?.textContent))
      await twoThemes('skill-new')
      view.querySelector('[data-x="snfile"]').click()
      await until(() => view.querySelector('.skn-rec'), 6000)
      const rec = view.querySelector('.skn-rec')
      note('из файла: что распознано, поля заполнены, превью SKILL.md', Boolean(rec) && /release-checklist\.docx/.test(rec.textContent) && view.querySelector('#snName').value === 'Чек-лист релиза' && /пройти проверки/.test(view.querySelector('#snWhen').value) && $$('#skillsView .skn-found li').length >= 3 && $$('#skillsView .skn-found li[data-s="warn"]').length === 1, rec?.textContent.slice(0, 300))
      view.querySelector('[data-x="snview"][data-v="raw"]').click(); await wait(200)
      note('из файла: исходник с шапкой name и description', /^---\nname: Чек-лист релиза\ndescription: /.test(view.querySelector('#snPrev .pk-doc').textContent))
      await twoThemes('skill-new-file')
      view.querySelector('[data-seg="snwhere"] [data-v="user"]').click()
      view.querySelector('[data-x="snsave"]').click(); await wait(900)
      note('из файла: «Создать скилл» — в списке, «Вернуть»', !view.querySelector('.skn') && $$('#skillsView .sk-link').some(l => l.textContent === 'Чек-лист релиза') && /Вернуть/.test($('toastNotification')?.textContent || ''), $('toastNotification')?.textContent)
      $('addSkillBtn').click(); await wait(400)
      view.querySelector('[data-x="snm"][data-v="agent"]').click(); await wait(300)
      type(view.querySelector('#snAsk'), 'Проверять тексты интерфейса перед релизом')
      view.querySelector('[data-x="snstart"]').click()
      await until(() => $$('#skillsView .skn-q').length, 6000)
      const qs = $$('#skillsView .skn-q')
      note('с onlyone: два вопроса с готовыми ответами', qs.length === 2 && qs.every(q => q.querySelectorAll('[data-x="snans"]').length >= 2), qs.map(q => q.textContent))
      qs.forEach(q => q.querySelector('[data-x="snans"]').click()); await wait(150)
      await twoThemes('skill-new-agent')
      view.querySelector('[data-x="sndraft"]').click()
      await until(() => view.querySelector('.skn-draft'), 6000)
      note('с onlyone: черновик с полями, превью и «Переделать», создать можно', view.querySelector('#snName')?.value === 'Тексты перед релизом' && Boolean(view.querySelector('.skn-draft .pk-doc')) && Boolean(view.querySelector('[data-x="snredo"]')) && !view.querySelector('[data-x="snsave"]').disabled)
      await twoThemes('skill-new-draft')
      view.querySelector('[data-x="snm"][data-v="zip"]').click(); await wait(300)
      view.querySelector('[data-x="snzip"]').click()
      await until(() => $$('#skillsView .skn-chk li').length, 6000)
      const li = $$('#skillsView .skn-chk li'), badLi = li.filter(x => x.dataset.s === 'bad')
      note('импорт: проверка шапки — ошибка со строкой, скрипт — согласие, «Импортировать» недоступна', badLi.length === 1 && /description/.test(badLi[0].textContent) && /строка 3/.test(badLi[0].textContent) && li.some(x => x.dataset.s === 'info' && /deploy\.ps1/.test(x.textContent)) && view.querySelector('[data-x="snsave"]').disabled, li.map(x => x.dataset.s + ':' + x.textContent))
      await twoThemes('skill-new-zip')
      type(view.querySelector('#snFix'), 'Выкатывает ветку на staging'); await wait(200)
      note('импорт: дописали description — ошибка ушла, импорт доступен', !view.querySelector('.skn-chk li[data-s="bad"]') && !view.querySelector('[data-x="snsave"]').disabled)
      view.querySelector('[data-seg="snwhere"] [data-v="user"]').click()
      view.querySelector('[data-x="snsave"]').click(); await wait(900)
      note('импорт: «Импортировать» — скилл в списке', !view.querySelector('.skn') && $$('#skillsView .sk-link').some(l => l.textContent === 'Выкатка на staging') && /импортирован/i.test($('toastNotification')?.textContent || ''), $('toastNotification')?.textContent)
      $('addSkillBtn').click(); await wait(400)
      view.querySelector('[data-x="snm"][data-v="md"]').click(); await wait(300)
      view.querySelector('[data-x="snsave"]').click(); await wait(250)
      note('вручную: пустое не создать — ошибки у трёх полей', ['snNameErr', 'snWhenErr', 'snTextErr'].every(id => /\S/.test(view.querySelector('#' + id)?.textContent || '')) && Boolean(view.querySelector('.skn')))
      await twoThemes('skill-new-md-err')
      type(view.querySelector('#snText'), '---\nname: Ревью SQL\ndescription: Перед миграцией проверить индексы\n---\n\n# Ревью SQL\n\n- EXPLAIN на каждый запрос'); await wait(150)
      note('вручную: вставленная шапка расходится по полям', view.querySelector('#snName').value === 'Ревью SQL' && /индексы/.test(view.querySelector('#snWhen').value))
      view.querySelector('[data-x="snback"]').click(); await wait(300)
      note('«← Скиллы» возвращает к списку и фокус на «Новый скилл»', !view.querySelector('.skn') && document.activeElement?.id === 'addSkillBtn', [document.activeElement?.id, focusTrace])
    }
    // ── Проекты: список слева, подробности справа, «Новый проект» на месте (макет 21.10) ──
    if (want('projects')) {
      $('navProjects').click(); await wait(500)
      const view = $('projectsView')
      note('проекты: пусто — знак, одна фраза и «Новый проект»', /Проектов пока нет/.test(view.querySelector('.state h2')?.textContent || '') && Boolean($('newProjectBtn')))
      await twoThemes('projects-empty')
      $('newProjectBtn').click(); await wait(500)
      const f = view.querySelector('.pjn'), d = view.querySelector('.pj-item.draft')
      note('новый проект: форма справа и строка черновика слева, окна нет', Boolean(f) && d?.getAttribute('aria-current') === 'true' && !document.querySelector('.modal-backdrop[style*="flex"]') && document.activeElement?.id === 'projectNameField' &&
        ['projectDescField', 'projectGoalField', 'npPlanIn', 'npDir'].every(id => f.querySelector('#' + id)) && Boolean(f.querySelector('.np-drop')), { f: Boolean(f), d: d?.outerHTML?.slice(0, 80), focus: document.activeElement?.id })
      const nm = $('projectNameField'), goalF = $('projectGoalField')
      note('название — заголовок: крупнее полей, первое в форме', parseFloat(getComputedStyle(nm).fontSize) >= 20 && parseFloat(getComputedStyle(nm).fontSize) > parseFloat(getComputedStyle(goalF).fontSize) && f.querySelector('input, textarea, button.field') === nm)
      await twoThemes('proj-new')
      f.requestSubmit(); await wait(250)
      note('пустую форму не создать: ошибки у названия и папки', /\S/.test($('projectNameFieldErr').textContent) && /\S/.test($('npDirErr').textContent) && Boolean(view.querySelector('.pjn')) && document.activeElement?.id === 'projectNameField')
      await twoThemes('proj-new-err')
      type(nm, 'Скорость API'); await wait(100)
      note('имя из заголовка сразу в строке черновика', /Скорость API/.test(view.querySelector('.pj-item.draft .pj-name').textContent))
      view.querySelector('[data-x="npdir"]').click(); await wait(500)
      note('«Выбрать…» ставит папку, имя не трогает', /workspace/.test($('projectFolderField').textContent) && nm.value === 'Скорость API' && !/\S/.test($('npDirErr').textContent) && /workspace/.test(view.querySelector('.pj-item.draft .pj-sub').textContent))
      const pin = $('npPlanIn')
      for (const v of ['Замерить p95 по ручкам', 'Кэш для /catalog']) { pin.value = v; press('Enter', pin); await wait(120) }
      const n2 = $$('#projectsView .pjn-plans li').length
      view.querySelector('.pjn-plans li:last-child [data-x="npplandel"]').click(); await wait(120)
      note('планы: Enter добавляет шаг, крестик убирает', n2 === 2 && $$('#projectsView .pjn-plans li').length === 1, n2)
      view.querySelector('[data-x="npctx"]').click(); await wait(500)
      note('база знаний: файл плиткой', $$('#projectsView .np-files .np-file').length === 1 && /latency-report\.md/.test(view.querySelector('.np-files').textContent))
      note('GitHub не подключён — плашка «Подключить GitHub» и крестик', Boolean(view.querySelector('.np-gh [data-x="npghon"]')) && Boolean(view.querySelector('.np-gh [data-x="npghx"]')))
      type(goalF, 'p95 ниже 200 мс во всём API')
      await twoThemes('proj-new-filled')
      view.querySelector('.pjn').requestSubmit(); await wait(600)
      const item = $$('#projectsView .pj-item').find(b => /Скорость API/.test(b.textContent))
      const det = view.querySelector('.pj-detail').textContent
      note('«Создать проект»: проект выбран, справа цель и план, «Вернуть»', !view.querySelector('.pjn') && !view.querySelector('.pj-item.draft') && item?.getAttribute('aria-current') === 'true' && /p95 ниже 200 мс/.test(det) && /Замерить p95/.test(det) && /Вернуть/.test($('toastNotification')?.textContent || ''), det.slice(0, 200))
      note('проект стал папкой в боковой панели', /Скорость API/.test($('chatHistoryList').textContent))
      note('подробности: инструкции, база знаний с файлом, папки, MCP, чаты', ['Инструкции', 'База знаний', 'Папки', 'MCP проекта', 'Чаты'].every(x => det.includes(x)) && /latency-report\.md/.test(det), det.slice(0, 300))
      await twoThemes('proj-detail')
      // Цель правится на месте
      view.querySelector('[data-x="pjgoal"]').click(); await wait(200)
      const ge = $('pjGoalEdit'); type(ge, 'p95 ниже 150 мс')
      view.querySelector('[data-x="pjgoalok"]').click(); await wait(300)
      note('цель правится на месте и сохраняется', /p95 ниже 150 мс/.test(view.querySelector('.pj-goal')?.textContent || '') && !$('pjGoalEdit'))
      // Шторка правил
      const rulesBtn = view.querySelector('[data-x="pjrules"]'); rulesBtn.click(); await wait(500)
      const layer = document.querySelector('.drawer-layer')
      note('«Написать инструкции» открывает шторку правил, фокус в тексте', layer?.classList.contains('on') && document.activeElement?.id === 'drawerText')
      const dt = $('drawerText'); dt.value = '# Скорость API\n\n- Замеры — только на staging'; dt.dispatchEvent(new Event('input', { bubbles: true })); await wait(100)
      note('шторка: «Сохранить» после правки, состояние «Не сохранено»', !layer.querySelector('[data-dx="save"]').disabled && /Не сохранено/.test($('drawerState').textContent))
      await twoThemes('proj-rules')
      dt.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); await wait(400)
      note('шторка: Ctrl S сохраняет, «Вернуть» в уведомлении', /Сохранено/.test($('drawerState').textContent) && /Вернуть/.test($('toastNotification')?.textContent || ''))
      press('Escape', dt); await wait(400)
      note('шторка: Esc закрывает, инструкции видны в проекте', !layer.classList.contains('on') && /Замеры — только на staging/.test(view.querySelector('.pj-detail .doc')?.textContent || ''))
      // Черновик переживает переход на другой проект
      $('newProjectBtn').click(); await wait(300)
      type($('projectNameField'), 'Лендинг')
      $$('#projectsView .pj-item').find(b => /Скорость API/.test(b.textContent)).click(); await wait(300)
      view.querySelector('.pj-item.draft').click(); await wait(300)
      note('черновик цел после перехода на другой проект', $('projectNameField')?.value === 'Лендинг')
      view.querySelector('[data-x="npcancel"]').click(); await wait(300)
      note('«Отмена» убирает черновик, фокус на «Новый проект»', !view.querySelector('.pj-item.draft') && document.activeElement?.id === 'newProjectBtn')
      // Проект с потерянной папкой
      $('newProjectBtn').click(); await wait(300)
      type($('projectNameField'), 'old-crm')
      view.querySelector('[data-x="npdir"]').click(); await wait(400)
      view.querySelector('.pjn').requestSubmit(); await wait(1200)
      const lost = $$('#projectsView .pj-item').find(b => /old-crm/.test(b.textContent))
      note('папки нет на диске — строка красная, справа состояние с «Указать новое место»', lost?.classList.contains('bad') && /папка не найдена/.test(lost.textContent) && /Папка проекта не найдена/.test(view.querySelector('.pj-detail .state h2')?.textContent || '') && Boolean(view.querySelector('[data-x="pjmove"]')), lost?.textContent)
      await twoThemes('proj-missing')
      note('проекты: одна залитая кнопка на экране', filled(view) === 1 || [filled(view)])
    }
    // ── Чат: шапка, ход, ответ с кодом, панель справа (макет 19–21.10) ──
    if (want('chat')) {
      $('navChats')?.click(); await wait(200)
      $('newChatBtn').click(); await wait(500)
      const hdr = $('chatHeader')
      const tasks = $('navTasks')
      note('шапка: «Задачи» — значок без подписи', Boolean(tasks) && !/Задачи/.test([...tasks.childNodes].filter(n => n.nodeType === 1 && visible(n)).map(n => n.textContent).join(' ')), tasks?.textContent)
      note('пустой экран: знак и имя папки, без ветки и без подсказки про «/»', !$('heroBranch') && !visible(document.querySelector('.hero-subtitle')), document.querySelector('#welcomeHero')?.textContent.trim().slice(0, 80))
      await twoThemes('chat-empty')
      const ta = $('composerTextarea'); type(ta, 'Настройки не сохраняются после перезапуска — найди и почини')
      $('composerForm').requestSubmit()
      await until(() => !$('sendBtn').classList.contains('is-stop') && document.querySelector('#messagesList .msg-assistant, #messagesList [data-role="assistant"]'), 30000)
      await wait(1500)
      await twoThemes('chat-run')
      const code = document.querySelector('#messagesList pre code')
      const blk = code?.closest('.code-block, .cb, pre')
      note('код в ответе — блок без заголовка с файлом, копирование значком', Boolean(code) && !blk?.querySelector('.code-header, .cb-head') && Boolean(blk?.parentElement?.querySelector('[aria-label*="Скопировать"], .copy-btn, [data-x="cbcopy"]')), blk?.outerHTML?.slice(0, 300))
      note('в шапке есть «Правила проекта»', Boolean($('instrBtn')))
      $('openBrowserBtn').click(); await wait(800)
      note('пустая вкладка браузера: без подсказки про localhost', !/localhost|Найти запущенный/.test(document.querySelector('#browserEmpty')?.innerText || ''), document.querySelector('#browserEmpty')?.innerText.trim().slice(0, 120))
      await twoThemes('chat-browser')
      $('openBrowserBtn').click(); await wait(400)
    }
    // ── Задачи: панель этого чата третьей колонкой — «Агенты» и «Консоль» (макет 20.10) ──
    if (want('tasks')) {
      $('navChats')?.click(); await wait(200)
      $('newChatBtn').click(); await wait(500)
      const ta = $('composerTextarea'); type(ta, 'Подними сервер разработки и проверь тесты')
      $('composerForm').requestSubmit()
      // Разрешения на команды — как человек: «Разрешить»
      for (let i = 0; i < 120; i++) {
        document.querySelectorAll('.approval-allow').forEach(b => { if (visible(b)) b.click() })
        if (i > 6 && !$('sendBtn').classList.contains('is-stop')) break
        await wait(250)
      }
      await wait(800)
      const feedW = $('chatFeed').getBoundingClientRect().width
      if (!$('tasksPanel')) $('navTasks').click()
      await until(() => $('tasksPanel'), 4000); await wait(500)
      const p = $('tasksPanel'), r = p?.getBoundingClientRect()
      // Уже 1100 px шторка ложится поверх ленты (макет), шире — лента сужается
      note('«Задачи» — колонка справа во всю высоту, лента сужается', Boolean(p) && Math.round(r.right) === innerWidth && r.top <= 41 && (innerWidth < 1100 || $('chatFeed').getBoundingClientRect().right <= r.left + 1), { r: r && [r.left, r.top, r.right], feedW, now: $('chatFeed').getBoundingClientRect().width })
      note('две вкладки: «Агенты» и «Консоль», заголовок «Задачи»', /Задачи/.test(p.querySelector('h2')?.textContent) && $$('#tasksPanel [data-tx="tab"]').length === 2)
      await twoThemes('tasks-agents')
      $$('#tasksPanel [data-tx="tab"]').find(b => b.dataset.v === 'console').click()
      await until(() => document.querySelectorAll('#tasksPanel .pr').length >= 2, 6000); await wait(300)
      const rows = $$('#tasksPanel .pr')
      note('консоль: процесс и команда этого чата, у идущего — «Завершить»', rows.length >= 2 && rows.some(x => x.dataset.state === 'run' && x.querySelector('.pr-kill')) && rows.every(x => x.querySelector('.pr-ps')), rows.map(x => x.dataset.state + ':' + x.textContent.trim().slice(0, 40)))
      const list = document.querySelector('#tasksPanel .pr-list')
      const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(.*, 0\)|transparent/.test(c)) return c } return 'rgb(255,255,255)' }
      note('консоль — тёмная подложка терминала', lum(bgOf(list)) < 0.03, bgOf(list))
      await twoThemes('tasks-console')
      // Панель пересобирается от вывода процесса — строки перезапрашиваются перед щелчком
      $$('#tasksPanel .pr').find(x => x.dataset.state === 'run').querySelector('[data-tx="propen"]').click(); await wait(400)
      const view = document.querySelector('#tasksPanel .pr-view')
      note('процесс открывается: команда заголовком, вывод с «$», курсор у идущего', Boolean(view) && /setInterval|node/.test(view.querySelector('h3')?.textContent || '') && Boolean(view.querySelector('.pr-out .cmd .pr-ps')) && Boolean(view.querySelector('.pr-cur')) && /ready in 412 ms/.test(view.textContent), view ? view.textContent.slice(0, 200) : document.querySelector('#tasksPanel .td-body')?.innerHTML.slice(0, 600))
      await twoThemes('tasks-proc')
      if (!view) return { ok: false, checks, thrown }
      document.querySelector('#tasksPanel .pr-view [data-tx="prkill"]').click()
      await until(() => document.querySelector('#tasksPanel .pr-view')?.dataset.state !== 'run', 8000); await wait(300)
      note('«Завершить» останавливает процесс', document.querySelector('#tasksPanel .pr-view')?.dataset.state !== 'run')
      document.querySelector('#tasksPanel [data-tx="prback"]').click(); await wait(300)
      const before = $$('#tasksPanel .pr').length
      document.querySelector('#tasksPanel .pr [data-tx="prdrop"]')?.click()
      await until(() => $$('#tasksPanel .pr').length === before - 1, 4000)
      note('«Убрать» убирает завершённый процесс из консоли', $$('#tasksPanel .pr').length === before - 1, [before, $$('#tasksPanel .pr').length])
      press('Escape', document.querySelector('#tasksPanel [data-tx="tab"]')); await wait(400)
      note('Esc закрывает панель и возвращает фокус на «Задачи»', !$('tasksPanel') && document.activeElement?.id === 'navTasks', document.activeElement?.id)
    }
    // ── Дизайн: что нарисовать, полка форматов, ваши дизайны; рабочее место (макет 20.10) ──
    if (want('design')) {
      // Кадр превью сам докладывает свой размер, когда отрисовался: так видно, что снимать уже можно
      let frameReports = 0
      window.addEventListener('message', e => { if (e.data?.type === 'onecode-design-size' && e.source === $('designPreviewFrame')?.contentWindow) frameReports++ })
      $('navDesign').click(); await wait(600)
      const g = $('designGallery')
      note('дизайн: заголовок, строка «что нарисовать» и полка из 13 листов', /Дизайн/.test(g.querySelector('h1')?.textContent || '') && Boolean($('dsNewIn')) && $$('#designGallery .shelf-item').length === 13)
      const ratio = f => { const p = g.querySelector(`.shelf-item[data-f="${f}"] .paper`).getBoundingClientRect(); return p.width / p.height }
      note('листы в пропорциях холста: телефон узкий, слайды широкие', ratio('mobile') < 0.6 && ratio('slides') > 1.6, [ratio('mobile'), ratio('slides')])
      note('пока слов нет, «Начать» погашена', $('dsNewSend').disabled)
      note('пусто: одна фраза вместо карточек', /Пока ни одного/.test($('designList').textContent))
      g.querySelector('.shelf-item[data-f="mobile"]').click(); await wait(200)
      note('лист ставит формат, а не создаёт дизайн', $('designWorkspace').hidden && /Мобильное/.test($('dsFmt').textContent) && /390 × 844/.test($('dsSize').textContent) && document.activeElement?.id === 'dsNewIn')
      await twoThemes('design-gallery')
      $('dsFmt').click(); await wait(250)
      const items = $$('.menu.pop .mi')
      note('пилюля формата открывает список всех форматов', items.length === 13, items.length)
      items.find(b => /Слайды/.test(b.textContent))?.click(); await wait(200)
      note('выбор в списке ставит формат и на полке', g.querySelector('.shelf-item[data-f="slides"]').getAttribute('aria-pressed') === 'true' && /1280 × 720/.test($('dsSize').textContent))
      g.querySelector('.shelf-item[data-f="blank"]').click(); await wait(150)
      type($('dsNewIn'), 'Первый экран сервиса дыхательных практик')
      note('появились слова — «Начать» горит', !$('dsNewSend').disabled)
      press('Enter', $('dsNewIn'))
      const opened = await until(() => !$('designWorkspace').hidden && /дыхательных практик/.test($('designMessages').textContent), 8000)
      note('Enter открывает новый дизайн, первое сообщение уже ушло', opened && /дыхательных практик/.test($('designMessages').textContent))
      await until(() => $('designPreviewName').textContent === 'Landing.dc.html' && !$('designSendBtn').classList.contains('is-stop'), 30000)
      const before = frameReports
      note('холст показывает собранную страницу', await until(() => frameReports > before || frameReports > 0, 10000), frameReports); await wait(800)
      const bar = document.querySelector('.dsw-bar')
      note('полоса холста: формат с размером, «Выбрать элемент», «Файлы»; «Замечания» и «Удалить» нет', /С чистого листа, 1440 × 900/.test($('designCanvasSize').textContent) && /Выбрать элемент/.test(bar.textContent) && /Файлы/.test(bar.textContent) && !/Замечание/.test(bar.textContent) && !$('designDeleteBtn') && !$('designHandoffBtn'), bar.textContent.trim().replace(/\s+/g, ' '))
      // В узком окне (макет: контейнер до 760 px) переписка встаёт над холстом
      const dc = document.querySelector('.dsw-chat').getBoundingClientRect(), dv = document.querySelector('.dsw-view').getBoundingClientRect()
      note('переписка слева, холст справа (в узком — сверху)', dc.right <= dv.left + 8 || dc.bottom <= dv.top + 8, [dc.right, dv.left, dc.bottom, dv.top])
      note('подсказка строки — про правку собранного макета', /Что поменять/.test($('designComposerTextarea').placeholder))
      await twoThemes('design-work')
      $('designMoreBtn').click(); await wait(250)
      const more = $$('.menu.pop .mi').map(b => b.textContent)
      note('«Ещё»: «В чат / проект» и «Удалить дизайн»', more.some(x => /В чат \/ проект/.test(x)) && more.some(x => /Удалить дизайн/.test(x)), more)
      press('Escape', document.querySelector('.menu.pop .mi')); await wait(200)
      note('Esc закрывает меню и возвращает фокус на «Ещё»', !document.querySelector('.menu.pop') && document.activeElement?.id === 'designMoreBtn', document.activeElement?.id)
      $('designBackBtn').click(); await wait(500)
      const card = await until(() => document.querySelector('#designList .ds-card .ds-thumb iframe'), 6000)
      note('ваши дизайны: превью — сам макет, подпись — формат и когда', card && /С чистого листа, /.test(document.querySelector('#designList .ds-card small')?.textContent || ''), document.querySelector('#designList')?.innerHTML.slice(0, 200))
      await wait(1200)
      await twoThemes('design-cards')
    }
    // ── MCP: строки серверов, переключатель, раскрытие, окно «Добавить сервер» (макет 20.10) ──
    if (want('mcp')) {
      $('navConnectors').click(); await wait(600)
      const view = $('connectorsView')
      note('MCP: полосы счётчиков нет', !view.querySelector('.mcp-compact-strip') && !$('statTotalServers'))
      note('пусто: знак, фраза про готовый конфиг и одна «Добавить сервер»', /Серверов пока нет/.test(view.querySelector('.state h2')?.textContent || '') && /готовый конфиг/.test(view.querySelector('.state p')?.textContent || '') && filled(view) === 1, filled(view))
      await twoThemes('mcp-empty')
      view.querySelector('.state [data-mx="new"]').click(); await wait(400)
      const modal = $('addMcpModal')
      note('окно «Добавить сервер»: фокус в названии, готовый конфиг — по ссылке', modal.style.display === 'flex' && document.activeElement?.id === 'mcpNameInput' && $('mcpJsonBox').hidden && !$('mcpJsonToggle').hidden && $$('#addMcpForm .transport-tab').length === 2)
      $('addMcpForm').requestSubmit(); await wait(250)
      note('пустую форму не сохранить: ошибки у названия и команды', /\S/.test($('mcpNameInputErr').textContent) && /\S/.test($('mcpCommandInputErr').textContent) && document.activeElement?.id === 'mcpNameInput')
      await twoThemes('mcp-add-err')
      $$('#addMcpForm .transport-tab').find(b => b.dataset.type === 'http').click(); await wait(150)
      note('«Удалённый» показывает адрес и заголовки', !$('mcpHttpFields').hidden && $('mcpStdioFields').hidden)
      $('mcpJsonToggle').click(); await wait(150)
      type($('mcpJsonInput'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer abc' } } } }))
      await wait(200)
      note('готовый конфиг заполняет поля, заголовки — строками', $('mcpNameInput').value === 'github' && $('mcpUrlInput').value === 'https://api.example.com/mcp' && $('mcpHeadersInput').value === 'Authorization: Bearer abc', [$('mcpNameInput').value, $('mcpHeadersInput').value])
      await twoThemes('mcp-add-json')
      $$('#addMcpForm .transport-tab').find(b => b.dataset.type === 'stdio').click()
      type($('mcpNameInput'), 'Тестовый')
      type($('mcpCommandInput'), ARG.node)
      type($('mcpArgsInput'), ARG.mockMcp)
      $('addMcpForm').requestSubmit()
      const row = await until(() => document.querySelector('#mcpServerList .mc .stat-pill.ok'), 20000)
      note('новый сервер сразу подключается: строка с «Подключён» и включённым переключателем', row && modal.style.display !== 'flex' && document.querySelector('#mcpServerList .mc .switch')?.getAttribute('aria-checked') === 'true', $('mcpServerList').textContent.trim().slice(0, 160))
      note('под именем — «Локальный, команда»', /^Локальный, /.test(document.querySelector('#mcpServerList .mc-d')?.textContent || ''))
      const more = document.querySelector('#mcpServerList .mc-more')
      note('свёрнутое не держит Tab', more?.hasAttribute('inert'))
      await twoThemes('mcp-list')
      document.querySelector('#mcpServerList [data-mx="exp"]').click(); await wait(400)
      const open = document.querySelector('#mcpServerList .mc.open')
      note('раскрытие: инструменты по имени и действия', Boolean(open) && /1 инструмент:/.test(open.querySelector('.mc-tools')?.textContent || '') && /echo_status/.test(open.textContent) && ['retry', 'edit', 'del'].every(x => open.querySelector(`[data-mx="${x}"]`)) && !open.querySelector('.mc-more').hasAttribute('inert'), open?.querySelector('.mc-in')?.textContent.trim().slice(0, 120))
      await twoThemes('mcp-open')
      document.querySelector('#mcpServerList [data-mx="sw"]').click()
      await until(() => document.querySelector('#mcpServerList .switch')?.getAttribute('aria-checked') === 'false' && !document.querySelector('#mcpServerList .stat-pill'), 8000)
      note('выключение: пилюли нет, «Вернуть» в уведомлении', !document.querySelector('#mcpServerList .stat-pill') && /Вернуть/.test($('toastNotification')?.textContent || ''), $('toastNotification')?.textContent)
      document.querySelector('#mcpServerList [data-mx="del"]').click()
      await until(() => $('confirmModal').style.display === 'flex', 3000)
      $('confirmOkBtn')?.click()
      await until(() => /Серверов пока нет/.test($('mcpServerList').textContent), 6000)
      note('удаление — с подтверждением, после него снова пусто', /Серверов пока нет/.test($('mcpServerList').textContent))
    }
    // ── Настройки: страница с 6 вкладками (макет 21.10, правки 24.10) ──
    if (want('settings')) {
      $('openSettingsBtn').click(); await wait(500)
      const page = $('settingsModal'), r = page.getBoundingClientRect()
      note('настройки — страница рядом с боковой панелью, а не окно поверх', page.style.display === 'flex' && r.left >= document.querySelector('.sidebar').getBoundingClientRect().right - 1 && !/rgba/.test(getComputedStyle(page).backgroundColor))
      const tabs = $$('#settingsModal [data-settings-tab]:not([hidden])').map(b => b.textContent.trim())
      note('6 вкладок (24.10: без «Работы», «Скиллов» и «Телефона»; 1.3.36: без «Модов»)', tabs.join('|') === 'Общее|Провайдеры|Агент|Внешний вид|Клавиши|Обновления', tabs)
      const tabsWithoutIcon = $$('#settingsModal [data-settings-tab]').filter(b => !b.querySelector('svg.icon')).map(b => b.textContent.trim())
      note('у каждой вкладки настроек есть значок', tabsWithoutIcon.length === 0, tabsWithoutIcon)
      note('акцента, плотности, тона и «Правил команд» нет', !$('personalAccents') && !$('personalDensity') && !$('personalTone') && !$('commandRulesText'))
      for (const id of ['personal', 'keys', 'agent', 'appearance', 'shortcuts', 'updates']) {
        $('tab-' + id).click(); await wait(250)
        await twoThemes('settings-' + id)
      }
      $('navChats').click(); await wait(300)
      note('переход в раздел закрывает настройки', page.style.display === 'none')
    }
  } catch (err) {
    thrown.push('скрипт: ' + String(err && err.stack || err))
  }
  return { ok: checks.every(c => c.pass) && !thrown.length, checks, thrown }
})()
