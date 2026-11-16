'use strict'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process')
const sha=data=>crypto.createHash('sha256').update(data).digest('hex')
const arg=name=>{const i=process.argv.indexOf('--'+name);if(i<0||!process.argv[i+1]||process.argv[i+1].startsWith('--'))throw Error('Required --'+name);return path.resolve(process.argv[i+1])}
function snapshot(root,files){
 return files.map(file=>{
  if(typeof file.path!=='string'||/[\\:\x00-\x1f]/.test(file.path)||file.path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Invalid manifest path')
  let current=root
  for(const part of file.path.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Source links are not supported')}
  const data=fs.readFileSync(current)
  return {path:file.path,size:data.length,sha256:sha(data)}
 }).sort((a,b)=>a.path.localeCompare(b.path,'en'))
}
async function main(){
 const checkout=arg('checkout'),manifestPath=arg('manifest'),out=arg('out')
 const relative=path.relative(fs.realpathSync(checkout),path.join(fs.realpathSync(path.dirname(out)),path.basename(out)))
 if(!relative||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep)))throw Error('Evidence must be outside checkout')
 if(fs.existsSync(out))throw Error('Evidence directory already exists')
 const manifestBytes=fs.readFileSync(manifestPath),manifest=JSON.parse(manifestBytes)
 if(!/^[a-f0-9]{40}$/i.test(manifest.revision)||!Array.isArray(manifest.files)||!manifest.files.length)throw Error('Invalid export manifest')
 const expected=manifest.files.map(({path,size,sha256})=>({path,size,sha256})).sort((a,b)=>a.path.localeCompare(b.path,'en'))
 const expectedDigest=sha(JSON.stringify(expected)),before=snapshot(checkout,manifest.files)
 if(sha(JSON.stringify(before))!==expectedDigest)throw Error('Checkout differs from export manifest')
 const git=(...args)=>execFileSync('git',['-c','safe.directory='+checkout,'-C',checkout,...args],{encoding:'utf8',windowsHide:true}).trim()
 const checkoutBefore=git('rev-parse','HEAD'),statusBefore=git('status','--porcelain')
 if(statusBefore)throw Error('Checkout must be clean before testing')
 const tracked=git('ls-files','-z').split('\0').filter(Boolean).sort()
 if(JSON.stringify(tracked)!==JSON.stringify(manifest.files.map(file=>file.path).sort()))throw Error('Git must track exactly the exported source files')
 const npm=process.env.npm_execpath||path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')
 if(!fs.existsSync(npm))throw Error('npm CLI unavailable; invoke through npm run test:public-record')
 fs.mkdirSync(out,{recursive:true})
 const log=path.join(out,'npm-test.log'),fd=fs.openSync(log,'wx'),startedAt=new Date().toISOString(),started=Date.now()
 const child=spawn(process.execPath,[npm,'test'],{cwd:checkout,windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,ONECODE_WINDOW_LOCK_WAIT:process.env.ONECODE_WINDOW_LOCK_WAIT||'1800000'}})
 console.log(JSON.stringify({pid:child.pid,revision:manifest.revision,startedAt,log}))
 let startError=false
 const result=await new Promise(resolve=>{child.once('error',()=>{startError=true});child.once('close',(code,signal)=>resolve({code,signal}))})
 fs.closeSync(fd)
 let after=[],checkoutAfter='',statusAfter='unavailable',sourceAfter=null
 try{after=snapshot(checkout,manifest.files);sourceAfter=sha(JSON.stringify(after));checkoutAfter=git('rev-parse','HEAD');statusAfter=git('status','--porcelain')}catch{/* Refuse incomplete evidence below. */}
 const changed=before.filter((file,i)=>!after[i]||JSON.stringify(file)!==JSON.stringify(after[i])).map(file=>file.path)
 const record={runner:'onlyone-public-tests/v1',command:['npm','test'],revision:manifest.revision,manifestSha256:sha(manifestBytes),sourceBefore:expectedDigest,sourceAfter,checkoutBefore,checkoutAfter,statusBefore,statusAfter,changed,...result,startedAt,finishedAt:new Date().toISOString(),durationMs:Date.now()-started,log:'npm-test.log',logSha256:sha(fs.readFileSync(log))}
 record.ok=!startError&&result.code===0&&!result.signal&&sourceAfter===expectedDigest&&checkoutAfter===checkoutBefore&&!statusAfter&&sha(fs.readFileSync(manifestPath))===record.manifestSha256
 fs.writeFileSync(path.join(out,'run.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify(record));process.exitCode=record.ok?0:1
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
