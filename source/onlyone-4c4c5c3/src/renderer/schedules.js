// Экран «Расписания» (план, этап 3.5). Вкладка Настроек в тот же слой, что
// «Провайдеры и ключи»: группа с заголовком, кнопка создания над списком,
// строка «подпись слева — управление справа», поля без обводки, удаление — с
// подтверждением на самой строке, без системного диалога.
//
// Окно знает только состояние записи: срок словами из `describeNext`, признак
// хода, исход. Текст просьбы приходит адресным каналом и ровно в форму правки.
(function initSchedules (root) {
  'use strict'

  // Перевод — общий со всем приложением (`t` в app.js): строки этого экрана
  // рождаются в шаблоне уже после обхода разметки словарём.
  const L = (text, ...args) => (typeof root.__t === 'function' ? root.__t(text, ...args) : text)

  const REPEATS = [
    ['once', 'Один раз'],
    ['daily', 'Каждый день'],
    ['weekdays', 'По будням'],
    ['weekly', 'Каждую неделю'],
    ['cron', 'Своё расписание (cron)']
  ]

  function esc (value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function newId () {
    return `sch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  }

  function zone () {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
  }

  function today () { return new Date().toISOString().slice(0, 10) }

  // Как человек опишет повторение одним словом — то же слово он хочет видеть,
  // когда сохранит. Разбор и сборка живут рядом, чтобы не разъезжались.
  function repeatOf (record) {
    if (record.kind === 'daily') return 'daily'
    if (record.kind === 'cron') return 'cron'
    if (record.kind === 'once') return 'once'
    if (record.kind === 'weekly') {
      const days = (record.weekly && record.weekly.weekdays) || []
      return days.join(',') === '1,2,3,4,5' ? 'weekdays' : 'weekly'
    }
    return 'daily'
  }

  function repeatWord (record) {
    const found = REPEATS.find(one => one[0] === repeatOf(record))
    return found ? L(found[1]) : String(record.kind)
  }

  function timeOf (record) {
    if (record.kind === 'daily') return record.daily && record.daily.time
    if (record.kind === 'weekly') return record.weekly && record.weekly.time
    if (record.kind === 'once' && record.once && record.once.at) return String(record.once.at).slice(11, 16)
    return ''
  }

  function create (electronAPI, host) {
    const state = { records: [], invalid: [], corrupt: false, storeError: '', nextText: {}, draft: null, errors: {}, confirmId: '' }

    function load () {
      return electronAPI.getSchedules().then(got => {
        if (!got || got.ok === false) { state.storeError = (got && got.error) || L('расписания не читаются'); paint(); return }
        state.records = got.records || []
        state.invalid = got.invalid || []
        state.corrupt = Boolean(got.corrupt)
        state.storeError = got.storeError || ''
        state.nextText = got.nextText || {}
        paint()
      }).catch(error => {
        state.storeError = String((error && error.message) || error)
        paint()
      })
    }

    function emptyNote () {
      return `<p class="settings-note">${L('Расписаний пока нет. Здесь они работают сами: приложение открывает чат и отправляет в него сохранённую просьбу в назначенное время, даже если его перезапустить.')}</p>`
    }

    function row (record) {
      const next = state.nextText[record.id] || L('следующий запуск не вычислен')
      const late = record.nextRunAt && record.nextRunAt < Date.now() && !record.running
      const when = late ? L('пропущен — ожидается пробуждение') : esc(next)
      const off = record.enabled ? '' : `<span class="settings-note">${L('выключено')}</span>`
      const run = record.running
        ? `<span class="settings-note" data-running="1">${L('идёт сейчас')}</span>`
        : `<button type="button" class="btn-secondary" data-run="${esc(record.id)}">${L('Выполнить сейчас')}</button>`
      const confirm = state.confirmId === record.id
        ? `<span class="settings-note">${L('Удалить «%s»?', esc(record.name))} <button type="button" class="btn-secondary" data-del="${esc(record.id)}">${L('Да, удалить')}</button> <button type="button" class="btn-secondary" data-cancel="1">${L('Отмена')}</button></span>`
        : `<button type="button" class="btn-secondary" data-ask="${esc(record.id)}">${L('Удалить')}</button>`
      return `<li class="setting-row" data-schedule-row="${esc(record.id)}">
        <span class="setting-label"><b>${esc(record.name)}</b><span class="settings-note">${when}</span>${off}</span>
        <span class="setting-control">${run}
          <button type="button" class="btn-secondary" data-edit="${esc(record.id)}">${L('Изменить')}</button>
          <button type="button" class="btn-secondary" role="switch" aria-pressed="${record.enabled ? 'true' : 'false'}" aria-label="${L('Включено')}" data-toggle="${esc(record.id)}">${record.enabled ? L('Включено') : L('Выключено')}</button>
          ${confirm}
        </span>
      </li>`
    }

    function brokenRow (item) {
      const name = esc(item.name || item.id || L('запись без имени'))
      const why = (item.errors || []).map(one => esc(one.message)).join('; ')
      return `<li class="setting-row" data-broken="1"><span class="setting-label"><b>${name}</b><span class="settings-note">${L('настроено неверно')}: ${why}</span></span>
        <span class="setting-control"><button type="button" class="btn-secondary" data-drop="${esc(item.id)}">${L('Удалить')}</button></span></li>`
    }

    function rows () {
      // Пустое место — не «расписаний нет», когда файл не читается: человек не
      // должен услышать «у вас ничего нет» про то, что он написать пытался.
      if (state.corrupt && !state.records.length && !state.invalid.length) return ''
      if (!state.records.length && !state.invalid.length) return emptyNote()
      return `<ul class="settings-list">${state.records.map(row).join('')}${state.invalid.map(brokenRow).join('')}</ul>`
    }

    function field (key, label, html) {
      return `<label class="setting-row"><span class="setting-label">${L(label)}</span><span class="setting-control">${html}${state.errors[key] ? `<span class="settings-note" data-error-for="${key}">${esc(state.errors[key])}</span>` : ''}</span></label>`
    }

    function form () {
      const draft = state.draft
      if (!draft) return ''
      const options = REPEATS.map(one => `<option value="${one[0]}"${draft.repeat === one[0] ? ' selected' : ''}>${L(one[1])}</option>`).join('')
      const when = draft.repeat === 'cron'
        ? field('cron', 'Cron', `<input data-f="cron" value="${esc(draft.cron)}" placeholder="30 7 * * 1-5">`)
        : draft.repeat === 'once'
          ? field('date', 'Дата и время', `<input type="date" data-f="date" value="${esc(draft.date)}"> <input type="time" data-f="time" value="${esc(draft.time)}">`)
          : field('time', 'Время', `<input type="time" data-f="time" value="${esc(draft.time)}">`)
      return `<div class="settings-group" data-schedule-form tabindex="-1">
        <div class="settings-group-title">${draft.id ? L('Изменить расписание') : L('Новое расписание')}</div>
        ${field('name', 'Имя', `<input data-f="name" value="${esc(draft.name)}">`)}
        ${field('prompt', 'Что делать', `<textarea data-f="prompt" rows="3">${esc(draft.prompt)}</textarea>`)}
        ${field('chat', 'Куда отправлять', `<label><input type="radio" name="sched-chat" data-f="newchat" value="new"${draft.chatId ? '' : ' checked'}> ${L('в новый чат')}</label> <label><input type="radio" name="sched-chat" data-f="usechat" value="current"${draft.chatId ? ' checked' : ''}> ${L('в этот чат')}</label> <input data-f="chatid" value="${esc(draft.chatId || '')}" size="14" aria-label="id">`)}
        ${field('repeat', 'Повторять', `<select data-f="repeat">${options}</select>`)}
        ${when}
        <p class="settings-note">${L('Пропущенные запуски не догоняются очередью: после сна выполнится один, остальные сроки пересчитываются вперёд.')}</p>
        <div class="setting-row"><span class="setting-label"></span><span class="setting-control">
          <button type="button" class="btn-primary" data-save="1">${L('Сохранить')}</button>
          <button type="button" class="btn-secondary" data-close="1">${L('Отмена')}</button>
        </span></div>
      </div>`
    }

    function notice () {
      const notes = []
      if (state.corrupt) notes.push(L('Файл расписаний повреждён и не читается: целое сохранено в копии, новые правки пока не запишутся. Не затирайте его — разберите руками.'))
      if (state.storeError) notes.push(`${L('Хранилище ответило отказом')}: ${esc(state.storeError)}`)
      if (!notes.length) return ''
      return `<p class="settings-note" role="status">${notes.join(' ')}</p>`
    }

    function paint () {
      if (!host) return
      host.innerHTML = `<div class="settings-group">
        <div class="settings-group-head">
          <div class="settings-group-title">${L('Запуски по расписанию')}</div>
          <button type="button" class="btn-primary" data-new="1">${L('Новое расписание')}</button>
        </div>
        ${notice()}
        ${rows()}
      </div>${form()}`
    }

    function readForm () {
      const draft = state.draft
      const only = key => host.querySelector(`[data-f="${key}"]`)
      const yes = key => { const one = only(key); return one && one.checked ? one.value : null }
      if (only('name')) draft.name = only('name').value.trim()
      if (only('prompt')) draft.prompt = only('prompt').value
      if (only('time')) draft.time = only('time').value
      if (only('date')) draft.date = only('date').value
      if (only('cron')) draft.cron = only('cron').value.trim()
      if (only('repeat')) draft.repeat = only('repeat').value
      if (yes('usechat') && only('chatid')) draft.chatId = only('chatid').value.trim() || null
      if (yes('newchat')) draft.chatId = null
      return draft
    }

    function toRecord (draft) {
      const base = {
        id: draft.id || newId(),
        name: draft.name,
        enabled: true,
        timeZone: zone(),
        misfire: 'skip',
        action: { type: 'agent-turn', prompt: draft.prompt }
      }
      if (draft.chatId) base.action.chatId = draft.chatId
      const time = /^\d{2}:\d{2}$/.test(draft.time || '') ? draft.time : '09:00'
      if (draft.repeat === 'once') {
        const at = new Date(`${draft.date || today()}T${time}:00`)
        return { ...base, kind: 'once', once: { at: at.toISOString() } }
      }
      if (draft.repeat === 'cron') return { ...base, kind: 'cron', cron: { expression: draft.cron } }
      if (draft.repeat === 'weekdays') return { ...base, kind: 'weekly', weekly: { time, weekdays: [1, 2, 3, 4, 5] } }
      if (draft.repeat === 'weekly') {
        const day = new Date(`${draft.date || today()}T00:00:00`).getDay()
        return { ...base, kind: 'weekly', weekly: { time, weekdays: [Number.isFinite(day) ? day : 1] } }
      }
      return { ...base, kind: 'daily', daily: { time } }
    }

    function save () {
      const draft = readForm()
      const errors = {}
      if (!draft.name) errors.name = L('Нужно имя — по нему найдёте расписание в списке.')
      if (!draft.prompt) errors.prompt = L('Нужно сохранить просьбу — её получит чат.')
      if (draft.repeat === 'cron' && !draft.cron) errors.cron = L('Нужно письмо cron, например 30 7 * * 1-5.')
      if (draft.repeat !== 'cron' && !/^\d{2}:\d{2}$/.test(draft.time || '')) errors.time = L('Укажите время, например 07:30.')
      state.errors = errors
      if (Object.keys(errors).length) { paint(); return }
      electronAPI.setSchedule(toRecord(draft)).then(got => {
        state.errors = {}
        if (got && got.ok === false) {
          const first = (got.errors || [])[0]
          // Ошибка модели про просьбу приходит полем «action.prompt» — показать её
          // надо у поля формы «prompt», иначе отказ сохранения невидим.
          const key = first && first.field === 'action.prompt' ? 'prompt' : ((first && first.field) || 'name')
          state.errors[key] = (first && first.message) || got.error || L('не сохранено')
          paint()
          return
        }
        state.draft = null
        load()
      })
    }

    // Просьба приходит отдельным каналом: в списке её нет намеренно.
    function edit (id) {
      const record = state.records.find(one => one.id === id) || {}
      state.draft = { id, name: record.name || '', prompt: '', time: timeOf(record) || '09:00', date: today(),
        cron: '', repeat: record.kind ? repeatOf(record) : 'daily', chatId: null }
      paint()
      if (electronAPI.getSchedulePrompt) electronAPI.getSchedulePrompt(id).then(got => {
        if (got && got.ok && state.draft && state.draft.id === id) {
          state.draft.prompt = got.prompt || ''
          const box = host.querySelector('[data-f="prompt"]')
          if (box) box.value = state.draft.prompt
        }
      })
    }

    function closeBoth () {
      if (state.confirmId) { state.confirmId = ''; paint(); return true }
      if (state.draft) { state.draft = null; state.errors = {}; paint(); return true }
      return false
    }

    host.addEventListener('click', event => {
      const button = event.target.closest('button')
      if (!button) return
      const data = button.dataset
      if (data.new) { state.draft = { name: '', prompt: '', time: '09:00', date: today(), cron: '', repeat: 'daily', chatId: null }; paint(); return }
      if (data.close) { state.draft = null; state.errors = {}; paint(); return }
      if (data.save) { save(); return }
      if (data.ask) { state.confirmId = state.confirmId === data.ask ? '' : data.ask; paint(); return }
      if (data.cancel) { state.confirmId = ''; paint(); return }
      const id = data.run || data.edit || data.toggle || data.del || data.drop
      if (!id) return
      if (data.run) { electronAPI.runScheduleNow(id); return }
      if (data.edit) { edit(id); return }
      if (data.toggle) { electronAPI.setScheduleEnabled(id, button.getAttribute('aria-pressed') !== 'true').then(load); return }
      electronAPI.deleteSchedule(id).then(() => { state.confirmId = ''; load() })
    })

    host.addEventListener('keydown', event => {
      if (event.key === 'Escape') { if (closeBoth()) event.stopPropagation() }
    })

    load()
    if (electronAPI.onScheduleEvent) electronAPI.onScheduleEvent(() => load())
    return { reload: load, paint, state, host }
  }

  const api = { create, repeatOf, repeatWord, timeOf, esc, REPEATS }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneSchedules = api

  if (typeof document === 'object' && root.electronAPI) {
    const start = () => {
      const host = document.querySelector('[data-schedule-screen]')
      if (host && !host.dataset.mounted) {
        host.dataset.mounted = '1'
        // Экран показывает слова главного процесса (срок следующим запуском):
        // после смены языка оболочка перечитывает список через этот экземпляр,
        // иначе английская вкладка осталась бы русской до следующего пуша.
        api.mounted = create(root.electronAPI, host)
      }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
    else start()
  }
})(typeof window === 'object' ? window : globalThis)
