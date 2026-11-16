// «Текст в строке ввода пропадает при клике вне адресной строки» (план, 9.2 п.13).
//
// По коду обработчика blur у поля ввода нет: набранное очищается только при
// отправке. Проверка держит это поведение настоящим окном — набрать текст,
// открыть панель «Задачи», панель «Браузер», кликнуть по списку диалогов, по
// ленте сообщений, уйти на другую вкладку и вернуться, отдать и вернуть фокус
// окну — и каждый раз смотреть на значение поля, а не на память о коде.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-composer-keeps-text')
const profile = path.join(out, 'profile'); const workspace = path.join(out, 'workspace')
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
}))
const script = path.join(out, 'renderer.js')
const resultFile = path.join(out, 'result.json')
fs.writeFileSync(script, `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(100) } return false }
  const checks = []
  const note = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  await until(() => document.documentElement.dataset.appReady === '1', 30000)
  if ($('onboarding') && !$('onboarding').hidden) $('onboarding').hidden = true
  await wait(400)

  const TEXT = 'черновик, который не должен пропасть'
  const box = () => $('composerTextarea')
  const type = text => { const b = box(); b.value = text; b.dispatchEvent(new Event('input', { bubbles: true })) }
  const value = () => box().value
  const intact = label => note(label, value() === TEXT, JSON.stringify(value()))

  $('newChatBtn') && $('newChatBtn').click(); await wait(500)
  type(TEXT); box().focus(); await wait(200)
  intact('текст набран и лежит в поле')

  // Правая панель «Задачи» открывается и закрывается поверх чата.
  $('navTasks').click(); await wait(800)
  intact('панель «Задачи» открыта: текст на месте')
  $('navTasks').click(); await wait(600)
  intact('панель «Задачи» закрыта: текст на месте')

  // Панель «Браузер» — вторая панель у того же края.
  $('openBrowserBtn').click(); await wait(1000)
  intact('панель «Браузер» открыта: текст на месте')
  $('openBrowserBtn').click(); await wait(600)
  intact('панель «Браузер» закрыта: текст на месте')

  // Клик мимо поля: список диалогов, лента сообщений, вкладки.
  $('chatHistoryList')?.click(); await wait(400)
  intact('клик по списку диалогов: текст на месте')
  box().blur(); await wait(300)
  intact('поле потеряло фокус по blur: текст на месте')
  $('messagesList')?.click(); await wait(400)
  intact('клик по ленте сообщений: текст на месте')
  $('navProjects').click(); await wait(500)
  $('navChats').click(); await wait(600)
  intact('уход на «Проекты» и назад: текст на месте')

  // Окно ушло на второй план и вернулось — тот же случай «клик вне окна».
  window.dispatchEvent(new Event('blur')); await wait(300)
  intact('окно потеряло фокус: текст на месте')
  window.dispatchEvent(new Event('focus')); await wait(300)
  intact('окно вернуло фокус: текст на месте')

  return { ok: checks.every(c => c.pass), checks }
})()`)
spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
  cwd: root, timeout: 240000, stdio: 'ignore',
  env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_SHOT: path.join(out, 'shot.png') })
})
const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { ok: false, checks: [], error: 'окно не отчиталось' }
if (report.error) console.error('ПРОВАЛ: ' + report.error)
for (const c of report.checks || []) console.log((c.pass ? '  ok     ' : '  ПРОВАЛ ') + c.label + (c.detail ? ' — ' + c.detail : ''))
console.log(report.ok ? 'Строка ввода: текст переживает клики вне поля' : 'Строка ввода: есть провалы')
settleRun(out, report.ok)
process.exit(report.ok ? 0 : 1)
