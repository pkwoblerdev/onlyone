// Сохранность работы при закрытии и повторном запуске — настоящим окном.
//
// Сценарий проверяет то, чего не видно в адресных тестах хранилища:
//   A. завершённое изменение файла → закрытие → повторный запуск: файл и ответ
//      на месте, карточки «Работа прервалась» нет;
//   B. отмена человеком: остановленный ход хранится как прерванный, карточки
//      после перезапуска нет, второго (как будто завершённого) ответа нет;
//   C. продолжение по снятой записи (повторное «Продолжить») и по повреждённой
//      записи: это ошибка восстановления с видимой причиной, а не новая задача;
//      сценарий провайдера при этом не вызывается ни разу.
//
// Сеть подменена файлом-сценарием (`ONECODE_PROVIDER_FILE`), ключ фиктивный.
// Профиль и рабочая папка — временные; живые вызовы моделей не делаются.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const history = require('./history-store.cjs')
const { createCheckpointStore } = require('../src/main/run-checkpoints')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-run-recovery')
const report = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })

const COMPLETED_ASK = 'Измени файл done-change.txt и закончи.'
const CANCEL_ASK = 'Долгая задача, которую я остановлю.'
const FILE_TEXT = 'ГОТОВО-1'

function providerFile(name, turns) {
  const file = path.join(out, `provider-${name}.json`)
  fs.writeFileSync(file, JSON.stringify({ turns }))
  return file
}
const completedProvider = providerFile('completed', [
  { toolCalls: [{ name: 'write_file', args: { path: 'done-change.txt', content: FILE_TEXT } }], text: 'Записываю файл.' },
  { text: 'Файл записан и проверен.' }
])
const cancelProvider = providerFile('cancel', [
  { text: 'Не должно выполниться.', delayMs: 3000 }
])

function makeProfile(tag) {
  const profile = path.join(out, 'profile-' + tag)
  const workspace = path.join(out, 'workspace-' + tag)
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model', legacyStoragePurged: true,
    workspace: { path: workspace, permission: 'acceptEdits' }
  }))
  return { profile, workspace }
}

const PRELUDE = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 60000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(100) }
    return false
  }
  const checks = []
  const note = (label, pass, detail) => checks.push({ label, pass: Boolean(pass),
    detail: detail === undefined ? '' : String(detail) })
  const feed = () => $('messagesList').innerText.replace(/\\s+/g, ' ')
  const busy = () => Boolean($('sendBtn') && $('sendBtn').classList.contains('is-stop'))
  const send = async text => {
    $('newChatBtn')?.click()
    await wait(350)
    const box = $('composerTextarea')
    box.value = text
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(120)
    $('composerForm').requestSubmit()
  }
  const openChat = async id => {
    const row = document.querySelector('.history-item[data-chat-id="' + id + '"] .history-item-title')
    if (row) row.click()
    await wait(400)
    return Boolean(row)
  }
  const ready = await until(() => document.documentElement.dataset.appReady === '1')
  note('окно завершило инициализацию', ready)
`

function launch(name, body, { profile, provider, timeout = 150000 } = {}) {
  const script = path.join(out, name + '.js')
  const result = path.join(out, name + '.json')
  fs.writeFileSync(script, `(async () => {${PRELUDE}${body}})()`)
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: provider,
      ONECODE_PROVIDER_LOG: path.join(out, `requests-${name}.log`)
    })
  })
  if (!fs.existsSync(result)) {
    return { ok: false, checks: [{ label: 'окно не отчиталось', pass: false,
      detail: `код выхода ${child.status}` }] }
  }
  return JSON.parse(fs.readFileSync(result, 'utf8'))
}

function collect(group, result) {
  const list = result?.checks || []
  if (!list.length) list.push({ label: 'прогон не состоялся', pass: false, detail: '' })
  for (const check of list) line(group, check.label, check.pass, check.detail)
}

// Профиль A: завершённое изменение файла и повторный запуск, затем продолжение
// по снятой записи (повторное «Продолжить») и повреждённая запись.
async function completedScenario() {
  const { profile, workspace } = makeProfile('completed')
  const runsDir = path.join(profile, 'runs')

  const first = launch('completed-1', `
    await send(${JSON.stringify(COMPLETED_ASK)})
    const started = await until(() => busy(), 20000)
    const said = await until(() => /Файл записан и проверен/.test(feed()), 60000)
    const idle = await until(() => !busy(), 20000)
    note('ход дошёл до конца', started && said && idle, JSON.stringify({ started, said, idle }))
    const chatId = document.querySelector('.history-item.active')?.dataset.chatId || ''
    note('у чата есть идентификатор', Boolean(chatId), chatId)
    // История пишется с паузой; без запаса второй запуск не нашёл бы чат.
    await wait(1800)
    return { ok: checks.every(item => item.pass), checks, chatId }
  `, { profile, provider: completedProvider })
  collect('A завершённое изменение', first)
  const chatId = first.chatId
  const changed = path.join(workspace, 'done-change.txt')
  line('A завершённое изменение', 'изменение файла осталось на диске',
    fs.existsSync(changed) && fs.readFileSync(changed, 'utf8') === FILE_TEXT,
    fs.existsSync(changed) ? fs.readFileSync(changed, 'utf8').slice(0, 60) : 'файла нет')
  const runsLeft = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(n => n.endsWith('.json')) : []
  line('A завершённое изменение', 'завершённый ход не оставил контрольной точки', runsLeft.length === 0,
    runsLeft.join(', '))
  line('A завершённое изменение', 'переписка легла на диск', history.historyBytes(profile) > 900,
    history.historyPresent(profile) ? history.historyLayout(profile) + ', ' + history.historyBytes(profile) + ' Б' : 'набора истории нет')

  if (!chatId) return
  const second = launch('completed-2', `
    const opened = await openChat(${JSON.stringify(chatId)})
    await wait(2500)
    note('чат пережил перезапуск', opened)
    note('карточки «Работа прервалась» нет',
      !document.querySelector('#messagesList .approval-card.kind-resume'))
    note('сохранённый ответ на месте', /Файл записан и проверен/.test(feed()), feed().slice(-160))
    const list = await window.electronAPI.getConversations()
    const chat = (list || []).find(item => item.id === ${JSON.stringify(chatId)})
    note('в хранилище и вопрос, и ответ', (chat?.messages || []).length >= 2,
      String((chat?.messages || []).length))
    return { ok: checks.every(item => item.pass), checks }
  `, { profile, provider: completedProvider })
  collect('A повторный запуск', second)

  // Контрольная точка посреди команды: карточка должна появиться, а повторное
  // «Продолжить» по уже снятой записи — отказать, не выполняя сценарий заново.
  const resumedId = 'aaaa0000-0000-0000-0000-0000000000aa'
  const store = createCheckpointStore({ dir: runsDir })
  const seeded = store.start({ runId: resumedId, chatId, ask: COMPLETED_ASK })
  seeded.begin('write_file', { path: 'done-change.txt' }).end('done')
  seeded.begin('run_command', { command: 'npm test' })

  const third = launch('completed-3', `
    await openChat(${JSON.stringify(chatId)})
    const card = () => document.querySelector('#messagesList .approval-card.kind-resume')
    note('карточка прерванного хода показана', await until(card, 15000),
      (card()?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160))
    const before = document.querySelectorAll('#messagesList .msg-item.assistant').length
    card()?.querySelector('.approval-allow')?.click()
    note('продолжение началось', await until(() => busy() ||
      document.querySelectorAll('#messagesList .msg-item.assistant').length > before, 15000))
    note('продолжение дошло до конца', await until(() => !busy(), 60000))
    let duplicate = ''
    try {
      await window.electronAPI.sendMessage({
        requestId: 'dup-resume', chatId: ${JSON.stringify(chatId)}, model: 'test/model',
        messages: [{ role: 'user', content: 'Продолжи прерванную работу.' }],
        resumeRunId: ${JSON.stringify(resumedId)}, params: { useTools: true }
      })
      duplicate = 'принято как новая задача'
    } catch (error) {
      duplicate = String(error && error.message || error)
    }
    note('повторное «Продолжить» названо ошибкой восстановления',
      /Прерванный ход не найден/.test(duplicate), duplicate.slice(0, 200))
    return { ok: checks.every(item => item.pass), checks }
  `, { profile, provider: completedProvider })
  collect('C повторное продолжение', third)
  const afterResume = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(n => n.endsWith('.json')) : []
  line('C повторное продолжение', 'после двух продолжений файлов хода не осталось', afterResume.length === 0,
    afterResume.join(', '))

  const corruptId = 'bad00000-0000-0000-0000-0000000000bb'
  fs.mkdirSync(runsDir, { recursive: true })
  fs.writeFileSync(path.join(runsDir, corruptId + '.json'), '{"schemaVersion":1,"runId":"' + corruptId + '"')
  const fourth = launch('corrupt-resume', `
    await openChat(${JSON.stringify(chatId)})
    await wait(1500)
    note('повреждённая запись не рисует карточку',
      !document.querySelector('#messagesList .approval-card.kind-resume'))
    let refusal = ''
    try {
      await window.electronAPI.sendMessage({
        requestId: 'corrupt-resume', chatId: ${JSON.stringify(chatId)}, model: 'test/model',
        messages: [{ role: 'user', content: 'Продолжи прерванную работу.' }],
        resumeRunId: ${JSON.stringify(corruptId)}, params: { useTools: true }
      })
      refusal = 'принято как новая задача'
    } catch (error) {
      refusal = String(error && error.message || error)
    }
    note('продолжение по повреждённой записи названо ошибкой',
      /Прерванный ход не найден/.test(refusal), refusal.slice(0, 200))
    return { ok: checks.every(item => item.pass), checks }
  `, { profile, provider: completedProvider })
  collect('C повреждённая запись', fourth)
  const corruptFiles = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []
  line('C повреждённая запись', 'повреждённый файл не затёрт и нового хода нет',
    corruptFiles.length === 1 && corruptFiles[0] === corruptId + '.json', corruptFiles.join(', '))
  const corruptLog = path.join(out, 'requests-corrupt-resume.log')
  line('C повреждённая запись', 'сценарий провайдера не вызывался ни разу',
    !fs.existsSync(corruptLog) || fs.statSync(corruptLog).size === 0)
}

// Профиль B: отмена человеком. Ход помечен прерванным, контрольной точки нет,
// после перезапуска карточки нет и второго ответа тоже.
async function cancelScenario() {
  const { profile } = makeProfile('cancel')
  const runsDir = path.join(profile, 'runs')
  const first = launch('cancel-1', `
    await send(${JSON.stringify(CANCEL_ASK)})
    const started = await until(() => busy(), 20000)
    await wait(900)
    $('sendBtn')?.click()
    const idle = await until(() => !busy(), 30000)
    await wait(1200)
    note('ход был запущен и остановлен', started && idle, JSON.stringify({ started, idle }))
    note('второй ответ не появился', !/Не должно выполниться/.test(feed()), feed().slice(-160))
    const chatId = document.querySelector('.history-item.active')?.dataset.chatId || ''
    const list = await window.electronAPI.getConversations()
    const chat = (list || []).find(item => item.id === chatId)
    const last = (chat?.messages || []).filter(item => item.role === 'assistant').pop()
    note('отменённый ответ сохранён как прерванный', Boolean(last && last.aborted),
      JSON.stringify(last ? { aborted: last.aborted, turnAborted: last.turnAborted } : null))
    await wait(1500)
    return { ok: checks.every(item => item.pass), checks, chatId }
  `, { profile, provider: cancelProvider })
  collect('B отмена человеком', first)
  const runsLeft = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(n => n.endsWith('.json')) : []
  line('B отмена человеком', 'отменённый ход не оставил контрольной точки', runsLeft.length === 0,
    runsLeft.join(', '))
  if (!first.chatId) return
  const second = launch('cancel-2', `
    const opened = await openChat(${JSON.stringify(first.chatId)})
    await wait(2500)
    note('чат пережил перезапуск', opened)
    note('карточки продолжения нет', !document.querySelector('#messagesList .approval-card.kind-resume'))
    note('причина остановки видна в ленте', /Остановлено|остановлен|прервано/i.test(feed()), feed().slice(-180))
    const list = await window.electronAPI.getConversations()
    const chat = (list || []).find(item => item.id === ${JSON.stringify(first.chatId)})
    const last = (chat?.messages || []).filter(item => item.role === 'assistant').pop()
    note('после перезапуска ход всё ещё прерванный, а не завершённый',
      Boolean(last && last.aborted), JSON.stringify(last ? { aborted: last.aborted } : null))
    return { ok: checks.every(item => item.pass), checks }
  `, { profile, provider: cancelProvider })
  collect('B повторный запуск', second)
}

;(async () => {
  await completedScenario()
  await cancelScenario()
  const failed = report.filter(item => !item.pass)
  for (const item of report) console.log(`${item.pass ? '  ok ' : 'ПРОВАЛ'} [${item.group}] ${item.name}${item.detail ? ' — ' + item.detail : ''}`)
  console.log(`сохранность при закрытии и перезапуске — проверок ${report.length}, не прошло ${failed.length}`)
  settleRun(out, failed.length === 0)
  process.exit(failed.length ? 1 : 0)
})().catch(error => { console.error(error); settleRun(out, false); process.exit(1) })
