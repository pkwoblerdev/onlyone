'use strict'
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { validatePackage, createMods } = require('../src/main/mods.cjs')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// A composite rule needs an earlier event in the same chat; the plain panel is
// the control: its identical-event rule must fire when the composite one does not.
const fixture = () => ({
  format:'onlyone.mod',apiVersion:1,id:'onlyone.rule-fixture',name:'Rule fixture',version:'1.0.0',
  permissions:['ui.panels','events.observe','chat.draft','skills.suggest'],
  panels:[
    {id:'checks',title:'Checks',body:'',surfaces:['main','desk'],buttons:[{id:'test',label:'Prepare check',action:{type:'draft',text:'Inspect the workspace and run its checks.'}}]},
    {id:'plain',title:'Plain',body:'',surfaces:['main'],buttons:[]}
  ],
  rules:[
    {event:'check.failed',panelId:'checks',after:'files.changed',text:'A check failed after files changed. Diagnose it.',tone:'error',skillId:'diagnostics',prompt:'Read the failed check output and verify any fix.'},
    {event:'turn.completed',panelId:'checks',text:'Turn completed.',tone:'info'},
    {event:'check.failed',panelId:'plain',text:'A check failed.',tone:'error'}
  ]
})
const withAfter = after => ({...fixture(),rules:fixture().rules.map((rule,index)=>index?rule:{...rule,after})})
const pack = validatePackage(fixture())
assert.equal(pack.rules[0].after,'files.changed','after survives validation')
assert.equal('after' in pack.rules[1],false,'a simple rule stays simple')
for (const after of ['build.failed','check.failed',42,null,'']) assert.throws(()=>validatePackage(withAfter(after)),undefined,'after must be a different known event: '+String(after))
const make = () => {
  let saved = null
  const storage = {load:()=>saved,save:value=>{saved=structuredClone(value)}}
  const service = createMods({storage,now:()=>100})
  const preview = service.preview({package:pack})
  assert.equal(service.commit(preview.token).ok,true)
  return {service,storage}
}
const statusOf = (service,chat,panel='checks') => service.panels(chat,'main').panels.find(p=>p.id===panel)?.status
const {service,storage} = make()

// The same check.failed reaches the plain rule but not the composite one.
service.event('chat-a','check.failed')
assert.equal(statusOf(service,'chat-a','plain').tone,'error','a simple rule still matches its event')
assert.equal(statusOf(service,'chat-a','checks'),null,'check.failed alone does not satisfy after:files.changed')
assert.equal(service.panels('chat-a','desk').panels.find(p=>p.id==='checks').status,null,'the composite rule is gated on both surfaces')

// check.failed before files.changed is not composite, and files.changed does not look back.
service.event('chat-d','check.failed')
service.event('chat-d','files.changed')
assert.equal(statusOf(service,'chat-d','checks'),null,'an earlier failed check is not retroactively diagnosed')

service.event('chat-a','files.changed')
assert.equal(statusOf(service,'chat-a','checks'),null,'files.changed alone sets no failed-check status')
service.event('chat-a','check.failed')
const composite = statusOf(service,'chat-a','checks')
assert.equal(composite.tone,'error')
assert.equal(composite.skillId,'diagnostics')
assert.match(composite.text,/files changed/)
let view = service.panels('chat-a','main'), checks = view.panels.find(p=>p.id==='checks')
assert.equal(checks.statusHash,hash(composite))
assert.notEqual(checks.statusHash,hash(null))

// The existing suggestion action prepares the diagnostic draft from the status.
const suggestion = service.action('chat-a',{modId:pack.id,panelId:'checks',suggestion:true,statusHash:checks.statusHash,revision:view.revision})
assert.equal(suggestion.ok,true)
assert.equal(suggestion.type,'draft')
assert.equal(suggestion.skillId,'diagnostics')
assert.equal(suggestion.text,'Read the failed check output and verify any fix.')
assert.equal(suggestion.input,undefined)
assert.equal(service.action('chat-a',{modId:pack.id,panelId:'checks',suggestion:true,statusHash:hash(null),revision:view.revision}).code,'conflict','a stale status hash is refused')

// A different rule on the same panel changes the hash; repeating the composite restores it.
service.event('chat-a','turn.completed')
checks = service.panels('chat-a','main').panels.find(p=>p.id==='checks')
assert.notEqual(checks.statusHash,hash(composite),'statusHash follows the rule that matched')
assert.equal(checks.statusHash,hash(statusOf(service,'chat-a','checks')))
assert.equal(service.action('chat-a',{modId:pack.id,panelId:'checks',suggestion:true,statusHash:hash(composite),revision:service.list().revision}).code,'missing','the turn status offers no diagnostic')
service.event('chat-a','files.changed')
service.event('chat-a','check.failed')
assert.equal(service.panels('chat-a','main').panels.find(p=>p.id==='checks').statusHash,hash(composite),'the same composite rule hashes the same again')

// History is per chat and remembers only the last eight event types.
service.event('chat-b','files.changed')
service.event('chat-b','check.failed')
assert.equal(statusOf(service,'chat-b','checks').tone,'error')
service.event('chat-c','check.failed')
assert.equal(statusOf(service,'chat-c','checks'),null,'history does not leak between chats')
service.event('chat-e','files.changed')
for (let i=0;i<8;i++) service.event('chat-e','desk.file.changed')
service.event('chat-e','check.failed')
assert.equal(statusOf(service,'chat-e','checks'),null,'only the last eight event types are remembered')

// Neither the status nor the history survives a restart.
const restarted = createMods({storage,now:()=>100})
assert.equal(statusOf(restarted,'chat-a','checks'),null,'panel status is not persisted')
restarted.event('chat-a','check.failed')
assert.equal(statusOf(restarted,'chat-a','checks'),null,'event history is not persisted across restart')

// Toggling the mod clears the composite status; re-enabling does not resurrect it.
assert.equal(service.toggle(pack.id,false,service.list().revision).ok,true)
assert.equal(service.panels('chat-a','main').panels.length,0)
assert.equal(service.toggle(pack.id,true,service.list().revision).ok,true)
assert.equal(statusOf(service,'chat-a','checks'),null,'reenabling does not resurrect the composite status')
console.log('PASS Mods rules: validated after, composite gating and order, per-chat session history (last 8), simple rules, diagnostic suggestion, status hash, toggle and restart reset')
