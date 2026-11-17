// У каждой русской строки вступления есть английская пара.
//
// test-en-locale смотрит разметку и app.js, а вступление (onboarding.js)
// собирает текст сам: через t('…') и через строки примера работы (DEMO_*).
// 26.09 так прошли 28 строк без перевода — английский первый запуск
// показывал русский текст.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(root, 'src/renderer/onboarding.js'), 'utf8')
const box = { window: {} }
vm.createContext(box)
vm.runInContext(fs.readFileSync(path.join(root, 'src/renderer/i18n.js'), 'utf8'), box)
const dict = box.window.__I18N__.en

const found = new Set()
for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)+)'/g)) found.add(m[1])
// Пример работы на первом шаге: строки лежат в константах DEMO_* и
// переводятся при показе.
const demo = [...src.matchAll(/const DEMO_\w+ = '((?:[^'\\\n])*)'/g)].map(m => m[1])
demo.forEach(text => found.add(text))
// Подписи из списков (тема, строки ответов) переводятся по значению.
for (const m of src.matchAll(/\[\s*'[a-z]+',\s*'([^']*[а-яё][^']*)'/gi)) found.add(m[1])
for (const m of src.matchAll(/rows\.push\(\['[a-z]+', '([^']+)'/g)) found.add(m[1])

const missing = [...found].filter(text => /[а-яё]/i.test(text) && !(text in dict))
const checks = [
  ['пример работы найден в onboarding.js', demo.length === 3],
  ['у каждой русской строки вступления есть английская пара', missing.length === 0, missing.slice(0, 8).join(' | ')]
]
let failed = 0
for (const [name, pass, detail] of checks) {
  if (!pass) failed++
  console.log(`${pass ? 'ok    ' : 'ПРОВАЛ'} ${name}${!pass && detail ? ' — ' + detail : ''}`)
}
console.log(JSON.stringify({ ok: failed === 0, failed, strings: found.size }))
process.exit(failed ? 1 : 0)
