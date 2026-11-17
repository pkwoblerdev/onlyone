// Карточка «Работа прервалась» в разделе Дизайн (план, этап 6, блок 2, пункт 2b).
// Два запуска на одном профиле: первый заводит макет, между запусками кладётся
// контрольная точка «приложение умерло посреди правки файла», второй должен
// показать карточку в ленте этого макета — и по «Продолжить» отправить опись,
// а не повтор. В чате карточка чужого хода не появляется.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const root = path.join(__dirname, '..')
const output = runDir('onlyone-design-resume')
const profile = path.join(output, 'profile')
const runId = 'aaaaaaaa-2222-3333-4444-555555555555'

const prelude = `
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 15000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(100) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  await until(() => document.documentElement.dataset.appReady === '1')
`

function launch(name, body) {
  const script = path.join(output, name + '.js')
  const out = path.join(output, name + '.json')
  fs.writeFileSync(script, `(async () => {${prelude}${body}})()`)
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 90000, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SHOT: path.join(output, name + '.png') })
  })
  if (child.error) throw child.error
  if (!fs.existsSync(out)) { console.error('окно не отчиталось: ' + out); process.exit(1) }
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}

const first = launch('first', `
  $('navDesign')?.click()
  await until(() => !$('designGallery').hidden, 8000)
  const starter = [...document.querySelectorAll('#designGallery .shelf-item')].find(item => /чистого листа/.test(item.textContent))
  note('формат «с чистого листа» предложен', !!starter)
  starter?.click()
  const askBox = $('dsNewIn')
  askBox.value = 'Набросай первый экран'
  askBox.dispatchEvent(new Event('input', { bubbles: true }))
  $('dsNewForm').requestSubmit()
  note('макет открылся', await until(() => !$('designWorkspace').hidden, 8000))
  const stored = await window.electronAPI.getDesigns()
  note('макет сохранён', (stored || []).length === 1, (stored || []).length)
  note('без оборванных ходов карточки нет', !document.querySelector('#designMessages .approval-card.kind-resume'))
  await wait(800)
  return { ok: checks.every(c => c.pass), checks, designId: stored?.[0]?.id || '' }
`)

let second = null
if (first.ok && first.designId) {
  // Так выглядит ход, прерванный закрытием окна: правка файла закончилась,
  // сборка превью — нет.
  fs.mkdirSync(path.join(profile, 'runs'), { recursive: true })
  const at = Date.now()
  fs.writeFileSync(path.join(profile, 'runs', runId + '.json'), JSON.stringify({
    schemaVersion: 1, runId, requestId: 'r', chatId: null, designId: first.designId,
    surface: 'design',
    ask: 'Собери макет лендинга', startedAt: at, updatedAt: at, droppedActions: 0,
    actions: [
      { seq: 1, tool: 'write_file', target: 'index.html', agentIndex: 0, status: 'done', at },
      { seq: 2, tool: 'read_file', target: 'index.html', agentIndex: 0, status: 'started', at }
    ]
  }))

  second = launch('second', `
    $('navDesign')?.click()
    await until(() => !$('designGallery').hidden, 8000)
    note('в галерее карточек прерванного хода нет', !document.querySelector('.approval-card.kind-resume'))
    document.querySelector('#designList .ds-card')?.click()
    const shown = await until(() => document.querySelector('#designMessages .approval-card.kind-resume'), 10000)
    const card = document.querySelector('#designMessages .approval-card.kind-resume')
    note('карточка стоит в ленте своего макета', shown)
    note('в карточке видна исходная просьба', /Собери макет лендинга/.test(card?.querySelector('.resume-ask')?.textContent || ''),
      card?.innerText.replace(/\\s+/g, ' ').slice(0, 160))
    card?.querySelector('.approval-toggle')?.click()
    note('действие с неизвестным результатом названо', /read_file: index\\.html/.test(card?.querySelector('.approval-diff')?.textContent || ''),
      card?.querySelector('.approval-diff')?.textContent)
    note('в чате этой карточки нет', !document.querySelector('#messagesList .approval-card.kind-resume'))
    card?.querySelector('.approval-allow')?.click()
    // textContent, не innerText: лента в этот момент может быть на полсекунды
    // скрыта за перестройкой вида, а innerText скрытого узла пуст.
    const sent = await until(() => /Продолжить прерванную работу/.test($('designMessages').textContent), 8000)
    const feed = ($('designMessages').textContent || '').replace(/\\s+/g, ' ')
    // Опись уходит модели скрыто: в ленте — одна короткая фраза, а не простыня
    // из «- write_file: …», как было.
    note('в ленте короткая фраза, опись скрыта', sent && !/не повторяй/.test(feed) && !/Сначала проверь/.test(feed),
      feed.slice(0, 200))
    note('карточка ушла', !document.querySelector('#designMessages .approval-card.kind-resume'))
    const left = await window.electronAPI.interruptedRuns()
    note('ход снят с учёта', Array.isArray(left) && left.length === 0, JSON.stringify(left).slice(0, 120))
    await until(() => $('designSendBtn')?.dataset.stop !== '1', 20000)
    return { ok: checks.every(c => c.pass), checks }
  `)
} else {
  console.log('второй запуск пропущен: первый не прошёл (' + JSON.stringify(first).slice(0, 200) + ')')
}

const fileLeft = fs.existsSync(path.join(profile, 'runs', runId + '.json'))
const ok = Boolean(first.ok && second?.ok && !fileLeft)
for (const part of [first, second].filter(Boolean)) {
  for (const c of part.checks || []) console.log((c.pass ? 'ok     ' : 'ПРОВАЛ ') + c.name + (c.detail && !c.pass ? ' — ' + c.detail : ''))
  if (part.error) console.log('ошибка окна: ' + part.error)
}
console.log((fileLeft ? 'ПРОВАЛ ' : 'ok     ') + 'файл контрольной точки удалён')
for (const name of ['first', 'second']) {
  const shot = path.join(output, name + '.png')
  if (!process.env.ONECODE_EVIDENCE_DIR || !fs.existsSync(shot)) continue
  const evidence = process.env.ONECODE_EVIDENCE_DIR
  fs.mkdirSync(evidence, { recursive: true })
  fs.copyFileSync(shot, path.join(evidence, 'design-resume-' + name + '.png'))
}
console.log(JSON.stringify({ ok, output }))
settleRun(output, ok)
process.exit(ok ? 0 : 1)
