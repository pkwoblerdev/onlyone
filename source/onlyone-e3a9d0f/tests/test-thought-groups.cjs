// U-3 и U-4: «Изменения в файлах» один раз в конце хода, и ход мысли мыслями.
//
// Слово владельца 01.10: «огромный блок “Изменения в файлах” — посередине
// хода. Он должен появляться только в конце ответа» (U-3) и «ход мысли — кашей
// из строк: всё это должно собираться в одну “мысль”» (U-4).
//
// Проверяются ЧИСТЫЕ функции окна, взятые из настоящего исходника, а не
// пересказанные: `thoughtRuns` решает, какие шаги в какую мысль собраны,
// `thoughtSummary` строит строку итога, `fileChangesBlockHtml` рисует
// единственный блок в конце хода. DOM и раскладку меряет отдельный оконный
// прогон; здесь — правила, которые иначе расходятся при перерисовке.
//
// РАЗЛИЧИЕ, КОТОРОЕ ТОЛЬКО ЗДЕСЬ ВИДНО. Перерисовка ответа (открытая
// переписка) и живая лента идут разными путями, и раньше группировка шагов
// была только в первом. Владелец видел кашу именно в живом ходу. Поэтому
// `thoughtRuns` обязана работать и там, и там, и тест требует этого от обеих
// точек входа явно.
const assert = require('node:assert/strict')
const path = require('node:path')
const src = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  assert(a >= 0 && b > a, 'не найдено в исходниках окна: ' + from)
  return src.slice(a, b)
}

// Модуль блоков отдаёт наружу только `create`, поэтому чистые функции достаются
// вырезкой из его исходника и собираются в песочнице. Так же сделан
// `test-thinking-split.cjs`: функция берётся из настоящего кода окна, а не
// переписывается в тесте.
//
// `t` здесь — НАСТОЯЩИЙ по форме: он подставляет «%s» и «{0}» по порядку, как
// `app.js:197`. Заглушка «верни первый аргумент» проглатывала бы подстановку и
// делала бы проверку заголовка враньём: тест прошёл бы на строке, которой на
// экране никогда не бывает.
const t = (text, ...args) => {
  if (!text) return text
  if (!args.length) return String(text)
  let next = 0
  return String(text)
    .replace(/%s/g, () => String(args[next++]))
    .replace(/\{(\d+)\}/g, (whole, index) => (args[Number(index)] === undefined ? whole : String(args[Number(index)])))
}
const escapeHtml = value => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
// Русская форма множественного числа — как в `work-panel.js:302`: возвращается
// «N + слово», а не одно слово. Заглушка, возвращавшая только слово, делала бы
// красной строку итога и заголовок блока там, где на экране «прочитал 4 файла».
const countWord = (count, one, few, many) => {
  const n = Number(count) || 0
  const tail = n % 10 === 1 && n % 100 !== 11 ? one
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many
  return `${n} ${tail}`
}

const blockSrc = cut('  const STEP_RUN_COLLAPSE = 3', '  function blocksHtmlInto(host, blocks)') + '\n' +
  cut('  // Последний слот-ход раскладки', '  // Blocks are the only thing drawn.')
let lang = 'ru'
const module_ = new Function('escapeHtml', 't', 'countWord', 'getUiLang',
  blockSrc + '; return { thoughtRuns, thoughtSummary, thoughtClass, fileChangesBlockHtml, thoughtLiveTitle, formatElapsed, thoughtStats, thoughtLayout }')
  (escapeHtml, t, countWord, () => lang)

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (ok) console.log('ok', name)
  else { failed++; console.error('ПРОВАЛ', name + (detail ? ': ' + detail : '')) }
}

const step = (verb, extra = {}) => ({ kind: 'tool', text: '', parts: { verb, ...extra.parts }, agent: extra.agent || '', items: extra.items })
const thought = (text = 'размышляю', agent = '') => ({ kind: 'thinking', text, agent })
const speech = (text = 'Сделал вот это.') => ({ kind: 'text', text, agent: '' })

// ─── U-4: какие шаги в какую мысль ───────────────────────────────────────────
check('ход из одной серии шагов — одна мысль',
  module_.thoughtRuns([step('Читаю'), step('Ищу в файлах'), step('Пишу')]).length === 1,
  JSON.stringify(module_.thoughtRuns([step('Читаю'), step('Ищу в файлах'), step('Пишу')])))

// 04.10.2026 (слово владельца, В3-1): ход идёт блоками — шаги, промежуточный результат (слова
// ассистента), снова шаги. Слово между шагами ЗАМЫКАЕТ блок, следующие шаги — новый блок.
check('слово ассистента между шагами замыкает блок: дальше новый',
  (() => {
    const runs = module_.thoughtRuns([step('Читаю'), speech('Теперь проверю.'), step('Пишу')])
    return runs.length === 2 && runs[0].to === 0 && runs[1].from === 2
  })(), JSON.stringify(module_.thoughtRuns([step('Читаю'), speech('Теперь проверю.'), step('Пишу')])))
check('слово после последнего шага — ответ, он вне хода',
  (() => {
    const runs = module_.thoughtRuns([step('Читаю'), step('Пишу'), speech('Готово.')])
    return runs.length === 1 && runs[0].to === 1
  })(), JSON.stringify(module_.thoughtRuns([step('Читаю'), step('Пишу'), speech('Готово.')])))
check('слово до первого шага — вне хода',
  (() => {
    const runs = module_.thoughtRuns([speech('Начну.'), step('Читаю'), step('Пишу')])
    return runs.length === 1 && runs[0].from === 1
  })())
check('несколько слов подряд между шагами — тоже граница, блоков два',
  (() => {
    const runs = module_.thoughtRuns([step('Читаю'), speech('Раз.'), speech('Два.'), step('Пишу')])
    return runs.length === 2 && runs[1].from === 3
  })())
check('чек-лист или отчёт между шагами по-прежнему граница',
  module_.thoughtRuns([step('Читаю'), { kind: 'plan', text: '[]', agent: '' }, step('Пишу')]).length === 2)
check('слово другого агента между шагами не втягивается в чужой ход',
  module_.thoughtRuns([step('Читаю', { agent: 'А' }), speech('Слово ведущего.'), step('Пишу', { agent: 'Б' })]).length === 2)

check('смена агента в команде начинает новую мысль',
  module_.thoughtRuns([step('Читаю', { agent: 'А' }), step('Пишу', { agent: 'Б' })]).length === 2,
  'мыслей: ' + module_.thoughtRuns([step('Читаю', { agent: 'А' }), step('Пишу', { agent: 'Б' })]).length)

check('размышление и вызов в одной серии — одна мысль',
  module_.thoughtRuns([thought(), step('Читаю')]).length === 1,
  'мыслей: ' + module_.thoughtRuns([thought(), step('Читаю')]).length)

check('текст ответа не попадает ни в одну мысль',
  module_.thoughtRuns([speech(), speech()]).length === 0)

const run12 = Array.from({ length: 12 }, (_, i) => step(['Читаю', 'Ищу в файлах', 'Пишу'][i % 3]))
check('ход из 12 вызовов трёх классов — одна мысль, а не 12 строк',
  module_.thoughtRuns(run12).length === 1 &&
  module_.thoughtRuns(run12)[0].to - module_.thoughtRuns(run12)[0].from + 1 === 12,
  JSON.stringify(module_.thoughtRuns(run12)))

check('ход помнит свой отрезок в общем списке блоков',
  (() => {
    const runs = module_.thoughtRuns([step('Читаю'), step('Пишу'), { kind: 'plan', text: '[]', agent: '' }, step('Пишу')])
    return runs.length === 2 && runs[0].from === 0 && runs[0].to === 1 && runs[1].from === 3
  })(), 'разбивка: ' + JSON.stringify(module_.thoughtRuns([step('Читаю'), step('Пишу'), { kind: 'plan', text: '[]', agent: '' }, step('Пишу')])))

// ─── 04.10: итог хода одной фразой, как в Claude ─────────────────────────────
// «Выполнено 25 команд (1 с ошибкой), создано 5 файлов, изменён файл и ещё 2 действия»
const tool = (name, over = {}) => ({ kind: 'tool', text: '', agent: '', parts: { verb: 'x', tool: name, tone: 'read', ...over.parts }, items: over.items })
const many = (n, name, over) => Array.from({ length: n }, () => tool(name, over))
const bigRun = [
  ...many(24, 'run_command'),
  tool('run_command', { parts: { tone: 'err' } }),
  ...many(5, 'write_file', { parts: { action: 'created' } }),
  tool('write_file', { parts: { action: 'updated' } }),
  ...many(2, 'task_plan')
]
const sentence = module_.thoughtSummary(bigRun)
check('итог — фраза как в образце: команды с ошибкой, созданные, изменённые, «ещё N действия»',
  sentence === 'Выполнено 25 команд (1 с ошибкой), создано 5 файлов, изменён файл и ещё 2 действия', sentence)

const grouped = {
  kind: 'tool', text: '', agent: '', parts: { verb: 'Записал', tool: 'write_file', tone: 'ok', action: 'created' },
  items: [{ action: 'created' }, { action: 'created' }, { action: 'updated' }, { action: 'updated' }]
}
check('вызовы, слитые в одну строку со списком, считаются по каждому',
  module_.thoughtSummary([grouped, tool('run_command')]) === 'Выполнена команда, создано 2 файла и изменено 2 файла',
  module_.thoughtSummary([grouped, tool('run_command')]))

check('единственное число: одна команда, один файл',
  module_.thoughtSummary([tool('run_command'), tool('write_file', { parts: { action: 'created' } }), tool('read_file')]) === 'Выполнена команда, создан файл и прочитан файл',
  module_.thoughtSummary([tool('run_command'), tool('write_file', { parts: { action: 'created' } }), tool('read_file')]))

check('ошибки не команд тоже названы, а не спрятаны',
  /не выполнено: 1/.test(module_.thoughtSummary([tool('run_command'), tool('write_file', { parts: { tone: 'err', action: 'created' } })])),
  module_.thoughtSummary([tool('run_command'), tool('write_file', { parts: { tone: 'err', action: 'created' } })]))

check('две и пять ошибок склоняются: «2 с ошибками», «1 с ошибкой»',
  /(2 с ошибками)/.test(module_.thoughtSummary([...many(3, 'run_command'), ...many(2, 'run_command', { parts: { tone: 'err' } })])) &&
  /(1 с ошибкой)/.test(module_.thoughtSummary([...many(3, 'run_command'), tool('run_command', { parts: { tone: 'err' } })])))

check('только прочие действия — «Выполнено N действий», без «и ещё»',
  module_.thoughtSummary(many(5, 'task_plan')) === 'Выполнено 5 действий', module_.thoughtSummary(many(5, 'task_plan')))

check('слова ассистента и размышления в итог не входят и не считаются действиями',
  module_.thoughtSummary([tool('run_command'), speech('Теперь проверю.'), thought('мысль'), tool('run_command')]) === 'Выполнено 2 команды',
  module_.thoughtSummary([tool('run_command'), speech('Теперь проверю.'), thought('мысль'), tool('run_command')]))

check('ход из одних размышлений называется ходом мысли, а не пустотой',
  module_.thoughtSummary([thought('раз'), thought('два')]) === 'Ход мысли', module_.thoughtSummary([thought('раз'), thought('два')]))

check('пустой ход не даёт итог из выдуманного',
  module_.thoughtSummary([]) === '', JSON.stringify(module_.thoughtSummary([])))

lang = 'en'
const english = module_.thoughtSummary(bigRun)
check('по-английски тот же итог — как в образце',
  english === 'Ran 25 commands (1 failed), created 5 files, edited a file, and 2 more actions', english)
check('по-английски единственное число и «а file»',
  module_.thoughtSummary([tool('run_command'), tool('write_file', { parts: { action: 'created' } })]) === 'Ran a command and created a file',
  module_.thoughtSummary([tool('run_command'), tool('write_file', { parts: { action: 'created' } })]))
lang = 'ru'

// ─── заголовок живого хода и время ───────────────────────────────────────────
check('живой заголовок — что делается сейчас (глагол вызова, который ещё идёт)',
  module_.thoughtLiveTitle([tool('write_file'), tool('run_command', { parts: { tone: 'pending', verb: 'Выполняю команду' } })]) === 'Выполняю команду',
  module_.thoughtLiveTitle([tool('write_file'), tool('run_command', { parts: { tone: 'pending', verb: 'Выполняю команду' } })]))
check('между вызовами живой заголовок — «Думаю», а не прошлое действие',
  module_.thoughtLiveTitle([tool('run_command'), tool('write_file')]) === 'Думаю', module_.thoughtLiveTitle([tool('run_command'), tool('write_file')]))
check('после мысли — тоже «Думаю»', module_.thoughtLiveTitle([thought('идея')]) === 'Думаю')
check('время хода: секунды, минуты, часы',
  module_.formatElapsed(57000) === '57с' && module_.formatElapsed(597000) === '9м 57с' && module_.formatElapsed(3725000) === '1ч 2м' && module_.formatElapsed(0) === '0с',
  [57000, 597000, 3725000, 0].map(n => module_.formatElapsed(n)).join(' | '))
lang = 'en'
check('время хода по-английски', module_.formatElapsed(597000) === '9m 57s', module_.formatElapsed(597000))
lang = 'ru'

// Браузер и слежение называются в итоге хода своими словами (слово владельца 05.10).
check('открыл страницу и запустил слежение — так и сказано, а не «выполнено 2 действия»',
  module_.thoughtSummary([tool('browse_page'), tool('watch_page')]) === 'Открыта страница и запущено слежение за страницей',
  module_.thoughtSummary([tool('browse_page'), tool('watch_page')]))
check('несколько страниц, действия на странице и снимок',
  module_.thoughtSummary([tool('browse_page'), tool('browse_page'), tool('browse_click'), tool('browse_input'), tool('browse_screenshot')]) === 'Открыто 2 страницы, выполнено 2 действия на странице и снят кадр страницы',
  module_.thoughtSummary([tool('browse_page'), tool('browse_page'), tool('browse_click'), tool('browse_input'), tool('browse_screenshot')]))
check('слежение снято, страница прочитана по адресу',
  module_.thoughtSummary([tool('fetch_url'), tool('stop_watching')]) === 'Прочитана страница и снято слежение',
  module_.thoughtSummary([tool('fetch_url'), tool('stop_watching')]))

check('статистика хода считает команды, файлы и «прочее» раздельно',
  (() => { const st = module_.thoughtStats(bigRun); return st.command === 25 && st.created === 5 && st.edited === 1 && st.other === 2 && st.failedCommand === 1 })(),
  JSON.stringify(module_.thoughtStats(bigRun)))

// ─── раскладка: один блок на все шаги, слова из середины — под ним ─────────────
{
  const layout = module_.thoughtLayout([tool('a'), tool('b'), speech('Промежуточное слово.'), tool('c')])
  check('шаги, слово, шаги — блок, слово, блок по порядку',
    layout.slots.map(s => s.kind).join() === 'run,one,run' && layout.slots[0].indices.join() === '0,1' && layout.slots[2].indices.join() === '3', JSON.stringify(layout.slots))
  check('слово из середины стоит МЕЖДУ блоками, а не внизу всего хода',
    layout.slots[1].from === 2 && layout.slotOf.join() === '0,0,1,2', JSON.stringify(layout))
  const lead = module_.thoughtLayout([speech('Начну.'), tool('a'), tool('b'), tool('c')])
  check('слово до первого шага остаётся выше блока', lead.slots[0].kind === 'one' && lead.slots[1].kind === 'run', JSON.stringify(lead.slots))
  const single = module_.thoughtLayout([tool('a'), speech('Конец.')])
  check('даже один вызов — блок: «Выполняю команду · 9м» виден с первого шага', single.slots[0].kind === 'run', JSON.stringify(single.slots))
  const onlyThinking = module_.thoughtLayout([thought('раз'), thought('два'), speech('Конец.')])
  check('одни размышления без вызовов от трёх, а два — обычные строки', onlyThinking.slots.every(slot => slot.kind === 'one'), JSON.stringify(onlyThinking.slots))
  const tail = module_.thoughtLayout([tool('a'), tool('b'), tool('c'), speech('Ответ.')])
  check('ответ после последнего шага — после блока', tail.slots[1].kind === 'one' && tail.slots[1].from === 3, JSON.stringify(tail.slots))
}

// ─── класс действия ──────────────────────────────────────────────────────────
check('глаголы делятся по смыслу, а не по букве',
  module_.thoughtClass('Читаю') === module_.thoughtClass('Читаю компонент') &&
  module_.thoughtClass('Читаю') !== module_.thoughtClass('Пишу'),
  [module_.thoughtClass('Читаю'), module_.thoughtClass('Читаю компонент'), module_.thoughtClass('Пишу')].join('|'))
check('незнакомый глагол не проваливает разбор',
  typeof module_.thoughtClass('Что-то совсем новое') === 'string' && module_.thoughtClass('Что-то совсем новое').length > 0,
  module_.thoughtClass('Что-то совсем новое'))

// ─── U-3: блок изменений один и в конце хода ────────────────────────────────
const CHANGES = [
  { file: 'main.js', action: 'updated', added: 12, removed: 3 },
  { file: 'app.js', action: 'created', added: 40, removed: 0 }
]
const blockHtml = module_.fileChangesBlockHtml(CHANGES, { stopped: false })
const stoppedHtml = module_.fileChangesBlockHtml(CHANGES, { stopped: true })

check('блок изменений один, а не на каждый файл',
  (blockHtml.match(/class="agent-file-changes"/g) || []).length === 1, blockHtml.slice(0, 120))
check('блок свёрнут: раскрывает список, а не сразу показывает',
  /<details/.test(blockHtml) && !/\sopen\b/.test(blockHtml), blockHtml.slice(0, 120))
check('в шапке блока — счётчик файлов, а не пустое «изменения в файлах»',
  /Изменено 2 файла/.test(blockHtml), blockHtml.slice(0, 200))
check('внутри блока виден каждый файл со своим итогом',
  /main\.js/.test(blockHtml) && /app\.js/.test(blockHtml) && /\+12/.test(blockHtml) && /−3/.test(blockHtml))
check('остановленный ход помечен, и это не молчание',
  /ход остановлен/i.test(stoppedHtml), stoppedHtml.slice(0, 200))
check('без изменений блока нет вовсе — пустой блок это шум',
  module_.fileChangesBlockHtml([], { stopped: false }) === '',
  JSON.stringify(module_.fileChangesBlockHtml([], { stopped: false })))
check('имя файла с кавычками не ломает разметку',
  !/file-change-name[^>]*>[^<]*<script/i.test(module_.fileChangesBlockHtml(
    [{ file: '<script>x</script>', action: 'updated', added: 1, removed: 0 }], {})),
  'имя не экранировано')

// 11.10.2026 (stress-agent): итог серии считал неудавшийся вызов выполненным. Две отклонённые записи давали «Изменено 2 файла»,
// семь чтений с пятью отказами — «Прочитано 7 файлов и не выполнено: 5». Неудача называется один раз и в готовое не входит.
const failedStep = (tool, extra = {}) => step('Не выполнено', { parts: { tool, tone: 'err', ...extra } })
const okStep = (verb, tool, extra = {}) => step(verb, { parts: { tool, ...extra } })
check('отклонённые записи не называются изменёнными файлами',
  (() => { const r = module_.thoughtSummary([failedStep('write_file'), failedStep('write_file')]); return !/зменен|зменён/.test(r) && /не выполнено: 2/i.test(r) })(),
  module_.thoughtSummary([failedStep('write_file'), failedStep('write_file')]))
check('чтения: прочитано столько, сколько удалось, остальное — не выполнено',
  (() => {
    const run = [okStep('Прочитал', 'read_file'), okStep('Прочитал', 'read_file'), ...Array.from({ length: 5 }, () => failedStep('read_file'))]
    const r = module_.thoughtSummary(run)
    return /прочитано 2 файла/i.test(r) && /не выполнено: 5/i.test(r) && !/7 файлов/.test(r)
  })(),
  module_.thoughtSummary([okStep('Прочитал', 'read_file'), failedStep('read_file')]))
check('команды по-прежнему считаются все, с пометкой об ошибке',
  (() => { const r = module_.thoughtSummary([okStep('Запустил', 'run_command'), okStep('Запустил', 'run_command'), failedStep('run_command')]); return /выполнено 3 команды \(1 с ошибкой\)/i.test(r) && !/не выполнено/.test(r) })(),
  module_.thoughtSummary([okStep('Запустил', 'run_command'), failedStep('run_command')]))

if (failed) { console.error(`проверок: ${total}, провалов: ${failed}`); process.exitCode = 1 }
else console.log(`проверок: ${total}, провалов: 0`)
