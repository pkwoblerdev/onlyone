/* Регулировка панели «Браузер / Превью» в чате: ширина (потянуть за левый край, стрелками или двойным щелчком — вернуть) и
 * масштаб страницы (− / процент / +). Выбор запоминается. Модуль не знает ни webview, ни вкладок: масштаб он отдаёт
 * колбэку, ширину ставит переменной --artifact-w-user у #chatView, которую уже читает вёрстка панели.
 */
(function (root) {
  'use strict'

  const WIDTH_KEY = 'onlyone.artifactWidth'
  const ZOOM_KEY = 'onlyone.browserZoom'
  const MIN_WIDTH = 320
  const KEY_STEP = 24
  const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

  const read = key => { try { return localStorage.getItem(key) } catch { return null } }
  const write = (key, value) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, String(value)) } catch { /* без памяти работаем */ } }

  function create (deps) {
    const { $, document, t } = deps
    let width = Number(read(WIDTH_KEY)) || 0
    let zoomAt = Math.max(0, ZOOMS.indexOf(Number(read(ZOOM_KEY)) || 1))
    if (zoomAt < 0) zoomAt = ZOOMS.indexOf(1)

    const maxWidth = () => Math.max(MIN_WIDTH, Math.min(1100, (root.innerWidth || 1200) - 420))
    const clamp = value => Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(value)))

    function applyWidth () {
      const chat = $('chatView')
      if (!chat) return
      if (width) chat.style.setProperty('--artifact-w-user', clamp(width) + 'px')
      else chat.style.removeProperty('--artifact-w-user')
    }
    function setWidth (value, save = true) {
      width = value ? clamp(value) : 0
      applyWidth()
      if (save) write(WIDTH_KEY, width || null)
      const bar = $('artifactResizer')
      if (bar) bar.setAttribute('aria-valuenow', String(width || Math.round($('artifactPanel')?.getBoundingClientRect().width || 0)))
    }

    const zoom = () => ZOOMS[zoomAt]
    function paintZoom () {
      const label = $('browserZoomLevel')
      if (label) label.textContent = Math.round(zoom() * 100) + '%'
      const out = $('browserZoomOut'); const plus = $('browserZoomIn')
      if (out) out.disabled = zoomAt === 0
      if (plus) plus.disabled = zoomAt === ZOOMS.length - 1
    }
    function setZoomIndex (index) {
      zoomAt = Math.max(0, Math.min(ZOOMS.length - 1, index))
      write(ZOOM_KEY, zoom() === 1 ? null : zoom())
      paintZoom()
      if (deps.onZoom) deps.onZoom(zoom())
    }

    function bind () {
      applyWidth()
      paintZoom()
      const bar = $('artifactResizer')
      if (bar) {
        bar.addEventListener('pointerdown', event => {
          event.preventDefault()
          const panel = $('artifactPanel')
          const start = { x: event.clientX, w: panel ? panel.getBoundingClientRect().width : width || MIN_WIDTH }
          bar.setPointerCapture?.(event.pointerId)
          document.body.classList.add('is-resizing-panel')
          const move = e => setWidth(start.w + (start.x - e.clientX), false)
          const stop = () => {
            bar.removeEventListener('pointermove', move)
            bar.removeEventListener('pointerup', stop)
            bar.removeEventListener('pointercancel', stop)
            document.body.classList.remove('is-resizing-panel')
            write(WIDTH_KEY, width || null)
          }
          bar.addEventListener('pointermove', move)
          bar.addEventListener('pointerup', stop)
          bar.addEventListener('pointercancel', stop)
        })
        bar.addEventListener('keydown', event => {
          const now = width || $('artifactPanel')?.getBoundingClientRect().width || MIN_WIDTH
          if (event.key === 'ArrowLeft') { event.preventDefault(); setWidth(now + KEY_STEP) }
          if (event.key === 'ArrowRight') { event.preventDefault(); setWidth(now - KEY_STEP) }
          if (event.key === 'Home' || event.key === 'Escape') { event.preventDefault(); setWidth(0) }
        })
        bar.addEventListener('dblclick', () => setWidth(0))
      }
      $('browserZoomOut')?.addEventListener('click', () => setZoomIndex(zoomAt - 1))
      $('browserZoomIn')?.addEventListener('click', () => setZoomIndex(zoomAt + 1))
      $('browserZoomLevel')?.addEventListener('click', () => setZoomIndex(ZOOMS.indexOf(1)))
      root.addEventListener('resize', applyWidth)
    }

    return { bind, setWidth, getWidth: () => width, zoom, setZoomIndex, ZOOMS }
  }

  const api = { create, WIDTH_KEY, ZOOM_KEY, MIN_WIDTH, ZOOMS }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.OnlyonePanelAdjust = api
})(typeof window !== 'undefined' ? window : globalThis)
