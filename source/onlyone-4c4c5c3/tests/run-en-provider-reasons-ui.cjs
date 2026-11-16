// Прогон Н89: английская панель путей в трёх отказных состояниях.
//
// Мёртвый адрес — порт, который держался открытым ровно столько, чтобы его
// занял номер: после `close()` соединение даёт настоящий ECONNREFUSED, а не
// заглушку. Внешней сети в прогоне нет: адрес 127.0.0.1.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('1code-en-provider-reasons')
const profile = path.join(out, 'profile')
const evidence = process.env.ONECODE_EVIDENCE_DIR

function deadPort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function launch (name, args) {
  const resultFile = path.join(out, `${name}.json`)
  const shot = path.join(out, `en-provider-reasons-${name}.png`)
  const child = spawnSync(electronBinary(),
    ['.', '--no-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${profile}`], {
      cwd: root, timeout: 420000, stdio: 'inherit',
      env: guiEnv({
        ONECODE_SMOKE: path.join(__dirname, 'en-provider-reasons-renderer.js'),
        ONECODE_SMOKE_OUT: resultFile,
        ONECODE_SHOT: shot,
        ONECODE_ARG: Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
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

(async () => {
  const report = launch('provider-reasons', { deadPort: await deadPort() })
  const ok = Boolean(report.ok) && (report.checks || []).length > 0
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
})()
