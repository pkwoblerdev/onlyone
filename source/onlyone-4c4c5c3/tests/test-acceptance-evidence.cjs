'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const { acceptanceMessages, readVerdict } = require('../src/main/agent-completion')
const start = source.indexOf('        const deterministicPass =')
const end = source.indexOf('        // Решение о доработке', start)
assert(start > 0 && end > start)
const gate = new Function('ctx', 'require', `return (async () => { const { gaps, toolLog, turnAnswer, payload, cycle, agentIndex, agentName, event, sendToWindow, hasDeterministicProof, judgeModelFor, model, openRouterRequest, signal, preferredKeyId, originalTask, plan, step, acceptanceMessages, readVerdict, runWithBudget, messagesRoughTokens } = ctx; let lead = ''; ${source.slice(start, end)}; return gaps; })()`)
async function run(overrides = {}) {
  const records = [], events = [], requests = []
  const ctx = {
    gaps: [], toolLog: [{ tool: 'edit_file', ok: true }, { tool: 'run_command', command: 'npm test', ok: true, exitCode: 0 }],
    turnAnswer: 'Все готово', payload: { isCoordinator: true }, agentIndex: 0, agentName: 'Агент 1', event: {},
    cycle: { record: item => records.push(item), spend: () => true },
    sendToWindow: (...args) => events.push(args.at(-1)), hasDeterministicProof: () => true,
    judgeModelFor: () => 'judge', model: 'lead', signal: {}, preferredKeyId: '',
    step: 0,
    runWithBudget: async (_budget, _input, provider) => ({ ok: true, enabled: false, called: true, value: await provider() }),
    messagesRoughTokens: () => 1000,
    originalTask: 'Добавить две функции', plan: [], acceptanceMessages, readVerdict,
    openRouterRequest: async (url, args) => { requests.push(args); return { json: async () => ({ choices: [{ message: { content: 'ВЕРДИКТ: НЕ ГОТОВО\n- Вторая функция отсутствует' } }] }) } },
    ...overrides
  }
  const gaps = await gate(ctx, require('node:module').createRequire(path.join(__dirname, '../src/main/main.js')))
  return { records, events, requests, gaps }
}
async function main() {
  const rejected = await run()
  assert.equal(rejected.requests.length, 1, 'unrelated green tests must not bypass requirement review')
  assert(rejected.gaps.includes('Вторая функция отсутствует'))
  assert(!rejected.records.some(item => item.source === 'acceptance' && item.verdict === 'pass'))
  const fast = await run({ payload: { speedMode: 'fast', isCoordinator: true } })
  assert.equal(fast.requests.length, 0)
  assert(fast.records.some(item => item.source === 'acceptance' && item.verdict === 'unknown'), 'skipped acceptance is unknown, not pass')
  const offline = await run({ openRouterRequest: async () => { throw new Error('offline') } })
  assert(offline.records.some(item => item.verdict === 'unknown'))
  assert.equal(offline.gaps.length, 0, 'unavailable judge must not cause retry loops')
  const messages = acceptanceMessages({ task: 'Проверить проект', log: [{ tool: 'run_command', command: 'node tests/unrelated.cjs', exitCode: 1, ok: false }], plan: [], answer: 'готово' })
  assert(messages[1].content.includes('node tests/unrelated.cjs'), 'reviewer sees actual command')
  assert(messages[1].content.includes('exitCode'), 'reviewer sees exit status')
  assert(messages[0].content.includes('релевант'), 'reviewer must relate checks to requirements')
  const secret = 'sk-ant-api03-EXAMPLE24f456d8b334fe381663fd1b22f'
  const redacted = acceptanceMessages({ task: 'Проверить проект', log: [{ tool: 'run_command', command: 'curl -H "Authorization: Bearer ' + secret + '"', ok: true, exitCode: 0 }], answer: 'готово' })
  assert(!redacted[1].content.includes(secret), 'new command detail must not expose credentials to reviewer')
  assert(source.includes('assignmentId: item.boardId'), 'dispatcher binds worker to its board part')
  assert(source.includes('assignmentId: payload.assignmentId'), 'tool log carries trusted assignment provenance')
  console.log('Acceptance evidence: requirement review, bounded unknown, command results and assignment wiring passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
