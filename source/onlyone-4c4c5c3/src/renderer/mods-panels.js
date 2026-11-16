(function () {
  'use strict'
  function node (tag, text, className) {
    const element = document.createElement(tag)
    if (text !== undefined) element.textContent = text
    if (className) element.className = className
    return element
  }
  function button (text, action) {
    const element = node('button', text, 'btn-secondary'); element.type = 'button'
    element.onclick = action; return element
  }
  function error (t, code) {
    const messages = { 'chat-required':'Откройте диалог для панелей модов', 'skill-unavailable':'Выбранный навык недоступен. Включите его в настройках.',
      conflict:'Мод изменился. Обновите панели и повторите.', 'main-unavailable':'Основное окно недоступно',
      'storage-unavailable':'Не удалось прочитать моды. Данные не сброшены.', 'invalid-package':'Некорректный пакет мода или разрешения',
      'same-version':'Для изменения пакета увеличьте его версию', 'write-failed':'Не удалось сохранить мод. Предыдущее состояние сохранено.',
      expired:'Предпросмотр устарел. Проверьте пакет заново.' }
    return t(messages[code] || 'Не удалось выполнить действие мода')
  }
  const trends = new Map()
  function trendCue (t, label, value, previous) {
    const direction = value > previous ? 'up' : value < previous ? 'down' : 'steady'
    const cue = node('span', { up: '↑', down: '↓', steady: '→' }[direction], 'mod-trend')
    cue.dataset.trend = direction; cue.setAttribute('role', 'img')
    // Before → after needs no new words; "no change" already has a translation.
    cue.setAttribute('aria-label', direction === 'steady' ? t(label) + ': ' + t('без изменений') : t(label) + ': ' + previous + ' → ' + value)
    return cue
  }
  function paint (host, view, {t, action, draft}) {
    host.replaceChildren()
    if (!view?.ok) { host.append(node('p',error(t,view?.code))); return }
    if (!view.panels.length) host.append(node('p', t('Нет включённых панелей. Установите мод в настройках Onlyone.')))
    for (const panel of view.panels) {
      const card = node('section', undefined, 'mod-card')
      card.append(node('small', panel.modName), node('h3',panel.title), node('p',panel.body))
      const counts = node('dl', undefined, 'mod-counts')
      const labels = { files:'Изменённые файлы',passed:'Проверки с кодом 0',failed:'Ошибки проверок' }
      const trendKey = (view.chatId || '') + '|' + panel.modId + '|' + panel.id
      const before = trends.get(trendKey), current = {}
      for (const [key,value] of Object.entries(panel.counts)) {
        current[key] = value
        const chip = node('div', undefined, 'mod-chip'); chip.dataset.metric = key
        if (!value) chip.dataset.zero = ''
        const amount = node('dd', String(value))
        if (before?.[key] !== undefined) amount.append(trendCue(t, labels[key], value, before[key]))
        chip.append(node('dt', t(labels[key])), amount); counts.append(chip)
      }
      trends.set(trendKey, current)
      card.append(counts)
      if ('passed' in panel.counts || 'failed' in panel.counts) {
        const passed = panel.counts.passed || 0, total = passed + (panel.counts.failed || 0)
        const bar = node('div', undefined, 'mod-progress')
        bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', t(labels.passed))
        bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(total)); bar.setAttribute('aria-valuenow', String(passed))
        const fill = node('span', undefined, 'mod-progress-fill'); fill.style.width = total ? passed / total * 100 + '%' : '0%'
        bar.append(fill); card.append(bar)
      }
      if (panel.status) { const status = node('p',panel.status.text,'mod-status'); status.dataset.tone = panel.status.tone; card.append(status) }
      const message = node('p', '', 'mod-feedback'); message.setAttribute('role','status')
      const controls = node('div',undefined,'mod-controls')
      const invoke = async (control, selection) => {
        control.disabled = true; message.textContent = ''
        try {
          const result = await action({ ...selection, modId:panel.modId,panelId:panel.id,revision:view.revision })
          if (!result?.ok) message.textContent = error(t,result?.code)
          else if (result.type === 'draft' || result.type === 'delivered') { draft(result); message.textContent = t('Задача подготовлена. Отправка — только из Onlyone.') }
        } catch { message.textContent = error(t) }
        finally { control.disabled = false }
      }
      for (const item of panel.buttons) { const control=button(item.label,()=>invoke(control,{buttonId:item.id})); controls.append(control) }
      if (panel.status?.skillId) { const control=button(t('Подготовить диагностику'),()=>invoke(control,{suggestion:true,statusHash:panel.statusHash})); controls.append(control) }
      card.append(controls,message); host.append(card)
    }
  }
  window.OnlyoneModPanels = { node,button,error,paint }
})()
