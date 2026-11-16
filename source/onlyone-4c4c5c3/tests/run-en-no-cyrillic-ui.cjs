// Оконный прогон 2.6б: два запуска Electron на одном временном профиле.
//
//   · `app`        — разделы, настройки по всем вкладкам, список команд и выбор
//     режима: всё, что человек видит в рабочем окне;
//   · `onboarding` — шаги вступления, которые в обычном прогоне скрыты.
//
// Каждый экран проверяется сканом видимого текста и переводимых атрибутов на
// кириллицу (см. `en-no-cyrillic-renderer.js`). Отчёт и кадры переживают
// зелёный прогон: копируются в `ONECODE_EVIDENCE_DIR` до того, как `settleRun`
// удалит временный каталог.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('1code-en-no-cyrillic')
const profile = path.join(out, 'profile')
const evidence = process.env.ONECODE_EVIDENCE_DIR

function launch (name, args = {}, extraEnv = {}) {
  const resultFile = path.join(out, `${name}.json`)
  const shot = path.join(out, `${name}.png`)
  const child = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
      cwd: root, timeout: 420000, stdio: 'inherit',
      env: guiEnv({
        ONECODE_SMOKE: path.join(__dirname, 'en-no-cyrillic-renderer.js'),
        ONECODE_SMOKE_OUT: resultFile,
        ONECODE_SHOT: shot,
        ONECODE_ARG: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
        ...extraEnv
      })
    })
  if (child.error) throw child.error
  if (!fs.existsSync(resultFile)) {
    console.error(`Окно не отчиталось: ${name} (статус ${child.status})`)
    return { ok: false, checks: [] }
  }
  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (report.error) console.error(`${name}: окно сообщило об ошибке — ${report.error}`)
  for (const item of report.checks || []) {
    console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + name + ' · ' + item.name +
      (item.detail ? ' — ' + item.detail : ''))
  }
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true })
    for (const file of [shot, resultFile]) {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)))
    }
  }
  return report
}

function main () {
  const app = launch('app', { mode: 'app' })
  const onboarding = launch('onboarding', { mode: 'onboarding' }, { ONECODE_ONBOARDING: '1' })
  const reports = [app, onboarding]

  // Кадры главных экранов на английском — отдельным запуском по слову
  // `ONECODE_EN_SHOTS=1`: в общий набор они не входят, потому что это пять
  // лишних окон только ради снимков, а приёмку вида делает Claude.
  if (process.env.ONECODE_EN_SHOTS === '1') {
    const shots = [['chats'], ['projects'], ['skills'], ['design'], ['connectors'], ['tasks'],
      ['settings', { tab: 'appearance' }], ['settings', { tab: 'keys' }]]
    for (const [nav, extra = {}] of shots) {
      const report = launch(`en-${nav}${extra.tab ? '-' + extra.tab : ''}`, { mode: 'shot', nav, ...extra })
      reports.push(report)
    }
  }

  // Те же экраны по-русски (`ONECODE_RU_SHOTS=1`) — вторая половина приёмки
  // 2.6б: на русском экране не должно быть английских названий разделов.
  if (process.env.ONECODE_RU_SHOTS === '1') {
    const shots = [['chats'], ['projects'], ['skills'], ['design'], ['connectors'], ['tasks'],
      ['settings', { tab: 'appearance' }], ['settings', { tab: 'keys' }]]
    for (const [nav, extra = {}] of shots) {
      const report = launch(`ru-${nav}${extra.tab ? '-' + extra.tab : ''}`, { mode: 'shot-ru', nav, ...extra })
      reports.push(report)
    }
  }

  const ok = reports.every(report => report.ok && (report.checks || []).length > 0)
  const checks = reports.reduce((sum, report) => sum + (report.checks || []).length, 0)
  const failed = reports.reduce((sum, report) => sum + (report.checks || []).filter(item => !item.pass).length, 0)
  const rows = [...(app.data?.строки || []), ...(onboarding.data?.строки || [])]
  console.log(JSON.stringify({ ok, failed, checks, русскихСтрок: rows.length }))
  // Список найденных строк — в файл: он длиннее одного экрана и нужен как
  // рабочий перечень того, что править.
  fs.writeFileSync(path.join(out, 'cyrillic-found.json'), JSON.stringify(rows, null, 2))
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true })
    fs.copyFileSync(path.join(out, 'cyrillic-found.json'), path.join(evidence, 'cyrillic-found.json'))
  }
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
}

main()
