'use strict'
// OS-5: раздел «Плагины» в настоящем окне Electron. Настоящий preload, настоящие
// каналы plugins:* (src/main/plugins-ipc.cjs), настоящий профиль во временной
// папке, установка из tests/fixtures/plugins/demo через tools/plugin/install.cjs и
// настоящие mk-kit.js + plugins-page.js. Проверяет: пусто → установлен и отключён →
// «Разрешить» → отключить/подключить → вторая версия и откат → удаление → RU/EN,
// тёмная/светлая, журнал действий, отсутствие кириллицы в EN.
// Снимки — в ONECODE_EVIDENCE_DIR, если он задан; в профиль пользователя не пишем.
const fs = require('node:fs')
const path = require('node:path')

if (!process.argv.includes('--probe')) {
  const { spawnSync } = require('node:child_process')
  const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
  const dir = runDir('onlyone-plugins-ui')
  const output = path.join(dir, 'result.json')
  const child = spawnSync(electronBinary(), [__filename, '--probe', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(dir, 'profile')], {
    cwd: path.join(__dirname, '..'), timeout: 180000, windowsHide: true, env: guiEnv({ PLUGINS_UI_DIR: dir, PLUGINS_UI_OUT: output })
  })
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { ok: false, error: child.error?.message || child.stderr?.toString().slice(-1500) || 'No UI result' }
  console.log(JSON.stringify(result))
  const ok = result.ok && child.status === 0
  if (!ok) console.error(child.stderr?.toString().slice(-1500))
  settleRun(dir, ok)
  process.exit(ok ? 0 : 1)
} else {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const { pathToFileURL } = require('node:url')
  const assert = require('node:assert/strict')

  app.whenReady().then(async () => {
    const dir = process.env.PLUGINS_UI_DIR
    const root = path.join(__dirname, '..')
    const file = name => pathToFileURL(path.join(root, 'src/renderer', name)).href
    const demo = path.join(__dirname, 'fixtures', 'plugins', 'demo')
    const base = JSON.parse(fs.readFileSync(path.join(demo, 'plugin.json'), 'utf8'))
    const install = require('../tools/plugin/install.cjs')

    // Раздел подключён к настоящему окну: вкладка, область и скрипт — в разметке,
    // переход — в app.js. Без этого страница работала бы только в этом прогоне.
    const markup = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    assert.ok(/id="navPlugins"/.test(markup) && /id="pluginsView"/.test(markup) && markup.includes('<script src="plugins-page.js"></script>'), 'раздел в разметке окна')
    const wiring = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8')
    assert.ok(wiring.includes("switchTab('plugins')") && wiring.includes('refreshPlugins()'), 'навигация зовёт раздел')

    const html = '<!doctype html><html lang="ru" data-theme="dark"><meta charset="utf-8">' +
      ['fonts.css', 'tokens.css', 'index.css', 'look.css', 'look-pages.css', 'plugins-page.css'].map(name => `<link rel="stylesheet" href="${file(name)}">`).join('') +
      '<body><section id="pluginsView" class="view-panel mk active"><div class="page" id="pluginsPage"><div class="page-inner"></div></div></section>' +
      ['i18n.js', 'mk-kit.js', 'plugins-page.js'].map(name => `<script src="${file(name)}"></script>`).join('') + '</body></html>'
    const target = path.join(dir, 'fixture.html')
    fs.writeFileSync(target, html)

    // preload при загрузке синхронно спрашивает канал сборки: без ответа окно ждало бы его вечно
    ipcMain.on('get-channel', event => { event.returnValue = 'stable' })
    const win = new BrowserWindow({ show: true, width: 1180, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(root, 'src/preload/preload.js') } })
    const errors = []
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
    const isMain = event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
    require('../src/main/plugins-ipc.cjs').register({ ipcMain, isMain, profileDir: () => dir })
    await win.loadFile(target)

    const js = code => win.webContents.executeJavaScript(code)
    const until = async (condition, label = condition) => {
      for (let i = 0; i < 250; i++) {
        if (await js(condition)) return
        await new Promise(r => setTimeout(r, 20))
      }
      throw Error('UI timeout: ' + label + ' :: ' + await js("document.getElementById('pluginsPage').innerText.slice(0, 500)"))
    }
    const pageText = () => js("document.getElementById('pluginsPage').innerText")
    const journalRows = () => js("[...document.querySelectorAll('.pl-journal tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()))")
    const waitJournal = async action => {
      let rows = []
      for (let i = 0; i < 60; i++) {
        rows = await journalRows()
        if (rows[0] && rows[0][1] === action) return rows
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return rows
    }
    const click = async label => {
      const found = await js(`(() => { const b = [...document.querySelectorAll('#pluginsPage button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)
      assert.ok(found, 'кнопка «' + label + '» есть')
    }
    const host = () => js("Boolean(document.querySelector('#pluginsView .page-inner [data-plugin]'))")

    await js(`
      window.__t = (s, ...a) => { let r = document.documentElement.lang === 'en' ? (window.__I18N__.en[s] || s) : s; for (const x of a) r = r.replace('%s', x); return r }
      window.toasts = []
      window.onlyone = OnlyonePluginsPage.create({
        host: document.getElementById('pluginsView'), api: window.electronAPI,
        confirm: async () => window.confirmAnswer !== false,
        toast: (message, isError) => window.toasts.push([message, Boolean(isError)])
      }); true
    `)

    // 1. Пустой профиль: пусто, но журнал на месте
    await until("document.getElementById('pluginsPage').innerText.includes('Плагинов пока нет')", 'empty state')
    assert.ok((await pageText()).includes('Записей пока нет.'), 'пустой журнал подписан')

    // 2. Установленный плагин: отключён, права запрошены, не выданы
    install.installPlugin(demo, { profileDir: dir })
    await js('window.onlyone.refresh()')
    await until("Boolean(document.querySelector('[data-plugin=demo][data-status=disabled]'))", 'installed row')
    let text = await pageText()
    assert.ok(text.includes('Отключён'), 'статус «Отключён»')
    assert.ok(text.includes('fs.read') && text.includes('storage'), 'запрошенные права видны')
    assert.ok(text.includes('Ничего не выдано'), 'выданных прав нет')
    assert.ok(text.includes('Версия 1.0.0'), 'версия видна')
    assert.equal(await js("Boolean(document.querySelector('#pluginsPage select'))"), false, 'одна версия — выбора нет')
    assert.equal(await js("[...document.querySelectorAll('#pluginsPage button')].some(b => b.textContent.trim() === 'Подключить')"), false, 'без согласия предлагается «Разрешить», а не «Подключить»')

    // 3. «Разрешить»: права выданы, плагин включён, журнал помнит
    await click('Разрешить')
    await until("Boolean(document.querySelector('[data-plugin=demo][data-status=enabled]'))", 'approved row')
    text = await pageText()
    assert.ok(text.includes('Работает'), 'статус «Работает»')
    assert.ok(text.includes('Ждёт согласия') === false, 'ожидание согласия снято')
    assert.equal(await js("document.querySelectorAll('.pl-cap[data-granted=true]').length"), 2, 'выдано ровно два права')
    let rows = await journalRows()
    assert.deepEqual(rows[0].slice(1), ['Разрешение', 'demo 1.0.0', 'Готово'], 'журнал: согласие записано')

    // 4. Отключить и подключить обратно
    await click('Отключить')
    await until("Boolean(document.querySelector('[data-plugin=demo][data-status=disabled]'))", 'disabled row')
    await click('Подключить')
    await until("Boolean(document.querySelector('[data-plugin=demo][data-status=enabled]'))", 'enabled row')

    // 5. Вторая версия: выбор появляется только при двух версиях, откат возвращает старую
    const next = path.join(dir, 'src-1.0.1')
    fs.cpSync(demo, next, { recursive: true })
    fs.writeFileSync(path.join(next, 'plugin.json'), JSON.stringify({ ...base, version: '1.0.1' }, null, 2) + '\n')
    install.installPlugin(next, { profileDir: dir })
    await js('window.onlyone.refresh()')
    await until("document.querySelectorAll('#pluginsPage select[data-role=version] option').length === 2", 'version select')
    assert.equal(await js("document.querySelector('#pluginsPage select[data-role=version]').value"), '1.0.1', 'текущая версия выбрана')
    await js("document.querySelector('#pluginsPage select[data-role=version]').value = '1.0.0'")
    await click('Откатить версию')
    await until("document.querySelector('[data-plugin=demo]').innerText.includes('Версия 1.0.0')", 'rolled back')
    rows = await waitJournal('Откат')
    assert.deepEqual(rows[0].slice(1), ['Откат', 'demo 1.0.0', 'Готово'], 'журнал: откат записан')
    assert.ok(fs.readFileSync(path.join(dir, 'plugins', 'journal.jsonl'), 'utf8').trim().split('\n').length >= 4, 'журнал на диске только дописывается')

    // 6. Удаление: файлы версий убраны, экран пуст, журнал помнит
    await click('Удалить')
    await until("document.getElementById('pluginsPage').innerText.includes('Плагинов пока нет')", 'removed')
    assert.equal(fs.existsSync(path.join(dir, 'plugins', 'demo')), false, 'каталог плагина удалён')
    rows = await waitJournal('Удаление')
    assert.deepEqual(rows[0].slice(1), ['Удаление', 'demo 1.0.0', 'Готово'], 'журнал: удаление записано')

    // 7. Английский язык: те же строки из словаря, без кириллицы
    install.installPlugin(demo, { profileDir: dir })
    await js("document.documentElement.lang = 'en'; window.onlyone.refresh()")
    await until("Boolean(document.querySelector('[data-plugin=demo]'))", 'en row')
    text = await pageText()
    for (const word of ['Plugins', 'Disabled', 'Allow', 'Requested', 'Granted', 'Nothing granted', 'Journal', 'Time', 'Action', 'Plugin', 'Result']) {
      assert.ok(text.includes(word), 'EN: есть «' + word + '»')
    }
    assert.equal(/[А-Яа-яЁё]/.test(text), false, 'EN: без кириллицы — ' + text.replace(/\s+/g, ' ').slice(0, 300))
    await click('Allow')
    await until("Boolean(document.querySelector('[data-plugin=demo][data-status=enabled]'))", 'en approved')
    assert.ok((await pageText()).includes('Running'), 'EN: статус Running')
    await click('Disable')
    await until("Boolean(document.querySelector('[data-plugin=demo][data-status=disabled]'))", 'en disabled')

    // 8. Вид: RU/EN × тёмная/светлая, страница помещается по ширине
    const evidence = process.env.ONECODE_EVIDENCE_DIR
    for (const lang of ['ru', 'en']) {
      for (const skin of ['dark', 'light']) {
        await js(`document.documentElement.lang='${lang}'; document.documentElement.dataset.theme='${skin}'; window.onlyone.repaint()`)
        await until(`document.documentElement.lang==='${lang}' && Boolean(document.querySelector('[data-plugin=demo]'))`, `shot ${lang}/${skin}`)
        assert.equal(await js("document.getElementById('pluginsPage').scrollWidth <= document.getElementById('pluginsPage').clientWidth + 1"), true, `страница помещается (${lang}/${skin})`)
        if (lang === 'en') assert.equal(/[А-Яа-яЁё]/.test(await pageText()), false, `EN без кириллицы (${skin})`)
        if (evidence) {
          fs.mkdirSync(evidence, { recursive: true })
          fs.writeFileSync(path.join(evidence, `plugins-${lang}-${skin}.png`), (await win.webContents.capturePage()).toPNG())
        }
      }
    }

    assert.equal(errors.length, 0, errors.join('\n'))
    win.destroy()
    fs.writeFileSync(process.env.PLUGINS_UI_OUT, JSON.stringify({
      ok: true,
      checks: 'раздел подключён в окно; пусто → установлен/отключён → согласие → отключить/подключить → две версии и откат → удаление; журнал на диске; RU/EN × тёмная/светлая; без ошибок консоли',
      errors
    }))
    app.exit(0)
  }).catch(error => {
    fs.writeFileSync(process.env.PLUGINS_UI_OUT, JSON.stringify({ ok: false, error: error.stack }))
    app.exit(1)
  })
}
