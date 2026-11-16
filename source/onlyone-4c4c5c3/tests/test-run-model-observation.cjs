'use strict'
const assert = require('node:assert/strict')
const { createRunContext } = require('../src/main/agent-run-context')
const { requestJson } = require('../src/main/run-model-observation.cjs')
;(async () => {
  const context = createRunContext({ durationMs: 1000 })
  const options = { body: { model: 'test/asked', messages: [{ role: 'system', content: 'PRIVATE' }] } }
  let mode = 'ok', requests = 0
  const request = async (route, opts) => {
    assert.equal(route, '/chat/completions'); assert.equal(opts, options); requests++
    if (mode === 'request-failure') throw Error('PRIVATE failure')
    return { json: async () => { if (mode === 'json-failure') throw Error('invalid JSON'); return { model: 'test/served', choices: [] } } }
  }
  const metadata = { request, context, kind: 'judge', agentIndex: 2 }
  assert.equal((await requestJson(options, metadata)).model, 'test/served')
  assert.equal(context.snapshot().modelCalls[0].answeredModel, 'test/served')
  assert.equal(context.snapshot().modelCalls[0].kind, 'judge')
  for (mode of ['request-failure', 'json-failure']) await assert.rejects(requestJson(options, metadata))
  assert.deepEqual(context.snapshot().modelCalls.map(call => call.outcome), ['completed', 'failed', 'failed'])
  const controller = new AbortController(); controller.abort(); mode = 'request-failure'
  await assert.rejects(requestJson({ ...options, signal: controller.signal }, { ...metadata, request: async () => { throw Error('aborted') } }))
  assert.equal(context.snapshot().modelCalls.at(-1).outcome, 'cancelled')
  assert.equal(requests, 3)
  assert.equal(JSON.stringify(context.snapshot()).includes('PRIVATE'), false)
  mode = 'ok'; await requestJson(options, { ...metadata, context: null })
  console.log('PASS model observation: exact response, failures/cancellation, no prompt contents, optional run context')
})().catch(error => { console.error(error); process.exitCode = 1 })
