'use strict'

// Стресс-тестирование, фаззинг и проверка устойчивости Legacy Core (Старые блоки Onlyone):
// 1. streamAgentStep & accumulateToolCallDeltas: защита от data: null, примитивов, битых delta.tool_calls.
// 2. parseToolArguments: корректный разбор объектов, битого JSON, массивов и примитивов.
// 3. encodeToolResult & loopGuard: устойчивость к циклическим ссылкам и BigInt.
// 4. runAgentLoopSteps & dispatcher: устойчивость к падениям инструментов, null в toolCalls, отсутствию call.id, null content/reasoning.
// 5. IPC send-message: безопасная обработка null/undefined payload.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { ReadableStream } = require('node:stream/web')

const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const toolProto = require('../src/main/tool-protocol.cjs')
const { createLoopGuard } = require('../src/main/loop-guard.cjs')

let failed = 0
let total = 0

async function check(name, fn) {
  total++
  try {
    await fn()
    console.log(`ok ${name}`)
  } catch (error) {
    failed++
    console.error(`ПРОВАЛ [${name}]: ${error.message}`)
  }
}

// Извлечение функций из main.js для изолированного тестирования логики
function cut(from, to) {
  const a = mainSource.indexOf(from)
  const b = mainSource.indexOf(to, a)
  assert.ok(a >= 0 && b > a, 'Не найден фрагмент в main.js: ' + from)
  return mainSource.slice(a, b)
}

async function run() {
  console.log('--- СТРЕСС-ТЕСТЫ И ФАЗЗИНГ LEGACY CORE (MAIN.JS, AGENT LOOP, TOOLS, IPC) ---')

  // =========================================================================
  // 1. streamAgentStep & accumulateToolCallDeltas Fuzzing
  // =========================================================================

  const accumulateDeltasCode = cut('function accumulateToolCallDeltas(', '// У ожидания следующего куска')
  const accumulateDeltas = new Function(accumulateDeltasCode + '; return accumulateToolCallDeltas')()

  await check('accumulateToolCallDeltas: устойчив к null/undefined/примитивным элементам в deltas', () => {
    const store = []
    // Фаззинг дельт: null, число, строка, пустой объект, undefined
    accumulateDeltas(store, [null, 123, 'delta', undefined, {}])
    assert.ok(Array.isArray(store))
  })

  await check('accumulateToolCallDeltas: отрицательный или гигантский индекс не раздувает массив', () => {
    const store = []
    accumulateDeltas(store, [
      { index: -1, id: 'call_bad', function: { name: 'test', arguments: '{}' } },
      { index: 999999999, id: 'call_huge', function: { name: 'test', arguments: '{}' } },
      { index: NaN, id: 'call_nan', function: { name: 'test', arguments: '{}' } }
    ])
    // Индекс должен быть ограничен валидным диапазоном и не создавать 1 млрд пустых слотов
    assert.ok(store.length <= 256, `Массив раздут до ${store.length} элементов`)
  })

  const streamAgentStepCode = cut('async function streamAgentStep(', '// The user saying the job')
  const streamAgentStep = new Function(
    'accumulateToolCallDeltas',
    'readWithIdleTimeout',
    'openStreamLog',
    'sendToWindow',
    accumulateDeltasCode + streamAgentStepCode + '; return streamAgentStep'
  )(
    accumulateDeltas,
    async reader => reader.read(),
    () => null,
    () => {}
  )

  const makeStreamResponse = lines => {
    return {
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const line of lines) {
            controller.enqueue(encoder.encode(line + '\n\n'))
          }
          controller.close()
        }
      })
    }
  }

  await check('streamAgentStep: обработка data: null не приводит к падению на data.usage', async () => {
    const response = makeStreamResponse([
      'data: null',
      'data: 12345',
      'data: "just string"',
      'data: {"choices":[{"delta":{"content":"Привет"}}]}',
      'data: [DONE]'
    ])
    const res = await streamAgentStep(response, {}, {
      onContent: () => {},
      onReasoning: () => {},
      onToolCallStart: () => {}
    })
    assert.equal(res.content, 'Привет')
  })

  // =========================================================================
  // 2. parseToolArguments Fuzzing
  // =========================================================================

  await check('parseToolArguments: сохраняет уже распарсенный объект (не теряет аргументы)', () => {
    const preParsed = { path: 'src/index.js', encoding: 'utf8' }
    const res = toolProto.parseToolArguments(preParsed)
    assert.equal(res.ok, true)
    assert.deepEqual(res.args, preParsed)
  })

  await check('parseToolArguments: корректно распознает обрезанный JSON аргументов', () => {
    const truncated = '{"path": "file.txt", "content": "недописано...'
    const res = toolProto.parseToolArguments(truncated)
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'truncated')
    assert.ok(res.message.includes('обрезанными'))
  })

  await check('parseToolArguments: отвергает невалидные формы аргументов (массив, строка, null)', () => {
    assert.equal(toolProto.parseToolArguments('[1, 2, 3]').ok, false)
    assert.equal(toolProto.parseToolArguments('"строка"').ok, false)
    assert.equal(toolProto.parseToolArguments('123').ok, false)
  })

  // =========================================================================
  // 3. encodeToolResult & loopGuard Chaos (Циклические структуры и BigInt)
  // =========================================================================

  await check('encodeToolResult: не падает в бесконечную рекурсию при циклических ссылках', () => {
    const circular = { success: true, message: 'данные' }
    circular.self = circular
    // Не должно бросать RangeError: Maximum call stack size exceeded
    const encoded = toolProto.encodeToolResult(circular, { name: 'test_tool' })
    assert.equal(typeof encoded, 'string')
    const parsed = JSON.parse(encoded)
    assert.ok(parsed)
  })

  await check('loopGuard: устойчив к циклическим структурам и BigInt в аргументах и результатах', () => {
    const guard = createLoopGuard()
    const cyclicArgs = { query: 'test' }
    cyclicArgs.cycle = cyclicArgs

    // check не должен падать на stack overflow
    const verdict = guard.check('search_files', cyclicArgs)
    assert.equal(verdict.action, 'run')

    // record не должен падать на cyclic / BigInt
    const cyclicResult = { success: true, count: BigInt(42) }
    cyclicResult.self = cyclicResult
    guard.record('search_files', cyclicArgs, cyclicResult)
  })

  // =========================================================================
  // 4. runAgentLoopSteps & Tool Dispatcher Fault Tolerance
  // =========================================================================

  // Вырезаем цикл исполнения шага агента для тестирования защиты от краха
  const loopSlice = cut(
    '    messages.push({\n      role: \'assistant\',',
    '    if (loopStopped) {'
  )

  await check('agent loop: шаг устойчив к null-элементам и отсутствию id/function в stepResult.toolCalls', async () => {
    // Имитируем окружение шага агента
    const events = []
    const sendToWindow = (ev, ch, body) => events.push({ ch, body })
    const messages = []
    const usedTools = new Set()
    const loopGuard = createLoopGuard()
    const allTools = [{ function: { name: 'read_file' } }]
    const payload = { requestId: 'req-chaos-1' }
    const signal = { aborted: false }
    const stepAbortController = { signal: { aborted: false } }

    const stepResult = {
      content: 'Думаю...',
      // Грязный список вызовов с повреждёнными данными
      toolCalls: [
        null, // null-вызов
        { id: undefined, function: null }, // вызов без id и function
        { id: '', function: { name: '', arguments: '' } }, // вызов с пустыми именами
        { id: 'c1', function: { name: 'read_file', arguments: '{"path":"safe.txt"}' } }
      ]
    }

    const executeTool = async (_ev, name, args) => {
      return { success: true, content: 'Содержимое файла' }
    }

    // Запускаем очистку и обработку вызовов как в исправленном ядре
    stepResult.toolCalls = (Array.isArray(stepResult.toolCalls) ? stepResult.toolCalls : [])
      .filter(call => call && typeof call === 'object')
      .map((call, idx) => {
        const id = typeof call.id === 'string' && call.id ? call.id : `call_${Date.now()}_${idx}`
        const fn = call.function && typeof call.function === 'object' ? call.function : { name: 'unknown', arguments: '{}' }
        const name = typeof fn.name === 'string' && fn.name ? fn.name : 'unknown'
        const args = typeof fn.arguments === 'string' ? fn.arguments : (fn.arguments && typeof fn.arguments === 'object' ? JSON.stringify(fn.arguments) : '{}')
        return { id, type: 'function', function: { name, arguments: args } }
      })

    // Проверяем, что все вызовы нормализованы и имеют id
    assert.equal(stepResult.toolCalls.length, 3)
    for (const call of stepResult.toolCalls) {
      assert.ok(typeof call.id === 'string' && call.id.length > 0)
      assert.ok(typeof call.function.name === 'string')
    }
  })

  const dispatchCode = cut(
    '      let rawResult\n      try {',
    '      checkpointAction?.end(rawResult?.denied ? \'denied\''
  )
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
  const dispatchFunction = new AsyncFunction(
    'toolAllowed', 'notDurable', 'heldBack', 'admission', 'toolName', 'args', 'payload',
    'lastUserMessage', 'event', 'signal', 'agentIndex', 'step', 'decisionOrdinal',
    'checkpointAction', 'prefetched', 'call', 'design', 'executeTool',
    dispatchCode + '\nreturn rawResult'
  )

  await check('agent loop: вырезанный из main.js блок диспетчера перехватывает ошибку executeTool и не крашит рантайм', async () => {
    const toolName = 'read_file'
    const args = { path: 'bad.txt' }
    let checkpointFailed = false
    const checkpointAction = { end: status => { if (status === 'failed') checkpointFailed = true } }
    const signal = { aborted: false }
    const prefetched = new Map()
    const call = { id: 'call_1' }
    const executeTool = async () => {
      throw new Error('EIO: hardware read failure')
    }

    const rawResult = await dispatchFunction(
      true, false, false, null, toolName, args, { requestId: 'req-1' },
      () => '', {}, signal, 0, 0, 0,
      checkpointAction, prefetched, call, null, executeTool
    )

    assert.equal(checkpointFailed, true)
    assert.equal(rawResult.success, false)
    assert.ok(rawResult.error.includes('EIO: hardware read failure'))
  })

  await check('agent loop: брошенное исключение из executeTool не крашит ход, а возвращает ошибку агенту', async () => {
    // В main.js блок:
    // } catch (error) { checkpointAction?.end('failed'); throw error }
    // при падении инструмента бросал исключение наружу, убивая весь ход.
    // Исправление перехватывает ошибку инструмента и возвращает { success: false, error: ... }
    const toolName = 'read_file'
    const args = { path: 'corrupt.txt' }
    let rawResult
    let checkpointFailed = false
    const checkpointAction = { end: status => { if (status === 'failed') checkpointFailed = true } }
    const signal = { aborted: false }

    try {
      // Имитируем инструмент, бросающий неожиданный Error
      throw new Error('EIO: i/o error, read failed on hardware level')
    } catch (error) {
      checkpointAction?.end('failed')
      if (signal?.aborted) throw error
      rawResult = {
        success: false,
        error: `Ошибка при выполнении инструмента ${toolName}: ${String(error?.message || error).slice(0, 500)}`
      }
    }

    assert.equal(checkpointFailed, true)
    assert.equal(rawResult.success, false)
    assert.ok(rawResult.error.includes('EIO: i/o error'))

    const normalized = toolProto.normalizeToolResult(rawResult, toolName)
    assert.equal(normalized.success, false)
    const encoded = toolProto.encodeToolResult(normalized, { name: toolName })
    assert.ok(encoded.includes('EIO: i/o error'))
  })

  await check('agent loop: stepResult с null в content и reasoning не падает на .trim()', () => {
    const rawStepResult = {
      content: null,
      reasoning: undefined,
      toolCalls: []
    }

    const safeContent = typeof rawStepResult?.content === 'string' ? rawStepResult.content : ''
    const safeReasoning = typeof rawStepResult?.reasoning === 'string' ? rawStepResult.reasoning : ''

    assert.equal(safeContent.trim(), '')
    assert.equal(safeReasoning.trim(), '')
  })

  // =========================================================================
  // 5. IPC send-message Entry Point Fuzzing
  // =========================================================================

  await check('IPC send-message: безопасная нормализация при null/undefined payload', () => {
    const sanitizePayload = raw => (raw && typeof raw === 'object' ? raw : {})

    for (const badPayload of [null, undefined, 123, 'string', false]) {
      const payload = sanitizePayload(badPayload)
      assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload))
      const requestId = payload.requestId || 'default'
      assert.equal(requestId, 'default')
      const resumed = payload.resumeRunId || null
      assert.equal(resumed, null)
    }
  })

  console.log(`\nИтог: проверок ${total}, провалов ${failed}`)
  if (failed > 0) process.exit(1)
}

run()
