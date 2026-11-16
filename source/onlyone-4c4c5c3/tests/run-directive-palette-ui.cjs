// Палитра директив в настоящем окне (12.10.2026): «.» открывает меню директив, «/» — команд, обычный текст меню не
// открывает; «.plan» переключает режим на пилюле и «.plan off» возвращает его; директива не уходит моделью как сообщение.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-directive-palette')
const profile = path.join(out, 'profile'); const workspace = path.join(out, 'workspace')
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
}))
const providerFile = path.join(out, 'provider.json')
fs.writeFileSync(providerFile, JSON.stringify({ turns: Array.from({ length: 6 }, (_, i) => ({ text: 'Ответ ' + (i + 1) })) }))
const script = path.join(out, 'renderer.js')
const resultFile = path.join(out, 'result.json')
fs.writeFileSync(script, `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(100) } return false }
  const checks = []
  const note = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const errors = []
  window.addEventListener('error', e => errors.push(String(e.message).slice(0, 140)))
  window.addEventListener('unhandledrejection', e => errors.push('promise: ' + String(e.reason && e.reason.message || e.reason).slice(0, 140)))
  await until(() => document.documentElement.dataset.appReady === '1', 30000)
  if ($('onboarding') && !$('onboarding').hidden) $('onboarding').hidden = true
  await wait(400)
  $('newChatBtn') && $('newChatBtn').click(); await wait(400)
  const box = $('composerTextarea')
  const type = text => { box.value = text; box.dispatchEvent(new Event('input', { bubbles: true })) }
  const items = () => [...document.querySelectorAll('#slashMenuList .slash-menu-item')].map(n => n.textContent.replace(/\\s+/g, ' ').trim())
  const menuOpen = () => $('slashMenu') && getComputedStyle($('slashMenu')).display !== 'none' && items().length > 0
  const userMessages = () => document.querySelectorAll('#messagesList .msg-item.user').length

  type('.'); await wait(300)
  note('точка открывает меню директив', menuOpen(), items().join(' | '))
  note('в меню только директивы: .plan .compact .diff .sections .watch', items().length === 5 && items().every(t => /^\\./.test(t)), items().join(' | '))
  type('.pl'); await wait(250)
  note('фильтр по набранному: «.pl» — одна директива', items().length === 1 && /^\\.plan/.test(items()[0]), items().join(' | '))
  type('/'); await wait(250)
  note('косая черта открывает команды, а не директивы', menuOpen() && items().length >= 10 && items().every(t => /^\\//.test(t)), items().length + ' пунктов')
  type('привет'); await wait(250)
  note('обычный текст меню не открывает', !menuOpen(), items().join(' | '))
  type('.5 примеров'); await wait(250)
  note('«.5 примеров» — обычный текст, меню закрыто', !menuOpen())

  // .plan — выбором из меню и клавишей Enter: меню вставляет команду и выполняет её, Enter не должен переключить обратно.
  const label = () => ($('permModeLabel') && $('permModeLabel').textContent || '').trim()
  const before = label()
  type('.plan'); await wait(300)
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await wait(400)
  note('«.plan» включил режим плана на пилюле', /plan/i.test(label()), before + ' → ' + label())
  type('.plan'); $('composerForm').requestSubmit(); await wait(400)
  note('повторный «.plan» режим не переключает обратно', /plan/i.test(label()), label())
  note('директива не стала сообщением человека', userMessages() === 0, 'сообщений: ' + userMessages())
  type('.plan off'); $('composerForm').requestSubmit(); await wait(500)
  note('«.plan off» вернул прежний режим', label() === before, before + ' → ' + label())
  note('поле очищено после директивы', box.value === '', JSON.stringify(box.value))
  note('«off» не ушло моделью текстом', userMessages() === 0, 'сообщений: ' + userMessages())

  type('.watch'); $('composerForm').requestSubmit(); await wait(400)
  note('«.watch» без адреса — ничего не уходит', userMessages() === 0)
  type('.diff'); $('composerForm').requestSubmit(); await wait(400)
  note('«.diff» без правок — сообщения нет', userMessages() === 0)

  // Обычное сообщение по-прежнему идёт.
  type('Привет, это обычное сообщение'); $('composerForm').requestSubmit()
  note('обычное сообщение уходит', await until(() => userMessages() === 1, 15000), 'сообщений: ' + userMessages())
  note('ошибок в окне нет', !errors.length, errors.join(' | ') || 'нет')
  return { ok: checks.every(c => c.pass), checks }
})()`)
spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
  cwd: root, timeout: 240000, stdio: 'ignore',
  env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_SHOT: path.join(out, 'shot.png') })
})
const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { ok: false, checks: [], error: 'окно не отчиталось' }
if (report.error) console.error('ПРОВАЛ: ' + report.error)
for (const c of report.checks || []) console.log((c.pass ? '  ok     ' : '  ПРОВАЛ ') + c.label + (c.detail ? ' — ' + c.detail : ''))
console.log(report.ok ? 'Палитра директив в окне: проверки пройдены' : 'Палитра директив в окне: есть провалы')
settleRun(out, report.ok)
process.exit(report.ok ? 0 : 1)
