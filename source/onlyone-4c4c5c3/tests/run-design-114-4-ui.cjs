// 1.14, часть 4 — счётчики панели живым окном (критика дизайн-системы: «в
// панели счётчики „0" у каждого раздела — шум → только не ноль»).
//
// Одно настоящее окно на пустом профиле: у разделов, где ничего нет, метки не
// должно быть вовсе, а там, где что-то есть, она обязана остаться и показать
// число. Кадр нужен потому, что «шум» — это как раз то, что видно глазами, а не
// то, что вычитается из исходника.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-design-114-4')
const evidence = process.env.ONECODE_EVIDENCE_DIR
  || path.join(root, 'audits', 'qoder-2-2026-09-28', 'design-114-4')
const profile = path.join(out, 'profile')
fs.mkdirSync(profile, { recursive: true })

const script = path.join(out, 'renderer.js')
const body = `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 30000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(100) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const shown = node => Boolean(node) && node.offsetParent !== null && !node.hidden
  const ids = __IDS__

  await until(() => document.documentElement.dataset.appReady === '1')
  await wait(2500)

  const zero = ids.filter(id => {
    const node = $(id)
    return node && !(Number(node.textContent) > 0)
  })
  const noisy = zero.filter(id => shown($(id)))
  note('пустые разделы панели не показывают счётчик', noisy.length === 0,
    'видно нули: ' + noisy.join(', '))
  note('не пустой раздел панели по-прежнему показывает число',
    ids.every(id => !(Number($(id).textContent) > 0) || shown($(id))),
    ids.map(id => id + '=' + $(id).textContent + (shown($(id)) ? '' : '(скрыт)')).join(' | '))
  const stray = [...document.querySelectorAll('.sidebar .badge-count')]
    .filter(node => shown(node) && !Number(node.textContent))
    .map(node => node.id + ':' + JSON.stringify(node.textContent))
  note('в панели нет пустой метки вместо числа', stray.length === 0, stray.join(' | '))
  note('разметка панели не стартует с нулями',
    [...document.querySelectorAll('.sidebar .badge-count')].every(node => node.textContent !== '0' || !shown(node)),
    [...document.querySelectorAll('.sidebar .badge-count')].map(node => node.id + '=' + node.textContent).join(' | '))
  return { ok: checks.every(c => c.pass), checks }
})()`
fs.writeFileSync(script, body.replace('__IDS__', JSON.stringify(
  ['projectsBadge', 'skillsBadge', 'designBadge', 'mcpBadge'])))

const resultFile = path.join(out, 'counters.json')
const shot = path.join(out, 'counters.png')
const child = spawnSync(electronBinary(),
  ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root, timeout: 240000, stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: script,
      ONECODE_SMOKE_OUT: resultFile,
      ONECODE_SHOT: shot
    })
  })
if (child.error) throw child.error
fs.mkdirSync(evidence, { recursive: true })
if (fs.existsSync(shot)) fs.copyFileSync(shot, path.join(evidence, 'counters.png'))
if (!fs.existsSync(resultFile)) {
  console.error(`Окно не отчиталось (код выхода ${child.status})`)
  settleRun(out, false)
  process.exitCode = 1
} else {
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error(`окно упало: ${report.error}`)
  for (const item of report.checks || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
  }
  console.log(`снимок: ${path.join(evidence, 'counters.png')}`)
  const ok = Boolean(report.ok) && (report.checks || []).length >= 4
  console.log(JSON.stringify({ ok, checks: (report.checks || []).length }))
  settleRun(out, ok)
  process.exitCode = ok ? 0 : 1
}
