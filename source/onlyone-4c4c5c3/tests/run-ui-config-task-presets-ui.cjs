// ---------------------------------------------------------------------------
// run-ui-config-task-presets-ui.cjs: Оконный прогон смены наборов интерфейса
// («дизайн», «код», «исследование» в RU и EN, пункт 9.5 плана работ).
// Сценарий по поручению Claude:
// 1. Запрос в чат («настрой под дизайн» / «tune for design»).
// 2. Карточка .prop в ленте.
// 3. Кнопка «Примерить» → проверка раскладки, .trybar, контура .trying.
// 4. Кнопка «Оставить» → фиксация новой раскладки.
// 5. Кнопка «Откатить» → возврат к исходному виду.
// 6. Снятие снимков RU/EN трёх наборов для приёмки
// ---------------------------------------------------------------------------

'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const output = runDir('1code-task-presets-ui')

// Каталог для свидетельств по правилам проекта
const evidenceDir = process.env.ONECODE_EVIDENCE_DIR || path.join(root, 'audits', 'ui-config-presets')
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true })
}

const SCENARIOS = [
  { name: 'design-ru', preset: 'design', lang: 'ru' },
  { name: 'code-ru', preset: 'code', lang: 'ru' },
  { name: 'research-ru', preset: 'research', lang: 'ru' },
  { name: 'design-en', preset: 'design', lang: 'en' },
  { name: 'code-en', preset: 'code', lang: 'en' },
  { name: 'research-en', preset: 'research', lang: 'en' }
]

function runScenario(sc) {
  const resultFile = path.join(output, `result-${sc.name}.json`)
  const scProfile = path.join(output, 'profile-' + sc.name)
  const shotsDir = path.join(output, 'shots-' + sc.name)
  fs.mkdirSync(shotsDir, { recursive: true })

  console.log(`-> Запуск сценария набора [${sc.preset}] на языке [${sc.lang}]...`)
  const argsPayload = { preset: sc.preset, lang: sc.lang, shotsDir }
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${scProfile}`], {
    cwd: root,
    timeout: 180000,
    stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: path.join(__dirname, 'ui-config-task-presets-renderer.js'),
      ONECODE_SMOKE_OUT: resultFile,
      ONECODE_ARG: Buffer.from(JSON.stringify(argsPayload), 'utf8').toString('base64')
    })
  })

  // Копирование снимков в каталог свидетельств
  if (evidenceDir && fs.existsSync(shotsDir)) {
    for (const f of fs.readdirSync(shotsDir)) {
      if (f.endsWith('.png')) {
        const src = path.join(shotsDir, f)
        const dst = path.join(evidenceDir, f)
        fs.copyFileSync(src, dst)
        console.log(`     снимок сохранён: ${path.basename(dst)} (${fs.statSync(dst).size} байт)`)
      }
    }
  }

  // Очистка временного профиля
  try {
    fs.rmSync(scProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {}

  if (!fs.existsSync(resultFile)) {
    console.error(`Окно не отчиталось: ${sc.name} (exit status: ${child.status})`)
    return { ok: false, checks: [] }
  }

  let report = { ok: false, checks: [] }
  try {
    report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  } catch (err) {
    console.error(`Ошибка разбора отчёта ${sc.name}:`, err.message)
    return { ok: false, checks: [] }
  }

  for (const c of report.checks || []) {
    console.log((c.pass ? '  ok  ' : 'ПРОВАЛ ') + `${sc.name} · ${c.name}` + (c.detail ? ` — ${c.detail}` : ''))
  }

  return report
}

async function main() {
  console.log('=== Оконный прогон 9.5: смена наборов интерфейса («дизайн», «код», «исследование») ===\n')
  console.log(`Целевой каталог свидетельств: ${evidenceDir}\n`)

  let allOk = true
  let totalChecks = 0
  let passedChecks = 0

  for (const sc of SCENARIOS) {
    const report = runScenario(sc)
    if (!report.ok) allOk = false
    const checks = report.checks || []
    totalChecks += checks.length
    passedChecks += checks.filter(c => c.pass).length
    console.log('')
  }

  console.log(`\nИтог оконных проверок 9.5: проверок ${totalChecks}, успешно ${passedChecks}`)
  console.log(`Все снимки зафиксированы в: ${evidenceDir}`)

  settleRun(output, allOk)
  process.exit(allOk ? 0 : 1)
}

main().catch(err => {
  console.error('Непредвиденная ошибка прогона:', err)
  process.exit(1)
})
