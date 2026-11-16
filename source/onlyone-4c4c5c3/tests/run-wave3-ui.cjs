// Волна 3 (слово владельца 04.10): настоящее окно, настоящий ход.
//   · над полем ввода нет строки «папка · модель · контекст», кольцо на месте;
//   · отправка — круг, как в макете 18.10; значки под ответом крупнее;
//   · молнии в поле ввода нет, Fast — в блоке выбора модели; модель и effort — раздельно;
//   · меню папок — один список без заголовков;
//   · имя чата в шапке и в списке одно и то же;
//   · «Задачи» — одна кнопка на чат, панель открывается и в пустом чате.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-wave3')
const workspace = path.join(out, 'workspace')
fs.mkdirSync(workspace, { recursive: true })

const providerFile = path.join(out, 'provider.json')
fs.writeFileSync(providerFile, JSON.stringify({ turns: [{ text: 'Первый ответ.' }, { text: 'Второй ответ.' }] }))

const profile = path.join(out, 'profile')
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model', legacyStoragePurged: true,
  workspace: { path: workspace, permission: 'acceptEdits' }
}))

const script = path.join(out, 'renderer.js')
fs.writeFileSync(script, `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 30000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(100) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const errors = []
  window.addEventListener('error', event => errors.push(String(event.message)))
  const flat = el => ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim()
  const send = async text => {
    $('composerTextarea').value = text
    $('composerTextarea').dispatchEvent(new Event('input', { bubbles: true }))
    $('composerForm').requestSubmit()
    await wait(300)
    await until(() => !document.querySelector('.btn-send.is-stop'), 60000)
    await wait(400)
  }

  async function run() {
    if (!await until(() => document.documentElement.dataset.appReady === '1')) { note('окно не поднялось', false); return }
    if ($('onboarding') && !$('onboarding').hidden) $('onboardingSkip')?.click()
    await wait(300)
    $('newChatBtn')?.click()
    await wait(400)

    // Строка контекста снята, кольцо на месте.
    note('строки «папка · модель · контекст» над полем ввода нет', !$('chatContextContainer') && !document.querySelector('.chat-context-bar'))
    // Макет 18.10: в пустом чате кольцо спрятано, место — после кнопок модели и effort.
    note('кольцо контекста стоит у поля ввода', Boolean($('contextRingBtn')))

    // Отправка — круг (макет 18.10).
    const radius = parseFloat(getComputedStyle($('sendBtn')).borderTopLeftRadius)
    const half = $('sendBtn').getBoundingClientRect().width / 2
    note('отправка — круг', radius >= half - 1, 'радиус ' + radius + ', половина ' + half)

    // Молнии в поле ввода нет; модель и effort — две кнопки; Fast — в блоке модели.
    note('молнии Fast в поле ввода нет', !$('fastModeBtn'))
    note('effort — отдельная кнопка, не внутри кнопки модели', Boolean($('effortPillBtn')) && !$('modelEffortPillBtn').contains($('pillEffortName')))
    $('modelEffortPillBtn').click()
    await wait(300)
    const pop = $('modelPopover')
    note('блок выбора модели открылся (не окно на весь экран)', pop && !pop.hidden && pop.getBoundingClientRect().height < window.innerHeight * 0.8, pop && Math.round(pop.getBoundingClientRect().height))
    note('в блоке есть поиск, прокручиваемый список и строка Fast', Boolean(pop.querySelector('.mp-search') && pop.querySelector('.mp-list') && pop.querySelector('.mp-fast')))
    const before = pop.querySelectorAll('.mp-row').length
    const search = pop.querySelector('.mp-search')
    search.value = 'zzzz-нет-такой'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(150)
    note('поиск фильтрует список', before > 1 && pop.querySelectorAll('.mp-row').length === 0 && /не найдены/i.test(flat(pop.querySelector('.mp-list'))), before + ' → ' + pop.querySelectorAll('.mp-row').length)
    search.value = ''
    search.dispatchEvent(new Event('input', { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(150)
    note('Escape закрывает блок', pop.hidden)
    note('кольцо правее кнопки модели', Boolean($('modelEffortPillBtn').compareDocumentPosition($('contextRingBtn')) & Node.DOCUMENT_POSITION_FOLLOWING))

    // Правки 05.10: меньше моделей в блоке, без стрелок, effort не выключается, «Задачи» без надписи.
    $('modelEffortPillBtn').click()
    await until(() => pop.querySelectorAll('.mp-row').length > 6, 8000)
    await wait(250)
    // Правка 05.10 (вечер): окна «Все модели» нет вовсе, весь каталог листается в самом блоке.
    const listBox = pop.querySelector('.mp-list')
    const rowCount = pop.querySelectorAll('.mp-row').length
    note('в блоке весь каталог без обрезки по шесть, а длинный список прокручивается', rowCount > 6 && listBox.scrollHeight > listBox.clientHeight && getComputedStyle(listBox).overflowY === 'auto', rowCount + ' строк, ' + listBox.scrollHeight + ' > ' + listBox.clientHeight)
    note('блок невысокий и не закрывает окно целиком', pop.getBoundingClientRect().height < window.innerHeight * 0.8, Math.round(pop.getBoundingClientRect().height))
    note('кнопки «Все модели и фильтры…» и окна-каталога нет', !pop.querySelector('.mp-all') && !/Все модели и фильтры/.test(flat(pop)))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(150)
    note('у кнопок модели и effort нет стрелок', !$('modelEffortPillBtn').querySelector('svg') && !$('effortPillBtn').querySelector('svg'))
    $('effortPillBtn').click()
    await wait(250)
    const effortText = flat($('effortPopover'))
    note('effort нельзя выключить: нет «Выкл», None и Minimal, самая тихая — Low', !/Выкл|None|Minimal/.test(effortText) && /Low/.test(effortText), effortText)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(150)

    // Папки: один список без заголовков.
    $('workspaceBtn').click()
    await wait(300)
    const menu = document.querySelector('.ctx-menu, .context-menu')
    const menuText = flat(menu)
    note('меню папок открылось', Boolean(menu), menuText.slice(0, 120))
    note('в меню нет заголовков «Все чаты» / «Этот чат» и счётчиков', !/Все чаты|Этот чат|\\+\\d/.test(menuText) && /Добавить папку/.test(menuText), menuText.slice(0, 160))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.body.click()
    await wait(200)

    // Ход, значки под ответом, имя чата.
    await send('Придумай название для проверки одинаковых имён чата')
    const action = document.querySelector('#messagesList .msg-action')
    const box = action && action.getBoundingClientRect()
    note('значки под ответом не мельче 28 px', box && box.width >= 28 && box.height >= 28, box && (Math.round(box.width) + '×' + Math.round(box.height)))
    const headerTitle = () => flat($('chatHeaderTitle'))
    const listTitle = () => flat(document.querySelector('.history-item.active'))
    note('имя чата в шапке и в списке совпадает', headerTitle() && listTitle().includes(headerTitle().slice(0, 12)), headerTitle() + ' | ' + listTitle())
    // Переименование через шапку: список догоняет сразу.
    $('chatHeaderTitle').click()
    await wait(200)
    const input = document.querySelector('#chatHeader input')
    if (input) {
      input.value = 'Новое имя чата'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.blur()
    }
    await wait(500)
    note('после переименования шапка и список показывают одно имя', headerTitle() === 'Новое имя чата' && listTitle().includes('Новое имя чата'), headerTitle() + ' | ' + listTitle())

    // Задачи: одна кнопка, панель этого чата.
    note('«Работа агентов» отдельной кнопкой нет', !document.querySelector('#chatHeader .tasks-header-btn'))
    note('кнопка «Задачи» одна', document.querySelectorAll('#chatHeader #navTasks').length === 1)
    const tasksLabel = [...$('navTasks').querySelectorAll('span:not(.task-center-trigger-count)')].some(s => s.getBoundingClientRect().width > 0)
    note('кнопка «Задачи» без надписи, только значок', !tasksLabel && $('navTasks').getBoundingClientRect().width < 48, Math.round($('navTasks').getBoundingClientRect().width) + ' px')
    $('newChatBtn')?.click()
    await wait(500)
    $('navTasks').click()
    await wait(500)
    const panel = $('tasksPanel')
    note('панель задач открывается и в чате без работы', Boolean(panel), flat(panel).slice(0, 100))
    note('в пустом чате сказано, что ничего не идёт', /ничего не идёт/.test(flat(panel)), flat(panel).slice(0, 120))
    $('navTasks').click()
    await wait(300)
    note('повторное нажатие закрывает панель', !$('tasksPanel'))
  }

  try { await run() } catch (error) {
    note('проверка упала', false, String((error && error.stack) || error).slice(0, 400))
  }
  note('ошибок в окне нет', !errors.length, errors.join(' | '))
  return { ok: checks.every(c => c.pass), checks }
})()`)

async function main () {
  const resultFile = path.join(out, 'result.json')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_SHOT: path.join(out, 'wave3.png') })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 240000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  let ok = false
  if (!fs.existsSync(resultFile)) {
    console.error('Окно не отчиталось')
  } else {
    const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    for (const item of report.checks || []) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    ok = Boolean(report.ok)
  }
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
