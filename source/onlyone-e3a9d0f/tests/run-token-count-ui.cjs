// Счёт токенов хода в настоящем окне: два шага агента, провайдер называет расход каждого (1000 и 1500).
// В сохранённом ответе и в подписи должно быть 2500, а не 5000: окно складывало прогресс шагов с итогом прогона.
//   node tests/run-token-count-ui.cjs
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { electronBinary, guiEnv, runDir, settleRun } = require('./app-launch.cjs')

const root = path.join(__dirname, '..')
const out = runDir('onlyone-token-count')
const profile = path.join(out, 'profile'); const workspace = path.join(out, 'workspace')
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 'notes.txt'), 'заметка для чтения\n')
fs.writeFileSync(path.join(profile, '1code-settings.json'), JSON.stringify({
  openrouterKeys: [{ id: 'test-key', name: 'Тест', keyEncrypted: 'Q0lQSEVSLU5PLQ', modelId: 'test/model', enabled: true }],
  defaultModel: 'test/model', legacyStoragePurged: true, workspace: { path: workspace, permission: 'acceptEdits' }
}))

const usage = (prompt, completion) => ({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion })
const providerFile = path.join(out, 'provider.json')
fs.writeFileSync(providerFile, JSON.stringify({ turns: [
  { frames: [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'notes.txt' }) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: usage(900, 100) }
  ] },
  { frames: [
    { choices: [{ delta: { content: 'В файле одна заметка.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: usage(1400, 100) }
  ] },
  { text: 'Подсказка' }, { text: 'Название' }, { text: 'Ещё' }
] }))

const script = path.join(out, 'renderer.js'); const result = path.join(out, 'result.json')
fs.writeFileSync(script, `(async () => {
  const $ = id => document.getElementById(id)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 60000) => { const stop = Date.now() + ms; while (Date.now() < stop) { try { if (await fn()) return true } catch {} await wait(50) } return false }
  await until(() => document.documentElement.dataset.appReady === '1', 30000)
  if ($('onboarding') && !$('onboarding').hidden) $('onboarding').hidden = true
  await wait(400)
  const box = $('composerTextarea')
  box.value = 'Что в notes.txt?'; box.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(150); $('composerForm').requestSubmit()
  await until(() => $('sendBtn') && $('sendBtn').classList.contains('is-stop'), 20000)
  await until(() => !$('sendBtn').classList.contains('is-stop'), 90000)
  await wait(1500)
  const chats = await window.electronAPI.getConversations()
  const list = Array.isArray(chats) ? chats : (chats && chats.conversations) || []
  const messages = list.flatMap(c => c.messages || [])
  const answer = messages.filter(m => m.role === 'assistant').pop() || {}
  const meta = [...document.querySelectorAll('#messagesList .msg-item')].pop()
  return { ok: true, stored: answer.tokens, metaText: meta ? meta.textContent.replace(/\\s+/g, ' ').slice(-200) : '' }
})()`)

spawnSync(electronBinary(), ['.', '--no-sandbox', '--disable-gpu-sandbox', '--user-data-dir=' + profile], {
  cwd: root, timeout: 180000, stdio: 'ignore',
  env: guiEnv({ ONECODE_SMOKE: script, ONECODE_SMOKE_OUT: result, ONECODE_E2E: '1', ONECODE_PROVIDER_FILE: providerFile, ONECODE_SHOT: path.join(out, 'token-count.png') })
})
const report = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : null
let failed = 0
const check = (name, ok, detail) => { console.log((ok ? '  ok  ' : 'ПРОВАЛ ') + name + (ok ? '' : ' — ' + detail)); if (!ok) failed++ }
check('окно отчиталось', Boolean(report && report.ok), JSON.stringify(report))
if (report && report.ok) {
  check('в ответе сохранено 2500 токенов (1000 + 1500), а не вдвое больше', report.stored === 2500, 'сохранено ' + report.stored)
  check('подпись ответа показывает 2,5 тыс., а не 5', /2[.,]5\s?(k|к|тыс)/i.test(report.metaText) && !/5[.,]0?\s?(k|к|тыс)/i.test(report.metaText), report.metaText)
}
settleRun(out, failed === 0)
console.log(JSON.stringify({ ok: failed === 0, failed }))
process.exit(failed ? 1 : 0)
