// Агент-режим на живых моделях, в настоящем окне.
//
// Всё остальное про агентов проверено на настоящем коде хода, но с подставными
// моделями: так видно, что диспетчер, дорожки и доска устроены верно, и не видно,
// как с ними обходятся настоящие провайдеры — принимают ли реплику после ответов
// инструментов, успевают ли помощники работать одновременно, не рассыпается ли
// лента, когда потоки идут вперемешку по-настоящему.
//
// Сценарии: solo — обычный вопрос, команда собираться не должна; team — задача,
// которая делится на две независимые части.
// Без аргумента идут оба, каждый в своём одноразовом профиле.
//
// Ключи, два способа:
// - ONECODE_LIVE_KEY (из окружения или из переменных пользователя Windows);
// - ONECODE_LIVE_FROM_APP=1 — ключи установленного приложения. В одноразовый
//   профиль копируются их зашифрованные записи и «Local State», которым они
//   зашифрованы; расшифровывает их само приложение при запросе. Значения ключей
//   нигде не выводятся. Ключ, привязанный к платной модели, не копируется —
//   ONECODE_LIVE_EXCLUDE_MODEL (по умолчанию z-ai/glm-5.3-flash).
const { spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const { readFileSync, existsSync, mkdtempSync, writeFileSync, copyFileSync } = fs
const { join } = require('path')
const { tmpdir } = require('os')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

function envKey() {
  if (process.env.ONECODE_LIVE_KEY) return process.env.ONECODE_LIVE_KEY
  if (process.platform !== 'win32') return ''
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'ONECODE_LIVE_KEY'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const match = out.match(/ONECODE_LIVE_KEY\s+REG_(?:EXPAND_)?SZ\s+(\S+)/)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

const fromApp = process.env.ONECODE_LIVE_FROM_APP === '1'
const KEY = fromApp ? '' : envKey()
const appData = join(process.env.APPDATA || '', '1code')
const excludeModel = process.env.ONECODE_LIVE_EXCLUDE_MODEL || 'z-ai/glm-5.3-flash'

let storedKeys = []
if (fromApp) {
  const settings = JSON.parse(readFileSync(join(appData, '1code-settings.json'), 'utf8'))
  storedKeys = (Array.isArray(settings.openrouterKeys) ? settings.openrouterKeys : [])
    .filter(key => key.enabled !== false && key.keyEncrypted && key.modelId !== excludeModel)
  // Привязки ключей к моделям оставляются, как у человека, — если не просили снять.
  if (process.env.ONECODE_LIVE_UNBIND === '1') {
    storedKeys = storedKeys.map(({ modelId, modelName, role, ...rest }) => rest)
  }
  if (!storedKeys.length) {
    console.log(JSON.stringify({ ok: false, error: 'в приложении нет подходящих ключей' }))
    process.exit(1)
  }
} else if (!KEY) {
  console.log(JSON.stringify({ ok: true, skipped: 'нет ONECODE_LIVE_KEY и не задан ONECODE_LIVE_FROM_APP=1 — живой прогон агентов пропущен' }))
  process.exit(0)
}

const root = join(__dirname, '..')
// Куда класть снимки. Без ONECODE_SHOTS_DIR прогон работает как раньше.
const shotsDir = process.env.ONECODE_SHOTS_DIR || ''
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true })
const wanted = process.argv[2] || 'all'
const scenarios = wanted === 'all' ? ['solo', 'team'] : wanted.split(',')
const model = process.env.ONECODE_LIVE_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free'

// Правильные ответы считаются здесь, из файлов, а не берутся на веру у модели.
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const smokeText = readFileSync(join(root, 'tests', 'run-smoke.cjs'), 'utf8')
const NL = String.fromCharCode(10)
const smokeLines = smokeText.split(NL).length - (smokeText.endsWith(NL) ? 1 : 0)

const electron = electronBinary()

console.log('ключей в прогоне: ' + (fromApp ? storedKeys.length + ' (из приложения: ' +
  storedKeys.map(k => k.name + (k.modelId ? ' → ' + k.modelId : '')).join(', ') + ')' : '1 (из окружения)'))
console.log('модель ведущего: ' + model)
console.log('')

let failedTotal = 0
for (const scenario of scenarios) {
  const base = readFileSync(join(__dirname, 'e2e-agents-renderer.js'), 'utf8')
  const script = join(mkdtempSync(join(tmpdir(), 'onecode-agents-script-')), 'renderer.js')
  writeFileSync(script,
    'window.__scenario = ' + JSON.stringify(scenario) + ';\n' +
    'window.__workspace = ' + JSON.stringify(root) + ';\n' +
    'window.__liveModel = ' + JSON.stringify(model) + ';\n' +
    'window.__useStoredKeys = ' + JSON.stringify(fromApp) + ';\n' +
    'window.__expect = ' + JSON.stringify({ version, smokeLines }) + ';\n' + base)
  const out = join(mkdtempSync(join(tmpdir(), 'onecode-agents-')), 'result.json')
  const profile = mkdtempSync(join(tmpdir(), 'onecode-agents-profile-'))

  if (fromApp) {
    copyFileSync(join(appData, 'Local State'), join(profile, 'Local State'))
    writeFileSync(join(profile, '1code-settings.json'), JSON.stringify({
      openrouterKeys: storedKeys,
      defaultModel: model,
      legacyStoragePurged: true
    }))
  }

  // Снимок окна в конце хода: события рассказывают, что случилось, но не
  // показывают, как это выглядело — а половина дефектов видна только глазами.
  const shot = shotsDir ? join(shotsDir, scenario + '.png') : ''
  const started = Date.now()
  spawnSync(electron, ['.', '--user-data-dir=' + profile], {
    cwd: root,
    stdio: 'ignore',
    timeout: 16 * 60 * 1000,
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: out, ONECODE_E2E: '1', ONECODE_ARG: KEY,
      ...(shot ? { ONECODE_SHOT: shot } : {}) })
  })
  if (shot && existsSync(shot)) console.log('  снимок: ' + shot)

  console.log('=== ' + scenario + ' (' + Math.round((Date.now() - started) / 1000) + ' с) ===')
  // Одноразовый профиль с копией ключей не остаётся на диске.
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(script, { force: true }) } catch {}

  if (!existsSync(out)) {
    console.log('  ПРОВАЛ окно не отчиталось — приложение не догрузилось или прогон завис')
    failedTotal += 1
    continue
  }
  const result = JSON.parse(readFileSync(out, 'utf8'))
  for (const [key, value] of Object.entries(result.facts || {})) {
    console.log('  ' + key.padEnd(20) + ' ' + String(value).slice(0, 600))
  }
  console.log('')
  for (const check of result.checks || []) {
    console.log((check.pass ? '  ok     ' : '  ПРОВАЛ ') + check.name + (check.detail ? ' — ' + String(check.detail).slice(0, 400) : ''))
  }
  const failed = (result.checks || []).filter(c => !c.pass).length
  failedTotal += failed
  console.log('')
}

console.log(JSON.stringify({ ok: failedTotal === 0, failed: failedTotal, scenarios }))
process.exit(failedTotal ? 1 : 0)
