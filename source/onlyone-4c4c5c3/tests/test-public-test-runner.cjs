'use strict'
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync,execFileSync}=require('node:child_process')
const runner=path.resolve(__dirname,'../scripts/run-public-tests.cjs'),verifier=path.resolve(__dirname,'../scripts/verify-public-readiness.cjs')
assert.ok(fs.existsSync(runner),'a fixed npm test runner must record source and log hashes')
const base=fs.mkdtempSync(path.join(os.tmpdir(),'onlyone-public-runner-'))
const sha=data=>crypto.createHash('sha256').update(data).digest('hex'),revision='a'.repeat(40)
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,'-c','core.autocrlf=false',...args],{encoding:'utf8'}).trim()
// Минимальный набор обязательных файлов публичного экспорта: readiness проверяет его,
// поэтому подставной каталог не может быть «просто тремя файлами».
const REQUIRED_FILES={
 'THIRD-PARTY-NOTICES.md':'# Third-party notices\n',
 'package-lock.json':'{"lockfileVersion":3}\n',
 'LICENSES/OFL-1.1.txt':'SIL OFL 1.1\n',
 'src/renderer/vendor/react-LICENSE.txt':'MIT\n',
 'src/renderer/vendor/react-dom-LICENSE.txt':'MIT\n',
 'electron-builder.config.cjs':"module.exports = { appId: 'com.onecode.workspace' }\n",
 'build/installer.nsh':'!macro fixture\n!macroend\n',
 'resources/1code.ico':'icon fixture\n',
 'resources/cli/onlyone.cmd':'@echo off\n',
 'resources/cli/path.ps1':'# path fixture\n',
 'src/main/main.js':'// main\n',
 'src/preload/preload.js':'// preload\n',
 'src/renderer/index.html':'<!doctype html>\n',
 'src/renderer/app.js':'// app\n',
 'mobile/capacitor.config.json':JSON.stringify({appId:'best.pkwobler.onlyone',webDir:'www'})+'\n',
 'mobile/package.json':'{"name":"mobile","version":"0.0.0"}\n',
 'server/relay/package.json':'{"name":"relay","version":"0.0.0"}\n'
}
function fixture(name,test,ignored=false) {
 const dir=path.join(base,name),checkout=path.join(dir,'checkout');fs.mkdirSync(checkout,{recursive:true})
 const files={'README.md':'fixture\n','.gitignore':'stage.log\n','package.json':JSON.stringify({name:'onlyone',version:'1.0.0',main:'src/main/main.js',scripts:{build:'node -e ""','build:win':'node -e ""','test:public-record':'node -e ""',pretest:'node -e "require(\'fs\').appendFileSync(\'stage.log\',\'pre\\n\')"',test,posttest:'node -e "require(\'fs\').appendFileSync(\'stage.log\',\'post\\n\')"'}}),...REQUIRED_FILES}
 for(const [name,text] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(checkout,name)),{recursive:true});fs.writeFileSync(path.join(checkout,name),text)}
 if(ignored){files['ignored.txt']='source fixture';files['.gitignore']+='ignored.txt\n';fs.writeFileSync(path.join(checkout,'ignored.txt'),files['ignored.txt']);fs.writeFileSync(path.join(checkout,'.gitignore'),files['.gitignore'])}
 git(checkout,'init','-q');git(checkout,'add','.');git(checkout,'-c','user.name=Test','-c','user.email=test@onlyone.local','-c','commit.gpgsign=false','commit','-qm','fixture')
 const gitBlob=text=>{const data=Buffer.from(text);return crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+data.length+'\0'),data])).digest('hex')}
 const entries=Object.entries(files).map(([path,text])=>({path,size:Buffer.byteLength(text),sha256:sha(text),gitBlob:gitBlob(text),gitMode:'100644'}))
 const manifest=path.join(dir,'manifest.json');fs.writeFileSync(manifest,JSON.stringify({revision,tree:'d'.repeat(40),counts:{tracked:entries.length,included:entries.length,excluded:0,includedBytes:entries.reduce((s,f)=>s+f.size,0)},files:entries,excluded:[]}))
 return {dir,checkout,manifest,out:path.join(dir,'evidence')}
}
function run(f){return spawnSync(process.execPath,[runner,'--checkout',f.checkout,'--manifest',f.manifest,'--out',f.out],{encoding:'utf8',timeout:90000})}
try {
 const good=fixture('good','node -e "require(\'fs\').appendFileSync(\'stage.log\',\'test\\n\')"')
 let result=run(good);assert.equal(result.status,0,result.stderr);const record=JSON.parse(fs.readFileSync(path.join(good.out,'run.json')))
 assert.equal(record.ok,true);assert.equal(record.command.join(' '),'npm test');assert.equal(fs.readFileSync(path.join(good.checkout,'stage.log'),'utf8'),'pre\ntest\npost\n');assert.equal(record.sourceBefore,record.sourceAfter)
 // The verifier receives a pristine export, not the checkout's generated files and .git.
 const exportDir=path.join(good.dir,'export');fs.mkdirSync(exportDir);for(const file of JSON.parse(fs.readFileSync(good.manifest)).files){fs.mkdirSync(path.dirname(path.join(exportDir,file.path)),{recursive:true});fs.copyFileSync(path.join(good.checkout,file.path),path.join(exportDir,file.path))}
 result=spawnSync(process.execPath,[verifier,'--export',exportDir,'--manifest',good.manifest,'--run',path.join(good.out,'run.json'),'--revision',revision],{encoding:'utf8'});assert.equal(result.status,0,result.stderr)
 fs.appendFileSync(path.join(good.out,'npm-test.log'),'tampered');result=spawnSync(process.execPath,[verifier,'--export',exportDir,'--manifest',good.manifest,'--run',path.join(good.out,'run.json'),'--revision',revision],{encoding:'utf8'});assert.equal(result.status,1)
 const failed=fixture('failure','node -e "process.exit(7)"');assert.equal(run(failed).status,1);assert.equal(JSON.parse(fs.readFileSync(path.join(failed.out,'run.json'))).code,7)
 const changed=fixture('changed','node -e "require(\'fs\').appendFileSync(\'README.md\',\'changed\')"');assert.equal(run(changed).status,1);assert.equal(JSON.parse(fs.readFileSync(path.join(changed.out,'run.json'))).ok,false)
 const dirty=fixture('dirty','node -e "process.exit(0)"');fs.appendFileSync(path.join(dirty.checkout,'README.md'),'changed');assert.equal(run(dirty).status,1);assert.equal(fs.existsSync(dirty.out),false)
 const existing=fixture('existing','node -e "process.exit(0)"');fs.mkdirSync(existing.out);fs.writeFileSync(path.join(existing.out,'keep'),'keep');assert.equal(run(existing).status,1);assert.equal(fs.readFileSync(path.join(existing.out,'keep'),'utf8'),'keep')
 const ignored=fixture('ignored','node -e "process.exit(0)"',true);assert.equal(run(ignored).status,1,'all manifest files must be tracked for future clones')
 console.log('PASS public runner: full npm lifecycle, source/log binding, failed/dirty/changed runs and existing evidence refused')
} finally { fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100}) }
