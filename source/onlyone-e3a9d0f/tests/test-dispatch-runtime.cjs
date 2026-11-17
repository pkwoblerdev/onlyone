const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr
const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
const start = src.indexOf('    const pending = plan.assignments.slice()')
const end = src.indexOf('    // Accumulate.', start)
assert.ok(start > 0 && end > start)
const ready = src.slice(src.indexOf('function readyFor(item, state)'), src.indexOf('function assignWorkSchema'))
// Настоящая отправка события хода: вырезанный участок диспетчера зовёт её, а
// заглушка здесь спрятала бы ровно ту регрессию, что проверяется в
// test-agent-turn. Окно тут подставное и живое — функция проходит к `send`.
const guard = src.slice(src.indexOf('function sendToWindow(event, channel, body)'), src.indexOf('async function runAgentMode(event'))
const dispatch = new Function('env', `return (async () => {
  const {plan, runAgentSlot} = env;
  const helpers = [2,3,4].map(agent => ({index:agent-1,name:'Agent '+agent}));
  const payload = {requestId:'fixture',messages:[]}, signal = {aborted:false};
  const done = [], round_done = [], stages = [], leadResult = null;
  const stage = () => {}, boardBrief = () => '', lastUserMessage = () => '';
  // Предыстория помощнику (инициатива 1) здесь не проверяется: нужно лишь имя. Склад отчётов приходит из среза main.js.
  const buildPrior = () => '';
  // Срок части: в этом наборе он не должен срабатывать — проверяется порядок
  // запуска, а не отсечка по времени.
  const PART_DEADLINE_MS = 5 * 60 * 1000;
  const helperBrief = () => '', helperDesignBrief = () => '', failureReason = String;
  const event = {sender:{send(){}}};
  const runContext = null;
  ${ready}
  ${guard}
  ${src.slice(start, end)}
  return {round_done, stages};
})()`)
const flush = () => new Promise(resolve => setImmediate(resolve))
const item = (agent, after = [], extra = {}) => ({agent,after,files:[],readOnly:true,task:'fixture',...extra})
;(async () => {
  const launched = [], pending = new Map()
  const result = dispatch({ plan:{assignments:[item(2),item(3),item(4,[2])]},
    runAgentSlot: (_, slot) => new Promise((resolve,reject) => {
      launched.push(slot.index+1); pending.set(slot.index+1,{resolve,reject})
    }) })
  await flush()
  assert.deepEqual(launched,[2,3])
  pending.get(2).resolve({content:'done 2'})
  await flush()
  assert.deepEqual(launched,[2,3,4], 'dependent must start while long neighbour still runs')
  pending.get(3).reject(new Error('fixture failure'))
  pending.get(4).resolve({content:'done 4'})
  const report = await result
  assert.equal(report.round_done.length,3)
  assert.equal(report.round_done.filter(x=>x.failed).length,1)
  assert.ok(report.round_done.some(x=>x.body==='done 4'))

  // И-5: две пишущие части в одном файле не идут одновременно, разные файлы — идут.
  const overlaps = [], pending2 = new Map()
  const guard = dispatch({ plan:{assignments:[
    item(2, [], {files:['src/a.js'],readOnly:false}),
    item(3, [], {files:['src/a.js'],readOnly:false}),
    item(4, [], {files:['src/b.js'],readOnly:false})
  ]},
    runAgentSlot: (_, slot) => new Promise((resolve,reject) => {
      overlaps.push(slot.index+1); pending2.set(slot.index+1,{resolve,reject})
    }) })
  await flush()
  assert.deepEqual(overlaps,[2,4], 'two writers of the same file must not start together')
  pending2.get(2).resolve({content:'done 2'})
  await flush()
  assert.deepEqual(overlaps,[2,4,3], 'the held writer must start once the file is free')
  pending2.get(3).resolve({content:'done 3'})
  pending2.get(4).resolve({content:'done 4'})
  const second = await guard
  assert.equal(second.round_done.length,3)
  assert.equal(second.round_done.filter(x=>x.failed).length,0)
  console.log(JSON.stringify({ok:true,dispatcherRuntimeChecks:13}))
})().catch(error => { console.error(error); process.exitCode=1 })
