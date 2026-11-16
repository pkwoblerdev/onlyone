'use strict'
const fs = require('node:fs'), path = require('node:path')
if (!process.argv.includes('--probe')) {
  const { spawnSync } = require('node:child_process')
  const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
  const dir = runDir('onlyone-change-review'), output = path.join(dir, 'result.json')
  const child = spawnSync(electronBinary(), [__filename, '--probe', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(dir, 'profile')], {
    cwd: path.join(__dirname, '..'), timeout: 60000, windowsHide: true, env: guiEnv({ CHANGE_REVIEW_OUT: output, CHANGE_REVIEW_DIR: dir })
  })
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output,'utf8')) : { ok: false, error: child.error?.message || 'No window result' }
  console.log(JSON.stringify(result))
  const ok = result.ok && child.status === 0
  if (!ok) console.error(child.stderr?.toString().slice(-1500))
  settleRun(dir,ok); process.exit(ok ? 0 : 1)
} else {
  const { app, BrowserWindow } = require('electron'), { pathToFileURL } = require('node:url'), assert = require('node:assert/strict')
  app.whenReady().then(async () => {
    const root = path.join(__dirname, '../src/renderer'), file = name => pathToFileURL(path.join(root,name)).href
    const html = '<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8">' +
      ['fonts.css','tokens.css','index.css','change-review.css'].map(name => `<link rel="stylesheet" href="${file(name)}">`).join('') +
      `<body><button id="origin">Fixture</button><script src="${file('i18n.js')}"></script><script src="${file('change-review.js')}"></script></body></html>`
    const target = path.join(process.env.CHANGE_REVIEW_DIR,'fixture.html'); fs.writeFileSync(target,html)
    const win = new BrowserWindow({ show: true, width: 1150, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const errors = []; win.webContents.on('console-message', (_event,level,message) => { if (level >= 3) errors.push(message) })
    await win.loadFile(target)
    const js = code => win.webContents.executeJavaScript(code)
    const until = async condition => { for (let i=0;i<100;i++) { if(await js(condition)) return; await new Promise(r=>setTimeout(r,20)) }; throw Error('UI timeout: '+condition) }
    await js(`window.calls = 0; window.fail = false; window.fixtureTranslate = s => document.documentElement.lang === 'en' ? (window.__I18N__.en[s] || s) : s;
      window.electronAPI = {
        reviewAgentChanges: async () => ({ ok: true, files: [{ requestId: 'turn', fileId: 'a'.repeat(64), file: 'src/example.js', edits: 2, status: 'ready' }], missing: [], truncated: false }),
        previewAgentChange: async () => ({ ok: true, status: 'ready', file: 'src/example.js', before: 'const n = 1\\n<script>alert(1)</script>', after: 'const n = 2' }),
        undoAgentChanges: async () => { window.calls++; await new Promise(r=>setTimeout(r,30)); if(window.fail) throw Error('PRIVATE disk error'); return { restored: ['src/example.js'], conflicts: [], failed: [], snapshotKept: true } }
      }; true`)
    const open = () => js("window.OnlyoneChangeReview.open({ entries: [{ requestId: 'turn', label: 'Fixture response' }], t: window.fixtureTranslate, opener: document.getElementById('origin') })")
    const close = () => js("new Promise(resolve => { const d = document.querySelector('.change-review-dialog'); d.addEventListener('close', () => queueMicrotask(resolve), { once: true }); d.querySelector('header button').click() })")
    await open()
    await js("document.querySelector('[data-action=preview-file]').click()")
    await until("Boolean(document.querySelector('[data-action=restore-file]'))")
    assert.equal(await js('window.calls'),0)
    assert.equal(await js("document.querySelector('.change-review-detail script')"),null,'file contents are text, never executable HTML')
    await js("document.querySelector('[data-action=restore-file]').click()")
    assert.equal(await js('window.calls'),0,'second confirmation required')
    await js("const b=document.querySelector('[data-action=confirm-restore]'); b.click(); b.click()")
    await until("document.querySelector('[role=status]').textContent === 'File restored to its state before the response.'")
    assert.equal(await js('window.calls'),1,'double click applies once')
    await js("window.fail = true; document.querySelector('[data-action=preview-file]').click()")
    await until("Boolean(document.querySelector('[data-action=restore-file]'))")
    await js("document.querySelector('[data-action=restore-file]').click(); document.querySelector('[data-action=confirm-restore]').click()")
    await until("document.querySelector('[role=status]').textContent === 'Could not roll back the file. Refresh the changes list.'")
    assert.equal(await js("document.querySelector('.change-review-dialog').textContent.includes('PRIVATE')"),false)
    await close()
    for (const language of ['ru','en']) for (const theme of ['dark','light']) {
      await js(`document.documentElement.lang='${language}'; document.documentElement.dataset.theme='${theme}'`)
      await open(); await js("document.querySelector('[data-action=preview-file]').click()")
      await until("Boolean(document.querySelector('[data-action=restore-file]'))")
      assert.equal(await js("(() => {const d=document.querySelector('.change-review-dialog'),r=d.getBoundingClientRect();return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight && d.scrollWidth<=d.clientWidth+1})()"),true)
      if (language==='en') assert.equal(await js("/[А-Яа-яЁё]/.test(document.querySelector('.change-review-dialog').textContent)"),false)
      if (process.env.CHANGE_REVIEW_SHOTS) {
        fs.mkdirSync(process.env.CHANGE_REVIEW_SHOTS,{recursive:true})
        await new Promise(r=>setTimeout(r,150))
        fs.writeFileSync(path.join(process.env.CHANGE_REVIEW_SHOTS,`change-review-${language}-${theme}.png`),(await win.webContents.capturePage()).toPNG())
      }
      await close()
    }
    assert.deepEqual(errors,[])
    fs.writeFileSync(process.env.CHANGE_REVIEW_OUT,JSON.stringify({ok:true,checks:['literal source preview','two-step confirmation','double click once','failure without secret leakage','RU/EN both themes','dialog bounds'],errors}))
    app.exit(0)
  }).catch(error => {fs.writeFileSync(process.env.CHANGE_REVIEW_OUT,JSON.stringify({ok:false,error:error.stack}));app.exit(1)})
}
