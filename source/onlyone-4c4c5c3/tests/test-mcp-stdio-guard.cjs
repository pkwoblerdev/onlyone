// break-5b Н16: add_mcp_server со stdio в «Авто» запускал процесс без карточки,
// ребёнок наследовал всё окружение главного процесса. Н17: ветки 404 и spawn
// describeMcpError отдавали url/command без маски.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let failed = 0
let total = 0
const check = (name, fn) => {
  total++
  try { fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}
const asyncCheck = async (name, fn) => {
  total++
  try { await fn() } catch (error) { failed++; console.error(`ПРОВАЛ [${name}]: ${error.message}`) }
}

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8')

// --- Н16, часть 1: классификация риска в ветке add_mcp_server ---
const branchStart = mainSrc.indexOf("if (name === 'add_mcp_server')")
const branchEnd = mainSrc.indexOf("if (name === 'list_mcp_servers')")
const branch = mainSrc.slice(branchStart, branchEnd)

const apStart = mainSrc.indexOf('function approvalRequired')
const apEnd = mainSrc.indexOf('\n}\n', apStart) + 3
const makeApprovalRequired = workspace =>
  new Function('workspace', mainSrc.slice(apStart, apEnd) + '\nreturn approvalRequired')(workspace)

check('ветка add_mcp_server даёт stdio риск destructive (карточка в любом режиме)', () => {
  assert.ok(branchStart > 0 && branchEnd > branchStart, 'ветка не найдена')
  assert.match(branch, /config\.type === 'stdio' \? 'destructive' : 'external'/,
    'stdio по-прежнему проходит с мягким риском — в «Авто» карточки нет')
})
check('destructive спрашивает во всех режимах, external в «Авто» — нет (контроль)', () => {
  for (const permission of ['manual', 'acceptEdits', 'auto', 'plan']) {
    const approvalRequired = makeApprovalRequired({ permission })
    assert.equal(approvalRequired('destructive'), true, `destructive не спросил в ${permission}`)
  }
  assert.equal(makeApprovalRequired({ permission: 'auto' })('external'), false,
    'контроль сломан: external и так спрашивает — находка не про то')
})
check('http-адрес по-прежнему проходит autoLocalRefusal (контроль)', () => {
  assert.match(branch, /autoLocalRefusal\(config\.url/, 'проверка http-адреса пропала')
})

// --- Н17: маска ДО выдачи во всех ветках describeMcpError ---
const mcpSrc = fs.readFileSync(path.join(root, 'src', 'main', 'mcp-manager.js'), 'utf8')
const dStart = mcpSrc.indexOf('function describeMcpError')
const dEnd = mcpSrc.indexOf('class McpManager')
globalThis.maskSecretText = require('../src/main/providers/secret-mask.js').maskSecretText
const describeMcpError = new Function(mcpSrc.slice(dStart, dEnd) + '\nreturn describeMcpError')()

const TOKEN = 'FAKE-TOKEN-abc123XYZ789'
const windows = []
for (let i = 0; i + 8 <= TOKEN.length; i++) windows.push(TOKEN.slice(i, i + 8).toLowerCase())
const clean = text => {
  const low = String(text).toLowerCase()
  assert.ok(!low.includes(TOKEN.toLowerCase()), 'токен целиком в тексте: ' + text)
  for (const w of windows) assert.ok(!low.includes(w), `окно «${w}» в тексте: ${text}`)
}

check('404: токен в query адреса замаскирован', () => {
  clean(describeMcpError(new Error('Error POSTing to endpoint (HTTP 404): Not Found'),
    { type: 'http', url: `https://host.invalid/mcp?token=${TOKEN}` }))
})
check('404: токен в пути адреса замаскирован', () => {
  clean(describeMcpError(new Error('HTTP 404 Not Found'),
    { type: 'http', url: `https://host.invalid/token/${TOKEN}/mcp` }))
})
check('spawn: ключ в команде замаскирован', () => {
  clean(describeMcpError(new Error('spawn node ENOENT'),
    { type: 'stdio', command: `node --api-key=${TOKEN} server.js` }))
})
check('контроль: эхо в 500 с Authorization маскировалось и раньше', () => {
  clean(describeMcpError(new Error(`500 boom ${TOKEN}`),
    { type: 'http', url: 'https://host.invalid/mcp', headers: { Authorization: `Bearer ${TOKEN}` } }))
})
check('длина ответа ограничена', () => {
  const out = describeMcpError(new Error('x'.repeat(5000)), { type: 'http', url: 'https://host.invalid/mcp' })
  assert.ok(out.length <= 400, `длина ${out.length}`)
})

// --- Н16, часть 2: окружение ребёнка не наследует секреты главного процесса ---
async function envProbe() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onecode-mcp-env-'))
  const marker = path.join(base, 'env-dump.json')
  const SECRET_NAME = 'ONECODE_FIX_A_FAKE_SECRET'
  const previous = process.env[SECRET_NAME]
  process.env[SECRET_NAME] = 'FAKE-SECRET-VALUE-12345'
  const { McpManager } = require('../src/main/mcp-manager.js')
  const manager = new McpManager({})
  manager.setConfigs([{
    id: 'probe', name: 'probe', type: 'stdio', command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env))`],
    env: { ONECODE_FIX_A_CUSTOM: 'custom-ok' }
  }])
  try {
    try { await manager.connect('probe') } catch { /* handshake падает: ребёнок записал файл и вышел */ }
    await asyncCheck('ребёнок не наследует секрет главного процесса', () => {
      assert.ok(fs.existsSync(marker), 'ребёнок не запустился — проверка не состоялась')
      const env = JSON.parse(fs.readFileSync(marker, 'utf8'))
      assert.equal(env[SECRET_NAME], undefined, 'секрет главного процесса дошёл до ребёнка')
    })
    await asyncCheck('контроль: PATH и свой env ребёнок получает', () => {
      const env = JSON.parse(fs.readFileSync(marker, 'utf8'))
      assert.ok(env.PATH || env.Path, 'PATH не дошёл — серверы перестанут запускаться')
      assert.equal(env.ONECODE_FIX_A_CUSTOM, 'custom-ok', 'явный env конфигурации не дошёл')
    })
  } finally {
    await manager.disconnectAll()
    if (previous === undefined) delete process.env[SECRET_NAME]
    else process.env[SECRET_NAME] = previous
    try { fs.rmSync(base, { recursive: true, force: true }) } catch {}
  }
}

envProbe().catch(error => { failed++; console.error('ПРОВАЛ [env-проба]: ' + error.message) })
  .finally(() => {
    console.log(JSON.stringify({ ok: failed === 0, checks: total, failed }))
    process.exitCode = failed ? 1 : 0
  })