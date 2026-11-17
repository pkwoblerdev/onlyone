// Поиск живёт в отдельном потоке. В установленной копии файл потока лежит
// внутри app.asar, и Electron должен уметь запустить worker оттуда. На исходниках
// этого не проверить — здесь собирается настоящий asar и запускается тот же
// Electron, каким идёт сборка.
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { electronBinary, guiEnv, runDir, settleRun, acquireWindowLock } = require('./app-launch.cjs')

const SRC = path.join(__dirname, '..', 'src', 'main')
const MODULES = ['workspace-search.js', 'workspace-search-worker.js', 'search-service.js']

const out = runDir('onlyone-asar')
const verdictFile = path.join(out, 'verdict.json')
const appDir = path.join(out, 'probe')
const payload = path.join(appDir, 'payload')

fs.mkdirSync(path.join(payload, 'src', 'main'), { recursive: true })
fs.mkdirSync(path.join(out, 'data'), { recursive: true })
for (const name of MODULES) fs.copyFileSync(path.join(SRC, name), path.join(payload, 'src', 'main', name))
fs.writeFileSync(path.join(out, 'data', 'a.js'), 'const needle = 1\n')
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', main: 'probe.js' }, null, 2))
fs.writeFileSync(path.join(appDir, 'probe.js'), [
  "const { app } = require('electron')",
  "const fs = require('fs')",
  "const path = require('path')",
  'app.whenReady().then(async () => {',
  '  const verdict = {}',
  '  try {',
  "    const file = path.join(__dirname, 'app.asar', 'src', 'main', 'search-service.js')",
  '    verdict.exists = fs.existsSync(file)',
  '    const mod = require(file)',
  '    const result = await mod.searchInWorker(',
  '      { roots: [{ root: process.env.PROBE_DATA, label: \'\' }], query: \'needle\' },',
  '      { timeoutMs: 15000 })',
  '    verdict.matches = result.matches.length',
  '    verdict.stopped = result.stopped',
  '    verdict.error = result.error',
  '  } catch (error) { verdict.thrown = String(error && error.message || error) }',
  '  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(verdict))',
  '  app.exit(0)',
  '})'
].join('\n'))

let failures = []
async function main() {
  const asarPath = path.join(appDir, 'app.asar')
  const asar = require('@electron/asar')
  await asar.createPackage(payload, asarPath)
  fs.rmSync(payload, { recursive: true, force: true })

  // Это тоже настоящее окно приложения (собирает app.asar и грузит его), а не
  // «electron как node»: два таких прогона глушат друг друга подписью «окно не
  // отчиталось», поэтому замок берём явно.
  acquireWindowLock()
  const child = spawnSync(electronBinary(), [appDir, '--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox',
    `--user-data-dir=${path.join(out, 'profile')}`], {
    cwd: appDir, timeout: 90000, stdio: 'ignore',
    env: guiEnv({ PROBE_DATA: path.join(out, 'data'), PROBE_OUT: verdictFile })
  })

  assert.ok(fs.existsSync(verdictFile), `окно не отчиталось (status ${child.status})`)
  const verdict = JSON.parse(fs.readFileSync(verdictFile, 'utf8'))
  console.log('вердикт:', JSON.stringify(verdict))

  assert.equal(verdict.thrown, undefined, `модуль не загрузился из asar: ${verdict.thrown}`)
  assert.equal(verdict.exists, true, 'пути к модулю в архиве не видно')
  assert.equal(verdict.error, null, `поток поиска внутри asar дал ошибку: ${verdict.error}`)
  assert.equal(verdict.stopped, null, 'поиск внутри asar не дошёл до конца')
  assert.equal(verdict.matches, 1, 'поток внутри asar ничего не нашёл')
  console.log('ok поиск в worker\'е работает и на исходниках, и из app.asar')
}

main()
  .catch(error => { failures.push(error.message); console.error('FAIL', error.message) })
  .finally(() => {
    settleRun(out, failures.length === 0)
    if (failures.length) process.exitCode = 1
  })
