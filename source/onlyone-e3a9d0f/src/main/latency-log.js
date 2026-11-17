'use strict'

// Журнал задержек. Владелец видел, как настройки открываются секунд десять, а
// на копии его профиля замер дал 15–42 мс — задержку в лаборатории поймать не
// удалось. Поэтому она ловится там, где случается: главный процесс замечает,
// что его таймер опоздал, окно сообщает о своих долгих задачах, и каждая
// запись говорит, что в этот момент делалось.
//
// Файл — logs/latency.log в папке данных, одна строка на случай, не больше
// 512 КБ (старое уходит в latency.1.log). Ни текста переписки, ни ключей.

const fs = require('fs')
const path = require('path')

const LOOP_INTERVAL_MS = 200
const LOOP_THRESHOLD_MS = 250
const MAX_BYTES = 512 * 1024

function create({ dir, now = () => Date.now(), clock = () => performance.now() }) {
  const file = path.join(dir, 'latency.log')
  const busy = new Map()
  let seq = 0
  let timer = null

  function write(line) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, 'latency.1.log'))
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError
      }
      fs.appendFileSync(file, `${new Date(now()).toISOString()} ${line}\n`)
    } catch (error) {
      // Журнал — вспомогательный: если его не записать, работа не должна падать.
      process.emitWarning?.(`latency-log: ${error?.message || error}`)
    }
  }

  // Что сейчас делает главный процесс: имена обработчиков IPC и операций
  // хранилища, которые начались и ещё не закончились.
  function begin(label) {
    const id = ++seq
    busy.set(id, { label, at: clock() })
    return () => busy.delete(id)
  }

  function activity() {
    const t = clock()
    return [...busy.values()].map(item => `${item.label} ${Math.round(t - item.at)}мс`).join(', ') || '—'
  }

  function measure(label, fn, { slowMs = 50 } = {}) {
    const end = begin(label)
    const started = clock()
    try {
      return fn()
    } finally {
      end()
      const took = clock() - started
      if (took >= slowMs) write(`main slow ${label} ${Math.round(took)}мс`)
    }
  }

  function startLoopMonitor() {
    let expected = clock() + LOOP_INTERVAL_MS
    timer = setInterval(() => {
      const t = clock()
      const lag = t - expected
      expected = t + LOOP_INTERVAL_MS
      if (lag >= LOOP_THRESHOLD_MS) write(`main lag ${Math.round(lag)}мс; шло: ${activity()}`)
    }, LOOP_INTERVAL_MS)
    timer.unref?.()
  }

  function stop() { clearInterval(timer) }

  function fromWindow(report) {
    const ms = Math.round(Number(report?.ms) || 0)
    if (ms <= 0) return
    const what = String(report?.what || '—').replace(/\s+/g, ' ').slice(0, 160)
    write(`window long ${ms}мс; после: ${what}; главный: ${activity()}`)
  }

  return { file, begin, measure, startLoopMonitor, stop, fromWindow, write, activity }
}

module.exports = { create, LOOP_INTERVAL_MS, LOOP_THRESHOLD_MS, MAX_BYTES }
