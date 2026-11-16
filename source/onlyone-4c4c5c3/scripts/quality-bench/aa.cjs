'use strict'
// Повторы A/A: несколько независимых прогонов одной конфигурации и сводка разброса.
// Два прогона — только начальная оценка шума, не основание для вывода об эффекте.
// Модель не вызывается самим этим файлом: он запускает стенд так же, как человек.
//   npm run bench:aa -- --runs 3 --out D:/tmp/aa [аргументы стенда: --mode, --model, --profile, --scenario, --timeout]
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { compareReports } = require('./compare.cjs')

function parseArgs (argv) {
  const out = { runs: 2, out: null, bench: [] }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--') continue
    if (key === '--runs' || key === '--out') {
      const value = argv[++i]
      if (typeof value !== 'string' || !value || value.startsWith('--')) throw Error('Нет значения: ' + key)
      if (key === '--runs') {
        const runs = Number(value)
        if (!Number.isSafeInteger(runs) || runs < 2 || runs > 20) throw Error('runs: целое от 2 до 20')
        out.runs = runs
      } else { if (out.out) throw Error('out указан дважды'); out.out = value }
    } else if (key === '--repeat') throw Error('--repeat не нужен: повторы задаёт --runs')
    else out.bench.push(key)
  }
  if (!out.out) throw Error('Нужен --out: каталог для прогонов и сводки (новый)')
  return out
}

const spread = values => values.some(value => !Number.isFinite(value)) ? null
  : { min: Math.min(...values), max: Math.max(...values), range: Math.max(...values) - Math.min(...values) }

function summarizeAA (reports) {
  if (!Array.isArray(reports) || reports.length < 2) throw Error('нужно не меньше 2 завершённых прогонов')
  for (const other of reports.slice(1)) compareReports(reports[0], other, 'aa') // один источник, набор, модель, условия, пары
  const rows = new Map()
  for (const report of reports) for (const item of report.attempts) {
    if (!rows.has(item.scenario)) rows.set(item.scenario, [])
    rows.get(item.scenario).push(item)
  }
  const scenarios = [...rows.keys()].sort().map(scenario => {
    const items = rows.get(scenario)
    const falseDone = items.every(item => typeof item.falseDone === 'boolean') ? items.filter(item => item.falseDone).length : null
    return { scenario, attempts: items.length, passed: items.filter(item => item.verdict === 'pass').length,
      outcomesStable: new Set(items.map(item => item.verdict)).size === 1, falseDone,
      durationMs: spread(items.map(item => item.durationMs)), requests: spread(items.map(item => item.requests)),
      tokens: spread(items.map(item => item.tokens)) }
  })
  const runs = reports.length
  return { tool: 'onlyone-agent-quality-aa', schemaVersion: 1, runs, mode: reports[0].mode, source: reports[0].source.commit,
    suiteDigest: reports[0].suiteDigest, requestedModel: reports[0].attempts[0].model,
    effectProven: false, noiseEstimate: runs === 2 ? 'initial' : 'observed',
    notice: runs === 2
      ? 'Только 2 прогона — начальная оценка шума: разброс по двум точкам ничего не доказывает; число повторов нужно уточнить по наблюдаемому разбросу.'
      : `Разброс по ${runs} прогонам — наблюдаемая оценка шума, не доказательство эффекта; достаточность повторов решается отдельно.`,
    scenarios }
}

function writeSummary (file, summary) { fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' }) }

function main (argv) {
  const options = parseArgs(argv)
  const out = path.resolve(options.out)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.mkdirSync(out) // Прежние прогоны не перезаписываются.
  const bench = path.join(__dirname, '..', 'quality-bench.cjs')
  const reports = []
  for (let run = 1; run <= options.runs; run++) {
    const dir = path.join(out, 'run-' + run)
    const result = spawnSync(process.execPath, [bench, ...options.bench, '--out', dir], { stdio: 'inherit', windowsHide: true })
    const file = path.join(dir, 'report.json')
    if (!fs.existsSync(file)) throw Error(`прогон ${run} не оставил отчёта (код ${result.status})`)
    reports.push(JSON.parse(fs.readFileSync(file, 'utf8')))
  }
  const summary = summarizeAA(reports)
  writeSummary(path.join(out, 'aa-summary.json'), summary)
  console.log(JSON.stringify({ summary: path.join(out, 'aa-summary.json'), runs: summary.runs, noiseEstimate: summary.noiseEstimate, effectProven: false }))
  console.log(summary.notice)
}

if (require.main === module) { try { main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 2 } }
module.exports = { parseArgs, summarizeAA, writeSummary }
