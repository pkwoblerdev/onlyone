'use strict'
// Секрет наружу ни одним путём: ни маской, ни текстом ошибки, ни в журнал,
// ни в имя ключа на диске.
//
// Проверяются ТЕ ЖЕ функции, что работают в приложении: `maskSecret`,
// `maskKeyInText` и `describeOpenRouterError` вырезаны из `main.js`, отметки
// «ключ мёртв» и «модель недоступна» — тоже, зачистка отказов — из обоих
// адаптеров `src/main/providers/`. Ни Electron, ни сети, ни живых ключей:
// сервер заглушен тем, что он теоретически может вернуть, — эхом нашего же
// заголовка авторизации. Живой OpenRouter такого обещания не даёт, и это
// отдельный пункт в отчёте владельцу.
//
// Что считается утечкой: не только весь ключ. Прежняя маска выдавала четыре
// последних символа, и проверка «ключа нет целиком» это пропускала. Здесь
// сравниваются фрагменты: начало, хвост, половина, база64.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { redactSecrets } = require('../src/main/run-checkpoints')
const { maskSecretText } = require('../src/main/providers/secret-mask')
const openaiCompatible = require('../src/main/providers/openai-compatible')
const anthropicMessages = require('../src/main/providers/anthropic-messages')

const root = path.join(__dirname, '..')
const CR = String.fromCharCode(13)
const main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8').split(CR).join('')
const cut = (from, to) => {
  const a = main.indexOf(from)
  const b = main.indexOf(to)
  assert.ok(a >= 0, `в main.js нет участка «${from}» — проверка отстала от кода`)
  assert.ok(b > a, `в main.js нет конца участка «${to}»`)
  return main.slice(a, b)
}

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

// Ключи собраны так, что любой их четырёхсимвольный кусок отличается от
// обычной прозы: цифры вперемешку со строчными и заглавными.
const KEY_LONG = 'sk-or-v1-EXAMPLEbe5caa9c23046a234585fab14'
const KEY_SHORT = 'zQ4xR7'
const KEY_SHAPELESS = 'zQ4xR7pLm2Wk9NbT'
const KEY_GOOGLE = 'AIzaSyD-Q7z2Lm4Xd9Rt6Yb1Nc8Vk3Hf5Gs0Jp'
const KEY_ANTHROPIC = 'sk-ant-api03-EXAMPLE8a077cb3937f810b7e2b44390'
const b64 = text => Buffer.from(text, 'utf8').toString('base64')

// Фрагменты, которые нельзя показывать наружу. Регистр не спасает: сервер
// вправе процитировать ключ заглавными, и для человека это тот же секрет.
function fragments(secret) {
  const half = Math.max(4, Math.floor(secret.length / 2))
  return [...new Set([secret, secret.slice(0, 4), secret.slice(-4), secret.slice(0, 6),
    secret.slice(-6), secret.slice(0, half), secret.slice(half), b64(secret),
    b64(`ENC:${secret}`)])].filter(piece => piece.length >= 4)
}

function leak(text, secret) {
  const dump = String(text == null ? '' : text).toLowerCase()
  return fragments(secret).find(piece => dump.includes(piece.toLowerCase())) || null
}

function assertNoLeak(text, secret, where) {
  const piece = leak(text, secret)
  assert.equal(piece, null, `${where}: наружу уехало «${piece}» — ${String(text).slice(0, 160)}`)
}

// Главный процесс: маска, разбор отказа OpenRouter и отметки о здоровье.
const api = new Function('redactSecrets', 'maskSecretText', 'store', 'crypto', 'REVOKED_KEY_SHA256',
  'decryptKeyValue', 'MODEL_UNAVAILABLE_TTL_MS',
  cut('function maskKeyInText', 'function normalizeOutgoingMessages') +
  cut('function modelUnavailable', 'function keyDead') +
  cut('function markKeyDead', 'function clearKeyHealth') +
  cut('function loadOpenRouterKeys', 'function saveOpenRouterKeys') +
  `return { maskKeyInText, describeOpenRouterError, markKeyDead, markModelUnavailable,
    loadOpenRouterKeys }`)
const store = { data: new Map(), get(key, fallback) { return this.data.has(key) ? this.data.get(key) : fallback },
  set(key, value) { this.data.set(key, value) }, delete(key) { this.data.delete(key) } }
const crypto = require('node:crypto')
// Конверт в тесте — поддельный шифр (обратный порядок + метка): иначе база64
// от настоящего ключа попадала бы в запись, и проверка фрагментов ругалась бы
// на собственную заглушку, а не на код.
const wrap = secret => b64('ШИФР:' + String(secret).split('').reverse().join(''))
const unwrap = blob => {
  const text = String(blob || '')
  if (!text) return null
  const raw = Buffer.from(text, 'base64').toString('utf8')
  return raw.startsWith('ШИФР:') ? raw.slice(5).split('').reverse().join('') : raw
}
const built = api(redactSecrets, maskSecretText, store, crypto, '0'.repeat(64), unwrap, 12 * 60 * 60 * 1000)

// Что сервер теоретически может вернуть эхом. Каждая форма — отдельная
// проверка: маска обязана держать и JSON, и голую страницу, и заголовок
// внутри текста.
const ECHOES = [
  ['json message', JSON.stringify({ error: { message: `bad key ${KEY_LONG}`, code: 401 } }), 401],
  ['metadata.raw', JSON.stringify({ error: { message: 'upstream refused', code: 401,
    metadata: { raw: `Authorization: Bearer ${KEY_LONG}` } } }), 401],
  ['goлая html-страница', `<html><body>Invalid token ${KEY_LONG} for this account</body></html>`, 401],
  ['x-api-key в тексте', JSON.stringify({ error: { message: `x-api-key: ${KEY_ANTHROPIC} rejected`, type: 'auth_error' } }), 403],
  ['ключ по-русски', JSON.stringify({ error: { message: `ключ ${KEY_LONG} отозван` } }), 401],
  ['google форма', JSON.stringify({ error: { message: `API key AIza${KEY_GOOGLE.slice(4)} invalid` } }), 400],
  ['половина на границе', JSON.stringify({ error: { message: `echo ${KEY_LONG.slice(0, 22)}…${KEY_LONG.slice(22)}`, code: 400 } }), 400]
]

async function masking() {
  await check('маска не выдаёт из ключа ничего — ни длинного, ни короткого', () => {
    // `maskSecret` живёт в main.js и вызывается без аргумента: проверка держит
    // её на месте, чтобы хвост не вернулся под видом «удобства».
    const source = cut('function maskSecret', 'function customKeyValue')
    assert.match(source, /return ''/, 'маска снова начала что-то выдавать из ключа')
    assert.equal(/slice\(-\d+\)/.test(source), false, 'в маске остался срез хвоста')
    assert.equal(/\.slice\(\d/.test(source), false, 'в маске остался срез начала')
  })

  await check('OpenRouter: эхо ключа в любом виде не доезжает до человека', () => {
    for (const [name, body, status] of ECHOES) {
      const line = built.describeOpenRouterError(body, status, 'тестовая/модель-7z2q', KEY_LONG)
      assertNoLeak(line, KEY_LONG, `описание отказа (${name})`)
      assertNoLeak(line, KEY_GOOGLE, `описание отказа (${name}), форма Google`)
      assertNoLeak(line, KEY_ANTHROPIC, `описание отказа (${name}), форма Anthropic`)
    }
  })

  await check('OpenRouter: маска не съедает то, по чему человек понимает отказ', () => {
    // Негативное управление против слишком ретивой зачистки: если из строки
    // исчезли код, модель и подсказка — проверка выше зелёна по неверной причине.
    const line = built.describeOpenRouterError(
      JSON.stringify({ error: { message: `bad key ${KEY_LONG}`, code: 429 } }), 429, 'глубокая/модель-9', KEY_LONG)
    assert.match(line, /429/, 'из описания пропал код статуса: ' + line)
    assert.match(line, /глубокая\/модель-9/, 'из описания пропала модель: ' + line)
    assert.match(line, /имит/, 'из описания пропало объяснение статуса: ' + line)
  })

  await check('отметки «ключ мёртв» и «модель недоступна» хранят причину без ключа', () => {
    store.data.clear()
    built.markKeyDead('key_1', `Invalid key: ${KEY_LONG}`)
    built.markModelUnavailable('модель-7z2q', `no endpoints found for ${KEY_LONG}`)
    assertNoLeak(JSON.stringify(store.get('keyHealth')), KEY_LONG, 'keyHealth на диске')
    assertNoLeak(JSON.stringify(store.get('modelHealth')), KEY_LONG, 'modelHealth на диске')
    assertNoLeak(JSON.stringify(store.get('keyHealth')), KEY_SHORT, 'keyHealth: короткий ключ')
    assert.match(store.get('keyHealth').key_1.reason, /ключ|key/i, 'причина отметки стала пустой')
  })

  await check('причина последней проверки маскируется на границе записи', () => {
    // `lastCheck.reason` ложится в настройки открытым текстом и показывается в
    // окне. Поведение адаптера (отказ уже замаскирован) меряют наборы
    // `test-provider-catalog` и `test-provider-openai-stub`; здесь держится
    // само правило: маска стоит в `saveCustomProvider`, а не в вызывающем.
    assert.match(main, /reason: maskKeyInText\(list\[index\]\.lastCheck\.reason, customKeyValue\(list\[index\]\)\)/)
    const writer = cut('function saveCustomProvider(', 'function addCustomProvider(')
    assert.match(writer, /maskKeyInText/, 'маска ушла из границы записи настроек')
  })

  await check('журнал latency не получает ни ключа, ни его оболочки', () => {
    // Вызовы журнала проверяются по исходнику: в тексте строки не должно быть
    // ни переменной с ключом, ни расшифровки.
    const calls = main.split('\n').filter(line => /latency\.write\(/.test(line))
    assert.ok(calls.length >= 5, `проверка не на чём: вызовов latency.write — ${calls.length}`)
    const bad = calls.filter(line => /apiKey|customKeyValue\(|decryptKeyValue\(|keyEncrypted|secret/i.test(line))
    assert.deepEqual(bad.map(line => line.trim().slice(0, 90)), [], 'в журнал уходит что-то про ключ')
  })
}

async function adapters() {
  await check('адаптер openai-совместимого пути: эхо ключа гасится в описании отказа', () => {
    for (const [name, body, status] of ECHOES) {
      const line = openaiCompatible.describeError(body, status, 'модель-тест-7z2q', KEY_LONG, 'Свой эндпоинт')
      assertNoLeak(line, KEY_LONG, `openai describeError (${name})`)
      assertNoLeak(line, KEY_GOOGLE, `openai describeError (${name}), форма Google`)
    }
    // Негативное управление: полезное в строке остаётся.
    const line = openaiCompatible.describeError(JSON.stringify({ error: { message: 'bad model' } }),
      404, 'глубокая/модель-9', KEY_LONG, 'Свой эндпоинт')
    assert.match(line, /код 404/, 'из отказа пропал код: ' + line)
    assert.match(line, /глубокая\/модель-9/, 'из отказа пропала модель: ' + line)
    assert.match(line, /Свой эндпоинт/, 'из отказа пропало имя пути: ' + line)
  })

  await check('адаптер Anthropic: эхо x-api-key и Bearer гасится одинаково', () => {
    const shapes = [
      [`x-api-key: ${KEY_ANTHROPIC}`, 401],
      [JSON.stringify({ error: { type: 'authentication_error', message: `key ${KEY_ANTHROPIC} disabled` } }), 401],
      [`Authorization: Bearer ${KEY_ANTHROPIC}`, 403],
      [`ключ ${KEY_ANTHROPIC} не принят`, 400]
    ]
    for (const [body, status] of shapes) {
      assertNoLeak(anthropicMessages.describeError(body, status, 'модель-тест-7z2q', KEY_ANTHROPIC),
        KEY_ANTHROPIC, 'anthropic describeError')
    }
    const line = anthropicMessages.describeError(JSON.stringify({ error: { message: 'unknown model' } }),
      404, 'claude-тест-9', KEY_ANTHROPIC)
    assert.match(line, /код 404|404/, 'из отказа пропал код: ' + line)
    assert.match(line, /claude-тест-9/, 'из отказа пропала модель: ' + line)
  })

  await check('короткий ключ локального сервера не выдаётся по фрагментам', () => {
    // Именно такой случай прежняя маска и портила: `…${slice(-4)}` от шестизначного
    // ключа — это две трети ключа.
    for (const text of [`token ${KEY_SHORT}`, `Bearer ${KEY_SHORT}x`, `ключ=${KEY_SHORT}`]) {
      assertNoLeak(openaiCompatible.describeError(text, 401, 'м-1', KEY_SHORT), KEY_SHORT, 'короткий ключ')
    }
  })

  await check('сервер сократил ключ в объяснении — хвоста не остаётся', () => {
    // Формат, которым OpenAI и OpenRouter реально показывают ключ в логах и
    // ошибках: начало, многоточие, четыре последних символа. Прежняя маска
    // выдавала ровно эти четыре символа, и окна по восемь символов их не
    // ловили — хвост короче окна.
    const cases = [
      [`Your api_key ${KEY_LONG.slice(0, 12)}...${KEY_LONG.slice(-4)} is invalid`, KEY_LONG],
      [`rejected credential ${KEY_LONG.slice(-4)}`, KEY_LONG],
      [`ключ ${KEY_ANTHROPIC.slice(-6)} отклонён`, KEY_ANTHROPIC],
      [`credential ${KEY_SHAPELESS} rejected`, KEY_SHAPELESS],
      [`bad key ${KEY_SHAPELESS.toUpperCase()}`, KEY_SHAPELESS]
    ]
    for (const [text, key] of cases) {
      assertNoLeak(maskSecretText(text, key), key, `эхо «${text}»`)
      assertNoLeak(built.describeOpenRouterError(JSON.stringify({ error: { message: text, code: 400 } }),
        400, 'модель-7z2', key), key, 'тот же эхо через разбор OpenRouter')
    }
    // Негативное управление: без ключа в тексте подмены нет, и имена моделей
    // не вымарываются (иначе проверка выше краснела бы от собственного усердия).
    const plain = maskSecretText('model deepseek/deepseek-chat-v3-0324:free unavailable', KEY_LONG)
    assert.match(plain, /deepseek-chat-v3-0324:free/, 'маска съела имя модели: ' + plain)
  })

  await check('эхо ключа заглавными гасится так же, как строчными', () => {
    // Сервер вправе вернуть цитату в любом регистре — для человека это тот же
    // секрет, и проверка фрагментов ниже сравнивает без учёта регистра.
    const cases = [
      [`bad key ${KEY_LONG.toUpperCase()}`, KEY_LONG],
      [`rejected credential ${KEY_LONG.slice(-4).toUpperCase()}`, KEY_LONG],
      [`ключ ${KEY_SHAPELESS.toUpperCase()} не принят`, KEY_SHAPELESS],
      [`x-api-key: ${KEY_ANTHROPIC.toLowerCase()}`, KEY_ANTHROPIC]
    ]
    for (const [text, key] of cases) {
      assertNoLeak(maskSecretText(text, key), key, `эхо в другом регистре: «${text}»`)
    }
  })

  await check('хвост подменяется только отдельным куском: адрес и порт остаются', () => {
    // Ключ намеренно кончается цифрами порта локального Ollama: прежняя
    // подмена «где угодно» превращала адрес в `localhost:1[ключ]`, и человек
    // терял то, что ему и так известно, — адрес своей машины.
    const KEY_TAILNUM = 'sk-or-v1-EXAMPLE6c54cf0ef627e7037ddc99361'
    const url = 'http://127.0.0.1:11434/v1'
    const kept = maskSecretText(`Не удалось связаться с ${url} (код 0). Проверьте ${url}.`, KEY_TAILNUM)
    assert.ok(kept.includes(url), `маска съела адрес сервера: ${kept}`)
    assert.match(kept, /код 0/, 'маска съела код: ' + kept)
    // А вот тот же хвост, стоящий отдельным словом, — это уже эхо ключа.
    const echo = maskSecretText('rejected credential 11434 for this account', KEY_TAILNUM)
    assert.equal(/(^|[^0-9])11434([^0-9]|$)/.test(echo), false, 'хвост ключа ушёл наружу: ' + echo)
    assert.match(echo, /rejected credential/, 'из объяснения пропало всё: ' + echo)
    // Имя модели и версия в объяснении читаются как раньше.
    const named = maskSecretText('model deepseek/deepseek-chat-v3-0324:free is unavailable', KEY_TAILNUM)
    assert.match(named, /deepseek-chat-v3-0324:free/, 'маска съела имя модели: ' + named)
  })

  await check('наши слова в отказе остаются словами: код, модель и подсказка', () => {
    const line = built.describeOpenRouterError(JSON.stringify({ error: { message: `nope ${KEY_LONG}`, code: 401 } }),
      401, 'глубокая/модель-9', KEY_LONG)
    assertNoLeak(line, KEY_LONG, 'отказ 401')
    assert.match(line, /код 401/, 'из отказа пропал код: ' + line)
    assert.match(line, /глубокая\/модель-9/, 'из отказа пропала модель: ' + line)
    assert.match(line, /Ключ отклонён/, 'подсказка вымарана вместе с ключом: ' + line)
  })

  await check('сырое тело ответа не перечисляется в ошибке адаптера', async () => {
    const http = require('node:http')
    const stub = http.createServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `echo ${KEY_LONG}` } }))
    })
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
    const adapter = openaiCompatible.create({
      baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: KEY_LONG, model: 'модель-7z2'
    })
    try {
      await adapter.request({ path: '/chat/completions', method: 'POST', body: { model: 'м', messages: [] } })
      assert.fail('запрос не отказал')
    } catch (error) {
      assert.equal(JSON.stringify(error).includes(KEY_LONG.slice(-4)), false,
        'сериализация ошибки выдала хвост ключа: ' + JSON.stringify(error).slice(0, 200))
      assert.equal(JSON.stringify(error).includes(KEY_LONG), false, 'сериализация ошибки выдала ключ')
      assert.ok(typeof error.rawText === 'string' && error.rawText.includes(KEY_LONG),
        'сырое тело перестали читать совсем — отладка отказа ушла')
      assert.match(error.message, /код 400/, 'из сообщения пропал код: ' + error.message)
    } finally {
      stub.close()
    }
  })
}

async function storage() {
  await check('имя ключа с хвостом прежней сборки переименовывается и исчезает с диска', () => {
    store.data.clear()
    store.set('openrouterKeys', [
      { id: 'key_1', name: 'Ключ (…Jp2W)', keyEncrypted: wrap(KEY_LONG), enabled: true },
      { id: 'key_2', name: 'Рабочий ноутбук', keyEncrypted: wrap(KEY_SHORT), enabled: true }
    ])
    const keys = built.loadOpenRouterKeys()
    assertNoLeak(keys.map(k => k.name).join(' '), KEY_LONG, 'имя ключа после перечитания')
    assert.equal(unwrap(keys.find(k => k.id === 'key_1').keyEncrypted), KEY_LONG,
      'конверт при переименовании повредился')
    assert.equal(keys.find(k => k.id === 'key_1').name, 'Ключ 1',
      'автоимя с хвостом не переименовано: ' + keys.find(k => k.id === 'key_1').name)
    assert.equal(keys.find(k => k.id === 'key_2').name, 'Рабочий ноутбук',
      'имя, выбранное человеком, переименовано')
    assert.equal(store.get('openrouterKeys').find(k => k.id === 'key_1').name, 'Ключ 1',
      'новое имя не записано на диск')
  })

  await check('два автоимени с хвостом не сливаются в одно', () => {
    store.data.clear()
    store.set('openrouterKeys', [
      { id: 'key_1', name: 'Ключ (…Jp2W)', keyEncrypted: wrap(KEY_LONG), enabled: true },
      { id: 'key_2', name: 'Ключ (…k3Hf)', keyEncrypted: wrap(KEY_GOOGLE), enabled: true },
      { id: 'key_3', name: 'Ключ 1', keyEncrypted: wrap(KEY_SHORT), enabled: true }
    ])
    const names = built.loadOpenRouterKeys().map(k => k.name)
    assert.equal(new Set(names).size, 3, 'имена ключей слились: ' + names.join(', '))
    assertNoLeak(names.join(' '), KEY_LONG, 'список имён')
    assertNoLeak(names.join(' '), KEY_GOOGLE, 'список имён')
  })
}

async function suite() {
  await masking()
  await adapters()
  await storage()
  console.log(`Проверок: ${checks}, отказов: ${failed}`)
  console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
  process.exitCode = failed ? 1 : 0
}

suite()
