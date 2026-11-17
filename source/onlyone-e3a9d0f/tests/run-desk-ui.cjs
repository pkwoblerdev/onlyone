'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')
const output = runDir('onlyone-desk-ui')
const profile = runDir('onlyone-desk-profile')
const resultPath = path.join(output, 'result.json')
const child = spawnSync(electronBinary(), [path.join(__dirname,'desk-ui-main.cjs'), '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir='+profile], {
  cwd: path.join(__dirname,'..'), timeout: 60000, stdio: 'pipe', env: guiEnv({ ONECODE_DESK_RESULT: resultPath })
})
const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath,'utf8')) : { ok: false, error: child.error?.message || 'Desk window did not report' }
console.log(JSON.stringify(result))
if (!result.ok && child.stderr) console.error(child.stderr.toString().slice(-3000))
settleRun(output,result.ok)
settleRun(profile,result.ok)
process.exit(result.ok ? 0 : 1)
