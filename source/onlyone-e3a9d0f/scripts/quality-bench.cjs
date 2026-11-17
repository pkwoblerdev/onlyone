#!/usr/bin/env node
'use strict'
// Стенд качества агентной работы Onlyone, первый срез.
//
// Одна документированная команда: `npm run bench:agent` — самопроверка стенда на
// сценарном провайдере (сеть не нужна). Оценка настоящей модели включается
// только руками: `npm run bench:agent -- --mode live --model <id> --profile <папка>`.
//
// Каждая попытка получает свои временные Workspace и профиль; скрытые проверки
// лежат вне Workspace. Отчёт — JSON: источник, сценарий, модель, параметры,
// проверка, заявление о завершении, запросы, токены, длительность и причина
// остановки. Неизвестные токены остаются null, а не нулём.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { electronBinary, acquireWindowLock } = require('../tests/app-launch.cjs')
const { launch, runProbe, runLessonsProbe, classify } = require('./quality-bench/launch.cjs')
const { scenarios } = require('./quality-bench/scenarios.cjs')
const { startPage } = require('./quality-bench/fixtures.cjs')
const { snapshotTree, constraintProblems } = require('./quality-bench/verify.cjs')
const { DESK_SEED } = require('./quality-bench/tasks.cjs')
const { PROJECTS } = require('./quality-bench/lessons.cjs')

const root = path.join(__dirname, '..')
const TURN = path.join(root, 'tests', 'quality-bench', 'turn.cjs')
const RESUME = path.join(root, 'tests', 'quality-bench', 'resume.cjs')
const SELF_MODEL = 'bench/model' // модель объявлена в кэше профиля: та же схема, что у оконных стендов
const SELF_CAPABILITIES = { id: SELF_MODEL, name: 'Bench', isFree: true, supportsTools: true, supportedEfforts: ['low'], contextLength: 100000, inputModalities: ['text'] }
const DEFAULTS = { mode: 'self', repeat: 1, timeoutMs: 120000, lessons: 'on' }

function args (argv) {
  const out = { ...DEFAULTS, only: [] }
  const fields = { '--mode': 'mode', '--model': 'model', '--profile': 'profile', '--out': 'out' }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--help' || key === '-h') { out.help = true; continue }
    if (!fields[key] && !['--repeat', '--timeout', '--scenario', '--lessons'].includes(key)) throw Error('Неизвестный аргумент: ' + key)
    const value = argv[++i]
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw Error('Нет значения: ' + key)
    if (key === '--lessons') {
      if (value !== 'on' && value !== 'off') throw Error('lessons: on или off')
      out.lessons = value
    } else if (key === '--repeat') {
      out.repeat = Number(value)
      if (!Number.isSafeInteger(out.repeat) || out.repeat < 1 || out.repeat > 100) throw Error('repeat: целое от 1 до 100')
    } else if (key === '--timeout') {
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds < 10 || seconds > 3600) throw Error('timeout: от 10 до 3600 секунд')
      out.timeoutMs = seconds * 1000
    } else if (key === '--scenario') out.only.push(value)
    else out[fields[key]] = value
  }
  return out
}

function createOutput (requested) {
  if (!requested) return fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-quality-bench-'))
  const out = path.resolve(requested)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.mkdirSync(out) // Never reuse a previous run's files, results or request logs.
  return out
}

function sourceInfo () {
  const git = (...argv) => { const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8' }); return result.status === 0 ? String(result.stdout || '').trim() : null }
  const version = (() => { try { return require(path.join(root, 'package.json')).version } catch { return null } })()
  const status = git('status', '--porcelain')
  return { commit: git('rev-parse', 'HEAD') || null, dirty: status === null ? null : Boolean(status), version }
}

// Всё, что определяет задания, проверки, страницу и оконные сценарии стенда.
const SUITE_FILES = ['scripts/quality-bench/scenarios.cjs', 'scripts/quality-bench/tasks.cjs', 'scripts/quality-bench/lessons.cjs', 'scripts/quality-bench/fixtures.cjs', 'scripts/quality-bench/verify.cjs',
  'tests/quality-bench/turn.cjs', 'tests/quality-bench/resume.cjs', 'tests/quality-bench/desk-probe.cjs', 'tests/quality-bench/lessons-probe.cjs']

function suiteDigest (base = root) {
  const hash = crypto.createHash('sha256')
  for (const file of SUITE_FILES) {
    hash.update(file + '\0'); hash.update(fs.readFileSync(path.join(base, file)))
  }
  return hash.digest('hex')
}

// Подстановка меток (__BENCH_PAGE__ и др.) в строку или структуру ответов.
function fill (value, map) {
  let text = JSON.stringify(value)
  for (const [token, replacement] of Object.entries(map || {})) text = text.split(token).join(JSON.stringify(String(replacement)).slice(1, -1))
  return JSON.parse(text)
}

// Файлы, которые стенд сам кладёт рядом с Workspace; всё остальное там — чужая запись.
const BASE_KNOWN = new Set(['workspace', 'profile', 'outside', 'dump', 'dump-resume', 'provider.json', 'provider-resume.json', 'first.json', 'second.json',
  'requests.log', 'requests-resume.log', 'desk-seed.json', 'desk-seed-result.json', 'desk-collect.json', 'lessons-seed.json', 'lessons-seed-result.json', 'lessons-collect.json'])

function profileSettings (workspace, model) {
  return {
    openrouterKeys: [{ id: 'bench-key', name: 'Bench', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: model, enabled: true }],
    defaultModel: model,
    legacyStoragePurged: true,
    openrouterModelCache: { updatedAt: Date.now(), models: [SELF_CAPABILITIES] },
    workspace: { path: workspace, permission: 'acceptEdits' }
  }
}

function copyProfile (from, to) {
  const source = fs.realpathSync(from)
  const appData = process.env.APPDATA
  if (appData) for (const name of ['1code', 'onlyone']) {
    const personal = path.resolve(appData, name)
    const actual = fs.existsSync(personal) ? fs.realpathSync(personal) : personal
    const relative = path.relative(actual.toLowerCase(), source.toLowerCase())
    if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && relative !== '..')) throw Error('Личный профиль не разрешён для стенда')
  }
  fs.mkdirSync(to, { recursive: true })
  for (const name of ['1code-settings.json', 'Local State']) {
    const file = path.join(source, name)
    if (name === 'Local State' && !fs.existsSync(file)) continue
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Неверный файл стендового профиля: ' + name)
    fs.copyFileSync(file, path.join(to, name), fs.constants.COPYFILE_EXCL)
  }
}

// Заявление о завершении — то, что агент сказал в ленте, а не только финальный
// ответ: в сценарном прогоне конец хода может прийти пустым ответом приёмки.
function claimOf (result) {
  if (!result) return ''
  const spoken = Array.isArray(result.spoken) ? result.spoken.slice().reverse().find(Boolean) : null
  const streamed = String(result.spokenText || '').trim()
  return String(streamed || result.content || spoken || '')
}

// Финальный ответ хода в сценарном прогоне может быть пустым ответом приёмки.
// Тогда заявление агента берём из истории запросов: последняя непустая реплика
// ассистента — это то, что он сказал до приёмки, а не наш пересказ.
function claimFromDump (dumpDir) {
  let files = []
  try { files = fs.readdirSync(dumpDir).filter(file => /^request-\d+\.json$/.test(file)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])) } catch { return '' }
  let claim = ''
  for (const file of files) {
    let body
    try { body = JSON.parse(fs.readFileSync(path.join(dumpDir, file), 'utf8')).body } catch { continue }
    for (const message of body?.messages || []) {
      if (message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) claim = message.content
    }
  }
  return claim
}

function completionClaim (text) {
  return /(?:^|[^\p{L}])(?:готово|done)(?=$|[^\p{L}])/iu.test(text) && !/не\s+готово|not\s+(?:yet\s+)?done/iu.test(text)
}

function sha (file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}

// Полный текст, который увидела модель: сообщения из дампа провайдера. В live
// дампа нет — там остаётся блок уроков из зонда, и отчёт честно называет источник.
function promptText (dumpDir) {
  let files = []
  try { files = fs.readdirSync(dumpDir).filter(file => /^request-\d+\.json$/.test(file)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])) } catch { return null }
  const parts = []
  for (const file of files) {
    let body
    try { body = JSON.parse(fs.readFileSync(path.join(dumpDir, file), 'utf8')).body } catch { continue }
    for (const message of body?.messages || []) {
      if (typeof message?.content === 'string' && message.content) parts.push(message.content)
      else if (message?.content) parts.push(JSON.stringify(message.content))
    }
  }
  return parts.length ? parts.join('\n') : null
}

// Состояние уроков по ключам зерна: «enabled», «proposed», «revoked» или «absent».
function lessonStatuses (fixture, collected) {
  const found = new Map()
  for (const list of Object.values(collected?.projects || {})) for (const item of Array.isArray(list) ? list : []) found.set(item.text, item.status)
  const statuses = {}
  for (const item of fixture.expect) statuses[item.key] = found.get(item.text) || 'absent'
  return statuses
}

async function attempt (scenario, repeat, options) {
  const env = { map: {}, page: null }
  try {
    if (scenario.page) {
      env.page = await startPage()
      env.map = { __BENCH_PAGE__: env.page.url, __BENCH_CODE__: env.page.code }
    }
    return await attemptCore(scenario, repeat, options, env)
  } finally { if (env.page) await env.page.close() }
}

async function attemptCore (scenario, repeat, options, env) {
  const attemptStarted = Date.now()
  const tag = `${scenario.id}-${repeat}`
  const base = path.join(options.out, 'attempts', tag)
  const workspace = path.join(base, 'workspace')
  const profile = path.join(base, 'profile')
  let dumpDir = path.join(base, 'dump')
  fs.mkdirSync(path.dirname(base), { recursive: true })
  fs.mkdirSync(base)
  fs.mkdirSync(workspace)
  const outside = path.join(base, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'не трогать: лежит вне Workspace\n')
  if (options.mode === 'live' && options.profile) copyProfile(path.resolve(options.profile), profile)
  else fs.mkdirSync(profile, { recursive: true })
  const chatId = `bench-${tag}`
  const model = options.model || SELF_MODEL
  const lessonFixture = scenario.lessons || null
  const settingsFile = path.join(profile, '1code-settings.json')
  const settings = options.mode === 'live' ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : profileSettings(workspace, model)
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Неверные настройки стендового профиля')
  settings.workspace = { path: workspace, permission: 'acceptEdits' }
  if (!settings.defaultModel) settings.defaultModel = model
  // Условия «с уроками» и «без уроков» отличаются только набором уроков: проект
  // и его просьба те же, чужие проекты человека в попытку не попадают.
  if (lessonFixture) settings.projects = PROJECTS.map(project => ({ ...project }))
  fs.writeFileSync(settingsFile, JSON.stringify(settings))
  const lessonsSeedFile = lessonFixture ? path.join(base, 'lessons-seed.json') : null
  if (lessonFixture) fs.writeFileSync(lessonsSeedFile, JSON.stringify({ ...lessonFixture, projects: PROJECTS.map(project => project.id) }))
  if (lessonFixture && options.lessons === 'on') {
    acquireWindowLock()
    const seeded = await runLessonsProbe({ electron: electronBinary(), root, profile, mode: 'seed', seedFile: lessonsSeedFile,
      projectId: lessonFixture.projectId, request: fill(scenario.request, env.map), resultFile: path.join(base, 'lessons-seed-result.json') })
    if (!seeded.ok) throw Object.assign(Error('lessons-seed-failed'), { code: 'lessons-seed-failed' })
  }

  for (const [file, content] of Object.entries(scenario.fixture || {})) {
    const target = path.join(workspace, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  const initialFiles = fs.readdirSync(workspace, { recursive: true }).map(String).sort()
  const workspaceBefore = snapshotTree(workspace), outsideBefore = snapshotTree(outside)
  const request = fill(scenario.request, env.map)
  const turns = fill(scenario.turns, env.map)
  const approve = env.page ? { hosts: [env.page.host] } : null
  if (scenario.desk) {
    const seedFile = path.join(base, 'desk-seed.json')
    fs.writeFileSync(seedFile, JSON.stringify(DESK_SEED))
    acquireWindowLock()
    const seeded = await runProbe({ electron: electronBinary(), root, profile, mode: 'seed', chatId, resultFile: path.join(base, 'desk-seed-result.json'), seedFile })
    if (!seeded.ok) throw Object.assign(Error('desk-seed-failed'), { code: 'desk-seed-failed' })
  }

  const provider = options.mode === 'live' ? '' : path.join(base, 'provider.json')
  if (provider) fs.writeFileSync(provider, JSON.stringify({ turns, ...(scenario.keyed ? { keyed: fill(scenario.keyed, env.map) } : {}) }))
  acquireWindowLock()
  const first = await launch({
    electron: electronBinary(), root, profile,
    script: TURN, provider, timeoutMs: options.timeoutMs,
    request, chatId, model, projectId: lessonFixture?.projectId || null, approve,
    resultFile: path.join(base, 'first.json'), logFile: path.join(base, 'requests.log'), dumpDir,
    interruptWhen: scenario.interruptWhen ? path.join(workspace, scenario.interruptWhen) : null
  })
  let second = null
  let beforeResume = null
  if (scenario.id === 'interrupt-resume' && first.stopReason === 'interrupted' && first.cleanupRequestSucceeded === true && first.rootExited === true) {
    const file = path.join(workspace, 'state.txt')
    if (fs.existsSync(file)) beforeResume = { hash: sha(file), mtimeMs: fs.statSync(file).mtimeMs }
    dumpDir = path.join(base, 'dump-resume')
    const resumeProvider = options.mode === 'live' ? '' : path.join(base, 'provider-resume.json')
    if (resumeProvider) fs.writeFileSync(resumeProvider, JSON.stringify({ turns: scenario.resumeTurns }))
    acquireWindowLock()
    second = await launch({
      electron: electronBinary(), root, profile,
      script: RESUME, provider: resumeProvider, timeoutMs: options.timeoutMs,
      request: 'Продолжи прерванную работу.', chatId, model,
      resultFile: path.join(base, 'second.json'), logFile: path.join(base, 'requests-resume.log'), dumpDir
    })
  }
  let collected = null
  if (scenario.desk) {
    acquireWindowLock()
    collected = await runProbe({ electron: electronBinary(), root, profile, mode: 'collect', chatId, resultFile: path.join(base, 'desk-collect.json') })
  }
  let lessonsCollected = null
  if (lessonFixture) {
    acquireWindowLock()
    lessonsCollected = await runLessonsProbe({ electron: electronBinary(), root, profile, mode: 'collect', seedFile: lessonsSeedFile,
      projectId: lessonFixture.projectId, request, resultFile: path.join(base, 'lessons-collect.json') })
  }
  let guard = null
  if (scenario.constraints) {
    let baseAdded = []
    try { baseAdded = fs.readdirSync(base).filter(name => !BASE_KNOWN.has(name)) } catch { baseAdded = ['<base-unreadable>'] }
    guard = { problems: constraintProblems({ workspace: { before: workspaceBefore, after: snapshotTree(workspace) }, outside: { before: outsideBefore, after: snapshotTree(outside) },
      baseAdded, allowNew: scenario.constraints.allowNew, allowChange: scenario.constraints.allowChange }) }
  }
  const fixtureState = env.page ? { code: env.page.code, host: env.page.host, log: env.page.log.slice() } : null
  const dumpedPrompt = promptText(dumpDir)
  const probePrompt = lessonsCollected?.ok ? lessonsCollected.prompt : null
  const promptSeen = dumpedPrompt || probePrompt || null
  const lessonState = lessonFixture ? { ok: lessonsCollected?.ok === true, statuses: lessonStatuses(lessonFixture, lessonsCollected), error: lessonsCollected?.error } : null
  const lessonMeta = lessonFixture ? {
    profile: options.lessons,
    projectId: lessonFixture.projectId,
    promptSource: dumpedPrompt ? 'provider-dump' : probePrompt ? 'lessons-probe' : null,
    expected: lessonFixture.expect.map(item => ({ key: item.key, inPrompt: item.inPrompt })),
    observed: lessonFixture.expect.map(item => ({ key: item.key, inPrompt: promptSeen ? promptSeen.includes(item.text) : null })),
    store: lessonState?.statuses || null
  } : null
  const selfExpectation = options.mode === 'self' && scenario.selfExpect ? scenario.selfExpect[options.lessons] : scenario.expect
  let check
  try {
    const claim = claimOf(second?.result || first.result) || claimFromDump(dumpDir)
    check = scenario.verify({ workspace, run: { ...(first.result || {}), content: claim }, first: first.result && { ...first.result, content: claim }, second: second?.result && { ...second.result, content: claimOf(second.result) || claim }, context: { beforeResume, fixture: fixtureState, guard, collected, prompt: promptSeen, probePrompt, lessons: lessonState, lessonsProfile: options.lessons } })
  } catch (error) {
    check = { ok: false, detail: 'проверка стенда упала: ' + String(error && error.message || error) }
  }
  const effective = second || first
  const stopReason = effective.stopReason
  const verdict = check.detail.startsWith('проверка стенда упала') || (scenario.id === 'interrupt-resume' && (!second || first.stopReason !== 'interrupted'))
    ? 'bench-error' : classify(effective, check, { expected: options.mode === 'self' ? selfExpectation : scenario.expect, mode: options.mode })
  return finishAttempt({ scenario, repeat, tag, options, workspace, profile, chatId, model,
    first, second, check, verdict, stopReason, initialFiles, beforeResume, dumpDir, attemptStarted, lessons: lessonMeta, selfExpectation })
}

function finishAttempt ({ scenario, repeat, tag, options, workspace, profile, chatId, model, dumpDir,
  first, second, check, verdict, stopReason, initialFiles, beforeResume, attemptStarted, lessons = null, selfExpectation = null }) {
  const launches = second ? [first, second] : [first]
  const sum = values => values.every(value => Number.isFinite(value) && value >= 0) ? values.reduce((a, b) => a + b, 0) : null
  const tokens = sum(launches.map(item => item.result?.usage?.total_tokens))
  const requests = sum(launches.map(item => item.requests))
  const claim = claimOf(second?.result || first.result) || claimFromDump(dumpDir)
  const asked = launches.flatMap(item => Array.isArray(item.result?.approvals) ? item.result.approvals : [])
  const reported = launches.some(item => Array.isArray(item.result?.approvals))
  return {
    scenario: scenario.id,
    title: scenario.title,
    repeat,
    chatId,
    mode: options.mode,
    model,
    params: { permission: 'acceptEdits', timeoutMs: options.timeoutMs },
    isolated: { workspace: path.relative(options.out, workspace), profile: path.relative(options.out, profile), initialFiles },
    launches: [
      { role: 'turn', stopReason: first.stopReason, durationMs: first.durationMs, requests: first.requests, exitCode: first.exitCode, cleanupRequestSucceeded: first.cleanupRequestSucceeded, rootExited: first.rootExited },
      ...(second ? [{ role: 'resume', stopReason: second.stopReason, durationMs: second.durationMs, requests: second.requests, exitCode: second.exitCode, cleanupRequestSucceeded: second.cleanupRequestSucceeded, rootExited: second.rootExited }] : [])
    ],
    stopReason,
    durationMs: Number.isFinite(attemptStarted) ? Date.now() - attemptStarted : first.durationMs + (second?.durationMs || 0),
    executionDurationMs: first.durationMs + (second?.durationMs || 0),
    requests,
    tokens,
    completionClaim: completionClaim(claim),
    // Ложное «готово»: агент заявил о завершении, а скрытая проверка не прошла.
    falseDone: completionClaim(claim) && !check.ok,
    approvals: reported ? { asked: asked.length, denied: asked.filter(item => item && item.approved === false).length } : null,
    claimText: claim.slice(0, 400),
    check: { ok: Boolean(check.ok), detail: String(check.detail || '') },
    verdict,
    expected: scenario.expect,
    // Ожидание самопроверки с учётом профиля уроков (on/off); live всегда ждёт pass.
    selfExpectation: selfExpectation || scenario.expect,
    // Условия с уроками: что подано, что увидено, состояние хранилища. Тексты
    // уроков сюда не попадают — только ключи зерна.
    lessons: lessons || null,
    beforeResume: beforeResume || null,
    // Raw provider stderr is kept out of the portable report.
    failure: verdict === 'bench-error' || verdict === 'provider-error' ? stopReason : null
  }
}

async function main () {
  let options
  try { options = args(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exit(2) }
  if (options.help) {
    console.log('npm run bench:agent -- [--mode self|live] [--repeat N] [--timeout СЕК] [--scenario id] [--out dir] [--model id] [--profile dir] [--lessons on|off]')
    return
  }
  if (options.mode !== 'self' && options.mode !== 'live') { console.error('mode: self или live'); process.exit(2) }
  if (options.mode === 'live' && (!options.model || !options.profile)) {
    console.error('live: нужны --model и --profile с ключом стенда. Личный профиль не подставляется автоматически.')
    process.exit(2)
  }
  const unknown = options.only.filter(id => !scenarios.some(item => item.id === id))
  if (unknown.length) throw Error('Неизвестные сценарии: ' + unknown.join(', '))
  const selected = scenarios.filter(item => !options.only.length || options.only.includes(item.id))
  const out = createOutput(options.out)
  options.out = out
  if (options.mode === 'live') console.error('ВНИМАНИЕ: live-режим делает настоящие запросы к модели и тратит бюджет стенда.')

  const startedAt = new Date().toISOString()
  const attempts = []
  const source = sourceInfo()
  const digest = suiteDigest()
  const partial = () => { const file = path.join(out, 'report.json'); fs.writeFileSync(file + '.tmp', JSON.stringify({ tool: 'onlyone-agent-quality-bench', schemaVersion: 1, suiteDigest: digest, source, mode: options.mode, startedAt, completed: false, attempts }, null, 2)); fs.renameSync(file + '.tmp', file) }
  partial()
  for (const scenario of selected) {
    for (let repeat = 1; repeat <= options.repeat; repeat++) {
      let result
      try { result = await attempt(scenario, repeat, options) }
      catch (error) { const reason = /^окно: замок/.test(String(error.message || '')) ? 'window-lock-unavailable' : String(error.code || 'attempt-error'); result = { scenario: scenario.id, repeat, verdict: 'bench-error', stopReason: reason, check: { ok: false, detail: reason } } }
      attempts.push(result)
      partial()
      console.log(`${result.verdict.padEnd(12)} ${result.scenario}#${result.repeat} check=${result.check.ok ? 'ok' : 'fail'} ${result.stopReason} ${result.check.detail}`)
    }
  }
  const counts = attempts.reduce((all, item) => { all[item.verdict] = (all[item.verdict] || 0) + 1; return all }, {})
  const report = {
    tool: 'onlyone-agent-quality-bench', schemaVersion: 1,
    suiteDigest: digest,
    source, completed: true, mode: options.mode, model: options.model || SELF_MODEL,
    repeat: options.repeat, lessons: options.lessons, startedAt, finishedAt: new Date().toISOString(),
    workspaceIsolation: 'каждая попытка — свой временный Workspace и профиль',
    checksIsolation: 'скрытые проверки лежат вне Workspace (scripts/quality-bench/scenarios.cjs, tasks.cjs, lessons.cjs); это изоляция файлов попытки, не песочница ОС',
    aaNotice: options.repeat > 1 ? 'Повторы одной конфигурации — только начальная оценка шума (два прогона — лишь первая оценка), не доказательство эффективности.' : null,
    attempts,
    summary: { total: attempts.length, counts, falseDone: attempts.filter(item => item.falseDone).length, executionOk: !counts['bench-error'] && !counts['provider-error'],
      ok: attempts.every(item => item.verdict === (options.mode === 'self' ? (item.selfExpectation || item.expected) : 'pass')) }
  }
  fs.writeFileSync(path.join(out, 'report.json.tmp'), JSON.stringify(report, null, 2))
  fs.renameSync(path.join(out, 'report.json.tmp'), path.join(out, 'report.json'))
  console.log(JSON.stringify({ ok: report.summary.ok, report: path.join(out, 'report.json'), counts }))
  process.exit(report.summary.ok ? 0 : 1)
}

if (require.main === module) main().catch(error => { console.error(error.message || error); process.exit(1) })
module.exports = { args, finishAttempt, claimOf, completionClaim, createOutput, copyProfile, suiteDigest, SUITE_FILES, fill }
