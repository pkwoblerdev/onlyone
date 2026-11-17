/* Раздел «Проекты» по макету (audits/ui-2026-10-18/onlyone-mockup.html, 19–21.10):
 * список проектов слева, подробности выбранного справа; «Новый проект» — не окно,
 * а строка черновика в списке и форма на месте подробностей (название-заголовок,
 * описание, цель, планы, база знаний, папка, GitHub). Черновик живёт, пока его не
 * создали или не отменили. Данные — настоящие projects[] окна; поля существующего
 * проекта сохраняются сами. Разметка — в области .mk (look-pages.css).
 */
(function (root) {
  'use strict'
  const NP_ID = '__new'

  function create(deps) {
    const K = root.OnlyoneMk
    const { t, ico, esc, plural, B, L, IX, SW, GRP, FLD, AREA, pageHead, stateBlock, fieldErrors, springIn, flipSw } = K
    const host = deps.host
    const inner = host.querySelector('.page-inner')
    let sel = null, prevSel = null, draft = null
    const folders = new Map() // путь → { state, tech }
    let editing = null // 'goal' на подробностях

    const projects = () => deps.getProjects()
    const byId = id => projects().find(p => p.id === id)
    // Уроки проекта (АГ-4): свой модуль, свои данные из главного процесса; здесь — только место на странице
    const lessons = root.OnlyoneProjectLessons ? root.OnlyoneProjectLessons.create({
      host: inner, chatsOf: deps.chatsOf, toast: deps.toast, ask: deps.ask, menu: deps.menu,
      project: () => (sel && sel !== NP_ID ? byId(sel) || null : null)
    }) : null
    const leaf = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
    const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' ' + t('МБ') : Math.max(1, Math.round((n || 0) / 1024)) + ' ' + t('КБ')
    const chatsWord = n => t(plural(n, '%s чат', '%s чата', '%s чатов'), n)
    const stateOf = p => p.workspacePath ? (folders.get(p.workspacePath)?.state || 'ok') : 'ok'

    async function checkFolders() {
      const paths = projects().map(p => p.workspacePath).filter(Boolean)
      if (!paths.length || !root.electronAPI.folderState) return
      try {
        const r = await root.electronAPI.folderState({ paths })
        let changed = false
        for (const [p, v] of Object.entries(r || {})) { if (folders.get(p)?.state !== v.state) changed = true; folders.set(p, v) }
        if (changed) paint()
      } catch { /* состояние папок — подсказка, а не условие показа */ }
    }

    // ── Список ──
    function item(p) {
      const st = stateOf(p), chats = deps.chatsOf(p.id)
      const last = chats.reduce((m, c) => Math.max(m, c.updatedAt || c.createdAt || 0), 0)
      const sub = st === 'missing' ? t('папка не найдена') : st === 'denied' ? t('нет доступа к папке')
        : chats.length ? `${chatsWord(chats.length)}, ${deps.relTime(last)}` : t('чатов нет')
      return `<button class="pj-item${st === 'missing' ? ' bad' : ''}${st === 'denied' ? ' locked' : ''}" type="button" data-x="pjsel" data-id="${esc(p.id)}" aria-current="${p.id === sel}">` +
        `${ico(st === 'missing' ? 'alert' : st === 'denied' ? 'lock' : 'folder')}<span class="pj-name">${esc(p.name || t('Без названия'))}</span><span class="pj-sub">${esc(sub)}</span></button>`
    }
    const draftRow = () => draft ? `<button class="pj-item draft" type="button" data-x="pjsel" data-id="${NP_ID}" aria-current="${sel === NP_ID}">${ico('plus')}<span class="pj-name">${esc(draft.name.trim() || t('Новый проект'))}</span><span class="pj-sub">${esc(draft.dir || t('черновик'))}</span></button>` : ''

    // ── Подробности ──
    const STEP_ICON = { done: ['check', 'ok'], doing: null, todo: null, blocked: ['alert', 'warn'] }
    const stIco = s => s === 'doing' ? '<span class="dot dot-now"></span>' : s === 'done' || s === 'blocked' ? ico(STEP_ICON[s][0], STEP_ICON[s][1]) : '<span class="dot"></span>'
    function detail(p) {
      const st = stateOf(p)
      const top = `<header class="pj-head"><div class="ttl"><h2>${esc(p.name || t('Без названия'))}</h2><div class="pj-path"><span class="path-txt">${esc(p.workspacePath || t('Папка не выбрана'))}</span></div></div>` +
        `<div class="page-acts">${B(t('Новый чат'), { kind: 'line', icon: 'plus', x: 'pjchat', id: 'projectNewChatBtn', dis: st !== 'ok' })}${IX('more', t('Ещё'), { x: 'pjmore', attrs: ' aria-haspopup="menu"' })}</div></header>`
      const n = deps.chatsOf(p.id).length
      if (st === 'missing') return top + stateBlock({
        mood: 'sad', inline: true, title: t('Папка проекта не найдена'),
        body: esc(t('%s не отвечает: диск отключён или папку перенесли. %s проекта сохранены и откроются, когда папка найдётся.', p.workspacePath, chatsWord(n))),
        acts: B(t('Указать новое место'), { kind: 'line', icon: 'folder', x: 'pjmove' }) + B(t('Убрать из списка'), { x: 'pjdel' }),
        tech: folders.get(p.workspacePath)?.tech || ''
      })
      if (st === 'denied') return top + stateBlock({
        mood: 'sad', inline: true, title: t('Нет доступа к папке'),
        body: esc(t('Windows не даёт onlyone читать эту папку: права на неё поменяли после последнего открытия. Чаты сохранены, но агент не видит файлы, пока доступ не вернётся.')),
        acts: B(t('Проверить снова'), { kind: 'line', icon: 'retry', x: 'pjrecheck' }) + B(t('Указать новое место'), { icon: 'folder', x: 'pjmove' }),
        tech: folders.get(p.workspacePath)?.tech || ''
      })
      const desc = p.description ? `<p class="pj-desc">${esc(p.description)}</p>` : ''
      const goal = GRP(esc(t('Цель'))) + (editing === 'goal'
        ? `<div class="pj-edit">${AREA('pjGoalEdit', { rows: 2, v: p.goal || '', ph: t('Снизить задержку p95 ниже 200 мс во всём API') })}<div class="pj-edit-acts">${B(t('Отмена'), { sm: true, x: 'pjgoalno' })}${B(t('Сохранить'), { sm: true, kind: 'primary', x: 'pjgoalok' })}</div></div>`
        : p.goal ? `<p class="pj-goal">${esc(p.goal)}</p><div class="pj-foot">${L(t('Изменить'), { icon: 'edit', x: 'pjgoal' })}</div>`
          : `<div class="pj-none"><span>${esc(t('Цели нет.'))}</span>${L(t('Добавить цель'), { accent: true, x: 'pjgoal' })}</div>`)
      const steps = deps.normalizePlan(p.plan)
      const plans = GRP(esc(t('Планы')), steps.length ? esc(t(plural(steps.length, '%s шаг', '%s шага', '%s шагов'), steps.length)) : esc(t('шаги по порядку'))) +
        (steps.length ? `<ul class="ag-plan pj-steps">${steps.map(s => `<li data-s="${s.status === 'doing' ? 'now' : s.status === 'done' ? 'done' : s.status === 'blocked' ? 'blocked' : 'next'}"><span class="st-ico">${stIco(s.status)}</span><span>${esc(s.title || t('Шаг'))}${s.status === 'blocked' ? `<small>${esc(t('упёрлось'))}</small>` : s.detail ? `<small>${esc(s.detail)}</small>` : ''}</span>${IX('close', t('Убрать шаг «%s»', s.title || ''), { x: 'pjstepdel', attrs: ` data-id="${esc(s.id)}"` })}</li>`).join('')}</ul>` : '') +
        `<label class="sr" for="pjStepIn">${esc(t('Новый шаг'))}</label><input class="field pj-stepin" id="pjStepIn" autocomplete="off" spellcheck="false" placeholder="${esc(t('Добавьте шаг и нажмите Enter'))}">`
      const lines = p.instructions ? p.instructions.split('\n').length : 0
      const instr = p.instructions
        ? GRP(esc(t('Инструкции')), esc(t(plural(lines, '%s строка', '%s строки', '%s строк'), lines))) + `<pre class="doc">${esc(p.instructions)}</pre><div class="pj-foot">${L(t('Изменить'), { icon: 'edit', x: 'pjrules' })}</div>`
        : GRP(esc(t('Инструкции'))) + `<div class="pj-none"><span>${esc(t('Инструкций нет.'))}</span>${L(t('Написать инструкции'), { accent: true, x: 'pjrules' })}</div>`
      const kbList = p.knowledgeFiles || []
      const kb = GRP(esc(t('База знаний')), kbList.length ? esc(t(plural(kbList.length, '%s файл', '%s файла', '%s файлов'), kbList.length)) : esc(t('пусто'))) +
        (kbList.length ? `<div class="list">${kbList.map((f, i) => `<div class="kb-row">${ico('file', 'i-sm')}<span class="path-txt" data-tooltip="${esc(f.path || '')}">${esc(f.name || leaf(f.path))}</span><span class="kb-meta num">${esc(fmtSize(f.size))}</span><span class="kb-meta kb-when">${esc(f.addedAt ? deps.relTime(f.addedAt) : '')}</span>${IX('trash', t('Убрать %s из базы', f.name || leaf(f.path)), { x: 'pjkbdel', attrs: ` data-i="${i}"`, tip: t('Убрать из базы') })}</div>`).join('')}</div>` : '') +
        `<button class="drop" type="button" data-x="pjkbadd" data-tooltip="${esc(t('Markdown, PDF и картинки до 20 МБ'))}" data-over="${esc(t('Отпустите, и файлы лягут в базу знаний'))}">${ico('upload')}<span class="drop-t">${esc(t('Перетащите файлы сюда или'))} <u>${esc(t('выберите на диске'))}</u></span></button>`
      const dirs = GRP(esc(t('Папки'))) + `<div class="list">` +
        `<div class="row tight"><div><div class="row-t"><span class="path-txt">${esc(p.workspacePath || t('Папка не выбрана'))}</span></div></div><div class="row-c"><span class="dir-tag">${esc(t('основная'))}</span>${L(t('Сменить'), { x: 'pjmove' })}</div></div>` +
        (p.folders || []).map(f => `<div class="row tight"><div><div class="row-t"><span class="path-txt">${esc(f)}</span></div></div><div class="row-c"><span class="dir-tag">${esc(t('дополнительная'))}</span>${IX('close', t('Убрать %s', f), { x: 'pjdirdel', attrs: ` data-path="${esc(f)}"`, tip: t('Убрать папку') })}</div></div>`).join('') +
        `</div><div class="pj-foot">${L(t('Добавить папку'), { icon: 'plus', x: 'pjdiradd' })}</div>`
      const servers = deps.mcpServers()
      const chosen = new Set(p.mcpServerIds || [])
      const mcp = GRP(esc(t('MCP проекта')), esc(t('агент берёт их в чатах проекта'))) + (servers.length
        ? `<div class="list">${servers.map(s => `<div class="row tight"><div><div class="row-t">${esc(s.name)}</div><div class="row-d">${esc(s.status === 'connected' ? t('подключён') : s.status === 'error' ? t('не запускается') : t('не подключён'))}</div></div><div class="row-c">${SW(chosen.has(s.id), s.name, { x: 'pjmcp', attrs: ` data-id="${esc(s.id)}"` })}</div></div>`).join('')}</div>`
        : `<div class="pj-none"><span>${esc(t('Серверов MCP нет.'))}</span>${L(t('Добавить сервер'), { accent: true, x: 'pjmcpadd' })}</div>`)
      const chats = deps.chatsOf(p.id).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      const chatList = GRP(esc(t('Чаты')), chats.length ? esc(chatsWord(chats.length)) : esc(t('пока нет'))) + (chats.length
        ? `<div class="list">${chats.map(c => `<button class="row tight pj-chat" type="button" data-x="pjopen" data-id="${esc(c.id)}"><div><div class="row-t">${esc(c.title || t('Новый диалог'))}</div></div><div class="row-c"><span class="kb-meta">${esc(deps.relTime(c.updatedAt || c.createdAt))}</span></div></button>`).join('')}</div>`
        : `<div class="pj-none"><span>${esc(t('В проекте пока нет чатов.'))}</span>${L(t('Начать чат'), { accent: true, x: 'pjchat' })}</div>`)
      return top + desc + goal + plans + instr + (lessons ? lessons.section(p) : '') + kb + dirs + mcp + chatList
    }

    // ── Новый проект: форма на месте подробностей ──
    const gh = () => deps.mcpServers().find(s => /github/i.test(s.name + ' ' + (s.url || '')))
    function ghBlock() {
      if (draft.ghHidden) return ''
      const s = gh()
      if (s && s.status === 'connected') return `<div class="np-gh ok">${ico('mcp', 'i-sm')}<span><b>${esc(t('GitHub подключён через MCP'))}</b>${esc(t('Агент увидит issues и пул-реквесты репозитория этой папки'))}</span>${SW(draft.gh !== false, t('GitHub в этом проекте'), { x: 'npghsw' })}</div>`
      return `<div class="np-gh">${ico('mcp', 'i-sm')}<span><b>${esc(t('Подключите GitHub'))}</b>${esc(t('и агент будет видеть issues и пул-реквесты ваших репозиториев'))}${B(t('Подключить GitHub'), { sm: true, kind: 'line', x: 'npghon' })}</span>${IX('close', t('Скрыть'), { x: 'npghx' })}</div>`
    }
    const npFiles = () => draft.ctx.map((f, i) => `<span class="np-file">${ico('file', 'i-sm')}<b>${esc(f.name || leaf(f.path))}</b><small>${esc(fmtSize(f.size))}</small>${IX('close', t('Убрать %s', f.name || leaf(f.path)), { x: 'npfdel', attrs: ` data-i="${i}"`, tip: t('Убрать') })}</span>`).join('')
    const npPlans = () => draft.plans.map((s, i) => `<li><span>${esc(s)}</span>${IX('close', t('Убрать шаг «%s»', s), { x: 'npplandel', attrs: ` data-i="${i}"`, tip: t('Убрать') })}</li>`).join('')
    function form() {
      const d = draft
      return `<form class="pjn" novalidate aria-label="${esc(t('Новый проект'))}"><div class="pjn-head"><label class="sr" for="projectNameField">${esc(t('Название проекта'))}</label>` +
        `<input class="field pjn-title" id="projectNameField" autocomplete="off" spellcheck="false" placeholder="${esc(t('Название проекта'))}" value="${esc(d.name)}" aria-describedby="projectNameFieldErr"><span class="fld-err" id="projectNameFieldErr" aria-live="polite"></span></div>` +
        FLD('projectDescField', t('Описание'), AREA('projectDescField', { rows: 2, ph: t('Что это за проект и для кого'), v: d.desc }), { opt: t('необязательно') }) +
        FLD('projectGoalField', t('Цель'), AREA('projectGoalField', { rows: 2, ph: t('Снизить задержку p95 ниже 200 мс во всём API'), d: 1, v: d.goal }), { opt: t('необязательно'), d: t('Агент держит её в голове в каждом чате проекта') }) +
        `<section class="pjn-sec">${GRP(esc(t('Планы')), esc(t('шаги по порядку')))}<ol class="pjn-plans" id="npPlans">${npPlans()}</ol>` +
        `<label class="sr" for="npPlanIn">${esc(t('Новый шаг'))}</label><input class="field" id="npPlanIn" autocomplete="off" spellcheck="false" placeholder="${esc(t('Добавьте шаг и нажмите Enter'))}"></section>` +
        `<section class="pjn-sec">${GRP(esc(t('База знаний')), esc(t('Markdown, PDF, картинки до 20 МБ')))}<div class="np-files" id="npFiles">${npFiles()}</div>` +
        `<button class="np-drop" type="button" data-x="npctx" data-over="${esc(t('Отпустите, и файлы лягут в базу знаний'))}">${ico('upload')}<span class="drop-t">${esc(t('Перетащите файлы или папки, или'))} <u>${esc(t('выберите на диске'))}</u></span></button></section>` +
        `<section class="pjn-sec">${GRP(esc(t('Папка')))}<div class="fld"><button class="field np-dir" id="npDir" type="button" data-x="npdir" aria-label="${esc(t('Папка проекта: %s', d.dir || t('не выбрана')))}" aria-describedby="npDirErr npDirD">${ico('folder', 'i-sm')}<span class="t${d.dir ? '' : ' ph'}" id="projectFolderField">${esc(d.dir || t('Не выбрана'))}</span><span class="go" id="projectPickFolderBtn">${esc(t('Выбрать…'))}</span></button><span class="fld-err" id="npDirErr" aria-live="polite"></span><span class="fld-d" id="npDirD">${esc(t('Агент работает внутри неё. Подойдёт и пустая'))}</span></div></section>` +
        `<div id="npGh">${ghBlock()}</div>` +
        `<div class="pjn-foot">${B(t('Отмена'), { x: 'npcancel' })}${B(t('Создать проект'), { kind: 'primary', type: 'submit', id: 'projectSaveBtn' })}</div></form>`
    }

    function paint(focus) {
      const list = projects()
      if (sel !== NP_ID && !byId(sel)) sel = list[0]?.id || (draft ? NP_ID : null)
      const desc = t('Папки с кодом: инструкции, база знаний, чаты.')
      const newBtn = B(t('Новый проект'), { kind: 'primary', icon: 'plus', x: 'pjnew', id: 'newProjectBtn' })
      if (!list.length && !draft) {
        inner.innerHTML = pageHead(t('Проекты'), desc) + stateBlock({
          title: t('Проектов пока нет'),
          body: esc(t('Откройте папку с кодом — onlyone запомнит её инструкции, базу знаний и чаты. Папку можно просто перетащить в окно.')),
          acts: B(t('Новый проект'), { kind: 'primary', icon: 'plus', x: 'pjnew', id: 'newProjectBtn' })
        })
      } else {
        const right = sel === NP_ID ? form() : detail(byId(sel))
        inner.innerHTML = pageHead(t('Проекты'), desc, newBtn) +
          `<div class="pj"><nav class="pj-list" aria-label="${esc(t('Проекты'))}">${draftRow()}${list.map(item).join('')}</nav><div class="pj-detail">${right}</div></div>`
      }
      if (focus) inner.querySelector(focus)?.focus({ preventScroll: true })
    }
    function paintDetail(focus) {
      const box = inner.querySelector('.pj-detail')
      if (!box) return paint(focus)
      box.innerHTML = sel === NP_ID ? form() : detail(byId(sel))
      inner.querySelectorAll('.pj-item').forEach(b => b.setAttribute('aria-current', String(b.dataset.id === sel)))
      if (focus) inner.querySelector(focus)?.focus({ preventScroll: true })
    }
    const saveProject = p => { p.updatedAt = Date.now(); deps.save(); deps.changed() }

    function newProject() {
      if (!draft) { draft = { name: '', desc: '', goal: '', plans: [], dir: '', ctx: [], ghHidden: false, gh: true }; prevSel = sel === NP_ID ? null : sel }
      sel = NP_ID
      paint('#projectNameField')
      springIn(inner.querySelector('.pjn'), 'soft')
    }
    function cancel() {
      draft = null
      sel = prevSel && byId(prevSel) ? prevSel : projects()[0]?.id || null
      paint('#newProjectBtn')
    }
    function submit() {
      const f = inner.querySelector('.pjn')
      // Поля читаются с экрана: значение могли поставить, не набирая (вставка, проверки)
      draft.name = f.querySelector('#projectNameField').value
      draft.desc = f.querySelector('#projectDescField').value
      draft.goal = f.querySelector('#projectGoalField').value
      const name = draft.name.trim(), errs = []
      if (!name) errs.push(['projectNameField', t('Назовите проект: так он будет в списке и в боковой панели')])
      else if (projects().some(p => (p.name || '').toLowerCase() === name.toLowerCase())) errs.push(['projectNameField', t('Проект «%s» уже есть', name)])
      if (!draft.dir) errs.push(['npDir', t('Выберите папку: агент работает внутри неё')])
      if (!fieldErrors(f, errs)) return
      const now = Date.now()
      const ghServer = gh()
      const p = {
        id: root.crypto?.randomUUID ? root.crypto.randomUUID() : `proj_${now}`,
        name, description: draft.desc.trim(), goal: draft.goal.trim(), instructions: '',
        workspacePath: draft.dir, folders: [],
        knowledgeFiles: draft.ctx.map(x => ({ ...x, addedAt: now })),
        mcpServerIds: ghServer && ghServer.status === 'connected' && draft.gh !== false && !draft.ghHidden ? [ghServer.id] : [],
        plan: draft.plans.map((title, i) => ({ id: `s${i + 1}`, title, status: 'todo', dependsOn: [] })),
        createdAt: now
      }
      const was = prevSel
      deps.getProjects().push(p)
      draft = null
      sel = p.id
      deps.save(); deps.changed()
      paint(`.pj-item[data-id="${CSS.escape(p.id)}"]`)
      deps.toast(t('Проект «%s» создан', name), false, { undo: () => {
        const list = deps.getProjects(), i = list.indexOf(p)
        if (i >= 0) list.splice(i, 1)
        sel = was; deps.save(); deps.changed(); paint()
      } })
      checkFolders()
    }
    async function pickFolder() {
      try { const r = await deps.pickFolder(); return r?.path || '' } catch (e) { deps.toast(deps.cleanError(e), true); return '' }
    }
    async function addFiles(list) {
      const p = sel === NP_ID ? null : byId(sel)
      const target = p ? (p.knowledgeFiles = p.knowledgeFiles || []) : draft.ctx
      const now = Date.now()
      for (const f of list) if (!target.some(x => x.path === f.path)) target.push({ name: f.name || leaf(f.path), path: f.path, size: f.size || 0, ...(p ? { addedAt: now } : {}) })
      target.splice(40)
      if (p) { saveProject(p); paintDetail('[data-x="pjkbadd"]') }
      else { inner.querySelector('#npFiles').innerHTML = npFiles(); springIn(inner.querySelector('#npFiles').lastElementChild, 'snap', { transform: 'translateY(4px)', opacity: 0 }) }
    }

    const X = {
      pjnew: () => newProject(),
      pjsel: a => {
        if (a.dataset.id === sel) return
        if (sel === NP_ID && draft) { const f = inner.querySelector('.pjn'); if (f) { draft.name = f.querySelector('#projectNameField').value; draft.desc = f.querySelector('#projectDescField').value; draft.goal = f.querySelector('#projectGoalField').value } }
        sel = a.dataset.id; editing = null
        paintDetail()
        springIn(inner.querySelector('.pj-detail'), 'soft', { transform: 'translateY(6px)', opacity: 0 })
      },
      pjchat: () => deps.newChat(sel),
      pjopen: a => deps.openChat(a.dataset.id),
      pjmore: (a, e) => {
        e.stopPropagation()
        const p = byId(sel)
        deps.menu(a, [
          [t('Переименовать'), async () => { const v = (await deps.ask(t('Название проекта'), p.name, t('Готово')))?.trim(); if (!v || v === p.name) return; const was = p.name; p.name = v; saveProject(p); paint(); deps.toast(t('Теперь «%s»', v), false, { undo: () => { p.name = was; saveProject(p); paint() } }) }],
          [t('Изменить описание'), async () => { const v = await deps.ask(t('Описание проекта'), p.description || '', t('Готово')); if (v == null) return; p.description = v.trim(); saveProject(p); paintDetail() }],
          [t('Удалить проект'), () => X.pjdel(), { danger: true }]
        ])
      },
      pjdel: async () => { const p = byId(sel); await deps.remove(p.id, p.name); sel = projects()[0]?.id || null; paint('#newProjectBtn') },
      pjmove: async () => { const p = byId(sel), dir = await pickFolder(); if (!dir) return; p.workspacePath = dir; folders.delete(dir); saveProject(p); paint(); checkFolders() },
      pjrecheck: () => { folders.clear(); checkFolders().then(() => paint()) },
      pjgoal: () => { editing = 'goal'; paintDetail('#pjGoalEdit') },
      pjgoalno: () => { editing = null; paintDetail('[data-x="pjgoal"]') },
      pjgoalok: () => { const p = byId(sel), v = inner.querySelector('#pjGoalEdit').value.trim(), was = p.goal || ''; p.goal = v; editing = null; saveProject(p); paintDetail('[data-x="pjgoal"]'); deps.toast(v ? t('Цель сохранена: агент держит её в каждом чате проекта') : t('Цель убрана'), false, { undo: () => { p.goal = was; saveProject(p); paintDetail() } }) },
      pjstepdel: a => { const p = byId(sel), list = deps.normalizePlan(p.plan), i = list.findIndex(s => s.id === a.dataset.id); if (i < 0) return; const [gone] = list.splice(i, 1); p.plan = list; saveProject(p); paintDetail('#pjStepIn'); deps.toast(t('Шаг «%s» убран', gone.title || ''), false, { undo: () => { const l = deps.normalizePlan(p.plan); l.splice(i, 0, gone); p.plan = l; saveProject(p); paintDetail() } }) },
      pjrules: a => {
        const p = byId(sel)
        deps.openRules(p, a)
      },
      pjkbadd: async () => { const picked = await deps.pickFiles(); if (picked?.length) addFiles(picked) },
      pjkbdel: a => { const p = byId(sel), i = +a.dataset.i, [gone] = p.knowledgeFiles.splice(i, 1); saveProject(p); paintDetail('[data-x="pjkbadd"]'); deps.toast(t('%s убран из базы знаний', gone.name || leaf(gone.path)), false, { undo: () => { p.knowledgeFiles.splice(i, 0, gone); saveProject(p); paintDetail() } }) },
      pjdiradd: async () => { const p = byId(sel), dir = await pickFolder(); if (!dir) return; if ((p.folders || []).includes(dir) || dir === p.workspacePath) return deps.toast(t('Эта папка уже подключена к проекту')); p.folders = [...(p.folders || []), dir]; saveProject(p); paintDetail('[data-x="pjdiradd"]') },
      pjdirdel: a => { const p = byId(sel), dir = a.dataset.path, i = (p.folders || []).indexOf(dir); if (i < 0) return; p.folders.splice(i, 1); saveProject(p); paintDetail('[data-x="pjdiradd"]'); deps.toast(t('Папка %s убрана из проекта', leaf(dir)), false, { undo: () => { p.folders.splice(i, 0, dir); saveProject(p); paintDetail() } }) },
      pjmcp: a => { const p = byId(sel), on = flipSw(a), set = new Set(p.mcpServerIds || []); on ? set.add(a.dataset.id) : set.delete(a.dataset.id); p.mcpServerIds = [...set]; saveProject(p) },
      pjmcpadd: () => deps.addMcp(),
      // Новый проект
      npcancel: () => cancel(),
      npdir: async () => {
        const dir = await pickFolder()
        if (!dir) return
        draft.dir = dir
        const tEl = inner.querySelector('#projectFolderField'); tEl.textContent = dir; tEl.classList.remove('ph')
        const btn = inner.querySelector('#npDir'); btn.removeAttribute('aria-invalid'); btn.setAttribute('aria-label', t('Папка проекта: %s', dir))
        inner.querySelector('#npDirErr').textContent = ''
        inner.querySelector('.pj-item.draft .pj-sub').textContent = dir
        // Имя из папки — только если название ещё пустое
        const nm = inner.querySelector('#projectNameField')
        if (!nm.value.trim()) { nm.value = draft.name = leaf(dir); nm.removeAttribute('aria-invalid'); inner.querySelector('#projectNameFieldErr').textContent = ''; inner.querySelector('.pj-item.draft .pj-name').textContent = draft.name }
      },
      npctx: async () => { const picked = await deps.pickFiles(); if (picked?.length) addFiles(picked) },
      npfdel: a => { draft.ctx.splice(+a.dataset.i, 1); inner.querySelector('#npFiles').innerHTML = npFiles(); inner.querySelector('[data-x="npctx"]').focus() },
      npplandel: a => { draft.plans.splice(+a.dataset.i, 1); inner.querySelector('#npPlans').innerHTML = npPlans(); inner.querySelector('#npPlanIn').focus() },
      npghsw: a => { draft.gh = flipSw(a) },
      npghon: () => deps.addMcp('github'),
      npghx: () => { draft.ghHidden = true; inner.querySelector('#npGh').innerHTML = ''; inner.querySelector('[data-x="npdir"]').focus() },
      tech: a => { const pre = a.closest('.state').querySelector('.fail-tech'); pre.hidden = !pre.hidden; a.setAttribute('aria-expanded', String(!pre.hidden)) }
    }

    host.addEventListener('click', e => {
      const a = e.target.closest('[data-x]')
      if (!a || a.disabled || a.getAttribute('aria-disabled') === 'true') return
      const fn = X[a.dataset.x]
      if (fn) { e.preventDefault(); fn(a, e) }
      else if (lessons?.handles(a.dataset.x)) { e.preventDefault(); lessons.act(a.dataset.x, a, e) }
    })
    host.addEventListener('submit', e => {
      if (e.target.closest('.pjn')) { e.preventDefault(); submit() }
      else if (lessons && e.target.closest('.ls-form')) { e.preventDefault(); lessons.submit() }
    })
    host.addEventListener('input', e => {
      if (!draft || !e.target.closest('.pjn')) return
      const id = e.target.id
      if (id === 'projectNameField') { draft.name = e.target.value; const r = inner.querySelector('.pj-item.draft .pj-name'); if (r) r.textContent = e.target.value.trim() || t('Новый проект') }
      if (id === 'projectDescField') draft.desc = e.target.value
      if (id === 'projectGoalField') draft.goal = e.target.value
      if (e.target.hasAttribute('aria-invalid') && e.target.value.trim()) { e.target.removeAttribute('aria-invalid'); const er = inner.querySelector('#' + id + 'Err'); if (er) er.textContent = '' }
    })
    host.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
      if (e.target.id === 'npPlanIn') {
        e.preventDefault()
        const v = e.target.value.trim()
        if (!v) return
        draft.plans.push(v); e.target.value = ''
        inner.querySelector('#npPlans').innerHTML = npPlans()
        springIn(inner.querySelector('#npPlans').lastElementChild, 'snap', { transform: 'translateY(4px)', opacity: 0 })
      }
      if (e.target.id === 'pjStepIn') {
        e.preventDefault()
        const v = e.target.value.trim(), p = byId(sel)
        if (!v || !p) return
        const list = deps.normalizePlan(p.plan)
        let n = list.length + 1
        while (list.some(s => s.id === `s${n}`)) n++
        list.push({ id: `s${n}`, title: v, status: 'todo', dependsOn: [] })
        p.plan = list; saveProject(p)
        paintDetail('#pjStepIn')
      }
    })
    // Перетаскивание файлов на зону базы знаний
    const DROPS = '.drop, .np-drop'
    function over(z, on) {
      if (z.classList.contains('over') === on) return
      z.classList.toggle('over', on)
      const txt = z.querySelector('.drop-t')
      if (on) { txt.dataset.was = txt.innerHTML; txt.textContent = z.dataset.over }
      else if (txt.dataset.was != null) { txt.innerHTML = txt.dataset.was; delete txt.dataset.was }
    }
    host.addEventListener('dragenter', e => { const z = e.target.closest?.(DROPS); if (z) { e.preventDefault(); over(z, true) } })
    host.addEventListener('dragover', e => { if (e.target.closest?.(DROPS)) e.preventDefault() })
    host.addEventListener('dragleave', e => { const z = e.target.closest?.(DROPS); if (z && !z.contains(e.relatedTarget)) over(z, false) })
    host.addEventListener('drop', e => {
      const z = e.target.closest?.(DROPS)
      if (!z) return
      e.preventDefault(); over(z, false)
      const files = [...(e.dataTransfer?.files || [])].map(f => ({ name: f.name, size: f.size, path: root.electronAPI.getPathForFile ? root.electronAPI.getPathForFile(f) : '' })).filter(f => f.path)
      if (files.length) addFiles(files)
    })

    return {
      render() { if (sel !== NP_ID && !editing) paint(); else if (sel === NP_ID && !inner.querySelector('.pjn')) paint(); checkFolders() },
      open(id) { if (id && byId(id)) { sel = id; editing = null; paint() } },
      newProject,
      get selected() { return sel }
    }
  }

  root.OnlyoneProjectsPage = Object.freeze({ create, NP_ID })
})(window)
