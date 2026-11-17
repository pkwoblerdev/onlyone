// «Пустой новый чат остаётся в списке» (план, 9.2 п.18).
//
// По коду пустой чат убирается при уходе из него (`selectChat` зовёт
// `dropEmptyChats`), а второе «Новый чат» переиспользует уже открытую пустую
// заготовку (`createNewChat`). Оконного теста именно на уход из пустого чата не
// было — здесь он есть: чат с сообщением, уход в пустой и обратно, двойное
// «Новый чат». Смотрим на настоящий список диалогов в окне.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-empty-chat')
const profile = path.join(out, 'profile'); const workspace = path.join(out, 'workspace')
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
}))
const providerFile = path.join(out, 'provider.json')
fs.writeFileSync(providerFile, JSON.stringify({ turns: [{ text: 'Ответ 1' }] }))
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

  const rows = () => [...document.querySelectorAll('#chatHistoryList .history-item')]
  const titles = () => rows().map(r => (r.querySelector('.history-item-title') || {}).textContent || '')
  const blanks = () => titles().filter(t => t === 'Новый диалог').length
  const busy = () => $('sendBtn') && $('sendBtn').classList.contains('is-stop')

  // Чат с настоящим ходом: пустым его уже не назовут.
  $('newChatBtn').click(); await wait(500)
  const box = $('composerTextarea')
  box.value = 'первое сообщение в чате'; box.dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()
  await until(() => busy(), 15000); await until(() => !busy(), 25000); await wait(1500)
  note('чат с сообщением в списке один', rows().length === 1, 'строк: ' + rows().length + ' — ' + titles().join(' | '))

  // Уходим в пустой и обратно — пустой не остаётся историей.
  $('newChatBtn').click(); await wait(600)
  note('новый чат открыт: строк стало две, одна пустая', rows().length === 2 && blanks() === 1,
    'строк: ' + rows().length + ', пустых: ' + blanks())
  const withMessage = rows().find(r => (r.querySelector('.history-item-title') || {}).textContent?.includes('первое сообщение'))
  withMessage?.querySelector('.history-item-title')?.click()
  await wait(800)
  note('ушли из пустого — он исчез из списка', rows().length === 1 && blanks() === 0,
    'строк: ' + rows().length + ', пустых: ' + blanks() + ' — ' + titles().join(' | '))

  // Двойное «Новый чат» не плодит пустые: вторая заготовка переиспользует первую.
  $('newChatBtn').click(); await wait(500)
  $('newChatBtn').click(); await wait(500)
  note('двойное «Новый чат» — одна пустая заготовка', blanks() === 1 && rows().length === 2,
    'строк: ' + rows().length + ', пустых: ' + blanks() + ' — ' + titles().join(' | '))

  return { ok: checks.every(c => c.pass), checks }
})()`)
spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
  cwd: root, timeout: 240000, stdio: 'ignore',
  env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_SHOT: path.join(out, 'shot.png') })
})
const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { ok: false, checks: [], error: 'окно не отчиталось' }
if (report.error) console.error('ПРОВАЛ: ' + report.error)
for (const c of report.checks || []) console.log((c.pass ? '  ok     ' : '  ПРОВАЛ ') + c.label + (c.detail ? ' — ' + c.detail : ''))
console.log(report.ok ? 'Пустой чат: не остаётся в списке' : 'Пустой чат: есть провалы')
settleRun(out, report.ok)
process.exit(report.ok ? 0 : 1)
