'use strict'
const { createHash, randomUUID } = require('node:crypto')
const copy = value => JSON.parse(JSON.stringify(value))
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ID = /^[a-z][a-z0-9._-]{0,79}$/
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const EVENTS = ['files.changed', 'check.passed', 'check.failed', 'turn.completed', 'turn.failed', 'desk.file.changed']
const PERMISSIONS = ['ui.panels', 'events.observe', 'chat.draft', 'desk.open', 'skills.suggest']
function object (value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.prototype.hasOwnProperty.call(value, '__proto__') || Object.keys(value).some(key => !keys.includes(key))) throw Error('invalid-object')
  return value
}
function text (value, limit, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) throw Error('invalid-text')
  return value
}
function identifier (value) { if (typeof value !== 'string' || !ID.test(value) || RESERVED_IDS.has(value)) throw Error('invalid-id'); return value }
function skillId (value) { return text(value, 160) }
function checkDependencyCycles (mods) {
  const graph = new Map()
  for (const m of mods || []) {
    const pkg = m.package || m
    if (pkg && pkg.id) {
      graph.set(pkg.id, Array.isArray(pkg.dependencies) ? pkg.dependencies : [])
    }
  }
  const visited = new Map()
  function hasCycle (node) {
    visited.set(node, 1)
    const neighbors = graph.get(node) || []
    for (const neighbor of neighbors) {
      if (neighbor === node) return true
      const st = visited.get(neighbor) || 0
      if (st === 1) return true
      if (st === 0 && graph.has(neighbor)) {
        if (hasCycle(neighbor)) return true
      }
    }
    visited.set(node, 2)
    return false
  }
  for (const node of graph.keys()) {
    if ((visited.get(node) || 0) === 0) {
      if (hasCycle(node)) return true
    }
  }
  return false
}
function validatePackage (input) {
  if (typeof input === 'string') { if (Buffer.byteLength(input) > 32768) throw Error('package-limit'); input = JSON.parse(input) }
  object(input, ['format','apiVersion','id','name','version','description','permissions','panels','rules','dependencies'])
  let dependencies = []
  if (input.dependencies !== undefined) {
    if (!Array.isArray(input.dependencies) || input.dependencies.length > 16) throw Error('invalid-dependencies')
    if (new Set(input.dependencies).size !== input.dependencies.length) throw Error('invalid-dependencies')
    dependencies = input.dependencies.map(dep => {
      const id = identifier(dep)
      if (id === input.id) throw Error('cyclic-dependency')
      return id
    })
  }
  if (input.format !== 'onlyone.mod' || input.apiVersion !== 1 || typeof input.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(input.version)) throw Error('unsupported-version')
  if (!Array.isArray(input.permissions) || input.permissions.some(p => !PERMISSIONS.includes(p)) || new Set(input.permissions).size !== input.permissions.length) throw Error('invalid-permission')
  const required = new Set(['ui.panels'])
  if (!Array.isArray(input.panels) || !input.panels.length || input.panels.length > 4) throw Error('invalid-panels')
  const panels = input.panels.map(panel => {
    object(panel, ['id','title','body','surfaces','metrics','buttons'])
    if (!Array.isArray(panel.surfaces) || !panel.surfaces.length || panel.surfaces.some(p => !['main','desk'].includes(p)) || new Set(panel.surfaces).size !== panel.surfaces.length) throw Error('invalid-surface')
    const metrics = panel.metrics === undefined ? [] : panel.metrics
    if (!Array.isArray(metrics) || metrics.length > 3 || metrics.some(p => !['files','passed','failed'].includes(p)) || new Set(metrics).size !== metrics.length) throw Error('invalid-metric')
    if (metrics.length) required.add('events.observe')
    if (!Array.isArray(panel.buttons) || panel.buttons.length > 4) throw Error('invalid-buttons')
    const buttons = panel.buttons.map(button => {
      object(button, ['id','label','action']); object(button.action, ['type','text','skillId'])
      const action = { type: button.action.type }
      if (action.type === 'open_desk') {
        if (button.action.text !== undefined || button.action.skillId !== undefined) throw Error('invalid-action')
        required.add('desk.open')
      } else if (action.type === 'draft') {
        required.add('chat.draft'); action.text = text(button.action.text, 2000)
        if (button.action.skillId !== undefined) { action.skillId = skillId(button.action.skillId); required.add('skills.suggest') }
      } else throw Error('unsupported-action')
      return { id: identifier(button.id), label: text(button.label, 80), action }
    })
    if (new Set(buttons.map(b => b.id)).size !== buttons.length) throw Error('duplicate-button')
    return { id: identifier(panel.id), title: text(panel.title, 100), body: text(panel.body === undefined ? '' : panel.body, 2000, true), surfaces: [...panel.surfaces], metrics: [...metrics], buttons }
  })
  if (new Set(panels.map(p => p.id)).size !== panels.length) throw Error('duplicate-panel')
  if (!Array.isArray(input.rules) || input.rules.length > 16) throw Error('invalid-rules')
  const rules = input.rules.map(rule => {
    object(rule, ['event','panelId','text','tone','skillId','prompt','after'])
    if (!EVENTS.includes(rule.event) || !panels.some(p => p.id === rule.panelId) || !['info','warning','success','error'].includes(rule.tone)) throw Error('invalid-rule')
    // `after` names an earlier event in the same chat; the current event never counts,
    // so an equal pair could never fire and is refused.
    if (rule.after !== undefined && (!EVENTS.includes(rule.after) || rule.after === rule.event)) throw Error('invalid-rule')
    required.add('events.observe')
    const result = { event: rule.event, panelId: rule.panelId, text: text(rule.text, 400), tone: rule.tone }
    if (rule.after !== undefined) result.after = rule.after
    if (rule.skillId !== undefined) {
      required.add('skills.suggest'); required.add('chat.draft')
      result.skillId = skillId(rule.skillId); result.prompt = text(rule.prompt, 2000)
    } else if (rule.prompt !== undefined) throw Error('invalid-skill-prompt')
    return result
  })
  if ([...required].some(p => !input.permissions.includes(p)) || input.permissions.some(p => !required.has(p))) throw Error('permission-mismatch')
  const pack = { format: 'onlyone.mod', apiVersion: 1, id: identifier(input.id), name: text(input.name,100), version: input.version,
    description: text(input.description === undefined ? '' : input.description, 1000, true), permissions: [...required].sort(), ...(dependencies.length ? { dependencies } : {}), panels, rules }
  if (Buffer.byteLength(JSON.stringify(pack)) > 32768) throw Error('package-limit')
  return pack
}
function samplePackage (diagnosticSkill) {
  const skill = diagnosticSkill ? { skillId: diagnosticSkill } : {}
  return validatePackage({ format:'onlyone.mod',apiVersion:1,id:'onlyone.project-checks',name:'Project checks',version:'1.0.0',
    description:'A dashboard for file changes and project checks. Buttons prepare tasks; only the user sends them.',
    permissions:['ui.panels','events.observe','chat.draft','desk.open',...(diagnosticSkill?['skills.suggest']:[])],
    panels:[{id:'checks',title:'Project checks',body:'Changes and checks observed in this chat during the current application session.',surfaces:['main','desk'],metrics:['files','passed','failed'],buttons:[
      {id:'test',label:'Prepare project check',action:{type:'draft',text:'Inspect the current Workspace and run its configured tests. Report the actual exit status. Do not install dependencies without permission.',...skill}},
      {id:'desk',label:'Open Desk',action:{type:'open_desk'}}]}],
    rules:[{event:'files.changed',panelId:'checks',text:'Files changed. Prepare a fresh project check.',tone:'warning'},
      {event:'desk.file.changed',panelId:'checks',text:'A watched file changed. Prepare a fresh project check.',tone:'warning'},
      {event:'check.passed',panelId:'checks',text:'A check command returned exit code 0. This alone does not confirm the entire task.',tone:'success'},
      {event:'check.failed',panelId:'checks',text:'A check command failed. Inspect the cause before retrying.',tone:'error',...skill,
        ...(diagnosticSkill?{prompt:'Diagnose the failed project check. Read its actual output and verify any proposed fix.'}:{})}]
  })
}
function cleanState (value) {
  if (value === null) return { schemaVersion:1, revision:0, mods:[] }
  object(value,['schemaVersion','revision','mods'])
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.mods) || value.mods.length > 16) throw Error('invalid-state')
  const mods = value.mods.map(item => {
    object(item,['package','enabled','history'])
    if (typeof item.enabled !== 'boolean' || !Array.isArray(item.history) || item.history.length > 2) throw Error('invalid-state')
    const pack = validatePackage(item.package), history = item.history.map(validatePackage)
    if (history.some(previous => previous.id !== pack.id)) throw Error('invalid-history')
    return { package:pack, enabled:item.enabled, history }
  })
  if (new Set(mods.map(item=>item.package.id)).size !== mods.length) throw Error('duplicate-mod')
  return { schemaVersion:1,revision:value.revision,mods }
}
// What survives of a state that failed the strict check: each valid package with
// its valid history; an unclear switch means disabled. The revision moves past
// the old one so an action prepared before the damage cannot match.
function salvage (value) {
  const items = Array.isArray(value?.mods) ? value.mods : null, mods = []
  for (const item of items || []) {
    if (mods.length >= 16) break
    try {
      const pack = validatePackage(item.package)
      if (mods.some(kept=>kept.package.id===pack.id)) continue
      const history = (Array.isArray(item.history)?item.history:[]).flatMap(previous=>{try{const old=validatePackage(previous);return old.id===pack.id?[old]:[]}catch{return []}}).slice(0,2)
      mods.push({ package:pack,enabled:item.enabled===true,history })
    } catch {}
  }
  const revision = Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision+1 : 1
  return { state:cleanState({ schemaVersion:1,revision,mods }),restored:mods.length,dropped:items?items.length-mods.length:null }
}
// Damage is never answered by a silent reset: the original bytes are archived
// first, and only then does the salvaged state replace them. An outage of the
// encryption, a busy file or a failed archive leave everything as it is.
function open (storage) {
  let value
  try { value = storage.load() } catch (error) {
    if (error?.code!=='mods-store-damaged' || typeof storage.archive!=='function') throw error
    value = undefined
  }
  if (value !== undefined) {
    try { return { state:cleanState(value),recovery:null } } catch (error) { if (typeof storage.archive!=='function') throw error }
  }
  const archive = String(storage.archive()), saved = salvage(value)
  storage.save(saved.state)
  return { state:saved.state,recovery:{ archive,restored:saved.restored,dropped:saved.dropped } }
}
function createMods ({ storage, changed = () => {}, now = Date.now }) {
  let { state, recovery } = open(storage), pending = null
  const chats = new Map(), diagnostics = [], salt = randomUUID()
  const fail = code => ({ ok:false,code })
  const notify = chatId => { try { changed(chatId) } catch {} }
  const validChat = chatId => typeof chatId === 'string' && chatId.length > 0 && chatId.length <= 200 && !/[\u0000-\u001f]/.test(chatId)
  function save (mods) {
    const next = cleanState({ schemaVersion:1,revision:state.revision+1,mods })
    const changedIds = new Set([...state.mods,...next.mods].map(item=>item.package.id).filter(id=>{
      const before=state.mods.find(item=>item.package.id===id),after=next.mods.find(item=>item.package.id===id)
      return !before||!after||hash(before)!==hash(after)
    }))
    storage.save(next); state = next
    for(const record of chats.values())for(const key of record.statuses.keys())if(changedIds.has(key.split(':')[0]))record.statuses.delete(key)
    notify(null)
  }
  function preview (input) {
    pending = null
    try {
      const previous = typeof input?.rollback === 'string' ? state.mods.find(item=>item.package.id===input.rollback)?.history[0] : null
      if (input?.rollback && !previous) return fail('no-history')
      const pack = validatePackage(previous || input?.package), installed = state.mods.find(item=>item.package.id===pack.id)
      if (!previous && installed && installed.package.version===pack.version && hash(installed.package)!==hash(pack)) return fail('same-version')
      if (!installed && state.mods.length >= 16) return fail('limit')
      const candidateMods = state.mods.filter(item=>item.package.id!==pack.id).concat([{ package: pack }])
      if (checkDependencyCycles(candidateMods)) return fail('cyclic-dependency')
      pending = { token:randomUUID(),package:pack,revision:state.revision,expires:now()+300000 }
      return { ok:true,token:pending.token,package:copy(pack),previousVersion:installed?.package.version || null,rollback:Boolean(previous),revision:state.revision }
    } catch (error) { return fail(error?.message === 'cyclic-dependency' ? 'cyclic-dependency' : 'invalid-package') }
  }
  function commit (token) {
    const intent = pending
    if (!intent || token !== intent.token) return fail('expired')
    pending = null
    if (now()>intent.expires) return fail('expired')
    if (state.revision!==intent.revision) return fail('conflict')
    try {
      const mods = copy(state.mods), previous = mods.find(item=>item.package.id===intent.package.id)
      const item = { package:intent.package,enabled:true,history:previous ? [previous.package,...previous.history].filter(p=>hash(p)!==hash(intent.package)).slice(0,2) : [] }
      if (previous) mods[mods.indexOf(previous)] = item; else mods.push(item)
      save(mods); return { ok:true,revision:state.revision }
    } catch { return fail('write-failed') }
  }
  function change (id, revision, transform) {
    if (revision!==state.revision) return fail('conflict')
    if (!state.mods.some(item=>item.package.id===id)) return fail('missing')
    try { save(transform(copy(state.mods))); return { ok:true,revision:state.revision } } catch { return fail('write-failed') }
  }
  function runtime (chatId) {
    if (!validChat(chatId)) return null
    let record = chats.get(chatId)
    if (!record) record = { counts:{files:0,passed:0,failed:0},files:new Set(),statuses:new Map(),events:[] }
    else chats.delete(chatId)
    chats.set(chatId,record)
    if (chats.size>32) chats.delete(chats.keys().next().value)
    return record
  }
  // `files` are the caller's normalized absolute paths. Only a salted digest is
  // kept, for this process: the counter is distinct files, never a path.
  function event (chatId,type,files) {
    if (!EVENTS.includes(type) || !state.mods.some(item=>item.enabled)) return false
    const record = runtime(chatId); if (!record) return false
    if (['files.changed','desk.file.changed'].includes(type)) {
      for (const file of (Array.isArray(files)?files:[]).slice(0,8)) {
        if (typeof file==='string'&&file&&file.length<=4096&&record.files.size<10000) record.files.add(createHash('sha256').update(salt+'\0'+file).digest('hex').slice(0,32))
      }
      record.counts.files=record.files.size
    }
    if (type==='check.passed') record.counts.passed=Math.min(1000000,record.counts.passed+1)
    if (type==='check.failed') record.counts.failed=Math.min(1000000,record.counts.failed+1)
    // Rules cannot emit events or invoke each other. Order is mod id, then manifest order.
    // Matching uses only events that already happened in this chat; the current one is
    // appended afterwards, so it cannot satisfy its own `after`.
    for (const mod of [...state.mods].filter(item=>item.enabled).sort((a,b)=>a.package.id.localeCompare(b.package.id))) {
      for (const rule of mod.package.rules) if (rule.event===type && (!rule.after || record.events.includes(rule.after))) record.statuses.set(mod.package.id+':'+rule.panelId,copy(rule))
    }
    record.events.push(type); if (record.events.length>8) record.events.shift()
    diagnostics.push({type,at:now()}); if(diagnostics.length>32)diagnostics.shift()
    notify(chatId); return true
  }
  function panels (chatId,surface) {
    if (!['main','desk'].includes(surface)) return fail('invalid-surface')
    if (!validChat(chatId)) return fail('chat-required')
    const record = chats.get(chatId) || { counts:{files:0,passed:0,failed:0},statuses:new Map() }
    return { ok:true,revision:state.revision,chatId,panels:state.mods.filter(item=>item.enabled).sort((a,b)=>a.package.id.localeCompare(b.package.id)).flatMap(item=>item.package.panels
      .filter(panel=>panel.surfaces.includes(surface)).map(panel=>({ ...copy(panel),modId:item.package.id,modName:item.package.name,modHash:hash(item.package),
        counts:Object.fromEntries(panel.metrics.map(metric=>[metric,record.counts[metric]])),status:copy(record.statuses.get(item.package.id+':'+panel.id)||null),statusHash:hash(record.statuses.get(item.package.id+':'+panel.id)||null) }))) }
  }
  function action (chatId,input) {
    if (!validChat(chatId)) return fail('chat-required')
    if (input?.revision!==state.revision) return fail('conflict')
    const mod = state.mods.find(item=>item.enabled&&item.package.id===input.modId), panel=mod?.package.panels.find(p=>p.id===input.panelId)
    if(!panel)return fail('missing')
    let action = panel.buttons.find(button=>button.id===input.buttonId)?.action
    if(input.suggestion===true) {
      const status=runtime(chatId)?.statuses.get(mod.package.id+':'+panel.id)
      if(!status?.skillId)return fail('missing')
      if(input.statusHash!==undefined&&input.statusHash!==hash(status))return fail('conflict')
      action={type:'draft',text:status.prompt,skillId:status.skillId}
    }
    if(!action)return fail('missing')
    return {ok:true,...copy(action),modName:mod.package.name,modHash:hash(mod.package),context:{modId:mod.package.id,panelId:panel.id,
      ...(input.suggestion?{suggestion:true,statusHash:hash(runtime(chatId).statuses.get(mod.package.id+':'+panel.id))}:{buttonId:input.buttonId}),revision:state.revision,chatId}}
  }
  return { preview,commit,event,panels,action,
    list:()=>({ok:true,revision:state.revision,mods:copy(state.mods),diagnostics:copy(diagnostics),recovery:recovery&&copy(recovery)}),
    toggle:(id,enabled,revision)=>typeof enabled!=='boolean'?fail('invalid'):change(id,revision,mods=>mods.map(item=>item.package.id===id?{...item,enabled}:item)),
    remove:(id,revision)=>change(id,revision,mods=>mods.filter(item=>item.package.id!==id)) }
}
module.exports = { validatePackage,samplePackage,cleanState,createMods,checkDependencyCycles }
