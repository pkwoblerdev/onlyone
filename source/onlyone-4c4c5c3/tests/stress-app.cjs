// Ломаем приложение (вручную, не в общем прогоне): настоящее окно, свежий профиль, сценарный провайдер.
// Ввод: пустой, пробельный, огромный, с разметкой, с длинными словами; ответ: длинное слово без пробелов, широкая таблица
// и код, глубокие списки; двойная отправка; уход из чата посреди хода; узкие окна; спам настроек.
// Печатает находки, ничего не утверждает (код выхода 0): их разбирают глазами, потом каждая находка становится тестом.
//   node tests/stress-app.cjs [папка для снимков]
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const target = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-stress-'))
fs.mkdirSync(target, { recursive: true })

const LONG_WORD = 'Супердлинноесловобезпробеловкотороенеумещаетсявстрокучатаи'.repeat(12)
const WIDE_TABLE = '| ' + Array.from({ length: 14 }, (_, i) => 'Колонка' + i).join(' | ') + ' |\n| ' + Array.from({ length: 14 }, () => '---').join(' | ') + ' |\n| ' + Array.from({ length: 14 }, (_, i) => 'значение-' + i + '-длинное').join(' | ') + ' |'
const WIDE_CODE = '```js\n' + 'const x = ' + '"' + 'очень-длинная-строка-кода-'.repeat(20) + '"\n```'
const NESTED = Array.from({ length: 12 }, (_, i) => '  '.repeat(i) + '- уровень ' + (i + 1) + ' и немного текста для переноса строки').join('\n')
const HTML_BAIT = '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1<\/script> [x](javascript:window.__pwned=1) **жирный**'

const turns = text => ({ text })
const REPLIES = [
  turns('Ответ с длинным словом: ' + LONG_WORD),
  turns('Таблица:\n\n' + WIDE_TABLE + '\n\nКод:\n\n' + WIDE_CODE),
  turns('Вложенные списки:\n\n' + NESTED),
  turns('Разметка: ' + HTML_BAIT),
  turns('Обычный ответ.')
]
const FILLER = Array.from({ length: 40 }, () => turns('Подсказка'))

const BODY = `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(120) } return false }
  const findings = []
  const info = []
  const note = (scene, problem) => findings.push(scene + ': ' + problem)
  const errors = []
  window.addEventListener('error', e => errors.push(String(e.message).slice(0, 140)))
  window.addEventListener('unhandledrejection', e => errors.push('promise: ' + String(e.reason && e.reason.message || e.reason).slice(0, 140)))
  await until(() => document.documentElement.dataset.appReady === '1', 30000)
  if ($('onboarding') && !$('onboarding').hidden) $('onboarding').hidden = true
  await wait(400)
  const busy = () => $('sendBtn') && $('sendBtn').classList.contains('is-stop')
  const idle = () => until(() => !busy(), 25000)
  const type = text => { const box = $('composerTextarea'); box.value = text; box.dispatchEvent(new Event('input', { bubbles: true })) }
  const submit = () => $('composerForm').requestSubmit()
  const newChat = async () => { $('newChatBtn') && $('newChatBtn').click(); await wait(400) }
  const userMessages = () => document.querySelectorAll('#messagesList .msg-item.user, #messagesList [data-role="user"]').length
  const overflowX = scene => {
    const w = innerWidth
    if (document.documentElement.scrollWidth > w + 2) note(scene, 'страница шире окна: ' + document.documentElement.scrollWidth + ' > ' + w)
    const feed = $('chatFeed') || $('messagesList')
    const box = feed && feed.getBoundingClientRect()
    const bad = []
    if (box) for (const n of document.querySelectorAll('#messagesList *')) {
      const r = n.getBoundingClientRect()
      if (r.width && r.right > box.right + 3 && getComputedStyle(n).position !== 'fixed' && !n.closest('pre, .table-wrap, table, .code-block, [data-scroll]')) bad.push((n.className || n.tagName).toString().slice(0, 40))
      if (bad.length >= 4) break
    }
    if (bad.length) note(scene, 'выступает за ленту: ' + bad.join(' | '))
    const comp = document.querySelector('.composer-container'); const ct = comp && comp.getBoundingClientRect()
    if (ct && (ct.right > w + 1 || ct.left < -1)) note(scene, 'поле ввода выходит за окно: ' + Math.round(ct.left) + '..' + Math.round(ct.right))
  }

  // 1. Пустой и пробельный ввод не запускает ход.
  await newChat()
  type(''); submit(); await wait(500)
  if (busy()) note('пустой ввод', 'ход запустился')
  type('   \\n\\n  \\t '); submit(); await wait(500)
  if (busy()) note('пробельный ввод', 'ход запустился'); type('')

  // 2. Ответ с длинным словом, таблицей, кодом, списками, разметкой.
  for (const [i, name] of ['длинное слово', 'таблица и код', 'вложенные списки', 'разметка'].entries()) {
    await newChat()
    type('Покажи ' + name); submit()
    await until(() => busy(), 15000); await idle(); await wait(600)
    overflowX('ответ: ' + name)
    if (i === 0) {
    // 0. Самопроверка детектора: заведомо широкий блок в ленте обязан быть найден, иначе «находок нет» ничего не значит.
    {
    const probe = document.createElement('div'); probe.className = 'stress-probe'; probe.style.cssText = 'width:4000px;height:10px'
    $('messagesList').appendChild(probe)
    const had = findings.length; overflowX('самопроверка'); const caught = findings.length > had
    probe.remove(); findings.length = had
    info.push('детектор переполнения ловит заведомо широкий блок: ' + (caught ? 'да' : 'НЕТ — проверки ниже слепы'))
    }

    }
    info.push('ответ «' + name + '»: сообщений ' + document.querySelectorAll('#messagesList .msg-item').length + ', текст ленты ' + $('messagesList').innerText.length + ' знаков, начало «' + $('messagesList').innerText.slice(-60).replace(/\s+/g, ' ') + '»')
  }
  if (window.__pwned) note('разметка', 'выполнился код из ответа модели (XSS): window.__pwned=1')
  if (document.querySelector('#messagesList img[src="x"], #messagesList script')) note('разметка', 'в ленте остались <img src=x>/<script>')
  if (document.querySelector('#messagesList a[href^="javascript:"]')) note('разметка', 'ссылка javascript: осталась живой')

  // 3. Огромный ввод и длинное слово в сообщении человека.
  await newChat()
  const huge = 'слово '.repeat(40000)
  const t0 = performance.now(); type(huge); const tType = performance.now() - t0
  if (tType > 1500) note('огромный ввод', 'вставка 240 000 знаков держала окно ' + Math.round(tType) + ' мс')
  const ta = $('composerTextarea'); if (ta.getBoundingClientRect().height > innerHeight * 0.6) note('огромный ввод', 'поле ввода заняло ' + Math.round(ta.getBoundingClientRect().height) + ' px из ' + innerHeight)
  type(''); await wait(200)
  type(${JSON.stringify(LONG_WORD)}); submit(); await until(() => busy(), 15000); await idle(); await wait(500)
  overflowX('длинное слово от человека')

  // 4. Двойная отправка: два submit подряд — один ход.
  await newChat()
  const before = document.querySelectorAll('#messagesList .msg-item').length
  type('двойная отправка'); submit(); submit(); submit()
  await until(() => busy(), 15000); await idle(); await wait(500)
  const after = document.querySelectorAll('#messagesList .msg-item').length
  info.push('двойная отправка: ' + [...document.querySelectorAll('#messagesList .msg-item')].map(n => n.className.replace('msg-item ', '') + '«' + n.innerText.replace(/\s+/g, ' ').slice(0, 40) + '»').join(' | '))
  if (after - before > 2) note('двойная отправка', 'сообщений прибавилось ' + (after - before) + ' вместо 2')

  // 5. Уход из чата посреди хода и возврат.
  await newChat()
  type('уходим посреди хода'); submit(); await until(() => busy(), 15000)
  $('newChatBtn') && $('newChatBtn').click(); await wait(300)
  const first = document.querySelector('#chatHistory .history-item, .history-item'); first && first.click(); await wait(400)
  await idle(); await wait(400)
  if (busy()) note('уход из чата', 'ход завис после возврата')

  // 6. Узкие окна.
  for (const [w, h] of [[900, 600], [700, 560], [560, 520], [1240, 800]]) {
    window.resizeTo(w, h); await until(() => Math.abs(innerWidth - w) < 40, 4000); await wait(500)
    overflowX('окно ' + w + 'x' + h)
    const send = $('sendBtn') && $('sendBtn').getBoundingClientRect()
    if (send && (send.right > innerWidth || send.bottom > innerHeight)) note('окно ' + w + 'x' + h, 'кнопка отправки за краем окна')
    const bar = document.querySelector('.composer-toolbar, .composer-actions')
    if (bar && bar.scrollWidth > bar.clientWidth + 2) note('окно ' + w + 'x' + h, 'панель поля ввода шире себя: ' + bar.scrollWidth + ' > ' + bar.clientWidth)
  }

  // 7. Спам настроек: открыть, пройти все вкладки, закрыть, 12 раз.
  for (let i = 0; i < 12; i++) {
    $('openSettingsBtn').click(); await wait(120)
    for (const t of document.querySelectorAll('.settings-nav-item')) { t.click(); await wait(25) }
    const close = document.querySelector('#settingsModal .modal-close, #settingsModal [data-close], #closeSettingsBtn'); close && close.click(); await wait(80)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }
  await wait(300)
  const openDialogs = [...document.querySelectorAll('.modal.is-open, .modal-backdrop.is-open, [role="dialog"]:not([hidden])')].filter(n => n.getBoundingClientRect().width > 0)
  info.push('открытых окон после спама настроек: ' + openDialogs.map(n => (n.id || n.className).toString().slice(0, 40)).join(', '))
  if (openDialogs.length > 1) note('спам настроек', 'окон открыто больше одного: ' + openDialogs.map(n => n.id || n.className).join(', '))

  if (errors.length) note('консоль', 'ошибки окна: ' + [...new Set(errors)].slice(0, 6).join(' | '))
  return { ok: true, findings, info, checks: findings.map(f => ({ label: f, pass: false })) }
})()`

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-stressrun-'))
  const profile = path.join(dir, 'profile'); const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
  }))
  const script = path.join(dir, 'renderer.js'); fs.writeFileSync(script, BODY)
  const provider = path.join(dir, 'provider.json')
  // Ответы идут по порядку; между ними — «подсказка» и название диалога, поэтому после каждого основного кладём запас.
  const list = []
  for (const reply of REPLIES) { list.push(reply); list.push(turns('Подсказка'), turns('Название')) }
  fs.writeFileSync(provider, JSON.stringify({ turns: [...list, ...FILLER] }))
  const result = path.join(dir, 'r.json'); const shot = path.join(target, 'stress-last.png')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, stdio: 'ignore',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_SHOT: shot, ONECODE_E2E: '1', ONECODE_VERSIONS: '0', ONECODE_PROVIDER_FILE: provider })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 420000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  let report
  try { report = JSON.parse(fs.readFileSync(result, 'utf8')) } catch { report = { error: 'окно не отчиталось' } }
  if (report.error) console.log('ПРОВАЛ: ' + report.error)
  const found = report.findings || []
  console.log(found.length ? 'НАХОДКИ (' + found.length + '):' : 'находок нет')
  for (const f of found) console.log('  - ' + f)
  for (const i of report.info || []) console.log('  · ' + i)
  console.log('Снимок: ' + shot)
  process.exit(0)
}
main()
