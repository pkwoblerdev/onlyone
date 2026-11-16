/* Уроки проекта (АГ-4) на странице проекта: список, «Предложить урок», включить, исправить, отозвать.
 * Урок действует, только когда его включил человек; исправление сохраняется новой версией, которая снова ждёт
 * включения, а прежняя уходит в отозванные вместе с историей. Данные — electronAPI.lessons* (главный процесс,
 * шифрованное хранилище); разметка — в области .mk страницы проектов (look-pages.css + project-lessons.css).
 */
(function (root) {
  'use strict'

  const ERRORS = {
    forbidden: 'Уроки меняются только в главном окне onlyone.',
    'project-not-found': 'Проект не найден. Откройте раздел «Проекты» заново.',
    'chat-not-in-project': 'Этот чат не из этого проекта.',
    'too-long': 'Слишком длинно: сократите текст.',
    'too-many-keywords': 'Не больше 8 слов для условия.',
    limit: 'В проекте уже 100 действующих уроков: отзовите устаревшие.',
    'limit-total': 'Хранилище уроков заполнено. Отзовите устаревшие уроки — новые пока не сохраняются.',
    'not-found': 'Урок уже изменился. Список обновлён.',
    'wrong-status': 'Урок уже изменился. Список обновлён.',
    'storage-unavailable': 'Не удалось прочитать или сохранить уроки. Данные не сброшены.'
  }

  function create(deps) {
    const K = root.OnlyoneMk
    const { t, ico, esc, B, L, IX, GRP, FLD, INP, AREA, fieldErrors, springIn } = K
    const host = deps.host
    const cache = new Map() // projectId → { state: 'loading' | 'ready' | 'error', lessons }
    let form = null // { projectId, id (при исправлении), chatId }
    let showOld = false
    let busy = false

    const say = code => t(ERRORS[code] || ERRORS['storage-unavailable'])
    const box = () => host.querySelector('#pjLessons')
    const chatTitle = (project, chatId) => {
      if (!chatId) return ''
      const chat = deps.chatsOf(project.id).find(c => c.id === chatId)
      return chat ? (chat.title || t('Новый диалог')) : t('чат удалён')
    }

    async function load(projectId) {
      cache.set(projectId, { state: 'loading', lessons: cache.get(projectId)?.lessons || [] })
      let r
      try { r = await root.electronAPI.lessonsList(projectId) } catch { r = { ok: false, code: 'storage-unavailable' } }
      cache.set(projectId, r?.ok ? { state: 'ready', lessons: r.lessons || [] } : { state: 'error', code: r?.code, lessons: [] })
      const project = deps.project()
      if (project && project.id === projectId) paint(project)
    }

    // ── Разметка ──
    function conditions(l) {
      const words = l.keywords?.length ? l.keywords.join(', ') : ''
      if (!l.when) return words ? t('Если в просьбе есть: %s', words) : t('В любой задаче проекта')
      return t('Когда: %s', l.when) + (words ? ' · ' + t('слова: %s', words) : '')
    }
    function source(project, l) {
      const from = chatTitle(project, l.source?.chatId)
      return `<div class="row-d ls-src">${ico('file', 'i-sm')}<span class="ls-ev">${esc(l.source?.evidence || '')}</span>` +
        (from ? `<span class="ls-from">${esc(t('из чата «%s»', from))}</span>` : '') + '</div>'
    }
    const STEP = { proposed: 'предложен', enabled: 'включён вами', revoked: 'отозван', replaced: 'заменён исправлением' }
    const history = l => (l.history || []).map(h => t(STEP[h.action] || h.action)).join(' → ')
    function row(project, l) {
      const name = l.text.length > 60 ? l.text.slice(0, 57) + '…' : l.text
      const status = l.status === 'enabled'
        ? `<span class="status ok">${esc(t('действует'))}</span>`
        : `<span class="status">${esc(t('ждёт включения'))}</span>`
      const acts = (l.status === 'proposed' ? B(esc(t('Включить')), { sm: true, kind: 'primary', x: 'lsenable', attrs: ` data-id="${esc(l.id)}"` }) : '') +
        IX('edit', t('Исправить урок «%s»', name), { x: 'lsfix', attrs: ` data-id="${esc(l.id)}"`, tip: t('Исправить') }) +
        IX('close', t('Отозвать урок «%s»', name), { x: 'lsrevoke', attrs: ` data-id="${esc(l.id)}"`, tip: t('Отозвать') })
      return `<div class="row tight ls-row" data-status="${l.status}" data-id="${esc(l.id)}"><div>` +
        `<div class="row-t">${esc(l.text)}</div><div class="row-d">${esc(conditions(l))}</div>${source(project, l)}</div>` +
        `<div class="row-c">${status}${acts}</div></div>`
    }
    function oldRow(project, l) {
      const why = l.reason ? t('причина: %s', l.reason) : ''
      return `<div class="row tight ls-row" data-status="revoked" data-id="${esc(l.id)}"><div>` +
        `<div class="row-t">${esc(l.text)}</div><div class="row-d">${esc(history(l))}${why ? ' · ' + esc(why) : ''}</div>${source(project, l)}</div>` +
        `<div class="row-c"><span class="status">${esc(t('отозван'))}</span></div></div>`
    }
    function formHtml(project) {
      const was = form.id ? (cache.get(project.id)?.lessons || []).find(l => l.id === form.id) : null
      const v = form.values || {
        text: was?.text || '', when: was?.when || '', words: (was?.keywords || []).join(', '), evidence: was?.source?.evidence || ''
      }
      const from = chatTitle(project, form.chatId)
      return `<form class="pj-edit ls-form" novalidate data-key="${esc(formKey())}" aria-label="${esc(form.id ? t('Исправить урок') : t('Новый урок'))}">` +
        FLD('lsText', esc(t('Урок')), AREA('lsText', { rows: 2, max: 400, v: v.text, ph: t('Тесты этого проекта запускаются через npm test, а не jest напрямую'), d: 1 }), { d: esc(t('Одно правило, понятное без переписки')) }) +
        FLD('lsWhen', esc(t('Когда применять')), INP('lsWhen', { max: 200, v: v.when, ph: t('При запуске и правке тестов') }), { opt: esc(t('необязательно')) }) +
        FLD('lsWords', esc(t('Слова в просьбе')), INP('lsWords', { v: v.words, ph: t('тест, jest'), d: 1 }), { opt: esc(t('необязательно')), d: esc(t('Урок применяется, только если в просьбе есть одно из слов. Пусто — в любой задаче проекта')) }) +
        FLD('lsEvidence', esc(t('Доказательство')), AREA('lsEvidence', { rows: 2, max: 1000, v: v.evidence, ph: t('Что показало, что правило верно: ход, проверка, ошибка') })) +
        FLD('lsSrc', esc(t('Источник')), `<button class="field np-dir" id="lsSrc" type="button" data-x="lssrc" aria-haspopup="menu" aria-label="${esc(t('Источник урока: %s', from ? t('Чат «%s»', from) : t('Не из чата')))}">${ico('file', 'i-sm')}` +
          `<span class="t${from ? '' : ' ph'}">${esc(from ? t('Чат «%s»', from) : t('Не из чата'))}</span><span class="go">${esc(t('Выбрать…'))}</span></button>`, { opt: esc(t('необязательно')) }) +
        `<p class="ls-note">${esc(form.id ? t('Исправление сохранится новой версией и начнёт действовать, когда вы его включите.') : t('Новый урок не действует, пока вы его не включите.'))}</p>` +
        `<div class="pj-edit-acts">${B(esc(t('Отмена')), { sm: true, x: 'lscancel' })}${B(esc(form.id ? t('Сохранить исправление') : t('Предложить')), { sm: true, kind: 'primary', type: 'submit' })}</div></form>`
    }
    function body(project) {
      const entry = cache.get(project.id)
      const lessons = entry?.lessons || []
      const live = lessons.filter(l => l.status !== 'revoked'), old = lessons.filter(l => l.status === 'revoked')
      const on = live.filter(l => l.status === 'enabled').length, wait = live.length - on
      const sub = live.length ? [on ? t('действуют: %s', on) : '', wait ? t('ждут включения: %s', wait) : ''].filter(Boolean).join(' · ') : t('действуют только включённые вами')
      let html = GRP(esc(t('Уроки')), esc(sub))
      if (!entry || (entry.state === 'loading' && !lessons.length)) return html + `<p class="ls-note" role="status">${esc(t('Загружаю уроки…'))}</p>`
      if (entry.state === 'error') return html + `<div class="pj-none" role="alert"><span>${esc(say(entry.code))}</span>${L(esc(t('Повторить')), { accent: true, x: 'lsretry' })}</div>`
      if (form && form.projectId === project.id) html += formHtml(project)
      if (live.length) html += `<div class="list ls-list">${live.map(l => row(project, l)).join('')}</div>`
      else if (!form) html += `<div class="pj-none"><span>${esc(t('Уроков нет. Урок — правило, которое агент учитывает в чатах этого проекта; пока вы его не включили, он не действует и в другие проекты не переносится.'))}</span></div>`
      const foot = (form ? '' : L(esc(t('Предложить урок')), { icon: 'plus', accent: !live.length, x: 'lsnew' })) +
        (old.length ? L(esc(t('Отозванные: %s', old.length)), { icon: showOld ? 'chevron' : 'chevR', x: 'lsold', attrs: ` aria-expanded="${showOld}"` }) : '')
      if (foot) html += `<div class="pj-foot ls-foot">${foot}</div>`
      if (old.length && showOld) html += `<div class="list ls-old">${old.map(l => oldRow(project, l)).join('')}</div>`
      return html
    }
    // Перерисовка не теряет набранное в открытой форме, но и не переносит его в другую (новый урок ↔ исправление)
    const formKey = () => (form ? form.id || 'new' : '')
    function keep() {
      const f = box()?.querySelector('.ls-form')
      if (form && f && f.dataset.key === formKey()) form.values = readForm()
    }
    function paint(project, focus) {
      const el = box()
      if (!el || el.dataset.project !== project.id) return
      keep()
      el.innerHTML = body(project)
      el.setAttribute('aria-busy', String(cache.get(project.id)?.state === 'loading'))
      if (focus) el.querySelector(focus)?.focus({ preventScroll: true })
    }

    // Раздел для подробностей проекта: разметка сразу, данные догружаются и перерисовывают только его.
    function section(project) {
      if (form && form.projectId !== project.id) form = null
      keep()
      if (!cache.has(project.id)) { cache.set(project.id, { state: 'loading', lessons: [] }); queueMicrotask(() => load(project.id)) }
      return `<section class="ls" id="pjLessons" data-project="${esc(project.id)}" aria-busy="${cache.get(project.id).state === 'loading'}">${body(project)}</section>`
    }

    function readForm() {
      const f = box()?.querySelector('.ls-form')
      if (!f) return null
      return { text: f.querySelector('#lsText').value, when: f.querySelector('#lsWhen').value, words: f.querySelector('#lsWords').value, evidence: f.querySelector('#lsEvidence').value }
    }
    async function submit(project) {
      if (busy) return
      const f = box().querySelector('.ls-form'), v = readForm()
      form.values = v
      const errs = []
      if (!v.text.trim()) errs.push(['lsText', t('Сформулируйте урок одним правилом')])
      if (!v.evidence.trim()) errs.push(['lsEvidence', t('Укажите, что подтверждает урок')])
      if (!fieldErrors(f, errs)) return
      const lesson = { text: v.text, when: v.when, keywords: v.words, evidence: v.evidence, chatId: form.chatId || '' }
      busy = true
      let r
      try { r = form.id ? await root.electronAPI.lessonsCorrect(project.id, form.id, lesson) : await root.electronAPI.lessonsPropose(project.id, lesson) } catch { r = { ok: false, code: 'storage-unavailable' } } finally { busy = false }
      if (!r?.ok) {
        if (r?.code === 'text-required') return fieldErrors(f, [['lsText', t('Сформулируйте урок одним правилом')]])
        if (r?.code === 'evidence-required') return fieldErrors(f, [['lsEvidence', t('Укажите, что подтверждает урок')]])
        deps.toast(say(r?.code), true)
        if (r?.code === 'not-found' || r?.code === 'wrong-status') { form = null; load(project.id) }
        return
      }
      const fixed = Boolean(form.id)
      form = null
      await load(project.id)
      deps.toast(fixed ? t('Исправление сохранено. Оно начнёт действовать, когда вы его включите.') : t('Урок предложен. Он начнёт действовать, когда вы его включите.'))
      const added = box()?.querySelector(`.ls-row[data-id="${CSS.escape(r.lesson.id)}"]`)
      added?.querySelector('[data-x=lsenable]')?.focus({ preventScroll: true })
      springIn(added, 'snap', { transform: 'translateY(4px)', opacity: 0 })
    }
    async function change(project, call, done) {
      if (busy) return
      busy = true
      let r
      try { r = await call() } catch { r = { ok: false, code: 'storage-unavailable' } } finally { busy = false }
      if (!r?.ok) deps.toast(say(r?.code), true)
      else if (done) deps.toast(done)
      await load(project.id)
    }

    const X = {
      lsnew: (a, project) => { form = { projectId: project.id, id: null, chatId: '' }; paint(project, '#lsText'); springIn(box().querySelector('.ls-form'), 'soft') },
      lsfix: (a, project) => {
        const l = (cache.get(project.id)?.lessons || []).find(x => x.id === a.dataset.id)
        if (!l) return
        form = { projectId: project.id, id: l.id, chatId: l.source?.chatId || '' }
        paint(project, '#lsText')
      },
      lscancel: (a, project) => { form = null; paint(project, '[data-x=lsnew]') },
      lssrc: (a, project) => {
        const pick = chatId => {
          if (form) form.chatId = chatId
          paint(project, '[data-x=lssrc]')
        }
        const chats = deps.chatsOf(project.id).slice().sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)).slice(0, 20)
        deps.menu(a, [[t('Не из чата'), () => pick(''), { on: !form?.chatId }],
          ...chats.map(c => [c.title || t('Новый диалог'), () => pick(c.id), { on: form?.chatId === c.id }])])
      },
      lsenable: (a, project) => change(project, () => root.electronAPI.lessonsEnable(project.id, a.dataset.id), t('Урок включён: агент учитывает его в чатах этого проекта')),
      lsrevoke: async (a, project) => {
        const reason = await deps.ask(t('Почему урок отозван? Он останется в истории проекта.'), t('Устарел'), t('Отозвать'))
        if (reason == null) return
        await change(project, () => root.electronAPI.lessonsRevoke(project.id, a.dataset.id, String(reason).trim()), t('Урок отозван и больше не действует'))
      },
      lsold: (a, project) => { showOld = !showOld; paint(project, '[data-x=lsold]') },
      lsretry: (a, project) => { load(project.id); paint(project) }
    }

    return {
      section,
      handles: name => Object.prototype.hasOwnProperty.call(X, name),
      act: (name, a, e) => { const project = deps.project(); if (project) X[name](a, project, e) },
      submit: () => { const project = deps.project(); if (project && form) submit(project) },
      reset: () => { cache.clear(); form = null }
    }
  }

  root.OnlyoneProjectLessons = Object.freeze({ create })
})(window)
