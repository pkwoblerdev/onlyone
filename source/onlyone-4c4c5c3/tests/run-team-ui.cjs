// Команда агентов в настоящем окне: Настройки → Работа → число агентов и модель помощника выбираются блоком со списком;
// выбор сохраняется в настройках и переживает перезапуск; «Авто» и сброс работают.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-team')
const profile = path.join(out, 'profile')
fs.mkdirSync(profile, { recursive: true })

const body = second => `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 15000) => { const s = Date.now() + ms; while (Date.now() < s) { try { if (await fn()) return true } catch {} await wait(100) } return false }
  const checks = []
  const note = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  const errors = []
  window.addEventListener('error', event => errors.push(String(event.message)))
  await until(() => document.documentElement.dataset.appReady === '1', 30000)
  if ($('onboarding') && !$('onboarding').hidden) $('onboarding').querySelector('.ob-skip')?.click()
  await wait(500)
  $('openSettingsBtn').click(); await wait(300)
  $('tab-workspace').click(); await wait(400)
  const body = () => $('teamBody')
  ${second ? `
  note('после перезапуска число и модель на месте', await until(() => /Агент 3/.test(body().textContent) && body().querySelector('[data-count="3"].on')), body().textContent.replace(/\\s+/g, ' ').slice(0, 160))
  const saved = await window.electronAPI.getAgentTeam()
  note('настройка хранится в главном процессе', saved.count === 3 && saved.models[0] === window.__picked, JSON.stringify(saved))
  body().querySelector('[data-count="auto"]').click()
  await wait(700)
  const back = await window.electronAPI.getAgentTeam()
  note('«Авто» снимает число агентов, модели остаются на случай возврата', back.count === null && back.models[0] === window.__picked, JSON.stringify(back))
  ` : `
  note('группа «Команда агентов» есть в Настройках → Работа', Boolean($('teamGroup')) && Boolean(body()))
  note('по умолчанию «Авто», строк помощников нет', Boolean(body().querySelector('[data-count="auto"].on')) && !body().querySelector('.team-row'))
  body().querySelector('[data-count="3"]').click(); await wait(200)
  note('выбрали 3 агента: появились строки Агент 2 и Агент 3, у каждой «Авто»', body().querySelectorAll('.team-row').length === 2 && /Агент 2/.test(body().textContent) && /Агент 3/.test(body().textContent) && body().querySelectorAll('.team-model.is-auto').length === 2)
  body().querySelector('[data-agent="2"]').click(); await wait(500)
  const pop = $('modelPopover')
  note('модель выбирается тем же блоком со списком и поиском', !pop.hidden && pop.querySelectorAll('.mp-row').length > 6 && Boolean(pop.querySelector('.mp-search')))
  note('в блоке выбора для агента нет строки Fast', pop.querySelector('.mp-foot').hidden)
  const row = [...pop.querySelectorAll('.mp-row')][2]
  const pickedName = row.querySelector('.mp-name').textContent.trim()
  row.click(); await wait(500)
  note('выбранная модель показана у Агента 2', body().querySelector('[data-agent="2"]').textContent.trim() === pickedName, body().querySelector('[data-agent="2"]').textContent)
  note('у Агента 3 по-прежнему «Авто»', body().querySelector('[data-agent="3"]').classList.contains('is-auto'))
  const team = await (async () => { await wait(700); return window.electronAPI.getAgentTeam() })()
  window.__picked = team.models[0]
  note('сохранено в настройках: число 3 и id модели Агента 2', team.count === 3 && /^[^/]+\\/.+/.test(team.models[0] || ''), JSON.stringify(team))
  $('modelEffortPillBtn').click(); await wait(400)
  note('после этого блок модели в чате снова обычный: со строкой Fast', !$('modelPopover').hidden && !$('modelPopover').querySelector('.mp-foot').hidden)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  ` }
  note('ошибок в окне нет', !errors.length, errors.join(' | '))
  return { ok: checks.every(c => c.pass), checks, picked: window.__picked || '' }
})()`

async function run(second, label) {
  const script = path.join(out, `renderer-${label}.js`)
  const result = path.join(out, `result-${label}.json`)
  fs.writeFileSync(script, body(second))
  const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
    cwd: root, stdio: 'inherit', env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_E2E: '1' })
  })
  const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 120000)
  await new Promise(resolve => child.on('close', resolve))
  clearTimeout(killer)
  return fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : null
}

;(async () => {
  let ok = true
  const first = await run(false, 'first')
  if (!first) { console.error('Окно не отчиталось (первый запуск)'); ok = false } else for (const item of first.checks) { console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.pass ? '' : ' — ' + item.detail)); ok = ok && item.pass }
  console.log('— перезапуск —')
  fs.writeFileSync(path.join(out, 'picked.txt'), first ? first.picked : '')
  // во втором запуске id первой выбранной модели подставляется из первого
  const pickedId = first ? first.picked : ''
  const second = await (async () => {
    const script = path.join(out, 'renderer-second.js')
    fs.writeFileSync(script, body(true).split('window.__picked').join(JSON.stringify(pickedId)))
    const result = path.join(out, 'result-second.json')
    const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], { cwd: root, stdio: 'inherit', env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_E2E: '1' }) })
    const killer = setTimeout(() => { try { child.kill() } catch { /* уже завершился */ } }, 120000)
    await new Promise(resolve => child.on('close', resolve))
    clearTimeout(killer)
    return fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : null
  })()
  if (!second) { console.error('Окно не отчиталось (после перезапуска)'); ok = false } else for (const item of second.checks) { console.log((item.pass ? '  ok  ' : 'ПРОВАЛ ') + item.name + (item.pass ? '' : ' — ' + item.detail)); ok = ok && item.pass }
  settleRun(out, ok)
  process.exit(ok ? 0 : 1)
})()
