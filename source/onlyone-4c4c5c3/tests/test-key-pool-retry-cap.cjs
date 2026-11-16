// break-5 Н13: `Retry-After` принимался без потолка — сервер (в т.ч. пользовательский
// baseURL совместимого провайдера) отправлял ключ «отдыхать» на 1e+21 секунд, а
// настройки показывали 21-значное число. Настоящий KeyPool с подставными часами;
// разбор заголовка вырезан ДОСЛОВНО из main.js — проверяется весь настоящий путь.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { KeyPool, DEFAULT_COOLDOWN_429_MS, DEFAULT_COOLDOWN_5XX_MS } = require('../src/main/providers/key-pool.js')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn(); console.log('ok     ' + name) } catch (error) { failed++; console.error('ПРОВАЛ [' + name + ']: ' + error.message) }
}

// Потолок «отдыха»: час. Дальше ключ обязан вернуться в работу сам.
const CAP_SEC = 3600

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const from = mainSrc.indexOf('let retryAfterSeconds = null')
const to = mainSrc.indexOf("if (pool && response.status !== 401)")
if (from < 0 || to <= from) throw new Error('разбор Retry-After не найден в main.js')
const parseBlock = mainSrc.slice(from, to)
// Тот же разбор, что в главном процессе: заголовок → число секунд.
const parseHeader = value => new Function('response', parseBlock + '\nreturn retryAfterSeconds')(
  { headers: { get: name => (String(name).toLowerCase() === 'retry-after' ? value : null) } }
)

const KEYS = [{ id: 'k1', name: 'Первый', key: 'sk-or-v1-FAKE0000000000000000000000000000000000000000000000000000000000' },
  { id: 'k2', name: 'Второй', key: 'sk-or-v1-FAKE1111111111111111111111111111111111111111111111111111111111' }]

function makePool() {
  const clock = { t: 1_700_000_000_000, now() { return this.t } }
  const pool = new KeyPool({ keys: KEYS.map(k => ({ ...k })), clock })
  return { pool, clock }
}
const remaining = pool => pool.getPublicKeys().map(k => k.cooldownRemainingSec)
const statuses = pool => pool.getPublicKeys().map(k => k.status)

// Заголовок настоящего ответа 429 → разбор main.js → markCooldown обоих ключей пула.
function coolBoth(pool, headerValue, status = 429) {
  const retryAfterSeconds = parseHeader(headerValue)
  for (const key of KEYS) pool.markCooldown(key.id, { status, reason: 'Лимит запросов исчерпан (429)', retryAfterSeconds })
  return retryAfterSeconds
}

check('Retry-After: 1000000000 (31,7 года) не уводит ключ за потолок', () => {
  const { pool } = makePool()
  assert.equal(coolBoth(pool, '1000000000'), 1000000000, 'разбор заголовка изменился')
  for (const sec of remaining(pool)) assert.ok(sec <= CAP_SEC, 'отдых ' + sec + ' с — потолка нет')
})

check('Retry-After: 21 знак (parseInt → 1e+21) не даёт 21-значное число в настройках', () => {
  const { pool } = makePool()
  const parsed = coolBoth(pool, '999999999999999999999')
  assert.equal(parsed, 1e21, 'parseInt повёл себя иначе')
  for (const sec of remaining(pool)) {
    assert.ok(Number.isSafeInteger(sec), 'в настройки уходит нецелое/небезопасное число: ' + sec)
    assert.ok(sec <= CAP_SEC, 'отдых ' + sec + ' с — потолка нет')
  }
})

check('честный отказ пула не обещает 1e+21 секунд', () => {
  const { pool } = makePool()
  coolBoth(pool, '999999999999999999999')
  let message = ''
  try { pool.acquireKey(); assert.fail('пул обязан отказать: оба ключа отдыхают') } catch (error) {
    assert.equal(error.code, 'POOL_EXHAUSTED')
    message = error.message
    assert.ok(error.minCooldownRemainingSec <= CAP_SEC, 'отказ обещает ' + error.minCooldownRemainingSec + ' с')
  }
  assert.ok(!/\d{7,}/.test(message), 'в отказе многозначное число секунд: ' + message)
})

check('после потолка ключ возвращается сам, без сброса в настройках', () => {
  const { pool, clock } = makePool()
  coolBoth(pool, '999999999999999999999')
  clock.t += (CAP_SEC + 1) * 1000
  assert.deepEqual(statuses(pool), ['active', 'active'], 'ключи не вернулись: ' + statuses(pool).join(','))
  assert.equal(pool.acquireKey().id, 'k1')
})

check('контроль: без заголовка работает штатный кулдаун 429', () => {
  const { pool, clock } = makePool()
  coolBoth(pool, null)
  assert.deepEqual(remaining(pool), [DEFAULT_COOLDOWN_429_MS / 1000, DEFAULT_COOLDOWN_429_MS / 1000])
  clock.t += DEFAULT_COOLDOWN_429_MS + 1000
  assert.deepEqual(statuses(pool), ['active', 'active'])
  assert.equal(pool.acquireKey().id, 'k1')
})

check('контроль: короткое значение заголовка соблюдается точно, потолок его не удлиняет', () => {
  const { pool, clock } = makePool()
  coolBoth(pool, '120')
  assert.deepEqual(remaining(pool), [120, 120])
  clock.t += 119_000
  assert.deepEqual(statuses(pool), ['cooldown', 'cooldown'], 'ключ вернулся раньше срока')
  clock.t += 2000
  assert.deepEqual(statuses(pool), ['active', 'active'])
})

check('контроль: значение ровно на потолке соблюдается', () => {
  const { pool } = makePool()
  coolBoth(pool, String(CAP_SEC))
  assert.deepEqual(remaining(pool), [CAP_SEC, CAP_SEC])
})

check('контроль: Retry-After HTTP-датой игнорируется, работает штатный кулдаун 5xx', () => {
  const { pool } = makePool()
  assert.equal(parseHeader('Wed, 21 Oct 2026 07:28:00 GMT'), null, 'дата не должна разбираться в число')
  coolBoth(pool, 'Wed, 21 Oct 2026 07:28:00 GMT', 503)
  assert.deepEqual(remaining(pool), [DEFAULT_COOLDOWN_5XX_MS / 1000, DEFAULT_COOLDOWN_5XX_MS / 1000])
})

check('контроль: Infinity и отрицательное значение не уводят ключ в вечный отдых', () => {
  const { pool } = makePool()
  pool.markCooldown('k1', { status: 429, retryAfterSeconds: Infinity })
  assert.ok(remaining(pool)[0] <= CAP_SEC, 'Infinity принят без потолка: ' + remaining(pool)[0])
  pool.markCooldown('k2', { status: 429, retryAfterSeconds: -5 })
  assert.equal(remaining(pool)[1], DEFAULT_COOLDOWN_429_MS / 1000, 'отрицательное значение не отброшено')
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0