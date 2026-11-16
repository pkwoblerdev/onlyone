// Оконный прогон компактного списка над «/» (план, 3.10): КРАСНЫЕ проверки.
//
// Шесть кадров: список команд над полем ввода (RU), выбранная строка с подсказкой
// справа (RU), список режимов над пилюлей (RU) и те же три по-английски. Каждый
// кадр — отдельный запуск окна на временном профиле: `main.js` делает один снимок
// на прогон, а состояние нужно поймать в момент, когда список открыт.
//
// Настоящей модели и сети наружу здесь нет: набирается текст в поле, кликается
// пилюля, жались клавиши. Доказательства (кадры и отчёты) копируются в
// ONECODE_EVIDENCE_DIR и переживают прогон — зелёный запуск убирает свой
// временный каталог, а улики красного остаются.
//
// ПУТЬ каталога доказательств передают в форме `D:/…`, а не `/d/…`.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('1code-composer-menu')
const profile = path.join(out, 'profile')
const evidence = process.env.ONECODE_EVIDENCE_DIR

const FRAMES = ['commands-ru', 'command-hint-ru', 'modes-ru', 'commands-en', 'command-hint-en', 'modes-en']

function launch (mode) {
  const resultFile = path.join(out, `${mode}.json`)
  const shot = path.join(out, `${mode}.png`)
  const child = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
      cwd: root, timeout: 180000, stdio: 'inherit',
      env: guiEnv({
        ONECODE_SMOKE: path.join(__dirname, 'composer-menu-renderer.js'),
        ONECODE_SMOKE_OUT: resultFile,
        ONECODE_SHOT: shot,
        ONECODE_ARG: Buffer.from(JSON.stringify({ mode }), 'utf8').toString('base64')
      })
    })
  if (child.error) throw child.error
  if (!fs.existsSync(resultFile)) {
    console.error(`ПРОВАЛ [${mode}]: окно не отчиталось (status ${child.status})`)
    return { ok: false, checks: 0, shot: false }
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error(`${mode}: окно сообщило об ошибке — ${report.error}`)
  for (const item of report.checks || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + mode + ' · ' + item.name +
      (item.detail ? ' — ' + item.detail : ''))
  }
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true })
    for (const file of [shot, resultFile]) {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)))
    }
  }
  const total = (report.checks || []).length
  return { ok: Boolean(report.ok) && total > 0, checks: total, shot: fs.existsSync(shot) }
}

function main () {
  const results = FRAMES.map(mode => [mode, launch(mode)])
  const ok = results.every(([, one]) => one.ok)
  const shots = results.filter(([, one]) => one.shot).length
  for (const [mode, one] of results) console.log(`кадр ${mode}: проверок ${one.checks}, снимок ${one.shot ? 'есть' : 'НЕТ'}`)
  console.log(`кадров со снятым состоянием: ${shots} из ${FRAMES.length}`)
  if (evidence) console.log(`доказательства: ${evidence}`)
  console.log(ok
    ? 'Компактный список команд и режимов над «/» работает в окне по пункту 3.10'
    : 'Пункт 3.10 ещё не сделан: список команд и режимов над «/» ведёт себя иначе')
  process.exitCode = ok ? 0 : 1
  settleRun(out, ok)
}

try {
  main()
} catch (error) {
  console.error('ПРОВАЛ', error.message)
  settleRun(out, false)
  process.exitCode = 1
}
