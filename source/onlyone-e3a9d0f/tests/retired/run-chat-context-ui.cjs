// run-chat-context-ui.cjs: реальный оконный прогон и снятие снимков всех состояний контекста чата (этап 3.7).
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const output = runDir('1code-chat-context-ui')
const profile = path.join(output, 'profile')
const evidenceDir = process.env.ONECODE_EVIDENCE_DIR || null

if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true })
}

const SCENARIOS = [
  { name: 'empty-ru', state: 'empty', lang: 'ru', shotName: 'chat-context-empty-ru.png' },
  { name: 'normal-ru', state: 'normal', lang: 'ru', shotName: 'chat-context-normal-ru.png' },
  { name: 'warn-ru', state: 'warn', lang: 'ru', shotName: 'chat-context-warn-ru.png' },
  { name: 'overflow-ru', state: 'overflow', lang: 'ru', shotName: 'chat-context-overflow-ru.png' },
  { name: 'no-folder-ru', state: 'no-folder', lang: 'ru', shotName: 'chat-context-no-folder-ru.png' },
  { name: 'no-key-ru', state: 'no-key', lang: 'ru', shotName: 'chat-context-no-key-ru.png' },
  { name: 'expanded-ru', state: 'expanded', lang: 'ru', shotName: 'chat-context-expanded-ru.png' },
  { name: 'normal-en', state: 'normal', lang: 'en', shotName: 'chat-context-normal-en.png' },
  { name: 'expanded-en', state: 'expanded', lang: 'en', shotName: 'chat-context-expanded-en.png' }
]

function runScenario(sc) {
  const resultFile = path.join(output, `result-${sc.name}.json`)
  const localShot = path.join(output, sc.shotName)
  const scProfile = path.join(output, 'profile-' + sc.name)

  console.log(`-> Запуск сценария ${sc.name}...`)
  const argsPayload = { state: sc.state, lang: sc.lang }
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${scProfile}`], {
    cwd: root,
    timeout: 60000,
    stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: path.join(__dirname, 'chat-context-smoke-renderer.js'),
      ONECODE_SMOKE_OUT: resultFile,
      ONECODE_SHOT: localShot,
      ONECODE_ARG: Buffer.from(JSON.stringify(argsPayload), 'utf8').toString('base64')
    })
  })

  if (!fs.existsSync(resultFile)) {
    console.error(`Окно не отчиталось: ${sc.name} (exit status: ${child.status})`)
    return { ok: false, checks: [] }
  }

  const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  for (const c of report.checks || []) {
    console.log((c.pass ? '  ok  ' : 'ПРОВАЛ ') + `${sc.name} · ${c.name}` + (c.detail ? ` — ${c.detail}` : ''))
  }

  if (evidenceDir && fs.existsSync(localShot)) {
    const auditShot = path.join(evidenceDir, sc.shotName)
    fs.copyFileSync(localShot, auditShot)
    console.log(`       снимок сохранён: ${auditShot}`)
  }

  return report
}

async function main() {
  console.log(`Запуск оконных проверок контекста чата (этап 3.7)...\n`)
  let allOk = true
  let totalChecks = 0
  let passedChecks = 0

  for (const sc of SCENARIOS) {
    const report = runScenario(sc)
    if (!report.ok) allOk = false
    const checks = report.checks || []
    totalChecks += checks.length
    passedChecks += checks.filter(c => c.pass).length
  }

  console.log(`\nИтог оконных проверок контекста чата: проверок ${totalChecks}, успешно ${passedChecks}`)
  console.log(`Снимки сохранены в: ${evidenceDir || output}`)

  settleRun(output, allOk)
  process.exit(allOk ? 0 : 1)
}

main().catch(err => {
  console.error('Непредвиденная ошибка запуска:', err)
  process.exit(1)
})
