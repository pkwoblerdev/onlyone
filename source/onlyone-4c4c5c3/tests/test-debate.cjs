// «Чтобы агенты могли спорить, обсуждать и делать вместе.»
//
// До этого помощники не видели работу друг друга вообще: каждый писал ведущему,
// ведущий читал всех. Звезда, а не разговор. Ошибка одного доезжала до итога,
// если ведущий не поймал её сам, а поймать чужую ошибку в чужом отчёте, не
// открывая файлов, почти невозможно.
//
// Здесь проверяется круг возражений: каждый читает чужую работу и обязан либо
// назвать изъян, либо сказать, что изъяна нет. Согласие по умолчанию не
// принимается.
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const cut = (from, to) => {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return main.slice(a, b)
}

// --- сам текст поручения на критику -----------------------------------------
// critiqueBrief — текст роли, он данными в ./mode-prompts/team.js (план, 6.2).
// reviewBrief опирается на reviewBriefBody и на доску хода, поэтому остаётся в
// главном процессе и вырезается вместе с ней.
const team = require('../src/main/mode-prompts/team')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr
const briefs = new Function(
  cut('function reviewBrief(', 'async function runAgentMode(') +
  '\nreturn { reviewBrief }')()
briefs.critiqueBrief = team.critiqueBrief

const others = [
  { name: 'Агент 3', task: 'Роутер', body: 'Переписал выбор ключа, тесты не запускал.' },
  { name: 'Агент 4', task: 'Кэш', body: 'Добавил кэш ответов без ограничения размера.' }
]
const brief = briefs.critiqueBrief('Агент 2', others)

check('в поручении названа чужая работа целиком',
  brief.includes('Агент 3') && brief.includes('Агент 4') &&
  brief.includes('Переписал выбор ключа') && brief.includes('без ограничения размера'))
check('своё имя названо', brief.includes('Ты Агент 2'))
check('требуется конкретика возражения',
  /Чьё, к какому именно месту, что произойдёт и как это проверить/.test(brief))
check('одно сильное возражение предпочтительнее списка мелочей',
  /сильнейшее возражение лучше/.test(brief))
check('«возражений нет» разрешено, но с отчётом о проверке',
  /ВОЗРАЖЕНИЙ НЕТ/.test(brief) && /что именно проверил/.test(brief))
// Вежливое согласие — главный способ, которым круг критики превращается в
// формальность. Он назван прямо и назван худшим ответом.
check('согласие не читая объявлено худшим ответом',
  /Согласиться, не читая, — худший из возможных ответов/.test(brief))
check('пересказ и похвала запрещены',
  /Не пересказывай чужую работу и не хвали её/.test(brief))

// --- возражения доходят до ведущего -----------------------------------------
const results = [{ name: 'Агент 2', task: 'Ключи', acceptance: 'работает', body: 'сделано', failed: false }]
const quiet = briefs.reviewBrief(results, [])
const loud = briefs.reviewBrief(results, [{ name: 'Агент 3', body: 'Кэш растёт без предела — на длинной сессии это утечка.' }])

check('без возражений раздел не появляется', !/Круг возражений/.test(quiet))
check('возражение доходит до ведущего дословно',
  loud.includes('Кэш растёт без предела') && /Агент 3 возражает/.test(loud))
check('ведущему запрещено молча проигнорировать',
  /Молча проигнорировать нельзя/.test(loud))
check('возражение объявлено данными, а не приговором',
  /данные, а не приговор/.test(loud))
check('пустое возражение не попадает в отчёт',
  !/Круг возражений/.test(briefs.reviewBrief(results, [{ name: 'Агент 3', body: '   ' }])))

// --- подключение к ходу ------------------------------------------------------
const mode = cut('async function runAgentMode(', 'function looksLikeFakeToolCall(')

// Спорить есть о чём, только когда сдали хотя бы два разных агента: этапы
// одного агента друг друга не проверяют.
check('круг идёт только когда есть о чём спорить',
  /partsBySlot\.size > 1/.test(mode), 'круг запускается на одной сданной работе')
check('в Fast круга нет',
  /partsBySlot\.size > 1 && payload\.speedMode !== 'fast'/.test(mode))
check('возражения пишутся одновременно, а не по очереди',
  /const verdicts = await Promise\.all\(\[\.\.\.partsBySlot\.entries\(\)\]\.map/.test(mode))
check('у проверяющего есть срок, и опоздание не выдаётся за одобрение',
  /const CRITIQUE_DEADLINE_MS = \d+/.test(main) &&
  /setTimeout\(stop, CRITIQUE_DEADLINE_MS\)/.test(mode) &&
  /if \(late\) \{\s*unchecked\.push/.test(mode))
check('срок проверяющего не отменяет весь ход',
  /const late = \(\) => own\.signal\.aborted && !signal\?\.aborted/.test(mode) && /\}, own\.signal\)/.test(mode))
check('агент не разбирает собственные части',
  /const others = speakers\.filter\(other => !mine\.includes\(other\)\)/.test(mode))
check('провалившаяся работа в круг не идёт',
  /round_done\.filter\(entry => !entry\.failed/.test(mode))
// Возражать можно, переписывать чужую часть — нет: иначе критика превращается в
// второй заход на ту же работу, и авторство теряется.
check('критикующий получает доступ только на чтение',
  /readOnlyAssignment: true/.test(mode))
check('«возражений нет» не засоряет отчёт ведущего',
  /\^\\W\*возражений нет/.test(mode))
check('круг прерывается отменой',
  /if \(signal\?\.aborted\) return \{ slot, skipped: true \}/.test(mode) &&
  /objections\.push\(\{ name: slot\.name, body \}\)\s*\}\s*\}\s*if \(signal\?\.aborted\) return \{ ok: true, aborted: true \}/.test(mode))
check('упавший участник не роняет круг',
  /возражение не получено/.test(mode))
// 29.09 (2.6б): строка ленты собирается шаблоном `tr('Круг возражений: %s …',
// speakers.length)`. Смысл проверки не изменился — человек видит, что круг идёт,
// и число в этой строке настоящее, а не написанное руками.
check('пользователь видит, что идёт спор',
  /Круг возражений: %s[\s\S]{0,90}speakers\.length/.test(mode) &&
  /Возражений: %s[\s\S]{0,90}objections\.length/.test(mode))
check('возражения доходят до обеих приёмок ведущего',
  (mode.match(/reviewBrief\(done, objections, unchecked\)/g) || []).length === 2,
  String((mode.match(/reviewBrief\(done, objections, unchecked\)/g) || []).length))

// Упавший участник оставлял после себя строку в окне и ничего больше: до ведущего
// это не доходило, и молчание он читал как «возражений нет». Непроверенная работа
// и проверенная выглядели для него одинаково — именно этой разницей круг и ценен.
check('сбой проверяющего доходит до ведущего',
  /unchecked\.push\(\{ name: slot\.name, reason \}\)/.test(mode))
check('пустой ответ не считается одобрением',
  /if \(!body\) \{[\s\S]{0,200}unchecked\.push/.test(mode))
check('ведущему сказано, что это не «возражений нет»',
  /Это не «возражений нет»/.test(main))
check('список непроверенного сбрасывается на каждом круге',
  /unchecked = \[\]/.test(mode))
check('накопитель сбрасывается на каждом круге',
  /objections = \[\]/.test(mode))

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
