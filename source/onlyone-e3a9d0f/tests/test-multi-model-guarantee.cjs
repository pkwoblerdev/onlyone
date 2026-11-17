const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const quality = require('../src/main/agent-quality')
const boardApi = require('../src/main/agent-board')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr

const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')

function cut(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a)
  assert(a >= 0 && b > a, 'Not found: ' + from)
  return source.slice(a, b)
}

const declarations = cut('function assignWorkSchema(helperCount)', 'async function runAgentMode')
const assignments = new Map()
// Брифы ролей — данными в ./mode-prompts/team.js, но вырезаются вместе с
// остальными объявлениями: режим подаётся настоящей зависимостью.
const api = new Function('assignmentsByRequest', 'lastUserMessage', 'modePrompts', declarations +
  ';return { recordAssignment, leadBrief, helperBrief, reviewBrief, isCollaborativeRequest }')(
  assignments, p => p.messages.at(-1).content, require('../src/main/mode-prompts'))

const failureReason = new Function('return ' + source.slice(source.indexOf('function failureReason('),
  source.indexOf(String.fromCharCode(10) + '}', source.indexOf('function failureReason(')) + 2))()

const slots = [
  { index: 0, id: 'lead', name: 'Агент 1', modelId: 'chosen-lead-model', modelName: 'GLM-5.3', supportsTools: true },
  { index: 1, id: 'peer2', name: 'Агент 2', modelId: 'helper-model-2:free', modelName: 'Coder-Free', supportsTools: true },
  { index: 2, id: 'peer3', name: 'Агент 3', modelId: 'helper-model-3:free', modelName: 'Reviewer-Free', supportsTools: true }
]

async function runScenario({ userMessage, collaborative = true, simulateSoloLead = true }) {
  const calls = []
  const events = []
  const signal = { aborted: false }
  const requestId = 'req-' + Math.random()

  let leadCallCount = 0
  const runSlot = async (event, slot, payload) => {
    calls.push({ slot, payload })
    if (slot.index === 0) {
      leadCallCount++
      if (leadCallCount === 1) {
        // Агент 1 в первом раунде:
        // Если simulateSoloLead=true, он просто отвечает текстом и НЕ вызывает assign_work
        if (!simulateSoloLead) {
          api.recordAssignment(requestId, {
            assignments: [
              { agent: 2, task: 'Проверь код', acceptance: 'Факты', readOnly: true },
              { agent: 3, task: 'Проверь архитектуру', acceptance: 'Факты', readOnly: true }
            ]
          }, 2)
          return { content: 'Агент 1: делю работу на двоих', answeredModel: slot.modelId }
        }
        return { content: 'Агент 1: вот моё первичное решение задачи', answeredModel: slot.modelId }
      }
      // Финальная приёмка Агента 1
      return { content: 'Агент 1: итоговый синтез с учётом проверок команды', answeredModel: slot.modelId }
    }

    // Для Агента 2 и 3
    if (payload.messages.at(-1)?.content?.includes('найди в этом изъян')) {
      // Круг возражений
      return { content: `${slot.name}: проверил работу коллеги, замечаний нет`, answeredModel: slot.modelId }
    }
    return { content: `${slot.name}: отчёт по проверке — подтверждено по файлам проекта`, answeredModel: slot.modelId }
  }

  const context = {
    resolveAgentSlots: () => slots,
    isCollaborativeRequest: api.isCollaborativeRequest,
    isFreeModel: id => id.endsWith(':free'),
    LEAD_MODEL: 'z-ai/glm-5.3-flash',
    assignmentsByRequest: assignments,
    // Общий бюджет хода (план, 2a) — настоящим модулем.
    createCycle: require('../src/main/agent-cycle').createCycle,
    CRITIQUE_DEADLINE_MS: 120000, PART_DEADLINE_MS: 5 * 60 * 1000,
    leadBrief: api.leadBrief,
    helperBrief: api.helperBrief,
    reviewBrief: api.reviewBrief,
    critiqueBrief: (mine, others) => `Ты ${mine}. Прочитай и найди в этом изъян.`,
    lastUserMessage: p => p.messages.filter(m => m.role === 'user').at(-1).content,
    // Настоящее правило совместимости из исходника.
    readyFor: new Function(source.slice(source.indexOf('function readyFor(item, state)'),
      source.indexOf('function helperAssignmentMessage')) + '; return readyFor')(),
    // Настоящее сообщение помощнику: что именно он видит последним, решает, по
    // чему он строит план.
    helperAssignmentMessage: new Function(source.slice(source.indexOf('function helperAssignmentMessage('),
      source.indexOf('function assignWorkSchema')) + '; return helperAssignmentMessage')(),
    // Отправка события хода — настоящая функция из main.js: без неё вырезанный
    // `runAgentMode` падает на `sendToWindow is not defined` в первом же
    // `stage()`, а подставка скрыла бы ровно ту регрессию, что тут и проверяется.
    sendToWindow: new Function(cut('function sendToWindow(event, channel, body)',
      'async function runAgentMode(event') + '; return sendToWindow')(),
    runAgentSlot: runSlot,
    describeOpenRouterError: e => e,
    failureReason,
    seedBoard: boardApi.seedBoard,
    // Замок приёмки доски, предыстория помощнику и склад отчётов (инициативы 1 и 6): настоящий модуль доски,
    // остальное — имена, которые вырезанный ход должен найти.
    setTestsExpected: boardApi.setTestsExpected, projectHasTests: () => false,
    workspaceRoots: () => [],
    buildPrior: require('../src/main/prior-digest.cjs').buildPrior, rememberReports() {},
    reassignItem: boardApi.reassignItem,
    boardSnapshot: boardApi.boardSnapshot,
    boardBrief: boardApi.boardBrief,
    reviewBoardSection: () => ''
  }

  const run = new Function(...Object.keys(context),
    cut('async function runAgentMode(event', '\n// A tool call written') + ';return runAgentMode')(...Object.values(context))

  const payload = {
    requestId,
    model: 'chosen-lead-model',
    collaborative,
    messages: [{ role: 'user', content: userMessage }]
  }

  const result = await run({ sender: { send: (channel, body) => events.push({ channel, body }) } }, payload, signal)
  return { result, calls, events, leadCallCount }
}

async function test() {
  console.log('--- Тест 1: Гарантия участия нескольких моделей при отсутствии вызова assign_work ---')
  const multi = await runScenario({
    userMessage: 'Разработай функцию валидации данных',
    collaborative: true,
    simulateSoloLead: true
  })

  assert(multi.calls.length > 1, `Ожидалось несколько вызовов, получено: ${multi.calls.length}`)
  
  const participatingAgents = new Set(multi.calls.map(c => c.slot.name))
  assert(participatingAgents.has('Агент 1'), 'Агент 1 должен участвовать')
  assert(participatingAgents.has('Агент 2'), 'Агент 2 должен участвовать')
  assert(participatingAgents.has('Агент 3'), 'Агент 3 должен участвовать')
  assert.equal(participatingAgents.size, 3, 'Все 3 агента должны быть задействованы')

  const stageNames = new Set(multi.result.stages.map(s => s.name))
  assert(stageNames.has('Агент 1'))
  assert(stageNames.has('Агент 2'))
  assert(stageNames.has('Агент 3'))

  assert.equal(multi.result.contributions.length, 2, 'Агент 2 и Агент 3 должны быть в contributions')
  assert(multi.result.contributions.some(c => /^Агент 2(?: · .+)?$/.test(c.name)))
  assert(multi.result.contributions.some(c => /^Агент 3(?: · .+)?$/.test(c.name)))

  for (const call of multi.calls) {
    const prompt = call.payload.customSystemPrompt || ''
    assert(!/глава|босс|начальник/i.test(prompt), 'Запрещены слова глава/босс в промптах')
  }
  for (const event of multi.events) {
    if (event.channel === 'agent-event') {
      assert(!/глава|босс|начальник/i.test(event.body.message), 'Запрещены слова глава/босс в событиях')
    }
  }

  console.log('Тест 1 пройден: несколько моделей успешно работают совместно!')

  console.log('--- Тест 2: Явный запрос одиночной работы (ответь сам) по-прежнему работает solo ---')
  const solo = await runScenario({
    userMessage: 'Ответь сам, без других агентов: сколько будет 2+2?',
    collaborative: true,
    simulateSoloLead: true
  })
  assert.equal(solo.calls.length, 1, 'При явном "ответь сам" должен выполниться ровно 1 вызов')
  assert.equal(solo.calls[0].slot.name, 'Агент 1')
  assert.equal(solo.result.contributions.length, 0, 'В solo режиме не должно быть contributions других агентов')
  console.log('Тест 2 пройден: явный solo запрос корректно исполняется одним агентом!')

  console.log('--- Тест 3: Штатное распределение через assign_work также работает для всех моделей ---')
  const standard = await runScenario({
    userMessage: 'Поработай над задачей',
    collaborative: true,
    simulateSoloLead: false
  })
  assert(standard.calls.length >= 4, 'Штатное распределение задействует команду')
  const standardAgents = new Set(standard.calls.map(c => c.slot.name))
  assert(standardAgents.has('Агент 1') && standardAgents.has('Агент 2') && standardAgents.has('Агент 3'))
  console.log('Тест 3 пройден: штатное распределение работает отлично!')

  console.log('\nВсе проверки гарантированного мультимодельного агент-режима успешно пройдены!')
}

test().catch(err => {
  console.error('ПРОВАЛ:', err)
  process.exit(1)
})
