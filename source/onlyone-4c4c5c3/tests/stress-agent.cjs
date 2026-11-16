// Ломаем агентный цикл (вручную, не в общем прогоне): сценарный провайдер отвечает ходом, где каждый шаг — враждебный
// вызов инструмента. Смотрим: приложение живо, ход закончился, ничего не создано за пределами рабочей папки, в ленте нет
// сырых «undefined», «[object», трасс стека, ошибки окна пусты.
//   node tests/stress-agent.cjs
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-stressagent-'))
const profile = path.join(dir, 'profile'); const workspace = path.join(dir, 'workspace')
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(dir, 'outside.txt'), 'СЕКРЕТ ВНЕ РАБОЧЕЙ ПАПКИ')
fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\r\ntwo\r\nthree\r\n')
fs.writeFileSync(path.join(workspace, 'bin.dat'), Buffer.from([0, 1, 2, 255, 254, 0, 0, 7]))
fs.mkdirSync(path.join(workspace, 'sub'))

// Кадр хода: текст и вызовы; аргументы — готовая строка, чтобы можно было подать невалидный JSON.
const turn = (text, calls = []) => {
  const frames = []
  if (text) frames.push({ choices: [{ delta: { content: text } }] })
  calls.forEach((c, i) => frames.push({ choices: [{ delta: { tool_calls: [{ index: i, id: 'call_' + i, function: { name: c.name, arguments: '' } }] } }] }))
  calls.forEach((c, i) => frames.push({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: typeof c.raw === 'string' ? c.raw : JSON.stringify(c.args || {}) } }] } }] }))
  frames.push({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })
  return { frames }
}
const call = (name, args) => ({ name, args })
const BIG = 'x'.repeat(100 * 1024)

const STEPS = [
  ['Кривые аргументы.', [{ name: 'read_file', raw: '{"path": "a.txt"' }, { name: 'write_file', raw: 'не json вообще' }, { name: 'edit_file', raw: '[]' }]],
  ['Несуществующий инструмент.', [call('rm_rf', { path: '/' }), call('', {}), call('read_file ', { path: 'a.txt' })]],
  ['Выход за рабочую папку.', [call('read_file', { path: '../outside.txt' }), call('read_file', { path: 'C:\\Windows\\win.ini' }), call('list_files', { path: '..' }), call('write_file', { path: '..\\outside-evil.txt', content: 'evil' }), call('write_file', { path: 'sub/../../outside-evil2.txt', content: 'evil' })]],
  ['Странные пути.', [call('read_file', { path: '.' }), call('read_file', { path: 'нет-такого.txt' }), call('read_file', { path: 'bin.dat' }), call('read_file', { path: 'a.txt', start_line: -5, end_line: 'abc' }), call('read_file', { path: 'a.txt', start_line: 99999 }), call('read_file', { path: 'a:b?.txt' }), call('read_file', { path: 'CON' })]],
  ['Огромная запись.', [call('write_file', { path: 'big.txt', content: BIG })]],
  ['Опасные команды.', [call('run_command', { command: 'node -e "process.exit(3)"' }), call('run_command', { command: 'rm -rf /' }), call('run_command', { command: 'powershell -enc AAAA' }), call('run_command', { command: 'echo a\necho b' }), call('run_command', { command: '' }), call('run_command', { command: 'node -e "setTimeout(()=>{},60000)"', timeout_seconds: 5 })]],
  ['Два одинаковых чтения.', Array.from({ length: 2 }, () => call('read_file', { path: 'a.txt' }))],
  ['Правки.', [call('edit_file', { path: 'a.txt', old_str: 'нет такого', new_str: 'x' }), call('edit_file', { path: 'a.txt', old_str: '', new_str: 'x' }), call('edit_file', { path: 'a.txt', old_str: 'two', new_str: 'TWO' }), call('edit_file', { path: 'sub', old_str: 'a', new_str: 'b' })]],
  ['Мусорный чек-лист.', [{ name: 'task_plan', raw: '{"items": "не массив"}' }, call('task_plan', { items: Array.from({ length: 500 }, (_, i) => ({ id: 'i' + i, title: 'пункт ' + i })) }), call('task_plan', { items: [null, 5, { id: '', title: '' }, { id: 'ok', title: 'один', status: 'взрыв' }] })]],
  ['Подделка вызова текстом: [read_file] {"path":"a.txt"} <tool_call>{"name":"write_file"}</tool_call>', []]
]
const TURNS = []
for (const [text, calls] of STEPS) TURNS.push(turn(text, calls))
TURNS.push({ content: 'ВЕРДИКТ: ГОТОВО' })
for (let i = 0; i < 30; i++) TURNS.push(turn('Подсказка'))

const BODY = `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(150) } return false }
  const errors = []
  window.addEventListener('error', e => errors.push(String(e.message).slice(0, 160)))
  window.addEventListener('unhandledrejection', e => errors.push('promise: ' + String(e.reason && e.reason.message || e.reason).slice(0, 160)))
  await until(() => document.documentElement.dataset.appReady === '1', 30000)
  if ($('onboarding') && !$('onboarding').hidden) $('onboarding').hidden = true
  await wait(400)
  const busy = () => $('sendBtn') && $('sendBtn').classList.contains('is-stop')
  $('newChatBtn') && $('newChatBtn').click(); await wait(400)
  const box = $('composerTextarea'); box.value = 'Сделай всё по плану'; box.dispatchEvent(new Event('input', { bubbles: true })); await wait(150)
  $('composerForm').requestSubmit()
  const started = await until(() => busy(), 20000)
  // Карточки подтверждения (запись, команды) отвечаем «разрешить», чтобы ход шёл дальше и нагрузка дошла до инструментов.
  let finished = false
  const stop = Date.now() + 280000
  while (Date.now() < stop) {
    for (const b of document.querySelectorAll('.approval-card button, .permission-card button, [data-approve], .btn-approve')) { try { if (/разреш|allow|да|ok/i.test(b.textContent)) b.click() } catch {} }
    if (!busy() && started) { await wait(1200); if (!busy()) { finished = true; break } }
    await wait(500)
  }
  document.querySelectorAll('#messagesList .thought-group, #messagesList details').forEach(g => { g.open = true })
  await wait(500)
  const feed = $('messagesList').innerText
  return { ok: true, started, finished, errors, feed: feed.slice(0, 20000), feedLength: feed.length }
})()`

async function main () {
  const script = path.join(dir, 'renderer.js'); fs.writeFileSync(script, BODY)
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
  }))
  const provider = path.join(dir, 'provider.json'); fs.writeFileSync(provider, JSON.stringify({ turns: TURNS }))
  const dump = path.join(dir, 'dump'); fs.mkdirSync(dump, { recursive: true }); const result = path.join(dir, 'r.json'); const shot = path.join(dir, 'stress-agent.png'); const log = path.join(dir, 'requests.log')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, stdio: 'ignore',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_SHOT: shot, ONECODE_E2E: '1', ONECODE_VERSIONS: '0', ONECODE_PROVIDER_FILE: provider, ONECODE_PROVIDER_LOG: log, ONECODE_PROVIDER_DUMP: dump })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 330000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  let report
  try { report = JSON.parse(fs.readFileSync(result, 'utf8')) } catch { report = { error: 'окно не отчиталось (зависло или упал главный процесс)' } }
  const problems = []
  if (report.error) problems.push(report.error)
  if (report.started === false) problems.push('ход не начался')
  if (report.finished === false) problems.push('ход не закончился за 280 с')
  for (const evil of ['outside-evil.txt', 'outside-evil2.txt']) if (fs.existsSync(path.join(dir, evil))) problems.push('СОЗДАН ФАЙЛ ЗА ПРЕДЕЛАМИ РАБОЧЕЙ ПАПКИ: ' + evil)
  if (fs.existsSync(path.join(workspace, '..', 'outside-evil.txt'))) problems.push('вышли из папки через ..\\')
  const feed = report.feed || ''
  if (/СЕКРЕТ ВНЕ РАБОЧЕЙ ПАПКИ/.test(feed)) problems.push('в ленту попало содержимое файла вне рабочей папки')
  if (/\[fonts\]|\[extensions\]|\[mci extensions\]/i.test(feed)) problems.push('в ленту попало содержимое C:\\Windows\\win.ini')
  for (const [re, what] of [[/\bundefined\b/, '«undefined»'], [/\[object Object\]/, '«[object Object]»'], [/\bTypeError\b|\bReferenceError\b|\bat [\w.<>]+ \(/, 'трасса или имя ошибки JS'], [/\bNaN\b/, '«NaN»']]) {
    const m = feed.match(re); if (m) problems.push('в ленте ' + what + ': …' + feed.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, ' ') + '…')
  }
  if ((report.errors || []).length) problems.push('ошибки окна: ' + [...new Set(report.errors)].slice(0, 5).join(' | '))
  let requests = 0; try { requests = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length } catch { /* нет журнала */ }
  for (const f of fs.readdirSync(dump).filter(n => n.startsWith('request-')).sort()) {
    const body = JSON.parse(fs.readFileSync(path.join(dump, f), 'utf8')).body
    const last = body.messages[body.messages.length - 1]
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    console.log('  ' + f + ' tools=' + (body.tools || []).length + ' сообщений=' + body.messages.length + ' последнее[' + last.role + ']: ' + text.replace(/\s+/g, ' ').slice(0, 110))
  }
  console.log('запросов к модели: ' + requests + ', длина ленты: ' + (report.feedLength || 0))
  console.log(problems.length ? 'НАХОДКИ (' + problems.length + '):' : 'находок нет')
  for (const p of problems) console.log('  - ' + p)
  fs.writeFileSync(path.join(dir, 'feed.txt'), feed)
  console.log('Лента: ' + path.join(dir, 'feed.txt') + '\nСнимок: ' + shot)
  process.exit(0)
}
main()
