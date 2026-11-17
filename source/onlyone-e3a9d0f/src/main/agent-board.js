'use strict'

// Почему агент-режим не был агент-режимом.
//
// Работа раздавалась звездой: ведущий писал поручения, помощники по очереди
// отвечали ведущему, ведущий читал всех. Помощник не мог ни спросить, ни
// возразить, ни отказаться — у него не было ни адресата, ни способа сказать
// «это не сделано». Единственным доступным действием было отчитаться, поэтому
// отчитывались всегда и всегда успешно. Это не команда, это четыре монолога.
//
// Здесь две недостающие вещи.
//
// Доска. Общий список поручений с состоянием, который видят все и который
// каждый правит только в своей части. Состояние — не украшение: «заблокировано»
// и «оспорено» это то, чего в звезде сказать было нельзя, и именно поэтому
// вместо них появлялся выдуманный успех.
//
// Почта. Именованный адресат. Вопрос конкретному агенту, возражение к
// конкретному пункту — и тот обязан ответить; неотвеченное видно ведущему и не
// растворяется в общем отчёте.
//
// Правила намеренно жёсткие. Отметить «сделано» без единого слова о том, чем
// это подтверждается, нельзя. Тронуть чужой пункт нельзя. Ответить на
// возражение молчанием нельзя — молчание останется в списке неотвеченного.

const { isVerificationCommand } = require('./verification.cjs')

const STATUSES = ['open', 'doing', 'done', 'blocked', 'disputed']

// Правки файлов: после последней из них должна быть зелёная проверка (замок приёмки, инициатива 6).
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'move_path', 'delete_path',
  'dc_write', 'dc_delete', 'dc_html_str_replace', 'dc_js_str_replace', 'dc_set_props', 'dc_set_entry', 'dc_scaffold'])

const STATUS_WORD = {
  open: 'не начато',
  doing: 'в работе',
  done: 'сделано',
  blocked: 'заблокировано',
  disputed: 'оспорено'
}

const KINDS = ['question', 'objection', 'answer', 'note']

const KIND_WORD = {
  question: 'вопрос',
  objection: 'возражение',
  answer: 'ответ',
  note: 'заметка'
}

// Одна доска на ход. Живёт ровно столько же, сколько сам ход: очищается там же,
// где чек-листы, и по тем же причинам — запись, пережившая свой ход, потом
// врёт про следующий.
const boards = new Map()

// Ведущий. Он же координатор, он же единственный, кто отвечает за итог, —
// поэтому у него на доске особые права: он закрывает чужие пункты, когда
// принимает работу, и отвечает на письма, оставшиеся без ответа. Без этого
// приёмка требовала от него закрыть то, чего он закрыть не может.
const COORDINATOR = 'Агент 1'

function ensureBoard(requestId) {
  const key = String(requestId || 'default')
  if (!boards.has(key)) {
    boards.set(key, { items: [], messages: [], nextMessageId: 1, evidence: [], roster: [], testsExpected: false })
  }
  return boards.get(key)
}

function participantsOf(board) {
  return [...new Set([COORDINATOR, ...(board.roster || []), ...board.items.map(item => item.agent)])]
}

// Имя адресата приходит от модели, а не из формы. Она пишет «агент 3», «Агент 3
// (ревьюер)», иногда просто «3» — и каждое такое попадание раньше стоило шага:
// письмо отвергалось, хотя адресат очевиден. Сверять побайтно имя, которое
// модель прочитала глазами в тексте поручения, — заведомо проигрышная игра.
function resolveName(board, raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const names = participantsOf(board)

  const exact = names.find(name => name === text)
  if (exact) return exact

  const bare = text.replace(/\s*[([].*$/, '').trim()
  const lower = bare.toLowerCase()
  const loose = names.find(name => name.toLowerCase() === lower)
  if (loose) return loose

  const digits = text.match(/(\d+)/)
  if (digits) {
    const numbered = names.find(name => name === `Агент ${digits[1]}`)
    if (numbered) return numbered
  }

  const withoutPrefix = text.replace(/^[Аа]гент\s+/i, '').trim()
  if (withoutPrefix) {
    const looseNoPrefix = names.find(name => name.toLowerCase() === withoutPrefix.toLowerCase())
    if (looseNoPrefix) return looseNoPrefix
  }

  const withPrefix = `Агент ${text}`.toLowerCase()
  const looseWithPrefix = names.find(name => name.toLowerCase() === withPrefix)
  if (looseWithPrefix) return looseWithPrefix

  return ''
}

function clearBoard(requestId) {
  boards.delete(String(requestId || 'default'))
}

function boardSnapshot(requestId) {
  const board = ensureBoard(requestId)
  return {
    items: board.items.map(item => ({ ...item })),
    messages: board.messages.map(message => ({ ...message }))
  }
}

// Поручения приходят из assign_work. Доска их не придумывает и не меняет —
// только заводит под ними место для состояния.
function seedBoard(requestId, assignments, roster = []) {
  const board = ensureBoard(requestId)
  const list = Array.isArray(assignments) ? assignments : []
  // Живой агент без поручения — всё равно участник: ему можно написать. Раньше
  // адресатом считался только тот, кому в этом круге что-то досталось, и
  // спросить у свободного коллегу было нельзя.
  for (const name of (Array.isArray(roster) ? roster : [])) {
    const clean = String(name || '').trim()
    if (clean && !board.roster.includes(clean)) board.roster.push(clean)
  }

  list.forEach((assignment, index) => {
    const id = `t${board.items.length + 1}`
    // У одного агента может быть несколько пунктов. Раньше второй
    // пункт того же агента переименовывался в «Агент ${index + 2}», которого в
    // команде нет, и настоящий исполнитель не мог отметить собственный этап.
    const agentName = String(assignment?.agent || '').trim() || `Агент ${index + 2}`

    board.items.push({
      id,
      agent: agentName,
      // Название части приходит вместе с поручением. Без него панель добывала
      // заголовок из текста задания, а у частей одного агента он мог начинаться одним и
      // тем же словом — в панели стояли три одинаковых имени.
      title: String(assignment?.taskTitle || assignment?.title || '').slice(0, 120),
      task: String(assignment?.task || '').slice(0, 4000),
      acceptance: String(assignment?.acceptance || '').slice(0, 2000),
      readOnly: assignment?.readOnly !== false,
      status: 'open',
      note: '',
      history: []
    })
  })

  return board.items.map(item => ({ ...item }))
}

// Пункт переходит к другому агенту: его агент занят, а другой свободен и берёт
// работу, чтобы не простаивать. Состояние пункта остаётся, в истории остаётся
// запись о передаче — иначе в отчёте было бы непонятно, почему «Простоту»
// поручали одному, а сдал другой.
function reassignItem(requestId, id, agent, note = '') {
  const board = ensureBoard(requestId)
  const item = findItem(board, id)
  const to = String(agent || '').trim()
  if (!item || !to) return null
  const from = item.agent
  if (from === to) return { ...item }
  item.agent = to
  if (!board.roster.includes(to)) board.roster.push(to)
  item.history.push({ from: item.status, to: item.status, note: (note || `передан: ${from} → ${to}`).slice(0, 600) })
  return { ...item }
}

function findItem(board, id) {
  return board.items.find(item => item.id === String(id || '').trim()) || null
}

// Пункты агента. Имя сравнивается как есть: ведущий раздаёт поручения теми же
// именами, которыми названы слоты, и придумывать сопоставление по похожести
// значило бы позволить агенту править чужое из-за опечатки.
function itemsOf(board, agent) {
  const name = String(agent || '').trim()
  return board.items.filter(item => item.agent === name)
}

// Была ли правка файлов этого пункта и зелёная проверка после неё. Нет правок — замок не нужен (true).
function evidenceFor(board, item, entry) {
  if (!entry) return false
  // Явная привязка к пункту однозначна: имя исполнителя не фильтр, иначе передача
  // пункта другому агенту сделала бы прежние правки невидимыми и открыла замок.
  if (entry.assignmentId) return entry.assignmentId === item.id
  // Доказательство без привязки при нескольких пунктах неоднозначно: относим его
  // ко всем кандидатам, а не прячем — невидимая правка открывает замок (break-4 Н19).
  if (entry.agent === COORDINATOR) return true
  return entry.agent === item.agent
}

function greenAfterLastWrite(board, item) {
  const evidence = board.evidence.filter(entry => evidenceFor(board, item, entry))
  let changed = false, green = false
  for (const entry of evidence) {
    if (WRITE_TOOLS.has(entry.tool) && entry.ok) { changed = true; green = false }
    if (entry.tool === 'run_command') {
      if (!entry.commandTruncated && isVerificationCommand(entry.command)) green = entry.ok === true && entry.exitCode === 0
      else { changed = true; green = false }
    }
  }
  return !changed || green
}

function updateItem(requestId, agent, args) {
  const board = ensureBoard(requestId)
  const who = String(agent || '').trim()
  const id = String(args?.id || '').trim()
  const status = String(args?.status || '').trim()
  const note = String(args?.note || '').trim()

  if (!id) return { success: false, error: 'Нужен id пункта. Посмотри доску: у каждого пункта он свой.' }

  const item = findItem(board, id)
  if (!item) {
    const known = board.items.map(entry => entry.id).join(', ') || 'доска пуста'
    return { success: false, error: `Пункта ${id} на доске нет. Есть: ${known}.` }
  }

  // Чужой пункт — не твой. Без этого «сделано» мог поставить кто угодно кому
  // угодно, и доска перестала бы значить что-либо.
  //
  // Исключение одно: ведущий. Он принимает работу, и приёмка требует от него
  // закрыть незакрытое. Пока права не было, приёмка гоняла его по кругу с
  // требованием сделать то, что код ему запрещал: помощник больше не
  // запускается, а его пункт так и остаётся «не начато».
  if (item.agent !== who && who !== COORDINATOR) {
    return {
      success: false,
      error: `Пункт ${id} поручен не тебе, а ${item.agent}. Свой пункт правь сам, к чужому — возражение через agent_message.`
    }
  }

  if (!STATUSES.includes(status)) {
    return { success: false, error: `Состояние должно быть одним из: ${STATUSES.join(', ')}.` }
  }

  // «Сделано» без единого слова о том, чем это подтверждается, — это и есть та
  // самая отчётность, ради которой всё затевалось. Слово требуется.
  if (status === 'done' && note.length < 12) {
    return {
      success: false,
      error: 'Чтобы закрыть пункт, скажи, чем это подтверждается: какие файлы изменены, что запускалось, что проверено. Одного слова «готово» мало.'
    }
  }
  if (status === 'blocked' && note.length < 8) {
    return { success: false, error: 'Скажи, что именно мешает: чего не хватает и от кого это зависит.' }
  }

  // «Нет зелёных тестов — нет «сделано»»: пункт с правом записи, где код менялся, закрывается только после зелёной проверки,
  // запущенной СТРОГО ПОЗЖЕ последней правки. Только там, где у проекта есть команда проверки; пункты «только чтение» и
  // пункты без единой правки замок не трогает (про вторых скажет проверка хода).
  if (status === 'done' && board.testsExpected && item.readOnly === false && !greenAfterLastWrite(board, item)) {
    return {
      success: false,
      error: 'Пункт не может быть отмечен как done: код был изменён, но верификационный тест не запускался после последней правки. ' +
        'Запусти проверку проекта (например, npm test), прочитай результат и закрой пункт снова.'
    }
  }

  const was = item.status
  item.status = status
  item.note = note || item.note
  if (status === 'done') {
    item.completedBy = who
  }
  item.history.push({ from: was, to: status, note: note.slice(0, 600) })

  return {
    success: true,
    id: item.id,
    status,
    was,
    board: board.items.map(entry => ({ id: entry.id, agent: entry.agent, status: entry.status }))
  }
}

// Письмо. Адресат обязателен: сообщение всем сразу — это снова монолог.
function postMessage(requestId, from, args) {
  const board = ensureBoard(requestId)
  const to = String(args?.to || '').trim()
  const kind = KINDS.includes(String(args?.kind || '').trim()) ? String(args.kind).trim() : 'note'
  const body = String(args?.body || '').trim()
  const about = String(args?.about || '').trim()

  if (!to) return { success: false, error: 'Укажи адресата: имя агента, которому это письмо.' }

  const sender = resolveName(board, from)
  const target = resolveName(board, to)
  if (!target || !sender) {
    return {
      success: false,
      error: 'Адресат и отправитель должны быть участниками доски: ' + participantsOf(board).join(', ')
    }
  }
  if (target === sender) return { success: false, error: 'Письмо самому себе ничего не решает.' }
  if (body.length < 10) {
    return { success: false, error: 'Скажи по существу: что именно не так или что именно нужно узнать. Одна строка вежливости — не сообщение.' }
  }

  const item = about ? findItem(board, about) : null
  if (about && !item) {
    return { success: false, error: `Пункта ${about} на доске нет. Либо укажи существующий id, либо не указывай его вовсе.` }
  }

  let reply = null
  if (kind === 'answer') {
    // Ведущий отвечает за итог, поэтому отвечать он вправе на любое письмо,
    // оставшееся без ответа, — в том числе на спор двух помощников, которых в
    // этом круге уже не запустят.
    const pending = board.messages.filter(m => !m.answered &&
      ['question', 'objection'].includes(m.kind) &&
      (sender === COORDINATOR ? true : (m.to === sender && m.from === target)))

    // Номер письма, если он назван, решает. Раньше он складывался с полем about
    // через «и», и законный ответ «на письмо 1, по моему пункту t2» отвергался:
    // about описывает пункт отвечающего, а не пункт вопроса.
    const asked = args.replyTo === undefined || args.replyTo === null || args.replyTo === ''
      ? null
      : Number(args.replyTo)
    const candidates = Number.isFinite(asked) && asked
      ? pending.filter(m => m.id === asked)
      : pending.filter(m => !about || m.about === about)
    if (!pending.length) {
      // Отвечать не на что — это не то же, что отвечать неясно кому. Раньше оба
      // случая давали одну и ту же просьбу указать replyTo — и агент, решивший
      // просто доложить ведущему, искал несуществующий номер письма.
      return {
        success: false,
        error: `От ${to} нет ни вопроса, ни возражения к тебе — отвечать не на что. Если это сообщение по своей инициативе, возьми kind: "note", вопрос — "question", возражение — "objection".`
      }
    }
    if (candidates.length !== 1) {
      const open = pending.map(m => `${m.id} (${KIND_WORD[m.kind]} от ${m.from}${m.about ? ', пункт ' + m.about : ''})`).join(', ')
      return { success: false, error: `Ответ должен относиться к одному письму. Укажи replyTo. Открыты: ${open}.` }
    }
    reply = candidates[0]
  }
  const primaryRecipient = (reply && sender === COORDINATOR && target !== reply.from) ? reply.from : target
  const message = {
    id: board.nextMessageId++,
    from: sender,
    to: primaryRecipient,
    kind,
    about: item ? item.id : '',
    body: body.slice(0, 4000),
    read: false,
    answered: false
  }
  if (reply) {
    message.replyTo = reply.id
    reply.answered = true
    if (target && target !== primaryRecipient && target !== sender) {
      board.messages.push({
        id: board.nextMessageId++,
        from: sender,
        to: target,
        kind,
        about: item ? item.id : '',
        replyTo: reply.id,
        body: body.slice(0, 4000),
        read: false,
        answered: false
      })
    }
  }
  board.messages.push(message)

  // Возражение к пункту — это не мнение в стороне, а состояние пункта. Пока на
  // него не ответили, «сделано» не значит сделано.
  if (kind === 'objection' && item && item.status !== 'blocked') {
    item.history.push({ from: item.status, to: 'disputed', note: `возражение от ${message.from}` })
    item.status = 'disputed'
  }

  return { success: true, id: message.id, to: primaryRecipient, kind, note: 'Письмо доставлено. Ответ придёт в очередь адресата.' }
}

// Непрочитанное для агента. Чтение помечает письма прочитанными, но не
// отвеченными: прочитал не значит ответил, и разница здесь принципиальная.
function inbox(requestId, agent) {
  const board = ensureBoard(requestId)
  const name = resolveName(board, agent) || String(agent || '').trim()
  const mine = board.messages.filter(message => message.to === name && !message.read)
  for (const message of mine) message.read = true
  return mine.map(message => ({ ...message }))
}

// Что агент обязан увидеть в своём поручении. Вопрос и возражение показываются,
// пока на них не ответили: раньше письмо доставлялось ровно один раз, и агент,
// упавший или просто промолчавший, больше его не видел никогда — а в списке
// неотвеченного оно оставалось навсегда и держало приёмку.
function pendingFor(requestId, agent) {
  const board = ensureBoard(requestId)
  const name = resolveName(board, agent) || String(agent || '').trim()
  const mine = board.messages.filter(message => message.to === name &&
    (['question', 'objection'].includes(message.kind) ? !message.answered : !message.read))
  for (const message of mine) message.read = true
  return mine.map(message => ({ ...message }))
}

// Что осталось висеть. Вопросы и возражения без ответа — то, о чём ведущий
// обязан знать прежде, чем назовёт работу принятой.
function unanswered(requestId) {
  const board = ensureBoard(requestId)
  return board.messages
    .filter(message => (message.kind === 'question' || message.kind === 'objection') && !message.answered)
    .map(message => ({ ...message }))
}

// Пункты, которые нельзя считать закрытыми.
function openItems(requestId) {
  const board = ensureBoard(requestId)
  return board.items.filter(item => item.status !== 'done').map(item => ({ ...item }))
}

function itemLine(item) {
  const note = item.note ? ` — ${item.note.slice(0, 300)}` : ''
  return `- [${item.id}] ${item.agent}: ${item.task.slice(0, 300)} · ${STATUS_WORD[item.status] || item.status}${note}`
}

function messageLine(message) {
  const about = message.about ? ` к пункту ${message.about}` : ''
  return `- [письмо ${message.id}] ${message.from} → ${message.to}, ${KIND_WORD[message.kind] || message.kind}${about}: ${message.body.slice(0, 600)}`
}

// Доска в поручении агента. Своё выделено: агент должен видеть и общую картину,
// и ровно ту её часть, за которую отвечает он.
function boardBrief(requestId, agent) {
  const board = ensureBoard(requestId)
  if (!board.items.length && !board.messages.length) return ''

  const name = resolveName(board, agent) || String(agent || '').trim()
  // Только незакрытое: во втором круге у агента появляется новый пункт, и
  // показывать рядом с ним закрытый пункт первого круга значит предлагать ему
  // перепутать, какой из них его текущая работа.
  const mine = itemsOf(board, name).filter(item => item.status !== 'done')
  const letters = pendingFor(requestId, name)

  const parts = []
  parts.push('## Доска работы\n\n' + (board.items.length
    ? board.items.map(itemLine).join('\n')
    : '(поручений пока нет)'))

  if (mine.length) {
    parts.push('### Твои пункты\n\n' + mine.map(itemLine).join('\n') +
      '\n\nОтмечай их сам: `board_update` со статусом doing, когда взялся, и done, когда сделал. ' +
      'Закрывая пункт, скажи, чем это подтверждается — какие файлы, какие проверки, какой результат. ' +
      'Если сделать нельзя — blocked с причиной. Выдумывать успех вместо blocked нельзя: это худшее, что здесь можно сделать.')
  }

  if (letters.length) {
    parts.push('### Письма тебе\n\n' + letters.map(messageLine).join('\n') +
      '\n\nНа вопрос и возражение ответь — `agent_message` с kind: "answer" тому же адресату и replyTo: ID письма. ' +
      'Возражение можно отклонить, но тогда скажи, почему оно неверно, и чем это проверяется. Молча пропустить нельзя.')
  }

  parts.push('Не согласен с чужой частью — пиши `agent_message` с kind: "objection" и укажи about: id пункта. ' +
    'Нужно что-то узнать у другого — kind: "question". Адресат обязан ответить.')

  return parts.join('\n\n')
}

// Сводка для ведущего: где работа встала и что осталось без ответа. Это и есть
// то, чего в звёздной схеме не было вовсе.
// Что изменилось у команды с прошлого шага этого агента.
//
// Работающий агент узнавал о сделанном соседями только из отчётов следующего
// круга — когда его часть уже сдана и подстроить её под чужой результат поздно.
// Два агента, идущие одновременно, так и не узнавали друг о друге: один находил
// причину ошибки, другой продолжал искать её же. Теперь новое за шаг приходит к
// агенту короткой сводкой: чья часть сдана или встала и какие письма ему пришли.
//
// `seen` принадлежит вызывающему — одному ходу одного агента: так одна и та же
// новость не приходит дважды, а письма не помечаются прочитанными там, где их
// ещё должна увидеть приёмка.
function teamNews(requestId, agent, seen) {
  const board = boards.get(requestId)
  if (!board || !board.items.length) return ''
  const name = resolveName(board, agent) || String(agent || '').trim()
  const flat = text => String(text || '').replace(/\s+/g, ' ').trim()
  const lines = []

  for (const item of board.items) {
    if (item.agent === name) continue
    if (!['done', 'blocked', 'disputed'].includes(item.status)) continue
    const key = `item:${item.id}:${item.status}`
    if (seen.has(key)) continue
    seen.add(key)
    const note = flat(item.note).slice(0, 300)
    lines.push(`- ${item.agent}, пункт ${item.id}: ${STATUS_WORD[item.status]}${note ? ` — ${note}` : ''}`)
  }

  for (const message of board.messages) {
    if (message.to !== name) continue
    const key = `message:${message.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const needsAnswer = ['question', 'objection'].includes(message.kind) && !message.answered
    lines.push(`- Письмо тебе от ${message.from} (${KIND_WORD[message.kind] || message.kind}): ${flat(message.body).slice(0, 300)}` +
      (needsAnswer ? ` — ответь через agent_message с replyTo: ${message.id}` : ''))
  }

  if (!lines.length) return ''
  return `Новости команды, пока ты работаешь:\n${lines.join('\n')}\n\n` +
    'Если это меняет твою часть — учти сейчас, а не в отчёте. Если не меняет — продолжай.'
}

function boardReport(requestId) {
  const board = ensureBoard(requestId)
  if (!board.items.length && !board.messages.length) return ''

  const stuck = board.items.filter(item => item.status === 'blocked' || item.status === 'disputed')
  const untouched = board.items.filter(item => item.status === 'open')
  const hanging = unanswered(requestId)

  const parts = ['## Доска работы\n\n' + board.items.map(itemLine).join('\n')]

  // Приёмка требует от ведущего закрыть незакрытое, поэтому ему надо сказать,
  // чем именно это делается. Без этой строки он видел требование и не знал
  // способа: помощника в этом круге уже не запустят, а чужой пункт ему был не по руке.
  parts.push('На приёмке доска твоя. Проверил чужой пункт сам — закрой его `board_update` со статусом done и скажи в note, чем именно проверил; не сделано — blocked с причиной. На письмо без ответа ответь сам: `agent_message` с kind: "answer" и replyTo — номером письма. Закрывать непроверенное нельзя: это то же самое враньё, только твоё.')

  if (stuck.length) {
    parts.push('### Встало\n\n' + stuck.map(itemLine).join('\n') +
      '\n\nЭто не мелочь на потом. Заблокированное и оспоренное не считается сделанным; разбери каждый пункт прежде, чем называть работу принятой.')
  }
  if (untouched.length) {
    parts.push('### Никто не брал\n\n' + untouched.map(itemLine).join('\n'))
  }
  if (hanging.length) {
    parts.push('### Без ответа\n\n' + hanging.map(messageLine).join('\n') +
      '\n\nНа эти вопросы и возражения никто не ответил. Ответь сам или скажи прямо, что это осталось невыясненным.')
  }

  return parts.join('\n\n')
}

// Чем доска дополняет проверку завершённости: слова агента против состояния
// доски. Пункт, закрытый без единого следа в журнале действий, — ровно тот
// случай, ради которого всё это и писалось.
function recordToolEvidence(requestId, entry) {
  const board = ensureBoard(requestId)
  if (!board.items.length || !entry || (!entry.ok && entry.tool !== 'run_command')) return
  // Preserve compact cross-agent evidence, not tool payloads or secrets.
  board.evidence.push({ tool: entry.tool, agent: entry.agent, path: entry.path, ok: entry.ok === true,
    ...(entry.assignmentId ? { assignmentId: entry.assignmentId } : {}),
    ...(entry.commandTruncated ? { commandTruncated: true } : {}),
    ...(entry.command ? { command: String(entry.command).slice(0, 200) } : {}),
    ...(typeof entry.exitCode === 'number' ? { exitCode: entry.exitCode } : {}) })
  if (board.evidence.length > 4096) board.evidence.shift()
}

// Проект с командой проверки включает замок приёмки; решает главный процесс по рабочим папкам.
function setTestsExpected(requestId, expected) {
  ensureBoard(requestId).testsExpected = Boolean(expected)
}

function boardGaps(requestId, toolLog = []) {
  const board = ensureBoard(requestId)
  const gaps = []

  for (const item of board.items) {
    if (item.status === 'open') gaps.push(`пункт ${item.id} (${item.agent}) никто не взял`)
    if (item.status === 'doing') gaps.push(`пункт ${item.id} (${item.agent}) остался в работе`)
    if (item.status === 'blocked') gaps.push(`пункт ${item.id} (${item.agent}) заблокирован: ${item.note.slice(0, 200)}`)
    if (item.status === 'disputed') gaps.push(`пункт ${item.id} (${item.agent}) оспорен и ответа не было`)
  }

  for (const message of unanswered(requestId)) {
    gaps.push(`${KIND_WORD[message.kind]} от ${message.from} к ${message.to} остался без ответа`)
  }

  // Пункт с правом записи, закрытый как сделанный, хотя ни один инструмент за
  // ход ничего не менял.
  const writes = new Set([
    'write_file', 'edit_file', 'move_path', 'delete_path',
    'dc_write', 'dc_delete', 'dc_html_str_replace', 'dc_js_str_replace', 'dc_set_props', 'dc_set_entry', 'dc_scaffold'
  ])
  const evidence = [...board.evidence, ...(Array.isArray(toolLog) ? toolLog : [])]
  for (const item of board.items.filter(item => item.status === 'done' && item.readOnly === false)) {
    const allowed = new Set([item.agent, item.completedBy, (item.completedBy === COORDINATOR ? COORDINATOR : null)].filter(Boolean))
    const changed = evidence.some(entry => entry && entry.ok && entry.path &&
      writes.has(entry.tool) && allowed.has(entry.agent) && evidenceFor(board, item, entry))
    if (!changed) gaps.push(`пункт ${item.id}: не изменён ни один файл подтверждённым инструментом ${item.agent}; проверь результат отдельно`)
  }

  return gaps
}

module.exports = {
  STATUSES,
  STATUS_WORD,
  KINDS,
  ensureBoard,
  clearBoard,
  boardSnapshot,
  seedBoard,
  reassignItem,
  updateItem,
  postMessage,
  inbox,
  unanswered,
  openItems,
  pendingFor,
  participantsOf,
  resolveName,
  boardBrief,
  boardReport,
  teamNews,
  boardGaps,
  recordToolEvidence,
  setTestsExpected
}
