'use strict'

// Поиск по файлам рабочей папки. Инструмента не было — агент
// перечитывал файлы целиком, и в живом прогоне проверяющий открывал один и тот
// же файл по десять раз. Ходим только по рабочим корням: те же границы, что у
// list_files и read_file.

const fs = require('fs/promises')
const path = require('path')

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'release', 'target',
  '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', 'coverage', '.turbo'])
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf',
  '.pdf', '.zip', '.7z', '.rar', '.gz', '.xz', '.tar', '.exe', '.dll', '.so', '.dylib', '.mp3', '.mp4', '.webm',
  '.pak', '.asar', '.map', '.bin', '.class', '.pyc', '.node', '.icns'])

const MAX_FILE_BYTES = 2 * 1024 * 1024
const SNIFF_BYTES = 4096

// ── Почему шаблон от модели проверяют до обхода дерева ──────────────────────
//
// Движок JavaScript при несовпадении перебирает варианты заново. Замер:
// `(a+)+b` на строке из 26 символов стоит 7,4 секунды; на 40 символах перебор не
// закончится и за часы. Таймаут потока от этого защищает — поиск обрывают,
// найденное отдают, поток при этом умирает честно (замер: четыре поиска с
// таймаутом 300 мс, затем 3 с простоя — 16 мс CPU) — но сам перебор он не
// ограничивает: модель может прислать такой шаблон снова и занимать ядро
// двадцать пять секунд на каждый вызов.
//
// Разбором формы выражения дело начиналось впустую: первый вариант фильтра с
// балансом скобок пропустил ровно `(a+)+b` — в нём класс повторения был собран
// с лишней скобкой. Теперь правил два, и они разные по природе.
//
// 1. Форма: группа с неограниченным повтором внутри, помноженная на повтор
//    сама, — это заведомый перебор. Ловит `(a+)+b`, `(x+x+)+y`, `(a|ab)+b`,
//    включая те, что на коротких строках ещё быстры.
// 2. Время: гоняем выражение на коротких спорных строках ступенями 14, 16, 18,
//    20, 22 знака и отклоняем на первом шаге, который стоил дороже PROBE_HARD_MS.
//    Замер на 17 реальных шаблонах: у безопасных стоимость 0.00 мс, у
//    опасных 65–300 мс, то есть в 30–50 раз больше, чем на 14. Порог между ними
//    огромный, ошибиться трудно. Ловит формы, которых правило 1 не перечислило.
//
// Ступени нужны затем, что проба — это тоже исполнение чужого шаблона, и она
// обязана стоить меньше того, от чего защищает. Один замер на 22 знаках по
// «(a|a|a)+b» стоил 218 с: при основании больше двух 22 знака — это не
// «в худшем случае 2^22 шагов». Тот случай теперь отсекает правило 1
// (одинаковые ветки), а ступени держат всё остальное.
//
// ── Почему этого всё-таки мало и где настоящий потолок ──────────────────────
//
// Правила выше смотрят на группы. А самый вероятный в бою медленный шаблон групп
// не содержит вовсе: «.*.*b» проходит и форму, и пробу (на 22 знаках — доли
// миллисекунды) и растёт по длине строки как куб. Замер независимого аудита
// (cancel-cpu, та же машина):
//
//    200 знаков → 1,95 мс   400 → 18,47 мс   800 → 92,27 мс
//    1600 → 754,7 мс         3200 → больше 6000 мс (поток убит)   k ≈ 2,7–3,35
//
// Экстраполяция на строку в 2 МиБ — 2,4·10⁵ часов. И 2 МиБ ей разрешены:
// MAX_FILE_BYTES меряет размер ФАЙЛА, а не длину СТРОКИ, файл из одной строки в
// 12 002 знака движок честно читает и гоняет по ней регулярку.
//
// Главное отсюда: прервать один вызов `re.test()` из того же потока нельзя — ни
// бюджетом, ни сигналом. Поэтому слой за слоями, и последний слой не здесь:
//
//   1. форма  → дешёвый отказ до первого файла;
//   2. проба  → отказ по измеренной стоимости на спорном входе;
//   3. бюджет → обход сам останавливается по часам и отдаёт найденное с
//      честными метаданными (`stopped: 'budget'`), пока не кончился слот;
//   4. таймаут потока → единственный слой, который властен над застрявшим
//      внутри нативной регулярки потоком. Он живёт в search-service.js.
//
// Бюджет — это слой 3: он ограничивает суммарную работу обхода (тысячи файлов,
// медленный диск, холодный кэш), но не один исполняемый вызов регулярки.
const MAX_PATTERN_CHARS = 400
const PROBE_SHORT = 14
const PROBE_LONG = 22
// Шаг эскалации пробы: два знака. Меньше — больше замеров, больше — дальше
// улетает тот самый шаг, который первый перешагнул порог.
const PROBE_STEP = 2
// Рост вчетверо за восемь дополнительных знаков — показательная степень.
const PROBE_GROWTH = 4
const PROBE_MIN_MS = 0.5
// Абсолютный потолок: на 22 знаках дороже — значит на строке файла не кончится.
const PROBE_HARD_MS = 5

// Regex-путь никогда не получает строку целиком, если она длиннее этого: один
// вызов `re.test()` из своего потока не прерывается ничем, и единственный способ
// ограничить ЕГО стоимость — ограничить вход. 1000 знаков выбраны по двум
// замерам: у худшего из пропущенных фильтром семейств (`.*.*b`, k≈3)
// стоимость на 800 знаках — 92–114 мс, на 1600 — 755–955 мс; на тысяче это
// примерно 200 мс, то есть один вызов остаётся короче стража ниже. Цена — часть
// совпадений в строках-простынях: на дереве onlyone из 50 880 regex-совпадений
// за этим пределом начинаются 22, а строк длиннее 1000 знаков в дереве 71 из
// 169 136. Подстрока (обычный запрос) капа не знает: она линейна и дёшева.
const MAX_REGEX_LINE_CHARS = 1000
// Один замер дороже этого — значит шаблон разрастается на реальных данных, и
// обход продолжать незачем: следующие такие строки будут стоить столько же.
// Страж — не потолок одного вызова (им он быть не может в принципе), а способ
// не тащить обход до бюджетного и тем более до потокового обрыва.
const SLOW_TEST_MS = 120
// Короткую строку не меряем: на 120 знаках даже кубический рост — доли
// миллисекунды, а замерать каждый из сотен тысяч вызовов — свои наносекунды.
const SLOW_TEST_FROM_CHARS = 120

// Слои 1 и 2 не дают гарантий, они дают дешёвый отказ. Гарантию несёт бюджет:
// за 20 с обход обязан остановиться сам и отдать то, что нашёл. Две цифры честной
// цены обхода, снятые в один день и разошедшиеся в восемь раз — обе настоящие, и
// расхождение показано намеренно:
//   · 4052 файла, подстрока, первый прогон в свежем процессе с незагретым
//     дисковым кэшем — 34 442 мс (тот же запрос вторым прогоном — 2642 мс);
//   · те же деревья у независимого аудита, где кэш уже прогрелся: 599 файлов —
//     474–594 мс, 4052 файла — 3689–4645 мс (прогрев считался «холодным
//     процессом», не «холодным диском»: без прав администратора кэш не сбросить).
// То есть 20 с обрезают большой проект на холодном диске — но обрезают честно, с
// `truncated` и настоящими `files`/`skipped`, тогда как убийство потока на 25 с
// отдало бы ноль файлов и половину найденного (замер: 0 против 233 файлов).
// Поток, которому считают срок снаружи, получает бюджет уже от вызывающего
// (см. search-service.js).
const DEFAULT_BUDGET_MS = 20000
// Часы смотрим раз в 32 строки: проверка costs наносекунды, а между двумя
// проверками не может пройти ничего долгого, кроме одного `re.test()`.
const BUDGET_CHECK_LINES = 32

// Неограниченный повтор: +, * и {n,}. «0 или 1» перебор не размножает.
const UNBOUNDED_REP = /(?:[+*]|\{[0-9]+,\})/

function multiplierAfter(text, index) {
  const char = text[index]
  if (char === '+' || char === '*') return { unbounded: true, repeat: true, len: 1 }
  if (char === '?') return { unbounded: false, repeat: false, len: 1 }
  if (char === '{') {
    const end = text.indexOf('}', index)
    if (end > 0 && /^\{\d+(,\d*)?\}$/.test(text.slice(index, end + 1))) {
      const body = text.slice(index + 1, end)
      const [min, max] = body.split(',').map(part => part === '' ? undefined : Number(part))
      return { unbounded: body.includes(',') && max === undefined, repeat: (max === undefined ? min : max) > 1, len: end + 1 - index }
    }
  }
  return null
}

function groupRanges(text) {
  // Группы вида [открывающая, закрывающая] по балансу скобок; экранированные
  // символы и классы [...] не считаем.
  const found = []
  const stack = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') { index += 2; continue }
    if (char === '[') { const end = text.indexOf(']', index + 1); index = end < 0 ? text.length : end + 1; continue }
    if (char === '(') stack.push(index)
    else if (char === ')' && stack.length) found.push([stack.pop(), index])
    index += 1
  }
  return found
}

function literalBranches(body) {
  // Ветки группы, только когда каждая — простые буквы и цифры: сравнивать
  // «что начинается одинаково» у произвольных подвыражений значит выдумывать.
  const branches = []
  let current = ''
  let depth = 0
  for (const char of body) {
    if (char === '(') depth++
    else if (char === ')') depth--
    if (char === '|' && depth === 0) { branches.push(current); current = ''; continue }
    if (!/[A-Za-z0-9 _-]/.test(char)) return null
    current += char
  }
  branches.push(current)
  return branches.every(branch => branch.length > 0) ? branches : null
}

// Ветки верхнего уровня без требования к их содержанию: нужны только одинаковые.
// Одинаковые сравнивать можно, даже если это «\w» или «[a-z]{1,3}».
function topLevelBranches(body) {
  const branches = []
  let current = ''
  let depth = 0
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char === '\\') { current += body.slice(index, index + 2); index++; continue }
    if (char === '[') { const end = body.indexOf(']', index + 1); const piece = end < 0 ? body.slice(index) : body.slice(index, end + 1); current += piece; index += piece.length - 1; continue }
    if (char === '(') depth++
    if (char === ')') depth--
    if (char === '|' && depth === 0) { branches.push(current); current = ''; continue }
    current += char
  }
  branches.push(current)
  return branches
}

// Может ли повторяющаяся группа раздавать одни и те же знаки пустоте: «(a?)+»,
// «(\\s*)+», «(a{0,3})+». Это отдельная от «повтор внутри повторения» беда, и
// опасна она именно тем, что исполняется ДО обхода — внутри пробы. Замер:
// «(a?){40,}b» и «(a?b?){30,}c» не разобрались и за 4 с на 14 знаках, то есть
// проба зависла бы на первом же шаге.
// Якоря («^», «$», «\\b») и lookahead'ы пустоту умеют совпадать, но знаков не
// расходуют и перебор не размножают: «(?:^|\\s)+» — обычная маска, и трогать её
// нельзя. Поэтому ищем именно расходующую пустоту ветку.
const ZERO_WIDTH = /^(?:\^|\$|\\[bBDFNS]|\(?[=!<:])/

function atomsOf(branch) {
  // Атомы последовательности: группа, класс, экранированный символ или буква —
  // каждый со своим повторителем.
  const atoms = []
  let index = 0
  while (index < branch.length) {
    const start = index
    let char = branch[index]
    if (char === '\\') index += 2
    else if (char === '[') { const end = branch.indexOf(']', index + 1); index = end < 0 ? branch.length : end + 1 }
    else if (char === '(') {
      let depth = 0
      do {
        if (branch[index] === '\\') index += 2
        else { if (branch[index] === '(') depth++; else if (branch[index] === ')') depth--; index++ }
      } while (index < branch.length && depth > 0)
    } else index += 1
    let piece = branch.slice(start, index)
    char = branch[index]
    if (char === '*' || char === '+' || char === '?') { piece += char; index += 1 }
    else if (char === '{') {
      const end = branch.indexOf('}', index)
      if (end > 0 && /^\{\d+(,\d*)?\}$/.test(branch.slice(index, end + 1))) { piece += branch.slice(index, end + 1); index = end + 1 }
    }
    if (piece) atoms.push(piece)
  }
  return atoms
}

function distributable(body) {
  for (const branch of topLevelBranches(body)) {
    const atoms = atomsOf(branch)
    // Ветка без атомов («(?:|x)») — пустота, но раздавать ей нечего.
    if (!atoms.length) continue
    const allOptional = atoms.every(atom => {
      if (ZERO_WIDTH.test(atom)) return true
      const repeat = atom.match(/(?:[*?+]|\{\d*(?:,\d*)?\})$/)?.[0]
      if (!repeat) return false
      if (repeat === '*' || repeat === '?') return true
      const bounds = repeat.slice(1, -1).split(',')
      return Number(bounds[0] || 0) === 0
    })
    const spends = atoms.some(atom => !ZERO_WIDTH.test(atom) && /(?:[*?+]|\{0(?:,\d*)?\})$/.test(atom))
    if (allOptional && spends) return true
  }
  return false
}

// Набором знаков движок интересующую нас пару атомов сравниваем не по тексту, а
// по поведению: «может ли этот атом совпасть с таким знаком». Образец алфавита
// намеренно узкий — нужны не все буквы мира, а пересечения классов.
const SAMPLE_CHARS = [...'aZ0 \t,.;:-_@/\\()[]{}<>=!?*"\'#$%&^|~`éßАЯ']

function atomCanBe(atom) {
  // Множество знаков, которыми атом может начаться (для односимвольной проверки
  // этого достаточно: длинный атом в последовательности начинается теми же).
  const base = atom.replace(/(?:[*?+]|\{\d+(?:,\d*)?\})$/, '')
  if (!base || ZERO_WIDTH.test(base)) return null
  try {
    const probe = new RegExp('^(?:' + base + ')$')
    return SAMPLE_CHARS.filter(char => probe.test(char))
  } catch {
    return null // собраться не могло — пусть это решит движок, а не мы
  }
}

// Последовательность атомов, где соседние могут начаться одним и тем же знаком,
// а один из них умеет быть нулевой длины, — это перебор: границу между ними
// можно двигать. Правило «повтор внутри повторения» такие формы не видит:
// вложенного повтора нет — «(?:[a-z][a-z]?)+» это две соседние части, одна из
// которых умеет быть нулевой. Замер на реальном корпусе: 31–38 мс на 30
// знаках и больше 2500 мс на 40.
function ambiguousSequence(body) {
  const atoms = atomsOf(body)
  if (atoms.length < 2) return null
  for (let index = 0; index + 1 < atoms.length; index++) {
    const left = atomCanBe(atoms[index])
    const right = atomCanBe(atoms[index + 1])
    if (!left || !right) continue
    const shrinkable = /(?:[*?+]|\{\d*,(?:\d*)?\}|\{0,?\d*\})$/.test(atoms[index]) ||
      /(?:[*?+]|\{\d*,(?:\d*)?\}|\{0,?\d*\})$/.test(atoms[index + 1])
    if (shrinkable && left.some(char => right.includes(char))) return `${atoms[index]}${atoms[index + 1]}`
  }
  return null
}

// Правило 1. Возвращает причину или null.
function findDangerousShape(text) {
  for (const [open, close] of groupRanges(text)) {
    const spec = multiplierAfter(text, close + 1)
    if (!spec || !spec.repeat) continue
    const body = text.slice(open + 1, close).replace(/^\?(?::|[=!<][=!]?)/, '')
    if (UNBOUNDED_REP.test(body)) {
      return `повтор внутри повторения: «${text.slice(open, close + 1 + spec.len).slice(0, 60)}»`
    }
    if (distributable(body)) {
      return `повторяющаяся группа, которая может совпасть с пустотой: ` +
        `«${text.slice(open, close + 1 + spec.len).slice(0, 60)}» — число способов раздать знаки растёт с длиной строки. Ищите короче: «(\\w+)» вместо «(\\w*)+».`
    }
    // Две одинаковые ветки в повторяющейся группе — это заведомый перебор:
    // вход разбивается на них несколькими способами, и число способов
    // множится. Замер: «(a|a|a)+b» на 22 знаках стоил 218 с.
    const branches = topLevelBranches(body)
    if (branches.length > 1 && new Set(branches).size < branches.length) {
      return `повторяющаяся группа с одинаковыми ветками: «${text.slice(open, close + 1).slice(0, 60)}»`
    }
    const literal = spec.unbounded ? literalBranches(body) : null
    if (literal && literal.length > 1 &&
      literal.some((first, i) => literal.some((second, j) => i !== j && second.startsWith(first)))) {
      return `повторяющаяся группа с ветками, где одна начинается как другая: «${text.slice(open, close + 1).slice(0, 60)}»`
    }
    if (topLevelBranches(body).length === 1) {
      const pair = ambiguousSequence(body)
      if (pair) {
        return `повторяющаяся группа, где соседние части берут один и тот же знак: «${pair.slice(0, 30)}» внутри ` +
          `«${text.slice(open, close + 1 + spec.len).slice(0, 60)}» — границу между ними можно двигать, и число способов это сделать растёт с длиной строки.`
      }
    }
  }
  return null
}

function probeSubjects(repeat) {
  // Три формы спорного входа: одна буква, пара и буква с цифрой — разные шаблоны
  // взрываются на разном.
  const pair = 'ab'.repeat(Math.ceil(repeat / 2)).slice(0, repeat)
  const mixed = 'a1'.repeat(Math.ceil(repeat / 2)).slice(0, repeat)
  return ['a'.repeat(repeat) + '!', pair + '!', mixed + '!']
}

function timeProbe(re, subject) {
  const started = process.hrtime.bigint()
  re.lastIndex = 0
  re.test(subject)
  return Number(process.hrtime.bigint() - started) / 1e6
}

// Проба выражения, собранного не из запроса, а из маски: спорный путь вместо
// спорной строки. Порог тот же — он про стоимость одного вызова, а не про
// происхождение шаблона.
function guardCompiledRegExp(re, what, source) {
  let worst = 0
  // Имя файла длиной в 200 знаков — за пределами того, что встречается на
  // практике (NTFS держит сегмент до 255), поэтому проба смотрит именно туда.
  for (const subject of ['a/'.repeat(24) + 'z', 'ab/'.repeat(16) + 'z', 'a'.repeat(200) + 'z']) {
    worst = Math.max(worst, timeProbe(re, subject))
  }
  if (worst >= PROBE_HARD_MS) {
    throw new Error(`${what} «${String(source).slice(0, 60)}» разбирается ${worst.toFixed(1)} мс на коротком пути: ` +
      'на дереве из тысяч файлов такой обход не закончится.')
  }
  return re
}

// Возвращает собранное выражение или бросает причину. Сборка здесь одна:
// проверяем и ищем тем же объектом, чтобы проба не расходилась с обходом.
function assertSafePattern(needle, flags = '') {
  const source = String(needle ?? '')
  if (source.length > MAX_PATTERN_CHARS) {
    throw new Error(`длиннее ${MAX_PATTERN_CHARS} знаков не принимается.`)
  }
  let re
  try {
    re = new RegExp(source, flags)
  } catch (error) {
    throw new Error(`не разобрано: ${error.message}`)
  }
  const shape = findDangerousShape(source)
  if (shape) {
    throw new Error(`${shape} — перебирает варианты до бесконечности. Уберите вложенный повтор: «(\\w+)» вместо «(\\w+)+», ветки сделайте непересекающимися, либо ищите подстрокой без regex.`)
  }
  // Проба идёт ступенями, а не двумя замерами, и вот почему: сама проба — это
  // исполнение чужого шаблона, и на «(a|a|a)+b» один замер на 22 знаках стоил
  // 218 с (замер). Ступень с тем же порогом обрывает перебор на первом
  // шаге, где он ещё дешёвый: рост минимум вдвое на каждые два знака означает,
  // что шаг, перешагнувший порог, не дороже нескольких кратных ему.
  const cost = count => Math.max(...probeSubjects(count).map(subject => timeProbe(re, subject)))
  let shortest = null
  for (let length = PROBE_SHORT; ; length += PROBE_STEP) {
    const spent = cost(length)
    if (shortest === null) shortest = spent
    if (spent >= PROBE_HARD_MS) {
      throw new Error(`разбирается ${spent.toFixed(1)} мс уже на ${length} знаках — на строке файла такой шаблон не закончится.`)
    }
    if (length >= PROBE_LONG) {
      if (spent >= PROBE_MIN_MS && spent / Math.max(shortest, 0.001) >= PROBE_GROWTH) {
        throw new Error(`перебирает варианты экспоненциально: ${shortest.toFixed(2)} мс на ${PROBE_SHORT} знаках против ${spent.toFixed(2)} мс на ${length}. ` +
          'Уберите вложенный повтор — например «(\\w+)» вместо «(\\w+)+», — или ищите подстрокой без regex.')
      }
      break
    }
  }
  return re
}

// «*.js» должен находить и во вложенных папках, иначе glob годится только на
// плоский каталог.
//
// Проверяется маска по тем же причинам, что и query, — и долго проверялась по
// совершенно другим. Первый вариант собирал «**» в «.*», и маска
// «**/**/**/**/zzz» на пути из 150 знаков стоила 2,4 с, а из 200 — больше 8 с
// (замер). При этом проверка формы и проба к маске не применялись: они
// про query. Ужас в том, что `fileWanted.test(rel)` вызывается на каждом файле
// и остановить один такой вызов изнутри нельзя — ни бюджетом, ни сигналом.
//
// Что сделано: «**» разрешён только целым сегментом (иначе это опечатка),
// подряд идущие «**» схлопнуты в один, а сам «**/» собирается в
// «(?:[^/]+/)*» — разбивка пути на сегменты единственна, перебирать нечего.
// Оставшиеся «*» ограничены и числом, и длиной маски, и в доверение выражение
// замеряется на коротком спорном пути той же пробой, что и query.
const MAX_GLOB_CHARS = 120
// Один «*» — это ещё один множитель перебора по длине имени: «*a*a*a*z» по
// файлу из 300 знаков разбирается секунды (замер). Имена в NTFS и ext4
// короче 256 знаков, поэтому трёх на сегмент хватает с запасом и перебор
// остаётся кубическим по короткой величине.
const MAX_STARS_PER_SEGMENT = 3
// «src/*/a/*-??*.test.cjs» — это четыре. Больше десяти в осмысленной маске не
// бывает, а каждый следующий — степень перебора.
const MAX_GLOB_STARS = 10

function escapeGlobSegment(segment) {
  return segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
}

function globToRegExp(glob) {
  const normalized = String(glob).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '')
  if (normalized.length > MAX_GLOB_CHARS) {
    throw new Error(`маска длиннее ${MAX_GLOB_CHARS} знаков: ${normalized.length}. Уточни путь, а не перебирай варианты.`)
  }
  const segments = normalized.split('/').map(segment => segment.replace(/\*{3,}/g, '**'))
  for (const segment of segments) {
    // «src**js» не значит «где-то внутри»: двойная звезда — это про папки.
    if (segment.includes('**') && segment !== '**') {
      throw new Error('«**» — отдельный сегмент маски: «src/**/*.js», а не «src**js».')
    }
  }
  // «**/**/x» и «**/x» значат одно и то же намерение, но первое перебирает разбивку
  // пути заново на каждой паре звёзд.
  const parts = segments.filter((segment, index) => segment !== '**' || segments[index - 1] !== '**')
  if (parts.filter(segment => segment === '**').length > MAX_GLOB_STARS) {
    throw new Error(`в маске больше ${MAX_GLOB_STARS} «**»: такой обход не кончится.`)
  }
  // «?» съедает ровно один знак и перебор не множит, поэтому считаем только «*».
  // Целый сегмент «**» к именам не относится: он разобран ниже по-своему.
  let stars = 0
  for (const segment of parts) {
    if (segment === '**') continue
    const count = (segment.match(/\*/g) || []).length
    if (count > MAX_STARS_PER_SEGMENT) {
      throw new Error(`в одном имени внутри маски больше ${MAX_STARS_PER_SEGMENT} «*» (${segment.slice(0, 40)}): ` +
        'перебор по длине имени растёт степенью этого числа.')
    }
    stars += count
  }
  if (stars > MAX_GLOB_STARS) {
    throw new Error(`в маске больше ${MAX_GLOB_STARS} «*»: перебор по имени файла растёт степенью этого числа.`)
  }

  let body = ''
  for (let index = 0; index < parts.length; index++) {
    const segment = parts[index]
    if (segment === '**') {
      // В конце — «всё, что внутри», на одном «.*» перебор линейный. В середине
      // — целое число сегментов: «(?:[^/]+/)*» разбивает путь единственным
      // способом, поэтому вариантов для движка не возникает вовсе.
      body += index === parts.length - 1 ? '.*' : '(?:[^/]+/)*'
      continue
    }
    body += escapeGlobSegment(segment)
    if (index < parts.length - 1) body += '/'
  }
  return guardCompiledRegExp(new RegExp('(^|/)' + body + '$', 'i'), 'маска', String(glob))
}

// Шаблон, для которого правый край строки значит что-то сам по себе: «$» —
// привязка к краю, «\b» и «\B» смотрят на соседа справа, look-around тоже. Для
// такого шаблона обрезка НЕ эквивалентна: «x+$» по началу длинной строки
// совпадёт там, где во всей строке совпадения нет. Потерять совпадение от капа
// можно, придумать — нельзя, поэтому такие шаблоны длинную строку не видят вовсе
// и это посчитано («skipped.long_regex_unchecked»).
// Класс [...] не считаем: «$» и «.» внутри него — обычные знаки.
function edgeSensitive(source) {
  const text = String(source ?? '')
  let inClass = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') {
      const next = text[index + 1]
      if (!inClass && (next === 'b' || next === 'B')) return true
      index++
      continue
    }
    if (char === '[') { inClass = true; continue }
    if (char === ']') { inClass = false; continue }
    if (inClass) continue
    if (char === '$') return true
    if (char === '(' && text[index + 1] === '?' && (text[index + 2] === '=' || text[index + 2] === '!')) return true
  }
  return false
}

function looksBinary(buffer) {
  const end = Math.min(buffer.length, SNIFF_BYTES)
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true
  return false
}

async function* walk(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name.toLowerCase())) yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

// roots — [{ root, label }], как возвращает rootLabels() в главном процессе:
// путь в ответе подписан именем папки, иначе из нескольких корней он неоднозначен.
// budgetMs — потолок суммарной работы обхода (слой 3); 0 или Infinity — без
// своего лимита, тогда остаётся только таймаут потока. deadlineAt — абсолютная
// отметка Date.now(), удобна тому, кто уже знает, сколько он ждал.
async function search({ roots, query, in: within = '.', glob = '', regex = false, ignoreCase = true,
  maxMatches = 200, maxFiles = 20000, maxLineChars = 300, budgetMs = DEFAULT_BUDGET_MS, deadlineAt = null,
  onPhase = null, onBatch = null }) {
  onPhase?.('probe')
  const needle = String(query ?? '')
  // Маску проверяем до первого файла и с тем же вниманием к срокам, что и
  // запрос: она тоже приходит от модели и тоже превращается в регулярку.
  let fileWanted = null
  if (glob && glob.trim()) {
    try {
      fileWanted = globToRegExp(glob.trim())
    } catch (error) {
      throw new Error(`Маска не принята: ${error.message}`)
    }
  }
  // Один glob без query — это «найди файлы с таким именем», а не «ничего не
  // ищи»: на большом дереве это единственный дешёвый способ узнать, как файл
  // называется и где лежит, не перечитывая содержимое.
  if (!needle.trim() && !fileWanted) throw new Error('Нужен query или glob: без обоих непонятно, что искать.')
  const byNameOnly = !needle.trim()

  let test = null
  if (regex && !byNameOnly) {
    // Опасную форму отклоняем до первого файла: иначе перебор начался бы внутри
    // обхода, и единственной защитой остался таймаут потока. Ошибка отсюда
    // доходит до модели текстом — модель в этот момент не молчит, а получает
    // внятную причину и может переформулировать.
    try {
      test = assertSafePattern(needle, ignoreCase ? 'i' : '')
    } catch (error) {
      throw new Error(`Регулярное выражение не принято: ${error.message}`)
    }
  } else if (ignoreCase) {
    const lower = needle.toLowerCase()
    test = line => line.toLowerCase().includes(lower)
  } else {
    test = line => line.includes(needle)
  }
  const matchesLine = regex ? line => test.test(line) : test
  // Считается один раз на поиск: шаблон с привязкой к правому краю обрезанную
  // строку видеть не вправе.
  const edgeCapped = regex && !byNameOnly && edgeSensitive(needle)

  // Монокронный счётчик: стенные часы могут прыгнуть (синхронизация времени в
  // Windows), а обрыв обхода из-за этого не должен ни появляться, ни исчезать.
  const limit = Number.isFinite(deadlineAt)
    ? Math.max(0, deadlineAt - Date.now())
    : (Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : Infinity)
  const openedAt = process.hrtime.bigint()
  let stopped = null
  let fileLimitHit = false
  const outOfTime = () => {
    if (stopped) return true
    if (Number(process.hrtime.bigint() - openedAt) / 1e6 >= limit) stopped = 'budget'
    return Boolean(stopped)
  }

  let files = 0
  const matches = []
  const skipped = { large: 0, binary: 0, long_regex: 0, long_regex_unchecked: 0, slow_regex: 0 }
  // Часть отдают по дороге: тому, кто ждёт с таймаутом, полезны уже найденное, а
  // не пустой ответ после обрыва.
  let sent = 0
  const flush = (force = false) => {
    if (!onBatch) return
    if (force ? matches.length > sent : matches.length - sent >= 100) {
      onBatch(matches.slice(sent))
      sent = matches.length
    }
  }
  const addMatch = match => { matches.push(match); flush() }

  // С этого места шаблон уже собран и проверен: дальше — только обход, и у
  // вызывающего появляется право заменить короткий срок пробы на длинный срок
  // обхода.
  onPhase?.('walk')
  for (const { root, label } of roots) {
    const base = path.resolve(root, String(within || '.'))
    for await (const file of walk(base)) {
      if (files >= maxFiles) { fileLimitHit = true; break }
      if (outOfTime()) break
      if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue
      const rel = path.relative(root, file).replace(/\\/g, '/')
      if (fileWanted && !fileWanted.test(rel)) continue
      files++
      if (byNameOnly) {
        addMatch({ file: label ? `${label}/${rel}` : rel, line: 0, text: '' })
        if (matches.length >= maxMatches) break
        continue
      }

      let stat
      try {
        stat = await fs.stat(file)
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { skipped.large++; continue }
        const head = await fs.readFile(file)
        if (looksBinary(head)) { skipped.binary++; continue }

        const lines = head.toString('utf8').split(/\r?\n/)
        for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
          if ((i % BUDGET_CHECK_LINES) === 0 && outOfTime()) break
          const line = lines[i]
          // Регулярке отдаём начало длинной строки, подстроке — всю: подстрока
          // линейна и бояться нечего. Потерянное капированием видно в
          // `skipped.long_regex`, а не исчезает молча.
          let subject = line
          if (regex && line.length > MAX_REGEX_LINE_CHARS) {
            if (edgeCapped) {
              skipped.long_regex_unchecked++
              continue
            }
            skipped.long_regex++
            subject = line.slice(0, MAX_REGEX_LINE_CHARS)
          }
          if (regex && subject.length >= SLOW_TEST_FROM_CHARS) {
            const at = process.hrtime.bigint()
            const hit = matchesLine(subject)
            const spent = Number(process.hrtime.bigint() - at) / 1e6
            if (spent >= SLOW_TEST_MS) {
              skipped.slow_regex++
              stopped = 'costly'
              break
            }
            if (!hit) continue
          } else if (!matchesLine(subject)) {
            continue
          }
          addMatch({
            file: label ? `${label}/${rel}` : rel,
            line: i + 1,
            text: line.trim().slice(0, maxLineChars)
          })
        }
      } catch {
        // Пропуск: право доступа отнялось в момент обхода, или это битый симлинк.
        continue
      }
      if (stopped || matches.length >= maxMatches) break
    }
    if (stopped || matches.length >= maxMatches) break
  }

  flush(true)
  // Любой обрыв — и по бюджету, и по стоимости одного замера, и по потолку файлов —
  // означает неполный ответ: иначе «мало совпадений» читалось бы как «в проекте этого нет».
  return { matches, files, skipped, truncated: matches.length >= maxMatches || Boolean(stopped) || fileLimitHit, stopped }
}

module.exports = { search, globToRegExp, looksBinary, assertSafePattern, edgeSensitive, SKIP_DIRS, MAX_FILE_BYTES,
  DEFAULT_BUDGET_MS, MAX_REGEX_LINE_CHARS }
