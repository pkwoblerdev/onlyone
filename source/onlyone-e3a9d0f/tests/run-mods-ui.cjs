'use strict'
const fs=require('node:fs'),path=require('node:path')
if(!process.argv.includes('--probe')) {
  const {spawnSync}=require('node:child_process'),{electronBinary,guiEnv,runDir,settleRun}=require('./app-launch.cjs')
  const dir=runDir('onlyone-mods-ui'),output=path.join(dir,'result.json')
  const child=spawnSync(electronBinary(),[__filename,'--probe','--no-sandbox','--disable-gpu-sandbox','--user-data-dir='+path.join(dir,'profile')],{
    cwd:path.join(__dirname,'..'),timeout:180000,windowsHide:true,env:guiEnv({MODS_UI_DIR:dir,MODS_UI_OUT:output})})
  const result=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{ok:false,error:child.error?.message||child.stderr?.toString().slice(-1800)||'No UI result'}
  console.log(JSON.stringify(result));const ok=result.ok&&child.status===0;settleRun(dir,ok);process.exit(ok?0:1)
} else {
  const {app,BrowserWindow,ipcMain,safeStorage}=require('electron'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url')
  app.whenReady().then(async()=>{
    const dir=process.env.MODS_UI_DIR,root=path.join(__dirname,'..'),file=name=>pathToFileURL(path.join(root,'src/renderer',name)).href
    const errors=[]
    const main=new BrowserWindow({show:true,width:1080,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,preload:path.join(root,'src/preload/preload.js')}})
    main.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message)})
    const storage=require('../src/main/mods-store.cjs').createStore({file:path.join(dir,'mods.json'),
      protect:text=>safeStorage.encryptString(text).toString('base64'),unprotect:body=>safeStorage.decryptString(Buffer.from(body,'base64'))})
    let desk=null,language='en',theme='dark'
    const settings=()=>({language,theme})
    const isMain=event=>event.sender===main.webContents&&event.senderFrame===main.webContents.mainFrame
    const service=require('../src/main/mods.cjs').createMods({storage,changed:chatId=>{main.webContents.send('mods:changed',{chatId});desk?.notifyMods(chatId)}})
    const skill={id:'diagnose',name:'Fixture diagnosis',enabled:true,systemPrompt:'PRIVATE DIAGNOSIS INSTRUCTION'}
    desk=require('../src/main/desk-service.cjs').createDeskService({BrowserWindow,ipcMain,isMainWindow:isMain,focusMain:()=>main.focus(),settings,createProcessManager:()=>require('../src/main/desk-process.cjs').createDeskProcessManager(),resolveResource:async()=>({type:'unavailable'}),
      onEvent:(chat,type)=>service.event(chat,type)})
    const bridge=require('../src/main/mods-ipc.cjs').register({ipcMain,getService:()=>service,isMain,deskChat:e=>desk.chatForEvent(e),skills:()=>[skill],openDesk:chat=>desk.open(chat),deliverDraft:draft=>{main.webContents.send('mods:draft',draft);return true}})
    const target=path.join(dir,'fixture.html')
    fs.writeFileSync(target,'<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8">'+['fonts.css','tokens.css','index.css','mods.css'].map(n=>`<link rel="stylesheet" href="${file(n)}">`).join('')+
      '<body style="overflow:auto;padding:24px"><div id="mods-manager"></div><form id="fixture-form"><textarea id="fixture-input"></textarea></form>'+['i18n.js','mods-panels.js','mods-ui.js'].map(n=>`<script src="${file(n)}"></script>`).join('')+'</body></html>')
    await main.loadFile(target)
    const js=code=>main.webContents.executeJavaScript(code)
    const until=async(check,execute=js)=>{for(let i=0;i<200;i++){if(await execute(check))return;await new Promise(r=>setTimeout(r,20))}throw Error('UI timed out: '+check+'; '+await js("JSON.stringify({active:document.activeElement?.outerHTML,focused:document.hasFocus(),dialogs:[...document.querySelectorAll('dialog')].map(d=>({open:d.open,target:d.returnFocus?.id,title:d.querySelector('h2')?.textContent}))})"))}
    await js("window.fixturePane={chatId:'fixture-chat',generating:false,preparing:false,dom:{textarea:document.getElementById('fixture-input'),form:document.getElementById('fixture-form')}};window.fixtureT=s=>document.documentElement.lang==='en'?(window.__I18N__.en[s]||s):s;window.client=OnlyoneMods.create({api:electronAPI,t:fixtureT,getPane:()=>fixturePane,chatOf:p=>({id:p.chatId}),closeSettings:()=>{window.settingsClosed=(window.settingsClosed||0)+1}});client.refresh()")
    const click=text=>js(`(() => {const b=[...document.querySelectorAll('#mods-manager button')].find(x=>x.textContent===${JSON.stringify(text)}); if(!b)throw Error('Missing button: '+${JSON.stringify(text)}); b.click()})()`)
    await until('Boolean(document.querySelector("#mods-manager select option[value=diagnose]"))')
    await js("document.querySelector('#mods-manager select').value='diagnose'")
    await click('Fill example');await until("document.getElementById('mods-package').value.includes('diagnose')")
    await click('Review package');await until("Boolean([...document.querySelectorAll('button')].find(b=>b.textContent==='Install and enable'))")
    assert.equal(service.list().mods.length,0,'review has no persistence or execution')
    await js("const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Install and enable');b.click();b.click()")
    await until("Boolean([...document.querySelectorAll('h3')].find(x=>x.textContent==='Project checks · 1.0.0'))")
    assert.equal(service.list().revision,1,'double click commits once')
    assert.equal(fs.readFileSync(path.join(dir,'mods.json'),'utf8').includes('Project checks'),false,'package is encrypted')
    assert.equal(require('../src/main/mods.cjs').createMods({storage}).list().mods.length,1,'actual encrypted reload')
    fs.copyFileSync(path.join(dir,'mods.json'),path.join(dir,'good.bak'));fs.writeFileSync(path.join(dir,'mods.json'),'{damaged')
    const rec=require('../src/main/mods.cjs').createMods({storage}),notice=rec.list().recovery
    assert.ok(notice&&/^mods\.damaged-[0-9a-f]{12}\.json$/.test(notice.archive),'damaged file archived on open')
    assert.equal(fs.readFileSync(path.join(dir,notice.archive),'utf8'),'{damaged');assert.equal(rec.list().mods.length,0)
    fs.copyFileSync(path.join(dir,'good.bak'),path.join(dir,'mods.json'))
    await click('Open panels');await until("document.querySelector('.mods-panel-list .mod-card')!==null")
    const panel=service.panels('fixture-chat','main').panels[0]
    const draftButton=panel.buttons.find(b=>b.action.type==='draft')
    await js(`document.querySelectorAll('.mods-panel-list button')[${panel.buttons.indexOf(draftButton)}].click()`)
    await until("Boolean([...document.querySelectorAll('dialog h2')].find(h=>h.textContent==='Task from mod'))")
    assert.equal(await js("(()=>{const d=document.querySelector('dialog.mods-dialog'),id=d.getAttribute('aria-labelledby');return Boolean(id&&document.getElementById(id))})()"),true,'task dialog has an accessible name')
    assert.equal(await js("document.getElementById('fixture-input').value"),'','draft not inserted automatically')
    assert.equal(await js("document.body.textContent.includes('PRIVATE DIAGNOSIS INSTRUCTION')"),false)
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Insert into composer').click()")
    await until("Boolean(fixturePane.modAction)")
    await until("document.activeElement.id==='fixture-input'")
    assert.equal(await js('window.settingsClosed'),1,'inserting a mod draft closes the settings page that covered the composer')
    const taken=await js('client.takeDraft(fixturePane)')
    const prepared=require('../src/main/mods-run.cjs').prepare({chatId:'fixture-chat',...taken},bridge)
    assert.ok(prepared.payload.modSkill.prompt.includes(skill.systemPrompt),'real IPC action resolves actual skill for turn')
    assert.equal(prepared.payload.customSystemPrompt,undefined,'the role prompt is not overloaded')
    assert.equal(await js('fixturePane.modAction'),null,'context consumed once')
    await js("document.querySelector('.mods-dialog')?.close();document.getElementById('fixture-input').value='' ")
    service.event('fixture-chat','check.failed')
    await js('client.openPanels()');await until("Boolean(document.querySelector('.mod-status[data-tone=error]'))")
    assert.equal(service.panels('another-chat','desk').panels[0].counts.failed,0,'chat isolation')
    await js("[...document.querySelectorAll('.mods-panel-list button')].find(b=>b.textContent==='Open Desk').click()")
    let deskWindow
    for(let i=0;i<200;i++){deskWindow=BrowserWindow.getAllWindows().find(w=>w!==main);if(deskWindow&&!deskWindow.webContents.isLoading()&&deskWindow.webContents.getURL().endsWith('desk.html'))break;await new Promise(r=>setTimeout(r,20))}
    assert.ok(deskWindow,'real Desk opened')
    const dj=code=>deskWindow.webContents.executeJavaScript(code)
    await until("Boolean(document.getElementById('desk-mods-toggle').textContent)",dj)
    await dj("document.getElementById('desk-mods-toggle').click()")
    await until("document.querySelector('#desk-mods-panel .mod-card')!==null",dj)
    assert.equal(await dj("[...document.querySelectorAll('textarea,input:not([type=hidden])')].filter(x=>x.getClientRects().length).length"),0,'Desk has no composer')
    await dj(`document.querySelectorAll('#desk-mods-panel .mod-controls button')[${panel.buttons.indexOf(draftButton)}].click()`)
    await until("Boolean([...document.querySelectorAll('dialog h2')].find(h=>h.textContent==='Task from mod'))")
    assert.equal(await js("document.getElementById('fixture-input').value"),'','Desk routes draft without sending')
    await js("[...document.querySelectorAll('dialog')].forEach(d=>d.close())")
    deskWindow.setSize(760,640)
    const shots=process.env.MODS_SHOTS
    for(const lang of ['ru','en'])for(const skin of ['dark','light']) {
      language=lang;theme=skin
      await js(`document.documentElement.lang='${lang}';document.documentElement.dataset.theme='${skin}';window.client=OnlyoneMods.create({api:electronAPI,t:fixtureT,getPane:()=>fixturePane,chatOf:p=>({id:p.chatId})});client.refresh()`)
      await until("Boolean(document.querySelector('#mods-manager select option[value=diagnose]'))")
      desk.refresh('fixture-chat');await until(`document.documentElement.lang==='${lang}' && document.documentElement.dataset.theme==='${skin}'`,dj)
      assert.equal(await dj("document.documentElement.scrollWidth <= innerWidth+1"),true,'Desk page fits narrow viewport')
      assert.equal(await dj("document.querySelector('.desk-bar').scrollWidth <= document.querySelector('.desk-bar').clientWidth+1"),true,'Desk toolbar fits narrow window')
      assert.equal(await js("document.getElementById('mods-manager').scrollWidth <= document.getElementById('mods-manager').clientWidth+1"),true,'manager fits')
      if(lang==='en')assert.equal(await js("/[А-Яа-яЁё]/.test(document.getElementById('mods-manager').textContent)"),false,await js("document.getElementById('mods-manager').textContent"))
      if(shots){fs.mkdirSync(shots,{recursive:true});fs.writeFileSync(path.join(shots,`mods-${lang}-${skin}.png`),(await main.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(shots,`desk-mods-${lang}-${skin}.png`),(await deskWindow.webContents.capturePage()).toPNG())}
    }
    await js("document.documentElement.lang='en'")
    const before=service.list().revision
    const disabled=service.toggle(panel.modId,false,before);assert.equal(disabled.ok,true)
    assert.equal(bridge.resolveSkill('fixture-chat',taken.modAction).ok,false,'stale selected action cannot execute')
    await until("document.querySelectorAll('#desk-mods-panel .mod-card').length===0",dj)
    assert.equal(errors.length,0,errors.join('\n'))
    desk.dispose();main.destroy()
    fs.writeFileSync(process.env.MODS_UI_OUT,JSON.stringify({ok:true,checks:'actual main/Desk IPC, review/confirm, encryption/reload, scoped events, draft/skill, disable/stale, no Desk composer, RU/EN × dark/light',errors}))
    app.exit(0)
  }).catch(error=>{fs.writeFileSync(process.env.MODS_UI_OUT,JSON.stringify({ok:false,error:error.stack}));app.exit(1)})
}
