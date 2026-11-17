// ЖИВАЯ проверка помощника по решениям (вручную, не в общем прогоне): ведущий на бесплатной модели получает просьбу, где названа
// модель-решатель, вызывает ask_decision и пересказывает ответ. Ключ берётся из профиля владельца; допускаются только модели :free.
// Использование:  node tests/live-free-decision.cjs <ведущий:free> [<решатель:free>]
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { electronBinary, guiEnv } = require('./app-launch.cjs')

const lead = process.argv[2]
const helper = process.argv[3] || 'inception/mercury-decide:free'
if (!lead || !/:free$/.test(lead) || !/:free$/.test(helper)) { console.error('Нужны бесплатные модели: node tests/live-free-decision.cjs nvidia/nemotron-3.5-lightning:free'); process.exit(2) }
const home = path.join(process.env.APPDATA || '', '1code')
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyone-live-decision-'))
const profile = path.join(out, 'profile'); const workspace = path.join(out, 'workspace')
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
const settings = JSON.parse(fs.readFileSync(path.join(home, '1code-settings.json'), 'utf8'))
settings.defaultModel = lead; settings.workspace = { path: workspace, permission: 'acceptEdits' }; settings.projects = []
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify(settings))
fs.copyFileSync(path.join(home, 'Local State'), path.join(profile, 'Local State'))

const prompt = `Your task with agent ${helper}: judge price moves. Only 2 agent you and ${helper}. ` +
  'Call ask_decision once with state {previous: 85735, now: 85717, window: "5m"} and two questions: ' +
  '"notable" (type noul, instructions "Is the move notable?", criteria {true: "large move", false: "noise"}) and ' +
  '"direction" (type choice, instructions "Next candle direction?", criteria {up: "rises", down: "falls", flat: "unchanged"}). ' +
  'Then reply in Russian: quote the numbers the decision helper returned.'

const script = path.join(out, 'renderer.js')
fs.writeFileSync(script, `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms) => { const s = Date.now() + ms; while (Date.now() < s) { try { if (await fn()) return true } catch {} await wait(300) } return false }
  await until(() => document.documentElement.dataset.appReady === '1', 30000)
  const events = []
  window.electronAPI.onAgentEvent?.(event => events.push(String(event.message || '')))
  let answer
  try {
    answer = await Promise.race([window.electronAPI.sendMessage({ model: ${JSON.stringify(lead)}, messages: [{ role: 'user', content: ${JSON.stringify(prompt)} }], requestId: 'live-decision', chatId: 'live', params: { useTools: true } }), new Promise(r => setTimeout(() => r({ timeout: true }), 240000))])
  } catch (error) { answer = { error: String(error.message || error) } }
  return { events, ok: answer && answer.ok, error: answer && answer.error, content: String((answer && answer.content) || '').slice(0, 1500), stages: (answer && answer.stages || []).length }
})()`)
const resultFile = path.join(out, 'r.json')
const child = spawn(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], { cwd: path.join(__dirname, '..'), stdio: 'ignore', env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: resultFile, ONECODE_E2E: '1' }) })
child.on('close', () => {
  const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { error: 'окно не отчиталось' }
  console.log(JSON.stringify(report, null, 2))
  const text = JSON.stringify(report)
  console.log('помощник назначен: ' + /помощник по решениям/i.test(text) + ' · вопрос ему задан: ' + /взвешивает решение|ask_decision|вероятност/i.test(text))
  console.log('Папка прогона: ' + out)
})
