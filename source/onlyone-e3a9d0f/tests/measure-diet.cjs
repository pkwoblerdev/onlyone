// Замер порогов диеты контекста (12.10.2026, вручную, вне npm test): сколько входных токенов уходит за ход при разных
// порогах свёртки старых результатов инструментов и сколько результатов к концу хода модель уже не видит целиком.
//   node tests/measure-diet.cjs
// Это модель роста переписки, а не живой ход: перечитывает ли модель свёрнутое, замером без живой модели не узнать.
// Заглушка свёрнутого результата называет инструмент, цель и размер, так что перечитать можно одним вызовом.
const { pruneOldToolResults, estimateTokens } = require('../src/main/context-diet.cjs')

const SYSTEM_TOKENS_CHARS = 26 * 1024 // системный промпт обычного хода ≈ 26 КБ (замер measure-prompt-cost)
const TOOLS_CHARS = 15 * 1024
const text = n => ('строка кода ' + 'х'.repeat(40) + '\n').repeat(Math.ceil(n / 55)).slice(0, n)

const SCENARIOS = {
  'аудит папки: 15 чтений по 12 КБ': Array.from({ length: 15 }, (_, i) => ({ tool: 'read_file', args: { path: `src/m${i}.js` }, result: JSON.stringify({ success: true, path: `src/m${i}.js`, content: text(12 * 1024) }) })),
  'правка с проверкой: 25 шагов (чтение 4 КБ, запись 3 КБ, тест 2 КБ)': Array.from({ length: 25 }, (_, i) => i % 3 === 0
    ? { tool: 'read_file', args: { path: 'a.js' }, result: JSON.stringify({ success: true, content: text(4 * 1024) }) }
    : i % 3 === 1
      ? { tool: 'write_file', args: { path: 'a.js', content: text(3 * 1024) }, result: JSON.stringify({ success: true, path: 'a.js' }) }
      : { tool: 'run_command', args: { command: 'npm test' }, result: JSON.stringify({ success: true, exitCode: 0, output: text(2 * 1024) }) }),
  'большие файлы: 12 чтений по 40 КБ': Array.from({ length: 12 }, (_, i) => ({ tool: 'read_file', args: { path: `big${i}.js` }, result: JSON.stringify({ success: true, content: text(40 * 1024) }) }))
}

const PROFILES = [
  ['без свёртки', null],
  ['порог 24k/12k (1.3.13)', { protectTokens: 24000, minSavingTokens: 12000 }],
  ['порог 8k/2k (1.3.15)', { protectTokens: 8000, minSavingTokens: 2000 }],
  ['порог 12k/4k', { protectTokens: 12000, minSavingTokens: 4000 }]
]

function run(steps, profile) {
  const base = [{ role: 'system', content: 'с'.repeat(SYSTEM_TOKENS_CHARS) }, { role: 'user', content: 'Сделай задачу' }]
  const history = []
  let total = 0
  let stubbedAtEnd = 0
  steps.forEach((step, i) => {
    history.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, function: { name: step.tool, arguments: JSON.stringify(step.args) } }] })
    history.push({ role: 'tool', tool_call_id: 'c' + i, content: step.result })
    const messages = [...base, ...history]
    const sent = profile ? pruneOldToolResults(messages, profile) : messages
    total += estimateTokens(sent) + Math.round(TOOLS_CHARS / 3.5)
    if (i === steps.length - 1) stubbedAtEnd = sent.filter((m, k) => m.role === 'tool' && m !== messages[k]).length
  })
  return { total, stubbedAtEnd }
}

for (const [name, steps] of Object.entries(SCENARIOS)) {
  console.log('\n' + name)
  const baseline = run(steps, null).total
  for (const [label, profile] of PROFILES) {
    const r = run(steps, profile)
    const saved = Math.round((1 - r.total / baseline) * 100)
    console.log('  ' + label.padEnd(26) + String(Math.round(r.total / 1000) + 'k').padStart(7) + ' токенов за ход, экономия ' + String(saved).padStart(3) + '%, свёрнуто к концу ' + r.stubbedAtEnd + ' из ' + steps.length)
  }
}
