// break-5 Н9: launcher.cjs звал redact(lineFor(outcome), []) — список секретов
// пуст всегда, ключ из ответа/отказа уходил в stdout и в --log. Тест гоняет
// настоящий launcher.main с подставным spawn (Electron не запускается) и
// настоящим result.json; ключ выдуманный.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const childProcess = require('node:child_process')
const { redact, secretValues } = require('../src/cli/onlyone.cjs')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const KEY = 'sk-or-v1-FAKEKEY0123456789ABCDEF'
const windows = []
for (let i = 0; i + 8 <= KEY.length; i++) windows.push(KEY.slice(i, i + 8))
const leaks = text => {
  const s = String(text)
  if (s.includes(KEY)) return 'ключ целиком'
  for (const w of windows) if (s.includes(w)) return `окно «${w}»`
  return null
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-cli-redact-'))
const profile = path.join(base, 'profile')
const folder = path.join(base, 'work')
const logFile = path.join(base, 'cli.log')
fs.mkdirSync(profile)
fs.mkdirSync(folder)
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({ providers: { openrouter: { key: KEY } } }), 'utf8')

// Подставной spawn: пишет настоящий result.json в каталог задания и закрывается.
const realSpawn = childProcess.spawn
childProcess.spawn = (binary, args) => {
  const child = new EventEmitter()
  child.pid = 999999
  child.exitCode = null
  child.kill = () => {}
  const jobArg = (args || []).find(a => String(a).startsWith('--onlyone-cli='))
  const jobDir = jobArg ? String(jobArg).slice('--onlyone-cli='.length) : null
  setImmediate(() => {
    if (jobDir) {
      fs.writeFileSync(path.join(jobDir, 'result.json'), JSON.stringify({
        ok: false,
        error: `Не удалось подключиться: сервер ответил "invalid key ${KEY}". Проверьте подключение.`
      }), 'utf8')
    }
    child.exitCode = 0
    child.emit('close', 0)
  })
  return child
}

const launcher = require('../src/cli/launcher.cjs')

async function main() {
  const out = []
  const err = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = chunk => { out.push(String(chunk)); return true }
  process.stderr.write = chunk => { err.push(String(chunk)); return true }
  let code
  try {
    code = await launcher.main(['run', 'проверка', '--folder', folder, '--profile', profile, '--log', logFile])
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
    childProcess.spawn = realSpawn
  }
  const printed = out.join('') + err.join('')
  const logged = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''

  check('ключ не уходит в stdout/stderr запускника', () => {
    const leak = leaks(printed)
    assert.ok(!leak, `ключ в выводе (${leak}): ${printed.slice(0, 200)}`)
    assert.match(printed, /ключ скрыт/, 'маски нет — зачистка не вызывалась')
  })
  check('ключ не уходит в --log', () => {
    assert.ok(logged, 'журнал не записан — проверка не состоялась')
    const leak = leaks(logged)
    assert.ok(!leak, `ключ в журнале (${leak})`)
  })
  check('контроль: код выхода и причина отказа на месте', () => {
    assert.equal(code, 1, 'ожидался EXIT.TURN_FAILED=1, получен ' + code)
    assert.match(printed, /Не удалось подключиться/, 'причина отказа потеряна')
  })
  check('контроль: secretValues находит ключ профиля, redact с ним работает', () => {
    const secrets = secretValues(JSON.parse(fs.readFileSync(path.join(profile, '1code-settings.json'), 'utf8')))
    assert.equal(secrets.length, 1)
    assert.ok(!leaks(redact(`ответ ${KEY} и хвост`, secrets)))
    assert.ok(leaks(redact(`ответ ${KEY}`, [])), 'контроль сломан: пустой список и так маскирует')
  })

  console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
  process.exitCode = failed ? 1 : 0
}

main().catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => { try { fs.rmSync(base, { recursive: true, force: true }) } catch {} })