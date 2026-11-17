/* Раздел «Скиллы» по макету (audits/ui-2026-10-18/onlyone-mockup.html, 19–21.10):
 * список строками с поиском и фильтром, страница скилла (Обзор / Содержимое с деревом,
 * просмотром, исходником и правкой) и страница «Новый скилл» — четыре способа слева,
 * работа справа: из файла, с onlyone, импорт папки или .zip, вручную.
 *
 * Данные — настоящие: свои скиллы и пакеты из настроек, скиллы проекта из
 * .onlyone/skills рабочей папки. Разметка — в области .mk (look-pages.css).
 * Модуль ничего не знает о каркасе: всё, что нужно от окна, приходит в deps.
 */
(function (root) {
  'use strict'

  function create(deps) {
    const K = root.OnlyoneMk
    const { t, ico, esc, plural, B, L, IX, SW, SEG, GRP, FLD, INP, AREA, pageHead, stateBlock, fieldErrors, springIn, flipSw } = K
    const host = deps.host
    const page = host.querySelector('.page')
    const inner = host.querySelector('.page-inner')

    let mode = 'list' // list | skill | new
    let state = 'loading' // loading | content | error
    let filter = 'all', query = ''
    const sk = { id: null, tab: 'over', cur: 'SKILL.md', raw: false, editing: false, closed: new Set(), text: '', loaded: '' }
    let sn = null // страница «Новый скилл»

    const skills = () => deps.getSkills() || []
    const groupOf = s => s.category === 'project' ? 'project' : s.category === 'builtin' ? 'builtin' : 'user'
    const projectName = () => deps.projectName() || t('проекта')
    const GROUPS = () => [
      ['project', t('В проекте %s', projectName()), t('лежат в папке проекта и едут с git')],
      ['user', t('Ваши'), t('для всех проектов')],
      ['builtin', t('Встроенные'), t('идут с onlyone')]
    ]

    // ── Список ──
    function skillRow(s) {
      const bad = Boolean(s.error)
      return `<div class="sk${bad ? ' bad' : ''}" data-on="${Boolean(s.enabled)}" data-q="${esc((t(s.name) + ' ' + (s.description || '')).toLowerCase())}" data-skill-id="${esc(s.id)}">` +
        `<div style="min-width:0"><div class="sk-name">${bad ? ico('alert', 'i-sm') : ''}<button class="sk-link" type="button" data-x="skopen" data-id="${esc(s.id)}"${s.project ? ` data-tooltip="${esc(s.project.rel)}"` : ''}>${esc(t(s.name))}</button></div>` +
        `<div class="sk-d">${esc(bad ? s.error : (t(s.description || '') || t('Описания нет: допишите description в шапке SKILL.md')))}</div></div>` +
        `<div class="sk-side">${bad ? L(t('Открыть файл'), { x: 'skfile', attrs: ` data-id="${esc(s.id)}"` })
          : `${SW(s.enabled, t(s.name), { x: 'sksw', attrs: ` data-id="${esc(s.id)}"` })}`}</div></div>`
    }
    function renderList() {
      const list = skills()
      const busy = state === 'loading' || state === 'error'
      const desc = t('Агент берёт их сам, когда задача подходит.')
      const newBtn = B(t('Новый скилл'), { kind: 'primary', icon: 'plus', x: 'sknew', id: 'addSkillBtn', dis: busy })
      if (state === 'content' && !list.length) return pageHead(t('Скиллы'), desc) + stateBlock({
        title: t('Скиллов пока нет'),
        body: esc(t('Скилл — инструкция в Markdown: как запускать тесты, как писать тексты, куда деплоить. Положите её в папку проекта или в свою, и агент возьмёт её, когда задача подойдёт.')),
        acts: B(t('Создать скилл'), { kind: 'primary', icon: 'plus', x: 'sknew', id: 'addSkillBtn' }) + B(t('Добавить из папки'), { icon: 'folder', x: 'skimport' })
      })
      const head = pageHead(t('Скиллы'), desc,
        `<label class="search"><span class="sr">${esc(t('Найти скилл'))}</span>${ico('search')}<input class="field" type="search" placeholder="${esc(t('Найти скилл'))}" data-search value="${esc(query)}"${busy ? ' disabled' : ''}></label>` + newBtn)
      const counts = { all: list.length, project: 0, user: 0, builtin: 0 }
      list.forEach(s => { counts[groupOf(s)]++ })
      const FL = [['all', t('Все')], ['project', t('Проект')], ['user', t('Ваши')], ['builtin', t('Встроенные')]].filter(([id]) => id === 'all' || counts[id])
      if (!FL.some(([id]) => id === filter)) filter = 'all'
      const flts = `<div class="flts" role="group" aria-label="${esc(t('Показать'))}">${FL.map(([id, txt]) =>
        `<button class="flt" type="button" data-x="skflt" data-v="${id}" aria-pressed="${id === filter}"${busy ? ' disabled' : ''}>${txt}<span class="n">${busy ? '' : counts[id]}</span></button>`).join('')}</div>`
      if (state === 'error') return head + flts + stateBlock({
        mood: 'sad', title: t('Скиллы не загрузились'),
        body: esc(t('Список скиллов не прочитался. Сами скиллы на месте: повторите, и они появятся.')),
        acts: B(t('Повторить'), { kind: 'primary', icon: 'retry', x: 'skretry' }), tech: deps.lastError() || ''
      })
      if (state === 'loading') {
        const skel = (w, hgt = 12, cls = '') => `<span class="skel ${cls}" style="width:${w};height:${hgt}px"></span>`
        const W = ['42%', '58%', '36%', '50%', '64%']
        return head + flts + [3, 2].map((n, g) => `<div class="grp">${skel(['180px', '72px'][g], 16)}</div><div class="list sk-group">${Array.from({ length: n }, (_, j) =>
          `<div class="sk"><div>${skel(W[(j + g) % 5], 14)}${skel('64%', 12, 'skel-line')}</div>${skel('36px', 22)}</div>`).join('')}</div>`).join('')
      }
      const groups = GROUPS().filter(([g]) => counts[g]).map(([g, title, sub]) =>
        `<div data-g="${g}"${filter !== 'all' && filter !== g ? ' hidden' : ''}>${GRP(esc(title), esc(sub))}<div class="list sk-group" data-group="${g}">${list.filter(s => groupOf(s) === g).map(skillRow).join('')}</div></div>`).join('')
      return head + flts + `<div id="skillsGrid">${groups}</div>` +
        `<section class="state sk-none" hidden><h2>${esc(t('Ничего не нашлось'))}</h2><p data-q-text></p><div class="fail-acts">${B(t('Новый скилл'), { icon: 'plus', x: 'sknew' })}</div></section>`
    }
    // Поиск и фильтр вместе: группа видна, если она в фильтре и в ней есть совпадения
    function filterRows() {
      const q = query.trim().toLowerCase()
      let any = false
      inner.querySelectorAll('[data-g]').forEach(box => {
        let n = 0
        box.querySelectorAll('.sk').forEach(r => { const hit = !q || r.dataset.q.includes(q); r.hidden = !hit; if (hit) n++ })
        box.hidden = !n || (filter !== 'all' && filter !== box.dataset.g)
        if (!box.hidden) any = true
      })
      const none = inner.querySelector('.sk-none')
      if (!none) return
      none.hidden = any || !skills().length
      none.querySelector('[data-q-text]').textContent = t('По запросу «%s» скиллов нет. Проверьте написание или создайте такой скилл.', q)
    }

    // ── Страница скилла ──
    const current = () => skills().find(s => s.id === sk.id)
    const filesOf = s => s.pack?.files?.length ? [...s.pack.files].sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b))) : ['SKILL.md']
    const isEntry = (s, f) => f === (s.pack?.entry || 'SKILL.md')
    const whoOf = s => s.category === 'project' ? t('Из проекта %s', projectName()) : s.category === 'builtin' ? t('Встроенный') : s.pack ? t('Ваш пакет') : t('Ваш')
    // Где лежит: у проекта — путь от его папки, у пакета — папка в skill-packs профиля, у своего — настройки
    const whereOf = s => s.project ? s.project.rel : s.pack?.dir ? 'skill-packs/' + String(s.pack.dir).split(/[\\/]/).filter(Boolean).pop() + '/' : t('в настройках onlyone')
    const rawOf = s => `---\nname: ${s.name}\ndescription: ${s.description || ''}\n---\n\n${s.systemPrompt || ''}`
    const editable = s => s.category !== 'builtin'
    function fmtDate(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      return d.toLocaleDateString(deps.lang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short' })
    }
    // Markdown страницы скилла: заголовки, абзацы, списки; шапка --- отбрасывается
    function md(raw) {
      const body = String(raw).replace(/^---[\s\S]*?---\n*/, '')
      let out = '', ul = false
      for (const ln of body.split('\n')) {
        if (/^\s*[-*] /.test(ln)) { if (!ul) { out += '<ul>'; ul = true } out += `<li>${esc(ln.replace(/^\s*[-*] /, ''))}</li>`; continue }
        if (ul) { out += '</ul>'; ul = false }
        if (/^#+ /.test(ln)) out += `<h4>${esc(ln.replace(/^#+ /, ''))}</h4>`
        else if (ln.trim()) out += `<p>${esc(ln)}</p>`
      }
      return out + (ul ? '</ul>' : '')
    }
    async function loadFile(s, f) {
      if (isEntry(s, f) && !s.pack) return rawOf(s)
      const r = await root.electronAPI.readSkillPackFile({ id: s.id, path: f })
      return r.content
    }
    // Дерево: файлы верхнего уровня, папки сворачиваются; путь вложенности — отступом
    function tree(s) {
      const files = filesOf(s)
      const dirs = new Map()
      const top = []
      for (const f of files) {
        const i = f.indexOf('/')
        if (i < 0) top.push(f)
        else { const d = f.slice(0, i); if (!dirs.has(d)) dirs.set(d, []); dirs.get(d).push(f) }
      }
      const fileBtn = (f, lvl) => `<button class="pk-file${lvl ? ' sub' : ''}" type="button" data-x="skf" data-f="${esc(f)}" aria-current="${sk.cur === f}">${ico('file', 'i-sm')}<span>${esc(f.split('/').pop())}</span></button>`
      return `<nav class="pk-files" aria-label="${esc(t('Файлы скилла'))}">${top.map(f => fileBtn(f, 0)).join('')}` +
        [...dirs].map(([d, list]) => `<button class="pk-file dir" type="button" data-x="skdir" data-d="${esc(d)}" aria-expanded="${!sk.closed.has(d)}">${ico('chevR', 'i-chev')}${ico('folder', 'i-sm')}<span>${esc(d)}</span></button>` +
          (sk.closed.has(d) ? '' : list.map(f => fileBtn(f, 1)).join(''))).join('') + '</nav>'
    }
    function viewer(s) {
      const asRaw = sk.raw || !/\.(md|markdown|txt)$/i.test(sk.cur)
      const seg = `<span class="seg" role="group" aria-label="${esc(t('Вид файла'))}">${[['doc', t('Просмотр')], ['raw', t('Исходник')]].map(([v, txt]) =>
        `<button type="button" data-x="skview" data-v="${v}" aria-pressed="${(v === 'raw') === asRaw}"${sk.editing || !/\.(md|markdown)$/i.test(sk.cur) ? ' disabled' : ''}>${txt}</button>`).join('')}</span>`
      const path = s.project ? (s.project.rel.endsWith('/') ? s.project.rel + sk.cur : s.project.rel)
        : s.pack ? (String(s.pack.dir).split(/[\\/]/).filter(Boolean).pop() + '/' + sk.cur) : sk.cur
      const body = sk.editing
        ? `<label class="sr" for="skEdit">${esc(t('Текст %s', sk.cur))}</label><textarea class="pk-edit" id="skEdit" spellcheck="false">${esc(sk.text)}</textarea>` +
          `<div class="pk-editbar"><span class="st" id="skEditSt">${esc(t('Без изменений'))}</span>${B(t('Отмена'), { sm: true, x: 'skcancel' })}${B(t('Сохранить'), { sm: true, kind: 'primary', x: 'sksave', dis: true, attrs: ' data-key="Ctrl S"' })}</div>`
        : asRaw ? `<div class="pk-doc raw">${esc(sk.text)}</div>` : `<div class="pk-doc">${md(sk.text)}</div>`
      return `<section class="pk-view"><div class="pk-vhead"><span class="path-txt">${esc(path)}</span>${seg}</div><div style="flex:1;min-height:0;display:flex;flex-direction:column">${body}</div></section>`
    }
    function renderSkill() {
      const s = current()
      if (!s) { mode = 'list'; return renderList() }
      const files = filesOf(s), uses = s.uses || []
      const date = fmtDate(s.updatedAt || s.pack?.importedAt || (/^skill_(\d{12,})/.exec(s.id) || [])[1] * 1)
      const meta = [whoOf(s), date ? t('обновлён %s', date) : ''].filter(Boolean).join(', ')
      const head = `<div class="skp"><button class="pr-back skp-back" type="button" data-x="skback">${ico('back', 'i-sm')}${esc(t('Скиллы'))}</button>` +
        `<header class="skp-head"><div class="ttl"><h1>${esc(t(s.name))}</h1><p class="skp-meta">${esc(meta)}</p></div><div class="skp-acts">` +
        `${SW(s.enabled, t('%s включён', t(s.name)), { x: 'skpsw', attrs: ` data-id="${esc(s.id)}" data-tooltip="${esc(t('Агент видит скилл, только если он включён'))}"`, dis: Boolean(s.error) })}` +
        `${IX('more', t('Ещё'), { x: 'skmore', attrs: ' aria-haspopup="menu"' })}</div></header>` +
        `<div class="skp-tabs" role="tablist" aria-label="${esc(t('Разделы скилла'))}">${[['over', t('Обзор'), ''], ['files', t('Содержимое'), files.length]].map(([v, txt, c]) =>
          `<button class="skp-tab" type="button" role="tab" id="skt-${v}" aria-controls="skp-panel" aria-selected="${sk.tab === v}" tabindex="${sk.tab === v ? 0 : -1}" data-x="sktab" data-v="${v}">${txt}${c ? `<span class="n">${c}</span>` : ''}</button>`).join('')}</div>`
      const scripts = files.filter(f => /\.(ps1|sh|bat|cmd|js|cjs|mjs|py)$/i.test(f)).map(f => f.split('/').pop())
      const over = `<div class="skp-over"><div>` +
        (s.error ? `<div class="banner skp-err" role="alert"><span class="msg">${ico('alert', 'i-sm')}<span><b>${esc(t('Агент не видит этот скилл.'))}</b> ${esc(s.error)}.</span></span>${L(t('Открыть файл'), { x: 'skfile', attrs: ` data-id="${esc(s.id)}"` })}</div>` : '') +
        `<section class="skp-sec"><h2 class="skp-h">${esc(t('Когда брать'))}</h2><p class="skp-lead">${esc(t(s.description || '') || t('Описания нет: допишите поле description в шапке SKILL.md, иначе агент не поймёт, когда его брать.'))}</p></section>` +
        `<section class="skp-sec"><h2 class="skp-h">${esc(t('Когда агент его брал'))}</h2>${uses.length ? `<ul class="skp-uses">${uses.slice(0, 8).map(u =>
          `<li><span>${esc(deps.chatTitle(u.chatId) || t('Чат удалён'))}</span><span class="when">${esc(deps.relTime(u.at))}</span></li>`).join('')}</ul>`
          : `<p class="skp-none">${esc(s.error ? t('Ни разу: пока шапка сломана, агент его не видит.') : t('Ещё ни разу. Агент возьмёт его сам, когда задача подойдёт под «Когда брать».'))}</p>`}</section></div>` +
        `<aside class="skp-aside" aria-label="${esc(t('О скилле'))}"><div class="skp-fact"><h3 class="skp-h">${esc(t('Где лежит'))}</h3><span class="path-txt"${s.pack?.dir ? ` data-tooltip="${esc(s.pack.dir)}"` : ''}>${esc(whereOf(s))}</span>${s.pack ? L(t('Показать в папке'), { x: 'skreveal' }) : ''}</div>` +
        `<div class="skp-fact"><h3 class="skp-h">${esc(t('Автор'))}</h3><span class="with">${ico(s.category === 'builtin' ? 'skill' : 'user', 'i-sm')}<span>${esc(s.category === 'builtin' ? 'onlyone' : t('Вы'))}</span></span></div>` +
        `<div class="skp-fact"><h3 class="skp-h">${esc(t('Что даёт агенту'))}</h3><span class="with">${ico(scripts.length ? 'terminal' : 'file', 'i-sm')}<span>${esc(scripts.length ? t('Инструкции и скрипт %s: запускает только с вашего согласия', scripts.join(', ')) : t('Только инструкции, ничего не запускает'))}</span></span></div></aside></div>`
      const filesTab = `<div class="skp-bar"><span class="grow"></span>${sk.editing || !editable(s) ? '' : B(t('Изменить'), { sm: true, icon: 'edit', x: 'skedit' })}</div>` +
        `<div class="pk">${tree(s)}${viewer(s)}</div>`
      return head + `<section id="skp-panel" role="tabpanel" aria-labelledby="skt-${sk.tab}">${sk.tab === 'over' ? over : filesTab}</section></div>`
    }

    // ── Новый скилл ──
    const WAYS = () => [
      ['file', t('Из файла'), '.md, .txt, .pdf, .docx', 'file'],
      ['agent', t('С onlyone'), t('опишите, агент напишет'), 'skill'],
      ['zip', t('Импорт папки или .zip'), t('SKILL.md и скрипты'), 'folder'],
      ['md', t('Вручную'), 'Markdown', 'edit']
    ]
    const fresh = m => ({ m, where: deps.projectName() ? 'project' : 'user', raw: false, file: { st: 'none' }, agent: { st: 'ask', ask: '', ans: {}, questions: [] }, zip: { st: 'none', fix: '' }, md: { name: '', when: '', text: '' } })
    const snRaw = (name, when, body) => `---\nname: ${name}\ndescription: ${when}\n---\n\n${body}`
    function snResult() {
      const o = sn
      if (o.m === 'file') return o.file.st === 'done' ? { name: o.file.name, when: o.file.when, body: o.file.body } : null
      if (o.m === 'agent') return o.agent.st === 'draft' ? { name: o.agent.name, when: o.agent.when, body: o.agent.body } : null
      if (o.m === 'zip') {
        const r = o.zip
        if (r.st !== 'done') return null
        const missing = r.items.filter(x => x.s === 'bad')
        const fixable = missing.length === 1 && missing[0].field === 'description'
        return (!missing.length || (fixable && r.fix.trim())) ? { name: r.name, when: r.fix.trim() || r.description, body: '' } : null
      }
      return { name: o.md.name, when: o.md.when, body: o.md.text.replace(/^---[\s\S]*?---\n*/, '') }
    }
    function preview(name, when, body) {
      const r = snRaw(name, when, body)
      return `<section class="skn-prev" id="snPrev"><div class="pk-vhead"><span class="path-txt">SKILL.md</span><span class="seg" role="group" aria-label="${esc(t('Вид файла'))}">${[['doc', t('Просмотр')], ['raw', t('Исходник')]].map(([v, txt]) =>
        `<button type="button" data-x="snview" data-v="${v}" aria-pressed="${(v === 'raw') === sn.raw}">${txt}</button>`).join('')}</span></div>` +
        (sn.raw ? `<div class="pk-doc raw">${esc(r)}</div>` : `<div class="pk-doc">${md(r)}</div>`) + '</section>'
    }
    const nameWhen = (name, when) => FLD('snName', t('Название'), INP('snName', { v: name, ph: t('Например, Ревью перед коммитом') })) +
      FLD('snWhen', t('Когда брать'), INP('snWhen', { v: when, ph: t('Перед коммитом: проверить ключи и отладочный вывод'), d: 1 }), { d: t('По этому описанию агент решает, подходит ли скилл') })
    const drop = (x, text, sub, over, tip) => `<button class="np-drop" type="button" data-x="${x}" data-tooltip="${esc(tip)}" data-over="${esc(over)}">${ico('upload')}<span class="drop-t">${text}<span class="skn-hint">${esc(sub)}</span></span></button>`
    const fail = (msg, x) => `<div class="banner" role="alert" style="margin:0 0 var(--s4)"><span class="msg">${ico('alert', 'i-sm')}<span>${esc(msg)}</span></span>${L(t('Повторить'), { x })}</div>`
    function work() {
      const o = sn
      if (o.m === 'file') {
        const f = o.file
        const head = `<h2>${esc(t('Из файла'))}</h2><p class="skn-lead">${esc(t('Вложите готовую инструкцию: onlyone перепишет её в SKILL.md, а вы проверите.'))}</p>`
        const zone = drop('snfile', `${esc(t('Перетащите файл или'))} <u>${esc(t('выберите на диске'))}</u>`, t('Markdown, текст, PDF или Word: .md, .txt, .pdf, .docx до 20 МБ'), t('Отпустите, и файл станет инструкцией'), t('.md, .txt, .pdf, .docx до 20 МБ'))
        if (f.st === 'none') return head + zone
        if (f.st === 'error') return head + fail(f.error, 'snfileagain') + zone
        if (f.st === 'busy') return head + `<div class="skn-busy" role="status">${esc(t('Читаю %s…', f.label))}</div>`
        return head + `<div class="skn-rec"><div class="skn-src"><span class="np-file">${ico('file', 'i-sm')}<b>${esc(f.label)}</b><small>${esc(f.size)}</small></span>${L(t('Другой файл'), { x: 'snfileagain' })}</div>` +
          `<h3 class="skp-h">${esc(t('Что распознано'))}</h3><ul class="skn-found">` +
          f.found.map(x => `<li data-s="${x.s}">${ico(x.s === 'warn' ? 'alert' : 'check', 'i-sm')}<span><b>${esc(x.b)}</b> ${esc(x.t)}</span></li>`).join('') + '</ul>' +
          nameWhen(f.name, f.when) + preview(f.name, f.when, f.body) + '</div>'
      }
      if (o.m === 'agent') {
        const a = o.agent
        let h = `<h2>${esc(t('С onlyone'))}</h2><p class="skn-lead">${esc(t('Опишите, что скилл должен уметь. Агент задаст пару вопросов и напишет черновик.'))}</p>` +
          FLD('snAsk', t('Что должен уметь скилл'), AREA('snAsk', { rows: 3, v: a.ask, ph: t('Проверять тексты интерфейса перед релизом') }))
        if (a.error) h += fail(a.error, a.st === 'ask' ? 'snstart' : 'sndraft')
        if (a.st === 'ask') return h + `<div class="skn-act">${B(t('Начать'), { kind: 'line', icon: 'skill', x: 'snstart' })}</div>`
        if (a.st === 'think') return h + `<div class="skn-busy" role="status">${esc(t('onlyone читает описание…'))}</div>`
        h += `<p class="skn-lead skn-qlead">${esc(t('Пара вопросов, чтобы скилл попадал в задачу:'))}</p>` + a.questions.map(({ q, options }, i) =>
          `<div class="skn-q" role="group" aria-label="${esc(q)}"><p>${esc(q)}</p><div class="skn-ansrow">${options.map(v => `<button class="skn-ans" type="button" data-x="snans" data-q="${i}" data-v="${esc(v)}" aria-pressed="${a.ans[i] === v}">${esc(v)}</button>`).join('')}</div></div>`).join('')
        if (a.st === 'q') return h + `<div class="skn-act">${B(t('Написать черновик'), { kind: 'line', x: 'sndraft' })}</div>`
        if (a.st === 'drafting') return h + `<div class="skn-busy" role="status">${esc(t('Пишу черновик SKILL.md…'))}</div>`
        return h + `<div class="skn-draft"><h3 class="skp-h">${esc(t('Черновик'))}</h3>${nameWhen(a.name, a.when)}${preview(a.name, a.when, a.body)}<div class="skn-act">${L(t('Переделать'), { icon: 'retry', x: 'snredo' })}</div></div>`
      }
      if (o.m === 'zip') {
        const z = o.zip
        const head = `<h2>${esc(t('Импорт папки или .zip'))}</h2><p class="skn-lead">${esc(t('Готовый скилл: папка с SKILL.md, рядом справка и скрипты. onlyone проверит шапку до импорта.'))}</p>`
        const zone = drop('snzip', `${esc(t('Перетащите папку или .zip, или'))} <u>${esc(t('выберите на диске'))}</u>`, t('Внутри SKILL.md с полями name и description'), t('Отпустите, и onlyone проверит скилл'), t('Папка или .zip до 20 МБ')) +
          `<div class="skn-act">${L(t('Выбрать .zip'), { icon: 'file', x: 'snzipfile' })}</div>`
        if (z.st === 'none') return head + zone
        if (z.st === 'error') return head + fail(z.error, 'snzipagain') + zone
        if (z.st === 'busy') return head + `<div class="skn-busy" role="status">${esc(t('Проверяю %s…', z.label))}</div>`
        const missing = z.items.filter(x => x.s === 'bad'), fixable = missing.length === 1 && missing[0].field === 'description'
        const fixed = fixable && z.fix.trim()
        const items = z.items.map(x => {
          if (fixed && x.s === 'bad') return `<li data-s="ok">${ico('check', 'i-sm')}<span><b>description:</b> <span id="snFixEcho">${esc(z.fix.trim())}</span></span></li>`
          return `<li data-s="${x.s}">${ico(x.s === 'bad' ? 'alert' : x.s === 'info' ? 'terminal' : 'check', 'i-sm')}<span><b>${esc(x.b)}</b> ${esc(x.t)}</span></li>`
        }).join('')
        return head + `<div class="skn-src"><span class="np-file">${ico(z.kind === 'zip' ? 'file' : 'folder', 'i-sm')}<b>${esc(z.label)}</b><small>${esc(t(plural(z.files, '%s файл', '%s файла', '%s файлов'), z.files))}</small></span>${L(t('Другой'), { x: 'snzipagain' })}</div><ul class="skn-chk">${items}</ul>` +
          (fixable ? FLD('snFix', t('Когда брать'), INP('snFix', { v: z.fix, ph: t('Выкатывает ветку на staging и проверяет /health'), d: 1 }), { d: t('Запишется в шапку как description') }) : '')
      }
      const d = o.md
      return `<h2>${esc(t('Вручную'))}</h2><p class="skn-lead">${esc(t('Напишите инструкцию или вставьте готовый SKILL.md: шапка сама разойдётся по полям.'))}</p>` + nameWhen(d.name, d.when) +
        FLD('snText', t('Инструкция'), AREA('snText', { rows: 10, v: d.text, ph: t('Шаги, команды, чего не делать'), d: 1 }), { d: 'Markdown' })
    }
    function renderNew() {
      const o = sn, ready = Boolean(snResult()) || o.m === 'md'
      const save = o.m === 'zip' ? t('Импортировать') : t('Создать скилл')
      const whereOpts = [['project', t('В проекте %s', projectName())], ['user', t('Для всех проектов')]].filter(([v]) => v === 'user' || deps.projectName())
      return `<div class="skn"><button class="pr-back skp-back" type="button" data-x="snback">${ico('back', 'i-sm')}${esc(t('Скиллы'))}</button>` +
        `<header class="skp-head"><div class="ttl"><h1>${esc(t('Новый скилл'))}</h1><p class="skp-meta">${esc(t('Инструкция, которую агент берёт сам, когда задача подходит'))}</p></div></header>` +
        `<div class="skn-grid"><nav class="skn-ways" aria-label="${esc(t('Как добавить скилл'))}">${WAYS().map(([v, txt, sub, ic]) =>
          `<button class="skn-way" type="button" data-x="snm" data-v="${v}" aria-current="${o.m === v}">${ico(ic, 'i-sm')}<b>${esc(txt)}</b><small>${esc(sub)}</small></button>`).join('')}</nav>` +
        `<section class="skn-work" id="snWork" aria-live="polite">${work()}<div class="skn-foot"><span class="lbl">${esc(t('Где хранить'))}</span>${SEG('snwhere', whereOpts, o.where, t('Где хранить'))}<span class="grow"></span>` +
        `${B(t('Отмена'), { x: 'snback' })}${B(save, { kind: 'primary', x: 'snsave', dis: !ready })}</div></section></div></div>`
    }

    // ── Отрисовка ──
    // Перерисовка не теряет фокус: без явного селектора он возвращается на ту же кнопку
    function paint(focus) {
      const a = document.activeElement
      const keep = !focus && a && inner.contains(a) && a.dataset?.x
        ? `[data-x="${a.dataset.x}"]` + (a.dataset.id ? `[data-id="${CSS.escape(a.dataset.id)}"]` : '') + (a.dataset.v ? `[data-v="${CSS.escape(a.dataset.v)}"]` : '')
        : (!focus && a?.id && inner.contains(a) ? '#' + CSS.escape(a.id) : '')
      inner.innerHTML = mode === 'skill' ? renderSkill() : mode === 'new' ? renderNew() : renderList()
      if (mode === 'list') filterRows()
      const target = focus || keep
      if (target) inner.querySelector(target)?.focus({ preventScroll: true })
    }
    async function openSkill(id, tab = 'over') {
      if (sk.editing && !leaveEdit()) return
      Object.assign(sk, { id, tab, cur: 'SKILL.md', raw: false, editing: false })
      const s = current()
      if (s) sk.cur = filesOf(s)[0]
      mode = 'skill'
      if (tab === 'files' && s) await loadCur(s)
      paint('[data-x="skback"]')
      page.scrollTop = 0
      springIn(inner.firstElementChild, 'soft')
    }
    async function loadCur(s) {
      try { sk.text = await loadFile(s, sk.cur); sk.loaded = sk.text } catch (e) { sk.text = String(e?.message || e); sk.loaded = sk.text }
    }
    function leaveEdit() {
      const ta = inner.querySelector('#skEdit')
      if (!ta || ta.value === sk.loaded) return true
      deps.toast(t('Сначала сохраните или отмените правку'))
      return false
    }
    function newSkill(way = 'file') {
      sn = fresh(way)
      mode = 'new'
      paint('[data-x="snm"][aria-current="true"]')
      page.scrollTop = 0
      springIn(inner.firstElementChild, 'soft')
    }
    function back(focus) {
      mode = 'list'
      sn = null
      paint(focus)
    }
    const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' ' + t('МБ') : Math.max(1, Math.round(n / 1024)) + ' ' + t('КБ')
    const leaf = p => String(p).split(/[\\/]/).filter(Boolean).pop() || p
    const paintWork = focus => { paint(focus) }

    async function readFile(p) {
      sn.file = { st: 'busy', label: leaf(p) }
      paintWork()
      try {
        const r = await root.electronAPI.skillFromFile({ path: p, model: deps.modelId() })
        if (!sn || sn.m !== 'file') return
        sn.file = { st: 'done', label: r.file, size: fmtSize(r.bytes || 0), found: r.found || [], name: r.name, when: r.description, body: r.body }
        paintWork('#snName')
      } catch (e) {
        if (!sn) return
        sn.file = { st: 'error', error: deps.cleanError(e) }
        paintWork('[data-x="snfile"]')
      }
    }
    async function checkPack(p) {
      sn.zip = { st: 'busy', label: leaf(p), fix: '' }
      paintWork()
      try {
        const r = await root.electronAPI.checkSkillPack({ path: p })
        if (!sn || sn.m !== 'zip') return
        sn.zip = { st: 'done', path: p, label: r.label, kind: r.kind, items: r.items, name: r.name, description: r.description, files: r.files, fix: '' }
        paintWork(inner.querySelector('#snFix') ? '#snFix' : '[data-x="snsave"]')
        if (inner.querySelector('#snFix')) inner.querySelector('#snFix').focus()
      } catch (e) {
        if (!sn) return
        sn.zip = { st: 'error', error: deps.cleanError(e), fix: '' }
        paintWork('[data-x="snzip"]')
      }
    }
    async function save() {
      const o = sn, r = snResult(), errs = []
      if (!r) return
      if (o.m !== 'zip') {
        if (!r.name.trim()) errs.push(['snName', t('Назовите скилл: так он будет виден в списке')])
        else if (skills().some(x => x.name.toLowerCase() === r.name.trim().toLowerCase())) errs.push(['snName', t('Скилл «%s» уже есть', r.name.trim())])
        if (!r.when.trim()) errs.push(['snWhen', t('Без описания агент не поймёт, когда его брать')])
        if (o.m === 'md' && !r.body.trim()) errs.push(['snText', t('Напишите хотя бы одну строку инструкции')])
        if (!fieldErrors(inner, errs)) return
      }
      const where = inner.querySelector('[data-seg="snwhere"] [aria-pressed="true"]')?.dataset.v || 'user'
      const btn = inner.querySelector('[data-x="snsave"]')
      if (btn) btn.disabled = true
      try {
        let made
        if (o.m === 'zip') {
          const res = await root.electronAPI.importSkillPack({ path: o.zip.path, description: o.zip.fix.trim() || '', where })
          made = res?.skill
        } else {
          const skill = { id: `skill_${Date.now()}`, name: r.name.trim(), description: r.when.trim(), systemPrompt: r.body.trim(), enabled: true, where }
          await root.electronAPI.addSkill(skill)
          made = skill
        }
        await deps.refresh()
        const hit = skills().find(x => x.id === made?.id) || skills().find(x => x.name === made?.name)
        const name = hit?.name || made?.name || r.name
        back(hit ? `.sk-link[data-id="${CSS.escape(hit.id)}"]` : null)
        deps.toast(o.m === 'zip' ? t('Скилл «%s» импортирован', name) : t('Скилл «%s» создан', name), false, hit ? { undo: async () => { await root.electronAPI.removeSkill(hit.id); await deps.refresh() } } : {})
      } catch (e) {
        if (btn) btn.disabled = false
        deps.toast(deps.cleanError(e), true)
      }
    }

    // ── Действия ──
    const X = {
      sknew: () => newSkill('file'),
      skimport: () => newSkill('zip'),
      skretry: () => deps.refresh(),
      skflt: a => {
        filter = a.dataset.v
        inner.querySelectorAll('[data-x="skflt"]').forEach(b => b.setAttribute('aria-pressed', String(b === a)))
        filterRows()
        springIn(inner.querySelector('[data-g]:not([hidden])'), 'soft', { transform: 'translateY(4px)', opacity: 0 })
      },
      sksw: async a => {
        const s = skills().find(x => x.id === a.dataset.id)
        const on = flipSw(a)
        a.closest('.sk').dataset.on = String(on)
        await root.electronAPI.toggleSkill({ id: s.id, enabled: on })
        await deps.refresh(true)
        if (on) deps.toast(t('«%s» включён', t(s.name)))
        else deps.toast(t('«%s» выключен: агент его не увидит', t(s.name)), false, { undo: async () => { await root.electronAPI.toggleSkill({ id: s.id, enabled: true }); await deps.refresh() } })
      },
      skopen: a => openSkill(a.dataset.id),
      skfile: a => openSkill(a.dataset.id, 'files'),
      skback: () => {
        if (sk.editing && !leaveEdit()) return
        const id = sk.id
        sk.editing = false
        back(`.sk-link[data-id="${CSS.escape(id)}"]`)
      },
      sktab: async a => {
        if (sk.editing && !leaveEdit()) return
        sk.tab = a.dataset.v; sk.editing = false
        if (sk.tab === 'files') await loadCur(current())
        paint(`[data-x="sktab"][data-v="${sk.tab}"]`)
        springIn(inner.querySelector('#skp-panel'), 'soft', { transform: 'translateY(4px)', opacity: 0 })
      },
      skf: async a => {
        if (sk.editing && !leaveEdit()) return
        sk.editing = false; sk.cur = a.dataset.f
        await loadCur(current())
        paint(`[data-x="skf"][data-f="${CSS.escape(sk.cur)}"]`)
      },
      skdir: a => { const d = a.dataset.d; sk.closed.has(d) ? sk.closed.delete(d) : sk.closed.add(d); paint(`[data-x="skdir"][data-d="${CSS.escape(d)}"]`) },
      skview: a => { if (a.disabled) return; sk.raw = a.dataset.v === 'raw'; paint(`[data-x="skview"][data-v="${a.dataset.v}"]`) },
      skedit: () => { sk.editing = true; paint('#skEdit') },
      skcancel: () => { sk.editing = false; sk.text = sk.loaded; paint('[data-x="skedit"]') },
      sksave: async () => {
        const s = current(), ta = inner.querySelector('#skEdit'), was = sk.loaded, f = sk.cur, value = ta.value
        try {
          await root.electronAPI.writeSkillFile({ id: s.id, path: f, content: value })
          sk.editing = false; sk.text = value; sk.loaded = value
          await deps.refresh(true)
          paint('[data-x="skedit"]')
          deps.toast(t('%s сохранён: агент возьмёт новую версию со следующего хода', f), false, { undo: async () => {
            await root.electronAPI.writeSkillFile({ id: s.id, path: f, content: was }); await deps.refresh(true)
            if (mode === 'skill' && sk.id === s.id && sk.cur === f && !sk.editing) { sk.text = was; sk.loaded = was; paint() }
          } })
        } catch (e) { deps.toast(deps.cleanError(e), true) }
      },
      skpsw: async a => {
        const s = current(), on = flipSw(a)
        await root.electronAPI.toggleSkill({ id: s.id, enabled: on })
        await deps.refresh(true)
        if (on) deps.toast(t('«%s» включён', t(s.name)))
        else deps.toast(t('«%s» выключен: агент его не увидит', t(s.name)), false, { undo: async () => { await root.electronAPI.toggleSkill({ id: s.id, enabled: true }); await deps.refresh(true); if (mode === 'skill') paint() } })
      },
      skreveal: () => root.electronAPI.revealSkill?.({ id: sk.id }),
      skmore: (a, e) => {
        e.stopPropagation()
        const s = current()
        deps.menu(a, [
          s.pack ? [t('Показать в папке'), () => root.electronAPI.revealSkill?.({ id: s.id })] : null,
          [t('Скопировать путь'), () => { navigator.clipboard?.writeText(whereOf(s)); deps.toast(t('Путь скопирован')) }],
          [t('Удалить скилл'), async () => {
            if (!(await deps.confirm(t('Удалить скилл «%s»? Агент перестанет его видеть.', t(s.name)), t('Удалить')))) return
            await root.electronAPI.removeSkill(s.id)
            await deps.refresh()
            back('#addSkillBtn')
            deps.toast(t('Скилл «%s» удалён', t(s.name)))
          }, { danger: true }]
        ].filter(Boolean))
      },
      tech: a => { const pre = a.closest('.state').querySelector('.fail-tech'); pre.hidden = !pre.hidden; a.setAttribute('aria-expanded', String(!pre.hidden)) },
      // Новый скилл
      snm: a => { sn.m = a.dataset.v; paint(`[data-x="snm"][data-v="${a.dataset.v}"]`); springIn(inner.querySelector('#snWork'), 'soft', { transform: 'translateY(4px)', opacity: 0 }) },
      snback: () => back('#addSkillBtn'),
      snview: a => { sn.raw = a.dataset.v === 'raw'; const r = snResult(); inner.querySelector('#snPrev').outerHTML = preview(r.name, r.when, r.body); inner.querySelector(`[data-x="snview"][data-v="${a.dataset.v}"]`)?.focus({ preventScroll: true }) },
      snfile: async () => { const p = await root.electronAPI.pickSkillSource({ kind: 'file' }); if (p?.path) readFile(p.path) },
      snfileagain: () => { sn.file = { st: 'none' }; paint('[data-x="snfile"]') },
      snstart: async () => {
        const f = inner.querySelector('#snAsk')
        if (!sn.agent.ask.trim()) { fieldErrors(inner, [['snAsk', t('Опишите хотя бы одной фразой')]]); f.focus(); return }
        Object.assign(sn.agent, { st: 'think', error: '' })
        paint()
        try {
          const r = await root.electronAPI.skillDraft({ ask: sn.agent.ask, model: deps.modelId() })
          if (!sn || sn.m !== 'agent') return
          Object.assign(sn.agent, { st: 'q', questions: r.questions, ans: {} })
          paint('[data-x="snans"]')
        } catch (e) { if (!sn) return; Object.assign(sn.agent, { st: 'ask', error: deps.cleanError(e) }); paint('[data-x="snstart"]') }
      },
      snans: a => { sn.agent.ans[a.dataset.q] = a.dataset.v; a.parentNode.querySelectorAll('.skn-ans').forEach(b => b.setAttribute('aria-pressed', String(b === a))) },
      sndraft: async () => {
        const g = sn.agent
        const answers = Object.fromEntries(g.questions.map((x, i) => [x.q, g.ans[i] || x.options[0]]))
        Object.assign(g, { st: 'drafting', error: '' })
        paint()
        try {
          const d = await root.electronAPI.skillDraft({ ask: g.ask, answers, model: deps.modelId() })
          if (!sn || sn.m !== 'agent') return
          Object.assign(g, { st: 'draft', name: d.name, when: d.description, body: d.body })
          paint('#snName')
        } catch (e) { if (!sn) return; Object.assign(g, { st: 'q', error: deps.cleanError(e) }); paint('[data-x="sndraft"]') }
      },
      snredo: () => { sn.agent.st = 'q'; paint('[data-x="sndraft"]') },
      snzip: async () => { const p = await root.electronAPI.pickSkillSource({ kind: 'folder' }); if (p?.path) checkPack(p.path) },
      snzipfile: async () => { const p = await root.electronAPI.pickSkillSource({ kind: 'zip' }); if (p?.path) checkPack(p.path) },
      snzipagain: () => { sn.zip = { st: 'none', fix: '' }; paint('[data-x="snzip"]') },
      snsave: () => save()
    }

    // Один обработчик на раздел. Сегменты страницы — простые переключатели выбора
    host.addEventListener('click', e => {
      const segBtn = e.target.closest('.seg button')
      if (segBtn && !segBtn.disabled && !segBtn.dataset.x) {
        segBtn.parentNode.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === segBtn)))
        if (segBtn.parentNode.dataset.seg === 'snwhere' && sn) sn.where = segBtn.dataset.v
        return
      }
      const a = e.target.closest('[data-x]')
      if (!a || a.disabled || a.getAttribute('aria-disabled') === 'true') return
      const fn = X[a.dataset.x]
      if (fn) { e.preventDefault(); fn(a, e) }
    })
    host.addEventListener('input', e => {
      const id = e.target.id, v = e.target.value
      if (e.target.matches('[data-search]')) { query = v; filterRows(); return }
      if (id === 'skEdit') {
        const dirty = v !== sk.loaded, st = inner.querySelector('#skEditSt')
        st.textContent = dirty ? t('Не сохранено') : t('Без изменений')
        st.classList.toggle('dirty', dirty)
        inner.querySelector('[data-x="sksave"]').disabled = !dirty
        return
      }
      if (!sn) return
      if (e.target.hasAttribute('aria-invalid') && v.trim()) { e.target.removeAttribute('aria-invalid'); const er = inner.querySelector('#' + id + 'Err'); if (er) er.textContent = '' }
      const box = sn.m === 'file' ? sn.file : sn.m === 'agent' ? sn.agent : sn.md
      if (id === 'snName') box.name = v
      if (id === 'snWhen') box.when = v
      if (id === 'snAsk') sn.agent.ask = v
      if (id === 'snText') {
        sn.md.text = v
        // Вставили SKILL.md целиком: шапка расходится по полям
        const h = v.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)
        if (h) {
          const nm = h[1].match(/^name:\s*(.+)$/m), ds = h[1].match(/^description:\s*(.+)$/m)
          if (nm) { sn.md.name = nm[1].trim(); inner.querySelector('#snName').value = sn.md.name }
          if (ds) { sn.md.when = ds[1].trim(); inner.querySelector('#snWhen').value = sn.md.when }
        }
      }
      if (id === 'snFix') {
        const was = Boolean(sn.zip.fix.trim())
        sn.zip.fix = v
        if (was !== Boolean(v.trim())) { paint(); const f = inner.querySelector('#snFix'); f.focus({ preventScroll: true }); f.setSelectionRange(v.length, v.length) }
        else if (inner.querySelector('#snFixEcho')) inner.querySelector('#snFixEcho').textContent = v.trim()
      }
      if ((id === 'snName' || id === 'snWhen') && inner.querySelector('#snPrev')) {
        const r = snResult()
        if (r) inner.querySelector('#snPrev').outerHTML = preview(r.name, r.when, r.body)
      }
      const sv = inner.querySelector('[data-x="snsave"]')
      if (sv) sv.disabled = !(snResult() || sn.m === 'md')
    })
    host.addEventListener('keydown', e => {
      if (e.target.id === 'skEdit' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        const b = inner.querySelector('[data-x="sksave"]')
        if (!b.disabled) b.click()
      }
      // Вкладки скилла: стрелки, как у настоящих вкладок
      const tab = e.target.closest?.('.skp-tab')
      if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); tab.parentNode.querySelector(`.skp-tab:not([data-v="${tab.dataset.v}"])`).click() }
    })
    // Перетаскивание на зону способа: файл или папка — сразу в работу
    const DROPS = '.np-drop'
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
      e.preventDefault()
      over(z, false)
      const file = e.dataTransfer?.files?.[0]
      const p = file && root.electronAPI.getPathForFile ? root.electronAPI.getPathForFile(file) : ''
      if (!p) return
      if (z.dataset.x === 'snfile') readFile(p)
      else if (z.dataset.x === 'snzip') checkPack(p)
    })

    return {
      // Из окна: данные пришли или упали
      // Данные пришли или упали. «Новый скилл» не перерисовывается: в нём пишут
      setState(s) {
        state = s
        if (s !== 'content') { mode = 'list'; sn = null; paint(); return }
        if (mode === 'list' || (mode === 'skill' && !sk.editing)) paint()
      },
      repaint() { if (mode === 'skill' && sk.editing) return; paint() },
      openSkill, newSkill,
      get mode() { return mode }
    }
  }

  root.OnlyoneSkillsPage = Object.freeze({ create })
})(window)
