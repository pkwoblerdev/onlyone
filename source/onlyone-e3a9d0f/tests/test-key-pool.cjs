'use strict'

// Тест пула ключей и перехода при 429/5xx (пункт 2.4б плана работ).
//
// Проверяет:
// 1. Инициализация пула ключей и определение статусов (active, off, dead, cooldown).
// 2. Распределение нагрузки (round-robin / balancing) среди активных ключей.
// 3. Учёт preferredKeyId: если ключ здоров — берётся он; если в кулдауне — переход на здоровый.
// 4. Переход в статус «отдыхает» (cooldown) при 429 (rate limit) с временем ожидания.
// 5. Переход в статус «отдыхает» при 5xx (500, 502, 503, 504) с временем ожидания.
// 6. Автоматическое восстановление ключа («отдохнул») по истечении времени кулдауна.
// 7. Честный отказ при исчерпании всех ключей в пуле с указанием времени до разблокировки.
// 8. Сквозной failover через локальную HTTP-заглушку: прозрачный переход на следующий ключ
//    при 429 без обрыва запроса и без задвоения ответа.
// 9. Обработка 401: ключ помечается как dead (не работает), не восстанавливается по таймеру.
// 10. Публичное представление для UI (getPublicKeys): поля status, cooldown, cooldownRemainingSec, cooldownReason.
// 11. Ручной сброс кулдауна (resetCooldown / resetAll).

const assert = require('node:assert/strict')
const http = require('node:http')

const { KeyPool, ROTATABLE_STATUSES } = require('../src/main/providers/key-pool')

async function runTests() {
  let passed = 0

  function ok(expr, msg) {
    assert(expr, msg)
    passed++
    console.log(`ok ${msg}`)
  }

  // Вспомогательный симулятор времени
  let fakeNow = 1_000_000
  const clock = {
    now: () => fakeNow,
    advance: ms => { fakeNow += ms }
  }

  // 1. Инициализация и статусы
  {
    const keys = [
      { id: 'k1', name: 'Ключ 1', enabled: true, keyEncrypted: 'enc-k1' },
      { id: 'k2', name: 'Ключ 2', enabled: true, keyEncrypted: 'enc-k2' },
      { id: 'k3', name: 'Ключ 3', enabled: false, keyEncrypted: 'enc-k3' }
    ]
    const pool = new KeyPool({ keys, clock })

    const active = pool.getActiveKeys()
    ok(active.length === 2 && active.map(k => k.id).join(',') === 'k1,k2', 'пул инициализирует только включённые ключи как активные')
    ok(pool.getKeyStatus('k1') === 'active', 'включённый ключ имеет статус active')
    ok(pool.getKeyStatus('k3') === 'off', 'отключённый пользователем ключ имеет статус off')
  }

  // 2. Распределение нагрузки (round-robin)
  {
    const keys = [
      { id: 'k1', name: 'Ключ 1', enabled: true },
      { id: 'k2', name: 'Ключ 2', enabled: true },
      { id: 'k3', name: 'Ключ 3', enabled: true }
    ]
    const pool = new KeyPool({ keys, clock })

    const picked = [
      pool.acquireKey().id,
      pool.acquireKey().id,
      pool.acquireKey().id,
      pool.acquireKey().id
    ]
    ok(picked[0] === 'k1' && picked[1] === 'k2' && picked[2] === 'k3' && picked[3] === 'k1',
      'пул равномерно распределяет нагрузку по кругу (round-robin) среди активных ключей')
  }

  // 3. Preferred key handling
  {
    const keys = [
      { id: 'k1', name: 'Ключ 1', enabled: true },
      { id: 'k2', name: 'Ключ 2', enabled: true }
    ]
    const pool = new KeyPool({ keys, clock })

    ok(pool.acquireKey({ preferredKeyId: 'k2' }).id === 'k2', 'предпочитаемый ключ отдаётся первым, если он активен')
    pool.markCooldown('k2', { status: 429, reason: 'Rate limit' })
    ok(pool.acquireKey({ preferredKeyId: 'k2' }).id === 'k1', 'если предпочитаемый ключ в кулдауне, пул бесшовно отдаёт здоровый ключ')
  }

  // 4. Пометка «отдыхает» (cooldown) при 429
  {
    const keys = [
      { id: 'k1', name: 'Ключ 1', enabled: true },
      { id: 'k2', name: 'Ключ 2', enabled: true }
    ]
    const pool = new KeyPool({ keys, clock, defaultCooldownMs: 60000 })

    pool.markCooldown('k1', { status: 429, reason: 'Лимит запросов исчерпан (429)', retryAfterSeconds: 45 })
    ok(pool.getKeyStatus('k1') === 'cooldown', 'ключ с 429 переходит в статус cooldown («отдыхает»)')
    ok(pool.isCoolingDown('k1') === true, 'isCoolingDown возвращает true для ключа в кулдауне')

    const pubKeys = pool.getPublicKeys()
    const k1Pub = pubKeys.find(k => k.id === 'k1')
    ok(k1Pub.cooldown === true && k1Pub.cooldownRemainingSec === 45, 'публичные данные ключа содержат признак кулдауна и оставшееся время')
    ok(k1Pub.cooldownReason.includes('429'), 'причина кулдауна содержит описание ошибки')
  }

  // 5. Пометка «отдыхает» при 5xx (500, 502, 503, 504)
  {
    const keys = [
      { id: 'k1', name: 'Ключ 1', enabled: true }
    ]
    const pool = new KeyPool({ keys, clock, defaultCooldownMs: 30000 })

    for (const code of [500, 502, 503, 504]) {
      ok(ROTATABLE_STATUSES.has(code), `статус ${code} входит в перечень ротируемых ошибок`)
    }

    pool.markCooldown('k1', { status: 503, reason: 'Сервер перегружен (503)' })
    ok(pool.getKeyStatus('k1') === 'cooldown', 'ключ с 503 переходит в статус cooldown')
    const k1Pub = pool.getPublicKeys().find(k => k.id === 'k1')
    ok(k1Pub.cooldownRemainingSec === 30, 'для 5xx по умолчанию используется стандартный кулдаун (30 с)')
  }

  // 6. Автоматическое восстановление ключа («отдохнул»)
  {
    const keys = [
      { id: 'k1', name: 'Ключ 1', enabled: true },
      { id: 'k2', name: 'Ключ 2', enabled: true }
    ]
    const pool = new KeyPool({ keys, clock, defaultCooldownMs: 60000 })

    pool.markCooldown('k1', { status: 429, retryAfterSeconds: 60 })
    ok(pool.acquireKey().id === 'k2', 'пока k1 в кулдауне, отдаётся k2')
    ok(pool.acquireKey().id === 'k2', 'следующий запрос снова берёт k2, пропуская k1')

    // Проматываем время на 61 секунду
    clock.advance(61000)

    ok(pool.isCoolingDown('k1') === false, 'по истечении срока кулдауна isCoolingDown возвращает false')
    ok(pool.getKeyStatus('k1') === 'active', 'ключ автоматически вернулся в статус active («отдохнул»)')
    // Теперь k1 снова участвует в round-robin
    const nextIds = [pool.acquireKey().id, pool.acquireKey().id]
    ok(nextIds.includes('k1'), 'отдохнувший ключ снова участвует в распределении нагрузки')
  }

  // 7. Честный отказ при исчерпании всех ключей в пуле
  {
    const keys = [
      { id: 'k1', name: 'Ключ 1', enabled: true },
      { id: 'k2', name: 'Ключ 2', enabled: true }
    ]
    const pool = new KeyPool({ keys, clock })

    pool.markCooldown('k1', { status: 429, retryAfterSeconds: 50, reason: 'Превышен лимит k1' })
    pool.markCooldown('k2', { status: 429, retryAfterSeconds: 20, reason: 'Превышен лимит k2' })

    let threw = false
    try {
      pool.acquireKey()
    } catch (err) {
      threw = true
      ok(err.code === 'POOL_EXHAUSTED', 'ошибка имеет код POOL_EXHAUSTED')
      ok(err.message.includes('отдыхают') || err.message.includes('исчерпаны'), 'сообщение об ошибке понятно объясняет, что все ключи отдыхают')
      ok(typeof err.minCooldownRemainingSec === 'number' && err.minCooldownRemainingSec === 20,
        'ошибка сообщает минимальное оставшееся время до восстановления ближайшего ключа')
    }
    ok(threw, 'при исчерпании пула выбрасывается исключение')
  }

  // 8. 401 отказ: ключ помечается как dead (не работает)
  {
    const keys = [
      { id: 'k1', name: 'Ключ 1', enabled: true },
      { id: 'k2', name: 'Ключ 2', enabled: true }
    ]
    const pool = new KeyPool({ keys, clock })

    pool.markDead('k1', 'Ключ отклонён провайдером (401)')
    ok(pool.getKeyStatus('k1') === 'dead', 'ключ с 401 помечается как dead')

    clock.advance(1000000)
    ok(pool.getKeyStatus('k1') === 'dead', 'dead-ключ не восстанавливается по времени')
    ok(pool.acquireKey().id === 'k2', 'dead-ключ исключён из распределения нагрузки')
  }

  // 9. Сброс кулдауна вручную
  {
    const keys = [
      { id: 'k1', name: 'Ключ 1', enabled: true }
    ]
    const pool = new KeyPool({ keys, clock })

    pool.markCooldown('k1', { status: 429 })
    ok(pool.isCoolingDown('k1') === true, 'ключ переведён в кулдаун')
    pool.resetCooldown('k1')
    ok(pool.isCoolingDown('k1') === false, 'resetCooldown мгновенно возвращает ключ в строй')

    pool.markCooldown('k1', { status: 502 })
    pool.resetAll()
    ok(pool.isCoolingDown('k1') === false, 'resetAll сбрасывает кулдауны у всех ключей')
  }

  // 10. Сквозной failover с локальной HTTP-заглушкой:
  // k1 даёт 429, переход на k2 даёт 200, ход не обрывается
  {
    const requestedKeys = []
    const server = http.createServer((req, res) => {
      const auth = req.headers['authorization'] || ''
      requestedKeys.push(auth)

      if (auth.includes('key-1')) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' })
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded upstream', code: 429 } }))
      } else if (auth.includes('key-2')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'Успешный ответ со второго ключа' } }] }))
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end('{}')
      }
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const url = `http://127.0.0.1:${port}`

    try {
      const keys = [
        { id: 'k1', name: 'Ключ 1', enabled: true, rawKey: 'key-1' },
        { id: 'k2', name: 'Ключ 2', enabled: true, rawKey: 'key-2' }
      ]
      const pool = new KeyPool({ keys, clock })

      const rotatedEvents = []
      const result = await pool.executeRequest({
        preferredKeyId: 'k1',
        onRotated: ev => rotatedEvents.push(ev),
        fetcher: async (key) => {
          const res = await fetch(`${url}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${key.rawKey}`
            },
            body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] })
          })
          return res
        }
      })

      ok(result.ok === true, 'executeRequest успешно выполнил запрос, несмотря на 429 на первом ключе')
      const data = await result.json()
      ok(data.choices[0].message.content === 'Успешный ответ со второго ключа', 'получен корректный ответ со второго ключа')
      ok(requestedKeys.length === 2 && requestedKeys[0].includes('key-1') && requestedKeys[1].includes('key-2'),
        'запрос сначала постучался в key-1, затем без обрыва перешёл в key-2')
      ok(rotatedEvents.length === 1 && rotatedEvents[0].fromKey.id === 'k1' && rotatedEvents[0].toKey.id === 'k2',
        'событие ротации зафиксировало переход с k1 на k2')
      ok(pool.isCoolingDown('k1') === true, 'первый ключ помечен как отдыхающий в пуле')
      ok(pool.isCoolingDown('k2') === false, 'второй ключ остаётся здоровым')

      // Следующий запрос сразу пойдёт на k2, не делая лишний запрос к k1
      const nextResult = await pool.executeRequest({
        fetcher: async (key) => {
          return await fetch(`${url}/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key.rawKey}` }
          })
        }
      })
      ok(nextResult.ok === true, 'следующий запрос сразу успешен')
      ok(requestedKeys.length === 3 && requestedKeys[2].includes('key-2'),
        'следующий запрос сразу пошёл на key-2, не пытаясь стучаться в остывающий key-1')

    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  }

  console.log(`Проверок пула ключей: ${passed}, отказов: 0`)
  console.log(JSON.stringify({ ok: true, checks: passed, failed: 0 }))
}

runTests().catch(err => {
  console.error('FAIL test-key-pool:', err)
  process.exit(1)
})
