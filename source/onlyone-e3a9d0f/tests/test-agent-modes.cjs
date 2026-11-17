// Agent mode, and one agent alone. Nothing else.
//
// There used to be five shapes — /lead, /pipeline, /parallel, /consensus and
// /agent — and each fixed the arrangement before the task had been read: a
// reviewer, two columns, a jury. The person asking had to know the shape of
// their own problem before they could ask for help with it. All five also shared
// one flaw: how many agents ran came from how many API keys existed, so a job
// for one was handed to four, and they either duplicated the work or reported
// there was nothing left to do.
//
// Now the roster only says how many agents there could be and what they are
// called. What each is told is written later, once the task has been read.
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')

const cut = (from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error('не найдено: ' + from)
  return src.slice(a, b)
}

const buildTeamRoster = new Function(
  cut('function buildTeamRoster(keyCount) {', '\nfunction ') + '\nreturn buildTeamRoster'
)()

// Брифы ролей команды — данными в ./mode-prompts/team.js (план, 6.2). Приёмка
// команды остаётся в главном процессе: она собирается из фактических отчётов и
// доски, то есть из данных хода, а не из текста роли.
const team = require('../src/main/mode-prompts/team')
const mainFns = new Function(
  cut('function reviewBrief(results', 'async function runAgentMode') +
  '\nreturn { reviewBrief }'
)()
const briefs = { leadBrief: team.leadBrief, helperBrief: team.helperBrief, reviewBrief: mainFns.reviewBrief }

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// --- the roster: names and count only ---------------------------------------

const solo = buildTeamRoster(1)
check('один ключ — один агент', solo.length === 1, 'слотов ' + solo.length)
check('одиночка не назван ведущим', !/ведущ/i.test(solo[0].name + solo[0].badge), solo[0].name)

for (const keys of [2, 3, 4]) {
  const roster = buildTeamRoster(keys)
  check(`${keys} ключа — ${keys} агента`, roster.length === keys, 'слотов ' + roster.length)
  check(`${keys}: первый берёт задачу`, roster[0].role === 'lead', roster[0].role)
  check(`${keys}: остальные — исполнители`,
    roster.slice(1).every(s => s.role === 'general'), roster.map(s => s.role).join(','))
  check(`${keys}: у каждого свой id`, new Set(roster.map(s => s.id)).size === keys)

  // The first one is not announced as anyone's boss: most tasks are its own job
  // and the title would promise a committee that never convenes.
  check(`${keys}: старшинство не объявлено заранее`,
    !roster.some(s => /ведущ|главн|начальник/i.test(s.name + s.badge)),
    roster.map(s => s.name + '/' + s.badge).join(' | '))

  // Prompts are written by agent mode, from the task. A prompt here would be a
  // dead copy of them, and the next person would edit the dead one.
  check(`${keys}: состав не несёт подсказок`,
    roster.every(s => !s.prompt), 'нашлась подсказка')
}

// The ceiling was four because nobody decided how many agents a task needed and
// all of them ran regardless, so a wider team only meant more duplicated work.
// Now the lead hands out the parts and whoever it does not name never runs, so
// the ceiling is a ceiling rather than a quota.
check('до восьми ключей — до восьми агентов', buildTeamRoster(8).length === 8,
  'слотов ' + buildTeamRoster(8).length)
check('выше восьми не растёт', buildTeamRoster(20).length === 8,
  'слотов ' + buildTeamRoster(20).length)
check('ведущий по-прежнему один при широком составе',
  buildTeamRoster(8).filter(s => s.role === 'lead').length === 1)
check('имена не повторяются при широком составе',
  new Set(buildTeamRoster(8).map(s => s.id)).size === 8)

// --- what agents are actually told ------------------------------------------

const lead = briefs.leadBrief(3, '')
check('агенту сказано, что он Агент 1', /Ты Агент 1/.test(lead), lead.slice(0, 80))
check('команда и совместная работа', /команду из 4 участников/.test(lead) && /совместными усилиями/.test(lead))
check('не делать всё в одиночку', /Не пытайся делать всю работу в одиночку/.test(lead))
check('названо доступное число участников', /участников: 3/.test(lead), lead.slice(0, 400))
check('распределение через assign_work', /assign_work/.test(lead))
check('куски не должны пересекаться', /Куски не должны пересекаться/.test(lead))

const second = briefs.leadBrief(2, '\n\nЭто второй круг')
check('второй круг отмечается', /второй круг/.test(second))

const helper = briefs.helperBrief(3, 'прочитать src/renderer/app.js и описать ленту')
check('исполнителю названа его часть',
  /прочитать src\/renderer\/app\.js/.test(helper), helper.slice(0, 200))
check('исполнитель знает свой номер', /Агент 3/.test(helper))
check('исполнителю запрещено брать задачу целиком',
  /Не бери на себя задачу целиком/.test(helper))
check('исполнителю велено читать файлы самому',
  /не проси прислать их содержимое/.test(helper))
check('остановиться можно только по своей части',
  /Если твоя часть уже сделана/.test(helper))
check('про задачу целиком рассуждать нельзя',
  /Про задачу целиком не рассуждай/.test(helper))

const review = briefs.reviewBrief([
  { name: 'Агент 2', task: 'тесты', body: 'написал тест' }
])
check('в приёмку попадает и поручение, и сделанное',
  /Поручено: тесты/.test(review) && /написал тест/.test(review), review.slice(0, 200))
check('велено проверять инструментами, а не на слово',
  /не верь на слово/.test(review))
check('итог пишется своими словами, а не отчётами',
  /собери из их работы один связный ответ/.test(review))
check('можно отправить на доработку', /assign_work/.test(review))

// --- the dispatcher ---------------------------------------------------------

// One mode. Solo was the other half of a choice the person had to make before
// they had asked their question — and the agent already answers alone whenever
// the task does not divide, which is most of the time. So the choice went, not
// the behaviour.
check('режим один, без развилки',
  !/agentMode\s*=|payload\.agentMode|'single'/.test(src),
  'в главном процессе осталась развилка по режиму')
check('ход всегда идёт через агента',
  /return await runAgentMode\(event, payload, signal\)/.test(src))
check('старые названия режимов не роняют запрос',
  /Old chats carry the names of the shapes that used to exist/.test(src))
check('состав собирается без параметра режима',
  /function resolveAgentSlots\(payload\)/.test(src))

// The shapes that were removed must be gone from the code, not merely unused.
// The LEAD_* prompts and the action log outlived the mode that read them: they
// sat there for weeks, collected by an audit that could not tell a dead
// function from a live local variable of the same name.
for (const gone of ['runLeadMode', 'buildConsensusRoster', 'messagesWithHandoff',
  'LEAD_PLAN_PROMPT', 'LEAD_EXEC_PROMPT', 'LEAD_REVIEW_PROMPT',
  'LEAD_MAX_REVIEW_ROUNDS', 'LEAD_REVIEW_BUDGET_BYTES',
  'agentActionLog', 'recordAgentAction']) {
  check(`удалено: ${gone}`, !src.includes(gone), 'ещё упоминается')
}

// --- what the assembled answer is made of ------------------------------------

// The helpers agent mode synthesises when there is only one key are two
// different free models, and that is all they are. Naming them «Разработчик»
// and «Ревьюер» handed out jobs before the task had been read — the one thing
// this mode exists not to do — and the badges said it again in the interface.
// Comments stripped first: the comment that explains why the titles went has to
// be allowed to name them.
const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
for (const word of ['Разработчик', 'Кодер', 'Агент 3 (', 'Агент 2 (']) {
  check(`в составе нет ролевых слов: ${word}`, !code.includes(word), 'ещё упоминается')
}
check('в имени помощника только номер',
  /name: 'Агент 2'/.test(src) && /name: 'Агент 3'/.test(src))

// The lead is still told to split the work when the user asked for a team — it
// just is not told who does which half.
const collab = src.slice(src.indexOf('const collabNote'), src.indexOf('const roundNote'))
check('разделить работу по-прежнему велено', /Вызови assign_work и раздели работу/.test(collab))
check('но кто что делает — не назначено заранее',
  !/поручи написание|аудит и проверку/.test(collab), collab.slice(0, 200))

// A second round used to overwrite the first: round 1 produced [A, B], round 2
// ran only C, and A and B disappeared from the answer the user read.
check('вклад кругов накапливается, а не затирается',
  !/^\s*done = round_done\s*$/m.test(src) &&
  /done = \[\s*\n\s*\.\.\.done\.filter/.test(src))

// The system prompt tells the model three times not to use emoji. The app then
// put two of its own in the heading of every team answer.
const PICTOGRAPHS = /[\u{1F300}-\u{1FAFF}]/u
check('приложение не дописывает эмодзи в ответ', !PICTOGRAPHS.test(src),
  (src.match(new RegExp(PICTOGRAPHS, 'gu')) || []).join(' '))

// The conclusion is the lead's and comes first; the contributions stay below it
// so the user can still see what each model actually did.
const assembled = src.slice(src.indexOf('const content = leadResult?.content?.trim()'))
check('итог не подменяется отчётами помощников',
  assembled.length > 200 &&
  !assembled.includes('Все этапы проекта завершены.') && /contributions: done/.test(assembled))

// Ход без итога возвращался с признаком успеха: окно рисовало его обычным
// ответом, а отличить от настоящего можно было только прочитав текст.
check('отсутствие итога называется провалом',
  /if \(!content\) \{[\s\S]{0,900}ok: false/.test(assembled))
check('сделанное помощниками не пропадает вместе с итогом',
  /salvage/.test(assembled) && /непроверенный материал/.test(assembled))

// Режим — устройство приложения, а не тема разговора. На просьбу «поработай в
// агент-режиме над X» модель отвечала подтверждением, что режим понят и включён,
// вместо того чтобы сделать X.
const contract = require('../src/main/agent-quality').qualityContract()
check('режим не объявляется вслух',
  /не обсуждается и не объявляется/.test(contract) &&
  /включаю агент-режим/.test(contract))
check('просьба про режим читается как просьба сделать работу',
  /это просьба сделать X/.test(contract))
check('в ответе не нужны служебные слова про режим',
  /сами слова .режим./.test(contract))

// Слеш-команды для агент-режима нет: просьба привлечь агентов читается из обычного
// текста. Проверяется и обратное: обычная работа не должна тянуть за собой
// помощников просто потому, что в просьбе встретилось слово «агент».
{
  const a = src.indexOf('function isCollaborativeRequest')
  const b = src.indexOf(String.fromCharCode(10) + '}', a) + 2
  const wants = new Function('lastUserMessage', src.slice(a, b) + '; return isCollaborativeRequest')(p => p.msg)
  for (const phrase of ['поработай в агент-режиме над сайтом', 'запусти агентов и сделай сайт',
    'погоняй агентов для разбора', 'напряги агентов', 'несколько агентов на задачу'])
    check('просьба про агентов понята: ' + phrase.slice(0, 28), wants({ msg: phrase }) === true)
  for (const phrase of ['сделай мне сайт', 'агент, прочитай файл', 'почини разбор аргументов'])
    check('обычная просьба не зовёт команду: ' + phrase.slice(0, 28), wants({ msg: phrase }) === false)
}

console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
