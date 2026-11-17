// Разрушающие диалоги должны иметь английскую пару в словаре (аудит 01.11, Н2/Н3/Н5/Н7).
//
// Единственный разрушающий диалог приложения — выход с несохранённой историей —
// и окно о потере ключа профиля показывают человеку русский текст даже в EN-сборке:
// часть строк не обёрнута в tr(), а для кнопок «Попробовать ещё раз»/«Выйти без
// сохранения»/«Понятно» и длинных detail-фраз ключей в i18n.js нет вовсе.
//
// Обёртки tr() в чужих файлах (main.js, profile-notice.cjs) кладёт ведущий; здесь
// проверяется СЛОВАРЬ — моя часть работы: каждая обещанная строка имеет пару,
// английское значение не содержит кириллицы, а число «%s» совпадает с ключом
// (иначе подстановка разъедется и на экране осядет голый «%s»).
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const dict = new Function('window', `${fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8')}
return window.__I18N__.en`)({})

// Ключ нормализуется ровно как tr()/applyTranslations(): пробелы свёрнуты, по краям обрезано.
const keyOf = text => String(text).replace(/\s+/g, ' ').trim()
const count = (text, re) => (String(text).match(re) || []).length

// Русские строки, которые видят человека и которые обязаны быть в словаре.
const REQUIRED = [
  // Диалог выхода с несохранённой историей (main.js ask()).
  'Попробовать ещё раз',
  'Выйти без сохранения',
  'Можно попробовать ещё раз. Если выйти сейчас, всё с последнего удачного сохранения пропадёт.',
  // Окно о потере ключа / нечитаемых секциях (profile-notice.cjs noticeKeyLoss()).
  'Понятно',
  'Файлы на месте и не изменены — папка данных: %s.',
  'Ключ шифрования пишет Chromium, и если приложение было закрыто сбоем в первые секунды после создания профиля (или файлы пришли с другой учётной записи Windows), ключ до диска не дожил.',
  'Ничего из этой папки не удаляйте: там лежит шифр, который можно разобрать руками. Приложение работает далее, но при первом же сохранении отложит нечитаемые файлы рядом с именем `.key-lost-<дата>` — вместо того чтобы молча перезаписать их пустым списком.',
  'Секции настроек (%s) сохранены в папке %s — ничего из неё не удаляйте, чтобы можно было разобрать руками.'
]

let failed = 0
function check (name, fn) {
  try { fn(); console.log('ok  ' + name) } catch (e) { failed++; console.error('ПРОВАЛ  ' + name + ' — ' + e.message) }
}

check('все строки разрушающих диалогов имеют английскую пару', () => {
  const missing = REQUIRED.map(keyOf).filter(key => !dict[key])
  assert.deepEqual(missing, [], `нет пары в i18n.js для ${missing.length} строк: ` + missing.map(s => s.slice(0, 40)).join(' | '))
})

check('в английских значениях нет кириллицы', () => {
  const cyr = REQUIRED.map(keyOf).filter(key => dict[key] && /[а-яёА-ЯЁ]/.test(dict[key]))
  assert.deepEqual(cyr, [], 'EN-значение написано кириллицей: ' + cyr.map(s => s.slice(0, 30)).join(' | '))
})

check('число подстановок «%s» совпадает с ключом', () => {
  const bad = []
  for (const raw of REQUIRED) {
    const key = keyOf(raw)
    const en = dict[key]
    if (!en) continue
    if (count(key, /%s/g) !== count(en, /%s/g)) bad.push(`${key.slice(0, 36)}: в ключе ${count(key, /%s/g)}, в паре ${count(en, /%s/g)}`)
  }
  assert.deepEqual(bad, [], 'подстановки разъедутся: ' + bad.join(' | '))
})

if (failed) { console.error(`\n${failed} проверок провалено`); process.exitCode = 1 }
else console.log('\ni18n разрушающих диалогов: пары на месте')
