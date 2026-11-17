// The agent wrote a tool call out as text and stopped, waiting for an answer
// that was never coming:
//
//     [list_dir: D:\1code]
//     Останавливаюсь здесь и жду реальных ответов инструментов.
//
// Two things wrong, and the turn ended on both. `list_dir` is not a tool this app
// has — the name is `list_files`. And a bracketed line is not a call, it is
// prose. The loop saw no tool calls, took the model for finished, and closed the
// turn on a promise to read files that were never read.
//
// A detector that fires too eagerly is worse than none: it would send the model
// back around on ordinary prose that merely contains brackets, burning tokens and
// never answering. So the false-positive cases matter as much as the true ones.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const start = src.indexOf('function looksLikeFakeToolCall(text) {')
const end = src.indexOf('\nasync function runAgentSlot')
if (start < 0 || end < 0) throw new Error('looksLikeFakeToolCall не найдена')

// eslint-disable-next-line no-new-func
const looksLikeFakeToolCall = new Function(
  src.slice(start, end) + '\nreturn looksLikeFakeToolCall'
)()

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- what must be caught ----------------------------------------------------

const caught = [
  ['вызов в квадратных скобках', '[list_dir: D:\\1code]'],
  ['настоящее имя, но текстом', '[list_files: .]'],
  ['чтение файла текстом', '[read_file: src/main/main.js]'],
  ['несколько подряд', 'Начинаю:\n\n[list_dir: D:\\1code]\n[list_dir: D:\\proj]\n'],
  ['ожидание ответов по-русски', 'Останавливаюсь здесь и жду реальных ответов инструментов.'],
  ['ожидание без слова «реальных»', 'Жду ответов инструментов, дальше продолжу.'],
  ['ожидание по-английски', 'Waiting for the tool results before continuing.'],
  ['ожидание с уточнением', 'I am waiting for tool call results now.']
]
for (const [name, text] of caught) {
  check(`ловится: ${name}`, looksLikeFakeToolCall(text) === true, JSON.stringify(text.slice(0, 50)))
}

// --- what must NOT be caught ------------------------------------------------
// A real answer that happens to contain brackets must go through untouched.

const passed = [
  ['обычный ответ', 'Прочитал файл, вот что нашёл: три ошибки в разборе аргументов.'],
  ['сноски и списки', 'Смотри пункты [1] и [2] выше, там подробнее.'],
  ['индекс массива', 'Значение лежит в arr[i: 0], проверь его.'],
  ['ссылка в markdown', 'Подробности в [документации](https://example.com/docs).'],
  ['json в ответе', 'Вернулось { "path": "src", "type": "directory" } — папка на месте.'],
  ['пустой ответ', ''],
  ['только пробелы', '   \n  '],
  ['отчёт о сделанном', 'Вызвал list_files и прочитал main.js: 5343 строки.'],
  ['разговор про ожидание вообще', 'Пользователь ждёт ответа, отвечаю сразу.']
]
for (const [name, text] of passed) {
  check(`не ловится: ${name}`, looksLikeFakeToolCall(text) === false, JSON.stringify(text.slice(0, 50)))
}

// --- how the loop reacts ----------------------------------------------------

check('описанный вызов не заканчивает ход',
  /looksLikeFakeToolCall\(stepResult\.content\)[\s\S]{0,1200}continue/.test(src))
check('модели говорят, что вызова не было',
  /Ты описал вызов инструмента текстом, но не вызвал его/.test(src))
check('называются настоящие имена инструментов',
  /list_files \(посмотреть папку[\s\S]{0,120}read_file/.test(src))
check('прямо сказано, что list_dir не существует',
  /Инструмента ` \+\s*'list_dir не существует/.test(src) || /list_dir не существует/.test(src))
check('число попыток ограничено', /fakeCallNudges < 2/.test(src))
check('счётчик заводится на прогон', /let fakeCallNudges = 0/.test(src))
check('без инструментов не подсказываем',
  /toolsEnabled && fakeCallNudges < 2 && looksLikeFakeToolCall/.test(src))
check('в окне видно, что произошло',
  /Вызов был описан текстом — прошу вызвать по-настоящему/.test(src))

// The model's own words have to stay in the conversation, or the nudge answers
// a message the model never sees itself having sent.
check('текст модели остаётся в переписке',
  /fakeCallNudges\+\+[\s\S]{0,160}role: 'assistant', content: stepResult\.content/.test(src))

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
