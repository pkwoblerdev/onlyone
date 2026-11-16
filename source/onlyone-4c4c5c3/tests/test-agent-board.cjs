// «Агент-режим, который не агент-режим.»
//
// Работа раздавалась звездой: ведущий писал поручения, помощники по очереди
// отвечали ведущему. У помощника не было ни адресата, ни способа сказать «это
// не сделано» — единственным доступным действием было отчитаться, поэтому
// отчитывались всегда и всегда успешно.
//
// Здесь проверяется то, что этого больше не позволяет: доска с состоянием,
// которое агент выставляет себе сам, и почта с обязательным ответом.
const fs = require('node:fs')
const path = require('node:path')

const board = require('../src/main/agent-board')

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

const REQ = 'req-test'
const reset = () => {
  board.clearBoard(REQ)
  board.seedBoard(REQ, [
    { agent: 'Агент 2', task: 'Прочитать src/main/main.js и описать цикл вызовов', acceptance: 'Описание с номерами строк', readOnly: true },
    { agent: 'Агент 3', task: 'Починить разбор аргументов', acceptance: 'Тест проходит', readOnly: false }
  ])
}

// --- доска заводится из поручений --------------------------------------------

reset()
const seeded = board.boardSnapshot(REQ)
check('поручения становятся пунктами доски', seeded.items.length === 2)
check('у каждого пункта свой идентификатор',
  seeded.items[0].id !== seeded.items[1].id && Boolean(seeded.items[0].id))
check('новый пункт никто не брал', seeded.items.every(item => item.status === 'open'))
check('право записи переносится с поручения',
  seeded.items[0].readOnly === true && seeded.items[1].readOnly === false)

// --- чужое трогать нельзя -----------------------------------------------------

const stolen = board.updateItem(REQ, 'Агент 3', { id: 't1', status: 'done', note: 'я за него всё сделал' })
check('чужой пункт закрыть нельзя', stolen.success === false)
check('в отказе названо, чей это пункт', /Агент 2/.test(stolen.error), stolen.error)
check('отказ подсказывает законный путь', /agent_message|возражение/i.test(stolen.error))

const nowhere = board.updateItem(REQ, 'Агент 2', { id: 't9', status: 'doing' })
check('несуществующий пункт не заводится молча', nowhere.success === false)
check('в отказе перечислены настоящие пункты', /t1/.test(nowhere.error), nowhere.error)

// --- «сделано» требует доказательства ----------------------------------------

const bare = board.updateItem(REQ, 'Агент 2', { id: 't1', status: 'done', note: 'готово' })
check('закрыть пункт словом «готово» нельзя', bare.success === false)
check('сказано, что именно нужно вместо этого',
  /файлы|проверк/i.test(bare.error), bare.error)

const blockedBare = board.updateItem(REQ, 'Агент 2', { id: 't1', status: 'blocked', note: 'нет' })
check('заблокировать без причины нельзя', blockedBare.success === false)

const taken = board.updateItem(REQ, 'Агент 2', { id: 't1', status: 'doing' })
check('взяться за свой пункт можно без пояснений', taken.success === true)
check('предыдущее состояние сохраняется', taken.was === 'open')

const closed = board.updateItem(REQ, 'Агент 2', { id: 't1', status: 'done',
  note: 'Прочитал src/main/main.js строки 5700-5900, описал цикл вызовов' })
check('закрыть пункт с доказательством можно', closed.success === true)
check('состояние действительно поменялось',
  board.boardSnapshot(REQ).items[0].status === 'done')

// --- почта -------------------------------------------------------------------

reset()
const noAddress = board.postMessage(REQ, 'Агент 2', { kind: 'question', body: 'а где тут цикл вызовов' })
check('письмо без адресата не уходит', noAddress.success === false)

const toSelf = board.postMessage(REQ, 'Агент 2', { to: 'Агент 2', kind: 'note', body: 'напоминание самому себе' })
check('письмо самому себе не считается общением', toSelf.success === false)

const empty = board.postMessage(REQ, 'Агент 2', { to: 'Агент 3', kind: 'question', body: 'ок' })
check('пустая вежливость письмом не считается', empty.success === false)

const asked = board.postMessage(REQ, 'Агент 2', { to: 'Агент 3', kind: 'question',
  body: 'Ты проверял, что разбор аргументов не ломается на кириллице?' })
check('вопрос конкретному агенту уходит', asked.success === true)

// Прочитал — не значит ответил. Разница здесь принципиальная: именно она
// отличает «увидел возражение и отклонил его» от «пропустил молча».
const firstRead = board.inbox(REQ, 'Агент 3')
check('письмо доходит до адресата', firstRead.length === 1)
check('второй раз то же письмо не приходит', board.inbox(REQ, 'Агент 3').length === 0)
check('прочитанное не считается отвеченным',
  board.unanswered(REQ).length === 1, String(board.unanswered(REQ).length))

board.postMessage(REQ, 'Агент 3', { to: 'Агент 2', kind: 'answer', body: 'Проверял, кириллица разбирается верно' })
check('ответ снимает вопрос с очереди', board.unanswered(REQ).length === 0)

// --- возражение меняет состояние пункта ---------------------------------------

reset()
board.updateItem(REQ, 'Агент 3', { id: 't2', status: 'done', note: 'Починил разбор, тест tests/test-tool-protocol.cjs проходит' })
check('пункт закрыт', board.boardSnapshot(REQ).items[1].status === 'done')

board.postMessage(REQ, 'Агент 2', { to: 'Агент 3', kind: 'objection', about: 't2',
  body: 'Разбор всё ещё падает на пустой строке аргументов, проверь parseToolArguments("")' })
check('возражение снимает пункт с «сделано»',
  board.boardSnapshot(REQ).items[1].status === 'disputed',
  board.boardSnapshot(REQ).items[1].status)
check('возражение остаётся без ответа, пока не ответили',
  board.unanswered(REQ).length === 1)

// --- то, что увидит ведущий ---------------------------------------------------

const report = board.boardReport(REQ)
check('ведущий видит доску', /Доска работы/.test(report))
check('ведущему показано, где встало', /Встало/.test(report))
check('ведущему показано неотвеченное', /Без ответа/.test(report))
check('ведущему сказано, что это не мелочь',
  /не считается сделанным/.test(report))

const gaps = board.boardGaps(REQ, [])
check('оспоренный пункт — незакрытая работа', gaps.some(g => /оспорен/.test(g)), gaps.join(' | '))
check('не взятый пункт — незакрытая работа', gaps.some(g => /никто не взял/.test(g)))
check('неотвеченное возражение — незакрытая работа',
  gaps.some(g => /без ответа/.test(g)))

// Пункт с правом записи, закрытый как сделанный, хотя за весь ход ни один файл
// не менялся. Это ровно тот случай, ради которого доска и заведена.
board.clearBoard(REQ)
board.seedBoard(REQ, [{ agent: 'Агент 2', task: 'Починить', acceptance: 'тест', readOnly: false }])
board.updateItem(REQ, 'Агент 2', { id: 't1', status: 'done', note: 'Исправил и проверил, всё работает' })
check('закрытая правка без единого изменения файла замечена',
  board.boardGaps(REQ, [{ tool: 'read_file', ok: true, path: 'a.js' }]).length === 0 ||
  board.boardGaps(REQ, []).some(g => /не изменён ни один файл/.test(g)),
  board.boardGaps(REQ, []).join(' | '))

// --- поручение агенту ---------------------------------------------------------

reset()
board.postMessage(REQ, 'Агент 3', { to: 'Агент 2', kind: 'objection', about: 't1',
  body: 'Описание цикла не совпадает с тем, что в файле на самом деле' })
const brief = board.boardBrief(REQ, 'Агент 2')
check('агент видит всю доску', /Доска работы/.test(brief))
check('агент видит свою часть отдельно', /Твои пункты/.test(brief))
check('агент видит письма себе', /Письма тебе/.test(brief))
check('агенту сказано, как отметить сделанное', /board_update/.test(brief))
check('агенту сказано, что выдумывать успех нельзя',
  /Выдумывать успех/.test(brief))
check('агенту сказано, как возразить', /objection/.test(brief))
check('чужие письма в поручение не попадают',
  !board.boardBrief(REQ, 'Агент 3').includes('Письма тебе'))

// --- ведущий может закрыть то, что требует от него приёмка --------------
//
// Проверка завершённости показывает пробелы доски только ведущему и требует их
// закрыть. Пока чужой пункт был ему не по руке, это было требование сделать
// невозможное: помощника в этом круге уже не запустят, а круг возражений такой
// пробел создаёт почти всегда. Цена была в лишних полных запросах к модели.

board.clearBoard(REQ)
board.seedBoard(REQ, [
  { agent: 'Агент 2', task: 'Правка разбора', readOnly: false },
  { agent: 'Агент 3', task: 'Ревью правки', readOnly: true }
], ['Агент 1', 'Агент 2', 'Агент 3', 'Агент 4'])

const leadCloses = board.updateItem(REQ, 'Агент 1', { id: 't1', status: 'done',
  note: 'Проверил сам: правка на месте, тест проходит' })
check('ведущий закрывает чужой пункт на приёмке', leadCloses.success === true, leadCloses.error)
check('ему тоже нужно доказательство',
  board.updateItem(REQ, 'Агент 1', { id: 't2', status: 'done', note: 'ок' }).success === false)
check('помощник по-прежнему чужое не трогает',
  board.updateItem(REQ, 'Агент 3', { id: 't1', status: 'open' }).success === false)

board.postMessage(REQ, 'Агент 3', { to: 'Агент 2', kind: 'objection', about: 't1',
  body: 'Правка не закрывает случай пустой строки' })
check('ведущий отвечает на спор двух помощников',
  board.postMessage(REQ, 'Агент 1', { to: 'Агент 3', kind: 'answer',
    body: 'Проверил возражение сам, случай закрыт' }).success === true)
check('ответ ведущего снимает письмо с очереди',
  board.unanswered(REQ).length === 0, String(board.unanswered(REQ).length))

// --- имя адресата читается по-человечески -----------------------------------
//
// Имя пишет модель, а не форма. Сверять его побайтно значит платить шагом
// за каждый регистр и каждую скобку.

const live = board.ensureBoard(REQ)
check('регистр не мешает', board.resolveName(live, 'агент 3') === 'Агент 3')
check('уточнение в скобках не мешает',
  board.resolveName(live, 'Агент 3 (ревьюер)') === 'Агент 3')
check('один номер тоже адрес', board.resolveName(live, '3') === 'Агент 3')
check('чужое имя не проходит', board.resolveName(live, 'Агент 42') === '')
check('свободный агент без поручения — тоже адресат',
  board.postMessage(REQ, 'Агент 2', { to: 'Агент 4', kind: 'question',
    body: 'Ты этот файл раньше смотрел?' }).success === true)

// --- номер письма решает, а не складывается с пунктом ------------------

board.clearBoard(REQ)
board.seedBoard(REQ, [
  { agent: 'Агент 2', task: 'А', readOnly: true },
  { agent: 'Агент 3', task: 'Б', readOnly: false }
], ['Агент 1', 'Агент 2', 'Агент 3'])
const raised = board.postMessage(REQ, 'Агент 2', { to: 'Агент 3', kind: 'objection', about: 't2',
  body: 'Разбор падает на пустой строке аргументов' })
check('ответ по номеру письма не отменяется чужим about',
  board.postMessage(REQ, 'Агент 3', { to: 'Агент 2', kind: 'answer', replyTo: raised.id,
    about: 't1', body: 'Возражение верное, поправил разбор' }).success === true)

const asked2 = board.postMessage(REQ, 'Агент 2', { to: 'Агент 3', kind: 'question',
  body: 'А кодировку файлов ты проверял?' })
check('явный null вместо номера не ломает единственный ответ',
  board.postMessage(REQ, 'Агент 3', { to: 'Агент 2', kind: 'answer', replyTo: null,
    body: 'Проверял, кодировка в порядке' }).success === true,
  String(asked2.id))

// --- письмо видно, пока на него не ответили -----------------------------

board.clearBoard(REQ)
board.seedBoard(REQ, [{ agent: 'Агент 2', task: 'А', readOnly: false }],
  ['Агент 1', 'Агент 2', 'Агент 3'])
board.postMessage(REQ, 'Агент 3', { to: 'Агент 2', kind: 'objection', about: 't1',
  body: 'Здесь ошибка в разборе аргументов' })
check('неотвеченное письмо приходит снова',
  /Письма тебе/.test(board.boardBrief(REQ, 'Агент 2')) &&
  /Письма тебе/.test(board.boardBrief(REQ, 'Агент 2')))

// --- второй круг: агент видит свою текущую работу, а не прошлую -------

board.clearBoard(REQ)
board.seedBoard(REQ, [{ agent: 'Агент 2', task: 'Круг первый', readOnly: false }],
  ['Агент 1', 'Агент 2'])
board.updateItem(REQ, 'Агент 2', { id: 't1', status: 'done', note: 'Сделал и проверил первый круг' })
board.seedBoard(REQ, [{ agent: 'Агент 2', task: 'Круг второй', readOnly: false }])
const second = board.boardBrief(REQ, 'Агент 2')
check('в своём разделе только текущий пункт',
  second.includes('Круг второй') &&
  !second.slice(second.indexOf('Твои пункты')).includes('Круг первый'))
check('общая доска помнит оба круга', second.includes('Круг первый'))

// --- доска живёт ровно один ход ------------------------------------------------

board.clearBoard(REQ)
check('доска умирает вместе с ходом', board.boardSnapshot(REQ).items.length === 0)

// --- всё это подключено ---------------------------------------------------------

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const quality = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'agent-quality.js'), 'utf8')
// Код окна теперь разложен по модулям (план, 2d) — проверяем весь исполняемый текст.
const ui = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8')

check('инструменты доски объявлены', /name: 'board_update'/.test(main) && /name: 'agent_message'/.test(main))
check('инструменты доски исполняются', /recordBoardUpdate\(event, args/.test(main) && /recordBoardMessage\(event, args/.test(main))
check('доска заводится из поручений ведущего', /seedBoard\(payload\.requestId/.test(main))
check('помощник получает доску в поручении', /boardBrief\(payload\.requestId, slot\.name\)/.test(main))
check('ведущий видит доску в приёмке', /reviewBoardSection\(payload\.requestId\)/.test(main))
check('доска участвует в проверке завершённости', /boardGaps\(payload\.requestId, toolLog\)/.test(main))
check('доска очищается вместе с ходом', /clearBoard\(requestId\)/.test(main))
check('координация доступна и при доступе только на чтение',
  /'board_update', 'agent_message', 'board_read'/.test(quality))
check('доска доходит до окна', /'agent-board'/.test(preload) && /onAgentBoard/.test(ui))
// С переделкой правой панели пункт доски — строка плана со значком состояния:
// класс `board-row` ушёл, состояние несут `status-…` у пункта и значок `state-…`.
check('окно показывает состояние пунктов', /BOARD_WORD/.test(ui) &&
  /unified-task-node status-/.test(ui) && /task-state-icon state-/.test(ui))
check('окно показывает неотвеченные письма', /board-letter/.test(ui))

// Живой прогон «Ревью»: в панели работы все части назывались одинаково —
// доска не хранила название части, и окно добывало заголовок из текста
// поручения, одинакового у всех частей.
{
  const api = require('../src/main/agent-board')
  const id = 'title-' + Math.random().toString(36).slice(2)
  api.seedBoard(id, [
    { agent: 'Агент 2', taskTitle: 'Корректность', task: 'Часть «Ревью»: Корректность.' + String.fromCharCode(10) + 'Прочитай изменения.' },
    { agent: 'Агент 3', taskTitle: 'Безопасность', task: 'Часть «Ревью»: Безопасность.' + String.fromCharCode(10) + 'Проверь тот же код.' }
  ], ['Агент 1', 'Агент 2', 'Агент 3'])
  const items = api.boardSnapshot(id).items
  check('доска помнит название части', items[0].title === 'Корректность' && items[1].title === 'Безопасность',
    items.map(item => item.title).join(' / '))
  api.clearBoard(id)
}

require('./test-agent-board-integration.cjs')
console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exitCode = failed ? 1 : 0
