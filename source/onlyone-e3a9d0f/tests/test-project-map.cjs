// PROJECT-MAP.md не должна отставать от кода: каждый файл src/ описан, каждый якорь существует, таблица в карте свежая.
// Починка — `node scripts/project-map.cjs` (и строка описания в DESCRIPTIONS для нового файла).
'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const script = path.join(__dirname, '..', 'scripts', 'project-map.cjs')
const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
const output = (run.stdout + run.stderr).trim()

let failed = 0
function check (name, ok, detail) {
  console.log((ok ? '  ok  ' : 'ПРОВАЛ ') + name + (ok ? '' : ' — ' + detail))
  if (!ok) failed++
}
check('карта проекта совпадает с кодом (файлы src/ описаны, якоря на месте)', run.status === 0, output)
console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
