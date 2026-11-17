// Смешанный шаблон «{0}» + «%s» не должен удваивать аргумент (аудит 01.11, Н7).
//
// И в главном процессе (src/main/ui-text.cjs), и в окне (function t в app.js)
// подстановка шла в два прохода: сначала заменялись «{n}», по получившейся строке
// затем сканировались «%s». Вставленный текст участвовал во втором поиске — и
// аргумент, содержавший «%s», подставлялся снова. Живых смешанных шаблонов в коде
// нет, но ловушка стреляет на первом же bilingual-тексте.
//
// Правильный ответ — один проход по шаблону: ни «{n}», ни «%s» не перечитывают
// уже вставленный текст. Проверяем обе реализации (ui-text.cjs и оконный t).
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const { fill } = require('../src/main/ui-text.cjs')

let failed = 0
function check (name, fn) {
  try { fn(); console.log('ok  ' + name) } catch (e) { failed++; console.error('ПРОВАЛ  ' + name + ' — ' + e.message) }
}

// Одинаковые ожидания для обеих реализаций подстановки.
const EXPECT = [
  // args: ['a%sb', 'CCC'] — «{0}» берёт args[0], «%s» — следующий по позиции (args[1]);
  // вставленный «a%sb» не перечитывается.
  ['{0} (%s)', ['a%sb', 'CCC'], 'a%sb (CCC)'],
  ['%s ➜ %s', ['имя%sфайл', 'X'], 'имя%sфайл ➜ X'],
  ['версия %s из %s', [1, 3], 'версия 1 из 3'],
  ['{1} из {0}', [3, 1], '1 из 3'],
  ['обычный %s без смеси', ['значение'], 'обычный значение без смеси'],
  ['%s и %s и %s', ['один', 'два'], 'один и два и %s'], // висячий %s остаётся как есть
  ['{5} вне диапазона %s', ['x'], '{5} вне диапазона %s'] // «{5}» вне диапазона остаётся literal
]

check('ui-text.cjs: fill подставляет в один проход', () => {
  for (const [template, args, want] of EXPECT) {
    assert.equal(fill(template, args), want, `fill(${JSON.stringify(template)}, ${JSON.stringify(args)})`)
  }
})

// Тот же fill внутри оконного t(): извлекаем функцию t как в test-en-locale и
// гоняем на русском (uiLang==='ru' → t возвращает fill(text)).
check('app.js: оконный t() подставляет в один проход', () => {
  const appCode = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n')
  const match = appCode.match(/function\s+t\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/)
  assert.ok(match, 'function t() не найден в app.js')
  const sandbox = { window: { __I18N__: { en: {}, ru: null } }, uiLang: 'ru', DICT: () => null }
  vm.createContext(sandbox)
  vm.runInContext(match[0], sandbox)
  for (const [template, args, want] of EXPECT) {
    assert.equal(sandbox.t(template, ...args), want, `t(${JSON.stringify(template)}, …)`)
  }
})

if (failed) { console.error(`\n${failed} проверок провалено`); process.exitCode = 1 }
else console.log('\nПодстановка шаблонов: оба прохода сведены в один')
