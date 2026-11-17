'use strict'
const { samplePackage } = require('./mods.cjs')
function register ({ ipcMain,getService,isMain,deskChat,skills,openDesk,deliverDraft }) {
  let previewOwner=null
  const fail=code=>({ok:false,code})
  const actor=(event,input)=>isMain(event)?{chatId:input?.chatId,surface:'main'}:(deskChat(event)?{chatId:deskChat(event),surface:'desk'}:null)
  const guarded=(name,fn)=>ipcMain.handle(name,async(event,input)=>{
    if(!isMain(event))return fail('forbidden')
    try{return await fn(event,input)}catch{return fail('storage-unavailable')}
  })
  guarded('mods:list',()=>({...getService().list(),skills:skills().map(({id,name,enabled})=>({id,name,enabled}))}))
  guarded('mods:sample',(_event,input)=>{
    const id=input?.skillId
    if(id!==undefined&&(typeof id!=='string'||!skills().some(item=>item.id===id&&item.enabled)))return fail('invalid-package')
    return {ok:true,package:samplePackage(id||undefined)}
  })
  guarded('mods:preview',(event,input)=>{const result=getService().preview(input);previewOwner=result.ok?event.sender:null;return result})
  guarded('mods:commit',(event,input)=>event.sender===previewOwner?getService().commit(input?.token):fail('expired'))
  guarded('mods:toggle',(_event,input)=>getService().toggle(input?.id,input?.enabled,input?.revision))
  guarded('mods:remove',(_event,input)=>getService().remove(input?.id,input?.revision))
  guarded('mods:export',(_event,input)=>{
    const item=getService().list().mods.find(mod=>mod.package.id===input?.id)
    return item?{ok:true,text:JSON.stringify(item.package,null,2)}:fail('missing')
  })
  ipcMain.handle('mods:panels',async(event,input)=>{
    const scope=actor(event,input);if(!scope)return fail('forbidden')
    try{return getService().panels(scope.chatId,scope.surface)}catch{return fail('storage-unavailable')}
  })
  function resolveSkill (chatId,input) {
    if(input?.chatId!==chatId)return fail('chat-mismatch')
    try {
      const action=getService().action(chatId,input)
      if(!action.ok)return action
      if(action.type!=='draft')return fail('draft-required')
      const skill=action.skillId?skills().find(item=>item.id===action.skillId&&item.enabled):null
      if(action.skillId&&(!skill||typeof skill.systemPrompt!=='string'||!skill.systemPrompt.trim()||skill.systemPrompt.length>64000))return fail('skill-unavailable')
      return {ok:true,action,skill:skill?{id:skill.id,name:skill.name,systemPrompt:skill.systemPrompt}:null}
    }catch{return fail('storage-unavailable')}
  }
  ipcMain.handle('mods:action',async(event,input)=>{
    const scope=actor(event,input);if(!scope)return fail('forbidden')
    try {
      const service=getService(),view=service.panels(scope.chatId,scope.surface)
      if(!view.ok)return view
      if(!view.panels.some(panel=>panel.modId===input?.modId&&panel.id===input?.panelId))return fail('missing')
      const action=service.action(scope.chatId,input)
      if(!action.ok)return action
      if(action.type==='open_desk')return await openDesk(scope.chatId)
      const checked=resolveSkill(scope.chatId,{...input,chatId:scope.chatId})
      if(!checked.ok)return checked
      const result={...action,chatId:scope.chatId,skillName:checked.skill?.name||null}
      if(scope.surface==='desk'){
        if(!deliverDraft(result))return fail('main-unavailable')
        return {ok:true,type:'delivered'}
      }
      return result
    }catch{return fail('action-failed')}
  })
  return {resolveSkill}
}
module.exports={register}
