// break-1 Н1/Н3/Н4: тестовые env-хуки удалёнки и smoke-подсказки действовали
// в упакованной сборке. Тест вырезает НАСТОЯЩИЕ строки хуков из main.js и
// исполняет их с подставным app: упакованный — хук молчит, unpacked — работает
// (E2E-прогоны не ломаются). ONECODE_TEST_MAIN_SRC — для прогона на прежней ревизии.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const srcPath = process.env.ONECODE_TEST_MAIN_SRC || path.join(__dirname, '..', 'src', 'main', 'main.js')
const src = fs.readFileSync(srcPath, 'utf8')
const lineWith = needle => {
  const line = src.split(/\r?\n/).find(l => l.includes(needle))
  if (!line) throw new Error('строка не найдена: ' + needle)
  return line.trim()
}

const VENDOR = ''
const env = { ONECODE_RELAY_URL: 'wss://attacker.invalid/relay', ONECODE_E2E: '1', ONECODE_REMOTE_AUTOAPPROVE: '1', ONECODE_REMOTE_CODE_FILE: 'C:/temp/pairing-code.txt', ONECODE_SMOKE: '1', ONECODE_SMOKE_FIXTURE: 'C:/temp/fixture.json' }

// Каждый хук исполняется как есть, с подставными app/process/fsSync.
const relayUrl = app => new Function('app', 'process', lineWith('const REMOTE_RELAY_URL =') + '\nreturn REMOTE_RELAY_URL')(app, { env })
const autoApprove = app => new Function('app', 'process', lineWith('ONECODE_REMOTE_AUTOAPPROVE') + '\nreturn false')(app, { env })
const codeFileWrite = app => {
  const writes = []
  new Function('app', 'process', 'fsSync', 'pairing', lineWith('ONECODE_REMOTE_CODE_FILE') + '\nreturn false')(app, { env }, { writeFileSync: (p, c) => writes.push([p, c]) }, { code: 'PAIRING-SECRET' })
  return writes
}
const smokeFixture = app => {
  const line = lineWith('process.env.ONECODE_SMOKE && process.env.ONECODE_SMOKE_FIXTURE').replace(/\{\s*$/, '')
  return new Function('app', 'process', line + ' return true\nreturn false')(app, { env })
}

const packaged = { isPackaged: true }
const unpacked = { isPackaged: false }

check('упакованный: ONECODE_RELAY_URL не переопределяет адрес посредника', () => {
  assert.equal(relayUrl(packaged), VENDOR)
})
check('упакованный: ONECODE_REMOTE_AUTOAPPROVE не одобряет подключение без человека', () => {
  assert.equal(autoApprove(packaged), false)
})
check('упакованный: ONECODE_REMOTE_CODE_FILE не пишет код pairing на диск', () => {
  assert.deepEqual(codeFileWrite(packaged), [])
})
check('упакованный: ONECODE_SMOKE_FIXTURE не подменяет подсказку', () => {
  assert.equal(smokeFixture(packaged), false)
})

// Отрицательные контроли: в unpacked тестовые прогоны продолжают работать.
check('контроль unpacked: env-адрес посредника работает (E2E)', () => {
  assert.equal(relayUrl(unpacked), env.ONECODE_RELAY_URL)
})
check('контроль unpacked: автоодобрение E2E работает', () => {
  assert.equal(autoApprove(unpacked), true)
})
check('контроль unpacked: код pairing пишется в файл E2E', () => {
  assert.deepEqual(codeFileWrite(unpacked), [[env.ONECODE_REMOTE_CODE_FILE, 'PAIRING-SECRET']])
})
check('контроль unpacked: smoke-фикстура работает', () => {
  assert.equal(smokeFixture(unpacked), true)
})
check('контроль: без env хуки молчат и в unpacked', () => {
  const empty = { isPackaged: false }
  const noEnv = { env: {} }
  assert.equal(new Function('app', 'process', lineWith('const REMOTE_RELAY_URL =') + '\nreturn REMOTE_RELAY_URL')(empty, noEnv), VENDOR)
  assert.equal(new Function('app', 'process', lineWith('ONECODE_REMOTE_AUTOAPPROVE') + '\nreturn false')(empty, noEnv), false)
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0