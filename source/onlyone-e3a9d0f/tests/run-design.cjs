const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const root = path.join(__dirname, '..')
const output = path.join(root, 'design-validation')
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-design-'))
const out = path.join(output, 'checks.json')
const { electronBinary, guiEnv } = require('./app-launch.cjs')
const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
  cwd: root, timeout: 90000, stdio: 'inherit',
  env: guiEnv({ ONECODE_SMOKE: path.join(__dirname, 'design-renderer.js'),
    ONECODE_SMOKE_FIXTURE: path.join(__dirname, 'design-fixture.json'),
    ONECODE_SMOKE_OUT: out, ONECODE_SHOT: path.join(output, 'chat.png') })
})
if (child.error) throw child.error
if (!fs.existsSync(out)) throw new Error('Окно не сформировало отчёт')
const report = JSON.parse(fs.readFileSync(out, 'utf8'))
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
