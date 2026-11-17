'use strict'

// Независимая сквозная проверка бюджета задачи (АГ-8): настоящий главный
// процесс, настоящий цикл агента и сценарный провайдер. Ни одной живой модели,
// ни одного ключа: ответы берутся из ONECODE_PROVIDER_FILE, каждый запрос
// складывается в ONECODE_PROVIDER_DUMP, а контрольная точка читается с диска
// ровно в тот момент, когда ход ещё идёт.
//
// Что измеряется:
//   1) set-budget-settings ставит requests=1; ходу нужно два запроса, второй до
//      провайдера НЕ доходит; причина видна в ленте; ход записан незавершённым;
//      в контрольной точке требования не подтверждены;
//   2) после падения посреди хода (активный расход, usage отсутствует) продолжение
//      не получает новый бюджет: настройки requests=50 не помогают, провайдер не
//      вызывается ни разу; неизвестный расход не считается нулём;
//   3) на диске резерв обязателен (not_durable), отмена до/после отправки и
//      повреждённый снимок отклоняются, а не обнуляются.
//
// Проверки 3-й группы — без окна, на настоящих модулях. Путь к src/main можно
// подменить копией для отрицательного контроля:
//   ONECODE_INDEPENDENT_MAIN=<папка-копия src/main>
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const mainSrc = process.env.ONECODE_INDEPENDENT_MAIN || path.join(root, 'src', 'main')
const { createCheckpointStore, continuationPrompt } = require(path.join(mainSrc, 'run-checkpoints.js'))
const { createBudgetRuntime } = require(path.join(mainSrc, 'budget-runtime.cjs'))
const { resolveBudget } = require(path.join(mainSrc, 'budget-settings.cjs'))
const { cleanBudgetState } = require(path.join(mainSrc, 'task-budget.cjs'))

const out = runDir('onlyone-independent-budget')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
function note (name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 500) })
  console.log((pass ? '  ok     ' : '  ПРОВАЛ ') + name + (detail ? ' — ' + String(detail).slice(0, 300) : ''))
}
async function test (name, fn) {
  try {
    await fn()
    note(name, true)
  } catch (error) {
    note(name, false, error && error.message || error)
  }
}

const RUN_A = 'aaaa0000-0000-0000-0000-0000000000a1'
const RUN_B = 'bbbb0000-0000-0000-0000-0000000000b1'
const RUN_C = 'cccc0000-0000-0000-0000-0000000000c1'
const RES_1 = `${RUN_A}:0:0:0`
const RES_2 = `${RUN_A}:0:0:1`
const RES_3 = `${RUN_B}:0:0:0`
const RES_4 = `${RUN_B}:0:0:1`

// ─── Часть 1. Без окна: резерв, восстановление, not_durable, отмена ──────────
async function pureChecks () {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-independent-budget-pure-'))
  const dir = path.join(base, 'runs')
  fs.mkdirSync(dir, { recursive: true })
  const limits = { requests: 3, tokens: 1000 }

  await test('резерв пишется на диск до запроса; активный резерв восстанавливается как неизвестный расход', async () => {
    const store = createCheckpointStore({ dir, now: () => 1000 })
    const run = store.start({ runId: RUN_A, chatId: 'chat-a', ask: 'Сделай отчёт', budgetLimits: limits, budgetDeadlineAt: null })
    const first = run.reserveBudget({ id: RES_1, requests: 1, tokens: 100 })
    assert.equal(first.ok, true)
    assert.equal(first.durable, true, 'первый резерв не дошёл до диска')
    assert.deepEqual(run.budget().reserved, { requests: 1, tokens: 100 })
    const settled = run.settleBudget({ id: RES_1, usage: { total_tokens: 100 } })
    assert.equal(settled.ok, true)
    const second = run.reserveBudget({ id: RES_2, requests: 1, tokens: 100 })
    assert.equal(second.ok, true)
    assert.equal(second.durable, true)

    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${RUN_A}.json`), 'utf8'))
    assert.equal(raw.task.budget.used.requests, 1)
    assert.deepEqual(raw.task.budget.reserved, { requests: 1, tokens: 100 })

    // Процесс «умирает» здесь: run.close() не зовём.
    const recovered = store.interrupted().find(item => item.runId === RUN_A)
    assert.ok(recovered, 'прерванный ход не найден')
    assert.equal(recovered.task.budget.used.requests, 2, 'активный резерв не стал потраченным запросом')
    assert.equal(recovered.task.budget.unknownUsage, 1, 'неизвестный расход потерян')
    assert.equal(recovered.task.budget.reservations.length, 0)
    assert.ok(recovered.task.budget.history.some(item => item.id === RES_2 && item.tokensUnknown === true))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('продолжение берёт сохранённые пределы, а не новые настройки; остаток не обнуляется', async () => {
    const store = createCheckpointStore({ dir, now: () => 2000 })
    const run = store.start({ runId: RUN_A, chatId: 'chat-a', ask: 'Сделай отчёт', budgetLimits: limits, budgetDeadlineAt: null })
    run.reserveBudget({ id: RES_1, tokens: 100 })
    run.settleBudget({ id: RES_1, usage: { total_tokens: 100 } })
    run.reserveBudget({ id: RES_2, tokens: 100 })
    const recovered = store.interrupted().find(item => item.runId === RUN_A)
    const plan = resolveBudget({
      saved: recovered.task.budget,
      settings: { requests: 50, tokens: 5000, deadlineMinutes: 60 },
      now: 3000
    })
    assert.equal(plan.source, 'continuation')
    assert.equal(plan.appliesToCurrent, false)
    assert.deepEqual(plan.limits, limits, 'продолжение получило новые пределы')
    assert.equal(plan.deadlineAt, null, 'продолжение получило новый срок')
    assert.equal(plan.next.limits.requests, 50, 'следующая новая задача не получила настройки')

    const resumed = store.start({ runId: RUN_B, chatId: 'chat-a', ask: 'Продолжай', carriedTask: recovered.task,
      budgetLimits: plan.limits, budgetDeadlineAt: plan.deadlineAt })
    const snapshot = resumed.budget()
    assert.equal(snapshot.used.requests, 2, 'счётчик продолжения обнулён')
    assert.equal(snapshot.unknownUsage, 1)
    assert.equal(snapshot.remaining.requests, 1)

    const blocked = resumed.reserveBudget({ id: RES_3, tokens: 100 })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.dimension, 'unknown', 'неизвестный расход не заблокировал обычное продолжение')
    const allowed = resumed.reserveBudget({ id: RES_4, tokens: 100, allowUnknown: true })
    assert.equal(allowed.ok, true)
    assert.equal(resumed.budget().overrides, 1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('повреждённый и противоречивый снимок отклоняется, а не обнуляется', async () => {
    const store = createCheckpointStore({ dir, now: () => 4000 })
    const run = store.start({ runId: RUN_A, chatId: 'chat-a', ask: 'Отчёт', budgetLimits: limits, budgetDeadlineAt: null })
    run.reserveBudget({ id: RES_1, tokens: 100 })
    run.settleBudget({ id: RES_1, usage: { total_tokens: 100 } })
    run.reserveBudget({ id: RES_2, tokens: 100 })
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${RUN_A}.json`), 'utf8'))
    const rejected = (label, value) => {
      assert.equal(cleanBudgetState(value), null, label + ' принят как целый')
    }
    rejected('счётчик запросов ниже журнала', { ...raw.task.budget, used: { ...raw.task.budget.used, requests: 0 } })
    rejected('неверный остаток', { ...raw.task.budget, remaining: { requests: 999, tokens: raw.task.budget.remaining.tokens } })
    rejected('неверная сумма резервов', { ...raw.task.budget, reserved: { requests: 1, tokens: 0 } })
    rejected('неизвестный расход больше потраченных запросов', { ...raw.task.budget, unknownUsage: raw.task.budget.used.requests + 1 })
    rejected('старая версия схемы', { ...raw.task.budget, schemaVersion: 1 })

    // Испорченный бюджет в файле хода: карточка обязана сказать «повреждён», а
    // новый ход — отказаться начинать с нуля.
    const brokenId = RUN_C
    const broken = JSON.parse(JSON.stringify(raw))
    broken.runId = brokenId
    broken.task.budget.used.requests = 0
    fs.writeFileSync(path.join(dir, `${brokenId}.json`), JSON.stringify(broken))
    const recovered = store.interrupted().find(item => item.runId === brokenId)
    assert.ok(recovered, 'испорченный ход не прочитан')
    assert.equal(recovered.task.budget, null)
    assert.equal(recovered.task.budgetCorrupt, true, 'метка повреждения потеряна')
    assert.match(continuationPrompt(recovered), /повреждено/)
    let refused = false
    try {
      store.start({ runId: 'dddd0000-0000-0000-0000-0000000000d1', carriedTask: recovered.task,
        budgetLimits: limits, budgetDeadlineAt: null })
    } catch (error) {
      refused = /Повреждённое состояние бюджета/.test(String(error.message))
    }
    assert.equal(refused, true, 'повреждённый бюджет молча стал новым')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('not_durable: без записи резерва провайдер не вызывается, расход не появляется', async () => {
    const notDir = path.join(out, 'not-a-directory')
    fs.writeFileSync(notDir, 'file, not a directory')
    const store = createCheckpointStore({ dir: notDir })
    const run = store.start({ runId: RUN_C, chatId: 'chat-c', ask: 'Отчёт', budgetLimits: limits, budgetDeadlineAt: null })
    assert.equal(run.saved(), false)
    const runtime = createBudgetRuntime({ checkpoint: run, runId: RUN_C })
    let called = 0
    const result = await runtime.run({ step: 0, tokens: 100 }, async () => {
      called++
      return { usage: { total_tokens: 10 } }
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_durable')
    assert.equal(result.called, false)
    assert.equal(called, 0, 'провайдер вызван без записанного резерва')
    const snapshot = run.budget()
    assert.equal(snapshot.used.requests, 0)
    assert.equal(snapshot.reservations.length, 0)
    assert.equal(snapshot.reserved.requests, 0)
  })

  await test('отмена до и после отправки; usage отсутствует — это не ноль', async () => {
    fs.mkdirSync(dir, { recursive: true })
    const store = createCheckpointStore({ dir, now: () => 5000 })
    const run = store.start({ runId: RUN_C, chatId: 'chat-c', ask: 'Отчёт',
      budgetLimits: { requests: 10, tokens: 10000 }, budgetDeadlineAt: null })
    const runtime = createBudgetRuntime({ checkpoint: run, runId: RUN_C })
    let called = 0

    const pre = new AbortController()
    pre.abort()
    const before = await runtime.run({ step: 0, tokens: 100, signal: pre.signal }, async () => { called++; return {} })
    assert.equal(before.called, false)
    assert.equal(before.reason, 'aborted')
    assert.equal(called, 0, 'провайдер вызван после отмены до резерва')
    assert.equal(run.budget().used.requests, 0)

    const unsent = await runtime.run({ step: 1, tokens: 100, unsentOnError: true }, async () => {
      called++
      throw new Error('сеть недоступна')
    })
    assert.equal(unsent.released.ok, true, 'неотправленный запрос не освободил резерв')
    assert.equal(run.budget().used.requests, 0)

    const cancelled = await runtime.run({ step: 2, tokens: 100 }, async () => {
      called++
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    assert.equal(cancelled.ok, false)
    assert.equal(cancelled.called, true)
    const afterCancel = run.budget()
    assert.equal(afterCancel.used.requests, 1, 'отменённый после отправки запрос не списан')
    assert.equal(afterCancel.unknownUsage, 1, 'отсутствующий usage превращён в ноль')

    const one = await runtime.run({ step: 3, tokens: 100, eventId: 'event-1', allowUnknown: true }, async () => ({ usage: { total_tokens: 10 } }))
    assert.equal(one.ok, true)
    const twice = await runtime.run({ step: 4, tokens: 100, eventId: 'event-1', allowUnknown: true }, async () => ({ usage: { total_tokens: 10 } }))
    assert.equal(twice.settled.duplicate, true, 'повтор события списан второй раз')
    assert.equal(run.budget().used.requests, 2, 'счётчик запросов вырос на дубле события')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  fs.rmSync(path.dirname(dir), { recursive: true, force: true })
}

// ─── Часть 2. Окно: предел, причина остановки, второй запрос не ушёл ─────────
const SLOW = 'node -e "setTimeout(function(){},4000)"'
const planItems = [
  { id: 'read', title: 'Прочитать a.txt', status: 'done' },
  { id: 'slow', title: 'Долгая проверка', status: 'doing' }
]
const limitFrames = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_plan', function: { name: 'task_plan', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ items: planItems }) } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_slow', function: { name: 'run_command', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: JSON.stringify({ command: SLOW }) } }] } }] },
  { choices: [{ delta: { content: 'Проверяю файл.' }, finish_reason: 'tool_calls' }],
    usage: { total_tokens: 120, prompt_tokens: 100, completion_tokens: 20 } }
]
const unknownFrames = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_plan_u', function: { name: 'task_plan', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ items: planItems }) } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_slow_u', function: { name: 'run_command', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: JSON.stringify({ command: SLOW }) } }] } }] },
  { choices: [{ delta: { content: 'Проверяю файл.' }, finish_reason: 'tool_calls' }] }
]

function profileOf (name, budgetSettings) {
  const base = path.join(out, name)
  const workspace = path.join(base, 'workspace')
  const profile = path.join(base, 'profile')
  const dump = path.join(base, 'dump')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(profile, { recursive: true })
  fs.mkdirSync(dump, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello')
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model',
    legacyStoragePurged: true,
    workspace: { path: workspace, permission: 'acceptEdits' },
    commandRules: 'allow node -e *',
    budgetSettings
  }))
  return { base, workspace, profile, dump }
}

function providerOf (base, turns) {
  const file = path.join(base, 'provider.json')
  fs.writeFileSync(file, JSON.stringify({ turns }))
  return file
}

function providerRequests (dump) {
  const requests = []
  for (const name of fs.readdirSync(dump).sort()) {
    if (!name.endsWith('.json')) continue
    try {
      const body = JSON.parse(fs.readFileSync(path.join(dump, name), 'utf8')).body || {}
      requests.push(body)
    } catch { /* недописанный файл замера */ }
  }
  return requests
}
const isAgentRequest = body => Array.isArray(body.tools) && body.tools.length > 0

function childArgs (profile) {
  return ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile]
}

function killTree (child) {
  try { child.kill('SIGKILL') } catch { /* уже мёртв */ }
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }) } catch {}
  }
}

// Ждём файл контрольной точки, который удовлетворяет условию; возвращает
// последний снимок. Читается, пока ход ещё идёт, — после штатного закрытия
// файла уже нет.
async function waitCheckpoint (runsDir, predicate, timeoutMs = 60000) {
  const stop = Date.now() + timeoutMs
  while (Date.now() < stop) {
    let names = []
    try { names = fs.readdirSync(runsDir).filter(name => name.endsWith('.json')) } catch {}
    for (const name of names) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8'))
        if (predicate(data)) return data
      } catch { /* файл пишется атомарно, но мог исчезнуть */ }
    }
    await sleep(35)
  }
  return null
}

async function runLimitWindow () {
  const { base, profile, dump } = profileOf('limit', { requests: 1, tokens: 1_000_000, deadlineMinutes: null })
  const provider = providerOf(base, [
    { frames: limitFrames },
    { text: 'Готово: файл прочитан.' }
  ])
  const log = path.join(base, 'requests.log')
  const script = path.join(base, 'renderer.js')
  const resultFile = path.join(base, 'result.json')
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 90000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(120) } return false }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail).slice(0, 400) })
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    const set = await window.electronAPI.setBudgetSettings({ requests: 1, tokens: 1000000, deadlineMinutes: null })
    const got = await window.electronAPI.getBudgetSettings()
    note('set-budget-settings принял пределы', set.ok && got.settings.requests === 1 && got.settings.tokens === 1000000, JSON.stringify({ set, got: got.settings }))
    $('newChatBtn')?.click()
    await wait(400)
    const box = $('composerTextarea')
    box.value = 'Прочитай a.txt и проверь его.'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(120)
    $('composerForm').requestSubmit()
    const started = await until(() => $('sendBtn')?.classList.contains('is-stop'), 20000)
    const finished = await until(() => !$('sendBtn')?.classList.contains('is-stop'), 90000)
    await wait(1800)
    const feed = $('messagesList').innerText.replace(/\\s+/g, ' ')
    note('ход начался и закончился', started && finished, JSON.stringify({ started, finished }))
    note('в ленте видна причина остановки', /Бюджет задачи исчерпан|осталось 0/.test(feed), feed.slice(-400))
    note('второй запрос не дал ответа', !/Готово: файл прочитан/.test(feed), feed.slice(-250))
    const chats = await window.electronAPI.getConversations()
    const id = $('messagesList')?.dataset.chatId
    const chat = (chats || []).find(item => item.id === id)
    const last = [...((chat && chat.messages) || [])].reverse().find(item => item.role === 'assistant')
    note('ход сохранён как незавершённый', Boolean(last && last.failure), JSON.stringify({ failure: last && last.failure, content: String((last && last.content) || '').slice(-160) }))
    note('в сохранённом ответе та же причина', /Бюджет задачи исчерпан|осталось 0/.test(String((last && last.content) || '')), String((last && last.content) || '').slice(-260))
    return { ok: checks.every(item => item.pass), checks, chatId: id || '' }
  })()`)

  const child = spawn(electronBinary(), childArgs(profile), {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: provider, ONECODE_PROVIDER_DUMP: dump, ONECODE_PROVIDER_LOG: log })
  })
  let tail = ''
  child.stdout.on('data', data => { tail = (tail + data).slice(-3000) })
  child.stderr.on('data', data => { tail = (tail + data).slice(-3000) })
  const progress = []
  const watching = (async () => {
    const runsDir = path.join(profile, 'runs')
    const snapshot = await waitCheckpoint(runsDir, data =>
      data?.task?.budget?.used?.requests === 1 && (data.actions || []).some(item => item.tool === 'run_command' && item.status === 'started'))
    if (snapshot) progress.push(snapshot)
  })()
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => { killTree(child); resolve('timeout') }, 120000)
    child.once('error', () => { clearTimeout(timer); resolve('error') })
    child.once('close', value => { clearTimeout(timer); resolve(value) })
  })
  await watching

  const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { ok: false, checks: [], error: 'окно не отчиталось: ' + tail }
  for (const item of report.checks || []) note('limit · ' + item.name, item.pass, item.detail)
  if (report.error) note('limit · окно отчиталось', false, report.error)
  note('limit · код выхода окна 0', code === 0, String(code))

  const requests = providerRequests(dump)
  const agentRequests = requests.filter(isAgentRequest)
  note('limit · провайдер получил ровно один запрос агента', agentRequests.length === 1, 'запросов: ' + agentRequests.length)
  note('limit · второй ответ сценария не запрашивался',
    !agentRequests.some(body => JSON.stringify(body.messages || []).includes('Готово: файл прочитан.')), '')
  note('limit · контрольная точка поймана на идущем ходе', progress.length === 1, 'снимков: ' + progress.length)
  if (progress.length) {
    const snapshot = progress[0]
    const budget = snapshot.task?.budget || {}
    note('limit · на диске потрачен ровно один запрос и остаток 0',
      budget.used?.requests === 1 && budget.remaining?.requests === 0 && budget.unknownUsage === 0,
      JSON.stringify({ used: budget.used, remaining: budget.remaining, unknownUsage: budget.unknownUsage }))
    const requirements = snapshot.task?.requirements || []
    note('limit · требования в контрольной точке есть и не подтверждены',
      requirements.length >= 2 && requirements.every(item => item.state !== 'confirmed'),
      requirements.map(item => item.state).join(','))
  }
  const runsLeft = fs.existsSync(path.join(profile, 'runs')) ? fs.readdirSync(path.join(profile, 'runs')).filter(name => name.endsWith('.json')) : []
  note('limit · штатно завершённый ход не оставил файла продолжения', runsLeft.length === 0, runsLeft.join(','))
  return { profile, base }
}

async function runResumeWindow () {
  const { base, profile, dump } = profileOf('resume', { requests: 5, tokens: 500_000, deadlineMinutes: null })
  const provider = providerOf(base, [
    { frames: unknownFrames },
    { text: 'Продолжил бы, если бы бюджет позволил.' }
  ])
  const firstScript = path.join(base, 'crash.js')
  fs.writeFileSync(firstScript, `(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 30000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(120) } return false }
    await until(() => document.documentElement.dataset.appReady === '1')
    await window.electronAPI.setBudgetSettings({ requests: 5, tokens: 500000, deadlineMinutes: null })
    await window.electronAPI.sendMessage({ model: 'dots-studio/dots-3-note-preview:free', requestId: 'crash-turn', chatId: 'crash-chat',
      messages: [{ role: 'user', content: 'Собери отчёт по a.txt.' }], params: { useTools: true } })
    await new Promise(() => {})
  })()`)
  const crash = spawn(electronBinary(), childArgs(profile), {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: guiEnv({ ONECODE_SMOKE: firstScript, ONECODE_SMOKE_OUT: path.join(base, 'crash-result.json'),
      ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: provider, ONECODE_PROVIDER_DUMP: dump })
  })
  let tail = ''
  crash.stdout.on('data', data => { tail = (tail + data).slice(-3000) })
  crash.stderr.on('data', data => { tail = (tail + data).slice(-3000) })
  const runsDir = path.join(profile, 'runs')
  const beforeCrash = await waitCheckpoint(runsDir, data =>
    data?.task?.budget?.used?.requests === 1 && data?.task?.budget?.unknownUsage === 1 &&
    (data.actions || []).some(item => item.tool === 'run_command' && item.status === 'started'))
  killTree(crash)
  await new Promise(resolve => { crash.once('close', resolve); setTimeout(resolve, 15000) })
  note('resume · ход убит посреди работы с частичным и неизвестным расходом',
    Boolean(beforeCrash), beforeCrash ? JSON.stringify(beforeCrash.task.budget.used) + ' unknown=' + beforeCrash.task.budget.unknownUsage : tail)
  if (beforeCrash) {
    note('resume · сохранённый остаток запросов — 4, а не новый комплект',
      beforeCrash.task.budget.remaining.requests === 4,
      JSON.stringify(beforeCrash.task.budget.remaining))
  }

  const log = path.join(base, 'resume-requests.log')
  const resumeDump = path.join(base, 'resume-dump')
  fs.mkdirSync(resumeDump, { recursive: true })
  const secondScript = path.join(base, 'resume.js')
  const resultFile = path.join(base, 'resume-result.json')
  fs.writeFileSync(secondScript, `(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 30000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(120) } return false }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail).slice(0, 500) })
    await until(() => document.documentElement.dataset.appReady === '1')
    const set = await window.electronAPI.setBudgetSettings({ requests: 50, tokens: 5000000, deadlineMinutes: null })
    note('новые настройки поставлены перед продолжением', set.ok, JSON.stringify(set))
    const runs = await window.electronAPI.interruptedRuns()
    const run = (runs || [])[0]
    note('карточка продолжения есть', Boolean(run), JSON.stringify((runs || []).map(item => item.runId)))
    if (!run) return { ok: false, checks, prompt: '' }
    const response = await window.electronAPI.sendMessage({ model: 'dots-studio/dots-3-note-preview:free', requestId: 'resume-turn',
      chatId: run.chatId || 'crash-chat', resumeRunId: run.runId,
      messages: [{ role: 'user', content: run.prompt }], params: { useTools: true } })
    note('продолжение остановлено бюджетом', response?.incomplete === true && response?.ok === false,
      JSON.stringify({ ok: response?.ok, incomplete: response?.incomplete, aborted: response?.aborted }))
    note('ход не выдаёт себя за завершённый', response?.execution?.state === 'incomplete', JSON.stringify(response?.execution))
    note('причина — неизвестный расход', /неизвестн/i.test(String(response?.content || '')), String(response?.content || '').slice(-350))
    return { ok: checks.every(item => item.pass), checks, prompt: run.prompt }
  })()`)
  const resume = spawnSync(electronBinary(), childArgs(profile), {
    cwd: root, timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: guiEnv({ ONECODE_SMOKE: secondScript, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1',
      ONECODE_PROVIDER_FILE: provider, ONECODE_PROVIDER_DUMP: resumeDump, ONECODE_PROVIDER_LOG: log })
  })
  const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { ok: false, checks: [], error: 'окно не отчиталось: ' + String(resume.stderr || '') }
  for (const item of report.checks || []) note('resume · ' + item.name, item.pass, item.detail)
  if (report.error) note('resume · окно отчиталось', false, report.error)
  note('resume · в карточке продолжения назван сохранённый расход',
    /запросов 1 из 5/.test(String(report.prompt || '')) && /1 с неизвестным расходом/.test(String(report.prompt || '')),
    String(report.prompt || '').slice(0, 500))

  const requests = providerRequests(resumeDump)
  note('resume · продолжение не сделало ни одного запроса к провайдеру', requests.length === 0, 'запросов: ' + requests.length)
  const runsLeft = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(name => name.endsWith('.json')) : []
  note('resume · старый файл снят, новый закрыт', runsLeft.length === 0, runsLeft.join(','))
  return { base }
}

;(async () => {
  await pureChecks()
  await runLimitWindow()
  await runResumeWindow()

  const failed = checks.filter(item => !item.pass)
  console.log('')
  if (failed.length) {
    console.error(`ПРОВАЛ: ${failed.length} из ${checks.length}`)
    for (const item of failed) console.error('  - ' + item.name + ' — ' + item.detail)
  } else {
    console.log(`Бюджет задачи: ${checks.length} проверок, провалов 0`)
  }
  settleRun(out, failed.length === 0)
  process.exitCode = failed.length ? 1 : 0
})().catch(error => {
  console.error('харнесс упал: ' + (error && error.stack || error))
  settleRun(out, false)
  process.exitCode = 2
})
