// Длинный чат в настоящем окне (12.10.2026, вручную, вне npm test): сеем диалоги на 300 и 1000 сообщений с разметкой
// и кодом, открываем, листаем, печатаем, добавляем ответ. Печатает миллисекунды: нужна ли виртуализация ленты (Д-3 плана).
//   node tests/stress-long-chat.cjs
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-long-chat')
const profile = path.join(out, 'profile'); const workspace = path.join(out, 'workspace')
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
}))
const providerFile = path.join(out, 'provider.json')
fs.writeFileSync(providerFile, JSON.stringify({ turns: Array.from({ length: 6 }, (_, i) => ({ text: 'Новый ответ в длинном чате ' + (i + 1) })) }))

const PRELUDE = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 60000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(20) } return false }
  await until(() => document.documentElement.dataset.appReady === '1', 30000)
  if ($('onboarding') && !$('onboarding').hidden) $('onboarding').hidden = true
  await wait(500)
`
function launch (name, body, { timeout = 240000, report = true } = {}) {
  const script = path.join(out, name + '.js'); const result = path.join(out, name + '.json')
  fs.writeFileSync(script, `(async () => {${PRELUDE}${body}})()`)
  spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout, stdio: 'ignore',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_SHOT: path.join(out, name + '.png') })
  })
  return report && fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : null
}

const SIZES = [300, 1000, 3000]
// 1. Засев: страница после перезагрузки умирает вместе со скриптом и отчёта не даёт — прогон обрывается по таймауту.
launch('seed', `
  const sizes = ${JSON.stringify(SIZES)}
  const chats = sizes.map(n => {
    const messages = []
    for (let i = 0; i < n; i++) {
      messages.push(i % 2
        ? { role: 'assistant', content: 'Ответ ' + i + ': **важное** и \`код\`.\\n\\n- пункт один\\n- пункт два\\n\\n\`\`\`js\\nfunction f' + i + '() { return ' + i + ' }\\n\`\`\`\\n\\n' + 'Подробности разбора. '.repeat(25), timestamp: Date.now() - (n - i) * 1000 }
        : { role: 'user', content: 'Вопрос ' + i + ': ' + 'уточнение по задаче '.repeat(6), timestamp: Date.now() - (n - i) * 1000 })
    }
    return { id: 'chat-' + n, title: 'Длинный чат ' + n, messages, createdAt: Date.now() - 60000, updatedAt: Date.now() - n }
  })
  await window.electronAPI.setConversations(chats)
  location.reload()
  await wait(20000)
`, { timeout: 40000, report: false })

// 2. Замеры
const report = launch('measure', `
  const results = []
  const items = () => [...document.querySelectorAll('#chatHistory .history-item, .history-item')]
  for (const n of ${JSON.stringify(SIZES)}) {
    const item = items().find(el => el.textContent.includes('Длинный чат ' + n))
    if (!item) { results.push({ n, error: 'чат не найден в списке' }); continue }
    const bubbles = () => document.querySelectorAll('#messagesList .msg-item').length
    const title = () => (($('chatHeaderTitle') || {}).textContent || '')
    // Открытие меряется до момента, когда в шапке названия нужного чата и лента перестала расти.
    if (title().includes('Длинный чат ' + n)) { document.querySelector('#newChatBtn') && document.querySelector('#newChatBtn').click(); await wait(500) }
    const t0 = performance.now()
    const target = item.querySelector('.history-item-title') || item
    target.click()
    await until(() => title().includes('Длинный чат ' + n) && bubbles() > 0, 60000)
    let last = -1
    while (bubbles() !== last) { last = bubbles(); await wait(150) }
    const firstPaint = performance.now() - t0
    await wait(800)
    const settled = performance.now() - t0 - 800
    const feed = $('chatFeed') || $('messagesList')
    const t1 = performance.now(); feed.scrollTop = feed.scrollHeight; await new Promise(r => requestAnimationFrame(() => r())); const scroll = performance.now() - t1
    const box = $('composerTextarea')
    const t2 = performance.now(); box.value = 'печатаю в длинном чате'; box.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => requestAnimationFrame(() => r())); const typing = performance.now() - t2
    box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }))
    const before = bubbles()
    const t3 = performance.now(); box.value = 'Ещё вопрос'; box.dispatchEvent(new Event('input', { bubbles: true })); $('composerForm').requestSubmit()
    await until(() => bubbles() >= before + 2, 60000)
    const append = performance.now() - t3
    await until(() => !($('sendBtn') && $('sendBtn').classList.contains('is-stop')), 60000)
    results.push({ n, bubbles: before, opened: title().includes('Длинный чат ' + n), firstPaint: Math.round(firstPaint), settled: Math.round(settled), scroll: Math.round(scroll), typing: Math.round(typing), append: Math.round(append), domNodes: document.querySelectorAll('#messagesList *').length, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null })
  }
  return { ok: true, results }
`)
if (!report || !report.results) { console.error('ПРОВАЛ: окно не отчиталось'); process.exit(1) }
for (const r of report.results) {
  if (r.error) { console.log(r.n + ': ' + r.error); continue }
  const slow = ['firstPaint', 'typing', 'append'].filter(k => r[k] > 700).map(k => k + '=' + r[k] + ' мс')
  console.log(`${String(r.n).padStart(5)} сообщений, нарисовано ${r.bubbles}, открыт нужный чат: ${r.opened} (${r.domNodes} узлов, куча ${r.heapMB} МБ): открытие ${r.firstPaint} мс (устоялось ${r.settled}), прокрутка ${r.scroll} мс, ввод ${r.typing} мс, новое сообщение ${r.append} мс` + (slow.length ? '  ← МЕДЛЕННО: ' + slow.join(', ') : ''))
}
settleRun(out, true)
