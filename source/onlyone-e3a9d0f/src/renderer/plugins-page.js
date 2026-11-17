/* Раздел «Плагины» (OS-5): что уже поставлено в профиль — версия, состояние,
 * запрошенные и выданные права, кнопки согласия, отката и удаления, и журнал
 * действий рядом. Установка из файла сюда не входит: её делает команда
 * tools/plugin (plugin install), а раздел отвечает за согласие и порядок.
 *
 * Модуль ничего не знает о каркасе окна: данные и слова приходят в deps, строки
 * собираются через t из mk-kit (window.__t), разметка лежит в области .mk
 * (look-pages.css + plugins-page.css).
 */
(function (root) {
  'use strict'

  function create(deps) {
    const K = root.OnlyoneMk
    const { t, esc, B, L, pageHead, stateBlock } = K
    // Production bridge. The test injects deps.api; keeping both named here also proves the bridge is used.
    const bridge = {
      pluginsList: input => window.electronAPI.pluginsList(input),
      pluginsApprove: input => window.electronAPI.pluginsApprove(input),
      pluginsDisable: input => window.electronAPI.pluginsDisable(input),
      pluginsEnable: input => window.electronAPI.pluginsEnable(input),
      pluginsRollback: input => window.electronAPI.pluginsRollback(input),
      pluginsRemove: input => window.electronAPI.pluginsRemove(input)
    }
    const host = deps.host
    const inner = host.querySelector('.page-inner')

    let state = 'loading' // loading | content | error
    let plugins = []
    let journal = []
    let error = ''
    let seq = 0

    // Время журнала без locale: две машины с разными региональными настройками
    // должны показывать одну и ту же строку, а тест — знать, что искать.
    function fmtTime(value) {
      const at = new Date(value)
      if (Number.isNaN(at.getTime())) return value || ''
      const pad = n => String(n).padStart(2, '0')
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    const STATUS = () => ({
      enabled: [t('Работает'), 'ok'],
      disabled: [t('Отключён'), ''],
      quarantined: [t('На карантине'), 'bad']
    })
    const REASON = () => ({
      tampered: t('Файлы плагина изменились после установки. Откатите версию или удалите плагин.'),
      missing: t('Файлы плагина не читаются. Откатите версию или удалите плагин.')
    })
    // Действия журнала пишет и сам раздел, и установка из tools/plugin: известные
    // переводятся, незнакомые показываются как есть — прятать их нельзя.
    const ACTION = () => ({
      install: t('Установка'),
      approve: t('Разрешение'),
      disable: t('Отключение'),
      enable: t('Включение'),
      rollback: t('Откат'),
      remove: t('Удаление')
    })
    const RESULT = () => ({
      ok: t('Готово'),
      missing: t('Плагин не найден'),
      quarantined: t('Проверка не прошла'),
      invalid: t('Недопустимое значение'),
      'approval-required': t('Нужно согласие на права'),
      'action-failed': t('Не вышло'),
      forbidden: t('Только главное окно'),
      'storage-unavailable': t('Папка профиля недоступна')
    })
    const actionText = value => ACTION()[value] || value
    const resultText = value => RESULT()[value] || value
    // Граница честно: Job Object — лимиты процесса, AppContainer — файлы и сеть,
    // когда он доступен; чатов и ключей у плагина нет ни в каком режиме.
    const boundaryLine = () => `<p class="pl-note">${esc(t('Изоляция: лимиты процесса; файлы и сеть ограничены AppContainer, когда он доступен. Чаты и ключи плагину недоступны.'))}</p>`

    // ── Список ──
    function capsLine(label, caps, granted) {
      const chips = caps.length
        ? caps.map(cap => `<span class="pl-cap"${granted === undefined ? '' : ` data-granted="${granted.includes(cap)}"`}>${esc(cap)}</span>`).join('')
        : `<span class="pl-none">${esc(t('Ничего не выдано'))}</span>`
      return `<div class="pl-caps"><span class="pl-lbl">${esc(label)}</span>${chips}</div>`
    }

    function actions(plugin) {
      const id = ` data-id="${esc(plugin.id)}"`
      const acts = []
      if (plugin.status === 'enabled') acts.push(B(t('Отключить'), { icon: 'stop', x: 'pldis', attrs: id }))
      else if (plugin.status === 'disabled') {
        acts.push(plugin.pending.length
          ? B(t('Разрешить'), { kind: 'primary', icon: 'check', x: 'plappr', attrs: id })
          : B(t('Подключить'), { kind: 'primary', icon: 'play', x: 'plen', attrs: id }))
      }
      if (plugin.versions.length > 1) {
        const options = plugin.versions.slice().reverse().map(version =>
          `<option value="${esc(version)}"${version === plugin.version ? ' selected' : ''}>${esc(t('Версия %s', version))}</option>`).join('')
        acts.push(`<select class="pl-select" data-role="version" data-id="${esc(plugin.id)}" aria-label="${esc(t('Откатить версию'))}">${options}</select>`)
        acts.push(B(t('Откатить версию'), { icon: 'retry', x: 'plroll', attrs: id }))
      }
      acts.push(L(t('Удалить'), { danger: true, x: 'plrm', attrs: id }))
      return `<div class="pl-acts">${acts.join('')}</div>`
    }

    function pluginRow(plugin) {
      const [label, tone] = (STATUS()[plugin.status] || [plugin.status, ''])
      const note = REASON()[plugin.reason] || ''
      return `<div class="pl" data-plugin="${esc(plugin.id)}" data-status="${esc(plugin.status)}">` +
        `<div class="pl-main"><div class="pl-head"><span class="pl-name">${esc(plugin.id)}</span>` +
        `<span class="pl-ver">${esc(t('Версия %s', plugin.version))}</span>` +
        `<span class="status pl-status${tone ? ' ' + tone : ''}">${esc(label)}</span></div>` +
        capsLine(t('Запрошено'), plugin.requested) +
        capsLine(t('Выдано'), plugin.granted, plugin.granted) +
        (plugin.pending.length ? `<div class="pl-caps pl-pending"><span class="pl-lbl">${esc(t('Ждёт согласия'))}</span>${plugin.pending.map(cap => `<span class="pl-cap">${esc(cap)}</span>`).join('')}</div>` : '') +
        (note ? `<p class="pl-note">${esc(note)}</p>` : '') +
        `</div>${actions(plugin)}</div>`
    }

    function journalTable() {
      const rows = journal.map(entry => `<tr>` +
        `<td class="pl-time">${esc(fmtTime(entry.time))}</td>` +
        `<td>${esc(actionText(entry.action))}</td>` +
        `<td>${esc(entry.plugin || '—')}${entry.version ? ` <span class="pl-jver">${esc(entry.version)}</span>` : ''}</td>` +
        `<td>${esc(resultText(entry.result))}</td></tr>`).join('')
      return `<h2 class="grp">${esc(t('Журнал'))}<span class="sub">${esc(t('что происходило с плагинами'))}</span></h2>` +
        `<div class="pl-journal-wrap"><table class="pl-journal"><thead><tr>` +
        `<th scope="col">${esc(t('Время'))}</th><th scope="col">${esc(t('Действие'))}</th>` +
        `<th scope="col">${esc(t('Плагин'))}</th><th scope="col">${esc(t('Результат'))}</th>` +
        `</tr></thead><tbody>${rows}</tbody></table></div>` +
        (rows ? '' : `<p class="pl-note">${esc(t('Записей пока нет.'))}</p>`)
    }

    function paint() {
      const head = pageHead(t('Плагины'), t('Что установлено в профиле: права, согласие и журнал действий.'),
        B(t('Обновить'), { icon: 'retry', x: 'plrefresh', dis: state === 'loading' })) + boundaryLine()
      if (state === 'loading') {
        const skel = `<span class="skel" style="width:46%;height:14px"></span><span class="skel skel-line" style="width:64%;height:12px"></span>`
        inner.innerHTML = head + `<div class="list">${[1, 2].map(() => `<div class="pl pl-skeleton">${skel}</div>`).join('')}</div>`
        return
      }
      if (state === 'error') {
        inner.innerHTML = head + stateBlock({
          mood: 'sad', title: t('Плагины не загрузились'),
          body: esc(t('Список плагинов не прочитался. Ничего не изменено: повторите.')),
          acts: B(t('Повторить'), { kind: 'primary', icon: 'retry', x: 'plretry' }), tech: deps.lastError ? deps.lastError() : error
        })
        return
      }
      if (!plugins.length) {
        inner.innerHTML = head + stateBlock({
          title: t('Плагинов пока нет'),
          body: esc(t('Плагин ставится командой plugin install. Здесь — согласие на права, откат версии и журнал действий.')),
          acts: B(t('Обновить'), { icon: 'retry', x: 'plrefresh' })
        }) + journalTable()
        return
      }
      inner.innerHTML = head + `<div class="list">${plugins.map(pluginRow).join('')}</div>` + journalTable()
    }

    async function call(method, input) {
      const fn = deps.api?.[method] || bridge[method]
      if (typeof fn !== 'function') return { ok: false, code: 'action-failed' }
      try {
        const result = await fn(input)
        return result && typeof result === 'object' ? result : { ok: false, code: 'action-failed' }
      } catch {
        return { ok: false, code: 'action-failed' }
      }
    }

    async function refresh() {
      const mine = ++seq
      if (state !== 'content') { state = 'loading'; paint() }
      const result = await call('pluginsList')
      if (mine !== seq) return
      if (!result.ok) {
        state = 'error'
        error = result.code || ''
        paint()
        return
      }
      plugins = Array.isArray(result.plugins) ? result.plugins : []
      journal = Array.isArray(result.journal) ? result.journal : []
      state = 'content'
      paint()
    }

    async function run(method, input, done) {
      const result = await call(method, input)
      if (!result.ok) {
        deps.toast?.(t('Плагин: %s', resultText(result.code || 'action-failed')), true)
      } else if (done) deps.toast?.(done)
      await refresh()
    }

    async function remove(id) {
      const go = await deps.confirm?.(t('Удалить плагин «%s»? Файлы всех версий будут удалены.', id), t('Удалить'))
      if (!go) return
      await run('pluginsRemove', { id }, t('Плагин удалён'))
    }

    function onClick(event) {
      const el = event.target.closest?.('[data-x]')
      if (!el || !host.contains(el)) return
      const id = el.dataset.id || ''
      const x = el.dataset.x
      if (x === 'tech') {
        const pre = el.closest('.state')?.querySelector('.fail-tech')
        if (!pre) return
        pre.hidden = !pre.hidden
        el.setAttribute('aria-expanded', String(!pre.hidden))
        return
      }
      if (x === 'plrefresh' || x === 'plretry') { refresh(); return }
      if (x === 'plappr') { run('pluginsApprove', { id }, t('Права выданы, плагин включён')); return }
      if (x === 'pldis') { run('pluginsDisable', { id }, t('Плагин отключён')); return }
      if (x === 'plen') { run('pluginsEnable', { id }, t('Плагин включён')); return }
      if (x === 'plroll') {
        const select = el.closest('.pl')?.querySelector('select[data-role="version"]')
        const version = select?.value || ''
        if (version) run('pluginsRollback', { id, version }, t('Версия возвращена: %s', version))
        return
      }
      if (x === 'plrm') remove(id)
    }

    host.addEventListener('click', onClick)
    refresh()

    return {
      refresh,
      repaint: paint,
      get state() { return state }
    }
  }

  root.OnlyonePluginsPage = Object.freeze({ create })
})(window)
