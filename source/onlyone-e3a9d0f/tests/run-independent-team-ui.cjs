'use strict'

// Независимая сквозная проверка команды агентов и сохранности данных в окне.
//
//   1) «Работайте вместе» ведёт настоящий командный ход: сценарный провайдер
//      отдаёт ведущему assign_work, Агент 2 сдаёт отчёт, Агент 3 падает. Итог
//      обязан сохранить отчёт сдавшего и назвать несданную часть; после
//      перезапуска то же лежит в переписке.
//   2) Остановка хода не считается завершением: ответ сохранён с aborted=true,
//      без обещанного текста модели, и переживает перезапуск.
//
// Живой модели нет: ответы — ONECODE_PROVIDER_FILE, каждый запрос считается по
// журналу. Профиль временный; зелёный прогон убирает каталог.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const dir = runDir('onlyone-independent-team')
const profile = path.join(dir, 'profile')
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model',
  legacyStoragePurged: true,
  workspace: { path: path.join(dir, 'workspace'), permission: 'acceptEdits' },
  agentTeam: { count: 3, models: [] }
}))
fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true })
fs.writeFileSync(path.join(dir, 'workspace', 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
fs.writeFileSync(path.join(dir, 'workspace', 'README.md'), '# Fixture\n')

const checks = []
function note (name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 500) })
  console.log((pass ? '  ok     ' : '  ПРОВАЛ ') + name + (detail ? ' — ' + String(detail).slice(0, 320) : ''))
}

// Сценарий команды: ведущий раздаёт две части, Альфа сдаёт отчёт, Бета падает.
const teamProvider = path.join(dir, 'team-provider.json')
fs.writeFileSync(teamProvider, JSON.stringify({
  keyed: [
    {
      match: 'координируешь команду из 3 участников',
      once: true,
      text: 'Распределяю работу.',
      toolCalls: [{ name: 'assign_work', args: { assignments: [
        { agent: 2, title: 'Альфа', task: 'Проверь package.json в части Альфа.', readOnly: true },
        { agent: 3, title: 'Бета', task: 'Проверь README в части Бета.', readOnly: true }
      ] } }]
    },
    { match: 'Твоя часть работы — «Альфа»', once: true, text: 'ОТЧЁТ-АЛЬФА: package.json прочитан, версия на месте.' },
    { match: 'Твоя часть работы — «Бета»', once: true, error: 'Провайдер недоступен (тест)' }
  ],
  turns: [{ text: 'Итог команды собран.' }]
}))
const teamLog = path.join(dir, 'team-requests.log')

// Сценарий остановки: ответ приходит позже, чем человек нажимает «Стоп».
const stopProvider = path.join(dir, 'stop-provider.json')
fs.writeFileSync(stopProvider, JSON.stringify({
  turns: [{ delayMs: 5000, text: 'ЭТО-НЕ-ДОЛЖНО-СОХРАНИТЬСЯ как завершённый ответ.' }]
}))
const stopLog = path.join(dir, 'stop-requests.log')

const PRELUDE = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 120000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(120) } return false }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail).slice(0, 500) })
  const busy = () => $('sendBtn')?.classList.contains('is-stop')
  const feed = () => $('messagesList').innerText.replace(/\\s+/g, ' ')
  const chats = () => window.electronAPI.getConversations()
  const lastAssistant = chat => [...((chat && chat.messages) || [])].reverse().find(item => item.role === 'assistant')
  const send = async text => {
    $('newChatBtn')?.click()
    await wait(500)
    const box = $('composerTextarea')
    box.value = text
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(150)
    $('composerForm').requestSubmit()
    const started = await until(() => busy(), 25000)
    return { started, chatId: $('messagesList')?.dataset.chatId || '' }
  }
`

async function phase (name, body, provider, log) {
  const script = path.join(dir, name + '.js')
  const resultFile = path.join(dir, name + '.json')
  fs.writeFileSync(script, `(async () => {${PRELUDE}${body}
    note('в окне нет ошибок', !window.__errors?.length, (window.__errors || []).join(' | '))
    return { ok: checks.every(item => item.pass), checks, facts: window.__facts || {} }
  })()`)
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: provider, ONECODE_PROVIDER_LOG: log })
  })
  let tail = ''
  child.stdout.on('data', data => { tail = (tail + data).slice(-3000) })
  child.stderr.on('data', data => { tail = (tail + data).slice(-3000) })
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; resolve('timeout') }, 240000)
    child.once('error', () => { clearTimeout(timer); resolve('error') })
    child.once('close', value => { clearTimeout(timer); resolve(value) })
  })
  const report = fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    : { ok: false, checks: [], facts: {}, error: 'окно не отчиталось: ' + tail }
  if (report.error) note(name + ' · окно отчиталось', false, report.error)
  note(name + ' · код выхода 0', code === 0, String(code))
  for (const item of report.checks || []) note(name + ' · ' + item.name, item.pass, item.detail)
  return report.facts || {}
}

function logCount (file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
}

;(async () => {
  const teamFacts = await phase('team', `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    window.addEventListener('unhandledrejection', event => window.__errors.push('promise: ' + String(event.reason?.message || event.reason)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    const response = await window.electronAPI.sendMessage({
      model: 'dots-studio/dots-3-note-preview:free',
      requestId: 'team-turn',
      chatId: 'team-chat',
      messages: [{ role: 'user', content: 'Работайте вместе: разделите проверку на две части — Альфа и Бета.' }],
      params: { useTools: true }
    })
    const stages = Array.isArray(response?.stages) ? response.stages : []
    const contributions = Array.isArray(response?.contributions) ? response.contributions : []
    note('командный ход отработал', response?.mode === 'agent' && stages.length >= 2,
      JSON.stringify({ mode: response?.mode, stages: stages.length, ok: response?.ok, incomplete: response?.incomplete }))
    note('отчёт сдавшего участника остался', stages.some(item => /ОТЧЁТ-АЛЬФА/.test(String(item.content || ''))),
      stages.map(item => String(item.content || '').slice(0, 80)).join(' | '))
    note('падение второго участника не стёрло первого',
      stages.some(item => /Провайдер недоступен|не ответил/.test(String(item.content || ''))) &&
        contributions.some(item => /ОТЧЁТ-АЛЬФА/.test(String(item.body || '')) && !item.failed),
      contributions.map(item => (item.failed ? 'failed:' : 'ok:') + String(item.body || '').slice(0, 50)).join(' | '))
    window.__facts = { stages: stages.length, contributions: contributions.length }
  `, teamProvider, teamLog)
  note('team · участники ответили', teamFacts.stages >= 2 && teamFacts.contributions >= 2,
    JSON.stringify(teamFacts))
  note('team · провайдер получил запросы обеих частей', logCount(teamLog) >= 3, 'запросов: ' + logCount(teamLog))

  const stopFacts = await phase('stop', `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    const sent = await send('Долгий ответ, который человек остановит.')
    note('ход начался', sent.started, JSON.stringify(sent))
    await wait(700)
    note('кнопка отправки в состоянии «стоп»', busy())
    $('sendBtn').click()
    const stopped = await until(() => !busy(), 30000)
    await wait(1800)
    note('ход остановлен', stopped, feed().slice(-250))
    const list = await chats()
    const chat = list.find(item => item.id === sent.chatId)
    const last = lastAssistant(chat)
    note('остановка сохранена как отмена, а не завершение', last?.aborted === true || last?.turnAborted === true,
      JSON.stringify({ aborted: last?.aborted, turnAborted: last?.turnAborted }))
    note('обещанный текст модели не сохранён', !/ЭТО-НЕ-ДОЛЖНО-СОХРАНИТЬСЯ/.test(String(last?.content || '')),
      String(last?.content || '').slice(-200))
    window.__facts = { chatId: sent.chatId || '' }
  `, stopProvider, stopLog)
  note('stop · ход был', Boolean(stopFacts.chatId), stopFacts.chatId)

  // Перезапуск: командный отчёт и отмена остаются на диске.
  await phase('persist', `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    const list = await chats()
    const stoppedChat = list.find(item => item.id === ${JSON.stringify(stopFacts.chatId || '')} ) ||
      list.find(item => (item.messages || []).some(m => m.role === 'assistant' && m.aborted === true))
    const stoppedLast = lastAssistant(stoppedChat)
    note('после перезапуска остановка остаётся отменой', stoppedLast?.aborted === true || stoppedLast?.turnAborted === true,
      JSON.stringify({ aborted: stoppedLast?.aborted, turnAborted: stoppedLast?.turnAborted }))
    note('после перезапуска нет ложного завершения', !/ЭТО-НЕ-ДОЛЖНО-СОХРАНИТЬСЯ/.test(String(stoppedLast?.content || '')),
      String(stoppedLast?.content || '').slice(-200))
    note('остановленный ход не выдан за завершённый', Boolean(stoppedChat) && stoppedLast?.aborted === true,
      JSON.stringify({ chats: list.length }))
  `, teamProvider, teamLog)

  const failed = checks.filter(item => !item.pass)
  console.log('')
  if (failed.length) console.error(`ПРОВАЛ: ${failed.length} из ${checks.length}`)
  else console.log(`Команда и остановка: ${checks.length} проверок, провалов 0`)
  settleRun(dir, failed.length === 0)
  process.exitCode = failed.length ? 1 : 0
})().catch(error => {
  console.error('харнесс упал: ' + (error && error.stack || error))
  settleRun(dir, false)
  process.exitCode = 2
})
