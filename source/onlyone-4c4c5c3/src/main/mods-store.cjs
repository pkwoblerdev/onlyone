'use strict'
const fs = require('node:fs'), path = require('node:path'), { createHash, randomUUID } = require('node:crypto')
// Two kinds of failure, kept apart: damage (the bytes on disk can never be read
// by this profile) and unavailability (try again later). Only damage may be archived.
const damaged = () => Object.assign(Error('mods-store-damaged'), { code: 'mods-store-damaged' })
const unavailable = () => Object.assign(Error('mods-encryption-unavailable'), { code: 'mods-encryption-unavailable' })
function createStore ({ file,protect,unprotect }) {
  function load () {
    let raw
    try { if(fs.statSync(file).size>8*1024*1024)throw damaged(); raw=fs.readFileSync(file,'utf8') } catch(error){if(error.code==='ENOENT')return null;throw error}
    let envelope
    try { envelope=JSON.parse(raw) } catch { throw damaged() }
    if(!envelope||envelope.enc!=='safeStorage'||typeof envelope.data!=='string'||Object.prototype.hasOwnProperty.call(envelope,'__proto__'))throw damaged()
    if(!unprotect)throw unavailable()
    let text
    try { text=unprotect(envelope.data) } catch(error){ if(error?.code==='mods-encryption-unavailable')throw error; throw damaged() }
    let value
    try { value=JSON.parse(text) } catch { throw damaged() }
    if(value&&Object.prototype.hasOwnProperty.call(value,'__proto__'))throw damaged()
    return value
  }
  // A byte copy beside the original, named by its content: the same damaged file
  // is archived once however often loading is retried, and nothing is overwritten.
  function archive () {
    const bytes=fs.readFileSync(file)
    const aside=path.join(path.dirname(file),'mods.damaged-'+createHash('sha256').update(bytes).digest('hex').slice(0,12)+'.json')
    try { fs.writeFileSync(aside,bytes,{flag:'wx',mode:0o600}) } catch(error){ if(error.code!=='EEXIST'||!fs.readFileSync(aside).equals(bytes))throw error }
    return path.basename(aside)
  }
  function save (state) {
    if(!protect)throw unavailable()
    const data=protect(JSON.stringify(state))
    if(typeof data!=='string'||!data)throw unavailable()
    const raw=JSON.stringify({enc:'safeStorage',data})
    if(Buffer.byteLength(raw)>8*1024*1024)throw Error('mods-store-limit')
    fs.mkdirSync(path.dirname(file),{recursive:true})
    const temporary=file+'.'+randomUUID()+'.tmp'
    try{fs.writeFileSync(temporary,raw,{flag:'wx',mode:0o600});fs.renameSync(temporary,file)}finally{try{fs.unlinkSync(temporary)}catch(error){if(error.code!=='ENOENT')throw error}}
  }
  return { load,save,archive }
}
module.exports={createStore}
