'use strict'
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const root = path.join(__dirname,'..'), dir = runDir('onlyone-session-review'), profile = path.join(dir,'profile'), workspace = path.join(dir,'workspace')
for (const folder of [profile,workspace]) fs.mkdirSync(folder,{recursive:true})
fs.writeFileSync(path.join(workspace,'a.txt'),'old_a'); fs.writeFileSync(path.join(workspace,'b.txt'),'old_b')
const model = { id:'fixture/model',name:'Fixture model',isFree:true,supportsTools:true,supportedEfforts:['low','high'],contextLength:100000,inputModalities:['text'] }
fs.writeFileSync(path.join(profile,'1code-settings.json'),JSON.stringify({
  openrouterKeys:[{id:'test-key',name:'Fixture',keyEncrypted:'Q0lQSEVSLU5PLQ',modelId:model.id,enabled:true}],
  defaultModel:model.id,thinkingEffort:'high',legacyStoragePurged:true,
  openrouterModelCache:{updatedAt:Date.now(),models:[model]},workspace:{path:workspace,permission:'acceptEdits'}
}))
const provider = path.join(dir,'provider.json')
fs.writeFileSync(provider,JSON.stringify({keyed:[
  {match:'LATER_DONE',once:true,toolCalls:[{name:'write_file',args:{path:'a.txt',content:'later_a'}}]},
  {match:'LATER_DONE',text:'LATER_DONE',content:'ВЕРДИКТ: ГОТОВО'}
],turns:[
  {toolCalls:[{name:'write_file',args:{path:'a.txt',content:'new_a'}},{name:'write_file',args:{path:'b.txt',content:'new_b'}}]},
  {text:'REVIEW_DONE'},{content:'ВЕРДИКТ: ГОТОВО'}
]}))
const script = path.join(dir,'renderer.js'), output = path.join(dir,'result.json')
fs.writeFileSync(script,`(async () => {
  const $ = id => document.getElementById(id)
  const ensure = (value,message) => { if(!value) throw Error(message) }
  const until = async predicate => { for(let i=0;i<600;i++){try{if(predicate())return}catch{};await new Promise(r=>setTimeout(r,50))};throw Error('UI timeout: '+predicate.toString()) }
  await until(() => document.documentElement.dataset.appReady==='1')
  $('onboardingSkip')?.click(); $('newChatBtn')?.click()
  $('composerTextarea').value='Запиши new_a в a.txt и new_b в b.txt. Затем ответь REVIEW_DONE.'
  $('composerTextarea').dispatchEvent(new Event('input',{bubbles:true})); $('composerForm').requestSubmit()
  await until(() => $('messagesList').textContent.includes('REVIEW_DONE') && !$('sendBtn').classList.contains('is-stop'))
  const api=window.electronAPI
  ensure((await api.reviewAgentChanges({requestIds:['../escape']})).code==='invalid','invalid request id accepted')
  let ids=[]
  for(let i=0;i<100&&!ids.length;i++) {
    const conversations=await api.getConversations()
    ids=conversations.flatMap(chat=>chat.messages||[]).filter(msg=>msg.undoId).map(msg=>msg.undoId)
    if(!ids.length) await new Promise(r=>setTimeout(r,50))
  }
  ensure(ids.length>0,'no real undo id')
  const review=await api.reviewAgentChanges({requestIds:ids})
  ensure(review.files.length===2,'two real files missing: '+JSON.stringify(review))
  const a=review.files.find(row=>row.file==='a.txt')
  $('composerTextarea').value='.diff'; $('composerTextarea').dispatchEvent(new Event('input',{bubbles:true})); $('composerForm').requestSubmit()
  await until(()=>document.querySelectorAll('.change-review-list tbody tr').length===2)
  const viewFile=name=>[...document.querySelectorAll('.change-review-list tbody tr')].find(row=>row.children[1].textContent===name)?.querySelector('button').click()
  viewFile('a.txt'); await until(()=>document.querySelector('[data-action=restore-file]'))
  ensure(document.querySelector('.change-review-detail').textContent.includes('old_a'),'original contents missing')
  const later=await api.sendMessage({requestId:'later-edit',chatId:'fixture-later',model:'fixture/model',reasoningEffort:'high',params:{useTools:true},
    messages:[{role:'user',content:'Запиши later_a в a.txt. Затем ответь LATER_DONE.'}]})
  ensure(later.ok,'later edit failed')
  document.querySelector('[data-action=restore-file]').click(); document.querySelector('[data-action=confirm-restore]').click()
  await until(()=>document.querySelector('.change-review-dialog [role=status]').textContent==='Откат пропущен: файл изменён после ответа.')
  const conflict=await api.previewAgentChange({requestId:a.requestId,fileId:a.fileId})
  ensure(conflict.status==='conflict' && conflict.after==='later_a','later work was overwritten')
  viewFile('b.txt'); await until(()=>document.querySelector('[data-action=restore-file]'))
  document.querySelector('[data-action=restore-file]').click(); document.querySelector('[data-action=confirm-restore]').click()
  await until(()=>document.querySelector('.change-review-dialog [role=status]').textContent==='Файл возвращён к состоянию до ответа.')
  const remaining=await api.reviewAgentChanges({requestIds:[a.requestId]})
  ensure(remaining.files.length===1 && remaining.files[0].file==='a.txt','unselected snapshot was lost')
  return {ok:true,checks:['real agent writes','real .diff entry','original/current preview','later edit conflict','selective rollback','remaining snapshot retained']}
})()`)
const child = spawnSync(electronBinary(),['.','--no-sandbox','--disable-gpu-sandbox','--user-data-dir='+profile],{
  cwd:root,timeout:150000,windowsHide:true,env:guiEnv({ONECODE_SMOKE:script,ONECODE_SMOKE_OUT:output,ONECODE_E2E:'1',ONECODE_PROVIDER_FILE:provider,ONECODE_SHOT:path.join(dir,'screen.png')})
})
let ok=false
try {
  const report=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{ok:false,error:child.error?.message||'No app verdict'}
  console.log(JSON.stringify(report)); assert.equal(report.ok,true,JSON.stringify(report));assert.equal(child.status,0)
  assert.equal(fs.readFileSync(path.join(workspace,'a.txt'),'utf8'),'later_a')
  assert.equal(fs.readFileSync(path.join(workspace,'b.txt'),'utf8'),'old_b')
  ok=true
} catch(error) {console.error(error);console.error(child.stderr?.toString().slice(-1500));process.exitCode=1}
settleRun(dir,ok)
