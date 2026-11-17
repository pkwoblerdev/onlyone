'use strict'
// Н2 (Mods): допустимый длинный пакет ломал вёрстку менеджера: grid-колонка
// auto растягивалась по самой длинной неразрывной строке, h3 и id не переносились,
// кнопки с white-space:nowrap уезжали за край. Настоящее окно Electron: ширина
// берётся из раскладки, а не из похожего расчёта.
const fs = require('node:fs'), path = require('node:path')
if (!process.argv.includes('--probe')) {
  const { spawnSync } = require('node:child_process')
  const { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock } = require('./app-launch.cjs')
  const dir = runDir('onlyone-mods-layout-long'), output = path.join(dir, 'result.json')
  acquireWindowLock()
  const child = spawnSync(electronBinary(), [__filename, '--probe', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(dir, 'profile')], {
    cwd: path.join(__dirname, '..'), timeout: 180000, windowsHide: true, env: guiEnv({ MODS_LONG_DIR: dir, MODS_LONG_OUT: output })
  })
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { ok: false, error: child.error?.message || child.stderr?.toString().slice(-1800) || 'No UI result' }
  console.log(JSON.stringify(result)); const ok = result.ok && child.status === 0
  settleRun(dir, ok); process.exit(ok ? 0 : 1)
} else {
  const { app, BrowserWindow } = require('electron'), assert = require('node:assert/strict'), { pathToFileURL } = require('node:url')
  app.whenReady().then(async () => {
    const dir = process.env.MODS_LONG_DIR, root = path.join(__dirname, '..')
    const file = name => pathToFileURL(path.join(root, 'src/renderer', name)).href
    const errors = []
    const main = new BrowserWindow({ show: true, width: 980, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    main.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
    const target = path.join(dir, 'fixture.html')
    fs.writeFileSync(target, '<!doctype html><html lang="ru" data-theme="dark"><meta charset="utf-8">' +
      ['tokens.css', 'mods.css'].map(name => `<link rel="stylesheet" href="${file(name)}">`).join('') +
      '<body style="margin:0;padding:0">' +
      '<div id="settings" style="width:360px"><div id="mods-manager" class="mods-manager"></div></div>' +
      '<div id="panel-column" class="mods-panel-list" style="width:360px"></div>' +
      '<dialog id="probe-dialog" class="mods-dialog"><div id="dialog-list" class="mods-panel-list"></div></dialog>' +
      ['mods-panels.js', 'mods-ui.js'].map(name => `<script src="${file(name)}"></script>`).join('') + '</body></html>')
    await main.loadFile(target)
    const js = code => main.webContents.executeJavaScript(code)
    const until = async check => { for (let i = 0; i < 300; i++) { if (await js(check)) return; await new Promise(resolve => setTimeout(resolve, 20)) } throw Error('UI timed out: ' + check + ' ' + await js("JSON.stringify({manager: document.getElementById('mods-manager')?.textContent.slice(0,400), html: document.getElementById('mods-manager')?.innerHTML.slice(0,600)})") + ' errors=' + errors.join(' | ')) }
    // Пакет на границах validatePackage: имя 100, описание 1000, id 60,
    // заголовок 100, тело 2000, подпись кнопки 80 неразрывных символов.
    await js(`
      ;(() => {
        const w = n => 'W'.repeat(n)
        const id = 'a'.repeat(60)
        window.longPanel = { modId: id, id: 'panel', modName: w(100), title: w(100), body: w(2000), counts: { files: 1 }, buttons: [{ id: 'button', label: w(80) }] }
        window.longView = { ok: true, revision: 1, skills: [], diagnostics: [], recovery: null, mods: [{ id, enabled: true, history: [],
          package: { id, name: w(100), version: '1.0.0', description: w(1000), rules: [],
            panels: [{ id: 'panel', title: w(100), body: w(2000), surfaces: ['main', 'desk'], metrics: ['files'], buttons: [{ id: 'button', label: w(80), action: { type: 'open_desk' } }] }] } }] }
        window.panelsView = { ok: true, revision: 1, panels: [window.longPanel] }
        window.t = source => source
        window.apiStub = { modsList: async () => window.longView, modsPanels: async () => window.panelsView,
          onModsChanged: () => () => {}, onModDraft: () => () => {}, modAction: async () => ({ ok: true, type: 'delivered' }),
          modsToggle: async () => ({ ok: true }), modsRemove: async () => ({ ok: true }), modsExport: async () => ({ ok: true, text: '' }),
          modsPreview: async () => ({ ok: true }), modsCommit: async () => ({ ok: true }) }
        void window.OnlyoneMods.create({ api: window.apiStub, t: window.t, getPane: () => ({}), chatOf: () => ({ id: 'c' }), closeSettings: () => {} })
      })()
    `)
    await until("document.querySelectorAll('#mods-manager .mod-card').length>=1")
    const fits = (selector, what) => js(`(()=>{const h=document.querySelector(${JSON.stringify(selector)});
      return h.scrollWidth<=h.clientWidth+1 && h.getBoundingClientRect().right<=window.innerWidth+1})()`)
      .then(ok => assert.equal(ok, true, what))
    await fits('#mods-manager', 'manager fits a 360px settings column for a legal long package')
    assert.equal(await js(`(()=>{const card=document.querySelector('#mods-manager .mod-card'),box=document.getElementById('settings').getBoundingClientRect(),r=card.getBoundingClientRect();
      return r.right<=box.right+1&&r.left>=box.left-1})()`), true, 'the card stays inside the settings column')
    // Панели: те же h3/тело/кнопки, но в узкой колонке Desk.
    await js("void window.OnlyoneModPanels.paint(document.getElementById('panel-column'), window.panelsView, { t: window.t, action: window.apiStub.modAction, draft: () => {} })")
    await until("document.querySelectorAll('#panel-column .mod-card').length===1")
    await fits('#panel-column', 'a panel with a long title and an 80-character button label fits a 360px column')
    assert.equal(await js(`(()=>{const box=document.getElementById('panel-column').getBoundingClientRect();
      return [...document.querySelectorAll('#panel-column .mod-controls button')].every(b=>b.getBoundingClientRect().right<=box.right+1)})()`), true,
    'panel buttons stay inside the column')
    // Диалог панелей — 740 px: ни тело, ни кнопка не растягивают его шире окна.
    await js(`(() => { const dialog = document.getElementById('probe-dialog'); dialog.showModal();
      window.OnlyoneModPanels.paint(document.getElementById('dialog-list'), window.panelsView, { t: window.t, action: window.apiStub.modAction, draft: () => {} }) })()`)
    await until("document.querySelectorAll('#dialog-list .mod-card').length===1")
    assert.equal(await js("(()=>{const d=document.getElementById('probe-dialog');return d.scrollWidth<=d.clientWidth+1&&d.getBoundingClientRect().right<=window.innerWidth+1})()"), true,
      'the panels dialog fits its own width')
    assert.equal(errors.length, 0, errors.join('\n'))
    main.destroy()
    fs.writeFileSync(process.env.MODS_LONG_OUT, JSON.stringify({ ok: true, checks: 'manager, panel column and dialog fit a legal long package', errors }))
    app.exit(0)
  }).catch(error => { fs.writeFileSync(process.env.MODS_LONG_OUT, JSON.stringify({ ok: false, error: error.stack })); app.exit(1) })
}
