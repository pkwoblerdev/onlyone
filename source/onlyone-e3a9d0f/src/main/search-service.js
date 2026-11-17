'use strict'

// Поиск по файлам — в отдельном потоке.
//
// В главном процессе приложение разбирает строки и гоняет регулярки: на дереве
// с исходниками onlyone это десятки тысяч файлов, и окно замирало бы ровно
// посреди ответа модели. Поток с таймаутом даёт и то, и другое: окно живёт, а
// поиск, который не закончился, обрывается с уже найденным на руках.

const path = require('path')
const { Worker } = require('worker_threads')

const WORKER_FILE = path.join(__dirname, 'workspace-search-worker.js')
const DEFAULT_TIMEOUT_MS = 25000

// ── Почему у обхода два срока, а не один ────────────────────────────────────
//
// Таймер потока — единственная сила, которой можно остановить поток, застрявший
// внутри нативного `RegExp.exec`: изнутри такой вызов не прерывается ничем. Но
// убийством нельзя отдать метаданные — `files` и `skipped` при нём остаются
// нулями, а найденное доходит лишь тем частями, что поток успел прислать.
//
// Поэтому потоку дополнительно сообщают бюджет обхода — на запас короче
// таймера. Штатный большой поиск теперь упирается в него и возвращается сам, с
// полным списком метаданных; terminate() остаётся для единственного случая,
// где своего срока не видно, — одного бесконечного вызова регулярки.
//
// Наружу бюджетный обрыв уходит как 'timeout': главный процесс понимает только
// этот смысл («не уложился, показаны первые совпадения, уточни запрос») и
// подставляет в текст фактическое `ms`, то есть 23 с вместо 25 он прочтёт
// правильно. Отдельного слова для второго слоя не заводим.
const WORKER_RESERVE_MS = 2500
const MIN_BUDGET_MS = 200
// Срок на одну только сборку и пробу шаблона. Он короткий не потому, что проба
// дорогая, а потому что она единственная работает над чужим выражением до того,
// как появится хоть одно совпадение: зависнет — и вызывающий не узнает ничего.
const PROBE_TIMEOUT_MS = 4000

function searchInWorker(args, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise(resolve => {
    // Сигнал мог быть снят до вызова: AbortSignal уже aborted слушателя не зовёт,
    // и такой поиск висел бы до таймаута.
    if (signal?.aborted) {
      return resolve({ matches: [], files: 0, skipped: { large: 0, binary: 0, long_regex: 0, long_regex_unchecked: 0, slow_regex: 0 }, truncated: true, stopped: 'aborted', error: null, ms: 0 })
    }
    // Бюджет, отданный потоку, всегда короче собственного таймера: иначе он
    // ничего не решает, и обход всегда кончался бы убийством. Явный budgetMs
    // вызывающего уважаем, но не сверх этого запаса.
    const derived = Math.max(MIN_BUDGET_MS, timeoutMs - WORKER_RESERVE_MS)
    const budgetMs = Number.isFinite(args?.budgetMs) ? Math.min(args.budgetMs, derived) : derived
    const started = Date.now()
    const matches = []
    let meta = null
    let error = null
    let stopped = null
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      worker.terminate().catch(() => { /* поток уже завершился сам */ })
      // Два штатных обрыва — свой бюджет обхода и страж стоимости одного замера
      // — наружу идут как 'timeout': главного процесса другого слова нет, а смысл
      // тот же («не уложился, показаны первые совпадения, уточни запрос»). У
      // убийства потоком метаданных нет вовсе.
      const graceful = meta?.stopped === 'budget' || meta?.stopped === 'costly'
      resolve({
        matches,
        files: meta?.files || 0,
        skipped: meta?.skipped || { large: 0, binary: 0, long_regex: 0, long_regex_unchecked: 0, slow_regex: 0 },
        truncated: Boolean(meta?.truncated) || Boolean(stopped) || graceful,
        stopped: stopped || (graceful ? 'timeout' : null),
        error,
        ms: Date.now() - started
      })
    }

    let timer = null
    const arm = (ms, reason, cause = null) => {
      clearTimeout(timer)
      timer = setTimeout(() => { stopped = reason; if (cause) error = cause; finish() }, ms)
    }
    // Первые секунды поток занят одним: сборкой и пробой шаблона. Проба — это
    // исполнение чужого регулярного выражения, и она сама может гореть дольше
    // бюджета обхода («(a?){40,}b» на 14 знаках не разбирается и за 4 с). Поэтому
    // до объявления обхода у потока отдельный, короткий срок.
    const probeMs = Math.min(PROBE_TIMEOUT_MS, timeoutMs)
    arm(probeMs, 'timeout',
      `Шаблон не проверен: сборка регулярного выражения или маски не закончилась за ${Math.round(probeMs / 100) / 10} с. Упростите запрос.`)
    const onAbort = () => { stopped = 'aborted'; finish() }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    const worker = new Worker(WORKER_FILE, { workerData: { args: { ...args, budgetMs } } })
    worker.on('message', message => {
      if (message?.type === 'batch') {
        matches.push(...message.matches)
      } else if (message?.type === 'phase') {
        // Обход начался: перебор шаблона нам не грозит, включаем общий срок.
        if (message.phase === 'walk') arm(Math.max(MIN_BUDGET_MS, timeoutMs - (Date.now() - started)), 'timeout')
      } else if (message?.type === 'done') { meta = message; finish() }
      else if (message?.type === 'error') { error = message.error; finish() }
    })
    worker.on('error', cause => { error = String(cause?.message || cause); finish() })
    // Поток умер без ответа: это тоже ответ, иначе вызывающий ждёт вечно.
    worker.on('exit', () => { if (!meta && !error && !stopped) stopped = 'worker-exit'; finish() })
  })
}

module.exports = { searchInWorker, WORKER_FILE, DEFAULT_TIMEOUT_MS, WORKER_RESERVE_MS, MIN_BUDGET_MS, PROBE_TIMEOUT_MS }
