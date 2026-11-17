'use strict'

// Независимая сквозная проверка команды с ВКЛЮЧЁННЫМ бюджетом задачи.
//
// Сценарий: ведущий → распределение → два помощника → две части одного
// помощника → критика → доработка во втором круге → итог. Ответы даёт
// локальный сценарный провайдер, каждый запрос считается по журналу — это и
// есть фактические отправки, а не снимок сервиса.
//
// Отдельные прогоны: предел 1 и 2 запроса, неизвестный расход токенов,
// отказ записи контрольной точки и остановка человеком. Ни один запрос сверх
// предела не должен дойти до провайдера, а исчерпание обязано дать incomplete
// с объяснением, а не ложное «готово».
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const dir = runDir('onlyone-team-budget')

const MODEL = 'dots-studio/dots-3-note-preview:free'
const ASK = 'Работайте вместе: проверьте три части — Альфа, Бета и Гамма.'

const TEAM_SCRIPT = {
  keyed: [
    {
      match: 'координируешь команду из 3 участников',
      once: true,
      toolCalls: [{ name: 'assign_work', args: { assignments: [
        { agent: 2, title: 'Альфа', task: 'Проверь первую часть задачи.', readOnly: true },
        { agent: 3, title: 'Гамма', task: 'Проверь третью часть задачи.', readOnly: true }
      ] } }]
    },
    // Помощник закрывает свой пункт доски, как требует его же инструкция: иначе
    // приёмка честно считает работу незакрытой и ход не может быть готовым.
    { match: 'Твоя часть работы — «Альфа»', once: true,
      toolCalls: [{ name: 'board_update', args: { id: 't1', status: 'done', note: 'проверено' } }] },
    { match: 'Твоя часть работы — «Альфа»', once: true, text: 'ОТЧЁТ-АЛЬФА: первая часть проверена.' },
    { match: 'Твоя часть работы — «Гамма»', once: true,
      toolCalls: [{ name: 'board_update', args: { id: 't2', status: 'done', note: 'проверено' } }] },
    { match: 'Твоя часть работы — «Гамма»', once: true, text: 'ОТЧЁТ-ГАММА: третья часть проверена.' },
    { match: 'Ты Агент 2. Твоя часть работы уже сдана', once: true, text: 'ВОЗРАЖЕНИЕ: в части Гамма нет доказательства.' },
    { match: 'Ты Агент 3. Твоя часть работы уже сдана', once: true, text: 'ВОЗРАЖЕНИЙ НЕТ: проверил обе части.' },
    {
      match: 'Это второй круг',
      once: true,
      toolCalls: [{ name: 'assign_work', args: { assignments: [
        { agent: 2, title: 'Доработка', task: 'Учти замечание критики.', readOnly: true }
      ] } }]
    },
    { match: 'Твоя часть работы — «Доработка»', once: true,
      toolCalls: [{ name: 'board_update', args: { id: 't3', status: 'done', note: 'доработано' } }] },
    { match: 'Твоя часть работы — «Доработка»', once: true, text: 'ОТЧЁТ-ДОРАБОТКА: замечание учтено.' },
    { match: 'Лимит делегирования достигнут', once: true, text: 'ИТОГ-КОМАНДЫ: все части проверены, замечание учтено.' }
  ],
  turns: [{ text: '' }]
}

const STOP_SCRIPT = {
  turns: [{ delayMs: 5000, text: 'ЭТО-НЕ-ДОЛЖНО-СОХРАНИТЬСЯ как завершённый ответ.' }]
}

const PRELUDE = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 120000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(120) } return false }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail).slice(0, 600) })
  const busy = () => $('sendBtn')?.classList.contains('is-stop')
  const feed = () => $('messagesList').innerText.replace(/\\s+/g, ' ')
  const chats = () => window.electronAPI.getConversations()
  const lastAssistant = chat => [...((chat && chat.messages) || [])].reverse().find(item => item.role === 'assistant')
`

function profileFor (name, budgetSettings, { runsAsFile = false } = {}) {
  const base = path.join(dir, name)
  const profile = path.join(base, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  fs.mkdirSync(path.join(base, 'workspace'), { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: MODEL, enabled: true }],
    defaultModel: MODEL,
    legacyStoragePurged: true,
    budgetSettings,
    workspace: { path: path.join(base, 'workspace'), permission: 'acceptEdits' },
    agentTeam: { count: 3, models: [] }
  }))
  fs.writeFileSync(path.join(base, 'workspace', 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
  fs.writeFileSync(path.join(base, 'workspace', 'README.md'), '# Fixture\n')
  if (runsAsFile) {
    // Контрольная точка не может создать каталог: резерв обязан не дойти до провайдера.
    fs.writeFileSync(path.join(profile, 'runs'), 'not a directory')
  }
  return { base, profile }
}

async function phase (name, { budgetSettings, script = TEAM_SCRIPT, body, runsAsFile = false }) {
  const { base, profile } = profileFor(name, budgetSettings, { runsAsFile })
  const provider = path.join(base, 'provider.json')
  const log = path.join(base, 'requests.log')
  const dump = path.join(base, 'dump')
  fs.mkdirSync(dump, { recursive: true })
  fs.writeFileSync(provider, JSON.stringify(script))
  const smoke = path.join(base, 'smoke.js')
  const resultFile = path.join(base, 'result.json')
  fs.writeFileSync(smoke, `(async () => {${PRELUDE}${body}
    note('в окне нет ошибок', !window.__errors?.length, (window.__errors || []).join(' | '))
    return { ok: checks.every(item => item.pass), checks, facts: window.__facts || {} }
  })()`)
  // Контрольная точка хода читается с диска, пока ход идёт: потраченное и
  // резервы — не вывод из слов, а запись на диске.
  const budgetSeen = { seen: false, limits: null, maxHeld: 0, unknown: 0, history: [] }
  const runsDir = path.join(profile, 'runs')
  const watch = setInterval(() => {
    try {
      for (const file of fs.readdirSync(runsDir)) {
        if (!file.endsWith('.json')) continue
        const data = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8'))
        const budget = data?.task?.budget
        if (!budget || !budget.used) continue
        budgetSeen.seen = true
        budgetSeen.limits = budget.limits
        budgetSeen.maxHeld = Math.max(budgetSeen.maxHeld,
          Number(budget.used.requests || 0) + Number(budget.reserved?.requests || 0))
        budgetSeen.unknown = Math.max(budgetSeen.unknown, Number(budget.unknownUsage || 0))
        const history = Array.isArray(budget.history) ? budget.history.map(item => item.id) : []
        if (history.length > budgetSeen.history.length) budgetSeen.history = history
      }
    } catch { /* каталога ещё нет или он не каталог (отказ записи) */ }
  }, 20)
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: guiEnv({ ONECODE_SMOKE: smoke, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: provider, ONECODE_PROVIDER_LOG: log, ONECODE_PROVIDER_DUMP: dump })
  })
  let tail = ''
  child.stdout.on('data', data => { tail = (tail + data).slice(-3000) })
  child.stderr.on('data', data => { tail = (tail + data).slice(-3000) })
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; resolve('timeout') }, 240000)
    child.once('error', () => { clearTimeout(timer); resolve('error') })
    child.once('close', value => { clearTimeout(timer); resolve(value) })
  })
  clearInterval(watch)
  const report = fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    : { ok: false, checks: [], facts: {}, error: 'окно не отчиталось: ' + tail }
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
  const requests = fs.readdirSync(dump).filter(file => file.endsWith('.json')).sort().map(file => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dump, file), 'utf8'))
      return { path: data.path, stream: data.stream === true, messages: JSON.stringify(data.body?.messages || []) }
    } catch { return { path: '', stream: false, messages: '' } }
  })
  const count = marker => requests.filter(item => item.messages.includes(marker)).length
  return { code, report, calls, requests, count, budgetSeen }
}

const checks = []
const note = (name, pass, detail = '') => {
  checks.push({ name, pass: Boolean(pass), detail })
  console.log((pass ? '  ok     ' : '  ПРОВАЛ ') + name + (detail ? ' — ' + String(detail).slice(0, 400) : ''))
}

const TURN = (text = ASK) => `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    window.addEventListener('unhandledrejection', event => window.__errors.push('promise: ' + String(event.reason?.message || event.reason)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    const response = await window.electronAPI.sendMessage({
      model: ${JSON.stringify(MODEL)},
      requestId: ${JSON.stringify('turn-' + Math.random().toString(36).slice(2))},
      chatId: ${JSON.stringify('chat-' + Math.random().toString(36).slice(2))},
      messages: [{ role: 'user', content: ${JSON.stringify(text)} }],
      params: { useTools: true }
    })
    const stages = Array.isArray(response?.stages) ? response.stages : []
    const joined = stages.map(item => String(item.content || '')).join('\\n')
    window.__facts = { mode: response?.mode, ok: response?.ok, incomplete: response?.incomplete,
      content: String(response?.content || ''), stages: joined, raw: JSON.stringify(response || {}).slice(0, 1200) }
`

;(async () => {
  // Точечный прогон одной группы: ONECODE_TEAM_BUDGET_ONLY=enough,limit-one
  const only = String(process.env.ONECODE_TEAM_BUDGET_ONLY || '').split(',').filter(Boolean)
  const want = name => !only.length || only.includes(name)

  if (want('enough')) {
  // 1. Достаточный бюджет: весь многофазный сценарий, ни одного ложного дубля.
  const enough = await phase('enough', {
    budgetSettings: { requests: 40, tokens: null, deadlineMinutes: null },
    body: TURN() + `
    const facts = window.__facts
    note('командный ход завершён', facts.mode === 'agent' && /ИТОГ-КОМАНДЫ/.test(facts.content) &&
      !/Бюджет задачи|уже использован/i.test(facts.content), facts.raw)
    note('незавершённость (если есть) — не от бюджета', facts.incomplete !== true ||
      !/Бюджет задачи|неизвестным расходом|не записан на диск/i.test(facts.content), String(facts.incomplete))
    note('оба помощника сдали свои части', /ОТЧЁТ-АЛЬФА/.test(facts.stages) && /ОТЧЁТ-ГАММА/.test(facts.stages), facts.stages.slice(0, 300))
    note('доработка второго круга выполнена', /ОТЧЁТ-ДОРАБОТКА/.test(facts.stages), facts.stages.slice(-300))
    note('итог собран ведущим', /ИТОГ-КОМАНДЫ/.test(facts.content), facts.content.slice(0, 300))
    note('бюджет не назвал фазы дублями', !/уже использован|уже зарезервирован|уже учтён|duplicate/i.test(facts.content), facts.content.slice(0, 300))
    note('хода не коснулось исчерпание бюджета', !/Бюджет задачи/.test(facts.content + facts.stages), facts.content.slice(0, 300))
  ` })
  for (const item of enough.report.checks || []) note('enough · ' + item.name, item.pass, item.detail)
  note('enough · окно вышло с кодом 0', enough.code === 0, String(enough.code))
  note('enough · провайдер получил весь сценарий', enough.calls >= 9, 'запросов: ' + enough.calls)
  note('enough · каждая отправка попала в замер', enough.calls === enough.requests.length,
    JSON.stringify({ calls: enough.calls, dumps: enough.requests.length }))
  // Фазы одного помощника — часть, критика, доработка — идут своими запросами;
  // повтор шага (step--) не должен получить прежний id.
  note('enough · у фаз одного помощника свои запросы',
    enough.count('Твоя часть работы — «Альфа»') >= 1 && enough.count('Твоя часть работы — «Гамма»') >= 1 &&
      enough.count('Твоя часть работы — «Доработка»') >= 1,
    JSON.stringify({ alfa: enough.count('Твоя часть работы — «Альфа»'), gamma: enough.count('Твоя часть работы — «Гамма»'),
      rework: enough.count('Твоя часть работы — «Доработка»') }))
  note('enough · id фактических запросов не повторяются',
    enough.budgetSeen.history.length >= 10 && new Set(enough.budgetSeen.history).size === enough.budgetSeen.history.length,
    'записей: ' + enough.budgetSeen.history.length)
  note('enough · критика — отдельный запрос каждому проверяющему', enough.count('Твоя часть работы уже сдана') === 2,
    'критик: ' + enough.count('Твоя часть работы уже сдана'))
  note('enough · второй круг поручений состоялся', enough.count('Это второй круг') === 1,
    'кругов: ' + enough.count('Это второй круг'))
  note('enough · доработка второго круга — отдельный запрос', enough.count('Твоя часть работы — «Доработка»') >= 1,
    'доработок: ' + enough.count('Твоя часть работы — «Доработка»'))
  note('enough · итоговая приёмка — отдельный запрос', enough.count('Лимит делегирования достигнут') >= 1,
    'приёмок: ' + enough.count('Лимит делегирования достигнут'))
  note('enough · контрольная точка хранит именно этот бюджет', enough.budgetSeen.seen === true &&
    enough.budgetSeen.limits?.requests === 40, JSON.stringify(enough.budgetSeen))
  note('enough · потрачено не больше предела', enough.budgetSeen.maxHeld <= 40 && enough.budgetSeen.maxHeld > 0,
    JSON.stringify(enough.budgetSeen))
  if (process.env.ONECODE_TEAM_BUDGET_DEBUG) console.log('CONTENT=' + JSON.stringify(enough.report.facts?.content || ''))

  }

  if (want('limit-one')) {
  // 2. Предел 1: второй запрос не уходит, ход incomplete с объяснением.
  const one = await phase('limit-one', {
    budgetSettings: { requests: 1, tokens: null, deadlineMinutes: null },
    body: TURN() + `
    const facts = window.__facts
    note('предел 1: ход не выдан за готовый', facts.incomplete === true && facts.ok === false, facts.raw)
    note('предел 1: причина названа', /Бюджет задачи/.test(facts.content), facts.content.slice(0, 300))
  ` })
  for (const item of one.report.checks || []) note('limit-one · ' + item.name, item.pass, item.detail)
  note('limit-one · окно вышло с кодом 0', one.code === 0, String(one.code))
  note('limit-one · провайдер получил ровно один запрос', one.calls === 1, 'запросов: ' + one.calls)
  note('limit-one · контрольная точка не пропустила сверх предела', one.budgetSeen.maxHeld <= 1 &&
    one.budgetSeen.limits?.requests === 1, JSON.stringify(one.budgetSeen))

  }

  if (want('limit-two')) {
  // 3. Предел 2: ровно две отправки, дальше отказ.
  const two = await phase('limit-two', {
    budgetSettings: { requests: 2, tokens: null, deadlineMinutes: null },
    body: TURN() + `
    const facts = window.__facts
    note('предел 2: ход не выдан за готовый', facts.incomplete === true && facts.ok === false, facts.raw)
    note('предел 2: причина названа', /Бюджет задачи/.test(facts.content), facts.content.slice(0, 300))
  ` })
  for (const item of two.report.checks || []) note('limit-two · ' + item.name, item.pass, item.detail)
  note('limit-two · окно вышло с кодом 0', two.code === 0, String(two.code))
  note('limit-two · провайдер получил ровно два запроса', two.calls === 2, 'запросов: ' + two.calls)
  note('limit-two · контрольная точка не пропустила сверх предела', two.budgetSeen.maxHeld <= 2 &&
    two.budgetSeen.limits?.requests === 2, JSON.stringify(two.budgetSeen))

  }

  if (want('unknown')) {
  // 4. Неизвестный расход: ответ без usage закрывает продолжение, а не считается нулём.
  const unknown = await phase('unknown', {
    budgetSettings: { requests: 40, tokens: 200000, deadlineMinutes: null },
    body: TURN() + `
    const facts = window.__facts
    note('неизвестный расход: ход не выдан за готовый', facts.incomplete === true && facts.ok === false, facts.raw)
    note('неизвестный расход назван', /неизвестн/i.test(facts.content), facts.content.slice(0, 300))
  ` })
  for (const item of unknown.report.checks || []) note('unknown · ' + item.name, item.pass, item.detail)
  note('unknown · окно вышло с кодом 0', unknown.code === 0, String(unknown.code))
  note('unknown · после неизвестного расхода провайдер не звали', unknown.calls === 1, 'запросов: ' + unknown.calls)
  note('unknown · расход записан неизвестным, а не нулём', unknown.budgetSeen.unknown >= 1, JSON.stringify(unknown.budgetSeen))

  }

  if (want('not-durable')) {
  // 5. Контрольная точка не пишется: резерв не доходит до провайдера.
  const durable = await phase('not-durable', {
    budgetSettings: { requests: 40, tokens: null, deadlineMinutes: null },
    runsAsFile: true,
    body: TURN() + `
    const facts = window.__facts
    note('отказ записи: ход не выдан за готовый', facts.incomplete === true && facts.ok === false, facts.raw)
    note('отказ записи назван', /не записан на диск/i.test(facts.content), facts.content.slice(0, 300))
  ` })
  for (const item of durable.report.checks || []) note('not-durable · ' + item.name, item.pass, item.detail)
  note('not-durable · окно вышло с кодом 0', durable.code === 0, String(durable.code))
  note('not-durable · провайдер не получил ни одного запроса', durable.calls === 0, 'запросов: ' + durable.calls)
  note('not-durable · на диск ничего не легло', durable.budgetSeen.seen === false, JSON.stringify(durable.budgetSeen))

  }

  if (want('stop')) {
  // 6. Остановка человеком: обещанный текст не сохраняется как завершённый ответ.
  const stop = await phase('stop', {
    budgetSettings: { requests: 40, tokens: null, deadlineMinutes: null },
    script: STOP_SCRIPT,
    body: `
    window.__errors = []
    window.addEventListener('error', event => window.__errors.push(String(event.message)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    $('newChatBtn')?.click()
    await wait(500)
    const box = $('composerTextarea')
    box.value = 'Долгий ответ, который человек остановит.'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(150)
    $('composerForm').requestSubmit()
    const started = await until(() => busy(), 25000)
    note('ход начался', started, '')
    await wait(700)
    $('sendBtn').click()
    const stopped = await until(() => !busy(), 30000)
    await wait(1800)
    note('ход остановлен', stopped, feed().slice(-250))
    const list = await chats()
    const last = lastAssistant(list[0])
    note('остановка сохранена как отмена', last?.aborted === true || last?.turnAborted === true,
      JSON.stringify({ aborted: last?.aborted, turnAborted: last?.turnAborted }))
    note('обещанный текст не сохранён', !/ЭТО-НЕ-ДОЛЖНО-СОХРАНИТЬСЯ/.test(String(last?.content || '')),
      String(last?.content || '').slice(-200))
  `
  })
  for (const item of stop.report.checks || []) note('stop · ' + item.name, item.pass, item.detail)
  note('stop · окно вышло с кодом 0', stop.code === 0, String(stop.code))
  // Название диалога — отдельный запрос окна, оно не входит в бюджет задачи;
  // считаются только запросы самого хода.
  const stopTurns = stop.requests.filter(item => item.stream && item.path === '/chat/completions').length
  note('stop · провайдер получил один запрос хода', stopTurns === 1,
    JSON.stringify({ turns: stopTurns, all: stop.requests.map(item => item.path) }))
  note('stop · отмена не потратила больше одной попытки', stop.budgetSeen.maxHeld <= 1, JSON.stringify(stop.budgetSeen))

  }

  const failed = checks.filter(item => !item.pass)
  console.log('')
  if (failed.length) console.error(`ПРОВАЛ: ${failed.length} из ${checks.length}`)
  else console.log(`Команда с бюджетом: ${checks.length} проверок, провалов 0`)
  settleRun(dir, failed.length === 0)
  process.exitCode = failed.length ? 1 : 0
})().catch(error => {
  console.error('харнесс упал: ' + (error && error.stack || error))
  settleRun(dir, false)
  process.exitCode = 2
})
