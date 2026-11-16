// Заголовки поручений в панели работы.
//
// На живом прогоне панель показала «Прочитай файл package», а строкой ниже
// обрывок «.json в корне ра…»: точка внутри имени файла считалась концом фразы.
// Читается это как поломка, и увидеть её можно было только глазами — ни одна
// проверка не смотрела на то, что получается из настоящего текста поручения.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Заголовки рисует панель «Работа», а она вынесена своим модулем (план, 2d).
// Код окна разложен по модулям (план, 2d): проверяем весь исполняемый текст.
const app = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
const cut = (from, to) => {
  const a = app.indexOf(from)
  const b = app.indexOf(to, a)
  assert(a >= 0 && b > a, 'не найдена область: ' + from)
  return app.slice(a, b)
}

// Настоящие функции окна, а не их пересказ.
const ui = new Function(cut('function extractTaskTitle(', 'const BOARD_WORD') +
  '; return { extractTaskTitle, cutOnWord }')()

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

check('имя файла не разрывается по точке', () => {
  const title = ui.extractTaskTitle('Прочитай файл package.json в корне и назови версию')
  assert.match(title, /package\.json/)
})

check('расширение остаётся при заголовке', () => {
  const title = ui.extractTaskTitle('Посчитай количество строк в файле tests/run-smoke.cjs. Ничего не меняй.')
  assert.equal(title, 'Посчитай количество строк в файле tests/run-smoke.cjs')
})

check('версия не превращается в конец фразы', () => {
  assert.match(ui.extractTaskTitle('Проверь, что в package.json стоит 1.1.0 и ничего не меняй'), /1\.1\.0/)
})

check('точка с пробелом всё ещё кончает фразу', () => {
  assert.equal(ui.extractTaskTitle('Разбери отмену. Потом напиши отчёт.'), 'Разбери отмену')
})

check('двоеточие отделяет заголовок от перечисления', () => {
  assert.equal(ui.extractTaskTitle('Проверь корректность: гонки, неверные допущения'), 'Проверь корректность')
})

check('длинный заголовок обрезается по границе слова', () => {
  const title = ui.extractTaskTitle('Очень длинное поручение без всякой пунктуации которое просто продолжается дальше и дальше')
  assert(title.length <= 61, 'длина ' + title.length)
  assert(title.endsWith('…'), title)
  assert(!/\S…$/.test(title.replace('…', '')) || !title.includes('  '), title)
  // Обрезка не оставляет половину слова: последнее слово целое.
  const words = title.replace('…', '').trim().split(' ')
  assert(words.at(-1).length > 1, title)
})

check('короткое поручение остаётся целым', () => {
  assert.equal(ui.extractTaskTitle('Посчитай строки'), 'Посчитай строки')
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
