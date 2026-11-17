/* Раздел «Удалённое управление» в настройках (волна 4): включение, код с QR, список устройств.
 * Состояние живёт в главном процессе (remote-control.js); здесь только показ и кнопки.
 */
(function (root) {
  'use strict'

  const AUDIT_WORDS = {
    send: 'Сообщение с телефона', stop: 'Остановка хода с телефона', approve: 'Разрешение с телефона', reject: 'Отказ с телефона',
    answer: 'Ответ на вопрос с телефона', 'pair-approved': 'Устройство подключено', 'pair-denied': 'Подключение отклонено',
    revoke: 'Устройство отключено', 'revoke-all': 'Все устройства отключены'
  }

  function create(deps) {
    const { electronAPI, t, $, document: doc, escapeHtml, showToast } = deps
    let state = null
    let tick = null

    const els = () => ({
      enabled: $('remoteEnabled'), body: $('remoteBody'), pairBtn: $('remotePairBtn'), pairBox: $('remotePairBox'),
      code: $('remoteCode'), qr: $('remoteQr'), countdown: $('remoteCountdown'), pending: $('remotePending'), cancel: $('remoteCancelPair'),
      devices: $('remoteDevices'), none: $('remoteNoDevices'), revokeAll: $('remoteRevokeAll'), audit: $('remoteAudit'), auditBox: $('remoteAuditBox')
    })

    function qrMarkup(text) {
      try {
        const qr = root.qrcode(0, 'M')
        qr.addData(text)
        qr.make()
        return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
      } catch { return '' }
    }

    function formatLeft(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
    }

    function paintCountdown() {
      const e = els()
      if (!e.countdown) return
      if (!state || !state.pairing) { e.countdown.textContent = ''; return }
      const left = state.pairing.expiresAt - Date.now()
      e.countdown.textContent = left > 0 ? t('Код действует ещё %s', formatLeft(left)) : t('Код устарел: покажите новый')
    }

    function render(next) {
      if (next) state = next
      if (!state) return
      const e = els()
      if (!e.enabled) return
      e.enabled.checked = state.enabled
      e.body.hidden = !state.enabled
      e.pairBtn.hidden = Boolean(state.pairing)
      e.pairBox.hidden = !state.pairing
      if (state.pairing) {
        e.code.textContent = state.pairing.code
        e.qr.innerHTML = qrMarkup(state.pairing.link)
        const pending = state.pairing.pending
        e.pending.hidden = !pending
        e.pending.textContent = pending ? t('Телефон «%s» просит подключиться. Цифры сверки: %s', pending.name, pending.sas) : ''
      }
      e.devices.innerHTML = ''
      e.none.hidden = state.devices.length > 0
      e.revokeAll.hidden = !state.enabled
      for (const device of state.devices) {
        const row = doc.createElement('div')
        row.className = 'remote-device'
        const seen = device.lastSeen ? new Date(device.lastSeen).toLocaleString() : '—'
        row.innerHTML = '<span class="remote-device-dot' + (device.online ? ' online' : '') + '" aria-hidden="true"></span>' +
          '<span class="remote-device-main"><span class="remote-device-name">' + escapeHtml(device.name) + '</span>' +
          '<span class="remote-device-meta">' + escapeHtml(device.online ? t('в сети') : t('не в сети, был: %s', seen)) + '</span></span>' +
          ''
        e.devices.appendChild(row)
      }
      const log = (state.audit || []).slice().reverse()
      e.auditBox.hidden = log.length === 0
      e.audit.innerHTML = log.map(item => '<li><span class="remote-audit-time">' + escapeHtml(new Date(item.at).toLocaleString()) + '</span> ' +
        escapeHtml(t(AUDIT_WORDS[item.what] || item.what)) + (item.summary ? ': ' + escapeHtml(String(item.summary)) : '') + '</li>').join('')
      paintCountdown()
    }

    async function refresh() { render(await electronAPI.remoteState()) }

    function setup() {
      const e = els()
      if (!e.enabled) return
      e.enabled.addEventListener('change', async () => {
        try { render(await electronAPI.remoteSetEnabled(e.enabled.checked)) } catch {
          e.enabled.checked = false
          showToast(t('Удалённое управление пока недоступно: сервер не настроен'), true)
          await refresh().catch(() => {})
        }
      })
      e.pairBtn.addEventListener('click', async () => {
        const answer = await electronAPI.remoteBeginPairing()
        if (!answer.ok) { showToast(answer.error || t('Не удалось показать код'), true); return }
        await refresh()
      })
      e.cancel.addEventListener('click', async () => { render(await electronAPI.remoteCancelPairing()) })
      e.revokeAll.addEventListener('click', async () => {
        if (typeof deps.confirm === 'function' && !(await deps.confirm('Сбросить код? Прежний код и подключённые по нему телефоны перестанут работать, появится новый код.', 'Сбросить'))) return
        await electronAPI.remoteRevokeAll()
        const answer = await electronAPI.remoteBeginPairing()
        if (!answer.ok) showToast(answer.error || t('Не удалось показать код'), true)
        await refresh()
      })
      electronAPI.onRemoteState(render)
      tick = setInterval(paintCountdown, 1000)
      if (tick && tick.unref) tick.unref()
      refresh().catch(() => {})
    }

    return { setup, refresh, render, paintCountdown }
  }

  const api = { create, AUDIT_WORDS }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyoneRemoteSettings = api
})(typeof window !== 'undefined' ? window : globalThis)
