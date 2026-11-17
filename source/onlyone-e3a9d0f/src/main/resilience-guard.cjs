'use strict'

// Модуль защиты и устойчивости главного процесса Onlyone (Resilience Guard).
//
// Изолирует необработанные исключения (uncaughtException) и отклонения промисов
// (unhandledRejection), управляет жизненным циклом и зачисткой дочерних процессов
// (предотвращение зомби-процессов), обрабатывает сигналы завершения (SIGINT/SIGTERM)
// и обеспечивает барьер от шквала IPC-запросов (IPC flood / storm).

const { EventEmitter } = require('node:events')

function createResilienceGuard({
  latency = null,
  onLog = null,
  abortTurns = null,
  terminateProcesses = null,
  onShutdown = null,
  isProduction = process.env.NODE_ENV === 'production'
} = {}) {
  const capturedRejections = []
  const capturedExceptions = []
  let installed = false
  let isShuttingDown = false

  const log = message => {
    try {
      if (typeof onLog === 'function') onLog(message)
      if (latency && typeof latency.write === 'function') {
        latency.write(`resilience: ${message}`)
      } else if (!isProduction) {
        console.warn(`[resilience] ${message}`)
      }
    } catch {
      // Логгер не должен приводить к вторичному сбою
    }
  }

  const handleUnhandledRejection = (reason, promise) => {
    const errorText = reason instanceof Error ? (reason.stack || reason.message) : String(reason)
    const record = { reason, promise, at: Date.now(), text: errorText }
    capturedRejections.push(record)

    log(`unhandledRejection isolated: ${errorText.slice(0, 300)}`)

    if (process.emitWarning) {
      process.emitWarning(`[resilience] unhandledRejection isolated: ${reason?.message || reason}`)
    }
  }

  const handleUncaughtException = (error, origin = 'unknown') => {
    const errorText = error instanceof Error ? (error.stack || error.message) : String(error)
    const record = { error, origin, at: Date.now(), text: errorText }
    capturedExceptions.push(record)

    log(`uncaughtException [${origin}] isolated: ${errorText.slice(0, 300)}`)

    // Нефатальные ошибки (например, обрыв сокета/потока, отмена IPC, сбои временных файлов)
    // не должны убивать весь Electron-процесс.
    const isNonFatal = /EBUSY|ENOENT|EPIPE|ECONNRESET|destroyed|aborted|canceled|closed/i.test(errorText)
      || origin === 'timerCallback'
      || origin === 'unhandledRejection'

    if (!isNonFatal && isProduction) {
      // При потенциально фатальном сбое в продакшене гарантируем безопасную зачистку
      log('критический сбой: экстренная зачистка ресурсов перед завершением')
      emergencyCleanup()
    }
  }

  const handleTerminationSignal = signal => {
    if (isShuttingDown) return
    isShuttingDown = true

    log(`получен сигнал завершения ${signal}: запуск безопасной остановки`)
    emergencyCleanup(signal)

    if (typeof onShutdown === 'function') {
      try { onShutdown(signal) } catch (err) { log(`ошибка при shutdown: ${err?.message || err}`) }
    }
  }

  const onSigInt = () => handleTerminationSignal('SIGINT')
  const onSigTerm = () => handleTerminationSignal('SIGTERM')

  function emergencyCleanup(reason = 'emergencyCleanup') {
    try {
      if (typeof abortTurns === 'function') abortTurns(reason)
    } catch (err) {
      log(`ошибка при отмене ходов: ${err?.message || err}`)
    }
    try {
      if (typeof terminateProcesses === 'function') terminateProcesses()
    } catch (err) {
      log(`ошибка при зачистке процессов: ${err?.message || err}`)
    }
  }

  function install() {
    if (installed) return
    installed = true

    process.on('unhandledRejection', handleUnhandledRejection)
    process.on('uncaughtException', handleUncaughtException)
    process.on('SIGINT', onSigInt)
    process.on('SIGTERM', onSigTerm)

    return uninstall
  }

  function uninstall() {
    if (!installed) return
    installed = false

    process.removeListener('unhandledRejection', handleUnhandledRejection)
    process.removeListener('uncaughtException', handleUncaughtException)
    process.removeListener('SIGINT', onSigInt)
    process.removeListener('SIGTERM', onSigTerm)
  }

  return {
    install,
    uninstall,
    emergencyCleanup,
    getCapturedRejections: () => [...capturedRejections],
    getCapturedExceptions: () => [...capturedExceptions],
    clearCaptured: () => {
      capturedRejections.length = 0
      capturedExceptions.length = 0
    }
  }
}

// Барьер от шквала IPC-запросов и race conditions
function createIpcFloodBarrier({ activeControllers = new Map(), maxBurst = 100 } = {}) {
  let inFlightCount = 0

  return {
    registerRequest(requestId, event) {
      inFlightCount++
      const id = requestId || 'default'

      // Если запрос с таким же id уже выполняется (гонка кликов / шквал IPC),
      // безопасно отменяем предыдущий, предотвращая зависшие "зомби-ходы"
      const existing = activeControllers.get(id)
      if (existing && !existing.signal.aborted) {
        try {
          existing.abort(new Error('Замещено новым запросом в IPC-шторме'))
        } catch {}
      }

      const controller = new AbortController()
      controller.windowId = event?.sender?.id != null ? event.sender.id : null
      activeControllers.set(id, controller)
      return controller
    },

    finishRequest(requestId) {
      inFlightCount = Math.max(0, inFlightCount - 1)
      const id = requestId || 'default'
      activeControllers.delete(id)
    },

    abortRequest(requestId) {
      const id = requestId || 'default'
      const controller = activeControllers.get(id)
      if (controller) {
        try { controller.abort() } catch {}
        activeControllers.delete(id)
        return { aborted: true }
      }
      return { aborted: false }
    },

    getInFlightCount: () => inFlightCount
  }
}

module.exports = {
  createResilienceGuard,
  createIpcFloodBarrier
}
