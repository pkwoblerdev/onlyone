// Продолжение хода, оборванного закрытием приложения (план, этап 6, блок 2).
// Два запуска на одном профиле: первый заводит чат, между запусками кладётся
// контрольная точка «приложение умерло посреди команды», второй должен показать
// в этом чате карточку и по «Продолжить» отправить опись, а не повтор.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const root = path.join(__dirname, '..')
const output = runDir('onlyone-resume-ui')
const profile = path.join(output, 'profile')
const runId = '11111111-2222-3333-4444-555555555555'

const prelude = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 15000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(100) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })
  await until(() => document.documentElement.dataset.appReady === '1')
`

function launch(name, body) {
  const script = path.join(output, name + '.js')
  const out = path.join(output, name + '.json')
  fs.writeFileSync(script, `(async () => {${prelude}${body}})()`)
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 60000, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: path.join(output, name + '.png') })
  })
  if (child.error) throw child.error
  if (!fs.existsSync(out)) { console.error('окно не отчиталось: ' + out); process.exit(1) }
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}

const first = launch('first', `
  $('newChatBtn')?.click()
  await wait(300)
  const box = $('composerTextarea')
  box.value = 'Собери проект'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()
  const answered = await until(() => document.querySelector('#messagesList .msg-item.assistant') &&
    !document.querySelector('.btn-send.is-stop'))
  note('первый ход прошёл', answered)
  const chatId = document.querySelector('.history-item.active')?.dataset.chatId ||
    document.querySelector('.history-item')?.dataset.chatId
  note('у строки чата есть идентификатор', chatId)
  note('без оборванных ходов карточки нет', !document.querySelector('.approval-card.kind-resume'))
  await wait(1500)
  return { ok: checks.every(c => c.pass), checks, chatId }
`)

const report = { first, second: null }
if (first.ok) {
  // Так файл выглядит, если процесс умер, пока шла сборка: запись файла
  // закончилась, сборка — нет.
  fs.mkdirSync(path.join(profile, 'runs'), { recursive: true })
  const at = Date.now()
  fs.writeFileSync(path.join(profile, 'runs', runId + '.json'), JSON.stringify({
    schemaVersion: 1, runId, requestId: 'r', chatId: first.chatId, surface: 'chat',
    ask: 'Собери проект', startedAt: at, updatedAt: at, droppedActions: 0,
    actions: [
      { seq: 1, tool: 'write_file', target: 'src/app.js', agentIndex: 0, status: 'done', at },
      { seq: 2, tool: 'run_command', target: 'npm run build', agentIndex: 0, status: 'started', at }
    ]
  }))

  report.second = launch('second', `
    document.querySelector('.history-item[data-chat-id="${first.chatId}"] .history-item-title')?.click()
    const shown = await until(() => document.querySelector('#messagesList .approval-card.kind-resume'))
    const card = document.querySelector('#messagesList .approval-card.kind-resume')
    note('карточка стоит в своём чате', shown)
    note('в карточке видна исходная просьба', /Собери проект/.test(card?.querySelector('.resume-ask')?.textContent),
      card?.innerText.replace(/\\s+/g, ' ').slice(0, 200))
    card?.querySelector('.approval-toggle')?.click()
    note('действие с неизвестным результатом названо', /run_command: npm run build/.test(card?.querySelector('.approval-diff')?.textContent))
    card?.querySelector('.approval-allow')?.click()
    const sent = await until(() => [...document.querySelectorAll('#messagesList .msg-item.user')]
      .some(item => /Продолжить прерванную работу/.test(item.innerText)))
    const last = [...document.querySelectorAll('#messagesList .msg-item.user')].pop()?.innerText || ''
    // Опись уходит модели скрыто (prompt сообщения), в ленте — короткая фраза.
    note('в ленте короткая фраза, опись скрыта', sent && !/не повторяй/.test(last) && !/write_file/.test(last), last.slice(0, 200))
    note('карточка ушла', !document.querySelector('.approval-card.kind-resume'))
    const left = await window.electronAPI.interruptedRuns()
    note('ход снят с учёта', Array.isArray(left) && left.length === 0, JSON.stringify(left).slice(0, 120))
    await until(() => !document.querySelector('.btn-send.is-stop'))
    return { ok: checks.every(c => c.pass), checks }
  `)
}

const fileLeft = fs.existsSync(path.join(profile, 'runs', runId + '.json'))
const ok = Boolean(first.ok && report.second?.ok && !fileLeft)
for (const part of [first, report.second].filter(Boolean)) {
  for (const c of part.checks || []) console.log((c.pass ? 'ok     ' : 'ПРОВАЛ ') + c.name + (c.detail && !c.pass ? ' — ' + c.detail : ''))
  if (part.error) console.log('ошибка окна: ' + part.error)
}
console.log((fileLeft ? 'ПРОВАЛ ' : 'ok     ') + 'файл контрольной точки удалён')
console.log(JSON.stringify({ ok, output }))
settleRun(output, ok)
process.exit(ok ? 0 : 1)
