const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { AsyncLocalStorage } = require('node:async_hooks')
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
// Код окна теперь разложен по модулям (план, 2d) — проверяем весь исполняемый текст.
const ui = require('./renderer-code.cjs').rendererCode(path.join(__dirname, '..'))
// Вырезки из main.js компилируются new Function и видят только глобальную
// область: главный процесс даёт им и переводчик фраз для окна (2.6б).
globalThis.tr = require('../src/main/ui-text.cjs').tr
const cut = (s, a, b) => { const i=s.indexOf(a), j=s.indexOf(b,i); assert(i>=0&&j>i); return s.slice(i,j) }
// Отправка события хода — настоящая: `defineCustomTool` пишет в ленту через неё.
const GUARD = cut(main, 'function sendToWindow(event, channel, body) {', 'async function runAgentMode(')
const build = new Function('env', `
 const {workspace, fs, AsyncLocalStorage, requireMutationApproval} = env;
 const {resolve,basename,isAbsolute,parse,relative,dirname,join}=env.path;
 const mcpManager=null;
 ${GUARD}
 ${cut(main,'function assertWorkspaceConfigured()', 'function computeLineDiff')}
 ${cut(main,'const CUSTOM_TOOLS_DIR =', 'async function runCustomTool')}
 ${cut(main,'function agentToolsAvailable()', '// Runs one slot.')}
 const planModeRefusal=()=>({success:false,denied:true});
 return {listFiles,assertSafeWorkspacePath,relativeDisplay,customToolsRoot,defineCustomTool,agentToolsAvailable,
 run:(folders,fn)=>turnScope.run({projectFolders:folders,chatFolders:[]},fn)};
`)
;(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-107-'))
 const project=path.join(root,'project'), other=path.join(root,'other')
 fs.mkdirSync(project); fs.mkdirSync(other)
 fs.writeFileSync(path.join(project,'marker.txt'),'fixture')
 const workspace={path:'',extraPaths:[],permission:'auto'}
 const api=build({workspace,fs:fs.promises,AsyncLocalStorage,path,requireMutationApproval:async()=>true})
 await assert.rejects(api.assertSafeWorkspacePath('.'),/Сначала выберите/)
 assert.equal(api.agentToolsAvailable(),false)
 await api.run([project],async()=>{
   assert.equal(api.agentToolsAvailable(),true)
   assert.equal(await api.assertSafeWorkspacePath('marker.txt'),path.join(project,'marker.txt'))
   const listing=await api.listFiles('.')
   assert.ok(listing.entries.some(x=>x.path==='marker.txt'))
   assert.equal(api.relativeDisplay(path.join(project,'marker.txt')),'marker.txt')
   await assert.rejects(api.assertSafeWorkspacePath('../other'),/Доступ запрещён/)
   const result=await api.defineCustomTool({sender:{send(){}}},{name:'test_tool',description:'fixture',code:'module.exports=()=>42'},'r')
   assert.equal(result.success,true)
   assert.equal(fs.readFileSync(path.join(project,'.1code/tools/test_tool.js'),'utf8'),'module.exports=()=>42')
 })
 await Promise.all([project,other].map(folder=>api.run([folder],async()=>{
   await new Promise(r=>setImmediate(r))
   assert.equal(api.customToolsRoot(),path.join(folder,'.1code/tools'))
 })))
 // A junction under the project must not redirect generated executable writes.
 fs.mkdirSync(path.join(other,'.1code'))
 fs.symlinkSync(project,path.join(other,'.1code/tools'),'junction')
 await api.run([other],async()=>{
   await assert.rejects(api.defineCustomTool({sender:{send(){}}},{name:'escape_tool',description:'fixture',code:'module.exports=()=>1'},'r'),/Символическая ссылка/)
   assert.equal(fs.existsSync(path.join(project,'escape_tool.js')),false)
 })
 const tasks=new Map([[0,{done:false,waiting:true}],[1,{done:true,outcome:'done'}],[2,{done:false,taskTitle:'Ожидает назначения'}]])
 // Маркер без списка параметров: у taskCard с переделкой панели появился второй (pane).
 const life=new Function('agentTaskState','t',cut(ui,'function settleAgentTasks(pane)', 'function taskCard(')+';return {settleAgentTasks,completeAgentTask,taskEndLabel}')(
   (pane,index)=>pane.agentTasks.get(index),x=>x)
 life.settleAgentTasks({agentTasks:tasks})
 assert.equal(life.taskEndLabel(tasks.get(0)),'Прервано')
 assert.equal(life.taskEndLabel(tasks.get(1)),'готово')
 assert.equal(life.taskEndLabel(tasks.get(2)),'Не запускался')
 life.completeAgentTask({agentTasks:tasks},{agentIndex:0,ok:false,incomplete:true})
 assert.equal(life.taskEndLabel(tasks.get(0)),'Не завершено')
 console.log('PASS: project-only paths, custom tools, junction rejection, concurrent roots, honest task outcomes')
})().catch(error=>{console.error(error);process.exitCode=1})
