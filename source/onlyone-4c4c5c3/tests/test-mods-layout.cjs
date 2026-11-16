'use strict'
// M-1: плотность панелей модов. Настоящее окно Electron, изолированный профиль,
// подставной мост вместо IPC. Без окна проверка не отличит «скрыто» от «не нарисовано».
const fs = require('node:fs'), path = require('node:path')
if (!process.argv.includes('--probe')) {
  const { spawnSync } = require('node:child_process')
  const { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock } = require('./app-launch.cjs')
  const dir = runDir('onlyone-mods-layout'), output = path.join(dir, 'result.json')
  acquireWindowLock()
  const child = spawnSync(electronBinary(), [__filename, '--probe', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(dir, 'profile')], {
    cwd: path.join(__dirname, '..'), timeout: 180000, windowsHide: true, env: guiEnv({ MODS_LAYOUT_DIR: dir, MODS_LAYOUT_OUT: output })
  })
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { ok: false, error: child.error?.message || child.stderr?.toString().slice(-1800) || 'No UI result' }
  console.log(JSON.stringify(result)); const ok = result.ok && child.status === 0
  settleRun(dir, ok); process.exit(ok ? 0 : 1)
} else {
  const { app, BrowserWindow } = require('electron'), assert = require('node:assert/strict'), { pathToFileURL } = require('node:url')
  app.whenReady().then(async () => {
    const dir = process.env.MODS_LAYOUT_DIR, root = path.join(__dirname, '..')
    const file = name => pathToFileURL(path.join(root, 'src/renderer', name)).href
    const errors = []
    const main = new BrowserWindow({ show: true, width: 980, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    main.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
    const target = path.join(dir, 'fixture.html')
    fs.writeFileSync(target, '<!doctype html><html lang="ru" data-theme="dark"><meta charset="utf-8">' +
      ['tokens.css', 'mods.css'].map(name => `<link rel="stylesheet" href="${file(name)}">`).join('') +
      '<body style="padding:24px"><div id="mods-manager"></div>' +
      '<aside id="desk-mods-panel"><div class="desk-dh"><h2>Моды</h2></div><div id="desk-mods-body"></div><div class="desk-dfoot"><button type="button">Моды в настройках Onlyone</button></div></aside>' +
      ['i18n.js'].map(name => `<script src="${file(name)}"></script>`).join('') +
      ['mods-panels.js', 'mods-ui.js'].map(name => `<script src="${file(name)}"></script>`).join('') + '</body></html>')
    await main.loadFile(target)
    const js = code => main.webContents.executeJavaScript(code)
    const until = async (check, execute = js) => { for (let i = 0; i < 300; i++) { if (await execute(check)) return; await new Promise(resolve => setTimeout(resolve, 20)) } const state = await execute("JSON.stringify({dialogs:[...document.querySelectorAll('dialog')].map(d=>d.innerHTML.slice(0,800)),lists:[...document.querySelectorAll('.mods-panel-list')].map(x=>x.outerHTML.slice(0,800)),manager:document.getElementById('mods-manager').textContent.slice(0,300)})"); throw Error('UI timed out: ' + check + ' ' + state) }
    const cards = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector + ' .mod-card')})).map(card => getComputedStyle(card).display !== 'none')`
    const key = 'onlyone.mods.density'
    await js(`
      window.panelsView={ok:true,revision:1,panels:[
        {modId:'m',id:'empty-a',modName:'M',title:'Empty A',body:'',counts:{files:0,passed:0,failed:0},buttons:[]},
        {modId:'m',id:'status',modName:'M',title:'With status',body:'',counts:{files:0},status:{text:'Rule active',tone:'warning'},buttons:[]},
        {modId:'m',id:'count',modName:'M',title:'With count',body:'',counts:{files:2,passed:0,failed:0},buttons:[]},
        {modId:'m',id:'empty-b',modName:'M',title:'Empty B',body:'',counts:{},buttons:[]}
      ]}
      window.emptyOnlyView={ok:true,revision:1,panels:[
        {modId:'m',id:'only-a',modName:'M',title:'Only empty A',body:'',counts:{files:0,passed:0,failed:0},buttons:[]},
        {modId:'m',id:'only-b',modName:'M',title:'Only empty B',body:'',counts:{},buttons:[]}
      ]}
      window.emptyView={ok:true,revision:1,panels:[]}
      window.apiStub={
        modsList:async()=>({ok:true,revision:1,skills:[],diagnostics:[],recovery:null,mods:[]}),
        modsPanels:async()=>window.panelsView,
        onModsChanged:()=>()=>{},onModDraft:()=>()=>{},
        modAction:async()=>({ok:true,type:'delivered'}),
        modsToggle:async()=>({ok:true}),modsRemove:async()=>({ok:true}),modsExport:async()=>({ok:true,text:''}),
        modsPreview:async()=>({ok:true,package:{name:'',version:'',description:'',permissions:[]},token:'t'}),
        modsCommit:async()=>({ok:true}),modsSample:async()=>({ok:true,package:{}})
      }
      window.fixtureT=source=>document.documentElement.lang==='en'?(window.__I18N__.en[source]||source):source
      window.makeClient=()=>{window.client=OnlyoneMods.create({api:window.apiStub,t:window.fixtureT,getPane:()=>({chatId:'c',dom:{}}),chatOf:()=>({id:'c'}),closeSettings:()=>{}});return window.client}
      window.paintDesk=view=>OnlyoneModPanels.paint(document.getElementById('desk-mods-body'),view,{t:window.fixtureT,action:window.apiStub.modAction,draft:()=>{}})
      localStorage.clear();void window.makeClient()
    `)
    await until("document.querySelectorAll('#mods-manager .mods-density input').length===1")
    const managerInput = '#mods-manager .mods-density input'
    const deskInput = '#desk-mods-panel .mods-density input'
    try {
      // 1. По умолчанию — normal, значение не пишется до решения человека.
      assert.equal(await js(`document.querySelector(${JSON.stringify(managerInput)}).checked`), false, 'default is normal')
      assert.equal(await js(`localStorage.getItem(${JSON.stringify(key)})`), null, 'default does not invent a stored value')
      assert.equal(await js("Boolean(document.querySelector('#mods-manager .mods-density label, #mods-manager label.mods-density'))"), true, 'manager has an implicit label')
      assert.equal(await js(`document.querySelector(${JSON.stringify(managerInput)}).labels[0].textContent.trim().length>0`), true, 'control has an accessible name')
      await js('window.client.openPanels()')
      await until("document.querySelectorAll('.mods-panel-list .mod-card').length===4")
      assert.deepEqual(await js(`(${cards('.mods-panel-list')})`), [true, true, true, true], 'normal shows every panel')

      // 2. Compact скрывает только пустые: статус и ненулевой счётчик остаются.
      await js(`document.querySelector(${JSON.stringify(managerInput)}).click()`)
      await until(`localStorage.getItem(${JSON.stringify(key)})==='compact'`)
      assert.deepEqual(await js(`(${cards('.mods-panel-list')})`), [false, true, true, false], 'compact hides only empty panels')
      assert.equal(await js(`document.querySelector('.mods-panel-list').dataset.density`), 'compact', 'manager panels carry the mode')

      // 3. Desk-панель красится тем же paint и подчиняется тому же режиму.
      await js('window.paintDesk(window.panelsView)')
      await until("document.querySelectorAll('#desk-mods-body .mod-card').length===4")
      assert.deepEqual(await js(`(${cards('#desk-mods-body')})`), [false, true, true, false], 'Desk panel hides the same empty panels')
      assert.equal(await js("document.querySelectorAll('#desk-mods-panel .mods-density').length"), 1, 'Desk drawer has exactly one switch')

      // 4. Режим помнится: свежий клиент на той же localStorage встаёт компактным.
      await js("document.querySelectorAll('dialog.mods-dialog').forEach(d=>d.close())")
      await js('void window.makeClient()')
      await until("document.querySelectorAll('#mods-manager .mods-density input').length===1")
      assert.equal(await js(`document.querySelector(${JSON.stringify(managerInput)}).checked`), true, 'fresh client reads the stored mode')
      assert.equal(await js("document.querySelectorAll('#desk-mods-panel .mods-density').length"), 1, 'no duplicate Desk switch after refresh')
      await js('window.client.refresh()')
      await until("document.querySelectorAll('#mods-manager .mods-density input').length===1")
      assert.equal(await js("document.querySelectorAll('#mods-manager .mods-density input').length"), 1, 'refresh adds no duplicate control')
      await js(`document.querySelector(${JSON.stringify(managerInput)}).click()`)
      await until(`localStorage.getItem(${JSON.stringify(key)})==='normal'`)
      assert.equal(await js(`localStorage.getItem(${JSON.stringify(key)})`), 'normal', 'one handler writes normal once')

      // 5. Мусор в localStorage — normal, без исключения.
      await js(`localStorage.setItem(${JSON.stringify(key)},'wide');void window.makeClient()`)
      await until("document.querySelectorAll('#mods-manager .mods-density input').length===1")
      assert.equal(await js(`document.querySelector(${JSON.stringify(managerInput)}).checked`), false, 'invalid stored value falls back to normal')
      await js('window.paintDesk(window.panelsView)')
      await until("document.querySelectorAll('#desk-mods-body .mod-card').length===4")
      assert.equal(await js("document.querySelector('#desk-mods-body').dataset.density"), 'normal', 'invalid value paints normal')

      // 6. Пустой набор не прячет область: остаётся прежний текст.
      await js(`document.querySelector(${JSON.stringify(managerInput)}).click();window.paintDesk(window.emptyOnlyView)`)
      await until("document.querySelectorAll('#desk-mods-body .mod-card').length===2")
      assert.deepEqual(await js(`(${cards('#desk-mods-body')})`), [false, false], 'compact hides every empty panel')
      assert.equal(await js("document.querySelector('#desk-mods-body .mods-density-empty').textContent.includes('Нет включённых панелей')"), true, 'all-empty compact shows the existing empty text')
      assert.equal(await js("getComputedStyle(document.getElementById('desk-mods-body')).display!=='none'"), true, 'empty panel area is not hidden')
      await js('window.paintDesk(window.emptyView)')
      await until("document.querySelectorAll('#desk-mods-body .mod-card').length===0")
      assert.equal(await js("document.getElementById('desk-mods-body').textContent.includes('Нет включённых панелей')"), true, 'existing empty text stays')

      // 7. Подписи переводятся, клавиатурный фокус на переключателе.
      await js("document.documentElement.lang='en';void window.makeClient()")
      await until("document.querySelector('#mods-manager .mods-density')?.textContent==='Compact'")
      await js('window.paintDesk(window.panelsView)')
      await until("document.querySelector('#desk-mods-panel .mods-density')?.textContent==='Compact'")
      assert.equal(await js("/[А-Яа-яЁё]/.test(document.querySelector('#mods-manager .mods-density').textContent+document.querySelector('#desk-mods-panel .mods-density').textContent)"), false, 'English label has no Cyrillic')
      assert.equal(await js(`(()=>{const input=document.querySelector(${JSON.stringify(managerInput)});input.focus();return document.activeElement===input})()`), true, 'switch takes keyboard focus')
      assert.deepEqual(errors, [])
      fs.writeFileSync(process.env.MODS_LAYOUT_OUT, JSON.stringify({ ok: true, checks: 'default normal, empty-only hiding (status/count kept), Desk paint, persistence across client create, no duplicates, invalid fallback, empty text, RU/EN labels, focus', errors }))
      main.destroy(); app.exit(0)
    } catch (error) {
      fs.writeFileSync(process.env.MODS_LAYOUT_OUT, JSON.stringify({ ok: false, error: error.stack, errors }))
      app.exit(1)
    }
  }).catch(error => { fs.writeFileSync(process.env.MODS_LAYOUT_OUT, JSON.stringify({ ok: false, error: error.stack })); app.exit(1) })
}
