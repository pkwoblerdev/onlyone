// Встроенный браузер в панели превью — настоящим окном, настоящими страницами.
//
// Сеть не нужна: страницы живут на 127.0.0.1 в этом же процессе. Проверяется то, что
// видит человек (панель открылась, вкладки, адресная строка, назад/вперёд, новая вкладка
// из target=_blank, понятная ошибка, отказ от опасных адресов) и то, чего он не видит, но
// от чего зависит безопасность: у страницы нет Node, она не открывает file:, у неё закрыта
// геолокация. Последний кадр остаётся в профиле прогона при красном исходе.
const { spawnSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-browser-panel')
const profile = path.join(out, 'profile')
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model', legacyStoragePurged: true
}))

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px sans-serif">${body}</body>`
const PAGES = {
  '/': page('Страница А', '<h1>Страница А</h1><a id="toB" href="/b">к Б</a> <a id="blank" href="/new" target="_blank">в новую</a>'),
  '/b': page('Страница Б', '<h1>Страница Б</h1>'),
  '/new': page('Страница из новой вкладки', '<h1>Новая вкладка страницы</h1>')
}

async function freePort () {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
  })
}

async function main () {
  const server = http.createServer((request, response) => {
    const body = PAGES[request.url.split('?')[0]]
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body || page('Нет такой', 'нет'))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const deadPort = await freePort()

  const script = path.join(out, 'renderer.js')
  fs.writeFileSync(script, `(async () => {
  const PORT = ${port}
  const DEAD = ${deadPort}
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 15000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(100) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const errors = []
  window.addEventListener('error', event => errors.push(String(event.message)))
  const panel = () => $('artifactPanel')
  const tabsNow = () => [...document.querySelectorAll('#browserTabs .browser-tab')]
  const activeTitle = () => (document.querySelector('#browserTabs .browser-tab.active .browser-tab-title') || {}).textContent || ''
  const visibleView = () => [...document.querySelectorAll('#browserViews webview')].find(view => !view.hidden)
  const submit = async text => {
    const input = $('browserAddress')
    input.focus(); input.value = text
    $('browserForm').requestSubmit()
  }
  const guest = code => visibleView().executeJavaScript(code)

  async function run() {
    if (!await until(() => document.documentElement.dataset.appReady === '1')) { note('окно не поднялось', false); return }
    if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
    await wait(300)
    $('newChatBtn')?.click()
    await wait(300)

    // 1. Вход и пустая вкладка.
    note('кнопка браузера есть в шапке чата', Boolean($('openBrowserBtn')))
    $('openBrowserBtn').click()
    await wait(300)
    note('панель открылась в режиме браузера', !panel().hidden && panel().dataset.mode === 'browser', panel().dataset.mode)
    note('переключатель: «Браузер» выбран, «Превью» серое (результатов нет)',
      $('modeBrowser').getAttribute('aria-selected') === 'true' && $('modePreview').getAttribute('aria-disabled') === 'true')
    note('результат агента скрыт, браузер виден', getComputedStyle(document.querySelector('.artifact-body')).display === 'none' && getComputedStyle($('browserPane')).display !== 'none')
    note('заставка «Новая вкладка» показана', !$('browserEmpty').hidden)
    note('в адресной строке — фокус', document.activeElement === $('browserAddress'))
    note('одна пустая вкладка', tabsNow().length === 1, tabsNow().length)
    note('чат отвёл место под панель', $('chatView').classList.contains('artifact-open'))

    const addressBox = $('browserAddress').getBoundingClientRect()
    const expandBox = $('browserExpand').getBoundingClientRect()
    const closeBox = $('browserClose').getBoundingClientRect()
    const panelBox = panel().getBoundingClientRect()
    const center = box => box.top + box.height / 2
    note('адресная строка на уровне разворачивания и закрытия', Math.abs(center(addressBox) - center(closeBox)) <= 1 && Math.abs(center(addressBox) - center(expandBox)) <= 1, JSON.stringify({ address: center(addressBox), expand: center(expandBox), close: center(closeBox) }))
    note('адресная строка занимает верхнюю строку без наложения на кнопки', addressBox.width >= panelBox.width - 112 && addressBox.right <= expandBox.left, JSON.stringify({ address: addressBox.width, panel: panelBox.width }))

    // 2. Открыть страницу по голому адресу localhost.
    await submit('127.0.0.1:' + PORT)
    note('на странице появился <webview>', await until(() => Boolean(visibleView())))
    note('заголовок страницы стал названием вкладки', await until(() => activeTitle() === 'Страница А', 15000), activeTitle())
    note('адрес показан без лишнего: http://127.0.0.1:порт', $('browserAddress').value === 'http://127.0.0.1:' + PORT, $('browserAddress').value)
    note('заставка скрыта, обновить и «в системном браузере» включены', $('browserEmpty').hidden && !$('browserReload').disabled && !$('browserExternal').disabled)
    note('раздел сессии — свой', visibleView().getAttribute('partition') === 'persist:onlyone-browser')

    // 3. Назад / вперёд.
    note('назад пока выключено', $('browserBack').disabled)
    await guest("document.getElementById('toB').click()")
    note('переход по ссылке: вкладка называется «Страница Б»', await until(() => activeTitle() === 'Страница Б', 15000), activeTitle())
    note('назад включилось', await until(() => !$('browserBack').disabled))
    $('browserBack').click()
    note('назад вернул «Страница А»', await until(() => activeTitle() === 'Страница А', 15000), activeTitle())
    note('вперёд включилось', await until(() => !$('browserForward').disabled))
    $('browserForward').click()
    note('вперёд вернул «Страница Б»', await until(() => activeTitle() === 'Страница Б', 15000), activeTitle())
    $('browserBack').click()
    await until(() => activeTitle() === 'Страница А', 15000)

    // 4. Страница просит новую вкладку (target=_blank): окно приложения не открывается, вкладка — в панели.
    await guest("document.getElementById('blank').click()")
    note('вторая вкладка появилась', await until(() => tabsNow().length === 2, 15000), tabsNow().length)
    note('новая вкладка загрузилась и активна', await until(() => activeTitle() === 'Страница из новой вкладки', 15000), activeTitle())

    // 4б. Правая кнопка по ссылке: меню приложения (не системное) с «Открыть ссылку в новой вкладке».
    // Страница из новой вкладки не содержит ссылок — для правой кнопки вернёмся на первую вкладку.
    tabsNow()[0].querySelector('.browser-tab-pick').click()
    await wait(400)
    const link2 = await guest("(() => { const r = document.getElementById('toB').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()")
    const viewNow = visibleView()
    viewNow.sendInputEvent({ type: 'mouseDown', x: link2.x, y: link2.y, button: 'right', clickCount: 1 })
    viewNow.sendInputEvent({ type: 'mouseUp', x: link2.x, y: link2.y, button: 'right', clickCount: 1 })
    note('правая кнопка по ссылке открыла меню приложения', await until(() => Boolean(document.querySelector('.ctx-menu')), 8000))
    const labels = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(item => item.textContent.trim())
    note('в меню есть «Открыть ссылку в новой вкладке» и «Копировать адрес ссылки»',
      labels.some(text => /Открыть ссылку в новой вкладке/.test(text)) && labels.some(text => /Копировать адрес ссылки/.test(text)), labels.join(' | '))
    const tabsBeforeMenu = tabsNow().length
    ;[...document.querySelectorAll('.ctx-menu .ctx-item')].find(item => /Открыть ссылку в новой вкладке/.test(item.textContent)).click()
    note('пункт меню завёл новую вкладку со страницей Б', await until(() => tabsNow().length === tabsBeforeMenu + 1 && activeTitle() === 'Страница Б', 15000), activeTitle())

    // 5. Закрыть вкладку: активной становится соседняя.
    document.querySelector('#browserTabs .browser-tab.active .browser-tab-close').click()
    note('вкладка закрылась', await until(() => tabsNow().length === 2, 5000), tabsNow().length)
    // Лишнюю вкладку из меню тоже закрываем: дальше проверки идут на одной.
    document.querySelector('#browserTabs .browser-tab.active .browser-tab-close').click()
    await until(() => tabsNow().length === 1, 5000)
    tabsNow()[0].querySelector('.browser-tab-pick').click()
    note('осталась первая вкладка', await until(() => tabsNow().length === 1 && activeTitle() === 'Страница А', 5000), activeTitle())

    // 6. Закрытый порт — понятная ошибка и «Повторить».
    await submit('localhost:' + DEAD)
    note('закрытый порт: показана ошибка словами', await until(() => !$('browserError').hidden, 15000))
    note('в ошибке названа причина', /не отвечает|отклонено/i.test($('browserErrorText').textContent), $('browserErrorText').textContent)
    note('в ошибке назван адрес', $('browserErrorTitle').textContent.includes('localhost:' + DEAD), $('browserErrorTitle').textContent)
    note('есть «Повторить»', Boolean($('browserErrorRetry')) && !$('browserErrorRetry').hidden)
    await submit('127.0.0.1:' + PORT)
    note('после нормального адреса ошибка ушла', await until(() => $('browserError').hidden && activeTitle() === 'Страница А', 15000))

    // 7. Опасные адреса не открываются.
    const before = $('browserAddress').value
    await submit('javascript:alert(1)')
    await wait(400)
    note('javascript: отклонён словами, вкладка не тронута', activeTitle() === 'Страница А' && /нельзя/i.test($('artifactNotice').textContent), $('artifactNotice').textContent)
    await submit('file:///C:/Windows/win.ini')
    await wait(400)
    note('file: отклонён, адрес прежний', activeTitle() === 'Страница А')
    $('browserAddress').blur()
    await wait(200)
    note('после отказа в строке снова адрес страницы', $('browserAddress').value === before, $('browserAddress').value)

    // 8. Запрос превращается в поиск (без сети: смотрим, куда пошла вкладка).
    const tabsBefore = tabsNow().length
    $('browserNewTab').click()
    await wait(200)
    note('«+» завёл вкладку и поставил фокус в адрес', tabsNow().length === tabsBefore + 1 && document.activeElement === $('browserAddress'))
    await submit('как сварить кофе')
    await wait(300)
    const searchView = visibleView()
    note('запрос ушёл в поиск, а не в адрес', Boolean(searchView) && /^https:\\/\\/duckduckgo\\.com\\/\\?q=/.test(searchView.getAttribute('src') || ''), searchView && searchView.getAttribute('src'))
    document.querySelector('#browserTabs .browser-tab.active .browser-tab-close').click()
    await until(() => activeTitle() === 'Страница А', 5000)

    // 9. Безопасность гостя.
    note('у страницы нет Node: require и process не определены', (await guest("typeof require + '|' + typeof process")) === 'undefined|undefined')
    await guest("location.href = 'file:///C:/Windows/win.ini'")
    await wait(600)
    note('страница не может уйти на file:', (await guest('location.protocol')) === 'http:')
    const geo = await guest("new Promise(r => navigator.geolocation.getCurrentPosition(() => r('выдано'), e => r('код ' + e.code), { timeout: 4000 }))")
    note('геолокация сайту не выдаётся', geo !== 'выдано', geo)
    const ua = await guest('navigator.userAgent')
    note('user-agent без Electron и имени приложения', !/Electron|onlyone|1code/i.test(ua), ua)

    // 10. Клавиатура.
    $('browserAddress').blur()
    document.body.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }))
    note('Ctrl+L ставит фокус в адресную строку', document.activeElement === $('browserAddress'))

    // 11. Закрыли — место вернулось; открыли — вкладки на месте.
    $('browserClose').click()
    await wait(300)
    note('панель закрылась и чат вернул место', panel().hidden && !$('chatView').classList.contains('artifact-open'))
    $('openBrowserBtn').click()
    await wait(300)
    note('вкладки пережили закрытие панели', tabsNow().length === 1 && activeTitle() === 'Страница А', tabsNow().length + ' · ' + activeTitle())
    note('кнопка в шапке нажата (aria-pressed)', $('openBrowserBtn').getAttribute('aria-pressed') === 'true')
  }

  try { await run() } catch (error) {
    note('проверка упала', false, String((error && error.stack) || error).slice(0, 400))
  }
  note('ошибок в окне нет', !errors.length, errors.join(' | '))
  return { ok: checks.every(c => c.pass), checks }
})()`)

  const resultFile = path.join(out, 'result.json')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_SHOT: path.join(out, 'browser.png') })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 170000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  server.close()

  let ok = false
  if (!fs.existsSync(resultFile)) {
    console.error('Окно не отчиталось')
  } else {
    const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    if (report.error) console.error('окно сообщило об ошибке — ' + report.error)
    for (const item of report.checks || []) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    ok = Boolean(report.ok)
  }
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}

main().catch(error => { console.error(error); process.exit(1) })
void spawnSync
