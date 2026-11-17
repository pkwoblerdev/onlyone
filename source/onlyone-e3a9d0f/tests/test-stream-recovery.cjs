const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { joinStreamChunk } = require('../src/main/stream-join')
const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const start = src.indexOf('function recoverInterruptedStep(')
const end = src.indexOf('async function streamAgentStep(', start)
const recover = new Function(src.slice(start, end) + '; return recoverInterruptedStep')()
const timeout = new Error('Upstream idle timeout exceeded')
const messages = [{role:'tool', tool_call_id:'completed', content:'saved'}]
assert.equal(recover(timeout, {}, 0, messages, 'Проверяю файл'), true)
assert.equal(messages[0].content, 'saved')
assert.equal(messages[1].role, 'assistant')
assert.equal(messages[1].content, 'Проверяю файл')
assert.equal(messages[2].role, 'system')
assert(messages[2].content.includes('не исполнялись'))
assert.equal(messages.some(m => m.tool_calls), false)
for (const [err, signal, count] of [
  [timeout, {aborted:true}, 0], [timeout, {}, 2],
  [Object.assign(new Error('timeout'), {name:'AbortError'}), {}, 0],
  [new Error('401 unauthorized'), {}, 0], [new Error('quota exceeded'), {}, 0]
]) {
  const unchanged = []
  assert.equal(recover(err, signal, count, unchanged, 'partial'), false)
  assert.equal(unchanged.length, 0)
}
assert.equal(recover(new Error('terminated'), {}, 1, [], ''), true)
assert(src.includes('recoverInterruptedStep(err, signal, interruptedStepRetries, messages, partialStepContent)'))
assert(src.includes('partialStepContent += text'))
assert.equal((src.match(/retryBoundaryPending = true/g) || []).length, 2,
  'обе ветки восстановления отмечают границу попыток')
assert(src.includes('appendStreamContent(text)'), 'обычный поток проходит через joinStreamChunk')
assert.equal(joinStreamChunk('Про', 'веряю', false), 'веряю', 'обычные chunks не разделяются')
assert.equal(joinStreamChunk('Готово.\n\n', 'Дальше.', true), 'Дальше.', 'не добавляем пустой абзац второй раз')
console.log('Stream recovery: timeout continuation, preserved state, discarded calls, cancellation and retry bounds passed')

// Exercise the real SSE parser with a partial tool call followed by the exact
// provider error seen in the screenshot, then a successful continuation.
;(async () => {
  const parser = src.slice(src.indexOf('async function streamAgentStep('), src.indexOf('// The user saying the job'))
  const deltas = src.slice(src.indexOf('function accumulateToolCallDeltas('), src.indexOf('// Writes every SSE'))
  const stream = new Function(deltas + parser + '; return streamAgentStep')()
  const response = frames => ({body: new ReadableStream({start(controller) {
    for (const frame of frames) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(frame) + '\n\n'))
    controller.close()
  }})})
  let observed = ''
  let retryBoundaryPending = false
  const callbacks = {onContent: text => {
    observed += joinStreamChunk(observed, text, retryBoundaryPending)
    retryBoundaryPending = false
  }, onReasoning: () => {}}
  const history = [{role:'tool', tool_call_id:'previous', content:'file saved'}]
  await assert.rejects(async () => {
    await stream(response([
      {choices:[{delta:{content:'Продолжаю макет.', tool_calls:[{index:0,id:'unfinished',function:{name:'dc_write',arguments:'{"content":"'}}]}}]},
      {error:{message:'Upstream idle timeout exceeded'}}
    ]), {}, callbacks)
  }, err => recover(err, {}, 0, history, observed))
  assert.equal(history[0].content, 'file saved')
  assert.equal(history[1].content, 'Продолжаю макет.')
  assert(!history.some(m => m.tool_calls))
  retryBoundaryPending = true
  const result = await stream(response([{choices:[{delta:{content:'Макет завершён.'},finish_reason:'stop'}]}]), {}, callbacks)
  assert.equal(result.content, 'Макет завершён.')
  assert.equal(result.toolCalls.length, 0)
  assert.equal(observed, 'Продолжаю макет.\n\nМакет завершён.')
  console.log('Real SSE parser: partial text + incomplete tool + upstream timeout + separated continuation passed')
})().catch(err => { console.error(err); process.exitCode = 1 })
