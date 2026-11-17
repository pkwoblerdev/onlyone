'use strict'
// Маршруты пяти путей к модели: куда, каким методом и с каким заголовком
// уходит запрос, и что возвращается человеку.
//
// Открытый вопрос пункта 2.8 был не «умеет ли адаптер говорить», а «тот ли это
// адрес и тот ли заголовок»: OpenAI, Gemini и Ollama едут openai-диалектом с
// `Authorization: Bearer`, Anthropic — нативным `POST /v1/messages` с
// `x-api-key` и `anthropic-version`, а свой совместимый endpoint вообще живёт
// по адресу человека. Всё это сверяется локальной заглушкой на 127.0.0.1:
// ни живых ключей, ни внешней сети, ни платных вызовов.
//
// Чего здесь сознательно нет: ответы реальных серверов. Что OpenAI, Anthropic,
// Google и Ollama отвечают ровно в заявленной форме — вне доказательства этим
// набором; он проверяет, что МЫ отправляем и разбираем то, что заявляем.
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')

const providers = require('../src/main/providers')
const catalog = require('../src/main/providers/catalog')

const SIDES = {
  openai: { model: 'модель-openai-Q7z2', key: 'sk-EXAMPLE32c91f3cab4b1235eb15dda' },
  anthropic: { model: 'claude-Q7z2Lm4', key: 'sk-ant-api03-EXAMPLE4b72e8828355a9b0abc1d' },
  gemini: { model: 'gemini-Q7z2Lm4', key: 'AIzaSyD-Q7z2Lm4Xd9Rt6Yb1Nc8Vk3Hf5Gs0Jp' },
  ollama: { model: 'llama-Q7z2Lm4', key: '' },
  compatible: { model: 'модель-своя-Q7z2', key: 'local-Q7z2Lm4Xd9Rt6Yb1' }
}

const hits = []
const stub = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = null }
    const side = Object.keys(SIDES).find(name => req.url.startsWith(`/${name}/`))
    hits.push({ side, url: req.url, method: req.method, headers: req.headers, body })
    if (!side) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return }
    if (req.headers.redirect_trap === 'yes') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/steals-your-key' })
      res.end('')
      return
    }
    if (req.url.endsWith('/models')) {
      const anthropic = side === 'anthropic'
      const list = [SIDES[side].model, `${SIDES[side].model}-сосед`]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(anthropic
        ? { data: list.map(id => ({ id, display_name: id })) }
        : { data: list.map(id => ({ id, name: id })) }))
      return
    }
    if (side === 'anthropic') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: SIDES.anthropic.model,
        content: [{ type: 'text', text: 'ОТВЕТ-ANTHROPIC' }], stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2 } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'cmp_1', model: SIDES[side].model, choices: [{ index: 0,
      message: { role: 'assistant', content: `ОТВЕТ-${side}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 } }))
  })
})

let checks = 0
let failed = 0
async function check(name, fn) {
  checks++
  try {
    await fn()
    console.log('ok', name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
    console.error(error.stack)
  }
}

const base = side => `http://127.0.0.1:${stub.address().port}/${side}/v1`
const lastHit = () => hits.at(-1)
const adapterFor = (side, providerId, extra = {}) => providers.adapterFor(providerId, {
  baseUrl: base(side),
  apiKey: SIDES[side].key || undefined,
  model: SIDES[side].model,
  ...extra
})
const CHAT = { model: 'модель-из-запроса', messages: [{ role: 'user', content: 'привет' }], stream: false }

async function routes() {
  await check('openai: POST на /chat/completions своего адреса, ключ — Bearer', async () => {
    const adapter = adapterFor('openai', 'openai')
    const response = await adapter.request({ path: '/chat/completions', method: 'POST', body: CHAT })
    assert.equal(response.ok, true, await response.text())
    const hit = lastHit()
    assert.equal(hit.side, 'openai', 'запрос ушёл не на свою сторону заглушки')
    assert.equal(hit.method, 'POST')
    assert.equal(hit.url, '/openai/v1/chat/completions', `адрес вызова не тот: ${hit.url}`)
    assert.equal(hit.headers.authorization, `Bearer ${SIDES.openai.key}`, 'ключ openai ушёл не в Bearer')
    assert.equal(hit.headers['x-api-key'], undefined, 'openai не должен слать x-api-key')
    assert.equal(hit.body.model, 'модель-из-запроса', 'имя модели подменено в теле')
  })

  await check('anthropic: нативный POST /v1/messages с x-api-key и версией', async () => {
    const adapter = adapterFor('anthropic', 'anthropic')
    const response = await adapter.request({ path: '/chat/completions', method: 'POST', body: CHAT })
    assert.equal(response.ok, true, await response.text())
    const hit = lastHit()
    assert.equal(hit.url, '/anthropic/v1/messages', `антропиковый путь не нативный: ${hit.url}`)
    assert.equal(hit.headers['x-api-key'], SIDES.anthropic.key, 'Anthropic не получил x-api-key')
    assert.match(String(hit.headers['anthropic-version'] || ''), /^\d{4}-\d\d-\d\d$/,
      'нет заголовка версии Anthropic')
    assert.equal(hit.headers.authorization, undefined, 'Anthropic не должен получать Bearer')
    assert.ok(Number.isFinite(Number(hit.body.max_tokens)), 'антропиковый max_tokens не заполнен')
    assert.equal(hit.body.messages.length, 1, 'сообщения не переведены')
  })

  await check('gemini: совместимый слой Google, а не нативный generateContent', async () => {
    const adapter = adapterFor('gemini', 'gemini')
    await adapter.request({ path: '/chat/completions', method: 'POST', body: CHAT })
    const hit = lastHit()
    assert.equal(hit.url, '/gemini/v1/chat/completions', `Gemini пошёл не openai-слоем: ${hit.url}`)
    assert.equal(hit.headers.authorization, `Bearer ${SIDES.gemini.key}`, 'ключ Google ушёл не в Bearer')
    assert.equal(hit.headers['x-goog-api-key'], undefined,
      'мы не используем нативный заголовок Google — путь через совместимый слой')
    const note = catalog.descriptor('gemini').notes.join(' ')
    assert.match(note, /v1beta\/openai/, 'каталог не говорит, каким слоем идёт Gemini')
  })

  await check('ollama: без ключа запрос уходит вообще без заголовка авторизации', async () => {
    const adapter = adapterFor('ollama', 'ollama')
    await adapter.request({ path: '/chat/completions', method: 'POST', body: CHAT })
    const hit = lastHit()
    assert.equal(hit.url, '/ollama/v1/chat/completions')
    assert.equal(hit.headers.authorization, undefined, 'пустой ключ уехал в Authorization')
    assert.equal(catalog.descriptor('ollama').keyOptional, true, 'Ollama не объявлен путём без ключа')
    // Негативное управление: с ключом он уходит как все.
    const withKey = providers.adapterFor('ollama', { baseUrl: base('ollama'), apiKey: SIDES.compatible.key })
    await withKey.request({ path: '/chat/completions', method: 'POST', body: CHAT })
    assert.equal(lastHit().headers.authorization, `Bearer ${SIDES.compatible.key}`,
      'ключ для Ollama перестал передаваться')
  })

  await check('совместимый endpoint: адрес человека — единственный, куда мы стучимся', async () => {
    const adapter = adapterFor('compatible', 'openai-compatible')
    await adapter.request({ path: '/chat/completions', method: 'POST', body: CHAT })
    const hit = lastHit()
    assert.equal(hit.url, '/compatible/v1/chat/completions')
    assert.equal(hit.headers.authorization, `Bearer ${SIDES.compatible.key}`)
  })

  await check('каталог моделей каждого пути — со своего адреса и своим заголовком', async () => {
    for (const [side, id] of [['openai', 'openai'], ['anthropic', 'anthropic'], ['gemini', 'gemini'],
      ['ollama', 'ollama'], ['compatible', 'openai-compatible']]) {
      const before = hits.length
      const probe = await adapterFor(side, id).probe({})
      assert.equal(probe.ok, true, `${side}: каталог не прочитался — ${probe.reason}`)
      const hit = lastHit()
      assert.equal(hits.length, before + 1, `${side}: каталог сделал не один запрос`)
      assert.match(hit.url, /\/models$/, `${side}: каталог не по /models — ${hit.url}`)
      assert.ok(probe.models.some(item => item.id === SIDES[side].model),
        `${side}: своей модели в каталоге нет: ${JSON.stringify(probe.models)}`)
      if (side === 'anthropic') assert.equal(hit.headers['x-api-key'], SIDES.anthropic.key)
      else if (side !== 'ollama') assert.equal(hit.headers.authorization, `Bearer ${SIDES[side].key}`)
    }
  })

  await check('адрес человека не сдваивается: слэш, /v1 и полный адрес вызова', async () => {
    const shapes = [
      [`${base('compatible')}/`, '/compatible/v1/chat/completions'],
      [base('compatible'), '/compatible/v1/chat/completions'],
      [`${base('compatible')}/chat/completions`, '/compatible/v1/chat/completions'],
      [`http://127.0.0.1:${stub.address().port}/compatible`, '/compatible/chat/completions']
    ]
    for (const [url, expected] of shapes) {
      const adapter = providers.adapterFor('openai-compatible', { baseUrl: url, apiKey: SIDES.compatible.key })
      await adapter.request({ path: '/chat/completions', method: 'POST', body: CHAT })
      assert.equal(lastHit().url, expected, `адрес «${url}» собрался в ${lastHit().url}`)
      assert.equal(/v1\/v1|completions\/chat/.test(lastHit().url), false, 'путь удвоился: ' + lastHit().url)
    }
  })

  await check('перенаправление не уносит ключ на чужой хост', async () => {
    const before = hits.length
    const adapter = adapterFor('compatible', 'openai-compatible', {
      fetchImpl: async (url, options) => {
        assert.equal(options.redirect, 'error', 'адаптер потерял запрет перенаправления')
        const response = await fetch(url, { ...options, redirect: 'follow', headers: { ...options.headers, redirect_trap: 'yes' } })
        return response
      }
    })
    const outcome = await adapter.request({ path: '/chat/completions', method: 'POST', body: CHAT })
      .then(() => 'ok').catch(error => String(error && error.message || error))
    assert.notEqual(outcome, 'ok', 'ответ с перенаправлением принят как успех')
    assert.equal(hits.length, before + 1, 'адаптер сам пошёл по редиректу')
  })
}

async function declared() {
  await check('адреса по умолчанию — те самые хосты, что заявлены в каталоге', () => {
    const expected = {
      openai: ['https:', 'api.openai.com', '/v1'],
      anthropic: ['https:', 'api.anthropic.com', '/v1'],
      gemini: ['https:', 'generativelanguage.googleapis.com', '/v1beta/openai'],
      ollama: ['http:', '127.0.0.1', '/v1']
    }
    for (const [id, [protocol, host, prefix]] of Object.entries(expected)) {
      const url = new URL(catalog.descriptor(id).defaultBaseUrl)
      assert.equal(url.protocol, protocol, `${id}: протокол ${url.protocol}`)
      assert.ok(url.hostname.endsWith(host) || url.hostname === host, `${id}: хост ${url.hostname}`)
      assert.ok(url.pathname.startsWith(prefix), `${id}: путь ${url.pathname} вне ${prefix}`)
    }
    // Негативное управление: встроенный путь по умолчанию в каталоге не лежит.
    assert.equal(catalog.descriptor('openrouter'), null, 'OpenRouter появился в каталоге именованных путей')
  })

  await check('возможности путей заявлены так, как их разбирает код', () => {
    for (const id of ['openai', 'gemini', 'ollama', 'anthropic']) {
      const caps = catalog.descriptor(id).capabilities
      assert.equal(caps.streaming, true, `${id}: стриминг не заявлен`)
      assert.equal(caps.tools, true, `${id}: инструменты не заявлены`)
      assert.equal(caps.fallbackChain, false, `${id}: цепочка запасных моделей заявлена там, где её не реализуют`)
      assert.equal(caps.reasoning, false, `${id}: ступени размышлений заявлены без исполнителя`)
    }
  })

  await check('реестр собирает каждый путь по своему диалекту и называет его своим именем', async () => {
    const titles = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', ollama: 'Ollama' }
    for (const [id, title] of Object.entries(titles)) {
      const adapter = providers.adapterFor(id, { baseUrl: base(id === 'anthropic' ? 'anthropic' : 'compatible') })
      assert.equal(adapter.providerId, id, `реестр подменил путь ${id}`)
      assert.equal(adapter.title, title, `отказ пути ${id} подпишут не тем именем`)
    }
  })
}

async function suite() {
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
  try {
    await routes()
    await declared()
  } finally {
    stub.close()
  }
  console.log(`Проверок: ${checks}, отказов: ${failed}`)
  console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
  process.exitCode = failed ? 1 : 0
}

suite().catch(error => {
  console.error('набор упал: ' + (error && error.stack || error))
  try { stub.close() } catch {}
  process.exit(2)
})
