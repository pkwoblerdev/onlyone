'use strict'

// Что считать проверкой результата. Одно определение на приёмку хода (`hasDeterministicProof`) и замок доски
// (`agent-board.updateItem`): расхождись они, пункт доски закрывался бы по одним правилам, а ход — по другим.
const fs = require('node:fs')
const path = require('node:path')

// Только настоящие запуски тестов и линтеров. «git checkout test-branch», «echo test», «cat tests/fixture.json» —
// не проверки, хотя содержат слово.
function isVerificationCommand(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase()
  if (!s) return false
  // A shell chain may hide a failed test or mutate files after it.
  if (/[\r\n;&|<>`]|\$\(/.test(s)) return false
  if (/^npm\s+(test|t\b|run\s+(test|lint|check|verify|typecheck))\b/.test(s)) return true
  // `./tests/x.cjs` — тот же запуск, что `tests/x.cjs`: префикс `./` не меняет
  // сути и раньше молча лишал требование доказательства (break-4 Н10).
  if (/^node\s+(?:\.\/)?(tests?\/|[a-z0-9_\-\\/]*tests?[a-z0-9_\-]*\.(cjs|mjs|js))\b/.test(s)) return true
  if (/^npx\s+(jest|vitest|mocha|pytest|tsc|eslint)\b/.test(s)) return true
  if (/^(pytest|vitest|jest|mocha|cargo\s+test|go\s+test)\b/.test(s)) return true
  return false
}

// Есть ли у проекта команда проверки, которой агент мог бы закрыть работу. Замок «нет зелёных тестов — нет «сделано»»
// включается только там, где такая команда есть: иначе закрыть пункт было бы нечем.
function projectHasTests(roots) {
  for (const root of Array.isArray(roots) ? roots : []) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
      const script = String(pkg && pkg.scripts && pkg.scripts.test || '')
      if (script && !/no test specified/i.test(script)) return true
    } catch { /* нет package.json или он не читается: смотрим другие признаки */ }
    for (const marker of ['Cargo.toml', 'go.mod', 'pytest.ini']) {
      try { if (fs.statSync(path.join(root, marker)).isFile()) return true } catch { /* нет такого файла */ }
    }
  }
  return false
}

module.exports = { isVerificationCommand, projectHasTests }
