// «Агент работает процентов на двадцать пять. Наляпали, сказали, что всё
// сделали. Хотели получить яблоко, получили апельсин.»
//
// Ход заканчивался ровно по одному признаку: модель перестала звать
// инструменты. Замолчать она может и после первого шага — и приложение
// принимало это за готовую работу.
//
// Единственная бывшая защита, saysUnfinished, читает слова самого агента и
// требует, чтобы он признался в недоделке вслух. То есть работает в том
// случае, который и без неё не страшен, и по построению пропускает тот, на
// который жалуется владелец: бодрый отчёт о сделанной четверти.
//
// Здесь проверяется то, что пришло на замену: чек-лист хода, сверка слов с
// делами и приёмка отдельным запросом. Первые две ничего не стоят и смотрят на
// факты, а не на формулировки; третья сверяет исходную просьбу с тем, что
// реально сделано, и не видит ни рассуждений агента, ни его уверенности.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
// Код окна теперь разложен по модулям (план, 2d) — проверяем весь исполняемый текст.
const ui = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8')

const {
  completionContract, normalizePlanItems, openPlanItems, completionGaps,
  unsupportedClaims, acceptanceMessages, readVerdict
} = require('../src/main/agent-completion')

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// ---------------------------------------------------------------------------
// 1. Чек-лист хода
// ---------------------------------------------------------------------------

const plan = normalizePlanItems([
  { id: 'apk', title: 'Собран установщик', status: 'done' },
  { id: 'icon', title: 'Иконка заменена на фирменную', status: 'todo' },
  { id: 'pub', title: 'Обновление выложено на сервер', status: 'doing' }
])
check('чек-лист принимает корректные пункты', plan.length === 3)
check('незакрытыми считаются и todo, и doing',
  openPlanItems(plan).map(i => i.id).join(',') === 'icon,pub',
  openPlanItems(plan).map(i => i.id).join(','))

// A blocked item is unfinished on purpose. An agent that marks something blocked
// and falls silent has not said what the blocker is, and that is the whole
// value of the state.
check('помеченный блоком пункт тоже незакрыт',
  openPlanItems(normalizePlanItems([{ id: 'x', title: 'Ключ подписи', status: 'blocked' }])).length === 1)
check('пункт без id или title отбрасывается',
  normalizePlanItems([{ id: '', title: 'нет id' }, { id: 'a', title: '' }]).length === 0)
check('повтор id не задваивает пункт',
  normalizePlanItems([{ id: 'a', title: 'раз' }, { id: 'a', title: 'два' }]).length === 1)
check('неизвестный статус приводится к todo',
  normalizePlanItems([{ id: 'a', title: 'x', status: 'почти' }])[0].status === 'todo')
check('мусор вместо списка не роняет разбор',
  normalizePlanItems(null).length === 0 && normalizePlanItems('строка').length === 0 &&
  openPlanItems(undefined).length === 0)

// ---------------------------------------------------------------------------
// 2. Слова против дел
// ---------------------------------------------------------------------------
// Инструментов запуска в приложении нет вообще. Единственный способ что-то
// запустить — написать себе инструмент через define_tool и позвать его как
// own_<имя>. Поэтому «прогнал тесты» без такого вызова — заведомо неправда.

const workLog = [
  { tool: 'list_files', detail: '.', ok: true },
  { tool: 'read_file', detail: 'src/main/main.js', ok: true },
  { tool: 'write_file', detail: 'src/main/app.js', ok: true }
]

check('отчёт о правке файла, которого не касались, пойман',
  unsupportedClaims('Исправил src/main/main.js — теперь отмена работает.', workLog).length === 1)
check('отчёт о реально записанном файле молчит',
  unsupportedClaims('Записал src/main/app.js, перечитал — на месте.', workLog).length === 0)
check('заявленный запуск тестов без единого запуска пойман',
  unsupportedClaims('Запустил тесты, все прошли.', workLog).length === 1)
check('запуск через свой инструмент претензий не вызывает',
  unsupportedClaims('Запустил тесты, все прошли.',
    [...workLog, { tool: 'own_run_tests', detail: '', ok: true }]).length === 0)

// The write that failed is not a write. Counting it as evidence would let the
// one case that matters most — an approval the user declined — pass as done.
check('неудавшаяся запись не считается доказательством',
  unsupportedClaims('Записал src/main/app.js.',
    [{ tool: 'write_file', detail: 'src/main/app.js', ok: false }]).length === 1)

// Honest answers must stay silent. Firing on these teaches the owner to ignore
// the mechanism, which costs more than the misses it catches.
check('признание «не записал» не считается враньём',
  unsupportedClaims('Не записал src/main/main.js — вы отклонили правку.', workLog).length === 0)
check('английское отрицание тоже понято',
  unsupportedClaims('I did not update src/main/main.js.', workLog).length === 0)
check('номер версии не принимается за имя файла',
  unsupportedClaims('Поднял версию до 0.86.0 и обновил src/main/app.js.', workLog).length === 0)
check('чтение и объяснение претензий не вызывают',
  unsupportedClaims('Прочитал src/main/main.js и разобрал, как устроен цикл.', workLog).length === 0)
check('проверка чтением не считается запуском',
  unsupportedClaims('Проверил, что тесты на это уже есть.', workLog).length === 0)
check('пустой ответ ничего не порождает',
  unsupportedClaims('', workLog).length === 0 && unsupportedClaims(null, []).length === 0)

// Ложное срабатывание дороже пропуска: оно гоняет модель по кругу на деньгах
// владельца и учит его не верить механизму вовсе. Каждый из этих ответов честен
// и обязан пройти молча.
for (const answer of [
  'В файле package.json описаны все цепочки тестов — их там две.',
  'Причина в src/main/main.js, но править я не стал — вы просили только разобраться.',
  'Нашёл три места: src/main/main.js, package.json и README.md. Что менять — решать вам.',
  'Правку в "src/main/main.js" отклонили, поэтому я её не делал.',
  'Вот как это выглядит:\n\n```js\nconst x = require("./config.json")\n```\n\nЯ ничего не менял.',
  'Записал src/main/app.js, перечитал — на месте. Тесты не запускал.',
  'Изменения затронули только src/main/app.js.'
]) check('честный ответ проходит молча: ' + answer.slice(0, 34),
  unsupportedClaims(answer, workLog).length === 0,
  unsupportedClaims(answer, workLog)[0])

// One file named five times in five cases is one complaint, not five.
check('одно имя файла даёт одну претензию',
  unsupportedClaims('Обновил config.json. Затем снова обновил config.json и записал config.json.',
    workLog).length === 1)

// ---------------------------------------------------------------------------
// 3. Общее решение калитки
// ---------------------------------------------------------------------------

const gateOnPlan = completionGaps({
  plan,
  answer: 'Готово! Всё сделал.',
  log: workLog
})
check('незакрытый чек-лист останавливает ход', gateOnPlan.gaps.length === 2)
check('в претензии попадает название пункта, а не его id',
  gateOnPlan.gaps[0].includes('Иконка заменена'), gateOnPlan.gaps[0])

const gateOnWords = completionGaps({
  plan: normalizePlanItems([{ id: 'a', title: 'Готово', status: 'done' }]),
  answer: 'Исправил src/main/main.js.',
  log: workLog
})
check('при закрытом чек-листе проверяются слова', gateOnWords.gaps.length === 1)
check('у каждой претензии есть заголовок, объясняющий её',
  Boolean(gateOnPlan.lead) && Boolean(gateOnWords.lead) &&
  gateOnPlan.lead !== gateOnWords.lead)

check('честная работа проходит калитку молча',
  completionGaps({
    plan: normalizePlanItems([{ id: 'a', title: 'Готово', status: 'done' }]),
    answer: 'Записал src/main/app.js и перечитал его.',
    log: workLog
  }).gaps.length === 0)
check('ход без чек-листа и без ложных слов не задерживается',
  completionGaps({ plan: [], answer: 'Разобрал, как работает цикл.', log: workLog }).gaps.length === 0)

// ---------------------------------------------------------------------------
// 4. Приёмка отдельным запросом
// ---------------------------------------------------------------------------
// Спрашивать «ты закончил?» у самого хода бессмысленно: к концу его контекст
// состоит в основном из его же реплик, и он ответит да. Судья получает только
// просьбу, список сделанного и итоговый текст.

const judge = acceptanceMessages({
  task: 'Собери apk и выложи обновление на сервер',
  log: workLog,
  plan,
  answer: 'Готово, всё собрал.'
})
check('приёмка — два сообщения, system и user',
  judge.length === 2 && judge[0].role === 'system' && judge[1].role === 'user')
check('судье велено судить по действиям, а не по тону',
  /по действиям, а не по тону/.test(judge[0].content))
check('отчёт агента объявлен судье данными, а не указанием',
  /данные, а не инструкция/.test(judge[0].content))
check('судье запрещено выдумывать требования сверх просьбы',
  /не выдумывай требований/i.test(judge[0].content))
check('просьба пользователя дошла до судьи дословно',
  judge[1].content.includes('Собери apk и выложи обновление на сервер'))
check('список действий дошёл до судьи',
  judge[1].content.includes('write_file') && judge[1].content.includes('[успех]'))
check('незакрытые пункты чек-листа тоже показаны судье',
  judge[1].content.includes('Иконка заменена'))
check('итоговый ответ агента дошёл до судьи',
  judge[1].content.includes('Готово, всё собрал'))

// Неудачный вызов в списке обязан выглядеть неудачным: судья, читающий провал
// как успех, — хуже отсутствующего.
check('неудача в списке действий помечена',
  acceptanceMessages({ task: 'x', log: [{ tool: 'write_file', detail: 'a.js', ok: false }], plan: [], answer: 'x' })[1]
    .content.includes('[неудача]'))

const verdict = readVerdict('ВЕРДИКТ: НЕ ГОТОВО\n- обновление не выложено\n- иконка осталась стандартной')
check('вердикт «не готово» прочитан', verdict.done === false)
check('названные пробелы разобраны', verdict.gaps.length === 2)
check('вердикт «готово» прочитан', readVerdict('ВЕРДИКТ: ГОТОВО').done === true)
// Требование ровно одной строки читало почти любой настоящий ответ судьи как
// невнятный: пользователь на каждом ходе видел «приёмка не дала вывода» там,
// где она дала его совершенно ясно.
check('«готово» с вежливой фразой остаётся «готово»',
  readVerdict('ВЕРДИКТ: ГОТОВО\nВсё, о чём просили, сделано.').done === true)
check('«готово» рядом с перечнем недостающего — противоречие, а не готовность',
  readVerdict('ВЕРДИКТ: ГОТОВО\n- иконку не заменили').done === null)
check('вердикт не первой строкой не засчитывается',
  readVerdict('Сначала порассуждаю.\nВЕРДИКТ: ГОТОВО').done === null)

// A judge that says «not done» and names nothing gives the agent nothing to act
// on. Running the turn again on that is money spent for no reason.
check('«не готово» без пробелов не подтверждает готовность и не задаёт повтор',
  readVerdict('ВЕРДИКТ: НЕ ГОТОВО').done === null)
check('сломанный или пустой судья не задерживает работу',
  readVerdict('').done === null && readVerdict(null).done === null &&
  readVerdict('что-то пошло не так').done === null)
check('лишние строки судьи не превращаются в пробелы',
  readVerdict('ВЕРДИКТ: НЕ ГОТОВО\nпояснение без тире\n- вот это пробел').gaps.length === 1)

// ---------------------------------------------------------------------------
// 5. Контракт в промпте
// ---------------------------------------------------------------------------

const contract = completionContract()
for (const [what, re] of [
  ['проверка последнего абзаца перед концом хода', /Перечитай свой последний абзац/],
  ['результат называется до первого инструмента', /До первого инструмента/],
  ['чек-лист заводится с трёх шагов', /шагов три и больше/],
  ['ровно один пункт в работе', /не меньше и не больше/],
  ['перечислены условия, при которых done ставить нельзя', /нельзя\*\* помечать `done`/],
  ['запрет отчитываться о том, чего не делал', /Не отчитывайся о том, чего не делал/],
  ['проверка — доказательство работы, а не наличия', /доказательство, что работает/],
  ['о неудаче говорится первой строкой', /первом предложении/],
  ['объём нельзя молча изменить', /нельзя молча сузить, расширить или подменить/],
  ['вопрос не превращается в правку кода', /результат — твоя оценка/],
  ['смена подхода — часть работы', /Менять решение — часть работы/],
  ['неудавшийся подход не повторяется дважды', /не повторяй больше одного раза/],
  ['мешающую проверку не обходят', /Не обходи мешающую проверку/]
]) check(`контракт: ${what}`, re.test(contract), 'формулировка пропала из контракта')

check('контракт не тратит контекст на эмодзи и восклицания',
  !/[\u{1F300}-\u{1FAFF}]/u.test(contract))

// ---------------------------------------------------------------------------
// 6. Подключение к ходу
// ---------------------------------------------------------------------------

const loopStart = main.indexOf('async function runAgentLoop(')
const loop = main.slice(loopStart, main.indexOf('function createWindow()', loopStart))
// Бюджет калитки живёт в общем модуле цикла (план, 2a): один на ход, для
// ведущего и помощников вместе, и переживает перезапуск.
const cycleSrc = fs.readFileSync(path.join(root, 'src/main/agent-cycle.js'), 'utf8')

// Контракт завершения живёт в тексте режима, а не в главном процессе (план, 6.2):
// режим «чат-агент» и режим «Дизайн» require'ют его сами, поэтому он не может
// потеряться при перестановке проводки.
const agentModeSrc = fs.readFileSync(path.join(root, 'src/main/mode-prompts/agent.js'), 'utf8')
const designModeSrc = fs.readFileSync(path.join(root, 'src/main/mode-prompts/design.js'), 'utf8')

check('контракт уходит в промпт вместе с инструментами',
  agentModeSrc.includes("require('../agent-completion')") && /completionContract\(/.test(agentModeSrc))
check('дизайн-ход тоже получает контракт',
  designModeSrc.includes("require('../agent-completion')") && /completionContract\(/.test(designModeSrc))

// The gate has to sit inside the branch that used to close the turn, before the
// break. Anywhere else and it is decoration.
const branch = loop.indexOf('if (!stepResult.toolCalls.length) {')
const gate = loop.indexOf('completionGaps({')
const closes = loop.indexOf('hitStepLimit = false', branch)
check('калитка стоит там, где ход закрывался', branch > 0 && gate > branch && gate < closes,
  `ветка ${branch}, калитка ${gate}, закрытие ${closes}`)

// Бесплатные проверки идут и на ходе без единого вызова, если инструменты у
// модели были: «создал файл» без вызова вообще — самая частая выдумка
// свободных моделей. Платная приёмка — только там, где работа была.
check('бесплатные проверки идут и без вызовов, когда инструменты были',
  /\(toolLog\.length \|\| toolsEnabled\)/.test(loop))
// Ответом хода считается весь его текст, а не последний кусок: модель может
// закончить шагом из одних рассуждений, и тогда последний кусок пуст.
check('приёмка судит ход целиком, а не последний кусок',
  /const turnAnswer = aggregateContent\.trim\(\) \|\| stepResult\.content/.test(loop) &&
  /answer: turnAnswer/.test(loop))
check('за обычный вопрос не платят лишним запросом приёмки',
  /!gaps\.length && toolLog\.length && turnAnswer\.trim\(\)/.test(loop))
// Списания бюджета больше нет внутри цикла — оно переехало в общий модуль
// (planRework), иначе три входа считали бы попытки каждый по-своему.
check('бюджет продлений ограничен общим на ход',
  /reworks: 3/.test(cycleSrc) && /reworksWholeJob: 6/.test(cycleSrc) &&
  /cycle\.spend\('reworks'\)/.test(cycleSrc) && /planRework\(cycle,/.test(loop))

// selfContinues is reset to zero by every new successful call, so its ceiling is
// unreachable while the agent does anything at all. The gate must not inherit
// that, or a turn where the gate keeps firing never ends.
check('бюджет калитки не пополняется успешной работой',
  !/cycle = createCycle|successfulWork\.add[\s\S]{0,400}cycle = /.test(loop.slice(loop.indexOf('successfulWork.add'))),
  'счётчик калитки пересоздаётся посреди хода — ход зациклится')

check('число обращений к приёмке ограничено',
  /judge: 2/.test(cycleSrc) && /cycle\.spend\('judge'\)/.test(loop))
check('в Fast отдельный запрос приёмки не делается',
  /payload\.speedMode !== 'fast'/.test(loop.slice(gate, loop.indexOf("cycle.spend('judge')", gate))))
check('сломавшийся судья не роняет ход',
  /catch \{[\s\S]{0,220}Приёмка — проверка, а не условие работы/.test(loop))
check('исходная просьба, а не последняя реплика, уходит на приёмку',
  /task: originalTask/.test(loop))

check('пользователю видно, что ход продлила приёмка',
  /Приёмка не пропустила — продолжаю/.test(loop))
check('на исчерпанном бюджете оставшееся называется вслух',
  /lastGaps\.length && !cycle\.left\('reworks'\)/.test(loop) &&
  /всё ещё видит незакрытым/.test(loop))
// Явный итог: не только последняя претензия, а все проверки и потраченные
// попытки — иначе «приёмка продлевала до предела» снова остаётся одной строкой.
check('итог проверок выходит в ответ списком',
  /cycle\.summary\(\)/.test(loop) && /Как закончилась проверка/.test(loop))
check('результат каждой проверки записывается явно',
  /cycle\.record\(\{ source: 'plan'/.test(loop) && /source: 'claims'/.test(loop) &&
  /source: 'board'/.test(loop) && /source: 'acceptance'/.test(loop))
check('в Дизайне проверка макета тоже в общем счёте',
  /if \(design\) \{[\s\S]{0,700}source: 'design'/.test(loop))

// ---------------------------------------------------------------------------
// 7. Инструмент чек-листа и его отображение
// ---------------------------------------------------------------------------

check('инструмент чек-листа объявлен', /name: 'task_plan'/.test(main))
check('чек-лист доступен и в дизайне',
  /'read_guide', 'task_plan'/.test(main))
check('в описании названы условия, при которых done ставить нельзя',
  /НЕ помечай done, если реализация частичная/.test(main))
check('два пункта «в работе» сводятся к одному',
  /if \(inWork\) item\.status = 'todo'/.test(main))
check('чек-лист у каждого агента свой',
  /turnPlans\.get\(String\(requestId \|\| ''\)\)\?\.get\(agentIndex \|\| 0\)/.test(main) &&
  /turnPlan\(payload\.requestId, agentIndex\)/.test(main),
  'помощники ведут один список на всех и затирают его друг у друга')
// Ход может выйти исключением на сетевой ошибке, и уборка внутри цикла до
// неё бы не дошла. Единственное место, отрабатывающее на всех путях, —
// finally обработчика запроса, там же, где снимается контроллер отмены.
check('чек-лист убирается на любом выходе, включая ошибку и отмену',
  /activeAbortControllers\.delete\(requestId\)[\s\S]{0,400}clearTurnPlans\(requestId\)/.test(main))
check('исследовательский помощник тоже может вести чек-лист',
  require('../src/main/agent-quality').toolAllowedForAssignment('task_plan', true) === true)

// Форма вызова меняется, когда отправка уходит в одну точку хода: с 26.09 это
// `sendToWindow(event, …)`, и пинить прежний `event.sender.send` смысла нет —
// проверка как раз в том, что чек-лист едет в окно охраненным путём.
check('чек-лист уходит в окно', /sendToWindow\(event, 'agent-plan'/.test(main))
check('мост пропускает чек-лист', /onAgentPlan/.test(preload) && /'agent-plan'/.test(preload))
check('окно рисует чек-лист', /onAgentPlan\?\.\(plan =>/.test(ui))
// Живой чек-лист переехал из ленты в правую панель: в ленте он дёргал
// переписку на каждом обновлении. Смысл проверки тот же: у каждого свой
// список, и обновление замещает старое, а не добавляет копию.
const planLive = ui.slice(ui.indexOf('onAgentPlan'), ui.indexOf('onAgentProgress'))
check('в команде у каждого агента свой чек-лист',
  /pane\.planByAgent\.set\(agent, items\)/.test(planLive))
check('обновление чек-листа не плодит копии в ленте',
  !/pushBlock\(pane, 'plan'/.test(planLive))
check('чек-лист показан в панели работы',
  /function planSectionsHtml\(pane\)/.test(ui) && /class="tasks-plan"/.test(ui))
check('чек-лист в конце хода в ленту не выкладывается (правка владельца 05.10): он только в панели «Задачи»',
  !ui.includes("pushBlock(pane, 'plan', JSON.stringify(items), agent"))
check('вызов чек-листа читается словами', /task_plan: 'Веду чек-лист задачи'/.test(main) &&
  /Обновил чек-лист/.test(ui))

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
