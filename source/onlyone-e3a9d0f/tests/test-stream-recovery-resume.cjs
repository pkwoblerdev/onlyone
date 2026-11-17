const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')

function sourceBetween(startText, endText) {
  const start = source.indexOf(startText)
  const end = source.indexOf(endText, start)
  assert.ok(start >= 0 && end > start, `Expected stream recovery source: ${startText}`)
  return source.slice(start, end)
}

const accumulator = sourceBetween('function accumulateToolCallDeltas(', '// У ожидания следующего куска')
const parserSource = sourceBetween('async function streamAgentStep(', '// The user saying the job')
const parser = new Function('readWithIdleTimeout', `${accumulator}${parserSource}; return streamAgentStep`)(
  reader => reader.read()
)
const recover = new Function(
  sourceBetween('function recoverInterruptedStep(', 'async function streamAgentStep(') +
  '; return recoverInterruptedStep'
)()

function response(frames) {
  return {
    body: new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`))
        }
        // A transport can close cleanly at the TCP/ReadableStream layer even
        // though the model never sent finish_reason or the SSE [DONE] marker.
        controller.close()
      }
    })
  }
}

;(async () => {
  const visible = []
  const priorMessages = [{ role: 'tool', tool_call_id: 'already-done', content: 'saved result' }]
  const callbacks = {
    onContent: text => visible.push(text),
    onReasoning: () => {}
  }

  // One complete text delta, then an incomplete tool-call delta, then EOF.
  // Neither the partial text nor any part of the tool call is a completed step.
  await assert.rejects(
    parser(response([{
      choices: [{ delta: {
        content: 'The migration is half finished; ',
        tool_calls: [{ index: 0, id: 'unfinished', function: { name: 'write_file', arguments: '{"path":"app.js"' } }]
      } }]
    }]), {}, callbacks),
    error => {
      assert.equal(recover(error, {}, 0, priorMessages, visible.join('')), true,
        'premature EOF should enter the bounded continuation path')
      return true
    },
    'an SSE stream without finish_reason or [DONE] must not be reported as a successful answer'
  )

  assert.deepEqual(visible, ['The migration is half finished; '], 'already streamed text remains visible exactly once')
  assert.equal(priorMessages[0].content, 'saved result', 'completed tool results remain unchanged')
  assert.deepEqual(priorMessages[1], { role: 'assistant', content: 'The migration is half finished; ' },
    'the recovery context keeps the exact observed text')
  assert.equal(priorMessages.some(message => message.tool_calls), false,
    'an unfinished tool call is never promoted into recovery history')
  assert.match(priorMessages.at(-1).content, /не исполнялись/,
    'the continuation is told that interrupted tools did not run')

  console.log('Stream recovery resume: premature EOF preserves visible text and retries without replaying incomplete tools')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
