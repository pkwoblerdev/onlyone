// Строка вызова в ленте появляется, когда модель ещё только пишет содержимое
// инструмента, а итог дописывается в ту же строку (план, этап 6). Без этого
// минуту до артефакта в ленте не двигается ничего, и ход выглядит зависшим.
// Инструмент в прогоне настоящий — show_artifact, — поэтому проверяется и
// панель: она обязана открыться уже после строки, а не вместо неё.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const root = path.join(__dirname, '..')
const output = runDir('onlyone-tool-stream')
const profile = path.join(output, 'profile')
const fixture = path.join(output, 'fixture.json')

fs.writeFileSync(fixture, JSON.stringify({
  content: 'Готово: показал страницу в панели.',
  toolStream: {
    tool: 'show_artifact',
    hold: 1600,
    args: { kind: 'page', title: 'Проверка строки', content: '<h1>Проверка строки</h1>' }
  }
}))

const script = path.join(output, 'renderer.js')
fs.writeFileSync(script, `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 15000) => {
    const stop = Date.now() + ms
    while (Date.now() < stop) { try { if (fn()) return true } catch {} ; await wait(80) }
    return false
  }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const rows = () => [...document.querySelectorAll('#messagesList .tool')]
  const said = row => row.textContent.replace(/\\s+/g, ' ')
  await until(() => document.documentElement.dataset.appReady === '1')
  await wait(400)

  $('newChatBtn')?.click()
  await wait(300)
  const box = $('composerTextarea')
  box.value = 'Сделай страницу и покажи её в панели'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  $('composerForm').requestSubmit()

  // 1. Строка есть до того, как инструмент отработал: панель ещё закрыта.
  const early = await until(() => rows().some(row => /Показываю результат рядом с ответом/.test(said(row))) &&
    $('artifactPanel').hidden, 6000)
  note('вызов виден, пока модель пишет его содержимое', early,
    rows().map(said).join(' | ').slice(0, 160))
  const pendingRow = rows().find(row => /Показываю результат/.test(said(row)))
  note('в строке сказано, чем заняты, а не имя инструмента',
    !!pendingRow && !/show_artifact/.test(said(pendingRow)), said(pendingRow))
  note('панель ещё не открыта', $('artifactPanel').hidden)

  // 2. Итог дописывается в ту же строку: второй строки не появляется. Строка
  // собирается из глагола и цели («Показал» + «Проверка строки»), а не из
  // одного предложения — колонки важнее связного текста.
  const settled = await until(() => rows().some(row => /Показал/.test(said(row)) &&
    /Проверка строки/.test(said(row))), 10000)
  note('итог дописан в ту же строку', settled, rows().map(said).join(' | ').slice(0, 200))
  const artifactRows = rows().filter(row => /Показал|Показываю результат/.test(said(row)))
  note('строка об этом вызове одна', artifactRows.length === 1, artifactRows.map(said).join(' | '))
  const meta = artifactRows[0]?.querySelector('.rail-meta')
  note('отметка «ещё пишется» снята', !meta?.textContent, JSON.stringify(meta?.textContent))
  note('панель открылась результатом', await until(() => !$('artifactPanel').hidden, 6000))
  note('ход закончился', await until(() => !document.querySelector('.btn-send.is-stop'), 20000))
  return { ok: checks.every(c => c.pass), checks }
})()`)

const out = path.join(output, 'result.json')
const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
  cwd: root, timeout: 120000, stdio: 'inherit',
  env: guiEnv({
    ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_SMOKE_FIXTURE: fixture,
    ONECODE_SHOT: path.join(output, 'tool-stream.png')
  })
})

let ok = false
if (!fs.existsSync(out)) {
  console.error('окно не отчиталось (status ' + child.status + ')')
} else {
  const report = JSON.parse(fs.readFileSync(out, 'utf8'))
  if (report.error) console.error('ошибка окна: ' + report.error)
  for (const c of report.checks || []) console.log((c.pass ? 'ok     ' : 'ПРОВАЛ ') + c.name + (c.detail ? ' — ' + c.detail : ''))
  ok = Boolean(report.ok)
  const shot = path.join(output, 'tool-stream.png')
  if (process.env.ONECODE_EVIDENCE_DIR && fs.existsSync(shot)) {
    const evidence = process.env.ONECODE_EVIDENCE_DIR
    fs.mkdirSync(evidence, { recursive: true })
    fs.copyFileSync(shot, path.join(evidence, 'tool-stream-row.png'))
  }
}
console.log(ok ? 'Строка вызова появляется вовремя' : 'Строка вызова запаздывает')
settleRun(output, ok)
process.exit(ok ? 0 : 1)
