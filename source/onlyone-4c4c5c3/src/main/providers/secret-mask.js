'use strict'

// Единный маскировщик секретов для всех путей к модели.
//
// Почему это не `redactSecrets` из `run-checkpoints.js`: тот знает ФОРМЫ
// живых ключей (sk-, AIza, xoxb-, ghp_, JWT, Bearer, 32+ символа, а также
// короткие значения с провайдерским префиксом) и хорош против общего мусора.
// Против конкретного секрета этого запроса он бессилен: сервер вправе
// процитировать отправленный заголовок, вставив в него что-то своё
// («key Q7z2…Jp2W is invalid»), и тогда ни целого совпадения, ни длинного
// непрерывного куска не остаётся. Здесь маскируются ОКНА САМОГО КЛЮЧА.
//
// Правило, из которого вырос модуль: прежняя маска `…abcd` выдавала четыре
// символа ключа в окно, а проверка «ключа нет целиком» это пропускала. Значит
// сравнивать надо не только целое значение, но и его куски.

const { redactSecrets } = require('../run-checkpoints')

// Длина окна: восемь символов — это уже не совпадение с обычным словом
// («model», «invalid», «status»), и при этом любой осмысленный эхо-кусок
// ключа длиной ≥ 8 попадается окну целиком.
const WINDOW = 8
// Кусок текста, похожий на фрагмент ключа: латиница, цифры и то, что в ключах
// встречается (`-`, `_`, `.`, `+`, `/`, `=`). Разбирается ТОКЕН ЦЕЛИКОМ, а не
// подстрока: так адрес локального сервера (`http://127.0.0.1:11434/v1`) не
// превращается в `http://127.0.0.1:[ключ]/v1` только потому, что порт кончается
// на хвост ключа.
const WORD = /[A-Za-z0-9._~+/=-]{4,}/g
// Точка в конце предложения — не часть токена: «credential 11434.» это тот же
// эхо-хвост, что и «credential 11434», и терять его из-за типографики нельзя.
const SENTENCE_DOT = /\.$/

// Заголовок авторизации: маскируется ЗНАЧЕНИЕ, а не конец строки — жадный
// `[:=].*$` съедал и код статуса, и имя модели, и человек оставался без того,
// по чему отказ вообще понимается.
const HEADER = /\b(authorization|x-api-key|api-key|anthropic-api-key|proxy-authorization|x-goog-api-key)(\s*[:=]\s*)(?:Bearer\s+)?(\S+)/gi

// Маска, которую не трогает `redactSecrets`: свои маркеры он бы перемаркировал
// в `***`, и проверка «значение ключа заменено вот этим» стала бы гонкой
// порядков, а не правилом.
const MASK = '[ключ]'

const SIZES = [4, 6, 8, 10]
// Кусок считается «машинным», если в нём есть цифра или заглавная буква.
// Слитное строчное окончание (`…code`) подменяло бы обычное слово в
// объяснении, и человек остался бы без причины отказа.
const MACHINE = /[0-9A-Z]/

function windows(secret, size = WINDOW) {
  const key = String(secret || '')
  if (key.length < size) return key.length >= 4 ? [key] : []
  const out = []
  for (let i = 0; i + size <= key.length; i++) out.push(key.slice(i, i + size))
  return out
}

// Хвосты ключа: 4, 6, 8 и 10 последних символов. Именно так живой сервер и
// сокращает секрет в объяснении — OpenAI пишет `sk-…Jp2W`, и против такого
// хвоста окна по восемь символов бессильны.
//
// Начало берётся только у короткого ключа (меньше 24 символов), где префикс и
// есть большая часть секрета. У длинных ключей начало — общий префикс формата
// (`sk-or-v1`), и подменять его значило бы вымарывать из объяснения имя
// формата, а не секрет.
function edges(secret) {
  const key = String(secret || '')
  const out = []
  for (const size of SIZES) {
    if (key.length >= size) out.push({ piece: key.slice(-size), at: 'end' })
    if (key.length < 24 && key.length >= size) out.push({ piece: key.slice(0, size), at: 'start' })
  }
  return out.filter(entry => entry.piece.length >= 4 && MACHINE.test(entry.piece))
}

// Текст с вычищенным секретом. Порядок такой: сначала общие формы и присваивания
// (`redactSecrets`), потом точное значение, окна и края ключа, потом
// заголовки. Если поменять местами, `redactSecrets` допирает до уже вставленной
// маски и заменяет её своими `***` — поведение то же, но проверка держится за
// слово «[ключ]», и по нему видно, что сработало именно правило секрета.
//
// Чужие ключи этот шаг не знает, поэтому затирает и обычное слово после
// «key=» — цена ловить секрет, которого мы не прогнозировали. На текст нашего
// отказа это не влияет: код статуса, имя модели и подсказку подставляют уже
// после маски, отдельно от серверных слов.
//
// Сравнение несёт и регистр: сервер вправе процитировать ключ заглавными или
// строчными, и для человека это тот же секрет.
function maskSecretText(text, secret) {
  let out = redactSecrets(String(text == null ? '' : text))
  const key = typeof secret === 'string' ? secret.trim() : ''
  if (key.length >= 4) {
    out = out.split(key).join(MASK)
    const wins = windows(key).map(piece => piece.toLowerCase())
    const cuts = edges(key).map(entry => ({ piece: entry.piece.toLowerCase(), at: entry.at }))
    out = out.replace(WORD, word => {
      const token = word.toLowerCase().replace(SENTENCE_DOT, '')
      const hit = wins.some(piece => token.includes(piece)) ||
        cuts.some(entry => (entry.at === 'end' ? token.endsWith(entry.piece) : token.startsWith(entry.piece)))
      return hit ? MASK : word
    })
  }
  return out.replace(HEADER, (whole, name, sep) => `${name}${sep}${MASK}`)
}

module.exports = { maskSecretText, windows, edges, WINDOW }
