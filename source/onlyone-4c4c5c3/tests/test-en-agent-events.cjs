// Строки, которые главный процесс шлёт в окно как «что сейчас делается», обязаны
// иметь английскую пару: в ленте их рисует интерфейс, и на английском они
// выглядят как сбой перевода.
//
// Проверка статичная — она перечисляет, что уже закрыто, и что осталось.
// Сообщения с подстановкой (`${}`) здесь помечаются отдельно: для них нужен
// шаблон с аргументом на месте отправки, а не перевод собранной фразы.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')
const i18n = fs.readFileSync(path.join(root, 'src', 'renderer', 'i18n.js'), 'utf8')

const keys = new Map()
for (const match of i18n.matchAll(/^    '((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)'/gm)) {
  keys.set(match[1].replace(/\\'/g, "'"), match[2].replace(/\\'/g, "'"))
}

// Что уходит в окно как текст для человека.
const events = [...main.matchAll(/message:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g)]
  .map(match => match[1].slice(1, -1).replace(/\\'/g, "'"))
const plain = [...new Set(events.filter(text => /[а-яёА-ЯЁ]{3,}/.test(text)))]

let failed = 0
const check = (name, fn) => {
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

check('английская пара есть у каждого русского сообщения главному процессом', () => {
  const missing = plain.filter(text => !keys.has(text))
  assert.equal(missing.length, 0,
    `${missing.length} из ${plain.length} без пары: `
    + missing.slice(0, 8).map(text => `«${text.slice(0, 60)}»`).join('; '))
})

// Отдельно — сколько сообщений собирается на месте: их словарь не догонит,
// и это не провал, а измеренный остаток, который надо переводить шаблоном.
// Планка-трещотка: число имеет право только падать. Без неё остаток в 55 мест
// незаметно превращается в 70 — новый текст с подстановкой написать легче, чем
// перевести старый.
// 29.09: 55 → 4. Закрыто лентой (`tr(шаблон, аргументы)`); четыре, что остались,
// уходят МОДЕЛИ, а не человеку, и переводить их нельзя: «Режим «План»…»,
// «Файл … изменился, пока запись ждала…», «MCP-сервер «…» успешно добавлен»,
// «Скилл «…» успешно добавлен».
// 29.09 вечер, после слияния с 1.1.19: планка 5 — тем же списком к ним
// добавилось «Порядок работы «…» построен и сохранён…» (ответ инструмента
// модели; карточка процесса и лента при нём переводятся).
const TEMPLATED_LIMIT = 5
const templated = [...new Set([...main.matchAll(/message:\s*`([^`]*[а-яё]{3,}[^`]*)`/g)].map(m => m[1]))]
  .filter(text => /\$\{/.test(text))

check(`мест с подстановкой не больше планки ${TEMPLATED_LIMIT}`, () => {
  assert.ok(templated.length <= TEMPLATED_LIMIT,
    `собранных на месте сообщений стало ${templated.length} (планка ${TEMPLATED_LIMIT}). `
    + 'Новое надо отправлять шаблоном с аргументом и парой вида «%s», а не русской фразой.')
})

console.log(JSON.stringify({
  ok: failed === 0, failed,
  статичных: plain.length, сПодстановкой: templated.length
}))
process.exit(failed ? 1 : 0)
