'use strict'
const fs = require('node:fs'), path = require('node:path')
if (!process.argv.includes('--probe')) {
  const { spawnSync } = require('node:child_process')
  const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
  const dir = runDir('onlyone-configurations-ui'), output = path.join(dir, 'result.json')
  const child = spawnSync(electronBinary(), [__filename, '--probe', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(dir, 'profile')], {
    cwd: path.join(__dirname, '..'), timeout: 60000, windowsHide: true, env: guiEnv({ CONFIGURATIONS_UI_OUT: output, CONFIGURATIONS_UI_DIR: dir })
  })
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { ok: false, error: child.error?.message || 'No window result' }
  console.log(JSON.stringify(result))
  if (!result.ok) console.error(child.stderr?.toString().slice(-2000))
  const ok = result.ok && child.status === 0
  settleRun(dir, ok); process.exit(ok ? 0 : 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const { pathToFileURL } = require('node:url')
  const assert = require('node:assert/strict')
  app.whenReady().then(async () => {
    const root = path.join(__dirname, '../src/renderer')
    const file = name => pathToFileURL(path.join(root, name)).href
    const html = '<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8">' +
      ['fonts.css', 'tokens.css', 'index.css', 'run-configurations.css'].map(name => `<link rel="stylesheet" href="${file(name)}">`).join('') +
      `<body><button id="origin" class="tasks-configurations">Fixture</button><script src="${file('i18n.js')}"></script><script src="${file('run-configurations.js')}"></script></body></html>`
    const target = path.join(process.env.CONFIGURATIONS_UI_DIR, 'fixture.html'); fs.writeFileSync(target, html)
    const win = new BrowserWindow({ show: true, width: 1100, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const errors = []
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
    await win.loadFile(target)
    const js = code => win.webContents.executeJavaScript(code)
    const lib = require('../src/main/agent-run-context')
    const run = lib.createRunContext({ durationMs: 1000 })
    run.recordConfiguration({ model: 'fixture/first', agentIndex: 0, reasoningEffort: 'low', systemPrompt: 'PRIVATE instruction', tools: [{ function: { name: 'read', description: 'first' } }] })
    run.recordConfiguration({ model: 'fixture/second', agentIndex: 0, reasoningEffort: 'high', systemPrompt: 'PRIVATE updated instruction', tools: [{ function: { name: 'write' } }] })
    run.recordSkillRead({ agentIndex: 0, skillId: 'PRIVATE skill', source: 'file', path: 'PRIVATE path', content: 'PRIVATE content' })
    run.recordModelCall({ kind: 'judge', agentIndex: 0, model: 'fixture/requested', answeredModel: 'fixture/served', outcome: 'completed' })
    const payload = { ok: true, records: [run.snapshot()] }
    await js(`window.fixtureArchive = ${JSON.stringify(payload)}; window.electronAPI = { getRunConfigurations: async () => window.fixtureArchive }; window.fixtureTranslate = source => document.documentElement.lang === 'en' ? (window.__I18N__.en[source] || source) : source; true`)
    await js(`window.fixtureApplies = 0; window.fixtureError = false; window.fixtureParameters = {
      preview: async selection => ({ ok: true, token: 'fixture-token', before: { defaultModel: 'fixture/before', thinkingEffort: 'low' }, after: { defaultModel: 'fixture/second', thinkingEffort: 'high' } }),
      apply: async token => { if (token !== 'fixture-token') throw Error('invalid token'); window.fixtureApplies++; await new Promise(resolve => setTimeout(resolve, 30)); return window.fixtureError ? { ok: false, code: 'write_failed' } : { ok: true } }
    }; true`)
    const open = () => js("window.OnlyoneRunConfigurations.open({ t: window.fixtureTranslate, opener: document.getElementById('origin'), parameters: window.fixtureParameters })")
    const until = async expression => {
      for (let i = 0; i < 100; i++) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)) }
      throw Error('UI timed out: ' + expression)
    }
    const close = () => js("new Promise(resolve => { const dialog = document.querySelector('.run-configurations-dialog'); dialog.addEventListener('close', () => queueMicrotask(resolve), { once: true }); dialog.querySelector('header button').click() })")
    await js("document.getElementById('origin').focus()")
    await open()
    assert.equal(await js("document.querySelectorAll('.run-configurations-dialog tbody tr').length"), 8)
    assert.equal(await js("document.querySelector('.run-configurations-message').textContent"), 'Configurations differ.')
    assert.equal(await js("document.querySelector('.run-configurations-dialog').textContent.includes('PRIVATE')"), false)
    assert.equal(await js("document.querySelector('.run-configurations-dialog').textContent.includes('fixture/requested → fixture/served')"), true)
    await js("document.querySelector('[data-action=preview-parameters]').click()")
    await until("Boolean(document.querySelector('[data-action=apply-parameters]'))")
    assert.equal(await js('window.fixtureApplies'), 0, 'preview does not apply')
    await js("document.querySelector('.run-configurations-restore .btn-secondary').click()")
    assert.equal(await js("document.querySelector('.run-configurations-restore').hidden"), true, 'cancel dismisses preview')
    await js("document.querySelector('[data-action=preview-parameters]').click()")
    await until("Boolean(document.querySelector('[data-action=apply-parameters]'))")
    await js("const apply = document.querySelector('[data-action=apply-parameters]'); apply.click(); apply.click()")
    await until("document.querySelector('.run-configurations-message').textContent === 'Model and effort restored for future runs.'")
    assert.equal(await js('window.fixtureApplies'), 1, 'double click applies once')
    await js("window.fixtureError = true; document.querySelector('[data-action=preview-parameters]').click()")
    await until("Boolean(document.querySelector('[data-action=apply-parameters]'))")
    await js("document.querySelector('[data-action=apply-parameters]').click()")
    await until("document.querySelector('.run-configurations-message').textContent === 'Could not save parameters. Try again.'")
    await js('window.fixtureError = false')
    await js("const selects = document.querySelectorAll('.run-configurations-dialog select'); selects[0].value = selects[1].value; selects[0].dispatchEvent(new Event('change'))")
    assert.equal(await js("document.querySelector('.run-configurations-message').textContent"), 'Configurations match.')
    await js("document.getElementById('origin').replaceWith(document.getElementById('origin').cloneNode(true))")
    await close()
    assert.equal(await js('document.activeElement.id'), 'origin', 'focus returns to the rebuilt Work panel button')
    await js("window.electronAPI.getRunConfigurations = async () => { throw Error('fixture read failed') }; true")
    await open()
    assert.equal(await js("document.querySelector('.run-configurations-message').textContent"), 'Could not read the configuration archive.')
    await js("window.electronAPI.getRunConfigurations = async () => ({ ok: true, records: [] }); document.querySelector('.run-configurations-dialog > button').click()")
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await js("document.querySelector('.run-configurations-message').textContent"), 'No saved configurations yet.')
    assert.equal(await js("[...document.querySelectorAll('.run-configurations-dialog select')].every(node => node.disabled)"), true)
    await close()
    await js("window.electronAPI.getRunConfigurations = async () => window.fixtureArchive; true")
    for (const language of ['ru', 'en']) for (const theme of ['dark', 'light']) {
      await js(`document.documentElement.lang = '${language}'; document.documentElement.dataset.theme = '${theme}'`)
      await open()
      assert.equal(await js("document.querySelector('.run-configurations-dialog h2').textContent"), language === 'ru' ? 'Конфигурации запусков' : 'Run configurations')
      if (language === 'en') assert.equal(await js("/[А-Яа-яЁё]/.test(document.querySelector('.run-configurations-dialog').textContent)"), false, 'English observations are translated')
      assert.equal(await js("(() => { const d = document.querySelector('.run-configurations-dialog'), r = d.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && d.scrollWidth <= d.clientWidth + 1 })()"), true)
      if (process.env.RUN_CONFIG_SHOTS) {
        fs.mkdirSync(process.env.RUN_CONFIG_SHOTS, { recursive: true })
        await new Promise(resolve => setTimeout(resolve, 200))
        fs.writeFileSync(path.join(process.env.RUN_CONFIG_SHOTS, `configurations-${language}-${theme}.png`), (await win.webContents.capturePage()).toPNG())
        await js("document.querySelector('[data-action=preview-parameters]').click()")
        await until("Boolean(document.querySelector('[data-action=apply-parameters]'))")
        await js("document.querySelector('.run-configurations-restore').scrollIntoView({ block: 'center' })")
        await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        await new Promise(resolve => setTimeout(resolve, 100))
        fs.writeFileSync(path.join(process.env.RUN_CONFIG_SHOTS, `restore-${language}-${theme}.png`), (await win.webContents.capturePage()).toPNG())
      }
      await close()
    }
    assert.equal(errors.length, 0, errors.join('\n'))
    fs.writeFileSync(process.env.CONFIGURATIONS_UI_OUT, JSON.stringify({ ok: true, checks: ['field comparison', 'same configuration', 'no instruction text', 'observed served model', 'restore preview/cancel', 'double apply once', 'save failure', 'read failure', 'retry and empty archive', 'RU/EN dark/light', 'dialog bounds'], errors }))
    app.exit(0)
  }).catch(error => { fs.writeFileSync(process.env.CONFIGURATIONS_UI_OUT, JSON.stringify({ ok: false, error: error.stack })); app.exit(1) })
}
