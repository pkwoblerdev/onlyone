/* Настройки → Работа → Видео (9.8): состояние ffmpeg и установка одной кнопкой.
 *
 * Проба кодеров запускает несколько процессов ffmpeg, поэтому состояние читается не на
 * старте окна, а когда человек открывает вкладку «Работа» (refresh) — иначе проба
 * тормозила бы всё остальное, пока окно поднимается.
 */
(function (root) {
  'use strict'

  function create (deps) {
    const { $, t, electronAPI, showToast, cleanErrorText } = deps
    let wired = false

    function show (state) {
      const line = $('videoToolsStatus')
      const button = $('btnFfmpegInstall')
      if (!line || !button) return
      if (state && state.found) {
        line.textContent = t('Готов: ffmpeg %s · кодер %s', state.version || '?', state.best || '—')
        button.hidden = true
      } else if (state && state.canInstall) {
        line.textContent = t('ffmpeg не найден. Он нужен агенту, чтобы монтировать и рендерить видео.')
        button.hidden = false
        button.disabled = false
      } else {
        line.textContent = t('ffmpeg не найден. Установите его: %s', (state && state.installHint) || '')
        button.hidden = true
      }
    }

    // Без принудительной пробы: кодеры проверяются один раз и держатся в памяти главного процесса.
    function refresh () {
      if (!electronAPI.getFfmpegStatus || !$('videoToolsStatus')) return Promise.resolve()
      return electronAPI.getFfmpegStatus(false).then(show)
        .catch(() => { $('videoToolsStatus').textContent = t('Не удалось проверить ffmpeg') })
    }

    function bind () {
      const line = $('videoToolsStatus')
      const button = $('btnFfmpegInstall')
      if (wired || !line || !button || !electronAPI.getFfmpegStatus) return
      wired = true
      button.addEventListener('click', async () => {
        button.disabled = true
        line.textContent = t('Устанавливаю ffmpeg через winget…')
        try {
          const done = await electronAPI.installFfmpeg()
          if (!done || !done.ok) throw new Error((done && done.error) || t('Установка не удалась'))
          show(done.status)
          showToast(t('ffmpeg установлен'))
        } catch (err) {
          button.disabled = false
          line.textContent = cleanErrorText(err) || t('Установка не удалась')
        }
      })
    }

    return Object.freeze({ bind, refresh, show })
  }

  const api = Object.freeze({ create })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OnlyoneVideoSettings = api
})(typeof window === 'object' ? window : globalThis)
