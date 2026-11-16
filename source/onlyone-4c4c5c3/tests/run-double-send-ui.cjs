// Двойная отправка (11.10.2026, находка stress-app): пока `attachPathsFromText` ждёт, `pane.preparing` уже истина, а поле
// ввода ещё не очищено. Второй submit с тем же текстом принимался за «уточнение» и вставал в очередь, после ответа уходил
// вторым платным ходом: у человека — дубль сообщения, у провайдера — вдвое больше запросов. Быстрый двойной Enter или клик
// по кнопке — обычное дело. Настоящее окно, настоящий обработчик формы.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-double-send')
const profile = path.join(out, 'profile'); const workspace = path.join(out, 'workspace')
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
}))
const providerFile = path.join(out, 'provider.json')
fs.writeFileSync(providerFile, JSON.stringify({ turns: Array.from({ length: 12 }, (_, i) => ({ text: 'Ответ ' + (i + 1) })) }))
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
  const busy = () => $('sendBtn') && $('sendBtn').classList.contains('is-stop')
  const type = text => { const box = $('composerTextarea'); box.value = text; box.dispatchEvent(new Event('input', { bubbles: true })) }
  const users = text => [...document.querySelectorAll('#messagesList .msg-item.user')].filter(n => n.innerText.includes(text)).length

  // IME Enter подтверждает символ и не отправляет сообщение или команду.
  type('未完成')
  const field = $('composerTextarea')
  let submits = 0
  const countSubmit = () => { submits++ }
  $('composerForm').addEventListener('submit', countSubmit)
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
  const legacy = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  Object.defineProperty(legacy, 'keyCode', { value: 229 })
  field.dispatchEvent(legacy)
  await wait(100)
  note('IME Enter не отправляет незавершённое сообщение', submits === 0 && field.value === '未完成')
  $('composerForm').removeEventListener('submit', countSubmit)

  // 1. Три submit подряд в одном такте: одно сообщение и один ход.
  $('newChatBtn') && $('newChatBtn').click(); await wait(400)
  type('двойная отправка один'); $('composerForm').requestSubmit(); $('composerForm').requestSubmit(); $('composerForm').requestSubmit()
  await until(() => busy(), 15000); await until(() => !busy(), 25000); await wait(1500)
  note('три submit подряд — одно сообщение человека', users('двойная отправка один') === 1, 'сообщений: ' + users('двойная отправка один'))
  note('очередь после хода пуста: второй ход не пошёл', !busy(), busy() ? 'ход идёт' : 'тихо')

  // 2. Другой текст, набранный пока идёт подготовка, по-прежнему встаёт в очередь (прежнее поведение не сломано).
  $('newChatBtn') && $('newChatBtn').click(); await wait(400)
  type('первое сообщение'); $('composerForm').requestSubmit()
  type('второе, уточняющее'); $('composerForm').requestSubmit()
  await until(() => busy(), 15000); await until(() => !busy(), 25000); await wait(2500); await until(() => !busy(), 25000)
  note('разные тексты — оба доходят', users('первое сообщение') === 1 && users('второе, уточняющее') === 1, users('первое сообщение') + '/' + users('второе, уточняющее'))
  return { ok: checks.every(c => c.pass), checks }
})()`)
spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
  cwd: root, timeout: 240000, stdio: 'ignore',
  env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_SHOT: path.join(out, 'shot.png') })
})
const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { ok: false, checks: [], error: 'окно не отчиталось' }
if (report.error) console.error('ПРОВАЛ: ' + report.error)
for (const c of report.checks || []) console.log((c.pass ? '  ok     ' : '  ПРОВАЛ ') + c.label + (c.detail ? ' — ' + c.detail : ''))
console.log(report.ok ? 'Двойная отправка: проверки пройдены' : 'Двойная отправка: есть провалы')
settleRun(out, report.ok)
process.exit(report.ok ? 0 : 1)
