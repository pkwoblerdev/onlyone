'use strict'
const assert=require('node:assert/strict')
const { createMods,samplePackage }=require('../src/main/mods.cjs')
const { register }=require('../src/main/mods-ipc.cjs')
const service=createMods({storage:{load:()=>null,save:()=>{}}}),handlers={},main={mainFrame:{}},desk={mainFrame:{}},guest={mainFrame:{}}
const event=wc=>({sender:wc,senderFrame:wc.mainFrame}),skills=[{id:'diagnostics',name:'Diagnostics',enabled:true,systemPrompt:'PRIVATE instruction'}]
let reads=0,delivered=0,opened=[]
const api=register({ipcMain:{handle:(id,fn)=>{handlers[id]=fn}},getService:()=>{reads++;return service},
  isMain:e=>e.sender===main&&e.senderFrame===main.mainFrame,deskChat:e=>e.sender===desk&&e.senderFrame===desk.mainFrame?'chat-desk':null,
  skills:()=>skills,openDesk:async id=>{opened.push(id);return{ok:true}},deliverDraft:()=>{delivered++;return true}})
;(async()=>{
  for(const id of ['mods:list','mods:preview','mods:commit','mods:toggle','mods:remove','mods:export','mods:sample'])assert.equal((await handlers[id](event(guest),{})).code,'forbidden',id)
  assert.equal(reads,0)
  assert.equal((await handlers['mods:list'](event(desk))).code,'forbidden')
  assert.equal((await handlers['mods:panels']({sender:desk,senderFrame:{}},{})).code,'forbidden')
  assert.equal((await handlers['mods:sample'](event(main),{skillId:{a:1}})).code,'invalid-package')
  assert.equal((await handlers['mods:sample'](event(main),{skillId:'missing-skill'})).code,'invalid-package')
  assert.equal((await handlers['mods:sample'](event(main),{skillId:'diagnostics'})).ok,true)
  const preview=await handlers['mods:preview'](event(main),{package:samplePackage('diagnostics')})
  assert.equal((await handlers['mods:commit'](event(main),{token:preview.token})).ok,true)
  service.event('chat-desk','check.failed')
  const rows=await handlers['mods:panels'](event(desk),{chatId:'forged-chat',surface:'main'})
  assert.equal(rows.panels[0].status.skillId,'diagnostics')
  const request={chatId:'forged-chat',modId:'onlyone.project-checks',panelId:'checks',buttonId:'test',revision:rows.revision}
  const draft=await handlers['mods:action'](event(desk),request)
  assert.equal(draft.type,'delivered');assert.equal(delivered,1)
  const resolved=api.resolveSkill('chat-desk',{...request,chatId:'chat-desk'})
  assert.equal(resolved.skill.systemPrompt,'PRIVATE instruction')
  assert.equal(JSON.stringify(draft).includes('PRIVATE'),false)
  skills[0].enabled=false
  assert.equal((await handlers['mods:action'](event(main),{...request,chatId:'main-chat'})).code,'skill-unavailable')
  skills[0].enabled=true
  assert.equal((await handlers['mods:action'](event(desk),{...request,buttonId:'desk'})).ok,true)
  assert.deepEqual(opened,['chat-desk'])
  assert.equal(api.resolveSkill('wrong-chat',{...request,chatId:'chat-desk'}).code,'chat-mismatch')
  console.log('PASS Mods IPC: management main-only, guest/subframe denial, Desk chat binding, disabled skill denial, private instruction stays in main')
})().catch(error=>{console.error(error);process.exitCode=1})
