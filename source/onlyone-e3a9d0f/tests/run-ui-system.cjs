// Real Chromium specimen checks. All data is isolated; no API keys or requests.
const fs = require('fs');
const path = require('path');
const os = require('os');
if (!process.argv.includes('--ui-system-probe')) {
  const { spawnSync } = require('child_process');
const { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock } = require('./app-launch.cjs');
  const dir = runDir('onlyone-ui-system');
  const result = path.join(dir, 'result.json');
  acquireWindowLock(); // окно наведение-на-координаты, второй копии тут не место
  const child = spawnSync(electronBinary(), [__filename, '--ui-system-probe', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(dir, 'profile')], {
    env: guiEnv({ ONLYONE_UI_RESULT: result }), timeout: 90000, stdio: 'ignore'
  });
  if (!fs.existsSync(result)) { console.error('No Electron report', child.error?.message, child.status); process.exit(1); }
  const report = JSON.parse(fs.readFileSync(result, 'utf8'));
  console.log(JSON.stringify(report, null, 2));
  settleRun(dir, report.ok && child.status === 0)
  process.exit(report.ok && child.status === 0 ? 0 : 1);
} else {
  const { app, BrowserWindow } = require('electron');
  const result = process.env.ONLYONE_UI_RESULT;
  const checks = [], screenshots = [];
  let win;
  const check = (name, pass, detail) => {
    checks.push({ name, pass: !!pass, ...(detail ? { detail } : {}) });
    fs.writeFileSync(result, JSON.stringify({ok:false,inProgress:true,checks,screenshots},null,2));
  };
  const js = code => win.webContents.executeJavaScript(code);
  const frames = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const key = async keyCode => { win.focus(); win.webContents.focus(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await frames(); };
  const focus = async selector => {
    win.focus(); win.webContents.focus();
    await js('document.querySelector(' + JSON.stringify(selector) + ').focus()');
    await frames();
  };
  const click = async selector => {
    const r = await js('(() => { const e = document.querySelector(' + JSON.stringify(selector) + '); e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()');
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...r});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...r});
    await frames();
  };
  const snapshot = async name => {
    await js('window.scrollTo(0,0)'); await frames();
    const file = path.join(path.dirname(result), name + '.png');
    win.webContents.debugger.attach('1.3');
    try {
      const size = await js('({width:innerWidth,height:document.documentElement.scrollHeight})');
      const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {format:'png',captureBeyondViewport:true,clip:{x:0,y:0,...size,scale:1}});
      fs.writeFileSync(file,Buffer.from(shot.data,'base64')); screenshots.push(file);
    } finally { win.webContents.debugger.detach(); }
  };
  app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({ width:1120, height:1500, show:true, autoHideMenuBar:true, webPreferences:{contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false} });
      win.webContents.on('did-fail-load', (_, code, description) => check('page loaded', false, code + ': ' + description));
      await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'ui-catalog.html'));
      await js('document.fonts.ready');
      check('unprivileged page', await js('typeof require === "undefined" && typeof window.electronAPI === "undefined"'));
      for (const theme of ['dark','light']) {
        if (await js('document.documentElement.dataset.theme || "dark"') !== theme) await click('#theme');
        await frames();
        const contrast = await js(String.raw`(() => {
          const luminance = rgb => rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v => {v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
          const pairs = ['.ui-card','.ui-small','.ui-error','.ui-button--primary','.ui-input'].map(selector=>{
            const el=document.querySelector(selector), s=getComputedStyle(el);
            let bg=s.backgroundColor, parent=el;
            while(bg==='rgba(0, 0, 0, 0)' && parent.parentElement){parent=parent.parentElement;bg=getComputedStyle(parent).backgroundColor;}
            const a=luminance(s.color),b=luminance(bg);return {selector,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
          });
          return pairs;
        })()`);
        check(theme + ' text contrast >=4.5', contrast.every(p => p.ratio >=4.5), JSON.stringify(contrast));
        check(theme + ' error token valid', await js('CSS.supports("color",getComputedStyle(document.documentElement).getPropertyValue("--err-dot").trim())'));
        check(theme + ' control border >=3', await js(String.raw`(() => {
          const l=c=>c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
          const s=getComputedStyle(document.querySelector('.ui-input')),a=l(s.borderColor),b=l(s.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=3;
        })()`));
        await snapshot(theme);
      }
      await click('#mode-trigger');
      check('select opens and focuses selected option', await js('!document.querySelector("#mode-options").hidden && document.activeElement.getAttribute("role")==="option"'));
      await snapshot('select');
      // Снимок во всю высоту меняет размер окна, а список по замыслу
      // закрывается на resize — фокус уходил с него, и клавиши жались в пустоту.
      if (await js('document.querySelector("#mode-options").hidden')) await click('#mode-trigger');
      await key('Down'); await key('Return');
      const selectState = await js('({ value: document.querySelector(".ui-select").dataset.value, focus: document.activeElement.id || document.activeElement.textContent.trim().slice(0, 20), hidden: document.querySelector("#mode-options").hidden })');
      check('select keyboard commits value', selectState.value === 'manual' && selectState.focus === 'mode-trigger' && selectState.hidden, JSON.stringify(selectState));
      await click('#mode-trigger'); await key('Escape');
      check('select Escape returns focus', await js('document.querySelector("#mode-options").hidden && document.activeElement.id==="mode-trigger"'));
      await click('#mode-trigger'); await click('#name');
      check('select outside click closes', await js('document.querySelector("#mode-options").hidden'));
      await js('document.querySelector("#tab-active").focus()'); await key('Right');
      check('tabs roving focus and panel', await js('document.activeElement.id==="tab-history" && !document.querySelector("#panel-history").hidden && document.querySelector("#panel-active").hidden'));
      await click('#open-dialog');
      check('modal opens with focus inside', await js('document.querySelector("#sample-dialog").open && !!document.activeElement.closest("dialog")'));
      await snapshot('dialog');
      await key('Tab'); await key('Tab');
      check('modal traps Tab', await js('!!document.activeElement.closest("#sample-dialog")'));
      await key('Escape');
      check('modal Escape returns focus', await js('!document.querySelector("#sample-dialog").open && document.activeElement.id==="open-dialog"'));
      await focus('.ui-tip-wrap button');
      check('tooltip keyboard visible', await js('!document.querySelector("#add-tip").hidden'));
      await key('Escape'); check('tooltip Escape', await js('document.querySelector("#add-tip").hidden'));
      await focus('#name');
      check('focus indicator', await js('getComputedStyle(document.activeElement).outlineStyle==="solid"'));
      const before = await js('document.querySelector(".ui-switch input").checked');
      await click('.ui-switch input');
      check('switch changes', before !== await js('document.querySelector(".ui-switch input").checked'));
      await js('window.disabledClicks=0; const b=document.querySelector("#button-states button[disabled]");b.addEventListener("click",()=>window.disabledClicks++);b.click()');
      check('disabled prevents action', await js('window.disabledClicks===0'));
      check('mount is idempotent', await js('OnlyoneUI.mount(document) === OnlyoneUI.mount(document)'));
      check('named controls', await js(`[...document.querySelectorAll('button,input')].every(e=>e.getAttribute('aria-label')||e.getAttribute('aria-labelledby')||e.closest('label')||e.textContent.trim())`));
      check('no native title tooltips', await js('document.querySelectorAll("[title]").length===0'));
      for (const accent of ['#d8a05a','#8fb79e','#8aa6c8','#b49ad4','#c4786e']) {
        await js('document.documentElement.dataset.accent="custom"; document.documentElement.style.setProperty("--accent-user",' + JSON.stringify(accent) + ')');
        check('custom accent contrast ' + accent, await js(String.raw`(() => {
          const l=c=>c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
          const s=getComputedStyle(document.querySelector('.ui-button--primary')),a=l(s.color),b=l(s.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;
        })()`));
      }
      await js('document.documentElement.dataset.accent=""; document.documentElement.style.removeProperty("--accent-user")');
      for (const width of [375,768,1440]) {
        win.setContentSize(width, 900); await frames();
        check('no horizontal overflow ' + width, await js('document.documentElement.scrollWidth <= innerWidth'));
        if(width===375) await snapshot('narrow');
      }
      win.setContentSize(1120,1500); win.webContents.setZoomFactor(2); await frames();
      check('200% zoom reflows', await js('document.documentElement.scrollWidth <= innerWidth'));
      win.webContents.setZoomFactor(1);
      // Emulate through Chromium: nativeTheme's OS value is read-only on some Electron versions.
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      check('reduced motion', await js('getComputedStyle(document.querySelector(".ui-switch input"),"::before").transitionDuration==="0s"'));
      win.webContents.debugger.detach();
    } catch(error) { check('runner', false, error.stack); }
    const ok = checks.length > 20 && checks.every(c=>c.pass);
    fs.writeFileSync(result, JSON.stringify({ok,checks,screenshots},null,2));
    app.exit(ok?0:1);
  });
}
