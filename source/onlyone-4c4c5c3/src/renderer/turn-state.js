/* Состояние хода в ленте (макет 19.10, «Честная ошибка: один шаблон, три причины»).
 *
 * Провал хода раньше был абзацем ответа «⚠️ **Итог не собран.** …» — его надо
 * было прочитать, чтобы понять, что случилось и что делать. Теперь это тот же
 * шаблон состояния, что у пустых разделов: приглушённая искорка, заголовок по
 * причине, что случилось и что цело, одно главное действие и тихие рядом.
 * Технический текст — под «Подробностями».
 *
 * Причина берётся из `msg.failure` (новые ходы) или из текста старого ответа:
 * чаты, записанные до переноса, показываются так же. Остальной текст ответа
 * (что успели сделать другие агенты) остаётся под блоком как был.
 */
(function (root) {
  'use strict'

  const PREFIXES = [/^⚠️\s*\*\*Итог не собран\.\*\*\s*/, /^⚠️\s*Ответа нет:\s*/, /^⚠️\s*Ход завершился, но ответа не пришло\.?\s*/]

  // Текст причины из сохранённого ответа: первый абзац без значка и жирного начала.
  function failureOf(msg) {
    if (!msg || msg.role !== 'assistant') return null
    if (msg.failure) return String(msg.failure)
    const text = String(msg.content || '').trim()
    if (!PREFIXES.some(re => re.test(text))) return null
    const first = text.split(/\n\s*\n/)[0]
    return PREFIXES.reduce((s, re) => s.replace(re, ''), first).trim() || 'Ответ не получен'
  }

  function kindOf(reason) {
    if (/401|403|User not found|Ключ отклонён|не принял ключ|No auth credentials|Unauthorized|ключ[а-я]* (?:нет|не задан)/i.test(reason)) return 'key'
    if (/unavailable for free|No endpoints found|only available on agentic harnesses|нет в каталоге|недоступна/i.test(reason)) return 'model'
    if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket|timeout|тайм-?аут|соединени|связ[ьи]|оборвал|не вернул ответ|не пришло|429|502|503|504|rate.?limit/i.test(reason)) return 'net'
    return 'crash'
  }

  const ICON = {
    retry: '<path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4"/><path d="M11.8 2.2V5H9"/>',
    key: '<circle cx="5.4" cy="10.6" r="2.4"/><path d="M7.1 8.9l5.1-5.1M10.6 5.4l1.6 1.6"/>',
    copy: '<rect x="5.6" y="5.6" width="8" height="8" rx="2"/><path d="M10.4 3.6c-.2-.8-.9-1.4-1.7-1.4H4c-1 0-1.8.8-1.8 1.8v4.7c0 .8.6 1.5 1.4 1.7"/>'
  }
  const icon = name => `<svg fill="none" class="icon" viewBox="0 0 16 16" aria-hidden="true">${ICON[name]}</svg>`

  // deps: { t, escapeHtml, markPath(), provider(), retry(), changeModel(), openKeys(), addKey(value), version }
  function decorate(item, msg, deps) {
    const reason = failureOf(msg)
    if (!reason || !item) return false
    const { t, escapeHtml } = deps
    const kind = kindOf(reason)
    const provider = deps.provider?.() || 'OpenRouter'
    const changed = Array.isArray(msg.fileChanges) ? msg.fileChanges.length : 0
    const kept = changed
      ? t('Правки в файлах (%s) сохранены.', changed)
      : t('В проекте ничего не изменено.')
    const TEXT = {
      net: { title: t('Связь с %s оборвалась', provider), body: kept + ' ' + t('Ответ не дописан — повторите ход или смените модель.') },
      model: { title: t('Модель сейчас недоступна'), body: kept + ' ' + t('Выберите другую модель и повторите ход.') },
      key: { title: t('%s не принял ключ', provider), body: kept + ' ' + t('Вставьте ключ ещё раз — проверим и продолжим.') },
      crash: { title: t('Ход не завершился'), body: kept + ' ' + t('Повторите ход; если сбой вернётся, скопируйте отчёт — кода и ключей в нём нет.') }
    }[kind]

    const box = document.createElement('section')
    box.className = 'state in-chat'
    box.setAttribute('role', 'alert')
    const mark = `<svg class="state-mark sad" viewBox="9 9 46 46" width="24" height="24" aria-hidden="true">${deps.markPath?.() || ''}</svg>`
    box.innerHTML = `${mark}<h2>${escapeHtml(TEXT.title)}</h2><p>${escapeHtml(TEXT.body)}</p>`
    const acts = document.createElement('div')
    acts.className = 'fail-acts'
    const tech = document.createElement('pre')
    tech.className = 'fail-tech'
    tech.hidden = true
    tech.textContent = reason + (deps.version ? `\nonlyone ${deps.version}` : '')
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'lnk'
    more.textContent = t('Подробности')
    more.setAttribute('aria-expanded', 'false')
    more.addEventListener('click', () => {
      tech.hidden = !tech.hidden
      more.setAttribute('aria-expanded', String(!tech.hidden))
    })
    const button = (cls, html, onClick) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.innerHTML = html
      b.addEventListener('click', onClick)
      return b
    }
    const retry = button('btn btn-primary', `${icon('retry')}<span>${escapeHtml(t('Повторить'))}</span>`, () => deps.retry?.())
    const model = button('btn btn-secondary', escapeHtml(t('Сменить модель')), e => { e.stopPropagation(); deps.changeModel?.() })

    if (kind === 'key' && deps.addKey) {
      const row = document.createElement('form')
      row.className = 'key-row'
      const fieldId = 'turnKey' + Math.random().toString(36).slice(2, 8)
      row.innerHTML = `<label class="visually-hidden" for="${fieldId}">${escapeHtml(t('Ключ %s', provider))}</label>` +
        `<input class="field-input" id="${fieldId}" type="password" placeholder="sk-or-…" autocomplete="off" spellcheck="false" aria-describedby="${fieldId}m">` +
        `<button class="btn btn-primary" type="submit">${icon('key')}<span>${escapeHtml(t('Проверить и продолжить'))}</span></button>` +
        `<span class="field-msg" id="${fieldId}m" aria-live="polite"></span>`
      const field = row.querySelector('input')
      const msgEl = row.querySelector('.field-msg')
      const go = row.querySelector('button')
      field.addEventListener('input', () => { field.removeAttribute('aria-invalid'); msgEl.textContent = '' })
      row.addEventListener('submit', async e => {
        e.preventDefault()
        const value = field.value.trim()
        if (!value) {
          field.setAttribute('aria-invalid', 'true')
          msgEl.textContent = t('Вставьте ключ целиком')
          field.focus()
          return
        }
        go.disabled = true
        go.querySelector('span').textContent = t('Проверяю…')
        try {
          await deps.addKey(value)
          box.querySelector('.state-mark')?.classList.remove('sad')
          deps.retry?.()
        } catch (err) {
          field.setAttribute('aria-invalid', 'true')
          msgEl.textContent = String(err?.message || err || t('Ключ не принят')).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/i, '')
          go.disabled = false
          go.querySelector('span').textContent = t('Проверить и продолжить')
        }
      })
      box.append(row)
      acts.classList.add('tight')
      acts.append(more)
    } else if (kind === 'key') {
      acts.append(button('btn btn-primary', `${icon('key')}<span>${escapeHtml(t('Открыть ключи'))}</span>`, () => deps.openKeys?.()), more)
    } else if (kind === 'model') {
      acts.append(button('btn btn-primary', escapeHtml(t('Сменить модель')), e => { e.stopPropagation(); deps.changeModel?.() }),
        button('btn btn-secondary', `${icon('retry')}<span>${escapeHtml(t('Повторить'))}</span>`, () => deps.retry?.()), more)
    } else if (kind === 'crash') {
      const report = button('btn btn-secondary', `${icon('copy')}<span>${escapeHtml(t('Скопировать отчёт'))}</span>`, async () => {
        try {
          await navigator.clipboard.writeText(tech.textContent)
          report.querySelector('span').textContent = t('Отчёт скопирован')
        } catch {
          tech.hidden = false
          more.setAttribute('aria-expanded', 'true')
        }
      })
      acts.append(retry, report, more)
    } else {
      acts.append(retry, model, more)
    }
    box.append(acts, tech)

    // Первый абзац с причиной заменяется блоком; что успели сделать другие
    // агенты (ниже черты) остаётся как было.
    const content = item.querySelector('.msg-content')
    const first = content?.querySelector('p')
    if (first && /⚠️|Итог не собран|Ответа нет|ответа не пришло/.test(first.textContent)) first.replaceWith(box)
    else (content || item).prepend(box)
    item.classList.add('has-state')
    return true
  }

  root.OnlyoneTurnState = Object.freeze({ decorate, failureOf, kindOf })
})(typeof window !== 'undefined' ? window : globalThis)
