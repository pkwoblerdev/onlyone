// Ключи, записанные без шифра (разбор REA 25.10, находка 4).
//
// Когда safeStorage недоступен, ключ OpenRouter ложится base64-обёрткой — то есть
// открытым текстом. Прежний `decryptKeyValue` смотрел только на доступность шифра
// в ЭТОТ запуск: открытая запись после возврата шифра не читалась (ключ «пропадал»),
// а шифроблоб при недоступном шифре превращался в двоичный мусор и уходил в
// `Authorization`. Здесь участок главного процесса вырезается из настоящего файла и
// гоняется против поддельного safeStorage: без окна, без ключей, без сети.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(process.env.ONECODE_MAIN_UNDER_TEST ||
  path.join(root, 'src', 'main', 'main.js'), 'utf8')

function cut(from, to, label) {
  const start = main.indexOf(from)
  assert.ok(start >= 0, `якорь не найден: ${label} (начало)`)
  const end = main.indexOf(to, start)
  assert.ok(end >= 0, `якорь не найден: ${label} (конец)`)
  return main.slice(start, end)
}

const ENCRYPT = cut('function requireWindowsEncryption() {',
  '// ---------------------------------------------------------------------------\n// Encrypted storage',
  'шифрование ключа')

// Поддельный safeStorage: шифр — приставка и XOR, то есть двоичные байты, как у
// DPAPI; расшифровка чужих данных бросает.
const xor = buf => Buffer.from(buf.map(byte => byte ^ 0xa5))
function fakeSafeStorage() {
  const state = { available: true }
  return {
    state,
    isEncryptionAvailable: () => state.available,
    encryptString: text => Buffer.concat([Buffer.from('v10'), xor(Buffer.from(String(text), 'utf8'))]),
    decryptString: buf => {
      if (!state.available || buf.slice(0, 3).toString() !== 'v10') throw new Error('Error while decrypting the ciphertext')
      return xor(buf.slice(3)).toString('utf8')
    }
  }
}

function load({ openrouterKeys = [], customProviders = [] } = {}) {
  const safeStorage = fakeSafeStorage()
  const data = { openrouterKeys, customProviders }
  const store = { get: key => data[key], set: (key, value) => { data[key] = value } }
  let saves = 0
  const saveOpenRouterKeys = keys => { saves++; data.openrouterKeys = keys }
  const readCustomProviders = () => data.customProviders.map(item => ({ ...item }))
  const saveCustomProviders = list => { data.customProviders = list }
  // Чтение записи своего подключения в тесте упрощено до самого способа упаковки.
  const customKeyValue = account => Buffer.from(account.keyEncrypted, 'base64').toString('utf8')
  const api = new Function('safeStorage', 'store', 'saveOpenRouterKeys', 'readCustomProviders',
    'saveCustomProviders', 'customKeyValue',
    ENCRYPT + '\nreturn { encryptKeyValue, decryptKeyValue, upgradePlainKeys }')(
    safeStorage, store, saveOpenRouterKeys, readCustomProviders, saveCustomProviders, customKeyValue)
  return { api, safeStorage, data, saves: () => saves }
}

// Заведомо ненастоящий ключ: тест не ходит в сеть.
const KEY = 'fake-key-for-tests-only'
const plain = value => Buffer.from(value, 'utf8').toString('base64')
let failed = 0
function check(name, fn) {
  try { fn(); console.log('ok    ' + name) } catch (error) { failed++; console.log('ПРОВАЛ ' + name + ' — ' + error.message) }
}

check('открытая запись (keyEnc: plain) читается и тогда, когда шифр снова доступен', () => {
  const { api } = load()
  assert.equal(api.decryptKeyValue(plain(KEY), 'plain'), KEY)
})

check('запись без пометки при доступном шифре принимается только шифром', () => {
  // Так стенд run-provider-security-ui кладёт «заведомо нечитаемый конверт»:
  // base64 от печатного текста. Угадывать в нём открытый ключ нельзя.
  const { api } = load()
  assert.equal(api.decryptKeyValue(plain('CIPHER-NO-')), null)
})

check('шифроблоб при недоступном шифре не превращается в «ключ» из мусора', () => {
  const { api, safeStorage } = load()
  const sealed = api.encryptKeyValue(KEY)
  safeStorage.state.available = false
  assert.equal(api.decryptKeyValue(sealed), null)
})

check('шифроблоб при доступном шифре читается как раньше', () => {
  const { api } = load()
  assert.equal(api.decryptKeyValue(api.encryptKeyValue(KEY)), KEY)
})

check('при старте открытые ключи пула перешифровываются и остаются рабочими', () => {
  const { api, data, safeStorage } = load({ openrouterKeys: [{ id: 'a', keyEncrypted: plain(KEY), keyEnc: 'plain' }] })
  assert.equal(api.upgradePlainKeys(), 1)
  const [entry] = data.openrouterKeys
  assert.equal(entry.keyEnc, 'safeStorage')
  assert.notEqual(entry.keyEncrypted, plain(KEY), 'запись осталась открытой')
  assert.equal(safeStorage.decryptString(Buffer.from(entry.keyEncrypted, 'base64')), KEY)
})

check('нечитаемая запись без пометки при старте не трогается', () => {
  const { api, data, saves } = load({ openrouterKeys: [{ id: 'd', keyEncrypted: plain('CIPHER-NO-') }] })
  assert.equal(api.upgradePlainKeys(), 0)
  assert.equal(data.openrouterKeys[0].keyEncrypted, plain('CIPHER-NO-'))
  assert.equal(saves(), 0)
})

check('старая запись без отметки, но уже под шифром, только получает отметку', () => {
  const { api, data } = load()
  const sealed = api.encryptKeyValue(KEY)
  data.openrouterKeys = [{ id: 'b', keyEncrypted: sealed }]
  assert.equal(api.upgradePlainKeys(), 0)
  assert.equal(data.openrouterKeys[0].keyEncrypted, sealed)
  assert.equal(data.openrouterKeys[0].keyEnc, 'safeStorage')
})

check('открытый ключ своего подключения тоже перешифровывается', () => {
  const { api, data } = load({ customProviders: [{ id: 'p-1', keyEncrypted: plain(KEY), keyEnc: 'plain' }] })
  assert.equal(api.upgradePlainKeys(), 1)
  assert.equal(data.customProviders[0].keyEnc, 'safeStorage')
  assert.notEqual(data.customProviders[0].keyEncrypted, plain(KEY))
})

check('без шифра перешифровка ничего не трогает', () => {
  const { api, data, safeStorage, saves } = load({ openrouterKeys: [{ id: 'c', keyEncrypted: plain(KEY), keyEnc: 'plain' }] })
  safeStorage.state.available = false
  assert.equal(api.upgradePlainKeys(), 0)
  assert.equal(data.openrouterKeys[0].keyEncrypted, plain(KEY))
  assert.equal(saves(), 0)
})

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
