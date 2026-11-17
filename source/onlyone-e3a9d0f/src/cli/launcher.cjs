'use strict'
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawn } = require('node:child_process')
const { EXIT, USAGE, parseArgs, outcomeOf, lineFor, redact, secretValues } = require('./onlyone.cjs')
const { createJob, cleanup } = require('./session.cjs')
function defaultProfile () {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config')
  const fresh = path.join(base, 'onlyone'), legacy = path.join(base, '1code')
  return fs.existsSync(fresh) ? fresh : legacy
}
function runtime () {
  const archive = path.resolve(__dirname, '../app.asar')
  if (fs.existsSync(archive)) return { binary: path.resolve(__dirname, '../../onlyone.exe'), args: [], cwd: path.resolve(__dirname, '../..') }
  return { binary: require('electron'), args: ['.'], cwd: path.resolve(__dirname, '../..'), version: require('../../package.json').version }
}
async function main (argv) {
  const say = text => process.stdout.write(String(text) + '\n'), error = text => process.stderr.write(String(text) + '\n')
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) { say(USAGE + '\nБез --allow-write доступно только чтение. Профиль берётся из установленного приложения.'); return EXIT.OK }
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) {
    const metadata = path.join(__dirname, 'version.json')
    say('onlyone ' + (fs.existsSync(metadata) ? require(metadata).version : require('../../package.json').version)); return EXIT.OK
  }
  const parsed = parseArgs(argv)
  if (parsed.error) { error(parsed.error); return EXIT.BAD_INPUT }
  if (!fs.existsSync(parsed.folder) || !fs.statSync(parsed.folder).isDirectory()) { error(`Папки «${parsed.folder}» нет на диске — ход не начинался.`); return EXIT.BAD_INPUT }
  try { require('./session.cjs').cleanupStale() } catch { /* уборка не должна мешать ходу */ }
  let job, engine
  try { engine = runtime() } catch { error('Runtime CLI не найден. Переустановите приложение.'); return EXIT.TURN_FAILED }
  const sourceProfile = parsed.profile || process.env.ONECODE_PROFILE_DIR || defaultProfile()
  try { job = createJob({ sourceProfile, folder: parsed.folder, request: parsed.request, allowWrite: parsed.allowWrite }) }
  catch { error('Не удалось прочитать настройки CLI. Откройте onlyone и настройте подключение либо укажите --profile.'); return EXIT.BAD_INPUT }
  // Секреты для зачистки вывода — из того же профиля, с которым идёт ход:
  // пустой список пропускал ключ в stdout и в --log (break-5 Н9).
  let secrets = []
  try { secrets = secretValues(JSON.parse(fs.readFileSync(path.join(sourceProfile, '1code-settings.json'), 'utf8'))) } catch { /* профиль не читается — маскирует сам провайдер */ }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const name of Object.keys(env)) if (/^ONECODE_(SMOKE|SHOT|ARG|CLI_|TEST_)/.test(name)) delete env[name]
  let cancelled = false, timedOut = false, child, stopPromise
  const stop = () => {
    if (!child?.pid || child.exitCode !== null || stopPromise) return stopPromise
    stopPromise = new Promise(resolve => {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        const fallback = () => { try { child.kill() } catch {}; resolve() }
        const deadline = setTimeout(() => { try { killer.kill() } catch {}; fallback() }, 10000)
        killer.once('error', () => { clearTimeout(deadline); fallback() })
        killer.once('close', code => { clearTimeout(deadline); if (code !== 0) fallback(); else resolve() })
      } else { try { child.kill('SIGTERM') } catch {}; resolve() }
    })
    return stopPromise
  }
  const interrupt = () => { cancelled = true; stop() }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  let code = EXIT.TURN_FAILED
  try {
    child = spawn(engine.binary, [...engine.args, '--onlyone-cli=' + job.dir, '--user-data-dir=' + path.join(job.dir, 'profile')], { cwd: engine.cwd, env, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { timedOut = true; stop() }, 240000)
    let startError = false
    await new Promise(resolve => { child.once('error', () => { startError = true; resolve() }); child.once('close', resolve) })
    clearTimeout(timer)
    if (stopPromise) await stopPromise
    if (cancelled) { error('Работа отменена.'); code = EXIT.ABORTED }
    else if (timedOut || startError) error(timedOut ? 'Время работы CLI истекло.' : 'Не удалось запустить приложение.')
    else {
      let verdict
      try { verdict = JSON.parse(fs.readFileSync(path.join(job.dir, 'result.json'), 'utf8')) } catch { error('Приложение не вернуло результат CLI.'); return code }
      const outcome = outcomeOf({ ...verdict, readOnly: !parsed.allowWrite })
      const text = redact(lineFor(outcome), secrets)
      if (outcome.code === EXIT.OK) say(text); else error(text)
      code = outcome.code
      if (parsed.log) {
        try { fs.mkdirSync(path.dirname(path.resolve(parsed.log)), { recursive: true }); fs.appendFileSync(parsed.log, JSON.stringify({ at: Date.now(), code, answer: text }) + '\n', { mode: 0o600 }) }
        catch { error('Не удалось записать журнал CLI.'); if (code === EXIT.OK) code = EXIT.TURN_FAILED }
      }
    }
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    try { cleanup(job.dir) } catch { error('Не удалось удалить временный профиль CLI.'); if (code === EXIT.OK) code = EXIT.TURN_FAILED }
  }
  return code
}
module.exports = { main, defaultProfile }
