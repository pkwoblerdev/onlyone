// Каналы сборки в настоящем окне. stable (для всех, кроме владельца): в знакомстве нет шага выбора версии, в Настройках
// нет группы «Версия», а попытка включить Ultra сбрасывается на Default. experimental (владелец): всё как было — версии
// на месте, Ultra включается.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')

function runChannel(channel) {
  const out = runDir('onlyone-channel-' + channel)
  const script = path.join(out, 'renderer.js')
  const result = path.join(out, 'result.json')
  const stable = channel === 'stable'
  fs.writeFileSync(script, `(async () => {
    const $ = id => document.getElementById(id)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, ms = 15000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (fn()) return true } catch {} await wait(60) } return false }
    const checks = []
    const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
    const errors = []
    window.addEventListener('error', event => errors.push(String(event.message)))
    await until(() => document.documentElement.dataset.appReady === '1', 30000)
    const ob = () => $('onboarding')
    const stepName = () => ob()?.querySelector('.ob-step:not(.is-leaving)')?.dataset.step

    note('окно знает свой канал', window.electronAPI.channel === '${channel}' && document.documentElement.dataset.channel === '${channel}', window.electronAPI.channel + '/' + document.documentElement.dataset.channel)

    // Знакомство: какие шаги проходит человек.
    await until(() => ob()?.classList.contains('is-in'))
    const seen = []
    for (let i = 0; i < 12; i++) {
      const name = stepName()
      if (name && seen[seen.length - 1] !== name) seen.push(name)
      if (name === 'done') break
      const button = ob().querySelector('.ob-next')
      if (!button) break
      button.click()
      await wait(450)
    }
    // Версий во вступлении нет ни в одном канале (слово владельца 25.10):
    // версию выбирают только в Настройках.
    note('в знакомстве нет шага выбора версии', seen.length >= 4 && !seen.includes('version') && seen.includes('focus') && seen.includes('key'), seen.join(','))
    ob()?.querySelector('.ob-skip')?.click()
    await wait(600)
    if (ob() && ob().classList.contains('is-in')) ob().querySelector('.ob-next')?.click()
    await wait(800)

    // Настройки → Вид приложения.
    $('openSettingsBtn').click()
    await wait(300)
    $('tab-appearance').click()
    await wait(300)
    const group = $('editionGroup')
    const visible = Boolean(group) && getComputedStyle(group).display !== 'none' && group.getBoundingClientRect().height > 0
    ${stable
      ? "note('в Настройках нет группы «Версия»', !visible)"
      : "note('в Настройках группа «Версия» на месте, три карточки', visible && document.querySelectorAll('#editionChoices .edition-card').length === 3, document.querySelectorAll('#editionChoices .edition-card').length)"}

    ${stable ? "note('в Настройках нет пункта «Представление Ultra»', getComputedStyle($('ultraIntroRow')).display === 'none')" : "note('у владельца пункт «Представление Ultra» на месте', getComputedStyle($('ultraIntroRow')).display !== 'none')"}

    // Попытка включить Ultra напрямую.
    const base = await window.electronAPI.getUiConfig()
    const saved = await window.electronAPI.setUiConfig(Object.assign({}, base, { versionPreset: 'ultra' }))
    const read = await window.electronAPI.getUiConfig()
    ${stable
      ? "note('Ultra не включается: версия остаётся Default', saved.ok && read.versionPreset === 'default' && document.documentElement.dataset.versionPreset !== 'ultra', read.versionPreset + '/' + document.documentElement.dataset.versionPreset)"
      : "note('у владельца Ultra включается', saved.ok && read.versionPreset === 'ultra', read.versionPreset)"}
    note('ошибок в окне нет', !errors.length, errors.join(' | '))
    return { ok: checks.every(c => c.pass), checks, seen }
  })()`)

  const profile = path.join(out, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  const child = spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, timeout: 150000, stdio: 'inherit',
    env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_E2E: '1', ONECODE_CHANNEL: channel, ONECODE_ONBOARDING: '1' })
  })
  let ok = false
  console.log('— канал ' + channel + ' —')
  if (!fs.existsSync(result)) console.error('Окно не отчиталось (код ' + child.status + ')')
  else {
    const report = JSON.parse(fs.readFileSync(result, 'utf8'))
    for (const item of report.checks || []) console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.detail ? ' — ' + item.detail : ''))
    ok = Boolean(report.ok)
  }
  settleRun(out, ok)
  return ok
}

const stableOk = runChannel('stable')
const experimentalOk = runChannel('experimental')
process.exit(stableOk && experimentalOk ? 0 : 1)
