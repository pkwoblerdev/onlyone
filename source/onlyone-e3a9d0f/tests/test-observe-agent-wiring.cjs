// test-observe-agent-wiring.cjs — проводка находки break-4 Н3 (аудит 11.11):
// task-state научился различать агентов, но живой путь main.js звал observe(args)
// без agentIndex — наблюдение оставалось всеобщим: чужое чтение «сверяло» помощника.
//
// Тест вырезает НАСТОЯЩЕЕ утверждение вызова из main.js и исполняет его с подставной
// контрольной точкой, которая записывает, что ей передали. Так проверяется проводка,
// а не текст регуляркой. Отрицательные контроли — все четыре условия отказа от вызова.
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
const found = main.match(/if \(!heldBack && rawResult\?\.success !== false && !hasSideEffects\(toolName\)\) payload\.checkpoint\?\.observe\([^\r\n]*/)
assert.ok(found, 'в main.js не найден вызов observe у контрольной точки хода')
const statement = found[0]

const run = ({ heldBack = false, rawResult = { success: true }, sideEffects = false, agentIndex = 0, checkpoint = true } = {}) => {
  const calls = []
  const payload = checkpoint ? { checkpoint: { observe: (...a) => calls.push(a) } } : {}
  const fn = new Function('heldBack', 'rawResult', 'hasSideEffects', 'toolName', 'payload', 'args', 'agentIndex', statement)
  fn(heldBack, rawResult, () => sideEffects, 'read_file', payload, { path: 'a.txt' }, agentIndex)
  return calls
}

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn(); console.log(`ok     ${name}`) } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

check('помощник: observe получает его agentIndex', () => {
  const calls = run({ agentIndex: 2 })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][0], { path: 'a.txt' })
  assert.equal(calls[0][1], 2, 'agentIndex не передан — наблюдение остаётся всеобщим (break-4 Н3)')
})

check('ведущий: observe получает agentIndex 0, а не undefined', () => {
  const calls = run({ agentIndex: 0 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 0)
})

check('удержанное действие не наблюдается', () => {
  assert.deepEqual(run({ heldBack: true, agentIndex: 1 }), [])
})

check('неудачный исход не наблюдается', () => {
  assert.deepEqual(run({ rawResult: { success: false }, agentIndex: 1 }), [])
})

check('действие с последствиями не наблюдается', () => {
  assert.deepEqual(run({ sideEffects: true, agentIndex: 1 }), [])
})

check('без контрольной точки вызов не падает', () => {
  assert.deepEqual(run({ checkpoint: false, agentIndex: 1 }), [])
})

console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
process.exit(failed === 0 ? 0 : 1)