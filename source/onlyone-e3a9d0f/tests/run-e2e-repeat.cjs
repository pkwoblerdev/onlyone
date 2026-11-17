// One green run proves a scenario can pass. Agent mode has been failing
// intermittently all along — an empty turn here, a swapped model there — and
// nothing intermittent shows up in a single run.
//
// So each scenario runs several times and the results are tallied. What matters
// is not the average but the worst case: an agent that works four times out of
// five is an agent a person cannot rely on.
const { spawnSync } = require('child_process')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const KEY = process.env.ONECODE_LIVE_KEY
if (!KEY) {
  console.error('нужен ONECODE_LIVE_KEY')
  process.exit(1)
}

const scenarios = (process.argv[2] || 'simple,steps,tool,write').split(',')
const times = Number(process.argv[3] || 3)

const results = {}

for (const scenario of scenarios) {
  results[scenario] = { passed: 0, failed: 0, seconds: [], notes: [] }

  for (let run = 1; run <= times; run++) {
    const out = spawnSync('node', [join(ROOT, 'tests', 'run-e2e.cjs'), scenario], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      env: { ...process.env, ONECODE_LIVE_KEY: KEY }
    })

    const text = (out.stdout || '') + (out.stderr || '')
    const verdict = /\{"ok":(true|false),"failed":(\d+)/.exec(text)
    const seconds = /seconds\s+(\d+)/.exec(text)

    if (seconds) results[scenario].seconds.push(Number(seconds[1]))

    if (verdict && verdict[1] === 'true') {
      results[scenario].passed++
      process.stdout.write('.')
    } else {
      results[scenario].failed++
      process.stdout.write('X')
      for (const line of text.split('\n')) {
        if (line.includes('ПРОВАЛ')) results[scenario].notes.push(line.trim().slice(0, 110))
      }
    }
  }
  process.stdout.write(` ${scenario}\n`)
}

console.log('')
console.log('сценарий'.padEnd(12), 'прошло'.padStart(8), 'упало'.padStart(7), 'секунды'.padStart(20))
for (const [name, r] of Object.entries(results)) {
  const times = r.seconds.length
    ? `${Math.min(...r.seconds)}–${Math.max(...r.seconds)}`
    : '—'
  console.log(name.padEnd(12), String(r.passed).padStart(8), String(r.failed).padStart(7), times.padStart(20))
}

const allNotes = Object.entries(results).flatMap(([name, r]) => r.notes.map(n => `${name}: ${n}`))
if (allNotes.length) {
  console.log('')
  console.log('что падало:')
  for (const note of [...new Set(allNotes)]) console.log(' ', note)
}

const totalFailed = Object.values(results).reduce((s, r) => s + r.failed, 0)
console.log('')
console.log(JSON.stringify({ ok: totalFailed === 0, failed: totalFailed }))
process.exit(totalFailed ? 1 : 0)
