// Окно, которое при запуске не получило переписку (25.10, 1.3.27 у владельца).
//
// Владелец открыл приложение и увидел пустоту: «Новый диалог», режим Manual,
// модель по умолчанию, ни одного проекта. Данные были целы — окно их просто
// не получило, и ничем об этом не сказало. Хуже того: если чтение отказало,
// а запись работает, первое же сохранение пустого «Нового диалога» легло бы
// поверх всей переписки.
//
// Прогон на настоящем окне: профиль засевается двумя чатами, потом окно
// запускается со сбоями чтения переписки (ONECODE_TEST_CONVERSATIONS_FAULTS,
// читается только из исходников):
//   A. один отказ — окно перезагружается само, чаты на месте, человек видит,
//      что была перезагрузка;
//   B. отказ и после перезагрузки — второй перезагрузки нет, видно
//      предупреждение, а переписка на диске не перезаписана;
//   C. нет ответа — то же, что A, по истечении срока ожидания.
// Окно ведётся по CDP: smoke-скрипт перезагрузку не переживает.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock } = require('./app-launch.cjs')
const history = require('./history-store.cjs')

const root = path.join(__dirname, '..')
const output = runDir('onlyone-boot-recovery')
const report = []
const line = (group, name, pass, detail) => report.push({ group, name, pass: Boolean(pass),
  detail: detail === undefined ? '' : String(detail) })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const TITLES = ['Переписка-А ' + process.pid, 'Переписка-Б ' + process.pid]

function seed(profile) {
  const script = path.join(profile, 'seed.js')
  const out = path.join(profile, 'seed.json')
  const now = Date.now()
  const chats = TITLES.map((title, i) => ({ id: `seed_${i}_${process.pid}`, title, projectId: null, createdAt: now - i, updatedAt: now - i,
    messages: [{ role: 'user', content: 'привет ' + i }, { role: 'assistant', content: 'ответ ' + i }] }))
  fs.writeFileSync(script, `(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const stop = Date.now() + 25000
    while (Date.now() < stop && document.documentElement.dataset.appReady !== '1') await wait(100)
    await window.electronAPI.setConversations(${JSON.stringify(chats)})
    await wait(1500)
    return { ok: true, checks: [] }
  })()`)
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
    { cwd: root, timeout: 120000, stdio: 'inherit', env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out }) })
  if (child.error) throw child.error
  return fs.existsSync(out)
}

async function cdpPage(port, ms) {
  const stop = Date.now() + ms
  while (Date.now() < stop) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find(t => t.type === 'page' && /index\.html/.test(t.url))
      if (page) return page
    } catch {}
    await sleep(200)
  }
  return null
}

// Одно соединение на всё время прогона: перезагрузка страницы его не рвёт.
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad })
  let id = 0
  const pending = new Map()
  ws.onmessage = m => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const evaluate = expr => new Promise(ok => {
    const n = ++id
    pending.set(n, r => ok(r.result && r.result.result ? r.result.result.value : undefined))
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  })
  return { evaluate, close: () => ws.close() }
}

const PROBE = `JSON.stringify({
  nav: (performance.getEntriesByType('navigation')[0] || {}).type,
  ready: document.documentElement.dataset.appReady === '1',
  titles: [...document.querySelectorAll('#chatHistoryList .history-item-title')].map(e => e.textContent.trim()),
  toast: (document.getElementById('toastNotification') || {}).textContent || '',
  warning: (() => { const w = document.getElementById('bootWarning'); return w && !w.hidden ? w.textContent.trim() : '' })()
})`

async function scenario(name, faults, waitMs, body) {
  const profile = path.join(output, name)
  fs.mkdirSync(profile, { recursive: true })
  line(name, 'профиль засеян двумя чатами', seed(profile))
  // Состояние читается хелпером: v1 — один файл, v2 — индекс и шарды.
  const before = history.historyDigest(profile)
  line(name, 'переписка лежит на диске до запуска со сбоем', Boolean(before), history.historyLayout(profile) || 'набора нет')

  acquireWindowLock()
  const port = 9500 + (process.pid % 400)
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port], { cwd: root, stdio: 'ignore',
    env: guiEnv({ ONECODE_TEST_CONVERSATIONS_FAULTS: faults }) })
  const seen = []
  try {
    const page = await cdpPage(port, 30000)
    line(name, 'окно открылось', Boolean(page))
    if (!page) return
    const cdp = await connect(page)
    const stop = Date.now() + waitMs
    while (Date.now() < stop) {
      const raw = await cdp.evaluate(PROBE).catch(() => undefined)
      if (raw) seen.push(JSON.parse(raw))
      await sleep(100)
    }
    cdp.close()
    await body({ seen, last: seen[seen.length - 1] || {}, profile, before })
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    await sleep(1500)
  }
}

;(async () => {
  await scenario('A-fail-once', 'fail', 20000, ({ seen, last }) => {
    line('A один отказ', 'окно перезагрузилось само', seen.some(s => s.nav === 'reload'), `nav: ${[...new Set(seen.map(s => s.nav))].join(',')}`)
    line('A один отказ', 'после перезагрузки оба чата в списке', TITLES.every(t => last.titles?.includes(t)), JSON.stringify(last.titles))
    line('A один отказ', 'человеку сказано, что окно перезагружалось', seen.some(s => /перезагруз/i.test(s.toast)),
      [...new Set(seen.map(s => s.toast).filter(Boolean))].join(' | '))
    line('A один отказ', 'предупреждения о недоступной переписке нет', !last.warning, last.warning)
  })

  await scenario('B-fail-twice', 'fail,fail', 14000, async ({ seen, last, profile, before }) => {
    const reloads = seen.filter((s, i) => s.nav === 'reload' && seen[i - 1]?.nav !== 'reload').length
    line('B отказ дважды', 'перезагрузка ровно одна, без цикла', reloads === 1, `перезагрузок: ${reloads}`)
    line('B отказ дважды', 'видно предупреждение', /не загрузил/i.test(last.warning || ''), last.warning)
    line('B отказ дважды', 'пустой «Новый диалог» не записан поверх переписки',
      history.historyDigest(profile) === before, String(history.historyDigest(profile)))
  })

  await scenario('C-hang-once', 'hang', 30000, ({ seen, last }) => {
    line('C нет ответа', 'окно перезагрузилось само', seen.some(s => s.nav === 'reload'))
    line('C нет ответа', 'после перезагрузки оба чата в списке', TITLES.every(t => last.titles?.includes(t)), JSON.stringify(last.titles))
  })

  const failed = report.filter(r => !r.pass)
  for (const r of report) console.log(`${r.pass ? '  ok ' : 'ПРОВАЛ'} [${r.group}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
  console.log(`окно без переписки при запуске — проверок ${report.length}, не прошло ${failed.length}`)
  settleRun(output, failed.length === 0)
  process.exit(failed.length ? 1 : 0)
})().catch(error => { console.error(error); settleRun(output, false); process.exit(1) })
