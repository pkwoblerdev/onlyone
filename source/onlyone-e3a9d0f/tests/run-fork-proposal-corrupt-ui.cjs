'use strict'
// Red-team window probe: corrupted / hostile proposal ledgers, then a large
// ledger in its own launch. Real app, throw-away profile, window-test lock, no
// network. Seed and every probe are separate launches so one slow case cannot
// hide the others.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-fork-proposal-corrupt')
const profile = path.join(out, 'profile')
fs.mkdirSync(profile, { recursive: true })
const MANY = Number(process.env.RT_MANY || 300)
const report = []
const line = (name, pass, detail = '') => {
  report.push({ name, pass: Boolean(pass), detail: String(detail == null ? '' : detail).slice(0, 600) })
  console.log(`  ${pass ? 'ok ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

function launch (name, script, timeout = 240000) {
  const scriptFile = path.join(out, name + '.smoke.js')
  const outFile = path.join(out, name + '.json')
  fs.writeFileSync(scriptFile, script)
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile],
    { cwd: root, timeout, stdio: 'inherit', env: guiEnv({ ONECODE_SMOKE: scriptFile, ONECODE_SMOKE_OUT: outFile }) })
  if (child.error) throw child.error
  if (!fs.existsSync(outFile)) return { ok: false, error: 'no verdict, status ' + child.status + ' signal ' + child.signal }
  return JSON.parse(fs.readFileSync(outFile, 'utf8'))
}

const PRELUDE = `
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 60000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(100) } return false }
  const $ = id => document.getElementById(id)
  const hash = value => { const text = String(value); let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h.toString(16).padStart(8, '0') }
  const rev = (messages, end) => 'h:' + hash(JSON.stringify(messages.slice(0, end + 1)))
  const toasts = []
  window.__rtErrors = []
  addEventListener('error', e => window.__rtErrors.push(String(e.message || e.error)))
  addEventListener('unhandledrejection', e => window.__rtErrors.push('unhandled: ' + String(e.reason && (e.reason.stack || e.reason.message) || e.reason)))
`

const SEED = `(async () => {${PRELUDE}
  await until(() => document.documentElement.dataset.appReady === '1', 45000)
  const now = Date.now()
  const messages = [{ role: 'user', content: 'первый вопрос', timestamp: 1 }, { role: 'assistant', content: 'первый ответ', timestamp: 2 }]
  const record = (over = {}) => ({
    version: 1, operationId: 'fp_seed00001', parentChatId: 'p', title: 'Т', goal: 'Ц', reason: '',
    context: { mode: 'messages', end: 1, revision: rev(messages, 1), summary: '' },
    createdAt: now, updatedAt: now, status: 'pending', childChatId: null, decidedAt: null, ...over
  })
  const chats = []
  const add = (id, title, extra) => chats.push({ id, title, projectId: null, createdAt: now, updatedAt: now, messages: messages.map(m => ({ ...m })), ...extra })
  add('chatA', 'A corrupt-shape', { forkProposals: { 0: record({ parentChatId: 'chatA' }) } })
  add('chatB', 'B version2', { forkProposals: [{ ...record({ parentChatId: 'chatB', operationId: 'fp_v200001' }), version: 2 }] })
  add('chatC', 'C huge-text', { forkProposals: [record({ parentChatId: 'chatC', operationId: 'fp_huge001', title: 'ч'.repeat(1024 * 1024), goal: 'ц'.repeat(1024 * 1024), context: { mode: 'messages', end: 1, revision: rev(messages, 1), summary: '' } })] })
  add('chatD', 'D accepted-missing', { forkProposals: [record({ parentChatId: 'chatD', operationId: 'fp_orphan01', status: 'accepted', childChatId: 'gone', decidedAt: now })] })
  add('chatE', 'E legacy', { forkProposalDismissed: ['fp_legacy1'] })
  const many = []
  for (let i = 0; i < ${MANY}; i++) many.push(record({ parentChatId: 'chatF', operationId: 'fp_many' + String(i).padStart(6, '0') }))
  add('chatF', 'F many-${MANY}', { forkProposals: many })
  const proto = JSON.parse('{"__proto__":{"polluted":true},"version":1,"operationId":"fp_proto01","parentChatId":"chatG","title":"proto","goal":"proto","reason":"","context":{"mode":"messages","end":1,"revision":' + JSON.stringify(JSON.stringify(rev(messages, 1))) + ',"summary":""},"status":"pending"}')
  add('chatG', 'G proto', { forkProposals: [proto] })
  await window.electronAPI.setConversations(chats)
  const back = await window.electronAPI.getConversations()
  return { ok: back.length === chats.length, checks: [{ name: 'seeded chats', pass: back.length === chats.length, detail: back.map(c => c.id).join(',') }] }
})().catch(e => ({ ok: false, error: String(e && e.stack || e) }))`

const PROBE_CORRUPT = `(async () => {${PRELUDE}
  await until(() => document.documentElement.dataset.appReady === '1', 45000)
  const toastBox = $('toastNotification')
  if (toastBox) new MutationObserver(() => { const text = toastBox.textContent.trim(); if (text) toasts.push(text) }).observe(toastBox, { childList: true, characterData: true, subtree: true })
  await wait(1200)
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: String(detail == null ? '' : detail).slice(0, 500) })
  const titles = () => [...document.querySelectorAll('#chatHistoryList .history-item-title')]
  const byPrefix = prefix => titles().find(el => el.textContent.trim().startsWith(prefix + ' '))
  const cards = () => [...document.querySelectorAll('#messagesList .fork-proposal-card')]
  const ledger = async id => (await window.electronAPI.getConversations()).find(c => c.id === id)
  const showAll = () => { const button = document.querySelector('#chatHistoryList .history-view-all'); if (button) button.click() }
  const open = async id => {
    if (!byPrefix(id.slice(-1))) showAll()
    await wait(200)
    byPrefix(id.slice(-1))?.click()
    return until(() => $('messagesList')?.dataset.chatId === id, 25000)
  }
  const mark = () => toasts.length
  const since = m => toasts.slice(m)

  note('no global prototype pollution after reading proto ledger', String(({}).polluted) === 'undefined', String(({}).polluted))
  note('boot did not throw', window.__rtErrors.length === 0, JSON.stringify(window.__rtErrors.slice(0, 3)))

  // A: non-array ledger
  let m = mark(); const t0 = Date.now()
  const openedA = await open('chatA')
  await wait(1500)
  note('A corrupt-shape chat opens', openedA, Date.now() - t0 + ' ms')
  note('A corrupt-shape card is not shown', cards().length === 0, 'cards=' + cards().length)
  note('A corrupt-shape shows a visible warning', since(m).some(t => /не читаются/.test(t)) || toasts.some(t => /не читаются/.test(t)),
    JSON.stringify(toasts.slice(-8)))

  // B: version 2 ledger
  m = mark()
  const openedB = await open('chatB')
  await wait(800)
  note('B version-2 chat opens', openedB)
  note('B version-2 card is not shown', cards().length === 0, 'cards=' + cards().length)
  note('B version-2 warns', since(m).some(t => /не читаются/.test(t)), JSON.stringify(since(m)))

  // C: 1 MB title/goal
  const t1 = Date.now()
  const openedC = await open('chatC')
  const cardC = await until(() => cards().length === 1, 25000)
  const cTitle = cards()[0]?.querySelector('.fork-proposal-title')?.textContent || ''
  note('C 1MB title/goal chat opens with a card', openedC && cardC, Date.now() - t1 + ' ms')
  note('C over-limit record is clamped and rendered capped', cTitle.length > 0 && cTitle.length <= 200,
    'rendered title chars=' + cTitle.length)
  const cLedger = await ledger('chatC')
  note('C huge text survives the ledger untouched', cLedger?.forkProposals?.[0]?.title?.length === 1024 * 1024,
    String(cLedger?.forkProposals?.[0]?.title?.length))

  // D: accepted, child deleted
  const openedD = await open('chatD')
  await until(() => cards().length === 1, 25000)
  const cardD = cards()[0]
  note('D accepted card shows the child is gone', openedD && /Связанный чат удалён/.test(cardD?.textContent || ''), cardD?.textContent?.slice(-160))
  note('D accepted card cannot be clicked', Boolean(cardD?.querySelector('[data-action="accept"]')?.disabled))

  // E: legacy dismissal
  const openedE = await open('chatE')
  await wait(500)
  note('E legacy dismissed chat shows no cards', openedE && cards().length === 0, 'cards=' + cards().length)

  // G: prototype key record renders, no pollution
  const openedG = await open('chatG')
  const cardG = await until(() => cards().length === 1, 25000)
  note('G record with __proto__ key renders as a normal card', openedG && cardG, 'cards=' + cards().length)
  note('G global prototype still clean', String({}.polluted) === 'undefined', String({}.polluted))

  note('no page errors', window.__rtErrors.length === 0, JSON.stringify(window.__rtErrors.slice(0, 5)))
  return { ok: checks.every(c => c.pass), checks, toasts: toasts.slice(-20) }
})().catch(e => ({ ok: false, error: String(e && e.stack || e) }))`

const PROBE_MANY = `(async () => {${PRELUDE}
  await until(() => document.documentElement.dataset.appReady === '1', 45000)
  await wait(1000)
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: String(detail == null ? '' : detail).slice(0, 500) })
  const titles = () => [...document.querySelectorAll('#chatHistoryList .history-item-title')]
  const byPrefix = prefix => titles().find(el => el.textContent.trim().startsWith(prefix + ' '))
  const cards = () => [...document.querySelectorAll('#messagesList .fork-proposal-card')]
  const showAll = () => { const button = document.querySelector('#chatHistoryList .history-view-all'); if (button) button.click() }
  if (!byPrefix('F')) showAll()
  await wait(300)
  const t0 = Date.now()
  byPrefix('F')?.click()
  const opened = await until(() => $('messagesList')?.dataset.chatId === 'chatF', 25000)
  const openMs = Date.now() - t0
  const mounted = await until(() => cards().length === ${MANY}, 300000)
  const totalMs = Date.now() - t0
  note('F opens', opened, 'open=' + openMs + ' ms')
  note('F cards mounted', mounted, 'total=' + totalMs + ' ms cards=' + cards().length)
  note('F no duplicates', new Set(cards().map(c => c.dataset.forkProposalId)).size === cards().length,
    new Set(cards().map(c => c.dataset.forkProposalId)).size + '/' + cards().length)
  if (!byPrefix('A')) showAll()
  await wait(200)
  byPrefix('A')?.click()
  await until(() => $('messagesList')?.dataset.chatId === 'chatA', 25000)
  const t1 = Date.now()
  byPrefix('F')?.click()
  const reopened = await until(() => $('messagesList')?.dataset.chatId === 'chatF' && cards().length === ${MANY}, 300000)
  note('F second open', reopened, Date.now() - t1 + ' ms')
  note('no page errors', window.__rtErrors.length === 0, JSON.stringify(window.__rtErrors.slice(0, 3)))
  return { ok: checks.every(c => c.pass), checks }
})().catch(e => ({ ok: false, error: String(e && e.stack || e) }))`

try {
  acquireWindowLock()
  const seed = launch('seed', SEED)
  if (!seed.ok) throw new Error('seed failed: ' + (seed.error || JSON.stringify(seed.checks)))
  console.log(`seeded chats, many=${MANY}`)

  const corrupt = launch('probe-corrupt', PROBE_CORRUPT)
  for (const c of corrupt.checks || []) line('corrupt · ' + c.name, c.pass, c.detail)
  if (corrupt.error) line('corrupt · verdict', false, corrupt.error)

  const many = launch('probe-many', PROBE_MANY, 600000)
  for (const c of many.checks || []) line('many · ' + c.name, c.pass, c.detail)
  if (many.error) line('many · verdict', false, many.error)

  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ corrupt, many }, null, 2))
  const failed = report.filter(r => !r.pass).length
  console.log(`fork proposal corrupt ledgers: checks ${report.length}, failed ${failed}`)
  console.log('EVIDENCE: ' + out)
  settleRun(out, failed === 0)
  process.exit(failed ? 1 : 0)
} catch (error) {
  console.error(error)
  console.log('EVIDENCE: ' + out)
  process.exit(1)
}
