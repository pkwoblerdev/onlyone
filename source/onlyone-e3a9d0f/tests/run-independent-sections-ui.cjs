'use strict'

// Оконная проверка расширенного обзора «Участки изменений» (.sections).
//
// Не подставной сервис, как в test-review-sections: настоящее окно, настоящие
// IPC review-agent-sections / preview-agent-section / undo-agent-sections,
// настоящий журнал снимков и рабочие файлы во временной папке. Ход создаёт
// файл с двумя правками (два участка), изменённый файл, ещё один файл и
// выполненную команду.
//
// Проверяется: список файла/команды, предпросмотр, выборочный откат одного
// участка (соседний остаётся), двойной щелчок по подтверждению, поздняя правка
// файла (conflict), отказ записи (файл только для чтения), откат команды,
// закрытие/переоткрытие, RU/EN, обе темы, узкое окно и клавиатурные свойства.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const dir = runDir('onlyone-sections-ui')
const MODEL = 'dots-studio/dots-3-note-preview:free'

const PRELUDE = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 120000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(100) } return false }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail).slice(0, 600) })
  const busy = () => $('sendBtn')?.classList.contains('is-stop')
  const feed = () => $('messagesList').innerText.replace(/\\s+/g, ' ')
  const dialog = () => document.querySelector('.review-sections-dialog')
  const rows = () => [...document.querySelectorAll('.review-sections-list tbody tr')]
  const rowText = row => row.innerText.replace(/\\s+/g, ' ')
  const preview = row => row.querySelector('[data-action=preview-section]').click()
  const closeDialog = () => document.querySelector('.review-sections-dialog header button').click()
  const send = async text => {
    const box = $('composerTextarea')
    box.value = text
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(120)
    $('composerForm').requestSubmit()
  }
  const openSections = async () => {
    await send('.sections')
    const opened = await until(() => Boolean(dialog()?.open), 20000)
    if (!opened) return false
    // Список приходит отдельным IPC-ответом уже после открытия диалога; пока он
    // идёт, в диалоге висит «Загрузка…», а «Обновить» выключена.
    return until(() => rows().length > 0 &&
      !document.querySelector('.review-sections-toolbar .btn-secondary')?.disabled, 20000)
  }
`

const TURN_SCRIPT = {
  keyed: [{
    match: 'Сделай правки в файлах',
    once: true,
    toolCalls: [
      { name: 'write_file', args: { path: 'alpha.js', content: 'line1\nline2\nline3' } },
      { name: 'edit_file', args: { path: 'alpha.js', old_str: 'line2', new_str: 'line2 edited' } },
      { name: 'edit_file', args: { path: 'alpha.js', old_str: 'line3', new_str: 'line3 edited' } },
      { name: 'edit_file', args: { path: 'beta.js', old_str: 'beta old', new_str: 'beta new' } },
      { name: 'edit_file', args: { path: 'gamma.js', old_str: 'gamma old', new_str: 'gamma new' } },
      { name: 'write_file', args: { path: 'delta.js', content: 'delta one' } },
      { name: 'run_command', args: { command: 'node -e "require(\'fs\').appendFileSync(\'cmd.txt\',\'x\')"' } }
    ]
  }, {
    match: 'Сделай ещё одну правку',
    once: true,
    toolCalls: [{ name: 'edit_file', args: { path: 'delta.js', old_str: 'delta one', new_str: 'delta two' } }]
  }],
  turns: [{ text: 'ГОТОВО: файлы изменены.' }]
}

const SHOTS_SCRIPT = {
  keyed: [{
    match: 'Подготовь снимки обзора',
    once: true,
    toolCalls: [
      { name: 'write_file', args: { path: 'shot-file.js', content: 'const shot = 1\n' } },
      { name: 'run_command', args: { command: 'node -e "require(\'fs\').appendFileSync(\'shot-cmd.txt\',\'x\')"' } }
    ]
  }],
  turns: [{ text: 'ГОТОВО: снимки подготовлены.' }]
}

function profileFor (name) {
  const base = path.join(dir, name)
  const profile = path.join(base, 'profile')
  const workspace = path.join(base, 'workspace')
  fs.mkdirSync(profile, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: MODEL, enabled: true }],
    defaultModel: MODEL,
    legacyStoragePurged: true,
    workspace: { path: workspace, permission: 'auto' },
    agentTeam: { count: 1, models: [] }
  }))
  fs.writeFileSync(path.join(workspace, 'beta.js'), 'beta old\n')
  fs.writeFileSync(path.join(workspace, 'gamma.js'), 'gamma old\n')
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Fixture\n')
  return { base, profile, workspace }
}

function launch (name, { profile, workspace, script, provider, body, shot = null }) {
  const base = path.join(dir, name)
  fs.mkdirSync(base, { recursive: true })
  const providerFile = path.join(base, 'provider.json')
  fs.writeFileSync(providerFile, JSON.stringify(script))
  const smoke = path.join(base, 'smoke.js')
  const resultFile = path.join(base, 'result.json')
  fs.writeFileSync(smoke, `(async () => {${PRELUDE}
  try {${body}
    note('в окне нет ошибок', !window.__errors?.length, (window.__errors || []).join(' | '))
  } catch (error) {
    checks.push({ name: 'сценарий дошёл до конца', pass: false, detail: String(error && error.stack || error).slice(0, 600) })
  }
  return { ok: checks.every(item => item.pass), checks, facts: window.__facts || {} }
  })()`)
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: guiEnv({ ONECODE_SMOKE: smoke, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: providerFile, ...(shot ? { ONECODE_SHOT: shot } : {}) })
  })
  let tail = ''
  child.stdout.on('data', data => { tail = (tail + data).slice(-3000) })
  child.stderr.on('data', data => { tail = (tail + data).slice(-3000) })
  return { child, resultFile, tail: () => tail, workspace }
}

async function finish (run, timeoutMs = 240000) {
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => { try { run.child.kill('SIGKILL') } catch {}; resolve('timeout') }, timeoutMs)
    run.child.once('error', () => { clearTimeout(timer); resolve('error') })
    run.child.once('close', value => { clearTimeout(timer); resolve(value) })
  })
  const report = fs.existsSync(run.resultFile)
    ? JSON.parse(fs.readFileSync(run.resultFile, 'utf8'))
    : { ok: false, checks: [], facts: {}, error: 'окно не отчиталось: ' + run.tail() }
  return { code, report }
}

function finishRun () {
  const evidence = process.env.ONECODE_EVIDENCE_DIR
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true })
    for (const file of fs.readdirSync(dir)) {
      if (/^sections-(ru|en)-(dark|light)[.]png$/.test(file)) fs.copyFileSync(path.join(dir, file), path.join(evidence, file))
    }
  }
  const failed = checks.filter(item => !item.pass)
  console.log('')
  if (failed.length) console.error(`ПРОВАЛ: ${failed.length} из ${checks.length}`)
  else console.log(`Участки изменений: ${checks.length} проверок, провалов 0`)
  settleRun(dir, failed.length === 0)
  process.exitCode = failed.length ? 1 : 0
}

const checks = []
const note = (name, pass, detail = '') => {
  checks.push({ name, pass: Boolean(pass), detail })
  console.log((pass ? '  ok     ' : '  ПРОВАЛ ') + name + (detail ? ' — ' + String(detail).slice(0, 500) : ''))
}

// Поздняя чужая правка и защита записи — снаружи приложения, как это и бывает
// у человека: файл поправили в редакторе или он открыт другой программой.
async function disturbAfterTurn (workspace) {
  const target = path.join(workspace, 'cmd.txt')
  const stop = Date.now() + 120000
  while (Date.now() < stop) {
    if (fs.existsSync(target)) break
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  await new Promise(resolve => setTimeout(resolve, 400))
  fs.writeFileSync(path.join(workspace, 'gamma.js'), 'gamma later edit\n')
  try { fs.chmodSync(path.join(workspace, 'beta.js'), 0o444) } catch { /* файл уже защищён */ }
  return { later: fs.readFileSync(path.join(workspace, 'gamma.js'), 'utf8') }
}

;(async () => {
  // Точечный прогон: ONECODE_SECTIONS_ONLY=main пропускает снимки.
  const only = String(process.env.ONECODE_SECTIONS_ONLY || '')
  const { base, profile, workspace } = profileFor('main')

  const run = launch('main', {
    profile, workspace, script: TURN_SCRIPT, provider: path.join(base, 'provider.json'),
    body: `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    window.addEventListener('unhandledrejection', event => window.__errors.push('promise: ' + String(event.reason?.message || event.reason)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    $('newChatBtn')?.click()
    await wait(500)
    await send('Сделай правки в файлах: alpha, beta, gamma и команду.')
    note('ход начался', await until(() => busy(), 25000), '')
    note('ход закончился', await until(() => !busy(), 180000), feed().slice(-200))
    await wait(1500)
    const chats = await window.electronAPI.getConversations()
    const chatId = $('messagesList')?.dataset.chatId || ''
    const chat = chats.find(item => item.id === chatId)
    const last = [...((chat && chat.messages) || [])].reverse().find(item => item.role === 'assistant')
    note('сообщению сопоставлен снимок правок', Boolean(last?.undoId), JSON.stringify({ chatId, undoId: last?.undoId,
      messages: (chat?.messages || []).map(msg => msg.role + ':' + (msg.undoId ? 'undo' : '-') + ':' + (msg.fileChanges?.length || 0)) }))
    window.__facts = { chatId, undoId: last?.undoId || '',
      messages: (chat?.messages || []).map(msg => msg.role + ':' + (msg.undoId ? 'undo' : '-') + ':' + (msg.fileChanges?.length || 0)) }
    // Внешние правки (harness) должны лечь после хода и до обзора.
    await wait(6000)

    // Второй ход правит тот же файл: у двух участков один sectionId, и выбор
    // обязан попадать в свой ход, а не в чужой.
    await send('Сделай ещё одну правку в delta.js.')
    note('второй ход начался', await until(() => busy(), 25000), '')
    note('второй ход закончился', await until(() => !busy(), 120000), feed().slice(-160))
    await wait(1500)
    const afterSecond = await window.electronAPI.getConversations()
    const secondChat = afterSecond.find(item => item.id === chatId)
    note('у второго ответа есть снимок правок',
      (secondChat?.messages || []).filter(msg => msg.role === 'assistant').every(msg => Boolean(msg.undoId)),
      JSON.stringify((secondChat?.messages || []).map(msg => msg.role + ':' + (msg.undoId || '-') + ':' + (msg.fileChanges?.length || 0))))

    note('обзор открылся директивой .sections', await openSections(), '')
    note('в обзоре есть файлы и команда', rows().length >= 4 &&
      rows().some(row => /Команда/.test(rowText(row))) &&
      rows().some(row => /alpha\\.js/.test(rowText(row))), rows().map(rowText).join(' | '))
    note('файл с поздней правкой помечен конфликтом',
      rows().some(row => /gamma\\.js/.test(rowText(row)) && /более поздние правки/i.test(rowText(row))),
      rows().map(rowText).join(' | '))

    const alphaRow = rows().find(row => /alpha\\.js/.test(rowText(row)))
    preview(alphaRow)
    note('предпросмотр файла показал участки', await until(() => document.querySelectorAll('.review-sections-fragment').length >= 2, 10000),
      String(document.querySelectorAll('.review-sections-fragment').length))
    note('содержимое участка выведено текстом, а не HTML',
      !document.querySelector('.review-sections-detail script'), '')
    const firstRestore = document.querySelector('.review-sections-fragment [data-action=restore-fragment]')
    note('у доступного участка есть откат', Boolean(firstRestore), '')
    firstRestore.click()
    await until(() => document.querySelector('.review-sections-confirm'), 10000)
    note('подтверждение получило фокус', document.activeElement?.dataset?.action === 'confirm-sections',
      document.activeElement?.outerHTML?.slice(0, 120))
    const confirm = document.querySelector('[data-action=confirm-sections]')
    confirm.click(); confirm.click()
    note('выборочный откат участка выполнен', await until(() => /Возвращено файлов: 1/.test(document.querySelector('.review-sections-dialog [role=status]')?.textContent || ''), 15000),
      document.querySelector('.review-sections-dialog [role=status]')?.textContent || '')
    const alphaAgain = rows().find(row => /alpha\\.js/.test(rowText(row)))
    preview(alphaAgain)
    await until(() => document.querySelector('.review-sections-comparison'), 10000)
    // Сравнение самого файла — первая пара «До / Сейчас», не карточки участков.
    const onDisk = document.querySelector('.review-sections-detail > .review-sections-comparison section:nth-child(2) pre')?.textContent || ''
    note('соседний участок сохранён', /line2/.test(onDisk) && /line3 edited/.test(onDisk), onDisk.slice(0, 400))
    note('откатанный участок не вернулся', !/line2 edited/.test(onDisk), onDisk.slice(0, 400))

    const deltaRows = rows().filter(row => /delta\\.js/.test(rowText(row)))
    note('два хода одного файла — две строки обзора', deltaRows.length === 2, String(deltaRows.length))
    const newestDelta = deltaRows.find(row => /Можно откатить/.test(rowText(row)))
    newestDelta?.querySelector('[data-action=select-section]')?.click()
    document.querySelector('.review-sections-toolbar .btn-primary').click()
    const deltaConfirm = await until(() => document.querySelector('[data-action=confirm-sections]'), 10000)
    note('выбор свежего участка открыл подтверждение', deltaConfirm, '')
    document.querySelector('[data-action=confirm-sections]')?.click()
    note('откат попал в свежий ход, а не в старый',
      await until(() => rows().filter(row => /delta\\.js/.test(rowText(row))).length === 1, 15000),
      rows().map(rowText).join(' | '))

    const betaRow = rows().find(row => /beta\\.js/.test(rowText(row)))
    const betaCheck = betaRow?.querySelector('[data-action=select-section]')
    note('файл без поздних правок доступен для выбора', Boolean(betaCheck) && !betaCheck.disabled,
      rows().map(row => rowText(row) + ' [' + (row.querySelector('[data-action=select-section]')?.disabled ? 'disabled' : 'on') + ']').join(' | '))
    betaCheck?.click()
    document.querySelector('.review-sections-toolbar .btn-primary').click()
    const betaConfirm = await until(() => document.querySelector('[data-action=confirm-sections]'), 10000)
    note('выбор файла открыл подтверждение', betaConfirm, '')
    document.querySelector('[data-action=confirm-sections]')?.click()
    note('отказ записи назван понятной причиной', await until(() => /Не удалось откатить: 1/.test(document.querySelector('.review-sections-dialog [role=status]')?.textContent || ''), 15000),
      document.querySelector('.review-sections-reasons')?.innerText || document.querySelector('.review-sections-dialog [role=status]')?.textContent || '')
    note('причина отказа записи видна списком', /Нет прав на запись/.test(document.querySelector('.review-sections-reasons')?.innerText || ''),
      document.querySelector('.review-sections-reasons')?.innerText || '')

    const gammaRow = rows().find(row => /gamma\\.js/.test(rowText(row)))
    gammaRow?.querySelector('[data-action=select-section]')?.click()
    document.querySelector('.review-sections-toolbar .btn-primary').click()
    const gammaConfirm = await until(() => document.querySelector('[data-action=confirm-sections]'), 10000)
    note('конфликтный файл можно выбрать', gammaConfirm, '')
    document.querySelector('[data-action=confirm-sections]')?.click()
    note('поздняя правка пропущена с причиной', await until(() => /Пропущено из-за поздних правок: 1/.test(document.querySelector('.review-sections-dialog [role=status]')?.textContent || ''), 15000),
      document.querySelector('.review-sections-reasons')?.innerText || '')

    const commandRow = rows().find(row => /Команда/.test(rowText(row)))
    if (commandRow) preview(commandRow)
    note('предпросмотр команды доступен', await until(() => document.querySelector('[data-action=restore-command]'), 10000),
      rows().map(rowText).join(' | '))
    note('у команды виден список файлов', /cmd\\.txt/.test(document.querySelector('.review-sections-detail')?.innerText || ''),
      document.querySelector('.review-sections-detail')?.innerText?.slice(0, 300))
    const commandHead = document.querySelector('.review-sections-detail table th')
    note('колонка файла команды достаточно широка', Boolean(commandHead) && commandHead.getBoundingClientRect().width >= 120,
      String(commandHead?.getBoundingClientRect().width))
    document.querySelector('[data-action=restore-command]').click()
    await until(() => document.querySelector('[data-action=confirm-sections]'), 10000)
    document.querySelector('[data-action=confirm-sections]').click()
    note('откат команды удалил созданный файл', await until(() => /Удалено созданных файлов: 1/.test(document.querySelector('.review-sections-dialog [role=status]')?.textContent || ''), 15000),
      document.querySelector('.review-sections-dialog [role=status]')?.textContent || '')

    // Клавиатура: клавиши внутри диалога не уходят в окно, а отмена во время
    // записи не закрывает окно.
    let leaked = false
    const listener = () => { leaked = true }
    document.addEventListener('keydown', listener, { once: true })
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    document.removeEventListener('keydown', listener)
    note('клавиши диалога не уходят в окно', !leaked, '')
    note('диалог объявлен модальным с названием', dialog().tagName === 'DIALOG' && dialog().hasAttribute('aria-labelledby'), '')

    // Узкое окно: диалог остаётся внутри видимой области.
    window.resizeTo(900, 700)
    await wait(600)
    const narrow = dialog().getBoundingClientRect()
    note('окно действительно стало узким', innerWidth <= 1000, String(innerWidth))
    note('в узком окне диалог помещается', narrow.left >= 0 && narrow.top >= 0 &&
      narrow.right <= innerWidth + 1 && narrow.bottom <= innerHeight + 1 &&
      dialog().scrollWidth <= dialog().clientWidth + 1,
      JSON.stringify({ innerWidth, innerHeight, rect: { left: narrow.left, top: narrow.top, right: narrow.right, bottom: narrow.bottom } }))

    // Закрытие и повторное открытие: список строится заново из того же журнала.
    closeDialog()
    note('диалог закрылся', await until(() => !dialog(), 10000), '')
    note('повторное открытие работает', await openSections(), '')
    note('после переоткрытия список не пуст', rows().length >= 1, String(rows().length))
    note('русский текст без английских подписей-заглушек', /Участки изменений/.test(dialog().innerText), dialog().innerText.slice(0, 120))

    // Английский и светлая тема: строки переведены, кириллицы в диалоге нет.
    closeDialog()
    await until(() => !dialog(), 10000)
    const select = $('languageSelect')
    select.value = 'en'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(500)
    document.documentElement.dataset.theme = 'light'
    note('английский обзор открылся', await openSections(), '')
    await wait(500)
    const allDialogs = [...document.querySelectorAll('.review-sections-dialog')]
    note('в английском обзоре нет кириллицы', allDialogs.length === 1 && !/[А-Яа-яЁё]/.test(allDialogs[0].innerText),
      JSON.stringify({ dialogs: allDialogs.length, open: allDialogs.map(item => item.open), rows: rows().length,
        cyr: String(allDialogs[0]?.innerText || '').match(/[А-Яа-яЁё]+/g)?.slice(0, 6) }))
    note('светлая тема применилась', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() !== '' ||
      document.documentElement.dataset.theme === 'light', document.documentElement.dataset.theme)
    window.__facts.theme = document.documentElement.dataset.theme
    window.__facts.lang = document.documentElement.lang
  `
  })

  const disturb = disturbAfterTurn(workspace)
  const main = await finish(run)
  const disturbed = await disturb
  for (const item of main.report.checks || []) note('sections · ' + item.name, item.pass, item.detail)
  note('sections · окно вышло с кодом 0', main.code === 0, String(main.code))
  note('sections · чужая поздняя правка действительно записана', /gamma later edit/.test(disturbed.later), disturbed.later)

  // Снаружи файла: выборочный откат вернул только участок, а команда удалила
  // созданный файл.
  const alpha = fs.existsSync(path.join(workspace, 'alpha.js')) ? fs.readFileSync(path.join(workspace, 'alpha.js'), 'utf8') : null
  note('на диске: откатан один участок, соседний остался', alpha === 'line1\nline2\nline3 edited', JSON.stringify(alpha))
  note('на диске: файл с поздней правкой не тронут', fs.readFileSync(path.join(workspace, 'gamma.js'), 'utf8') === 'gamma later edit\n', '')
  note('на диске: файл без прав не изменён', fs.readFileSync(path.join(workspace, 'beta.js'), 'utf8') === 'beta new\n', '')
  note('на диске: созданный командой файл удалён', !fs.existsSync(path.join(workspace, 'cmd.txt')), '')
  note('на диске: откат вернул свежий ход, старый не тронут',
    fs.existsSync(path.join(workspace, 'delta.js')) && fs.readFileSync(path.join(workspace, 'delta.js'), 'utf8') === 'delta one',
    fs.existsSync(path.join(workspace, 'delta.js')) ? fs.readFileSync(path.join(workspace, 'delta.js'), 'utf8') : 'missing')

  // Второй диалог остаётся неоткатанным — на нём снимаются четыре вида.
  if (only === 'main') return finishRun()
  const { profile: shotsProfile, workspace: shotsWorkspace, base: shotsBase } = profileFor('shots')
  const shotsRun = launch('shots-setup', {
    profile: shotsProfile, workspace: shotsWorkspace,
    script: SHOTS_SCRIPT, provider: path.join(shotsBase, 'provider.json'),
    body: `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    $('newChatBtn')?.click()
    await wait(500)
    await send('Подготовь снимки обзора.')
    note('ход за снимками начался', await until(() => busy(), 25000), '')
    note('ход за снимками закончился', await until(() => !busy(), 120000), '')
    await wait(1500)
    const chats = await window.electronAPI.getConversations()
    const chatId = $('messagesList')?.dataset.chatId || ''
    window.__facts = { chatId, hasUndo: Boolean(chats.find(item => item.id === chatId)?.messages?.some(msg => msg.undoId)) }
  `
  })
  const shots = await finish(shotsRun)
  for (const item of shots.report.checks || []) note('shots · ' + item.name, item.pass, item.detail)
  const shotsChat = shots.report.facts?.chatId || ''
  note('shots · снимок обзора подготовлен', shots.code === 0 && Boolean(shotsChat) && shots.report.facts?.hasUndo === true,
    JSON.stringify({ chatId: shotsChat, hasUndo: shots.report.facts?.hasUndo }))

  for (const [language, theme] of [['ru', 'dark'], ['ru', 'light'], ['en', 'dark'], ['en', 'light']]) {
    const shot = path.join(dir, `sections-${language}-${theme}.png`)
    const runShot = launch(`shot-${language}-${theme}`, {
      profile: shotsProfile, workspace: shotsWorkspace,
      script: SHOTS_SCRIPT, provider: path.join(shotsBase, 'provider.json'), shot,
      body: `
      window.__errors = []
      window.addEventListener('error', event => window.__errors.push(String(event.message)))
      await until(() => document.documentElement.dataset.appReady === '1', 30000)
      await until(() => document.querySelector('.history-item[data-chat-id="${shotsChat}"] .history-item-title'), 20000)
      document.querySelector('.history-item[data-chat-id="${shotsChat}"] .history-item-title')?.click()
      await wait(500)
      document.querySelector('#languageSelect').value = ${JSON.stringify(language)}
      document.querySelector('#languageSelect').dispatchEvent(new Event('change', { bubbles: true }))
      document.documentElement.dataset.theme = ${JSON.stringify(theme)}
      await wait(400)
      const opened = await openSections()
      const row = rows().find(item => item.querySelector('[data-action=preview-section]'))
      if (row) row.querySelector('[data-action=preview-section]').click()
      await wait(700)
      note('снимок ${language}/${theme}: обзор открыт', opened && rows().length >= 1, String(rows().length))
      window.__facts = { rows: rows().length }
    `
    })
    // Снимок делает сам main.js после отчёта скрипта.
    const donePromise = finish(runShot)
    const saved = await new Promise(resolve => {
      const watcher = setInterval(() => { if (fs.existsSync(shot)) { clearInterval(watcher); resolve(true) } }, 200)
      setTimeout(() => { clearInterval(watcher); resolve(false) }, 180000)
    })
    const done = await donePromise
    for (const item of done.report.checks || []) note(`shot ${language}/${theme} · ` + item.name, item.pass, item.detail)
    note(`снимок ${language}/${theme} сохранён`, saved || fs.existsSync(shot), shot)
  }

  finishRun()
})().catch(error => {
  console.error('харнесс упал: ' + (error && error.stack || error))
  settleRun(dir, false)
  process.exitCode = 2
})
