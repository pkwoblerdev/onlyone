'use strict'

// Виртуальные часы страницы для покадрового рендера (план, 9.8).
//
// Строка-скрипт вставляется в страницу ДО её собственных скриптов. Она подменяет
// все источники времени — setTimeout/setInterval, requestAnimationFrame,
// performance.now, Date.now — одним счётчиком, который двигает рендерер кадр за
// кадром, а CSS-анимации и переходы (Web Animations) ставит на паузу и
// перематывает на момент кадра. Каждый кадр поэтому снимается ровно в свой момент,
// без рывков и пропусков, сколько бы ни занимала отрисовка, и один и тот же ролик
// собирается одним и тем же.
//
// Чего часы НЕ покрывают: <video>/<audio> внутри страницы идут в реальном времени
// (ролик-вставку заранее режут ffmpeg-ом в кадры или картинку), `new Date()` без
// аргументов читает настоящие часы (берите Date.now()).

const CLOCK_SOURCE = `(() => {
  if (window.__clip) return
  const realSetTimeout = window.setTimeout.bind(window)
  let now = 0
  let seq = 0
  const timers = new Map()
  let frames = []
  window.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++seq
    timers.set(id, { due: now + Math.max(0, Number(ms) || 0), fn, args, seq: id })
    return id
  }
  window.clearTimeout = id => { timers.delete(id) }
  window.setInterval = (fn, ms = 0, ...args) => {
    const id = ++seq
    const step = Math.max(1, Number(ms) || 0)
    const arm = due => timers.set(id, { due, fn: () => { arm(due + step); fn(...args) }, args: [], seq: ++seq })
    arm(now + step)
    return id
  }
  window.clearInterval = id => { timers.delete(id) }
  window.requestAnimationFrame = fn => { const id = ++seq; frames.push({ id, fn }); return id }
  window.cancelAnimationFrame = id => { frames = frames.filter(item => item.id !== id) }
  performance.now = () => now
  const epoch = Date.UTC(2026, 0, 1, 0, 0, 0)
  Date.now = () => epoch + now

  const starts = new WeakMap()
  const adopt = at => {
    for (const anim of document.getAnimations()) {
      if (!starts.has(anim)) { starts.set(anim, at); anim.pause() }
    }
  }
  const seek = () => {
    for (const anim of document.getAnimations()) {
      if (!starts.has(anim)) { starts.set(anim, now); anim.pause() }
      anim.currentTime = Math.max(0, now - starts.get(anim))
    }
  }
  const flush = () => new Promise(resolve => realSetTimeout(resolve, 0))

  window.__clip = {
    now: () => now,
    async advanceTo(target) {
      for (;;) {
        let next = null
        for (const [id, timer] of timers) {
          if (timer.due > target) continue
          if (!next || timer.due < next.timer.due || (timer.due === next.timer.due && timer.seq < next.timer.seq)) next = { id, timer }
        }
        if (!next) break
        timers.delete(next.id)
        now = Math.max(now, next.timer.due)
        try { next.timer.fn(...next.timer.args) } catch (error) { console.error('таймер ролика:', error) }
        await flush()
        adopt(now)
      }
      now = Math.max(now, target)
      // Кадр анимации страницы: одна порция на кадр ролика, с меткой времени кадра.
      const due = frames
      frames = []
      for (const item of due) {
        try { item.fn(now) } catch (error) { console.error('кадр анимации ролика:', error) }
      }
      await flush()
      adopt(now)
      seek()
    }
  }
})()`

module.exports = { CLOCK_SOURCE }
