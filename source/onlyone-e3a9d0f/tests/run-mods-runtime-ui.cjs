 'use strict'
// Real application and tool loop; isolated profile, local scripted provider, no account or paid requests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process')
const {electronBinary,guiEnv,runDir,settleRun}=require('./app-launch.cjs')
const root=path.join(__dirname,'..'),dir=runDir('onlyone-mods-runtime'),profile=path.join(dir,'profile'),workspace=path.join(dir,'workspace'),dump=path.join(dir,'dump')
for(const folder of [profile,workspace,dump])fs.mkdirSync(folder,{recursive:true})
const model={id:'fixture/model',name:'Fixture',isFree:true,supportsTools:true,supportedEfforts:['low'],contextLength:100000,inputModalities:['text']}
const instruction='PRIVATE MOD EXACT INSTRUCTION'
fs.writeFileSync(path.join(profile,'1code-settings.json'),JSON.stringify({openrouterKeys:[{id:'test-key',name:'Fixture',keyEncrypted:'Q0lQSEVSLU5PLQ',modelId:model.id,enabled:true}],defaultModel:model.id,legacyStoragePurged:true,openrouterModelCache:{updatedAt:Date.now(),models:[model]},workspace:{path:workspace,permission:'acceptEdits'},skills:[{id:'fixture-diagnosis',name:'Fixture diagnosis',enabled:true,systemPrompt:instruction}]}))
fs.writeFileSync(path.join(workspace,'test.cjs'),'process.exit(1)')
const provider=path.join(dir,'provider.json')
fs.writeFileSync(provider,JSON.stringify({turns:[
 {toolCalls:[{name:'write_file',args:{path:'mod-proof.txt',content:'Fixture saved'}},{name:'run_command',args:{command:'node test.cjs'}}]},
 {text:'MOD_FIXTURE_DONE'},{content:'ВЕРДИКТ: ГОТОВО'}
]}))
function launch(stage, body) {
  const script = path.join(dir, stage + '.js'), output = path.join(dir, stage + '.json')
  fs.writeFileSync(script, `(async () => {
    const ensure = (value, message) => { if (!value) throw Error(message) }
    const waitFor = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }; throw Error('UI readiness timeout') }
    await waitFor(() => document.documentElement.dataset.appReady === '1')
    ${body}
    return { ok: true }
  })()`)
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 120000, windowsHide: true,
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: output, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: provider, ONECODE_PROVIDER_DUMP: dump })
  })
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { ok: false, error: child.error?.message || 'No app verdict' }
  if (!result.ok || child.status !== 0) console.error(child.stderr?.toString().slice(-1500))
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(child.status, 0)
  console.log('PASS real application:', stage)
}
try {
 launch('mod-events-and-skill', `
  const api=window.electronAPI
  const sample=await api.modsSample({skillId:'fixture-diagnosis'})
  ensure(sample.ok,'sample unavailable')
  const preview=await api.modsPreview({package:sample.package})
  ensure(preview.ok,'preview failed')
  ensure((await api.modsCommit(preview.token)).ok,'installation failed')
  await waitFor(()=>document.getElementById('mainMods') && !document.getElementById('mainMods').hidden)
  const view=await api.modsPanels('mods-runtime-chat'),panel=view.panels[0]
  const action=await api.modAction({chatId:'mods-runtime-chat',revision:view.revision,modId:panel.modId,panelId:panel.id,buttonId:panel.buttons.find(b=>b.action.type==='draft').id})
  ensure(action.ok&&action.type==='draft','action unavailable')
  const before=await api.modsList()
  ensure(before.diagnostics.length===0,'draft unexpectedly executed')
  const off=api.onAgentApproval(request=>{api.resolveAgentApproval({id:request.id,approved:true})})
  const result=await api.sendMessage({requestId:'mods-runtime',chatId:'mods-runtime-chat',modAction:action.context,model:'fixture/model',params:{useTools:true},messages:[{role:'user',content:'Write mod-proof.txt and run node test.cjs. Report actual failure.'}]})
  off()
  ensure(result.ok,'turn failed: '+JSON.stringify(result))
  const after=await api.modsPanels('mods-runtime-chat')
  ensure(after.panels[0].counts.files===1,'actual file tool event missing: '+JSON.stringify(after))
  ensure(after.panels[0].counts.failed===1,'actual failed check event missing: '+JSON.stringify(after))
  const history=await api.getRunConfigurations()
  ensure(history.records.some(r=>r.skillReads.some(s=>s.skillId==='b4d61af49c0c2d2129c391c62308126c8af380041ed2615c0011d49343937b6d')),'actual skill use not recorded')
  const list=await api.modsList()
  ensure(list.diagnostics.some(e=>e.type==='turn.completed'),'turn completion event missing')
  ensure(!JSON.stringify(list.diagnostics).includes('mod-proof'),'raw paths retained in mod diagnostics')
 `)
 assert.equal(fs.readFileSync(path.join(workspace,'mod-proof.txt'),'utf8'),'Fixture saved')
 const requests=fs.readdirSync(dump).map(name=>fs.readFileSync(path.join(dump,name),'utf8'))
 assert.ok(requests.some(text=>text.includes(instruction)),'actual provider request lacks selected skill instruction')
 const encrypted=fs.readFileSync(path.join(profile,'mods.json'),'utf8');assert.equal(JSON.parse(encrypted).enc,'safeStorage');assert.equal(encrypted.includes('Project checks'),false)
 launch('mod-restart', `
  const api=window.electronAPI,list=await api.modsList()
  ensure(list.mods.length===1&&list.mods[0].enabled,'mod lost after restart')
  const view=await api.modsPanels('mods-runtime-chat')
  ensure(view.panels.length===1&&view.panels[0].counts.files===0,'panels not restored or ephemeral counters persisted')
 `)

 const requestSnapshot=()=>JSON.stringify(fs.readdirSync(dump).sort().map(name=>[name,fs.readFileSync(path.join(dump,name),'utf8')]))
 const requestsBeforeStale=requestSnapshot()
 launch('stale-before-compression', `
  const api=window.electronAPI,view=await api.modsPanels('mods-runtime-chat'),panel=view.panels[0]
  const action=await api.modAction({chatId:'mods-runtime-chat',revision:view.revision,modId:panel.modId,panelId:panel.id,buttonId:panel.buttons.find(b=>b.action.type==='draft').id})
  ensure(action.ok,'draft missing')
  ensure((await api.modsToggle({id:panel.modId,enabled:false,revision:view.revision})).ok,'disable failed')
  let refused=false
  try { await api.sendMessage({requestId:'stale-mod',chatId:'mods-runtime-chat',modAction:action.context,model:'fixture/model',forceCompression:true,params:{useTools:true},messages:Array.from({length:12},(_,i)=>({role:i%2?'assistant':'user',content:'Stale context must not reach the provider. '.repeat(300)}))}) }
  catch { refused=true }
  ensure(refused,'disabled mod action was accepted')
 `)
 assert.ok(requestSnapshot()===requestsBeforeStale,'disabled action must fail before compression or any model call')
 settleRun(dir,true)
} catch(error){console.error(error);settleRun(dir,false);process.exitCode=1}
