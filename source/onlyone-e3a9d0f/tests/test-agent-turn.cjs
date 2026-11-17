// Целый ход команды, от раздачи работы до итога, на настоящем коде.
//
// До этого агент-режим проверялся по частям: отдельно доска, отдельно раздача
// поручений, отдельно цикл вызовов. Между частями и живут те дефекты, ради
// которых всё затевалось: помощник закрывает пункт, критик возражает, автора
// в этом круге уже не запустят — и приёмка требует от ведущего закрыть то,
// чего он закрыть не может.
//
// Провайдера здесь нет. Вместо него — сценарий: каждый агент делает ровно то,
// что делала бы модель, через настоящие функции доски. Проверяется не текст
// ответа, а то, чем ход кончается: что попадает ведущему, что остаётся
// незакрытым и что видит пользователь.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8')
const boardApi = require('../src/main/agent-board')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr

const cut = (from, to) => {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  assert(a >= 0 && b > a, 'не найдена область: ' + from)
  return source.slice(a, b)
}

const isAssignment = p => /^Твоя часть работы/.test(String(p.payload.messages.at(-1).content))
// Круг возражений узнаётся по настоящему тексту critiqueBrief, а не по слову,
// которое в нём когда-то было: первая версия проверки искала «Возражения», а в
// брифе стоит «ВОЗРАЖЕНИЕ», и сценарий молча шёл не по той ветке.
const isCritique = payload => /найди в этом изъян/.test(String(payload.messages.at(-1).content))
const assignments = new Map()
const api = new Function('assignmentsByRequest', 'lastUserMessage', 'boardReport', 'modePrompts',
  cut('function assignWorkSchema(helperCount)', 'async function runAgentMode') +
  ';return { recordAssignment, leadBrief, helperBrief, critiqueBrief, reviewBrief, reviewBoardSection, failureReason, isCollaborativeRequest }'
)(assignments, payload => payload.messages.filter(m => m.role === 'user').at(-1).content, boardApi.boardReport,
  require('../src/main/mode-prompts'))

let failed = 0
let total = 0
const check = (name, ok, detail) => {
  total++
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

// Слоты как в приложении: ведущий на выбранной модели, двое помощников.
const slots = [
  { index: 0, name: 'Агент 1', modelId: 'lead-model', modelName: 'Lead', supportsTools: true, role: 'lead' },
  { index: 1, name: 'Агент 2', modelId: 'helper-a', modelName: 'Dots3', supportsTools: true, role: 'general' },
  { index: 2, name: 'Агент 3', modelId: 'helper-b', modelName: 'GLM', supportsTools: true, role: 'general' }
]

// Сценарий одного хода. Каждая запись — что этот агент делает, когда до него
// доходит очередь: те же вызовы доски, что сделала бы модель.
function runTurn(script, extra = {}, options = {}) {
  const requestId = 'turn-' + Math.random().toString(36).slice(2)
  const events = []
  const phaseTrace = []
  const runContext = {
    currentPhase: null,
    transition(phase) { this.currentPhase = phase; phaseTrace.push(phase) }
  }
  const event = { sender: { send: (channel, body) => events.push({ channel, body }) } }

  const calls = new Map()
  // Сколько частей одновременно ведёт каждый агент. Больше одной — это одна
  // модель с двумя ходами сразу и перемешанным выводом.
  const active = new Map()
  const peak = new Map()
  const payloads = []

  const runAgentSlot = async (_event, slot, payload, slotSignal) => {
    payloads.push({ slot: slot.name, payload })
    active.set(slot.name, (active.get(slot.name) || 0) + 1)
    peak.set(slot.name, Math.max(peak.get(slot.name) || 0, active.get(slot.name)))
    // Настоящий runAgentSlot обрывается по сигналу: запрос к провайдеру отменяется
    // и ход агента кончается ошибкой. Без этого прерванная по сроку часть висела
    // бы в тесте вечно — и проверка срока проверяла бы саму себя.
    const stopped = new Promise((_, reject) => {
      if (!slotSignal) return
      if (slotSignal.aborted) return reject(new Error('Ход прерван'))
      slotSignal.addEventListener?.('abort', () => reject(new Error('Ход прерван')), { once: true })
    })
    try {
      if (slot.index > 0) {
        const said = String(payload.messages?.at(-1)?.content || '')
        await Promise.race([
          new Promise(resolve => setTimeout(resolve, options.delayFor ? options.delayFor(said, slot) : 15)),
          stopped
        ])
      }
      return await Promise.race([runStep(slot, payload), stopped])
    } finally {
      active.set(slot.name, active.get(slot.name) - 1)
    }
  }

  const runStep = async (slot, payload) => {
    const step = script[slot.name]
    if (!step) return { content: `${slot.name}: нечего делать`, ok: true }
    const turn = (calls.get(slot.name) || 0) + 1
    calls.set(slot.name, turn)
    if (step.throws) throw new Error(step.throws)
    const seen = String(payload.customSystemPrompt || '')
    const said = String(payload.messages?.at(-1)?.content || '')
    step.sawBoard = step.sawBoard || /Доска работы/.test(seen)
    step.sawLetters = step.sawLetters || /Письма тебе/.test(seen)
    step.sawReport = step.sawReport || /Доска работы/.test(said)
    if (typeof step.act === 'function') step.act(requestId, slot, turn)
    return step.result ? step.result(payload, turn) : { content: step.content ?? `${slot.name}: отчёт`, ok: true }
  }

  const context = {
    resolveAgentSlots: () => slots,
    isCollaborativeRequest: api.isCollaborativeRequest,
    isFreeModel: () => false,
    LEAD_MODEL: 'lead-model',
    assignmentsByRequest: assignments,
    // Общий бюджет хода (план, 2a): круги переделки тратят его вместе с
    // продлениями приёмки. Настоящий модуль, не подставный.
    createCycle: require('../src/main/agent-cycle').createCycle,
    CRITIQUE_DEADLINE_MS: 120000,
    // Срок части в сценарии можно укоротить: ждать пять минут в тесте незачем.
    PART_DEADLINE_MS: options.partDeadlineMs || 5 * 60 * 1000,
    leadBrief: api.leadBrief,
    helperBrief: api.helperBrief,
    critiqueBrief: api.critiqueBrief,
    reviewBrief: api.reviewBrief,
    reviewBoardSection: api.reviewBoardSection,
    failureReason: api.failureReason,
    lastUserMessage: p => p.messages.filter(m => m.role === 'user').at(-1).content,
    // Настоящее правило совместимости: его собственные проверки живут в
    // test-agent-waves, а здесь важно, что ход с ним работает.
    readyFor: new Function(source.slice(source.indexOf('function readyFor(item, state)'),
      source.indexOf('function helperAssignmentMessage')) + '; return readyFor')(),
    // Настоящее сообщение помощнику: что именно он видит последним, решает, по
    // чему он строит план.
    helperAssignmentMessage: new Function(source.slice(source.indexOf('function helperAssignmentMessage('),
      source.indexOf('function assignWorkSchema')) + '; return helperAssignmentMessage')(),
    // Отправка события хода — настоящая функция из main.js, той же вырезкой, что
    // и `readyFor`: без неё вырезанный `runAgentMode` падает на
    // `sendToWindow is not defined` в первом же `stage()`, и подставка здесь
    // спрятала бы регрессию, которую как раз и нужно видеть.
    sendToWindow: new Function(cut('function sendToWindow(event, channel, body)',
      'async function runAgentMode(event') + '; return sendToWindow')(),
    runAgentSlot,
    describeOpenRouterError: e => String(e),
    seedBoard: boardApi.seedBoard,
    // Замок приёмки доски, предыстория помощнику и склад отчётов (инициативы 1 и 6): настоящий модуль доски,
    // остальное — имена, которые вырезанный ход должен найти.
    setTestsExpected: boardApi.setTestsExpected, projectHasTests: () => false,
    workspaceRoots: () => [],
    buildPrior: require('../src/main/prior-digest.cjs').buildPrior, rememberReports() {},
    reassignItem: boardApi.reassignItem,
    boardSnapshot: boardApi.boardSnapshot,
    boardBrief: boardApi.boardBrief
  }

  const run = new Function(...Object.keys(context),
    cut('async function runAgentMode(event', '\n// A tool call written') + ';return runAgentMode'
  )(...Object.values(context))

  return run(event, { requestId, model: 'lead-model', speedMode: 'standard',
    messages: [{ role: 'user', content: 'Работай вместе с другими моделями над разбором отмены' }],
    runContext, ...extra }, {})
    .then(result => ({ result, events, requestId, peak, payloads, phaseTrace }))
}

async function main() {
  // --- обычный ход: раздали, сделали, приняли --------------------------------
  {
    const script = {
      'Агент 1': {
        act: (requestId, _slot, turn) => turn === 1 && api.recordAssignment(requestId, {
          assignments: [
            { agent: 2, task: 'Прочитать цикл отмены', acceptance: 'Описание', readOnly: true },
            { agent: 3, task: 'Починить разбор аргументов', acceptance: 'Тест', readOnly: false }
          ]
        }, 2),
        content: 'Раздал работу'
      },
      'Агент 2': {
        act: (requestId, _slot, turn) => turn === 1 && boardApi.updateItem(requestId, 'Агент 2',
          { id: 't1', status: 'done', note: 'Прочитал src/main/main.js, описал цикл отмены' }),
        content: 'Цикл отмены разобран'
      },
      'Агент 3': {
        act: (requestId, _slot, turn) => turn === 1 && boardApi.updateItem(requestId, 'Агент 3',
          { id: 't2', status: 'done', note: 'Поправил разбор, tests/test-tool-protocol.cjs проходит' }),
        content: 'Разбор починен'
      }
    }
    const { result, requestId } = await runTurn(script)

    check('ход команды доходит до итога', result.ok === true, result.error)
    check('итог принадлежит ведущему', /Раздал работу|отчёт/.test(String(result.content)))
    check('вклад помощников сохранён', (result.contributions || []).length === 2)
    check('помощник видит доску в поручении', script['Агент 2'].sawBoard === true)
    check('ведущий видит доску в приёмке', script['Агент 1'].sawReport === true)
    check('критик тоже получает доску', script['Агент 3'].sawBoard === true)

    const board = boardApi.boardSnapshot(requestId)
    check('доска завелась из поручений', board.items.length === 2)
    check('оба пункта закрыты', board.items.every(item => item.status === 'done'),
      board.items.map(i => i.id + ':' + i.status).join(', '))
    check('после закрытых пунктов приёмке не к чему придраться',
      boardApi.boardGaps(requestId, [{ tool: 'write_file', ok: true, path: 'a.js', agent: 'Агент 3' }]).length === 0,
      boardApi.boardGaps(requestId, []).join(' | '))
    boardApi.clearBoard(requestId)
  }

  // --- возражение: круг спора и его последствия -------------------------------
  {
    const script = {
      'Агент 1': {
        act: (requestId, _slot, turn) => turn === 1 && api.recordAssignment(requestId, {
          assignments: [
            { agent: 2, task: 'Починить разбор', acceptance: 'Тест', readOnly: false },
            { agent: 3, task: 'Проверить правку', acceptance: 'Отчёт', readOnly: true }
          ]
        }, 2),
        content: 'Раздал работу'
      },
      'Агент 2': {
        act: (requestId, _slot, turn) => turn === 1 && boardApi.updateItem(requestId, 'Агент 2',
          { id: 't1', status: 'done', note: 'Поправил разбор пустой строки, проверил вручную' }),
        content: 'Готово'
      },
      'Агент 3': {
        act: (requestId, _slot, turn) => turn === 1 && boardApi.postMessage(requestId, 'Агент 3',
          { to: 'Агент 2', kind: 'objection', about: 't1',
            body: 'Правка не закрывает случай обрезанных аргументов' }),
        content: 'Нашёл изъян'
      }
    }
    const { result, requestId, events } = await runTurn(script)

    const board = boardApi.boardSnapshot(requestId)
    check('возражение снимает пункт с «сделано»',
      board.items[0].status === 'disputed', board.items[0].status)
    check('спор не остаётся без следа для ведущего',
      boardApi.boardGaps(requestId, []).some(g => /оспорен|без ответа/.test(g)),
      boardApi.boardGaps(requestId, []).join(' | '))
    check('ведущий может закрыть спор сам',
      boardApi.postMessage(requestId, 'Агент 1', { to: 'Агент 3', kind: 'answer',
        body: 'Проверил возражение, случай закрыт отдельной правкой' }).success === true)
    check('ход всё равно завершается', result.ok === true)
    check('пользователь видит, что шёл спор',
      events.some(e => e.channel === 'agent-event' && /Круг возражений/.test(String(e.body?.message))))
    boardApi.clearBoard(requestId)
  }

  // --- помощник упал: причина доезжает до ведущего и до окна -------------------
  {
    const script = {
      'Агент 1': {
        act: (requestId, _slot, turn) => turn === 1 && api.recordAssignment(requestId, {
          assignments: [{ agent: 2, task: 'Починить разбор', acceptance: 'Тест', readOnly: false }]
        }, 2),
        content: 'Раздал работу'
      },
      'Агент 2': { throws: 'Rate limit exceeded — провайдер Chutes (код 429) [glm:free]' }
    }
    const { result, events, requestId } = await runTurn(script)

    const said = events.filter(e => e.channel === 'agent-event').map(e => String(e.body?.message)).join(' | ')
    check('настоящая причина падения видна пользователю',
      /Rate limit exceeded/.test(said), said.slice(0, 160))
    check('заглушка про статус 0 больше не появляется', !/статус 0/.test(said))
    check('упавший помощник не роняет ход', result.ok === true || Boolean(result.content))
    check('его пункт остаётся незакрытым',
      boardApi.boardGaps(requestId, []).some(g => /t1/.test(g)),
      boardApi.boardGaps(requestId, []).join(' | '))
    boardApi.clearBoard(requestId)
  }

  // --- ведущий оборвался: работа помощников не пропадает ----------------------
  {
    let round = 0
    const script = {
      'Агент 1': {
        act: (requestId, _slot, turn) => {
          round = turn
          if (turn === 1) {
            api.recordAssignment(requestId, {
              assignments: [{ agent: 2, task: 'Разобрать отмену', acceptance: 'Описание', readOnly: true }]
            }, 2)
            return
          }
          // Второй круг: связь отвалилась ровно там, где ведущий должен был
          // принять работу.
          throw new Error('Не удалось связаться с OpenRouter: fetch failed')
        },
        content: 'Раздал работу'
      },
      'Агент 2': { content: 'Отмена разобрана: сигнал доходит до цикла вызовов' }
    }
    const { result, events } = await runTurn(script)

    check('обрыв ведущего не уносит ход целиком', typeof result === 'object')
    // Живой прогон: команда отработала полторы минуты, ведущий упал на приёмке
    // с «Service temporarily overloaded», и вся работа превратилась в
    // предупреждение. Материал к этому моменту собран — собрать из него итог
    // может любой помощник с инструментами.
    check('приёмку подхватывает помощник', result.ok === true, JSON.stringify(result.ok))
    check('подмена названа вслух',
      events.some(e => e.channel === 'agent-event' && /переходит к Агент 2/.test(String(e.body?.message))))
    check('сделанное помощником не пропало',
      /Отмена разобрана/.test(String(result.content)), String(result.content).slice(0, 120))
  }

  // --- некому подхватить: провал называется провалом --------------------------
  {
    const script = {
      'Агент 1': {
        act: (requestId, _slot, turn) => {
          if (turn === 1) {
            api.recordAssignment(requestId, {
              assignments: [{ agent: 2, task: 'Разобрать отмену', acceptance: 'Описание', readOnly: true }]
            }, 2)
            return
          }
          throw new Error('Не удалось связаться с OpenRouter: fetch failed')
        },
        content: 'Раздал работу'
      },
      'Агент 2': {
        result: (payload) => {
          // Помощник сдал свою часть, но подхватить работу ведущего не смог:
          // у провайдера отказала и его модель. Работу ведущего видно по тому,
          // что вместе с ней даётся право раздавать поручения.
          if (payload.canAssign || /Лимит делегирования достигнут/.test(String(payload.messages.at(-1).content))) {
            throw new Error('Не удалось связаться с OpenRouter: fetch failed')
          }
          return { ok: true, content: 'Отмена разобрана: сигнал доходит до цикла вызовов' }
        }
      }
    }
    const { result, events } = await runTurn(script)

    check('когда подхватить некому, провал назван провалом', result.ok === false, JSON.stringify(result.ok))
    check('причина обрыва дошла до ответа',
      /fetch failed/.test(String(result.error)) || /fetch failed/.test(String(result.content)),
      String(result.error))
    check('сделанное помощником не пропало и в провале',
      /Отмена разобрана/.test(String(result.content)), String(result.content).slice(0, 120))
    check('вторая неудача тоже названа',
      events.some(e => e.channel === 'agent-event' && /тоже не состоялась/.test(String(e.body?.message))))
  }

  // --- провал предпосылки не запускает зависимую часть --------------------------
  for (const mode of ['failed', 'error', 'empty', 'not-ok']) {
    const helper = {
      result: payload => {
        const said = String(payload.messages.at(-1).content)
        if (/«Разведка»/.test(said)) {
          if (mode === 'error') throw new Error('upstream unavailable')
          if (mode === 'empty') return { ok: true, content: '' }
          return { ok: mode !== 'not-ok', failed: mode === 'failed', content: 'Часть не выполнена' }
        }
        return { ok: true, content: 'Отчёт' }
      }
    }
    const { payloads, events, requestId } = await runTurn({
      'Агент 1': {
        act: (id, _slot, turn) => turn === 1 && api.recordAssignment(id, {
          assignments: [
            { agent: 2, title: 'Разведка', task: 'Прочитать цикл отмены', acceptance: 'Описание', readOnly: true },
            { agent: 3, title: 'Проверка', task: 'Проверить выводы разведки', acceptance: 'Вердикт', readOnly: true, after: [2] }
          ]
        }, 2),
        content: 'Есть заблокированные части'
      },
      'Агент 2': helper, 'Агент 3': helper
    })
    const assigned = payloads.filter(isAssignment)
    check(`провал предпосылки не запускает зависимую часть: ${mode}`,
      assigned.length === 1 && /«Разведка»/.test(assigned[0].payload.messages.at(-1).content))
    check(`блокировка зависимой части видна пользователю: ${mode}`,
      events.filter(e => e.channel === 'agent-event' && /заблокирован: не завершены предпосылки/.test(e.body.message)).length === 1)
    boardApi.clearBoard(requestId)
  }

  // --- без возражений второго круга не бывает ---------------------------------
  //
  // Круг спора кончился словами «возражений нет», все части сданы. Второй заход
  // ведущего в этом случае стоит целого хода и не приносит ничего: поручать
  // нечего. Проверяем, что ведущий приходит ровно дважды — раздать и принять,
  // а помощники работают по одному разу плюс проверка чужого.
  {
    const script = {
      'Агент 1': {
        act: (requestId, _slot, turn) => turn === 1 && api.recordAssignment(requestId, {
          assignments: [
            { agent: 2, task: 'Прочитать разбор аргументов', acceptance: 'Описание', readOnly: true },
            { agent: 3, task: 'Прочитать цикл отмены', acceptance: 'Описание', readOnly: true }
          ]
        }, 2),
        content: 'Раздал работу'
      },
      'Агент 2': { result: payload => ({ ok: true,
        content: isCritique(payload) ? 'Возражений нет: прочитал отчёт Агента 3' : 'Разбор готов' }) },
      'Агент 3': { result: payload => ({ ok: true,
        content: isCritique(payload) ? 'Возражений нет: прочитал отчёт Агента 2' : 'Отмена разобрана' }) }
    }
    const { result, payloads, events, requestId } = await runTurn(script)
    const leadTurns = payloads.filter(p => p.slot === 'Агент 1')

    check('ход без возражений доходит до итога', result.ok === true, result.error)
    check('ведущий не идёт на второй круг зря', leadTurns.length === 2, 'ведущего звали: ' + leadTurns.length)
    check('второй ход ведущего — приёмка, а не новая раздача',
      leadTurns[1]?.payload.canAssign === false &&
      /Лимит делегирования достигнут/.test(String(leadTurns[1]?.payload.messages.at(-1).content)),
      'canAssign=' + leadTurns[1]?.payload.canAssign)
    check('помощникам не раздают работу второй раз',
      payloads.filter(isAssignment).length === 2,
      'поручений: ' + payloads.filter(isAssignment).length)
    check('переход к приёмке объявлен',
      events.some(e => e.channel === 'agent-event' && /перехожу к приёмке/.test(String(e.body?.message))))
    boardApi.clearBoard(requestId)
  }

  // --- возражение по-прежнему открывает второй круг ----------------------------
  {
    const script = {
      'Агент 1': {
        act: (requestId, _slot, turn) => turn === 1 && api.recordAssignment(requestId, {
          assignments: [
            { agent: 2, task: 'Прочитать разбор аргументов', acceptance: 'Описание', readOnly: true },
            { agent: 3, task: 'Прочитать цикл отмены', acceptance: 'Описание', readOnly: true }
          ]
        }, 2),
        content: 'Раздал работу'
      },
      'Агент 2': { result: payload => ({ ok: true,
        content: isCritique(payload) ? 'ВОЗРАЖЕНИЕ. Разбор не покрывает пустой ввод' : 'Разбор готов' }) },
      'Агент 3': { result: payload => ({ ok: true,
        content: isCritique(payload) ? 'Возражений нет: прочитал отчёт Агента 2' : 'Отмена разобрана' }) }
    }
    const { payloads, requestId } = await runTurn(script)
    const leadTurns = payloads.filter(p => p.slot === 'Агент 1')
    check('после возражения ведущий может раздать доработку',
      leadTurns.length === 2 && leadTurns[1]?.payload.canAssign === true,
      'ходов ведущего: ' + leadTurns.length + ', canAssign=' + leadTurns[1]?.payload.canAssign)
    check('возражение доходит до ведущего',
      /пустой ввод/.test(String(leadTurns[1]?.payload.messages.at(-1).content)))
    boardApi.clearBoard(requestId)
  }

  // --- ведущий не раздал работу: делим сами, но не клонами ----------------------
  //
  // Слабая модель игнорирует принудительный assign_work. Тогда раздача строится
  // здесь — и это её единственное оправдание: если каждому выдать одно и то же
  // «проанализируй решение», человек получит два-три одинаковых чек-листа.
  {
    const { payloads, events, requestId } = await runTurn({
      'Агент 1': { content: 'Отвечу сам' },
      'Агент 2': { content: 'Проверил по коду' },
      'Агент 3': { content: 'Разобрал края' }
    })
    const assigned = payloads.filter(isAssignment).map(p => String(p.payload.messages.at(-1).content))
    check('запасная раздача не оставляет помощников без дела', assigned.length === 2, 'частей: ' + assigned.length)
    check('части запасной раздачи не копируют друг друга',
      assigned.length === 2 && assigned[0] !== assigned[1])
    check('в запасной раздаче нет безымянных «частей»',
      !assigned.some(said => /Анализ части/.test(said)))
    check('раздача названа своим именем',
      events.some(e => e.channel === 'agent-event' && /Ведущий не раздал работу/.test(String(e.body?.message))))
    boardApi.clearBoard(requestId)
  }

  // --- ведущий упал сразу: подменный раздаёт работу и молчит -------------------
  //
  // Ровно то, что случилось на живых моделях: ведущий отказал на первой же
  // реплике («Service temporarily overloaded»), работу подхватил помощник,
  // раздал поручения — и ход оборвался, потому что раздача без слов считалась
  // провалом подмены. Раздал — значит сработал.
  {
    const script = {
      'Агент 1': { throws: 'Upstream error from Nvidia: Service temporarily overloaded' },
      'Агент 2': {
        // Подменный ведущий: раздаёт работу и ничего не говорит.
        act: (requestId, _slot, turn) => turn === 1 && api.recordAssignment(requestId, {
          assignments: [{ agent: 3, task: 'Посчитать строки', acceptance: 'Число', readOnly: true }]
        }, 2),
        result: (_payload, turn) => turn === 1 ? { ok: true, content: '' } : { ok: true, content: 'Итог собран' }
      },
      'Агент 3': { content: 'Строк 51' }
    }
    const { result, payloads, events, requestId } = await runTurn(script)

    check('подменный ведущий раздаёт работу, и она выполняется',
      payloads.some(p => p.slot === 'Агент 3' && isAssignment(p)),
      payloads.map(p => p.slot).join(', '))
    check('молчание подменного не считается провалом', result.ok === true, String(result.error))
    check('работа помощника дошла до ответа',
      /Строк 51/.test(String(result.content)) || (result.contributions || []).some(c => /Строк 51/.test(String(c.body))),
      String(result.content).slice(0, 160))
    check('ход не жалуется на упавшего ведущего, когда его подменили',
      !/Агент 1 оборвался/.test(String(result.content)), String(result.content).slice(0, 160))
    check('подмена объявлена', events.some(e => /переходит к Агент 2/.test(String(e.body?.message))))
    boardApi.clearBoard(requestId)
  }

  // --- часть, которая не кончается, обрывается по сроку ------------------------
  //
  // Живой прогон «Ревью» на GLM: этап «Безопасность» двенадцать минут перечитывал
  // main.js и app.js по кругу. Ход не кончился вовсе — ни итога, ни работы двух
  // других этапов, которые своё уже сдали.
  {
    const script = {
      'Агент 1': {
        act: (requestId, _slot, turn) => turn === 1 && api.recordAssignment(requestId, {
          assignments: [
            { agent: 2, task: 'Бесконечное чтение', acceptance: 'Отчёт', readOnly: true },
            { agent: 3, task: 'Посчитать строки', acceptance: 'Число', readOnly: true }
          ]
        }, 2),
        content: 'Раздал работу'
      },
      // Никогда не отвечает: ровно то, что делала живая модель.
      'Агент 2': { result: () => new Promise(() => {}) },
      'Агент 3': { content: 'Строк 51' }
    }
    const { result, events, requestId } = await runTurn(script, {}, { partDeadlineMs: 200 })

    check('ход кончается, даже если часть не отвечает', result.ok === true || Boolean(result.content),
      String(result.error))
    check('просроченная часть названа вслух',
      events.some(e => e.channel === 'agent-event' && /не уложилась в \d+ мин/.test(String(e.body?.message))))
    check('работа других частей не пропала',
      (result.contributions || []).some(entry => /Строк 51/.test(String(entry.body))),
      JSON.stringify((result.contributions || []).map(entry => entry.name)))
    check('просроченная часть помечена несданной',
      (result.contributions || []).some(entry => entry.failed && /не уложилась/.test(String(entry.body))),
      JSON.stringify((result.contributions || []).map(entry => [entry.name, entry.failed])))
    boardApi.clearBoard(requestId)
  }

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })
