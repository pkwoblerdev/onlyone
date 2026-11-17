// Agent-authored tools execute real code, so the runner's contract is checked
// end to end: a good tool returns JSON, a broken one fails without taking the
// caller down, and a runaway one gets killed.
const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const RUNNER = path.join(__dirname, '..', 'src', 'main', 'tool-runner.cjs')
// Разбор — общий с главным процессом: тест не должен понимать протокол шире,
// чем его понимает приложение.
const { readFramedResult } = require('../src/main/tool-protocol.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-tools-'))

const write = (name, code) => {
  const file = path.join(dir, name + '.js')
  fs.writeFileSync(file, code)
  return file
}

// Runner-у всегда передаётся граница: папка фикстуры как единственный корень.
// Без токена он обязан отказать — это проверяется отдельно.
const TOKEN = Buffer.from(JSON.stringify([dir]), 'utf8').toString('base64')

function run(file, args, timeout = 8000, token = TOKEN) {
  return new Promise(resolve => {
    const child = execFile(
      process.execPath, [RUNNER, file, token],
      { cwd: dir, timeout, maxBuffer: 1 << 20, windowsHide: true },
      (error, stdout) => {
        if (error && error.killed) return resolve({ killed: true })
        resolve(readFramedResult(stdout) || { unparsed: String(stdout || '') })
      }
    )
    child.stdin.end(JSON.stringify(args || {}))
  })
}

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) { failed++; console.error(`ПРОВАЛ [${name}]${detail ? ': ' + detail : ''}`) }
}

async function main() {
  // The ordinary case: arguments in, JSON out.
  const adder = write('adder', 'module.exports = async ({ a, b }) => ({ sum: a + b })')
  const sum = await run(adder, { a: 2, b: 40 })
  check('обычный инструмент возвращает результат', sum.ok === true && sum.result?.sum === 42, JSON.stringify(sum))

  // A tool that prints an envelope of its own must not be believed: the answer
  // is what the runner frames, everything else is just the tool's log.
  const noisy = write('noisy',
    "console.log('{\"ok\":true,\"result\":\"ФОРГА\"}');module.exports = async () => ({ truth: 1 })")
  const told = await run(noisy, {})
  check('напечатанный инструментом конверт не становится ответом',
    told.ok === true && told.result?.truth === 1 && /ФОРГА/.test(String(told.log || '')),
    JSON.stringify(told).slice(0, 300))

  // It really does run where the workspace is, which is how a tool finds files.
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'здесь')
  const lister = write('lister', "const fs=require('fs');module.exports=async()=>fs.readdirSync('.').filter(f=>f.endsWith('.txt'))")
  const listed = await run(lister, {})
  check('инструмент работает в папке проекта',
    listed.ok === true && Array.isArray(listed.result) && listed.result.includes('marker.txt'),
    JSON.stringify(listed))

  // A throwing tool reports the failure instead of producing nothing.
  const thrower = write('thrower', "module.exports = async () => { throw new Error('сломался') }")
  const threw = await run(thrower, {})
  check('падение инструмента возвращается ошибкой',
    threw.ok === false && /сломался/.test(threw.error || ''), JSON.stringify(threw))

  // Exporting the wrong shape is a mistake the agent can act on, not a crash.
  const notAFunction = write('shapeless', 'module.exports = { hello: 1 }')
  const shapeless = await run(notAFunction, {})
  check('неверный экспорт объясняется',
    shapeless.ok === false && /экспортировать функцию/.test(shapeless.error || ''), JSON.stringify(shapeless))

  // An endless loop must die on the timeout rather than hang the app.
  const spinner = write('spinner', 'module.exports = async () => { while (true) {} }')
  const spun = await run(spinner, {}, 2500)
  check('зацикленный инструмент убивается по таймауту', spun.killed === true, JSON.stringify(spun))

  // Names the app will accept — the same guard the main process applies.
  const NAME = /^[a-z][a-z0-9_]{2,40}$/
  for (const good of ['count_todos', 'grep2', 'a_b_c']) {
    check('имя принято: ' + good, NAME.test(good))
  }
  for (const bad of ['Ab', 'x', '2fast', 'has-dash', 'про_русское', '../escape']) {
    check('имя отклонено: ' + bad, !NAME.test(bad))
  }

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: failed === 0, failed }))
  process.exit(failed ? 1 : 0)
}

main()
