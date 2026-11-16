// Снимки всех вкладок настроек (вручную, не в общем прогоне): настоящее окно, отдельный запуск со свежим профилем.
// Нужен, чтобы глазами сверить вид настроек: отступы, выравнивание, переносы, перекрытия.
// Использование:  node tests/shots-settings.cjs [папка]
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const target = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-settings-shots-'))
fs.mkdirSync(target, { recursive: true })

const TABS = ['workspace', 'keys', 'personal', 'appearance', 'shortcuts', 'remote', 'updates']

const BODY = tab => `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 30000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(150) } return false }
  await until(() => document.documentElement.dataset.appReady === '1')
  if ($('onboarding') && !$('onboarding').hidden) $('onboarding').hidden = true
  await wait(400)
  $('openSettingsBtn').click(); await wait(500)
  $('tab-${tab}')?.click(); await wait(700)
  const modal = document.querySelector('#settingsModal .modal-body, #settingsModal') || document.body
  const overflow = [...document.querySelectorAll('#settingsModal *')].filter(n => n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX === 'visible' && n.clientWidth > 0).slice(0, 8)
    .map(n => (n.id || n.className || n.tagName).toString().slice(0, 60))
  return { ok: true, checks: [{ label: 'переполнение по ширине: ' + (overflow.join(' | ') || 'нет'), pass: !overflow.length }] }
})()`

async function shoot (tab) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-sshot-'))
  const profile = path.join(dir, 'profile'); const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
    openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
    defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
  }))
  const script = path.join(dir, 'renderer.js'); fs.writeFileSync(script, BODY(tab))
  const shot = path.join(target, 'settings-' + tab + '.png')
  const result = path.join(dir, 'r.json')
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, stdio: 'ignore',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_SHOT: shot, ONECODE_E2E: '1', ONECODE_VERSIONS: process.env.SHOTS_VERSIONS || '0' })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 120000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  let note = ''
  try { note = JSON.parse(fs.readFileSync(result, 'utf8')).checks.map(c => c.label).join('; ') } catch { note = 'нет отчёта' }
  console.log((fs.existsSync(shot) ? '  ok  ' : 'ПРОВАЛ ') + tab + ' → ' + shot + '  [' + note + ']')
}

;(async () => {
  for (const tab of TABS) await shoot(tab)
  console.log('Папка снимков: ' + target)
  process.exit(0)
})()
