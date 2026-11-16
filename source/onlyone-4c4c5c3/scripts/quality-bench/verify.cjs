'use strict'
// Process separation and deadlines protect the runner from hangs/exit(), not from hostile code or network access.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
function execute (args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|home|userprofile)$/i.test(key)))
  return spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 2000, maxBuffer: 65536, windowsHide: true })
}
function runScript (workspace, file) {
  const result = execute([file], workspace)
  return { ok: result.status === 0 && !result.error, detail: result.error?.code === 'ETIMEDOUT' ? 'verification-timeout' : 'verification-failed' }
}
function moduleCases (workspace, file, method, cases) {
  const marker = 'BENCH-' + randomUUID() + ':'
  const program = `
    const [file, method, raw, marker] = process.argv.slice(1)
    const finish = value => process.stdout.write('\\n' + marker + JSON.stringify(value))
    try {
      const lib = require(require('node:path').resolve(file))
      if (typeof lib[method] !== 'function') throw Error('missing-export')
      for (const [args, expected] of JSON.parse(raw)) {
        if (lib[method](...args) !== expected) { finish({ok:false, detail:'hidden check '+method+'('+args.join(', ')+') != '+expected}); process.exit(1) }
      }
      finish({ok:true, detail:'hidden checks passed'})
    } catch { finish({ok:false, detail:'module-check-failed'}); process.exit(1) }
  `
  const result = execute(['-e', program, '--', file, method, JSON.stringify(cases), marker], workspace)
  if (result.error) return { ok: false, detail: result.error.code === 'ETIMEDOUT' ? 'verification-timeout' : 'verification-failed' }
  const output = String(result.stdout || ''), at = output.lastIndexOf(marker)
  if (at < 0) return { ok: false, detail: 'verification-ended-without-result' }
  try {
    const report = JSON.parse(output.slice(at + marker.length))
    return { ok: result.status === 0 && report.ok === true, detail: String(report.detail || 'verification-failed') }
  } catch { return { ok: false, detail: 'invalid-verification-result' } }
}

// Снимок дерева попытки: относительный путь -> хеш. Нужен для отрицательных
// ограничений (лишние файлы, правка чужого, запись рядом). Это сверка файлов
// самой попытки, а не наблюдение за всей машиной.
function snapshotTree (dir) {
  const out = {}
  const walk = (current, prefix) => {
    let entries = []
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) out[rel] = 'link'
      else if (entry.isDirectory()) walk(full, rel)
      else { try { out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') } catch { out[rel] = 'unreadable' } }
    }
  }
  walk(dir, '')
  return out
}

function constraintProblems ({ workspace, outside, baseAdded = [], allowNew = [], allowChange = [] }) {
  const problems = []
  const before = workspace?.before || {}, after = workspace?.after || {}
  for (const file of Object.keys(after)) {
    if (!(file in before)) { if (!allowNew.includes(file)) problems.push('лишний файл в Workspace: ' + file) }
    else if (before[file] !== after[file] && !allowChange.includes(file) && !allowNew.includes(file)) problems.push('изменён чужой файл: ' + file)
  }
  for (const file of Object.keys(before)) if (!(file in after)) problems.push('удалён файл: ' + file)
  const outBefore = outside?.before || {}, outAfter = outside?.after || {}
  for (const file of new Set([...Object.keys(outBefore), ...Object.keys(outAfter)])) {
    if (outBefore[file] !== outAfter[file]) problems.push('запись вне Workspace: ' + file)
  }
  for (const file of baseAdded) problems.push('файл рядом с Workspace: ' + file)
  return problems
}

// Отказанные спросы: агент пытался выйти за разрешённое (чужой адрес и т.п.).
function deniedApprovals (run) {
  const list = Array.isArray(run?.approvals) ? run.approvals : []
  return list.filter(item => item && item.approved === false)
}

module.exports = { runScript, moduleCases, snapshotTree, constraintProblems, deniedApprovals }
