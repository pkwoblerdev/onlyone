// Приложение телефона: у каждой русской строки интерфейса есть английская, лишних переводов нет, общие модули не разошлись.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { strings } = require('../mobile/strings.cjs')

let failed = 0
function check(name, fn) { try { fn(); console.log('ok', name) } catch (error) { failed++; console.error('ПРОВАЛ', name, '-', error.message) } }

const sandbox = { window: { OnlyoneI18n: { EN: {} } } }
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../mobile/www/js/en.js'), 'utf8'), sandbox)
const EN = sandbox.window.OnlyoneI18n.EN

check('каждая строка t(…) переведена на английский', () => {
  const missing = strings().filter(text => !EN[text])
  assert.deepEqual(missing, [], 'нет перевода: ' + missing.join(' | '))
})
check('в словаре нет мёртвых строк, которых никто не вызывает', () => {
  const used = new Set(strings())
  const html = ['app.js', 'render.js', 'remote.js'].map(name => fs.readFileSync(path.join(__dirname, '../mobile/www/js', name), 'utf8')).join('\n')
  const dead = Object.keys(EN).filter(key => !used.has(key) && !html.includes(key))
  assert.deepEqual(dead, [], 'лишнее: ' + dead.join(' | '))
})
check('общие модули телефона совпадают с исходниками компьютера (запустите node mobile/sync.cjs)', () => {
  for (const name of ['remote-protocol.js', 'remote-pairing.js', 'remote-link.js']) {
    const copy = path.join(__dirname, '../mobile/www/js/shared', name)
    assert.ok(fs.existsSync(copy), 'нет копии ' + name)
    assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(__dirname, '../src/shared', name), 'utf8'), name + ' разошёлся')
  }
})
check('приложение называется onlyone, значок — искра; id пакета best.pkwobler.onlyone', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../mobile/capacitor.config.json'), 'utf8'))
  assert.equal(config.appId, 'best.pkwobler.onlyone')
  assert.equal(config.appName, 'onlyone')
  assert.match(fs.readFileSync(path.join(__dirname, '../mobile/www/js/icons.js'), 'utf8'), /e08c62|currentColor/)
})
check('резервное копирование Android выключено: зашифрованные данные не уходят в облако', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../mobile/android/app/src/main/AndroidManifest.xml'), 'utf8'), /android:allowBackup="false"/)
})

if (failed) process.exit(1)
console.log('\nПеревод и сборка приложения телефона: проверки пройдены')
