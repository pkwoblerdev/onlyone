'use strict'
// Уроки проекта (АГ-4) на странице проекта в окне Electron: настоящий preload, каналы lessons:*, registerLessonsIpc,
// хранилище с safeStorage и настоящие mk-kit.js, projects-page.js и project-lessons.js. Проверяет: пусто → ошибки полей →
// предложить → включить → исправить → отозвать; что действует в промпте; шифрование на диске; ошибка хранилища без
// технического текста; другой проект не видит уроков; RU/EN × тёмная/светлая, границы и отсутствие кириллицы в EN.
const fs = require('node:fs'), path = require('node:path')
if (!process.argv.includes('--probe')) {
  const { spawnSync } = require('node:child_process')
  const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
  const dir = runDir('onlyone-project-lessons'), output = path.join(dir, 'result.json')
  const child = spawnSync(electronBinary(), [__filename, '--probe', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + path.join(dir, 'profile')], {
    cwd: path.join(__dirname, '..'), timeout: 120000, windowsHide: true, env: guiEnv({ LESSONS_UI_OUT: output, LESSONS_UI_DIR: dir })
  })
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { ok: false, error: child.error?.message || 'No window result' }
  console.log(JSON.stringify(result))
  const ok = result.ok && child.status === 0
  if (!ok) console.error(child.stderr?.toString().slice(-1500))
  settleRun(dir, ok); process.exit(ok ? 0 : 1)
} else {
  const { app, BrowserWindow, ipcMain, safeStorage } = require('electron'), { pathToFileURL } = require('node:url'), assert = require('node:assert/strict')
  app.whenReady().then(async () => {
    const dir = process.env.LESSONS_UI_DIR, root = path.join(__dirname, '..'), file = name => pathToFileURL(path.join(root, 'src/renderer', name)).href
    const lessonsLib = require('../src/main/project-lessons.cjs')
    const storeFile = path.join(dir, 'lessons.json')
    const storage = () => require('../src/main/mods-store.cjs').createStore({ file: storeFile,
      protect: text => safeStorage.encryptString(text).toString('base64'), unprotect: body => safeStorage.decryptString(Buffer.from(body, 'base64')) })
    const service = lessonsLib.createLessons({ storage: storage() })
    let breakNext = false
    const html = '<!doctype html><html lang="ru" data-theme="dark"><meta charset="utf-8">' +
      ['fonts.css', 'tokens.css', 'index.css', 'look.css', 'look-pages.css', 'project-lessons.css'].map(name => `<link rel="stylesheet" href="${file(name)}">`).join('') +
      '<body><section id="projectsView" class="view-panel mk active"><div class="page" id="projectsPage"><div class="page-inner"></div></div></section>' +
      ['i18n.js', 'mk-kit.js', 'project-lessons.js', 'projects-page.js'].map(name => `<script src="${file(name)}"></script>`).join('') + '</body></html>'
    const target = path.join(dir, 'fixture.html'); fs.writeFileSync(target, html)
    // preload при загрузке синхронно спрашивает канал сборки: без ответа окно ждало бы его вечно
    ipcMain.on('get-channel', event => { event.returnValue = 'stable' })
    const win = new BrowserWindow({ show: true, width: 1180, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(root, 'src/preload/preload.js') } })
    lessonsLib.registerLessonsIpc({ ipcMain,
      getService: () => { if (breakNext) { breakNext = false; throw Error('PRIVATE C:/Users/someone/lessons.json') } return service },
      isMain: event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame,
      projectExists: id => id === 'p1' || id === 'p2',
      chatInProject: (projectId, chatId) => projectId === 'p1' && chatId === 'chat-a' })
    const errors = []; win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
    await win.loadFile(target)
    const js = code => win.webContents.executeJavaScript(code)
    const until = async (condition, label = condition) => { for (let i = 0; i < 150; i++) { if (await js(condition)) return; await new Promise(r => setTimeout(r, 20)) }; throw Error('UI timeout: ' + label) }
    const lessons = projectId => service.list(projectId).lessons
    const prompt = request => service.promptBlock('p1', { request, mode: 'agent' })
    await js(`
      window.__t = (s, ...a) => { let r = document.documentElement.lang === 'en' ? (window.__I18N__.en[s] || s) : s; for (const x of a) r = r.replace('%s', x); return r };
      window.toasts = []
      const projects = [{ id: 'p1', name: 'Onlyone', workspacePath: '', description: 'Настольное приложение', plan: [], knowledgeFiles: [], folders: [] },
        { id: 'p2', name: 'Сайт', workspacePath: '', plan: [], knowledgeFiles: [], folders: [] }]
      const chats = [{ id: 'chat-a', projectId: 'p1', title: 'Почему падают тесты', updatedAt: Date.now() - 3600e3, messages: [] }]
      window.page = OnlyoneProjectsPage.create({
        host: document.getElementById('projectsView'), getProjects: () => projects, save() {}, changed() {},
        chatsOf: id => chats.filter(c => c.projectId === id), normalizePlan: v => Array.isArray(v) ? v : [], relTime: () => '',
        mcpServers: () => [], pickFolder: async () => null, pickFiles: async () => [], newChat() {}, openChat() {}, remove: async () => {},
        ask: async (message, initial) => { window.asked = [message, initial]; return window.askReply === undefined ? initial : window.askReply },
        menu: (button, items) => OnlyoneMk.popMenu(button, items), toast: (text, isError) => { window.toasts.push([text, Boolean(isError)]) },
        openRules() {}, addMcp() {}, cleanError: e => String(e)
      })
      window.page.render(); true`)
    const section = "document.querySelector('#pjLessons')"
    await until(`${section} && ${section}.querySelector('[data-x=lsnew]')`, 'пустой раздел уроков')
    assert.equal(await js(`${section}.textContent.includes('не действует')`), true, 'пусто: сказано, что урок не действует без включения')

    // Предложить: пустая форма не уходит, ошибки у полей
    await js(`${section}.querySelector('[data-x=lsnew]').click()`)
    await until(`document.querySelector('#lsText')`)
    await js(`document.querySelector('.ls-form [type=submit]').click()`)
    assert.equal(await js(`document.querySelector('#lsText').getAttribute('aria-invalid')`), 'true')
    assert.equal(await js(`document.querySelector('#lsEvidence').getAttribute('aria-invalid')`), 'true')
    assert.equal(lessons('p1').length, 0, 'пустое предложение не записано')
    await js(`document.querySelector('#lsText').value = 'Тесты запускаются через npm test, а не jest напрямую'
      document.querySelector('#lsWhen').value = 'при запуске тестов'
      document.querySelector('#lsWords').value = 'тест, jest'
      document.querySelector('#lsEvidence').value = 'jest без конфигурации упал, npm test прошёл'; true`)
    // Источник — чат проекта, выбранный из меню
    await js(`document.querySelector('[data-x=lssrc]').click()`)
    await until(`document.querySelector('.menu.pop .mi')`)
    await js(`[...document.querySelectorAll('.menu.pop .mi')].find(b => b.textContent.includes('Почему падают тесты')).click()`)
    assert.equal(await js(`document.querySelector('[data-x=lssrc]').textContent.includes('Почему падают тесты')`), true)
    await js(`document.querySelector('.ls-form [type=submit]').click()`)
    await until(`${section}.querySelector('.ls-row[data-status=proposed]')`, 'предложенный урок в списке')
    const first = lessons('p1')[0]
    assert.equal(first.status, 'proposed')
    assert.deepEqual(first.source, { chatId: 'chat-a', turnId: '', evidence: 'jest без конфигурации упал, npm test прошёл', by: 'human' })
    assert.deepEqual(first.keywords, ['тест', 'jest'])
    assert.equal(prompt('запусти тесты'), '', 'предложенный урок не действует')
    assert.equal(await js(`${section}.querySelector('.ls-row[data-status=proposed]').textContent.includes('Почему падают тесты')`), true, 'источник виден')

    // Включить — урок действует в промпте своего проекта по словам просьбы
    await js(`${section}.querySelector('[data-x=lsenable]').click()`)
    await until(`${section}.querySelector('.ls-row[data-status=enabled]')`, 'урок включён')
    assert.ok(prompt('запусти тесты').includes('npm test, а не jest напрямую'), 'включённый урок в промпте')
    assert.equal(prompt('напиши README'), '', 'без слова из условия урок не применим')
    assert.equal(service.promptBlock('p2', { request: 'запусти тесты', mode: 'agent' }), '', 'другой проект урок не получает')
    const raw = fs.readFileSync(storeFile, 'utf8')
    assert.equal(raw.includes('npm test') || raw.includes('chat-a'), false, 'на диске только шифрованный текст')
    assert.equal(lessonsLib.createLessons({ storage: storage() }).list('p1').lessons[0].status, 'enabled', 'переживает перезапуск')

    // Исправить: форма с прежними значениями, новая версия ждёт включения, старая — в отозванных с историей
    await js(`${section}.querySelector('[data-x=lsfix]').click()`)
    await until(`document.querySelector('#lsText') && document.querySelector('#lsText').value.includes('npm test')`)
    assert.equal(await js(`document.querySelector('#lsWhen').value`), 'при запуске тестов')
    await js(`document.querySelector('#lsText').value = 'Тесты запускаются через npm run test:unit'; document.querySelector('.ls-form [type=submit]').click(); true`)
    await until(`${section}.querySelector('.ls-row[data-status=proposed]') && !${section}.querySelector('.ls-row[data-status=enabled]')`, 'исправление ждёт включения')
    assert.equal(prompt('запусти тесты'), '', 'исправление не действует до включения, старая версия — тоже')
    assert.equal(await js(`window.toasts.some(([t]) => t.includes('включите'))`), true, 'сказано, что исправление надо включить')
    await js(`${section}.querySelector('[data-x=lsold]').click()`)
    await until(`${section}.querySelector('.ls-old .ls-row[data-status=revoked]')`, 'отозванные видны с историей')
    assert.equal(await js(`${section}.querySelector('.ls-old').textContent.includes('заменён исправлением')`), true, 'в истории видно, что версию заменили')

    // Отозвать с причиной
    await js(`window.askReply = 'Устарел'; ${section}.querySelector('.ls-row[data-status=proposed] [data-x=lsrevoke]').click()`)
    await until(`${section}.querySelectorAll('.ls-old .ls-row').length === 2`, 'второй отзыв')
    assert.deepEqual(lessons('p1').map(l => l.status), ['revoked', 'revoked'], 'действующих уроков не осталось, оба в истории')
    assert.ok(lessons('p1').some(l => l.reason === 'Устарел'), 'причина отзыва записана')
    await js(`window.askReply = undefined; true`)

    // Ошибка хранилища: понятный текст, без кода и пути, введённое не потеряно
    await js(`${section}.querySelector('[data-x=lsnew]').click()`)
    await until(`document.querySelector('#lsText')`)
    breakNext = true
    await js(`document.querySelector('#lsText').value = 'Ещё правило'; document.querySelector('#lsEvidence').value = 'проверено'; document.querySelector('.ls-form [type=submit]').click(); true`)
    await until(`window.toasts.some(([, bad]) => bad)`, 'тост ошибки')
    const bad = await js(`window.toasts.filter(([, bad]) => bad).map(([t]) => t).join(' | ')`)
    assert.equal(/storage-unavailable|PRIVATE|Users/.test(bad), false, 'код и путь ошибки не показаны человеку')
    assert.equal(await js(`document.querySelector('#lsText') && document.querySelector('#lsText').value`), 'Ещё правило', 'введённое не потеряно')
    await js(`document.querySelector('[data-x=lscancel]').click()`)

    // Другой проект уроков не видит
    await js(`document.querySelector('.pj-item[data-id=p2]').click()`)
    await until(`${section} && ${section}.dataset.project === 'p2' && ${section}.querySelector('[data-x=lsnew]') && !${section}.querySelector('.ls-row')`, 'чужой проект пуст')
    await js(`document.querySelector('.pj-item[data-id=p1]').click()`)
    await until(`${section} && ${section}.querySelector('[data-x=lsold]')`)

    // Для вида: один действующий урок со словами и один, ждущий включения
    const proposeVia = async (text, evidence, words) => {
      await js(`${section}.querySelector('[data-x=lsnew]').click()`)
      await until(`document.querySelector('#lsText')`)
      await js(`document.querySelector('#lsText').value = ${JSON.stringify(text)}; document.querySelector('#lsWords').value = ${JSON.stringify(words)}; document.querySelector('#lsEvidence').value = ${JSON.stringify(evidence)}; document.querySelector('.ls-form [type=submit]').click(); true`)
      await until(`!document.querySelector('.ls-form') && [...${section}.querySelectorAll('.ls-row .row-t')].some(e => e.textContent === ${JSON.stringify(text)})`)
    }
    await proposeVia('Сборку проверять скачиванием по sha512', 'выкладка 24.10 прошла только после сверки', 'сборк')
    await js(`${section}.querySelector('[data-x=lsenable]').click()`)
    await until(`${section}.querySelector('.ls-row[data-status=enabled]')`)
    await proposeVia('Коммиты писать по-английски', 'договорились в чате 20.10', '')
    // Открытая форма переживает перерисовку раздела и не перетекает в исправление другого урока
    await js(`${section}.querySelector('[data-x=lsnew]').click()`)
    await until(`document.querySelector('#lsText')`)
    const expanded = await js(`${section}.querySelector('[data-x=lsold]').getAttribute('aria-expanded')`)
    await js(`document.querySelector('#lsText').value = 'Черновик в форме'; ${section}.querySelector('[data-x=lsold]').click(); true`)
    await until(`document.querySelector('#lsText') && ${section}.querySelector('[data-x=lsold]').getAttribute('aria-expanded') !== ${JSON.stringify(expanded)}`, 'раздел перерисован')
    assert.equal(await js(`document.querySelector('#lsText').value`), 'Черновик в форме', 'набранное не потеряно при перерисовке')
    await js(`${section}.querySelector('.ls-row[data-status=proposed] [data-x=lsfix]').click()`)
    await until(`document.querySelector('#lsText') && document.querySelector('#lsText').value === 'Коммиты писать по-английски'`, 'исправление открылось со своим текстом')
    await js(`document.querySelector('[data-x=lscancel]').click(); true`)
    const block = prompt('собери сборку')
    assert.ok(block.includes('sha512') && !block.includes('по-английски'), 'в промпте только включённый и применимый урок')

    // Вид: RU/EN × тёмная/светлая — список и форма
    const shots = process.env.LESSONS_UI_SHOTS
    const userData = ['Тесты запускаются через npm test, а не jest напрямую', 'Тесты запускаются через npm run test:unit', 'jest без конфигурации упал, npm test прошёл',
      'Почему падают тесты', 'при запуске тестов', 'тест, jest', 'Устарел', 'Сборку проверять скачиванием по sha512', 'выкладка 24.10 прошла только после сверки',
      'сборк', 'Коммиты писать по-английски', 'договорились в чате 20.10'].sort((a, b) => b.length - a.length)
    const inspect = async (language, theme, view) => {
      const box = await js(`(() => { const s = ${section}, r = s.getBoundingClientRect(); return { left: r.left, right: r.right, inner: innerWidth, overflow: s.scrollWidth - s.clientWidth } })()`)
      assert.ok(box.left >= 0 && box.right <= box.inner && box.overflow <= 1, `${language}/${theme}/${view}: раздел вылез за края ${JSON.stringify(box)}`)
      if (language === 'en') {
        // Введённое человеком (формулировки, условия, доказательства, название чата) — данные, а не интерфейс
        const cyr = await js(`(() => { const s = ${section}; const attrs = [...s.querySelectorAll('[aria-label],[placeholder],[data-tooltip]')].map(e => [e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('data-tooltip')].join(' ')).join(' ');
          let rest = s.innerText + ' ' + attrs; for (const u of ${JSON.stringify(userData)}) rest = rest.split(u).join(''); return (rest.match(/[А-Яа-яЁё]+/g) || []).slice(0, 12) })()`)
        assert.deepEqual(cyr, [], `EN/${view}: русские слова интерфейса в разделе уроков`)
      }
      if (shots) {
        fs.mkdirSync(shots, { recursive: true })
        await js(`${section}.scrollIntoView({ block: 'start' }); true`)
        await new Promise(r => setTimeout(r, 250))
        fs.writeFileSync(path.join(shots, `project-lessons-${view}-${language}-${theme}.png`), (await win.webContents.capturePage()).toPNG())
      }
    }
    for (const language of ['ru', 'en']) for (const theme of ['dark', 'light']) {
      await js(`document.documentElement.lang='${language}'; document.documentElement.dataset.theme='${theme}'; window.page.render(); true`)
      await until(`${section} && ${section}.querySelector('[data-x=lsold]') && ${section}.querySelector('.ls-row[data-status=proposed]')`)
      await js(`${section}.querySelector('[data-x=lsold]').getAttribute('aria-expanded') === 'true' || ${section}.querySelector('[data-x=lsold]').click(); true`)
      await until(`${section}.querySelector('.ls-old .ls-row')`)
      await inspect(language, theme, 'list')
      await js(`${section}.querySelector('[data-x=lsnew]').click(); true`)
      await until(`document.querySelector('#lsText')`)
      await inspect(language, theme, 'form')
      await js(`document.querySelector('[data-x=lscancel]').click(); true`)
    }
    assert.deepEqual(errors, [])
    fs.writeFileSync(process.env.LESSONS_UI_OUT, JSON.stringify({ ok: true, checks: ['real preload and lessons:* IPC', 'empty state explains inactive until enabled', 'field errors before send', 'source chat from menu, by=human set by main', 'propose/enable/correct/revoke', 'prompt: only enabled and applicable, own project only', 'encrypted on disk, reload', 'correction waits for enabling', 'revoked kept with history', 'storage error without code or path, input kept', 'other project isolated', 'RU/EN both themes, bounds, no Cyrillic in EN'], errors }))
    app.exit(0)
  }).catch(error => { fs.writeFileSync(process.env.LESSONS_UI_OUT, JSON.stringify({ ok: false, error: error.stack })); app.exit(1) })
}
