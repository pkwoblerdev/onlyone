'use strict'
// Одна попытка стенда: настоящее приложение, настоящий send-message, ответы —
// из файла сценария. Дочернее дерево снимается целиком: Electron оставляет
// процессы рендера, и ждать их самих нельзя.
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

function killTree (pid) {
  if (!pid) return false
  if (process.platform === 'win32') {
    try { return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }).status === 0 } catch { return false }
  }
  try { process.kill(-pid, 'SIGKILL'); return true } catch {
    try { process.kill(pid, 'SIGKILL'); return true } catch { return false }
  }
}

function requestsIn (logFile) {
  try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length } catch { return null }
}

// run: { electron, root, profile, workspace, script, provider, timeoutMs, chatId, request, outDir }
function launch ({ electron, root, profile, script, provider, timeoutMs, request, chatId, model, projectId, resultFile, logFile, dumpDir, interruptWhen, approve }) {
  return new Promise(resolve => {
    const arg = Buffer.from(JSON.stringify({ request, chatId, model, projectId: projectId || null, approve: approve || null })).toString('base64')
    const env = {
      ...process.env,
      ONECODE_SMOKE: script,
      ONECODE_SMOKE_OUT: resultFile,
      ONECODE_E2E: '1',
      ONECODE_VERSIONS: '0',
      ONECODE_ARG: arg,
      ONECODE_PROVIDER_FILE: provider || '',
      ONECODE_PROVIDER_LOG: logFile,
      ONECODE_PROVIDER_DUMP: dumpDir
    }
    // ELECTRON_RUN_AS_NODE наследуется из оболочки агента: окно тогда стартует
    // как Node и не отчитывается вовсе.
    delete env.ELECTRON_RUN_AS_NODE
    let stderr = ''
    let settled = false
    let stopRequested = null, cleanupRequestSucceeded = null
    const started = Date.now()
    const child = spawn(electron, ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
      cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32'
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000) })
    for (const dir of [dumpDir]) { try { fs.mkdirSync(dir, { recursive: true }) } catch { /* каталог есть */ } }
    let watcher = null
    const finish = stopReason => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (watcher) clearInterval(watcher)
      let result = null
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { result = null }
      resolve({ stopReason, result, stderr, durationMs: Date.now() - started,
        requests: requestsIn(logFile), exitCode: child.exitCode, pid: child.pid,
        cleanupRequestSucceeded, rootExited: child.exitCode !== null || child.signalCode !== null })
    }
    const timer = setTimeout(async () => {
      stopRequested = 'timeout'
      cleanupRequestSucceeded = killTree(child.pid)
      await new Promise(done => {
        const hard = setTimeout(done, 5000)
        child.once('close', () => { clearTimeout(hard); done() })
      })
      finish('timeout')
    }, timeoutMs)
    child.on('error', error => { stderr += String(error && error.message || error); finish('spawn-error') })
    child.on('close', code => finish(stopRequested || (code === 0 ? 'completed' : 'crashed')))
    // Прерывание по побочному действию: файл появился — снимаем дерево, как
    // падение посреди хода. Продолжение проверяет контрольная точка, а не мы.
    if (interruptWhen) {
      watcher = setInterval(() => {
        try {
          if (!fs.existsSync(interruptWhen)) return
        } catch { return }
        clearInterval(watcher); watcher = null
        stopRequested = 'interrupted'
        cleanupRequestSucceeded = killTree(child.pid)
        setTimeout(() => finish('interrupted'), 5000).unref()
      }, 50)
    }
  })
}

// Зонд Desk: отдельный запуск Electron без окон, пишет результат в файл (см.
// tests/quality-bench/desk-probe.cjs). seed кладёт раскладку, collect читает её.
function runProbe ({ electron, root, profile, mode, chatId, resultFile, seedFile = '', timeoutMs = 60000 }) {
  return new Promise(resolve => {
    const env = { ...process.env, ONECODE_BENCH_DESK_MODE: mode, ONECODE_BENCH_DESK_CHAT: chatId, ONECODE_BENCH_DESK_OUT: resultFile, ONECODE_BENCH_DESK_SEED: seedFile }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [path.join(root, 'tests', 'quality-bench', 'desk-probe.cjs'), '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
      { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32' })
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let result = null
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { result = null }
      resolve(result || { ok: false, error: 'probe-no-result' })
    }
    const timer = setTimeout(() => { killTree(child.pid); setTimeout(finish, 2000) }, timeoutMs)
    child.on('error', () => finish())
    child.on('close', finish)
  })
}

// Зонд уроков: отдельный запуск Electron без окон (tests/quality-bench/lessons-probe.cjs).
// seed кладёт уроки в шифрованное хранилище профиля, collect читает состояния и promptBlock.
function runLessonsProbe ({ electron, root, profile, mode, resultFile, seedFile, projectId = '', request = '', timeoutMs = 120000 }) {
  return new Promise(resolve => {
    const env = { ...process.env, ONECODE_BENCH_LESSONS_MODE: mode, ONECODE_BENCH_LESSONS_OUT: resultFile,
      ONECODE_BENCH_LESSONS_SEED: seedFile, ONECODE_BENCH_LESSONS_PROJECT: projectId, ONECODE_BENCH_LESSONS_REQUEST: request }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [path.join(root, 'tests', 'quality-bench', 'lessons-probe.cjs'), '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
      { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32' })
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let result = null
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { result = null }
      resolve(result || { ok: false, error: 'probe-no-result' })
    }
    const timer = setTimeout(() => { killTree(child.pid); setTimeout(finish, 2000) }, timeoutMs)
    child.on('error', () => finish())
    child.on('close', finish)
  })
}

// Ошибка агента, стенда и провайдера — разные вещи. Неизвестный исход не
// приписывается модели: без отчёта окна или с таймаутом виноват стенд.
function classify ({ stopReason, stderr, result }, check, { expected, mode }) {
  if (['spawn-error', 'timeout', 'crashed'].includes(stopReason)) return 'bench-error'
  if (stopReason === 'interrupted') return check.ok ? 'pass' : 'agent-error'
  if (!result || result.ok === false || result.aborted) {
    return /провайдер|provider|\b429\b|\b5\d\d\b|лимит|network|fetch/i.test(String(result?.error || '') + ' ' + String(stderr || '')) ? 'provider-error' : 'bench-error'
  }
  if (check.ok) return expected === 'agent-error' && mode === 'self' ? 'bench-error' : 'pass'
  return 'agent-error'
}

module.exports = { launch, runProbe, runLessonsProbe, killTree, requestsIn, classify }
