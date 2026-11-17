const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const root = path.join(__dirname, '..')
// Код окна теперь разложен по модулям (план, 2d) — проверяем весь исполняемый текст.
const ui = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8')
const { qualityContract } = require('../src/main/agent-quality')
const { designReviewContract } = require('../src/main/design/review-contract')
const { McpManager } = require('../src/main/mcp-manager')
async function run() {
  const start = ui.indexOf('  function thinkingHeadline(')
  const end = ui.indexOf('  function pushBlock(', start)
  const headline = new Function('t', ui.slice(start,end) + '; return thinkingHeadline')(x=>x)
  assert.equal(headline('Checking cancellation paths. Then tests.'), 'Checking cancellation paths.')
  assert.equal(headline('Проверяю отмену. Затем тесты.'), 'Проверяю отмену.')
  // Пустая мысль — не повод что-то написать. Раньше здесь возвращалось
  // «Ожидаю ответ модели…», и эта строка вставала поверх настоящего занятия
  // агента на каждом куске размышления без внятного первого предложения.
  assert.equal(headline(''), '')
  assert(!ui.includes('Обдумывает следующий шаг'))
  assert(qualityContract().includes('не скрытые рассуждения'))
  assert(!main.includes("step === 0 ? 'Анализ задачи…'"))
  const review = designReviewContract()
  for(const term of ['Сохраняй все запрошенные функции','loading','dc_check','не требуют четырёх агентов','Аудит не разрешает правки']) assert(review.includes(term), term)
  // A connecting session should be awaited, not reported disconnected.
  const manager = new McpManager()
  manager.toolMap.set('x', {serverId:'s',toolName:'read'})
  const controller = new AbortController()
  let signalPassed = false
  const session = {status:'connecting',client:null}
  manager.sessions.set('s',session)
  setTimeout(()=>{session.status='connected';session.client={callTool:async(_p,_schema,opts)=>{signalPassed=opts.signal===controller.signal;return {content:[]}}}},10)
  await manager.callOpenRouterTool('x', {}, {signal:controller.signal})
  assert(signalPassed)
  controller.abort()
  await assert.rejects(manager.callOpenRouterTool('x', {}, {signal:controller.signal}), {name:'AbortError'})
  session.status='connecting'
  const waiting = new AbortController()
  const result = manager.callOpenRouterTool('x', {}, {signal:waiting.signal})
  waiting.abort()
  await assert.rejects(result, {name:'AbortError'})
  session.status='connected'
  session.client={callTool:(_p,_s,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}
  const active = new AbortController()
  const pending = manager.callOpenRouterTool('x', {}, {signal:active.signal})
  active.abort()
  await assert.rejects(pending, {name:'AbortError'})
  // Real Node subprocess: no files or network, and cancellation must end it.
  const subprocess = new AbortController()
  await new Promise((resolve,reject)=>{
    const child=require('node:child_process').execFile(process.execPath,['-e','setInterval(()=>{},1000)'],
      {signal:subprocess.signal,windowsHide:true,timeout:3000},error=>{
        try { assert.equal(error?.name,'AbortError'); resolve() } catch(e) { reject(e) }
      })
    child.once('spawn',()=>subprocess.abort())
  })
  assert(main.includes('mcpManager.callOpenRouterTool(name, args, { signal })'))
  assert(main.includes('executeMcpTool(event, toolName, args, payload.requestId, signal)'))
  assert(main.includes('runCustomTool(event, toolName.slice(4), args, payload.requestId, signal)'))
  assert(main.includes("if (error?.name === 'AbortError')"))
  console.log('Agent 0908: authentic headings, progress contract, design review, MCP wait/cancellation passed')
}
run().catch(err=>{console.error(err);process.exitCode=1})
