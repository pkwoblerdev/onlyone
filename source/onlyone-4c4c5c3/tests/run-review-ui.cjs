const fs=require('fs'),path=require('path'),os=require('os');
if(!process.argv.includes('--probe')) {
  const {spawnSync}=require('child_process'),{electronBinary,guiEnv,runDir,settleRun,acquireWindowLock}=require('./app-launch.cjs');
  const dir=runDir('onlyone-review-ui'),out=path.join(dir,'result.json');
  // Окно одно на машину: наведение мыши на контрол и подсказка фокуса не
  // терпят второго окна поверх (замер 24.09: первая попытка красной, вторая
  // зелёная без изменения кода). ONECODE_SMOKE здесь нет — замок берём явно.
  acquireWindowLock();
  const timeoutMs=180000;
  const child=spawnSync(electronBinary(),[__filename,'--probe','--no-sandbox','--disable-gpu-sandbox','--user-data-dir='+path.join(dir,'profile')],{
    env:guiEnv({REVIEW_UI_OUT:out}),timeout:timeoutMs,encoding:'utf8',maxBuffer:1024*1024,windowsHide:true
  });
  if(!fs.existsSync(out)) {
    const detail=[child.error?.message,child.stderr,child.stdout].filter(Boolean).join('\n').trim().slice(-4000);
    throw Error(`No Electron result (status ${child.status}, signal ${child.signal}, limit ${timeoutMs} ms)${detail?'\n'+detail:''}`);
  }
  const r=JSON.parse(fs.readFileSync(out,'utf8'));console.log(JSON.stringify(r,null,2));const green=r.ok&&child.status===0;settleRun(dir,green);process.exit(green?0:1);
} else {
  const {app,BrowserWindow}=require('electron'),checks=[];
  const check=(name,pass)=>checks.push({name,pass:!!pass});
  app.whenReady().then(async()=>{
    let win;
    try {
      win=new BrowserWindow({show:true,width:1100,height:850,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
      const js=s=>win.webContents.executeJavaScript(s);
      await win.loadFile(path.join(__dirname,'../src/renderer/ui-catalog.html'));
      const emoji=await js(`(()=>{
        const html='<a data-note="x > 🌴" href="https://example.com/">🚀</a><code>✅</code>';
        const out=formatWithEmoji(html),t=document.createElement('template');t.innerHTML=out;
        const twice=formatWithEmoji(out);
        return {attribute:t.content.querySelector('a').getAttribute('data-note')==='x > 🌴',
          code:t.content.querySelector('code').innerHTML==='✅',
          idempotent:twice===out,
          count:t.content.querySelectorAll('.ui-emoji').length===1};
      })()`);
      for(const [name,pass] of Object.entries(emoji))check('emoji '+name,pass);
      // Keyboard focus shows the tooltip synchronously; read one snapshot before native window events can change it.
      const keyboard=await js(`(()=>{const b=document.createElement('button');b.id='audit-tooltip';b.textContent='Проверить';b.dataset.tooltip='Описание действия';b.setAttribute('aria-describedby','existing-description');document.querySelector('header').append(b);b.focus();
        const tip=document.querySelector('#onlyone-global-tooltip');
        return {focused:document.activeElement===b,linked:b.getAttribute('aria-describedby').split(' ').includes('onlyone-global-tooltip'),visible:!!tip&&!tip.hidden}})()`);
      check('keyboard focus reaches control',keyboard.focused);
      check('tooltip linked to focused control',keyboard.linked);
      check('tooltip visible for keyboard',keyboard.visible);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await new Promise(r=>setTimeout(r,150));
      check('tooltip restores existing description',await js(`document.querySelector('#audit-tooltip').getAttribute('aria-describedby')==='existing-description'`));
      await js(`new Promise(resolve=>{const l=document.createElement('link');l.rel='stylesheet';l.href='index.css';l.onload=resolve;document.head.append(l)})`);
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      check('real reduced-motion media emulation',await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`));
      check('production CSS disables spinner',await js(`(()=>{const e=document.createElement('span');e.className='asterisk-spinner';document.body.append(e);const s=getComputedStyle(e);return s.animationName==='none'||parseFloat(s.animationDuration)<=.001})()`));
      check('reduced motion disables every transient agent mark',await js(`['tick','is-settled','spun','burst'].every(state=>{const e=document.createElement('span');e.className='agent-mark '+state;document.body.append(e);const ok=getComputedStyle(e).animationName==='none';e.remove();return ok})`));
      win.webContents.debugger.detach();
      const shot=path.join(path.dirname(process.env.REVIEW_UI_OUT),'review.png');
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      fs.writeFileSync(shot,(await win.webContents.capturePage()).toPNG());
    }catch(e){checks.push({name:'runner',pass:false,error:e.stack})}
    const ok=checks.length>=9&&checks.every(c=>c.pass);
    fs.writeFileSync(process.env.REVIEW_UI_OUT,JSON.stringify({ok,checks,artifacts:path.dirname(process.env.REVIEW_UI_OUT)},null,2));app.exit(ok?0:1);
  });
}
