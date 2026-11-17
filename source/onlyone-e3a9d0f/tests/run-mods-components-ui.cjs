'use strict'
// M-2: compact metric chips, a trend against the previous paint and a passed/failed bar.
// The fixture paints `OnlyoneModPanels.paint` directly with synthetic views, so no IPC,
// no mods.json and no network: the question is only what the renderer puts on screen.
// Negative control: the same view painted by the previous renderer
// (`git show 8975b83:src/renderer/mods-panels.js`, written to the run dir and loaded in
// the same window) must have no chips, no trend and no progress bar. The old file stays
// in the temporary run dir; it is not part of the commit.
const fs = require('node:fs'), path = require('node:path')

if (!process.argv.includes('--probe')) {
  const { spawnSync } = require('node:child_process'), { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
  const css = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/mods.css'), 'utf8')
  const hex = [...new Set(css.match(/#[0-9a-fA-F]{3,8}\b/g) || [])]
  if (hex.length) { console.error('mods.css uses literal colours instead of tokens: ' + hex.join(', ')); process.exit(1) }
  const dir = runDir('onlyone-mods-components'), output = path.join(dir, 'result.json'), old = path.join(dir, 'panels-old.js')
  const base = '8975b83'
  let oldSource = process.env.MODS_COMPONENTS_OLD && fs.existsSync(process.env.MODS_COMPONENTS_OLD) ? fs.readFileSync(process.env.MODS_COMPONENTS_OLD, 'utf8') : null
  if (!oldSource) {
    const show = spawnSync('git', ['-C', path.join(__dirname, '..'), 'show', base + ':src/renderer/mods-panels.js'], { encoding: 'utf8' })
    if (show.status === 0 && show.stdout) {
      oldSource = show.stdout
    } else {
      oldSource = '(function () {\n' +
        '  \'use strict\'\n' +
        '  function node (tag, text, className) {\n' +
        '    const element = document.createElement(tag)\n' +
        '    if (text !== undefined) element.textContent = text\n' +
        '    if (className) element.className = className\n' +
        '    return element\n' +
        '  }\n' +
        '  function button (text, action) {\n' +
        '    const element = node(\'button\', text, \'btn-secondary\'); element.type = \'button\'\n' +
        '    element.onclick = action; return element\n' +
        '  }\n' +
        '  function error (t, code) {\n' +
        '    const messages = { \'chat-required\':\'Откройте диалог для панелей модов\', \'skill-unavailable\':\'Выбранный навык недоступен. Включите его в настройках.\',\n' +
        '      conflict:\'Мод изменился. Обновите панели и повторите.\', \'main-unavailable\':\'Основное окно недоступно\',\n' +
        '      \'storage-unavailable\':\'Не удалось прочитать моды. Данные не сброшены.\', \'invalid-package\':\'Некорректный пакет мода или разрешения\',\n' +
        '      \'same-version\':\'Для изменения пакета увеличьте его версию\', \'write-failed\':\'Не удалось сохранить мод. Предыдущее состояние сохранено.\',\n' +
        '      expired:\'Предпросмотр устарел. Проверьте пакет заново.\' }\n' +
        '    return t(messages[code] || \'Не удалось выполнить действие мода\')\n' +
        '  }\n' +
        '  function paint (host, view, {t, action, draft}) {\n' +
        '    host.replaceChildren()\n' +
        '    if (!view?.ok) { host.append(node(\'p\',error(t,view?.code))); return }\n' +
        '    if (!view.panels.length) host.append(node(\'p\', t(\'Нет включённых панелей. Установите мод в настройках Onlyone.\')))\n' +
        '    for (const panel of view.panels) {\n' +
        '      const card = node(\'section\', undefined, \'mod-card\')\n' +
        '      card.append(node(\'small\', panel.modName), node(\'h3\',panel.title), node(\'p\',panel.body))\n' +
        '      const counts = node(\'dl\', undefined, \'mod-counts\')\n' +
        '      const labels = { files:\'Изменённые файлы\',passed:\'Проверки с кодом 0\',failed:\'Ошибки проверок\' }\n' +
        '      for (const [key,value] of Object.entries(panel.counts)) { const pair = node(\'div\'); if (!value) pair.dataset.zero = \'\'; pair.append(node(\'dt\', t(labels[key])),node(\'dd\',String(value))); counts.append(pair) }\n' +
        '      card.append(counts)\n' +
        '      if (panel.status) { const status = node(\'p\',panel.status.text,\'mod-status\'); status.dataset.tone = panel.status.tone; card.append(status) }\n' +
        '      const message = node(\'p\', \'\', \'mod-feedback\'); message.setAttribute(\'role\',\'status\')\n' +
        '      const controls = node(\'div\',undefined,\'mod-controls\')\n' +
        '      const invoke = async (control, selection) => {\n' +
        '        control.disabled = true; message.textContent = \'\'\n' +
        '        try {\n' +
        '          const result = await action({ ...selection, modId:panel.modId,panelId:panel.id,revision:view.revision })\n' +
        '          if (!result?.ok) message.textContent = error(t,result?.code)\n' +
        '          else if (result.type === \'draft\' || result.type === \'delivered\') { draft(result); message.textContent = t(\'Задача подготовлена. Отправка — только из Onlyone.\') }\n' +
        '        } catch { message.textContent = error(t) }\n' +
        '        finally { control.disabled = false }\n' +
        '      }\n' +
        '      for (const item of panel.buttons) { const control=button(item.label,()=>invoke(control,{buttonId:item.id})); controls.append(control) }\n' +
        '      if (panel.status?.skillId) { const control=button(t(\'Подготовить диагностику\'),()=>invoke(control,{suggestion:true,statusHash:panel.statusHash})); controls.append(control) }\n' +
        '      card.append(controls,message); host.append(card)\n' +
        '    }\n' +
        '  }\n' +
        '  window.OnlyoneModPanels = { node,button,error,paint }\n' +
        '})()\n'
    }
  }
  fs.writeFileSync(old, oldSource)
  const child = spawnSync(electronBinary(), [__filename, '--probe', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(dir, 'profile')], {
    cwd: path.join(__dirname, '..'), timeout: 180000, windowsHide: true,
    env: guiEnv({ MODS_COMPONENTS_DIR: dir, MODS_COMPONENTS_OUT: output, MODS_COMPONENTS_OLD: process.env.MODS_COMPONENTS_OLD || old })
  })
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { ok: false, error: child.error?.message || child.stderr?.toString().slice(-1800) || 'No UI result' }
  console.log(JSON.stringify(result)); const ok = result.ok && child.status === 0; settleRun(dir, ok); process.exit(ok ? 0 : 1)
} else {
  const { app, BrowserWindow } = require('electron'), assert = require('node:assert/strict'), { pathToFileURL } = require('node:url')
  app.whenReady().then(async () => {
    const dir = process.env.MODS_COMPONENTS_DIR, root = path.join(__dirname, '..'), file = name => pathToFileURL(path.join(root, 'src/renderer', name)).href
    const window = new BrowserWindow({ show: true, width: 900, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const fixture = (script, name) => {
      const target = path.join(dir, name)
      fs.writeFileSync(target, '<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8">' +
        ['tokens.css', 'mods.css'].map(n => `<link rel="stylesheet" href="${file(n)}">`).join('') +
        '<body style="padding:24px"><div id="host"></div><script>' +
        'window.dict={"Изменённые файлы":"Changed files","Проверки с кодом 0":"Checks with exit code 0","Ошибки проверок":"Failed checks",' +
        '"без изменений":"no change"};' +
        'window.tt=s=>Object.prototype.hasOwnProperty.call(window.dict,s)?window.dict[s]:s;' +
        'window.paintView=v=>{OnlyoneModPanels.paint(document.getElementById("host"),v,{t:tt,action:async()=>({ok:true,type:"draft",text:"x"}),draft:()=>{}});return true};' +
        'window.snapshot=()=>[...document.querySelectorAll("#host .mod-chip")].map(c=>({metric:c.dataset.metric,zero:c.hasAttribute("data-zero"),label:c.querySelector("dt")?.textContent,value:c.querySelector("dd")?.textContent.trim(),trend:c.querySelector(".mod-trend")?.dataset.trend,trendLabel:c.querySelector(".mod-trend")?.getAttribute("aria-label"),width:c.getBoundingClientRect().width}));' +
        'window.plain=()=>({chips:document.querySelectorAll(".mod-chip").length,trends:document.querySelectorAll(".mod-trend").length,bars:document.querySelectorAll(".mod-progress").length,pairs:document.querySelectorAll(".mod-counts > div").length,values:[...document.querySelectorAll(".mod-counts dd")].map(d=>d.textContent)});' +
        '</script><script src="' + script + '"></script></body></html>')
      return target
    }
    const js = code => window.webContents.executeJavaScript(code)
    const view = (chatId, counts, extra = {}) => ({ ok: true, chatId, revision: 1, panels: [{ id: 'checks', modId: 'onlyone.project-checks', modName: 'Project checks', title: 'Project checks', body: 'Changes and checks observed in this chat.', counts, status: null, statusHash: 'h0', buttons: [{ id: 'run', label: 'Run checks' }], ...extra }] })
    const paint = v => js(`paintView(${JSON.stringify(v)})`)
    const bar = () => js("(()=>{const b=document.querySelector('#host .mod-progress');if(!b)return null;const f=b.querySelector('.mod-progress-fill');return {role:b.getAttribute('role'),label:b.getAttribute('aria-label'),min:b.getAttribute('aria-valuemin'),max:b.getAttribute('aria-valuemax'),now:b.getAttribute('aria-valuenow'),fill:f.style.width,ratio:f.getBoundingClientRect().width/b.getBoundingClientRect().width}})()")

    await window.loadFile(fixture(file('mods-panels.js'), 'fixture-new.html'))
    await js('Boolean(window.OnlyoneModPanels && window.paintView)')

    // 1. First paint: plaques with label and value, no trend invented from nothing.
    const v1 = view('chat-a', { files: 2, passed: 3, failed: 1 })
    await paint(v1)
    let chips = await js('snapshot()')
    assert.deepEqual(chips.map(c => c.metric), ['files', 'passed', 'failed'], 'one chip per metric')
    assert.deepEqual(chips.map(c => c.label), ['Changed files', 'Checks with exit code 0', 'Failed checks'], 'labels go through t')
    assert.deepEqual(chips.map(c => c.value), ['2', '3', '1'], 'values are on the chips')
    assert.equal(chips.every(c => c.trend === undefined), true, 'the first paint has no trend arrow')
    assert.equal(chips.every(c => c.width > 40), true, 'chips are laid out, not display:contents')

    let progress = await bar()
    assert.equal(progress.role, 'progressbar', 'the bar exposes its role')
    assert.equal(progress.label, 'Checks with exit code 0', 'the bar has a translated accessible name')
    assert.equal(progress.min, '0'); assert.equal(progress.now, '3'); assert.equal(progress.max, '4')
    assert.ok(Math.abs(progress.ratio - 0.75) < 0.03, 'passed / (passed + failed): ' + JSON.stringify(progress))
    assert.equal(progress.fill, '75%')

    // 2. Second paint of the same chat+panel: a steady cue, still translated.
    await paint(v1)
    chips = await js('snapshot()')
    assert.deepEqual(chips.map(c => c.trend), ['steady', 'steady', 'steady'], 'a second paint compares with the previous one')
    assert.deepEqual(chips.map(c => c.trendLabel), ['Changed files: no change', 'Checks with exit code 0: no change', 'Failed checks: no change'], 'the steady cue is spoken and translated')

    // 3. Real movement: files steady, passed up, failed down.
    await paint(view('chat-a', { files: 2, passed: 5, failed: 0 }))
    chips = await js('snapshot()')
    assert.deepEqual(chips.map(c => c.trend), ['steady', 'up', 'down'])
    assert.deepEqual(chips.map(c => c.trendLabel), ['Changed files: no change', 'Checks with exit code 0: 3 → 5', 'Failed checks: 1 → 0'])
    progress = await bar()
    assert.equal(progress.now, '5'); assert.equal(progress.max, '5'); assert.equal(progress.fill, '100%')

    // 4. Honest zero: digits stay on screen and the bar survives 0 / 0 without NaN.
    await paint(view('chat-zero', { files: 0, passed: 0, failed: 0 }))
    chips = await js('snapshot()')
    assert.deepEqual(chips.map(c => c.value), ['0', '0', '0'], 'zeros are shown, not hidden')
    assert.deepEqual(chips.map(c => c.zero), [true, true, true])
    assert.equal(chips.every(c => c.width > 40), true, 'zero chips keep their box')
    assert.equal(chips.every(c => c.trend === undefined), true, 'another chat starts without a trend')
    progress = await bar()
    assert.equal(progress.now, '0'); assert.equal(progress.fill, '0%'); assert.ok(!/NaN/.test(progress.fill))

    // 5. A panel without check metrics gets no bar.
    await paint(view('chat-files', { files: 1 }))
    assert.equal(await js("document.querySelector('#host .mod-progress')===null"), true, 'no check counts, no bar')

    // 6. Trend keys include the chat: the same panel in another chat is not a comparison.
    await paint(view('chat-b', { files: 2, passed: 4, failed: 1 }))
    chips = await js('snapshot()')
    assert.equal(chips.every(c => c.trend === undefined), true, 'a different chat is a first paint')

    // 7. Buttons and status keep working next to the chips.
    await paint(view('chat-status', { files: 1, passed: 2, failed: 0 }, { status: { text: 'Needs review', tone: 'warning' }, buttons: [{ id: 'run', label: 'Run checks' }, { id: 'open', label: 'Open Desk' }] }))
    assert.equal(await js("document.querySelector('#host .mod-status[data-tone=warning]')?.textContent"), 'Needs review')
    assert.equal(await js("document.querySelectorAll('#host .mod-controls button').length"), 2)

    // 8. The host stays English: every visible and spoken label came through t.
    assert.equal(/[А-Яа-яЁё]/.test(await js("document.getElementById('host').textContent + [...document.querySelectorAll('#host [aria-label]')].map(x=>x.getAttribute('aria-label')).join(' ')")), false)

    // 9. Chips read the theme tokens in both themes.
    const dark = await js("getComputedStyle(document.querySelector('.mod-chip')).backgroundColor")
    await js("document.documentElement.dataset.theme='light'")
    const light = await js("getComputedStyle(document.querySelector('.mod-chip')).backgroundColor")
    assert.notEqual(dark, light, 'chip follows the theme')
    assert.equal(/rgba\(0, 0, 0, 0\)|transparent/.test(dark + light), false, 'chip has a real surface colour')

    // 10. Negative control: the old renderer on the same view has none of these elements.
    await window.loadFile(fixture(pathToFileURL(process.env.MODS_COMPONENTS_OLD).href, 'fixture-old.html'))
    await paint(v1)
    assert.deepEqual(await js('plain()'), { chips: 0, trends: 0, bars: 0, pairs: 3, values: ['2', '3', '1'] }, 'old renderer: plain dt/dd pairs only')
    await paint(v1)
    assert.deepEqual(await js('plain()'), { chips: 0, trends: 0, bars: 0, pairs: 3, values: ['2', '3', '1'] }, 'old renderer never grows a trend')

    window.destroy()
    fs.writeFileSync(process.env.MODS_COMPONENTS_OUT, JSON.stringify({ ok: true, checks: 'chips+values, zero visible, progress aria and ratio, trend on repaint only, per-chat trend, buttons/status, EN labels, both themes, old renderer has none of it', dir }))
    app.exit(0)
  }).catch(error => { fs.writeFileSync(process.env.MODS_COMPONENTS_OUT, JSON.stringify({ ok: false, error: error.stack })); app.exit(1) })
}
