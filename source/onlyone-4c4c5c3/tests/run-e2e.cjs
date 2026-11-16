// Boots the real app on a throwaway profile and runs one real agent turn against
// the real model, then prints what happened.
//
// Needs a key: ONECODE_LIVE_KEY. Skipped without one, so `npm test` stays
// offline. Costs about a tenth of a cent per run.
const { spawnSync } = require('child_process')
const { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('fs')
const { join } = require('path')
const { tmpdir } = require('os')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

const KEY = process.env.ONECODE_LIVE_KEY
if (!KEY) {
  console.log(JSON.stringify({ ok: true, skipped: 'нет ONECODE_LIVE_KEY — настоящий прогон пропущен' }))
  process.exit(0)
}

const root = join(__dirname, '..')
const scenario = process.argv[2] || 'simple'

// The working folder must exist on the machine running the suite. Everything
// else works in the project root; the twins scenario needs two folders with the
// same name, so it gets a throwaway pair with the same package.json in the
// sources one.
let workspace = root
let extraPaths = []
let twinsRoot = ''
if (scenario === 'twins') {
  twinsRoot = mkdtempSync(join(tmpdir(), 'onecode-e2e-twins-'))
  const installed = join(twinsRoot, 'installed', '1code')
  const sources = join(twinsRoot, 'sources', '1code')
  mkdirSync(installed, { recursive: true })
  mkdirSync(sources, { recursive: true })
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ version: '0.0.0' }))
  writeFileSync(join(sources, 'package.json'), readFileSync(join(root, 'package.json')))
  workspace = installed
  extraPaths = [sources]
}
const cleanupTwins = () => {
  if (twinsRoot) { try { rmSync(twinsRoot, { recursive: true, force: true }) } catch {} }
}

// A project's knowledge file lives wherever the user keeps it, which is not the
// working folder — and that is exactly the case the ordinary file tools cannot
// serve, because they refuse absolute paths. Writing it into the working folder
// instead would let them reach it and prove nothing.
const knowledge = join(mkdtempSync(join(tmpdir(), 'onecode-e2e-knowledge-')), 'справочник-цен.md')
require('fs').writeFileSync(knowledge, [
  '# Справочник цен',
  '',
  'Оптовая цена одной единицы товара — 417 рублей.',
  'Розничная наценка — 35 процентов.'
].join('\n'), 'utf8')

// The scenario is chosen by prepending one line, so the renderer script stays a
// plain file that can also be read on its own.
const base = readFileSync(join(__dirname, 'e2e-renderer.js'), 'utf8')
const script = join(mkdtempSync(join(tmpdir(), 'onecode-e2e-script-')), 'renderer.js')
require('fs').writeFileSync(script, 'window.__scenario = ' + JSON.stringify(scenario) + ';\n' +
  'window.__workspace = ' + JSON.stringify(workspace) + ';\n' +
  'window.__workspaceExtra = ' + JSON.stringify(extraPaths) + ';\n' +
  // The window runs the mock MCP server as a child process, so it needs a real
  // path — with forward slashes, because the script it is spliced into is JS.
  base.split('__MOCK_PATH__').join(join(__dirname, 'mock-mcp-server.mjs').replace(/\\/g, '/'))
      .split('__SECOND_KEY__').join(process.env.ONECODE_LIVE_KEY_2 || '')
      .split('__KNOWLEDGE__').join(knowledge.replace(/\\/g, '/')))
const out = join(mkdtempSync(join(tmpdir(), 'onecode-e2e-')), 'result.json')

// A throwaway profile: the first run of this wrote into the real chat history.
const profile = mkdtempSync(join(tmpdir(), 'onecode-e2e-profile-'))

const electron = electronBinary()

spawnSync(electron, ['.', '--user-data-dir=' + profile], {
  cwd: root,
  stdio: 'ignore',
  timeout: 8 * 60 * 1000,
  env: guiEnv({
    ONECODE_SMOKE: script,
    ONECODE_SMOKE_OUT: out,
    ONECODE_E2E: '1',
    // The cutoff scenario needs the answer to actually be cut off. A real 32k
    // answer running into the cap is neither cheap nor repeatable, so the cap
    // comes down to a couple of sentences and the model hits it several times.
    ...(scenario === 'cutoff' ? { ONECODE_ANSWER_TOKENS: '500' } : {}),
    ONECODE_ARG: KEY
  })
})

if (!existsSync(out)) {
  cleanupTwins()
  console.error('окно не отчиталось — приложение не догрузилось или прогон завис')
  process.exit(1)
}

// The halfway scenario writes into the working folder on purpose. Leaving the
// files behind would let the next run pass by finding yesterday's work.
for (const leftover of ['tmp-half-1.md', 'tmp-half-2.md']) {
  try { require('fs').unlinkSync(join(root, leftover)) } catch {}
}

const result = JSON.parse(readFileSync(out, 'utf8'))

console.log('=== сценарий: ' + scenario + ' ===')
for (const [key, value] of Object.entries(result.facts || {})) {
  console.log('  ' + key.padEnd(16) + ' ' + String(value).slice(0, 160))
}
console.log('')

for (const check of result.checks || []) {
  console.log((check.pass ? '  ok   ' : 'ПРОВАЛ ') + check.name +
    (check.detail ? ' — ' + check.detail : ''))
}

cleanupTwins()
const failed = (result.checks || []).filter(c => !c.pass).length
console.log('')
console.log(JSON.stringify({ ok: failed === 0, failed, checks: (result.checks || []).length }))
process.exit(failed ? 1 : 0)
