// Н6 (адварк-тест 01.11): под одним `catch` в `readStoreSecure` прятались две разные
// беды, и человеку про битый JSON секции настроек говорилось «ключ шифрования
// профиля не подошёл» — он шёл искать `Local State`, а надо было смотреть архив.
// Проверка на настоящем куске `main.js`: причина разделяется на месте чтения и
// передаётся дальше третьим аргументом.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(process.env.ONECODE_MAIN_UNDER_TEST ||
  path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const from = main.indexOf('function readStoreSecure(key, fallback) {')
const to = main.indexOf('\n}', from)
if (from < 0 || to < 0) throw new Error('readStoreSecure не найдена в main.js')
const REGION = main.slice(from, to + 2)

let failed = 0
function check(name, fn) {
  try { fn(); console.log('ok', name) } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

// Песочница чтения: хранилище отдаёт одно значение, архив записывает вызовы, журнал — строки.
function sandbox({ raw, decryptError }) {
  const archived = []
  const log = []
  const api = new Function('store', 'safeStorage', 'requireWindowsEncryption', 'archiveCorruptSettings', 'latency',
    `${REGION}
     return { readStoreSecure }`)(
    { get: () => raw },
    {
      decryptString: () => {
        if (decryptError) throw decryptError
        return 'привет, это не json {{{'
      }
    },
    () => true,
    (...args) => { archived.push(args); return true },
    { write: text => log.push(String(text)) })
  return { ...api, archived, log }
}

const KEY_ERROR = new Error('Unable to decrypt text: Error while decrypting the ciphertext provided to safeStorage.decryptString.')
const plainEnvelope = text => ({ enc: 'plain', data: Buffer.from(text, 'utf8').toString('base64') })

check('битый JSON секции называется испорченным содержимым, а не потерянным ключом', () => {
  const ctx = sandbox({ raw: plainEnvelope('привет, это не json {{{') })
  assert.deepEqual(ctx.readStoreSecure('skills', []), [])
  assert.equal(ctx.archived.length, 1, 'секция не ушла в архив')
  assert.equal(ctx.archived[0][2], 'corrupt', 'причина не передана архиву: ' + JSON.stringify(ctx.archived[0][2]))
  assert.ok(ctx.log.some(text => text.includes('corrupt')), 'журнал не различает причину: ' + ctx.log.join(' | '))
})

check('нечитаемый конверт называется потерянным ключом', () => {
  const ctx = sandbox({ raw: { enc: 'safeStorage', data: 'QUJD' }, decryptError: KEY_ERROR })
  assert.deepEqual(ctx.readStoreSecure('mcpServers', []), [])
  assert.equal(ctx.archived.length, 1, 'секция не ушла в архив')
  assert.equal(ctx.archived[0][2], 'key-mismatch', 'причина не передана архиву: ' + JSON.stringify(ctx.archived[0][2]))
  assert.ok(ctx.log.some(text => text.includes('key-mismatch')), 'журнал не различает причину: ' + ctx.log.join(' | '))
})

// Разделение причин не должно стоить ни одного прочитанного значения.
check('читаемая секция возвращается как ни в чём не бывало и не архивируется', () => {
  const ctx = sandbox({ raw: plainEnvelope(JSON.stringify([{ id: 's1' }])) })
  assert.deepEqual(ctx.readStoreSecure('skills', []), [{ id: 's1' }])
  assert.deepEqual(ctx.archived, [], 'живое значение уехало в архив')
  assert.deepEqual(ctx.log, [], 'чистое чтение оставило строку в журнале')
})

if (failed) process.exit(1)
console.log('\nПричины нечитаемых секций: проверки пройдены')
