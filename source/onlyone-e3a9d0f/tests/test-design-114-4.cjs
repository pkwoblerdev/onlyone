'use strict'
// 1.14, часть 4 — счётчики панели и строка, повторяющая название чата
// (критика дизайн-системы: «В панели счётчики „0" моноширинным у каждого
// раздела — шум. → только не ноль»; «Пункт меню повторяет название чата
// первой строкой. → убрать»).
//
// ТЕСТЫ ДО КОДА: сейчас нули стоят у каждого раздела, а в списке второстепенной
// панели текущий диалог повторяется строкой — набор обязан быть красным и
// назвать, чего не хватает.
//
// Проверяется то, что тяжело увидеть на одном снимке: где именно пишутся
// счётчики и все ли семь мест идут через одну мерку «ноль не показываем».
// Экраном меряется `run-design-114-4-ui.cjs`.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const app = read('src', 'renderer', 'app.js')
const html = read('src', 'renderer', 'index.html')

let checks = 0
let failed = 0
function check(name, fn) {
  checks++
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${String(error && error.message).replace(/\s*\n\s*/g, ' · ').slice(0, 300)}`)
  }
}

// ─── 1. счётчики панели: ноль не рисуют ─────────────────────────────────────

check('у счётчиков панели одна мерка, и в ней ноль не показан', () => {
  const at = app.indexOf('function setNavCount')
  assert.ok(at > 0, 'нет общей функции, которая писала бы счётчик панели')
  const body = app.slice(at, app.indexOf('\n  }', at))
  assert.match(body, /hidden\s*=\s*[^;\n]*(<=\s*0|!\s*\w+|\w+\s*===\s*0)/,
    'функция есть, но ноль она не прячет')
  assert.match(body, /textContent/, 'счётчик не заполняется')
})

check('ни один счётчик панели не пишется мимо общей меры', () => {
  // Список берётся из разметки: что стоит в панели как `.badge-count`, то и
  // обязано подчиняться мерке. Иначе проверка ловила бы счётчики модели или
  // хранилища, которые к панели отношения не имеют.
  const ids = [...html.matchAll(/id="([A-Za-z0-9_-]+)" class="badge-count"/g)].map(m => m[1])
  assert.ok(ids.length >= 4, `в разметке только ${ids.length} счётчиков панели — проверять нечего`)
  const offenders = []
  for (const id of ids) {
    const pattern = new RegExp(`\\b(el\\.|\\$\\()'${id}'?\\)?\\s*\\.?\\s*textContent\\s*=|\\b${id}\\b[^\\n]*\\.textContent\\s*=`, 'g')
    for (const match of app.matchAll(pattern)) {
      const line = app.slice(app.lastIndexOf('\n', match.index) + 1, match.index + match[0].length)
      if (/function setNavCount|setNavCount\(/.test(line)) continue
      offenders.push(id)
    }
  }
  assert.deepEqual([...new Set(offenders)], [],
    'пишут число напрямую: ' + [...new Set(offenders)].join(', '))
})

check('в разметке панели счётчик не начинается с нуля', () => {
  const zeros = [...html.matchAll(/class="badge-count"[^>]*>\s*0\s*</g)]
  assert.equal(zeros.length, 0,
    `${zeros.length} счётчиков стоят с нулём в разметке: до первой загрузки данных человек видит шум`)
})

// ─── 2. меню второстепенной панели не повторяет выбранный диалог ────────────

check('в списке второстепенной панели нет строки про текущий диалог', () => {
  // Якорь — сам обработчик, а не id: `$('splitChatLabel')` встречается и в
  // списке элементов, и окно проверки ушло бы в совершенно чужой кусок файла.
  const at = app.indexOf("$('splitChatLabel')?.addEventListener")
  assert.ok(at > 0, 'не найдён список диалогов второстепенной панели')
  const body = app.slice(at, at + 1600)
  // Текущий диалог и так написан на кнопке: строкой в списке он только шумит.
  // Мерка — сам признак исключения, а не форма строки: фильтр мог обрасти
  // скобками, и проверка по одному регулярному выражению падала бы на ровном месте.
  assert.match(body, /chat\.id\s*!==\s*side\.chatId/,
    'текущий диалог не исключён из списка — меню повторяет название чата первой строкой')
  assert.equal(/checked:\s*chat\.id === side\.chatId/.test(body), false,
    'пункт про текущий диалог помечен галочкой — он всё ещё в списке')
})

console.log(`Проверок: ${checks}, отказов: ${failed}`)
console.log(JSON.stringify({ ok: failed === 0, checks, failed }))
process.exitCode = failed ? 1 : 0
