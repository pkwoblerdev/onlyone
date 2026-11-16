// Текст, который главный процесс показывает человеку.
//
// Словарь тот же файл, что читает окно: `src/renderer/i18n.js`. Два словаря
// неизбежно разошлись бы — «переведено в окне, но не переведено в процессе»
// перестало бы быть возможным по построению.
//
// Почему перевод здесь, а не в окне: окно ищет в словаре строку целиком, а
// главное окно собирает фразы с подстановкой — «Путь «Anthropic» не настроен:
// нужно заполнить модель, ключ.». Для словаря это неизвестная строка, и на
// английском экране она оставалась русской (Н89). Поэтому главный процесс
// получает язык окна и отправляет `tr(шаблон, аргументы)`: переводится шаблон,
// подставляются аргументы.
//
// Язык берётся из настроек каждый раз, а не один раз при старте: переключение
// языка в окне не перезапускает процесс.

let dict = null
let getLanguage = () => 'ru'

function dictionary () {
  if (dict) return dict
  const fs = require('node:fs')
  const path = require('node:path')
  const file = path.join(__dirname, '..', 'renderer', 'i18n.js')
  // `i18n.js` — скрипт окна: вешает словарь на `window`. В главном процессе
  // такого объекта нет, поэтому файл читается в подставное окно.
  const scope = {}
  const source = fs.readFileSync(file, 'utf8')
  const i18n = new Function('window', `${source}\nreturn window.__I18N__`)(scope)
  dict = (i18n && i18n.en) || {}
  return dict
}

// Откуда главный процесс узнаёт язык окна. Пока не задано — русский: это
// исходный язык, и молчание означает «не переводить».
function setLanguageSource (fn) {
  getLanguage = typeof fn === 'function' ? fn : () => String(fn || 'ru')
}

// Те же «%s» по порядку и «{0}» по номеру, что у оконного `t()`: шаблон один,
// и расхождение в подстановках значит, что экран показал бы «%s» человеку.
// Один проход: «{n}» и «%s» сканируются вместе, вставленный текст больше не
// перечитывается — иначе «%s» внутри аргумента подставлялся бы повторно (Н7).
function fill (template, args) {
  if (!args.length) return template
  let cursor = 0
  return String(template).replace(/%s|\{\d+\}/g, (all) => {
    const take = all === '%s' ? cursor : Number(all.slice(1, -1))
    cursor += 1
    return take < args.length ? String(args[take]) : all
  })
}

function tr (template, ...args) {
  if (typeof template !== 'string' || !template) return template
  if (getLanguage() !== 'en') return fill(template, args)
  const key = template.replace(/\s+/g, ' ').trim()
  return fill(dictionary()[key] || key, args)
}

module.exports = { tr, setLanguageSource, fill }
