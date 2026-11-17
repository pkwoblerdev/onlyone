// run-at-rest-decrypt-ui.cjs: Оконная проверка расшифровки unwrapProtectedBytes
// (артефакт b64, макет Дизайна CSS/JS, миниатюра вложения чата).
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const evidenceDir = process.env.ONECODE_EVIDENCE_DIR || path.join(root, 'audits', 'at-rest-decrypt')
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true })
}

const out = runDir('1code-at-rest-decrypt-ui')
const profile = path.join(out, 'profile')

function launch(name, mode, manifest, shot) {
  const resultFile = path.join(out, `${name}.json`)
  const argsPayload = { mode, manifest }
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
    cwd: root,
    timeout: 120000,
    stdio: 'inherit',
    env: guiEnv({
      ONECODE_SMOKE: path.join(__dirname, 'at-rest-decrypt-renderer.js'),
      ONECODE_SMOKE_OUT: resultFile,
      ...(shot ? { ONECODE_SHOT: shot } : {}),
      ONECODE_ARG: Buffer.from(JSON.stringify(argsPayload), 'utf8').toString('base64')
    })
  })

  if (!fs.existsSync(resultFile)) {
    console.error(`Окно не отчиталось: ${name} (exit status: ${child.status})`)
    return { ok: false, checks: [] }
  }

  let report = { ok: false, checks: [] }
  try {
    report = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  } catch (err) {
    console.error(`Ошибка разбора отчёта ${name}:`, err.message)
    return { ok: false, checks: [] }
  }

  for (const c of report.checks || []) {
    console.log((c.pass ? '  ok  ' : 'ПРОВАЛ ') + `${name} · ${c.name}` + (c.detail ? ` — ${c.detail}` : ''))
  }

  if (shot && fs.existsSync(shot)) {
    console.log(`     снимок сохранён: ${path.basename(shot)} (${fs.statSync(shot).size} байт)`)
  }

  return report
}

async function main() {
  console.log('=== Оконный прогон проверки unwrapProtectedBytes (DPAPI safeStorage) ===\n')
  console.log(`Целевой каталог свидетельств: ${evidenceDir}\n`)

  // Шаг 1: Подготовка зашифрованных данных с реальным Electron DPAPI в профиле
  console.log('-> Фаза 1: Подготовка зашифрованных данных в профиле...')
  const prepChild = spawnSync(electronBinary(), [
    path.join(__dirname, 'at-rest-decrypt-prep.cjs'),
    profile,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    `--user-data-dir=${profile}`
  ], {
    cwd: root,
    timeout: 60000,
    stdio: 'inherit',
    env: guiEnv()
  })

  if (prepChild.status !== 0) {
    console.error(`Фаза подготовки завершилась с ошибкой: ${prepChild.status}`)
    settleRun(out, false)
    process.exit(1)
  }

  const manifestPath = path.join(profile, 'at-rest-manifest.json')
  if (!fs.existsSync(manifestPath)) {
    console.error('Манифест зашифрованных данных не найден:', manifestPath)
    settleRun(out, false)
    process.exit(1)
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  console.log('   Данные зашифрованы:', manifest)

  let allOk = true
  let totalChecks = 0
  let passedChecks = 0

  const runs = [
    {
      name: '01-artifact-decrypt',
      mode: 'artifact',
      shot: path.join(evidenceDir, '01-artifact-image-decrypted.png')
    },
    {
      name: '02-design-decrypt',
      mode: 'design',
      shot: path.join(evidenceDir, '02-design-css-js-decrypted.png')
    },
    {
      name: '03-attachment-decrypt',
      mode: 'attachment',
      shot: path.join(evidenceDir, '03-chat-attachment-decrypted.png')
    }
  ]

  for (const r of runs) {
    console.log(`\n-> Запуск окна: ${r.name} (режим ${r.mode})...`)
    const res = launch(r.name, r.mode, manifest, r.shot)
    if (!res.ok) allOk = false
    const checks = res.checks || []
    totalChecks += checks.length
    passedChecks += checks.filter(c => c.pass).length
  }

  console.log(`\nИтог проверки: проверок ${totalChecks}, успешно ${passedChecks}`)
  if (allOk) {
    console.log('✓ Все проверки расшифровки unwrapProtectedBytes успешно пройдены!')
  } else {
    console.error('✗ Обнаружены провалы в проверке расшифровки!')
  }

  settleRun(out, allOk)
  process.exitCode = allOk ? 0 : 1
}

main().catch(err => {
  console.error('Непредвиденная ошибка:', err)
  settleRun(out, false)
  process.exit(1)
})
