// break-5b Н14: собственный 20-секундный таймер fetchPage тикал, ПОКА человек думал
// над карточкой подтверждения (карточка живёт до 30 минут) — нажатое «Разрешить»
// превращалось в TimeoutError. Таймер запроса обязан начинаться после решения человека.
// Настоящий fetchPage, транспорт и резолвер подставные: сети нет, адреса выдуманные.
'use strict'
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const web = require('../src/main/web-fetch.js')

let failed = 0
let total = 0
const check = async (name, fn) => {
  total++
  try { await fn(); console.log('ok     ' + name) } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + error.message) }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Имя с публичным адресом: карточка спрашивается не о локальном адресе, а о чтении страницы.
const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const URL_TARGET = 'http://page.test/article'

const response = body => ({
  status: 200, ok: true,
  header: name => ({ 'content-type': 'text/plain; charset=utf-8' }[String(name).toLowerCase()] || ''),
  discard: () => {},
  stream: Readable.from([body])
})

// Транспорт, который молчит вечно и обрывается только сигналом — как настоящий сокет.
const hangingTransport = state => ({ signal }) => new Promise((resolve, reject) => {
  state.requestedAt = Date.now()
  state.signal = signal
  signal.addEventListener('abort', () => { state.abortedAt = Date.now(); reject(signal.reason) }, { once: true })
})

async function main() {
  // AbortSignal.timeout не держит событийный цикл: без этого процесс ушёл бы до срока.
  const keepAlive = setInterval(() => {}, 1000)

  await check('«Разрешить» после 21 с раздумья читает страницу, а не TimeoutError', async () => {
    const state = { askedAt: 0, requestedAt: 0 }
    const result = await web.fetchPage(URL_TARGET, {
      lookup,
      allow: async () => { state.askedAt = Date.now(); await sleep(21000); return true },
      request: async () => { state.requestedAt = Date.now(); return response('текст статьи') }
    })
    assert.equal(result.success, true, 'чтение после долгого раздумья не удалось: ' + JSON.stringify(result).slice(0, 200))
    assert.equal(result.text, 'текст статьи')
    assert.ok(state.requestedAt - state.askedAt >= 20500, 'запрос ушёл раньше решения человека')
  })

  await check('таймер запроса начинается после решения: висящий транспорт обрывается через 20 с после «да»', async () => {
    const state = {}
    const started = Date.now()
    await assert.rejects(web.fetchPage(URL_TARGET, {
      lookup,
      allow: async () => { await sleep(21000); state.approvedAt = Date.now(); return true },
      request: hangingTransport(state)
    }), error => error.name === 'TimeoutError')
    assert.ok(state.requestedAt, 'запрос не ушёл вовсе: ожидание человека съело таймер')
    const afterApproval = state.abortedAt - state.approvedAt
    const fromStart = state.abortedAt - started
    assert.ok(afterApproval >= 19000 && afterApproval < 26000, 'срок сети не отсчитан от решения человека: ' + afterApproval + ' мс')
    assert.ok(fromStart >= 39000, 'таймер не перезапущен: обрыв через ' + fromStart + ' мс от старта')
  })

  await check('контроль: быстрое разрешение читает страницу как раньше', async () => {
    const result = await web.fetchPage(URL_TARGET, { lookup, allow: async () => true, request: async () => response('быстро') })
    assert.equal(result.success, true)
    assert.equal(result.text, 'быстро')
  })

  await check('контроль: «стоп» во время раздумья — соединения нет', async () => {
    const controller = new AbortController()
    const state = {}
    setTimeout(() => controller.abort(), 150)
    await assert.rejects(web.fetchPage(URL_TARGET, {
      lookup, signal: controller.signal,
      allow: async () => { await sleep(600); return true },
      request: hangingTransport(state)
    }), error => error.name === 'AbortError')
    assert.equal(state.requestedAt, undefined, 'запрос ушёл после отмены')
  })

  await check('контроль: отказ человека — denied и соединения нет', async () => {
    const state = {}
    const result = await web.fetchPage(URL_TARGET, { lookup, allow: async () => false, request: hangingTransport(state) })
    assert.equal(result.denied, true)
    assert.equal(result.success, false)
    assert.equal(state.requestedAt, undefined)
  })

  clearInterval(keepAlive)
  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })